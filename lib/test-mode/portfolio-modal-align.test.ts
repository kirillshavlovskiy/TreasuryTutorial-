import { describe, expect, it } from 'vitest';
import { INITIAL_ROWS, type LayerId, type RowState, type SharedGlobals } from '@/lib/fx-buffer';
import { DEFAULT_FORECAST_PROFILE, type ForecastProfileState } from '@/lib/forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING, type LiquidityTiming } from '@/lib/liquidity-ladder';
import { liquidityStrategyMeta } from '@/lib/test-mode/liquidity-strategies';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import {
  buildLiquidityLeftEndFrontier,
  carryFwd,
  priceLiquidityStanding,
  type LiquidityFrontierInput,
} from '@/lib/test-mode/liquidity-frontier';
import {
  buildSoloCcyAlignedFrontier,
  conservativeFundingPoint,
  maxVarWithinPolicyPoint,
  localCarryCfarSlope,
  carryTargetOnArm,
  DEFAULT_DESK_TARGET_CARRY_USD_YR,
  orderedLiquidityScenarioPoints,
  tangencyByParallelDerivative,
  tangencyFromTrueZero,
  tangencyFromOrigin,
  modalDefaultCarryUsdK,
  mixFundingAndOverlay,
  pricedFundingWalk,
  overlayKToModalXy,
  pickConservativeFundingBook,
  portfolioFrontierFromLeftEnd,
  unhedgedSectionCfarUsdM,
} from '@/lib/test-mode/portfolio-modal-align';

const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
const shared: SharedGlobals = { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 6 };

function row(over: Partial<RowState> = {}): RowState {
  return {
    ...eur,
    cash: 20,
    payout: -40,
    collections: 20,
    fcastFX: 0,
    cash_floor: 2,
    carry_target: 12,
    ...over,
  };
}

function profileWith(timing: Partial<LiquidityTiming> = {}): ForecastProfileState {
  return {
    ...DEFAULT_FORECAST_PROFILE,
    liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: true, ...timing },
  };
}

function engine(over: Partial<LiquidityFrontierInput> = {}): Omit<
  LiquidityFrontierInput,
  'row' | 'strategy' | 'bookStanding' | 'carryUsdK'
> {
  return {
    months: 6,
    shared,
    activeLayers: new Set<LayerId>(['floorH', 'carryOptim', 'portfolioDiv', 'cfarCover']),
    forecastProfile: profileWith({ bookingMode: 'rolling', sizingBasis: 'horizon' }),
    setup: DEFAULT_VAR_SETUP,
    cfarNetByCcyUsd: { EUR: 0.42 },
    ...over,
  };
}

describe('portfolioFrontierFromLeftEnd', () => {
  it('copies origin + open/far arms from the per-currency left-end', () => {
    const r = row();
    const eng = engine();
    const standing = 12;
    const left = buildLiquidityLeftEndFrontier({
      ...eng,
      row: r,
      strategy: liquidityStrategyMeta('rollingProgramme'),
      bookStanding: standing,
      carryUsdK: modalDefaultCarryUsdK(r, eng, standing),
    });
    const mapped = portfolioFrontierFromLeftEnd(left);
    expect(mapped.points[0]!.portfolioVarUsd).toBeCloseTo(left.origin.finalCfarUsdM, 10);
    expect(mapped.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 10);
    const opens = left.upper.filter(p => p.delta < 1e-9);
    expect(mapped.points.length).toBe(opens.length + 1);
    expect(mapped.farPoints.length).toBe(left.lower.length + 1);
    const first = mapped.points[1]!;
    const src = opens[0]!;
    expect(first.portfolioVarUsd).toBeCloseTo(src.finalCfarUsdM, 10);
    expect(first.totalCarryUsdYr).toBeCloseTo(src.totalCarryUsdYrM, 10);
  });
});

