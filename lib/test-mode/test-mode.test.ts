import { describe, expect, it } from 'vitest';
import {
  buildHedgeVarSummary,
  buildNordtechWorkspace,
  classifyNordtechEntity,
  computeConsolidatedRisk,
  computeStockLadder,
  consolidateEntityBooks,
  emptyAnswers,
  accruedPositionFromScheduleM,
  analyticsOpenExposureLocalM,
  averageExposureFromScheduleM,
  simpleAverageFromScheduleM,
  bookedNotionalLocalM,
  buildRollingHedgeEdges,
  hasRollingStripForCcy,
  hedgeBreakevensForStrip,
  isLiveHedgeTicket,
  mergeRollingStripIntoBook,
  needsRollingHedges,
  packSelectedStripEdges,
  proposeRollingHedgeTickets,
  resyncBookedRollingStrips,
  buildStripHedgedVarProfile,
  stripAnalyticsWeightedVarUsdM,
  stripForwardLegsFromEdges,
  stripResidualVarAtMonthsUsdM,
  varSetupForHedgeStructure,
  varSetupForPathHedgeRegime,
  removeHedgeTicketOrStrip,
  buildExposurePathPoints,
  buildResidualPath,
  budgetRiskUsdM,
  hedgeBreakevenMonths,
  hedgeRatioForNumber,
  resyncHedgeRatiosToNearestRegime,
  computeAnalyticsVarUsdM,
  computeGrowingExposureVarUsdM,
  computeParametricVarUsdM,
  cumulativeForecastErrorStdM,
  equalVarLinearHedgeNotionalLocalM,
  equalVarNotionalAtTenureLocalM,
  eurRefExposureM,
  expectedEurVarUsdM,
  growingExposurePathFactor,
  linearBulletNotionalFromVarUsdM,
  aggregateBookedHedges,
  applyBookedHedgePositions,
  applyConsolidatedBookedChange,
  emptyHedgeBook,
  fxTableRiskMetrics,
  GROUP_HEDGE_SCOPE,
  growingVarByHorizonUsdM,
  largestMismatch,
  overlayRiskFromFxBook,
  NORDTECH_REFERENCE,
  proposeBookHedge,
  proposeHigherVarHedge,
  scoreTask01,
  seedNordtechWorkspace,
  simSeedForEntity,
  TASK01_REQUIRED_ANALYTICAL_LAYERS,
  TASK01_REQUIRED_DECISION_LAYERS,
  TASK01_REQUIRED_FX_INPUTS,
  withinTolerance,
  type VarSetup,
} from '@/lib/test-mode';
import { usdToFcyM } from '@/lib/fx-buffer';
import {
  createDashboard,
  createRiskProfile,
  type Workspace,
} from '@/lib/workspace-store';

function completeWorkspace(): Workspace {
  let ws = seedNordtechWorkspace();
  for (const e of ws.entities) {
    const d = createDashboard(ws, e.id, `${e.name} FX`);
    ws = d.workspace;
    const p = createRiskProfile(ws, e.id, d.dashboard.id, {
      type: 'fx',
      name: 'Cash/FX',
      fxConfig: {
        inputs: [...TASK01_REQUIRED_FX_INPUTS],
        currencyMode: 'all',
        currencies: [],
        optimizationMetrics: [],
        decisionLayers: [...TASK01_REQUIRED_DECISION_LAYERS],
        analyticalLayers: [...TASK01_REQUIRED_ANALYTICAL_LAYERS],
      },
    });
    ws = p.workspace;
  }
  return ws;
}

function answersFor(setup: VarSetup, extras: Partial<ReturnType<typeof emptyAnswers>> = {}) {
  const varK = Math.round(expectedEurVarUsdM(setup) * 1000);
  return {
    ...emptyAnswers(),
    largestMismatchCcy: 'EUR',
    largestMismatchAmount: String(eurRefExposureM(setup)),
    varConfidencePct: String(setup.confidencePct),
    varHorizon: setup.horizon,
    varExposureBasis: setup.exposureBasis,
    varForecastMonths: String(setup.forecastMonths),
    varForecastUncertainty:
      setup.forecastUncertainty1m > 0 ? String(setup.forecastUncertainty1m) : '',
    varVolSource: setup.volSource,
    varAveragingConvention: setup.averagingConvention,
    eurVarUsdK: String(varK),
    ...extras,
  };
}

function setupOf(
  partial: Omit<
    VarSetup,
    | 'forecastMonths'
    | 'forecastUncertainty1m'
    | 'volSource'
    | 'averagingConvention'
  > & {
    forecastMonths?: number;
    forecastUncertainty1m?: number;
    volSource?: VarSetup['volSource'];
    averagingConvention?: VarSetup['averagingConvention'];
  },
): VarSetup {
  return {
    forecastMonths: 1,
    forecastUncertainty1m: 0,
    volSource: 'historical',
    averagingConvention: 'midMonth',
    ...partial,
  };
}

describe('NordTech seed exposures', () => {
  it('EUR Net FX stock = cash + receivables − debt ≈ 1.9', () => {
    const entities = seedNordtechWorkspace().entities;
    const de = entities.find(e => classifyNordtechEntity(e) === 'DE')!;
    const seed = simSeedForEntity(de);
    const eur = seed.rows.find(r => r.ccy === 'EUR')!;
    expect(eur.cash + (eur.nonCashAsset ?? 0)).toBeCloseTo(4.9, 6);
    expect(eur.ir_liab_notional).toBeCloseTo(3.0, 6);
    expect(
      eur.cash + (eur.nonCashAsset ?? 0) - eur.ir_liab_notional,
    ).toBeCloseTo(1.9, 6);
    expect(eur.collections).toBeCloseTo(1.2, 6);
  });
});

describe('Task 01 scoring — setup-dependent VaR', () => {
  const stock99_1m = setupOf({
    confidencePct: 99,
    exposureBasis: 'stock',
    horizon: '1m',
  });
  const avg99_1m = setupOf({
    confidencePct: 99,
    exposureBasis: 'avgBuildup',
    horizon: '1m',
  });
  const stock95_3m = setupOf({
    confidencePct: 95,
    exposureBasis: 'stock',
    horizon: '3m',
  });

  it('passes stock · 1m · 99% (~$110K)', () => {
    const result = scoreTask01(completeWorkspace(), answersFor(stock99_1m), true);
    expect(result.pass).toBe(true);
  });

  it('passes avg P&L pipeline · 1m · 99%', () => {
    const result = scoreTask01(completeWorkspace(), answersFor(avg99_1m), true);
    expect(result.pass).toBe(true);
    // EUR avg = 1.9 + 0.5×1.2 = 2.5
    expect(expectedEurVarUsdM(avg99_1m)).toBeCloseTo(2.5 * 0.025 * 2.326, 5);
  });

  it('total forecast buildup accrues with g=min(Th,Tf)', () => {
    const total1m = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '1m',
      forecastMonths: 1,
    });
    // Th=1m caps accrual even when Tf=3m.
    const totalTf3Th1 = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '1m',
      forecastMonths: 3,
    });
    const total3m = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 3,
    });
    expect(eurRefExposureM(total1m)).toBeCloseTo(1.9 + 1.2, 5);
    expect(eurRefExposureM(totalTf3Th1)).toBeCloseTo(1.9 + 1.2, 5);
    expect(eurRefExposureM(total3m)).toBeCloseTo(1.9 + 3 * 1.2, 5);
    expect(scoreTask01(completeWorkspace(), answersFor(total1m), true).pass).toBe(true);
    expect(scoreTask01(completeWorkspace(), answersFor(total3m), true).pass).toBe(true);
  });

  it('accepts EUR 2.5 for avg P&L pipeline exposure (not stock 1.9)', () => {
    const result = scoreTask01(
      completeWorkspace(),
      answersFor(avg99_1m, { largestMismatchAmount: '2.5' }),
      true,
    );
    expect(result.checks.find(c => c.id === 'answerAmount')!.pass).toBe(true);
  });

  it('rejects stock 1.9 when Analytics basis is avg P&L pipeline', () => {
    const result = scoreTask01(
      completeWorkspace(),
      answersFor(avg99_1m, { largestMismatchAmount: '1.9' }),
      true,
    );
    expect(result.checks.find(c => c.id === 'answerAmount')!.pass).toBe(false);
  });

  it('passes stock · 3m · 95% (√3 vol scale)', () => {
    const result = scoreTask01(completeWorkspace(), answersFor(stock95_3m), true);
    expect(result.pass).toBe(true);
  });

  it('fails VaR that does not match the declared setup', () => {
    const result = scoreTask01(
      completeWorkspace(),
      answersFor(stock99_1m, { eurVarUsdK: '390' }),
      true,
    );
    expect(result.checks.find(c => c.id === 'answerVar')!.pass).toBe(false);
  });

  it('fails incomplete Analytics setup', () => {
    const result = scoreTask01(
      completeWorkspace(),
      {
        ...answersFor(stock99_1m),
        varHorizon: '',
      },
      true,
    );
    expect(result.checks.find(c => c.id === 'answerConfidence')!.pass).toBe(false);
  });
});

