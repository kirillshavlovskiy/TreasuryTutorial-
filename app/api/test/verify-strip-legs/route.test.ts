import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';

const sessionEmail = { value: 'desk@example.com' as string | null };
vi.mock('@/auth', () => ({
  auth: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
}));

const journalText = { value: null as string | null };
vi.mock('@/lib/s3', async importOriginal => ({
  // The real key-segment encoder: the keys under test must be the keys the
  // route and the matcher actually build.
  s3OwnerSegment: (await importOriginal<typeof import('@/lib/s3')>()).s3OwnerSegment,
  getS3ObjectText: vi.fn(async () => {
    if (journalText.value == null) {
      const err = new Error('not found');
      err.name = 'NoSuchKey';
      throw err;
    }
    return journalText.value;
  }),
}));

type LegTapePoint = { quoteKey: string; bid: number; ask: number; mid: number; t: number };
const dbTape = { value: [] as LegTapePoint[] };
vi.mock('@/lib/test-mode/matching-process-persist', () => ({
  loadLegTapeTicks: vi.fn(async () => dbTape.value),
}));

const { POST } = await import('@/app/api/test/verify-strip-legs/route');

function post(payload: unknown): Request {
  return new Request('http://localhost/api/test/verify-strip-legs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function ticket(partial: Partial<HedgeTicket> & Pick<HedgeTicket, 'id'>): HedgeTicket {
  return {
    ccy: 'EUR',
    instrument: 'forward',
    basis: 'totalBuildup',
    amountLocalM: 5,
    maturity: '1m',
    maturityLabel: '1M',
    maturityMonths: 1,
    varUsdM: 0,
    addressesHigherVar: true,
    stripId: 'strip-1',
    stripEdgeIndex: 0,
    status: 'scheduled',
    limitRate: 1.166,
    ...partial,
  };
}

type VerifyResponse = {
  taskId: string;
  summary: { legsChecked: number; consistent: number; mismatches: number };
  legs: {
    stripId: string;
    edgeIndex: number;
    status: string;
    chart: { levels: { role: string; price: number }[] };
    tapeCheck: { wouldTrigger: boolean; nearestTapeMid: number } | null;
    verdict: string;
    notes: string[];
  }[];
};

describe('POST /api/test/verify-strip-legs', () => {
  beforeEach(() => {
    sessionEmail.value = 'desk@example.com';
    journalText.value = null;
    dbTape.value = [];
  });

  it('refuses an unauthenticated caller', async () => {
    sessionEmail.value = null;
    const res = await POST(post({ tickets: [] }));
    expect(res.status).toBe(401);
  });

  it('reports no-fill-to-check for a leg still working', async () => {
    const tickets = [ticket({ id: 'w1' })];
    const res = await POST(post({ tickets }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs).toHaveLength(1);
    expect(json.legs[0]!.status).toBe('working');
    expect(json.legs[0]!.verdict).toBe('no-fill-to-check');
    expect(json.legs[0]!.tapeCheck).toBeNull();
  });

  it('marks a fill consistent when the recorded tape crosses the limit at fill time', async () => {
    const filledAtMs = 1_700_000_010_000;
    journalText.value = JSON.stringify({
      events: [],
      tapeByCcy: {
        'EUR|forward|t1.00': [
          { bid: 1.1655, ask: 1.1657, mid: 1.1656, t: 1_700_000_000_000 },
          { bid: 1.1660, ask: 1.1662, mid: 1.1661, t: filledAtMs },
        ],
      },
    });
    const tickets = [
      ticket({
        id: 'f1',
        status: 'booked',
        orderHit: 'bid',
        filledAtMs,
        limitRate: 1.166,
        ipaQuote: {
          strike: null,
          strikeInput: '',
          premiumUsd: null,
          premiumPercent: null,
          fxSpot: 1.16,
          fxOutright: 1.166,
          atmVolPercent: null,
          impliedVolPercent: null,
          deltaPercent: null,
        },
      }),
    ];
    const res = await POST(post({ tickets }));
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs[0]!.status).toBe('filled');
    expect(json.legs[0]!.tapeCheck?.wouldTrigger).toBe(true);
    expect(json.legs[0]!.verdict).toBe('consistent');
    expect(json.summary.mismatches).toBe(0);
  });

  it('flags a fill whose recorded tape never actually crossed the limit', async () => {
    // Same fill, but the recorded/displayed tape at that instant sits ~150
    // pips below the limit — the two-independent-random-walk divergence.
    const filledAtMs = 1_700_000_010_000;
    journalText.value = JSON.stringify({
      events: [],
      tapeByCcy: {
        'EUR|forward|t1.00': [
          { bid: 1.1508, ask: 1.1510, mid: 1.1509, t: filledAtMs },
        ],
      },
    });
    const tickets = [
      ticket({
        id: 'f2',
        status: 'booked',
        orderHit: 'bid',
        filledAtMs,
        limitRate: 1.166,
      }),
    ];
    const res = await POST(post({ tickets }));
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs[0]!.tapeCheck?.wouldTrigger).toBe(false);
    expect(json.legs[0]!.verdict).toBe('tape-never-crossed-level');
    expect(json.legs[0]!.notes[0]).toMatch(/does not cross limit/);
    expect(json.summary.mismatches).toBe(1);
  });

  it('keeps the cancelled OCO sibling in the chart levels once its partner has filled', async () => {
    // chartTicketsAtEdge (2026-09-17): the desk asked to still see where a
    // cancelled OCO leg was resting, not just the fill — this report mirrors
    // TradeTicketPanel's chartLevelTickets, so it must show both.
    const filledAtMs = 1_700_000_010_000;
    journalText.value = JSON.stringify({
      events: [],
      tapeByCcy: {
        'EUR|forward|t1.00': [
          { bid: 1.166, ask: 1.1662, mid: 1.1661, t: filledAtMs },
        ],
      },
    });
    const tp = ticket({
      id: 'tp1',
      status: 'booked',
      bracketRole: 'takeProfit',
      orderHit: 'bid',
      filledAtMs,
      limitRate: 1.166,
      ocoGroupId: 'oco-1',
    });
    const sl = ticket({
      id: 'sl1',
      status: 'cancelled',
      bracketRole: 'stopLoss',
      limitRate: 1.15,
      ocoGroupId: 'oco-1',
    });
    const res = await POST(post({ tickets: [tp, sl] }));
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs).toHaveLength(1);
    expect(json.legs[0]!.status).toBe('filled');
    expect(json.legs[0]!.chart.levels).toEqual([
      { role: 'TP', price: 1.166 },
      { role: 'SL', price: 1.15 },
    ]);
  });

  it('reports no-tape-recorded when the journal has no history for this leg', async () => {
    journalText.value = JSON.stringify({ events: [], tapeByCcy: {} });
    const tickets = [
      ticket({
        id: 'f3',
        status: 'booked',
        orderHit: 'bid',
        filledAtMs: 1_700_000_010_000,
      }),
    ];
    const res = await POST(post({ tickets }));
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs[0]!.verdict).toBe('no-tape-recorded');
    expect(json.legs[0]!.tapeCheck).toBeNull();
  });

  it('handles a missing journal (no S3 object yet) without erroring', async () => {
    journalText.value = null;
    const tickets = [ticket({ id: 'w2' })];
    const res = await POST(post({ tickets }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs).toHaveLength(1);
  });

  it('ignores tickets with no stripId', async () => {
    const tickets = [ticket({ id: 'bullet', stripId: undefined, stripEdgeIndex: undefined })];
    const res = await POST(post({ tickets }));
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs).toHaveLength(0);
  });

  it('verifies against the DB-recorded tape when there is no S3 journal at all', async () => {
    // The actual local-dev case: no AWS credentials, so the S3 journal read
    // 404s (NoSuchKey) every time, but Postgres is reachable and the server
    // matcher has been recording there directly.
    journalText.value = null;
    const filledAtMs = 1_700_000_010_000;
    dbTape.value = [
      { quoteKey: 'EUR|forward|t1.00', bid: 1.1655, ask: 1.1657, mid: 1.1656, t: 1_700_000_000_000 },
      { quoteKey: 'EUR|forward|t1.00', bid: 1.166, ask: 1.1662, mid: 1.1661, t: filledAtMs },
    ];
    const tickets = [
      ticket({ id: 'db1', status: 'booked', orderHit: 'bid', filledAtMs, limitRate: 1.166 }),
    ];
    const res = await POST(post({ tickets }));
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs[0]!.tapeCheck?.wouldTrigger).toBe(true);
    expect(json.legs[0]!.verdict).toBe('consistent');
  });

  it('prefers the DB tape over the S3 journal when both have data for the leg', async () => {
    const filledAtMs = 1_700_000_010_000;
    // S3 journal alone would say "never crossed" (mid far below the limit).
    journalText.value = JSON.stringify({
      events: [],
      tapeByCcy: {
        'EUR|forward|t1.00': [{ bid: 1.15, ask: 1.1502, mid: 1.1501, t: filledAtMs }],
      },
    });
    // The DB tape (what the server actually recorded) says it did cross.
    dbTape.value = [
      { quoteKey: 'EUR|forward|t1.00', bid: 1.166, ask: 1.1662, mid: 1.1661, t: filledAtMs },
    ];
    const tickets = [
      ticket({ id: 'db2', status: 'booked', orderHit: 'bid', filledAtMs, limitRate: 1.166 }),
    ];
    const res = await POST(post({ tickets }));
    const json = (await res.json()) as VerifyResponse;
    expect(json.legs[0]!.tapeCheck?.nearestTapeMid).toBeCloseTo(1.1661);
    expect(json.legs[0]!.verdict).toBe('consistent');
  });
});
