import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecutionBeatEvent,
  ExecutionOrderEvent,
} from '@/lib/test-mode/execution-monitor';

type Store = typeof import('@/lib/execution-log-store');

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
  // A beat with nothing triggered is dropped as idle by the monitor dedupe,
  // so every fixture beat has triggered at least once.
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

describe('execution log store — per-desk visibility', () => {
  let store: Store;
  beforeEach(async () => {
    // The ring buffer is module state; a fresh module per case keeps one
    // case's events out of the next.
    vi.resetModules();
    store = await import('@/lib/execution-log-store');
  });

  it('shows a desk its own order events and never another desk\'s', () => {
    store.appendExecutionLogs([
      { ownerEmail: 'alice@example.com', event: orderEvent('alice-1', 100) },
      { ownerEmail: 'bob@example.com', event: orderEvent('bob-1', 200) },
    ]);
    const alice = store.listExecutionLogs('alice@example.com');
    expect(alice.map(e => e.kind === 'order' ? e.orderId : e.kind)).toEqual(['alice-1']);
    const bob = store.listExecutionLogs('bob@example.com');
    expect(bob.map(e => e.kind === 'order' ? e.orderId : e.kind)).toEqual(['bob-1']);
  });

  it('shows a process beat with no owner to every desk', () => {
    store.appendExecutionLogs([{ ownerEmail: null, event: beatEvent(100) }]);
    expect(store.listExecutionLogs('alice@example.com')).toHaveLength(1);
    expect(store.listExecutionLogs('bob@example.com')).toHaveLength(1);
  });

  it('shows a beat one desk posted only to that desk', () => {
    store.appendExecutionLogs([
      { ownerEmail: 'alice@example.com', event: beatEvent(100) },
    ]);
    expect(store.listExecutionLogs('alice@example.com')).toHaveLength(1);
    expect(store.listExecutionLogs('bob@example.com')).toEqual([]);
  });

  it('shows an order event with no known owner to nobody', () => {
    store.appendExecutionLogs([{ ownerEmail: null, event: orderEvent('orphan-1', 100) }]);
    expect(store.listExecutionLogs('alice@example.com')).toEqual([]);
    expect(store.listExecutionLogs('bob@example.com')).toEqual([]);
  });

  it('matches the viewer to the owner regardless of case or surrounding space', () => {
    store.appendExecutionLogs([
      {
        ownerEmail: store.normalizeOwnerEmail('Alice@Example.com'),
        event: orderEvent('alice-1', 100),
      },
    ]);
    expect(store.listExecutionLogs('  ALICE@example.COM ')).toHaveLength(1);
  });

  it('fills the limit with the viewer\'s own events, newest first, however many other desks wrote after them', () => {
    store.appendExecutionLogs([
      { ownerEmail: 'alice@example.com', event: orderEvent('alice-1', 100) },
      { ownerEmail: 'alice@example.com', event: orderEvent('alice-2', 200) },
      { ownerEmail: 'alice@example.com', event: orderEvent('alice-3', 300) },
      ...[1, 2, 3, 4, 5].map(i => ({
        ownerEmail: 'bob@example.com',
        event: orderEvent(`bob-${i}`, 400 + i),
      })),
    ]);
    const alice = store.listExecutionLogs('alice@example.com', 2);
    expect(alice.map(e => e.kind === 'order' ? e.orderId : e.kind)).toEqual([
      'alice-3',
      'alice-2',
    ]);
  });
});