describe('Consolidated risk layer', () => {
  it('EUR stock VaR at 99% 1m ≈ $110K', () => {
    const setup = setupOf({ confidencePct: 99, exposureBasis: 'stock', horizon: '1m' });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    expect(eur.bar.stockNetM).toBeCloseTo(1.9, 5);
    expect(eur.bar.avg3mM).toBeCloseTo(2.5, 5);
    expect(withinTolerance(eur.varStock.varUsdM, NORDTECH_REFERENCE.eurVarUsdM)).toBe(true);
    const m = largestMismatch(risk.map(r => r.bar))!;
    expect(m.ccy).toBe('EUR');
  });
});

describe('Hedging Decision VaR before/after', () => {
  it('100% hedge drives residual VaR to ~0', () => {
    // F×0 → path = stock; matches curriculum EUR stock VaR @ 99% 1m.
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'stock',
      horizon: '1m',
      forecastMonths: 0,
    });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const open = buildHedgeVarSummary(risk, {}, setup);
    expect(withinTolerance(open.rows.find(r => r.ccy === 'EUR')!.varBeforeUsdM, NORDTECH_REFERENCE.eurVarUsdM)).toBe(true);
    const closed = buildHedgeVarSummary(risk, { EUR: 1, PLN: 1, GBP: 1 }, setup);
    expect(closed.totalVarAfterUsdM).toBeLessThan(1e-9);
  });
});

