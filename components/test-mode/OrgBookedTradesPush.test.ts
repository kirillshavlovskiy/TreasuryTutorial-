import { describe, expect, it } from 'vitest';
import {
  buildNotices,
  mergeNotificationTickets,
  noticeEventMs,
  withToastsAdded,
} from '@/components/test-mode/OrgBookedTradesPush';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';

const HOUR_MS = 3600_000;

function stubTicket(extras: Partial<HedgeTicket> = {}): HedgeTicket {
  return {
    id: 'ht-1',
    ccy: 'EUR',
    instrument: 'forward',
    basis: 'stock',
    amountLocalM: 1,
    maturity: null,
    maturityLabel: null,
    varUsdM: 0,
    addressesHigherVar: false,
    ...extras,
  };
}

function stripLegs(stripId: string, extras: Partial<HedgeTicket>): HedgeTicket[] {
  return [0, 1, 2].map(edge =>
    stubTicket({
      id: `${stripId}-m${edge + 1}`,
      stripId,
      stripEdgeIndex: edge,
      ...extras,
    }),
  );
}

function savedHistory(tickets: HedgeTicket[], arrivedAtMs: number) {
  return {
    tickets,
    cancelled: [],
    readIds: tickets.map(t => t.id),
    arrivedAt: Object.fromEntries(tickets.map(t => [t.id, arrivedAtMs])),
  };
}

describe('OrgBookedTradesPush — a freshly left strip of working orders', () => {
  const nowMs = Date.now();
  // An earlier EUR strip that filled and has since left the book, still
  // inside the bell's 12h history — on the same edges as the new strip.
  const earlierStrip = stripLegs('strip-earlier', {
    status: 'booked',
    filledAtMs: nowMs - HOUR_MS,
  });
  const saved = savedHistory(earlierStrip, nowMs - HOUR_MS);
  const newStrip = stripLegs('strip-new', { status: 'scheduled', limitRate: 1.163 });

  it('keeps every leg of the new strip beside the earlier strip', () => {
    const merged = mergeNotificationTickets(saved, newStrip);
    expect(merged.filter(t => t.stripId === 'strip-new').map(t => t.id)).toEqual(
      newStrip.map(t => t.id),
    );
    expect(merged.filter(t => t.stripId === 'strip-earlier')).toHaveLength(3);
  });

  it('is its own WORKING notice and outranks the earlier strip before its arrival is stamped', () => {
    const notices = buildNotices(mergeNotificationTickets(saved, newStrip), nowMs);
    const fresh = notices.find(n => n.id === 'strip:strip-new');
    const earlier = notices.find(n => n.id === 'strip:strip-earlier');
    expect(fresh?.kind).toBe('working');
    expect(fresh?.legs.map(l => l.state)).toEqual(['WORKING', 'WORKING', 'WORKING']);
    expect(earlier?.kind).toBe('fill');
    // Only the earlier strip's arrivals are recorded yet: the new strip is
    // arriving in this render, and the stamping effect runs after commit.
    const arrivedAt = new Map(Object.entries(saved.arrivedAt));
    expect(noticeEventMs(fresh!, arrivedAt, nowMs)).toBe(nowMs);
    expect(noticeEventMs(earlier!, arrivedAt, nowMs)).toBe(nowMs - HOUR_MS);
  });
});

describe('mergeNotificationTickets — working orders', () => {
  it('does not replay a saved working order that has left the book', () => {
    const left = stubTicket({ id: 'ht-left', status: 'scheduled', limitRate: 1.16 });
    const merged = mergeNotificationTickets(savedHistory([left], Date.now() - 60_000), []);
    expect(merged).toEqual([]);
  });

  it('keeps a working order that is still on the book', () => {
    const resting = stubTicket({ id: 'ht-rest', status: 'scheduled', limitRate: 1.16 });
    const merged = mergeNotificationTickets(
      savedHistory([resting], Date.now() - 60_000),
      [resting],
    );
    expect(merged.map(t => t.id)).toEqual(['ht-rest']);
  });
});

describe('noticeEventMs', () => {
  it('moves a working order that fills later to its fill time', () => {
    const nowMs = Date.now();
    const filled = stubTicket({ id: 'ht-f', status: 'booked', filledAtMs: nowMs - 60_000 });
    const [notice] = buildNotices([filled], nowMs);
    // Stamped when it was left as an order, two hours before it filled.
    const arrivedAt = new Map([['ht-f', nowMs - 2 * HOUR_MS]]);
    expect(noticeEventMs(notice!, arrivedAt, nowMs)).toBe(nowMs - 60_000);
  });

  it('keeps a restored legacy stamp (0) ancient instead of treating it as new', () => {
    const nowMs = Date.now();
    const cancelled = stubTicket({ id: 'ht-c:cancelled', status: 'cancelled' });
    const [notice] = buildNotices([cancelled], nowMs);
    expect(noticeEventMs(notice!, new Map([['ht-c:cancelled', 0]]), nowMs)).toBe(0);
  });
});

type Banner = Parameters<typeof withToastsAdded>[0][number];

function banner(key: string, leaving = false): Banner {
  return { key, noticeId: key, kind: 'fill', glyph: 'fill', title: key, body: '', time: '', leaving };
}

function keysAndLeaving(banners: readonly Banner[]): [string, boolean][] {
  return banners.map(t => [t.key, Boolean(t.leaving)]);
}

describe('withToastsAdded', () => {
  it('puts a new banner first and keeps the rest in order', () => {
    const out = withToastsAdded([banner('a'), banner('b')], [banner('c')]);
    expect(out.map(t => t.key)).toEqual(['c', 'a', 'b']);
  });

  it('replaces a banner raised again under the same key, even one that is leaving', () => {
    const out = withToastsAdded([banner('a'), banner('b', true)], [banner('b')]);
    expect(keysAndLeaving(out)).toEqual([['b', false], ['a', false]]);
  });

  it('lets the oldest banner past the limit play its exit instead of vanishing', () => {
    const out = withToastsAdded([banner('a'), banner('b'), banner('c')], [banner('d')]);
    expect(keysAndLeaving(out)).toEqual([
      ['d', false],
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
  });

  it('does not count banners that are already leaving toward the limit', () => {
    const out = withToastsAdded([banner('a'), banner('b', true), banner('c')], [banner('d')]);
    expect(out.filter(t => !t.leaving).map(t => t.key)).toEqual(['d', 'a', 'c']);
  });
});
