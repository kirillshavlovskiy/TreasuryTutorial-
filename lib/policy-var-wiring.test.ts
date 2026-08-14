import { describe, it, expect } from 'vitest';
import { computeDashboardModel } from './dashboard-model';
import { INITIAL_ROWS, INITIAL_USD_PARAMS } from './fx-buffer';

const base = {
  rows: INITIAL_ROWS,
  usdCash: 303.9,
  usdNonLpCash: 154.1,
  usdParams: INITIAL_USD_PARAMS,
  shared: { r_USD: 3.50, σ_P: 0.10, days: 3 },
  activeLayers: new Set(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'] as const),
};

describe('Policy VAR wiring', () => {
  it('changing policyVAR scales targets and portfolio VAR display', () => {
    const m5 = computeDashboardModel({ ...base, policyVAR: 5 });
    const m10 = computeDashboardModel({ ...base, policyVAR: 10 });
    const m20 = computeDashboardModel({ ...base, policyVAR: 20 });

    expect(m5.portfolioSummary!.policyVAR).toBe(5);
    expect(m10.portfolioSummary!.policyVAR).toBe(10);
    expect(m20.portfolioSummary!.policyVAR).toBe(20);

    const ps5 = m5.portfolioSummary!;
    const ps10 = m10.portfolioSummary!;
    const ps20 = m20.portfolioSummary!;

    // Tight limit trims to ≤ policy; looser limits allow higher VAR
    expect(ps5.portfolio_VAR_USD).toBeLessThanOrEqual(5.05);
    expect(ps10.portfolio_VAR_USD).toBeLessThanOrEqual(10.01);
    expect(ps20.portfolio_VAR_USD).toBeLessThanOrEqual(20.01);

    expect(ps5.portfolio_VAR_USD).toBeLessThan(ps20.portfolio_VAR_USD);
    // Each step up in the limit must produce a visible recalculation
    expect(ps10.portfolio_VAR_USD).toBeLessThan(ps20.portfolio_VAR_USD);

    const gbp5 = m5.fcyComputed.find(r => r.ccy === 'GBP')!;
    const gbp10 = m10.fcyComputed.find(r => r.ccy === 'GBP')!;
    const gbp20 = m20.fcyComputed.find(r => r.ccy === 'GBP')!;
    expect(gbp20.cash_threshold_pre_swap).toBeGreaterThan(gbp5.cash_threshold_pre_swap);
    expect(gbp20.cash_threshold_pre_swap).toBeGreaterThan(gbp10.cash_threshold_pre_swap);

    expect(ps5.var_binding || ps5.var_trim).toBe(true);
    // Fill semantics: at 20M the carry overlay fills the budget → VAR binding by design
    expect(ps20.var_binding).toBe(true);
    expect(ps20.portfolio_VAR_USD).toBeCloseTo(20, 1);
  });
});
