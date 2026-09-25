/**
 * In-process matching / execution runtime.
 *
 * Lives on the Next.js Node server (not in the browser). A closed tab, a
 * refresh, or leaving Hedging Decision must not stop the tape or fills.
 * Survives only as long as this Node process does; scheduled tickets are
 * rehydrated from sandbox rows on start.
 */

import {
  appendExecutionLogs,
  isVisibleTo,
  normalizeOwnerEmail,
  type OwnedExecutionLogEvent,
} from '@/lib/execution-log-store';
import type { HedgeIpaQuote, HedgeTicket } from '@/lib/test-mode/hedge-var';
import { isListedEurGhostTicket } from '@/lib/test-mode/listed-eur-orders';
import {
  hedgeRestingKey,
  isLiveHedgeTicket,
  isMarketExecutedHedgeTicket,
  OVER_AUTOMATED_LIMIT_NOTE,
  autoFillAllowedByPolicy,
  quoteAfterFill,
  restingOrderHitSide,
  restingOrderTriggersAt,
  spotReferencedFillQuote,
  ticketNotionalUsdM,
  usdPerLocalFromQuote,
} from '@/lib/test-mode/hedge-var';
import {
  EXEC_LOG_TAG,
  beatEvent,
  dedupeMonitorEvents,
  eventsForBeat,
  explainRestingOrder,
  explainWorkingOrders,
  monitorSnapshotKey,
  nodeBeatStatusLine,
  toOrderEvent,
  type ExecutionLogEvent,
} from '@/lib/test-mode/execution-monitor';
import { MatchingEngine } from '@/lib/test-mode/matching-engine';
import {
  fillCounterpartyFor,
  POST_FILL_TAPE_TAIL_MS,
} from '@/lib/test-mode/ticket-desk-label';
import type { SimSpotQuote } from '@/lib/test-mode/sim-ticket-price';
import { pipSizeOf } from '@/lib/test-mode/sim-ticket-price';
import {
  markFxSpotInterest,
  seededFxSpotCurrencies,
  tickFxSpotTape,
} from '@/lib/fx-spot-tape';
import { usdMarketPair } from '@/lib/fx-market-rates';
import {
  isTapeContinuityBreak,
  parkMidAwayFromStopLimit,
  quoteIsWrongTapeForOrder,
  restingTapeAnchorMid,
  tapeInstrument,
  tapeQuoteKey,
} from '@/lib/test-mode/tape-candles';

export const MATCHING_INTERVAL_MS = 1_000;
/** ~30min of the server's own 1s beat per leg, kept in memory before the S3 cap trims it further. */
const RUNTIME_TAPE_CAP = 1_800;
/** Newest points served per key on a heartbeat — the poll merges them client-side. */
const TAPE_SERVE_MAX_POINTS = 600;
export const MATCHING_HEARTBEAT_BEATS = 6;
export const MATCHING_STALE_MS = MATCHING_INTERVAL_MS * 3;

const EMPTY_IPA: HedgeIpaQuote = {
  strike: null,
  strikeInput: '',
  premiumUsd: null,
  premiumPercent: null,
  fxSpot: null,
  fxOutright: null,
  atmVolPercent: null,
  impliedVolPercent: null,
  deltaPercent: null,
};

const DEFAULT_MIDS: Record<string, number> = {
  EUR: 1.17,
  GBP: 1.35,
  JPY: 150,
  MXN: 18.5,
  PLN: 3.65,
  TRY: 34,
  USD: 1,
};

export type MatchingOrderOwner = {
  ticket: HedgeTicket;
  userEmail: string;
  taskId: string;
};

export type MatchingFillNotice = {
  orderId: string;
  userEmail: string;
  taskId: string;
  ticket: HedgeTicket;
  cancelledOrderIds: string[];
  outcome: 'filled' | 'blocked-policy' | 'released';
  atMs: number;
};

export type MatchingHeartbeat = {
  ok: true;
  processAlive: boolean;
  isRunning: boolean;
  lastTickAt: number | null;
  ageMs: number | null;
  tickCount: number;
  intervalMs: number;
  ccyCount: number;
  workingOrders: number;
  recentFills: number;
  lastTape: {
    ccy: string;
    bid: number;
    ask: number;
    mid: number;
    timestamp: number;
  } | null;
  independentOfBrowser: boolean;
  survivesBrowserClose: boolean;
  rehydratesOrdersFromDb: boolean;
  runtime: 'nodejs-inprocess';
  verdict: 'live' | 'stale' | 'stopped';
  lastBeat: {
    atMs: number;
    elapsedMs: number;
    ccyCount: number;
    working: number;
    triggered: number;
    filled: number;
    blocked: number;
    summary: string;
  } | null;
  /** Matcher-owned monitor lines — not the blotter "booked" stub. */
  monitorEvents: ExecutionLogEvent[];
};

export type MatchingHeartbeatProbe = MatchingHeartbeat & {
  probe: {
    firstTickAt: number | null;
    secondTickAt: number | null;
    advanced: boolean;
    waitedMs: number;
    browserRequired: false;
  };
};

/** Bump when matcher fill/tape rules change so `next dev` HMR cannot keep a stale singleton filling on spot. */
export const MATCHING_RUNTIME_REV = 42;
const PERSIST_TIMEOUT_MS = 2_000;
/**
 * How long an open ticket keeps its currency recording after the last
 * heartbeat that named it. Comfortably longer than the browser's own poll
 * so a slow beat cannot punch a hole in the record, short enough that a
 * closed tab stops the recording promptly.
 */
export const WATCHED_CCY_TTL_MS = 30_000;
/**
 * How long a consumed SHAPE (not id) blocks a same-shape re-registration.
 * Long enough to absorb the 2s browser resync storm around a fill; short
 * enough that the desk re-placing the same level minutes later is a new
 * order, not a swallowed one.
 */
export const CONSUMED_SHAPE_WINDOW_MS = 15_000;

type GlobalFx = typeof globalThis & {
  __fxMatchingRuntime?: MatchingProcessRuntime;
  __fxMatchingRuntimeRev?: number;
};

/** Node-only DB I/O — imported from API routes, not from instrumentation. */
async function matchingPersist() {
  return import('./matching-process-persist');
}

async function withPersistTimeout<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Matcher persistence timed out')),
          PERSIST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function quoteFromMid(mid: number): SimSpotQuote {
  const pip = pipSizeOf(mid);
  return { bid: mid - pip, mid, ask: mid + pip };
}

function walkQuoteForTicket(t: HedgeTicket, mid: number): SimSpotQuote {
  // A stop a whole convention break away is on the wrong tape, not "about to
  // through-fill" — parking there would drag a shared tape onto the outright.
  const parked =
    t.bracketRole === 'stopLoss'
    && t.limitRate != null
    && !isTapeContinuityBreak(mid, t.limitRate)
      ? parkMidAwayFromStopLimit(
          mid,
          t.limitRate,
          restingOrderHitSide(t) === 'bid',
        )
      : mid;
  return quoteFromMid(parked);
}

/** On the canonical spot tape: spot tickets and spot-referenced forward legs. */
function isSpotTicket(t: HedgeTicket): boolean {
  return tapeInstrument(t) === 'spot';
}

/** The per-currency live spot feed key ("EUR|spot") — see tapeQuoteKey. */
function isCanonicalSpotKey(key: string): boolean {
  return /^[A-Z]{3}\|spot$/i.test(key);
}

/**
 * Mid a spot ticket may seed the SHARED per-currency spot tape with —
 * always its stamped SPOT when one exists, never its resting anchor first:
 * a mis-stamped short-tenor outright anchor sits within the 40-pip
 * continuity band of spot and would seed the shared tape pips high
 * (review M-4). Anchor is the fallback for stamp-less tickets only.
 */
function spotTapeSeedMid(t: HedgeTicket): number | null {
  const stampedSpot = t.ipaQuote?.fxSpot;
  if (stampedSpot != null && stampedSpot > 0) return stampedSpot;
  return restingTapeAnchorMid(t);
}

/**
 * The PERSISTED record an order's story lives on. Spot tickets own their
 * canonical key; a forward leg's story is the same currency's spot record —
 * its displayed series is spot + stamped points, so spot is what must be
 * guaranteed on disk.
 */
