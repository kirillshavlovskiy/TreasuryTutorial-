import { describe, it, expect } from 'vitest';
import {
  ccySpotRate,
  fundingSwapOverlayUsdYr,
  INITIAL_ROWS,
  toggleLayerGroup,
  type LayerId,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import {
  emptyMarketRatesForCcy,
} from '@/lib/fx-market-rates';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import {
  buildLiquidityLadder,
  cycleCarrySplit,
  DEFAULT_LIQUIDITY_TIMING,
  type LiquidityTiming,
} from '@/lib/liquidity-ladder';
import {
  evaluateLiquidityStrategies,
  liveLiquidityCostUsdYrM,
  livePlanByCcyFrom,
  resolveBufferConstraint,
  bufferConstraintDetail,
  cfarExpectedLossWeight,
  cfarTailProbability,
  certainCarryAtResidualUsdM,
  expectedCfarLossUsdM,
  hedgeableCfarUsdM,
  probabilityWeightedReturnUsdM,
  weightedReturnByResidualDelta,
  strategyBookCarryK,
  strategyForRegime,
  swapLegScheduleWithCarry,
  usdMToCarryK,
  LIQUIDITY_STRATEGIES,
  type LiquidityStrategyId,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import {
  fxHedgeMcCfarByCcy,
  fxOnlyNetByCcyUsdM,
  sumNetCfarUsdM,
} from '@/lib/test-mode/cfar-net-by-ccy';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';

const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP')!;

/** GBP that drains every cycle: opens 20, pays out 90, collects 60. */
function row(over: Partial<RowState> = {}): RowState {
  return {
    ...gbp,
    cash: 20,
    payout: -90,
    collections: 60,
    fcastFX: 0,
    cash_floor: 0,
    ...over,
  };
}

function profileWith(timing: Partial<LiquidityTiming> = {}): ForecastProfileState {
  return {
    ...DEFAULT_FORECAST_PROFILE,
    liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: true, ...timing },
  };
}

const shared: SharedGlobals = { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 3 };

function evaluate(
  rows: readonly RowState[],
  months = 3,
  profile: ForecastProfileState = profileWith(),
): LiquidityStrategyResult[] {
  return evaluateLiquidityStrategies({ rows, forecastProfile: profile, months, shared });
}

function pick(
  results: readonly LiquidityStrategyResult[],
  id: LiquidityStrategyId,
): LiquidityStrategyResult {
  return results.find(r => r.strategy.id === id)!;
}

describe('evaluateLiquidityStrategies — shape', () => {
  it('returns one result per declared strategy, in declaration order', () => {
    const results = evaluate([row()]);
    expect(results.map(r => r.strategy.id)).toEqual(
      LIQUIDITY_STRATEGIES.map(s => s.id),
    );
  });

  it('has nothing to compare without a forecast period', () => {
    expect(evaluate([row()], 0)).toEqual([]);
  });

  it('skips USD — it is the funding side of the swap, not a book to cover', () => {
    const usd = row({ id: 'usd', ccy: 'USD' });
    expect(evaluate([usd])).toEqual([]);
    expect(evaluate([row(), usd])[0]!.byCcy.map(c => c.ccy)).toEqual(['GBP']);
  });
});

describe('the unfunded baseline', () => {
  const results = evaluate([row()]);
  const unfunded = pick(results, 'unfunded');

  it('books nothing at all', () => {
    expect(unfunded.committedTodayUsdM).toBe(0);
    expect(unfunded.bookNowUsdM).toBe(0);
    expect(unfunded.peakBookUsdM).toBe(0);
    expect(unfunded.marketTrips).toBe(0);
    expect(unfunded.usdGiveUpUsdYrM).toBe(0);
  });

  it('still prices the unfunded path — overdraft days sit in Cash Carry', () => {
    expect(unfunded.odPaidUsdYrM).toBeGreaterThan(0);
    expect(unfunded.swapCarryUsdYrM).toBeCloseTo(0, 9);
    expect(unfunded.netCostUsdYrM).toBeCloseTo(-unfunded.cashCarryUsdYrM, 9);
  });

  it('reports the requirement it leaves open, not zero', () => {
    // H* does not go away because nothing funds it.
    expect(unfunded.gapToThresholdUsdM).toBeLessThan(0);
    expect(unfunded.floorBreaches).toBeGreaterThan(0);
  });
});

describe('funded programmes cover the path the baseline leaves open', () => {
  const results = evaluate([row()]);
  const unfunded = pick(results, 'unfunded');
  const funded = ['nearCycle', 'rollingProgramme', 'termSwap'] as const;

  it.each(funded)('%s books a near leg and lifts the trough', id => {
    const r = pick(results, id);
    expect(r.bookNowUsdM).toBeGreaterThan(0);
    expect(r.peakBookUsdM).toBeGreaterThan(0);
    expect(r.byCcy[0]!.trough).toBeGreaterThan(unfunded.byCcy[0]!.trough);
  });

  it.each(funded)('%s clears H* on every cycle', id => {
    expect(pick(results, id).gapToThresholdUsdM).toBeCloseTo(0, 6);
  });

  it.each(funded)('%s trades the overdraft for a USD give-up', id => {
    const r = pick(results, id);
    expect(r.odPaidUsdYrM).toBeLessThan(unfunded.odPaidUsdYrM);
    expect(r.usdGiveUpUsdYrM).toBeGreaterThan(0);
  });
});

describe('the two rolling programmes differ in market risk, not in notional', () => {
  const results = evaluate([row()]);
  const near = pick(results, 'nearCycle');
  const strip = pick(results, 'rollingProgramme');

  it('books identical legs, so identical carry', () => {
    expect(strip.peakBookUsdM).toBeCloseTo(near.peakBookUsdM, 10);
    expect(strip.netCostUsdYrM).toBeCloseTo(near.netCostUsdYrM, 10);
  });

  it('near-cycle returns to market every cycle; the strip is priced in one trip', () => {
    expect(near.marketTrips).toBeGreaterThan(1);
    expect(strip.marketTrips).toBe(1);
  });

  it('near-cycle commits only the spot leg today; the strip commits the whole book', () => {
    expect(near.committedTodayUsdM).toBeCloseTo(near.bookNowUsdM, 10);
    expect(strip.committedTodayUsdM).toBeGreaterThan(near.committedTodayUsdM);
  });
});

describe('the term swap commits its cover up front', () => {
  const results = evaluate([row()]);
  const term = pick(results, 'termSwap');
  const strip = pick(results, 'rollingProgramme');

  it('is a single trade whose book never grows', () => {
    expect(term.marketTrips).toBe(1);
    expect(term.byCcy[0]!.schedule).toHaveLength(1);
    expect(term.peakBookUsdM).toBeCloseTo(term.bookNowUsdM, 10);
  });

  it('carries the deepest cycle from day one, so it holds more than the strip peaks at on average', () => {
    expect(term.byCcy[0]!.avgBook).toBeGreaterThan(strip.byCcy[0]!.avgBook);
  });

  it('wires a PAY term near into Book now — does not floor the short at 0', () => {
    const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
    const pay = {
      ...eur,
      cash: 40,
      payout: -2,
      collections: 2,
      cash_floor: 0,
      carry_target: -15,
      fcastFX: 0,
      nonLpCash: 0,
    };
    const termPay = pick(
      evaluateLiquidityStrategies({
        rows: [pay],
        forecastProfile: profileWith(),
        months: 6,
        shared,
        activeLayers: new Set(['carryOptim']),
      }),
      'termSwap',
    ).byCcy[0]!;
    expect(termPay.bookNow).toBeLessThan(-0.5);
    expect(termPay.schedule).toHaveLength(1);
    expect(termPay.peakBook).toBeCloseTo(termPay.bookNow, 6);
  });

  it('EUR Book CIP still reads the bundled EURUSD curve when the map has an empty EUR shell', () => {
    const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
    const pay = {
      ...eur,
      cash: 40,
      payout: -2,
      collections: 2,
      cash_floor: 0,
      carry_target: -15,
      fcastFX: 0,
      nonLpCash: 0,
    };
    const input = {
      rows: [pay],
      forecastProfile: profileWith(),
      months: 6,
      shared,
      activeLayers: new Set<LayerId>(['carryOptim']),
    };
    const seeded = pick(
      evaluateLiquidityStrategies(input),
      'termSwap',
    ).byCcy[0]!;
    const shadowed = pick(
      evaluateLiquidityStrategies({
        ...input,
        marketRatesByCcy: { EUR: emptyMarketRatesForCcy('EUR') },
      }),
      'termSwap',
    ).byCcy[0]!;
    expect(Math.abs(seeded.swapPointsUsdYrM)).toBeGreaterThan(0.001);
    expect(shadowed.swapPointsUsdYrM).toBeCloseTo(seeded.swapPointsUsdYrM, 6);
    expect(shadowed.schedule.some(l => l.midPoints != null)).toBe(true);
  });
});

describe('the interest ledger adds up', () => {
  it('net cost = −(Cash + Hedge + Swap cash + CIP), on every strategy', () => {
    for (const r of evaluate([row()])) {
      expect(r.netCostUsdYrM).toBeCloseTo(
        -(
          r.cashCarryUsdYrM
          + r.hedgeCarryUsdYrM
          + r.swapInterestUsdYrM
          + r.swapPointsUsdYrM
        ),
        6,
      );
    }
    expect(pick(evaluate([row()]), 'unfunded').swapCarryUsdYrM).toBeCloseTo(0, 9);
  });

  it('displayed $k total is Cash + FWD + Swap cash + CIP, currency by currency', () => {
    const results = evaluate([row()]);
    for (const r of results) {
      const book = strategyBookCarryK(r.byCcy);
      expect(book.total).toBe(book.cash + book.hedge + book.swap + book.cip);
      const fromRows = r.byCcy.reduce((s, c) => (
        s
        + usdMToCarryK(c.cashCarryUsdYrM)
        + usdMToCarryK(c.hedgeCarryUsdYrM)
        + usdMToCarryK(c.swapInterestUsdYrM)
        + usdMToCarryK(c.swapPointsUsdYrM)
      ), 0);
      expect(book.total).toBe(fromRows);
    }
  });

  it('Cash Carry is the unfunded path — identical on every strategy', () => {
    const results = evaluate([row()]);
    const cash = pick(results, 'unfunded').cashCarryUsdYrM;
    for (const r of results) {
      expect(r.cashCarryUsdYrM).toBeCloseTo(cash, 9);
    }
  });

  it('Cash Carry is the desk cycle-1 LP NIM, not a horizon average', () => {
    const r = row();
    const profile = profileWith();
    const ladder = buildLiquidityLadder(r, profile, {
      months: 3,
      opening: r.cash,
      floor: r.cash_floor,
    });
    const split = cycleCarrySplit(ladder, 0);
    const expected =
      (split.avgCredit * (r.r_FCY - shared.r_USD)
        + split.avgDebit * (r.r_OD - shared.r_USD)) / 100 * ccySpotRate(r.ccy);
    expect(pick(evaluate([r]), 'unfunded').cashCarryUsdYrM).toBeCloseTo(expected, 8);
  });

  it('uses the desk Cash Carry map when the P&L already priced the book', () => {
    const results = evaluateLiquidityStrategies({
      rows: [row()],
      forecastProfile: profileWith(),
      months: 3,
      shared,
      deskCashCarryByCcyUsdM: { GBP: 0.042 },
    });
    for (const r of results) {
      expect(r.cashCarryUsdYrM).toBeCloseTo(0.042, 9);
    }
  });

  it('desk Hedge Cash sits in Total carry — same on every strategy', () => {
    const results = evaluateLiquidityStrategies({
      rows: [row()],
      forecastProfile: profileWith(),
      months: 3,
      shared,
      deskCashCarryByCcyUsdM: { GBP: 0.297 },
      deskHedgeCarryByCcyUsdM: { GBP: 0.245 },
    });
    for (const r of results) {
      expect(r.cashCarryUsdYrM).toBeCloseTo(0.297, 9);
      expect(r.hedgeCarryUsdYrM).toBeCloseTo(0.245, 9);
      const book = strategyBookCarryK(r.byCcy);
      expect(book.cash + book.hedge).toBe(
        usdMToCarryK(0.297) + usdMToCarryK(0.245),
      );
      expect(r.netCostUsdYrM).toBeCloseTo(
        -(
          r.cashCarryUsdYrM
          + r.hedgeCarryUsdYrM
          + r.swapInterestUsdYrM
          + r.swapPointsUsdYrM
        ),
        6,
      );
    }
  });

  it('live CIP is the desk CIP column, counterfactuals keep their own points', () => {
    const plan = Array.from({ length: 3 }, (_, i) => ({
      cycleIndex: i,
      opening_cash: 0,
      payout: 0,
      collections: 0,
      invoiceFcast: 0,
      hedgeSettle: 0,
      forecasted_cash: 0,
      drawdown: 0,
      cash_threshold: 0,
      swap_needed: 6,
      incremental_swap: 0,
      standing_swap: 6,
      post_swap_cash: 0,
      cycle_end_cash: 0,
    }));
    const results = evaluateLiquidityStrategies({
      rows: [row()],
      forecastProfile: profileWith({ sizingBasis: 'horizon', bookingMode: 'rolling' }),
      months: 3,
      shared,
      livePlanByCcy: { GBP: plan as never },
      deskCipByCcyUsdM: { GBP: -0.42 },
    });
    const live = pick(results, 'rollingProgramme');
    expect(live.byCcy[0]!.swapPointsUsdYrM).toBeCloseTo(-0.42, 8);
    expect(pick(results, 'termSwap').byCcy[0]!.swapPointsUsdYrM).not.toBeCloseTo(-0.42, 4);
  });

  it('totals are the per-currency figures summed, converted at spot', () => {
    const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
    const results = evaluate([row(), { ...eur, cash: 10, payout: -50, collections: 30 }]);
    for (const r of results) {
      expect(r.byCcy).toHaveLength(2);
      expect(r.netCostUsdYrM).toBeCloseTo(
        r.byCcy.reduce((s, c) => s + c.netCostUsdYrM, 0),
        6,
      );
      expect(r.peakBookUsdM).toBeCloseTo(
        r.byCcy.reduce((s, c) => s + c.peakBook * c.spot, 0),
        6,
      );
    }
  });

  it('a book that never goes negative pays no overdraft and needs no swap', () => {
    const flush = row({ cash: 500, payout: -10, collections: 10 });
    const results = evaluate([flush]);
    for (const r of results) {
      expect(r.odPaidUsdYrM).toBeCloseTo(0, 10);
      expect(r.fcyEarnedUsdYrM).toBeGreaterThan(0);
    }
    expect(pick(results, 'unfunded').floorBreaches).toBe(0);
  });
});

describe('swapLegScheduleWithCarry', () => {
  it('prices each cycle on the standing book — same basis as Swap cash / CIP', () => {
    const rows = swapLegScheduleWithCarry(
      [
        { cycleIndex: 0, valueDateMonths: 0, newLeg: -2.5, rolledForward: 0, outstanding: -2.5, preBookable: false },
        { cycleIndex: 1, valueDateMonths: 1, newLeg: -1.4, rolledForward: -2.5, outstanding: -3.9, preBookable: true },
      ],
      1.26,
      4.31,
      3.5,
    );
    const first = fundingSwapOverlayUsdYr(-2.5, 1.26, 4.31, 3.5);
    expect(rows[0]!.hasPoints).toBe(true);
    expect(rows[0]!.fcyOnUsdYr).toBeCloseTo(first.fcyOnUsdYr / 12, 12);
    expect(rows[0]!.pointsUsdYr).toBeCloseTo(first.pointsUsdYr / 12, 12);
    expect(rows[0]!.interestUsdYr).toBeCloseTo((first.fcyOnUsdYr + first.usdOnUsdYr) / 12, 12);
    expect(rows[0]!.netUsdYr).toBeCloseTo(0, 12);
    expect(rows[1]!.hasPoints).toBe(true);
    expect(rows[1]!.netUsdYr).toBeCloseTo(0, 12);
  });
});

describe('regime summary — constraint and final CFaR', () => {
  it('labels the H* constraint from the desk layers', () => {
    expect(resolveBufferConstraint(new Set(['floorH']))).toBe('balance');
    expect(resolveBufferConstraint(new Set(['carryOptim']))).toBe('carry');
    expect(resolveBufferConstraint(new Set(['cfarCover']))).toBe('balance');
    expect(resolveBufferConstraint(new Set(['sigmaP', 'cfarCover']))).toBe('balance');
    expect(resolveBufferConstraint(new Set(['floorH', 'cfarCover']))).toBe('balance');
    expect(resolveBufferConstraint(new Set(['portfolioDiv']))).toBe('var');
    expect(resolveBufferConstraint(new Set(['carryOptim', 'portfolioDiv']))).toBe('var');
    expect(bufferConstraintDetail(new Set(['sigmaP', 'cfarCover']))).toBe(
      'Forecast accuracy',
    );
    expect(bufferConstraintDetail(new Set(['sigmaP']))).toContain('Forecast accuracy');
    const results = evaluateLiquidityStrategies({
      rows: [row()],
      forecastProfile: profileWith(),
      months: 3,
      shared,
      activeLayers: new Set(['carryOptim']),
    });
    expect(results[0]!.constraint).toBe('carry');
    expect(results[0]!.constraintDetail).toContain('Buffer Carry target');
  });

  it('portfolio level anchors every funded regime to the desk H*', () => {
    const gbp = row({ cash: 20, payout: -90, collections: 40, cash_floor: 5 });
    const profile = profileWith({ sizingBasis: 'horizon', bookingMode: 'rolling' });
    const bare = evaluateLiquidityStrategies({
      rows: [gbp],
      forecastProfile: profile,
      months: 3,
      shared,
      activeLayers: new Set(['floorH']),
    });
    const livePlan = pick(bare, 'rollingProgramme').byCcy[0]!.plan;
    expect(livePlan.length).toBeGreaterThan(0);
    const deskH = 42;
    const deskPlan = livePlan.map(p => ({ ...p, cash_threshold: deskH }));
    const results = evaluateLiquidityStrategies({
      rows: [gbp],
      forecastProfile: profile,
      months: 3,
      shared,
      activeLayers: new Set(['floorH', 'portfolioDiv']),
      livePlanByCcy: { [gbp.ccy]: deskPlan },
    });
    expect(pick(results, 'rollingProgramme').constraint).toBe('var');
    expect(pick(results, 'rollingProgramme').constraintDetail).toContain('Portfolio level');
    expect(pick(results, 'rollingProgramme').byCcy[0]!.plan[0]!.cash_threshold)
      .toBeCloseTo(deskH, 6);

    const nearestH = (plan: readonly { cash_threshold: number }[]) =>
      plan.reduce(
        (best, p) =>
          Math.abs(p.cash_threshold - deskH) < Math.abs(best - deskH)
            ? p.cash_threshold
            : best,
        plan[0]!.cash_threshold,
      );
    expect(nearestH(pick(results, 'termSwap').byCcy[0]!.plan)).toBeCloseTo(deskH, 4);
    expect(nearestH(pick(results, 'nearCycle').byCcy[0]!.plan)).toBeCloseTo(deskH, 4);
    expect(
      Math.abs(nearestH(pick(bare, 'termSwap').byCcy[0]!.plan) - deskH),
    ).toBeGreaterThan(1);
  });

  it('turns payout σ and CFaR cover on or off as one forecast-accuracy limit', () => {
    const active = new Set<LayerId>(['sigmaP']);
    const flip = (id: LayerId) => {
      if (active.has(id)) active.delete(id);
      else active.add(id);
    };
    toggleLayerGroup(['sigmaP', 'cfarCover'], active, flip);
    expect(active.has('sigmaP')).toBe(false);
    expect(active.has('cfarCover')).toBe(false);
    toggleLayerGroup(['sigmaP', 'cfarCover'], active, flip);
    expect(active.has('sigmaP')).toBe(true);
    expect(active.has('cfarCover')).toBe(true);
  });

  it('overdraft Final CFaR is the CFaR-tab FX-only Net — no funding-swap bridge', () => {
    const rows = [row()];
    const forecastProfile = profileWith();
    const setup = { ...DEFAULT_VAR_SETUP, forecastMonths: 3 };
    const unfunded = pick(evaluateLiquidityStrategies({
      rows,
      forecastProfile,
      months: 3,
      shared,
      setup,
      activeLayers: new Set(['floorH', 'sigmaP']),
    }), 'unfunded');
    const fx = fxHedgeMcCfarByCcy({ rows, setup, forecastProfile });
    expect(unfunded.finalCfarUsdM).toBeCloseTo(
      sumNetCfarUsdM(fxOnlyNetByCcyUsdM(fx)),
      8,
    );
    expect(unfunded.byCcy[0]!.plan).toEqual([]);
  });

  it('Overdraft Sum CFaR uses the CFaR-tab map when the desk already computed it', () => {
    const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
    const tab = { EUR: 0.334, GBP: 0.3 };
    const unfunded = pick(evaluateLiquidityStrategies({
      rows: [row({ ...eur, ccy: 'EUR' }), row()],
      forecastProfile: profileWith(),
      months: 3,
      shared,
      setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 3 },
      cfarNetByCcyUsd: tab,
      activeLayers: new Set(['floorH', 'sigmaP']),
    }), 'unfunded');
    expect(unfunded.finalCfarUsdM).toBeCloseTo(0.634, 8);
    expect(unfunded.byCcy.find(c => c.ccy === 'EUR')!.cfarUsdM).toBeCloseTo(0.334, 8);
    expect(unfunded.byCcy.find(c => c.ccy === 'GBP')!.cfarUsdM).toBeCloseTo(0.3, 8);
  });

  it('keeps Default Carry the same and raises Final CFaR when a funding book is on', () => {
    const results = evaluateLiquidityStrategies({
      rows: [row()],
      forecastProfile: profileWith(),
      months: 3,
      shared,
      setup: DEFAULT_VAR_SETUP,
      activeLayers: new Set(['floorH', 'sigmaP']),
    });
    const unfunded = pick(results, 'unfunded');
    const term = pick(results, 'termSwap');
    expect(term.cashCarryUsdYrM).toBeCloseTo(unfunded.cashCarryUsdYrM, 8);
    expect(term.finalCfarUsdM).toBeGreaterThan(unfunded.finalCfarUsdM);
    expect(unfunded.constraint).toBe('balance');
  });
});

