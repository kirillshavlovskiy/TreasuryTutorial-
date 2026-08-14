import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, INITIAL_USD_PARAMS } from './fx-buffer';
import { computeDashboardModel } from './dashboard-model';

describe('payout flow neutrality', () => {
  const base = {
    rows: INITIAL_ROWS,
    usdCash: 303.9,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: { r_USD: 3.50, σ_P: 0.10, days: 3 },
    activeLayers: new Set(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'] as const),
    policyVAR: 5.0,
  };

  it('GBP full payout (trough=0): carry survives; LP+Swap ≈ |payout| + σ + carry', () => {
    const model = computeDashboardModel({
      ...base,
      rows: base.rows.map(r => r.ccy === 'GBP' ? { ...r, payout: -131.8 } : r),
    });
    const gbp = model.fcyComputed.find(r => r.ccy === 'GBP')!;
    expect(gbp.lp_peak_cash).toBeCloseTo(0, 1);
    // Cushion (H* at trough) is positive: σ on gross payout + EARN carry on opening stock
    expect(gbp.cash_threshold_pre_swap).toBeGreaterThan(0);
    expect(gbp.swapNear).toBeGreaterThan(0);
    // LP+Swap (funded position before payout) exceeds the payout it must cover
    expect(gbp.postSwapCash).toBeGreaterThan(131.8);
    expect(gbp.postSwapCash).toBeCloseTo(gbp.cash + gbp.swapNear, 4);
    // Cycle End = LP+Swap − payout + payins + fcast + Non-LP sweep
    expect(gbp.cycleEndCash).toBeCloseTo(
      gbp.postSwapCash + gbp.payout + gbp.collections + gbp.fcastFX + gbp.nonLpCash, 4);
  });

  it('CAD −500M (ample USD): LP+Swap rises ≈ payout + σ; swap buys the gap; Cycle End near-stable', () => {
    // usdCash raised so the USD funding stress trim does not bind — isolates the formula
    const ample = { ...base, usdCash: 900 };
    const m0 = computeDashboardModel({
      ...ample,
      rows: base.rows.map(r => r.ccy === 'CAD' ? { ...r, payout: 0 } : r),
    });
    const m500 = computeDashboardModel({
      ...ample,
      rows: base.rows.map(r => r.ccy === 'CAD' ? { ...r, payout: -500 } : r),
    });
    const cad0 = m0.fcyComputed.find(r => r.ccy === 'CAD')!;
    const cad500 = m500.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(cad500.postSwapCash - cad0.postSwapCash).toBeGreaterThan(450);
    expect(cad500.swapNear).toBeGreaterThan(cad0.swapNear);
    expect(Math.abs(cad500.swapNear - cad0.swapNear)).toBeGreaterThan(450);
    // Cycle End = cushion + flows — payout is funded by the swap; only σ/carry deltas move it
    expect(Math.abs(cad500.cycleEndCash - cad0.cycleEndCash)).toBeLessThan(150);
  });

  it('CAD −500M under USD funding stress: Target still rises; funding bind flagged', () => {
    const m500 = computeDashboardModel({
      ...base,
      rows: base.rows.map(r => r.ccy === 'CAD' ? { ...r, payout: -500 } : r),
    });
    const m0 = computeDashboardModel({
      ...base,
      rows: base.rows.map(r => r.ccy === 'CAD' ? { ...r, payout: 0 } : r),
    });
    const cad0 = m0.fcyComputed.find(r => r.ccy === 'CAD')!;
    const cad500 = m500.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(cad500.cash_threshold).toBeGreaterThan(cad0.cash_threshold);
    expect(cad500.swapNear).toBeGreaterThan(cad0.swapNear);
  });
});