function storyTapeKey(t: HedgeTicket): string {
  return isSpotTicket(t)
    ? tapeQuoteKey(t)
    : `${t.ccy.toUpperCase()}|spot`;
}

function isWorkingRest(t: HedgeTicket): boolean {
  return t.status === 'scheduled' && t.limitRate != null;
}

function stripCoverSlot(t: Pick<HedgeTicket, 'ccy' | 'stripEdgeIndex'>): string {
  return `${t.ccy}|${t.stripEdgeIndex ?? 0}`;
}

function executedStripCoverSlots(tickets: readonly HedgeTicket[]): Set<string> {
  const slots = new Set<string>();
  for (const t of tickets) {
    if (!t.stripId || t.bracketRole) continue;
    if (!isMarketExecutedHedgeTicket(t)) continue;
    slots.add(stripCoverSlot(t));
  }
  return slots;
}

function isDuplicateStripCoverRest(
  t: HedgeTicket,
  filledCover: Set<string>,
): boolean {
  if (!t.stripId || t.bracketRole) return false;
  return filledCover.has(stripCoverSlot(t));
}


export class MatchingProcessRuntime {
  private readonly engine = new MatchingEngine(MATCHING_INTERVAL_MS, 'node');
  private readonly orders = new Map<string, MatchingOrderOwner>();
  /** Live booked tickets, for the automated notional cap. */
  private readonly liveTickets = new Map<string, HedgeTicket>();
  private readonly liveOwners = new Map<string, { userEmail: string; taskId: string }>();
  /**
   * Fills the browser has not yet booked. Count toward the cap until the
   * blotter either acks them or drops the id (cancel).
   */
  private readonly filledHold = new Map<string, MatchingOrderOwner>();
  /**
   * Recently EXECUTED tickets whose tape story is still open (fill + tail).
   * setLiveTicket deliberately skips stripId tickets and filledHold only
   * ever holds the matcher's own fills — so a strip leg executed on the
   * CLIENT path was invisible to every tape loop: its forward key was never
   * walked, recorded, served or persisted, and a reopened leg chart had
   * nothing to show. This map is the tape-only tracking for those tickets;
   * it feeds no cover/policy math.
   */
  private readonly bookedTapeHold = new Map<string, MatchingOrderOwner>();
  /**
   * Currencies a desk has a ticket OPEN on, with the instant last seen.
   * Desk rule: the record starts when the desk first engages the tile, not
   * when an order finally exists — a market execution creates its order at
   * the fill, so keying recording off orders alone left every live-executed
   * chart with nothing before its own fill. Entries lapse on their own
   * (WATCHED_CCY_TTL_MS) once the panel stops refreshing them.
   */
  private readonly watchedCcys = new Map<
    string,
    { ccy: string; userEmail: string; taskId: string; atMs: number }
  >();
  /** Filled or OCO-cancelled ids — the browser must not resurrect them. */
  private readonly consumedOrderIds = new Set<string>();
  /** Shape key → consumedAtMs; gates clones only inside CONSUMED_SHAPE_WINDOW_MS. */
  private readonly consumedOrderKeys = new Map<string, number>();
  /** Consumes not yet written to the DB — flushed each beat, kept on failure. */
  private readonly pendingConsumedRows: {
    orderId: string;
    restKey: string | null;
    consumedAtMs: number;
  }[] = [];
  /** Over-cap rests we already told the desk about — do not re-BLOCK every tick. */
  private readonly policyBlockedKeys = new Set<string>();
  private lastMonitorKey = '';
  private lastBeat: MatchingHeartbeat['lastBeat'] = null;
  private readonly monitorRing: OwnedExecutionLogEvent[] = [];
  private readonly fills: MatchingFillNotice[] = [];
  /**
   * The server's own recorded tape per leg (tapeQuoteKey), independent of
   * whether any browser tab is open. Persisted to the same S3 execution
   * journal the ticket panel writes, so a fill can be verified against the
   * tape that actually decided it even with no client connected.
   */
  private readonly tapeHistoryByKey = new Map<string, (SimSpotQuote & { t: number })[]>();
  /** Points recorded since the last DB flush, per leg — cleared once persisted. */
  private readonly pendingTapeByKey = new Map<string, (SimSpotQuote & { t: number })[]>();
  /**
   * Local dev has no AWS credentials, so the S3 journal write fails every
   * beat — logging the full error (stack + SDK metadata) that often is
   * flooded the terminal and, per the user, broke the testing workflow. One
   * detailed warning on the first failure, then a one-line reminder per beat
   * after that; reset on a success so a later real outage warns loudly again.
   */
  private s3JournalPersistFailedOnce = false;
  private s3JournalLastWarnAtMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickCount = 0;
  private stepping = false;
  private started = false;

  constructor() {
    const spots: Record<string, SimSpotQuote> = {};
    for (const [ccy, mid] of Object.entries(DEFAULT_MIDS)) {
      spots[ccy] = quoteFromMid(mid);
    }
    this.engine.initializeSpots(spots);
  }

  get isRunning(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.engine.mergeSpots({});
    await this.hydrateFromSandboxes();
    await this.persistProcessFlag(true);
    this.arm();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.engine.stop();
    void this.persistProcessFlag(false);
  }

  mergeSpots(spots: Record<string, SimSpotQuote>, allowJump = true) {
    const clean: Record<string, SimSpotQuote> = {};
    for (const [key, q] of Object.entries(spots)) {
      if (!q || !(q.mid > 0) || !(q.bid > 0) || !(q.ask > 0)) continue;
      if (/^[A-Z]{3}$/i.test(key)) {
        const matched = [...this.orders.values()]
          .map(owner => owner.ticket)
          .filter(ticket => ticket.ccy.toUpperCase() === key.toUpperCase());
        if (matched.length > 0) {
          for (const ticket of matched) {
            const destKey = tapeQuoteKey(ticket);
            // The canonical spot key IS the live market feed — orders never
            // veto it (a wide or stamp-less rest starving its own currency's
            // feed was review H2/H-B). Forward keys keep the wrong-tape veto
            // so a spot print cannot land on an outright tape.
            if (
              !isCanonicalSpotKey(destKey)
              && quoteIsWrongTapeForOrder(ticket, q)
            ) {
              continue;
            }
            clean[destKey] = q;
          }
          continue;
        }
      }
      const onKey = [...this.orders.values()]
        .map(owner => owner.ticket)
        .filter(ticket => tapeQuoteKey(ticket) === key);
      if (
        !isCanonicalSpotKey(key)
        && onKey.length > 0
        && onKey.every(ticket => quoteIsWrongTapeForOrder(ticket, q))
      ) {
        continue;
      }
      clean[key] = q;
    }
    if (Object.keys(clean).length > 0) this.engine.mergeSpots(clean, allowJump);
  }

  /**
   * Consumption gates on IDENTITY (ticket id) durably, and on SHAPE
   * (hedgeRestingKey — no id in it) only for a short window after the
   * consume. The window kills resync-storm clones: a browser re-post of a
   * just-filled rest under a regenerated id arrives within seconds. An
   * ETERNAL shape gate (what this used to be) silently swallowed every NEW
   * order the desk deliberately placed at a level that had ever filled once
   * — POST /orders returned 200 while the matcher stayed at 0 working,
   * forever, for that shape.
   */
  private isConsumed(t: HedgeTicket): boolean {
    if (this.consumedOrderIds.has(t.id)) return true;
    const at = this.consumedOrderKeys.get(hedgeRestingKey(t));
    return at != null && Date.now() - at < CONSUMED_SHAPE_WINDOW_MS;
  }

  /**
   * The in-memory consumed sets die with this instance, and a browser
   * re-sync of a stale sandbox row then resurrects an already-filled rest
   * and double-books it. Every consume is therefore also queued for the DB
   * (flushed on the beat, reloaded on start) so the dedupe survives an HMR
   * rev bump or a process restart.
   */
  private queueConsumedRow(orderId: string, restKey: string | null) {
    this.pendingConsumedRows.push({
      orderId,
      restKey,
      consumedAtMs: Date.now(),
    });
  }

  private consumeTicket(t: HedgeTicket, restKey = true) {
    this.consumedOrderIds.add(t.id);
    const key = restKey ? hedgeRestingKey(t) : null;
    if (key) this.consumedOrderKeys.set(key, Date.now());
    this.queueConsumedRow(t.id, key);
  }

