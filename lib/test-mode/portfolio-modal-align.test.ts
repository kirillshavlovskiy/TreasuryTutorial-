import { describe, expect, it } from 'vitest';
import { INITIAL_ROWS, type LayerId, type RowState, type SharedGlobals } from '@/lib/fx-buffer';
import { DEFAULT_FORECAST_PROFILE, type ForecastProfileState } from '@/lib/forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING, type LiquidityTiming } from '@/lib/liquidity-ladder';
import {
  evaluateLiquidityStrategies,
  liquidityStrategyMeta,
} from '@/lib/test-mode/liquidity-strategies';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import {
  buildLiquidityLeftEndFrontier,
  carryFwd,
  priceLiquidityStanding,
  applyPortfolioFrontierTargets,
  isoSSlicePoints,
  priceIsoSSlice,
  type LiquidityFrontierInput,
} from '@/lib/test-mode/liquidity-frontier';
import {
  buildSoloCcyAlignedFrontier,
  conservativeFundingPoint,
  maxVarWithinPolicyPoint,
  localCarryCfarSlope,
  carryTargetOnArm,
  efficientCarryVarEnvelope,
  frontierMonotoneStats,
  plotCarryVarArm,
  plotFarCarryArm,
  plotStandingCarryArm,
  chartOpenPath,
  chartPresetPointForScenario,
  chartFrontierStroke,
  chartPathTrace,
  collapseNearVerticalRuns,
  thinScreenCollocated,
  splitOverlayFillOpenArm,
  DEFAULT_DESK_TARGET_CARRY_USD_YR,
  orderedLiquidityScenarioPoints,
  tangencyByParallelDerivative,
  tangencyFromTrueZero,
  pricedBalancedVertex,
  pricedCarryTargetVertex,
  plotCarryS,
  tangencyFromOrigin,
  modalDefaultCarryUsdK,
  mixFundingAndOverlay,
  pricedFundingWalk,
  overlayKToModalXy,
  pickConservativeFundingBook,
  portfolioFrontierFromLeftEnd,
  leftEndFromPortfolioFrontier,
  buildCcyInspectLeftEnd,
  alignedInspectMaxScale,
  frontierWalkTipK,
  isWalkLevered,
  splitLeveredChartPath,
  overlayTFromCashCarryK,
  modalLevMinK,
  unhedgedSectionCfarUsdM,
  alignLeftEndToCcyTicket,
  bookStandingChipLabel,
  ccyModalAlignTicket,
  modalCcyTicketTargets,
} from '@/lib/test-mode/portfolio-modal-align';
import {
  buildPortfolioLiquidityFrontier,
  overlayWalkMaxScale,
  toPortfolioCarryFrontier,
} from '@/lib/test-mode/portfolio-liquidity-frontier';

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

describe('leftEndFromPortfolioFrontier', () => {
  it('replays the one-name portfolio arm onto the modal left-end', () => {
    const port = {
      points: [
        { k: 0, portfolioVarUsd: 0.42, totalCarryUsdYr: 0, floorBoundCcys: [] },
        { k: 0.5, portfolioVarUsd: 4.2, totalCarryUsdYr: 0.8, floorBoundCcys: [] },
        { k: 1, portfolioVarUsd: 9.4, totalCarryUsdYr: 1.6, floorBoundCcys: [] },
      ],
      farPoints: [
        { k: 0, portfolioVarUsd: 0.42, totalCarryUsdYr: 0, floorBoundCcys: [] },
        { k: 1, portfolioVarUsd: 9.4, totalCarryUsdYr: 0.2, floorBoundCcys: [] },
      ],
      sweetSpotIndex: -1,
      nearestClampCcy: null,
      nearestClampVarUsd: null,
      walk: 'overlay' as const,
    };
    const left = leftEndFromPortfolioFrontier(port, {
      dial: 'var_target',
      liveStanding: 0,
      overlayFcyM: -14.6,
      walk: 'overlay',
    });
    expect(left.origin.finalCfarUsdM).toBeCloseTo(0.42, 8);
    expect(left.origin.totalCarryUsdYrM).toBe(0);
    expect(left.upper.length).toBe(2);
    expect(left.upper[1]!.finalCfarUsdM).toBeCloseTo(9.4, 8);
    expect(left.upper[1]!.totalCarryUsdYrM).toBeCloseTo(1.6, 8);
    expect(Math.abs(left.upper[1]!.peakBook)).toBeGreaterThan(10);
    expect(left.lower.length).toBe(1);
  });
});

