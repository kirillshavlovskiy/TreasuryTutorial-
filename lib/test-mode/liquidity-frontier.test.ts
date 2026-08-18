import { describe, it, expect } from 'vitest';
import { ccySpotRate, INITIAL_ROWS, type LayerId, type RowState, type SharedGlobals } from '@/lib/fx-buffer';
import { DEFAULT_FORECAST_PROFILE, type ForecastProfileState } from '@/lib/forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING, type LiquidityTiming } from '@/lib/liquidity-ladder';
import { liquidityStrategyMeta } from '@/lib/test-mode/liquidity-strategies';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import {
  buildLiquidityFrontier,
  buildLiquidityLeftEndFrontier,
  cfarAtZeroDelta,
  standingFromCashCarryUsdYr,
  standingForCashCarryStep,
  frontierCashCarrySign,
  frontierFarPointsUsdYr,
  carryAxisFromArms,
  carryFwd,
  farSettleExposureCfarUsdM,
  farSettleUnwindCfarUsdM,
  bookCashCarryK,
  carryStepsToMaxK,
  carryStepStrideK,
  frontierCarryDotsK,
  hedgeIntensity,
  constraintTwinFromHits,
  snapFrontierStandKey,
  signedPeakStanding,
  isDegenerateLiquidityFrontier,
  interpAlong,
  isoSSliceAlphas,
  isoSSlicePoints,
  ISO_S_SLICE_STEPS,
  priceIsoSSlice,
  rssMixCfarUsdM,
  liquidityFrontierBufferBand,
  liquidityFrontierDial,
  liquidityFrontierByDelta,
  liquidityFrontierUpperTail,
  liquidityFrontierWalk,
  liquidityFrontierRays,
  liquidityFrontierSkyline,
  type LiquidityFrontierInput,
  type LiquidityFrontierPoint,
} from '@/lib/test-mode/liquidity-frontier';

const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP')!;

function row(over: Partial<RowState> = {}): RowState {
  return {
    ...gbp,
    cash: 20,
    payout: -90,
    collections: 60,
    fcastFX: 0,
    cash_floor: 5,
    carry_target: 25,
    ...over,
  };
}

function profileWith(timing: Partial<LiquidityTiming> = {}): ForecastProfileState {
  return {
    ...DEFAULT_FORECAST_PROFILE,
    liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: true, ...timing },
  };
}

const shared: SharedGlobals = { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 6 };

function input(over: Partial<LiquidityFrontierInput> = {}): LiquidityFrontierInput {
  return {
    row: row(),
    strategy: liquidityStrategyMeta('rollingProgramme'),
    months: 6,
    shared,
    activeLayers: new Set<LayerId>(['floorH', 'carryOptim']),
    forecastProfile: profileWith({ bookingMode: 'rolling', sizingBasis: 'horizon' }),
    deltas: [0],
    multiples: [0, 1],
    ...over,
  };
}

function pt(
  cfar: number,
  carry: number,
  extra: Partial<LiquidityFrontierPoint> = {},
): LiquidityFrontierPoint {
  return {
    delta: 0,
    multiple: extra.multiple ?? 0,
    phase: extra.phase ?? 'hedged',
    intensity: extra.intensity ?? hedgeIntensity(extra.multiple ?? 0),
    bufferM: 0,
    carryM: 0,
    cashCarryUsdYrM: 0,
    swapCashUsdYrM: 0,
    cipUsdYrM: 0,
    hedgeCarryUsdYrM: 0,
    totalCarryUsdYrM: carry,
    finalCfarUsdM: cfar,
    peakBook: 0,
    levered: false,
    ...extra,
  };
}

describe('liquidityFrontierDial', () => {
  it('labels Target Carry when Buffer Carry target is on', () => {
    expect(liquidityFrontierDial(new Set(['carryOptim']))).toBe('carry_target');
  });

  it('labels Target VAR when a VAR layer is on', () => {
    expect(liquidityFrontierDial(new Set(['portfolioDiv']))).toBe('var_target');
  });

  it('labels Min floor when only the floor is on', () => {
    expect(liquidityFrontierDial(new Set(['floorH']))).toBe('cash_floor');
  });
});