describe('buildSoloCcyAlignedFrontier', () => {
  it('EUR-only limited-universe points match the EUR modal left-end', () => {
    const r = row();
    const eng = engine();
    const standing = 12;
    const aligned = buildSoloCcyAlignedFrontier({
      row: r,
      engine: eng,
      strategy: liquidityStrategyMeta('rollingProgramme'),
      bookStanding: standing,
    });
    const left = buildLiquidityLeftEndFrontier({
      ...eng,
      row: r,
      strategy: liquidityStrategyMeta('rollingProgramme'),
      bookStanding: standing,
      carryUsdK: modalDefaultCarryUsdK(r, eng, standing),
    });
    expect(aligned.points[0]!.portfolioVarUsd).toBeCloseTo(0.42, 8);
    expect(aligned.points.length).toBe(left.curve.length);
    aligned.points.forEach((p, i) => {
      const src = left.curve[i]!;
      expect(p.portfolioVarUsd).toBeCloseTo(src.finalCfarUsdM, 8);
      expect(p.totalCarryUsdYr).toBeCloseTo(src.totalCarryUsdYrM, 8);
    });
  });

  it('origin CFaR is the overdraft / FX-only section, not a leftover desk net', () => {
    const r = row();
    const eng = engine();
    const aligned = buildSoloCcyAlignedFrontier({
      row: r,
      engine: eng,
      strategy: liquidityStrategyMeta('rollingProgramme'),
      bookStanding: 12,
      sectionCfarUsdM: 0.335,
    });
    expect(aligned.points[0]!.portfolioVarUsd).toBeCloseTo(0.335, 8);
    expect(aligned.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 10);
  });

  it('a sampled standing prices with the same CFaR as the modal engine', () => {
    const r = row();
    const eng = engine();
    const standing = 8;
    const aligned = buildSoloCcyAlignedFrontier({
      row: r,
      engine: eng,
      strategy: liquidityStrategyMeta('rollingProgramme'),
      bookStanding: standing,
    });
    const sample = aligned.points.find(p => p.k > 1) ?? aligned.points[1]!;
    const priced = priceLiquidityStanding({ ...eng, row: r }, sample.k, 0);
    expect(sample.portfolioVarUsd).toBeCloseTo(priced.cfarOpenUsdM, 5);
    expect(sample.totalCarryUsdYr).toBeCloseTo(priced.open.totalCarryUsdYrM, 5);
  });
});

describe('overlayKToModalXy', () => {
  it('k = 0 sits on the modal origin (section CFaR, $0 carry)', () => {
    const r = row();
    const eng = engine();
    const xy = overlayKToModalXy(0, r, eng, 12);
    expect(xy).not.toBeNull();
    expect(xy!.x).toBeCloseTo(0.42, 8);
    expect(xy!.y).toBeCloseTo(0, 8);
  });

  it('k = 0 stays at $0 carry even when the live book has standing', () => {
    const r = row();
    const eng = engine();
    const xy = overlayKToModalXy(0, r, eng, 40);
    expect(xy!.x).toBeCloseTo(0.42, 8);
    expect(xy!.y).toBe(0);
  });
});

describe('unhedgedSectionCfarUsdM', () => {
  it('is the CFaR-tab Σ, not RSS of the same Nets', () => {
    const net = { EUR: 0.334, GBP: 0.3 };
    const sum = unhedgedSectionCfarUsdM(net);
    expect(sum).toBeCloseTo(0.634, 8);
    expect(sum).not.toBeCloseTo(Math.hypot(0.334, 0.3), 3);
  });

  it('drops USD and respects the include filter', () => {
    expect(unhedgedSectionCfarUsdM(
      { EUR: 0.334, GBP: 0.3, USD: 9 },
      ccy => ccy === 'EUR',
    )).toBeCloseTo(0.334, 8);
  });
});

