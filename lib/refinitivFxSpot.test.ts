import { describe, expect, it } from 'vitest';
import {
  fxSpotRicForCcy,
  parseFxSpotPrice,
  parseFxSpotRequest,
} from '@/lib/refinitivFxSpot';

describe('fxSpotRicForCcy', () => {
  it('maps book CCY and pairs onto the USD spot RIC', () => {
    expect(fxSpotRicForCcy('EUR')).toBe('EUR=');
    expect(fxSpotRicForCcy('EURUSD')).toBe('EUR=');
    expect(fxSpotRicForCcy('PLN')).toBe('PLN=');
    expect(fxSpotRicForCcy('USDPLN')).toBe('PLN=');
    expect(fxSpotRicForCcy('JPY=')).toBe('JPY=');
  });
});

describe('parseFxSpotRequest', () => {
  it('prefers an explicit RIC', () => {
    expect(parseFxSpotRequest({ ric: 'GBP=', ccy: 'EUR' }).ric).toBe('GBP=');
  });
});

describe('parseFxSpotPrice', () => {
  it('reads the mobile fx-service bid/ask envelope', () => {
    const q = parseFxSpotPrice(
      { bid: 1.16113, ask: 1.16114, mid: 1.161135, timestamp: '2026-09-01T00:00:00Z' },
      'EUR=',
      'EURUSD',
      'fx-service',
    );
    expect(q.bid).toBeCloseTo(1.16113);
    expect(q.ask).toBeCloseTo(1.16114);
    expect(q.source).toBe('fx-service');
  });

  it('reads an RDP pricing snapshot', () => {
    const q = parseFxSpotPrice(
      {
        universe: [
          {
            ric: 'EUR=',
            fields: { BID: 1.16, ASK: 1.161, MID_PRICE: 1.1605 },
          },
        ],
      },
      'EUR=',
      'EURUSD',
      'pricing-snapshot',
    );
    expect(q.bid).toBeCloseTo(1.16);
    expect(q.ask).toBeCloseTo(1.161);
    expect(q.mid).toBeCloseTo(1.1605);
    expect(q.source).toBe('pricing-snapshot');
  });

  it('fills a missing ask from mid', () => {
    const q = parseFxSpotPrice({ Bid: 155.2, Mid: 155.21 }, 'JPY=', 'USDJPY', 'fx-service');
    expect(q.ask).toBeGreaterThanOrEqual(q.bid);
  });
});