describe('buildLiquidityFrontier', () => {
  it('starts at unfunded — no funding-gap hedge, empty book', () => {
    const built = buildLiquidityFrontier(input({ multiples: [0, 1] }));
    const origin = built.points.find(p => p.phase === 'unfunded' && p.delta === 0);
    expect(origin).toBeTruthy();
    expect(origin!.multiple).toBe(0);
    expect(origin!.peakBook).toBe(0);
    expect(origin!.swapCashUsdYrM).toBe(0);
    expect(origin!.cipUsdYrM).toBe(0);
  });

  it('carry falls from unfunded to the fully hedged cover', () => {
    const built = buildLiquidityFrontier(input({ multiples: [0, 1] }));
    const origin = built.points.find(p => p.multiple === 0 && p.delta === 0)!;
    const covered = built.points.find(p => p.multiple === 1 && p.delta === 0)!;
    expect(covered.peakBook).toBeGreaterThan(origin.peakBook);
    expect(covered.totalCarryUsdYrM).toBeLessThan(origin.totalCarryUsdYrM);
  });

  it('overhedge is a deeper cut in carry than full cover', () => {
    const built = buildLiquidityFrontier(input({ multiples: [1, 2] }));
    const full = built.points.find(p => p.multiple === 1 && p.delta === 0)!;
    const over = built.points.find(p => p.multiple === 2 && p.delta === 0)!;
    expect(over.phase).toBe('overhedged');
    expect(Math.abs(over.peakBook)).toBeGreaterThan(Math.abs(full.peakBook));
    expect(over.totalCarryUsdYrM).toBeLessThan(full.totalCarryUsdYrM);
  });

  it('inverse flips the cover book (short FCY / long USD side)', () => {
    const built = buildLiquidityFrontier(input({ multiples: [1, -1] }));
    const full = built.points.find(p => p.multiple === 1 && p.delta === 0)!;
    const inv = built.points.find(p => p.multiple === -1 && p.delta === 0)!;
    expect(inv.phase).toBe('inverse');
    expect(inv.peakBook).toBeCloseTo(-full.peakBook, 4);
  });

  it('Δ at the same hedge multiple moves hedge carry off the swap-only point', () => {
    const built = buildLiquidityFrontier(input({
      deltas: [0, 1],
      multiples: [1],
    }));
    const d0 = built.points.find(p => p.delta === 0)!;
    const d1 = built.points.find(p => p.delta === 1)!;
    expect(Math.abs(d1.hedgeCarryUsdYrM - d0.hedgeCarryUsdYrM)).toBeGreaterThan(1e-9);
  });

  it('prices the live cover (k = 1) as the applied point', () => {
    const built = buildLiquidityFrontier(input({
      row: row({ cash_floor: 8, carry_target: 22 }),
      multiples: [0, 1],
    }));
    expect(built.applied).not.toBeNull();
    expect(built.applied!.multiple).toBe(1);
    expect(built.applied!.delta).toBe(0);
    expect(built.applied!.bufferM).toBe(8);
    expect(built.applied!.carryM).toBe(22);
  });

  it('unfunded regime is only the origin — no cover book to scale', () => {
    const built = buildLiquidityFrontier(input({
      strategy: liquidityStrategyMeta('unfunded'),
      multiples: [0, 1, -1],
    }));
    expect(built.points.length).toBeGreaterThan(0);
    for (const p of built.points) {
      expect(p.peakBook).toBe(0);
      expect(p.swapCashUsdYrM).toBe(0);
    }
  });
});

describe('liquidityFrontierWalk', () => {
  it('includes unfunded and inverse on one Δ so a PAY book can show a positive tail', () => {
    const built = buildLiquidityFrontier(input({
      deltas: [0],
      multiples: [0, 1, -1],
    }));
    const walk = liquidityFrontierWalk(built.points, 0);
    expect(walk.map(p => p.multiple)).toEqual([0, 1, -1]);
  });
});