describe('pricedFundingWalk', () => {
  it('t=0 is Unhedged and t=1 is a priced hold, not a table pin', () => {
    const r = row({ cash: 20, payout: -40 });
    const walk = pricedFundingWalk({
      byCcy: [{ ccy: 'EUR', plan: [{ standing_swap: 12 }] }],
      rows: [r],
      engine: engine(),
      unhedgedCfarUsdM: 0.359,
      steps: 6,
    });
    expect(walk).not.toBeNull();
    expect(walk!.origin.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(walk!.origin.portfolioVarUsd).toBeCloseTo(0.359, 8);
    expect(walk!.path[0]!.portfolioVarUsd).toBeCloseTo(0.359, 8);
    expect(walk!.path[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(walk!.hold.k).toBe(0);
    const priced = priceLiquidityStanding({ ...engine(), row: r }, 12, 0);
    expect(walk!.hold.portfolioVarUsd).toBeCloseTo(priced.open.finalCfarUsdM, 5);
    expect(walk!.hold.totalCarryUsdYr).toBeCloseTo(priced.open.totalCarryUsdYrM, 5);
    expect(walk!.path.length).toBeGreaterThan(4);
    const mid = walk!.path[3]!;
    expect(mid.k).toBeLessThan(0);
    const midS = (3 / 6) * 12;
    const pricedMid = priceLiquidityStanding({ ...engine(), row: r }, midS, 0);
    expect(mid.portfolioVarUsd).toBeCloseTo(pricedMid.open.finalCfarUsdM, 5);
    expect(mid.totalCarryUsdYr).toBeCloseTo(pricedMid.open.totalCarryUsdYrM, 5);
  });
});

describe('mixFundingAndOverlay', () => {
  it('leaves Unhedged with overlay immediately — not a funding-only chord to Conservative', () => {
    const hold = {
      k: 0, portfolioVarUsd: 0.55, totalCarryUsdYr: 0.23, floorBoundCcys: [],
    };
    const origin = {
      k: -1, portfolioVarUsd: 0.36, totalCarryUsdYr: 0, floorBoundCcys: [],
    };
    const midFund = {
      k: -0.5, portfolioVarUsd: 0.45, totalCarryUsdYr: 0.11, floorBoundCcys: [],
    };
    const mixed = mixFundingAndOverlay(
      { path: [origin, midFund, hold], hold },
      {
        points: [
          { k: 0, portfolioVarUsd: 0.36, totalCarryUsdYr: 0, floorBoundCcys: [] },
          { k: 0.2, portfolioVarUsd: Math.hypot(0.36, 0.2), totalCarryUsdYr: 0.04, floorBoundCcys: [] },
          { k: 2, portfolioVarUsd: Math.hypot(0.36, 2), totalCarryUsdYr: 0.1, floorBoundCcys: [] },
        ],
        farPoints: [],
        sweetSpotIndex: 2,
        nearestClampCcy: null,
        nearestClampVarUsd: null,
      },
      0.36,
    );
    expect(mixed.points[0]!.portfolioVarUsd).toBeCloseTo(0.36, 8);
    expect(mixed.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    const early = mixed.points.find(p => p.k > 0 && p.k < 0.5)!;
    expect(early).toBeDefined();
    expect(early.k).toBeGreaterThan(0);
    const chordY = hold.totalCarryUsdYr
      * (early.portfolioVarUsd - 0.36) / (hold.portfolioVarUsd - 0.36);
    expect(Math.abs(early.totalCarryUsdYr - chordY)).toBeGreaterThan(0.005);
  });
});

describe('conservativeFundingPoint', () => {
  it('is buffer cash + swap interest — no far CIP, no hedge FWD', () => {
    const p = conservativeFundingPoint({
      byCcy: [
        { ccy: 'EUR', cashCarryUsdYrM: 0.04, swapInterestUsdYrM: 0.01, cfarUsdM: 0.334 },
        { ccy: 'GBP', cashCarryUsdYrM: 0.02, swapInterestUsdYrM: 0.005, cfarUsdM: 0.3 },
      ],
    });
    expect(p.portfolioVarUsd).toBeCloseTo(0.634, 8);
    expect(p.totalCarryUsdYr).toBeCloseTo(0.075, 8);
  });

  it('respects the include filter', () => {
    const p = conservativeFundingPoint({
      byCcy: [
        { ccy: 'EUR', cashCarryUsdYrM: 0.04, swapInterestUsdYrM: 0, cfarUsdM: 0.334 },
        { ccy: 'GBP', cashCarryUsdYrM: 0.9, swapInterestUsdYrM: 0, cfarUsdM: 9 },
      ],
      includeCcy: ccy => ccy === 'EUR',
    });
    expect(p.portfolioVarUsd).toBeCloseTo(0.334, 8);
    expect(p.totalCarryUsdYr).toBeCloseTo(0.04, 8);
  });
});

describe('maxVarWithinPolicyPoint', () => {
  const pt = (
    k: number, varUsd: number, carry: number,
  ): import('@/lib/fx-buffer').PortfolioCarryFrontierPoint => ({
    k, portfolioVarUsd: varUsd, totalCarryUsdYr: carry, floorBoundCcys: [],
  });

  it('picks max VAR on the overlay arm still inside the policy cap', () => {
    const p = maxVarWithinPolicyPoint([
      pt(-0.5, 0.4, 0.1),
      pt(0, 0.55, 0.23),
      pt(5, 5.1, 0.4),
      pt(18, 18.2, 0.9),
      pt(25, 25.4, 1.1),
    ], 20);
    expect(p?.portfolioVarUsd).toBeCloseTo(20, 8);
    expect(p!.k).toBeGreaterThan(18);
    expect(p!.k).toBeLessThan(25);
  });

  it('does not pick a point above the cap (nearest-to-tier bug)', () => {
    const p = maxVarWithinPolicyPoint([
      pt(0, 0.5, 0.2),
      pt(10, 10, 0.5),
      pt(22, 22, 0.8),
    ], 20);
    expect(p?.portfolioVarUsd).toBeLessThanOrEqual(20);
    expect(p?.portfolioVarUsd).toBeCloseTo(20, 8);
  });

  it('returns the last overlay point when the sweep never reaches the cap', () => {
    const p = maxVarWithinPolicyPoint([
      pt(0, 0.5, 0.2),
      pt(3, 3.1, 0.4),
    ], 20);
    expect(p?.portfolioVarUsd).toBeCloseTo(3.1, 8);
  });

  it('ignores the funding approach even if it is the only point under the cap', () => {
    expect(maxVarWithinPolicyPoint([pt(-1, 0.4, 0)], 20)).toBeNull();
  });

  it('orders origin < Conservative < Balanced < Max Carry by CFaR', () => {
    const pts = [
      pt(0, 0.40, 0),
      pt(0.5, 0.48, 0.10),
      pt(1, 0.55, 0.23),
      pt(1.05, 0.52, 0.24),
      pt(1.4, 4.2, 0.50),
      pt(2, 8.0, 0.80),
      pt(4, 20, 1.10),
    ];
    const o = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[2],
      policyCapUsd: 20,
      originCfarUsd: 0.40,
    });
    expect(o.origin!.totalCarryUsdYr).toBe(0);
    expect(o.conservative!.portfolioVarUsd).toBeGreaterThan(o.origin!.portfolioVarUsd);
    expect(o.balanced!.portfolioVarUsd).toBeCloseTo(
      tangencyFromTrueZero(pts)!.portfolioVarUsd, 8,
    );
    expect(o.maxCarry!.portfolioVarUsd).toBeLessThanOrEqual(20 + 1e-6);
  });

  it('does not pin Unhedged to a larger CFaR-tab Σ the walk never starts at', () => {
    const pts = [
      pt(0, 0.21, 0),
      pt(1, 0.55, 0.23),
      pt(2, 8.0, 0.80),
      pt(4, 20, 1.10),
    ];
    const o = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[1],
      policyCapUsd: 20,
      originCfarUsd: 0.359,
    });
    expect(o.origin!.portfolioVarUsd).toBeCloseTo(0.21, 8);
    expect(o.origin!.totalCarryUsdYr).toBe(0);
    expect(o.conservative!.portfolioVarUsd).toBeGreaterThan(o.origin!.portfolioVarUsd);
  });

  it('tangencyByParallelDerivative is the (γ−origin)∥γ′ vertex', () => {
    const pts = [
      pt(0, 0, 0),
      pt(1, 1, 1),
      pt(2, 2, 1.5),
      pt(3, 3, 2.5),
    ];
    const hit = tangencyByParallelDerivative(pts, { portfolioVarUsd: 0, totalCarryUsdYr: 0 });
    expect(hit!.portfolioVarUsd).toBeCloseTo(2, 8);
  });

  it('localCarryCfarSlope is the neighbor difference, not the origin secant', () => {
    const pts = [
      pt(0, 1, 0),
      pt(1, 2, 1),
      pt(2, 4, 1.5),
    ];
    expect(localCarryCfarSlope(pts, pts[1]!)).toBeCloseTo((1.5 - 0) / (4 - 1), 8);
    expect(localCarryCfarSlope(pts, pts[1]!)).not.toBeCloseTo((1 - 0) / (2 - 1), 4);
  });

  it('the (0,0) ray through the touch stays above every other sample', () => {
    const pts = [
      pt(0, 0.634, 0),
      pt(0.4, 0.80, 0.04),
      pt(0.8, 1.10, 0.09),
      pt(1, 2.125, 0.114),
      pt(1.4, 4.0, 0.20),
      pt(2, 8.0, 0.35),
      pt(4, 20, 0.50),
    ];
    const s = 0.50;
    const touch = tangencyFromTrueZero(pts, s)!;
    const cap = carryFwd(touch.totalCarryUsdYr, s) / touch.portfolioVarUsd;
    for (const p of pts) {
      if (p.portfolioVarUsd <= 1e-9) continue;
      expect(carryFwd(p.totalCarryUsdYr, s) / p.portfolioVarUsd).toBeLessThanOrEqual(cap + 1e-12);
    }
  });

  it('places Carry Target on the open-arm interpolant at the ask', () => {
    const pts = [
      pt(0, 0.50, 0),
      pt(1, 1.00, 0.20),
      pt(2, 4.00, 0.60),
      pt(3, 10.0, 1.00),
    ];
    const hit = carryTargetOnArm(pts, 0.40);
    expect(hit).not.toBeNull();
    expect(hit!.totalCarryUsdYr).toBeCloseTo(0.40, 8);
    expect(hit!.portfolioVarUsd).toBeCloseTo(2.50, 8);
    expect(carryTargetOnArm(pts, 2.00)).toBeNull();
    const o = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[1],
      policyCapUsd: 20,
      carryTargetUsdYr: 0.40,
    });
    expect(o.carryTarget!.portfolioVarUsd).toBeCloseTo(hit!.portfolioVarUsd, 8);
  });

  it('interpolates Carry Target from Unhedged when k=0 already has program carry', () => {
    const pts = [
      pt(0, 0.50, 0.08),
      pt(1, 2.00, 0.20),
      pt(2, 8.00, 0.40),
    ];
    const o = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[1],
      policyCapUsd: 20,
      carryTargetUsdYr: 0.032,
    });
    expect(o.carryTarget).not.toBeNull();
    expect(o.carryTarget!.totalCarryUsdYr).toBeCloseTo(0.032, 8);
    expect(o.carryTarget!.portfolioVarUsd).toBeGreaterThan(0.50);
    expect(o.carryTarget!.portfolioVarUsd).toBeLessThan(2.00);
  });

  it('defaults a blank Earn to $32k/yr, not the H* book carry', () => {
    const pts = [
      pt(0, 0.634, 0),
      pt(1, 2.125, 0.114),
      pt(2, 8.0, 0.35),
    ];
    const o = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[1],
      policyCapUsd: 20,
    });
    expect(o.carryTarget).not.toBeNull();
    expect(o.carryTarget!.totalCarryUsdYr).toBeCloseTo(DEFAULT_DESK_TARGET_CARRY_USD_YR, 8);
    expect(o.carryTarget!.portfolioVarUsd).toBeGreaterThan(0.634);
    expect(o.carryTarget!.portfolioVarUsd).toBeLessThan(2.125);
    expect(o.carryTarget!.totalCarryUsdYr).not.toBeCloseTo(0.114, 2);
  });

  it('sets Balanced at the (0,0) touch on the full arm, ignoring Conservative', () => {
    const pts = [
      pt(0, 0.50, 0),
      pt(1, 1.00, 0.30),
      pt(1.4, 3.00, 0.90),
      pt(2.2, 6.00, 1.20),
      pt(3.0, 10.0, 1.35),
      pt(4.0, 20.0, 1.50),
    ];
    const touch = tangencyFromTrueZero(pts);
    expect(touch).not.toBeNull();
    const o = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[1],
      policyCapUsd: 20,
    });
    expect(o.balanced!.portfolioVarUsd).toBeCloseTo(touch!.portfolioVarUsd, 8);
  });

  it('can place Balanced before Conservative when that is the (0,0) touch', () => {
    const pts = [
      pt(0, 0.3, 0),
      pt(0.6, 0.35, 0.18),
      pt(1, 0.55, 0.22),
      pt(1.8, 6, 0.55),
      pt(3, 12, 0.9),
    ];
    const o = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[2],
      policyCapUsd: 12,
    });
    expect(o.conservative!.k).toBeCloseTo(1, 5);
    expect(o.balanced!.portfolioVarUsd).toBeCloseTo(
      tangencyFromTrueZero(pts)!.portfolioVarUsd, 8,
    );
    expect(o.balanced!.portfolioVarUsd).toBeLessThan(o.conservative!.portfolioVarUsd);
  });

  it('does not collapse Balanced and Max Carry when the cap is Conservative CFaR', () => {
    const cons = 2.125;
    const pts = [
      pt(0, 0.634, 0),
      pt(1, cons, 0.411),
      pt(1.2, 4.0, 0.55),
      pt(1.5, 5.0, 0.62),
      pt(2, 8.994, 0.80),
      pt(4, 20, 1.10),
    ];
    const o = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[1],
      policyCapUsd: cons,
      originCfarUsd: 0.634,
    });
    expect(o.conservative!.portfolioVarUsd).toBeCloseTo(cons, 5);
    expect(o.balanced!.portfolioVarUsd).toBeCloseTo(
      tangencyFromTrueZero(pts)!.portfolioVarUsd, 8,
    );
    expect(o.maxCarry!.portfolioVarUsd).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(o.maxCarry!.portfolioVarUsd).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('re-targets when the policy cap moves from $20M to $5M', () => {
    const pts = [
      pt(0, 0.5, 0.2),
      pt(5, 5, 0.4),
      pt(10, 10, 0.6),
      pt(20, 20, 0.9),
    ];
    expect(maxVarWithinPolicyPoint(pts, 20)?.portfolioVarUsd).toBeCloseTo(20, 8);
    expect(maxVarWithinPolicyPoint(pts, 5)?.portfolioVarUsd).toBeCloseTo(5, 8);
    expect(maxVarWithinPolicyPoint(pts, 10)?.portfolioVarUsd).toBeCloseTo(10, 8);
  });
});

describe('pickConservativeFundingBook', () => {
  it('skips unfunded even when it is selected', () => {
    const rows = [
      { strategy: { id: 'unfunded' } },
      { strategy: { id: 'rollingProgramme' } },
    ];
    expect(pickConservativeFundingBook(rows, 'unfunded')?.strategy.id).toBe('rollingProgramme');
  });

  it('returns null when no funded H* book exists', () => {
    expect(pickConservativeFundingBook([{ strategy: { id: 'unfunded' } }])).toBeNull();
  });
});