describe('Book hedge tickets', () => {
  it('stock → spot; avgBuildup → forward at VaR horizon; higher VaR picks total for EUR', () => {
    const setup = setupOf({ confidencePct: 99, exposureBasis: 'stock', horizon: '1m' });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;

    const spotTicket = proposeBookHedge(eur, 'stock', setup);
    expect(spotTicket.instrument).toBe('spot');
    expect(spotTicket.maturity).toBeNull();
    expect(spotTicket.amountLocalM).toBeCloseTo(1.9, 5);

    const fwdTicket = proposeBookHedge(eur, 'avgBuildup', setup);
    expect(fwdTicket.instrument).toBe('forward');
    expect(fwdTicket.maturity).toBe('1m');
    expect(fwdTicket.amountLocalM).toBeCloseTo(2.5, 5);
    // Total (S+F×T = 3.1) > avg pipeline (2.5) → avg does not address the higher VaR.
    expect(fwdTicket.addressesHigherVar).toBe(false);

    const higher = proposeHigherVarHedge(eur, setup);
    expect(higher.basis).toBe('totalBuildup');
    expect(higher.instrument).toBe('forward');
  });

  it('aggregates entity hedges into consolidated booked list', () => {
    const t1 = {
      id: 'a',
      ccy: 'EUR',
      instrument: 'spot' as const,
      basis: 'stock' as const,
      amountLocalM: 1,
      maturity: null,
      maturityLabel: null,
      varUsdM: 0.1,
      addressesHigherVar: false,
      entityId: 'e1',
      entityName: 'GmbH',
    };
    const t2 = {
      ...t1,
      id: 'b',
      ccy: 'PLN',
      entityId: 'e2',
      entityName: 'Poland',
    };
    const books = {
      e1: { bookedHedges: [t1], hedgeRatios: {} },
      e2: { bookedHedges: [t2], hedgeRatios: { PLN: 0.5 } },
      [GROUP_HEDGE_SCOPE]: emptyHedgeBook(),
    };
    const all = aggregateBookedHedges(books, ['e1', 'e2'], true);
    expect(all).toHaveLength(2);
    expect(all.map(t => t.ccy).sort()).toEqual(['EUR', 'PLN']);

    const afterCancel = applyConsolidatedBookedChange([t2], ['e1', 'e2'], books);
    expect(afterCancel.e1.bookedHedges).toHaveLength(0);
    expect(afterCancel.e2.bookedHedges).toHaveLength(1);
    expect(afterCancel.e2.hedgeRatios.PLN).toBe(0.5);
  });

  it('booked forward overlays into FWD FCY / FWD USD position columns', () => {
    const setup = setupOf({ confidencePct: 99, exposureBasis: 'avgBuildup', horizon: '1m' });
    const ws = seedNordtechWorkspace();
    const risk = computeConsolidatedRisk(ws.entities, setup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    const ticket = proposeBookHedge(eur, 'avgBuildup', setup);
    expect(ticket.instrument).toBe('forward');
    const book = consolidateEntityBooks(ws.entities);
    const seed = book.rows.find(r => r.ccy === 'EUR')!;
    expect(Math.abs(seed.fwd)).toBeLessThan(1e-9);
    const displayed = applyBookedHedgePositions(book.rows, [ticket]).find(r => r.ccy === 'EUR')!;
    // Long exposure → SELL forward → short FWD position (−amount in local).
    expect(usdToFcyM(displayed.fwd, 'EUR')).toBeCloseTo(-ticket.amountLocalM, 5);
  });

  it('fx table metrics show spot/fwd hedges and residual VaR under regime', () => {
    // Risk Metrics Exp = Net FX Forecast (F×T). F×0 → Exp = stock, so a stock
    // spot hedge can flat the residual.
    const stockSetup = setupOf({
      confidencePct: 99,
      exposureBasis: 'stock',
      horizon: '1m',
      forecastMonths: 0,
    });
    const ws = seedNordtechWorkspace();
    const risk = computeConsolidatedRisk(ws.entities, stockSetup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    const ticket = proposeBookHedge(eur, 'stock', stockSetup);
    const book = consolidateEntityBooks(ws.entities);
    const open = fxTableRiskMetrics(book.rows, stockSetup);
    expect(open.find(m => m.ccy === 'EUR')!.exposureLocalM).toBeCloseTo(1.9, 5);
    expect(open.find(m => m.ccy === 'EUR')!.varUsdM).toBeGreaterThan(0.01);
    const closed = fxTableRiskMetrics(book.rows, stockSetup, [ticket]).find(m => m.ccy === 'EUR')!;
    expect(Math.abs(closed.spotHedgeLocalM)).toBeCloseTo(Math.abs(ticket.amountLocalM), 5);
    expect(Math.abs(closed.forwardHedgeLocalM)).toBeLessThan(1e-9);
    expect(Math.abs(closed.residualLocalM)).toBeLessThan(1e-9);
    expect(closed.varUsdM).toBeLessThan(1e-9);
  });

  it('fx table Exp follows Net FX Forecast (F×T), not Analytics stock-only', () => {
    const setup1m = setupOf({
      confidencePct: 99,
      exposureBasis: 'stock', // Analytics stock must not freeze Risk Metrics Exp
      horizon: '1m',
      forecastMonths: 1,
    });
    const book = consolidateEntityBooks(seedNordtechWorkspace().entities);
    const eur = fxTableRiskMetrics(book.rows, setup1m).find(m => m.ccy === 'EUR')!;
    // Net FX 1.9 + flow 1.2 × 1m = 3.1
    expect(eur.exposureLocalM).toBeCloseTo(3.1, 5);
  });

  it('Analytics VaR evolution follows live FX book stock, not seed EUR 1.9', () => {
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'simpleAvg',
      horizon: '1m',
      forecastMonths: 12,
    });
    const entities = seedNordtechWorkspace().entities;
    const seedRisk = computeConsolidatedRisk(entities, setup);
    const book = consolidateEntityBooks(entities);
    const eurRow = book.rows.find(r => r.ccy === 'EUR')!;
    // Edit Cash FX (spot) so Net FX stock moves off seed 1.9.
    const edited = { ...eurRow, spot: eurRow.spot + 1.0 }; // 1.9 → 2.9
    const liveRows = book.rows.map(r => (r.ccy === 'EUR' ? edited : r));
    const liveRisk = overlayRiskFromFxBook(seedRisk, liveRows, setup);
    const liveEur = liveRisk.find(r => r.bar.ccy === 'EUR')!;
    expect(liveEur.bar.stockNetM).toBeCloseTo(2.9, 5);
    expect(seedRisk.find(r => r.bar.ccy === 'EUR')!.bar.stockNetM).toBeCloseTo(
      1.9,
      5,
    );
    const seedTerm = growingVarByHorizonUsdM(
      seedRisk.find(r => r.bar.ccy === 'EUR')!.bar.stockNetM,
      1.2,
      'EUR',
      setup,
    );
    const liveTerm = growingVarByHorizonUsdM(
      liveEur.bar.stockNetM,
      liveEur.bar.flowM,
      'EUR',
      setup,
    );
    expect(liveTerm.find(t => t.id === '1y')!.varUsdM).toBeGreaterThan(
      seedTerm.find(t => t.id === '1y')!.varUsdM,
    );
  });

  it('growing-exposure VaR is below snapshot |E_end|×σ×√T and above |S|×σ×√T', () => {
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 3,
    });
    const S = 1.9;
    const F = 1.2;
    const end = S + F * 3; // 5.5
    const path = growingExposurePathFactor(S, F, 3, 3);
    // Constant S → |S|√T; end snapshot path equiv |E|√T; linear RMS in between.
    expect(path).toBeGreaterThan(Math.abs(S) * Math.sqrt(3));
    expect(path).toBeLessThan(Math.abs(end) * Math.sqrt(3));
    const grow = computeGrowingExposureVarUsdM(S, F, 'EUR', setup);
    const snapEnd = computeParametricVarUsdM(end, 'EUR', setup);
    const snapStock = computeParametricVarUsdM(S, 'EUR', setup);
    expect(grow).toBeGreaterThan(snapStock);
    expect(grow).toBeLessThan(snapEnd);
  });

  it('forecast period caps cumulative path when VaR horizon > Tf', () => {
    const S = 1.9;
    const F = 1.2;
    // Horizon 1y, forecast only 1m → grow 1m then flat at S+F
    const capped = growingExposurePathFactor(S, F, 12, 1);
    const uncapped = growingExposurePathFactor(S, F, 12, 12);
    const stockOnly = growingExposurePathFactor(S, F, 12, 0);
    expect(capped).toBeGreaterThan(stockOnly);
    expect(capped).toBeLessThan(uncapped);
  });

  it('stock & weighted-avg VaR follow √T; growth-path curvature differs', () => {
    const S = 1.9;
    const F = 1.2;
    const base = {
      confidencePct: 99 as const,
      forecastMonths: 12,
      forecastUncertainty1m: 0,
    };
    const stock1 = computeAnalyticsVarUsdM(S, F, 'EUR', { ...base, exposureBasis: 'stock', horizon: '1m' });
    const stock3 = computeAnalyticsVarUsdM(S, F, 'EUR', { ...base, exposureBasis: 'stock', horizon: '3m' });
    expect(stock3 / stock1).toBeCloseTo(Math.sqrt(3), 5);

    // With Tf fixed and Th ≤ Tf, Ē grows with Th — not pure √T. Pure √T when Tf caps both.
    const avgCapped = { ...base, forecastMonths: 1, exposureBasis: 'avgBuildup' as const };
    const avg1c = computeAnalyticsVarUsdM(S, F, 'EUR', { ...avgCapped, horizon: '1m' });
    const avg3c = computeAnalyticsVarUsdM(S, F, 'EUR', { ...avgCapped, horizon: '3m' });
    expect(avg3c / avg1c).toBeCloseTo(Math.sqrt(3), 5);
    expect(avg1c).toBeGreaterThan(stock1);

    const path1 = computeAnalyticsVarUsdM(S, F, 'EUR', { ...base, exposureBasis: 'totalBuildup', horizon: '1m' });
    const path3 = computeAnalyticsVarUsdM(S, F, 'EUR', { ...base, exposureBasis: 'totalBuildup', horizon: '3m' });
    // Growth path is not pure √T (ratio ≠ √3).
    expect(Math.abs(path3 / path1 - Math.sqrt(3))).toBeGreaterThan(0.05);
  });

  it('weighted-avg VaR at Th=3m is unchanged when Tf extends past 3m', () => {
    const S = 1.9;
    const F = 1.2;
    const base = {
      confidencePct: 99 as const,
      exposureBasis: 'avgBuildup' as const,
      horizon: '3m' as const,
      forecastUncertainty1m: 0,
    };
    const vTf3 = computeAnalyticsVarUsdM(S, F, 'EUR', { ...base, forecastMonths: 3 });
    const vTf6 = computeAnalyticsVarUsdM(S, F, 'EUR', { ...base, forecastMonths: 6 });
    // Time-weighted avg: Ē = S + 1.5F = 3.7 at Th=Tf=3 (≡ simple on flat F)
    expect(vTf3).toBeCloseTo(3.7 * 0.025 * Math.sqrt(3) * 2.326, 5);
    expect(vTf6).toBeCloseTo(vTf3, 8);
    // Extending Tf only lifts longer tenures (Th=6m).
    const v6_tf3 = computeAnalyticsVarUsdM(S, F, 'EUR', {
      ...base,
      horizon: '6m',
      forecastMonths: 3,
    });
    const v6_tf6 = computeAnalyticsVarUsdM(S, F, 'EUR', {
      ...base,
      horizon: '6m',
      forecastMonths: 6,
    });
    expect(v6_tf6).toBeGreaterThan(v6_tf3 + 1e-6);
  });

  it('1m forecast uncertainty compounds as √g and steepens VaR curvature', () => {
    const S = 1.9;
    const F = 1.2;
    const u = 0.3;
    // Independent monthly errors: σ_E(g) = |F|·u·√g
    expect(cumulativeForecastErrorStdM(F, u, 1)).toBeCloseTo(F * u, 8);
    expect(cumulativeForecastErrorStdM(F, u, 4)).toBeCloseTo(F * u * 2, 8);

    // Cap Tf so Ē is flat across Th=1m/3m — isolates √T vs u steepening.
    const base = {
      confidencePct: 99 as const,
      exposureBasis: 'avgBuildup' as const,
      forecastMonths: 1,
      forecastUncertainty1m: u,
    };
    const off = { ...base, forecastUncertainty1m: 0 };
    const v1off = computeAnalyticsVarUsdM(S, F, 'EUR', { ...off, horizon: '1m' });
    const v3off = computeAnalyticsVarUsdM(S, F, 'EUR', { ...off, horizon: '3m' });
    const v1 = computeAnalyticsVarUsdM(S, F, 'EUR', { ...base, horizon: '1m' });
    const v3 = computeAnalyticsVarUsdM(S, F, 'EUR', { ...base, horizon: '3m' });
    expect(v1).toBeGreaterThan(v1off);
    // Stock ignores forecast u
    expect(
      computeAnalyticsVarUsdM(S, F, 'EUR', {
        ...base,
        exposureBasis: 'stock',
        horizon: '1m',
      }),
    ).toBeCloseTo(
      computeAnalyticsVarUsdM(S, F, 'EUR', {
        ...off,
        exposureBasis: 'stock',
        horizon: '1m',
      }),
      8,
    );
    // Pure √T → VaR/√T flat; with u, σ_E grows as √g (g capped at Tf=1) still lifts level.
    expect(v3off / Math.sqrt(3)).toBeCloseTo(v1off, 8);
    expect(v3).toBeGreaterThan(v3off + 1e-9);
  });

  it('Hedge-add % does not show as Fwd hedge without booked forwards', () => {
    const avgSetup = setupOf({
      confidencePct: 99,
      exposureBasis: 'avgBuildup',
      horizon: '1m',
    });
    const book = consolidateEntityBooks(seedNordtechWorkspace().entities);
    const withRatio = fxTableRiskMetrics(book.rows, avgSetup, [], { EUR: 0.5 });
    const eur = withRatio.find(m => m.ccy === 'EUR')!;
    expect(Math.abs(eur.forwardHedgeLocalM)).toBeLessThan(1e-9);
    expect(Math.abs(eur.spotHedgeLocalM)).toBeLessThan(1e-9);
    expect(Math.abs(eur.residualLocalM)).toBeCloseTo(Math.abs(eur.exposureLocalM) * 0.5, 5);
  });

  it('booked ticket nets into exposure; VaR @ Δ1 stays on open; avg basis reopens residual', () => {
    // forecastMonths=0 so stock ticket can zero path residual (no F×T buildup).
    const stockSetup = setupOf({
      confidencePct: 99,
      exposureBasis: 'stock',
      horizon: '6m',
      forecastMonths: 0,
    });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, stockSetup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    const ticket = proposeBookHedge(eur, 'stock', stockSetup);
    const open = buildHedgeVarSummary(risk, {}, stockSetup);

    const afterBook = buildHedgeVarSummary(risk, {}, stockSetup, [ticket]);
    const stockRow = afterBook.rows.find(r => r.ccy === 'EUR')!;
    expect(Math.abs(stockRow.exposureLocalM)).toBeLessThan(1e-9);
    expect(stockRow.hedgeRatio).toBe(0);
    expect(Math.abs(stockRow.hedgeNotionalLocalM)).toBeLessThan(1e-9);
    // Δ = 1 VaR stays on the original open book — does not collapse to $0 after booking.
    expect(stockRow.varBeforeUsdM).toBeCloseTo(
      open.rows.find(r => r.ccy === 'EUR')!.varBeforeUsdM,
      8,
    );
    expect(stockRow.delta).toBe(0);
    expect(stockRow.varAfterUsdM).toBeLessThan(1e-9);

    const avgSetup: VarSetup = {
      ...stockSetup,
      exposureBasis: 'avgBuildup',
      forecastMonths: 1,
    };
    const afterSwitch = buildHedgeVarSummary(risk, {}, avgSetup, [ticket]);
    const avgRow = afterSwitch.rows.find(r => r.ccy === 'EUR')!;
    // Exposure @ Δ1 = accrued end (not Ē); stock ticket leaves forecast residual.
    const endOpen = analyticsOpenExposureLocalM(
      eur.bar.stockNetM,
      eur.bar.flowM,
      avgSetup,
    );
    expect(avgRow.exposureLocalM).toBeCloseTo(endOpen - ticket.amountLocalM, 5);
    expect(avgRow.varBeforeUsdM).toBeGreaterThan(1e-6);
    expect(avgRow.delta).toBeGreaterThan(0);
    expect(avgRow.hedgeRatio).toBe(0);
  });

  it('equal-VaR linear hedge notional ≤ accrued position; matches opposite VaR', () => {
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '1w',
      forecastMonths: 12,
    });
    const S = 1.9;
    const F = 1.2;
    const pathVar = computeAnalyticsVarUsdM(S, F, 'EUR', setup);
    const { amountLocalM, uncappedAbsLocalM, capped } = equalVarLinearHedgeNotionalLocalM(
      S,
      F,
      'EUR',
      setup,
      pathVar,
    );
    // Accrued at 1w: S + F×0.25 = 2.2 — full F×12 = 16.3 must not be the hedge size.
    expect(Math.abs(amountLocalM)).toBeLessThanOrEqual(2.2 + 1e-9);
    expect(Math.abs(amountLocalM)).toBeLessThan(16.3);
    expect(uncappedAbsLocalM).toBeCloseTo(
      linearBulletNotionalFromVarUsdM(pathVar, 'EUR', setup),
      8,
    );
    // Bullet VaR of sized N matches path VaR when under the accrued cap.
    if (!capped) {
      expect(computeParametricVarUsdM(amountLocalM, 'EUR', setup)).toBeCloseTo(pathVar, 6);
    }
    const summary = buildHedgeVarSummary(
      computeConsolidatedRisk(seedNordtechWorkspace().entities, setup),
      { EUR: 1 },
      setup,
    );
    const eur = summary.rows.find(r => r.ccy === 'EUR')!;
    // VaR-neutral N = Equal-VaR at Tf (matches bullet/strip final), not Th-only.
    const eqAtTf = equalVarNotionalAtTenureLocalM(S, F, 'EUR', setup, 12);
    expect(Math.abs(eur.equalVarHedgeLocalM)).toBeCloseTo(Math.abs(eqAtTf), 5);
    expect(Math.abs(eur.equalVarHedgeLocalM)).toBeGreaterThan(
      Math.abs(amountLocalM),
    );
    // 100% Decision hedge → Hedge N = Target N (same sign / cover).
    expect(eur.hedgeNotionalLocalM).toBeCloseTo(eur.targetHedgeLocalM, 5);
    expect(Math.abs(eur.targetHedgeLocalM)).toBeGreaterThan(
      Math.abs(eur.equalVarHedgeLocalM),
    );
  });

  it('Analytics summary: Stock is t=0 cash; Hedge N opposite; Target cover → Δ=0', () => {
    const setup = setupOf({
      confidencePct: 95,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 3,
    });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const open = buildHedgeVarSummary(risk, {}, setup);
    const eur0 = open.rows.find(r => r.ccy === 'EUR')!;
    const pln0 = open.rows.find(r => r.ccy === 'PLN')!;
    expect(eur0.stockHedgeLocalM).toBeCloseTo(1.9, 5);
    expect(eur0.openExposureLocalM).toBeCloseTo(5.5, 5);
    expect(pln0.stockHedgeLocalM).toBeCloseTo(-1.8, 5);
    expect(pln0.openExposureLocalM).toBeCloseTo(-7.2, 5);
    // Fresh book: unhedged → Δ = 1
    expect(pln0.delta).toBe(1);
    expect(Math.abs(pln0.hedgeNotionalLocalM)).toBeLessThan(1e-12);

    const covered = buildHedgeVarSummary(
      risk,
      { EUR: 1, PLN: 1, GBP: 1 },
      setup,
    );
    for (const r of covered.rows) {
      expect(r.delta).toBe(0);
      expect(r.hedgeNotionalLocalM).toBeCloseTo(r.targetHedgeLocalM, 5);
      expect(Math.abs(r.residualLocalM)).toBeLessThan(1e-9);
    }
    // Partial PLN % leaves Δ > 0 (not a path/VaR bug).
    const partial = buildHedgeVarSummary(risk, { PLN: 0.42 }, setup);
    const plnP = partial.rows.find(r => r.ccy === 'PLN')!;
    expect(plnP.delta).toBeGreaterThan(0.3);
    expect(plnP.hedgeNotionalLocalM).toBeCloseTo(pln0.targetHedgeLocalM * 0.42, 5);
  });

  it('resync hedge % to nearest regime after VaR profile change', () => {
    const growth = setupOf({
      confidencePct: 95,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 3,
    });
    const avg = setupOf({
      confidencePct: 95,
      exposureBasis: 'simpleAvg',
      horizon: '3m',
      forecastMonths: 3,
      averagingConvention: 'monthEnd',
    });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, growth);
    const gOpen = buildHedgeVarSummary(risk, {}, growth);
    const eurG = gOpen.rows.find(r => r.ccy === 'EUR')!;
    const vnRatio = hedgeRatioForNumber(
      eurG.equalVarHedgeLocalM,
      eurG.targetHedgeLocalM,
    );
    // Stale book: keep growth VN % after switching to weighted/simple avg.
    const stale = buildHedgeVarSummary(risk, { EUR: vnRatio }, avg);
    const avgOpen = buildHedgeVarSummary(risk, {}, avg);
    const eurA = avgOpen.rows.find(r => r.ccy === 'EUR')!;
    const freshVn = hedgeRatioForNumber(
      eurA.equalVarHedgeLocalM,
      eurA.targetHedgeLocalM,
    );
    expect(Math.abs(vnRatio - freshVn)).toBeGreaterThan(1e-3);
    const synced = resyncHedgeRatiosToNearestRegime(stale.rows, {
      EUR: vnRatio,
    });
    expect(synced).not.toBeNull();
    expect(synced!.EUR).toBeCloseTo(freshVn, 5);
    // After resync, Hedge N = Equal-VaR; residual formula still leaves end gap.
    const after = buildHedgeVarSummary(risk, synced!, avg);
    const eurAfter = after.rows.find(r => r.ccy === 'EUR')!;
    expect(eurAfter.hedgeNotionalLocalM).toBeCloseTo(eurA.equalVarHedgeLocalM, 4);
    expect(eurAfter.delta).toBeGreaterThan(0);
    expect(eurAfter.delta).toBeCloseTo(
      Math.abs(eurAfter.residualLocalM) /
        Math.abs(eurAfter.targetHedgeLocalM),
      5,
    );
    // Idempotent when already on the chip under the current book.
    expect(resyncHedgeRatiosToNearestRegime(after.rows, synced!)).toBeNull();
  });

  it('Decision hedge %: Cash / VaR-neutral / Target ladder on Total', () => {
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 6,
    });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const open = buildHedgeVarSummary(risk, {}, setup);
    const eur0 = open.rows.find(r => r.ccy === 'EUR')!;
    const stockR = hedgeRatioForNumber(
      eur0.stockHedgeLocalM,
      eur0.targetHedgeLocalM,
    );
    const midR = hedgeRatioForNumber(
      eur0.equalVarHedgeLocalM,
      eur0.targetHedgeLocalM,
    );
    expect(stockR).toBeGreaterThan(0);
    expect(stockR).toBeLessThan(midR);
    expect(midR).toBeLessThan(1);

    const atCash = buildHedgeVarSummary(risk, { EUR: stockR }, setup);
    const atMid = buildHedgeVarSummary(risk, { EUR: midR }, setup);
    const atTarget = buildHedgeVarSummary(risk, { EUR: 1 }, setup);
    const c = atCash.rows.find(r => r.ccy === 'EUR')!;
    const m = atMid.rows.find(r => r.ccy === 'EUR')!;
    const t = atTarget.rows.find(r => r.ccy === 'EUR')!;
    // Hedge N is trade-signed (opposite exposure).
    expect(c.hedgeNotionalLocalM).toBeCloseTo(eur0.stockHedgeLocalM, 4);
    expect(m.hedgeNotionalLocalM).toBeCloseTo(eur0.equalVarHedgeLocalM, 4);
    expect(t.hedgeNotionalLocalM).toBeCloseTo(eur0.targetHedgeLocalM, 4);
  });

  it('exposure path breakeven crosses flat hedge between S and E_end', () => {
    const path = buildExposurePathPoints(1.9, [1.2, 1.3, 1.4], 3);
    const H = 3.78; // near time-avg Ē
    const tStar = hedgeBreakevenMonths(path, H);
    expect(tStar).not.toBeNull();
    expect(tStar!).toBeGreaterThan(0.5);
    expect(tStar!).toBeLessThan(2.5);
    // H = S at t=0 is a touch, not a crossing
    expect(hedgeBreakevenMonths(path, 1.9)).toBeNull();
    expect(hedgeRatioForNumber(1.9, 3.78)).toBeCloseTo(1.9 / 3.78, 5);
    expect(hedgeRatioForNumber(5.8, 3.78)).toBeCloseTo(5.8 / 3.78, 5); // uncapped
  });

  it('USD Budget Risk vs T0: Target end ~0, Cash end >0, √τ scaling', () => {
    const path = buildExposurePathPoints(1.9, [1.2, 1.3, 1.4], 3);
    const S = 1.9;
    const endH = 5.8;
    const midH = 3.78;
    const ccy = 'EUR';
    const confidencePct = 99 as const;
    const rCash = buildResidualPath(path, S, {
      basis: 'cash',
      startM: S,
      endM: endH,
      ccy,
      confidencePct,
    });
    const rEnd = buildResidualPath(path, endH, {
      basis: 'totalExpected',
      startM: S,
      endM: endH,
      ccy,
      confidencePct,
    });
    const rMid = buildResidualPath(path, midH, {
      basis: 'varNeutral',
      startM: S,
      endM: endH,
      ccy,
      confidencePct,
    });
    // Cash: matched at t=0 → budget risk 0; unmatched at end → risk > 0
    expect(rCash[0]!.budgetRiskUsdM).toBeLessThan(1e-12);
    expect(rCash[0]!.absResidualM).toBeLessThan(1e-9);
    const cashEnd = rCash[rCash.length - 1]!;
    expect(cashEnd.absResidualM).toBeGreaterThan(1);
    expect(cashEnd.budgetNetM).toBeGreaterThan(1); // unmatched at settle
    expect(cashEnd.budgetRiskUsdM).toBeLessThan(1e-12); // τ=0 → formula zero at T
    // Cash pre-settle: open residual × √τ > 0
    const cashAt2 = rCash.find(p => Math.abs(p.t - 2) < 1e-6)!;
    expect(cashAt2.budgetRiskUsdM).toBeGreaterThan(0.01);
    expect(cashAt2.budgetRiskUsdM).toBeCloseTo(
      budgetRiskUsdM(cashAt2.absResidualM, 1, ccy, confidencePct),
      8,
    );
    // Target: early overhedge → budget risk > 0; matched at end → ~0
    expect(rEnd[0]!.absResidualM).toBeCloseTo(endH - S, 5);
    expect(rEnd[0]!.budgetRiskUsdM).toBeGreaterThan(0.05);
    expect(rEnd[0]!.budgetRiskUsdM).toBeCloseTo(
      budgetRiskUsdM(endH - S, 3, ccy, confidencePct),
      8,
    );
    expect(rEnd[rEnd.length - 1]!.absResidualM).toBeLessThan(0.05);
    expect(rEnd[rEnd.length - 1]!.budgetRiskUsdM).toBeLessThan(1e-9);
    // √τ scaling: same |r|, half remaining months → risk / √2
    const r0 = rEnd[0]!.absResidualM;
    const at0 = budgetRiskUsdM(r0, 3, ccy, confidencePct);
    const atHalfTau = budgetRiskUsdM(r0, 1.5, ccy, confidencePct);
    expect(atHalfTau / at0).toBeCloseTo(Math.sqrt(0.5), 5);
    // VaR-neutral: end gap remains; budget risk at end is 0 (τ=0) but gap noted
    expect(rMid[rMid.length - 1]!.budgetNetM).toBeCloseTo(endH - midH, 5);
    expect(rMid[rMid.length - 1]!.budgetRiskUsdM).toBeLessThan(1e-12);
    const mid0 = rMid[0]!.absResidualM;
    const midEnd = rMid[rMid.length - 1]!.absResidualM;
    const midMin = Math.min(...rMid.map(p => p.absResidualM));
    expect(midMin).toBeLessThan(mid0);
    expect(midMin).toBeLessThan(midEnd);
    expect(rMid[0]!.budgetRiskUsdM).toBeGreaterThan(0.01);
  });

  it('rolling edges: stock / mid / window-end + per-edge breakevens', () => {
    const S = 1.9;
    const F = 1.2;
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'stock',
      horizon: '3m',
      forecastMonths: 6,
    });
    expect(needsRollingHedges(setup)).toBe(true);
    const bulletSetup = varSetupForHedgeStructure(setup, 'bullet');
    expect(bulletSetup.horizon).toBe('6m');
    expect(varSetupForHedgeStructure(setup, 'strip').horizon).toBe('3m');
    const stockDefault = setupOf({
      confidencePct: 99,
      exposureBasis: 'stock',
      horizon: '1m',
      forecastMonths: 1,
    });
    const pathRegime = varSetupForPathHedgeRegime(stockDefault, 'bullet');
    expect(pathRegime.exposureBasis).toBe('totalBuildup');
    expect(pathRegime.horizon).toBe('1m');
    const flows = Array.from({ length: 6 }, () => F);
    const path = buildExposurePathPoints(S, flows, 6);
    const stock = buildRollingHedgeEdges(S, flows, setup, 'stockStart');
    const mid = buildRollingHedgeEdges(S, flows, setup, 'varNeutral', {
      ccy: 'EUR',
      varSetup: setup,
    });
    const end = buildRollingHedgeEdges(S, flows, setup, 'windowEnd');
    expect(stock).toHaveLength(2);
    // Cash/stock roll: H = S at each window start
    expect(stock[0]!.hedgeLocalM).toBeCloseTo(1.9, 5);
    expect(stock[1]!.hedgeLocalM).toBeCloseTo(5.5, 5);
    // VN strip = per-window path-VaR CoG H=e(∫t e²/∫e²)
    expect(mid[0]!.hedgeLocalM).toBeCloseTo(4.241, 2);
    expect(mid[1]!.hedgeLocalM).toBeCloseTo(7.590, 2);
    expect(end[0]!.hedgeLocalM).toBeCloseTo(5.5, 5);
    const beStock = hedgeBreakevensForStrip(path, stock, 'stockStart');
    expect(beStock).toHaveLength(2);
    expect(beStock[0]!.t).toBeCloseTo(0, 5);
    expect(beStock[1]!.t).toBeCloseTo(3, 5);
    const beMid = hedgeBreakevensForStrip(path, mid, 'varNeutral');
    expect(beMid.length).toBeGreaterThanOrEqual(1);
    expect(beMid[0]!.t).toBeGreaterThan(0.5);
    expect(beMid[0]!.t).toBeLessThan(3);
    const beEnd = hedgeBreakevensForStrip(path, end, 'windowEnd');
    expect(beEnd[0]!.t).toBeCloseTo(3, 5);
    expect(beEnd[1]!.t).toBeCloseTo(6, 5);
  });

  it('custom endMonths keep applied settles — do not append phantom Tf', () => {
    const S = 1.9;
    const F = 1.2;
    const setup = setupOf({
      confidencePct: 95,
      exposureBasis: 'stock',
      horizon: '3m',
      forecastMonths: 12,
    });
    const flows = Array.from({ length: 12 }, () => F);
    // Optimizer-style strip ending before Tf (e.g. M6.4 / M8.4 / M8.8).
    const applied = [6.4, 8.4, 8.8];
    const edges = buildRollingHedgeEdges(S, flows, setup, 'stockStart', {
      endMonths: applied,
      ccy: 'EUR',
      varSetup: setup,
    });
    expect(edges).toHaveLength(3);
    expect(edges.map(e => e.endMonth)).toEqual([6.4, 8.4, 8.8]);
    expect(edges[edges.length - 1]!.endMonth).toBeLessThan(12 - 1e-9);
  });

  it('windowEnd custom settles cover full E(Tf) — no underhedge vs Target', () => {
    const S = 1.9;
    const F = 1.2;
    const setup = setupOf({
      confidencePct: 95,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 12,
    });
    const flows = Array.from({ length: 12 }, () => F);
    const applied = [6.4, 8.4, 8.8];
    const edges = buildRollingHedgeEdges(S, flows, setup, 'windowEnd', {
      endMonths: applied,
    });
    const eTf = accruedPositionFromScheduleM(S, flows, 12);
    expect(edges).toHaveLength(3);
    expect(edges.map(e => e.endMonth)).toEqual([6.4, 8.4, 8.8]);
    expect(edges[edges.length - 1]!.hedgeLocalM).toBeCloseTo(eTf, 6);
    const legs = stripForwardLegsFromEdges(edges);
    const sum = legs.reduce((s, l) => s + l.amountLocalM, 0);
    expect(sum).toBeCloseTo(eTf, 6);
  });

  it('rolling strip: all legs live from M0; incremental size; own tenure', () => {
    const S = 1.9;
    const F = 1.2;
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 6,
    });
    const flows = Array.from({ length: 6 }, () => F);
    const edges = buildRollingHedgeEdges(S, flows, setup, 'windowEnd');
    const strip = proposeRollingHedgeTickets(
      'EUR',
      edges,
      setup,
      'totalBuildup',
      flows,
    );
    expect(strip).toHaveLength(2);
    expect(strip.every(t => t.status === 'booked')).toBe(true);
    expect(strip[0]!.stripId).toBe(strip[1]!.stripId);
    // Incremental: H0=5.5, H1=9.1 → 5.5 + 3.6
    expect(strip[0]!.amountLocalM).toBeCloseTo(5.5, 5);
    expect(strip[1]!.amountLocalM).toBeCloseTo(3.6, 5);
    expect(strip[0]!.maturity).toBe('3m');
    expect(strip[1]!.maturity).toBe('6m');
    expect(bookedNotionalLocalM(strip, 'EUR')).toBeCloseTo(9.1, 5);
    expect(strip[0]!.varUsdM).toBeGreaterThan(0);
    // Ticket VaR = parametric |N| @ tenure (not analytics path VaR).
    expect(strip[0]!.varUsdM).toBeCloseTo(
      computeParametricVarUsdM(5.5, 'EUR', { ...setup, horizon: '3m' }),
      6,
    );
    expect(strip[1]!.varUsdM).toBeCloseTo(
      computeParametricVarUsdM(3.6, 'EUR', { ...setup, horizon: '6m' }),
      6,
    );

    const once = mergeRollingStripIntoBook([], strip, 'EUR');
    expect(hasRollingStripForCcy(once, 'EUR')).toBe(true);
    const again = proposeRollingHedgeTickets(
      'EUR',
      edges,
      setup,
      'totalBuildup',
      flows,
    );
    const twice = mergeRollingStripIntoBook(once, again, 'EUR');
    expect(twice.filter(t => t.ccy === 'EUR' && t.stripId)).toHaveLength(2);
    expect(twice.filter(isLiveHedgeTicket)).toHaveLength(2);

    const cleared = removeHedgeTicketOrStrip(twice, again[1]!);
    expect(hasRollingStripForCcy(cleared, 'EUR')).toBe(false);
  });

  it('hedged VaR profile: Target residual |e−H| mid-path > 0; ~0 only at Tf', () => {
    const setup = setupOf({
      confidencePct: 95,
      exposureBasis: 'simpleAvg',
      horizon: '6m',
      forecastMonths: 12,
      forecastUncertainty1m: 0.08,
      averagingConvention: 'midMonth',
    });
    const eur = computeConsolidatedRisk(
      seedNordtechWorkspace().entities,
      setup,
    ).find(r => r.bar.ccy === 'EUR')!;
    const flows = Array.from({ length: 12 }, () => eur.bar.flowM);
    const legs = stripForwardLegsFromEdges(
      buildRollingHedgeEdges(eur.bar.stockNetM, flows, setup, 'windowEnd'),
    );
    const profile = buildStripHedgedVarProfile(
      eur.bar.stockNetM,
      eur.bar.flowM,
      'EUR',
      setup,
      legs.map(l => ({
        amountLocalM: l.amountLocalM,
        tenureMonths: l.tenureMonths,
      })),
      flows,
      1,
      Math.abs(16.3),
    );
    const at6 = profile.find(p => Math.abs(p.t - 6) < 1e-6)!;
    const at12 = profile.find(p => Math.abs(p.t - 12) < 1e-6)!;
    // H=E(Tf) from M0, but e(6)=9.1 → unrealized 7.2 still mismatches.
    expect(at6.cumulCoverLocalM).toBeCloseTo(16.3, 5);
    expect(at6.exposureLocalM).toBeCloseTo(9.1, 5);
    expect(at6.residualCoverLocalM).toBeCloseTo(7.2, 5);
    expect(at6.hedgedVarUsdM).toBeGreaterThan(1e-6);
    expect(at6.hedgedVarUsdM).toBeCloseTo(
      at6.openVarUsdM * (7.2 / 16.3),
      8,
    );
    expect(at12.exposureLocalM).toBeCloseTo(16.3, 5);
    expect(at12.residualCoverLocalM).toBeLessThan(1e-9);
    expect(at12.hedgedVarUsdM).toBeLessThan(1e-9);
    // Bullet Target same residual path as strip Target (same flat H).
    const bulletProfile = buildStripHedgedVarProfile(
      eur.bar.stockNetM,
      eur.bar.flowM,
      'EUR',
      setup,
      [
        {
          amountLocalM: 16.3,
          tenureMonths: 12,
          recognizeFromMonths: 0,
        },
      ],
      flows,
      1,
      Math.abs(16.3),
    );
    const b6 = bulletProfile.find(p => Math.abs(p.t - 6) < 1e-6)!;
    expect(b6.residualCoverLocalM).toBeCloseTo(at6.residualCoverLocalM, 8);
    expect(b6.hedgedVarUsdM).toBeCloseTo(at6.hedgedVarUsdM, 8);
  });

  it('short forecast Tf=3: VN residual track continues past Tf (e flat, V grows)', () => {
    const setup = setupOf({
      confidencePct: 95,
      exposureBasis: 'simpleAvg',
      horizon: '1y',
      forecastMonths: 3,
      forecastUncertainty1m: 0,
    });
    const S = 1.9;
    const F = 1.2;
    const flows = [F, F, F];
    const Eend = S + 3 * F; // 5.5
    const Hvn = S + 0.5 * F * 3; // Ē = 3.7 (simple/time-weighted flat)
    const profile = buildStripHedgedVarProfile(
      S,
      F,
      'EUR',
      setup,
      [{ amountLocalM: Hvn, tenureMonths: 3, recognizeFromMonths: 0 }],
      flows,
      1,
      Eend,
      12,
    );
    const at3 = profile.find(p => Math.abs(p.t - 3) < 1e-6)!;
    const at12 = profile.find(p => Math.abs(p.t - 12) < 1e-6)!;
    expect(at3.exposureLocalM).toBeCloseTo(Eend, 5);
    expect(at12.exposureLocalM).toBeCloseTo(Eend, 5); // flat after Tf
    expect(at3.residualCoverLocalM).toBeCloseTo(Eend - Hvn, 5);
    expect(at12.residualCoverLocalM).toBeCloseTo(Eend - Hvn, 5); // gap stays
    expect(at3.hedgedVarUsdM).toBeGreaterThan(1e-6);
    // Open VaR keeps growing with tenure → resid VaR rises after Tf.
    expect(at12.openVarUsdM).toBeGreaterThan(at3.openVarUsdM + 1e-6);
    expect(at12.hedgedVarUsdM).toBeGreaterThan(at3.hedgedVarUsdM + 1e-6);
    expect(at12.hedgedVarUsdM).toBeCloseTo(
      at12.openVarUsdM * ((Eend - Hvn) / Eend),
      8,
    );
  });

  it('Target strip Tf=12 Th=6: M0 legs 9.1+7.2; residual VaR @6m ≈ 362', () => {
    const setup = setupOf({
      confidencePct: 95,
      exposureBasis: 'simpleAvg',
      horizon: '6m',
      forecastMonths: 12,
      forecastUncertainty1m: 0.08,
      averagingConvention: 'midMonth',
    });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    const S = eur.bar.stockNetM;
    const F = eur.bar.flowM;
    const flows = Array.from({ length: 12 }, () => F);
    const edges = buildRollingHedgeEdges(S, flows, setup, 'windowEnd');
    const legs = stripForwardLegsFromEdges(edges);
    expect(legs).toHaveLength(2);
    expect(legs[0]!.label).toBe('M0–M6');
    expect(legs[1]!.label).toBe('M0–M12');
    expect(legs[0]!.amountLocalM).toBeCloseTo(9.1, 5);
    expect(legs[1]!.amountLocalM).toBeCloseTo(7.2, 5);
    expect(legs[1]!.cumulCoverLocalM).toBeCloseTo(16.3, 5);
    // Residual N at Tf = 0
    expect(16.3 - legs[0]!.amountLocalM - legs[1]!.amountLocalM).toBeCloseTo(
      0,
      5,
    );

    // Untick M0–M6 → its Δ folds into M0–M12 (same Σ, later maturity).
    const packed = packSelectedStripEdges(
      edges,
      legs,
      { 0: false, 1: true },
      12,
    );
    expect(packed).toHaveLength(1);
    expect(packed[0]!.startMonth).toBeCloseTo(0, 5);
    expect(packed[0]!.endMonth).toBeCloseTo(12, 5);
    expect(packed[0]!.hedgeLocalM).toBeCloseTo(16.3, 5);

    // Target strip: H=Σ=16.3 from M0 → |e−H|@M6 = 7.2 (≠ 0); 0 only at Tf.
    const targetProfile = buildStripHedgedVarProfile(
      S,
      F,
      'EUR',
      setup,
      [
        { amountLocalM: 9.1, tenureMonths: 6, recognizeFromMonths: 0 },
        { amountLocalM: 7.2, tenureMonths: 12, recognizeFromMonths: 0 },
      ],
      flows,
      1,
      16.3,
      12,
    );
    const at6 = targetProfile.find(p => Math.abs(p.t - 6) < 1e-6)!;
    const at12 = targetProfile.find(p => Math.abs(p.t - 12) < 1e-6)!;
    expect(at6.cumulCoverLocalM).toBeCloseTo(16.3, 5);
    expect(at6.exposureLocalM).toBeCloseTo(9.1, 5);
    expect(at6.residualCoverLocalM).toBeCloseTo(7.2, 5);
    expect(at6.hedgedVarUsdM).toBeGreaterThan(1e-6);
    expect(at12.residualCoverLocalM).toBeCloseTo(0, 5);
    expect(at12.hedgedVarUsdM).toBeCloseTo(0, 5);

    const resid6 = stripResidualVarAtMonthsUsdM(
      S,
      F,
      'EUR',
      setup,
      6,
      9.1,
      flows,
    );
    expect(resid6 * 1000).toBeCloseTo(362, 0);
    const strip = proposeRollingHedgeTickets(
      'EUR',
      edges,
      setup,
      'totalBuildup',
      flows,
    );
    // Parametric strip sum > analytics bullet V(Tf)
    const V12 = computeAnalyticsVarUsdM(S, F, 'EUR', setup, flows, 12);
    const stripParam =
      strip[0]!.varUsdM + strip[1]!.varUsdM;
    expect(stripParam * 1000).toBeCloseTo(1942, 0);
    expect(V12 * 1000).toBeCloseTo(1297, 0);
    expect(stripParam).toBeGreaterThan(V12);
    // Live credit underperforms bullet
    const credit = stripAnalyticsWeightedVarUsdM(
      S,
      F,
      'EUR',
      setup,
      [
        { amountLocalM: 9.1, tenureMonths: 6 },
        { amountLocalM: 7.2, tenureMonths: 12 },
      ],
      flows,
    );
    expect(credit).toBeLessThan(V12);
    const row = buildHedgeVarSummary(
      risk,
      {},
      varSetupForHedgeStructure(setup, 'strip'),
      strip,
      { EUR: flows },
    ).rows.find(r => r.ccy === 'EUR')!;
    expect(row.hedgeNotionalLocalM).toBeCloseTo(16.3, 5);
    // Target strip: e(Tf)=H → resid VaR 0 (same formula as bullet / evolution).
    expect(row.varAfterUsdM).toBeLessThan(1e-6);
    expect(Math.abs(row.residualLocalM)).toBeLessThan(1e-9);
  });

  it('strip booked: Hedge N = full cover (not Cash %); Stock stays gross', () => {
    const setup = setupOf({
      confidencePct: 95,
      exposureBasis: 'simpleAvg',
      horizon: '1m',
      forecastMonths: 12,
      forecastUncertainty1m: 0.08,
      averagingConvention: 'midMonth',
    });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    const flows = Array.from({ length: 12 }, () => eur.bar.flowM);
    const stripSetup = varSetupForHedgeStructure(setup, 'strip');
    const edges = buildRollingHedgeEdges(
      eur.bar.stockNetM,
      flows,
      setup,
      'stockStart',
    );
    const strip = proposeRollingHedgeTickets(
      'EUR',
      edges,
      setup,
      'stock',
      flows,
    );
    // Stale Decision Cash % (≈12%) must not win over booked strip.
    const row = buildHedgeVarSummary(
      risk,
      { EUR: 0.12 },
      stripSetup,
      strip,
    ).rows.find(r => r.ccy === 'EUR')!;
    expect(row.stockHedgeLocalM).toBeCloseTo(1.9, 5);
    expect(row.hedgeNotionalLocalM).toBeCloseTo(15.1, 5);
    expect(row.hedgeRatio).toBeGreaterThan(0.9);
    // Cash strip cover < E(Tf) → resid VaR > 0.
    expect(row.varAfterUsdM).toBeGreaterThan(1e-6);
    // Residual N = e(Tf) − Σ strip legs (full M0 cover).
    expect(row.residualLocalM).toBeCloseTo(16.3 - 15.1, 5);
  });

  it('strip: Target zeros resid VaR at Tf; resync rebuilds on Th change', () => {
    const setup = setupOf({
      confidencePct: 95,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 6,
    });
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    const flows = Array.from({ length: 6 }, () => eur.bar.flowM);
    const stripSetup = varSetupForHedgeStructure(setup, 'strip');

    const edgesT = buildRollingHedgeEdges(
      eur.bar.stockNetM,
      flows,
      setup,
      'windowEnd',
    );
    const stripT = proposeRollingHedgeTickets(
      'EUR',
      edgesT,
      setup,
      'totalBuildup',
      flows,
    );
    const afterT = buildHedgeVarSummary(risk, {}, stripSetup, stripT);
    const eurT = afterT.rows.find(r => r.ccy === 'EUR')!;
    const varTf = computeAnalyticsVarUsdM(
      eur.bar.stockNetM,
      eur.bar.flowM,
      'EUR',
      setup,
      flows,
      6,
    );
    expect(eurT.varBeforeUsdM).toBeCloseTo(varTf, 6);
    // Target strip: e(Tf)=H → resid VaR 0 (path-mismatch formula).
    expect(eurT.varAfterUsdM).toBeLessThan(1e-6);
    expect(Math.abs(eurT.residualLocalM)).toBeLessThan(1e-9);
    expect(eurT.hedgeNotionalLocalM).toBeCloseTo(eurT.targetHedgeLocalM, 5);
    expect(bookedNotionalLocalM(stripT, 'EUR')).toBeCloseTo(9.1, 5);

    const edgesVn = buildRollingHedgeEdges(
      eur.bar.stockNetM,
      flows,
      setup,
      'varNeutral',
      { ccy: 'EUR', varSetup: setup },
    );
    const stripVn = proposeRollingHedgeTickets(
      'EUR',
      edgesVn,
      setup,
      'simpleAvg',
      flows,
    );
    // VN strip: per-window CoG — final ≈ last-window H (~7.59).
    const afterVn = buildHedgeVarSummary(risk, {}, stripSetup, stripVn);
    const eurVn = afterVn.rows.find(r => r.ccy === 'EUR')!;
    expect(eurVn.varAfterUsdM).toBeGreaterThan(1e-6);
    expect(bookedNotionalLocalM(stripVn, 'EUR')).toBeCloseTo(7.590, 2);
    expect(Math.abs(eurVn.hedgeNotionalLocalM)).toBeCloseTo(7.590, 2);
    expect(Math.abs(eurVn.hedgeNotionalLocalM)).toBeLessThan(
      Math.abs(eurVn.targetHedgeLocalM) - 1e-6,
    );

    // Th change must rebuild strip (3m windows → 1m windows from M0).
    const shortTh = setupOf({
      confidencePct: 95,
      exposureBasis: 'totalBuildup',
      horizon: '1m',
      forecastMonths: 6,
    });
    const rebuilt = resyncBookedRollingStrips(
      stripT,
      [{ ccy: 'EUR', stockNetM: eur.bar.stockNetM, flowM: eur.bar.flowM }],
      shortTh,
      { EUR: flows },
    );
    expect(rebuilt).not.toBeNull();
    // First incremental = end of first 1m window (Target).
    expect(rebuilt![0]!.amountLocalM).toBeCloseTo(1.9 + 1.2, 5);
    expect(rebuilt![0]!.maturity).toBe('1m');
    expect(rebuilt!.filter(t => t.stripId)).toHaveLength(6);
    expect(rebuilt!.every(t => t.status === 'booked')).toBe(true);
  });

  it('simple average vs time-weighted average (flat and uneven)', () => {
    const S = 1.9;
    const F = 1.2;
    const simpleSetup = setupOf({
      confidencePct: 99,
      exposureBasis: 'simpleAvg',
      horizon: '3m',
      forecastMonths: 3,
    });
    const twSetup = { ...simpleSetup, exposureBasis: 'avgBuildup' as const };
    // Flat F: both Ē = S+1.5F = 3.7
    expect(analyticsOpenExposureLocalM(S, F, simpleSetup)).toBeCloseTo(3.7, 5);
    expect(analyticsOpenExposureLocalM(S, F, twSetup)).toBeCloseTo(3.7, 5);
    expect(computeAnalyticsVarUsdM(S, F, 'EUR', twSetup)).toBeCloseTo(
      computeAnalyticsVarUsdM(S, F, 'EUR', simpleSetup),
      8,
    );

    const flows = [1.2, 1.3, 1.4];
    const simple = simpleAverageFromScheduleM(S, flows, 3);
    const tw = averageExposureFromScheduleM(S, flows, 3);
    expect(simple).toBeCloseTo(3.85, 5); // (1.9+5.8)/2
    expect(tw).toBeCloseTo((2.5 + 3.75 + 5.1) / 3, 5);
    expect(simple).not.toBeCloseTo(tw, 3);
    const flatF = 3.9 / 3;
    expect(
      computeAnalyticsVarUsdM(S, flatF, 'EUR', simpleSetup, flows),
    ).not.toBeCloseTo(
      computeAnalyticsVarUsdM(S, flatF, 'EUR', twSetup, flows),
      5,
    );
  });

  it('custom uneven schedule: Exposure=Ē; VN = time-weighted Ē (not path CoG)', () => {
    const S = 1.9;
    const flows = [1.2, 1.3, 1.4]; // Σ = 3.9, end = 5.8
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'avgBuildup',
      horizon: '3m',
      forecastMonths: 3,
    });
    const flatF = 3.9 / 3; // 1.3
    const tw = averageExposureFromScheduleM(S, flows, 3);
    const endBuildup = accruedPositionFromScheduleM(S, flows, 3);
    const midPoint = (S + endBuildup) / 2; // 3.85
    const flatTw = averageExposureFromScheduleM(S, [flatF, flatF, flatF], 3);
    expect(endBuildup).toBeCloseTo(5.8, 5);
    expect(tw).toBeCloseTo((2.5 + 3.75 + 5.1) / 3, 5);
    expect(tw).not.toBeCloseTo(midPoint, 3);
    expect(tw).not.toBeCloseTo(flatTw, 3);
    const schedVar = computeAnalyticsVarUsdM(S, flatF, 'EUR', setup, flows);
    const flatVar = computeAnalyticsVarUsdM(S, flatF, 'EUR', setup);
    expect(Math.abs(schedVar - flatVar)).toBeGreaterThan(1e-6);
    const { amountLocalM } = equalVarLinearHedgeNotionalLocalM(
      S,
      flatF,
      'EUR',
      setup,
      schedVar,
      flows,
    );
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const summary = buildHedgeVarSummary(risk, {}, setup, [], { EUR: flows });
    const eur = summary.rows.find(r => r.ccy === 'EUR')!;
    expect(eur.openExposureLocalM).toBeCloseTo(tw, 5);
    expect(Math.abs(eur.equalVarHedgeLocalM)).toBeCloseTo(tw, 2);
    expect(Math.abs(amountLocalM)).toBeCloseTo(tw, 2);
    expect(Math.abs(eur.equalVarHedgeLocalM)).toBeLessThan(
      Math.abs(endBuildup) - 1,
    );
  });

  it('VN differs by regime: simple/TW → Ē; growth → path CoG', () => {
    const S = 1.9;
    const F = 1.2;
    const base = {
      confidencePct: 99 as const,
      horizon: '1y' as const,
      forecastMonths: 12,
    };
    const growth = setupOf({ ...base, exposureBasis: 'totalBuildup' });
    const simple = setupOf({ ...base, exposureBasis: 'simpleAvg' });
    const tw = setupOf({ ...base, exposureBasis: 'avgBuildup' });
    const Hg = equalVarNotionalAtTenureLocalM(S, F, 'EUR', growth, 12);
    const Hs = equalVarNotionalAtTenureLocalM(S, F, 'EUR', simple, 12);
    const Ht = equalVarNotionalAtTenureLocalM(S, F, 'EUR', tw, 12);
    expect(Hs).toBeCloseTo(9.1, 5);
    expect(Ht).toBeCloseTo(9.1, 5);
    expect(Hg).toBeCloseTo(12.242, 2);
    expect(Hg).toBeGreaterThan(Hs + 1);
  });

  it('growth-path VaR-neutral N is path-VaR CoG, above Ē and RMS', () => {
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 3,
    });
    const S = 1.9;
    const F = 1.2;
    const pathVar = computeAnalyticsVarUsdM(S, F, 'EUR', setup);
    // Legacy path-VaR invert (explicit) still yields RMS — not the VN chip.
    const { amountLocalM, capped } = equalVarLinearHedgeNotionalLocalM(
      S,
      F,
      'EUR',
      setup,
      pathVar,
    );
    const endExp = S + F * 3; // 5.5
    const eBar = (S + endExp) / 2; // 3.7
    const rms = 3.843;
    expect(capped).toBe(false);
    expect(Math.abs(amountLocalM)).toBeCloseTo(rms, 2);
    expect(Math.abs(amountLocalM)).toBeLessThan(endExp - 0.5);
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const atTarget = buildHedgeVarSummary(risk, { EUR: 1 }, setup);
    const eurT = atTarget.rows.find(r => r.ccy === 'EUR')!;
    // Live VaR VN = CoG of e² mass (~4.24) > RMS > Ē.
    expect(eurT.openExposureLocalM).toBeCloseTo(endExp, 5);
    expect(Math.abs(eurT.equalVarHedgeLocalM)).toBeCloseTo(4.241, 2);
    expect(Math.abs(eurT.equalVarHedgeLocalM)).toBeGreaterThan(rms);
    expect(Math.abs(eurT.equalVarHedgeLocalM)).toBeGreaterThan(eBar);
    expect(Math.abs(eurT.equalVarHedgeLocalM)).toBeLessThan(
      Math.abs(eurT.openExposureLocalM) - 0.5,
    );
    // 100% Target: Hedge N = Target N → e=H → resid VaR 0.
    expect(eurT.hedgeNotionalLocalM).toBeCloseTo(endExp, 5);
    expect(Math.abs(eurT.residualLocalM)).toBeLessThan(1e-9);
    expect(eurT.varAfterUsdM).toBeLessThan(1e-6);
    expect(eurT.delta).toBe(0);

    // VaR-neutral: physical |e−H| remains → resid VaR > 0 (no floor to $0).
    const vnRatio = hedgeRatioForNumber(
      eurT.equalVarHedgeLocalM,
      eurT.targetHedgeLocalM,
    );
    const atVn = buildHedgeVarSummary(risk, { EUR: vnRatio }, setup);
    const eurV = atVn.rows.find(r => r.ccy === 'EUR')!;
    expect(Math.abs(eurV.residualLocalM)).toBeGreaterThan(0.5);
    expect(eurV.varAfterUsdM).toBeGreaterThan(1e-6);
    expect(eurV.varAfterUsdM).toBeCloseTo(
      eurV.varBeforeUsdM *
        (Math.abs(eurV.residualLocalM) / Math.abs(eurV.targetHedgeLocalM)),
      5,
    );
  });
});

describe('Stock ladder', () => {
  it('largest mismatch is EUR Net FX ≈ 1.9', () => {
    const bars = computeStockLadder(buildNordtechWorkspace().accounts);
    const m = largestMismatch(bars)!;
    expect(m.ccy).toBe('EUR');
    expect(m.stockNetM).toBeCloseTo(1.9, 5);
  });
});
