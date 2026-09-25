import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getS3ObjectText, s3OwnerSegment } from '@/lib/s3';
import {
  chartTicketsAtEdge,
  fillTicketAtEdge,
  legPeersAtEdge,
  restingOrderTriggersAt,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import { tapeFillPrint, tapeQuoteKey } from '@/lib/test-mode/tape-candles';
import { loadLegTapeTicks } from '@/lib/test-mode/matching-process-persist';
import type { ExecutionLogEvent } from '@/lib/test-mode/execution-monitor';
import type { SimSpotQuote } from '@/lib/test-mode/sim-ticket-price';

export const runtime = 'nodejs';

type TapePoint = SimSpotQuote & { t: number };
type ExecutionJournal = {
  events?: ExecutionLogEvent[];
  tapeByCcy?: Record<string, TapePoint[]>;
};

/** Same key format as /api/execution-journal's matcher part — the tape the matcher recorded. */
function journalKeyFor(email: string, taskId: string): string {
  return `execution-journal/${s3OwnerSegment(email)}/${taskId}.json`;
}

function isValidTaskId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v);
}

function isTicket(v: unknown): v is HedgeTicket {
  if (!v || typeof v !== 'object') return false;
  const t = v as { id?: unknown; ccy?: unknown };
  return typeof t.id === 'string' && typeof t.ccy === 'string';
}

function pipSize(px: number): number {
  return px >= 20 ? 0.01 : 0.0001;
}

