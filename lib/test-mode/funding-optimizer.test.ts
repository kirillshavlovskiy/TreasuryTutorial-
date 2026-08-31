import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, type RowState, type SharedGlobals } from '@/lib/fx-buffer';
import { DEFAULT_FORECAST_PROFILE, type ForecastProfileState } from '@/lib/forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING, type LiquidityTiming } from '@/lib/liquidity-ladder';
import { evaluateLiquidityStrategies } from '@/lib/test-mode/liquidity-strategies';
import {
  kktCycleCovers,
  kktSpreads,
  kktVerdictOf,
  optimizeFundingRegime,
  optimizeLiveRegime,
  scaleFundingPlan,
  unfundedTroughOf,
} from '@/lib/test-mode/funding-optimizer';

const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP')!;

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

function livePlan(
  r: RowState,
  timing: Partial<LiquidityTiming> = { sizingBasis: 'horizon', bookingMode: 'rolling' },
) {
  const results = evaluateLiquidityStrategies({
    rows: [r],
    forecastProfile: profileWith(timing),
    months: 3,
    shared,
  });
  const id =
    timing.bookingMode === 'term'
      ? 'termSwap'
      : timing.sizingBasis === 'cycle'
        ? 'nearCycle'
        : 'rollingProgramme';
  return results.find(x => x.strategy.id === id)!.byCcy[0]!;
}

describe('kktSpreads / verdict', () => {
  it('EARN when FCY yields more than USD', () => {
    const s = kktSpreads(4.5, 6.0, 7.0);
    expect(s.muPct).toBeCloseTo(-1.5, 10);
    expect(kktVerdictOf(s.muPct, s.lambdaPct)).toBe('earn');
  });

  it('cheap OD when the facility is at or below USD', () => {
    const s = kktSpreads(4.5, 1.8, 2.2);
    expect(s.lambdaPct).toBe(0);
    expect(kktVerdictOf(s.muPct, s.lambdaPct)).toBe('cheapOd');
  });

  it('binds H* when OD is expensive vs USD and still cheaper than PAY carry', () => {
    const s = kktSpreads(4.5, 1.2, 34);
    expect(s.muPct).toBeCloseTo(3.3, 10);
    expect(s.lambdaPct).toBeCloseTo(29.5, 10);
    expect(kktVerdictOf(s.muPct, s.lambdaPct)).toBe('bind');
  });

  it('skips when PAY carry is steeper than the OD-vs-USD spread', () => {
    const s = kktSpreads(4.5, 0.5, 5.0);
    expect(s.muPct).toBeCloseTo(4.0, 10);
    expect(s.lambdaPct).toBeCloseTo(0.5, 10);
    expect(kktVerdictOf(s.muPct, s.lambdaPct)).toBe('skip');
  });
});

describe('kktCycleCovers — rolling', () => {
  it('takes the full strip on an EARN name', () => {
    const plan = livePlan(row({ r_FCY: 6.2, r_OD: 7.5 })).plan;
    const kkt = kktCycleCovers({ r_FCY: 6.2, r_OD: 7.5 }, plan, shared.r_USD, 'rolling');
    expect(kkt.verdict).toBe('earn');
    expect(kkt.covers.every(a => a === 1)).toBe(true);
  });

  it('drops every increment when OD is cheaper than USD', () => {
    const plan = livePlan(row({ r_FCY: 1.8, r_OD: 2.2 })).plan;
    const kkt = kktCycleCovers({ r_FCY: 1.8, r_OD: 2.2 }, plan, shared.r_USD, 'rolling');
    expect(kkt.verdict).toBe('cheapOd');
    expect(kkt.covers.every(a => a === 0)).toBe(true);
    expect(kkt.cycles.every(c => c.increment === 0)).toBe(true);
  });

  it('binds residual H* on an expensive-OD PAY name', () => {
    const ccy = livePlan(row({ r_FCY: 1.2, r_OD: 34 }));
    const kkt = kktCycleCovers({ r_FCY: 1.2, r_OD: 34 }, ccy.plan, shared.r_USD, 'rolling');
    expect(kkt.verdict).toBe('bind');
    expect(kkt.covers.some(a => a > 0.5)).toBe(true);
    const last = kkt.cycles[kkt.cycles.length - 1]!;
    expect(last.cover).toBeGreaterThan(0);
  });
});

