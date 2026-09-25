import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  SPOT_DAY_SOURCE,
  type SpotDayCandlesPayload,
} from '@/lib/test-mode/tape-candles';

const sessionEmail = { value: 'desk@example.com' as string | null };
vi.mock('@/auth', () => ({
  auth: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
}));
// No Postgres in unit tests: the record is served from process memory.
vi.mock('@/lib/db/models/spot-day-candle', () => ({
  getSpotDayCandleRowModel: async () => null,
}));
// No live feed either: a read for an unseeded pair tries to seed it and
// must answer with a warning, never reach the network.
vi.mock('@/lib/fxLiveClient', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/fxLiveClient')>();
  return {
    ...actual,
    fetchLiveFxQuote: async () => {
      throw new Error('feed down');
    },
  };
});

const { GET } = await import('@/app/api/fx-spot/candles/route');
const { ingestLiveFxSpotQuote, resetFxSpotTapeForTests, tickFxSpotTape } =
  await import('@/lib/fx-spot-tape');

// On a minute boundary.
const T0 = 1_700_000_100_000;
const LIVE = { bid: 1.1622, mid: 1.1623, ask: 1.1624 };

function get(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/fx-spot/candles?${query}`);
}

describe('GET /api/fx-spot/candles', () => {
  afterEach(() => {
    sessionEmail.value = 'desk@example.com';
    resetFxSpotTapeForTests();
    vi.restoreAllMocks();
  });

  it('refuses an unauthenticated caller before reading anything', async () => {
    sessionEmail.value = null;
    const res = await GET(get(`ccy=EUR&fromMs=${T0}&toMs=${T0 + 1_000}`));
    expect(res.status).toBe(401);
  });

  it('rejects a malformed currency or window', async () => {
    const cases = [
      `ccy=EU&fromMs=${T0}&toMs=${T0 + 1}`,
      `ccy=USD&fromMs=${T0}&toMs=${T0 + 1}`,
      `ccy=EUR&fromMs=abc&toMs=${T0}`,
      `ccy=EUR&fromMs=${T0 + 10}&toMs=${T0}`,
      `ccy=EUR&fromMs=${T0}&toMs=${T0 + 49 * 3_600_000}`,
      `ccy=EUR&fromMs=${T0}&toMs=${T0 + 1}&barSec=7`,
    ];
    for (const query of cases) {
      const res = await GET(get(query));
      expect(res.status, query).toBe(400);
    }
  });

  it('serves the recorded 1m bars for the currency pair inside the window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    ingestLiveFxSpotQuote({ pair: 'EURUSD', live: LIVE, asOf: 't0', nowMs: T0 });
    tickFxSpotTape('EUR', T0 + 1_000);
    tickFxSpotTape('EUR', T0 + 60_000);

    const res = await GET(get(`ccy=eur&fromMs=${T0}&toMs=${T0 + 60_000}`));
    expect(res.status).toBe(200);
    const body: SpotDayCandlesPayload = await res.json();
    expect(body.pair).toBe('EURUSD');
    expect(body.currency).toBe('EUR');
    expect(body.barSec).toBe(60);
    expect(body.source).toBe(SPOT_DAY_SOURCE);
    expect(body.candles).toHaveLength(1);
    // The snap is the bar's one live print; the beat added a simulated step.
    expect(body.candles[0]).toMatchObject({ t: T0, ticks: 2, prints: 1 });
    expect(body.candles[0]!.open).toBeCloseTo(1.1623, 6);
    expect(body.forming).toMatchObject({ t: T0 + 60_000, ticks: 1, prints: 0 });
    expect(body.persisted).toBe(false);
    expect(body.warning).toBeNull();
  });

  it('answers an empty record with a warning, not an error, when nothing has printed and the feed is down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await GET(get(`ccy=GBP&fromMs=${T0}&toMs=${T0 + 1_000}`));
    expect(res.status).toBe(200);
    const body: SpotDayCandlesPayload = await res.json();
    expect(body.candles).toEqual([]);
    expect(body.forming).toBeNull();
    expect(body.warning).toMatch(/Live feed unavailable/);
  });
});
