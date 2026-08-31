import { describe, expect, it } from 'vitest';
import {
  depositsFromForwardCurves,
  impliedVolFromSurface,
  swapPointsFromCip,
  tenorToMonths,
} from '@/lib/refinitiv-to-market';

describe('refinitiv-to-market', () => {
  it('maps IPA tenors to months', () => {
    expect(tenorToMonths('1M')).toBe(1);
    expect(tenorToMonths('1Y')).toBe(12);
    expect(tenorToMonths('1W')).toBe(0.25);
  });

  it('builds CIP points for EURUSD from deposit rates', () => {
    const pts = swapPointsFromCip({
      ccy: 'EUR',
      spotMid: 1.17,
      rFcyPct: 2,
      rUsdPct: 4,
      months: 12,
    });
    expect(pts).toBeDefined();
    expect(pts!.bid).toBeGreaterThan(0);
  });

  it('fills FCY + USD deposit rows from two IPA curves', () => {
    const rows = depositsFromForwardCurves(
      [
        {
          forwardCurveTag: 'EURFwd',
          currency: 'EUR',
          indexName: 'EURIBOR',
          indexTenor: '3M',
          errorMessage: '',
          points: [
            { tenor: '1M', startDate: '', endDate: '', ratePercent: 2.1, discountFactor: null },
            { tenor: '1Y', startDate: '', endDate: '', ratePercent: 2.4, discountFactor: null },
          ],
        },
        {
          forwardCurveTag: 'USDFwd',
          currency: 'USD',
          indexName: 'SOFR',
          indexTenor: '3M',
          errorMessage: '',
          points: [
            { tenor: '1M', startDate: '', endDate: '', ratePercent: 4.1, discountFactor: null },
            { tenor: '1Y', startDate: '', endDate: '', ratePercent: 3.8, discountFactor: null },
          ],
        },
      ],
      'EUR',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tenor).toBe('1M');
    expect(rows[0]!.eur.creditPct).toBe(2.1);
    expect(rows[0]!.usd.creditPct).toBe(4.1);
    expect(rows[1]!.tenor).toBe('1Y');
  });

  it('reads the ATM row of a Date × Strike vol matrix', () => {
    const rec = impliedVolFromSurface({
      surfaceTag: 'FxVol-EURUSD',
      fxCrossCode: 'EURUSD',
      xLabels: ['1M', '3M', '1Y'],
      yLabels: ['25D', 'ATM', '25D C'],
      values: [
        [0.08, 0.09, 0.1],
        [0.061, 0.063, 0.07],
        [0.07, 0.08, 0.09],
      ],
      errorMessage: '',
    });
    expect(rec['1']).toBeCloseTo(0.061);
    expect(rec['3']).toBeCloseTo(0.063);
    expect(rec['12']).toBeCloseTo(0.07);
  });
});
