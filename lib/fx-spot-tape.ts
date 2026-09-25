/**
 * Process-wide FX spot tape: last live overlay print + Brownian walk between
 * prints. /api/fx-spot and the Node matcher share this map so the Click &
 * Trade pad, candles, and SL/TP all see the same bid/ask series.
 *
 * Every commit of that walk is also folded into OHLC day-record bars per pair
 * at 1s, 5s, 15s, 30s and 1m (`spotDayCandlesFor`) — the chart the trade
 * ticket shows before an order exists. Closed bars are upserted to Postgres
 * when one is configured; the process keeps the last 48h of each length in
 * memory either way.
 *
 * Server-only — do not import from client components (pulls undici).
 */

import {
  fetchLiveFxQuote,
  quoteFromLiveSpot,
  type LiveFxQuote,
} from '@/lib/fxLiveClient';
import { usdMarketPair } from '@/lib/fx-market-rates';
import {
  parseFxSpotRequest,
  type FxSpotQuote,
} from '@/lib/refinitivFxSpot';
import type { SimSpotQuote } from '@/lib/test-mode/sim-ticket-price';
import {
  advanceStaleLiveSpot,
  type StaleLiveWalkState,
} from '@/lib/test-mode/stale-live-walk';
import {
  SPOT_DAY_MAX_WINDOW_MS,
  SPOT_DAY_RECORD_BAR_SEC,
  SPOT_DAY_STORE_BAR_SECS,
  foldSpotDayTick,
  isSpotDayStoreBarSec,
  spotDayBucketStartMs,
  type SpotDayCandle,
  type SpotDayStoreBarSec,
} from '@/lib/test-mode/tape-candles';

export const LIVE_FX_QUOTE_TTL_MS = 20_000;

/**
 * With no ticket, chart or resting order on a pair, the matcher beat still
 * re-anchors it — every 5 minutes instead of every 20 s, so an idle process
 * costs six pairs ~1.7k live requests a day rather than ~26k.
 */
export const LIVE_FX_IDLE_REFRESH_MS = 5 * 60_000;

/** How long a route poll, a chart read or a resting order keeps a pair on the 20 s cadence. */
export const LIVE_FX_INTEREST_TTL_MS = 2 * 60_000;

/**
 * How often a served window re-reads its tail from Postgres, so bars another
 * instance (or a restarted runtime) persisted after the first read still
 * reach the chart within a minute.
 */
export const SPOT_DAY_BACKFILL_REFRESH_MS = 60_000;

/** Persisted bars older than this are deleted — the table is a chart cache, not an audit trail. */
export const SPOT_DAY_RETENTION_MS = 7 * 24 * 3600 * 1000;
const SPOT_DAY_PRUNE_EVERY_MS = 3600 * 1000;

type LiveFetchCache = { live: LiveFxQuote; fetchedAt: number };

type SpotDayLane = {
  /** Closed bars of this `barSec` by bucket start (unix ms). */
  closed: Map<number, SpotDayCandle>;
  forming: SpotDayCandle | null;
  /** Earliest window start already merged from Postgres; null = never asked. */
  backfilledFromMs: number | null;
  /** Wall clock of the last Postgres read; 0 = never. */
  backfilledAtMs: number;
};

type SpotDayRecord = {
  /**
   * Walk clock of the last print folded. The matcher beat and the
   * /api/fx-spot poll both commit the same second's walk — only the commit
   * that actually advanced it is recorded.
   */
  lastWalkedAtMs: number;
  /** Wall clock of the last retention delete; 0 = never. */
  lastPrunedAtMs: number;
  lanes: Map<SpotDayStoreBarSec, SpotDayLane>;
};

type GlobalFxSpot = typeof globalThis & {
  __fxSpotWalk?: Map<string, StaleLiveWalkState>;
  __fxSpotLiveFetch?: Map<string, LiveFetchCache>;
  /** Versioned: the map outlives HMR, so a record shape change must not resurface old bars. */
  __fxSpotDayRecordV3?: Map<string, SpotDayRecord>;
  __fxSpotLiveRefresh?: Set<string>;
  __fxSpotLiveRefreshFailed?: Set<string>;
  __fxSpotInterest?: Map<string, number>;
  __fxSpotBackfillFailed?: Set<string>;
  __fxSpotPersistFailed?: Set<string>;
};

