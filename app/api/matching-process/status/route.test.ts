import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatchingProcessRuntime } from '@/lib/test-mode/matching-process-runtime';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';

const session: { email: string | null } = { email: 'alice@example.com' };
vi.mock('@/auth', () => ({
  auth: async () => (session.email ? { user: { email: session.email } } : null),
}));

// A real, un-hydrated runtime shared with the route — the route's own job is
// auth gating and scoping the heartbeat to the caller's desk.
let runtime = new MatchingProcessRuntime();
vi.mock('@/lib/test-mode/matching-process-runtime', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/lib/test-mode/matching-process-runtime')>();
  return {
    ...actual,
    ensureMatchingProcess: async () => runtime,
    getMatchingRuntime: () => runtime,
  };
});

const { GET } = await import('@/app/api/matching-process/status/route');

function takeProfit(id: string, limitRate: number): HedgeTicket {
  return {
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
  };
}

/** Two desks, each with one take-profit resting short of the market. */
async function twoDesksWorking(): Promise<void> {
  runtime.mergeSpots({ EUR: { bid: 1.10, mid: 1.1001, ask: 1.1002 } });
  runtime.replaceUserOrders('alice@example.com', '02', [takeProfit('alice-tp', 1.2)]);
  runtime.replaceUserOrders('bob@example.com', '02', [takeProfit('bob-tp', 1.21)]);
  runtime.mergeSpots({ EUR: { bid: 1.1994, mid: 1.1995, ask: 1.1996 } });
  await runtime.step();
}

type HeartbeatBody = {
  success?: boolean;
  isRunning?: boolean;
  monitorEvents: { kind: string; orderId?: string }[];
};

function orderIds(body: HeartbeatBody): string[] {
  return body.monitorEvents.flatMap(e => (e.kind === 'order' && e.orderId ? [e.orderId] : []));
}

describe('GET /api/matching-process/status', () => {
  afterEach(() => {
    session.email = 'alice@example.com';
    runtime.stop();
    runtime = new MatchingProcessRuntime();
  });

  it('refuses an unauthenticated caller', async () => {
    session.email = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('shows the signed-in desk its own working orders and not another desk\'s', async () => {
    await twoDesksWorking();
    const res = await GET();
    expect(res.status).toBe(200);
    const body: HeartbeatBody = await res.json();
    expect(orderIds(body)).toEqual(['alice-tp']);
  });

  it('matches the desk to its orders whatever the case of the sign-in email', async () => {
    await twoDesksWorking();
    session.email = 'Bob@Example.COM';
    const body: HeartbeatBody = await (await GET()).json();
    expect(orderIds(body)).toEqual(['bob-tp']);
  });

  it('shows no order lines to a desk with no orders of its own', async () => {
    await twoDesksWorking();
    session.email = 'carol@example.com';
    const body: HeartbeatBody = await (await GET()).json();
    expect(orderIds(body)).toEqual([]);
  });
});
