// projectLiquidityCycles — the liquidity buffer/swap pipeline (fx-buffer.ts
// computeLayeredBuffer/computeFcySwapNear) sizes ONE cycle at a time. These
// tests confirm the multi-cycle chain correctly surfaces a growing structural
// gap (via the Forecast profile's MoM growth) and schedules forward-dated
// near-leg tranches to pre-fund it, using EUR as the worked example.

import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, type LayerId, type RowState } from './fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  forwardSwapSchedule,
  projectLiquidityCycles,
  swapLegSchedule,
  type ForecastProfileState,
} from './forecast-profile';

const SHARED = { r_USD: 3.5, σ_P: 0.1, days: 3 };
const ALL_LAYERS = new Set<LayerId>(['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv']);
// EUR's LP credit (1.78%) is below USD (3.5%), but its overdraft (2.21%) is CHEAPER
// than USD too — so with carryOptim/portfolioDiv on, the layer formula deliberately
// funds growing payout via cheap overdraft instead of a bigger buffer (correct
// behavior of the existing formula). Isolate sigmaP+floorH to test the safety-margin
// buffer's growth response on its own, independent of that carry offset.
const SAFETY_LAYERS = new Set<LayerId>(['sigmaP', 'floorH']);

const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;

// nonLpCash is zeroed out: it's a one-time balance swept into LP at cycle 0 (see
// projectLiquidityCycles), not something these tests are exercising, and leaving
// EUR's large default (81.6) in would swing "opening" by a one-off amount that
// has nothing to do with the growing-payout scenario under test.
function row(over: Partial<RowState> = {}): RowState {
  return { ...eur, cash: 20, payout: -18, collections: 0, cash_floor: 1, nonLpCash: 0, ...over };
}

function flatGrowthProfile(growthRateMoM: number): ForecastProfileState {
  return { ...DEFAULT_FORECAST_PROFILE, mode: 'flat', growthRateMoM };
}

describe('projectLiquidityCycles — flat, no growth', () => {
  it('repeats the same threshold/swap every cycle and never opens a forward tranche', () => {
    const r = row();
    // SAFETY_LAYERS: delta_sigma/floor depend only on payout magnitude (flat here),
    // not on opening cash, so the threshold is exactly repeatable cycle to cycle.
    const projection = projectLiquidityCycles(r, SHARED, SAFETY_LAYERS, 4, flatGrowthProfile(0));

    expect(projection).toHaveLength(4);
    for (let k = 1; k < projection.length; k++) {
      expect(projection[k]!.cash_threshold).toBeCloseTo(projection[0]!.cash_threshold, 6);
      expect(projection[k]!.incremental_swap).toBe(0);
    }
    expect(forwardSwapSchedule(projection)).toHaveLength(0);
  });

  it('chains cycle N+1 opening cash from cycle N close', () => {
    const r = row();
    const projection = projectLiquidityCycles(r, SHARED, SAFETY_LAYERS, 3, flatGrowthProfile(0));
    for (let k = 1; k < projection.length; k++) {
      expect(projection[k]!.opening_cash).toBeCloseTo(projection[k - 1]!.cycle_end_cash, 6);
    }
  });

  it('matches a direct single-cycle call at cycle 0', () => {
    const r = row();
    const [c0] = projectLiquidityCycles(r, SHARED, SAFETY_LAYERS, 1, flatGrowthProfile(0));
    expect(c0!.opening_cash).toBe(r.cash);
    expect(c0!.forecasted_cash).toBeCloseTo(r.cash + r.payout, 6);
  });
});

describe('projectLiquidityCycles — EUR payout growing MoM', () => {
  it('threshold and swap need grow cycle over cycle', () => {
    const r = row();
    const projection = projectLiquidityCycles(r, SHARED, SAFETY_LAYERS, 4, flatGrowthProfile(0.08));

    for (let k = 1; k < projection.length; k++) {
      expect(Math.abs(projection[k]!.payout)).toBeGreaterThan(Math.abs(projection[k - 1]!.payout));
      expect(projection[k]!.cash_threshold).toBeGreaterThan(projection[k - 1]!.cash_threshold - 1e-9);
    }
  });

  it('schedules a forward near-leg tranche once later cycles outgrow cycle 0 swap', () => {
    const r = row();
    const projection = projectLiquidityCycles(r, SHARED, SAFETY_LAYERS, 6, flatGrowthProfile(0.08));
    const schedule = forwardSwapSchedule(projection);

    expect(schedule.length).toBeGreaterThan(0);
    for (const tranche of schedule) {
      expect(tranche.valueDateMonths).toBe(tranche.cycleIndex);
      expect(tranche.amount_fcy).toBeGreaterThan(0);
    }
    // Later cycles need at least as much top-up as earlier ones once the gap is growing.
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i]!.amount_fcy).toBeGreaterThanOrEqual(schedule[i - 1]!.amount_fcy - 1e-9);
    }
  });

  it('booking the forward tranches funds every projected cycle\'s buffer requirement', () => {
    const r = row();
    const projection = projectLiquidityCycles(r, SHARED, SAFETY_LAYERS, 5, flatGrowthProfile(0.08));
    const cycle0Threshold = projection[0]!.cash_threshold;
    const schedule = forwardSwapSchedule(projection);
    const preFunded = new Map(schedule.map(t => [t.cycleIndex, t.amount_fcy]));

    for (const p of projection) {
      const fundedByNow = cycle0Threshold + (preFunded.get(p.cycleIndex) ?? 0);
      expect(fundedByNow).toBeGreaterThanOrEqual(p.cash_threshold - 1e-6);
    }
  });
});