describe('buildCcyInspectLeftEnd', () => {
  it('overlay fill draws a one-name arm past the unhedged origin', () => {
    const r = row();
    const eng = engine();
    const results = evaluateLiquidityStrategies({
      rows: [r],
      months: 6,
      shared,
      activeLayers: eng.activeLayers,
      forecastProfile: eng.forecastProfile,
      setup: eng.setup,
      cfarNetByCcyUsd: eng.cfarNetByCcyUsd,
    });
    const unfunded = results.find(x => x.strategy.id === 'unfunded')!;
    const left = buildCcyInspectLeftEnd({
      row: r,
      engine: eng,
      result: unfunded,
      askFillMode: 'overlay',
      overlayCapFcyM: -14.6,
      maxScale: 2,
      sectionCfarUsdM: 0.42,
    });
    expect(left.origin.finalCfarUsdM).toBeCloseTo(0.42, 5);
    expect(left.upper.length).toBeGreaterThan(4);
    const tip = left.upper[left.upper.length - 1]!;
    expect(tip.finalCfarUsdM).toBeGreaterThan(left.origin.finalCfarUsdM + 0.05);
    expect(Math.abs(tip.totalCarryUsdYrM)).toBeGreaterThan(0.01);
  });

  it('dashed tail stops at Ask-pad t, not selected overlayT = 0', () => {
    expect(overlayWalkMaxScale(0)).toBeCloseTo(1.2, 8);
    expect(overlayWalkMaxScale(8)).toBeCloseTo(10, 8);
    expect(alignedInspectMaxScale({ askFillMode: 'overlay', tAsk: 8 })).toBeCloseTo(10, 8);
    expect(alignedInspectMaxScale({ askFillMode: 'overlay', tAsk: 0 })).toBeCloseTo(1.2, 8);
    expect(alignedInspectMaxScale({ askFillMode: 'swap', tAsk: 8 })).toBeNull();
    expect(alignedInspectMaxScale({
      askFillMode: 'overlay',
      tAsk: 0,
      overlayCapFcyM: 1,
      row: row(),
      r_USD: shared.r_USD,
    })).toBeGreaterThanOrEqual(1.2);
  });

  it('one-name overlay inspect tip k matches the parent universe walk at the same maxScale', () => {
    const r = row();
    const eng = engine();
    const results = evaluateLiquidityStrategies({
      rows: [r],
      months: 6,
      shared,
      activeLayers: eng.activeLayers,
      forecastProfile: eng.forecastProfile,
      setup: eng.setup,
      cfarNetByCcyUsd: eng.cfarNetByCcyUsd,
    });
    const unfunded = results.find(x => x.strategy.id === 'unfunded')!;
    const cap = -14.6;
    const tAsk = 4;
    const maxScale = alignedInspectMaxScale({
      askFillMode: 'overlay',
      tAsk,
      overlayCapFcyM: cap,
      row: r,
      r_USD: shared.r_USD,
    })!;
    expect(maxScale).toBeCloseTo(overlayWalkMaxScale(tAsk), 8);
    const parent = toPortfolioCarryFrontier(buildPortfolioLiquidityFrontier({
      result: unfunded,
      strategy: unfunded.strategy,
      rows: [r],
      engine: eng,
      overlayFcyByCcy: { EUR: cap },
      overlaySweetT: 0,
      maxScale,
    }));
    const left = buildCcyInspectLeftEnd({
      row: r,
      engine: eng,
      result: unfunded,
      askFillMode: 'overlay',
      overlayCapFcyM: cap,
      maxScale,
      sectionCfarUsdM: 0.42,
    });
    const parentTipK = frontierWalkTipK(parent.points)!;
    const modalTipK = Math.max(...left.upper.map(p => p.multiple));
    expect(parentTipK).toBeCloseTo(maxScale, 5);
    expect(modalTipK).toBeCloseTo(parentTipK, 5);
    expect(left.upper.some(p => p.levered)).toBe(true);
    expect(left.upper.filter(p => p.levered).every(p => p.multiple > 1 + 1e-6)).toBe(true);
    expect(left.upper.filter(p => !p.levered).every(p => p.multiple <= 1 + 1e-6)).toBe(true);
    expect(left.upper.filter(p => p.multiple <= 1 + 1e-6).every(p => !p.levered)).toBe(true);
    expect(parent.points.filter(p => isWalkLevered(p)).every(p => p.k > 1 + 1e-6)).toBe(true);
    expect(parent.points.filter(p => p.k <= 1 + 1e-6).every(p => !isWalkLevered(p))).toBe(true);
    const split = splitLeveredChartPath(parent.points, parent.points[0]!.portfolioVarUsd);
    expect(split.solid.length).toBeGreaterThanOrEqual(2);
    expect(split.levered.length).toBeGreaterThanOrEqual(2);
    const book = parent.points.filter(p => p.k <= 1 + 1e-6).at(-1)!;
    expect(split.solid.some(p => Math.abs(p.x - book.portfolioVarUsd) < 1e-6)).toBe(true);
  });

  it('swap inspect hard-caps at the parent walk tip k', () => {
    const r = row();
    const eng = engine();
    const results = evaluateLiquidityStrategies({
      rows: [r],
      months: 6,
      shared,
      activeLayers: eng.activeLayers,
      forecastProfile: eng.forecastProfile,
      setup: eng.setup,
      cfarNetByCcyUsd: eng.cfarNetByCcyUsd,
    });
    const rolling = results.find(x => x.strategy.id === 'rollingProgramme')!;
    const parent = toPortfolioCarryFrontier(buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows: [r],
      engine: eng,
    }));
    const tipK = frontierWalkTipK(parent.points);
    expect(tipK).not.toBeNull();
    const left = buildCcyInspectLeftEnd({
      row: r,
      engine: eng,
      result: rolling,
      askFillMode: 'swap',
      maxScale: tipK,
      sectionCfarUsdM: 0.42,
    });
    expect(Math.max(...left.upper.map(p => p.multiple))).toBeCloseTo(tipK!, 5);
  });

  it('inspect twins keep a yellow iso-S mix at matched k (d=0 open ↔ d=1 far)', () => {
    const r = row();
    const eng = engine();
    const results = evaluateLiquidityStrategies({
      rows: [r],
      months: 6,
      shared,
      activeLayers: eng.activeLayers,
      forecastProfile: eng.forecastProfile,
      setup: eng.setup,
      cfarNetByCcyUsd: eng.cfarNetByCcyUsd,
    });
    const rolling = results.find(x => x.strategy.id === 'rollingProgramme')!;
    const left = buildCcyInspectLeftEnd({
      row: r,
      engine: eng,
      result: rolling,
      askFillMode: 'swap',
      sectionCfarUsdM: 0.42,
    });
    const open = left.upper.find(p => p.delta < 1e-9 && !p.levered);
    expect(open).toBeTruthy();
    const far = left.lower.find(p => Math.abs(p.multiple - open!.multiple) < 1e-6)
      ?? left.lower.find(p => Math.abs(p.peakBook - open!.peakBook) < 1e-4);
    expect(far).toBeTruthy();
    expect(Math.abs(far!.totalCarryUsdYrM - open!.totalCarryUsdYrM)).toBeGreaterThan(1e-5);
    expect(Math.abs(open!.cipUsdYrM)).toBeGreaterThan(1e-5);
    const mid = priceIsoSSlice(open!, far!, left.cfarOriginUsdM, 0.5);
    const yLo = Math.min(open!.totalCarryUsdYrM, far!.totalCarryUsdYrM);
    const yHi = Math.max(open!.totalCarryUsdYrM, far!.totalCarryUsdYrM);
    expect(mid.totalCarryUsdYrM).toBeGreaterThanOrEqual(yLo - 1e-6);
    expect(mid.totalCarryUsdYrM).toBeLessThanOrEqual(yHi + 1e-6);
    expect(Math.abs(mid.totalCarryUsdYrM - open!.totalCarryUsdYrM)).toBeGreaterThan(1e-5);
    const dropped = { ...open!, cipUsdYrM: 0 };
    const droppedFar = { ...far!, cipUsdYrM: 0 };
    const slice = isoSSlicePoints(dropped, droppedFar, left.cfarOriginUsdM);
    expect(slice.length).toBeGreaterThan(8);
    expect(Math.abs(slice[0]!.totalCarryUsdYrM - slice[slice.length - 1]!.totalCarryUsdYrM))
      .toBeGreaterThan(1e-5);
  });

  it('tiny overlay cap: modal levMin $K extends the parent past the 1.2 floor', () => {
    const r = row();
    const tiny = 0.4;
    const tFromK = overlayTFromCashCarryK(modalLevMinK(0), tiny, r, shared.r_USD);
    const scale = alignedInspectMaxScale({
      askFillMode: 'overlay',
      tAsk: 0,
      overlayCapFcyM: tiny,
      row: r,
      r_USD: shared.r_USD,
    })!;
    if (tFromK > 1.2) {
      expect(scale).toBeCloseTo(tFromK, 8);
      expect(scale).toBeGreaterThan(1.2);
    } else {
      expect(scale).toBeCloseTo(1.2, 8);
    }
  });
});