describe('probability-weighted return', () => {
  it('maps 90 / 95 / 99% confidence onto a 10 / 5 / 1% CFaR tail', () => {
    expect(cfarTailProbability(90)).toBeCloseTo(0.10);
    expect(cfarTailProbability(95)).toBeCloseTo(0.05);
    expect(cfarTailProbability(99)).toBeCloseTo(0.01);
    expect(cfarExpectedLossWeight(95)).toBeCloseTo(0.05);
  });

  it('is certain carry minus tail × standing CFaR, not a one-sided half-normal', () => {
    expect(probabilityWeightedReturnUsdM(0.297, 0.584, 95)).toBeCloseTo(
      0.297 - 0.584 * 0.05,
    );
    expect(probabilityWeightedReturnUsdM(0.297, 0.584, 90)).toBeCloseTo(
      0.297 - 0.584 * 0.10,
    );
    expect(probabilityWeightedReturnUsdM(0.297, 0.584, 99)).toBeCloseTo(
      0.297 - 0.584 * 0.01,
    );
  });

  it('origin / flattened book: E[return] = carry, not a haircut on residual CFaR', () => {
    expect(hedgeableCfarUsdM(0.359, 0.359)).toBeCloseTo(0);
    expect(expectedCfarLossUsdM(0.359, 95, 0.359)).toBeCloseTo(0);
    expect(probabilityWeightedReturnUsdM(0, 0.359, 95, 0.359)).toBeCloseTo(0);
    expect(probabilityWeightedReturnUsdM(0.040, 0.359, 95, 0.359)).toBeCloseTo(0.040);
  });

  it('charges the tail only on standing CFaR orthogonal to the section floor', () => {
    const section = 0.359;
    const total = 0.412;
    const standing = Math.sqrt(total * total - section * section);
    expect(hedgeableCfarUsdM(total, section)).toBeCloseTo(standing);
    expect(probabilityWeightedReturnUsdM(0.040, total, 95, section)).toBeCloseTo(
      0.040 - standing * 0.05,
    );
  });

  it('does not flip the open arm — tail haircut stays below cash carry at book scale', () => {
    const origin = 0.359;
    const openCfar = 0.90;
    const cashCarry = 0.109;
    const standing = Math.sqrt(openCfar * openCfar - origin * origin);
    const e = probabilityWeightedReturnUsdM(cashCarry, openCfar, 95, origin);
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(cashCarry);
    expect(e).toBeCloseTo(cashCarry - standing * 0.05);
  });

  it('stamps per-currency CFaR onto each strategy row', () => {
    const results = evaluateLiquidityStrategies({
      rows: [row()],
      forecastProfile: profileWith(),
      months: 3,
      shared,
      setup: DEFAULT_VAR_SETUP,
      activeLayers: new Set(['floorH', 'sigmaP']),
    });
    const term = pick(results, 'termSwap');
    expect(term.byCcy[0]!.cfarUsdM).toBeCloseTo(term.finalCfarUsdM, 8);
    const book = strategyBookCarryK(term.byCcy);
    expect(
      probabilityWeightedReturnUsdM(
        book.total / 1000,
        term.finalCfarUsdM,
        95,
      ),
    ).toBeCloseTo(book.total / 1000 - expectedCfarLossUsdM(term.finalCfarUsdM, 95));
  });

  it('certain carry keeps cash + swap at Δ=1 and adds full CIP at Δ=0', () => {
    const c = {
      cashCarryUsdYrM: 0.297,
      hedgeCarryUsdYrM: 0.245,
      swapInterestUsdYrM: -0.043,
      cipFullUsdYrM: 0.042,
    };
    expect(certainCarryAtResidualUsdM(c, 0)).toBeCloseTo(
      (usdMToCarryK(0.297) + usdMToCarryK(0.245) + usdMToCarryK(-0.043) + usdMToCarryK(0.042)) / 1000,
    );
    expect(certainCarryAtResidualUsdM(c, 1)).toBeCloseTo(
      (usdMToCarryK(0.297) + usdMToCarryK(0.245) + usdMToCarryK(-0.043)) / 1000,
    );
  });

  it('prices Δ=0 hedged and Δ=1 open on the same programme', () => {
    const input = {
      rows: [row()],
      forecastProfile: profileWith(),
      months: 3,
      shared,
      activeLayers: new Set<LayerId>(['floorH', 'sigmaP']),
    };
    const term = pick(evaluateLiquidityStrategies(input), 'termSwap');
    const pair = weightedReturnByResidualDelta(term, input, 95);
    expect(pair.hedged.delta).toBe(0);
    expect(pair.open.delta).toBe(1);
    expect(pair.hedged.carryUsdM).toBeCloseTo(
      term.byCcy.reduce((s, c) => s + certainCarryAtResidualUsdM(c, 0), 0),
    );
    expect(pair.open.carryUsdM).toBeCloseTo(
      term.byCcy.reduce((s, c) => s + certainCarryAtResidualUsdM(c, 1), 0),
    );
    expect(pair.hedged.carryUsdM).toBeGreaterThanOrEqual(pair.open.carryUsdM - 1e-9);
    expect(pair.hedged.cfarUsdM).toBeCloseTo(pair.open.cfarUsdM);
    expect(pair.hedged.weightedUsdM).toBeCloseTo(pair.hedged.carryUsdM);
    expect(pair.open.weightedUsdM).toBeCloseTo(
      pair.open.carryUsdM
        - expectedCfarLossUsdM(pair.open.cfarUsdM, 95, pair.hedged.cfarUsdM),
    );
  });
});

