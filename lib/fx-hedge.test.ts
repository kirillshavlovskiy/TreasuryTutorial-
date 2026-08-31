import { describe, it, expect } from 'vitest';
import {
  suggestCarryHedge, excessLongLpCash, spotCarryBenefitUsdYr,
  fwdHedgeCarryUsdYr, optionGammaCarryUsdYr, shortOptionCarryUsdYr,
  resolveStrategyHedge,
  allocateSwapForwardOverlay,
  swapForwardDeltaFromForward,
  monthlyHedgeCarryUsdM,
  allocateResidualSwapForwardOverlay,
  clampBothPayBuyToSell,
  bothPaySellCoverLocalM,
  coverFromTradeLocalM,
  scaleFundingPlanByRetention,
  retainedFundingPlanByCcy,
  analyticsForwardsFromOverlays,
  stripHedgeLegCarryUsdM,
  fwdCarryForExposureCoverUsdM,
  fwdHedgeCarryFromMarketUsd,
} from './fx-hedge';
import { CURRENCY_PARAMS, fcyToUsdM, fundingSwapCipPointsUsdYr, makeSimRow } from './fx-buffer';
import {
  DEFAULT_EURUSD_MARKET_RATES,
  emptyMarketRatesForCcy,
  type FxMarketRatesBundle,
} from './fx-market-rates';
import {
  hedgeImprovementBreakdownToT,
  assignImpliedCarryFromSwapPoints,
  buildCashForecastCarryComparison,
} from './test-mode/cash-carry-analytics';
import { hedgeBasisNotionalLocalM } from './test-mode/exposure-hedge-path';
import { buildRollingHedgeEdges } from './test-mode/rolling-hedge';
import { DEFAULT_VAR_SETUP } from './test-mode/var-setup';

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

  it('SWAP_FWD: forward = −Δ×near; residual keeps unreplaced near; no swap far / CIP', () => {
    const swapNear = 40;
    const E = base.forecastFx;

    const at0 = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear, swapForwardDelta: 0, optDelta: 0,
    });
    expect(at0.fwdNotional).toBeCloseTo(0, 6);
    expect(at0.remainingFarLocalM).toBeCloseTo(0, 6);
    expect(at0.residualFx).toBeCloseTo(E + swapNear, 6);
    expect(at0.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at0.fwdCarryUsdYr).toBeCloseTo(0, 9);
    expect(at0.overlay?.finalNetLocalM ?? 1).toBeCloseTo(E + swapNear, 6);

    const at50 = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear, swapForwardDelta: 0.5, optDelta: 0.5,
    });
    expect(at50.fwdNotional).toBeCloseTo(-0.5 * swapNear, 6);
    expect(at50.remainingFarLocalM).toBeCloseTo(0, 6);
    expect(at50.residualFx).toBeCloseTo(E + 0.5 * swapNear, 6);
    expect(at50.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at50.fwdCarryUsdYr).not.toBeCloseTo(0, 6);

    const at100 = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear, swapForwardDelta: 1, optDelta: 1,
    });
    expect(at100.fwdNotional).toBeCloseTo(-swapNear, 6);
    expect(at100.remainingFarLocalM).toBeCloseTo(0, 6);
    expect(at100.residualFx).toBeCloseTo(E, 6);
    expect(at100.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at100.fwdCarryUsdYr).toBeCloseTo(
      fwdHedgeCarryUsdYr(-swapNear, 'CAD', base.r_FCY, base.r_USD),
      6,
    );
  });

  it('swapForwardDeltaFromForward inverts F = −Δ×S', () => {
    const S = 40;
    expect(swapForwardDeltaFromForward({
      forwardLocalM: -0.5 * S,
      swapNearLocalM: S,
    })).toBeCloseTo(0.5, 9);
    expect(swapForwardDeltaFromForward({
      forwardLocalM: -S,
      swapNearLocalM: S,
    })).toBeCloseTo(1, 9);
    expect(swapForwardDeltaFromForward({
      forwardLocalM: 0,
      swapNearLocalM: S,
    })).toBeCloseTo(0, 9);
    expect(swapForwardDeltaFromForward({
      forwardLocalM: -10,
      swapNearLocalM: 0,
    })).toBe(0);
  });

  it('monthlyHedgeCarryUsdM splits fwd points beside CIP (term / rolling)', () => {
    expect(monthlyHedgeCarryUsdM({
      cycleCipUsdM: 0.012,
      fwdCarryUsdM: 0.024,
      cycleIndex: 0,
      farMonths: 12,
      termFar: true,
    })).toBeCloseTo(0.014, 9);
    expect(monthlyHedgeCarryUsdM({
      cycleCipUsdM: 0.012,
      fwdCarryUsdM: 0.024,
      cycleIndex: 0,
      farMonths: 12,
      termFar: false,
    })).toBeCloseTo(0.014, 9);
    expect(monthlyHedgeCarryUsdM({
      cycleCipUsdM: 0.012,
      fwdCarryUsdM: 0.024,
      cycleIndex: 12,
      farMonths: 12,
      termFar: true,
    })).toBeCloseTo(0.012, 9);
  });

  it('SWAP_FWD clamps Δ outside [0,1] and handles negative Swap Near', () => {
    const swapNear = -40;
    const E = base.forecastFx;
    const over = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear, swapForwardDelta: 2, optDelta: 2,
    });
    expect(over.swapForwardDelta).toBe(1);
    expect(over.fwdNotional).toBeCloseTo(-swapNear, 6);
    expect(over.remainingFarLocalM).toBeCloseTo(0, 6);

    const under = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear, swapForwardDelta: -1, optDelta: -1,
    });
    expect(under.swapForwardDelta).toBe(0);
    expect(under.fwdNotional).toBeCloseTo(0, 6);
    expect(under.remainingFarLocalM).toBeCloseTo(0, 6);
    expect(E).toBeCloseTo(base.forecastFx, 6);
  });

  it('SWAP_ONLY: no hedge legs, full cycle-end exposure stays open', () => {
    const h = resolveStrategyHedge('SWAP_ONLY', base);
    expect(h.fwdNotional).toBe(0);
    expect(h.optNotional).toBe(0);
    expect(h.hedgeCarryUsdYr).toBe(0);
    expect(h.residualFx).toBeCloseTo(base.forecastFx, 6);
  });

  it('SWAP_FWD without swap: naked spot buffer → Fwd and Option are 0', () => {
    const h = resolveStrategyHedge('SWAP_FWD', { ...base, swapForwardDelta: 1 });
    expect(h.fwdNotional).toBe(0);
    expect(h.optNotional).toBe(0);
    expect(h.fwdCarryUsdYr).toBe(0);
    expect(h.residualFx).toBeCloseTo(base.forecastFx, 6);
  });

  it('SWAP_FWD_OPT on PAY carry: near strip + option (no leftover far)', () => {
    const swapNear = 40;
    const h = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, swapNear, optDelta: 0.5 });
    expect(h.optType).toBe('SELL_CALL');
    expect(h.fwdNotional).toBeCloseTo(-swapNear, 6);
    expect(h.optNotional).toBeCloseTo(-40, 6);
    expect(h.remainingFarLocalM).toBeCloseTo(0, 6);
    const δLeg = fwdHedgeCarryUsdYr(-40 * 0.5, 'CAD', 1.49, 3.50);
    expect(h.optCarryUsdYr).toBeCloseTo(δLeg, 9);
    expect(h.effectiveHedge).toBeCloseTo(-swapNear + -40 * 0.5, 6);
    expect(h.residualFx).toBeCloseTo(base.forecastFx + -40 * 0.5, 6);
  });

  it('SWAP_FWD_OPT with no swap: naked spot → Fwd and Option are 0', () => {
    const h = resolveStrategyHedge('SWAP_FWD_OPT', base);
    expect(h.fwdNotional).toBe(0);
    expect(h.optNotional).toBe(0);
    expect(h.optType).toBeNull();
    expect(h.residualFx).toBeCloseTo(base.forecastFx, 6);
  });

  it('δ replaces the buffer far only — naked spot stays 0 at every δ', () => {
    const at25 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, optDelta: 0.25 });
    const at100 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, optDelta: 1 });
    expect(at25.fwdNotional).toBe(0);
    expect(at25.optNotional).toBe(0);
    expect(at100.fwdNotional).toBe(0);
    expect(at100.optNotional).toBe(0);
  });

  it('SWAP_FWD_OPT on EARN carry: SELL PUT replaces the buffer far', () => {
    const h = resolveStrategyHedge('SWAP_FWD_OPT', {
      ...base, ccy: 'MXN', r_FCY: 6.19, σ_daily: 0.007892,
      currentFx: 100, forecastFx: 100 + 50, swapNear: 30, optDelta: 0.5,
    });
    expect(h.optType).toBe('SELL_PUT');
    expect(h.fwdNotional).toBeCloseTo(-30, 6);
    expect(h.optNotional).toBeCloseTo(-30, 6);
    expect(h.remainingFarLocalM).toBeCloseTo(0, 6);
    expect(h.residualFx).toBeCloseTo(150 + -30 * 0.5, 6);
  });

  it('zero flows but a standing book → option still written on the buffer far', () => {
    const h = resolveStrategyHedge('SWAP_FWD_OPT', {
      ...base, forecastFx: base.currentFx, swapNear: 25, optDelta: 0.5,
    });
    expect(h.fwdNotional).toBeCloseTo(-25, 6);
    expect(h.optNotional).toBeCloseTo(-25, 6);
    expect(h.remainingFarLocalM).toBeCloseTo(0, 6);
  });

  it('SWAP_FWD_OPT neutral carry: no option written; near strip only (no far leftover)', () => {
    const h = resolveStrategyHedge('SWAP_FWD_OPT', {
      ...base, r_FCY: 3.50, swapNear: 40,
    });
    expect(h.optType).toBeNull();
    expect(h.optNotional).toBe(0);
    expect(h.fwdNotional).toBeCloseTo(-40, 6);
    expect(h.remainingFarLocalM).toBeCloseTo(0, 6);
    expect(h.residualFx).toBeCloseTo(base.forecastFx, 6);
  });

  it('flat book and flat flows → SWAP_FWD hedges nothing', () => {
    const h = resolveStrategyHedge('SWAP_FWD', { ...base, currentFx: 0, forecastFx: 0 });
    expect(h.fwdNotional).toBe(0);
    expect(h.hedgeCarryUsdYr).toBe(0);
  });

  it('zero flows but standing book → SWAP_FWD hedges the buffer far (not the book)', () => {
    const h = resolveStrategyHedge('SWAP_FWD', {
      ...base, forecastFx: base.currentFx, swapNear: base.currentFx, swapForwardDelta: 1,
    });
    expect(h.fwdNotional).toBeCloseTo(-base.currentFx, 6);
    expect(h.residualFx).toBeCloseTo(base.currentFx, 6);
  });

  it('funding-swap near is the buffer hedge — naked spot prints 0', () => {
    const swapNear = 40;
    const only = resolveStrategyHedge('SWAP_ONLY', { ...base, swapNear });
    expect(only.fwdNotional).toBe(0);
    expect(only.remainingFarLocalM).toBeCloseTo(-swapNear, 6);
    expect(only.residualFx).toBeCloseTo(base.forecastFx + swapNear, 6);

    const fwd = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear, swapForwardDelta: 1,
    });
    expect(fwd.fwdNotional).toBeCloseTo(-swapNear, 6);
    expect(fwd.residualFx).toBeCloseTo(base.forecastFx, 6);
    expect(fwd.remainingFarLocalM).toBeCloseTo(0, 6);

    const none = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear: 0, swapForwardDelta: 1,
    });
    expect(none.fwdNotional).toBe(0);
    expect(Math.abs(fwd.fwdNotional)).toBeGreaterThan(Math.abs(none.fwdNotional));
  });

  it('SWAP_ONLY books full CIP on the standing far leg', () => {
    const swapNear = -40;
    const pts = fundingSwapCipPointsUsdYr(swapNear, fcyToUsdM(1, 'CAD'), base.r_FCY, base.r_USD);
    expect(pts).toBeLessThan(0);
    const h = resolveStrategyHedge('SWAP_ONLY', { ...base, swapNear, optDelta: 0.5 });
    expect(h.cipCarryUsdYr).toBeCloseTo(pts, 9);
    expect(h.hedgeCarryUsdYr).toBeCloseTo(pts, 9);
    expect(h.fwdNotional).toBe(0);
  });

  it('SWAP_ONLY far-leg CIP uses market swap points when the curve is on', () => {
    const swapNear = -40;
    const h = resolveStrategyHedge('SWAP_ONLY', {
      ccy: 'EUR',
      currentFx: 10,
      forecastFx: 10,
      swapNear,
      optDelta: 1,
      horizonDays: 30,
      r_FCY: 1.78,
      r_USD: 3.50,
      σ_daily: 0.004372,
      marketRates: DEFAULT_EURUSD_MARKET_RATES,
      farSettleMonths: 12,
    });
    expect(h.cipCarryUsdYr).toBeCloseTo(swapNear * (170.1 / 10_000), 6);
    const cash = fundingSwapCipPointsUsdYr(
      swapNear, fcyToUsdM(1, 'EUR'), 1.78, 3.50,
    );
    expect(Math.abs(h.cipCarryUsdYr)).not.toBeCloseTo(Math.abs(cash), 2);
  });

  it('SWAP_FWD basis-risk cover of PLN OD (buy near) earns on the outright forward', () => {
    const swapNear = 21.6;
    const h = resolveStrategyHedge('SWAP_FWD', {
      ccy: 'PLN',
      currentFx: 0,
      forecastFx: 0,
      swapNear,
      swapForwardDelta: 1,
      optDelta: 1,
      horizonDays: 30,
      r_FCY: 3.41,
      r_USD: 3.50,
      σ_daily: 0.006363,
      farSettleMonths: 12,
    });
    expect(h.fwdNotional).toBeCloseTo(-swapNear, 6);
    expect(h.fwdCarryUsdYr).toBeGreaterThan(0);
    expect(h.cipCarryUsdYr).toBeCloseTo(0, 9);
  });

  it('SWAP_FWD PLN both-pay: short standing still sells the near — CIP is not a buy', () => {
    const swapNear = -21.6;
    const buy = resolveStrategyHedge('SWAP_FWD', {
      ccy: 'CAD',
      currentFx: 0,
      forecastFx: 0,
      swapNear,
      swapForwardDelta: 1,
      optDelta: 1,
      horizonDays: 30,
      r_FCY: 1.49,
      r_USD: 3.50,
      σ_daily: 0.004256,
      farSettleMonths: 12,
    });
    expect(buy.fwdNotional).toBeCloseTo(-swapNear, 6);
    expect(buy.fwdCarryUsdYr).toBeLessThan(0);

    const h = resolveStrategyHedge('SWAP_FWD', {
      ccy: 'PLN',
      currentFx: 0,
      forecastFx: 0,
      swapNear,
      swapForwardDelta: 1,
      optDelta: 1,
      horizonDays: 30,
      r_FCY: 3.41,
      r_USD: 3.50,
      σ_daily: 0.006363,
      farSettleMonths: 12,
    });
    expect(h.fwdNotional).toBeCloseTo(swapNear, 6);
    expect(h.fwdCarryUsdYr).toBeGreaterThan(0);
  });

  it('SWAP_FWD books outright points only — CIP stays 0 at every Δ', () => {
    const swapNear = 40;
    const at0 = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear, swapForwardDelta: 0,
    });
    const at100 = resolveStrategyHedge('SWAP_FWD', {
      ...base, swapNear, swapForwardDelta: 1,
    });
    expect(at0.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at100.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at0.fwdCarryUsdYr).toBeCloseTo(0, 9);
    expect(at100.fwdCarryUsdYr).toBeCloseTo(
      fwdHedgeCarryUsdYr(-swapNear, 'CAD', base.r_FCY, base.r_USD),
      6,
    );
    expect(at100.hedgeCarryUsdYr).toBeCloseTo(at100.fwdCarryUsdYr, 6);
  });

  it('SWAP_FWD_OPT: near strip + option — CIP stays 0; residual is E + δ×option', () => {
    const swapNear = 40;
    const nearStrip = -swapNear;
    const bufferFar = -swapNear;
    const at0 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, swapNear, optDelta: 0 });
    const at50 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, swapNear, optDelta: 0.5 });
    const at100 = resolveStrategyHedge('SWAP_FWD_OPT', { ...base, swapNear, optDelta: 1 });
    expect(at0.fwdNotional).toBeCloseTo(nearStrip, 6);
    expect(at50.fwdNotional).toBeCloseTo(nearStrip, 6);
    expect(at100.fwdNotional).toBeCloseTo(nearStrip, 6);
    expect(at0.optNotional).toBeCloseTo(bufferFar, 6);
    expect(at50.optNotional).toBeCloseTo(bufferFar, 6);
    expect(at100.optNotional).toBeCloseTo(bufferFar, 6);
    expect(at0.remainingFarLocalM).toBeCloseTo(0, 6);
    expect(at0.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at50.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at100.cipCarryUsdYr).toBeCloseTo(0, 9);
    expect(at0.residualFx).toBeCloseTo(base.forecastFx, 6);
    expect(at50.residualFx).toBeCloseTo(base.forecastFx + 0.5 * bufferFar, 6);
    expect(at100.residualFx).toBeCloseTo(base.forecastFx + bufferFar, 6);
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

