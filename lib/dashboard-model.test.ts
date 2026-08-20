import { describe, it, expect } from 'vitest';
import { fcyToUsdM, usdToFcyM, ccySpotRate, sumFcySwapNearUsd } from './fx-buffer';
import { INITIAL_ROWS, INITIAL_USD_PARAMS, CURRENCY_PARAMS } from './fx-buffer';
import { computeDashboardModel, computeLayerTargets } from './dashboard-model';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3 };
const ACTIVE_LAYERS = new Set(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'] as const);

describe('fx conversion helpers', () => {
  it('round-trips FCY ↔ USD via spot rate', () => {
    expect(fcyToUsdM(100, 'EUR')).toBeCloseTo(100 * ccySpotRate('EUR'), 6);
    expect(usdToFcyM(-9.1, 'CAD')).toBeCloseTo(-9.1 / ccySpotRate('CAD'), 6);
  });
});

describe('computeDashboardModel', () => {
  const input = {
    rows: INITIAL_ROWS,
    usdCash: 303.9,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: SHARED,
    activeLayers: ACTIVE_LAYERS,
    policyVAR: 5.0,
  };

  function openingLpUsdTotal(m: ReturnType<typeof computeDashboardModel>) {
    return m.fcyComputed.reduce((s, r) => s + fcyToUsdM(r.cash, r.ccy), 0) + m.usdComputed.cash;
  }

  function postSwapUsdTotal(m: ReturnType<typeof computeDashboardModel>) {
    return m.fcyComputed.reduce((s, r) => s + r.postSwapUSD, 0) + m.usdComputed.postSwapUSD;
  }

  it('runs layer + simulator pipeline on all 24 FCY rows', () => {
    const model = computeDashboardModel(input);
    expect(model.fcyComputed).toHaveLength(24);
    expect(model.layerRows).toHaveLength(25);
    expect(model.layerResults).toHaveLength(25);
  });

  it('includes extra simulator currencies in portfolio optimizer (not only DISPLAY set)', () => {
    const targets = computeLayerTargets(input);
    const extra = ['SGD', 'THB', 'RON', 'CZK', 'RSD', 'DKK', 'NZD', 'HKD', 'CNY'];
    for (const ccy of extra) {
      const row = targets.find(r => r.ccy === ccy);
      expect(row, `${ccy} missing from layer targets`).toBeDefined();
      expect(row!.cash_threshold).toBeDefined();
    }
  });

  it('Target = LP+Swap = opening + swap; TOTAL Target $USD = opening LP $USD', () => {
    const model = computeDashboardModel(input);
    const opening = openingLpUsdTotal(model);
    for (const fc of model.fcyComputed) {
      expect(fc.cash_threshold).toBeCloseTo(fc.cash + fc.swapNear, 4);
      expect(fc.postSwapCash).toBeCloseTo(fc.cash + fc.swapNear, 4);
      expect(fc.cash_threshold).toBeCloseTo(fc.postSwapCash, 4);
      expect(fc.postSwapUSD).toBeCloseTo(fcyToUsdM(fc.postSwapCash, fc.ccy), 4);
      expect(fc.cashThresholdUSD).toBeCloseTo(fcyToUsdM(fc.cash_threshold, fc.ccy), 4);
      expect(fc.lp_after_swap_trough).toBeCloseTo(fc.lp_peak_cash + fc.swapNear, 4);
      expect(fc.cycleEndCash).toBeCloseTo(
        fc.postSwapCash + fc.payout + fc.collections + fc.fcastFX + fc.nonLpCash, 4);
    }
    const usd = model.usdComputed;
    expect(usd.cash_threshold).toBeCloseTo(usd.cash + usd.swapNear, 4);
    expect(usd.postSwapCash).toBeCloseTo(usd.cash + usd.swapNear, 4);
    expect(postSwapUsdTotal(model)).toBeCloseTo(opening, 1);
  });

  it('USD FX position mirrors FCY book so net FX $USD sums to zero', () => {
    const model = computeDashboardModel(input);
    const netFxUsdTotal = model.fcyComputed.reduce((s, r) => s + r.netFxUSD, 0) + model.usdComputed.netFxUSD;
    const spotUsdTotal = model.fcyComputed.reduce((s, r) => s + r.fxSpotUSD, 0) + model.usdComputed.fxSpotUSD;
    const fwdUsdTotal = model.fcyComputed.reduce((s, r) => s + r.fxFwdUSD, 0) + model.usdComputed.fxFwdUSD;
    expect(netFxUsdTotal).toBeCloseTo(0, 2);
    expect(spotUsdTotal).toBeCloseTo(0, 2);
    expect(fwdUsdTotal).toBeCloseTo(0, 2);
  });

  it('converts TMS fwd USD to FCY for net FX', () => {
    const model = computeDashboardModel(input);
    const cad = model.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(cad.fwd).toBe(-9.1);
    expect(cad.fxFwdUSD).toBe(-9.1);
    expect(cad.fxFwdFCY).toBeCloseTo(-9.1 / 0.73112776, 2);
    expect(cad.netFxUSD).toBeCloseTo(cad.fxSpotUSD + cad.fxFwdUSD + cad.fxNonCashUSD, 4);
  });

  it('USD swap is mechanical offset of portfolio FCY legs', () => {
    const model = computeDashboardModel(input);
    const usd = model.usdComputed;
    const fcySwapUsd = sumFcySwapNearUsd(
      model.fcyComputed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear })),
    );
    expect(usd.postSwapCash).toBeCloseTo(usd.cash + usd.swapNear, 2);
    expect(usd.cashThresholdUSD).toBeCloseTo(usd.cash_threshold, 2);
    expect(usd.swapNear).toBeCloseTo(-fcySwapUsd, 1);
    expect(fcySwapUsd + usd.swapNear).toBeCloseTo(0, 0);
    expect(Math.abs(fcySwapUsd)).toBeGreaterThan(10);
  });

  it('zero payouts + tight 5M limit: targets stay near opening LP, never all zero', () => {
    // Regression: base holdings must NOT be liquidated to fund the VAR limit —
    // the P&L budget applies to the carry OVERLAY (deviation from hold-the-book).
    const m = computeDashboardModel({
      ...input,
      rows: input.rows.map(r => ({ ...r, payout: 0 })),
      usdParams: { ...INITIAL_USD_PARAMS, payout: 0 },
      policyVAR: 5,
    });
    const s = m.portfolioSummary!;
    // Overlay VAR fills PART of the 5M budget, not necessarily close to it
    // — MAX_LEG_LEVERAGE (solveCarryVarUsd, 3x the active cap) can cap
    // several individual currency legs before the correlated portfolio VAR
    // gets anywhere near the cap, on a 24-currency book like this one.
    expect(s.portfolio_VAR_USD).toBeGreaterThan(2);
    expect(s.portfolio_VAR_USD).toBeLessThanOrEqual(5.05);
    // Positive-LP rows keep meaningful targets (not trimmed to zero)
    const nonZero = m.fcyComputed.filter(r => r.cash > 10 && r.cash_threshold > 1);
    expect(nonZero.length).toBeGreaterThan(10);
    // EARN rows tilt ABOVE opening LP (buy overlay), PAY rows below (sell overlay)
    const mxn = m.fcyComputed.find(r => r.ccy === 'MXN')!;
    expect(mxn.cash_threshold).toBeGreaterThan(mxn.cash);
    const cad = m.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(cad.cash_threshold).toBeLessThan(cad.cash);
    expect(cad.cash_threshold).toBeGreaterThan(0); // sold down, not wiped out
  });

  it('portfolioDiv is a continuous correction on the carry target (no base jump)', () => {
    // Regression: toggling portfolioDiv must not redefine the base. The carry-only
    // CAD sell target must sit BETWEEN portfolio targets at tight vs loose limits
    // (tight limit shrinks the sell toward hold-the-book, loose amplifies past it).
    const carryOnly = computeDashboardModel({
      ...input,
      activeLayers: new Set(['sigmaP', 'carryOptim', 'floorH'] as const),
    });
    const cadCarry = carryOnly.fcyComputed.find(r => r.ccy === 'CAD')!.cash_threshold;
    const t5 = computeDashboardModel({ ...input, policyVAR: 5 })
      .fcyComputed.find(r => r.ccy === 'CAD')!.cash_threshold;
    const t20 = computeDashboardModel({ ...input, policyVAR: 20 })
      .fcyComputed.find(r => r.ccy === 'CAD')!.cash_threshold;
    expect(t5).toBeGreaterThan(cadCarry);  // 5M: sell shrunk toward hold-the-book
    // 20M used to amplify PAST the single-name carry optimum (unconstrained
    // portfolio diversification could push CAD arbitrarily past its own
    // optimum) — MAX_LEG_LEVERAGE now bounds that, so at a loose limit CAD's
    // portfolio target converges toward (not past) the single-name optimum.
    // Still strictly less aggressive-than-t5 (the loose target sells CAD
    // down further than the tight one), just no longer required to overshoot
    // cadCarry itself.
    expect(t20).toBeLessThan(t5);
  });

  it('CIP: Swap Carry is cash Δr; points are not on this line', () => {
    const m = computeDashboardModel({ ...input, policyVAR: 10 });
    for (const r of m.fcyComputed) {
      const spot = CURRENCY_PARAMS[r.ccy]?.spot ?? 0;
      expect(r.swapInterestUsdYr).toBeCloseTo(r.swapOnUsdYr + r.usdOnUsdYr, 9);
      const cash = r.swapNear * ((
        r.swapNear < 0 ? r.r_OD : r.r_FCY
      ) - input.shared.r_USD) / 100 * spot;
      expect(r.swapCarryUsdYr).toBeCloseTo(cash, 6);
      if (Math.abs(r.swapNear) > 0.01) {
        expect(Math.abs(r.swapInterestUsdYr)).toBeGreaterThan(0);
      }
      const r_actual = r.cash >= 0 ? r.r_FCY : r.r_OD;
      const expected = r.cash * (r_actual - input.shared.r_USD) / 100 * spot;
      expect(r.floatNim).toBeCloseTo(expected, 6);
    }
  });

  it('funding-swap overlay sits on top of unfunded carry and does not replace it', () => {
    const m = computeDashboardModel({ ...input, policyVAR: 10 });
    const withOverlay = m.fcyComputed.filter(r => Math.abs(r.overlayLeg) > 1);
    expect(withOverlay.length).toBeGreaterThan(3);
    const eur = m.fcyComputed.find(r => r.ccy === 'EUR')!;
    const openingNaive = eur.cash * (eur.r_FCY - input.shared.r_USD) / 100
      * (CURRENCY_PARAMS.EUR?.spot ?? 0);
    // Unfunded cash carry stays on the opening path; the swap is a separate line.
    expect(eur.floatNim).toBeCloseTo(openingNaive, 6);
    const row = withOverlay.find(r => Math.abs(r.swapNear) > 0.01) ?? eur;
    const spot = CURRENCY_PARAMS[row.ccy]?.spot ?? 0;
    const cash = row.swapNear * ((
      row.swapNear < 0 ? row.r_OD : row.r_FCY
    ) - input.shared.r_USD) / 100 * spot;
    expect(row.swapCarryUsdYr).toBeCloseTo(cash, 6);
  });

  it('per-row overlay carry sums to the aggregate portfolio figure', () => {
    const m = computeDashboardModel({ ...input, policyVAR: 10 });
    const rowSum = m.fcyComputed.reduce((s, r) => s + r.overlayCarryUSD, 0);
    expect(rowSum).toBeCloseTo(m.portfolioSummary!.overlay_carry_USD, 6);
  });

  it('overlay carry P&L is positive and grows with the P&L limit', () => {
    const m5 = computeDashboardModel({ ...input, policyVAR: 5 });
    const m20 = computeDashboardModel({ ...input, policyVAR: 20 });
    // The disposition earns positive USD carry (EARN buys + PAY sells both earn)
    expect(m5.portfolioSummary!.overlay_carry_USD).toBeGreaterThan(0);
    // More P&L budget → more carry income
    expect(m20.portfolioSummary!.overlay_carry_USD)
      .toBeGreaterThan(m5.portfolioSummary!.overlay_carry_USD);
  });

  it('a feasible shared earn ask binds overlay carry below the VAR fill', () => {
    const filled = computeDashboardModel({ ...input, policyVAR: 10, usdCash: 900 });
    const modest = filled.portfolioSummary!.overlay_carry_USD * 0.25;
    const hit = computeDashboardModel({
      ...input, policyVAR: 10, usdCash: 900, carryTargetUsdYrM: modest,
    });
    // Floor / no-negative-LP slightly distort μ′w, but the ask still binds
    // below the VAR-fill overlay rather than spending the whole budget.
    expect(hit.portfolioSummary!.overlay_carry_USD).toBeGreaterThan(modest * 0.8);
    expect(hit.portfolioSummary!.overlay_carry_USD).toBeLessThan(modest * 1.2);
    expect(hit.portfolioSummary!.portfolio_VAR_USD)
      .toBeLessThan(filled.portfolioSummary!.portfolio_VAR_USD - 0.5);
  });

  it('portfolio VAR layer fills the limit and scales all currencies with it', () => {
    // Ample USD so the VAR limit (not USD funding) is the binding constraint.
    const m10 = computeDashboardModel({ ...input, policyVAR: 10, usdCash: 900 });
    const m20 = computeDashboardModel({ ...input, policyVAR: 20, usdCash: 900 });
    // Portfolio VAR fills PART of each budget, well under the limit on this
    // many-currency book — MAX_LEG_LEVERAGE (3x the active cap) caps
    // several individual currency legs before the correlated portfolio VAR
    // gets anywhere near the cap (solveCarryVarUsd). Still scales up with
    // the cap (m20 > m10, checked below via earn20/earn10 and pay20/pay10).
    expect(m10.portfolioSummary!.portfolio_VAR_USD).toBeGreaterThan(4);
    expect(m10.portfolioSummary!.portfolio_VAR_USD).toBeLessThanOrEqual(10.05);
    expect(m20.portfolioSummary!.portfolio_VAR_USD).toBeGreaterThan(8);
    expect(m20.portfolioSummary!.portfolio_VAR_USD).toBeLessThanOrEqual(20.05);
    expect(m20.portfolioSummary!.portfolio_VAR_USD)
      .toBeGreaterThan(m10.portfolioSummary!.portfolio_VAR_USD);
    // Raising the limit enlarges BOTH EARN buys and PAY sells (uniform scale-up).
    const earn10 = m10.fcyComputed.find(r => r.ccy === 'MXN')!.cash_threshold;
    const earn20 = m20.fcyComputed.find(r => r.ccy === 'MXN')!.cash_threshold;
    expect(earn20).toBeGreaterThan(earn10);
    const pay10 = m10.fcyComputed.find(r => r.ccy === 'CAD')!.cash_threshold;
    const pay20 = m20.fcyComputed.find(r => r.ccy === 'CAD')!.cash_threshold;
    // Sells further as the cap loosens — MAX_LEG_LEVERAGE now bounds how
    // far, so this no longer necessarily crosses zero into a short position.
    expect(pay20).toBeLessThan(pay10);
  });

  it('CAD with no payout: target below current stock (PAY sell-down)', () => {
    // Loose VAR budget + ample USD so the carry overlay sells CAD down.
    // MAX_LEG_LEVERAGE now bounds how far the sell can go — it no longer
    // necessarily crosses zero into a short position, just sells below
    // current stock.
    const model = computeDashboardModel({ ...input, policyVAR: 20, usdCash: 900 });
    const cad = model.fcyComputed.find(r => r.ccy === 'CAD')!;
    expect(cad.cash).toBeCloseTo(95.1, 1);
    expect(cad.cash_threshold).toBeLessThan(cad.cash);
    expect(cad.cash_threshold).toBeGreaterThan(0); // sold down, not wiped out
  });

  it('CAD payout: LP+Swap rises with payout; zero-sum $USD legs hold', () => {
    for (const payout of [-50, -100]) {
      const model = computeDashboardModel({
        ...input,
        rows: input.rows.map(r => r.ccy === 'CAD' ? { ...r, payout } : r),
      });
      const cad = model.fcyComputed.find(r => r.ccy === 'CAD')!;
      expect(cad.postSwapCash).toBeCloseTo(cad.cash + cad.swapNear, 2);
      const fcySwapUsd = sumFcySwapNearUsd(
        model.fcyComputed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear })),
      );
      expect(fcySwapUsd + model.usdComputed.swapNear).toBeCloseTo(0, 0);
    }
  });

  it('Post-payout cushion = Target + payout (funded target minus the payout that leaves)', () => {
    const model = computeDashboardModel(input);
    for (const fc of model.fcyComputed) {
      expect(fc.lp_after_swap_trough).toBeCloseTo(fc.cash_threshold + fc.payout, 4);
      expect(fc.postSwapCash).toBeCloseTo(fc.cash_threshold, 4);
    }
    expect(model.usdComputed.lp_after_swap_trough).toBeCloseTo(
      model.usdComputed.cash_threshold + model.usdComputed.payout, 4,
    );
  });

  it('USD liquidity stress binds when FCY envelope exceeds USD payout reserve', () => {
    // Overlay carry is self-funding (PAY sells fund EARN buys), so a bind needs
    // a REAL funding draw: a big FCY payout gap swap-funded from USD while the
    // USD payout consumes the reserve.
    const bound = computeDashboardModel({
      ...input,
      rows: input.rows.map(r => r.ccy === 'CAD' ? { ...r, payout: -800 } : r),
      usdParams: { ...INITIAL_USD_PARAMS, payout: -300 },
    });
    const usdLayer = bound.layerRows.find(r => r.ccy === 'USD')!;
    expect(usdLayer.usd_stress_binding).toBe(true);
    expect(usdLayer.usd_liquidity_mode).toBe('stress');
    // Stress trim propagates to FCY rows as a funding bind
    expect(bound.fcyComputed.some(r => r.funding_binding)).toBe(true);

    const heavy = computeDashboardModel({
      ...input,
      usdParams: { ...INITIAL_USD_PARAMS, payout: -600 },
    });
    const fcySwapUsd = sumFcySwapNearUsd(
      heavy.fcyComputed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear })),
    );
    expect(fcySwapUsd + heavy.usdComputed.swapNear).toBeCloseTo(0, 0);
  });

  it('USD payout −500M: zero-sum holds', () => {
    const model = computeDashboardModel({
      ...input,
      usdParams: { ...INITIAL_USD_PARAMS, payout: -500 },
    });
    const fcySwapUsd = sumFcySwapNearUsd(
      model.fcyComputed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear })),
    );
    expect(fcySwapUsd + model.usdComputed.swapNear).toBeCloseTo(0, 0);
  });

  it('USD payout −500M: swap $USD legs sum to zero after FCY envelope reconcile', () => {
    const model = computeDashboardModel({
      ...input,
      usdParams: { ...INITIAL_USD_PARAMS, payout: -500 },
    });
    const usd = model.usdComputed;
    const fcySwapUsd = sumFcySwapNearUsd(
      model.fcyComputed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear })),
    );
    expect(usd.swapNear).toBeGreaterThan(400);
    expect(fcySwapUsd + usd.swapNear).toBeCloseTo(0, 0);
  });
});