/** Nearest recorded tape point to a wall-clock instant, or null with no history. */
function nearestTapePoint(
  points: readonly TapePoint[] | undefined,
  atMs: number,
): TapePoint | null {
  if (!points || points.length === 0) return null;
  let best: TapePoint | null = null;
  let bestDelta = Infinity;
  for (const p of points) {
    const delta = Math.abs(p.t - atMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }
  return best;
}

type LegVerdict =
  | 'consistent'
  | 'no-fill-to-check'
  | 'tape-never-crossed-level'
  | 'no-tape-recorded'
  | 'journal-unavailable';

type LegReport = {
  stripId: string;
  edgeIndex: number;
  ccy: string;
  tenorMonths: number | null;
  maturityLabel: string | null;
  status: 'filled' | 'working' | 'cancelled';
  /** Exactly what TradeTicketPanel's chartLevelTickets/legPeersAtEdge would draw for this leg. */
  chart: {
    levels: { role: 'LIMIT' | 'TP' | 'SL'; price: number }[];
    fillPx: number | null;
    fillAtMs: number | null;
    placedPx: number | null;
  };
  /** Replays restingOrderTriggersAt against the recorded tape at fill time. */
  tapeCheck: {
    tapeQuoteKey: string;
    nearestTapeAtMs: number;
    nearestTapeMid: number;
    tapeAgeMs: number;
    wouldTrigger: boolean;
    pipsFromLimit: number | null;
  } | null;
  verdict: LegVerdict;
  notes: string[];
};

/**
 * POST /api/test/verify-strip-legs
 * Diagnostic, read-only: for each strip leg in the posted tickets, resolves
 * the same filled/working/cancelled state the ticket panel's chart uses
 * (legPeersAtEdge), then — for a filled leg — replays restingOrderTriggersAt
 * against the recorded tape history at fill time. Flags a leg whose fill the
 * recorded/displayed tape does not actually justify (the server matcher and
 * the browser's recorded tape are two independent random walks once a leg
 * is working; this is the check for whether they agreed at the moment it
 * filled). Reads the matcher's own S3 journal object (the browser saves
 * into separate `.desk` / `.notifications` objects) — no new persistence, no
 * writes of any kind.
 */
export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email?.trim();
  if (!email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const tickets: HedgeTicket[] = Array.isArray(body?.tickets)
      ? body.tickets.filter(isTicket)
      : [];
    const taskId = isValidTaskId(body?.taskId) ? body.taskId : 'workspace';

    let journal: ExecutionJournal = {};
    // Distinct from "no journal yet" (NoSuchKey, a genuinely fresh session):
    // any other failure means the read never happened at all — most likely
    // no S3 credentials in this environment — and a leg's tapeCheck must say
    // that plainly rather than report the misleading "no tape recorded",
    // which reads as "this session hasn't recorded anything," not "storage
    // was unreachable."
    let journalUnavailable: string | null = null;
    try {
      journal = JSON.parse(
        await getS3ObjectText(journalKeyFor(email, taskId)),
      ) as ExecutionJournal;
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name !== 'NoSuchKey') {
        journalUnavailable = err instanceof Error ? err.message : String(err);
        console.error('[api/test/verify-strip-legs] journal read failed', err);
      }
    }
    const tapeByCcy = journal.tapeByCcy ?? {};

    const byStrip = new Map<string, HedgeTicket[]>();
    for (const t of tickets) {
      if (!t.stripId) continue;
      const list = byStrip.get(t.stripId) ?? [];
      list.push(t);
      byStrip.set(t.stripId, list);
    }

    const legs: LegReport[] = [];
    for (const [stripId, stripTickets] of byStrip) {
      const edgeIndices = [
        ...new Set(stripTickets.map(t => t.stripEdgeIndex ?? 0)),
      ].sort((a, b) => a - b);

      for (const edgeIndex of edgeIndices) {
        const { filled, working, cancelled } = legPeersAtEdge(
          stripTickets,
          edgeIndex,
        );
        const resolved = filled ?? working[0] ?? cancelled;
        if (!resolved) continue;

        const status: LegReport['status'] = filled
          ? 'filled'
          : working.length > 0
            ? 'working'
            : 'cancelled';
        // Match TradeTicketPanel chartLevelTickets: bracket focus ignores cover
        // print; cover focus keeps working TP/SL visible after the cover fills.
        const levelSource = chartTicketsAtEdge(
          stripTickets,
          edgeIndex,
          resolved.bracketRole ? resolved : null,
        );
        const fillPeer = fillTicketAtEdge(
          stripTickets,
          edgeIndex,
          resolved.bracketRole ? resolved : filled ?? resolved,
        );
        const levels = levelSource
          .filter((t): t is HedgeTicket & { limitRate: number } =>
            t.limitRate != null && t.limitRate > 0,
          )
          .map(t => ({
            role: (t.bracketRole === 'takeProfit'
              ? 'TP'
              : t.bracketRole === 'stopLoss'
                ? 'SL'
                : 'LIMIT') as 'LIMIT' | 'TP' | 'SL',
            price: t.limitRate,
          }));

        const notes: string[] = [];
        let tapeCheck: LegReport['tapeCheck'] = null;
        let verdict: LegVerdict = 'no-fill-to-check';

        if (filled) {
          const key = tapeQuoteKey(filled);
          // DB first: local dev has Postgres credentials but not necessarily
          // AWS ones, and this is append-only (no shared-object race like
          // the S3 merge). Fall back to the S3 journal only if the DB has
          // nothing for this leg — e.g. an older fill from before this path
          // existed. journalUnavailable only matters once the DB has also
          // come up empty — it must never short-circuit a DB hit.
          const dbPoints = await loadLegTapeTicks(email, taskId, key);
          const usedDb = dbPoints.length > 0;
          const points = usedDb ? dbPoints : tapeByCcy[key];
          const atMs = filled.filledAtMs;
          if ((!points || points.length === 0) && !usedDb && journalUnavailable) {
            verdict = 'journal-unavailable';
            notes.push(
              `No DB-recorded tape for this leg, and the S3 journal could not be read (${journalUnavailable}) — `
              + 'this is not "nothing recorded yet", the S3 read never happened. Nothing below can be verified '
              + 'until at least one of the two is reachable.',
            );
          } else if (!points || points.length === 0) {
            verdict = 'no-tape-recorded';
            notes.push(
              `No recorded tape history under key "${key}" — cannot verify this fill against what the chart shows.`,
            );
          } else if (atMs == null || !Number.isFinite(atMs) || atMs <= 0) {
            verdict = 'no-tape-recorded';
            notes.push(
              'Filled ticket has no filledAtMs — cannot locate the tape point at fill time.',
            );
          } else {
            const nearest = nearestTapePoint(points, atMs);
            if (nearest) {
              const probe: HedgeTicket = { ...filled, status: 'scheduled' };
              const wouldTrigger = restingOrderTriggersAt(probe, {
                bid: nearest.bid,
                ask: nearest.ask,
              });
              const limit = filled.limitRate ?? null;
              const pips =
                limit != null
                  ? Math.abs(nearest.mid - limit) / pipSize(nearest.mid)
                  : null;
              const ageMs = Math.abs(nearest.t - atMs);
              tapeCheck = {
                tapeQuoteKey: key,
                nearestTapeAtMs: nearest.t,
                nearestTapeMid: nearest.mid,
                tapeAgeMs: ageMs,
                wouldTrigger,
                pipsFromLimit: pips,
              };
              if (!wouldTrigger) {
                verdict = 'tape-never-crossed-level';
                notes.push(
                  `Recorded tape ${ageMs}ms from the fill (mid ${nearest.mid}) does not cross limit ${limit} — `
                  + 'the chart\'s own recorded history does not justify this fill. This is the two-independent-'
                  + 'random-walk divergence: the server matcher\'s internal tape and the browser\'s recorded/'
                  + 'displayed tape are not the same series once the server owns fills.',
                );
              } else {
                verdict = 'consistent';
              }
            }
          }
        }

        legs.push({
          stripId,
          edgeIndex,
          ccy: resolved.ccy,
          tenorMonths: resolved.maturityMonths ?? null,
          maturityLabel: resolved.maturityLabel ?? null,
          status,
          chart: {
            levels,
            fillPx: (fillPeer ? tapeFillPrint(fillPeer) : null) ?? fillPeer?.limitRate ?? null,
            fillAtMs: fillPeer?.filledAtMs ?? null,
            placedPx: resolved.restingAnchorRate ?? null,
          },
          tapeCheck,
          verdict,
          notes,
        });
      }
    }

    const summary = {
      legsChecked: legs.length,
      consistent: legs.filter(l => l.verdict === 'consistent').length,
      mismatches: legs.filter(
        l => l.verdict !== 'consistent' && l.verdict !== 'no-fill-to-check',
      ).length,
    };

    return NextResponse.json({ taskId, summary, legs });
  } catch (error) {
    console.error('[api/test/verify-strip-legs] failed', error);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}