describe('projectLiquidityCycles — a drain that never reverses', () => {
  // A cycle that only pays out never gives the cash back, so rolling its near leg
  // keeps the cash without repaying anything: every cycle books another leg on
  // top. The per-cycle leg stays flat while the outstanding book grows to the
  // horizon's whole burn — the case a "one rolling leg covers it" reading gets
  // wrong by a factor of the cycle count.
  const drainRow = row({ cash: 0, payout: -1.8, collections: 0, fcastFX: 0, cash_floor: 0 });
  const T = 12;

  it('accumulates the legs: outstanding is the running sum, not the largest leg', () => {
    const projection = projectLiquidityCycles(drainRow, SHARED, SAFETY_LAYERS, T, flatGrowthProfile(0));

    let running = 0;
    for (const p of projection) {
      running += p.swap_needed;
      expect(p.standing_swap).toBeCloseTo(running, 6);
    }

    // The steady-state leg is flat (cycle 0 also has to climb from today's cash
    // to target), yet the book behind it keeps growing by that leg every cycle.
    const steadyLeg = projection[T - 1]!.swap_needed;
    expect(steadyLeg).toBeCloseTo(projection[T - 2]!.swap_needed, 6);
    for (let k = 1; k < T; k++) {
      expect(projection[k]!.standing_swap).toBeGreaterThan(projection[k - 1]!.standing_swap);
    }
    expect(projection[T - 1]!.standing_swap).toBeGreaterThanOrEqual(steadyLeg * (T - 1));
  });

  it('outstanding at the horizon equals the cumulative burn plus that cycle\'s cushion', () => {
    const projection = projectLiquidityCycles(drainRow, SHARED, SAFETY_LAYERS, T, flatGrowthProfile(0));
    const lastCycle = projection[T - 1]!;
    // Unfunded, the balance free-falls: opening + net per cycle, at its trough.
    const unfundedTrough = drainRow.cash + drainRow.payout * T;
    expect(lastCycle.standing_swap).toBeCloseTo(lastCycle.cash_threshold - unfundedTrough, 4);
  });
});

describe('swapLegSchedule — the programme behind the outstanding book', () => {
  const drainRow = row({ cash: 0, payout: -1.8, collections: 0, fcastFX: 0, cash_floor: 0 });
  const T = 12;

  it('lists every leg on a repeating drain, where the tranche schedule lists none', () => {
    const plan = projectLiquidityCycles(drainRow, SHARED, SAFETY_LAYERS, T, flatGrowthProfile(0));
    const schedule = swapLegSchedule(plan);

    // The requirement never outgrows cycle 0's leg, so pre-funding tranches are
    // silent — yet another leg is due every single cycle.
    expect(forwardSwapSchedule(plan)).toHaveLength(0);
    expect(schedule).toHaveLength(T);

    for (const leg of schedule) {
      expect(leg.valueDateMonths).toBe(leg.cycleIndex);
      expect(leg.preBookable).toBe(leg.cycleIndex > 0);
      expect(leg.rolledForward + leg.newLeg).toBeCloseTo(leg.outstanding, 6);
    }
    // Only the near leg is a spot trade; the rest can be booked forward today.
    expect(schedule.filter(l => l.preBookable)).toHaveLength(T - 1);
    // Rolled-in notional is what the earlier legs left behind.
    expect(schedule[T - 1]!.rolledForward).toBeCloseTo(plan[T - 2]!.standing_swap, 6);
    expect(schedule[T - 1]!.outstanding).toBeCloseTo(plan[T - 1]!.standing_swap, 6);
  });

  it('has one spot leg and nothing to roll under term booking', () => {
    const plan = projectLiquidityCycles(drainRow, SHARED, SAFETY_LAYERS, T, flatGrowthProfile(0),
      undefined, undefined, 'term');
    const schedule = swapLegSchedule(plan);

    expect(schedule).toHaveLength(1);
    expect(schedule[0]!.preBookable).toBe(false);
    expect(schedule[0]!.rolledForward).toBe(0);
  });

  it('skips cycles that ask for no trade', () => {
    // Cash-rich and flush: no cycle is short, so there is no programme at all.
    const flush = projectLiquidityCycles(row({ cash: 200, payout: -1, collections: 1 }),
      SHARED, SAFETY_LAYERS, 4, flatGrowthProfile(0));
    for (const leg of swapLegSchedule(flush)) {
      expect(Math.abs(leg.newLeg)).toBeGreaterThan(0.001);
    }
  });
});

