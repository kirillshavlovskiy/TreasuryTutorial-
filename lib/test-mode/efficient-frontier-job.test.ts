import { describe, expect, it } from 'vitest';
import { INITIAL_ROWS } from '@/lib/fx-buffer';
import {
  EFFICIENT_FRONTIER_LIMITS,
  ccySetpointFromBreakdown,
  ccySetpointsByScenario,
  computeEfficientFrontier,
  parseEfficientFrontierRequest,
  walkStandingFromSetpoints,
} from '@/lib/test-mode/efficient-frontier-job';
import {
  chartFrontierStroke,
  chartOpenPath,
  chartPathTrace,
  frontierMonotoneStats,
  plotStandingCarryArm,
  pricedBalancedVertex,
} from '@/lib/test-mode/portfolio-modal-align';

function eurGbpRows() {
  const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR');
  const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP');
  if (!eur || !gbp) throw new Error('INITIAL_ROWS missing EUR/GBP');
  return [eur, gbp];
}

function eurGbpFrontierBody(overrides: Record<string, unknown> = {}) {
  return validBody({
    strategyInput: {
      rows: eurGbpRows(),
      months: 3,
      shared: { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 3 },
      activeLayers: ['floorH', 'sigmaP', 'portfolioDiv', 'carryOptim'],
    },
    tabNetByCcyUsd: { EUR: 2.1, GBP: 1.4 },
    scenarioId: 'carryTarget',
    scenarioCapUsd: 20,
    policyVAR: 20,
    ...overrides,
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    strategyInput: {
      rows: [],
      months: 12,
      shared: { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 12 },
      activeLayers: ['floorH', 'sigmaP', 'portfolioDiv', 'carryOptim'],
    },
    selectedStrategyId: 'rollingProgramme',
    policyVAR: 5,
    includedCcys: null,
    tabNetByCcyUsd: {},
    carryTargetUsdYr: 0.032,
    scenarioCapUsd: 5,
    bookingMode: 'rolling',
    forecastMonths: 12,
    confidencePct: 95,
    ...overrides,
  };
}

function expectError(result: ReturnType<typeof parseEfficientFrontierRequest>): string {
  if (!('error' in result)) throw new Error('expected a rejection, got a request');
  return result.error;
}

describe('parseEfficientFrontierRequest', () => {
  it('accepts a well-formed body', () => {
    const parsed = parseEfficientFrontierRequest(validBody());
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.request.policyVAR).toBe(5);
    expect(parsed.request.strategyInput.activeLayers).toEqual([
      'floorH', 'sigmaP', 'portfolioDiv', 'carryOptim',
    ]);
    expect(parsed.request.includedCcys).toBeNull();
    expect(parsed.request.askFillMode).toBe('overlay');
  });

  it('rejects an unknown askFillMode', () => {
    expect(expectError(parseEfficientFrontierRequest(validBody({
      askFillMode: 'lever',
    })))).toMatch(/askFillMode/);
  });

  it('rejects malformed envelopes and unknown ids', () => {
    expect(expectError(parseEfficientFrontierRequest(null))).toMatch(/JSON object/);
    expect(expectError(parseEfficientFrontierRequest({}))).toMatch(/strategyInput/);
    expect(expectError(parseEfficientFrontierRequest(validBody({
      selectedStrategyId: 'nope',
    })))).toMatch(/funding regime/);
    expect(expectError(parseEfficientFrontierRequest(validBody({
      strategyInput: {
        rows: [],
        months: 12,
        shared: { r_USD: 4.5, σ_P: 0.1, days: 3 },
        activeLayers: ['notALayer'],
      },
    })))).toMatch(/unknown layer/);
  });

  it('refuses an oversized book', () => {
    const rows = Array.from({ length: EFFICIENT_FRONTIER_LIMITS.maxRows + 1 }, (_, i) => ({
      ccy: `C${i}`,
    }));
    expect(expectError(parseEfficientFrontierRequest(validBody({
      strategyInput: {
        rows,
        months: 12,
        shared: { r_USD: 4.5, σ_P: 0.1, days: 3 },
        activeLayers: [],
      },
    })))).toMatch(/exceeds/);
  });
});

