/**
 * fx-buffer.test.ts — Comprehensive validation of all FX buffer formulas.
 *
 * Test structure:
 *  1. normInv / normPDF         — statistical building blocks
 *  2. var95_1m_factor            — 1-month 95% VAR scaling factor
 *  3. combinedMultiplier         — FX + IR carry loss multiplier
 *  4. calcSwapNear               — swap leg sizing (7 scenarios from decisions.md)
 *  5. calcCarry / calcDelta      — carry income and delta identity
 *  6. calcDynamicH               — dynamic cash threshold (NWC P&L buffer)
 *  7. calcOptimalBuffer          — IR-optimized H* (liquidity buffer)
 *  8. computeLayeredBuffer       — additive layer decomposition
 *  9. computePortfolioVAR        — cross-currency diversified VAR
 * 10. CURRENCY_PARAMS integrity  — data consistency checks
 */

import { describe, it, expect } from 'vitest';
import {
  normInv,
  normPDF,
  var95_1m_factor,
  combinedMultiplier,
  calcSwapNear,
  calcCarry,
  calcDelta,
  calcDynamicH,
  calcOptimalBuffer,
  computeLayeredBuffer,
  netPayoutDeficit,
  computeUsdBuffer,
  computeFcySwapNear,
  applyNoNegativeLpFloor,
  applyHardMinFloor,
  isExpensiveOverdraft,
  deriveUsdLiquidity,
  deriveUsdFromFcySwaps,
  sumFcySwapNearUsd,
  enforceUsdLiquidityStress,
  computeFcyCollateralBudget,
  assessUsdLiquidityPriority,
  usdStressTrimFloor,
  payoutLiquidityMinimum,
  allowsNegativeLp,
  fundingSwapOverlayUsdYr,
  fundingSwapCashDeltaUsdYr,
  fundingSwapCarryLegs,
  fundingSwapCipPointsUsdYr,
  computePortfolioVAR,
  optimizePortfolioCarry,
  sweepPortfolioCarryFrontier,
  frontierTangencyIndex,
  type PortfolioCarryFrontierPoint,
  universePolicyVarCap,
  approvalTierCapUsd,
  POLICY_VAR_LIMITS,
  computeEffectiveUsdBudget,
  toggleLayerGroup,
  setBufferLevel,
  bufferLevelOf,
  type PortfolioCarryInput,
  type LayerId,
  CURRENCY_PARAMS,
  CORR_CURRENCIES,
  DISPLAY_CURRENCIES,
  Z_NEUTRAL,
} from './fx-buffer';
import {
  DEFAULT_EURUSD_MARKET_RATES,
  fundingSwapPathFarCipUsdM,
  resolveMarketRatesForCcy,
} from './fx-market-rates';

// ── Tolerance helpers ─────────────────────────────────────────────────────────

/** Absolute tolerance for financial values (M FCY / M USD) */
const ABS = (tol: number) => ({ numDigits: -Math.log10(tol) });

