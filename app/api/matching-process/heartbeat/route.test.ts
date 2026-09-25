import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MatchingProcessRuntime } from '@/lib/test-mode/matching-process-runtime';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';

const sessionEmail: { value: string | null } = { value: 'desk@example.com' };
vi.mock('@/auth', () => ({
  auth: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
}));

// A fresh, un-hydrated runtime per test — the route's job is auth gating,
// query parsing and response shape; MatchingProcessRuntime's own behaviour
// (tapeForUser, watchCcys, fills) is already exhaustively covered in
// matching-process-runtime.test.ts. .start()'s DB hydration is skipped
// entirely, same as that suite's own setup.
let runtime = new MatchingProcessRuntime();
vi.mock('@/lib/test-mode/matching-process-runtime', async importOriginal => {
  const actual =
    await importOriginal<typeof import('@/lib/test-mode/matching-process-runtime')>();
  return {
    ...actual,
    ensureMatchingProcess: async () => runtime,
  };
});

const { GET } = await import('@/app/api/matching-process/heartbeat/route');

function rest(partial: Partial<HedgeTicket> & Pick<HedgeTicket, 'id'>): HedgeTicket {
  return {
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
    ...partial,
  };
}

function get(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/matching-process/heartbeat?${query}`);
}

describe('GET /api/matching-process/heartbeat', () => {
  afterEach(() => {
    sessionEmail.value = 'desk@example.com';
    runtime = new MatchingProcessRuntime();
  });

  it('refuses an unauthenticated caller when a probe is requested', async () => {
    sessionEmail.value = null;
    const res = await GET(get('probeMs=1200'));
    expect(res.status).toBe(401);
  });

  it('answers bare liveness for an unauthenticated caller with no probe, and no book', async () => {
    sessionEmail.value = null;
    runtime.upsertOrders([
      { ticket: rest({ id: 'ht-1' }), userEmail: 'desk@example.com', taskId: '02' },
    ]);
    const res = await GET(get(''));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
    // monitorEvents carries every desk's working levels and notionals — an
    // unauthenticated caller must never see them.
    expect(body.monitorEvents).toEqual([]);
    expect(body.fills).toEqual([]);
    expect(body.tape).toEqual({});
  });

  it('serves this user\'s own tape, keyed by CCY|spot, and not another user\'s', async () => {
    runtime.upsertOrders([
      { ticket: rest({ id: 'ht-1' }), userEmail: 'desk@example.com', taskId: '02' },
      { ticket: rest({ id: 'ht-2', ccy: 'GBP' }), userEmail: 'other@example.com', taskId: '02' },
    ]);
    await runtime.step();
    const res = await GET(get(''));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.tape['EUR|spot']).toBeDefined();
    expect(Array.isArray(body.tape['EUR|spot'])).toBe(true);
    expect(body.tape['GBP|spot']).toBeUndefined();
  });

  it('registers a watched currency so the tape starts recording before any order exists', async () => {
    // watchCcys is what lets a currency record from the moment a ticket
    // panel opens — a market execution creates its order only at the fill,
    // so without this there is nothing recorded before that fill's own print.
    const res = await GET(get('watch=EUR&taskId=02'));
    expect(res.status).toBe(200);
    await runtime.step();
    const tape = runtime.tapeForUser('desk@example.com');
    expect(tape['EUR|spot']).toBeDefined();
  });

  /** Two desks, each with one take-profit resting short of the market. */
  async function twoDesksWorking(): Promise<void> {
    runtime.mergeSpots({ EUR: { bid: 1.10, mid: 1.1001, ask: 1.1002 } });
    runtime.replaceUserOrders('desk@example.com', '02', [
      rest({ id: 'mine-tp', bracketRole: 'takeProfit', limitRate: 1.2, restingAnchorRate: 1.1995 }),
    ]);
    runtime.replaceUserOrders('other@example.com', '02', [
      rest({ id: 'theirs-tp', bracketRole: 'takeProfit', limitRate: 1.21, restingAnchorRate: 1.1995 }),
    ]);
    runtime.mergeSpots({ EUR: { bid: 1.1994, mid: 1.1995, ask: 1.1996 } });
    await runtime.step();
  }

  function orderIds(body: { monitorEvents: { kind: string; orderId?: string }[] }): string[] {
    return body.monitorEvents.flatMap(e => (e.kind === 'order' && e.orderId ? [e.orderId] : []));
  }

  it('shows the signed-in desk its own working orders and not another desk\'s', async () => {
    await twoDesksWorking();
    const res = await GET(get(''));
    expect(res.status).toBe(200);
    expect(orderIds(await res.json())).toEqual(['mine-tp']);
  });

  it('scopes a probed heartbeat to the signed-in desk the same way', async () => {
    await twoDesksWorking();
    sessionEmail.value = 'Other@Example.com';
    const res = await GET(get('probeMs=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.probe).toBeDefined();
    expect(orderIds(body)).toEqual(['theirs-tp']);
  });

  it('shows no order lines to an unauthenticated liveness check even when desks have working orders', async () => {
    await twoDesksWorking();
    sessionEmail.value = null;
    const body = await (await GET(get(''))).json();
    expect(orderIds(body)).toEqual([]);
  });

  it('ignores a malformed watch currency instead of throwing', async () => {
    const res = await GET(get('watch=EU9,,XXXX'));
    expect(res.status).toBe(200);
  });
});
