import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Op } from 'sequelize';
import type {
  ExecutionBeatEvent,
  ExecutionOrderEvent,
} from '@/lib/test-mode/execution-monitor';

const session: { email: string | null } = { email: 'desk@example.com' };
vi.mock('@/auth', () => ({
  auth: async () => (session.email ? { user: { email: session.email } } : null),
}));

type StoredRow = { payload: unknown };
const findAll = vi.fn(async (_options: unknown): Promise<StoredRow[]> => []);
const bulkCreate = vi.fn(async (_rows: unknown[]) => []);
vi.mock('@/lib/db/models/execution-log', () => ({
  getExecutionLogModel: async () => ({ findAll, bulkCreate }),
}));

type Route = typeof import('@/app/api/execution-log/route');

function orderEvent(orderId: string, atMs: number): ExecutionOrderEvent {
  return {
    kind: 'order',
    atMs,
    orderId,
    ccy: 'EUR',
    outcome: 'working',
    basis: 'stock',
    instrument: 'forward',
    maturityLabel: '1M',
    orderSide: 'Sell',
    hitSide: 'bid',
    bracketRole: null,
    ocoGroupId: null,
    limitRate: 1.17,
    marketBid: 1.16,
    marketAsk: 1.1602,
    marketMid: 1.1601,
    triggerPx: null,
    filledPx: null,
    distancePips: 99,
    amountLocalM: 1,
    notionalUsdM: 1.17,
    committedUsdM: 0,
    policyCapUsdM: 10,
    autoFillAllowed: true,
    quoteConvention: 'usd-per-fcy',
    reason: 'resting',
    summary: `EUR WORKING ${orderId} sell 1.00M limit 1.17000`,
  };
}

function beatEvent(atMs: number): ExecutionBeatEvent {
  return {
    kind: 'beat',
    atMs,
    elapsedMs: 3,
    ccyCount: 1,
    working: 1,
    triggered: 1,
    filled: 1,
    blocked: 0,
    summary: `[node] BEAT at ${atMs}`,
  };
}

function get(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/execution-log${query}`);
}

function post(payload: unknown): NextRequest {
  return new NextRequest('http://localhost/api/execution-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function orderIdsOf(res: Response): Promise<string[]> {
  const body: { events: { kind: string; orderId?: string }[] } = await res.json();
  return body.events.flatMap(e => (e.kind === 'order' && e.orderId ? [e.orderId] : []));
}

describe('/api/execution-log', () => {
  let route: Route;
  beforeEach(async () => {
    session.email = 'desk@example.com';
    findAll.mockClear();
    bulkCreate.mockClear();
    // The in-memory ring buffer is module state; a fresh route + store per
    // case keeps one case's events out of the next.
    vi.resetModules();
    route = await import('@/app/api/execution-log/route');
  });

  it('refuses an unauthenticated GET and POST', async () => {
    session.email = null;
    expect((await route.GET(get())).status).toBe(401);
    expect((await route.POST(post({ events: [orderEvent('o-1', 1)] }))).status).toBe(401);
  });

  it('asks the database only for the caller\'s own rows and ownerless beats', async () => {
    session.email = 'Desk@Example.com';
    await route.GET(get('?limit=50'));
    expect(findAll).toHaveBeenCalledTimes(1);
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          [Op.or]: [
            { userEmail: 'desk@example.com' },
            { kind: 'beat', userEmail: { [Op.is]: null } },
          ],
        },
      }),
    );
  });

  it('stamps every posted event, beats included, with the session\'s own email', async () => {
    session.email = 'Desk@Example.com';
    // A body cannot choose its owner: a spoofed field on the event is ignored.
    const spoofed = { ...orderEvent('o-1', 100), userEmail: 'other@example.com' };
    const res = await route.POST(post({ events: [spoofed, beatEvent(200)] }));
    expect(res.status).toBe(200);
    expect(bulkCreate).toHaveBeenCalledTimes(1);
    const rows: unknown = bulkCreate.mock.calls[0]?.[0];
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'order', orderId: 'o-1', userEmail: 'desk@example.com' }),
      expect.objectContaining({ kind: 'beat', userEmail: 'desk@example.com' }),
    ]);
  });

  it('shows a posted order to the desk that posted it and not to another desk', async () => {
    session.email = 'alice@example.com';
    await route.POST(post({ events: [orderEvent('alice-1', 100)] }));

    session.email = 'bob@example.com';
    expect(await orderIdsOf(await route.GET(get()))).toEqual([]);

    session.email = 'alice@example.com';
    expect(await orderIdsOf(await route.GET(get()))).toEqual(['alice-1']);
  });
});