describe('splitLeveredChartPath', () => {
  it('joins the dashed tail at the last live-book vertex', () => {
    const pts = [
      { k: 0, portfolioVarUsd: 1.0, totalCarryUsdYr: 0, floorBoundCcys: [] as string[] },
      { k: 0.5, portfolioVarUsd: 1.2, totalCarryUsdYr: 0.10, floorBoundCcys: [] as string[] },
      { k: 1, portfolioVarUsd: 1.5, totalCarryUsdYr: 0.20, floorBoundCcys: [] as string[] },
      { k: 1.5, portfolioVarUsd: 2.5, totalCarryUsdYr: 0.40, floorBoundCcys: [] as string[], levered: true },
    ];
    const split = splitLeveredChartPath(pts, 1.0);
    expect(split.solid[0]).toEqual({ x: 1.0, y: 0 });
    expect(split.solid.some(p => Math.abs(p.x - 1.5) < 1e-9)).toBe(true);
    expect(split.levered[0]!.x).toBeCloseTo(split.solid[split.solid.length - 1]!.x, 8);
    expect(split.levered[split.levered.length - 1]!.x).toBeCloseTo(2.5, 8);
    expect(frontierWalkTipK(pts)).toBeCloseTo(1.5, 8);
  });

  it('keeps the live book solid when k is FCY standing (not overlay t)', () => {
    const pts = [
      { k: 0, portfolioVarUsd: 0.42, totalCarryUsdYr: 0, floorBoundCcys: [] as string[], levered: false },
      { k: 6, portfolioVarUsd: 0.50, totalCarryUsdYr: 0.10, floorBoundCcys: [] as string[], levered: false },
      { k: 12, portfolioVarUsd: 0.70, totalCarryUsdYr: 0.20, floorBoundCcys: [] as string[], levered: false },
      { k: 18, portfolioVarUsd: 1.20, totalCarryUsdYr: 0.30, floorBoundCcys: [] as string[], levered: true },
    ];
    expect(isWalkLevered({ k: 1.2 })).toBe(true);
    expect(isWalkLevered({ k: 0.8 })).toBe(false);
    expect(isWalkLevered({ k: 12, levered: false })).toBe(false);
    expect(isWalkLevered({ k: 0.8, levered: true })).toBe(true);
    const split = splitLeveredChartPath(pts, 0.42);
    expect(split.solid.length).toBeGreaterThanOrEqual(2);
    expect(split.solid.some(p => Math.abs(p.x - 0.70) < 1e-9)).toBe(true);
    expect(split.levered[0]!.x).toBeCloseTo(split.solid[split.solid.length - 1]!.x, 8);
    expect(split.levered.some(p => Math.abs(p.x - 1.20) < 1e-9)).toBe(true);
    expect(split.levered.filter(p => Math.abs(p.x - 0.50) < 1e-9)).toHaveLength(0);
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

  it('pins Unhedged origin to chart originCfarUsd when provided', () => {
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
    expect(o.origin!.portfolioVarUsd).toBeCloseTo(0.359, 8);
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

  it('places Carry Target on the live book (k ≤ 1), not leveraged k > 1', () => {
    const pts = [
      pt(0, 0.50, 0),
      pt(1, 1.00, 0.20),
      pt(2, 4.00, 0.60),
      pt(3, 10.0, 1.00),
    ];
    const hit = carryTargetOnArm(pts.filter(p => p.k <= 1 + 1e-6), 0.10);
    expect(hit).not.toBeNull();
    expect(hit!.totalCarryUsdYr).toBeCloseTo(0.10, 8);
    expect(hit!.k).toBeLessThanOrEqual(1 + 1e-6);
    expect(carryTargetOnArm(pts, 2.00)).toBeNull();
    const onBook = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[1],
      policyCapUsd: 20,
      carryTargetUsdYr: 0.10,
    });
    expect(onBook.carryTarget!.totalCarryUsdYr).toBeCloseTo(0.10, 8);
    expect(onBook.carryTarget!.k).toBeLessThanOrEqual(1 + 1e-6);
    const pastHold = orderedLiquidityScenarioPoints({
      points: pts,
      conservative: pts[1],
      policyCapUsd: 20,
      carryTargetUsdYr: 0.40,
    });
    expect(pastHold.carryTarget!.totalCarryUsdYr).toBeCloseTo(0.40, 8);
    expect(pastHold.carryTarget!.k).toBeGreaterThan(1);
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

  it('Balanced is a priced walk vertex, not k×holdY at book-hold X', () => {
    const pts = [
      pt(0, 1.085, 0.556),
      pt(0.26, 1.220, 0.171),
      pt(1, 1.626, 0.666),
      pt(4, 5.20, 1.10),
    ];
    const bal = pricedBalancedVertex(pts, 1.085);
    expect(bal).not.toBeNull();
    expect(pts.some(p => (
      Math.abs(p.k - bal!.k) < 1e-9
      && Math.abs(p.portfolioVarUsd - bal!.portfolioVarUsd) < 1e-8
      && Math.abs(p.totalCarryUsdYr - bal!.totalCarryUsdYr) < 1e-8
    ))).toBe(true);
    expect(Math.abs(bal!.totalCarryUsdYr - 0.171)).toBeGreaterThan(1e-3);
  });

  it('Swap lift Balanced is the first priced off-origin vertex, not $171k', () => {
    const pts = [
      pt(0, 1.085, 0.556),
      pt(0.03, 1.086, 0.559),
      pt(1, 1.626, 0.666),
      pt(9.47, 11.516, 1.599),
    ];
    const bal = pricedBalancedVertex(pts, 1.085);
    expect(bal).toMatchObject({ k: 0.03, portfolioVarUsd: 1.086, totalCarryUsdYr: 0.559 });
  });

  it('Balanced touch is stable — plotCarryS, not zoom display carryS', () => {
    const pts = [
      pt(0, 1.085, 0.556),
      pt(0.03, 1.086, 0.559),
      pt(0.26, 1.220, 0.171),
      pt(1, 1.626, 0.666),
      pt(9.47, 11.516, 1.599),
    ];
    const stable = pricedBalancedVertex(pts, 1.085);
    const zoomed = pricedBalancedVertex(pts, 1.085, 0.012);
    expect(stable).toMatchObject({ k: 0.03, portfolioVarUsd: 1.086, totalCarryUsdYr: 0.559 });
    expect(zoomed).toMatchObject(stable!);
    const stroke = chartOpenPath(
      plotStandingCarryArm(pts).map(p => ({
        x: p.portfolioVarUsd,
        y: p.totalCarryUsdYr,
      })),
      1.085,
      true,
    );
    expect(stroke[0]).toMatchObject({ x: 1.085, y: 0 });
    expect(stroke.some(p => (
      Math.abs(p.x - stable!.portfolioVarUsd) < 1e-6
      && Math.abs(p.y - stable!.totalCarryUsdYr) < 1e-6
    ))).toBe(true);
  });

  it('Carry Target on chart walk matches pricedCarryTargetVertex at Ask Y', () => {
    const pts = [
      pt(0, 1.085, 0.556),
      pt(0.03, 1.086, 0.559),
      pt(1, 1.626, 0.666),
    ];
    const ask = 0.032;
    const ct = pricedCarryTargetVertex(pts, 1.085, ask);
    expect(ct).not.toBeNull();
    expect(ct!.totalCarryUsdYr).toBeCloseTo(ask, 6);
    expect(ct!.portfolioVarUsd).toBeLessThan(1.2);
    expect(ct!.portfolioVarUsd).toBeGreaterThan(1.085);
    const stroke = chartOpenPath(
      plotStandingCarryArm(pts).map(p => ({
        x: p.portfolioVarUsd,
        y: p.totalCarryUsdYr,
      })),
      1.085,
      true,
    );
    const balanced = pricedBalancedVertex(pts, 1.085);
    expect(balanced!.portfolioVarUsd).not.toBeCloseTo(1.626, 2);
    expect(stroke[0]).toMatchObject({ x: 1.085, y: 0 });
  });

  it('scenario presets share plotCarryS — balanced unchanged when carry target reframes', () => {
    const pts = [
      pt(0, 1.085, 0.556),
      pt(0.03, 1.086, 0.559),
      pt(1, 1.626, 0.666),
    ];
    const s = plotCarryS(pts);
    const bal = pricedBalancedVertex(pts, 1.085, s);
    const ct = pricedCarryTargetVertex(pts, 1.085, 0.032);
    expect(bal).toMatchObject({ k: 0.03, portfolioVarUsd: 1.086 });
    expect(ct!.totalCarryUsdYr).toBeCloseTo(0.032, 6);
    expect(pricedBalancedVertex(pts, 1.085, s)).toMatchObject(bal!);
  });

  it('ordered presets honor chart originCfarUsd over walk k=0 X', () => {
    const pts = [
      pt(0, 0.556, 0.1),
      pt(0.03, 1.086, 0.559),
      pt(1, 1.626, 0.666),
    ];
    const chartOrigin = 1.085;
    const walkOrigin = orderedLiquidityScenarioPoints({
      points: pts,
      policyCapUsd: 20,
      originCfarUsd: pts[0]!.portfolioVarUsd,
      carryTargetUsdYr: 0.032,
    });
    const chartOriginPresets = orderedLiquidityScenarioPoints({
      points: pts,
      policyCapUsd: 20,
      originCfarUsd: chartOrigin,
      carryTargetUsdYr: 0.032,
    });
    expect(chartOriginPresets.carryTarget!.portfolioVarUsd).toBeGreaterThan(
      walkOrigin.carryTarget!.portfolioVarUsd,
    );
    expect(chartOriginPresets.carryTarget!.totalCarryUsdYr).toBeCloseTo(0.032, 6);
    expect(chartPresetPointForScenario({
      scenarioId: 'carryTarget',
      points: pts,
      originX: chartOrigin,
      policyCapUsd: 20,
      confidencePct: 95,
      carryTargetUsdYr: 0.032,
    })).toMatchObject(chartOriginPresets.carryTarget!);
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

describe('efficientCarryVarEnvelope', () => {
  const pt = (
    k: number,
    portfolioVarUsd: number,
    totalCarryUsdYr: number,
  ) => ({ k, portfolioVarUsd, totalCarryUsdYr, floorBoundCcys: [] as string[] });

  it('drops the RSS bow (more CFaR, less carry than a neighbour)', () => {
    const pts = [
      pt(0, 0.634, 0),
      pt(0.3, 1.20, 0.040),
      pt(0.45, 1.50, 0.035), // jag: X up, Y down — dominated
      pt(0.6, 1.35, 0.055),
      pt(1, 2.125, 0.114),
    ];
    const stats = frontierMonotoneStats(pts);
    expect(stats.xBacktracks).toBe(1);
    expect(stats.yDips).toBe(1);
    const env = efficientCarryVarEnvelope(pts);
    expect(env.map(p => p.k)).toEqual([0, 0.3, 0.6, 1]);
    expect(env.every((p, i) => i === 0 || p.portfolioVarUsd >= env[i - 1]!.portfolioVarUsd - 1e-12)).toBe(true);
    expect(env.every((p, i) => i === 0 || p.totalCarryUsdYr >= env[i - 1]!.totalCarryUsdYr - 1e-12)).toBe(true);
  });

  it('plot arm is walk order — envelope is not the stroke (keeps $0 at the same CFaR)', () => {
    const pts = [
      pt(0, 3.5, 0),
      pt(1, 3.5, 8.4),
      pt(16, 3.5, 141),
    ];
    expect(efficientCarryVarEnvelope(pts)).toHaveLength(1);
    expect(plotCarryVarArm(pts).map(p => p.k)).toEqual([0, 1, 16]);
    expect(plotCarryVarArm(pts)).toEqual(plotStandingCarryArm(pts));
  });

  it('does not invent a $0 → huge-Y stem when the first priced sample is the lift', () => {
    const skyline = [
      { x: 1.086, y: 0.556 },
      { x: 1.20, y: 0.70 },
      { x: 1.40, y: 1.599 },
    ];
    const swapped = chartOpenPath(skyline, 1.086, true);
    expect(swapped[0]).toEqual({ x: 1.086, y: 0 });
    expect(swapped[1]).not.toEqual({ x: 1.086, y: 0.556 });
    expect(swapped.some(p => Math.abs(p.x - 1.20) < 1e-9 && Math.abs(p.y - 0.70) < 1e-9)).toBe(true);
    const fromZero = chartOpenPath(
      [{ x: 1.086, y: 0 }, { x: 1.10, y: 0.003 }, { x: 1.20, y: 0.40 }],
      1.086,
      true,
    );
    expect(fromZero[0]).toEqual({ x: 1.086, y: 0 });
    expect(fromZero[1]).toEqual({ x: 1.10, y: 0.003 });
  });

  it('chartFrontierStroke is chartOpenPath — no fill arg, no hull, no stem filter', () => {
    expect(chartFrontierStroke).toBe(chartOpenPath);
    const skyline = [
      { x: 1.086, y: 0 },
      { x: 1.20, y: 0.14 },
      { x: 1.577, y: 0.556 },
      { x: 1.577, y: 0.774 },
      { x: 5.685, y: 0.666 },
      { x: 5.690, y: 0.720 },
      { x: 15.60, y: 1.599 },
    ];
    expect(chartFrontierStroke(skyline, 1.086, true)).toEqual(
      chartOpenPath(skyline, 1.086, true),
    );
  });

  it('overlay pin connects green to unhedged $0 when the skyline starts at the orange peak', () => {
    const skyline = [
      { x: 1.086, y: 0.50 },
      { x: 1.20, y: 0.62 },
      { x: 3.50, y: 0.90 },
      { x: 11.50, y: 1.599 },
    ];
    const pinned = chartOpenPath(skyline, 1.086, true);
    expect(pinned[0]).toEqual({ x: 1.086, y: 0 });
    expect(pinned.some(p => Math.abs(p.x - 1.086) < 1e-9 && Math.abs(p.y - 0.50) < 1e-9)).toBe(false);
    expect(pinned.some(p => Math.abs(p.x - 1.20) < 1e-9 && Math.abs(p.y - 0.62) < 1e-9)).toBe(true);
  });

  it('keeps a $300k CFaR run with distinct X — default collapse is not a %-of-span skyline', () => {
    const stack = [
      { x: 1.086, y: 0 },
      { x: 1.0862, y: 0.08 },
      { x: 1.160, y: 0.20 },
      { x: 1.250, y: 0.32 },
      { x: 1.390, y: 0.50 },
      { x: 2.10, y: 0.80 },
      { x: 4.50, y: 1.20 },
    ];
    const out = collapseNearVerticalRuns(stack);
    expect(out).toHaveLength(stack.length);
    expect(out[0]).toEqual({ x: 1.086, y: 0 });
    expect(out.filter(p => p.x > 1.086 && p.x < 1.40)).toHaveLength(4);
  });

  it('collapses only a true same-CFaR stack when given an explicit tol', () => {
    const stack = [
      { x: 1.086, y: 0.215 },
      { x: 1.0862, y: 0.28 },
      { x: 1.087, y: 0.40 },
      { x: 1.088, y: 0.55 },
      { x: 1.40, y: 1.20 },
      { x: 2.10, y: 1.599 },
    ];
    const out = collapseNearVerticalRuns(stack, 0.01);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ x: 1.086, y: 0.215 });
    expect(out[1]).toEqual({ x: 1.40, y: 1.20 });
    expect(out[2]).toEqual({ x: 2.10, y: 1.599 });
  });

  it('standing arm keeps unhedged $0 that the max-carry envelope drops', () => {
    const pts = [
      pt(0, 1.086, 0),
      pt(0.2, 1.086, 0.12),
      pt(0.5, 1.086, 0.28),
      pt(1, 1.086, 0.50),
      pt(2, 3.50, 0.90),
      pt(8, 11.50, 1.599),
    ];
    expect(efficientCarryVarEnvelope(pts)[0]?.totalCarryUsdYr).toBeGreaterThan(0.2);
    const arm = plotStandingCarryArm(pts);
    expect(arm[0]).toMatchObject({ portfolioVarUsd: 1.086, totalCarryUsdYr: 0 });
    expect(arm).toHaveLength(pts.length);
    const overlay = chartOpenPath(
      arm.map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr })),
      1.086,
      true,
    );
    expect(overlay[0]).toEqual({ x: 1.086, y: 0 });
    expect(overlay.length).toBe(pts.length);
  });

  it('thinScreenCollocated drops only pixels that sit on top of each other', () => {
    const pts = [
      { x: 1.086, y: 0 },
      { x: 1.086, y: 0 },
      { x: 1.20, y: 0.20 },
      { x: 1.50, y: 0.40 },
    ];
    const thinned = thinScreenCollocated(pts, v => v * 100, v => v * 100, 2);
    expect(thinned).toHaveLength(3);
    expect(thinned[0]).toEqual({ x: 1.086, y: 0 });
    expect(thinned[1]).toEqual({ x: 1.20, y: 0.20 });
  });

  it('overlay and swap strokes both pin $0 and keep every walk-order sample', () => {
    const overlay = [
      pt(0, 1.086, 0),
      pt(0.2, 1.10, 0.08),
      pt(0.5, 1.18, 0.16),
      pt(1, 1.40, 0.28),
      pt(4, 3.20, 0.70),
      pt(12, 11.0, 1.50),
    ];
    const swap = [
      pt(-1, 1.086, 0),
      pt(-0.8, 1.10, 0.08),
      pt(-0.5, 1.30, 0.28),
      pt(0, 1.58, 0.56),
      pt(0.5, 1.70, 0.78),
      pt(1, 1.90, 0.96),
      pt(4, 3.20, 1.20),
      pt(12, 11.0, 1.60),
    ];
    for (const pts of [overlay, swap]) {
      const arm = plotStandingCarryArm(pts);
      const drawn = chartOpenPath(
        arm.map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr })),
        1.086,
        true,
      );
      expect(drawn[0]).toEqual({ x: 1.086, y: 0 });
      expect(drawn.length).toBeGreaterThanOrEqual(pts.length);
      expect(drawn.filter(p => p.x > 1.086 + 1e-6).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('chartPathTrace pins overlay at $0 and keeps the standing walk', () => {
    const pts = [
      pt(0, 1.085, 0),
      pt(0.15, 1.092, 0.235),
      pt(0.30, 1.110, 0.252),
      pt(0.50, 1.150, 0.280),
      pt(1, 1.626, 0.329),
      pt(4, 4.50, 0.80),
      pt(12, 15.20, 1.599),
    ];
    const overlay = chartPathTrace(pts, 1.085, true);
    expect(overlay.pinApplied).toBe(true);
    expect(overlay.liftedOrigin).toBe(false);
    expect(overlay.drawn[0]).toEqual({ x: 1.085, y: 0 });
    expect(overlay.nDrawn).toBeLessThanOrEqual(overlay.nSkyline);
    expect(overlay.nDrawn).toBeGreaterThanOrEqual(3);
    expect(overlay.drawn.every((p, i) => i === 0 || p.x > overlay.drawn[i - 1]!.x + 1e-12)).toBe(true);
    expect(overlay.drawn.some(p => Math.abs(p.x - 1.092) < 1e-9 && p.y > 0.2)).toBe(true);
    const bookScale = [
      pt(0, 1.085, 0.556),
      pt(0.5, 1.35, 0.610),
      pt(1, 1.626, 0.666),
      pt(4, 4.50, 0.80),
      pt(12, 15.20, 1.599),
    ];
    const swapped = chartPathTrace(bookScale, 1.085, true);
    const swapStroke = chartFrontierStroke(
      plotStandingCarryArm(bookScale).map(p => ({
        x: p.portfolioVarUsd,
        y: p.totalCarryUsdYr,
      })),
      1.085,
      true,
    );
    expect(swapped.drawn).toEqual(swapStroke);
    expect(swapped.drawn).toEqual(chartOpenPath(
      plotStandingCarryArm(bookScale).map(p => ({
        x: p.portfolioVarUsd,
        y: p.totalCarryUsdYr,
      })),
      1.085,
      true,
    ));
    expect(swapped.drawn[0]).toEqual({ x: 1.085, y: 0 });
  });

  it('splits overlay-fill green at the first k=1 hold', () => {
    const pts = [
      pt(0, 1.086, 0),
      pt(0.5, 1.30, 0.055),
      pt(1, 1.626, 0.110),
      pt(1, 2.40, 0.80),
      pt(1, 4.028, 1.599),
    ];
    const { approach, overlay } = splitOverlayFillOpenArm(pts);
    expect(approach.map(p => p.totalCarryUsdYr)).toEqual([0, 0.055, 0.110]);
    expect(overlay[0]!.totalCarryUsdYr).toBeCloseTo(0.110, 8);
    expect(overlay[overlay.length - 1]!.totalCarryUsdYr).toBeCloseTo(1.599, 8);
    const dBook = (approach[2]!.totalCarryUsdYr - approach[0]!.totalCarryUsdYr)
      / (approach[2]!.portfolioVarUsd - approach[0]!.portfolioVarUsd);
    const dOv = (overlay[overlay.length - 1]!.totalCarryUsdYr - overlay[0]!.totalCarryUsdYr)
      / (overlay[overlay.length - 1]!.portfolioVarUsd - overlay[0]!.portfolioVarUsd);
    expect(dOv).toBeGreaterThan(dBook);
  });

  it('far CIP walk keeps the negative tail the max-carry envelope drops', () => {
    const far = [
      pt(0, 1.086, 0),
      pt(0.5, 1.30, -0.040),
      pt(1, 1.55, -0.087),
      pt(2, 2.10, -0.160),
    ];
    expect(efficientCarryVarEnvelope(far).every(p => p.totalCarryUsdYr >= -1e-12)).toBe(true);
    expect(plotFarCarryArm(far).map(p => p.totalCarryUsdYr)).toEqual([0, -0.040, -0.087, -0.160]);
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

describe('alignLeftEndToCcyTicket', () => {
  const origin = {
    delta: 0, multiple: 0, phase: 'unfunded' as const, intensity: 0,
    bufferM: 0, carryM: 0, cashCarryUsdYrM: 0, swapCashUsdYrM: 0,
    cipUsdYrM: 0, hedgeCarryUsdYrM: 0, totalCarryUsdYrM: 0,
    finalCfarUsdM: 0.411, peakBook: 0, levered: false,
  };
  const openMid = {
    ...origin, phase: 'hedged' as const, peakBook: 26.45, carryM: 26.45,
    multiple: 26.45, cashCarryUsdYrM: 0.53, totalCarryUsdYrM: 0.53,
    finalCfarUsdM: 3.5,
  };
  const openBook = {
    ...origin, phase: 'hedged' as const, peakBook: 79.36, carryM: 79.36,
    multiple: 79.36, cashCarryUsdYrM: 1.6, totalCarryUsdYrM: 1.5,
    finalCfarUsdM: 10.5,
  };
  const farBook = {
    ...openBook, delta: 1, phase: 'hedged' as const,
    totalCarryUsdYrM: -0.203, cashCarryUsdYrM: 1.6, cipUsdYrM: -1.803,
    finalCfarUsdM: 0.717,
  };

  function left(): import('@/lib/test-mode/liquidity-frontier').LiquidityLeftEndResult {
    return {
      dial: 'var_target',
      walk: 'carry_pair',
      cfarOriginUsdM: 0.411,
      origin,
      upper: [openMid, openBook],
      lower: [farBook],
      curve: [origin, openMid, openBook],
      points: [openMid, openBook, farBook],
      applied: openBook,
      constraint: {
        dial: 'var_target',
        hCarryUsdYrM: 1.6,
        vCfarUsdM: 0.717,
        openHit: { cfarUsdM: 10.5, carryUsdYrM: 1.5, standing: 79.36 },
        hedgeHit: { cfarUsdM: 0.717, carryUsdYrM: -0.203, standing: 79.36 },
      },
      bookStanding: 79.36,
      bookCashK: 1600,
    };
  }

  const eurTicket = {
    cfarUsdM: 8.7,
    carryUsdYrM: 2.3,
    bookUsdYrM: 1.6,
    overlayUsdYrM: 0.716,
    bookStandingFcyM: 79.36,
    bookStandingUsdM: 92.9,
  };

  it('lands Book S on EUR Total CFaR / Total carry — not Book-only $10.5M / $1.5M', () => {
    const aligned = alignLeftEndToCcyTicket(left(), eurTicket);
    const book = aligned.upper.find(p => Math.abs(p.peakBook - 79.36) < 1e-6)!;
    expect(book.finalCfarUsdM).toBeCloseTo(8.7, 8);
    expect(book.totalCarryUsdYrM).toBeCloseTo(2.3, 8);
    expect(aligned.origin.finalCfarUsdM).toBeCloseTo(0.411, 8);
    expect(aligned.origin.totalCarryUsdYrM).toBeCloseTo(0, 8);
    const mid = aligned.upper.find(p => Math.abs(p.peakBook - 26.45) < 1e-6)!;
    expect(mid.totalCarryUsdYrM).toBeGreaterThan(0.53);
    expect(mid.totalCarryUsdYrM).toBeLessThan(2.3);
    expect(mid.finalCfarUsdM).toBeLessThan(8.7);
  });

  it('adds overlay Y on the far twin without mixing Book Y and Total Y on chips', () => {
    const aligned = alignLeftEndToCcyTicket(left(), eurTicket);
    const far = aligned.lower.find(p => Math.abs(p.peakBook - 79.36) < 1e-6)!;
    expect(far.totalCarryUsdYrM).toBeCloseTo(-0.203 + 0.716, 8);
    expect(far.finalCfarUsdM).toBeCloseTo(0.717, 8);
  });

  it('yellow mix at Book S connects remapped Total to far, not pre-morph cash', () => {
    const aligned = alignLeftEndToCcyTicket(left(), eurTicket);
    const open = aligned.upper.find(p => Math.abs(p.peakBook - 79.36) < 1e-6)!;
    const far = aligned.lower.find(p => Math.abs(p.peakBook - 79.36) < 1e-6)!;
    expect(open.totalCarryUsdYrM).toBeCloseTo(2.3, 8);
    expect(far.totalCarryUsdYrM).toBeCloseTo(-0.203 + 0.716, 8);
    const mid = priceIsoSSlice(open, far, aligned.cfarOriginUsdM, 0.5);
    expect(mid.peakBook).toBeCloseTo(79.36, 5);
    expect(mid.delta).toBeCloseTo(0.5, 6);
    expect(mid.totalCarryUsdYrM).toBeCloseTo(
      (open.totalCarryUsdYrM + far.totalCarryUsdYrM) / 2,
      6,
    );
    expect(mid.totalCarryUsdYrM).not.toBeCloseTo((1.6 + far.totalCarryUsdYrM) / 2, 3);
    const slice = isoSSlicePoints(open, far, aligned.cfarOriginUsdM);
    expect(slice.length).toBeGreaterThan(3);
    expect(slice[0]!.totalCarryUsdYrM).toBeCloseTo(2.3, 6);
    expect(slice[slice.length - 1]!.totalCarryUsdYrM).toBeCloseTo(far.totalCarryUsdYrM, 6);
    expect(slice.every(p => Math.abs(p.peakBook - 79.36) < 1e-6)).toBe(true);
  });

  it('leaves overlay-fill (S = 0) walks untouched', () => {
    const src = left();
    expect(alignLeftEndToCcyTicket(src, {
      ...eurTicket, bookStandingFcyM: 0,
    })).toBe(src);
    expect(ccyModalAlignTicket({ ...eurTicket, bookStandingFcyM: 0 })).toBeNull();
  });

  it('chip, Target Carry line, and selected Book S share Total CFaR / Total carry', () => {
    const aligned = alignLeftEndToCcyTicket(left(), eurTicket);
    const pinned = applyPortfolioFrontierTargets(
      aligned.constraint,
      {
        origin: aligned.origin,
        open: aligned.upper.filter(p => p.delta < 1e-9),
        far: aligned.lower,
      },
      modalCcyTicketTargets({ overlayFill: false, ticket: eurTicket }),
    );
    expect(pinned.hCarryUsdYrM).toBeCloseTo(2.3, 8);
    expect(pinned.vCfarUsdM).toBeCloseTo(8.7, 8);
    expect(pinned.vCfarUsdM).not.toBeCloseTo(0.717, 2);
    expect(pinned.vCfarUsdM).not.toBeCloseTo(18.5, 1);
    expect(pinned.openHit!.carryUsdYrM).toBeCloseTo(2.3, 3);
    expect(pinned.openHit!.cfarUsdM).toBeCloseTo(8.7, 3);
    expect(pinned.openHit!.standing).toBeCloseTo(79.36, 5);
  });
});

describe('modalCcyTicketTargets', () => {
  it('pins Swap/Both Target Carry + Target VAR to the CCY row, not Policy VAR / far leftover', () => {
    const t = modalCcyTicketTargets({
      overlayFill: false,
      ticket: { cfarUsdM: 8.7, carryUsdYrM: 2.3 },
    });
    expect(t.carryUsdYrM).toBeCloseTo(2.3, 8);
    expect(t.cfarUsdM).toBeCloseTo(8.7, 8);
    expect(t.pinVar).toBe(true);
    expect(t.cfarUsdM).not.toBeCloseTo(18.5, 1);
    expect(t.cfarUsdM).not.toBeCloseTo(0.717, 2);
  });

  it('does not stamp overlay-fill chips onto an origin walk', () => {
    expect(modalCcyTicketTargets({
      overlayFill: true,
      ticket: { cfarUsdM: 15, carryUsdYrM: 1.599 },
    })).toEqual({ carryUsdYrM: null, cfarUsdM: null, pinVar: false });
  });
});

describe('bookStandingChipLabel', () => {
  it('labels Book S as FCY and Book $ as USD', () => {
    expect(bookStandingChipLabel(79.36, 92.9)).toBe('Book S 79.4 M · Book $92.9M');
    expect(bookStandingChipLabel(79.36, 0)).toBe('Book S 79.4 M');
  });
});
