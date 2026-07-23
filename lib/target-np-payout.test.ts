import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, INITIAL_USD_PARAMS, Z_NEUTRAL } from './fx-buffer';
import { computeDashboardModel } from './dashboard-model';

describe('Target NP Cash with payout (sigma + floor only)', () => {
  const base = {
    rows: INITIAL_ROWS.map(r => r.ccy === 'CAD' ? { ...r, payout: -100 } : r),
    usdCash: 303.9,
    usdNonNpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: { r_USD: 3.50, σ_P: 0.10, days: 3 },
    activeLayers: new Set(['sigmaP', 'floorH'] as const),
    policyVAR: 5.0,
  };

  it('CAD −100M: Target = NP Cash + Swap; swap sized to the σ cushion', () => {
    const model = computeDashboardModel(base);
    const cad = model.fcyComputed.find(r => r.ccy === 'CAD')!;
    const sigma = 100 * base.shared.σ_P * Z_NEUTRAL; // 16.45
    // Internal cushion H* that sizes the swap = σ buffer
    expect(cad.cash_threshold_pre_swap).toBeCloseTo(sigma, 1);
    // Target = NP+Swap = opening NP + swap (funds the payout plus the cushion)
    expect(cad.cash_threshold).toBeCloseTo(cad.cash + cad.swapNear, 4);
    expect(cad.postSwapCash).toBeCloseTo(cad.cash + cad.swapNear, 4);
    expect(cad.cash_threshold).toBeCloseTo(cad.postSwapCash, 4);
    expect(cad.cash_threshold).toBeCloseTo(100 + sigma, 1);
  });

  it('Target = NP+Swap moves 1:1+σ with payout estimate', () => {
    const m100 = computeDashboardModel(base);
    const m200 = computeDashboardModel({
      ...base,
      rows: INITIAL_ROWS.map(r => r.ccy === 'CAD' ? { ...r, payout: -200 } : r),
    });
    const c100 = m100.fcyComputed.find(r => r.ccy === 'CAD')!;
    const c200 = m200.fcyComputed.find(r => r.ccy === 'CAD')!;
    const sigmaDelta = 100 * base.shared.σ_P * Z_NEUTRAL;
    // Target rises by the extra payout plus the extra σ cushion
    expect(c200.cash_threshold - c100.cash_threshold).toBeCloseTo(100 + sigmaDelta, 1);
    expect(c200.postSwapCash - c100.postSwapCash).toBeCloseTo(100 + sigmaDelta, 1);
  });

  it('Target moves when σ_P changes', () => {
    const low = computeDashboardModel(base);
    const high = computeDashboardModel({
      ...base,
      shared: { ...base.shared, σ_P: 0.20 },
    });
    const tLow = low.fcyComputed.find(r => r.ccy === 'CAD')!.cash_threshold;
    const tHigh = high.fcyComputed.find(r => r.ccy === 'CAD')!.cash_threshold;
    expect(tHigh - tLow).toBeCloseTo(100 * 0.10 * Z_NEUTRAL, 1);
  });
});
