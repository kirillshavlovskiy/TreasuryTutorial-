/**
 * Unified FX simulator invariants — ALL requirements validated together.
 * Do not fix one column in isolation; any change must keep this suite green.
 */
import { describe, it, expect } from 'vitest';
import {
  INITIAL_ROWS, INITIAL_USD_PARAMS, sumFcySwapNearUsd, fcyToUsdM, netPayoutDeficit,
} from './fx-buffer';
import { computeDashboardModel } from './dashboard-model';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3 };
const ACTIVE = new Set(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'] as const);

function baseInput(payoutByCcy: Record<string, number> = {}) {
  return {
    rows: INITIAL_ROWS.map(r => payoutByCcy[r.ccy] !== undefined ? { ...r, payout: payoutByCcy[r.ccy]! } : r),
    usdCash: 303.9,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: SHARED,
    activeLayers: ACTIVE,
    policyVAR: 5.0,
  };
}

function openingLpUsd(m: ReturnType<typeof computeDashboardModel>) {
  return m.fcyComputed.reduce((s, r) => s + fcyToUsdM(r.cash, r.ccy), 0) + m.usdComputed.cash;
}

function postSwapUsdTotal(m: ReturnType<typeof computeDashboardModel>) {
  return m.fcyComputed.reduce((s, r) => s + r.postSwapUSD, 0) + m.usdComputed.postSwapUSD;
}

describe('FX simulator unified invariants', () => {
  const model = computeDashboardModel(baseInput());

  it('1. Zero-sum swap book: Σ(FCY swap×spot) + USD swap = 0', () => {
    const fcy = sumFcySwapNearUsd(model.fcyComputed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear })));
    expect(fcy + model.usdComputed.swapNear).toBeCloseTo(0, 0);
  });

  it('2. Target = LP+Swap = opening LP + swap', () => {
    for (const r of model.fcyComputed) {
      expect(r.cash_threshold).toBeCloseTo(r.cash + r.swapNear, 4);
      expect(r.cashThresholdUSD).toBeCloseTo(fcyToUsdM(r.cash_threshold, r.ccy), 4);
      expect(r.postSwapCash).toBeCloseTo(r.cash + r.swapNear, 4);
      expect(r.postSwapUSD).toBeCloseTo(fcyToUsdM(r.postSwapCash, r.ccy), 4);
      // Target and LP+Swap are the same funded position (swap sized to hit the target)
      expect(r.cash_threshold).toBeCloseTo(r.postSwapCash, 4);
    }
    const u = model.usdComputed;
    expect(u.cash_threshold).toBeCloseTo(u.cash + u.swapNear, 4);
    expect(u.postSwapCash).toBeCloseTo(u.cash + u.swapNear, 4);
  });

  it('3. TOTAL Target $USD = Σ opening LP $USD (swap zero-sum)', () => {
    expect(postSwapUsdTotal(model)).toBeCloseTo(openingLpUsd(model), 1);
  });

  it('4. Post-payout cushion = pre-swap cushion H* when no clamp binds', () => {
    for (const r of model.fcyComputed) {
      if (r.debit_floor_binding || r.usd_stress_trim || r.funding_binding) continue;
      expect(r.lp_after_swap_trough).toBeCloseTo(r.cash_threshold_pre_swap, 1);
    }
  });

  it('5. Cycle End = LP+Swap − payout + payins + fcast + Non-LP sweep', () => {
    for (const r of model.fcyComputed) {
      expect(r.cycleEndCash).toBeCloseTo(
        r.postSwapCash + r.payout + r.collections + r.fcastFX + r.nonLpCash, 4);
    }
    const u = model.usdComputed;
    expect(u.cycleEndCash).toBeCloseTo(
      u.postSwapCash + u.payout + u.collections + u.fcastFX + u.nonLpCash, 4);
  });

  it('6. Payout response: Target = LP+Swap rises to fund the payout gap + σ', () => {
    const cad0 = model.fcyComputed.find(r => r.ccy === 'CAD')!;
    const m100 = computeDashboardModel(baseInput({ CAD: -100 }));
    const cad100 = m100.fcyComputed.find(r => r.ccy === 'CAD')!;
    const dTarget = cad100.cash_threshold - cad0.cash_threshold;
    const dLpSwap = cad100.postSwapCash - cad0.postSwapCash;
    // Target = LP+Swap by construction, so they move together
    expect(dTarget).toBeCloseTo(dLpSwap, 4);
    // Hold-the-book: own cash (95.1) funds the payout first; the swap buys the
    // trough gap (100 − 95.1) plus the σ cushion — target rises by gap + σ.
    expect(dTarget).toBeGreaterThan(0);
    // Post-payout residual = the H* cushion that sized the swap (σ + carry overlay)
    expect(cad100.postSwapCash + cad100.payout)
      .toBeCloseTo(cad100.cash_threshold_pre_swap!, 1);
  });

  it('7. PAY CAD zero payout: swap sell; EARN rebalance when VAR limit allows', () => {
    const cad0 = model.fcyComputed.find(r => r.ccy === 'CAD')!;
    const loose = computeDashboardModel({ ...baseInput(), policyVAR: 20 });
    const gbpLoose = loose.fcyComputed.find(r => r.ccy === 'GBP')!;
    expect(gbpLoose.swapNear).toBeGreaterThan(0);
    expect(cad0.swapNear).toBeLessThan(0);
    expect(cad0.cash_threshold).toBeLessThan(cad0.cash);
  });

  it('7b. PAY CAD −150M: Target = LP+Swap rises with payout; swap buys the gap', () => {
    const cad0 = model.fcyComputed.find(r => r.ccy === 'CAD')!;
    const m150 = computeDashboardModel(baseInput({ CAD: -150 }));
    const cad = m150.fcyComputed.find(r => r.ccy === 'CAD')!;
    // Swap funds the trough gap (150 − 95.1 = 54.9) + σ cushion on top of hold
    expect(cad.postSwapCash).toBeGreaterThan(cad0.postSwapCash + 54.9);
    expect(cad.cash_threshold).toBeGreaterThan(cad0.cash_threshold + 54.9);
    expect(cad.swapNear).toBeGreaterThan(cad0.swapNear);
  });

  it('8. USD swap is mechanical funding leg only', () => {
    const fcy = sumFcySwapNearUsd(model.fcyComputed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear })));
    expect(model.usdComputed.swapNear).toBeCloseTo(-fcy, 1);
  });

  it('9. Net FX $USD book sums to zero', () => {
    const net = model.fcyComputed.reduce((s, r) => s + r.netFxUSD, 0) + model.usdComputed.netFxUSD;
    expect(net).toBeCloseTo(0, 2);
  });
});