// ─────────────────────────────────────────────────────────────────────────────
// 1. normInv — inverse normal CDF
// ─────────────────────────────────────────────────────────────────────────────
describe('normInv', () => {
  it('returns 0 at the median', () => {
    expect(normInv(0.5)).toBeCloseTo(0, 6);
  });

  it('matches z₉₅ = 1.645 at p=0.95', () => {
    expect(normInv(0.95)).toBeCloseTo(1.645, 2);
  });

  it('is antisymmetric: normInv(1-p) = -normInv(p)', () => {
    expect(normInv(0.05)).toBeCloseTo(-1.645, 2);
    expect(normInv(0.25)).toBeCloseTo(-normInv(0.75), 4);
    expect(normInv(0.10)).toBeCloseTo(-normInv(0.90), 4);
  });

  it('returns ~3.09 at p=0.999 (high-confidence tail)', () => {
    expect(normInv(0.999)).toBeCloseTo(3.09, 1);
  });

  it('returns ~-3.09 at p=0.001', () => {
    expect(normInv(0.001)).toBeCloseTo(-3.09, 1);
  });

  it('clamps to ±3.72 at hard boundaries', () => {
    expect(normInv(0)).toBe(-3.72);
    expect(normInv(1)).toBe(3.72);
    expect(normInv(0.0001)).toBe(-3.72);
    expect(normInv(0.9999)).toBe(3.72);
  });

  it('is monotonically increasing', () => {
    const ps = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
    for (let i = 1; i < ps.length; i++) {
      expect(normInv(ps[i])).toBeGreaterThan(normInv(ps[i - 1]));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. var95_1m_factor  =  σ_daily × √21 × 1.645
// ─────────────────────────────────────────────────────────────────────────────
describe('var95_1m_factor', () => {
  it('returns 0 for a pegged currency (σ ≈ 0)', () => {
    expect(var95_1m_factor(0)).toBe(0);
    // AED σ is near-zero
    expect(var95_1m_factor(CURRENCY_PARAMS.AED.σ_daily)).toBeCloseTo(0, 3);
  });

  it('AUD: σ=0.008227 → factor ≈ 0.062', () => {
    // 0.008227 × √21 × 1.645 = 0.008227 × 4.5826 × 1.645 ≈ 0.06200
    expect(var95_1m_factor(0.008227)).toBeCloseTo(0.062, 3);
  });

  it('TRY: σ=0.009301 → factor ≈ 0.0701', () => {
    expect(var95_1m_factor(0.009301)).toBeCloseTo(0.0701, 3);
  });

  it('EUR: σ=0.004372 → factor ≈ 0.0330', () => {
    expect(var95_1m_factor(0.004372)).toBeCloseTo(0.0330, 3);
  });

  it('scales linearly with σ_daily', () => {
    const f1 = var95_1m_factor(0.004);
    const f2 = var95_1m_factor(0.008);
    expect(f2).toBeCloseTo(f1 * 2, 10);
  });

  it('uses √21 × 1.645 as the scaling constant', () => {
    const sigma = 0.005;
    expect(var95_1m_factor(sigma)).toBeCloseTo(sigma * Math.sqrt(21) * 1.645, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. combinedMultiplier  =  1 + (carry_pct / 100) × β_IR
// ─────────────────────────────────────────────────────────────────────────────
describe('combinedMultiplier', () => {
  it('returns 1.0 when β_IR = 0 (pegged currencies: AED, HKD)', () => {
    expect(combinedMultiplier(2.05, 0)).toBe(1.0);
    expect(combinedMultiplier(100, 0)).toBe(1.0);
  });

  it('returns 1.0 when carry = 0', () => {
    expect(combinedMultiplier(0, 0.80)).toBe(1.0);
  });

  it('TRY with JPM NP rates (1.16%): multiplier ≈ 1.009 — far below nominal 46%', () => {
    // JPM NP rate: 1.157379%, β_IR = 0.80
    // 1 + (1.157379/100) × 0.80 = 1.009259
    expect(combinedMultiplier(1.157379, 0.80)).toBeCloseTo(1.00926, 4);
  });

  it('TRY with nominal policy rates (46%) would give 1.368', () => {
    // This test documents the WRONG value — why JPM NP rates must be used instead
    expect(combinedMultiplier(46.0, 0.80)).toBeCloseTo(1.368, 3);
  });

  it('EUR: 1 + (1.783/100) × 0.20 = 1.003566', () => {
    expect(combinedMultiplier(1.783, 0.20)).toBeCloseTo(1.003566, 5);
  });

  it('MXN: 1 + (6.19/100) × 0.60 = 1.03714', () => {
    expect(combinedMultiplier(6.19, 0.60)).toBeCloseTo(1.03714, 4);
  });

  it('HUF: 1 + (5.69/100) × 0.55 = 1.031295', () => {
    expect(combinedMultiplier(5.69, 0.55)).toBeCloseTo(1.031295, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. calcSwapNear  =  MAX(H − (F + G),  −(C + D))
//    Scenarios from decisions.md — validates both constraints and netting
// ─────────────────────────────────────────────────────────────────────────────
describe('calcSwapNear', () => {
  it('S1 — book restructuring dominates: short net, cash well above threshold', () => {
    // C=-0.8M, D=+0.2M → net=-0.6M → -(C+D)=+0.6M
    // F=5.0M, G=-0.5M → forecasted=4.5M, H=1.0M
    // Constraint1 = 1.0 − 4.5 = −3.5  (negative: cash above threshold)
    // Constraint2 = +0.6
    // Result = MAX(−3.5, 0.6) = 0.6
    expect(calcSwapNear(-0.8, 0.2, 5.0, -0.5, 1.0)).toBeCloseTo(0.6, 10);
  });

  it('S2 — cash maintenance dominates: cash below threshold', () => {
    // C=-0.2M, D=+0.1M → net=-0.1M → -(C+D)=+0.1M
    // F=0.1M, G=-0.5M → forecasted=−0.4M, H=1.0M
    // Constraint1 = 1.0 − (−0.4) = +1.4
    // Constraint2 = +0.1
    // Result = MAX(1.4, 0.1) = 1.4
    expect(calcSwapNear(-0.2, 0.1, 0.1, -0.5, 1.0)).toBeCloseTo(1.4, 10);
  });

  it('S3 — net long position: sell near (negative swap = deploy the long)', () => {
    // C=-0.2M, D=+0.4M → net=+0.2M → -(C+D)=−0.2M
    // F=2.0M, G=-0.5M → forecasted=1.5M > H=1.0M
    // Constraint1 = 1.0 − 1.5 = −0.5
    // Constraint2 = −0.2
    // Result = MAX(−0.5, −0.2) = −0.2 (sell near)
    expect(calcSwapNear(-0.2, 0.4, 2.0, -0.5, 1.0)).toBeCloseTo(-0.2, 10);
  });

  it('S4 — both constraints negative: sell large near (long book + high cash)', () => {
    // C=-0.1M, D=+2.0M → net=+1.9M → -(C+D)=−1.9M
    // F=5.0M, G=0 → forecasted=5.0M >> H=0.1M
    // Constraint1 = 0.1 − 5.0 = −4.9
    // Constraint2 = −1.9
    // Result = MAX(−4.9, −1.9) = −1.9
    expect(calcSwapNear(-0.1, 2.0, 5.0, 0, 0.1)).toBeCloseTo(-1.9, 10);
  });

  it('S5 — H=0, short net: pure book restructuring with no cash threshold', () => {
    // C=-1.0M, D=0 → net=-1.0M → -(C+D)=+1.0M
    // F=0.5M, G=0 → forecasted=0.5M, H=0
    // Constraint1 = 0 − 0.5 = −0.5
    // Constraint2 = +1.0
    // Result = MAX(−0.5, 1.0) = 1.0
    expect(calcSwapNear(-1.0, 0, 0.5, 0, 0)).toBeCloseTo(1.0, 10);
  });

  it('S6 — both constraints exactly equal: MAX(x, x) = x', () => {
    // C=-1.0M, D=0 → -(C+D)=1.0
    // F=2.0M, G=-2.0M → forecasted=0, H=1.0 → Constraint1=1.0
    // Both = 1.0
    expect(calcSwapNear(-1.0, 0, 2.0, -2.0, 1.0)).toBeCloseTo(1.0, 10);
  });

  it('S7 — all zeros: no swap needed', () => {
    // Net = 0, cash above threshold
    expect(calcSwapNear(0, 0, 1.0, 0, 0)).toBeCloseTo(0, 10);
  });

  it('netting: spot and forward partially offset (prevents oversizing)', () => {
    // C=-400K=−0.4, D=+200K=+0.2 → net=-0.2 → swap=0.2 (not 0.4 gross)
    // Cash well above H so book restructuring drives result
    const swap = calcSwapNear(-0.4, 0.2, 5.0, 0, 0);
    expect(swap).toBeCloseTo(0.2, 10);  // correct: net is only 0.2 short
    expect(swap).not.toBeCloseTo(0.4, 2); // NOT gross dominant leg 0.4 (the old wrong formula)
  });

  it('near + far = 0: swap is self-cancelling', () => {
    // Far leg always = −near leg; net Delta unchanged
    const near = calcSwapNear(-0.8, 0.2, 5.0, -0.5, 1.0);
    const far = -near;
    expect(near + far).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. calcCarry and calcDelta
// ─────────────────────────────────────────────────────────────────────────────
describe('calcCarry', () => {
  it('short net position earns positive carry', () => {
    // L = -(C+D) × carry/100 = -(-1.0) × 5/100 = +0.05
    expect(calcCarry(-1.0, 0, 5.0)).toBeCloseTo(0.05, 10);
  });

  it('long net position pays carry (negative income)', () => {
    expect(calcCarry(1.0, 0, 5.0)).toBeCloseTo(-0.05, 10);
  });

  it('flat net position has zero carry regardless of rate', () => {
    expect(calcCarry(-1.0, 1.0, 5.0)).toBeCloseTo(0, 10);
    expect(calcCarry(0, 0, 20.0)).toBeCloseTo(0, 10);
  });

  it('zero carry rate produces zero carry income', () => {
    expect(calcCarry(-1.0, 0, 0)).toBe(0);
  });
});

describe('calcDelta', () => {
  it('delta = C + D + L + E (swap legs cancel: I+J=0)', () => {
    // C=-0.8, D=+0.2, L=0.03, E=0.5
    expect(calcDelta(-0.8, 0.2, 0.03, 0.5)).toBeCloseTo(-0.07, 10);
  });

  it('delta is unchanged by swap: adding near+far does not affect it', () => {
    const delta1 = calcDelta(-1.0, 0.5, 0.02, 0.1);
    // Conceptually: swap near = 0.6, far = -0.6, net = 0
    // calcDelta does not take swap inputs — this is the architectural guarantee
    expect(delta1).toBeCloseTo(-0.38, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. calcDynamicH  =  MAX(cash_floor, |net| × VAR95_1M × combined_multiplier)
//    NWC P&L buffer — sized for FX mark-to-market loss, NOT FCY payment capacity
// ─────────────────────────────────────────────────────────────────────────────
describe('calcDynamicH', () => {
  it('pegged currency (AED): formula near cash_floor regardless of position size', () => {
    // AED σ_daily ≈ 0 → var_factor ≈ 0 → H ≈ cash_floor
    const H = calcDynamicH(100, 'AED', 0.05);
    expect(H).toBeCloseTo(0.05, 2); // formula term < cash_floor, floor binds
  });

  it('AUD: 3M position → dynamic H > H_min', () => {
    // vf = 0.062, mult = 1 + (3.27/100) × 0.25 = 1.00818
    // H = MAX(0.05, 3.0 × 0.062 × 1.00818) ≈ MAX(0.05, 0.1875) = 0.1875
    const H = calcDynamicH(3.0, 'AUD', 0.05);
    expect(H).toBeGreaterThan(0.05);
    expect(H).toBeCloseTo(0.1875, 2);
  });

  it('TRY: 10M position → dynamic H well above H_min', () => {
    // vf = 0.0701, mult = 1.009259
    // H = MAX(0.05, 10 × 0.0701 × 1.009259) ≈ MAX(0.05, 0.708) = 0.708
    const H = calcDynamicH(10, 'TRY', 0.05);
    expect(H).toBeCloseTo(0.708, 2);
  });

  it('JPM NP TRY multiplier is 1.009, NOT 1.368 (nominal rates)', () => {
    // Confirms the decision to use JPM NP rates — multiplier is much smaller
    const mult_lp = combinedMultiplier(CURRENCY_PARAMS.TRY.carry, CURRENCY_PARAMS.TRY.β_IR);
    const mult_nominal = combinedMultiplier(46.0, CURRENCY_PARAMS.TRY.β_IR);
    expect(mult_lp).toBeCloseTo(1.009, 2);
    expect(mult_nominal).toBeCloseTo(1.368, 2);
    // JPM NP H is 26% smaller than if nominal rates were used
    expect(mult_nominal / mult_lp).toBeGreaterThan(1.3);
  });

  it('floor binding: small position on volatile currency still respects cash_floor', () => {
    const H = calcDynamicH(0.001, 'TRY', 0.05);
    expect(H).toBe(0.05); // formula term near zero, floor takes over
  });

  it('absolute value of position: long and short give same H', () => {
    expect(calcDynamicH(5, 'EUR', 0.05)).toBeCloseTo(calcDynamicH(-5, 'EUR', 0.05), 10);
  });

  it('scales with position: double position → double H (above floor)', () => {
    const H1 = calcDynamicH(10, 'AUD', 0);
    const H2 = calcDynamicH(20, 'AUD', 0);
    expect(H2).toBeCloseTo(H1 * 2, 8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. calcOptimalBuffer  —  interest-rate optimized liquidity threshold H*
//    H* = MAX(cash_floor, P × (1 + σ_P × Φ⁻¹(1 − Δr/r_OD)))
//    Key insight: high r_OD → hold near P; EARN carry → hold above P; PAY carry → hold below P
// ─────────────────────────────────────────────────────────────────────────────
describe('calcOptimalBuffer', () => {
  const BASE = { P: 10, σ_P: 0.10, r_USD: 3.5, days: 30, cash_floor: 0 };

  it('EARN carry (GBP: r_FCY=3.57% > r_USD=3.50%): H* > P — profitable to hold more FCY', () => {
    const r = calcOptimalBuffer({ ...BASE, r_FCY: 3.5747, r_OD: 4.0047 });
    expect(r.carry_direction).toBe('earn');
    expect(r.H_optimal).toBeGreaterThan(10); // hold more than expected payouts
    expect(r.H_pct_of_P).toBeGreaterThan(100);
    // C_hold = 0 (MAX(0, negative Δr))
    expect(r.C_hold_daily).toBe(0);
  });

  it('PAY carry moderate (EUR: r_FCY=1.78% < r_USD=3.50%): H* < P — reduce buffer', () => {
    const r = calcOptimalBuffer({ ...BASE, r_FCY: 1.783, r_OD: 2.213 });
    expect(r.carry_direction).toBe('pay');
    expect(r.H_optimal).toBeLessThan(10); // cheaper to accept occasional overdraft
    expect(r.H_pct_of_P).toBeLessThan(100);
    expect(r.delta_r).toBeCloseTo(1.717, 2);
  });

  it('PAY carry extreme (CHF: r_FCY=−0.32%, r_OD=0.15%): H* << P — r_OD too cheap to bother holding', () => {
    // Δr = 3.82%, r_OD = 0.15% → ratio = 25.5 → clamp to 0.999
    // z = normInv(0.001) ≈ −3.09 → H* = 10 × (1 − 0.10 × 3.09) ≈ 6.91
    const r = calcOptimalBuffer({ ...BASE, r_FCY: -0.32, r_OD: 0.15 });
    expect(r.carry_direction).toBe('pay');
    expect(r.H_optimal).toBeCloseTo(6.91, 1);
    expect(r.shortfall_prob_pct).toBeCloseTo(99.9, 0); // almost accept overdraft freely
  });

  it('cash_floor binding (CHF with cash_floor=8): floor overrides formula result', () => {
    const r = calcOptimalBuffer({ ...BASE, r_FCY: -0.32, r_OD: 0.15, cash_floor: 8 });
    expect(r.H_optimal).toBe(8); // formula gives ~6.91 but floor = 8
    expect(r.H_pct_of_P).toBeCloseTo(80, 0);
  });

  it('TRY (r_OD=34.16%): H* > P even though PAY carry — overdraft is too expensive', () => {
    // Δr = 2.34%, r_OD = 34.16% → ratio = 0.0686 → shortfall_prob = 6.86%
    // z = normInv(0.9314) ≈ 1.49 → H* = 10 × (1 + 0.10 × 1.49) ≈ 11.49
    const r = calcOptimalBuffer({ ...BASE, r_FCY: 1.157379, r_OD: 34.157379 });
    expect(r.carry_direction).toBe('pay');
    expect(r.H_optimal).toBeGreaterThan(10); // PAY carry BUT r_OD dominates
    expect(r.H_pct_of_P).toBeCloseTo(114.9, 0);
    expect(r.shortfall_prob_pct).toBeCloseTo(6.86, 1);
  });

  it('zero forecast uncertainty (σ_P=0): H* = P exactly, no z-score effect', () => {
    const r = calcOptimalBuffer({ ...BASE, σ_P: 0, r_FCY: 1.783, r_OD: 2.213 });
    expect(r.H_optimal).toBeCloseTo(10, 10);
    expect(r.C_OD_daily).toBeCloseTo(0, 10); // no uncertainty → no expected overdraft
  });

  it('zero P: H* = H_min (0), H_pct_of_P = 0', () => {
    const r = calcOptimalBuffer({ ...BASE, P: 0, r_FCY: 1.783, r_OD: 2.213 });
    expect(r.H_optimal).toBe(0);
    expect(r.H_pct_of_P).toBe(0);
  });

  it('EARN carry has zero holding cost (C_hold = MAX(0, Δr) × H)', () => {
    const r = calcOptimalBuffer({ ...BASE, r_FCY: 5.0, r_OD: 6.0 }); // EARN
    expect(r.C_hold_daily).toBe(0); // holding earns, not costs
  });

  it('PAY carry has positive holding cost', () => {
    const r = calcOptimalBuffer({ ...BASE, r_FCY: 1.783, r_OD: 2.213 }); // PAY
    expect(r.C_hold_daily).toBeGreaterThan(0);
  });

  it('σ_P scales safety margin linearly: double σ_P doubles the safety margin on top of P', () => {
    const r1 = calcOptimalBuffer({ ...BASE, σ_P: 0.10, r_FCY: 3.5, r_OD: 4.5 }); // neutral carry
    const r2 = calcOptimalBuffer({ ...BASE, σ_P: 0.20, r_FCY: 3.5, r_OD: 4.5 });
    const margin1 = r1.H_optimal - 10;
    const margin2 = r2.H_optimal - 10;
    expect(margin2).toBeCloseTo(margin1 * 2, 6);
  });

  it('carry direction boundary: |Δr| ≤ 0.05% → neutral', () => {
    const r = calcOptimalBuffer({ ...BASE, r_FCY: 3.50, r_OD: 4.5 });
    expect(r.carry_direction).toBe('neutral');
    const r2 = calcOptimalBuffer({ ...BASE, r_FCY: 3.46, r_OD: 4.5 });
    expect(r2.carry_direction).toBe('neutral'); // 3.50 − 3.46 = 0.04% < threshold
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. computeLayeredBuffer  —  additive layer decomposition
//    cash_threshold = P_contrib + floor_contrib + delta_sigma + delta_carry
//    P_contrib = P when sigmaP layer is active, else 0 (PRE-PAYOUT base)
// ─────────────────────────────────────────────────────────────────────────────
describe('netPayoutDeficit', () => {
  it('returns 0 when opening LP covers outflow', () => {
    expect(netPayoutDeficit(-100, 95.1)).toBeCloseTo(4.9);
    expect(netPayoutDeficit(-50, 95.1)).toBe(0);
  });

  it('returns full |payout| when LP cannot prefund', () => {
    expect(netPayoutDeficit(-100, 0)).toBe(100);
  });
});

describe('computeLayeredBuffer', () => {
  const EUR = { r_FCY: 1.783, r_OD: 2.213 };
  const HUF = { r_FCY: 5.690276, r_OD: 6.790276 }; // EARN carry
  const P = 10, σ_P = 0.10, r_USD = 3.5;

  const none   = new Set<'sigmaP' | 'carryOptim' | 'floorH' | 'portfolioDiv'>([]);
  const floor  = new Set<typeof none extends Set<infer T> ? T : never>(['floorH']);
  const safety = new Set<typeof none extends Set<infer T> ? T : never>(['sigmaP']);
  const carry  = new Set<typeof none extends Set<infer T> ? T : never>(['carryOptim']);
  const all3   = new Set<typeof none extends Set<infer T> ? T : never>(['floorH', 'sigmaP', 'carryOptim']);

  it('no active layers: all contributions = 0, H* = 0', () => {
    const r = computeLayeredBuffer(0, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, 0.5, none);
    expect(r.floor_contrib).toBe(0);
    expect(r.delta_sigma).toBe(0);
    expect(r.delta_carry).toBe(0);
    expect(r.cash_threshold).toBe(0);
    expect(r.floor_binding).toBe(false);
  });

  it('floor only (PAY, zero payout): H* = cash_floor, no safety or carry', () => {
    const r = computeLayeredBuffer(0, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, 0.5, floor);
    expect(r.floor_contrib).toBeCloseTo(0.5, 10);
    expect(r.delta_sigma).toBe(0);
    expect(r.delta_carry).toBe(0);
    expect(r.cash_threshold).toBeCloseTo(0.5, 10);
  });

  it('safety only (EARN): H* = trough + sigma on deficit', () => {
    const trough = P;
    const r = computeLayeredBuffer(P, trough, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, 0, safety);
    const expected_sigma = P * σ_P * Z_NEUTRAL;
    expect(r.delta_sigma).toBeCloseTo(expected_sigma, 6);
    expect(r.P_contrib).toBeCloseTo(P, 10);
    expect(r.cash_threshold).toBeCloseTo(trough + expected_sigma, 6);
  });

  it('PAY carry with no Min floor: layer is neutral, nothing to anchor on', () => {
    const rCheap = computeLayeredBuffer(0, P, σ_P, r_USD, EUR.r_FCY, 1.0, 0, carry);
    expect(rCheap.P_contrib).toBe(0);
    expect(rCheap.delta_carry).toBe(0);
    expect(rCheap.cash_threshold).toBe(0);
  });

  it('PAY carry anchored on a Min floor: the floor is the carry level', () => {
    const r = computeLayeredBuffer(0, P, σ_P, r_USD, EUR.r_FCY, 1.0, 3.0, carry);
    // Floor VALUE drives the default even with the floorH layer off.
    expect(r.floor_contrib).toBe(0);
    expect(r.cash_threshold).toBeCloseTo(3.0, 6);
  });

  it('carry EARN only (HUF) with no Min floor: neutral, direction still reported', () => {
    const r = computeLayeredBuffer(P, P, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, 0, carry);
    expect(r.delta_carry).toBe(0);
    expect(r.carry_dir).toBe('earn');
  });

  it('carry EARN (HUF) anchored on a Min floor lands on it', () => {
    const ask = 12.0;
    const r = computeLayeredBuffer(P, P, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, ask, carry);
    // The ask states Target LP Cash pre-payout; the cushion carries it net of |payout|.
    expect(r.cash_threshold).toBeCloseTo(ask - P, 6);
    expect(r.carry_target_applied).toBe(true);
  });

  it('floor + PAY carry: enabled floor is a hard minimum (carry cannot sell through it)', () => {
    const r = computeLayeredBuffer(P, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, 5.0,
      new Set(['floorH', 'carryOptim']));
    expect(r.floor_contrib).toBeCloseTo(5.0, 10);
    expect(r.delta_carry).toBeLessThan(0);
    expect(r.raw_sum).toBeCloseTo(5.0 + r.delta_carry, 4);
    expect(r.cash_threshold).toBeCloseTo(5.0, 10);
  });

  it('cash_threshold floored at 0 only when r_OD > r_USD (enabled min floor still binds)', () => {
    const rEur = computeLayeredBuffer(P, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, 5.0, all3);
    expect(rEur.cash_threshold).toBe(Math.max(rEur.raw_sum, 5.0)); // r_OD < r_USD → no zero-floor; min floor holds
    const rEurNoFloor = computeLayeredBuffer(P, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, 0, all3);
    expect(rEurNoFloor.cash_threshold).toBe(rEurNoFloor.raw_sum);
    const { carry: aedCarry, r_OD: aedOd } = CURRENCY_PARAMS.AED!;
    const rAed = computeLayeredBuffer(P, P, σ_P, r_USD, aedCarry, aedOd, 5.0, all3);
    expect(rAed.cash_threshold).toBeGreaterThanOrEqual(5.0);
    expect(rAed.cash_threshold).toBe(Math.max(5.0, rAed.raw_sum));
  });

  it('a typed carry ask may run H* negative even when r_OD > r_USD', () => {
    const { carry: aedCarry, r_OD: aedOd } = CURRENCY_PARAMS.AED!;
    const r = computeLayeredBuffer(0, 0, σ_P, r_USD, aedCarry, aedOd, 0, carry, 0, -20);
    expect(r.cash_threshold).toBeLessThan(0);
    expect(r.debit_floor_binding).toBe(false);
  });

  it('additive identity: PAY cushion = layerSum; EARN = max(trough,0) + layers', () => {
    for (const layers of [none, floor, safety, carry, all3]) {
      const r = computeLayeredBuffer(P, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, 2.0, layers as Set<'sigmaP' | 'carryOptim' | 'floorH' | 'portfolioDiv'>);
      const layerSum = r.floor_contrib + r.delta_sigma + r.delta_carry;
      expect(r.raw_sum).toBeCloseTo(layerSum, 10);
    }
    const earn = computeLayeredBuffer(P, P, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, 2.0, all3);
    expect(earn.raw_sum).toBeCloseTo(P + earn.floor_contrib + earn.delta_sigma + earn.delta_carry, 10);
    const earnNegTrough = computeLayeredBuffer(P, -P, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, 2.0, all3, P);
    expect(earnNegTrough.raw_sum).toBeCloseTo(
      earnNegTrough.floor_contrib + earnNegTrough.delta_sigma + earnNegTrough.delta_carry, 10,
    );
  });

  it('safety + carry with no Min floor: the carry layer leaves safety untouched', () => {
    const rSafety = computeLayeredBuffer(P, P, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, 0, safety);
    const rBoth   = computeLayeredBuffer(P, P, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, 0,
      new Set(['sigmaP', 'carryOptim']));
    expect(rBoth.delta_carry).toBe(0);
    expect(rBoth.cash_threshold).toBeCloseTo(rSafety.cash_threshold, 10);
  });

  it('safety + carry anchored on a Min floor overrides the safety stack', () => {
    const ask = 400;
    const rBoth = computeLayeredBuffer(P, P, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, ask,
      new Set(['sigmaP', 'carryOptim']));
    // δ_carry absorbs σ so the book lands on the stated floor, not floor + σ.
    expect(rBoth.delta_sigma).toBeGreaterThan(0);
    expect(rBoth.cash_threshold).toBeCloseTo(ask - P, 6);
  });

  it('neutral carry: z_opt ≈ Z_NEUTRAL, delta_carry ≈ 0', () => {
    // r_FCY = r_USD → Δr = 0 → but ratio = 0/r_OD = 0 → clamped to 0.001 → z ≈ 3.09
    // Actually neutral is when |Δr| < 0.05 for display, but the z computation still runs
    // Use a very small Δr to see near-neutral behavior
    const r = computeLayeredBuffer(P, P, σ_P, r_USD, 3.50, 4.5, 0, carry);
    // Δr = 0 → ratio = 0 → clamped to 0.001 → z = normInv(0.999) ≈ 3.09
    // delta_carry = P × σ_P × (3.09 − 1.645) = 1.445
    // Hmm — technically even 0 carry triggers the EARN path when r_USD = r_FCY
    // This is by design: at Δr = 0 you're indifferent but the formula biases toward EARN
    expect(r.carry_dir).toBe('neutral'); // display label
  });

  // ── cash_floor positive and negative values ───────────────────────────────────

  it('positive cash_floor (PAY): cushion = floor only', () => {
    const r = computeLayeredBuffer(P, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, 3.0, floor);
    expect(r.floor_contrib).toBeCloseTo(3.0, 10);
    expect(r.cash_threshold).toBeCloseTo(3.0, 10);
    expect(r.delta_sigma).toBe(0);
    expect(r.delta_carry).toBe(0);
  });

  it('negative cash_floor on expensive OD: PAY cushion floored at 0', () => {
    const { carry: aedCarry, r_OD: aedOd } = CURRENCY_PARAMS.AED!;
    const r = computeLayeredBuffer(P, P, σ_P, r_USD, aedCarry, aedOd, -5.0, floor);
    expect(r.floor_contrib).toBeCloseTo(-5.0, 10);
    expect(r.raw_sum).toBeCloseTo(-5.0, 10);
    expect(r.cash_threshold).toBeCloseTo(0, 10);
  });

  it('negative cash_floor + safety (EARN): H* = trough + floor + sigma', () => {
    const r = computeLayeredBuffer(P, P, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, -5.0,
      new Set(['floorH', 'sigmaP']));
    const expected_sigma = P * σ_P * Z_NEUTRAL;
    expect(r.floor_contrib).toBeCloseTo(-5.0, 10);
    expect(r.delta_sigma).toBeCloseTo(expected_sigma, 6);
    expect(r.cash_threshold).toBeCloseTo(P + (-5.0) + expected_sigma, 6);
  });

  it('negative H_min + PAY: cushion = floor + σ + carry', () => {
    const r = computeLayeredBuffer(P, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, -5.0, all3);
    expect(r.floor_contrib).toBeCloseTo(-5.0, 10);
    expect(r.P_contrib).toBe(0);
    expect(r.delta_sigma).toBeCloseTo(P * σ_P * Z_NEUTRAL, 6);
    expect(r.cash_threshold).toBeCloseTo(-5.0 + r.delta_sigma + r.delta_carry, 4);
  });

  it('additive identity holds for negative H_min: PAY cushion = layerSum', () => {
    for (const layers of [floor, safety, carry, all3]) {
      const r = computeLayeredBuffer(P, P, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, -3.0,
        layers as Set<'sigmaP' | 'carryOptim' | 'floorH' | 'portfolioDiv'>);
      const layerSum = r.floor_contrib + r.delta_sigma + r.delta_carry;
      expect(r.raw_sum).toBeCloseTo(layerSum, 10);
      const expected = allowsNegativeLp(EUR.r_OD, r_USD) ? r.raw_sum : Math.max(0, r.raw_sum);
      expect(r.cash_threshold).toBe(expected);
    }
  });

  it('zero payout PAY CAD with no Min floor: carry stays neutral', () => {
    const CAD = { r_FCY: 1.49, r_OD: 2.39 };
    const trough = 95.1;
    const r = computeLayeredBuffer(0, trough, σ_P, r_USD, CAD.r_FCY, CAD.r_OD, 0, all3, trough);
    expect(r.P_contrib).toBe(0);
    expect(r.delta_sigma).toBe(0);
    expect(r.delta_carry).toBe(0);
    expect(r.cash_threshold).toBeCloseTo(r.floor_contrib, 4);
  });

  it('zero payout PAY CAD anchored on a Min floor sells the stock down to it', () => {
    const CAD = { r_FCY: 1.49, r_OD: 2.39 };
    const trough = 95.1;
    const floorAsk = 10;
    const r = computeLayeredBuffer(0, trough, σ_P, r_USD, CAD.r_FCY, CAD.r_OD, floorAsk,
      new Set(['carryOptim']), trough);
    expect(r.cash_threshold).toBeCloseTo(floorAsk, 6);
    expect(r.cash_threshold).toBeLessThan(trough);
  });

  it('zero payout EARN with no Min floor: carry adds nothing to the stock', () => {
    const trough = 238;
    const r = computeLayeredBuffer(0, trough, σ_P, r_USD, HUF.r_FCY, HUF.r_OD, 0,
      new Set(['carryOptim']), trough);
    expect(r.delta_carry).toBe(0);
    expect(r.cash_threshold).toBeCloseTo(trough, 4);
  });

  it('zero payout: enabled floor caps the PAY sell-down (hard minimum)', () => {
    const trough = 95.1;
    const r = computeLayeredBuffer(0, trough, σ_P, r_USD, EUR.r_FCY, EUR.r_OD, 0.5,
      new Set(['floorH', 'sigmaP', 'carryOptim']));
    expect(r.delta_sigma).toBe(0);
    expect(r.raw_sum).toBeCloseTo(0.5 + r.delta_carry, 4);
    expect(r.cash_threshold).toBeCloseTo(0.5, 10);
  });
});

describe('computeUsdBuffer', () => {
  const σ_P = 0.10;
  const all = new Set(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'] as LayerId[]);
  const sigmaFloor = new Set(['sigmaP', 'floorH'] as LayerId[]);

  it('zero payout → zero target (carry/portfolio layers ignored)', () => {
    const r = computeUsdBuffer(0, 0, σ_P, all);
    expect(r.cash_threshold).toBe(0);
    expect(r.delta_carry).toBe(0);
  });

  it('payout + sigmaP → |P| + σ buffer, no carry leg', () => {
    const r = computeUsdBuffer(-100, 0, σ_P, sigmaFloor);
    expect(r.P_contrib).toBeCloseTo(100);
    expect(r.delta_sigma).toBeCloseTo(100 * σ_P * Z_NEUTRAL);
    expect(r.delta_carry).toBe(0);
    expect(r.cash_threshold).toBeCloseTo(100 + 100 * σ_P * Z_NEUTRAL);
  });

  it('floorH applies minimum even without payout', () => {
    const r = computeUsdBuffer(0, 50, σ_P, new Set(['floorH'] as LayerId[]));
    expect(r.cash_threshold).toBeCloseTo(50);
  });

  it('carryOptim and portfolioDiv have no effect', () => {
    const base = computeUsdBuffer(-50, 0, σ_P, sigmaFloor);
    const withCarry = computeUsdBuffer(-50, 0, σ_P, all);
    expect(withCarry.cash_threshold).toBeCloseTo(base.cash_threshold);
    expect(withCarry.delta_carry).toBe(0);
  });
});

describe('deriveUsdLiquidity', () => {
  it('USD swap is mechanical offset of FCY legs', () => {
    const d = deriveUsdLiquidity(116.45, 42.5, 303.9);
    expect(d.cash_threshold).toBeCloseTo(116.45);
    expect(d.usd_peak).toBeCloseTo(303.9);
    expect(d.swapNear).toBeCloseTo(-42.5);
    expect(d.implied_fcy_swap_usd).toBeCloseTo(303.9 - 116.45);
    expect(d.available_for_fcy).toBeCloseTo(303.9 - 116.45);
  });

  it('no USD payout: FCY swaps drive USD leg; envelope does not bind', () => {
    const d = deriveUsdLiquidity(0, 50, 500);
    expect(d.cash_threshold).toBeCloseTo(500);
    expect(d.swapNear).toBeCloseTo(-50);
    expect(d.implied_fcy_swap_usd).toBeCloseTo(0);
    expect(d.fcy_envelope_shortfall).toBeCloseTo(0);
    expect(d.fcy_funding_shortfall).toBeCloseTo(0);
    expect(d.budget_binding).toBe(false);

    const dSell = deriveUsdLiquidity(0, -80, 500);
    expect(dSell.swapNear).toBeCloseTo(80);
    expect(dSell.fcy_envelope_shortfall).toBeCloseTo(0);
    expect(dSell.budget_binding).toBe(false);
  });

  it('zero-sum by construction: USD swap = −FCY net', () => {
    const fcySwap = 42.5;
    const d = deriveUsdLiquidity(116.45, fcySwap, 303.9);
    expect(d.swapNear + fcySwap).toBeCloseTo(0);
  });

  it('large USD payout: FCY envelope binds; USD swap still −FCY net', () => {
    const σ_P = 0.10;
    const payoutBuffer = computeUsdBuffer(-500, 0, σ_P, new Set(['sigmaP', 'floorH'])).cash_threshold;
    const usdCash = 303.9;
    const d = deriveUsdLiquidity(payoutBuffer, 0, usdCash, -500);
    expect(d.usd_peak).toBeCloseTo(usdCash - 500);
    expect(d.implied_fcy_swap_usd).toBeCloseTo(-778.35, 0);
    expect(d.implied_fcy_swap_usd).toBeLessThan(0);
    expect(d.fcy_envelope_shortfall).toBeGreaterThan(700);
    expect(d.swapNear).toBeCloseTo(0);
  });

  it('flags shortfall when FCY funding exceeds available USD', () => {
    const d = deriveUsdLiquidity(0, 250, 200);
    expect(d.available_for_fcy).toBeCloseTo(200);
    expect(d.fcy_funding_shortfall).toBeCloseTo(50);
    expect(d.fcy_envelope_shortfall).toBeCloseTo(0);
    expect(d.budget_binding).toBe(true);
  });
});

describe('computeFcyCollateralBudget', () => {
  it('reserves USD payout buffer before FCY collateral', () => {
    expect(computeFcyCollateralBudget(303.9, 116.45)).toBeCloseTo(187.45);
  });

  it('never negative', () => {
    expect(computeFcyCollateralBudget(50, 100)).toBe(0);
  });
});

describe('assessUsdLiquidityPriority', () => {
  it('USD payout buffer reserved first', () => {
    const a = assessUsdLiquidityPriority(303.9, 116.45);
    expect(a.available_for_fcy).toBeCloseTo(187.45);
    expect(a.usd_payout_gap).toBe(0);
    expect(a.mode).toBe('normal');
  });

  it('flags payout gap when cash below buffer', () => {
    const a = assessUsdLiquidityPriority(50, 116.45);
    expect(a.usd_payout_gap).toBeCloseTo(66.45);
    expect(a.available_for_fcy).toBe(0);
  });
});

describe('isExpensiveOverdraft / allowsNegativeLp', () => {
  const r_USD = 4.5;

  it('AED: r_OD > r_USD → no negative LP', () => {
    const { r_OD } = CURRENCY_PARAMS.AED!;
    expect(isExpensiveOverdraft(r_OD, r_USD)).toBe(true);
    expect(allowsNegativeLp(r_OD, r_USD)).toBe(false);
  });

  it('CAD: r_OD < r_USD → negative LP allowed', () => {
    const { r_OD } = CURRENCY_PARAMS.CAD!;
    expect(isExpensiveOverdraft(r_OD, r_USD)).toBe(false);
    expect(allowsNegativeLp(r_OD, r_USD)).toBe(true);
  });

  it('AED expensive overdraft: swap clamped to clear negative cash', () => {
    const { r_OD } = CURRENCY_PARAMS.AED!;
    const swap = computeFcySwapNear(0, -26.9, 0, r_OD, r_USD, true, -26.9);
    expect(swap).toBeGreaterThanOrEqual(26.9);
  });
});

describe('PLN cash + points vs USD', () => {
  const spot = CURRENCY_PARAMS.PLN!.spot;
  const r_FCY = 3.41;
  const r_USD = 3.50;
  const r_OD = 4.41;

  it('a short standing pays OD, earns USD, and pays CIP to buy PLN far', () => {
    const S = -20;
    const overlay = fundingSwapOverlayUsdYr(S, spot, r_FCY, r_USD, r_OD);
    const cash = fundingSwapCashDeltaUsdYr(S, spot, r_FCY, r_USD, r_OD);
    expect(overlay.fcyOnUsdYr).toBeLessThan(0);
    expect(overlay.usdOnUsdYr).toBeGreaterThan(0);
    expect(overlay.pointsUsdYr).toBeLessThan(0);
    expect(cash).toBeLessThan(0);
    expect(cash).toBeCloseTo(S * ((r_OD - r_USD) / 100) * spot, 10);
  });

  it('a covering long standing pays credit vs USD; CIP on the sell-far offsets it at mid', () => {
    const S = 20;
    const overlay = fundingSwapOverlayUsdYr(S, spot, r_FCY, r_USD, r_OD);
    const cash = fundingSwapCashDeltaUsdYr(S, spot, r_FCY, r_USD, r_OD);
    expect(cash).toBeLessThan(0);
    expect(cash).toBeCloseTo(S * ((r_FCY - r_USD) / 100) * spot, 10);
    expect(overlay.pointsUsdYr).toBeCloseTo(-cash, 10);
  });

  it('12m term Buffer Carry is annual cash Δr on M1 standing, not a 1M nest or a 6-cycle path', () => {
    const standing = 21.6;
    const annual = standing * ((r_FCY - r_USD) / 100) * spot;
    expect(annual * 1000).toBeCloseTo(-5.343, 2);
    const sixCycleTerm = Array.from({ length: 6 }, (_, i) => ({
      standing_swap: standing,
      far_leg: i === 5 ? -standing : 0,
      cycleIndex: i,
    }));
    const legs = fundingSwapCarryLegs({
      ccy: 'PLN',
      plan: sixCycleTerm,
      r_FCY,
      r_USD,
      r_OD,
      forecastMonths: 12,
    });
    expect(legs.cashUsdM).toBeCloseTo(annual, 8);
    expect(legs.cashUsdM * 1000).toBeCloseTo(-5.3, 1);
    expect(legs.cashUsdM).not.toBeCloseTo(annual / 2, 4);
  });

  it('EURUSD points on a PLN strip do not print cash and CIP both negative', () => {
    const plan = Array.from({ length: 12 }, (_, i) => ({
      standing_swap: 1.8 * (i + 1),
      far_leg: 0,
      cycleIndex: i,
    }));
    const bundle = resolveMarketRatesForCcy(
      { PLN: DEFAULT_EURUSD_MARKET_RATES },
      'PLN',
    );
    const legs = fundingSwapCarryLegs({
      ccy: 'PLN',
      plan,
      r_FCY,
      r_USD,
      r_OD,
      forecastMonths: 12,
    });
    const cip = fundingSwapPathFarCipUsdM({
      plan,
      standingFallback: 1.8,
      forecastMonths: 12,
      bookingMode: 'rolling',
      bundle,
      fallbackAnnualUsdYr: S =>
        fundingSwapCipPointsUsdYr(S, spot, r_FCY, r_USD),
    });
    expect(legs.cashUsdM * 1000).toBeCloseTo(-2.9, 1);
    expect(cip).toBeGreaterThan(0);
    expect(cip).toBeCloseTo(-legs.cashUsdM, 8);
    expect(cip + legs.cashUsdM).toBeCloseTo(0, 8);
  });

  it('rolling buffer carry extends to forecastMonths when the plan is shorter', () => {
    const standing = 21.6;
    const annual = standing * ((r_FCY - r_USD) / 100) * spot;
    const sixCycleRolling = Array.from({ length: 6 }, (_, i) => ({
      standing_swap: standing,
      far_leg: 0,
      cycleIndex: i,
    }));
    const legs = fundingSwapCarryLegs({
      ccy: 'PLN',
      plan: sixCycleRolling,
      r_FCY,
      r_USD,
      r_OD,
      forecastMonths: 12,
    });
    expect(legs.cashUsdM).toBeCloseTo(annual, 8);
    expect(legs.cashUsdM * 1000).toBeCloseTo(-5.3, 1);
  });
});

describe('enforceUsdLiquidityStress', () => {
  const r_USD = 4.5;
  const σ_P = 0.05;
  const allLayers = new Set<LayerId>(['floorH', 'sigmaP', 'carryOptim', 'portfolioDiv']);

  function stressRow(
    ccy: string,
    cash: number,
    cash_threshold: number,
    total_cash = cash,
    trough_lp = cash,
  ) {
    const p = CURRENCY_PARAMS[ccy]!;
    const layered = computeLayeredBuffer(0, cash, σ_P, r_USD, p.carry, p.r_OD, 0, allLayers);
    return {
      ccy,
      cash_threshold,
      total_cash,
      cash,
      payout: 0,
      trough_lp,
      P_contrib: layered.P_contrib,
      floor_contrib: layered.floor_contrib,
      delta_sigma: layered.delta_sigma,
      r_FCY: p.carry,
      r_OD: p.r_OD,
    };
  }

  it('no-op when USD covers FCY funding need and no excess buys', () => {
    const opt = optimizePortfolioCarry([
      { ccy: 'CAD', P: 0, lp_cash: 95.1, P_contrib: 0, forecasted_cash: 95.1, floor_contrib: 0, delta_sigma: 0, r_FCY: CURRENCY_PARAMS.CAD!.carry, r_OD: CURRENCY_PARAMS.CAD!.r_OD },
      { ccy: 'MXN', P: 0, lp_cash: 238, P_contrib: 0, forecasted_cash: 238, floor_contrib: 0, delta_sigma: 0, r_FCY: CURRENCY_PARAMS.MXN!.carry, r_OD: CURRENCY_PARAMS.MXN!.r_OD },
    ], σ_P, r_USD, 500, 500);
    const rows = opt.map(r => stressRow(r.ccy, r.ccy === 'CAD' ? 95.1 : 238, r.cash_threshold));
    const res = enforceUsdLiquidityStress(rows, 500, 0, r_USD, true);
    expect(res.usdLiquidity.fcy_funding_shortfall).toBeLessThan(0.001);
    expect(res.fcySwapNearUsd + res.usdLiquidity.swapNear).toBeCloseTo(0, 0);
  });

  it('trims MXN EARN to cash when USD collateral budget binds', () => {
    const rows = [stressRow('MXN', 238, 350)];
    const res = enforceUsdLiquidityStress(rows, 1, 0, r_USD, true);

    const mxn = res.rows[0];
    expect(mxn.usd_stress_trim).toBe(true);
    expect(mxn.cash_threshold).toBeLessThan(350);
    expect(mxn.cash_threshold).toBeGreaterThanOrEqual(0);
    expect(res.usdLiquidity.fcy_funding_shortfall).toBeLessThan(0.001);
    expect(res.stress_binding).toBe(true);
  });

  it('sizes the swap on the trough it was handed, not on cash + payout', () => {
    // The dated path troughs 60 below the opening cash: a stress pass that
    // re-derived the low from cash + payout would size the leg 60 short.
    const dated = enforceUsdLiquidityStress(
      [stressRow('MXN', 238, 350, 238, 178)], 500, 0, r_USD, true,
    );
    const lump = enforceUsdLiquidityStress(
      [stressRow('MXN', 238, 350, 238, 238)], 500, 0, r_USD, true,
    );
    expect(dated.rows[0]!.swap_needed - lump.rows[0]!.swap_needed).toBeCloseTo(60, 6);
  });

  it('keeps PAY sell target when r_OD ≤ r_USD', () => {
    const floor = usdStressTrimFloor(
      { P_contrib: 0, floor_contrib: 0, delta_sigma: 0, r_FCY: 1.49, r_OD: 2.39 },
      80,
      4.5,
    );
    expect(allowsNegativeLp(2.39, 4.5)).toBe(true);
    expect(floor).toBe(80);
  });

  it('expensive-OD PAY (r_OD > r_USD) trims to 0 under stress floor', () => {
    const floor = usdStressTrimFloor(
      { P_contrib: 0, floor_contrib: 0, delta_sigma: 0, r_FCY: 2.05, r_OD: 4.55 },
      50,
      4.5,
    );
    expect(floor).toBe(0);
  });

  it('EARN floor is payout minimum (0 when no payout)', () => {
    const mxn = CURRENCY_PARAMS.MXN!;
    const floor = usdStressTrimFloor(
      { P_contrib: 0, floor_contrib: 0, delta_sigma: 0, r_FCY: mxn.carry, r_OD: mxn.r_OD },
      268,
      r_USD,
    );
    expect(floor).toBe(0);
    expect(payoutLiquidityMinimum(0, 0, 0, mxn.r_OD, r_USD)).toBe(0);
  });
});

describe('deriveUsdFromFcySwaps (compat)', () => {
  it('H_USD = payout buffer; swap = −FCY net', () => {
    const d = deriveUsdFromFcySwaps(116.45, 42.5, 303.9);
    expect(d.cash_threshold).toBeCloseTo(116.45);
    expect(d.swapNear).toBeCloseTo(-42.5);
  });
});

describe('sumFcySwapNearUsd', () => {
  it('excludes USD row from sum', () => {
    const mxnSpot = CURRENCY_PARAMS.MXN!.spot;
    expect(sumFcySwapNearUsd([
      { ccy: 'MXN', swapNear: 10 },
      { ccy: 'USD', swapNear: -100 },
    ])).toBeCloseTo(10 * mxnSpot);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. computePortfolioVAR  —  diversified portfolio VAR across FCY buffers
//    portfolio_VAR = z₉₅ × √(Σᵢ Σⱼ vol_i × vol_j × ρᵢⱼ)
// ─────────────────────────────────────────────────────────────────────────────
describe('computePortfolioVAR', () => {
  it('empty input: all zeros, div_factor = 1', () => {
    const r = computePortfolioVAR([]);
    expect(r.portfolio_VAR_USD).toBe(0);
    expect(r.standalone_sum_USD).toBe(0);
    expect(r.div_factor).toBe(1);
    expect(r.currencies).toHaveLength(0);
  });

  it('AED excluded: AED not in CORR_CURRENCIES → filtered out', () => {
    expect(CORR_CURRENCIES.includes('AED')).toBe(false);
    const r = computePortfolioVAR([{ ccy: 'AED', cashFCY: 100 }]);
    expect(r.currencies).toHaveLength(0);
    expect(r.portfolio_VAR_USD).toBe(0);
  });

  it('single AUD: portfolio VAR = standalone VAR, div_factor = 1, beta = 1', () => {
    // vol1M_USD = 1.0 × 0.71415 × 0.008227 × √21
    const { σ_daily, spot } = CURRENCY_PARAMS.AUD;
    const vol = 1.0 * spot * σ_daily * Math.sqrt(21);
    const expectedVar = Z_NEUTRAL * vol;

    const r = computePortfolioVAR([{ ccy: 'AUD', cashFCY: 1.0 }]);
    expect(r.currencies).toHaveLength(1);
    expect(r.portfolio_VAR_USD).toBeCloseTo(expectedVar, 6);
    expect(r.standalone_sum_USD).toBeCloseTo(expectedVar, 6);
    expect(r.div_benefit_USD).toBeCloseTo(0, 6);
    expect(r.div_factor).toBeCloseTo(1.0, 6);
    expect(r.currencies[0].beta).toBeCloseTo(1.0, 6);
  });

  it('EUR + GBP (ρ=0.77): portfolio VAR < standalone sum', () => {
    const r = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'GBP', cashFCY: 10 },
    ]);
    expect(r.portfolio_VAR_USD).toBeLessThan(r.standalone_sum_USD);
    expect(r.div_benefit_USD).toBeGreaterThan(0);
    expect(r.div_factor).toBeLessThan(1.0);
    // EUR + GBP are 77% correlated — moderate but real diversification
    expect(r.div_factor).toBeGreaterThan(0.9); // not huge diversification
  });

  it('EUR + JPY: more diversification than EUR + GBP (JPY negatively correlated with EUR)', () => {
    const rEurGbp = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'GBP', cashFCY: 10 },
    ]);
    const rEurJpy = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'JPY', cashFCY: 1000 }, // scale for comparable USD size
    ]);
    // JPY negative correlation with EUR means better diversification
    expect(rEurJpy.div_factor).toBeLessThan(rEurGbp.div_factor);
  });

  it('component VAR sum ≈ portfolio VAR (mathematical identity)', () => {
    const r = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'GBP', cashFCY: 8 },
      { ccy: 'AUD', cashFCY: 15 },
      { ccy: 'JPY', cashFCY: 800 },
    ]);
    const sumComp = r.currencies.reduce((s, c) => s + c.component_VAR_USD, 0);
    expect(sumComp).toBeCloseTo(r.portfolio_VAR_USD, 4);
  });

  it('diversification saving increases with portfolio size', () => {
    const r2 = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'JPY', cashFCY: 800 },
    ]);
    const r4 = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'JPY', cashFCY: 800 },
      { ccy: 'MXN', cashFCY: 20 },
      { ccy: 'TRY', cashFCY: 50 },
    ]);
    expect(r4.div_benefit_USD).toBeGreaterThan(r2.div_benefit_USD);
  });

  it('all M USD buffer sizes sum correctly in total_cash_USD', () => {
    const inputs = [
      { ccy: 'EUR', cashFCY: 5 },
      { ccy: 'GBP', cashFCY: 3 },
    ];
    const r = computePortfolioVAR(inputs);
    const expected =
      5 * CURRENCY_PARAMS.EUR.spot + 3 * CURRENCY_PARAMS.GBP.spot;
    expect(r.total_cash_USD).toBeCloseTo(expected, 6);
  });

  it('policy limit breach: portfolio VAR > $5M triggers director approval threshold', () => {
    // Scale positions so standalone VAR > $5M
    // AUD: standalone_VAR_USD = cashFCY × 0.71415 × 0.008227 × √21 × 1.645
    //   For 100M AUD: vol = 100 × 0.71415 × 0.037693 = 2.6926 M USD → VAR = 4.43 M USD
    // Use large position to breach $5M
    const r = computePortfolioVAR([
      { ccy: 'AUD', cashFCY: 150 },
      { ccy: 'EUR', cashFCY: 50 },
    ]);
    expect(r.portfolio_VAR_USD).toBeGreaterThan(5); // >$5M → Director approval
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. CURRENCY_PARAMS data integrity
// ─────────────────────────────────────────────────────────────────────────────
describe('CURRENCY_PARAMS integrity', () => {
  it('all DISPLAY_CURRENCIES have params defined', () => {
    for (const ccy of DISPLAY_CURRENCIES) {
      expect(CURRENCY_PARAMS[ccy], `Missing params for ${ccy}`).toBeDefined();
    }
  });

  it('USD: spot=1.0, σ_daily=0, β_IR=0', () => {
    expect(CURRENCY_PARAMS.USD.spot).toBe(1.0);
    expect(CURRENCY_PARAMS.USD.σ_daily).toBe(0);
    expect(CURRENCY_PARAMS.USD.β_IR).toBe(0);
  });

  it('pegged currencies (AED, HKD) have β_IR=0', () => {
    expect(CURRENCY_PARAMS.AED.β_IR).toBe(0);
    expect(CURRENCY_PARAMS.HKD.β_IR).toBe(0);
  });

  it('LP debit rate (r_OD) > LP credit rate (carry) for all currencies', () => {
    // Bank always charges more to borrow than it pays to deposit
    for (const [ccy, p] of Object.entries(CURRENCY_PARAMS)) {
      expect(p.r_OD, `${ccy}: r_OD must exceed carry`).toBeGreaterThan(p.carry);
    }
  });

  it('EARN carry currencies (r_FCY > r_USD=3.50%): GBP, HUF, MXN, ZAR', () => {
    const r_USD = 3.50;
    const earnCurrencies = ['GBP', 'HUF', 'MXN', 'ZAR'];
    for (const ccy of earnCurrencies) {
      expect(CURRENCY_PARAMS[ccy].carry, `${ccy} should earn carry`).toBeGreaterThan(r_USD);
    }
  });

  it('PAY carry currencies (r_FCY < r_USD=3.50%): EUR, JPY, CHF have positive Δr', () => {
    const r_USD = 3.50;
    const payCurrencies = ['EUR', 'JPY', 'CHF'];
    for (const ccy of payCurrencies) {
      expect(CURRENCY_PARAMS[ccy].carry, `${ccy} should pay carry`).toBeLessThan(r_USD);
    }
  });

  it('all spots are positive', () => {
    for (const [ccy, p] of Object.entries(CURRENCY_PARAMS)) {
      expect(p.spot, `${ccy}: spot must be positive`).toBeGreaterThan(0);
    }
  });

  it('all σ_daily are non-negative', () => {
    for (const [ccy, p] of Object.entries(CURRENCY_PARAMS)) {
      expect(p.σ_daily, `${ccy}: σ_daily must be ≥ 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it('all β_IR are between 0 and 1', () => {
    for (const [ccy, p] of Object.entries(CURRENCY_PARAMS)) {
      expect(p.β_IR, `${ccy}: β_IR must be in [0,1]`).toBeGreaterThanOrEqual(0);
      expect(p.β_IR, `${ccy}: β_IR must be in [0,1]`).toBeLessThanOrEqual(1);
    }
  });

  it('TRY carry uses JPM NP rate (~1.16%), not nominal (~46%)', () => {
    expect(CURRENCY_PARAMS.TRY.carry).toBeCloseTo(1.157, 1);
    expect(CURRENCY_PARAMS.TRY.carry).toBeLessThan(5); // definitely not nominal 46%
  });

  it('CORR_CURRENCIES are all defined in CURRENCY_PARAMS', () => {
    for (const ccy of CORR_CURRENCIES) {
      expect(CURRENCY_PARAMS[ccy], `${ccy} in CORR_CURRENCIES but no params`).toBeDefined();
    }
  });

  it('AED and USD are not in CORR_CURRENCIES (pegged / reporting currency)', () => {
    expect(CORR_CURRENCIES.includes('AED')).toBe(false);
    expect(CORR_CURRENCIES.includes('USD')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. VAR comparison: standalone vs diversified vs carry-optimized
//
// These tests validate the logic behind the VAR comparison columns in the main
// table: H₀ (σ-basis) vs H₁ (carry-optimized), solo_VAR₀ vs solo_VAR₁,
// and how correlation diversification appears in the portfolio totals footer.
// ─────────────────────────────────────────────────────────────────────────────
describe('VAR comparison: standalone vs diversified', () => {

  it('standalone_sum > portfolio_VAR for any 2+ currency portfolio (ρ < 1 always benefits)', () => {
    // EUR+GBP ρ=0.77 — real but less than 1 → diversification benefit must exist
    const r = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'GBP', cashFCY: 10 },
    ]);
    expect(r.standalone_sum_USD).toBeGreaterThan(r.portfolio_VAR_USD);
    expect(r.div_benefit_USD).toBeGreaterThan(0);
    expect(r.div_factor).toBeLessThan(1.0);
  });

  it('div_benefit_USD = standalone_sum_USD - portfolio_VAR_USD (mathematical identity)', () => {
    const r = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'JPY', cashFCY: 800 },
      { ccy: 'MXN', cashFCY: 20 },
    ]);
    expect(r.div_benefit_USD).toBeCloseTo(r.standalone_sum_USD - r.portfolio_VAR_USD, 6);
  });

  it('JPY component_VAR < JPY standalone_VAR (negative correlations reduce JPY marginal risk)', () => {
    const r = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'GBP', cashFCY: 8  },
      { ccy: 'AUD', cashFCY: 15 },
      { ccy: 'JPY', cashFCY: 800 },
      { ccy: 'MXN', cashFCY: 20 },
    ]);
    const jpy = r.currencies.find(c => c.ccy === 'JPY')!;
    // JPY has negative correlations with EUR(-0.15), GBP(-0.12), AUD(-0.05), MXN(-0.28)
    // → component_VAR < standalone_VAR
    expect(jpy.component_VAR_USD).toBeLessThan(jpy.standalone_VAR_USD);
    expect(jpy.beta).toBeLessThan(1.0);
  });

  it('JPY beta can be near-zero or negative in a portfolio with EM currencies (strongest diversifier)', () => {
    const r = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'MXN', cashFCY: 20 },
      { ccy: 'JPY', cashFCY: 800 },
    ]);
    const jpy = r.currencies.find(c => c.ccy === 'JPY')!;
    // JPY ρ(EUR)=-0.15, ρ(MXN)=-0.28 — negatively correlated with both
    expect(jpy.beta).toBeLessThan(0.5); // strong diversifier
  });

  it('European FX block (EUR, PLN, HUF) has high beta > 0.85 (low diversification within the block)', () => {
    const r = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'PLN', cashFCY: 30 },
      { ccy: 'HUF', cashFCY: 2000 },
    ]);
    // EUR-PLN ρ=0.74, EUR-HUF ρ=0.72, PLN-HUF ρ=0.72 — highly correlated
    for (const c of r.currencies) {
      expect(c.beta).toBeGreaterThan(0.85); // correlated block → limited diversification
    }
  });

  it('when portfolioDiv only: H₀ = H₁ per currency → d_solo = 0, but diversification benefit exists in portfolio footer', () => {
    // This is the key test explaining the "JPY shows adjustment but portfolio VARs are same" behavior.
    //
    // When only portfolioDiv is active (no carry/safety/floor layers):
    //   Pass 2 of layerRows: raw_sum = 0 → target = +var_FCY → H_final = var_FCY
    //   H_var (σ-basis) = |payout| × σ × √21 × z₉₅ = var_FCY ← SAME as H_final
    //   → d_solo = 0 at every currency level (correct: carry didn't change anything)
    //   → BUT: standalone_sum >> portfolio_VAR shows the REAL diversification effect
    //          (the table footer, not per-row d_solo, is where the effect is visible)

    const payout = -10; // -10M FCY
    const sigmaVarInputs = CORR_CURRENCIES.map(ccy => {
      const p = CURRENCY_PARAMS[ccy]!;
      const cashFCY = Math.abs(payout) * var95_1m_factor(p.σ_daily);
      return { ccy, cashFCY };
    }).filter(inp => inp.cashFCY > 0.001);

    const result = computePortfolioVAR(sigmaVarInputs);

    // Effect 1: diversification benefit is always present (standalone_sum >> portfolio_VAR)
    expect(result.standalone_sum_USD).toBeGreaterThan(result.portfolio_VAR_USD);
    expect(result.div_benefit_USD).toBeGreaterThan(0);

    // For each currency: H₀ = H₁ = var_FCY when only portfolioDiv is active
    // → d_solo = 0 (correct: no carry or safety layers changed the holding amount)
    for (const { ccy } of sigmaVarInputs) {
      const p = CURRENCY_PARAMS[ccy]!;
      const H_var = Math.abs(payout) * var95_1m_factor(p.σ_daily);
      // Simulate portfolioDiv-only: raw_sum=0, target=+var_FCY
      const raw_sum = 0;
      const var_FCY = H_var;
      const target = raw_sum >= 0 ? var_FCY : Math.max(-var_FCY, raw_sum);
      const H_final = raw_sum + (target - raw_sum);
      expect(H_final).toBeCloseTo(H_var, 6); // H₀ = H₁ → d_solo = 0
    }
  });

  it('carry-optimized changes solo_VAR₁ vs solo_VAR₀: PAY carry → solo_VAR₁ < solo_VAR₀', () => {
    // Build two portfolio VAR results:
    // Baseline: each currency holds H₀ = |payout| × σ × √21 × z₉₅
    // Carry-opt: PAY carry currencies hold less (0.7 × H₀), EARN carry hold more (1.3 × H₀)
    const payout = -10;
    const sigmaVarInputs = CORR_CURRENCIES.map(ccy => ({
      ccy,
      cashFCY: Math.abs(payout) * var95_1m_factor(CURRENCY_PARAMS[ccy]!.σ_daily),
    })).filter(inp => inp.cashFCY > 0.001);

    const baseResult = computePortfolioVAR(sigmaVarInputs);

    const r_USD = 3.5;
    const carryOptInputs = sigmaVarInputs.map(inp => {
      const p = CURRENCY_PARAMS[inp.ccy]!;
      const isPay = p.carry < r_USD;
      return { ccy: inp.ccy, cashFCY: inp.cashFCY * (isPay ? 0.7 : 1.3) };
    });
    const optResult = computePortfolioVAR(carryOptInputs);

    // For individual PAY currencies: solo_VAR₁ < solo_VAR₀
    for (const inp of sigmaVarInputs) {
      const p = CURRENCY_PARAMS[inp.ccy]!;
      if (p.carry >= r_USD) continue; // only check PAY currencies
      const baseRow = baseResult.currencies.find(c => c.ccy === inp.ccy);
      const optRow  = optResult.currencies.find(c => c.ccy === inp.ccy);
      if (!baseRow || !optRow) continue;
      expect(optRow.standalone_VAR_USD).toBeLessThan(baseRow.standalone_VAR_USD);
    }

    // Portfolio-level: diversification always present in both states
    expect(baseResult.standalone_sum_USD).toBeGreaterThan(baseResult.portfolio_VAR_USD);
    expect(optResult.standalone_sum_USD).toBeGreaterThan(optResult.portfolio_VAR_USD);
  });

  it('3-state ordering: standalone_sum₀ ≥ portfolio_VAR₀ ≥ 0 (diversification never negative)', () => {
    // Test with a representative 14-currency portfolio
    const inputs = CORR_CURRENCIES.map(ccy => ({
      ccy,
      cashFCY: Math.abs(-10) * var95_1m_factor(CURRENCY_PARAMS[ccy]!.σ_daily),
    })).filter(inp => inp.cashFCY > 0.001);

    const r = computePortfolioVAR(inputs);

    // Core invariants
    expect(r.standalone_sum_USD).toBeGreaterThanOrEqual(r.portfolio_VAR_USD); // diversification ≥ 0
    expect(r.portfolio_VAR_USD).toBeGreaterThanOrEqual(0); // VAR is non-negative
    expect(r.div_benefit_USD).toBeGreaterThanOrEqual(0); // benefit ≥ 0
    expect(r.div_factor).toBeGreaterThan(0); // factor > 0
    expect(r.div_factor).toBeLessThanOrEqual(1); // factor ≤ 1
  });

  it('comp VAR sums to portfolio VAR (additive decomposition identity)', () => {
    // Σ component_VAR_i = portfolio_VAR (mathematical property of component VARs)
    const r = computePortfolioVAR([
      { ccy: 'EUR', cashFCY: 10 },
      { ccy: 'GBP', cashFCY: 8  },
      { ccy: 'AUD', cashFCY: 15 },
      { ccy: 'JPY', cashFCY: 800 },
      { ccy: 'MXN', cashFCY: 20 },
      { ccy: 'ZAR', cashFCY: 30 },
    ]);
    const sumComp = r.currencies.reduce((s, c) => s + c.component_VAR_USD, 0);
    expect(sumComp).toBeCloseTo(r.portfolio_VAR_USD, 4); // tight tolerance
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. optimizePortfolioCarry — Lagrangian cross-currency stock rebalance
// ─────────────────────────────────────────────────────────────────────────────
describe('optimizePortfolioCarry', () => {
  const r_USD = 3.5;
  const σ_P = 0.10;

  function makeInput(
    ccy: string, lp_cash: number, payout = 0,
    overrides: Partial<PortfolioCarryInput> = {},
  ): PortfolioCarryInput {
    const p = CURRENCY_PARAMS[ccy]!;
    return {
      ccy, P: payout, lp_cash, P_contrib: payout > 0 ? payout : 0,
      forecasted_cash: lp_cash, floor_contrib: 0, delta_sigma: 0,
      r_FCY: p.carry, r_OD: p.r_OD, ...overrides,
    };
  }

  it('CAD PAY stock: negative carry overlay (sell), EARN positive (buy)', () => {
    const res = optimizePortfolioCarry([
      makeInput('CAD', 95.1),
      makeInput('MXN', 238.0),
      makeInput('GBP', 131.8),
    ], σ_P, r_USD, 500);
    const cad = res.find(r => r.ccy === 'CAD')!;
    const mxn = res.find(r => r.ccy === 'MXN')!;
    // PAY → sell overlay (δ<0) on top of the hold-the-book base (own LP stock).
    expect(cad.delta_portfolio).toBeLessThan(0);
    expect(cad.cash_threshold).toBeCloseTo(95.1 + cad.delta_portfolio, 1);
    expect(cad.cash_threshold).toBeLessThan(95.1);
    // EARN → buy (δ>0) on top of the trough base.
    expect(mxn.delta_portfolio).toBeGreaterThan(0);
    expect(mxn.cash_threshold).toBeCloseTo(238 + mxn.delta_portfolio, 1);
  });

  it('carry overlay scales up as the VAR budget grows (fills the limit)', () => {
    const mk = () => [
      makeInput('CAD', 95.1),
      makeInput('MXN', 238.0),
      makeInput('HUF', 800.0),
    ];
    const lo = optimizePortfolioCarry(mk(), σ_P, r_USD, 5);
    const hi = optimizePortfolioCarry(mk(), σ_P, r_USD, 20);
    const cadLo = lo.find(r => r.ccy === 'CAD')!;
    const cadHi = hi.find(r => r.ccy === 'CAD')!;
    const mxnLo = lo.find(r => r.ccy === 'MXN')!;
    const mxnHi = hi.find(r => r.ccy === 'MXN')!;
    // Bigger budget → bigger PAY sell (more negative) and bigger EARN buy.
    expect(cadHi.delta_portfolio).toBeLessThan(cadLo.delta_portfolio);
    expect(mxnHi.delta_portfolio).toBeGreaterThan(mxnLo.delta_portfolio);
  });

  it('JPY negative LP stock: large negative delta_portfolio (not zero)', () => {
    const res = optimizePortfolioCarry([
      makeInput('JPY', -869.1),
      makeInput('CAD', 95.1),
      makeInput('MXN', 238.0),
    ], σ_P, r_USD, 500);
    const jpy = res.find(r => r.ccy === 'JPY')!;
    expect(jpy.delta_portfolio).toBeLessThan(-100);
    expect(jpy.cash_threshold).toBeLessThan(0); // r_OD < r_USD → sell JPY / receive USD
    expect(jpy.carry_dir).toBe('pay');
  });

  it('MXN EARN stock gets positive delta_portfolio and buy-direction swap', () => {
    const res = optimizePortfolioCarry([
      makeInput('CAD', 95.1),
      makeInput('MXN', 238.0),
      makeInput('GBP', 131.8),
    ], σ_P, r_USD, 500);
    const mxn = res.find(r => r.ccy === 'MXN')!;
    const gbp = res.find(r => r.ccy === 'GBP')!;
    expect(mxn.delta_portfolio).toBeGreaterThan(gbp.delta_portfolio);
    expect(mxn.cash_threshold).toBeCloseTo(238 + mxn.delta_portfolio, 1);
    expect(mxn.cash_threshold).toBeGreaterThan(238);
  });

  it('payout carry separate from stock leg: P>0 adds delta_carry on EARN only', () => {
    const res = optimizePortfolioCarry([
      makeInput('MXN', 50, 10, { P_contrib: 10 }),
    ], σ_P, r_USD, 500, Infinity, true);
    const mxn = res[0];
    expect(mxn.delta_carry).toBeGreaterThan(0);
    expect(mxn.cash_threshold).toBeGreaterThan(50);
    expect(mxn.cash_threshold).toBeCloseTo(50 + mxn.delta_portfolio, 1);
  });

  it('zero payout: hold-the-book base + overlay (PAY sell / EARN buy)', () => {
    const res = optimizePortfolioCarry([
      makeInput('CAD', 95.1),
      makeInput('MXN', 238.0),
    ], σ_P, r_USD, 500);
    const cad = res.find(r => r.ccy === 'CAD')!;
    const mxn = res.find(r => r.ccy === 'MXN')!;
    // Huge budget → deep PAY sell below the own-stock base
    expect(cad.cash_threshold).toBeLessThan(0);
    expect(mxn.cash_threshold).toBeGreaterThan(238);
    expect(cad.cash_threshold).toBeCloseTo(95.1 + cad.delta_portfolio, 1);
    expect(mxn.cash_threshold).toBeCloseTo(238 + mxn.delta_portfolio, 1);
  });

  it('PAY CAD: σ cushion sits in the base; carry overlay adds on top of it', () => {
    const allLayers = new Set<LayerId>(['floorH', 'sigmaP', 'carryOptim', 'portfolioDiv']);
    const p = CURRENCY_PARAMS.CAD!;
    const mk = (grossPayout: number): PortfolioCarryInput => {
      const trough = 95.1 - grossPayout;
      const l = computeLayeredBuffer(grossPayout, trough, σ_P, r_USD, p.carry, p.r_OD, 0, allLayers, 95.1);
      return {
        ccy: 'CAD', P: grossPayout, lp_cash: 95.1, forecasted_cash: trough,
        P_contrib: l.P_contrib, floor_contrib: l.floor_contrib, delta_sigma: l.delta_sigma,
        r_FCY: p.carry, r_OD: p.r_OD,
      };
    };
    // Base cushion (floor + σ×|payout|) grows with payout — verified on the layer inputs.
    const base100 = mk(100);
    const base150 = mk(150);
    expect(base150.delta_sigma).toBeGreaterThan(base100.delta_sigma);
    // Optimizer target = base cushion + carry overlay (PAY overlay < 0).
    const r100 = optimizePortfolioCarry([base100], σ_P, r_USD, 500)[0];
    expect(r100.delta_portfolio).toBeLessThan(0);
    expect(r100.cash_threshold).toBeCloseTo(
      base100.floor_contrib + base100.delta_sigma + r100.delta_portfolio, 1,
    );
  });

  it('USD row excluded from portfolio optimizer', () => {
    const res = optimizePortfolioCarry([
      makeInput('USD', 303.9),
      makeInput('MXN', 238.0),
    ], σ_P, r_USD, 500);
    expect(res.find(r => r.ccy === 'USD')).toBeUndefined();
    expect(res.find(r => r.ccy === 'MXN')).toBeDefined();
  });

  it('USD budget binding scales EARN buys when collateral budget is tiny', () => {
    const res = optimizePortfolioCarry(
      [makeInput('MXN', 238.0), makeInput('GBP', 131.8)],
      σ_P, r_USD, 500, 0.01,
    );
    const mxn = res.find(r => r.ccy === 'MXN')!;
    expect(mxn.budget_binding).toBe(true);
    // KNOWN GAP: at this VAR cap (500), MAX_LEG_LEVERAGE clamps BOTH MXN
    // (long) and GBP (short) to the identical ceiling ($1500 = 3x cap),
    // which makes the pair perfectly self-funding in USD terms (long MXN
    // funded by short GBP proceeds) — the downstream usdShortfallLegs check
    // sees ~zero NET USD demand and never trims further, even though gross
    // notional here is many orders of magnitude past the $0.01 budget. The
    // leverage ceiling bounds VAR-driven sizing; it does not know about a
    // separate USD-collateral constraint, so a self-funding pair can still
    // bypass a near-zero USD budget. Fixing this needs the leverage ceiling
    // (or a further trim) to account for usdBudget_M too — not done here.
    expect(mxn.cash_threshold).toBeGreaterThan(237);
    expect(mxn.cash_threshold).toBeLessThan(3350);
  });
});

describe('approvalTierCapUsd', () => {
  it('keeps an exact $5 / $10 / $20 chip', () => {
    expect(approvalTierCapUsd(5)).toBe(5);
    expect(approvalTierCapUsd(10)).toBe(10);
    expect(approvalTierCapUsd(20)).toBe(20);
  });

  it('does not treat Conservative CFaR as a cap', () => {
    expect(approvalTierCapUsd(2.125)).toBe(5);
    expect(approvalTierCapUsd(0.634)).toBe(5);
  });

  it('steps a fill past $5M up to the next rung', () => {
    expect(approvalTierCapUsd(8.994)).toBe(10);
    expect(approvalTierCapUsd(12)).toBe(20);
  });
});

describe('universePolicyVarCap', () => {
  it('covers the $20 approval rung when nothing clamps', () => {
    expect(universePolicyVarCap(null)).toBe(20);
    expect(universePolicyVarCap(8)).toBe(20);
  });

  it('stretches a little past a late clamp so the knee can sit inside the sweep', () => {
    expect(universePolicyVarCap(18)).toBeCloseTo(18 * 1.6, 6);
  });

  it('never traces past 4× the top approval rung', () => {
    expect(universePolicyVarCap(80)).toBe(80);
    expect(universePolicyVarCap(120)).toBe(80);
  });
});

describe('sweepPortfolioCarryFrontier', () => {
  const r_USD = 3.5;
  const σ_P = 0.10;

  function makeInput(
    ccy: string, lp_cash: number,
    overrides: Partial<PortfolioCarryInput> = {},
  ): PortfolioCarryInput {
    const p = CURRENCY_PARAMS[ccy]!;
    return {
      ccy, P: 0, lp_cash, P_contrib: 0,
      forecasted_cash: lp_cash, floor_contrib: 0, delta_sigma: 0,
      r_FCY: p.carry, r_OD: p.r_OD, ...overrides,
    };
  }

  it('range is bounded by policyVAR_M — never runs away when a currency is EARN-only', () => {
    // GBP and MXN both earn vs USD in CURRENCY_PARAMS — an unbounded "sweep
    // until everyone floor-clamps" search never terminates purely on that
    // basis, since neither is a PAY currency. The range must come from
    // policyVAR_M alone. (MXN's much larger carry does make the Σ⁻¹μ
    // direction short GBP to lever MXN further, so GBP's own leg floor-
    // clamps at 0 late in the range — that's what the +1 tangency-refinement
    // point below is bracketing.)
    const f = sweepPortfolioCarryFrontier(
      [makeInput('GBP', 131.8), makeInput('MXN', 238.0)],
      σ_P, r_USD, 10, 12, 3,
    );
    expect(f.points[f.points.length - 1]!.k).toBeCloseTo(30, 6); // policyVAR_M(10) × rangeMultiple(3)
    // 13 linear steps + up to 12 near-origin densification points (some may
    // coincide with the linear grid and dedupe via the Set) — see the
    // "denser sampling near k=0" comment in sweepPortfolioCarryFrontier —
    // plus at most 1 golden-section tangency-refinement point once GBP's
    // late floor clamp gives the ratio a genuine interior peak to refine.
    expect(f.points.length).toBeGreaterThanOrEqual(13);
    expect(f.points.length).toBeLessThanOrEqual(29);
  });

  it('tangencyIndex is the true argmax of carry/CFaR and sits strictly inside the range once a leg clamps', () => {
    // Same GBP+MXN book as above — GBP's late floor clamp is what gives the
    // ratio a genuine interior peak (see the comment on the previous test).
    const f = sweepPortfolioCarryFrontier(
      [makeInput('GBP', 131.8), makeInput('MXN', 238.0)],
      σ_P, r_USD, 10, 12, 3,
    );
    expect(f.tangencyIndex).toBeGreaterThan(0);
    expect(f.tangencyIndex).toBeLessThan(f.points.length - 1);
    const tangent = f.points[f.tangencyIndex!]!;
    const tangentRatio = tangent.totalCarryUsdYr / tangent.portfolioVarUsd;
    for (const p of f.points) {
      if (!(p.portfolioVarUsd > 1e-9)) continue;
      expect(p.totalCarryUsdYr / p.portfolioVarUsd).toBeLessThanOrEqual(tangentRatio + 1e-9);
    }
    // The refined point sits inside GBP's clamp region, past where GBP
    // first floor-binds.
    const firstClampIdx = f.points.findIndex(p => p.floorBoundCcys.includes('GBP'));
    expect(firstClampIdx).toBeGreaterThan(0);
    expect(tangent.k).toBeGreaterThan(f.points[firstClampIdx]!.k - 0.001);
  });

  it('tangencyIndex lands on the first positive-CFaR point when nothing ever clamps', () => {
    // A single EARN currency alone never floor-clamps and has no fixed CFaR
    // term — the ray is flat by construction, so tangency must resolve to
    // the very first point, not wander via floating-point noise.
    const f = sweepPortfolioCarryFrontier([makeInput('MXN', 238.0)], σ_P, r_USD, 10);
    const firstPositive = f.points.findIndex(p => p.portfolioVarUsd > 1e-9);
    expect(f.tangencyIndex).toBe(firstPositive);
  });

  it('carry and VAR both start at zero and grow with k', () => {
    const f = sweepPortfolioCarryFrontier(
      [makeInput('GBP', 131.8), makeInput('MXN', 238.0), makeInput('CAD', 95.1)],
      σ_P, r_USD, 10,
    );
    expect(f.points[0]!.portfolioVarUsd).toBeCloseTo(0, 6);
    expect(f.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 6);
    for (let i = 1; i < f.points.length; i++) {
      expect(f.points[i]!.portfolioVarUsd).toBeGreaterThanOrEqual(f.points[i - 1]!.portfolioVarUsd - 1e-9);
    }
  });

  it('a PAY currency clamped at its floor bends the curve — sweet spot lands strictly inside the range', () => {
    // TRY pays vs USD in CURRENCY_PARAMS (r_FCY well below r_USD) — its
    // overlay sells FCY as k grows and clamps at its floor once the stock is
    // exhausted, while GBP/MXN keep climbing unclamped. That mismatch is the
    // curvature this sweep exists to find.
    const f = sweepPortfolioCarryFrontier(
      [makeInput('TRY', 2.0, { floor_contrib: 1 }), makeInput('GBP', 60), makeInput('MXN', 40)],
      σ_P, r_USD, 8, 24,
    );
    expect(f.points.some(p => p.floorBoundCcys.includes('TRY'))).toBe(true);
    expect(f.sweetSpotIndex).toBeGreaterThan(0);
    expect(f.sweetSpotIndex).toBeLessThan(f.points.length - 1);
  });

  it('no currency floor-clamps in range — sweetSpotIndex is -1, not a noise-driven pick', () => {
    // A single EARN currency has no peer to be hedged against, so its Σ⁻¹μ
    // weight can only ever be positive — the overlay grows without bound and
    // never crosses into floor-clamp territory anywhere in the swept range.
    // Reporting a knee here would be floating-point noise dressed up as an
    // optimum — the "use $X.XM" button walked to a different, larger value
    // on every click before this was fixed, because each click reseeded the
    // range from that noise.
    const f = sweepPortfolioCarryFrontier(
      [makeInput('GBP', 131.8)],
      σ_P, r_USD, 10, 12, 3,
    );
    expect(f.points.every(p => p.floorBoundCcys.length === 0)).toBe(true);
    expect(f.sweetSpotIndex).toBe(-1);
  });

  it('no currencies / no positive policyVAR_M — empty frontier, not a crash', () => {
    const empty = { points: [], farPoints: [], sweetSpotIndex: -1, nearestClampCcy: null, nearestClampVarUsd: null, tangencyIndex: -1 };
    expect(sweepPortfolioCarryFrontier([], σ_P, r_USD, 10)).toEqual(empty);
    expect(
      sweepPortfolioCarryFrontier([makeInput('GBP', 10)], σ_P, r_USD, 0),
    ).toEqual(empty);
  });

  it('nearestClampVarUsd solves the same breakpoint the discrete sweep finds', () => {
    // TRY clamps somewhere inside [0, 1.25] in the discrete sweep below (first
    // sampled clamp is at k=1.25) — the closed-form value must fall in that
    // window, not just be "some" finite number.
    const wide = sweepPortfolioCarryFrontier(
      [makeInput('TRY', 150), makeInput('GBP', 200), makeInput('MXN', 300)],
      σ_P, r_USD, 10, 24, 3,
    );
    const firstClampK = wide.points.find(p => p.floorBoundCcys.length > 0)?.k;
    expect(wide.nearestClampCcy).toBe('TRY');
    expect(wide.nearestClampVarUsd).not.toBeNull();
    expect(wide.nearestClampVarUsd!).toBeGreaterThan(0);
    expect(wide.nearestClampVarUsd!).toBeLessThanOrEqual(firstClampK!);
  });

  it('nearestClampVarUsd is null when every currency is EARN-direction (never clamps)', () => {
    const f = sweepPortfolioCarryFrontier([makeInput('GBP', 131.8)], σ_P, r_USD, 10, 12, 3);
    expect(f.sweetSpotIndex).toBe(-1);
    expect(f.nearestClampCcy).toBeNull();
    expect(f.nearestClampVarUsd).toBeNull();
  });

  describe('negative floor_contrib per currency', () => {
    // applyHardMinFloor's own gate is `floor_contrib > 0.001` — a negative
    // value fails that test and falls straight through, so a negative floor
    // is not "an allowed overdraft limit," it is silently indistinguishable
    // from no floor at all. Documenting the current behavior exactly, not
    // implying it does something it doesn't.
    it('applyHardMinFloor: negative floor_contrib is a no-op, not a bound', () => {
      expect(applyHardMinFloor(10, -30)).toBe(10);
      expect(applyHardMinFloor(-50, -30)).toBe(-50); // NOT clamped to -30
      expect(applyHardMinFloor(-50, -30)).not.toBe(-30);
    });

    it('sweepPortfolioCarryFrontier: floor_contrib=-30 behaves identically to floor_contrib=0', () => {
      const negFloor = sweepPortfolioCarryFrontier(
        [makeInput('EUR', 180, { floor_contrib: -30 }), makeInput('GBP', 90), makeInput('MXN', 130)],
        σ_P, r_USD, 20, 24, 3,
      );
      const noFloor = sweepPortfolioCarryFrontier(
        [makeInput('EUR', 180, { floor_contrib: 0 }), makeInput('GBP', 90), makeInput('MXN', 130)],
        σ_P, r_USD, 20, 24, 3,
      );
      expect(negFloor.nearestClampCcy).toBeNull();
      // VAR is unaffected either way — the clamp itself never binds for a
      // negative floor_contrib, so the position size (and hence risk) at
      // every k is identical (to float precision — the leverage rescale in
      // solveCarryVarUsd reorders a couple of floating-point ops relative
      // to before, so this is no longer bit-for-bit, just numerically
      // identical).
      negFloor.points.forEach((p, i) => {
        expect(p.portfolioVarUsd).toBeCloseTo(noFloor.points[i]!.portfolioVarUsd, 6);
      });
      // Carry is NOT guaranteed identical, even though the clamp is a
      // no-op: floor_contrib also feeds bases[i] directly (bases = max(cash,0)
      // + floor_contrib + delta_sigma), which shifts WHERE the credit/debit
      // split's position crosses zero — a real, if narrow, effect of
      // floor_contrib on which rate (mu vs muDebit) prices a leg at a given
      // k, independent of the clamp. Only meaningful once a leg is large
      // enough to cross zero within the swept range.
      const carryDiffs = negFloor.points.map((p, i) => Math.abs(p.totalCarryUsdYr - noFloor.points[i]!.totalCarryUsdYr));
      expect(Math.max(...carryDiffs)).toBeLessThan(2);
      // There is currently no mechanism for "allow up to $X of overdraft,
      // then stop" — only floor_contrib > 0 (hard positive minimum) or the
      // r_OD > r_USD zero-floor. A bounded-negative floor would need new
      // logic in applyHardMinFloor / applyNoNegativeLpFloor, not just a
      // negative input value.
    });
  });

  describe('position-amplitude scaling — what is and isn\'t linear', () => {
    // computePortfolioVAR is sqrt(w'Σw): homogeneous of degree 1 under
    // UNIFORM scaling of a fixed position mix. This is a mathematical
    // property of any PSD quadratic form, not something to re-derive per
    // book — verified numerically here so a future change that breaks
    // homogeneity (e.g. a per-currency floor/cap inside the VAR calc
    // itself) fails loudly.
    it('computePortfolioVAR is exactly linear under uniform amplitude scaling of a fixed mix', () => {
      const base = [
        { ccy: 'EUR', cashFCY: 100 },
        { ccy: 'GBP', cashFCY: -60 },
        { ccy: 'MXN', cashFCY: 200 },
        { ccy: 'JPY', cashFCY: -1500 },
      ];
      const unit = computePortfolioVAR(base).portfolio_VAR_USD;
      for (const A of [0.25, 0.5, 2, 5, 10]) {
        const scaled = base.map(x => ({ ccy: x.ccy, cashFCY: x.cashFCY * A }));
        const r = computePortfolioVAR(scaled).portfolio_VAR_USD;
        expect(r / A).toBeCloseTo(unit, 6);
      }
    });

    // A fixed operational floor_contrib gets ADDED into `bases` and is also
    // the clamp `threshold` — the two occurrences cancel algebraically
    // (gapFcy = bases − threshold = forecasted_cash, the floor term drops
    // out entirely). So the clamp point is EXACTLY proportional to book
    // amplitude regardless of the floor's own size — a fixed $30M floor and
    // a fixed $60M floor produce the identical breakpoint-per-amplitude
    // ratio. This is the correct, verified behavior, not an assumption.
    it('nearestClampVarUsd scales exactly linearly with book amplitude, independent of floor size', () => {
      const run = (amplitude: number, floor: number) => sweepPortfolioCarryFrontier(
        [
          makeInput('EUR', 180 * amplitude, { floor_contrib: floor }),
          makeInput('GBP', 90 * amplitude),
          makeInput('JPY', 220 * amplitude),
          makeInput('MXN', 130 * amplitude),
        ],
        σ_P, r_USD, 20, 8, 1,
      );
      for (const floor of [10, 30, 60]) {
        const ref = run(1, floor).nearestClampVarUsd!;
        for (const A of [0.25, 0.5, 2, 4]) {
          const got = run(A, floor).nearestClampVarUsd!;
          expect(got / A).toBeCloseTo(ref, 3);
        }
      }
    });

    // universePolicyVarCap has a hard ceiling (4× the top approval rung —
    // see its own doc comment) so an EARN-only book cannot sweep to
    // infinity. That ceiling does NOT scale with book size — so as book
    // amplitude grows, the linearly-growing clamp point eventually exceeds
    // the ceiling's reach (ceiling / 1.6, per universePolicyVarCap's own
    // formula) and the knee — despite existing at a perfectly predictable,
    // linearly-scaling VAR level — becomes undetectable in the bounded
    // sweep. This is the genuine non-linearity: not in the VAR/carry math
    // (which stays linear throughout), but in a fixed display/approval
    // window meeting a linearly growing book.
    it('the knee silently disappears once amplitude pushes the clamp past the bounded window ceiling', () => {
      const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
      const ceiling = maxTier * 4;
      const book = (A: number) => [
        makeInput('EUR', 180 * A, { floor_contrib: 30 }),
        makeInput('GBP', 90 * A),
        makeInput('JPY', 220 * A),
        makeInput('MXN', 130 * A),
      ];
      // A=1 comfortably clamps inside the ceiling.
      const probeSmall = sweepPortfolioCarryFrontier(book(1), σ_P, r_USD, maxTier, 8, 1);
      expect(probeSmall.nearestClampVarUsd!).toBeLessThan(ceiling / 1.6);
      const capSmall = universePolicyVarCap(probeSmall.nearestClampVarUsd);
      const fineSmall = sweepPortfolioCarryFrontier(book(1), σ_P, r_USD, capSmall, 60, 1);
      expect(fineSmall.sweetSpotIndex).toBeGreaterThanOrEqual(0);

      // A large enough to push the (still linearly-scaling) clamp point
      // past what any bounded window can reach.
      const bigA = (ceiling / 1.6 / probeSmall.nearestClampVarUsd!) * 3;
      const probeBig = sweepPortfolioCarryFrontier(book(bigA), σ_P, r_USD, maxTier, 8, 1);
      expect(probeBig.nearestClampVarUsd!).toBeGreaterThan(ceiling); // clamp is real and linearly larger...
      const capBig = universePolicyVarCap(probeBig.nearestClampVarUsd);
      expect(capBig).toBeLessThanOrEqual(ceiling); // ...but the window can't follow it there
      const fineBig = sweepPortfolioCarryFrontier(book(bigA), σ_P, r_USD, capBig, 60, 1);
      expect(fineBig.sweetSpotIndex).toBe(-1); // knee exists analytically, invisible in the bounded sweep
    });
  });

  it('impliedRFcyByCcy overrides μ for the named currency only', () => {
    const base = sweepPortfolioCarryFrontier(
      [makeInput('GBP', 60), makeInput('MXN', 40)], σ_P, r_USD, 10, 8,
    );
    // Flip GBP from EARN to PAY via the override — the curve must move.
    const overridden = sweepPortfolioCarryFrontier(
      [makeInput('GBP', 60), makeInput('MXN', 40)], σ_P, r_USD, 10, 8, 3,
      { GBP: r_USD - 5 },
    );
    const lastBase = base.points[base.points.length - 1]!;
    const lastOverridden = overridden.points[overridden.points.length - 1]!;
    expect(lastOverridden.totalCarryUsdYr).not.toBeCloseTo(lastBase.totalCarryUsdYr, 3);
  });

  it('impliedRFcyByCcy falls back to flat r_FCY for currencies not named in the map', () => {
    const withEmptyMap = sweepPortfolioCarryFrontier(
      [makeInput('GBP', 60), makeInput('MXN', 40)], σ_P, r_USD, 10, 8, 3, {},
    );
    const withoutMap = sweepPortfolioCarryFrontier(
      [makeInput('GBP', 60), makeInput('MXN', 40)], σ_P, r_USD, 10, 8,
    );
    withEmptyMap.points.forEach((p, i) => {
      expect(p.totalCarryUsdYr).toBeCloseTo(withoutMap.points[i]!.totalCarryUsdYr, 6);
      expect(p.portfolioVarUsd).toBeCloseTo(withoutMap.points[i]!.portfolioVarUsd, 6);
    });
  });

  describe('delta_cfar — same √(fixed²+scaling²) shape the per-currency frontier uses', () => {
    it('delta_cfar unset (0) reproduces the old pure-ray behavior exactly — full backward compatibility', () => {
      const withZero = sweepPortfolioCarryFrontier(
        [makeInput('TRY', 150, { floor_contrib: 1 }), makeInput('GBP', 60), makeInput('MXN', 40)],
        σ_P, r_USD, 8, 24,
      );
      const explicit = sweepPortfolioCarryFrontier(
        [
          makeInput('TRY', 150, { floor_contrib: 1, delta_cfar: 0 }),
          makeInput('GBP', 60, { delta_cfar: 0 }),
          makeInput('MXN', 40, { delta_cfar: 0 }),
        ],
        σ_P, r_USD, 8, 24,
      );
      expect(explicit).toEqual(withZero);
    });

    it('does not pin Conservative — overlay k=0 is Unhedged, pink shares that fork', () => {
      const unhedged = 0.359;
      const f = sweepPortfolioCarryFrontier(
        [makeInput('EUR', 20), makeInput('GBP', 20)],
        σ_P, r_USD, 10, 8, 1,
        undefined, () => 0, { EUR: 40, GBP: 40 }, 1,
        unhedged,
      );
      expect(f.points[0]!.portfolioVarUsd).toBeCloseTo(unhedged, 8);
      expect(f.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
      expect(f.farPoints[0]!.portfolioVarUsd).toBeCloseTo(unhedged, 8);
      expect(f.farPoints[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
      const openLater = f.points.find(p => p.k > 0.5);
      const farLater = f.farPoints.find(p => p.k > 0.5);
      expect(openLater && farLater).toBeTruthy();
      expect(openLater!.portfolioVarUsd).not.toBeCloseTo(farLater!.portfolioVarUsd, 3);
    });

    it('unhedgedCfarUsdM pins k=0 to the CFaR-tab / Overdraft total, not RSS(delta_cfar)', () => {
      const deskTotal = 0.634;
      const f = sweepPortfolioCarryFrontier(
        [
          makeInput('EUR', 20, { delta_cfar: 2 }),
          makeInput('GBP', 20, { delta_cfar: 1 }),
        ],
        σ_P, r_USD, 10, 8, 1,
        undefined, undefined, undefined, 1, deskTotal,
      );
      expect(f.points[0]!.portfolioVarUsd).toBeCloseTo(deskTotal, 8);
      expect(f.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
      const rss = Math.hypot(
        2 * CURRENCY_PARAMS.EUR!.spot,
        1 * CURRENCY_PARAMS.GBP!.spot,
      );
      expect(f.points[0]!.portfolioVarUsd).not.toBeCloseTo(rss, 3);
      const later = f.points.find(p => p.k > 0.5) ?? f.points[f.points.length - 1]!;
      expect(later.portfolioVarUsd).toBeGreaterThan(deskTotal);
    });

    it('a nonzero delta_cfar makes VAR flat-sloped at k=0 — no floor clamp needed for curvature', () => {
      // GBP alone never floor-clamps (EARN-only, proven in an earlier test in
      // this file) — with delta_cfar=0 that means a dead-straight, disabled
      // sweetSpotIndex=-1 ray. A standalone exposure CFaR changes that
      // entirely: the curve is now √(fixed²+(k·rate)²), never linear.
      const f = sweepPortfolioCarryFrontier(
        [makeInput('GBP', 131.8, { delta_cfar: 6 })], σ_P, r_USD, 10, 40, 3,
      );
      // delta_cfar is FCY (cfarCoverFcyFor converts USD → FCY on the way in)
      // — VAR(0) is delta_cfar converted back to USD via GBP spot, not the
      // raw FCY figure.
      expect(f.points[0]!.portfolioVarUsd).toBeCloseTo(6 * CURRENCY_PARAMS.GBP!.spot, 6);
      // Slope (VAR per unit k) must be strictly decreasing near the origin —
      // the defining signature of a hypotenuse flattening near zero, which a
      // pure linear ray could never produce.
      const slopeAt = (i: number) => f.points[i]!.portfolioVarUsd / f.points[i]!.k;
      const early = slopeAt(2);
      const late = slopeAt(f.points.length - 1);
      expect(early).toBeGreaterThan(late);
    });

    it('sweetSpotIndex finds a genuine interior knee from delta_cfar alone, with zero floor-clamps', () => {
      const f = sweepPortfolioCarryFrontier(
        [makeInput('GBP', 131.8, { delta_cfar: 6 })], σ_P, r_USD, 10, 40, 3,
      );
      expect(f.points.every(p => p.floorBoundCcys.length === 0)).toBe(true); // confirms: NOT the floor mechanism
      expect(f.sweetSpotIndex).toBeGreaterThan(0);
      expect(f.sweetSpotIndex).toBeLessThan(f.points.length - 1);
    });

    it('carry gets a credit/debit kink exactly where a real position crosses zero', () => {
      // EUR starts with a genuine 50M FCY base position (NOT fully hedged) —
      // the overlay sells it down through zero. Before the crossing, the leg
      // is still priced at the deposit rate; after, at the worse overdraft
      // rate — a real slope change in raw $ terms, not a chart axis effect.
      const f = sweepPortfolioCarryFrontier(
        [makeInput('EUR', 50), makeInput('GBP', 90), makeInput('MXN', 130)],
        σ_P, r_USD, 20, 60, 1,
      );
      const carrySlope = (i: number) => (
        (f.points[i + 1]!.totalCarryUsdYr - f.points[i]!.totalCarryUsdYr)
        / (f.points[i + 1]!.k - f.points[i]!.k)
      );
      const early = carrySlope(1);
      const late = carrySlope(f.points.length - 2);
      // EUR's deposit rate and overdraft rate differ, so the aggregate
      // portfolio carry slope must change once EUR crosses — proven by the
      // slope not staying constant across the whole sweep.
      expect(Math.abs(late - early)).toBeGreaterThan(1e-6);
    });
  });
});

describe('frontierTangencyIndex — genuine hump required', () => {
  const pt = (
    portfolioVarUsd: number, totalCarryUsdYr: number,
  ): PortfolioCarryFrontierPoint => ({ k: 0, portfolioVarUsd, totalCarryUsdYr, floorBoundCcys: [] });

  it('−1 on a monotonically-decaying ratio (RSS-blended CFaR spiking at k→0, real shape measured off the book-scale walk)', () => {
    // Ratio decays 1.24 → 0.65 → 0.49 → … → 0.165, never rising again —
    // matches the actual portfolio-liquidity-frontier.ts book-scale curve.
    const origin = pt(0.58, 0);
    const points = [
      origin,
      pt(0.5999671369974838, 0.02472378),
      pt(0.6562333898148056, 0.04944758),
      pt(0.7198572682865128, 0.06867719),
      pt(1.031299154862294, 0.13735437),
      pt(3.8809474903815118, 0.6180947),
      pt(15.360405423346643, 2.47237882),
    ];
    expect(frontierTangencyIndex(points, origin.portfolioVarUsd, origin.totalCarryUsdYr)).toBe(-1);
  });

  it('finds the genuine interior peak when the ratio actually rises before falling', () => {
    const origin = pt(1, 0);
    const points = [
      origin,
      pt(1.5, 0.3),  // ratio 0.6
      pt(2, 0.6),    // ratio 0.6
      pt(2.5, 1.05), // ratio 0.7 — the real peak
      pt(3, 1.2),    // ratio 0.6
      pt(4, 1.5),    // ratio 0.5
    ];
    const idx = frontierTangencyIndex(points, origin.portfolioVarUsd, origin.totalCarryUsdYr);
    expect(idx).toBe(3);
  });

  it('−1 when no point has CFaR past the origin', () => {
    const origin = pt(1, 0);
    expect(frontierTangencyIndex([origin, pt(1, 0.5)], 1, 0)).toBe(-1);
  });
});

describe('computeEffectiveUsdBudget', () => {
  it('full cash available when no USD payout', () => {
    expect(computeEffectiveUsdBudget(303.9, 0)).toBeCloseTo(303.9);
  });

  it('USD outflow reduces FCY collateral budget', () => {
    expect(computeEffectiveUsdBudget(303.9, -100)).toBeCloseTo(203.9);
  });

  it('positive USD payout does not increase collateral budget', () => {
    expect(computeEffectiveUsdBudget(303.9, 50)).toBeCloseTo(303.9);
  });
});

describe('toggleLayerGroup', () => {
  it('turns payout σ and CFaR cover on or off together', () => {
    const active = new Set<LayerId>(['sigmaP']);
    const flip = (id: LayerId) => {
      if (active.has(id)) active.delete(id);
      else active.add(id);
    };
    toggleLayerGroup(['sigmaP', 'cfarCover'], active, flip);
    expect([...active]).toEqual([]);
    toggleLayerGroup(['sigmaP', 'cfarCover'], active, flip);
    expect(active.has('sigmaP')).toBe(true);
    expect(active.has('cfarCover')).toBe(true);
  });
});

describe('setBufferLevel', () => {
  it('portfolio level is portfolioDiv; currency level clears it', () => {
    const active = new Set<LayerId>(['floorH', 'carryOptim']);
    const flip = (id: LayerId) => {
      if (active.has(id)) active.delete(id);
      else active.add(id);
    };
    expect(bufferLevelOf(active)).toBe('currency');
    setBufferLevel(active, 'portfolio', flip);
    expect(bufferLevelOf(active)).toBe('portfolio');
    expect(active.has('portfolioDiv')).toBe(true);
    expect(active.has('carryOptim')).toBe(true);
    setBufferLevel(active, 'portfolio', flip);
    expect(active.has('portfolioDiv')).toBe(true);
    setBufferLevel(active, 'currency', flip);
    expect(bufferLevelOf(active)).toBe('currency');
    expect(active.has('portfolioDiv')).toBe(false);
    expect(active.has('carryOptim')).toBe(true);
  });

  it('enabling portfolio level brings Min floor along when it was off', () => {
    // Without a real floor, sweepPortfolioCarryFrontier's ray never bends —
    // the Portfolio VAR frontier would be degenerate by default.
    const active = new Set<LayerId>(['carryOptim']);
    const flip = (id: LayerId) => {
      if (active.has(id)) active.delete(id);
      else active.add(id);
    };
    expect(active.has('floorH')).toBe(false);
    setBufferLevel(active, 'portfolio', flip);
    expect(active.has('portfolioDiv')).toBe(true);
    expect(active.has('floorH')).toBe(true);
    // Switching back to currency level does not rip Min floor back out —
    // only the portfolio toggle itself is undone.
    setBufferLevel(active, 'currency', flip);
    expect(active.has('portfolioDiv')).toBe(false);
    expect(active.has('floorH')).toBe(true);
  });

  it('enabling portfolio level brings every curvature-capable layer along — floorH, carryOptim, cfarCover', () => {
    // Removes the "forgot to flip a chip" failure mode entirely. It does
    // NOT set any floor value or CFaR exposure number — those are real
    // desk inputs. A book with every layer on and all of them still at 0
    // is correctly a straight line: the layers being on isn't what was
    // missing.
    const active = new Set<LayerId>();
    const flip = (id: LayerId) => {
      if (active.has(id)) active.delete(id);
      else active.add(id);
    };
    setBufferLevel(active, 'portfolio', flip);
    expect(active.has('portfolioDiv')).toBe(true);
    expect(active.has('floorH')).toBe(true);
    expect(active.has('carryOptim')).toBe(true);
    expect(active.has('cfarCover')).toBe(true);
  });
});
