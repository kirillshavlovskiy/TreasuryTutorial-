import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, INITIAL_USD_PARAMS, fcyToUsdM } from './fx-buffer';
import { computeDashboardModel } from './dashboard-model';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3 };
const ACTIVE = new Set(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'] as const);

describe('AED/ILS Target NP Cash USD', () => {
  const model = computeDashboardModel({
    rows: INITIAL_ROWS,
    usdCash: 303.9,
    usdNonNpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: SHARED,
    activeLayers: ACTIVE,
    policyVAR: 5.0,
  });

  it('computes cashThresholdUSD for AED and ILS (not hidden zero)', () => {
    for (const ccy of ['AED', 'ILS'] as const) {
      const r = model.fcyComputed.find(x => x.ccy === ccy)!;
      expect(r.cashThresholdUSD).toBeCloseTo(fcyToUsdM(r.postSwapCash, ccy), 6);
      expect(Number.isFinite(r.cashThresholdUSD)).toBe(true);
    }
  });

  it('AED/ILS expensive-OD: zero payout → Target equals NP+Swap (raw may be negative)', () => {
    const aed = model.fcyComputed.find(x => x.ccy === 'AED')!;
    const ils = model.fcyComputed.find(x => x.ccy === 'ILS')!;
    // payout = 0 on these rows → opening + swap = trough + swap
    expect(aed.cash_threshold).toBeCloseTo(aed.postSwapCash, 4);
    expect(ils.cash_threshold).toBeCloseTo(ils.postSwapCash, 4);
    expect(aed.postSwapCash).toBeCloseTo(aed.np_after_swap_trough!, 4);
    expect(aed.np_after_swap_trough).toBeCloseTo(aed.np_peak_cash + aed.swapNear, 4);
    expect(aed.cashThresholdUSD).toBeCloseTo(fcyToUsdM(aed.cash_threshold, 'AED'), 4);
    expect(ils.cashThresholdUSD).toBeCloseTo(fcyToUsdM(ils.cash_threshold, 'ILS'), 4);
    if (ils.debit_floor_binding) {
      expect(ils.cash_threshold_raw).toBeLessThan(0);
    }
  });

  it('pre-swap H* preserved separately from wired target', () => {
    const aed = model.fcyComputed.find(x => x.ccy === 'AED')!;
    expect(aed.cash_threshold).toBeCloseTo(aed.np_peak_cash + aed.swapNear, 4);
    expect(aed.cashThresholdUSD).toBeCloseTo(fcyToUsdM(aed.postSwapCash, 'AED'), 4);
    expect(aed.cash_threshold_pre_swap).toBeDefined();
  });
});