  private consumeLiveRest(t: HedgeTicket) {
    if (!isLiveHedgeTicket(t) || t.stripId || t.limitRate == null) return;
    const key = hedgeRestingKey(t);
    this.consumedOrderIds.add(t.id);
    this.consumedOrderKeys.set(key, Date.now());
    this.queueConsumedRow(t.id, key);
  }

  private async flushConsumedRows() {
    if (this.pendingConsumedRows.length === 0) return;
    const rows = this.pendingConsumedRows.splice(0);
    try {
      await withPersistTimeout(async () => {
        const persist = await matchingPersist();
        await persist.persistConsumedOrders(rows);
      });
    } catch (err) {
      // Keep them for the next beat — losing a row reopens the double-book
      // window this exists to close.
      this.pendingConsumedRows.unshift(...rows);
      console.warn(`${EXEC_LOG_TAG} consumed-order persist failed, will retry`, err);
    }
  }

  private setLiveTicket(
    ticket: HedgeTicket,
    userEmail: string,
    taskId: string,
  ) {
    if (!ticket.id || ticket.stripId || !isLiveHedgeTicket(ticket)) return;
    this.liveTickets.set(ticket.id, ticket);
    this.liveOwners.set(ticket.id, { userEmail, taskId });
  }

  /** Live cover for this user comes from the blotter, plus fills not acked yet. */
  private rebuildLiveCover(
    userEmail: string,
    taskId: string,
    tickets: readonly HedgeTicket[],
  ) {
    for (const [id, owner] of [...this.liveOwners]) {
      if (owner.userEmail === userEmail && owner.taskId === taskId) {
        this.liveTickets.delete(id);
        this.liveOwners.delete(id);
      }
    }
    for (const t of tickets) {
      this.setLiveTicket(t, userEmail, taskId);
    }
    for (const [id, owner] of [...this.filledHold]) {
      if (owner.userEmail !== userEmail || owner.taskId !== taskId) continue;
      const inPayload = tickets.find(t => t.id === id);
      if (!inPayload) {
        this.filledHold.delete(id);
        continue;
      }
      if (isLiveHedgeTicket(inPayload)) {
        this.filledHold.delete(id);
        continue;
      }
      this.setLiveTicket(owner.ticket, userEmail, taskId);
    }
    const email = userEmail.trim().toLowerCase();
    const task = taskId || '02';
    // The post-fill recording hold is a SERVER guarantee: once a fill is
    // registered, its tail of tape keeps persisting no matter what the
    // browser posts next. So a rebuild never wipes this owner's holds —
    // wiping-then-readding-from-payload made the guarantee exactly as
    // durable as the next browser payload (a cleared book, a filtered
    // view, or a closed tab silently stopped the recording mid-tail).
    // Entries self-expire at fill + tail in openTapeHolds; the payload
    // loop below only ADDS holds the server has not seen — client-path
    // fills, and fills from before a runtime restart. Brackets included:
    // a TP/SL fill's tail is the record that justifies it.
    const nowMs = Date.now();
    for (const t of tickets) {
      if (!t.id) continue;
      if (!isMarketExecutedHedgeTicket(t)) continue;
      const filledAtMs = t.filledAtMs;
      if (filledAtMs == null || !Number.isFinite(filledAtMs)) continue;
      if (nowMs - filledAtMs > POST_FILL_TAPE_TAIL_MS) continue;
      if (this.bookedTapeHold.has(t.id)) continue;
      this.bookedTapeHold.set(t.id, { ticket: t, userEmail: email, taskId: task });
    }
  }

  /**
   * The desk has a ticket open on these currencies — start their spot
   * record now, before any order exists. Called from the orders sync the
   * panel already drives, so it refreshes while the ticket stays open.
   */
  watchCcys(
    userEmail: string,
    taskId: string,
    ccys: readonly string[],
  ) {
    const email = userEmail.trim().toLowerCase();
    const task = taskId || '02';
    const atMs = Date.now();
    for (const raw of ccys) {
      const ccy = String(raw ?? '').trim().toUpperCase();
      if (ccy.length !== 3) continue;
      this.watchedCcys.set(`${email}|${task}|${ccy}`, {
        ccy,
        userEmail: email,
        taskId: task,
        atMs,
      });
    }
  }

  /** Watched currencies whose ticket is still open (TTL not lapsed). */
  private *openWatchedCcys(): IterableIterator<{
    ccy: string;
    userEmail: string;
    taskId: string;
  }> {
    const nowMs = Date.now();
    for (const [key, watch] of [...this.watchedCcys]) {
      if (nowMs - watch.atMs > WATCHED_CCY_TTL_MS) {
        this.watchedCcys.delete(key);
        continue;
      }
      yield watch;
    }
  }

  /** bookedTapeHold entries whose story window (fill + tail) is still open. */
  private *openTapeHolds(): IterableIterator<MatchingOrderOwner> {
    const nowMs = Date.now();
    for (const [id, owner] of [...this.bookedTapeHold]) {
      const filledAtMs = owner.ticket.filledAtMs;
      if (
        filledAtMs == null
        || !Number.isFinite(filledAtMs)
        || nowMs - filledAtMs > POST_FILL_TAPE_TAIL_MS
      ) {
        this.bookedTapeHold.delete(id);
        continue;
      }
      yield owner;
    }
  }

  private rebaseWorkingTape() {
    for (const owner of this.orders.values()) {
      const t = owner.ticket;
      const quoteKey = tapeQuoteKey(t);
      const mid = isSpotTicket(t) ? spotTapeSeedMid(t) : restingTapeAnchorMid(t);
      if (mid == null || !(mid > 0)) continue;
      const cur = this.engine.getState().currentSpot[quoteKey];
      // The shared spot tape follows the live fx-spot feed. An order may SEED
      // a missing key from its own spot stamps, but never re-anchor a key
      // that already has a print — a stale stamp a few pips off would pin
      // the tape every beat while the market moves away (review H1), and
      // every other order on the key would be decided against a price the
      // market never printed.
      if (isSpotTicket(t)) {
        if (cur) continue;
      } else if (cur && !quoteIsWrongTapeForOrder(t, cur)) {
        continue;
      }
      const q = walkQuoteForTicket(t, mid);
      this.engine.setWalkAnchor(quoteKey, q);
      this.mergeSpots({ [quoteKey]: q }, true);
    }
  }