describe('Min floor is a hard lower bound (floorH enabled)', () => {
  const FLOOR = 10;

  function flooredInput(overrides: Partial<ReturnType<typeof baseInput>> = {}, payoutByCcy: Record<string, number> = {}) {
    const base = baseInput(payoutByCcy);
    return {
      ...base,
      rows: base.rows.map(r => ({ ...r, cash_floor: FLOOR })),
      ...overrides,
    };
  }

  function assertFloorHeld(m: ReturnType<typeof computeDashboardModel>) {
    for (const r of m.fcyComputed) {
      expect(r.cash_threshold_pre_swap, `${r.ccy} target cushion`).toBeGreaterThanOrEqual(FLOOR - 1e-6);
      expect(r.lp_after_swap_trough!, `${r.ccy} trough after swap`).toBeGreaterThanOrEqual(FLOOR - 1e-6);
    }
  }

  it('holds at base state with all layers on', () => {
    assertFloorHeld(computeDashboardModel(flooredInput()));
  });

  it('holds under heavy payouts', () => {
    assertFloorHeld(computeDashboardModel(flooredInput({}, { CAD: -200, GBP: -150, EUR: -300, MXN: -400 })));
  });

  it('holds under a tight portfolio VAR limit', () => {
    assertFloorHeld(computeDashboardModel(flooredInput({ policyVAR: 0.5 })));
  });

  it('holds under USD liquidity stress', () => {
    assertFloorHeld(computeDashboardModel(flooredInput({ usdCash: 5, usdNonLpCash: 0 }, { EUR: -500, GBP: -300 })));
  });

  it('holds with carry layer selling PAY rows (no portfolio layer)', () => {
    const active = new Set(['sigmaP', 'carryOptim', 'floorH'] as const);
    assertFloorHeld(computeDashboardModel({ ...flooredInput(), activeLayers: active }));
  });

  it('holds with floor layer alone', () => {
    const active = new Set(['floorH'] as const);
    assertFloorHeld(computeDashboardModel({ ...flooredInput(), activeLayers: active }));
  });
});