function tapes(): Map<string, StaleLiveWalkState> {
  const g = globalThis as GlobalFxSpot;
  if (!g.__fxSpotWalk) g.__fxSpotWalk = new Map();
  return g.__fxSpotWalk;
}

function liveFetches(): Map<string, LiveFetchCache> {
  const g = globalThis as GlobalFxSpot;
  if (!g.__fxSpotLiveFetch) g.__fxSpotLiveFetch = new Map();
  return g.__fxSpotLiveFetch;
}

function dayRecords(): Map<string, SpotDayRecord> {
  const g = globalThis as GlobalFxSpot;
  if (!g.__fxSpotDayRecordV3) g.__fxSpotDayRecordV3 = new Map();
  return g.__fxSpotDayRecordV3;
}

function liveRefreshes(): Set<string> {
  const g = globalThis as GlobalFxSpot;
  if (!g.__fxSpotLiveRefresh) g.__fxSpotLiveRefresh = new Set();
  return g.__fxSpotLiveRefresh;
}

/** Pairs whose last live refresh failed — warned once until one succeeds. */
function liveRefreshFailures(): Set<string> {
  const g = globalThis as GlobalFxSpot;
  if (!g.__fxSpotLiveRefreshFailed) g.__fxSpotLiveRefreshFailed = new Set();
  return g.__fxSpotLiveRefreshFailed;
}

/** Last time something that needs a fresh print (ticket, chart, order) touched a pair. */
function interests(): Map<string, number> {
  const g = globalThis as GlobalFxSpot;
  if (!g.__fxSpotInterest) g.__fxSpotInterest = new Map();
  return g.__fxSpotInterest;
}

/** Pairs whose last Postgres backfill failed — warned once until one succeeds. */
function backfillFailures(): Set<string> {
  const g = globalThis as GlobalFxSpot;
  if (!g.__fxSpotBackfillFailed) g.__fxSpotBackfillFailed = new Set();
  return g.__fxSpotBackfillFailed;
}

/** Pairs whose last bar persist failed — warned once until one succeeds. */
function persistFailures(): Set<string> {
  const g = globalThis as GlobalFxSpot;
  if (!g.__fxSpotPersistFailed) g.__fxSpotPersistFailed = new Set();
  return g.__fxSpotPersistFailed;
}

function pairKey(pairOrCcy: string): string {
  return pairOrCcy.replace(/[^A-Za-z]/g, '').toUpperCase();
}

/** "EUR" and "EURUSD" both name the EURUSD tape. */
function marketPairKey(pairOrCcy: string): string {
  const raw = pairKey(pairOrCcy);
  return raw.length === 3 ? pairKey(usdMarketPair(raw)) : raw;
}

/**
 * FCY codes of every pair with a seeded walk — the matcher beat ticks these
 * so a record keeps growing after the ticket that started it has closed.
 */
export function seededFxSpotCurrencies(): string[] {
  const out: string[] = [];
  for (const key of tapes().keys()) {
    if (key.length !== 6) continue;
    const fcy = key.startsWith('USD') ? key.slice(3) : key.slice(0, 3);
    if (fcy !== 'USD') out.push(fcy);
  }
  return out;
}

function resolveTapeKey(pairOrCcy: string): string | null {
  const raw = pairKey(pairOrCcy);
  const map = tapes();
  if (map.has(raw)) return raw;
  if (raw.length === 3) {
    const pair = usdMarketPair(raw);
    if (map.has(pair)) return pair;
  }
  return null;
}

export function resetFxSpotTapeForTests() {
  tapes().clear();
  liveFetches().clear();
  dayRecords().clear();
  liveRefreshes().clear();
  liveRefreshFailures().clear();
  interests().clear();
  backfillFailures().clear();
  persistFailures().clear();
}

/**
 * Note that something is watching this pair right now — an open ticket's
 * /api/fx-spot poll, a day-chart read, a resting order on the matcher — so
 * the beat's live refresh runs on the fast cadence for the next two minutes.
 */
export function markFxSpotInterest(pairOrCcy: string, nowMs = Date.now()) {
  interests().set(marketPairKey(pairOrCcy), nowMs);
}

function hasFxSpotInterest(key: string, nowMs: number): boolean {
  const at = interests().get(key);
  return at != null && nowMs - at <= LIVE_FX_INTEREST_TTL_MS;
}