describe('liquidityFrontierByDelta', () => {
  it('keeps one (Carry, VAR) point per Δ at the live cover', () => {
    const built = buildLiquidityFrontier(input({
      deltas: [0, 0.5, 1],
      multiples: [0, 1],
    }));
    const series = liquidityFrontierByDelta(built.points);
    expect(series.map(p => p.delta)).toEqual([0, 0.5, 1]);
    expect(series.every(p => p.multiple === 1)).toBe(true);
  });
});

describe('liquidityFrontierRays', () => {
  it('keeps only positive-carry points on each Δ', () => {
    const built = buildLiquidityFrontier(input({
      deltas: [0, 1],
      multiples: [0, 1],
    }));
    const rays = liquidityFrontierRays(built.points);
    expect(rays.length).toBeGreaterThan(0);
    expect(rays.every(r => r.every(p => p.totalCarryUsdYrM > 0))).toBe(true);
  });
});

describe('liquidityFrontierUpperTail', () => {
  it('is a Δ walk with positive carry — not a buffer walk', () => {
    const built = buildLiquidityFrontier(input({
      deltas: [0, 0.5, 1],
      multiples: [0, 1, -1],
    }));
    const upper = liquidityFrontierUpperTail(built.points);
    expect(upper.length).toBeGreaterThan(1);
    expect(upper.every(p => p.totalCarryUsdYrM > 0)).toBe(true);
    expect(upper.every(p => Math.abs(p.multiple - upper[0].multiple) < 1e-9)).toBe(true);
    expect(upper.map(p => p.delta)).toEqual([0, 0.5, 1]);
  });
});

describe('liquidityFrontierBufferBand', () => {
  it('is Δ = 0 only and is not a sign-flip of the upper tail', () => {
    const built = buildLiquidityFrontier(input({
      deltas: [0, 0.5, 1],
      multiples: [0, 1, -1],
    }));
    const upper = liquidityFrontierUpperTail(built.points);
    const lower = liquidityFrontierBufferBand(built.points);
    expect(lower.length).toBeGreaterThan(1);
    expect(lower.every(p => p.delta === 0)).toBe(true);
    expect(new Set(lower.map(p => p.multiple)).size).toBeGreaterThan(1);
    const mirrored = upper.map(p => -p.totalCarryUsdYrM);
    const lowerCarries = lower.map(p => p.totalCarryUsdYrM);
    expect(lowerCarries).not.toEqual(mirrored);
  });
});

describe('cfarOriginUsdM', () => {
  it('reads FX-only Net CFaR from the CFaR section', () => {
    const built = buildLiquidityFrontier(input({
      cfarNetByCcyUsd: { GBP: 0.361 },
    }));
    expect(built.cfarOriginUsdM).toBe(0.361);
  });
});

describe('farSettleExposureCfarUsdM', () => {
  it('moves CFaR with |S| by more than $1K — not a flat section', () => {
    const setup = { ...DEFAULT_VAR_SETUP, forecastMonths: 12 };
    const a = farSettleExposureCfarUsdM(-5, 12, 'EUR', setup, 0.359);
    const b = farSettleExposureCfarUsdM(-20, 12, 'EUR', setup, 0.359);
    expect(a).toBeGreaterThan(0.359);
    expect(b).toBeGreaterThan(a + 0.001);
  });
});

describe('farSettleUnwindCfarUsdM', () => {
  it('is the early-settle rate-diff factor — smaller than open FX revaluation of the same S', () => {
    const setup = { ...DEFAULT_VAR_SETUP, forecastMonths: 12 };
    const open = farSettleExposureCfarUsdM(-20, 12, 'EUR', setup, 0.359);
    const far = farSettleUnwindCfarUsdM(-20, 12, 'EUR', setup, 0.359);
    expect(far).toBeGreaterThan(0.359);
    expect(far).toBeLessThan(open - 0.001);
    const bigger = farSettleUnwindCfarUsdM(-80, 12, 'EUR', setup, 0.359);
    expect(bigger).toBeGreaterThan(far + 0.001);
  });
});

