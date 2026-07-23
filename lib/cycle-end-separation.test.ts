/**
 * Column semantics:
 *   Target  = opening NP + swap   (cash target the swap funds to; = NP+Swap)
 *   Swap    = cushion H* − trough
 *   NP+Swap = opening NP + swap   (funded NP position after swap, before payout)
 *   Cycle End = NP+Swap − payout + payins + fcast + Non-NP sweep back
 */
import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, INITIAL_USD_PARAMS } from './fx-buffer';
import { computeDashboardModel } from './dashboard-model';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3 };
const ACTIVE = new Set(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'] as const);

function model(overrides: {
  payout?: Record<string, number>;
  collections?: Record<string, number>;
  fcast?: Record<string, number>;
} = {}) {
  return computeDashboardModel({
    rows: INITIAL_ROWS.map(r => ({
      ...r,
      payout: overrides.payout?.[r.ccy] ?? r.payout,
      collections: overrides.collections?.[r.ccy] ?? r.collections,
      fcastFX: overrides.fcast?.[r.ccy] ?? r.fcastFX,
    })),
    usdCash: 303.9,
    usdNonNpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: SHARED,
    activeLayers: ACTIVE,
    policyVAR: 5.0,
  });
}

describe('column separation: Target / Swap / NP+Swap / Cycle End', () => {
  it('Target = NP+Swap = opening + swap; cushion = Target − |payout|', () => {
    const m = model({ payout: { CAD: -100 } });
    const cad = m.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(cad.cash_threshold).toBeCloseTo(cad.cash + cad.swapNear, 6);
    expect(cad.postSwapCash).toBeCloseTo(cad.cash + cad.swapNear, 6);
    expect(cad.cash_threshold).toBeCloseTo(cad.postSwapCash, 6);
    // Post-payout cushion = Target + payout (payout leaves after the swap funds the target)
    expect(cad.np_after_swap_trough).toBeCloseTo(cad.cash_threshold + cad.payout, 4);
  });

  it('fcast does not move near swap or Target; moves Cycle End 1:1', () => {
    const m0 = model({ payout: { CAD: -100 } });
    const mF = model({ payout: { CAD: -100 }, fcast: { CAD: -15 } });
    const c0 = m0.fcyComputed.find(r => r.ccy === 'CAD')!;
    const cF = mF.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(cF.swapNear).toBeCloseTo(c0.swapNear, 4);
    expect(cF.cash_threshold).toBeCloseTo(c0.cash_threshold, 4);
    expect(cF.cycleEndCash - c0.cycleEndCash).toBeCloseTo(-15, 4);
  });

  it('payins move Cycle End 1:1, not Target or NP+Swap', () => {
    const m0 = model({ collections: { CAD: 0 } });
    const mPayin = model({ collections: { CAD: 50 } });
    const c0 = m0.fcyComputed.find(r => r.ccy === 'CAD')!;
    const c1 = mPayin.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(c1.cash_threshold).toBeCloseTo(c0.cash_threshold, 4);
    expect(c1.postSwapCash).toBeCloseTo(c0.postSwapCash, 4);
    expect(c1.cycleEndCash - c0.cycleEndCash).toBeCloseTo(50, 4);
    expect(c1.cycleEndCash).toBeCloseTo(
      c1.postSwapCash + c1.payout + 50 + c1.fcastFX + c1.nonNpCash, 4);
  });

  it('payout raises Target = NP+Swap by the trough gap + σ; Cycle End near-stable', () => {
    const m0 = model({ payout: { CAD: 0 } });
    const m150 = model({ payout: { CAD: -150 } });
    const c0 = m0.fcyComputed.find(r => r.ccy === 'CAD')!;
    const c150 = m150.fcyComputed.find(r => r.ccy === 'CAD')!;
    // Hold-the-book: own cash (95.1) funds the payout first; the swap buys the
    // trough gap (150 − 95.1 = 54.9) + σ cushion — Target rises by ≥ that gap.
    expect(c150.postSwapCash - c0.postSwapCash).toBeGreaterThan(54.9);
    expect(c150.cash_threshold - c0.cash_threshold).toBeGreaterThan(54.9);
    expect(c150.swapNear).toBeGreaterThan(c0.swapNear);
    // Post-payout residual = the H* cushion that sized the swap (σ + carry overlay)
    expect(c150.postSwapCash + c150.payout)
      .toBeCloseTo(c150.cash_threshold_pre_swap!, 1);
  });

  it('with payout + payin + fcast, Cycle End is distinct from Target/NP+Swap', () => {
    const m = model({ payout: { CAD: -150 }, collections: { CAD: 40 }, fcast: { CAD: -10 } });
    const cad = m.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(cad.cycleEndCash).toBeCloseTo(
      cad.postSwapCash + cad.payout + 40 - 10 + cad.nonNpCash, 4);
    // Target = NP+Swap (both funded to opening + swap)
    expect(cad.cash_threshold).toBeCloseTo(cad.postSwapCash, 4);
    // Cycle End differs from the funded target (payout has left, payins/fcast/sweep applied)
    expect(cad.cycleEndCash).not.toBeCloseTo(cad.cash_threshold, 0);
  });
});