/**
 * Every walk update lands here, so the day record sees exactly the served
 * series. A commit counts as a live print when the feed moved the anchor
 * (`snapped`) or re-confirmed it with a fresh timestamp — a re-fetched print
 * that did not move the mid is still the market, not a simulated step.
 */
function commitWalk(
  key: string,
  prev: StaleLiveWalkState | null,
  state: StaleLiveWalkState,
  nowMs: number,
  snapped: boolean,
) {
  tapes().set(key, state);
  const isLivePrint =
    snapped
    || (prev != null && state.liveAsOf != null && state.liveAsOf !== prev.liveAsOf);
  recordSpotDayPrint(key, state, nowMs, isLivePrint);
}

export function ingestLiveFxSpotQuote(args: {
  pair: string;
  live: SimSpotQuote;
  asOf: string | null;
  nowMs?: number;
  rand?: () => number;
}): { quote: SimSpotQuote; live: SimSpotQuote; snapped: boolean } {
  const key = pairKey(args.pair);
  const nowMs = args.nowMs ?? Date.now();
  const prev = tapes().get(key) ?? null;
  const { state, snapped } = advanceStaleLiveSpot(
    prev,
    args.live,
    args.asOf,
    nowMs,
    args.rand,
  );
  commitWalk(key, prev, state, nowMs, snapped);
  return { quote: state.walked, live: state.live, snapped };
}

/** Advance the existing tape without a new overlay fetch (matcher 1s beat). */
export function tickFxSpotTape(
  pairOrCcy: string,
  nowMs = Date.now(),
  rand?: () => number,
): { quote: SimSpotQuote; live: SimSpotQuote; snapped: boolean } | null {
  const key = resolveTapeKey(pairOrCcy);
  if (!key) return null;
  const prev = tapes().get(key);
  if (!prev) return null;
  const { state, snapped } = advanceStaleLiveSpot(
    prev,
    prev.live,
    prev.liveAsOf,
    nowMs,
    rand,
  );
  commitWalk(key, prev, state, nowMs, snapped);
  refreshStaleLiveFxSpot(key, nowMs);
  return { quote: state.walked, live: state.live, snapped };
}

export async function fetchLiveFxQuoteCached(
  pair: string,
): Promise<LiveFxQuote> {
  const key = pairKey(pair);
  const cache = liveFetches();
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < LIVE_FX_QUOTE_TTL_MS) return hit.live;
  const live = await fetchLiveFxQuote(pair);
  cache.set(key, { live, fetchedAt: now });
  return live;
}

export async function fetchAndWalkFxSpot(input: {
  ccy?: string;
  ric?: string;
  pair?: string;
}): Promise<FxSpotQuote> {
  const parsed = parseFxSpotRequest(input);
  const live = await fetchLiveFxQuoteCached(parsed.pair);
  const raw = quoteFromLiveSpot(live, parsed);
  const walked = ingestLiveFxSpotQuote({
    pair: raw.pair,
    live: { bid: raw.bid, ask: raw.ask, mid: raw.mid },
    asOf: raw.asOf,
  });
  return {
    ...raw,
    bid: walked.quote.bid,
    ask: walked.quote.ask,
    mid: walked.quote.mid,
    simulated: !walked.snapped,
  };
}

/**
 * The matcher ticks a pair every second for the process lifetime, but only
 * /api/fx-spot ever fetched a new live print — so with no ticket open the
 * walk mean-reverted around a print that could be hours old, and the day
 * record (and any resting order) sat on that stale anchor. Re-fetch on the
 * 20 s cadence an open ticket uses while something is interested in the
 * pair, and on the 5 min idle cadence otherwise. Only for pairs the route has
 * fetched before: a walk seeded directly (tests, replay) has no feed behind it.
 */