describe('standingFromCashCarryUsdYr', () => {
  it('inverts a short book when only the debit side earns vs USD', () => {
    const S = standingFromCashCarryUsdYr(0.02, 1.35, 3.57, 4.5, 4.0);
    expect(S).toBeLessThan(0);
    expect(S * ((4.0 - 4.5) / 100) * 1.35).toBeCloseTo(0.02, 8);
  });

  it('inverts pay-side S when both long and short pay vs USD (PLN), and still prints +cash on the open arm', () => {
    const spot = ccySpotRate('PLN');
    expect(frontierCashCarrySign(spot, 3.41, 3.50, 4.41)).toBe(-1);
    expect(standingFromCashCarryUsdYr(0.0053, spot, 3.41, 3.50, 4.41)).toBe(0);
    const S = standingForCashCarryStep(5.3, spot, 3.41, 3.50, 4.41);
    expect(S).toBeGreaterThan(10);
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({
        ccy: 'PLN',
        r_FCY: 3.41,
        r_OD: 4.41,
        cash_floor: 0,
        carry_target: 0,
      }),
      shared: { ...shared, r_USD: 3.50 },
      cfarNetByCcyUsd: { PLN: 0.22 },
      carryUsdK: [5.3, 10, 20],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    expect(built.upper.length).toBeGreaterThan(0);
    expect(built.upper.every(p => p.cashCarryUsdYrM > 0)).toBe(true);
    expect(built.upper.every(p => p.totalCarryUsdYrM > 0)).toBe(true);
  });

  it('puts CIP below +cash when the cash Δr is a pay', () => {
    expect(frontierFarPointsUsdYr(-0.005, 0.005)).toBe(-0.005);
    expect(frontierFarPointsUsdYr(-0.005, -0.12)).toBe(-0.12);
    expect(frontierFarPointsUsdYr(0.04, -0.02)).toBe(-0.02);
  });
});

describe('cfarAtZeroDelta', () => {
  it('keeps the section CFaR at floor 0 and only adds buffer on top', () => {
    expect(cfarAtZeroDelta(0.361, 0, 0)).toBe(0.361);
    expect(cfarAtZeroDelta(0.361, 0.05, 0)).toBeCloseTo(0.411, 4);
  });
});

