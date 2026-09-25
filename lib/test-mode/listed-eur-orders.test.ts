import { describe, expect, it } from 'vitest';
import {
  isListedEurGhostTicket,
  stripListedEurFromHedgeBooks,
} from './listed-eur-orders';

describe('isListedEurGhostTicket', () => {
  it('matches the EUR strip legs, option, and TP/SL notionals', () => {
    expect(
      isListedEurGhostTicket({
        ccy: 'EUR',
        instrument: 'forward',
        amountLocalM: 6.99,
        stripId: 's1',
      }),
    ).toBe(true);
    expect(
      isListedEurGhostTicket({
        ccy: 'EUR',
        instrument: 'option',
        amountLocalM: -12.1,
      }),
    ).toBe(true);
    expect(
      isListedEurGhostTicket({
        ccy: 'EUR',
        instrument: 'forward',
        amountLocalM: 14.65,
        limitRate: 1.1575,
        status: 'scheduled',
      }),
    ).toBe(true);
    expect(
      isListedEurGhostTicket({
        ccy: 'GBP',
        instrument: 'forward',
        amountLocalM: 14.65,
      }),
    ).toBe(false);
  });
});

describe('stripListedEurFromHedgeBooks', () => {
  it('keeps unrelated tickets', () => {
    const { hedges, removedCount } = stripListedEurFromHedgeBooks({
      g: {
        bookedHedges: [
          { id: 'keep', ccy: 'JPY', instrument: 'forward', amountLocalM: -900 },
          { id: 'drop', ccy: 'EUR', instrument: 'option', amountLocalM: -12.1 },
        ] as never,
        hedgeRatios: {},
      },
    });
    expect(removedCount).toBe(1);
    expect(hedges.g?.bookedHedges.map(t => t.id)).toEqual(['keep']);
  });
});