  /**
   * Spot keys share /api/fx-spot's Brownian series (last live mid, walked
   * while the overlay is stale). Forwards keep their own parked walk.
   */
  private pullSharedSpotTape() {
    const ccys = new Set<string>();
    for (const key of Object.keys(this.engine.getState().currentSpot)) {
      const ccy = key.split('|')[0]?.toUpperCase();
      if (ccy && ccy.length === 3) ccys.add(ccy);
    }
    // The SPOT record is every ticket's story (spot-only storage): it must
    // tick for any currency the desk holds ANYTHING in — forward legs
    // included, stamped or not.
    for (const owner of this.orders.values()) {
      ccys.add(owner.ticket.ccy.toUpperCase());
    }
    for (const t of this.liveTickets.values()) {
      ccys.add(t.ccy.toUpperCase());
    }
    // Forward keys ride the SAME live feed: outright = live spot + the
    // ticket's stamped forward points (fxOutright − fxSpot). A forward
    // triggers off the forward-points-based live rate — never the raw spot
    // print, and never an independent walk drifting away from the market.
    // Tickets without both stamps keep the engine's own walk.
    const fwdPointsByKey = new Map<string, { ccy: string; points: number }>();
    const noteForwardKey = (t: HedgeTicket) => {
      if (isSpotTicket(t)) return;
      const stampedSpot = t.ipaQuote?.fxSpot;
      const stampedOutright = t.ipaQuote?.fxOutright;
      if (
        stampedSpot == null || !(stampedSpot > 0)
        || stampedOutright == null || !(stampedOutright > 0)
      ) {
        return;
      }
      const key = tapeQuoteKey(t);
      if (!fwdPointsByKey.has(key)) {
        fwdPointsByKey.set(key, {
          ccy: t.ccy.toUpperCase(),
          points: stampedOutright - stampedSpot,
        });
      }
    };
    for (const owner of this.orders.values()) noteForwardKey(owner.ticket);
    for (const t of this.liveTickets.values()) noteForwardKey(t);
    // Client-executed legs (strip legs above all) ride the live feed through
    // their post-fill tail so their story gets a real recorded series.
    for (const owner of this.openTapeHolds()) {
      ccys.add(owner.ticket.ccy.toUpperCase());
      if (!isSpotTicket(owner.ticket)) noteForwardKey(owner.ticket);
    }
    // An OPEN ticket records from the moment the desk engages the tile —
    // a market execution has no order until it fills, so without this its
    // chart could never have a single candle before its own fill print.
    for (const watch of this.openWatchedCcys()) ccys.add(watch.ccy);
    for (const fwd of fwdPointsByKey.values()) ccys.add(fwd.ccy);
    // Every pair a ticket ever opened keeps ticking, so its day record keeps
    // growing after the ticket closed — not only the DEFAULT_MIDS set.
    for (const ccy of seededFxSpotCurrencies()) ccys.add(ccy);

    const nowMs = Date.now();
    // A resting or live ticket keeps its pair's live refresh on the fast
    // cadence; pairs only the DEFAULT_MIDS walks touch drop to the idle one.
    for (const owner of this.orders.values()) {
      markFxSpotInterest(owner.ticket.ccy, nowMs);
    }
    for (const t of this.liveTickets.values()) markFxSpotInterest(t.ccy, nowMs);
    const tapedByCcy = new Map<
      string,
      { quote: SimSpotQuote; live: SimSpotQuote }
    >();
    for (const ccy of ccys) {
      const taped = tickFxSpotTape(usdMarketPair(ccy), nowMs)
        ?? tickFxSpotTape(ccy, nowMs);
      if (taped) {
        tapedByCcy.set(ccy, taped);
        this.engine.applySharedTape(ccy, taped.quote, taped.live);
        this.engine.applySharedTape(`${ccy}|spot`, taped.quote, taped.live);
        continue;
      }
      // No live print ingested yet (cold server before the first
      // /api/fx-spot poll, or a test env). The spot record is every
      // ticket's story under spot-only storage, so it must still RUN —
      // seed the canonical key from the engine's own ambient walk and let
      // it keep walking until the live feed takes over.
      const spotKey = `${ccy}|spot`;
      const cur = this.engine.getState().currentSpot;
      if (!cur[spotKey]) {
        const seed =
          cur[ccy]
          ?? (DEFAULT_MIDS[ccy] != null
            ? quoteFromMid(DEFAULT_MIDS[ccy]!)
            : null);
        if (seed) {
          this.engine.mergeSpots({
            [spotKey]: { bid: seed.bid, mid: seed.mid, ask: seed.ask },
          });
        }
      }
    }
    for (const [key, fwd] of fwdPointsByKey) {
      const taped = tapedByCcy.get(fwd.ccy);
      if (!taped) continue;
      const shifted = (q: SimSpotQuote): SimSpotQuote => ({
        bid: q.bid + fwd.points,
        mid: q.mid + fwd.points,
        ask: q.ask + fwd.points,
      });
      this.engine.applySharedTape(key, shifted(taped.quote), shifted(taped.live));
    }
  }

  /**
   * Keep a tape running for every key the desk holds a BOOKED ticket on,
   * through the post-fill tail.
   *
   * `upsertOrders` seeds the engine only for WORKING rests, so a leg that
   * executed on the beat it was placed — every market fill — never entered
   * the engine's quote state and recorded no tape at all. Its chart then had
   * nothing to show and tripped the blank-plot guard: EUR|forward|t5.00 had
   * zero rows while the one leg that actually rested (t9.00) had 3,942.
   *
   * A booked leg's tape is the record of what happened to the position, so
   * it keeps walking until its story window closes (fill + tail) — after
   * that the chart is frozen anyway and more points would be waste.
   */
  private pullLiveTicketTapes() {
    const nowMs = Date.now();
    const seed = (t: HedgeTicket) => {
      // Canonical spot keys belong to pullSharedSpotTape's live feed.
      if (isSpotTicket(t)) return;
      const filledAtMs = t.filledAtMs;
      if (
        filledAtMs != null
        && Number.isFinite(filledAtMs)
        && nowMs - filledAtMs > POST_FILL_TAPE_TAIL_MS
      ) {
        return;
      }
      const quoteKey = tapeQuoteKey(t);
      if (this.engine.getState().currentSpot[quoteKey]) return;
      // Spot tickets seed from their stamped spot, exactly as the other two
      // seed sites do. Reaching for the outright anchor here put a forward
      // leg's outright on the shared `CCY|spot` key whenever that key had no
      // print yet — after a restart, or on the first beat of a new session.
      const anchor = isSpotTicket(t) ? spotTapeSeedMid(t) : restingTapeAnchorMid(t);
      if (anchor == null || !(anchor > 0)) return;
      // Engine-level merge on purpose: the runtime's own mergeSpots gates on
      // WORKING orders for the key, and a booked leg has none by definition.
      this.engine.mergeSpots({ [quoteKey]: quoteFromMid(anchor) });
    };
    for (const t of this.liveTickets.values()) seed(t);
    for (const owner of this.filledHold.values()) seed(owner.ticket);
    // Stamp-less client fills still get an anchored walk; stamped ones are
    // already riding the shared live feed via pullSharedSpotTape.
    for (const owner of this.openTapeHolds()) seed(owner.ticket);
  }

  upsertOrders(owners: readonly MatchingOrderOwner[]) {
    for (const owner of owners) {
      if (!owner.ticket.id || !isWorkingRest(owner.ticket)) continue;
      if (this.isConsumed(owner.ticket)) continue;
      const restKey = hedgeRestingKey(owner.ticket);
      const ticket =
        this.policyBlockedKeys.has(restKey)
        && owner.ticket.ipaQuote?.errorMessage !== OVER_AUTOMATED_LIMIT_NOTE
          ? {
              ...owner.ticket,
              ipaQuote: {
                ...(owner.ticket.ipaQuote ?? EMPTY_IPA),
                errorMessage: OVER_AUTOMATED_LIMIT_NOTE,
              },
            }
          : owner.ticket;
      this.orders.set(owner.ticket.id, {
        ticket,
        userEmail: owner.userEmail.trim().toLowerCase(),
        taskId: owner.taskId || '02',
      });
      const anchor = isSpotTicket(owner.ticket)
        ? spotTapeSeedMid(owner.ticket)
        : restingTapeAnchorMid(owner.ticket);
      if (anchor != null && anchor > 0) {
        const quoteKey = tapeQuoteKey(owner.ticket);
        const cur = this.engine.getState().currentSpot[quoteKey];
        // The shared spot tape follows the live spot feed: an order only
        // seeds it when the key has no print yet — it never re-parks a live
        // spot series onto its own stamps (review H1).
        if (isSpotTicket(owner.ticket) && cur) continue;
        const q = walkQuoteForTicket(owner.ticket, anchor);
        this.engine.setWalkAnchor(quoteKey, q);
        const jump =
          !cur
          || quoteIsWrongTapeForOrder(owner.ticket, cur)
          || isTapeContinuityBreak(cur.mid, anchor);
        this.mergeSpots({ [quoteKey]: q }, jump);
      }
    }
  }

