import { describe, it, expect } from 'vitest';
import {
  INITIAL_ROWS,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import {
  DEFAULT_LIQUIDITY_TIMING,
  type LiquidityTiming,
} from '@/lib/liquidity-ladder';
import {
  evaluateLiquidityStrategies,
  liveLiquidityCostUsdYrM,
  livePlanByCcyFrom,
  resolveBufferConstraint,
  strategyForRegime,
  swapLegScheduleWithCarry,
  LIQUIDITY_STRATEGIES,
  type LiquidityStrategyId,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import { fundingSwapOverlayUsdYr } from '@/lib/fx-buffer';
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
});

describe('the interest ledger adds up', () => {
  it('net cost = −(unfunded Cash Carry + Swap Carry), on every strategy', () => {
    for (const r of evaluate([row()])) {
      expect(r.netCostUsdYrM).toBeCloseTo(
        -(r.cashCarryUsdYrM + r.swapCarryUsdYrM),
        6,
      );
      expect(r.swapCarryUsdYrM).toBeCloseTo(0, 9);
    }
  });

  it('Cash Carry is the unfunded path — identical on every strategy', () => {
    const results = evaluate([row()]);
    const cash = pick(results, 'unfunded').cashCarryUsdYrM;
    for (const r of results) {
      expect(r.cashCarryUsdYrM).toBeCloseTo(cash, 9);
    }
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
  it('prices every funding leg as a swap — points on the spot-start too', () => {
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
    expect(rows[0]!.fcyOnUsdYr).toBeCloseTo(first.fcyOnUsdYr, 12);
    expect(rows[0]!.pointsUsdYr).toBeCloseTo(first.pointsUsdYr, 12);
    expect(rows[0]!.interestUsdYr).toBeCloseTo(first.fcyOnUsdYr + first.usdOnUsdYr, 12);
    expect(rows[0]!.netUsdYr).toBeCloseTo(0, 12);
    expect(rows[1]!.hasPoints).toBe(true);
    expect(rows[1]!.netUsdYr).toBeCloseTo(0, 12);
  });
});

describe('regime summary — constraint and final CFaR', () => {
  it('labels the H* constraint from the desk layers', () => {
    expect(resolveBufferConstraint(new Set(['floorH']))).toBe('balance');
    expect(resolveBufferConstraint(new Set(['carryOptim']))).toBe('carry');
    expect(resolveBufferConstraint(new Set(['cfarCover']))).toBe('var');
    expect(resolveBufferConstraint(new Set(['floorH', 'cfarCover']))).toBe('var');
    const results = evaluateLiquidityStrategies({
      rows: [row()],
      forecastProfile: profileWith(),
      months: 3,
      shared,
      activeLayers: new Set(['carryOptim']),
    });
    expect(results[0]!.constraint).toBe('carry');
    expect(results[0]!.constraintDetail).toContain('Carry target');
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
    expect(unfunded.constraint).toBe('var');
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