describe('strategyForRegime', () => {
  it('maps the persisted regime back onto a strategy', () => {
    expect(strategyForRegime('cycle', 'rolling').id).toBe('nearCycle');
    expect(strategyForRegime('horizon', 'rolling').id).toBe('rollingProgramme');
    expect(strategyForRegime('cycle', 'term').id).toBe('termSwap');
    expect(strategyForRegime('horizon', 'term').id).toBe('termSwap');
  });

  it('every strategy that carries a regime round-trips through it', () => {
    for (const s of LIQUIDITY_STRATEGIES) {
      if (!s.regime) continue;
      expect(strategyForRegime(s.regime.sizingBasis, s.regime.bookingMode).id).toBe(s.id);
    }
  });
});

describe('liveLiquidityCostUsdYrM', () => {
  const input = {
    rows: [row()],
    forecastProfile: profileWith(),
    months: 3,
    shared,
  };

  it('reports the net cost of the regime the book is running', () => {
    const results = evaluateLiquidityStrategies(input);
    expect(liveLiquidityCostUsdYrM(input, 'horizon', 'term')).toBeCloseTo(
      pick(results, 'termSwap').netCostUsdYrM,
      10,
    );
    expect(liveLiquidityCostUsdYrM(input, 'cycle', 'rolling')).toBeCloseTo(
      pick(results, 'nearCycle').netCostUsdYrM,
      10,
    );
  });

  it('is zero when there is no path to fund', () => {
    expect(liveLiquidityCostUsdYrM({ ...input, months: 0 }, 'horizon', 'rolling')).toBe(0);
  });
});