describe('allocateSwapForwardOverlay + retention helpers', () => {
  it('buffer-hedge identity: F = −Δ×S, residual keeps E, both swap signs', () => {
    for (const S of [40, -40]) {
      for (const delta of [0, 0.5, 1]) {
        const o = allocateSwapForwardOverlay({
          exposureLocalM: 100,
          swapNearLocalM: S,
          delta,
        });
        expect(o.forwardLocalM).toBeCloseTo(-delta * S, 9);
        expect(o.remainingFarLocalM).toBeCloseTo(-(1 - delta) * S, 9);
        expect(o.residualNearLocalM).toBeCloseTo((1 - delta) * S, 9);
        expect(o.finalNetLocalM).toBeCloseTo(100 + (1 - delta) * S, 9);
      }
    }
  });

  it('scaleFundingPlanByRetention scales standing and far by (1−Δ)', () => {
    const plan = [
      { standing_swap: 10, far_leg: 0 },
      { standing_swap: 10, far_leg: -10 },
    ];
    const half = scaleFundingPlanByRetention(plan, 0.5);
    expect(half[0]!.standing_swap).toBeCloseTo(5, 9);
    expect(half[1]!.far_leg).toBeCloseTo(-5, 9);
    const gone = scaleFundingPlanByRetention(plan, 0);
    expect(gone.every(p => Math.abs(p.standing_swap) < 1e-12)).toBe(true);
  });

  it('retainedFundingPlanByCcy uses overlay Δ and leaves other CCYs full', () => {
    const planByCcy = {
      EUR: [{ standing_swap: 8, far_leg: -8 }],
      GBP: [{ standing_swap: 4, far_leg: 0 }],
    };
    const overlays = {
      EUR: allocateSwapForwardOverlay({
        exposureLocalM: 10,
        swapNearLocalM: 8,
        delta: 0.75,
      }),
    };
    const retained = retainedFundingPlanByCcy(planByCcy, overlays)!;
    expect(retained.EUR![0]!.standing_swap).toBeCloseTo(8 * 0.25, 9);
    expect(retained.GBP![0]!.standing_swap).toBeCloseTo(4, 9);
  });

  it('analyticsForwardsFromOverlays emits Forward only — never RemainingFar', () => {
    const overlay = allocateSwapForwardOverlay({
      exposureLocalM: 12,
      swapNearLocalM: 5,
      delta: 0.4,
    });
    const legs = analyticsForwardsFromOverlays({
      overlayByCcy: { EUR: overlay },
      forecastMonths: 12,
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]!.amountLocalM).toBeCloseTo(overlay.forwardLocalM, 9);
    expect(legs[0]!.amountLocalM).not.toBeCloseTo(overlay.remainingFarLocalM, 6);
  });
});