  replaceUserOrders(
    userEmail: string,
    taskId: string,
    tickets: readonly HedgeTicket[],
    spots?: Record<string, SimSpotQuote>,
  ) {
    const email = userEmail.trim().toLowerCase();
    const task = taskId || '02';
    for (const t of tickets) {
      this.consumeLiveRest(t);
    }
    for (const [id, owner] of this.orders) {
      if (owner.userEmail === email && owner.taskId === task) {
        this.orders.delete(id);
      }
    }
    const filledCover = executedStripCoverSlots(tickets);
    this.upsertOrders(
      tickets
        .filter(t => isWorkingRest(t) && !this.isConsumed(t))
        .filter(t => !isDuplicateStripCoverRest(t, filledCover))
        .map(ticket => ({
          ticket,
          userEmail: email,
          taskId: task,
        })),
    );
    this.rebuildLiveCover(email, task, tickets);
    if (spots) {
      // Forward keys are owned by their order's parked anchor, so ambient
      // browser quotes must not fight them. Spot keys are the opposite: the
      // shared spot tape IS the live feed, so a working spot order must not
      // block it.
      const workingCcys = new Set(
        tickets
          .filter(t => isWorkingRest(t) && !this.isConsumed(t))
          .filter(t => !isDuplicateStripCoverRest(t, filledCover))
          .filter(t => !isSpotTicket(t))
          .map(t => tapeQuoteKey(t)),
      );
      const safe: Record<string, SimSpotQuote> = {};
      const liveSpotFeed: Record<string, SimSpotQuote> = {};
      for (const [ccy, q] of Object.entries(spots)) {
        if (workingCcys.has(ccy)) continue;
        // The browser's spot posts (bare CCY or canonical spot key) are the
        // live market feed: they may JUMP a stale spot key back to the
        // market — without this, a key seeded >40 pips away can never be
        // corrected and every spot order fills against a price the market
        // never printed (review H-A). Forward keys keep no-jump continuity.
        if (isCanonicalSpotKey(ccy) || /^[A-Z]{3}$/i.test(ccy)) {
          liveSpotFeed[ccy] = q;
        } else {
          safe[ccy] = q;
        }
      }
      this.mergeSpots(safe, false);
      this.mergeSpots(liveSpotFeed, true);
    }
  }

  /** Drop the resurrecting EUR strip / option / TP-SL stack from memory. */
  dropListedEurOrders(): { dropped: number; ids: string[] } {
    const ids: string[] = [];
    for (const [id, owner] of [...this.orders]) {
      if (!isListedEurGhostTicket(owner.ticket)) continue;
      this.consumeTicket(owner.ticket);
      this.orders.delete(id);
      ids.push(id);
    }
    for (const [id, ticket] of [...this.liveTickets]) {
      if (!isListedEurGhostTicket(ticket)) continue;
      this.consumeTicket(ticket);
      this.liveTickets.delete(id);
      this.liveOwners.delete(id);
      if (!ids.includes(id)) ids.push(id);
    }
    return { dropped: ids.length, ids };
  }

  /**
   * Current print on one tape key, read-only. `heartbeat().lastTape` is only
   * the map's first entry (the bare spot feed) — anything checking a specific
   * leg's tape (a composite forward key) must read that key, not lastTape.
   */
  quoteForKey(quoteKey: string): SimSpotQuote | null {
    return this.engine.getState().currentSpot[quoteKey] ?? null;
  }

  /**
   * The server's own recorded tape for every key this user has a working or
   * live ticket on — the record the matcher actually decides fills against.
   * This is what the UI charts instead of a browser-generated walk; the same
   * points land in LegTapeTick / the S3 journal, so chart, matcher and the
   * persistent record are one series.
   */
  tapeForUser(
    userEmail: string,
  ): Record<string, (SimSpotQuote & { t: number })[]> {
    const email = userEmail.trim().toLowerCase();
    // Serving mirrors storage: ONE recorded series per currency (the spot
    // record — storyTapeKey), whatever instrument the user's tickets are.
    // Forward series are derived client-side from spot + stamped points.
    const keys = new Set<string>();
    for (const owner of this.orders.values()) {
      if (owner.userEmail === email) keys.add(storyTapeKey(owner.ticket));
    }
    for (const [id, owner] of this.liveOwners) {
      if (owner.userEmail !== email) continue;
      const ticket = this.liveTickets.get(id);
      if (ticket) keys.add(storyTapeKey(ticket));
    }
    // A just-filled strip leg lives only in filledHold until the browser
    // acks it (setLiveTicket skips stripId tickets) — its tape must keep
    // flowing to the chart through exactly the beats around its fill.
    for (const owner of this.filledHold.values()) {
      if (owner.userEmail === email) keys.add(storyTapeKey(owner.ticket));
    }
    // Client-executed legs in their post-fill tail — booked strip legs
    // never reach liveTickets or filledHold, so without this their series
    // was recorded but never served.
    for (const owner of this.openTapeHolds()) {
      if (owner.userEmail === email) keys.add(storyTapeKey(owner.ticket));
    }
    // Currencies with a ticket open right now: the desk is watching the
    // chart before any order exists, so the record must reach it live.
    for (const watch of this.openWatchedCcys()) {
      if (watch.userEmail === email) keys.add(`${watch.ccy}|spot`);
    }
    const out: Record<string, (SimSpotQuote & { t: number })[]> = {};
    for (const key of keys) {
      const hist = this.tapeHistoryByKey.get(key);
      if (hist && hist.length > 0) out[key] = hist.slice(-TAPE_SERVE_MAX_POINTS);
    }
    return out;
  }

  recentFillsForUser(userEmail: string, sinceMs = 0): MatchingFillNotice[] {
    const email = userEmail.trim().toLowerCase();
    return this.fills.filter(f => f.userEmail === email && f.atMs >= sinceMs);
  }

  fillsViewForUser(userEmail: string) {
    return this.recentFillsForUser(userEmail, Date.now() - 60 * 60 * 1000)
      .slice(0, 40)
      .map(f => ({
        orderId: f.orderId,
        taskId: f.taskId,
        outcome: f.outcome,
        ticket: f.ticket,
        cancelledOrderIds: f.cancelledOrderIds,
        atMs: f.atMs,
      }));
  }

  /** The desk an order belongs to, from whichever map still tracks it. */
  private ownerEmailOf(orderId: string): string | null {
    const owner =
      this.orders.get(orderId)
      ?? this.filledHold.get(orderId)
      ?? this.liveOwners.get(orderId)
      ?? this.bookedTapeHold.get(orderId);
    return owner ? normalizeOwnerEmail(owner.userEmail) : null;
  }

  private ownedEvent(event: ExecutionLogEvent): OwnedExecutionLogEvent {
    return {
      ownerEmail: event.kind === 'order' ? this.ownerEmailOf(event.orderId) : null,
      event,
    };
  }

  /**
   * Monitor lines for ONE desk. Decisions are still computed over every
   * desk's tickets (so each line reads exactly as the matcher decided it);
   * only the output is filtered to the viewer. No viewer, no order lines.
   */
  private liveMonitorEvents(viewerEmail: string | null): ExecutionLogEvent[] {
    if (!viewerEmail) return [];
    const viewer = normalizeOwnerEmail(viewerEmail);
    const quotes = new Map(Object.entries(this.engine.getState().currentSpot));
    const decisions = explainWorkingOrders(
      [
        ...this.liveTickets.values(),
        ...[...this.orders.values()].map(o => o.ticket),
        // Client-executed legs: without these the monitor showed nothing
        // for a strip filled through the leg-row click path.
        ...[...this.openTapeHolds()].map(o => o.ticket),
      ],
      quotes,
    );
    const atMs = Date.now();
    const live = decisions
      .filter(
        d =>
          d.outcome === 'working'
          || d.outcome === 'filled'
          || d.outcome === 'blocked-policy',
      )
      .filter(d => this.ownerEmailOf(d.orderId) === viewer)
      .map(d => toOrderEvent({ ...d, atMs }));
    const beat = this.lastBeat
      ? [{ kind: 'beat' as const, ...this.lastBeat, atMs }]
      : [];
    const ring = this.monitorRing
      .filter(entry => isVisibleTo(entry, viewer))
      .map(entry => entry.event);
    return dedupeMonitorEvents([...live, ...beat, ...ring]).slice(0, 120);
  }

  /**
   * `viewerEmail` scopes `monitorEvents` to that desk's own orders. Omit it
   * (liveness-only callers) and the payload carries no order lines at all.
   */
  heartbeat(viewerEmail: string | null = null): MatchingHeartbeat {
    const state = this.engine.getState();
    const lastTickAt = state.lastTickAt;
    const ageMs = lastTickAt == null ? null : Math.max(0, Date.now() - lastTickAt);
    const processAlive = this.started && ageMs != null && ageMs < MATCHING_STALE_MS;
    const tape = Object.entries(state.currentSpot)[0];
    let verdict: MatchingHeartbeat['verdict'] = 'stopped';
    if (this.started && processAlive) verdict = 'live';
    else if (this.started) verdict = 'stale';
    return {
      ok: true,
      processAlive,
      isRunning: this.started,
      lastTickAt,
      ageMs,
      tickCount: this.tickCount,
      intervalMs: MATCHING_INTERVAL_MS,
      ccyCount: Object.keys(state.currentSpot).length,
      workingOrders: this.orders.size,
      recentFills: this.fills.length,
      lastTape: tape
        ? {
            ccy: tape[0],
            bid: tape[1].bid,
            ask: tape[1].ask,
            mid: tape[1].mid,
            timestamp: lastTickAt ?? Date.now(),
          }
        : null,
      independentOfBrowser: true,
      survivesBrowserClose: this.started,
      rehydratesOrdersFromDb: true,
      runtime: 'nodejs-inprocess',
      verdict,
      lastBeat: this.lastBeat,
      monitorEvents: this.liveMonitorEvents(viewerEmail),
    };
  }

