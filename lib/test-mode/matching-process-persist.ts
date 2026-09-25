/**
 * Sequelize / pg I/O for the Node matcher.
 * Imported only from matching-process-runtime (API / Node), never from
 * instrumentation.ts — that bundle cannot resolve `fs`.
 */

import { Op } from 'sequelize';
import { tapeQuoteKeyCandidates } from '@/lib/test-mode/tape-candles';
import {
  POST_FILL_TAPE_TAIL_MS,
  ticketPlacedAtMs,
} from '@/lib/test-mode/ticket-desk-label';
import { getConsumedOrderKeyModel } from '@/lib/db/models/consumed-order-key';
import { getExecutionLogModel } from '@/lib/db/models/execution-log';
import { getLegTapeTickModel } from '@/lib/db/models/leg-tape-tick';
import { getMatchingProcessStateModel } from '@/lib/db/models/matching-process-state';
import { getOrderExecutionModel } from '@/lib/db/models/order-execution';
import { getSandboxProgressModel } from '@/lib/db/models/sandbox-progress';
import {
  loadSandboxProgress,
  saveSandboxProgress,
} from '@/lib/test-mode/sandbox-service';
import {
  hedgeRestingKey,
  type EntityHedgeBook,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import type { ExecutionLogEvent } from '@/lib/test-mode/execution-monitor';
import { dedupeMonitorEvents } from '@/lib/test-mode/execution-monitor';
import type { SimSpotQuote } from '@/lib/test-mode/sim-ticket-price';
import { getS3ObjectText, putS3Object, s3OwnerSegment } from '@/lib/s3';
import {
  normalizeOwnerEmail,
  type OwnedExecutionLogEvent,
} from '@/lib/execution-log-store';

const MAX_JOURNAL_EVENTS = 500;
/** ~30min of the server's 1s beat per leg — plenty to verify a fill against. */
const MAX_TAPE_POINTS_PER_KEY = 1_800;

/** Where the recorded tape is persisted. Exactly one store, never both. */
export type ExecutionStore = 's3' | 'postgres';

let unknownStoreWarned = false;

/**
 * Production defaults to S3; a local checkout sets `EXECUTION_STORE=postgres`
 * so the matcher writes the tape it can actually verify against.
 *
 * The tape used to be written to BOTH every beat — the S3 journal's
 * `tapeByCcy` and `leg_tape_ticks` carry the same points — which on a box
 * with Postgres but no AWS credentials meant a failed S3 put every second
 * forever, warned about on a 5-minute throttle, while Postgres quietly held
 * the real record. One store, chosen here, read back through the same
 * switch in `loadLegTapeTicks`.
 *
 * Events are deliberately NOT switched: `execution_logs` and the S3 journal
 * each have their own reader (`/api/execution-log`, `/api/execution-journal`),
 * so they are two products, not one written twice.
 */
export function executionStore(): ExecutionStore {
  const raw = process.env.EXECUTION_STORE?.trim().toLowerCase();
  if (!raw || raw === 's3') return 's3';
  if (raw === 'postgres') return 'postgres';
  // Never silently reinterpret a value the caller meant as something else:
  // say so once, then use the documented default.
  if (!unknownStoreWarned) {
    unknownStoreWarned = true;
    console.warn(
      `[fx-exec] EXECUTION_STORE="${raw}" is not "s3" or "postgres" — using s3`,
    );
  }
  return 's3';
}

export type JournalTapePoint = SimSpotQuote & { t: number };

function journalKey(userEmail: string, taskId: string): string {
  return `execution-journal/${s3OwnerSegment(userEmail)}/${taskId}.json`;
}

/**
 * Merge this beat's per-key tape points onto whatever the journal already
 * has: concatenate (never overwrite — a journal written before the split
 * still carries the browser's series, and a beat must not erase it) and cap
 * the tail per key. The matcher is this object's only writer: the browser
 * saves into its own `.desk` / `.notifications` objects (see
 * `app/api/execution-journal/route.ts`).
 */
function mergeTapeByCcy(
  prior: Record<string, JournalTapePoint[]>,
  incoming: Readonly<Record<string, readonly JournalTapePoint[]>> | undefined,
): Record<string, JournalTapePoint[]> {
  if (!incoming || Object.keys(incoming).length === 0) return prior;
  const merged: Record<string, JournalTapePoint[]> = { ...prior };
  for (const [key, points] of Object.entries(incoming)) {
    if (!points || points.length === 0) continue;
    const existing = merged[key] ?? [];
    const seen = new Set(existing.map(p => p.t));
    const appended = points.filter(p => p.mid > 0 && !seen.has(p.t));
    if (appended.length === 0) continue;
    merged[key] = [...existing, ...appended]
      .sort((a, b) => a.t - b.t)
      .slice(-MAX_TAPE_POINTS_PER_KEY);
  }
  return merged;
}

export async function persistExecutionJournalEvents(input: {
  userEmail: string;
  taskId: string;
  events: readonly ExecutionLogEvent[];
  /** This beat's per-leg tape points (tapeQuoteKey → new points), if any. */
  tapeByCcy?: Readonly<Record<string, readonly JournalTapePoint[]>>;
}): Promise<void> {
  if (executionStore() !== 's3') return;
  const key = journalKey(input.userEmail, input.taskId);
  let prior: ExecutionLogEvent[] = [];
  let tapeByCcy: Record<string, JournalTapePoint[]> = {};
  let notifications: unknown;
  try {
    const parsed = JSON.parse(await getS3ObjectText(key)) as {
      events?: unknown;
      tapeByCcy?: unknown;
      notifications?: unknown;
    };
    if (Array.isArray(parsed.events)) prior = parsed.events as ExecutionLogEvent[];
    if (parsed.tapeByCcy && typeof parsed.tapeByCcy === 'object') {
      tapeByCcy = parsed.tapeByCcy as Record<string, JournalTapePoint[]>;
    }
    notifications = parsed.notifications;
  } catch (err) {
    // Only a missing journal starts empty. Any other failed read (S3 down,
    // access denied, a corrupt object) must skip this beat's write: the
    // matcher is this object's only writer, so writing now would replace the
    // stored history with a single beat and nothing would ever restore it.
    // The caller logs the failure and keeps the beat's tape pending.
    if (!(err instanceof Error && err.name === 'NoSuchKey')) throw err;
  }
  const events = dedupeMonitorEvents([...input.events, ...prior]).slice(0, MAX_JOURNAL_EVENTS);
  const nextTapeByCcy = mergeTapeByCcy(tapeByCcy, input.tapeByCcy);
  await putS3Object({
    relativeKey: key,
    body: JSON.stringify({ events, tapeByCcy: nextTapeByCcy, notifications }),
    contentType: 'application/json',
    metadata: { task: input.taskId },
  });
}

export type LegTapePoint = { quoteKey: string; bid: number; ask: number; mid: number; t: number };

/**
 * DB-backed per-leg tape, alongside the S3 journal — not instead of it.
 * Local dev has Postgres credentials (DATABASE_URL) but not necessarily AWS
 * ones, so this is the path that actually works for local verification;
 * production keeps both. Append-only inserts, never a read-modify-write, so
 * unlike the S3 merge there is no shared-object race to reason about.
 */
export async function persistLegTapeTicks(input: {
  userEmail: string;
  taskId: string;
  points: readonly LegTapePoint[];
}): Promise<void> {
  if (executionStore() !== 'postgres') return;
  if (input.points.length === 0) return;
  const LegTapeTick = await getLegTapeTickModel();
  if (!LegTapeTick) return;
  await LegTapeTick.bulkCreate(
    input.points.map(p => ({
      quoteKey: p.quoteKey,
      userEmail: input.userEmail,
      taskId: input.taskId,
      timestamp: p.t,
      bid: p.bid,
      ask: p.ask,
      mid: p.mid,
    })),
  );
}

/**
 * The S3 journal's own copy of a leg's tape, in the shape `loadLegTapeTicks`
 * returns. The journal keeps at most MAX_TAPE_POINTS_PER_KEY per key and is
 * already de-duplicated by timestamp, so this only has to window, order and
 * take the newest `limit` — the same answer the DB query gives.
 */
async function journalTapePoints(
  userEmail: string,
  taskId: string,
  quoteKey: string,
  limit: number,
  window?: { fromMs?: number | null; toMs?: number | null },
): Promise<LegTapePoint[]> {
  let tapeByCcy: Record<string, JournalTapePoint[]> = {};
  try {
    const parsed = JSON.parse(
      await getS3ObjectText(journalKey(userEmail, taskId)),
    ) as { tapeByCcy?: Record<string, JournalTapePoint[]> };
    if (parsed.tapeByCcy && typeof parsed.tapeByCcy === 'object') {
      tapeByCcy = parsed.tapeByCcy;
    }
  } catch {
    // No journal yet, or S3 unreachable — the same empty answer the DB path
    // gives when Postgres is not configured. A chart draws from live prints;
    // it must not throw here.
    return [];
  }
  const points = tapeByCcy[quoteKey];
  if (!Array.isArray(points) || points.length === 0) return [];
  const fromMs =
    window?.fromMs != null && window.fromMs > 0 ? Math.floor(window.fromMs) : null;
  const toMs =
    window?.toMs != null && window.toMs > 0 ? Math.floor(window.toMs) : null;
  return points
    .filter(
      (p): p is JournalTapePoint =>
        Boolean(p) && Number.isFinite(p.t) && Number(p.mid) > 0,
    )
    .filter(p => (fromMs == null || p.t >= fromMs) && (toMs == null || p.t <= toMs))
    .sort((a, b) => a.t - b.t)
    .slice(-limit)
    .map(p => ({ quoteKey, bid: p.bid, ask: p.ask, mid: p.mid, t: p.t }));
}

/** Ordered tape history for one leg, scoped to its owner — DB-backed counterpart to the S3 journal read. */
export async function loadLegTapeTicks(
  userEmail: string,
  taskId: string,
  quoteKey: string,
  limit = 2_000,
  // Order-story window: scope the read to [fromMs, toMs] in the DATABASE,
  // not post-hoc — an old fill's span can sit entirely outside the newest
  // `limit` rows of a busy key, and filtering after a newest-first read
  // would return nothing for exactly the bookings that need history most.
  window?: { fromMs?: number | null; toMs?: number | null },
): Promise<LegTapePoint[]> {
  // Read from whichever store the write went to, so every caller — the
  // chart's backstop, the runtime, verify-strip-legs — works unchanged in
  // both deployments.
  if (executionStore() === 's3') {
    return journalTapePoints(userEmail, taskId, quoteKey, limit, window);
  }
  const loadStartMs = Date.now();
  const LegTapeTick = await getLegTapeTickModel();
  if (!LegTapeTick) {
    console.log(`[tape-load-db] key=${quoteKey} db=unavailable`);
    return [];
  }
  const timestamp: Record<symbol, number> = {};
  if (window?.fromMs != null && window.fromMs > 0) {
    timestamp[Op.gte] = Math.floor(window.fromMs);
  }
  if (window?.toMs != null && window.toMs > 0) {
    timestamp[Op.lte] = Math.floor(window.toMs);
  }
  const hasWindow = Object.getOwnPropertySymbols(timestamp).length > 0;

  const queryStartMs = Date.now();
  // Newest rows first, then re-sorted ascending: duplicate rows from a
  // partial-failure retry must shrink the window from the OLD end, never
  // push the fill-time points out of reach of the verify replay.
  const rows = await LegTapeTick.findAll({
    where: hasWindow
      ? { userEmail, taskId, quoteKey, timestamp }
      : { userEmail, taskId, quoteKey },
    order: [['timestamp', 'DESC']],
    limit,
    raw: true,
  });
  const queryDurationMs = Date.now() - queryStartMs;

  const parseStartMs = Date.now();
  rows.reverse();
  const result = rows.map(r => ({
    quoteKey: r.quoteKey,
    bid: parseFloat(String(r.bid)),
    ask: parseFloat(String(r.ask)),
    mid: parseFloat(String(r.mid)),
    t: Number(r.timestamp),
  }));
  const parseDurationMs = Date.now() - parseStartMs;
  const totalDurationMs = Date.now() - loadStartMs;

  const windowStr = hasWindow
    ? `[${window?.fromMs ?? '?'}-${window?.toMs ?? '?'}]`
    : 'full';
  console.log(
    `[tape-load-db] key=${quoteKey} rows=${rows.length} window=${windowStr} ` +
    `query=${queryDurationMs}ms parse=${parseDurationMs}ms total=${totalDurationMs}ms`
  );

  return result;
}

export type PersistedFillNotice = {
  userEmail: string;
  taskId: string;
  orderId: string;
  cancelledOrderIds: string[];
  outcome: 'filled' | 'blocked-policy' | 'released';
  ticket: HedgeTicket;
};

export type HydratedRestingOrder = {
  ticket: HedgeTicket;
  userEmail: string;
  taskId: string;
};

export async function persistFillToSandbox(notice: PersistedFillNotice) {
  const rec = await loadSandboxProgress(notice.userEmail, notice.taskId);
  const hedges = { ...(rec.state.hedgesByEntityId ?? {}) };
  let changed = false;
  const cancel = new Set(notice.cancelledOrderIds);
  const fillKey =
    notice.outcome === 'filled' ? hedgeRestingKey(notice.ticket) : null;
  const matches = (t: HedgeTicket) =>
    t.id === notice.orderId
    || cancel.has(t.id)
    || (fillKey != null && t.status === 'scheduled' && hedgeRestingKey(t) === fillKey);
  for (const [scope, book] of Object.entries(hedges)) {
    const list = book.bookedHedges ?? [];
    if (!list.some(matches)) continue;
    const next =
      notice.outcome === 'filled'
        ? list.map(t => {
            if (cancel.has(t.id)) {
              return t.status === 'cancelled'
                ? t
                : { ...t, status: 'cancelled' as const };
            }
            if (
              t.id === notice.orderId
              || (t.status === 'scheduled'
                && fillKey != null
                && hedgeRestingKey(t) === fillKey)
            ) {
              return notice.ticket;
            }
            return t;
          })
        : list.map(t => (t.id === notice.orderId ? notice.ticket : t));
    hedges[scope] = { ...book, bookedHedges: next } as EntityHedgeBook;
    changed = true;
  }
  // Do not insert a fill that is no longer on the book — a cancel must stay
  // cancelled even if the matcher still holds a stale working copy.
  if (!changed) return;
  await saveSandboxProgress(
    notice.userEmail,
    {
      ...rec.state,
      hedgesByEntityId: hedges,
      hedgesUpdatedAt: new Date().toISOString(),
    },
    notice.taskId,
  );
}

export async function persistExecutionLogRows(
  entries: readonly OwnedExecutionLogEvent[],
) {
  const Model = await getExecutionLogModel();
  if (!Model) return;
  await Model.bulkCreate(
    entries.map(({ ownerEmail, event: e }) => ({
      atMs: e.atMs,
      kind: e.kind,
      outcome: e.kind === 'order' ? e.outcome : null,
      orderId: e.kind === 'order' ? e.orderId : null,
      ccy: e.kind === 'order' ? e.ccy : null,
      userEmail: ownerEmail,
      summary: e.summary,
      payload: e,
    })),
  );
}

export async function persistOrderExecution(
  userEmail: string,
  orderId: string,
  executedAt: number,
  price: number,
  fill: 'bid' | 'ask',
  // Ticket snapshot at fill time — the sandbox book is current-state only,
  // so without this a cleared book orphans the execution (no ccy, no role,
  // not even enough to derive its tape key).
  ticket?: HedgeTicket,
) {
  const Model = await getOrderExecutionModel();
  if (!Model) return;
  const [row, created] = await Model.findOrCreate({
    where: { orderId, executedAt, userEmail: normalizeOwnerEmail(userEmail) },
    defaults: { price, fill, ticket: ticket ?? null },
  });
  if (!created && ticket && row.ticket == null) {
    await row.update({ ticket });
  }
}

export type ExecutedOrderDetail = {
  orderId: string;
  executions: { executedAt: number; price: number; fill: 'bid' | 'ask' }[];
  /** Fill-time snapshot; null for rows persisted before snapshots existed. */
  ticket: HedgeTicket | null;
  /** Which spelling of the ticket's tape key the record was found under. */
  tapeKey: string | null;
  /** Recorded tape over the ORDER'S story window: placement → last fill + tail. */
  tape: LegTapePoint[];
  window: { fromMs: number; toMs: number } | null;
};

/**
 * Everything the desk needs to audit one executed order in one call:
 * its execution prints, the ticket as it was at fill time, and the recorded
 * tape for its own key over its own story window. Snapshot-first — the
 * sandbox book is current-state and cannot answer for cleared orders.
 */
export async function loadExecutedOrderDetail(
  userEmail: string,
  taskId: string,
  orderId: string,
): Promise<ExecutedOrderDetail | null> {
  const Model = await getOrderExecutionModel();
  if (!Model) return null;
  // Scoped by owner, not by orderId alone: rows written before the owner
  // column existed have NULL there and are not returned to anyone.
  const rows = await Model.findAll({
    where: { orderId, userEmail: normalizeOwnerEmail(userEmail) },
    order: [['executedAt', 'ASC']],
    raw: true,
  });
  if (rows.length === 0) return null;
  const executions = rows.map(r => ({
    executedAt: Number(r.executedAt),
    price: parseFloat(String(r.price)),
    fill: r.fill,
  }));
  const ticket =
    (rows.find(r => r.ticket != null)?.ticket as HedgeTicket | undefined)
    ?? null;
  let tapeKey: string | null = null;
  let tape: LegTapePoint[] = [];
  let window: { fromMs: number; toMs: number } | null = null;
  if (ticket) {
    const placed = ticketPlacedAtMs(orderId);
    const lastFill = executions[executions.length - 1]!.executedAt;
    window = {
      fromMs: placed ?? lastFill - 30 * 60_000,
      toMs: lastFill + POST_FILL_TAPE_TAIL_MS,
    };
    for (const key of tapeQuoteKeyCandidates(ticket)) {
      const points = await loadLegTapeTicks(userEmail, taskId, key, 4_000, window);
      if (points.length > 0) {
        tapeKey = key;
        tape = points;
        break;
      }
    }
  }
  return { orderId, executions, ticket, tapeKey, tape, window };
}

export async function persistMatcherProcessState(input: {
  isRunning: boolean;
  lastTickAt: number | null;
}) {
  const Process = await getMatchingProcessStateModel();
  if (!Process) return;
  const [row] = await Process.findOrCreate({
    where: { processInstanceId: 'default' },
    defaults: {
      isRunning: input.isRunning,
      processInstanceId: 'default',
      lastTickAt: input.lastTickAt,
    },
  });
  await row.update({
    isRunning: input.isRunning,
    lastTickAt: input.lastTickAt,
  });
}

export type ConsumedOrderRow = {
  orderId: string;
  restKey: string | null;
  consumedAtMs: number;
};

/**
 * Durable copy of the matcher's consumed sets — what keeps a filled rest
 * from being resurrected (and double-booked) by a browser re-sync after the
 * in-memory runtime is replaced. Append-only; loaded back on runtime start.
 * With no DB configured this degrades to in-memory-only dedupe (the S3-only
 * production path keeps today's behavior).
 */
export async function persistConsumedOrders(
  rows: readonly ConsumedOrderRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const Model = await getConsumedOrderKeyModel();
  if (!Model) return;
  await Model.bulkCreate(
    rows.map(r => ({
      orderId: r.orderId,
      restKey: r.restKey,
      consumedAtMs: r.consumedAtMs,
    })),
  );
}

/** Recently consumed ids/keys — 48h covers any realistic GTC resync window. */
export async function loadConsumedOrders(
  sinceMs = Date.now() - 48 * 3600 * 1000,
): Promise<ConsumedOrderRow[]> {
  const Model = await getConsumedOrderKeyModel();
  if (!Model) return [];
  const { Op } = await import('sequelize');
  const rows = await Model.findAll({
    where: { consumedAtMs: { [Op.gte]: sinceMs } },
    attributes: ['orderId', 'restKey', 'consumedAtMs'],
    raw: true,
  });
  return rows.map(r => ({
    orderId: r.orderId,
    restKey: r.restKey,
    consumedAtMs: Number(r.consumedAtMs),
  }));
}

export async function loadHydratedRestingOrders(): Promise<
  HydratedRestingOrder[]
> {
  const Model = await getSandboxProgressModel();
  if (!Model) return [];
  const rows = await Model.findAll({
    attributes: ['userEmail', 'taskId', 'state'],
  });
  const out: HydratedRestingOrder[] = [];
  for (const row of rows) {
    const hedges = row.state?.hedgesByEntityId ?? {};
    for (const book of Object.values(hedges)) {
      for (const ticket of book.bookedHedges ?? []) {
        out.push({
          ticket,
          userEmail: row.userEmail,
          taskId: row.taskId,
        });
      }
    }
  }
  return out;
}