describe('the desk strip is what Analytics prices on the live regime', () => {
  it('keys the injected plan by currency and drops empty ones', () => {
    expect(
      livePlanByCcyFrom([
        { ccy: 'GBP', liquidityPlan: pick(evaluate([row()]), 'rollingProgramme').byCcy[0]!.plan },
        { ccy: 'EUR' },
        { ccy: 'PLN', liquidityPlan: [] },
      ]),
    ).toHaveProperty('GBP');
    expect(
      livePlanByCcyFrom([
        { ccy: 'EUR' },
        { ccy: 'PLN', liquidityPlan: [] },
      ]),
    ).toEqual({});
  });

  it('uses the injected plan for the live regime instead of recomputing it', () => {
    const profile = profileWith({ sizingBasis: 'horizon', bookingMode: 'rolling' });
    const recomputed = pick(evaluate([row()], 3, profile), 'rollingProgramme');
    const deskPlan = recomputed.byCcy[0]!.plan.map(p => ({
      ...p,
      swap_needed: p.swap_needed + 1,
      standing_swap: p.standing_swap + 1,
    }));
    const results = evaluateLiquidityStrategies({
      rows: [row()],
      forecastProfile: profile,
      months: 3,
      shared,
      livePlanByCcy: { GBP: deskPlan },
    });
    const live = pick(results, 'rollingProgramme');
    expect(live.byCcy[0]!.bookNow).toBeCloseTo(deskPlan[0]!.swap_needed, 10);
    expect(live.byCcy[0]!.plan).toEqual(deskPlan);
    // Counterfactuals still recompute — they are not the desk strip.
    expect(pick(results, 'termSwap').byCcy[0]!.plan).not.toEqual(deskPlan);
  });
});
