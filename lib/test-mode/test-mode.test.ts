import { describe, expect, it } from 'vitest';
import {
  buildHedgeVarSummary,
  buildNordtechWorkspace,
  classifyNordtechEntity,
  computeConsolidatedRisk,
  computeStockLadder,
  consolidateEntityBooks,
  emptyAnswers,
  expectedEurVarUsdM,
  aggregateBookedHedges,
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
    largestMismatchAmount: '4.9',
    varConfidencePct: String(setup.confidencePct),
    varHorizon: setup.horizon,
    varExposureBasis: setup.exposureBasis,
    eurVarUsdK: String(varK),
    ...extras,
  };
}

describe('NordTech seed exposures', () => {
  it('EUR stock = cash + receivables ≈ 4.9', () => {
    const entities = seedNordtechWorkspace().entities;
    const de = entities.find(e => classifyNordtechEntity(e) === 'DE')!;
    const seed = simSeedForEntity(de);
    const eur = seed.rows.find(r => r.ccy === 'EUR')!;
    expect(eur.cash + (eur.nonCashAsset ?? 0)).toBeCloseTo(4.9, 6);
    expect(eur.collections).toBeCloseTo(1.2, 6);
  });
});

describe('Task 01 scoring — setup-dependent VaR', () => {
  const stock99_1m: VarSetup = {
    confidencePct: 99,
    exposureBasis: 'stock',
    horizon: '1m',
  };
  const avg99_1m: VarSetup = {
    confidencePct: 99,
    exposureBasis: 'avgBuildup',
    horizon: '1m',
  };
  const stock95_3m: VarSetup = {
    confidencePct: 95,
    exposureBasis: 'stock',
    horizon: '3m',
  };

  it('passes stock · 1m · 99% (~$285K)', () => {
    const result = scoreTask01(completeWorkspace(), answersFor(stock99_1m), true);
    expect(result.pass).toBe(true);
  });

  it('passes avg buildup · 1m · 99% (~$390K)', () => {
    const result = scoreTask01(completeWorkspace(), answersFor(avg99_1m), true);
    expect(result.pass).toBe(true);
    expect(expectedEurVarUsdM(avg99_1m)).toBeCloseTo(6.7 * 0.025 * 2.326, 5);
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
  it('EUR stock VaR at 99% 1m ≈ $285K', () => {
    const setup: VarSetup = { confidencePct: 99, exposureBasis: 'stock', horizon: '1m' };
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    expect(eur.bar.stockNetM).toBeCloseTo(4.9, 5);
    expect(eur.bar.avg3mM).toBeCloseTo(6.7, 5);
    expect(withinTolerance(eur.varStock.varUsdM, NORDTECH_REFERENCE.eurVarUsdM)).toBe(true);
    const m = largestMismatch(risk.map(r => r.bar))!;
    expect(m.ccy).toBe('EUR');
  });
});

describe('Hedging Decision VaR before/after', () => {
  it('100% hedge drives residual VaR to ~0', () => {
    const setup: VarSetup = { confidencePct: 99, exposureBasis: 'stock', horizon: '1m' };
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const open = buildHedgeVarSummary(risk, {}, setup);
    expect(withinTolerance(open.rows.find(r => r.ccy === 'EUR')!.varBeforeUsdM, NORDTECH_REFERENCE.eurVarUsdM)).toBe(true);
    const closed = buildHedgeVarSummary(risk, { EUR: 1, PLN: 1, GBP: 1 }, setup);
    expect(closed.totalVarAfterUsdM).toBeLessThan(1e-9);
  });
});

describe('Book hedge tickets', () => {
  it('stock → spot; avgBuildup → forward at VaR horizon; higher VaR picks avg for EUR', () => {
    const setup: VarSetup = { confidencePct: 99, exposureBasis: 'stock', horizon: '1m' };
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, setup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;

    const spotTicket = proposeBookHedge(eur, 'stock', setup);
    expect(spotTicket.instrument).toBe('spot');
    expect(spotTicket.maturity).toBeNull();
    expect(spotTicket.amountLocalM).toBeCloseTo(4.9, 5);

    const fwdTicket = proposeBookHedge(eur, 'avgBuildup', setup);
    expect(fwdTicket.instrument).toBe('forward');
    expect(fwdTicket.maturity).toBe('1m');
    expect(fwdTicket.amountLocalM).toBeCloseTo(6.7, 5);
    expect(fwdTicket.addressesHigherVar).toBe(true);

    const higher = proposeHigherVarHedge(eur, setup);
    expect(higher.basis).toBe('avgBuildup');
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

  it('fx table metrics show spot/fwd hedges and residual VaR under regime', () => {
    const stockSetup: VarSetup = { confidencePct: 99, exposureBasis: 'stock', horizon: '1m' };
    const ws = seedNordtechWorkspace();
    const risk = computeConsolidatedRisk(ws.entities, stockSetup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    const ticket = proposeBookHedge(eur, 'stock', stockSetup);
    const book = consolidateEntityBooks(ws.entities);
    const open = fxTableRiskMetrics(book.rows, stockSetup);
    expect(open.find(m => m.ccy === 'EUR')!.varUsdM).toBeGreaterThan(0.01);
    const closed = fxTableRiskMetrics(book.rows, stockSetup, [ticket]).find(m => m.ccy === 'EUR')!;
    expect(Math.abs(closed.spotHedgeLocalM)).toBeCloseTo(Math.abs(ticket.amountLocalM), 5);
    expect(Math.abs(closed.forwardHedgeLocalM)).toBeLessThan(1e-9);
    expect(Math.abs(closed.residualLocalM)).toBeLessThan(1e-9);
    expect(closed.varUsdM).toBeLessThan(1e-9);
  });

  it('booked ticket nets into exposure; incremental hedge resets; avg basis reopens risk', () => {
    const stockSetup: VarSetup = { confidencePct: 99, exposureBasis: 'stock', horizon: '6m' };
    const risk = computeConsolidatedRisk(seedNordtechWorkspace().entities, stockSetup);
    const eur = risk.find(r => r.bar.ccy === 'EUR')!;
    const ticket = proposeBookHedge(eur, 'stock', stockSetup);

    const afterBook = buildHedgeVarSummary(risk, {}, stockSetup, [ticket]);
    const stockRow = afterBook.rows.find(r => r.ccy === 'EUR')!;
    expect(Math.abs(stockRow.exposureLocalM)).toBeLessThan(1e-9);
    expect(stockRow.hedgeRatio).toBe(0);
    expect(Math.abs(stockRow.hedgeNotionalLocalM)).toBeLessThan(1e-9);
    expect(stockRow.varBeforeUsdM).toBeLessThan(1e-9);
    expect(stockRow.varAfterUsdM).toBeLessThan(1e-9);

    const avgSetup: VarSetup = { ...stockSetup, exposureBasis: 'avgBuildup' };
    const afterSwitch = buildHedgeVarSummary(risk, {}, avgSetup, [ticket]);
    const avgRow = afterSwitch.rows.find(r => r.ccy === 'EUR')!;
    expect(avgRow.exposureLocalM).toBeCloseTo(eur.bar.avg3mM - ticket.amountLocalM, 5);
    expect(avgRow.varBeforeUsdM).toBeGreaterThan(1e-6);
    expect(avgRow.hedgeRatio).toBe(0);
  });
});

describe('Stock ladder', () => {
  it('largest mismatch is EUR', () => {
    const m = largestMismatch(computeStockLadder(buildNordtechWorkspace().accounts))!;
    expect(m.ccy).toBe('EUR');
  });
});