function refreshStaleLiveFxSpot(key: string, nowMs: number) {
  const cached = liveFetches().get(key);
  if (!cached) return;
  const ttl = hasFxSpotInterest(key, nowMs)
    ? LIVE_FX_QUOTE_TTL_MS
    : LIVE_FX_IDLE_REFRESH_MS;
  if (nowMs - cached.fetchedAt < ttl) return;
  const inFlight = liveRefreshes();
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void fetchAndWalkFxSpot({ pair: key })
    .then(() => {
      liveRefreshFailures().delete(key);
    })
    .catch((err: unknown) => {
      // Keep walking around the last good print and try again after one TTL
      // — unless the fetch itself succeeded and a newer print is already
      // cached, which must not be rolled back to the stale one.
      if (liveFetches().get(key) === cached) {
        liveFetches().set(key, { live: cached.live, fetchedAt: Date.now() });
      }
      const failed = liveRefreshFailures();
      if (failed.has(key)) return;
      failed.add(key);
      console.warn(
        `[fx-spot] live refresh failed for ${key}; walking the last print until it recovers`,
        err instanceof Error ? err.message : err,
      );
    })
    .finally(() => {
      inFlight.delete(key);
    });
}

function newSpotDayLane(): SpotDayLane {
  return {
    closed: new Map(),
    forming: null,
    backfilledFromMs: null,
    backfilledAtMs: 0,
  };
}

function newSpotDayRecord(): SpotDayRecord {
  return {
    lastWalkedAtMs: 0,
    lastPrunedAtMs: 0,
    lanes: new Map(),
  };
}

function laneFor(
  record: SpotDayRecord,
  barSec: SpotDayStoreBarSec,
): SpotDayLane {
  // The globalThis map outlives HMR: a record written by an older module
  // version of the same map key may predate `lanes`. Heal it — losing that
  // record's bars — rather than 500 every candles read until a restart.
  if (!(record.lanes instanceof Map)) record.lanes = new Map();
  let lane = record.lanes.get(barSec);
  if (!lane) {
    lane = newSpotDayLane();
    record.lanes.set(barSec, lane);
  }
  return lane;
}

function recordHasBars(record: SpotDayRecord): boolean {
  if (!(record.lanes instanceof Map)) return false;
  for (const lane of record.lanes.values()) {
    if (lane.closed.size > 0 || lane.forming != null) return true;
  }
  return false;
}

/**
 * Stamp the print with the wall clock, not the walk clock: after an idle
 * stretch the walk catches up at most 8 steps per beat, so `walkedAtMs` can
 * lag real time by minutes and would fold fresh prints into stale buckets.
 */
function recordSpotDayPrint(
  key: string,
  state: StaleLiveWalkState,
  nowMs: number,
  isLivePrint: boolean,
) {
  const records = dayRecords();
  let record = records.get(key);
  if (!record) {
    record = newSpotDayRecord();
    records.set(key, record);
  }
  if (state.walkedAtMs === record.lastWalkedAtMs) return;
  record.lastWalkedAtMs = state.walkedAtMs;
  const tick = {
    bid: state.walked.bid,
    ask: state.walked.ask,
    mid: state.walked.mid,
    t: nowMs,
  };
  let closedAny = false;
  for (const barSec of SPOT_DAY_STORE_BAR_SECS) {
    const lane = laneFor(record, barSec);
    const { forming, closed } = foldSpotDayTick(
      lane.forming,
      tick,
      barSec,
      isLivePrint,
    );
    lane.forming = forming;
    if (!closed) continue;
    closedAny = true;
    lane.closed.set(closed.t, closed);
    pruneSpotDayLane(lane, nowMs - SPOT_DAY_MAX_WINDOW_MS);
    void persistSpotDayCandle(key, closed, barSec);
  }
  if (closedAny && nowMs - record.lastPrunedAtMs >= SPOT_DAY_PRUNE_EVERY_MS) {
    record.lastPrunedAtMs = nowMs;
    void pruneSpotDayRows(key, nowMs - SPOT_DAY_RETENTION_MS);
  }
}

function pruneSpotDayLane(lane: SpotDayLane, cutoffMs: number) {
  for (const t of lane.closed.keys()) {
    if (t < cutoffMs) lane.closed.delete(t);
  }
  if (lane.backfilledFromMs != null && lane.backfilledFromMs < cutoffMs) {
    lane.backfilledFromMs = cutoffMs;
  }
}

/**
 * Node-only DB I/O, resolved lazily — the matcher imports this module and
 * must not drag Sequelize into contexts that never touch the database. The
 * import promises are shared: a bar close fires a persist and a retention
 * prune together, and a chart read can land in the same beat, so the module
 * is resolved once rather than by each caller in parallel.
 */