describe('buildLiquidityLeftEndFrontier', () => {
  it('pairs open-cash FX CFaR with a smaller far-on unwind CFaR at the same S', () => {
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: 0 }),
      cfarNetByCcyUsd: { GBP: 0.361 },
      carryUsdK: [10, 20, 30],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    expect(built.walk).toBe('carry_pair');
    expect(built.origin.totalCarryUsdYrM).toBe(0);
    expect(built.origin.finalCfarUsdM).toBe(0.361);
    expect(built.upper.length).toBeGreaterThan(0);
    expect(built.lower.length).toBeGreaterThan(0);
    expect(built.upper.every(p => p.totalCarryUsdYrM > 0)).toBe(true);
    expect(built.lower.every(p => p.delta === 1)).toBe(true);
    const open = built.upper.find(p => p.delta < 1e-9 && Math.abs(p.cashCarryUsdYrM - 0.02) < 1e-6);
    const hedged = built.lower.find(p => Math.abs(p.peakBook - (open?.peakBook ?? NaN)) < 1e-6);
    expect(open).toBeTruthy();
    expect(hedged).toBeTruthy();
    expect(hedged!.finalCfarUsdM).toBeLessThan(open!.finalCfarUsdM - 0.001);
    expect(hedged!.totalCarryUsdYrM).toBeCloseTo(
      open!.cashCarryUsdYrM + open!.cipUsdYrM,
      6,
    );
    const first = built.lower[0]!;
    const last = built.lower[built.lower.length - 1]!;
    expect(last.finalCfarUsdM).toBeGreaterThan(first.finalCfarUsdM + 0.001);
  });

  it('extends the cash grid past $100K when asked — leverage steps', () => {
    expect(carryStepsToMaxK(200).some(k => k >= 200)).toBe(true);
    expect(carryStepsToMaxK(200).length).toBeGreaterThan(carryStepsToMaxK(100).length);
    const bookS = standingFromCashCarryUsdYr(
      0.05, ccySpotRate('GBP'), gbp.r_FCY, shared.r_USD, gbp.r_OD,
    );
    expect(bookCashCarryK(bookS, ccySpotRate('GBP'), gbp.r_FCY, shared.r_USD, gbp.r_OD))
      .toBeGreaterThan(40);
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: 0 }),
      bookStanding: bookS,
      cfarNetByCcyUsd: { GBP: 0.361 },
      carryUsdK: carryStepsToMaxK(200),
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    expect(built.bookCashK).toBeGreaterThan(40);
    expect(built.upper.some(p => p.levered)).toBe(true);
    expect(built.upper.some(p => !p.levered && p.cashCarryUsdYrM > 0)).toBe(true);
  });

  it('caps the default plot at a handful of cash dots, including the live book', () => {
    const near = frontierCarryDotsK(0);
    expect(near[0]).toBeLessThanOrEqual(0.5);
    expect(near.filter(k => k <= 3).length).toBeGreaterThanOrEqual(4);
    expect(near[near.length - 1]!).toBeLessThanOrEqual(50);
    const withBook = frontierCarryDotsK(50);
    expect(withBook.some(k => k <= 5)).toBe(true);
    expect(withBook.some(k => Math.abs(k - 50) < 0.51)).toBe(true);
    const tailed = frontierCarryDotsK(50, { targetCashK: 50, tail: true });
    expect(tailed[tailed.length - 1]!).toBeGreaterThan(50);
    expect(frontierCarryDotsK(1000).filter(k => k <= 8).length).toBeGreaterThanOrEqual(6);
    expect(frontierCarryDotsK(1000).length).toBeLessThanOrEqual(42);
    expect(frontierCarryDotsK(1000, { targetCashK: 1000, tail: true, maxK: 2000 }).length)
      .toBeLessThanOrEqual(48);
    expect(carryStepsToMaxK(1000).length).toBeLessThanOrEqual(16);
    expect(carryStepStrideK(1000)).toBeGreaterThan(10);
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: 0 }),
      cfarNetByCcyUsd: { GBP: 0.361 },
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    const open = built.upper.filter(p => p.delta < 1e-9);
    expect(open.length).toBeGreaterThan(8);
    expect(open.length).toBeLessThanOrEqual(42);
    expect(open.filter(p => Math.abs(p.cashCarryUsdYrM) * 1000 <= 8).length)
      .toBeGreaterThanOrEqual(4);
  });

  it('extends past the live book when a carry / VAR ask is on', () => {
    const bookS = standingFromCashCarryUsdYr(
      0.04, ccySpotRate('GBP'), gbp.r_FCY, shared.r_USD, gbp.r_OD,
    );
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: bookS }),
      bookStanding: bookS,
      activeLayers: new Set<LayerId>(['carryOptim']),
      cfarNetByCcyUsd: { GBP: 0.361 },
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    expect(built.constraint.dial).toBe('carry_target');
    const open = built.upper.filter(p => p.delta < 1e-9);
    expect(open.some(p => p.levered)).toBe(true);
    expect(open.some(p => Math.abs(p.cashCarryUsdYrM) * 1000 < 8)).toBe(true);
  });

  it('marks Target Carry as a horizontal hit on both arms', () => {
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: -20 }),
      activeLayers: new Set<LayerId>(['carryOptim']),
      cfarNetByCcyUsd: { GBP: 0.361 },
      carryUsdK: [10, 20, 40],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    expect(built.constraint.dial).toBe('carry_target');
    expect(built.constraint.hCarryUsdYrM).not.toBeNull();
    expect(built.constraint.vCfarUsdM).toBeNull();
    expect(built.constraint.openHit).not.toBeNull();
    expect(built.constraint.hedgeHit).not.toBeNull();
    expect(built.constraint.openHit!.standing).toBeCloseTo(
      built.constraint.hedgeHit!.standing, 5,
    );
    expect(built.constraint.hedgeHit!.cfarUsdM)
      .toBeLessThan(built.constraint.openHit!.cfarUsdM - 0.001);
    expect(built.constraint.openHit!.carryUsdYrM)
      .not.toBeCloseTo(built.constraint.hedgeHit!.carryUsdYrM, 3);
  });

  it('marks Target VAR as a vertical cut — carry open vs far at the same CFaR', () => {
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: -20 }),
      activeLayers: new Set<LayerId>(['portfolioDiv']),
      cfarNetByCcyUsd: { GBP: 0.361 },
      carryUsdK: [10, 20, 40, 80],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    expect(built.constraint.dial).toBe('var_target');
    expect(built.constraint.vCfarUsdM).not.toBeNull();
    expect(built.constraint.vCfarUsdM).toBeGreaterThan(0.361);
    expect(built.constraint.openHit).not.toBeNull();
    expect(built.constraint.hedgeHit).not.toBeNull();
    expect(built.constraint.openHit!.cfarUsdM).toBeCloseTo(built.constraint.hedgeHit!.cfarUsdM, 5);
    expect(built.constraint.openHit!.cfarUsdM).toBeCloseTo(built.constraint.vCfarUsdM!, 5);
    expect(built.constraint.openHit!.carryUsdYrM)
      .toBeGreaterThan(built.constraint.hedgeHit!.carryUsdYrM);
  });

  it('draws the open arm when cash Δr is negative on both sides (PLN)', () => {
    const pln = INITIAL_ROWS.find(r => r.ccy === 'PLN')!;
    const built = buildLiquidityLeftEndFrontier(input({
      row: { ...pln, cash_floor: 6, carry_target: 21.6 },
      shared: { r_USD: 3.50, σ_P: 0.1, days: 3, forecastMonths: 6 },
      bookStanding: 21.6,
      activeLayers: new Set<LayerId>(['portfolioDiv']),
      cfarNetByCcyUsd: { PLN: 0 },
      carryUsdK: [1, 2, 5.3, 10, 20],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    expect(built.upper.length).toBeGreaterThan(0);
    expect(built.lower.length).toBeGreaterThan(0);
    expect(built.upper.every(p => p.delta < 1e-9)).toBe(true);
    expect(built.upper.every(p => p.cashCarryUsdYrM > 0)).toBe(true);
    expect(built.constraint.vCfarUsdM).toBeGreaterThan(0);
    expect(built.constraint.openHit).not.toBeNull();
    expect(built.constraint.hedgeHit).not.toBeNull();
    expect(built.constraint.openHit!.cfarUsdM)
      .toBeCloseTo(built.constraint.vCfarUsdM!, 4);
    const opens = built.upper.filter(p => p.delta < 1e-9);
    expect(opens.length).toBe(built.lower.length);
    for (let i = 0; i < opens.length; i++) {
      expect(built.lower[i]!.peakBook).toBeCloseTo(opens[i]!.peakBook, 5);
      expect(built.lower[i]!.totalCarryUsdYrM)
        .toBeLessThanOrEqual(opens[i]!.totalCarryUsdYrM + 1e-6);
      expect(built.lower[i]!.finalCfarUsdM)
        .toBeLessThan(opens[i]!.finalCfarUsdM - 0.001);
    }
  });

  it('snaps the sweet spot to the Target Carry / Target VAR cut, not the origin', () => {
    const twins = [
      { key: 'origin', standing: 0 },
      { key: '-8.0000', standing: -8 },
      { key: '-12.4000', standing: -12.4 },
      { key: '-20.0000', standing: -20 },
    ];
    const hit = { standing: -12.4, cfarUsdM: 0.41, carryUsdYrM: 0.04 };
    expect(snapFrontierStandKey('carry_target', hit, twins)).toBe('-12.4000');
    expect(snapFrontierStandKey('var_target', hit, twins)).toBe('-12.4000');
    expect(snapFrontierStandKey('cash_floor', hit, twins)).toBe('origin');
    expect(snapFrontierStandKey('carry_target', null, twins)).toBe('origin');
  });

  it('opens a Target Carry book on the constraint standing, not S = 0', () => {
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: -20 }),
      activeLayers: new Set<LayerId>(['carryOptim']),
      cfarNetByCcyUsd: { GBP: 0.361 },
      bookStanding: -20,
      carryUsdK: [10, 20, 40],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    const hit = built.constraint.openHit!;
    const hedge = built.constraint.hedgeHit!;
    const syn = constraintTwinFromHits(hit, hedge, built.origin, built.origin);
    const twins = [
      { key: 'origin', standing: 0 },
      ...built.upper
        .filter(p => p.delta < 1e-9)
        .map(p => ({ key: p.peakBook.toFixed(4), standing: p.peakBook })),
      { key: syn.key, standing: syn.open.peakBook },
    ];
    const key = snapFrontierStandKey('carry_target', hit, twins);
    expect(key).toBe(syn.key);
    expect(syn.open.peakBook).toBeCloseTo(-20, 5);
  });

  it('reads signed peak standing from a short book', () => {
    expect(signedPeakStanding([
      { standing_swap: -12 },
      { standing_swap: -8 },
    ])).toBe(-12);
  });
});

