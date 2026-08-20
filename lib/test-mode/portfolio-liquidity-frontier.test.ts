import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, type LayerId, type RowState, type SharedGlobals } from '@/lib/fx-buffer';
import { DEFAULT_FORECAST_PROFILE, type ForecastProfileState } from '@/lib/forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING, type LiquidityTiming } from '@/lib/liquidity-ladder';
import { liquidityStrategyMeta } from '@/lib/test-mode/liquidity-strategies';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import type { LiquidityFrontierInput } from '@/lib/test-mode/liquidity-frontier';
import {
  buildPortfolioLiquidityFrontier,
  diversifiedUsdRisk,
  overlayStandingAtPlotScale,
  regimePortfolioCfar,
  pairCorr,
  portfolioCfarSnapshot,
  riskStanding,
  signedCfarUsdM,
  standingAtScale,
  toPortfolioCarryFrontier,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import { orderedLiquidityScenarioPoints } from '@/lib/test-mode/portfolio-modal-align';
import { evaluateLiquidityStrategies, type LiquidityStrategyInput } from '@/lib/test-mode/liquidity-strategies';

describe('pairCorr / diversifiedUsdRisk', () => {
  it('EUR–GBP is the desk pairwise (0.77), not 1', () => {
    expect(pairCorr('EUR', 'GBP')).toBeCloseTo(0.77, 10);
    expect(pairCorr('EUR', 'EUR')).toBe(1);
    expect(pairCorr('AED', 'EUR')).toBe(0);
  });

  it('perfectly correlated same-sign risk sums; uncorrelated RSS', () => {
    const same = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: 0.4 },
      { ccy: 'EUR', usdM: 0.3 },
    ]);
    expect(same.portfolioUsdM).toBeCloseTo(0.7, 10);

    const rss = diversifiedUsdRisk([
      { ccy: 'AED', usdM: 0.3 },
      { ccy: 'USD', usdM: 0.4 },
    ]);
    expect(rss.portfolioUsdM).toBeCloseTo(Math.hypot(0.3, 0.4), 10);
  });

  it('EUR+GBP CFaR is below the undiversified sum', () => {
    const r = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: 0.50 },
      { ccy: 'GBP', usdM: 0.40 },
    ]);
    expect(r.standaloneUsdM).toBeCloseTo(0.9, 10);
    expect(r.portfolioUsdM).toBeLessThan(r.standaloneUsdM - 0.02);
    expect(r.portfolioUsdM).toBeGreaterThan(Math.hypot(0.5, 0.4) - 1e-9);
    expect(r.divFactor).toBeLessThan(1);
  });

  it('JPY’s negative corr with EUR cuts portfolio below two EM names', () => {
    const em = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: 0.5 },
      { ccy: 'PLN', usdM: 0.5 },
    ]);
    const jpy = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: 0.5 },
      { ccy: 'JPY', usdM: 0.5 },
    ]);
    expect(jpy.portfolioUsdM).toBeLessThan(em.portfolioUsdM);
  });

  it('opposite standing signs can offset when ρ > 0', () => {
    const sameWay = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: signedCfarUsdM(0.4, 12) },
      { ccy: 'GBP', usdM: signedCfarUsdM(0.3, 8) },
    ]);
    const offset = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: signedCfarUsdM(0.4, 12) },
      { ccy: 'GBP', usdM: signedCfarUsdM(0.3, -8) },
    ]);
    expect(offset.portfolioUsdM).toBeLessThan(sameWay.portfolioUsdM);
  });

  it('Euler components sum to the diversified total', () => {
    const r = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: 0.50 },
      { ccy: 'GBP', usdM: 0.40 },
      { ccy: 'JPY', usdM: 0.20 },
    ]);
    const split = r.byCcy.reduce((s, c) => s + c.componentUsdM, 0);
    expect(split).toBeCloseTo(r.portfolioUsdM, 10);
    expect(r.portfolioUsdM).toBeLessThan(r.standaloneUsdM);
  });
});

describe('regimePortfolioCfar', () => {
  it('adds overlay Euler into the book vector and stays below the standalone sum', () => {
    const r = regimePortfolioCfar(
      [
        { ccy: 'EUR', cfarUsdM: 0.334, standing: 12 },
        { ccy: 'GBP', cfarUsdM: 0.3, standing: 8 },
      ],
      [{ ccy: 'EUR', componentVarUsdM: 0.05 }, { ccy: 'GBP', componentVarUsdM: -0.01 }],
    );
    expect(r.portfolioUsdM).toBeLessThan(r.standaloneUsdM - 1e-6);
    expect(r.byCcy.reduce((s, c) => s + c.componentUsdM, 0)).toBeCloseTo(r.portfolioUsdM, 10);
  });
});

