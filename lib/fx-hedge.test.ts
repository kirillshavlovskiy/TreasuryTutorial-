import { describe, it, expect } from 'vitest';
import {
  suggestCarryHedge, excessLongLpCash, spotCarryBenefitUsdYr,
  fwdHedgeCarryUsdYr, optionGammaCarryUsdYr, shortOptionCarryUsdYr,
  resolveStrategyHedge,
} from './fx-hedge';
import { fcyToUsdM, fundingSwapCipPointsUsdYr } from './fx-buffer';

describe('resolveStrategyHedge — book-wide strategy selection', () => {
  // forecastFx = current book + cycle flows (flows = −50: payouts exceed payins).
  const base = {
    ccy: 'CAD',
    currentFx: 312.3,           // current net FX book (M FCY)
    forecastFx: 312.3 - 50,     // cycle-end exposure = book + flows
    optDelta: 0.5,
    horizonDays: 30,
    r_FCY: 1.49,
    r_USD: 3.50,
    σ_daily: 0.004256,
  };

  it('SWAP_ONLY: no hedge legs, full cycle-end exposure stays open', () => {
    const h = resolveStrategyHedge('SWAP_ONLY', base);
    expect(h.fwdNotional).toBe(0);
    expect(h.optNotional).toBe(0);
    expect(h.hedgeCarryUsdYr).toBe(0);
    expect(h.residualFx).toBeCloseTo(base.forecastFx, 6);
  });

  it('SWAP_FWD: forward squares the FULL cycle-end exposure (book + flows)', () => {
    const h = resolveStrategyHedge('SWAP_FWD', base);
    expect(h.fwdNotional).toBeCloseTo(-(312.3 - 50), 6); // sell the whole forecast exposure
    expect(h.optNotional).toBe(0);
    expect(h.fwdCarryUsdYr).toBeCloseTo(fwdHedgeCarryUsdYr(-(312.3 - 50), 'CAD', 1.49, 3.50), 9);
    expect(h.residualFx).toBeCloseTo(0, 6); // fully squared
  });

  it('SWAP_FWD_OPT on PAY carry: fwd squares the FULL forecast, SELL CALL matched to it', () => {
    const h = resolveStrategyHedge('SWAP_FWD_OPT', base); // optDelta 0.5 (ATM)
    // CAD is PAY carry (1.49 < 3.50) → we WRITE a call: sell USD / buy LCY on exercise
    expect(h.optType).toBe('SELL_CALL');
    // Fwd = −Net FX Forecast, IDENTICAL to SWAP_FWD — the option never resizes it
    expect(h.fwdNotional).toBeCloseTo(-262.3, 6);
    expect(h.fwdNotional).toBeCloseTo(
      resolveStrategyHedge('SWAP_FWD', base).fwdNotional, 9,
    );
    // option notional ALWAYS matches the forward notional 1:1 — δ never resizes it
    expect(h.optNotional).toBeCloseTo(262.3, 6);
    // FAIR-VALUE carry: option contributes ONLY the δ-weighted delivery-leg
    // forward points. Buying CAD (PAY) forward on exercise GIVES UP the rate
    // differential → the δ-leg is NEGATIVE.
    const δLeg = fwdHedgeCarryUsdYr(262.3 * 0.5, 'CAD', 1.49, 3.50);
    expect(δLeg).toBeLessThan(0);
    expect(h.optCarryUsdYr).toBeCloseTo(δLeg, 9);
    const so = shortOptionCarryUsdYr(262.3, 0.5, 30, 'CAD', 1.49, 3.50, 0.004256);
    expect(h.optCarryUsdYr).toBeCloseTo(so.deliveryLegCarryUsdYr, 9);
    // gross premium is still reported informationally, unchanged by the carry fix…
    expect(h.optPremiumUsdYr).toBeCloseTo(so.premiumEarnedUsdYr, 9);
    expect(h.optPremiumUsdYr).toBeGreaterThan(0);
    // locked structure carry = fwd points only (CIP 0 with no swap). Option
    // delivery-leg is contingent — not assumed exercised, not in Hedge Carry.
    expect(h.hedgeCarryUsdYr).toBeCloseTo(h.fwdCarryUsdYr, 9);
    expect(h.optCarryUsdYr).toBeCloseTo(δLeg, 9);
    expect(h.hedgeCarryUsdYr).toBeGreaterThan(0);
    // residual = forecast + total delta-weighted hedge (fwd + δ × option):
    // 262.3 + (−262.3 + 262.3 × 0.5) = +131.15 — the sold call's δ-weighted
    // delivery (buy LCY) re-adds long exposure on top of the squared forward.
    expect(h.effectiveHedge).toBeCloseTo(-131.15, 6);
    expect(h.residualFx).toBeCloseTo(131.15, 6);
  });

  it('notional matched 1:1 at ALL deltas; δ scales only the effective hedge, linear to zero', () => {
    const at25 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, optDelta: 0.25 });
    const at50 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, optDelta: 0.5 });
    const at100 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, optDelta: 1 });
    // written notional = |Fwd| at every δ — δ never resizes it
    expect(at25.optNotional).toBeCloseTo(262.3, 6);
    expect(at50.optNotional).toBeCloseTo(262.3, 6);
    expect(at100.optNotional).toBeCloseTo(262.3, 6);
    // premium is earned on the full written notional — identical at every δ
    expect(at25.optPremiumUsdYr).toBeCloseTo(at100.optPremiumUsdYr, 9);
    expect(at50.optPremiumUsdYr).toBeCloseTo(at100.optPremiumUsdYr, 9);
    // δ-effective coverage (option alone) = δ × written notional
    expect(at25.effectiveHedge - at25.fwdNotional).toBeCloseTo(262.3 * 0.25, 6); // 65.575
    expect(at50.effectiveHedge - at50.fwdNotional).toBeCloseTo(262.3 * 0.5, 6);  // 131.15
    expect(at100.effectiveHedge - at100.fwdNotional).toBeCloseTo(262.3, 6);
    // residual = forecast + fwd + δ × option = δ × |Fwd| (fwd squares the forecast)
    expect(at25.residualFx).toBeCloseTo(65.575, 6);
    expect(at50.residualFx).toBeCloseTo(131.15, 6);
    expect(at100.residualFx).toBeCloseTo(262.3, 6);
    // δ = 0: the option stays WRITTEN and matched, but its effective coverage
    // is zero → residual = 0. The raw δ drives effective/residual; only the
    // premium/carry pricing keeps a δ floor of 0.05 on the full notional.
    const at0 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, optDelta: 0 });
    expect(at0.optNotional).toBeCloseTo(262.3, 6);
    expect(at0.optType).toBe('SELL_CALL');
    expect(at0.optDelta).toBe(0);
    expect(at0.effectiveHedge).toBeCloseTo(at0.fwdNotional, 6);
    expect(at0.residualFx).toBeCloseTo(0, 6);
    expect(at0.optPremiumUsdYr).toBeCloseTo(at100.optPremiumUsdYr, 9);
    // carry uses the δ floor of 0.05 and, at fair value, is the δ-leg forward
    // points ONLY — no premium in carry
    expect(at0.optCarryUsdYr).toBeCloseTo(
      fwdHedgeCarryUsdYr(262.3 * 0.05, 'CAD', 1.49, 3.50), 9,
    );
  });

  it('SWAP_FWD_OPT on EARN carry: fwd squares the full forecast, SELL PUT matched to it', () => {
    // MXN EARN carry (6.19 > 3.50)
    const h = resolveStrategyHedge('SWAP_FWD_OPT', {
      ...base, ccy: 'MXN', r_FCY: 6.19, σ_daily: 0.007892,
      currentFx: 100, forecastFx: 100 + 50,
    });
    expect(h.optType).toBe('SELL_PUT');
    expect(h.fwdNotional).toBeCloseTo(-150, 6); // −Net FX Forecast, full square
    expect(h.optNotional).toBeCloseTo(-150, 6); // matched to the forward, sell-side delivery
    expect(h.optPremiumUsdYr).toBeGreaterThan(0);
    // residual = forecast + fwd + δ × option = 150 − 150 + 0.5 × (−150) = −75
    expect(h.residualFx).toBeCloseTo(-75, 6);
  });

  it('zero flows but a standing book → option still written (matched to the fwd on the book)', () => {
    const h = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, forecastFx: base.currentFx });
    expect(h.fwdNotional).toBeCloseTo(-base.currentFx, 6);
    expect(h.optNotional).toBeCloseTo(base.currentFx, 6);
  });

  it('SWAP_FWD_OPT neutral carry: no option written, fwd squares the full forecast', () => {
    // r_FCY ≈ r_USD → neither call nor put program applies
    const h = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, r_FCY: 3.50 });
    expect(h.optType).toBeNull();
    expect(h.optNotional).toBe(0);
    expect(h.fwdNotional).toBeCloseTo(-base.forecastFx, 6);
    expect(h.residualFx).toBeCloseTo(0, 6);
  });

  it('flat book and flat flows → SWAP_FWD hedges nothing', () => {
    const h = resolveStrategyHedge('SWAP_FWD', { ...base, currentFx: 0, forecastFx: 0 });
    expect(h.fwdNotional).toBe(0);
    expect(h.hedgeCarryUsdYr).toBe(0);
  });

  it('zero flows but standing book → SWAP_FWD still hedges the book (not zero)', () => {
    const h = resolveStrategyHedge('SWAP_FWD', { ...base, forecastFx: base.currentFx });
    expect(h.fwdNotional).toBeCloseTo(-base.currentFx, 6);
    expect(h.residualFx).toBeCloseTo(0, 6);
  });

  it('funding-swap near is in the hedge basis (hedging/funding layer)', () => {
    const swapNear = 40;
    const only = resolveStrategyHedge('SWAP_ONLY', { ...base, swapNear });
    expect(only.fwdNotional).toBe(0);
    expect(only.residualFx).toBeCloseTo(base.forecastFx + swapNear, 6);

    const fwd = resolveStrategyHedge('SWAP_FWD', { ...base, swapNear });
    expect(fwd.fwdNotional).toBeCloseTo(-(base.forecastFx + swapNear), 6);
    expect(fwd.residualFx).toBeCloseTo(0, 6);

    const none = resolveStrategyHedge('SWAP_FWD', { ...base, swapNear: 0 });
    expect(Math.abs(fwd.fwdNotional)).toBeGreaterThan(Math.abs(none.fwdNotional));
  });

  it('SWAP_ONLY scales CIP P&L by δ — δ = 0 books none, δ ≠ 0 harvests the far-leg', () => {
    const swapNear = -40;
    const pts = fundingSwapCipPointsUsdYr(swapNear, fcyToUsdM(1, 'CAD'), base.r_FCY, base.r_USD);
    expect(pts).toBeLessThan(0);
    const at0 = resolveStrategyHedge('SWAP_ONLY', { ...base, swapNear, optDelta: 0 });
    const at50 = resolveStrategyHedge('SWAP_ONLY', { ...base, swapNear, optDelta: 0.5 });
    const at100 = resolveStrategyHedge('SWAP_ONLY', { ...base, swapNear, optDelta: 1 });
    expect(at0.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at50.cipCarryUsdYr).toBeCloseTo(pts * 0.5, 9);
    expect(at100.cipCarryUsdYr).toBeCloseTo(pts, 9);
    expect(at100.hedgeCarryUsdYr).toBeCloseTo(pts, 9);
  });

  it('SWAP_FWD books swap CIP points in hedge carry scaled by δ', () => {
    const swapNear = 40;
    const h = resolveStrategyHedge('SWAP_FWD', { ...base, swapNear, optDelta: 1 });
    const pts = fundingSwapCipPointsUsdYr(swapNear, fcyToUsdM(1, 'CAD'), base.r_FCY, base.r_USD);
    expect(h.cipCarryUsdYr).toBeCloseTo(pts, 9);
    expect(h.hedgeCarryUsdYr).toBeCloseTo(
      fwdHedgeCarryUsdYr(-(base.forecastFx + swapNear), 'CAD', base.r_FCY, base.r_USD),
      6,
    );
  });

  it('SWAP_FWD_OPT scales swap CIP points by δ — δ = 0 books none, δ ≠ 0 harvests them', () => {
    const swapNear = 40;
    const pts = fundingSwapCipPointsUsdYr(swapNear, fcyToUsdM(1, 'CAD'), base.r_FCY, base.r_USD);
    expect(Math.abs(pts)).toBeGreaterThan(0.01);
    const at0 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, swapNear, optDelta: 0 });
    const at50 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, swapNear, optDelta: 0.5 });
    const at100 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, swapNear, optDelta: 1 });
    expect(at0.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at50.cipCarryUsdYr).toBeCloseTo(pts * 0.5, 9);
    expect(at100.cipCarryUsdYr).toBeCloseTo(pts, 9);
    expect(at50.residualFx).toBeGreaterThan(at0.residualFx);
  });
});