describe('rssMixCfarUsdM', () => {
  it('recovers the open and far endpoints', () => {
    expect(rssMixCfarUsdM(0.36, 0.50, 0.40, 0)).toBeCloseTo(0.50, 10);
    expect(rssMixCfarUsdM(0.36, 0.50, 0.40, 1)).toBeCloseTo(0.40, 10);
  });

  it('bows left of the linear CFaR interpolant at mid-cover', () => {
    const mid = rssMixCfarUsdM(0.36, 0.50, 0.40, 0.5);
    const lerp = 0.5 * 0.50 + 0.5 * 0.40;
    expect(mid).toBeLessThan(lerp - 1e-4);
    expect(mid).toBeGreaterThan(0.36);
  });
});

describe('priceIsoSSlice', () => {
  it('keeps Y linear in cover and X on the RSS curve, not the chord', () => {
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: 0 }),
      cfarNetByCcyUsd: { GBP: 0.361 },
      carryUsdK: [20],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    const open = built.upper.find(p => p.delta < 1e-9)!;
    const far = built.lower.find(p => Math.abs(p.peakBook - open.peakBook) < 1e-6)!;
    const mid = priceIsoSSlice(open, far, built.cfarOriginUsdM, 0.5);
    expect(mid.totalCarryUsdYrM).toBeCloseTo(
      (open.totalCarryUsdYrM + far.totalCarryUsdYrM) / 2,
      6,
    );
    expect(mid.finalCfarUsdM).toBeLessThan(
      (open.finalCfarUsdM + far.finalCfarUsdM) / 2 - 1e-6,
    );
    expect(mid.finalCfarUsdM).toBeGreaterThan(far.finalCfarUsdM);
    expect(mid.finalCfarUsdM).toBeLessThan(open.finalCfarUsdM);
    const slice = isoSSlicePoints(open, far, built.cfarOriginUsdM);
    expect(slice.length).toBeGreaterThanOrEqual(ISO_S_SLICE_STEPS + 1);
    expect(slice[0]).toBe(open);
    expect(slice[slice.length - 1]).toBe(far);
    for (let i = 1; i < slice.length; i += 1) {
      expect(slice[i]!.delta).toBeGreaterThan(slice[i - 1]!.delta);
    }
    expect(priceIsoSSlice(open, far, built.cfarOriginUsdM, 0)).toBe(open);
    expect(priceIsoSSlice(open, far, built.cfarOriginUsdM, 1)).toBe(far);
  });

  it('places extra Δ knots at Y = 0 and the RSS corner', () => {
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: 0 }),
      cfarNetByCcyUsd: { GBP: 0.361 },
      carryUsdK: [20],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    const open = built.upper.find(p => p.delta < 1e-9)!;
    const far = built.lower.find(p => Math.abs(p.peakBook - open.peakBook) < 1e-6)!;
    const alphas = isoSSliceAlphas(open, far, built.cfarOriginUsdM);
    expect(alphas[0]).toBe(0);
    expect(alphas[alphas.length - 1]).toBe(1);
    const a0 = -open.cashCarryUsdYrM / open.cipUsdYrM;
    if (a0 > 0 && a0 < 1) {
      expect(alphas.some(a => Math.abs(a - a0) < 1.5e-6)).toBe(true);
    }
    const section = built.cfarOriginUsdM;
    const fxAdd = Math.sqrt(Math.max(0, open.finalCfarUsdM ** 2 - section ** 2));
    const rateAdd = Math.sqrt(Math.max(0, far.finalCfarUsdM ** 2 - section ** 2));
    const den = fxAdd * fxAdd + rateAdd * rateAdd;
    if (den > 1e-16) {
      const aStar = (fxAdd * fxAdd) / den;
      if (aStar > 0 && aStar < 1) {
        expect(alphas.some(a => Math.abs(a - aStar) < 1.5e-6)).toBe(true);
      }
    }
  });

  it('is less risky than the same-S open point, not than a smaller unhedged S at the same Y', () => {
    const built = buildLiquidityLeftEndFrontier(input({
      row: row({ cash_floor: 0, carry_target: 0 }),
      cfarNetByCcyUsd: { GBP: 0.361 },
      carryUsdK: [10, 20, 30, 40, 50],
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, forecastUncertainty1m: 0.3 },
    }));
    const open = built.upper.find(p => p.delta < 1e-9 && Math.abs(p.cashCarryUsdYrM - 0.04) < 1e-6)!;
    const far = built.lower.find(p => Math.abs(p.peakBook - open.peakBook) < 1e-6)!;
    const mid = priceIsoSSlice(open, far, built.cfarOriginUsdM, 0.5);
    const opens = built.upper.filter(p => p.delta < 1e-9);
    expect(mid.finalCfarUsdM).toBeLessThan(open.finalCfarUsdM);
    expect(mid.totalCarryUsdYrM).toBeLessThan(open.totalCarryUsdYrM);
    const greenAtY = interpAlong(
      [built.origin, ...opens],
      mid.totalCarryUsdYrM,
      'carry',
    );
    expect(greenAtY).toBeTruthy();
    expect(mid.finalCfarUsdM).toBeGreaterThan(greenAtY!.cfarUsdM);
  });
});

