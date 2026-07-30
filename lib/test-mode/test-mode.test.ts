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
  proposeRollingHedgeTickets,
  removeHedgeTicketOrStrip,
  rollingHedgeAtMonth,
  buildExposurePathPoints,
  buildResidualPath,
  hedgeBreakevenMonths,
  hedgeRatioForNumber,
  computeAnalyticsVarUsdM,
  computeGrowingExposureVarUsdM,
  computeParametricVarUsdM,
  cumulativeForecastErrorStdM,
  equalVarLinearHedgeNotionalLocalM,
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
  largestMismatch,
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
    eurVarUsdK: String(varK),
    ...extras,
  };
}

function setupOf(
  partial: Omit<VarSetup, 'forecastMonths' | 'forecastUncertainty1m'> & {
    forecastMonths?: number;
    forecastUncertainty1m?: number;
  },
): VarSetup {
  return { forecastMonths: 1, forecastUncertainty1m: 0, ...partial };
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
    const stockSetup = setupOf({ confidencePct: 99, exposureBasis: 'stock', horizon: '6m' });
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

    const avgSetup: VarSetup = { ...stockSetup, exposureBasis: 'avgBuildup' };
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
    expect(Math.abs(eur.equalVarHedgeLocalM)).toBeCloseTo(Math.abs(amountLocalM), 5);
    // 100% Decision hedge = Target (Total expected), not Equal-VaR mid.
    expect(Math.abs(eur.hedgeNotionalLocalM)).toBeCloseTo(
      Math.abs(eur.targetHedgeLocalM),
      5,
    );
    expect(Math.abs(eur.targetHedgeLocalM)).toBeGreaterThan(
      Math.abs(eur.equalVarHedgeLocalM),
    );
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

  it('residual VaR: √∫(e−H)² accrues from t=0 (flat hedge offset)', () => {
    const path = buildExposurePathPoints(1.9, [1.2, 1.3, 1.4], 3);
    const S = 1.9;
    const endH = 5.8;
    const midH = 3.78;
    const rCash = buildResidualPath(path, S, {
      basis: 'cash',
      startM: S,
      endM: endH,
    });
    const rEnd = buildResidualPath(path, endH, {
      basis: 'totalExpected',
      startM: S,
      endM: endH,
    });
    const rMid = buildResidualPath(path, midH, {
      basis: 'varNeutral',
      startM: S,
      endM: endH,
    });
    // Cash: r(0)=0 then grows — path factor rises in month 1
    expect(rCash[0]!.cumPathFactor).toBeLessThan(1e-9);
    const cashAt1 = rCash.find(p => Math.abs(p.t - 1) < 1e-6) ?? rCash[1]!;
    expect(cashAt1.cumPathFactor).toBeGreaterThan(0.2);
    // Total: offset from t=0 (H=E_end > S) → factor grows immediately
    expect(rEnd[0]!.absResidualM).toBeCloseTo(endH - S, 5);
    const endAt1 = rEnd.find(p => Math.abs(p.t - 1) < 1e-6) ?? rEnd[1]!;
    expect(endAt1.cumPathFactor).toBeGreaterThan(0.5);
    expect(rEnd[rEnd.length - 1]!.absResidualM).toBeLessThan(0.05);
    // VaR-neutral: accrues before BE (overhedge offset), continues after
    const tBe = hedgeBreakevenMonths(path, midH)!;
    const beforeBe = rMid.filter(p => p.t < tBe - 1e-6 && p.t > 0.2);
    expect(beforeBe.some(p => p.cumPathFactor > 0.1)).toBe(true);
    expect(rMid[rMid.length - 1]!.cumPathFactor).toBeGreaterThan(0.5);
    expect(rMid[rMid.length - 1]!.budgetNetM).toBeCloseTo(endH - midH, 5);
    // Early path factor grows with √t character (between 0 and |r₀|√t)
    const r0 = rEnd[0]!.absResidualM;
    expect(endAt1.cumPathFactor).toBeGreaterThan(0.5 * r0);
    expect(endAt1.cumPathFactor).toBeLessThan(r0 * Math.sqrt(1) + 0.05);
    const mid0 = rMid[0]!.absResidualM;
    const midEnd = rMid[rMid.length - 1]!.absResidualM;
    const midMin = Math.min(...rMid.map(p => p.absResidualM));
    expect(midMin).toBeLessThan(mid0);
    expect(midMin).toBeLessThan(midEnd);
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
    const flows = Array.from({ length: 6 }, () => F);
    const path = buildExposurePathPoints(S, flows, 6);
    const stock = buildRollingHedgeEdges(S, flows, setup, 'stockStart');
    const mid = buildRollingHedgeEdges(S, flows, setup, 'varNeutral');
    const end = buildRollingHedgeEdges(S, flows, setup, 'windowEnd');
    expect(stock).toHaveLength(2);
    // Cash/stock roll: H = S at each window start
    expect(stock[0]!.hedgeLocalM).toBeCloseTo(1.9, 5);
    expect(stock[1]!.hedgeLocalM).toBeCloseTo(5.5, 5);
    expect(mid[0]!.hedgeLocalM).toBeCloseTo(3.7, 5);
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

  it('rolling strip: book M0 live + later scheduled; no duplicate stacks', () => {
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
    const strip = proposeRollingHedgeTickets('EUR', edges, setup, 'totalBuildup');
    expect(strip).toHaveLength(2);
    expect(strip[0]!.status).toBe('booked');
    expect(strip[1]!.status).toBe('scheduled');
    expect(strip[0]!.stripId).toBe(strip[1]!.stripId);
    expect(bookedNotionalLocalM(strip, 'EUR')).toBeCloseTo(
      strip[0]!.amountLocalM,
      5,
    );
    expect(bookedNotionalLocalM(strip, 'EUR')).not.toBeCloseTo(
      strip[0]!.amountLocalM + strip[1]!.amountLocalM,
      5,
    );

    const once = mergeRollingStripIntoBook([], strip, 'EUR');
    expect(hasRollingStripForCcy(once, 'EUR')).toBe(true);
    const again = proposeRollingHedgeTickets('EUR', edges, setup, 'totalBuildup');
    const twice = mergeRollingStripIntoBook(once, again, 'EUR');
    expect(twice.filter(t => t.ccy === 'EUR' && t.stripId)).toHaveLength(2);
    expect(twice.filter(isLiveHedgeTicket)).toHaveLength(1);

    const cleared = removeHedgeTicketOrStrip(twice, again[1]!);
    expect(hasRollingStripForCcy(cleared, 'EUR')).toBe(false);
  });

  it('simpleAvg mid-point vs weighted time-avg on uneven schedule', () => {
    const S = 1.9;
    const flows = [1.2, 1.3, 1.4];
    const mid = simpleAverageFromScheduleM(S, flows, 3);
    const weighted = averageExposureFromScheduleM(S, flows, 3);
    expect(mid).toBeCloseTo(3.85, 5); // (1.9+5.8)/2
    expect(weighted).toBeCloseTo(3.783333, 3);
    expect(mid).toBeGreaterThan(weighted);
    const simpleSetup = setupOf({
      confidencePct: 99,
      exposureBasis: 'simpleAvg',
      horizon: '3m',
      forecastMonths: 3,
    });
    const weightedSetup = { ...simpleSetup, exposureBasis: 'avgBuildup' as const };
    const flatF = 3.9 / 3;
    const vSimple = computeAnalyticsVarUsdM(S, flatF, 'EUR', simpleSetup, flows);
    const vWeighted = computeAnalyticsVarUsdM(S, flatF, 'EUR', weightedSetup, flows);
    expect(vSimple).toBeGreaterThan(vWeighted);
    expect(analyticsOpenExposureLocalM(S, flatF, simpleSetup, flows)).toBeCloseTo(
      mid,
      5,
    );
  });

  it('custom uneven schedule: Exposure=end 5.8, Equal-VaR N=time-avg Ē', () => {
    const S = 1.9;
    const flows = [1.2, 1.3, 1.4]; // Σ = 3.9, end = 5.8
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'avgBuildup',
      horizon: '3m',
      forecastMonths: 3,
    });
    const flatF = 3.9 / 3; // 1.3
    const eAvg = averageExposureFromScheduleM(S, flows, 3);
    const endBuildup = accruedPositionFromScheduleM(S, flows, 3);
    const midPoint = (S + endBuildup) / 2; // 3.85
    const flatAvg = S + 0.5 * flatF * 3; // 3.85
    expect(endBuildup).toBeCloseTo(5.8, 5);
    // Time-avg ∫e/T: slightly below mid-point when growth is back-loaded.
    expect(eAvg).toBeCloseTo(3.783333, 3);
    expect(eAvg).toBeLessThan(midPoint - 1e-6);
    expect(eAvg).not.toBeCloseTo(flatAvg, 3);
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
    // Exposure @ Δ1 = end; Equal-VaR N = time-weighted Ē ≠ mid-point / end.
    expect(eur.openExposureLocalM).toBeCloseTo(5.8, 5);
    expect(Math.abs(eur.equalVarHedgeLocalM)).toBeCloseTo(eAvg, 2);
    expect(Math.abs(amountLocalM)).toBeCloseTo(eAvg, 2);
    expect(Math.abs(eur.equalVarHedgeLocalM)).toBeLessThan(
      Math.abs(eur.openExposureLocalM) - 1,
    );
  });

  it('growth-path Equal-VaR N is RMS-equivalent, not end exposure', () => {
    const setup = setupOf({
      confidencePct: 99,
      exposureBasis: 'totalBuildup',
      horizon: '3m',
      forecastMonths: 3,
    });
    const S = 1.9;
    const F = 1.2;
    const pathVar = computeAnalyticsVarUsdM(S, F, 'EUR', setup);
    const { amountLocalM, capped } = equalVarLinearHedgeNotionalLocalM(
      S,
      F,
      'EUR',
      setup,
      pathVar,
    );
    const endExp = S + F * 3; // 5.5
    expect(capped).toBe(false);
    expect(Math.abs(amountLocalM)).toBeCloseTo(3.843, 2);
    expect(Math.abs(amountLocalM)).toBeLessThan(endExp - 0.5);
    const summary = buildHedgeVarSummary(
      computeConsolidatedRisk(seedNordtechWorkspace().entities, setup),
      { EUR: 1 },
      setup,
    );
    const eur = summary.rows.find(r => r.ccy === 'EUR')!;
    // Exposure @ Δ1 = accrued end-of-window; Hedge N = smaller RMS bullet.
    expect(eur.openExposureLocalM).toBeCloseTo(endExp, 5);
    expect(Math.abs(eur.equalVarHedgeLocalM)).toBeLessThan(
      Math.abs(eur.openExposureLocalM) - 0.5,
    );
    expect(eur.varAfterUsdM).toBeLessThan(1e-6);
    // Physical residual remains even when VaR is offset.
    expect(Math.abs(eur.residualLocalM)).toBeGreaterThan(0.5);
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