describe('hedge overlay carry (on top of the swap book)', () => {
  // CAD: PAY currency (r_FCY 1.49 < r_USD 3.50) — selling fwd EARNS the differential.
  it('FWD hedge of a long PAY exposure earns the forward points', () => {
    const carry = fwdHedgeCarryUsdYr(-100, 'CAD', 1.49, 3.50); // sell 100M CAD fwd
    const expected = 100 * fcyToUsdM(1, 'CAD') * (3.50 - 1.49) / 100;
    expect(carry).toBeCloseTo(expected, 6);
    expect(carry).toBeGreaterThan(0);
  });

  it('FWD hedge of a long EARN exposure gives the yield up (negative carry)', () => {
    const carry = fwdHedgeCarryUsdYr(-100, 'AUD', 4.35, 3.50); // sell 100M AUD fwd
    expect(carry).toBeLessThan(0);
  });

  it('zero notional → zero fwd carry', () => {
    expect(fwdHedgeCarryUsdYr(0, 'CAD', 1.49, 3.50)).toBe(0);
  });

  it('gamma overlay = δ-scaled fwd leg carry minus annualized theta bleed', () => {
    const g = optionGammaCarryUsdYr(-100, 0.5, 30, 'CAD', 1.49, 3.50, 0.004256);
    // δ-leg = half the outright forward carry
    expect(g.fwdLegCarryUsdYr).toBeCloseTo(fwdHedgeCarryUsdYr(-100, 'CAD', 1.49, 3.50) * 0.5, 6);
    // theta: 0.4 × σ_ann × √(T/365) × |N| × spot, annualized ×365/T
    const σ_ann = 0.004256 * Math.sqrt(252);
    const tYr = 30 / 365;
    const theta = 0.4 * σ_ann * Math.sqrt(tYr) * 100 * fcyToUsdM(1, 'CAD') / tYr;
    expect(g.thetaBleedUsdYr).toBeCloseTo(theta, 6);
    expect(g.totalUsdYr).toBeCloseTo(g.fwdLegCarryUsdYr - g.thetaBleedUsdYr, 9);
  });

  it('longer horizon → smaller annualized theta bleed (premium ∝ √T but spread over T)', () => {
    const g30 = optionGammaCarryUsdYr(-100, 0.5, 30, 'CAD', 1.49, 3.50, 0.004256);
    const g90 = optionGammaCarryUsdYr(-100, 0.5, 90, 'CAD', 1.49, 3.50, 0.004256);
    expect(g90.thetaBleedUsdYr).toBeLessThan(g30.thetaBleedUsdYr);
    expect(g90.totalUsdYr).toBeGreaterThan(g30.totalUsdYr);
  });
});