describe('computeEfficientFrontier', () => {
  it('returns empty results when there is no FCY book', () => {
    const parsed = parseEfficientFrontierRequest(validBody());
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    expect(out.results).toEqual([]);
    expect(out.mvFrontier).toBeNull();
    expect(out.universeFrontier).toBeNull();
    expect(out.tabAllCcyNetUsdM).toBe(0);
  });

  it('builds the overlay and book-scale arm on a real FCY book', () => {
    const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR');
    const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP');
    if (!eur || !gbp) throw new Error('INITIAL_ROWS missing EUR/GBP');
    const parsed = parseEfficientFrontierRequest(validBody({
      strategyInput: {
        rows: [eur, gbp],
        months: 3,
        shared: { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 3 },
        activeLayers: ['floorH', 'sigmaP', 'portfolioDiv', 'carryOptim'],
      },
      tabNetByCcyUsd: { EUR: 2.1, GBP: 1.4 },
      scenarioId: 'carryTarget',
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.tabAllCcyNetUsdM).toBeCloseTo(3.5, 8);
    expect(out.mvFrontier).not.toBeNull();
    expect(out.mvFrontier!.capLegs.length).toBeGreaterThan(0);
    expect(out.universeFrontier).not.toBeNull();
    expect(out.solutionFrontier).not.toBeNull();
    expect(out.carryBreakdown).not.toBeNull();
    const bd = out.carryBreakdown!;
    expect(bd.askFillMode).toBe('overlay');
    expect(out.solutionFrontier!.walk).toBe('overlay');
    expect(bd.k).toBeCloseTo(0, 5);
    expect(bd.totalSum).toBeCloseTo(bd.bookSum + bd.overlaySum, 8);
    expect(bd.chartY).toBeCloseTo(bd.overlaySum, 5);
    expect(bd.chartX).toBeCloseTo(bd.overlayCfarSum, 5);
    expect(bd.bookSum).toBeCloseTo(0, 5);
    const origin = out.solutionFrontier!.points[0]!;
    expect(origin.k).toBeCloseTo(0, 8);
    expect(origin.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(origin.portfolioVarUsd).toBeCloseTo(3.5, 6);
    expect(out.solutionFrontier!.points.length).toBeGreaterThan(10);
    expect(out.solutionFrontier!.farPoints.length).toBeGreaterThan(2);
  });

  it('omitted scenarioId still solves Carry Target (default Fill Ask = overlay)', () => {
    const parsed = parseEfficientFrontierRequest(validBody({
      strategyInput: {
        rows: eurGbpRows(),
        months: 6,
        shared: { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 6 },
        activeLayers: ['floorH', 'sigmaP', 'portfolioDiv', 'carryOptim'],
      },
      tabNetByCcyUsd: { EUR: 0.36, GBP: 0.22 },
      carryTargetUsdYr: 0.999,
      scenarioCapUsd: 20,
      policyVAR: 20,
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    expect(out.carryBreakdown).not.toBeNull();
    const bd = out.carryBreakdown!;
    expect(bd.askFillMode).toBe('overlay');
    expect(out.solutionFrontier!.walk).toBe('overlay');
    expect(bd.k).toBeCloseTo(0, 5);
    expect(bd.totalSum).toBeCloseTo(bd.bookSum + bd.overlaySum, 8);
    expect(bd.chartY).toBeCloseTo(bd.overlaySum, 5);
    expect(bd.chartX).toBeCloseTo(bd.overlayCfarSum, 5);
    expect(Math.abs(bd.chartY - bd.askY)).toBeLessThan(0.08);
  });

  it('Fill Ask = overlay walks unhedged + one term overlay to Ask Y', () => {
    const probeParsed = parseEfficientFrontierRequest(eurGbpFrontierBody({
      askFillMode: 'overlay',
      carryTargetUsdYr: 0,
    }));
    if ('error' in probeParsed) throw new Error(probeParsed.error);
    const probe = computeEfficientFrontier(probeParsed.request, { log: false });
    const t1 = probe.solutionFrontier?.points.find(p => Math.abs(p.k - 1) < 1e-6);
    if (!t1) throw new Error('missing overlay t=1');
    const ask = t1.totalCarryUsdYr + Math.max(0.08, Math.abs(t1.totalCarryUsdYr) * 0.4);
    const parsed = parseEfficientFrontierRequest(eurGbpFrontierBody({
      askFillMode: 'overlay',
      carryTargetUsdYr: ask,
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    const bd = out.carryBreakdown!;
    expect(bd.askFillMode).toBe('overlay');
    expect(out.solutionFrontier!.walk).toBe('overlay');
    expect(bd.k).toBeCloseTo(0, 5);
    expect(bd.overlayT).toBeGreaterThan(1);
    expect(bd.totalSum).toBeCloseTo(bd.bookSum + bd.overlaySum, 8);
    expect(bd.chartY).toBeCloseTo(ask, 2);
    expect(bd.chartY).toBeCloseTo(bd.overlaySum, 5);
    expect(bd.chartX).toBeCloseTo(bd.overlayCfarSum, 5);
    expect(out.regimeSolutions.rollingProgramme.portUsdM).toBeCloseTo(bd.chartX, 2);
    const nearest = out.solutionFrontier!.points.reduce((best, p) => (
      Math.abs(p.totalCarryUsdYr - bd.chartY) < Math.abs(best.totalCarryUsdYr - bd.chartY)
        ? p : best
    ));
    expect(Math.abs(nearest.totalCarryUsdYr - bd.chartY)).toBeLessThan(0.12);
    expect(out.solutionFrontier!.farPoints.length).toBeGreaterThan(2);
  });

  it('Fill Ask = swap runs the funding book only — no overlay leg', () => {
    const probeParsed = parseEfficientFrontierRequest(eurGbpFrontierBody({
      askFillMode: 'swap',
      carryTargetUsdYr: 0,
    }));
    if ('error' in probeParsed) throw new Error(probeParsed.error);
    const probe = computeEfficientFrontier(probeParsed.request, { log: false });
    const probePts = probe.solutionFrontier?.points ?? [];
    const peak = probePts.reduce((best, p) => (
      p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
    ));
    const askBase = probePts.find(p => Math.abs(p.k - 1) < 1e-6)
      ?? probePts.find(p => p.k >= -1e-12)
      ?? probePts[0];
    if (!askBase || !peak) throw new Error('missing swap arm');
    const ask = askBase.totalCarryUsdYr
      + Math.max(0.08, (peak.totalCarryUsdYr - askBase.totalCarryUsdYr) * 0.4);
    const parsed = parseEfficientFrontierRequest(eurGbpFrontierBody({
      askFillMode: 'swap',
      carryTargetUsdYr: ask,
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    const bd = out.carryBreakdown!;
    const pts = out.solutionFrontier!.points;
    expect(bd.askFillMode).toBe('swap');
    // Swap = the funding book scaled as a standing short. The k-walk is the
    // real book-scale arm (k may exceed 1), but there is NO overlay leg
    // (t = 0, overlaySum = 0) — Total = Book.
    expect(bd.overlayT).toBeCloseTo(0, 8);
    expect(bd.overlaySum).toBeCloseTo(0, 6);
    expect(bd.totalSum).toBeCloseTo(bd.bookSum, 8);
    expect(bd.totalSum).toBeCloseTo(bd.bookSum + bd.overlaySum, 8);
    // The per-leg scenario strip is returned and priced. Σ leg netUsdYr does
    // NOT yet reconcile with `bookUsdYrM` — the frontier's book carry is
    // `|cash|` on the peak standing held flat for a full year, whereas the
    // strip is the actual-horizon path with buildup and (for a complete
    // swap) CIP points that cancel the cash Δr. Unifying the two carry
    // pricers is an open item (see handover).
    for (const leg of bd.byCcy) {
      if (Math.abs(leg.bookStandingFcyM) < 0.01) continue;
      expect(leg.strip.length).toBeGreaterThan(0);
      expect(leg.strip.every(l => Number.isFinite(l.netUsdYr))).toBe(true);
    }
    if (pts.some(p => p.k > 1 + 1e-6)) {
      expect(bd.k).toBeGreaterThan(1);
    }
    expect(out.solutionFrontier!.walk).toBe('book-scale');
    expect(pts.every(p => p.k >= -1e-12)).toBe(true);
    const originX = pts[0]!.portfolioVarUsd;
    const xy = plotStandingCarryArm(pts).map(p => ({
      x: p.portfolioVarUsd,
      y: p.totalCarryUsdYr,
    }));
    const plot = chartPathTrace(pts, originX, true);
    const stroke = chartFrontierStroke(xy, originX, true);
    expect(chartFrontierStroke).toBe(chartOpenPath);
    expect(stroke).toEqual(chartOpenPath(xy, originX, true));
    expect(plot.drawn).toEqual(stroke.slice(0, plot.drawn.length));
    expect(plot.pinApplied).toBe(true);
    expect(plot.drawn[0]!.y).toBeCloseTo(0, 8);
    expect(plot.drawn[0]!.x).toBeCloseTo(originX, 5);
    expect(pts[0]!.k).toBeCloseTo(0, 8);
    const solHold = pts.find(p => Math.abs(p.k - 1) < 1e-6);
    expect(solHold).toBeTruthy();
    expect(Number.isFinite(solHold!.totalCarryUsdYr)).toBe(true);
    expect(Number.isFinite(solHold!.portfolioVarUsd)).toBe(true);
    const uniHold = out.universeFrontier?.points.find(p => Math.abs(p.k - 1) < 1e-6);
    if (uniHold && solHold) {
      // No overlay lift — the k = 1 point is the raw book arm.
      expect(solHold.portfolioVarUsd).toBeCloseTo(uniHold.portfolioVarUsd, 5);
      expect(solHold.totalCarryUsdYr).toBeCloseTo(uniHold.totalCarryUsdYr, 5);
    }
    const mid = pts.find(p => p.k > 0.2 && p.k < 0.8);
    if (mid && solHold) {
      expect(Number.isFinite(mid.totalCarryUsdYr)).toBe(true);
      expect(mid.totalCarryUsdYr).toBeLessThanOrEqual(solHold.totalCarryUsdYr + 1e-6);
    }
    const bal = pricedBalancedVertex(pts, originX);
    expect(bal).toBeTruthy();
    expect(pts.some(p => (
      Math.abs(p.k - bal!.k) < 1e-9
      && Math.abs(p.portfolioVarUsd - bal!.portfolioVarUsd) < 1e-8
      && Math.abs(p.totalCarryUsdYr - bal!.totalCarryUsdYr) < 1e-8
    ))).toBe(true);
    expect(Math.abs(bal!.totalCarryUsdYr) > 1e-9).toBe(true);
    const stats = frontierMonotoneStats(pts);
    expect(stats.yDips).toBe(0);
    expect(stats.xBacktracks).toBe(0);
    expect(stroke.length).toBeGreaterThan(0);
    expect(stroke[0]!.y).toBeCloseTo(0, 8);
    expect(pts[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(plot.rawHead[0]?.y ?? pts[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    if (stroke.length > 1) {
      expect(stroke[1]!.y).toBeLessThan(0.12);
    }
  });

  it('Fill Ask = both: funding programme unscaled (k = 1), overlay covers the rest of the ask', () => {
    const parsed = parseEfficientFrontierRequest(eurGbpFrontierBody({
      askFillMode: 'both',
      scenarioId: 'carryTarget',
      carryTargetUsdYr: 0.6,
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    const bd = out.carryBreakdown!;
    expect(bd.askFillMode).toBe('both');
    // Programme fixed at its own size — not scaled to the ask.
    expect(bd.k).toBeCloseTo(1, 8);
    expect(bd.totalSum).toBeCloseTo(bd.bookSum + bd.overlaySum, 8);
    // Total reaches at least the ask — the overlay tops up the programme carry
    // (and stays at 0 when the programme already over-earns).
    expect(bd.totalSum).toBeGreaterThanOrEqual(0.6 - 5e-3);
    expect(bd.overlaySum).toBeGreaterThanOrEqual(-1e-9);
    // Per-CCY book carry = Σ that CCY's operating strip legs — the strip the
    // client renders sums to the header.
    for (const leg of bd.byCcy) {
      const stripInt = leg.strip.reduce((s, l) => s + l.interestUsdYr, 0);
      expect(stripInt, `${leg.ccy} Σ strip interest`).toBeCloseTo(leg.bookUsdYrM, 4);
    }
  });

  it('Fill Ask = overlay sits on the walk peak when Ask is off the arm', () => {
    const parsed = parseEfficientFrontierRequest(eurGbpFrontierBody({
      carryTargetUsdYr: 999,
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    const bd = out.carryBreakdown!;
    const peak = out.solutionFrontier!.points.reduce((best, p) => (
      p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
    ));
    expect(bd.askFillMode).toBe('overlay');
    expect(out.solutionFrontier!.walk).toBe('overlay');
    expect(bd.k).toBeCloseTo(0, 5);
    expect(bd.overlayT).toBeGreaterThan(1);
    expect(bd.totalSum).toBeCloseTo(bd.bookSum + bd.overlaySum, 8);
    expect(bd.chartY).toBeCloseTo(bd.overlaySum, 5);
    expect(bd.chartY).toBeCloseTo(peak.totalCarryUsdYr, 3);
    expect(bd.chartY).toBeLessThan(999);
    expect(out.solutionFrontier!.points.length).toBeGreaterThan(10);
  });

  it('ccySetpointFromBreakdown prints overlay CFaR · overlay carry (not local H*)', () => {
    const sp = ccySetpointFromBreakdown({
      scenarioId: 'carryTarget',
      k: 0,
      overlayT: 7.4,
      askFillMode: 'overlay',
      chartY: 1.599,
      askY: 1.599,
      bookSum: 0,
      overlaySum: 1.599,
      totalSum: 1.599,
      bookCfarSum: 1.085,
      overlayCfarSum: 13.5,
      totalCfarSum: 13.5,
      chartX: 13.5,
      byCcy: [{
        ccy: 'EUR',
        bookUsdYrM: 0,
        overlayUsdYrM: 1.599,
        totalUsdYrM: 1.599,
        overlayUsdM: -123.5,
        overlayFcyM: -105.51,
        mixWeight: -0.95,
        bookStandingFcyM: 0,
        bookStandingUsdM: 0,
        bookSignedCashUsdYrM: 0,
        bookCfarUsdM: 0.545,
        overlayCfarUsdM: 15,
        totalCfarUsdM: 15,
      }],
    }, 'EUR');
    expect(sp).not.toBeNull();
    expect(sp!.cfarUsdM).toBeCloseTo(15, 8);
    expect(sp!.carryUsdYrM).toBeCloseTo(1.599, 8);
    expect(sp!.bookStandingFcyM).toBe(0);
    expect(sp!.bookStandingUsdM).toBe(0);
    expect(walkStandingFromSetpoints(68.49, { carryTarget: sp! }, 'carryTarget')).toBe(0);
    expect(walkStandingFromSetpoints(68.49, { carryTarget: sp! }, 'balanced')).toBe(0);
    const un = ccySetpointFromBreakdown({
      scenarioId: 'unhedged',
      k: 0,
      overlayT: 0,
      askFillMode: 'overlay',
      chartY: 0,
      askY: 1.599,
      bookSum: 0,
      overlaySum: 0,
      totalSum: 0,
      bookCfarSum: 1.085,
      overlayCfarSum: 0,
      totalCfarSum: 1.085,
      chartX: 0,
      byCcy: [{
        ccy: 'EUR',
        bookUsdYrM: 0,
        overlayUsdYrM: 0,
        totalUsdYrM: 0,
        overlayUsdM: 0,
        overlayFcyM: 0,
        mixWeight: 0,
        bookStandingFcyM: 0,
        bookStandingUsdM: 0,
        bookSignedCashUsdYrM: 0,
        bookCfarUsdM: 0.545,
        overlayCfarUsdM: 0,
        totalCfarUsdM: 0.545,
      }],
    }, 'EUR');
    expect(un!.cfarUsdM).toBeCloseTo(0.545, 8);
    expect(un!.carryUsdYrM).toBeCloseTo(0, 8);
  });

  it('swap-fill setpoint keeps Book S so the CCY walk reaches the table', () => {
    const sp = ccySetpointFromBreakdown({
      scenarioId: 'carryTarget',
      k: 2.4,
      overlayT: 1,
      askFillMode: 'swap',
      chartY: 1.599,
      askY: 1.599,
      bookSum: 1.378,
      overlaySum: 0.221,
      totalSum: 1.599,
      bookCfarSum: 9.8,
      overlayCfarSum: 0.564,
      totalCfarSum: 9.8,
      chartX: 9.8,
      byCcy: [{
        ccy: 'EUR',
        bookUsdYrM: 1.378,
        overlayUsdYrM: 0.221,
        totalUsdYrM: 1.599,
        overlayUsdM: -17.1,
        overlayFcyM: -14.61,
        mixWeight: -1,
        bookStandingFcyM: 68.49,
        bookStandingUsdM: 80.1,
        bookSignedCashUsdYrM: 1.378,
        bookCfarUsdM: 9.8,
        overlayCfarUsdM: 0.564,
        totalCfarUsdM: 9.8,
      }],
    }, 'EUR');
    expect(sp!.cfarUsdM).toBeCloseTo(9.8, 8);
    expect(sp!.carryUsdYrM).toBeCloseTo(1.599, 8);
    expect(sp!.bookStandingFcyM).toBeCloseTo(68.49, 5);
    expect(walkStandingFromSetpoints(12, { carryTarget: sp! }, 'carryTarget'))
      .toBeCloseTo(68.49, 5);
    expect(walkStandingFromSetpoints(12, { carryTarget: sp! }, 'balanced'))
      .toBeCloseTo(68.49, 5);
    expect(sp!.bookStandingUsdM).toBeCloseTo(80.1, 5);
  });

  it('both-fill EUR ticket is Total CFaR / Total carry, with Book S FCY and Book $ USD', () => {
    const sp = ccySetpointFromBreakdown({
      scenarioId: 'carryTarget',
      k: 2.4,
      overlayT: 1,
      askFillMode: 'both',
      chartY: 2.3,
      askY: 2.3,
      bookSum: 1.6,
      overlaySum: 0.716,
      totalSum: 2.316,
      bookCfarSum: 9.1,
      overlayCfarSum: 1.8,
      totalCfarSum: 8.7,
      chartX: 8.7,
      byCcy: [{
        ccy: 'EUR',
        bookUsdYrM: 1.6,
        overlayUsdYrM: 0.716,
        totalUsdYrM: 2.316,
        overlayUsdM: -55.5,
        overlayFcyM: -47.43,
        mixWeight: -0.98,
        bookStandingFcyM: 79.36,
        bookStandingUsdM: 92.9,
        bookSignedCashUsdYrM: 1.6,
        bookCfarUsdM: 9.1,
        overlayCfarUsdM: 1.8,
        totalCfarUsdM: 8.7,
      }],
    }, 'EUR');
    expect(sp!.cfarUsdM).toBeCloseTo(8.7, 8);
    expect(sp!.carryUsdYrM).toBeCloseTo(2.316, 8);
    expect(sp!.bookUsdYrM).toBeCloseTo(1.6, 8);
    expect(sp!.overlayUsdYrM).toBeCloseTo(0.716, 8);
    expect(sp!.bookStandingFcyM).toBeCloseTo(79.36, 5);
    expect(sp!.bookStandingUsdM).toBeCloseTo(92.9, 5);
    expect(sp!.cfarUsdM).not.toBeCloseTo(9.1, 2);
    expect(sp!.carryUsdYrM).not.toBeCloseTo(1.6, 2);
  });

  it('publishes per-CCY setpoints for every named portfolio scenario', () => {
    const parsed = parseEfficientFrontierRequest(eurGbpFrontierBody({
      askFillMode: 'overlay',
      scenarioId: 'carryTarget',
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    expect(out.scenarioBreakdowns.unhedged).toBeTruthy();
    expect(out.scenarioBreakdowns.carryTarget).toBeTruthy();
    expect(out.scenarioBreakdowns.balanced).toBeTruthy();
    expect(out.carryBreakdown).toBe(out.scenarioBreakdowns.carryTarget);
    const ct = out.scenarioBreakdowns.carryTarget!;
    const un = out.scenarioBreakdowns.unhedged!;
    const eurCt = ccySetpointFromBreakdown(ct, 'EUR');
    const eurUn = ccySetpointFromBreakdown(un, 'EUR');
    expect(eurUn).not.toBeNull();
    expect(eurCt).not.toBeNull();
    expect(eurUn!.carryUsdYrM).toBeCloseTo(0, 5);
    expect(eurUn!.cfarUsdM).toBeGreaterThan(0);
    expect(eurCt!.carryUsdYrM).toBeCloseTo(
      ct.byCcy.find(r => r.ccy === 'EUR')!.overlayUsdYrM, 8,
    );
    expect(Math.abs(eurCt!.carryUsdYrM)).toBeGreaterThan(Math.abs(eurUn!.carryUsdYrM) + 1e-6);
    const setpoints = ccySetpointsByScenario(out.scenarioBreakdowns, 'EUR');
    expect(setpoints.carryTarget!.cfarUsdM).toBeCloseTo(eurCt!.cfarUsdM, 8);
    expect(setpoints.carryTarget!.carryUsdYrM).not.toBeCloseTo(eurUn!.carryUsdYrM, 3);
  });

  it('Balanced table Total stays Buffer + Overlay', () => {
    const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR');
    const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP');
    if (!eur || !gbp) throw new Error('INITIAL_ROWS missing EUR/GBP');
    const parsed = parseEfficientFrontierRequest(validBody({
      strategyInput: {
        rows: [eur, gbp],
        months: 3,
        shared: { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 3 },
        activeLayers: ['floorH', 'sigmaP', 'portfolioDiv', 'carryOptim'],
      },
      tabNetByCcyUsd: { EUR: 2.1, GBP: 1.4 },
      scenarioId: 'balanced',
      askFillMode: 'both',
      carryTargetUsdYr: 1,
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    const out = computeEfficientFrontier(parsed.request, { log: false });
    const bd = out.carryBreakdown!;
    expect(bd.scenarioId).toBe('balanced');
    // Table stays internally consistent: Total = Book + Overlay per row and Σ.
    expect(bd.totalSum).toBeCloseTo(bd.bookSum + bd.overlaySum, 8);
    for (const leg of bd.byCcy) {
      expect(leg.totalUsdYrM).toBeCloseTo(leg.bookUsdYrM + leg.overlayUsdYrM, 8);
    }
  });

  it('strip-table data is 100% on carryBreakdown — client renders, does not recompute', () => {
    const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR');
    const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP');
    if (!eur || !gbp) throw new Error('INITIAL_ROWS missing EUR/GBP');
    for (const askFillMode of ['swap', 'both', 'overlay'] as const) {
      const parsed = parseEfficientFrontierRequest(eurGbpFrontierBody({
        askFillMode,
        scenarioId: 'carryTarget',
        carryTargetUsdYr: 0.6,
      }));
      if ('error' in parsed) throw new Error(parsed.error);
      const out = computeEfficientFrontier(parsed.request, { log: false });
      const bd = out.carryBreakdown;
      expect(bd, askFillMode).not.toBeNull();
      if (!bd) continue;

      // Header/right-hand summary cells.
      for (const f of [
        'chartX', 'chartY', 'askY', 'bookSum', 'overlaySum', 'totalSum',
        'bookCfarSum', 'overlayCfarSum', 'totalCfarSum', 'k', 'overlayT',
      ] as const) {
        expect(Number.isFinite(bd[f]), `${askFillMode}.${f}`).toBe(true);
      }
      expect(bd.totalSum).toBeCloseTo(bd.bookSum + bd.overlaySum, 6);

      // Per-CCY row + nested strip.
      let bookSum = 0;
      let overlaySum = 0;
      for (const leg of bd.byCcy) {
        for (const f of [
          'bookUsdYrM', 'overlayUsdYrM', 'totalUsdYrM', 'overlayUsdM',
          'overlayFcyM', 'mixWeight', 'bookStandingFcyM', 'bookStandingUsdM',
          'bookSignedCashUsdYrM', 'bookCfarUsdM', 'overlayCfarUsdM', 'totalCfarUsdM',
        ] as const) {
          expect(Number.isFinite(leg[f]), `${askFillMode}.${leg.ccy}.${f}`).toBe(true);
        }
        expect(leg.totalUsdYrM).toBeCloseTo(leg.bookUsdYrM + leg.overlayUsdYrM, 6);
        expect(Array.isArray(leg.strip), `${askFillMode}.${leg.ccy}.strip`).toBe(true);
        for (const l of leg.strip) {
          for (const f of [
            'newLeg', 'outstanding', 'settleMonths', 'valueDateMonths',
            'interestUsdYr', 'pointsUsdYr', 'netUsdYr',
          ] as const) {
            expect(Number.isFinite(l[f] as number), `${askFillMode}.${leg.ccy}.leg.${f}`).toBe(true);
          }
        }
        bookSum += leg.bookUsdYrM;
        overlaySum += leg.overlayUsdYrM;
      }
      expect(bookSum, `${askFillMode} Σ bookUsdYrM`).toBeCloseTo(bd.bookSum, 6);
      expect(overlaySum, `${askFillMode} Σ overlayUsdYrM`).toBeCloseTo(bd.overlaySum, 6);

      // CFaR columns must SUM to their portfolio totals — per-CCY Book is the
      // diversified share, not standalone.
      const sumBookCfar = bd.byCcy.reduce((s, l) => s + l.bookCfarUsdM, 0);
      const sumOverlayCfar = bd.byCcy.reduce((s, l) => s + l.overlayCfarUsdM, 0);
      const sumTotalCfar = bd.byCcy.reduce((s, l) => s + l.totalCfarUsdM, 0);
      expect(sumBookCfar, `${askFillMode} Σ bookCfarUsdM`).toBeCloseTo(bd.bookCfarSum, 4);
      expect(sumOverlayCfar, `${askFillMode} Σ overlayCfarUsdM`).toBeCloseTo(bd.overlayCfarSum, 4);
      expect(sumTotalCfar, `${askFillMode} Σ totalCfarUsdM`).toBeCloseTo(bd.totalCfarSum, 4);

      // Swap / both fill: Σ the per-leg strip's cash Δr reconstructs the
      // header book carry — the strip the client renders sums to the header.
      if (askFillMode !== 'overlay') {
        for (const leg of bd.byCcy) {
          if (Math.abs(leg.bookStandingFcyM) < 0.01 && leg.strip.length === 0) continue;
          expect(leg.strip.length, `${askFillMode}.${leg.ccy} strip`).toBeGreaterThan(0);
          const stripInt = leg.strip.reduce((s, l) => s + l.interestUsdYr, 0);
          expect(stripInt, `${askFillMode}.${leg.ccy} Σ strip interest`)
            .toBeCloseTo(leg.bookUsdYrM, 4);
        }
      }

      // Carry Target: swap / overlay land the deliverable total ON the ask;
      // both lands there unless the funding programme already over-earns it.
      if (askFillMode === 'swap' || askFillMode === 'overlay') {
        expect(bd.totalSum, `${askFillMode} total vs ask`).toBeCloseTo(bd.askY, 3);
      } else {
        expect(bd.totalSum).toBeGreaterThanOrEqual(bd.askY - 5e-3);
      }
    }
  });

  it('logs the per-CCY strip vs plot breakdown without throwing', () => {
    const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR');
    const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP');
    if (!eur || !gbp) throw new Error('INITIAL_ROWS missing EUR/GBP');
    const parsed = parseEfficientFrontierRequest(validBody({
      strategyInput: {
        rows: [eur, gbp],
        months: 3,
        shared: { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 3 },
        activeLayers: ['floorH', 'sigmaP', 'portfolioDiv', 'carryOptim'],
      },
      tabNetByCcyUsd: { EUR: 2.1, GBP: 1.4 },
      scenarioId: 'carryTarget',
      carryTargetUsdYr: 1,
    }));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(() => computeEfficientFrontier(parsed.request, { log: true })).not.toThrow();
  });
});