  async probe(
    waitedMs: number,
    viewerEmail: string | null = null,
  ): Promise<MatchingHeartbeatProbe> {
    const firstTickAt = this.engine.getState().lastTickAt;
    await this.step();
    if (waitedMs > 0) {
      await new Promise(r => setTimeout(r, Math.min(waitedMs, 5_000)));
      await this.step();
    }
    const second = this.heartbeat(viewerEmail);
    return {
      ...second,
      probe: {
        firstTickAt,
        secondTickAt: second.lastTickAt,
        advanced: (second.lastTickAt ?? 0) > (firstTickAt ?? 0),
        waitedMs,
        browserRequired: false,
      },
    };
  }

  async step(): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    const t0 = Date.now();
    try {
      this.rebaseWorkingTape();
      this.pullSharedSpotTape();
      this.pullLiveTicketTapes();
      await this.engine.step();
      this.tickCount += 1;
      const elapsedMs = Date.now() - t0;
      const quotes = new Map(
        Object.entries(this.engine.getState().currentSpot),
      );
      const nowMs = Date.now();
      for (const [quoteKey, q] of quotes) {
        if (!(q.mid > 0)) continue;
        // ONE recorded tape per currency: the canonical spot series. A
        // forward key's series is DERIVED — live spot shifted by the
        // ticket's stamped points (pullSharedSpotTape) — so persisting it
        // stores a redundant transform and lets it drift from the record.
        // The UI renders forward legs as spot history + points.
        if (!isCanonicalSpotKey(quoteKey)) continue;
        const point = { bid: q.bid, ask: q.ask, mid: q.mid, t: nowMs };
        const hist = this.tapeHistoryByKey.get(quoteKey) ?? [];
        hist.push(point);
        if (hist.length > RUNTIME_TAPE_CAP) hist.shift();
        this.tapeHistoryByKey.set(quoteKey, hist);
        const pending = this.pendingTapeByKey.get(quoteKey) ?? [];
        pending.push(point);
        // Keys no owner group ever flushes (ambient DEFAULT_MIDS walks) must
        // not grow one point per second for the process lifetime.
        if (pending.length > RUNTIME_TAPE_CAP) pending.shift();
        this.pendingTapeByKey.set(quoteKey, pending);
      }
      const heartbeat = this.tickCount % MATCHING_HEARTBEAT_BEATS === 0;
      const notices = await this.applyMatches(quotes);
      await this.flushConsumedRows();
      const remaining = [...this.orders.values()].map(o => o.ticket);
      const workingDecisions = explainWorkingOrders(
        [...this.liveTickets.values(), ...remaining],
        quotes,
      );
      const events: ExecutionLogEvent[] = [];
      for (const n of notices) {
        if (n.outcome !== 'filled' && n.outcome !== 'blocked-policy') continue;
        const scheduled: HedgeTicket = { ...n.ticket, status: 'scheduled' };
        const q = quotes.get(tapeQuoteKey(n.ticket));
        const usdPerLocal = q
          ? usdPerLocalFromQuote(n.ticket.ccy, q.mid)
          : 0;
        let committed = 0;
        if (n.outcome === 'blocked-policy') {
          for (const live of this.liveTickets.values()) {
            if (live.ccy !== n.ticket.ccy || live.id === n.orderId) continue;
            committed += ticketNotionalUsdM(live, usdPerLocal);
          }
        }
        const d = explainRestingOrder(
          scheduled,
          q,
          committed,
          n.atMs,
          true,
        );
        events.push(toOrderEvent({ ...d, outcome: n.outcome, atMs: n.atMs }));
      }
      events.push(
        ...eventsForBeat(
          workingDecisions,
          elapsedMs,
          quotes.size,
          heartbeat,
          Date.now(),
          this.lastMonitorKey,
        ).filter(e => e.kind === 'order' && e.outcome === 'working'),
      );
      if (heartbeat) {
        events.push(beatEvent(workingDecisions, elapsedMs, quotes.size));
        for (const d of workingDecisions) {
          if (d.outcome === 'working') events.push(toOrderEvent(d));
        }
      }
      this.lastMonitorKey = monitorSnapshotKey(workingDecisions);
      const filledThis = notices.filter(n => n.outcome === 'filled').length;
      const blockedThis = notices.filter(n => n.outcome === 'blocked-policy').length;
      this.lastBeat = {
        atMs: Date.now(),
        elapsedMs,
        ccyCount: quotes.size,
        working: this.orders.size,
        triggered: filledThis + blockedThis,
        filled: filledThis,
        blocked: blockedThis,
        summary: nodeBeatStatusLine({
          elapsedMs,
          ccyCount: quotes.size,
          working: this.orders.size,
          filled: filledThis,
          blocked: blockedThis,
        }),
      };
      // Flush on any notable event, and otherwise on the same heartbeat
      // cadence as everything else — a resting order can sit quiet for many
      // beats, and the tape must still land in S3 during that time, not only
      // when something happens to it.
      if (events.length > 0 || heartbeat) await this.persistEvents(events);
      await this.persistTick(heartbeat);
    } finally {
      this.stepping = false;
    }
  }

  private arm() {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      void this.step().finally(() => this.arm());
    }, MATCHING_INTERVAL_MS);
  }

  private async applyMatches(
    quotes: ReadonlyMap<string, SimSpotQuote>,
  ): Promise<MatchingFillNotice[]> {
    const committedUsdM = new Map<string, number>();
    for (const t of this.liveTickets.values()) {
      const q = quotes.get(tapeQuoteKey(t));
      if (!q) continue;
      committedUsdM.set(
        t.ccy,
        (committedUsdM.get(t.ccy) ?? 0)
          + ticketNotionalUsdM(t, usdPerLocalFromQuote(t.ccy, q.mid)),
      );
    }

    const notices: MatchingFillNotice[] = [];

    for (const [id, owner] of [...this.orders]) {
      if (!this.orders.has(id) || this.isConsumed(owner.ticket)) continue;
      if (this.filledHold.has(id)) {
        this.orders.delete(id);
        continue;
      }
      const t = owner.ticket;
      const quote = quotes.get(tapeQuoteKey(t));
      const restKey = hedgeRestingKey(t);
      if (!quote || !restingOrderTriggersAt(t, quote)) continue;
      const usdPerLocal = usdPerLocalFromQuote(t.ccy, quote.mid);
      if (
        !autoFillAllowedByPolicy(
          t,
          usdPerLocal,
          committedUsdM.get(t.ccy) ?? 0,
        )
      ) {
        const already =
          this.policyBlockedKeys.has(restKey)
          || t.ipaQuote?.errorMessage === OVER_AUTOMATED_LIMIT_NOTE;
        this.policyBlockedKeys.add(restKey);
        const blocked: HedgeTicket = {
          ...t,
          ipaQuote: {
            ...(t.ipaQuote ?? EMPTY_IPA),
            errorMessage: OVER_AUTOMATED_LIMIT_NOTE,
          },
        };
        this.orders.set(id, { ...owner, ticket: blocked });
        if (already) continue;
        notices.push({
          orderId: id,
          userEmail: owner.userEmail,
          taskId: owner.taskId,
          ticket: blocked,
          cancelledOrderIds: [],
          outcome: 'blocked-policy',
          atMs: Date.now(),
        });
        continue;
      }
      committedUsdM.set(
        t.ccy,
        (committedUsdM.get(t.ccy) ?? 0) + ticketNotionalUsdM(t, usdPerLocal),
      );
      const hit = restingOrderHitSide(t);
      const fillPx = hit === 'bid' ? quote.bid : quote.ask;
      const filled: HedgeTicket = {
        ...t,
        status: 'booked',
        filledAtMs: Date.now(),
        // Record the dealer at fill time (executed-side bank of the same
        // rotation the tiles display) so blotter and footer name one bank
        // instead of the UI re-deriving it per render.
        counterparty: fillCounterpartyFor({
          ccy: t.ccy,
          stripEdgeIndex: t.stripEdgeIndex,
          counterparty: t.counterparty,
          executedHit: hit,
        }),
        // `orderHit` is the UI tile the level was typed into, NOT the market
        // side this executed on — see its doc on HedgeTicket and the note on
        // restingOrderHitSide. Overwriting it with `hit` moved a filled leg
        // onto its sibling's pad (both brackets of one side execute against
        // the same side of the quote), which showed a filled BUY take-profit
        // on the stop-loss card and left both cards titled "TAKE PROFIT".
        // Anything needing the execution side derives it with
        // restingOrderHitSide, so nothing needs it stored here.
        // `quote` is the leg's own tape — for a forward that mid is the
        // OUTRIGHT, not a spot print, so it must not overwrite the stamped
        // spot reference on the executed ticket. A spot-referenced forward
        // executed on SPOT and books that print plus its leg's points.
        ipaQuote: quoteAfterFill(
          t.ipaQuote,
          spotReferencedFillQuote(t, fillPx) ?? {
            fxOutright: fillPx,
            fxSpot:
              (t.instrument ?? 'spot') === 'spot'
                ? quote.mid
                : t.ipaQuote?.fxSpot ?? null,
          },
        ),
      };
      this.orders.delete(id);
      this.consumeTicket(t);
      this.setLiveTicket(filled, owner.userEmail, owner.taskId);
      this.filledHold.set(id, {
        ticket: filled,
        userEmail: owner.userEmail,
        taskId: owner.taskId,
      });
      // The SERVER registers the post-fill recording hold at the fill
      // itself — the desk is guaranteed the story tail (fill + tail) of
      // tape in Postgres no matter what the browser does next: a closed
      // tab, a cleared book, or a payload that omits this ticket must not
      // stop the recording. Brackets included — a TP/SL fill's tail is the
      // record that justifies it.
      this.bookedTapeHold.set(id, {
        ticket: filled,
        userEmail: owner.userEmail,
        taskId: owner.taskId,
      });
      const cancelledOrderIds: string[] = [];
      if (t.ocoGroupId) {
        for (const [oid, other] of [...this.orders]) {
          if (
            other.ticket.ocoGroupId === t.ocoGroupId
            && other.ticket.status === 'scheduled'
          ) {
            this.orders.delete(oid);
            this.consumeTicket(other.ticket);
            cancelledOrderIds.push(oid);
          }
        }
      }
      notices.push({
        orderId: id,
        userEmail: owner.userEmail,
        taskId: owner.taskId,
        ticket: filled,
        cancelledOrderIds,
        outcome: 'filled',
        atMs: Date.now(),
      });
      void this.engine.recordExecution({
        orderId: id,
        executedAt: filled.filledAtMs ?? Date.now(),
        price: fillPx,
        fill: hit,
      });
      await this.persistExecution(
        owner.userEmail,
        id,
        filled.filledAtMs ?? Date.now(),
        fillPx,
        hit,
        filled,
      );
    }

    for (const notice of notices) {
      this.fills.unshift(notice);
      await this.persistFillToSandbox(notice);
    }
    if (this.fills.length > 200) this.fills.length = 200;
    return notices;
  }

  private async persistFillToSandbox(notice: MatchingFillNotice) {
    try {
      await withPersistTimeout(async () => {
        const persist = await matchingPersist();
        await persist.persistFillToSandbox(notice);
      });
    } catch (err) {
      console.warn(`${EXEC_LOG_TAG} sandbox fill persist failed`, err);
    }
  }

  private async persistEvents(events: readonly ExecutionLogEvent[]) {
    const owned = events.map(e => this.ownedEvent(e));
    this.monitorRing.unshift(...owned);
    if (this.monitorRing.length > 250) this.monitorRing.length = 250;
    appendExecutionLogs(owned);
    for (const e of events) {
      console.info(`${EXEC_LOG_TAG} ${e.summary}`);
    }
    if (owned.length > 0) {
      try {
        await withPersistTimeout(async () => {
          const persist = await matchingPersist();
          await persist.persistExecutionLogRows(owned);
        });
      } catch {
        /* monitor must never block the tape */
      }
    }

    type OwnerGroup = {
      userEmail: string;
      taskId: string;
      events: ExecutionLogEvent[];
      keys: Set<string>;
    };
    const byOwner = new Map<string, OwnerGroup>();
    const ownerGroup = (userEmail: string, taskId: string): OwnerGroup => {
      const groupKey = `${userEmail}:${taskId}`;
      const existing = byOwner.get(groupKey);
      if (existing) return existing;
      const created: OwnerGroup = { userEmail, taskId, events: [], keys: new Set() };
      byOwner.set(groupKey, created);
      return created;
    };
    for (const event of events) {
      if (event.kind !== 'order') continue;
      const owner = this.orders.get(event.orderId) ?? this.filledHold.get(event.orderId);
      if (!owner) continue;
      const group = ownerGroup(owner.userEmail, owner.taskId);
      group.events.push(event);
      // A strip leg's own ticket never lands in liveOwners/liveTickets below
      // (setLiveTicket deliberately skips stripId tickets — see its own
      // comment), so a leg that just filled this beat must get its tape key
      // from the fill event's own owner record, not from that tracking set.
      group.keys.add(storyTapeKey(owner.ticket));
    }
    // Every currently-tracked order/live ticket contributes its own leg's
    // tape key to its owner's group even on a beat with no events for it —
    // this is what keeps a quiet resting order's tape flowing to S3 instead
    // of only landing there when something happens to it.
    for (const owner of this.orders.values()) {
      ownerGroup(owner.userEmail, owner.taskId).keys.add(storyTapeKey(owner.ticket));
    }
    for (const [id, owner] of this.liveOwners) {
      const ticket = this.liveTickets.get(id);
      if (!ticket) continue;
      ownerGroup(owner.userEmail, owner.taskId).keys.add(storyTapeKey(ticket));
    }
    for (const owner of this.openTapeHolds()) {
      ownerGroup(owner.userEmail, owner.taskId).keys.add(storyTapeKey(owner.ticket));
    }
    // Open tickets persist their currency's record too — otherwise the
    // pre-execution stretch is walked and served but never stored, and a
    // reload (which reads Postgres) loses exactly the part the desk was
    // watching when it clicked.
    for (const watch of this.openWatchedCcys()) {
      ownerGroup(watch.userEmail, watch.taskId).keys.add(`${watch.ccy}|spot`);
    }

    // Snapshot the pending buffers ONCE: the canonical spot key is shared
    // across owners, and draining it inside the per-group loop would hand
    // all points to whichever group ran first and persist nothing for
    // everyone after it (review H3). Each owning group writes the same
    // points; a key clears only when no group holding it failed. A partial
    // failure re-persists for the groups that already succeeded — duplicate
    // append-only rows are the accepted cost of never losing a user's tape.
    const pendingSnapshot = new Map(this.pendingTapeByKey);
    const failedTapeKeys = new Set<string>();
    const touchedTapeKeys = new Set<string>();

    // One store per beat, chosen by EXECUTION_STORE (prod defaults to s3).
    // The tape used to go to BOTH the S3 journal and leg_tape_ticks, so a
    // box with Postgres and no AWS credentials failed a put every second.
    const store = (await matchingPersist()).executionStore();

    for (const group of byOwner.values()) {
      const tapeByCcy: Record<string, (SimSpotQuote & { t: number })[]> = {};
      for (const quoteKey of group.keys) {
        const hist = this.tapeHistoryByKey.get(quoteKey);
        if (hist && hist.length > 0) tapeByCcy[quoteKey] = hist;
      }
      // Drain-tracking is store-independent: whichever store runs, the
      // pending buffer clears only for keys whose write succeeded, so a
      // failure retries next beat instead of dropping the points.
      const points: (SimSpotQuote & { t: number } & { quoteKey: string })[] = [];
      for (const quoteKey of group.keys) {
        const pending = pendingSnapshot.get(quoteKey);
        if (!pending || pending.length === 0) continue;
        touchedTapeKeys.add(quoteKey);
        for (const p of pending) points.push({ ...p, quoteKey });
      }
      if (store === 's3') {
        try {
          await withPersistTimeout(async () => {
            const persist = await matchingPersist();
            await persist.persistExecutionJournalEvents({
              userEmail: group.userEmail,
              taskId: group.taskId,
              events: group.events,
              tapeByCcy,
            });
          });
          this.s3JournalPersistFailedOnce = false;
        } catch (err) {
          // S3 journal must not stop the matcher — but a silent catch here is
          // exactly why "no tape recorded" is indistinguishable from "storage
          // is unreachable" until someone reads server logs. The first failure
          // still gets the full error (e.g. missing AWS credentials in local
          // dev); every beat after that logs one line, not the full stack —
          // the repeated stack traces were flooding the terminal and breaking
          // the testing workflow without adding new information.
          if (!this.s3JournalPersistFailedOnce) {
            this.s3JournalPersistFailedOnce = true;
            this.s3JournalLastWarnAtMs = Date.now();
            console.warn(`${EXEC_LOG_TAG} S3 journal persist failed`, err);
          } else if (Date.now() - this.s3JournalLastWarnAtMs > 300_000) {
            // Once per 5 minutes, not once per beat: a dev box without AWS
            // credentials fails this every second forever, and the repeat
            // line drowned the whole terminal.
            this.s3JournalLastWarnAtMs = Date.now();
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`${EXEC_LOG_TAG} S3 journal persist still failing: ${message}`);
          }
          // The journal carries this beat's tape, so a failed put must keep
          // the pending points for the next one.
          for (const quoteKey of group.keys) failedTapeKeys.add(quoteKey);
        }
      }

      // Append-only, so flush before clearing: a failed insert leaves the
      // pending points in place for the next beat to retry.
      if (store === 'postgres' && points.length > 0) {
        try {
          await withPersistTimeout(async () => {
            const persist = await matchingPersist();
            await persist.persistLegTapeTicks({
              userEmail: group.userEmail,
              taskId: group.taskId,
              points,
            });
          });
          console.info(
            `${EXEC_LOG_TAG} leg tape DB persist ok: ${points.length} points, keys=${[...group.keys].join(',')}, owner=${group.userEmail}`,
          );
        } catch (err) {
          for (const quoteKey of group.keys) failedTapeKeys.add(quoteKey);
          console.warn(`${EXEC_LOG_TAG} leg tape DB persist failed, will retry next beat`, err);
        }
      }
      // A beat with 0 pending points is the steady state, not an event —
      // logging it every second buried the lines that matter.
    }

    // persistEvents' only caller is step(), which is re-entrancy-guarded by
    // `stepping`, so nothing can append to a pending buffer between the
    // snapshot above and this clear.
    for (const quoteKey of touchedTapeKeys) {
      if (failedTapeKeys.has(quoteKey)) continue;
      this.pendingTapeByKey.delete(quoteKey);
    }
  }

  private async persistExecution(
    userEmail: string,
    orderId: string,
    executedAt: number,
    price: number,
    fill: 'bid' | 'ask',
    ticket?: HedgeTicket,
  ) {
    try {
      await withPersistTimeout(async () => {
        const persist = await matchingPersist();
        await persist.persistOrderExecution(
          userEmail,
          orderId,
          executedAt,
          price,
          fill,
          ticket,
        );
      });
    } catch {
      /* best effort */
    }
  }

  private async persistTick(writeState: boolean) {
    if (!writeState) return;
    const state = this.engine.getState();
    try {
      await withPersistTimeout(async () => {
        const persist = await matchingPersist();
        await persist.persistMatcherProcessState({
          isRunning: this.started,
          lastTickAt: state.lastTickAt,
        });
      });
    } catch {
      /* best effort — do not write every tape print */
    }
  }

  private async persistProcessFlag(isRunning: boolean) {
    try {
      await withPersistTimeout(async () => {
        const persist = await matchingPersist();
        await persist.persistMatcherProcessState({
          isRunning,
          lastTickAt: this.engine.getState().lastTickAt,
        });
      });
    } catch {
      /* best effort */
    }
  }

  private async hydrateFromSandboxes() {
    // Durable consumed ids/keys come back FIRST so the hydrate below (and
    // the first browser re-sync) cannot resurrect an already-filled rest.
    try {
      const consumed = await withPersistTimeout(async () => {
        const persist = await matchingPersist();
        return persist.loadConsumedOrders();
      });
      for (const row of consumed) {
        this.consumedOrderIds.add(row.orderId);
        // Shape keys rehydrate WITH their timestamps — the window check in
        // isConsumed lets stale ones lapse, so an old fill's shape cannot
        // swallow the desk's re-placed orders after a restart.
        if (row.restKey) {
          const prev = this.consumedOrderKeys.get(row.restKey);
          if (prev == null || prev < row.consumedAtMs) {
            this.consumedOrderKeys.set(row.restKey, row.consumedAtMs);
          }
        }
      }
    } catch (err) {
      console.warn(`${EXEC_LOG_TAG} consumed-order hydrate failed`, err);
    }
    try {
      const rows = await withPersistTimeout(async () => {
        const persist = await matchingPersist();
        return persist.loadHydratedRestingOrders();
      });
      for (const row of rows) {
        const t = row.ticket;
        const email = row.userEmail.trim().toLowerCase();
        const task = row.taskId || '02';
        if (isLiveHedgeTicket(t) && !t.stripId) {
          this.setLiveTicket(t, email, task);
          this.consumeLiveRest(t);
          continue;
        }
        if (!isWorkingRest(t) || this.isConsumed(t)) continue;
        this.upsertOrders([{ ticket: t, userEmail: email, taskId: task }]);
      }
    } catch (err) {
      console.warn(`${EXEC_LOG_TAG} hydrate scheduled orders failed`, err);
    }
    // Tape history lived only in this process's memory, so every runtime
    // recreation (REV bump, dev-server restart) blanked the served chart
    // while Postgres held the full series — reload each hydrated order's
    // own recorded tape so a reopened ticket seeds its real history again.
    // Read-only serving state: nothing here re-enters pendingTapeByKey, so
    // reloaded points are never re-persisted.
    try {
      const wanted = new Map<string, { userEmail: string; taskId: string }>();
      for (const owner of this.orders.values()) {
        const key = tapeQuoteKey(owner.ticket);
        if (!this.tapeHistoryByKey.has(key) && !wanted.has(key)) {
          wanted.set(key, { userEmail: owner.userEmail, taskId: owner.taskId });
        }
      }
      for (const [key, who] of wanted) {
        const points = await withPersistTimeout(async () => {
          const persist = await matchingPersist();
          return persist.loadLegTapeTicks(
            who.userEmail,
            who.taskId,
            key,
            RUNTIME_TAPE_CAP,
          );
        });
        if (points.length === 0) continue;
        this.tapeHistoryByKey.set(
          key,
          points.map(p => ({ bid: p.bid, ask: p.ask, mid: p.mid, t: p.t })),
        );
      }
      if (wanted.size > 0) {
        console.info(
          `${EXEC_LOG_TAG} tape history rehydrated from DB for keys=${[...wanted.keys()].join(',')}`,
        );
      }
    } catch (err) {
      console.warn(`${EXEC_LOG_TAG} tape history rehydrate failed`, err);
    }
  }
}

export function getMatchingRuntime(): MatchingProcessRuntime {
  const g = globalThis as GlobalFx;
  if (
    !g.__fxMatchingRuntime
    || g.__fxMatchingRuntimeRev !== MATCHING_RUNTIME_REV
  ) {
    g.__fxMatchingRuntime?.stop();
    g.__fxMatchingRuntime = new MatchingProcessRuntime();
    g.__fxMatchingRuntimeRev = MATCHING_RUNTIME_REV;
  }
  return g.__fxMatchingRuntime;
}

export async function ensureMatchingProcess(): Promise<MatchingProcessRuntime> {
  let runtime = getMatchingRuntime();
  if (runtime.isRunning && runtime.heartbeat().verdict === 'stale') {
    runtime.stop();
    const g = globalThis as GlobalFx;
    runtime = new MatchingProcessRuntime();
    g.__fxMatchingRuntime = runtime;
    g.__fxMatchingRuntimeRev = MATCHING_RUNTIME_REV;
  }
  if (!runtime.isRunning) await runtime.start();
  return runtime;
}