describe('projectLiquidityCycles — term booking', () => {
  const drainRow = row({ cash: 0, payout: -1.8, collections: 0, fcastFX: 0, cash_floor: 0 });
  const T = 12;
  const rollingPlan = () =>
    projectLiquidityCycles(drainRow, SHARED, SAFETY_LAYERS, T, flatGrowthProfile(0));
  const termPlan = () =>
    projectLiquidityCycles(drainRow, SHARED, SAFETY_LAYERS, T, flatGrowthProfile(0),
      undefined, undefined, 'term');

  it('books one leg at cycle 0 and nothing after', () => {
    const plan = termPlan();
    expect(plan[0]!.swap_needed).toBeGreaterThan(0);
    for (let k = 1; k < T; k++) expect(plan[k]!.swap_needed).toBe(0);
    // Nothing left to pre-book: the single leg already covers the horizon.
    expect(forwardSwapSchedule(plan)).toHaveLength(0);
  });

  it('sizes the leg so every cycle still clears its own H*', () => {
    const plan = termPlan();
    for (const p of plan) {
      // The trough is reported before the cycle's own leg lands; from cycle 1 on
      // the term leg's cash is already in the chained opening.
      expect(p.forecasted_cash + p.swap_needed).toBeGreaterThanOrEqual(p.cash_threshold - 0.001);
    }
  });

  it('holds outstanding flat while the cash runs down, where rolling does the reverse', () => {
    const term = termPlan();
    const rolling = rollingPlan();

    for (const p of term) expect(p.standing_swap).toBeCloseTo(term[0]!.standing_swap, 6);
    for (let k = 1; k < T; k++) {
      expect(term[k]!.cycle_end_cash).toBeLessThan(term[k - 1]!.cycle_end_cash);
      expect(rolling[k]!.standing_swap).toBeGreaterThan(rolling[k - 1]!.standing_swap);
    }
    // Same path, same total cover — bought up front instead of cycle by cycle.
    expect(term[0]!.swap_needed).toBeCloseTo(rolling[T - 1]!.standing_swap, 2);
  });
});

describe('projectLiquidityCycles — custom mode month series', () => {
  it('reads payout/collections from the explicit month series instead of the flat row', () => {
    const r = row({ cash: 20, payout: -18, collections: 0 });
    const profile: ForecastProfileState = {
      ...DEFAULT_FORECAST_PROFILE,
      mode: 'custom',
      byCcy: {
        EUR: [
          { collections: 0, payout: -18, invoiceFcast: 0, nwcIn: 0, nwcOut: 0, debtIn: 0, debtOut: 0, investIn: 0, investOut: 0, otherIn: 0, otherOut: 0 },
          { collections: 5, payout: -30, invoiceFcast: 0, nwcIn: 0, nwcOut: 0, debtIn: 0, debtOut: 0, investIn: 0, investOut: 0, otherIn: 0, otherOut: 0 },
        ],
      },
    };
    const projection = projectLiquidityCycles(r, SHARED, SAFETY_LAYERS, 2, profile);

    expect(projection[0]!.payout).toBe(-18);
    expect(projection[1]!.payout).toBe(-30);
    expect(projection[1]!.opening_cash).toBeCloseTo(projection[0]!.cycle_end_cash, 6);
    expect(projection[1]!.cash_threshold).toBeGreaterThan(projection[0]!.cash_threshold);
  });
});

describe('projectLiquidityCycles — carry optimization can suppress the growth signal', () => {
  it('with carryOptim/portfolioDiv on, EUR (cheap overdraft, r_OD < r_USD) funds growth via ' +
    'overdraft instead of a bigger buffer, unlike the safety-only projection', () => {
    const r = row();
    const profile = flatGrowthProfile(0.08);
    const safetyOnly = projectLiquidityCycles(r, SHARED, SAFETY_LAYERS, 4, profile);
    const withCarry = projectLiquidityCycles(r, SHARED, ALL_LAYERS, 4, profile);

    // Safety-only buffer keeps climbing with the growing payout (the raw structural gap).
    expect(safetyOnly[3]!.cash_threshold).toBeGreaterThan(safetyOnly[1]!.cash_threshold);
    // With carry optimization on, the same growing payout does NOT force a bigger EUR
    // buffer — the negative delta_carry (favoring cheap overdraft over holding FCY)
    // offsets it. This is the existing formula behaving correctly for this rate
    // differential, not a defect in the projection.
    expect(withCarry[1]!.layered.delta_carry).toBeLessThan(0);
    expect(withCarry[3]!.cash_threshold).toBeLessThan(safetyOnly[3]!.cash_threshold);
  });
});