describe('stripHedgeLegCarryUsdM — conversion cash', () => {
  const rates = { creditPct: 3.41, debitPct: 4.41 };
  const usd = { creditPct: 3.50, debitPct: 3.89 };

  it('selling FCY earns USD credit and pays FCY debit', () => {
    const sell = stripHedgeLegCarryUsdM({
      notionalLocalM: -10,
      ccy: 'PLN',
      recognizeMonths: 0,
      settleMonths: 6,
      forecastEndMonths: 12,
      fcyFwdRates: rates,
      usdFwdRates: usd,
      fcyCashRates: rates,
      usdCashRates: usd,
    });
    expect(sell.fcyInterestUsdM).toBeLessThan(0);
    expect(sell.usdInterestUsdM).toBeGreaterThan(0);
    expect(sell.fwdCarryUsdM).toBeGreaterThan(0);
  });

  it('buying PLN forward pays FWD points and USD; FCY credit only after the buy', () => {
    const buy = stripHedgeLegCarryUsdM({
      notionalLocalM: 10,
      ccy: 'PLN',
      recognizeMonths: 0,
      settleMonths: 6,
      forecastEndMonths: 12,
      fcyFwdRates: rates,
      usdFwdRates: usd,
      fcyCashRates: rates,
      usdCashRates: usd,
    });
    expect(buy.fwdCarryUsdM).toBeLessThan(0);
    expect(buy.usdInterestUsdM).toBeLessThan(0);
    expect(buy.fcyInterestUsdM).toBeGreaterThan(0);
    expect(buy.totalUsdM).toBeLessThan(0);
  });

  it('M12 cover of long PLN earns CIP when cash Δr is negative (not a buy)', () => {
    const cover = 21.6;
    const r_FCY = 3.41;
    const r_USD = 3.50;
    const priced = fwdCarryForExposureCoverUsdM({
      coverLocalM: cover,
      ccy: 'PLN',
      settleMonths: 12,
      r_FCY,
      r_USD,
    });
    expect(r_FCY).toBeLessThan(r_USD);
    expect(priced.fwdCarryUsdM).toBeGreaterThan(0);
    expect(priced.fwdCarryUsdM).toBeCloseTo(
      fwdHedgeCarryUsdYr(-cover, 'PLN', r_FCY, r_USD),
      9,
    );

    const hedge = stripHedgeLegCarryUsdM({
      notionalLocalM: -cover,
      ccy: 'PLN',
      recognizeMonths: 0,
      settleMonths: 12,
      forecastEndMonths: 12,
      fcyFwdRates: rates,
      usdFwdRates: usd,
      fcyCashRates: rates,
      usdCashRates: usd,
      swapPointsCarryUsdM: priced.fwdCarryUsdM,
    });
    expect(hedge.fwdCarryUsdM).toBeGreaterThan(0);
    expect(hedge.fcyInterestUsdM).toBeLessThan(0);
    expect(hedge.usdInterestUsdM).toBeCloseTo(0, 8);
  });

  it('Cash Carry FWD accrued on a Swap+Fwd PLN sell is +CIP — settle delivers, not a buy', () => {
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const bundle: FxMarketRatesBundle = {
      pair: 'USDPLN',
      baseCcy: 'USD',
      quoteCcy: 'PLN',
      sourceFile: 'test',
      spot: { bid: S, ask: S, mid: S },
      deposits: [{
        tenor: '1Y',
        months: 12,
        eur: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.50, debitPct: 3.89 },
        swapPoints: { bid: -92, ask: -80 },
      }],
    };
    const overlay = allocateSwapForwardOverlay({
      exposureLocalM: 0,
      swapNearLocalM: 21.6,
      delta: 1,
      r_FCY: 3.41,
      r_USD: 3.50,
      r_OD: 4.41,
      spot: CURRENCY_PARAMS.PLN!.spot,
    });
    expect(overlay.forwardLocalM).toBeLessThan(0);
    const extra = analyticsForwardsFromOverlays({
      overlayByCcy: { PLN: overlay },
      forecastMonths: 12,
    });
    const cmp = buildCashForecastCarryComparison({
      ccy: 'PLN',
      bookRows: [makeSimRow('16', 'PLN', 0, 0, 0, 10, 0)],
      forecastMonths: 12,
      marketRates: bundle,
      bookedHedges: [],
      preparedByCcy: {},
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 12 },
      extraForwards: extra,
    });
    expect(cmp).not.toBeNull();
    expect(cmp!.categories.fwdCarryUsdM).toBeGreaterThan(0);
    expect(cmp!.hedged.totals.hedgeCashFlowM).toBeLessThan(0);
  });

  it('Cash Carry M12 PLN cover prints +CIP on the empty curve, not a buy', () => {
    const bundle = emptyMarketRatesForCcy('PLN');
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'bullet',
        basis: 'totalExpected',
        ticketBasis: 'stock',
        legs: [],
        coverLocalM: 21.6,
        hedgeRatio: 1,
        settleMonths: 12,
      },
      { marketRates: bundle, bulletSettleMonths: 12 },
    );
    expect(profile.impliedCarryUsdM!).toBeGreaterThan(0);

    const br = hedgeImprovementBreakdownToT(
      [{
        ccy: 'PLN',
        amountLocalM: 21.6,
        settleMonths: 12,
        recognizeMonths: 0,
        structure: 'bullet',
        notionalKind: 'cover',
      }],
      12,
      bundle,
    );
    expect(br.fwdCarryUsdM).toBeGreaterThan(0);
    expect(br.fcyInterestUsdM).toBeLessThan(0);
  });

  it('sell-PLN hedge on negative USDPLN points earns inverted CIP, not N × pts/10_000', () => {
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const ask = -80;
    const cover = 10;
    const bundle: FxMarketRatesBundle = {
      pair: 'USDPLN',
      baseCcy: 'USD',
      quoteCcy: 'PLN',
      sourceFile: 'test',
      spot: { bid: S, ask: S, mid: S },
      deposits: [{
        tenor: '1Y',
        months: 12,
        eur: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.50, debitPct: 3.89 },
        swapPoints: { bid: -92, ask },
      }],
    };
    const earn = cover * (1 / (S + ask / 10_000) - 1 / S);
    expect(earn).toBeGreaterThan(0);

    const hedge = fwdHedgeCarryFromMarketUsd(
      -cover, 'PLN', 3.41, 3.50, 12, bundle,
    );
    expect(hedge).toBeGreaterThan(0);
    expect(hedge).toBeCloseTo(earn, 8);
    expect(hedge).not.toBeCloseTo(cover * (ask / 10_000), 4);

    const h = resolveStrategyHedge('SWAP_FWD', {
      ccy: 'PLN',
      currentFx: cover,
      forecastFx: cover,
      swapNear: 0,
      swapForwardDelta: 1,
      optDelta: 1,
      horizonDays: 30,
      r_FCY: 3.41,
      r_USD: 3.50,
      σ_daily: 0.006363,
      marketRates: bundle,
      farSettleMonths: 12,
    });
    // Naked spot buffer — forecast cover is not squared into Fwd Hedge.
    expect(h.fwdNotional).toBe(0);
    expect(h.fwdCarryUsdYr).toBe(0);
  });

  it('MXN CIP is a cost when the points column is flat or EUR-scale', () => {
    const S = 1 / CURRENCY_PARAMS.MXN!.spot;
    const cover = 146.61;
    const hedge = -cover;
    const cip = fwdHedgeCarryUsdYr(hedge, 'MXN', 6.19, 4);
    expect(cip).toBeLessThan(-0.15);

    const bundle = (bid: number, ask: number): FxMarketRatesBundle => ({
      pair: 'USDMXN',
      baseCcy: 'USD',
      quoteCcy: 'MXN',
      sourceFile: 'test',
      spot: { bid: S, ask: S, mid: S },
      deposits: [{
        tenor: '1Y',
        months: 12,
        eur: { creditPct: 6.19, debitPct: 7.59 },
        usd: { creditPct: 4, debitPct: 4.5 },
        swapPoints: { bid, ask },
      }],
    });

    expect(fwdHedgeCarryFromMarketUsd(hedge, 'MXN', 6.19, 4, 12, bundle(0, 0)))
      .toBeCloseTo(cip, 8);
    expect(fwdHedgeCarryFromMarketUsd(hedge, 'MXN', 6.19, 4, 12, bundle(18, 22)))
      .toBeCloseTo(cip, 8);
  });

  it('coverFromTrade flips overlay extras before CIP / CFaR settle', () => {
    expect(coverFromTradeLocalM(-21.6)).toBeCloseTo(21.6, 9);
    expect(coverFromTradeLocalM(21.6)).toBeCloseTo(-21.6, 9);
  });

  it('both-pay residual overlay sells |Swap Near| — does not buy PLN', () => {
    const rates = {
      r_FCY: 3.41,
      r_USD: 3.50,
      r_OD: 4.41,
      spot: CURRENCY_PARAMS.PLN!.spot,
    };
    expect(clampBothPayBuyToSell({
      forwardLocalM: 21.6,
      sellWeight: 1,
      swapNearLocalM: -21.6,
      ...rates,
    })).toBeLessThan(0);

    const shortNear = allocateResidualSwapForwardOverlay({
      exposureLocalM: 0,
      swapNearLocalM: -21.6,
      residual: 0,
      ...rates,
    });
    expect(shortNear.forwardLocalM).toBeLessThan(0);
    expect(shortNear.forwardLocalM).toBeCloseTo(-21.6, 6);

    const cadEarns = allocateResidualSwapForwardOverlay({
      exposureLocalM: 0,
      swapNearLocalM: -10,
      residual: 0,
      r_FCY: 4.31,
      r_USD: 3.50,
      r_OD: 5.5,
      spot: CURRENCY_PARAMS.CAD!.spot,
    });
    expect(cadEarns.forwardLocalM).toBeGreaterThan(0);
  });

  it('implied FWD on a USDPLN file (baseCcy USD) still earns on long PLN cover', () => {
    const S = 1 / CURRENCY_PARAMS.PLN!.spot;
    const bundle: FxMarketRatesBundle = {
      pair: 'USDPLN',
      baseCcy: 'USD',
      quoteCcy: 'PLN',
      sourceFile: 'test',
      spot: { bid: S, ask: S, mid: S },
      deposits: [{
        tenor: '1Y',
        months: 12,
        eur: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.50, debitPct: 3.89 },
        swapPoints: { bid: -92, ask: -80 },
      }],
    };
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'bullet',
        basis: 'totalExpected',
        ticketBasis: 'stock',
        legs: [],
        coverLocalM: 21.6,
        hedgeRatio: 1,
        settleMonths: 12,
      },
      { marketRates: bundle, bulletSettleMonths: 12 },
    );
    expect(profile.impliedCarryUsdM!).toBeGreaterThan(0);
  });

  it('path-matching PLN cover keeps the short sign — both-pay sell is overlay-only', () => {
    expect(bothPaySellCoverLocalM(-23.4, 'PLN')).toBeCloseTo(23.4, 9);
    expect(bothPaySellCoverLocalM(-16.3, 'EUR')).toBeCloseTo(-16.3, 9);
    expect(hedgeBasisNotionalLocalM('totalExpected', 0, -23.4, 0, 'PLN')).toBeCloseTo(-23.4, 9);
    expect(hedgeBasisNotionalLocalM('totalExpected', 0, -16.3, 0, 'EUR')).toBeCloseTo(-16.3, 9);

    const plnEdges = buildRollingHedgeEdges(
      0,
      [-4, -4, -4, -4, -4, -4],
      { ...DEFAULT_VAR_SETUP, forecastMonths: 6 },
      'windowEnd',
      { ccy: 'PLN' },
    );
    expect(plnEdges[plnEdges.length - 1]!.hedgeLocalM).toBeLessThan(0);

    const bundle = emptyMarketRatesForCcy('PLN');
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'strip',
        basis: 'cash',
        ticketBasis: 'stock',
        legs: [
          {
            index: 0,
            startMonth: 0,
            endMonth: 1,
            settleMonths: 1,
            hedgeLocalM: -8,
            tradeNotionalLocalM: -8,
            label: 'L1',
          },
          {
            index: 1,
            startMonth: 0,
            endMonth: 9,
            settleMonths: 9,
            hedgeLocalM: -23.4,
            tradeNotionalLocalM: -15.4,
            label: 'L2',
          },
        ],
        coverLocalM: -23.4,
        hedgeRatio: 1,
      },
      { marketRates: bundle, bulletSettleMonths: 12, ccy: 'PLN' },
    );
    expect(profile.coverLocalM).toBeCloseTo(-23.4, 9);
    expect(profile.legs[1]!.hedgeLocalM).toBeCloseTo(-23.4, 9);
  });
});
