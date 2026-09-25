import { afterEach, describe, expect, it, vi } from 'vitest';
import { Op } from 'sequelize';
import { DEFAULT_EURUSD_MARKET_RATES } from '@/lib/fx-market-rates';
import type { LiveFxQuote } from '@/lib/fxLiveClient';

const liveFetch = vi.fn<(pair: string) => Promise<LiveFxQuote>>();
vi.mock('@/lib/fxLiveClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/fxLiveClient')>();
  return {
    ...actual,
    fetchLiveFxQuote: (pair: string) => liveFetch(pair),
  };
});

type FakeSpotDayCandleRow = {
  bucketStartMs: number;
  openMid: string;
  highMid: string;
  lowMid: string;
  closeMid: string;
  tickCount: number;
  livePrintCount: number;
};
type FakeBucketQuery = {
  where: { pair: string; barSec?: number; bucketStartMs: Record<symbol, number> };
};
type FakeSpotDayCandleRowModel = {
  findAll: (query: FakeBucketQuery) => Promise<FakeSpotDayCandleRow[]>;
  upsert: (values: unknown, options: unknown) => Promise<void>;
  destroy: (query: FakeBucketQuery) => Promise<number>;
};
// Null = no Postgres configured (the day record stays in process memory);
// a fake model stands in for the table where a test needs the backfill path.
const spotDayDb = { model: null as FakeSpotDayCandleRowModel | null };
vi.mock('@/lib/db/models/spot-day-candle', () => ({
  getSpotDayCandleRowModel: async () => spotDayDb.model,
}));

const {
  LIVE_FX_IDLE_REFRESH_MS,
  SPOT_DAY_BACKFILL_REFRESH_MS,
  SPOT_DAY_RETENTION_MS,
  fetchAndWalkFxSpot,
  fetchLiveFxQuoteCached,
  ingestLiveFxSpotQuote,
  markFxSpotInterest,
  resetFxSpotTapeForTests,
  seededFxSpotCurrencies,
  spotDayCandlesFor,
  tickFxSpotTape,
} = await import('@/lib/fx-spot-tape');

const LIVE = { bid: 1.1622, mid: 1.1623, ask: 1.1624 };

describe('fx-spot tape cache', () => {
  afterEach(() => {
    resetFxSpotTapeForTests();
    vi.restoreAllMocks();
  });

  it('walks on a stale overlay print and snaps on a new mid', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const first = ingestLiveFxSpotQuote({
      pair: 'EURUSD',
      live: LIVE,
      asOf: '2026-09-07T12:00:00Z',
      nowMs: 1_000,
    });
    expect(first.snapped).toBe(true);
    expect(first.quote.mid).toBeCloseTo(1.1623, 6);

    const walked = ingestLiveFxSpotQuote({
      pair: 'EURUSD',
      live: LIVE,
      asOf: '2026-09-07T12:00:00Z',
      nowMs: 3_000,
    });
    expect(walked.snapped).toBe(false);
    expect(walked.quote.mid).not.toBe(LIVE.mid);

    const seedAsk = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '2M')
      ?.outright?.ask;
    expect(seedAsk).toBeCloseTo(1.15574, 4);
    expect(Math.abs(walked.quote.mid - (seedAsk ?? 0))).toBeGreaterThan(0.005);

    const snap = ingestLiveFxSpotQuote({
      pair: 'EURUSD',
      live: { bid: 1.1630, mid: 1.1631, ask: 1.1632 },
      asOf: '2026-09-07T12:01:00Z',
      nowMs: 4_000,
    });
    expect(snap.snapped).toBe(true);
    expect(snap.quote.mid).toBeCloseTo(1.1631, 6);
  });

  it('lets the matcher tick the same series by CCY', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    ingestLiveFxSpotQuote({
      pair: 'EURUSD',
      live: LIVE,
      asOf: 't0',
      nowMs: 1_000,
    });
    const beat = tickFxSpotTape('EUR', 3_000);
    expect(beat).not.toBeNull();
    expect(beat!.snapped).toBe(false);
    expect(beat!.quote.mid).not.toBe(LIVE.mid);
    expect(beat!.live.mid).toBeCloseTo(LIVE.mid, 6);
  });
});