describe('carryAxisFromArms', () => {
  const onPlot = (usdM: number, axis: { s: number; zNeg: number; zPos: number }) => {
    const z = carryFwd(usdM, axis.s);
    return z >= axis.zNeg - 1e-6 && z <= axis.zPos + 1e-6;
  };

  it('keeps a deeply negative PLN far arm on the plot when open cash is tiny', () => {
    const openMax = 0.02;
    const farMin = -0.139;
    const axis = carryAxisFromArms(0, openMax, farMin);
    expect(onPlot(openMax, axis)).toBe(true);
    expect(onPlot(0, axis)).toBe(true);
    expect(onPlot(farMin, axis)).toBe(true);
    expect(axis.zNeg).toBeLessThan(carryFwd(farMin * 0.5, axis.s));
  });

  it('does not let far CIP steal the negative band when open cash also goes below $0', () => {
    const axis = carryAxisFromArms(-0.04, 0.08, -0.4);
    const openLo = carryFwd(-0.04, axis.s);
    const span = axis.zPos - axis.zNeg;
    expect((openLo - axis.zNeg) / span).toBeGreaterThan(0.04);
    expect((0 - openLo) / span).toBeGreaterThan(0.12);
  });
});

describe('liquidityFrontierSkyline', () => {
  it('keeps rising carry as VAR rises and drops a dominated interior', () => {
    const skyline = liquidityFrontierSkyline([
      pt(1, 5, { multiple: 0 }),
      pt(2, 3, { multiple: 1 }),
      pt(2.5, 2, { multiple: 1.5 }),
      pt(3, 6, { multiple: -1 }),
    ]);
    expect(skyline.map(p => p.multiple)).toEqual([0, -1]);
  });

  it('reports a one-point skyline as degenerate', () => {
    const all = [pt(1, 2), pt(2, 1)];
    const skyline = liquidityFrontierSkyline(all);
    expect(skyline).toHaveLength(1);
    expect(isDegenerateLiquidityFrontier(all, skyline)).toBe(true);
  });
});