let spotDayCandleModule: Promise<typeof import('@/lib/db/models/spot-day-candle')> | null =
  null;
let sequelizeModule: Promise<typeof import('sequelize')> | null = null;

async function spotDayCandleRowModel() {
  if (!spotDayCandleModule) {
    spotDayCandleModule = import('@/lib/db/models/spot-day-candle').catch(
      (err: unknown) => {
        spotDayCandleModule = null;
        throw err;
      },
    );
  }
  const { getSpotDayCandleRowModel } = await spotDayCandleModule;
  return getSpotDayCandleRowModel();
}

async function sequelizeOperators() {
  if (!sequelizeModule) {
    sequelizeModule = import('sequelize').catch((err: unknown) => {
      sequelizeModule = null;
      throw err;
    });
  }
  const { Op } = await sequelizeModule;
  return Op;
}

async function persistSpotDayCandle(
  pair: string,
  bar: SpotDayCandle,
  barSec: SpotDayStoreBarSec,
): Promise<void> {
  try {
    const SpotDayCandleRow = await spotDayCandleRowModel();
    if (!SpotDayCandleRow) return;
    await SpotDayCandleRow.upsert(
      {
        pair,
        barSec,
        bucketStartMs: bar.t,
        openMid: bar.open,
        highMid: bar.high,
        lowMid: bar.low,
        closeMid: bar.close,
        tickCount: bar.ticks,
        livePrintCount: bar.prints,
        updatedAt: new Date(),
      },
      { conflictFields: ['pair', 'barSec', 'bucketStartMs'] },
    );
    persistFailures().delete(pair);
  } catch (err) {
    const failed = persistFailures();
    if (failed.has(pair)) return;
    failed.add(pair);
    console.warn(
      `[fx-spot] day record persist failed for ${pair}; retrying each bar until it recovers`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Retention: drop this pair's bars older than the cutoff. Runs once an hour per pair. */
async function pruneSpotDayRows(pair: string, cutoffMs: number): Promise<void> {
  try {
    const SpotDayCandleRow = await spotDayCandleRowModel();
    if (!SpotDayCandleRow) return;
    const Op = await sequelizeOperators();
    await SpotDayCandleRow.destroy({
      where: {
        pair,
        bucketStartMs: { [Op.lt]: cutoffMs },
      },
    });
  } catch (err) {
    console.warn(
      `[fx-spot] day record retention prune failed for ${pair}`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Merge persisted bars into this lane: the whole window the first time a
 * window start is asked for, then only the recent tail once per
 * `SPOT_DAY_BACKFILL_REFRESH_MS`. A bucket this process already holds is its
 * own write (or will overwrite the row when it closes) and is never replaced
 * by the row read back. Returns whether a database is configured at all.
 */
async function backfillSpotDayLane(
  key: string,
  lane: SpotDayLane,
  barSec: SpotDayStoreBarSec,
  fromBucket: number,
  toMs: number,
  nowMs: number,
): Promise<boolean> {
  const SpotDayCandleRow = await spotDayCandleRowModel();
  if (!SpotDayCandleRow) return false;
  const coversWindow =
    lane.backfilledFromMs != null && fromBucket >= lane.backfilledFromMs;
  const isFresh = nowMs - lane.backfilledAtMs < SPOT_DAY_BACKFILL_REFRESH_MS;
  if (coversWindow && isFresh) return true;
  const readFromMs = coversWindow
    ? Math.max(
        fromBucket,
        spotDayBucketStartMs(lane.backfilledAtMs, barSec)
          - 2 * SPOT_DAY_BACKFILL_REFRESH_MS,
      )
    : fromBucket;
  const Op = await sequelizeOperators();
  const barMs = barSec * 1000;
  const rows = await SpotDayCandleRow.findAll({
    where: {
      pair: key,
      barSec,
      bucketStartMs: { [Op.gte]: readFromMs, [Op.lte]: toMs },
    },
    order: [['bucketStartMs', 'ASC']],
    limit: Math.ceil(SPOT_DAY_MAX_WINDOW_MS / barMs) + 1,
    raw: true,
  });
  for (const row of rows) {
    const t = Number(row.bucketStartMs);
    if (lane.closed.has(t) || lane.forming?.t === t) continue;
    // DECIMAL columns round-trip as strings; the chart consumes JS numbers
    // and no arithmetic runs on them here (same read shape as loadLegTapeTicks).
    lane.closed.set(t, {
      t,
      open: Number(row.openMid),
      high: Number(row.highMid),
      low: Number(row.lowMid),
      close: Number(row.closeMid),
      ticks: Number(row.tickCount),
      prints: Number(row.livePrintCount),
    });
  }
  lane.backfilledFromMs =
    lane.backfilledFromMs == null
      ? fromBucket
      : Math.min(lane.backfilledFromMs, fromBucket);
  lane.backfilledAtMs = nowMs;
  return true;
}

/**
 * The day record for one market pair over `[fromMs, toMs]` at `barSec`
 * (1s / 5s / 15s / 30s / 1m; default 1m): closed bars ascending, plus the
 * bar still forming. Served from memory; Postgres is read once per window
 * start, then its tail again once a minute.
 */
export async function spotDayCandlesFor(
  pair: string,
  fromMs: number,
  toMs: number,
  barSec: SpotDayStoreBarSec = SPOT_DAY_RECORD_BAR_SEC,
): Promise<{
  candles: SpotDayCandle[];
  forming: SpotDayCandle | null;
  persisted: boolean;
  warning: string | null;
}> {
  const resolvedBarSec = isSpotDayStoreBarSec(barSec)
    ? barSec
    : SPOT_DAY_RECORD_BAR_SEC;
  const key = pairKey(pair);
  const nowMs = Date.now();
  const enterMs = nowMs;
  let seedMs = 0;
  let backfillMs = 0;
  // A chart reading the record is a consumer that wants fresh prints.
  markFxSpotInterest(key, nowMs);
  let warning: string | null = null;
  // No walk yet for this pair: recording starts the moment the chart opens,
  // not when something else happens to poll the live route. The first live
  // print seeds the walk and lands in the record before this read answers.
  if (!tapes().has(key)) {
    const seedStartMs = Date.now();
    try {
      await fetchAndWalkFxSpot({ pair: key });
      liveRefreshFailures().delete(key);
    } catch (err) {
      warning = 'Live feed unavailable — the record starts with the first print that arrives';
      const failed = liveRefreshFailures();
      if (!failed.has(key)) {
        failed.add(key);
        console.warn(
          `[fx-spot] could not seed the day record for ${key}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    seedMs = Date.now() - seedStartMs;
  }
  const records = dayRecords();
  const record = records.get(key) ?? newSpotDayRecord();
  const lane = laneFor(record, resolvedBarSec);
  const fromBucket = spotDayBucketStartMs(fromMs, resolvedBarSec);
  let persisted = false;
  const backfillStartMs = Date.now();
  try {
    persisted = await backfillSpotDayLane(
      key,
      lane,
      resolvedBarSec,
      fromBucket,
      toMs,
      nowMs,
    );
    backfillFailures().delete(key);
  } catch (err) {
    warning = [warning, 'Postgres backfill failed — showing only what this process recorded']
      .filter(Boolean)
      .join(' · ');
    const failed = backfillFailures();
    if (!failed.has(key)) {
      failed.add(key);
      console.warn(
        `[fx-spot] day record backfill failed for ${key}`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  // A read must not pin an entry for every code a caller tries; keep the
  // record once it holds a bar, or once Postgres was consulted so the read
  // throttle above has a clock to run on.
  if (recordHasBars(record) || persisted) {
    records.set(key, record);
  }
  backfillMs = Date.now() - backfillStartMs;
  const assembleStartMs = Date.now();
  const candles = [...lane.closed.values()]
    .filter(bar => bar.t >= fromBucket && bar.t <= toMs)
    .sort((a, b) => a.t - b.t);
  const forming =
    lane.forming && lane.forming.t >= fromBucket && lane.forming.t <= toMs
      ? lane.forming
      : null;
  const assembleMs = Date.now() - assembleStartMs;
  console.log(
    `[candles-load] pair=${key} bar=${resolvedBarSec}s lane=${lane.closed.size} `
    + `out=${candles.length} seed=${seedMs}ms backfill=${backfillMs}ms `
    + `assemble=${assembleMs}ms total=${Date.now() - enterMs}ms `
    + `persisted=${persisted}${warning ? ' warning=yes' : ''}`,
  );
  return { candles, forming, persisted, warning };
}