describe('suggestCarryHedge', () => {
  it('CAD PAY with excess above target → SPOT sell', () => {
    const s = suggestCarryHedge({
      ccy: 'CAD',
      lpNetFX: 50,
      lpCash: 95.1,
      cashThreshold: 69.96,
      postSwapCash: 95.1,
      fcastFX: 0,
      cashFloor: 0,
      carryDir: 'pay',
      r_FCY: 1.49,
      r_USD: 3.50,
      σ_daily: 0.004256,
    });
    expect(s.mode).toBe('SPOT');
    expect(s.spotSell).toBeCloseTo(-25.14, 1);
    expect(s.carryBenefitUsdYr).toBeGreaterThan(0.3);
    expect(s.reason).toMatch(/sell.*spot/i);
  });

  it('CAD PAY with invoice pipeline → OPTION spot + retain', () => {
    const s = suggestCarryHedge({
      ccy: 'CAD',
      lpNetFX: 50,
      lpCash: 95.1,
      cashThreshold: 69.96,
      postSwapCash: 95.1,
      fcastFX: -10,
      cashFloor: 0,
      carryDir: 'pay',
      r_FCY: 1.49,
      r_USD: 3.50,
      σ_daily: 0.004256,
    });
    expect(s.mode).toBe('OPTION');
    expect(s.spotSell).toBeLessThan(0);
    expect(s.optionRetain).toBe(10);
    expect(s.optionDelta).toBeLessThan(1);
  });

  it('EARN carry → no hedge', () => {
    const s = suggestCarryHedge({
      ccy: 'MXN',
      lpNetFX: 100,
      lpCash: 100,
      cashThreshold: 50,
      postSwapCash: 100,
      fcastFX: 0,
      cashFloor: 0,
      carryDir: 'earn',
      r_FCY: 6.19,
      r_USD: 3.50,
      σ_daily: 0.007892,
    });
    expect(s.mode).toBe('NONE');
  });

  it('excessLongLpCash uses max of stock vs trough', () => {
    expect(excessLongLpCash(95.1, 80, 70)).toBeCloseTo(25.1, 1);
    expect(excessLongLpCash(50, 90, 70)).toBeCloseTo(20, 1);
  });

  it('spotCarryBenefitUsdYr positive for PAY spot sell', () => {
    const b = spotCarryBenefitUsdYr(-25, 'CAD', 1.49, 3.50);
    expect(b).toBeCloseTo(0.37, 1);
  });
});
