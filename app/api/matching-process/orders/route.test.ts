import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MatchingProcessRuntime } from '@/lib/test-mode/matching-process-runtime';
import type { LegTapePoint } from '@/lib/test-mode/matching-process-persist';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';

const sessionEmail: { value: string | null } = { value: 'desk@example.com' };
vi.mock('@/auth', () => ({
  auth: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
}));

// Same fresh-runtime-per-test approach as the heartbeat route test — the
// route's own job is auth gating, param parsing and response shape; the
// runtime class itself is covered in matching-process-runtime.test.ts.
let runtime = new MatchingProcessRuntime();
vi.mock('@/lib/test-mode/matching-process-runtime', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/lib/test-mode/matching-process-runtime')>();
  return {
    ...actual,
    ensureMatchingProcess: async () => runtime,
  };
});

// No Postgres in unit tests — the persisted-tape backstop this route serves
// is exercised directly rather than through a real LegTapeTick table.
const loadLegTapeTicksMock =
  vi.fn<
    (
      userEmail: string,
      taskId: string,
      quoteKey: string,
      limit?: number,
      window?: { fromMs?: number | null; toMs?: number | null },
    ) => Promise<LegTapePoint[]>
  >(async () => []);
vi.mock('@/lib/test-mode/matching-process-persist', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/lib/test-mode/matching-process-persist')>();
  return {
    ...actual,
    loadLegTapeTicks: (...args: Parameters<typeof loadLegTapeTicksMock>) =>
      loadLegTapeTicksMock(...args),
  };
});

const { GET, POST } = await import('@/app/api/matching-process/orders/route');

