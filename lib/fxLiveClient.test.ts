import { describe, expect, it } from 'vitest';
import { marketPairLegs, quoteFromLiveSpot } from '@/lib/fxLiveClient';

describe('marketPairLegs', () => {
  it('splits market pairs into base/quote for exchangerate.dev', () => {
    expect(marketPairLegs('EURUSD')).toEqual({ base: 'EUR', quote: 'USD' });
    expect(marketPairLegs('GBP/USD')).toEqual({ base: 'GBP', quote: 'USD' });
    expect(marketPairLegs('USDMXN')).toEqual({ base: 'USD', quote: 'MXN' });
    expect(marketPairLegs('USDJPY')).toEqual({ base: 'USD', quote: 'JPY' });
  });
});

describe('quoteFromLiveSpot', () => {
  it('maps an overlay mid onto the /api/fx-spot bid/ask contract', () => {
    const q = quoteFromLiveSpot(
      {
        spot: 1.35126,
        base: 'GBP',
        quote: 'USD',
        asOfDate: '2026-09-04',
        asOfTime: '2026-09-04T18:16:22.000Z',
        source: 'exchangerate-dev',
      },
      { ccy: 'GBP', pair: 'GBPUSD' },
    );
    expect(q.pair).toBe('GBPUSD');
    expect(q.ric).toBe('GBP=');
    expect(q.mid).toBeCloseTo(1.35126);
    expect(q.bid).toBeLessThan(q.mid);
    expect(q.ask).toBeGreaterThan(q.mid);
    expect(q.source).toBe('exchangerate-dev');
  });
});