// On a minute boundary.
const T0 = 1_700_000_100_000;

function livePrint(spot: number, asOfTime: string): LiveFxQuote {
  return {
    spot,
    base: 'EUR',
    quote: 'USD',
    asOfDate: '2026-09-08',
    asOfTime,
    source: 'exchangerate-dev',
  };
}

/** Let a fire-and-forget refresh / persist chain settle. */
function settle(ms = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fakeModel(
  overrides: Partial<FakeSpotDayCandleRowModel> = {},
): FakeSpotDayCandleRowModel {
  return {
    findAll: vi.fn(async () => []),
    upsert: vi.fn(async () => undefined),
    destroy: vi.fn(async () => 0),
    ...overrides,
  };
}

function storedRow(
  bucketStartMs: number,
  openMid: string,
  highMid: string,
  lowMid: string,
  closeMid: string,
  tickCount: number,
  livePrintCount: number,
): FakeSpotDayCandleRow {
  return { bucketStartMs, openMid, highMid, lowMid, closeMid, tickCount, livePrintCount };
}

function minuteBarUpserts(upsert: { mock: { calls: unknown[][] } }) {
  return upsert.mock.calls.filter(
    call => (call[0] as { barSec: number }).barSec === 60,
  );
}

describe('spot day record', () => {
  afterEach(() => {
    resetFxSpotTapeForTests();
    liveFetch.mockReset();
    spotDayDb.model = null;
    vi.restoreAllMocks();
  });

  it('folds the served walk into 1m bars and rolls on the minute', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    tickFxSpotTape('EUR', T0 + 1_000);
    tickFxSpotTape('EUR', T0 + 2_000);

    const open = await spotDayCandlesFor('EURUSD', T0, T0 + 2_000);
    expect(open.candles).toEqual([]);
    expect(open.persisted).toBe(false);
    expect(open.warning).toBeNull();
    // One real print (the snap) and two simulated steps.
    expect(open.forming).toMatchObject({ t: T0, ticks: 3, prints: 1 });
    // Hand-checked walk with rand = 0.9 (two pips up, no sign flip):
    //   1.1623 → 1.1625 → 1.1625 + 0.0002 − (1.1625 − 1.1623)·0.18 = 1.162664
    expect(open.forming!.open).toBeCloseTo(1.1623, 6);
    expect(open.forming!.close).toBeCloseTo(1.162664, 6);
    // The wick is the mid path's own extremes: this walk only went up, so the
    // bar runs from its first print to its last and draws no wick at all.
    expect(open.forming!.high).toBeCloseTo(1.162664, 6);
    expect(open.forming!.low).toBeCloseTo(1.1623, 6);

    tickFxSpotTape('EUR', T0 + 60_000);
    const rolled = await spotDayCandlesFor('EURUSD', T0, T0 + 60_000);
    expect(rolled.candles).toHaveLength(1);
    expect(rolled.candles[0]).toMatchObject({ t: T0, ticks: 3, prints: 1 });
    expect(rolled.candles[0]!.close).toBeCloseTo(1.162664, 6);
    expect(rolled.forming).toMatchObject({ t: T0 + 60_000, ticks: 1, prints: 0 });
  });

  it('records one print per walk second even when the beat and the poll both commit it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    tickFxSpotTape('EURUSD', T0 + 1_000);
    // Same second again from the route: the walk does not advance, nothing is recorded twice.
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 + 1_200 });
    tickFxSpotTape('EUR', T0 + 1_400);
    const { forming } = await spotDayCandlesFor('EURUSD', T0, T0 + 2_000);
    expect(forming).toMatchObject({ ticks: 2 });
  });

  it('counts a re-fetched print with a fresh timestamp as live even when the mid did not move', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: '10:00:00', nowMs: T0 });
    // The same print served from the 20s cache: a simulated step.
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: '10:00:00', nowMs: T0 + 5_000 });
    // A fresh fetch re-confirming the same rate under a new timestamp: live.
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: '10:00:20', nowMs: T0 + 20_000 });
    // The matcher beat never carries a new timestamp.
    tickFxSpotTape('EUR', T0 + 21_000);
    const { forming } = await spotDayCandlesFor('EURUSD', T0, T0 + 21_000);
    expect(forming).toMatchObject({ ticks: 4, prints: 2 });
  });

  it('stamps prints with the wall clock, not a walk clock that lags after idling', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    // An hour idle: the walk catches up at most 8 steps per beat, so its own
    // clock sits at T0 + 8s while the print is really at T0 + 1h.
    tickFxSpotTape('EUR', T0 + 3_600_000);
    const { candles, forming } = await spotDayCandlesFor('EURUSD', T0, T0 + 3_600_000);
    expect(candles.map(c => c.t)).toEqual([T0]);
    expect(forming).toMatchObject({ t: T0 + 3_600_000, ticks: 1 });
  });

  it('starts recording on the first read when the pair has no walk yet', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    liveFetch.mockResolvedValueOnce(livePrint(1.1623, '2026-09-08T10:00:00Z'));
    const first = await spotDayCandlesFor('EURUSD', T0, T0 + 1_000);
    expect(liveFetch).toHaveBeenCalledTimes(1);
    expect(first.warning).toBeNull();
    // The seeding print is already the forming bar of this very answer.
    expect(first.forming).toMatchObject({ t: T0, ticks: 1, prints: 1 });
    expect(first.forming!.open).toBeCloseTo(1.1623, 6);
    // The beat will keep this pair ticking from now on.
    expect(seededFxSpotCurrencies()).toEqual(['EUR']);
    // A second read does not re-seed.
    await spotDayCandlesFor('EURUSD', T0, T0 + 1_000);
    expect(liveFetch).toHaveBeenCalledTimes(1);
  });

  it('answers with a warning, not an error, when the seeding fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    liveFetch.mockRejectedValue(new Error('feed down'));
    const gbp = await spotDayCandlesFor('GBPUSD', T0, T0 + 1_000);
    expect(gbp.candles).toEqual([]);
    expect(gbp.forming).toBeNull();
    expect(gbp.warning).toMatch(/Live feed unavailable/);
    await spotDayCandlesFor('GBPUSD', T0, T0 + 1_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(seededFxSpotCurrencies()).toEqual([]);
  });

  it('names the FCY of every seeded pair for the beat, USD pairs either way round', () => {
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    ingestLiveFxSpotQuote({
      pair: 'USDJPY',
      live: { bid: 147.1, mid: 147.11, ask: 147.12 },
      asOf: 't0',
      nowMs: T0,
    });
    expect(seededFxSpotCurrencies().sort()).toEqual(['EUR', 'JPY']);
  });

  it('does not pin an empty record for a code nothing has printed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    liveFetch.mockRejectedValue(new Error('feed down'));
    await spotDayCandlesFor('XXXUSD', T0, T0 + 1_000);
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    const eur = await spotDayCandlesFor('EURUSD', T0, T0 + 1_000);
    expect(eur.forming).toMatchObject({ t: T0, ticks: 1 });
    const g = globalThis as { __fxSpotDayRecordV3?: Map<string, unknown> };
    expect([...(g.__fxSpotDayRecordV3?.keys() ?? [])]).toEqual(['EURUSD']);
  });

  it('backfills persisted bars once, then re-reads only the tail once a minute', async () => {
    const rows = [
      storedRow(T0 - 120_000, '1.16010000', '1.16050000', '1.16000000', '1.16030000', 60, 2),
      storedRow(T0 - 60_000, '1.16030000', '1.16080000', '1.16020000', '1.16070000', 60, 1),
    ];
    const findAll = vi.fn<FakeSpotDayCandleRowModel['findAll']>(async () => rows);
    spotDayDb.model = fakeModel({ findAll });
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    // A walk seeded well before the window, so no read has to seed one.
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 - 180_000 });

    const first = await spotDayCandlesFor('EURUSD', T0 - 120_000, T0);
    expect(first.persisted).toBe(true);
    expect(first.warning).toBeNull();
    expect(first.candles).toEqual([
      { t: T0 - 120_000, open: 1.1601, high: 1.1605, low: 1.16, close: 1.1603, ticks: 60, prints: 2 },
      { t: T0 - 60_000, open: 1.1603, high: 1.1608, low: 1.1602, close: 1.1607, ticks: 60, prints: 1 },
    ]);
    expect(findAll).toHaveBeenCalledTimes(1);

    // Same window start inside the refresh interval: served from memory.
    now.mockReturnValue(T0 + 2_000);
    await spotDayCandlesFor('EURUSD', T0 - 120_000, T0 + 2_000);
    expect(findAll).toHaveBeenCalledTimes(1);

    // A minute later another writer has closed the T0 bucket: the tail re-read picks it up.
    rows.push(storedRow(T0, '1.16070000', '1.16100000', '1.16060000', '1.16090000', 60, 3));
    now.mockReturnValue(T0 + 61_000);
    const later = await spotDayCandlesFor('EURUSD', T0 - 60_000, T0 + 61_000);
    expect(findAll).toHaveBeenCalledTimes(2);
    expect(later.candles.map(c => c.t)).toEqual([T0 - 60_000, T0]);

    // The re-read is bounded to the tail — two refresh intervals before the
    // last read — not the window start the caller asked for.
    now.mockReturnValue(T0 + 5 * 60_000);
    await spotDayCandlesFor('EURUSD', T0 - 120_000, T0 + 5 * 60_000);
    expect(findAll).toHaveBeenCalledTimes(3);
    const tail = findAll.mock.calls[2]![0].where.bucketStartMs;
    expect(tail[Op.gte]).toBe(T0 + 60_000 - 2 * SPOT_DAY_BACKFILL_REFRESH_MS);
    expect(tail[Op.lte]).toBe(T0 + 5 * 60_000);
  });

  it('keeps the bar this process folded when the same bucket is read back', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const upsert = vi.fn<FakeSpotDayCandleRowModel['upsert']>(async () => undefined);
    const findAll = vi.fn<FakeSpotDayCandleRowModel['findAll']>(async () => [
      storedRow(T0, '1.10000000', '1.20000000', '1.00000000', '1.15000000', 999, 999),
    ]);
    spotDayDb.model = fakeModel({ findAll, upsert });
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 60_000);
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    tickFxSpotTape('EUR', T0 + 1_000);
    tickFxSpotTape('EUR', T0 + 60_000);
    await settle();
    expect(minuteBarUpserts(upsert)).toHaveLength(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        pair: 'EURUSD',
        barSec: 60,
        bucketStartMs: T0,
        tickCount: 2,
        livePrintCount: 1,
      }),
      { conflictFields: ['pair', 'barSec', 'bucketStartMs'] },
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ pair: 'EURUSD', barSec: 1, bucketStartMs: T0 }),
      { conflictFields: ['pair', 'barSec', 'bucketStartMs'] },
    );

    const served = await spotDayCandlesFor('EURUSD', T0, T0 + 60_000);
    expect(findAll).toHaveBeenCalledTimes(1);
    expect(served.candles).toHaveLength(1);
    // Own bar, not the stored row and not a double-counted merge of the two.
    expect(served.candles[0]).toMatchObject({ t: T0, ticks: 2, prints: 1 });
    expect(served.candles[0]!.open).toBeCloseTo(1.1623, 6);
  });

  it('surfaces a failed backfill as a warning and still serves the process record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spotDayDb.model = fakeModel({
      findAll: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    const served = await spotDayCandlesFor('EURUSD', T0, T0 + 1_000);
    expect(served.warning).toMatch(/backfill failed/);
    expect(served.forming).toMatchObject({ t: T0, ticks: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once for repeated backfill failures until a read succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = { value: true };
    spotDayDb.model = fakeModel({
      findAll: vi.fn(async () => {
        if (failing.value) throw new Error('connection refused');
        return [];
      }),
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    await spotDayCandlesFor('EURUSD', T0, T0 + 1_000);
    await spotDayCandlesFor('EURUSD', T0, T0 + 1_000);
    expect(warn).toHaveBeenCalledTimes(1);

    failing.value = false;
    await spotDayCandlesFor('EURUSD', T0, T0 + 1_000);
    failing.value = true;
    now.mockReturnValue(T0 + 61_000);
    const again = await spotDayCandlesFor('EURUSD', T0, T0 + 61_000);
    expect(again.warning).toMatch(/backfill failed/);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns once for repeated persist failures until a bar lands', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = { value: true };
    const upsert = vi.fn<FakeSpotDayCandleRowModel['upsert']>(async () => {
      if (failing.value) throw new Error('connection refused');
    });
    spotDayDb.model = fakeModel({ upsert });
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    tickFxSpotTape('EUR', T0 + 60_000);
    tickFxSpotTape('EUR', T0 + 120_000);
    await vi.waitFor(() => expect(minuteBarUpserts(upsert)).toHaveLength(2));
    await settle(20);
    expect(warn).toHaveBeenCalledTimes(1);

    failing.value = false;
    tickFxSpotTape('EUR', T0 + 180_000);
    await vi.waitFor(() => expect(minuteBarUpserts(upsert)).toHaveLength(3));
    failing.value = true;
    tickFxSpotTape('EUR', T0 + 240_000);
    await vi.waitFor(() => expect(minuteBarUpserts(upsert)).toHaveLength(4));
    await settle(20);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('prunes persisted bars past retention once an hour per pair', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const destroy = vi.fn<FakeSpotDayCandleRowModel['destroy']>(async () => 0);
    spotDayDb.model = fakeModel({ destroy });
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    tickFxSpotTape('EUR', T0 + 60_000);
    // The prune resolves two lazy imports before it runs — wait for it.
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    const where = destroy.mock.calls[0]![0].where;
    expect(where.pair).toBe('EURUSD');
    expect(where.barSec).toBeUndefined();
    expect(where.bucketStartMs[Op.lt]).toBe(T0 + 60_000 - SPOT_DAY_RETENTION_MS);

    // The next close inside the hour does not prune again.
    tickFxSpotTape('EUR', T0 + 120_000);
    await settle(20);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('never fetches a live print for a walk the route did not seed', () => {
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    tickFxSpotTape('EUR', T0 + 60_000);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it('refreshes a stale live print on the beat once the route has fetched the pair', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    liveFetch.mockResolvedValueOnce(livePrint(1.1623, '2026-09-08T10:00:00Z'));
    // The route marks interest before it fetches.
    markFxSpotInterest('EURUSD', T0);
    await fetchAndWalkFxSpot({ pair: 'EURUSD' });
    expect(liveFetch).toHaveBeenCalledTimes(1);

    // Inside the 20s TTL: no refresh.
    tickFxSpotTape('EUR', T0 + 5_000);
    expect(liveFetch).toHaveBeenCalledTimes(1);

    now.mockReturnValue(T0 + 25_000);
    liveFetch.mockResolvedValueOnce(livePrint(1.165, '2026-09-08T10:00:25Z'));
    tickFxSpotTape('EUR', T0 + 25_000);
    expect(liveFetch).toHaveBeenCalledTimes(2);
    await settle();
    // The walk snapped to the new print and keeps it as its anchor.
    expect(tickFxSpotTape('EUR', T0 + 25_500)!.live.mid).toBeCloseTo(1.165, 6);
  });

  it('drops to the idle cadence when nothing has shown interest for two minutes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    liveFetch.mockResolvedValue(livePrint(1.1623, '2026-09-08T10:00:00Z'));
    markFxSpotInterest('EURUSD', T0);
    await fetchAndWalkFxSpot({ pair: 'EURUSD' });

    now.mockReturnValue(T0 + 25_000);
    tickFxSpotTape('EUR', T0 + 25_000);
    await settle();
    expect(liveFetch).toHaveBeenCalledTimes(2);

    // Interest expired: a 20s TTL would refetch here, the 5 min idle one does not.
    now.mockReturnValue(T0 + 3 * 60_000);
    tickFxSpotTape('EUR', T0 + 3 * 60_000);
    expect(liveFetch).toHaveBeenCalledTimes(2);

    // Past the idle cadence the pair is re-anchored again.
    now.mockReturnValue(T0 + 25_000 + LIVE_FX_IDLE_REFRESH_MS);
    tickFxSpotTape('EUR', T0 + 25_000 + LIVE_FX_IDLE_REFRESH_MS);
    expect(liveFetch).toHaveBeenCalledTimes(3);
  });

  it('a day-record read puts the pair back on the fast cadence', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    liveFetch.mockResolvedValue(livePrint(1.1623, '2026-09-08T10:00:00Z'));
    markFxSpotInterest('EURUSD', T0);
    await fetchAndWalkFxSpot({ pair: 'EURUSD' });

    now.mockReturnValue(T0 + 3 * 60_000);
    tickFxSpotTape('EUR', T0 + 3 * 60_000);
    expect(liveFetch).toHaveBeenCalledTimes(1);

    await spotDayCandlesFor('EURUSD', T0, T0 + 3 * 60_000);
    tickFxSpotTape('EUR', T0 + 3 * 60_000 + 1_000);
    expect(liveFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the last print and backs off one TTL when the live refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    liveFetch.mockResolvedValueOnce(livePrint(1.1623, '2026-09-08T10:00:00Z'));
    markFxSpotInterest('EURUSD', T0);
    await fetchAndWalkFxSpot({ pair: 'EURUSD' });

    now.mockReturnValue(T0 + 25_000);
    liveFetch.mockRejectedValueOnce(new Error('feed down'));
    tickFxSpotTape('EUR', T0 + 25_000);
    await settle();
    expect(liveFetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(tickFxSpotTape('EUR', T0 + 26_000)!.live.mid).toBeCloseTo(1.1623, 6);

    // Backed off: a beat five seconds later does not retry.
    tickFxSpotTape('EUR', T0 + 30_000);
    expect(liveFetch).toHaveBeenCalledTimes(2);
  });

  it("does not roll a newer print back when the beat's own fetch fails late", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(T0);
    liveFetch.mockResolvedValueOnce(livePrint(1.1623, '2026-09-08T10:00:00Z'));
    markFxSpotInterest('EURUSD', T0);
    await fetchAndWalkFxSpot({ pair: 'EURUSD' });

    now.mockReturnValue(T0 + 25_000);
    // The beat's refresh fetch is slow and fails ...
    liveFetch.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('feed down')), 5);
        }),
    );
    tickFxSpotTape('EUR', T0 + 25_000);
    // ... while an open ticket's poll fetches and caches a newer print first.
    liveFetch.mockResolvedValueOnce(livePrint(1.165, '2026-09-08T10:00:25Z'));
    await fetchAndWalkFxSpot({ pair: 'EURUSD' });
    await settle(10);
    expect(liveFetch).toHaveBeenCalledTimes(3);

    // The newer print survives the late failure: still cached, no refetch inside the TTL.
    now.mockReturnValue(T0 + 26_000);
    expect((await fetchLiveFxQuoteCached('EURUSD')).spot).toBeCloseTo(1.165, 6);
    expect(liveFetch).toHaveBeenCalledTimes(3);
  });
});