describe('portfolioCfarSnapshot', () => {
  it('matches diversifiedUsdRisk on signed CFaR', () => {
    const snap = portfolioCfarSnapshot([
      { ccy: 'EUR', cfarUsdM: 0.4, standing: -12 },
      { ccy: 'GBP', cfarUsdM: 0.3, standing: -5 },
    ]);
    const raw = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: -0.4 },
      { ccy: 'GBP', usdM: -0.3 },
    ]);
    expect(snap.portfolioUsdM).toBeCloseTo(raw.portfolioUsdM, 10);
    expect(snap.standaloneUsdM).toBeCloseTo(0.7, 10);
  });
});

const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP')!;
const shared: SharedGlobals = { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 6 };

function row(base: RowState, over: Partial<RowState> = {}): RowState {
  return {
    ...base,
    cash: 20,
    payout: -40,
    collections: 20,
    fcastFX: 0,
    cash_floor: 2,
    ...over,
  };
}

function profileWith(timing: Partial<LiquidityTiming> = {}): ForecastProfileState {
  return {
    ...DEFAULT_FORECAST_PROFILE,
    liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: true, ...timing },
  };
}

describe('buildPortfolioLiquidityFrontier', () => {
  const rows = [row(eur, { id: 'e' }), row(gbp, { id: 'g' })];
  const engine: Omit<LiquidityFrontierInput, 'row' | 'strategy' | 'bookStanding' | 'carryUsdK'> = {
    months: 6,
    shared,
    activeLayers: new Set<LayerId>(['floorH', 'carryOptim']),
    forecastProfile: profileWith({ bookingMode: 'rolling', sizingBasis: 'horizon' }),
    setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, confidencePct: 95 },
    cfarNetByCcyUsd: { EUR: 0.36, GBP: 0.22 },
  };
  const stratInput: LiquidityStrategyInput = {
    rows,
    months: 6,
    shared,
    activeLayers: engine.activeLayers,
    forecastProfile: engine.forecastProfile,
    setup: engine.setup,
    cfarNetByCcyUsd: engine.cfarNetByCcyUsd,
  };

  it('drops unticked names from the standing walk so presets re-price', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const both = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
    });
    const eurOnly = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows: [rows[0]!],
      engine,
    });
    expect(eurOnly.origin.cfarUsdM).toBeCloseTo(0.36, 5);
    expect(both.origin.cfarUsdM).toBeGreaterThan(eurOnly.origin.cfarUsdM + 0.02);
    const holdBoth = both.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    const holdEur = eurOnly.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    expect(holdBoth).toBeDefined();
    expect(holdEur).toBeDefined();
    expect(holdBoth!.cfarUsdM).toBeGreaterThan(holdEur!.cfarUsdM + 0.02);
  });

  it('sums carry and diversifies CFaR along the open arm', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme');
    expect(rolling).toBeDefined();
    const port = buildPortfolioLiquidityFrontier({
      result: rolling!,
      strategy: rolling!.strategy,
      rows,
      engine,
    });
    expect(port.open.length).toBeGreaterThan(1);
    const book = port.open.find(p => Math.abs(p.scale - 1) < 1e-6) ?? port.open[port.open.length - 1]!;
    expect(book.standaloneCfarUsdM).toBeGreaterThan(book.cfarUsdM + 1e-6);
    expect(book.divFactor).toBeLessThan(1);
    const originCarry = port.origin.carryUsdYrM;
    const tip = port.open[port.open.length - 1]!;
    expect(Math.abs(tip.carryUsdYrM)).toBeGreaterThanOrEqual(Math.abs(originCarry) - 1e-9);
  });

  it('carry plot is one S(t) walk — Conservative is scale 1, same pricer past it', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const liq = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
    });
    const f = toPortfolioCarryFrontier(liq);
    expect(f.walk).toBe('book-scale');
    expect(f.points[0]!.portfolioVarUsd).toBeCloseTo(liq.origin.cfarUsdM, 8);
    expect(f.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    const hold = f.points.find(p => Math.abs(p.k - 1) < 1e-6);
    expect(hold).toBeDefined();
    expect(hold!.k).toBeGreaterThan(0);
    const past = f.points.filter(p => p.k > 1 + 1e-6);
    expect(past.length).toBeGreaterThan(0);
    const before = f.points.filter(p => p.k > 1e-9 && p.k < 1 - 1e-6);
    expect(before.length).toBeGreaterThan(0);
    const dCarry = (a: { k: number; totalCarryUsdYr: number }, b: { k: number; totalCarryUsdYr: number }) =>
      (b.totalCarryUsdYr - a.totalCarryUsdYr) / (b.k - a.k);
    const slopeBefore = dCarry(before[before.length - 2] ?? f.points[0]!, hold!);
    const slopeAfter = dCarry(hold!, past[0]!);
    expect(Number.isFinite(slopeBefore) && Number.isFinite(slopeAfter)).toBe(true);
    const onPath = f.points.some(p => (
      p === hold
      || (Math.abs(p.portfolioVarUsd - hold!.portfolioVarUsd) < 1e-12
        && Math.abs(p.totalCarryUsdYr - hold!.totalCarryUsdYr) < 1e-12)
    ));
    expect(onPath).toBe(true);
  });

  it('Unhedged is the CFaR-tab All CCY Net Σ — both arms leave that vertex', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const liq = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
    });
    const f = toPortfolioCarryFrontier(liq);
    const tabSum = 0.36 + 0.22;
    expect(liq.origin.cfarUsdM).toBeCloseTo(tabSum, 8);
    expect(f.points[0]!.portfolioVarUsd).toBeCloseTo(tabSum, 8);
    expect(f.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(f.farPoints[0]!.portfolioVarUsd).toBeCloseTo(tabSum, 8);
    expect(f.farPoints[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(f.points.slice(1).every(p => p.portfolioVarUsd >= tabSum - 1e-6)).toBe(true);
    expect(f.farPoints.slice(1).every(p => p.portfolioVarUsd >= tabSum - 1e-6)).toBe(true);
  });

  it('t = 0 keeps the live book sign so long/short names offset', () => {
    expect(riskStanding(-12, 0)).toBe(-12);
    expect(riskStanding(-12, -3)).toBe(-3);
    expect(signedCfarUsdM(0.36, riskStanding(-12, 0))).toBeCloseTo(-0.36, 10);
    const unsigned = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: signedCfarUsdM(0.36, 0) },
      { ccy: 'GBP', usdM: signedCfarUsdM(0.22, 0) },
    ]);
    const offset = diversifiedUsdRisk([
      { ccy: 'EUR', usdM: signedCfarUsdM(0.36, riskStanding(12, 0)) },
      { ccy: 'GBP', usdM: signedCfarUsdM(0.22, riskStanding(-8, 0)) },
    ]);
    expect(offset.portfolioUsdM).toBeLessThan(unsigned.portfolioUsdM - 0.02);
  });

  it('open arm reaches the $20M policy rung; Balanced sits at or past Conservative', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const liq = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
    });
    const hold = liq.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    expect(hold).toBeDefined();
    expect(Math.max(...liq.open.map(p => p.cfarUsdM))).toBeGreaterThanOrEqual(20 - 0.05);
    expect(liq.autoSweet).toBeDefined();
    expect(liq.autoSweet!.scale).toBeGreaterThanOrEqual(1 - 1e-6);
    const f = toPortfolioCarryFrontier(liq);
    const cons = f.points.find(p => Math.abs(p.k - 1) < 1e-6)!;
    const ordered = orderedLiquidityScenarioPoints({
      points: f.points,
      conservative: cons,
      policyCapUsd: 20,
      originCfarUsd: f.points[0]!.portfolioVarUsd,
    });
    expect(ordered.origin!.totalCarryUsdYr).toBe(0);
    expect(ordered.conservative!.portfolioVarUsd).toBeGreaterThan(ordered.origin!.portfolioVarUsd);
    expect(ordered.balanced!.portfolioVarUsd).toBeGreaterThan(ordered.conservative!.portfolioVarUsd);
    expect(ordered.maxCarry!.portfolioVarUsd).toBeGreaterThan(ordered.balanced!.portfolioVarUsd);
  });

  it('yellow mix sits between open and far at the book S', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
    });
    if (port.mix.length === 0) return;
    const openBook = port.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    const farBook = port.far.find(p => Math.abs(p.scale - 1) < 1e-6);
    if (!openBook || !farBook) return;
    const mid = port.mix[Math.floor(port.mix.length / 2)]!;
    const yLo = Math.min(openBook.carryUsdYrM, farBook.carryUsdYrM);
    const yHi = Math.max(openBook.carryUsdYrM, farBook.carryUsdYrM);
    expect(mid.carryUsdYrM).toBeGreaterThanOrEqual(yLo - 1e-6);
    expect(mid.carryUsdYrM).toBeLessThanOrEqual(yHi + 1e-6);
  });

  it('iso-S mix is a dense RSS curve, not four chords', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
    });
    expect(port.mix.length).toBeGreaterThan(10);
    const openBook = port.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    const farBook = port.far.find(p => Math.abs(p.scale - 1) < 1e-6);
    if (!openBook || !farBook || port.mix.length < 3) return;
    const mid = port.mix.find(p => Math.abs(p.cover - 0.5) < 0.08)
      ?? port.mix[Math.floor(port.mix.length / 2)]!;
    const ax = farBook.cfarUsdM - openBook.cfarUsdM;
    const ay = farBook.carryUsdYrM - openBook.carryUsdYrM;
    const bx = mid.cfarUsdM - openBook.cfarUsdM;
    const by = mid.carryUsdYrM - openBook.carryUsdYrM;
    const area = Math.abs(ax * by - ay * bx);
    const chord = Math.hypot(ax, ay);
    if (chord < 1e-6) return;
    expect(area / chord).toBeGreaterThan(1e-6);
  });

  it('overlay walk sizes hold + s×mix, not a common t on live S', () => {
    expect(standingAtScale(20, 0, -80)).toBeCloseTo(100, 10);
    expect(standingAtScale(20, 1, -80)).toBeCloseTo(20, 10);
    expect(standingAtScale(20, 0.5, -80)).toBeCloseTo(60, 10);
    expect(standingAtScale(20, 0, -80, 0.25)).toBeCloseTo(40, 10);
    expect(standingAtScale(20, 0.25, -80, 0.25)).toBeCloseTo(20, 10);
    expect(standingAtScale(20, 1, -80, 0.25)).toBeCloseTo(-40, 10);
    expect(overlayStandingAtPlotScale(20, -1, -80)).toBeCloseTo(0, 10);
    expect(overlayStandingAtPlotScale(20, 0, -80)).toBeCloseTo(100, 10);
    expect(overlayStandingAtPlotScale(20, 1, -80)).toBeCloseTo(20, 10);
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
      overlayFcyByCcy: { EUR: -12, GBP: 8 },
    });
    expect(port.walk).toBe('overlay');
    expect(port.open.length).toBeGreaterThan(8);
    expect(port.sweetScale).toBe(1);
  });

  it('an earn ask still walks to the VAR cap instead of collapsing the path', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
      overlayFcyByCcy: { EUR: -12, GBP: 8 },
      overlaySweetT: 0.25,
    });
    expect(port.walk).toBe('overlay');
    expect(port.sweetScale).toBeCloseTo(0.25, 8);
    const atSweet = port.open.find(p => Math.abs(p.scale - 0.25) < 0.02);
    const atCap = port.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    expect(atSweet).toBeDefined();
    expect(atCap).toBeDefined();
    expect(port.open.some(p => p.scale > 0.9)).toBe(true);
    const span = Math.hypot(
      atCap!.cfarUsdM - atSweet!.cfarUsdM,
      atCap!.carryUsdYrM - atSweet!.carryUsdYrM,
    );
    expect(span).toBeGreaterThan(1e-6);
  });

  it('autoSweet is a real point on the curve, not the dial position', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
      overlayFcyByCcy: { EUR: -12, GBP: 8 },
    });
    expect(port.autoSweet).not.toBeNull();
    expect(port.autoSweet!.scale).toBeGreaterThanOrEqual(-1e-6);
    expect(Number.isFinite(port.autoSweet!.cfarUsdM)).toBe(true);
    expect(Number.isFinite(port.autoSweet!.carryUsdYrM)).toBe(true);
  });

  it('autoSweet does not move when the dial (overlaySweetT) moves — it reads the curve, not the setting', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const atDial1 = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
      overlayFcyByCcy: { EUR: -12, GBP: 8 },
      overlaySweetT: 1,
    });
    const atDial025 = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
      overlayFcyByCcy: { EUR: -12, GBP: 8 },
      overlaySweetT: 0.25,
    });
    // sweetScale (the old, dial-echoing field) moves with the input...
    expect(atDial1.sweetScale).not.toBeCloseTo(atDial025.sweetScale, 3);
    // ...but autoSweet is a property of the open-arm curve's own shape, which
    // this input does not change, so it should land on the same point.
    expect(atDial1.autoSweet?.scale).toBeCloseTo(atDial025.autoSweet?.scale ?? NaN, 6);
  });

  it('green and rose meet at the origin; yellow mix joins them at live S', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
    });
    const leftOpen = port.open.find(p => Math.abs(p.scale) < 1e-6) ?? port.origin;
    const leftFar = port.far.find(p => Math.abs(p.scale) < 1e-6) ?? port.origin;
    expect(leftOpen.cfarUsdM).toBeCloseTo(port.origin.cfarUsdM, 6);
    expect(leftFar.cfarUsdM).toBeCloseTo(port.origin.cfarUsdM, 6);
    expect(leftOpen.carryUsdYrM).toBeCloseTo(0, 6);
    expect(leftFar.carryUsdYrM).toBeCloseTo(0, 6);
    if (port.mix.length < 2) return;
    const mix0 = [...port.mix].sort((a, b) => a.cover - b.cover)[0]!;
    const mix1 = [...port.mix].sort((a, b) => a.cover - b.cover)[port.mix.length - 1]!;
    const openBook = port.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    const farBook = port.far.find(p => Math.abs(p.scale - 1) < 1e-6);
    expect(openBook).toBeDefined();
    expect(farBook).toBeDefined();
    expect(mix0.cfarUsdM).toBeCloseTo(openBook!.cfarUsdM, 5);
    expect(mix0.carryUsdYrM).toBeCloseTo(openBook!.carryUsdYrM, 5);
    expect(mix1.cfarUsdM).toBeCloseTo(farBook!.cfarUsdM, 5);
    expect(mix1.carryUsdYrM).toBeCloseTo(farBook!.carryUsdYrM, 5);
  });

  it('overlay arms share the origin before walking hold → cap', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
      overlayFcyByCcy: { EUR: -12, GBP: 8 },
    });
    const leftOpen = port.open.find(p => Math.abs(p.scale + 1) < 1e-6);
    const leftFar = port.far.find(p => Math.abs(p.scale + 1) < 1e-6);
    expect(leftOpen).toBeDefined();
    expect(leftFar).toBeDefined();
    expect(leftOpen!.cfarUsdM).toBeCloseTo(port.origin.cfarUsdM, 5);
    expect(leftFar!.cfarUsdM).toBeCloseTo(leftOpen!.cfarUsdM, 6);
    expect(leftFar!.carryUsdYrM).toBeCloseTo(leftOpen!.carryUsdYrM, 6);
    expect(leftOpen!.carryUsdYrM).toBeCloseTo(0, 6);
    if (port.mix.length < 2) return;
    const mix0 = [...port.mix].sort((a, b) => a.cover - b.cover)[0]!;
    const mix1 = [...port.mix].sort((a, b) => a.cover - b.cover)[port.mix.length - 1]!;
    const liveOpen = port.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    const liveFar = port.far.find(p => Math.abs(p.scale - 1) < 1e-6);
    expect(liveOpen).toBeDefined();
    expect(liveFar).toBeDefined();
    expect(mix0.cfarUsdM).toBeCloseTo(liveOpen!.cfarUsdM, 5);
    expect(mix0.carryUsdYrM).toBeCloseTo(liveOpen!.carryUsdYrM, 5);
    expect(mix1.cfarUsdM).toBeCloseTo(liveFar!.cfarUsdM, 5);
    expect(mix1.carryUsdYrM).toBeCloseTo(liveFar!.carryUsdYrM, 5);
  });

  it('overlay CFaR vs carry is a curve, not the linear VAR/μ chord', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
      overlayFcyByCcy: { EUR: -12, GBP: 8 },
    });
    const arm = port.open.filter(p => p.scale >= 0 && p.scale <= 1);
    expect(arm.length).toBeGreaterThan(10);
    const a = arm[0]!;
    const c = arm[arm.length - 1]!;
    const b = arm[Math.floor(arm.length / 2)]!;
    const area = Math.abs(
      (b.cfarUsdM - a.cfarUsdM) * (c.carryUsdYrM - a.carryUsdYrM)
      - (c.cfarUsdM - a.cfarUsdM) * (b.carryUsdYrM - a.carryUsdYrM),
    );
    const chord = Math.hypot(c.cfarUsdM - a.cfarUsdM, c.carryUsdYrM - a.carryUsdYrM);
    expect(chord).toBeGreaterThan(1e-6);
    expect(area / chord).toBeGreaterThan(1e-5);
  });

  it('book-scale open arm bows under the origin–book chord (RSS CFaR)', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const port = buildPortfolioLiquidityFrontier({
      result: rolling,
      strategy: rolling.strategy,
      rows,
      engine,
    });
    const book = port.open.find(p => Math.abs(p.scale - 1) < 1e-6);
    const mid = port.open.find(p => Math.abs(p.scale - 0.5) < 0.03);
    expect(book).toBeDefined();
    expect(mid).toBeDefined();
    const chordCfar = (port.origin.cfarUsdM + book!.cfarUsdM) / 2;
    expect(mid!.cfarUsdM).toBeLessThan(chordCfar - 1e-8);
  });
});