function get(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/matching-process/orders?${query}`);
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/matching-process/orders', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const POINT: LegTapePoint = {
  quoteKey: 'EUR|spot',
  t: 1_700_000_000_000,
  bid: 1.1699,
  ask: 1.1701,
  mid: 1.17,
};

describe('GET /api/matching-process/orders', () => {
  afterEach(() => {
    sessionEmail.value = 'desk@example.com';
    runtime = new MatchingProcessRuntime();
    loadLegTapeTicksMock.mockReset();
    loadLegTapeTicksMock.mockResolvedValue([]);
  });

  it('refuses an unauthenticated caller before reading anything', async () => {
    sessionEmail.value = null;
    const res = await GET(get('keys=EUR|spot'));
    expect(res.status).toBe(401);
    expect(loadLegTapeTicksMock).not.toHaveBeenCalled();
  });

  it('returns the persisted history for a valid per-currency/per-contract key', async () => {
    loadLegTapeTicksMock.mockResolvedValueOnce([POINT]);
    const res = await GET(get('keys=EUR|spot&taskId=02'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.taskId).toBe('02');
    expect(body.tapeHistory['EUR|spot']).toEqual([
      { bid: POINT.bid, ask: POINT.ask, mid: POINT.mid, t: POINT.t },
    ]);
    // Scoped to this session's own (lower-cased) email — never a raw param.
    expect(loadLegTapeTicksMock).toHaveBeenCalledWith(
      'desk@example.com',
      '02',
      'EUR|spot',
      4_000,
      { fromMs: null, toMs: null },
    );
  });

  it('drops a malformed key instead of passing it through to the store', async () => {
    const res = await GET(get('keys=EUR|spot,DROP TABLE,../../etc'));
    expect(res.status).toBe(200);
    expect(loadLegTapeTicksMock).toHaveBeenCalledTimes(1);
    expect(loadLegTapeTicksMock).toHaveBeenCalledWith(
      'desk@example.com',
      'workspace',
      'EUR|spot',
      4_000,
      { fromMs: null, toMs: null },
    );
  });

  it('scopes a forward leg key to the caller-supplied story window', async () => {
    const res = await GET(
      get('keys=EUR|forward|t5.00&fromMs=1000&toMs=2000'),
    );
    expect(res.status).toBe(200);
    expect(loadLegTapeTicksMock).toHaveBeenCalledWith(
      'desk@example.com',
      'workspace',
      'EUR|forward|t5.00',
      4_000,
      { fromMs: 1_000, toMs: 2_000 },
    );
  });

  it('omits a key with no persisted history rather than serving an empty array', async () => {
    loadLegTapeTicksMock.mockResolvedValueOnce([]);
    const res = await GET(get('keys=EUR|spot'));
    const body = await res.json();
    expect(body.tapeHistory).toEqual({});
  });
});

describe('POST /api/matching-process/orders', () => {
  afterEach(() => {
    sessionEmail.value = 'desk@example.com';
    runtime = new MatchingProcessRuntime();
  });

  it('refuses an unauthenticated caller', async () => {
    sessionEmail.value = null;
    const res = await POST(post({ tickets: [] }));
    expect(res.status).toBe(401);
  });

  it('replaces this user\'s book and returns heartbeat, fills and tape together', async () => {
    const res = await POST(
      post({
        taskId: '02',
        tickets: [
          {
            id: 'ht-1',
            ccy: 'EUR',
            instrument: 'forward',
            basis: 'stock',
            amountLocalM: 2.55,
            orderSide: 'Sell',
            orderHit: 'bid',
            status: 'scheduled',
            limitRate: 1.17,
            restingAnchorRate: 1.17,
            maturity: '1m',
            maturityLabel: '1M',
            varUsdM: 0,
            addressesHigherVar: false,
          },
        ],
        watchCcys: ['EUR'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.accepted).toBe(1);
    expect(body.workingOrders).toBe(1);
    expect(body.fills).toEqual([]);
    expect(body.tape).toBeDefined();
  });

  it('returns only the posting desk\'s own order lines in the heartbeat it answers with', async () => {
    const takeProfit = (id: string, limitRate: number): HedgeTicket => ({
      id,
      ccy: 'EUR',
      instrument: 'forward',
      basis: 'stock',
      amountLocalM: 2,
      orderSide: 'Sell',
      orderHit: 'bid',
      status: 'scheduled',
      bracketRole: 'takeProfit',
      limitRate,
      restingAnchorRate: 1.1995,
      maturity: '1m',
      maturityLabel: '1M',
      varUsdM: 0,
      addressesHigherVar: false,
    });
    runtime.mergeSpots({ EUR: { bid: 1.10, mid: 1.1001, ask: 1.1002 } });
    expect((await POST(post({ taskId: '02', tickets: [takeProfit('mine-tp', 1.2)] }))).status).toBe(200);
    runtime.replaceUserOrders('other@example.com', '02', [takeProfit('theirs-tp', 1.21)]);
    runtime.mergeSpots({ EUR: { bid: 1.1994, mid: 1.1995, ask: 1.1996 } });
    await runtime.step();
    const res = await POST(post({ taskId: '02', tickets: [takeProfit('mine-tp', 1.2)] }));
    expect(res.status).toBe(200);
    const body: { monitorEvents: { kind: string; orderId?: string }[] } = await res.json();
    const ids = body.monitorEvents.flatMap(e => (e.kind === 'order' && e.orderId ? [e.orderId] : []));
    expect(ids).toEqual(['mine-tp']);
  });

  it('ignores a ticket-shaped object missing an id or ccy instead of throwing', async () => {
    const res = await POST(post({ tickets: [{ instrument: 'forward' }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(0);
  });

  it('refuses a spot-referenced order whose flag or points would book a malformed forward', async () => {
    const leg = {
      ccy: 'EUR',
      instrument: 'forward',
      basis: 'stock',
      amountLocalM: 2.55,
      orderSide: 'Sell',
      orderHit: 'bid',
      status: 'scheduled',
      limitRate: 1.1628,
      restingAnchorRate: 1.1648,
      maturity: '1y',
      maturityMonths: 12,
      maturityLabel: 'L5 · M12',
      varUsdM: 0,
      addressesHigherVar: false,
    };
    const res = await POST(
      post({
        tickets: [
          { ...leg, id: 'ok', isSpotReferenced: true, stripLegPoints: 170.1 },
          { ...leg, id: 'flag-string', isSpotReferenced: 'false', stripLegPoints: 170.1 },
          { ...leg, id: 'points-string', isSpotReferenced: true, stripLegPoints: '170.1' },
          { ...leg, id: 'points-missing', isSpotReferenced: true },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(1);
  });
});