describe('kktCycleCovers — term', () => {
  it('is a single opening cover — later cycles stay at 0', () => {
    const plan = livePlan(row({ r_FCY: 1.2, r_OD: 34 }), { bookingMode: 'term' }).plan;
    const kkt = kktCycleCovers({ r_FCY: 1.2, r_OD: 34 }, plan, shared.r_USD, 'term');
    expect(kkt.covers[0]).toBeGreaterThan(0.5);
    plan.forEach((p, k) => {
      if (k > 0 && Math.abs(p.swap_needed) < 0.001) expect(kkt.covers[k]).toBe(0);
    });
  });

  it('drops the term leg when OD is cheaper than USD', () => {
    const plan = livePlan(row({ r_FCY: -0.3, r_OD: 0.15 }), { bookingMode: 'term' }).plan;
    const kkt = kktCycleCovers({ r_FCY: -0.3, r_OD: 0.15 }, plan, shared.r_USD, 'term');
    expect(kkt.verdict).toBe('cheapOd');
    expect(kkt.covers.every(a => a === 0)).toBe(true);
  });
});

describe('scaleFundingPlan', () => {
  it('rebuilds standing as the running sum of scaled increments', () => {
    const plan = livePlan(row()).plan;
    expect(plan.length).toBeGreaterThan(1);
    const half = plan.map(() => 0.5);
    const scaled = scaleFundingPlan(plan, half);
    let standing = 0;
    scaled.forEach((p, k) => {
      standing = Math.round((standing + p.swap_needed) * 1e8) / 1e8;
      expect(p.swap_needed).toBeCloseTo(plan[k]!.swap_needed * 0.5, 6);
      expect(p.standing_swap).toBeCloseTo(standing, 6);
      expect(unfundedTroughOf(p)).toBeCloseTo(unfundedTroughOf(plan[k]!), 5);
    });
  });

  it('zeros the book when every cover is 0', () => {
    const plan = livePlan(row()).plan;
    const scaled = scaleFundingPlan(plan, plan.map(() => 0));
    expect(scaled.every(p => Math.abs(p.swap_needed) < 1e-9)).toBe(true);
    expect(scaled.every(p => Math.abs(p.standing_swap) < 1e-9)).toBe(true);
  });
});

describe('optimizeLiveRegime', () => {
  it('returns null when there is no dated path', () => {
    expect(optimizeLiveRegime({
      rows: [row()],
      forecastProfile: profileWith(),
      months: 0,
      shared,
    })).toBeNull();
  });

  it('keeps the live EARN strip — complementary slackness takes the whole book', () => {
    const input = {
      rows: [row({ r_FCY: 6.2, r_OD: 7.5 })],
      forecastProfile: profileWith({ sizingBasis: 'horizon', bookingMode: 'rolling' }),
      months: 3,
      shared,
    };
    const opt = optimizeLiveRegime(input)!;
    expect(opt.strategy.id).toBe('rollingProgramme');
    expect(opt.method).toBe('kkt-shadow-price');
    expect(opt.byCcy[0]!.verdict).toBe('earn');
    expect(opt.proposed.bookNowUsdM).toBeCloseTo(opt.live.bookNowUsdM, 6);
    expect(opt.savedKktUsdYrM).toBeCloseTo(0, 6);
  });

  it('drops the cheap-OD book and frees USD capital', () => {
    const input = {
      rows: [row({ r_FCY: 1.8, r_OD: 2.2 })],
      forecastProfile: profileWith({ sizingBasis: 'horizon', bookingMode: 'rolling' }),
      months: 3,
      shared,
    };
    const opt = optimizeLiveRegime(input)!;
    expect(opt.byCcy[0]!.verdict).toBe('cheapOd');
    expect(opt.proposed.bookNowUsdM).toBeLessThan(opt.live.bookNowUsdM - 0.01);
    expect(opt.proposed.peakBookUsdM).toBeLessThan(opt.live.peakBookUsdM - 0.01);
    expect(opt.savedKktUsdYrM).toBeGreaterThan(0);
  });

  it('sparsifies a named regime, not only the live desk', () => {
    const input = {
      rows: [row({ r_FCY: 1.8, r_OD: 2.2 })],
      forecastProfile: profileWith({ sizingBasis: 'horizon', bookingMode: 'rolling' }),
      months: 3,
      shared,
    };
    const term = optimizeFundingRegime(input, 'termSwap')!;
    expect(term.strategy.id).toBe('termSwap');
    expect(term.proposed.byCcy[0]!.schedule.length).toBe(1);
  });

  it('stays inside a term regime — one opening cover, not a rolling rewrite', () => {
    const input = {
      rows: [row({ r_FCY: 1.2, r_OD: 34 })],
      forecastProfile: profileWith({ sizingBasis: 'horizon', bookingMode: 'term' }),
      months: 3,
      shared,
    };
    const opt = optimizeLiveRegime(input)!;
    expect(opt.strategy.id).toBe('termSwap');
    expect(opt.proposed.byCcy[0]!.schedule.length).toBe(1);
  });
});
