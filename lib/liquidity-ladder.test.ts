import { describe, it, expect } from 'vitest';
import {
  ccySpotRate,
  INITIAL_ROWS,
  INITIAL_USD_PARAMS,
  makeSimRow,
  type LayerId,
  type RowState,
} from './fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  emptyMonthFlow,
  forwardSwapSchedule,
  monthlyInflowSeriesLocalM,
  monthlyOutflowSeriesLocalM,
  type ForecastProfileState,
} from './forecast-profile';
import {
  updateDashboardForecastProfile,
  type Workspace,
} from './workspace-store';
import {
  buildLiquidityLadder,
  cycleCarrySplit,
  DEFAULT_LIQUIDITY_TIMING,
  LADDER_DAYS_PER_MONTH,
  shapeCycleWindow,
  type LiquidityGranularity,
  type LiquidityTiming,
} from './liquidity-ladder';
import { computeDashboardModel } from './dashboard-model';

const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP')!;

/** GBP with explicit cycle flows: opening 131.8, out 90, in 60. */
function row(over: Partial<RowState> = {}): RowState {
  return {
    ...gbp,
    cash: 131.8,
    payout: -90,
    collections: 60,
    fcastFX: 0,
    cash_floor: 0,
    ...over,
  };
}

function profileWith(
  timing: Partial<LiquidityTiming>,
  base: Partial<ForecastProfileState> = {},
): ForecastProfileState {
  return {
    ...DEFAULT_FORECAST_PROFILE,
    ...base,
    liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: true, ...timing },
  };
}

describe('liquidity ladder — worst-case shapes reproduce the lump-sum trough', () => {
  const r = row();
  const profile = profileWith({ granularity: 'day' });

  it('trough = cash + payout on day 0, closing = cash + payout + collections', () => {
    const ladder = buildLiquidityLadder(r, profile, { months: 1 });
    expect(ladder.trough).toBeCloseTo(r.cash + r.payout, 8);
    expect(ladder.troughDay).toBe(0);
    expect(ladder.closing).toBeCloseTo(r.cash + r.payout + r.collections, 8);
  });

  it('cycle window spans first payout to last payin', () => {
    const ladder = buildLiquidityLadder(r, profile, { months: 1 });
    expect(ladder.cycleStartDay).toBe(0);
    expect(ladder.cycleEndDay).toBe(LADDER_DAYS_PER_MONTH - 1);
    const shaped = shapeCycleWindow(profile.liquidity, r.ccy);
    expect(shaped.startDay).toBe(0);
    expect(shaped.lengthDays).toBe(LADDER_DAYS_PER_MONTH);
  });

  it('a row with no flows troughs at its opening balance', () => {
    const flat = row({ payout: 0, collections: 0 });
    const ladder = buildLiquidityLadder(flat, profile, { months: 1 });
    expect(ladder.trough).toBeCloseTo(flat.cash, 8);
    expect(ladder.closing).toBeCloseTo(flat.cash, 8);
    expect(ladder.cycleStartDay).toBe(-1);
    expect(ladder.cycleEndDay).toBe(-1);
  });

  it('a T = 0 forecast still yields one cycle', () => {
    const ladder = buildLiquidityLadder(r, profile, { months: 0 });
    expect(ladder.months).toBe(1);
    expect(ladder.buckets.length).toBe(LADDER_DAYS_PER_MONTH);
  });
});

describe('liquidity ladder — monthly amounts are preserved', () => {
  const r = row({ nwcOut: undefined } as Partial<RowState>);
  const months = 3;

  const shapes: { name: string; timing: Partial<LiquidityTiming> }[] = [
    { name: 'worst case', timing: {} },
    {
      name: 'even spread both sides',
      timing: {
        defaults: {
          out: { from: 0, to: 1, curve: 'even' },
          in: { from: 0, to: 1, curve: 'even' },
        },
      },
    },
    {
      name: 'front-loaded out, back-loaded in',
      timing: {
        defaults: {
          out: { from: 0, to: 0.5, curve: 'front' },
          in: { from: 0.4, to: 1, curve: 'back' },
        },
      },
    },
  ];

  for (const { name, timing } of shapes) {
    it(`${name}: month buckets equal the monthly in/out series`, () => {
      const profile = profileWith({ ...timing, granularity: 'month' });
      const ladder = buildLiquidityLadder(r, profile, { months });
      const inflows = monthlyInflowSeriesLocalM(r, months, profile);
      const outflows = monthlyOutflowSeriesLocalM(r, months, profile);
      expect(ladder.buckets).toHaveLength(months);
      ladder.buckets.forEach((b, k) => {
        expect(b.inflow).toBeCloseTo(inflows[k]!, 6);
        expect(b.outflow).toBeCloseTo(outflows[k]!, 6);
      });
    });
  }

  it('growth path is respected month by month', () => {
    const profile = profileWith(
      { granularity: 'month' },
      { growthRateMoM: 0.1 },
    );
    const ladder = buildLiquidityLadder(r, profile, { months });
    const outflows = monthlyOutflowSeriesLocalM(r, months, profile);
    expect(outflows[1]).toBeGreaterThan(outflows[0]!);
    ladder.buckets.forEach((b, k) => {
      expect(b.outflow).toBeCloseTo(outflows[k]!, 6);
    });
  });
});

describe('liquidity ladder — granularity never hides a dip', () => {
  // Payout lands day 1, the offsetting payin day 4 — same week, same month.
  const timing: Partial<LiquidityTiming> = {
    defaults: {
      out: { from: 0, to: 0, curve: 'lump' },
      in: { from: 0.1, to: 0.1, curve: 'lump' },
    },
  };
  const r = row({ payout: -200, collections: 200 });

  it('trough is identical at day, week and month granularity', () => {
    const troughs = (['day', 'week', 'month'] as LiquidityGranularity[]).map(
      granularity =>
        buildLiquidityLadder(r, profileWith({ ...timing, granularity }), {
          months: 1,
        }).trough,
    );
    for (const t of troughs) expect(t).toBeCloseTo(r.cash + r.payout, 8);
  });

  it('the netted bucket still reports its intra-bucket low', () => {
    const ladder = buildLiquidityLadder(
      r,
      profileWith({ ...timing, granularity: 'week' }),
      { months: 1 },
    );
    const first = ladder.buckets[0]!;
    expect(first.net).toBeCloseTo(0, 8);
    expect(first.closing).toBeCloseTo(r.cash, 8);
    expect(first.low).toBeCloseTo(r.cash + r.payout, 8);
  });

  it('spreading the payout lifts the trough above the lump-sum case', () => {
    const spread = profileWith({
      granularity: 'day',
      defaults: {
        out: { from: 0, to: 1, curve: 'even' },
        in: { from: 0, to: 1, curve: 'even' },
      },
    });
    const ladder = buildLiquidityLadder(row(), spread, { months: 1 });
    expect(ladder.trough).toBeGreaterThan(row().cash + row().payout);
  });
});

describe('liquidity ladder — cycle 1 vs the whole horizon', () => {
  // Burning 30/month: the horizon low is the far end, the cycle low is not.
  const r = row({ payout: -90, collections: 60 });
  const profile = profileWith({ granularity: 'week' });

  it('separates the cycle trough from the horizon trough', () => {
    const ladder = buildLiquidityLadder(r, profile, { months: 6 });
    expect(ladder.cycleTrough).toBeCloseTo(r.cash + r.payout, 8);
    expect(ladder.cycleTroughDay).toBeLessThan(LADDER_DAYS_PER_MONTH);
    expect(ladder.trough).toBeLessThan(ladder.cycleTrough);
    expect(ladder.troughDay).toBeGreaterThan(LADDER_DAYS_PER_MONTH);
  });

  it('cycle closing settles every month-1 line', () => {
    const ladder = buildLiquidityLadder(r, profile, { months: 6 });
    expect(ladder.cycleClosing).toBeCloseTo(r.cash + r.payout + r.collections, 8);
  });

  it('cycle closing picks up profile extras', () => {
    const withExtras: ForecastProfileState = {
      ...profile,
      extrasByCcy: {
        [r.ccy]: {
          nwcIn: 40,
          nwcOut: -30,
          debtIn: 0,
          debtOut: 0,
          investIn: 0,
          investOut: 0,
          otherIn: 0,
          otherOut: 0,
        },
      },
    };
    const ladder = buildLiquidityLadder(r, withExtras, { months: 1 });
    expect(ladder.cycleClosing).toBeCloseTo(
      r.cash + r.payout + r.collections + 40 - 30,
      8,
    );
    // NWC out lands with the other outflows on day 0, so it deepens the trough.
    expect(ladder.cycleTrough).toBeCloseTo(r.cash + r.payout - 30, 8);
  });
});

describe('liquidity ladder — floor breaches', () => {
  it('flags the days and buckets below the per-CCY floor', () => {
    const r = row({ cash_floor: 60 });
    const ladder = buildLiquidityLadder(r, profileWith({ granularity: 'week' }), {
      months: 1,
    });
    // Trough 41.8 sits under the 60 floor for the whole month (payin lands D30).
    expect(ladder.trough).toBeLessThan(r.cash_floor);
    expect(ladder.daysBelowFloor).toBe(LADDER_DAYS_PER_MONTH);
    expect(ladder.buckets.every(b => b.belowFloor)).toBe(true);
  });

  it('reports no breach when the floor sits under the trough', () => {
    const r = row({ cash_floor: 10 });
    const ladder = buildLiquidityLadder(r, profileWith({ granularity: 'week' }), {
      months: 1,
    });
    expect(ladder.daysBelowFloor).toBe(0);
    expect(ladder.buckets.some(b => b.belowFloor)).toBe(false);
  });
});

describe('liquidity timing drives the desk model', () => {
  const rows = INITIAL_ROWS.map(r =>
    r.ccy === 'GBP' ? row() : r,
  );
  const base = {
    rows,
    usdCash: 900,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: 1 },
    activeLayers: new Set(['sigmaP', 'carryOptim', 'floorH'] as const),
    policyVAR: 5.0,
  };

  const spread = profileWith({
    granularity: 'day',
    defaults: {
      out: { from: 0, to: 1, curve: 'even' },
      in: { from: 0, to: 1, curve: 'even' },
    },
  });

  it('disabled timing keeps the lump-sum trough', () => {
    const model = computeDashboardModel({
      ...base,
      forecastProfile: { ...spread, liquidity: { ...spread.liquidity!, enabled: false } },
    });
    const g = model.fcyComputed.find(r => r.ccy === 'GBP')!;
    expect(g.lp_peak_cash).toBeCloseTo(g.cash + g.payout, 8);
    expect(g.troughDay).toBeUndefined();
  });

  it('enabled timing raises the trough, lifts H* and dates the low point', () => {
    const off = computeDashboardModel({
      ...base,
      forecastProfile: { ...spread, liquidity: { ...spread.liquidity!, enabled: false } },
    });
    const on = computeDashboardModel({ ...base, forecastProfile: spread });
    const gOff = off.fcyComputed.find(r => r.ccy === 'GBP')!;
    const gOn = on.fcyComputed.find(r => r.ccy === 'GBP')!;
    expect(gOn.lp_peak_cash).toBeGreaterThan(gOff.lp_peak_cash);
    expect(gOn.cash_threshold_pre_swap).toBeGreaterThan(gOff.cash_threshold_pre_swap);
    expect(gOn.lp_after_swap_trough!).toBeGreaterThan(gOff.lp_after_swap_trough!);
    expect(gOn.troughDay).toBeGreaterThan(0);
    expect(gOn.cycleStartDay).toBe(0);
    // FX side reads the same monthly amounts either way.
    expect(gOn.netFxForecast).toBeCloseTo(gOff.netFxForecast, 8);
  });

  it('cycle net flow answers to NWC lines once timing is on', () => {
    const extras = {
      nwcIn: 40,
      nwcOut: -30,
      debtIn: 0,
      debtOut: 0,
      investIn: 0,
      investOut: 0,
      otherIn: 0,
      otherOut: 0,
    };
    const off = computeDashboardModel({
      ...base,
      forecastProfile: {
        ...spread,
        extrasByCcy: { GBP: extras },
        liquidity: { ...spread.liquidity!, enabled: false },
      },
    });
    const on = computeDashboardModel({
      ...base,
      forecastProfile: { ...spread, extrasByCcy: { GBP: extras } },
    });
    const gOff = off.fcyComputed.find(r => r.ccy === 'GBP')!;
    const gOn = on.fcyComputed.find(r => r.ccy === 'GBP')!;
    // Off: extras are invisible to the liquidity book, as before.
    expect(gOff.cash_after_payins).toBeCloseTo(
      gOff.cashPos + gOff.payout + gOff.collections,
      8,
    );
    // On: cycle end = opening + every month-1 line + non-LP cash.
    expect(gOn.cash_after_payins).toBeCloseTo(
      gOff.cash_after_payins + 40 - 30 + gOn.fcastFX,
      6,
    );
  });

  it('with no layer selected the swap stays silent and the book is held', () => {
    const bare = { ...base, activeLayers: new Set<never>() };
    const off = computeDashboardModel({
      ...bare,
      forecastProfile: { ...spread, liquidity: { ...spread.liquidity!, enabled: false } },
    });
    const on = computeDashboardModel({ ...bare, forecastProfile: spread });
    const gOff = off.fcyComputed.find(r => r.ccy === 'GBP')!;
    const gOn = on.fcyComputed.find(r => r.ccy === 'GBP')!;
    expect(gOff.swapNear).toBe(0);
    expect(gOn.swapNear).toBe(0);
    expect(gOff.postSwapCash).toBeCloseTo(gOff.cash, 8);
    expect(gOn.postSwapCash).toBeCloseTo(gOn.cash, 8);
    // Timing still dates the trough — it just no longer triggers a swap.
    expect(gOn.lp_peak_cash).not.toBeCloseTo(gOff.lp_peak_cash, 3);
  });

  it('a layer brings the swap back', () => {
    const withFloor = computeDashboardModel({
      ...base,
      activeLayers: new Set<LayerId>(['floorH']),
      rows: [row({ cash_floor: 20 })],
      forecastProfile: spread,
    });
    const g = withFloor.fcyComputed.find(r => r.ccy === 'GBP')!;
    expect(g.swapNear).toBeGreaterThan(0);
    expect(g.lp_after_swap_trough).toBeCloseTo(g.cash_threshold_pre_swap, 6);
  });

  it('Trough Cash does not take the funding swap — a layer only adds the near leg', () => {
    // M1/M2 slightly overdraw; M3 is the unique deep dip. Turning a layer on
    // used to lift M3's displayed trough by M1's leftover cover (−6.6 → −6.58).
    const quiet = { ...emptyMonthFlow(), payout: -2.52, collections: 2.52 };
    const dip = { ...emptyMonthFlow(), payout: -9.1, collections: 1.2 };
    const after = { ...emptyMonthFlow(), payout: 0, collections: 1.2 };
    const eur = makeSimRow('e', 'EUR', 2.5, 0, 0, 2.5, 0, 1.2, 0, 0, 0, 0, 3);
    const profile = profileWith(
      { granularity: 'week', sizingBasis: 'horizon' },
      { mode: 'custom', byCcy: { EUR: [quiet, quiet, dip, ...Array.from({ length: 9 }, () => after)] } },
    );
    const input = {
      rows: [eur],
      usdCash: 0,
      usdNonLpCash: 0,
      usdParams: INITIAL_USD_PARAMS,
      shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: 12 },
      policyVAR: 5,
      forecastProfile: profile,
    };
    const off = computeDashboardModel({ ...input, activeLayers: new Set<never>() })
      .fcyComputed.find(r => r.ccy === 'EUR')!;
    const on = computeDashboardModel({ ...input, activeLayers: new Set<LayerId>(['floorH']) })
      .fcyComputed.find(r => r.ccy === 'EUR')!;

    expect(off.troughCycleIndex).toBe(2);
    expect(on.troughCycleIndex).toBe(2);
    expect(off.lp_peak_cash).toBeCloseTo(-6.6, 8);
    expect(on.lp_peak_cash).toBeCloseTo(off.lp_peak_cash, 8);
    expect(on.cycleDrawdown).toBeCloseTo(off.cycleDrawdown!, 8);
    expect(on.cash_after_payins).toBeCloseTo(off.cash_after_payins, 8);
    expect(off.swapNear).toBe(0);
    expect(on.swapNear).toBeGreaterThan(0);
    expect(on.liquidityCycles![2]!.low).toBeCloseTo(on.lp_peak_cash, 8);
    expect(on.liquidityPlan![on.sizingCycleIndex ?? 2]!.forecasted_cash)
      .not.toBeCloseTo(on.lp_peak_cash, 3);
  });

  it('later-cycle liquidity-book openings do not include the funding swap', () => {
    const withFloor = computeDashboardModel({
      ...base,
      shared: { ...base.shared, forecastMonths: 12 },
      activeLayers: new Set<LayerId>(['floorH']),
      rows: [row({ cash_floor: 20 })],
      forecastProfile: spread,
    });
    const g = withFloor.fcyComputed.find(r => r.ccy === 'GBP')!;
    expect(g.swapNear).toBeGreaterThan(0);
    expect(g.liquidityCycles!.length).toBeGreaterThan(1);
    expect(g.liquidityPlan!.length).toBeGreaterThan(1);
    const bookM2 = g.liquidityCycles![1]!;
    const fundedM2 = g.liquidityPlan![1]!;
    expect(bookM2.opening).toBeCloseTo(g.liquidityCycles![0]!.closing, 8);
    expect(fundedM2.opening_cash).not.toBeCloseTo(bookM2.opening, 3);
  });

  it('a buffer layer does not rewrite collapsed-row operating totals on a repeating drain', () => {
    const profile = profileWith({ granularity: 'week', sizingBasis: 'horizon' });
    const input = {
      rows: [row()],
      usdCash: 0,
      usdNonLpCash: 0,
      usdParams: INITIAL_USD_PARAMS,
      shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: 12 },
      policyVAR: 5,
      forecastProfile: profile,
    };
    const off = computeDashboardModel({ ...input, activeLayers: new Set<never>() })
      .fcyComputed.find(r => r.ccy === 'GBP')!;
    const on = computeDashboardModel({ ...input, activeLayers: new Set<LayerId>(['sigmaP']) })
      .fcyComputed.find(r => r.ccy === 'GBP')!;

    expect(on.lp_peak_cash).toBeCloseTo(off.lp_peak_cash, 8);
    expect(on.cycleDrawdown).toBeCloseTo(off.cycleDrawdown!, 8);
    expect(on.cash_after_payins).toBeCloseTo(off.cash_after_payins, 8);
    expect(on.troughCycleIndex).toBe(off.troughCycleIndex);
    expect(off.swapNear).toBe(0);
    expect(on.swapNear).toBeGreaterThan(0);
  });
});

describe('structural gap carry', () => {
  const spot = ccySpotRate('GBP');
  /** Opening 100, everything out on D1, everything back on D21: 20d overdrawn. */
  const flip = profileWith({
    granularity: 'day',
    byField: {
      payout: { from: 0, to: 0, curve: 'lump' },
      collections: { from: 20 / 30, to: 20 / 30, curve: 'lump' },
    },
  });
  const flipRow = row({ cash: 100, payout: -180, collections: 150 });

  function carryFor(profile: ForecastProfileState | undefined) {
    const m = computeDashboardModel({
      rows: [flipRow],
      usdCash: 900,
      usdNonLpCash: 154.1,
      usdParams: INITIAL_USD_PARAMS,
      shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: 1 },
      activeLayers: new Set<LayerId>(),
      policyVAR: 5,
      forecastProfile: profile,
    });
    return m.fcyComputed.find(r => r.ccy === 'GBP')!;
  }

  it('prices each day on its own side of zero', () => {
    const g = carryFor(flip);
    // 20 days at −80 on the debit rate, 10 days at +70 on the credit rate,
    // both measured against the USD alternative.
    const expected = ((70 * 10) / 30 * (flipRow.r_FCY - 3.5)
      + (-80 * 20) / 30 * (flipRow.r_OD - 3.5)) / 100 * spot;
    expect(g.floatNim).toBeCloseTo(expected, 6);
  });

  it('a single average balance would use the wrong rate for the whole cycle', () => {
    const timed = carryFor(flip);
    const lump = carryFor(undefined);
    // Netted to one balance the cycle looks long (100 − 180 + 150 = +70) and
    // never sees the overdraft — the error is larger than the carry itself.
    expect(lump.floatNim).toBeCloseTo(100 * (flipRow.r_FCY - 3.5) / 100 * spot, 6);
    expect(Math.abs(timed.floatNim - lump.floatNim)).toBeGreaterThan(
      Math.abs(timed.floatNim),
    );
  });

  it('the gap is charged at the debit rate, not the credit rate', () => {
    const g = carryFor(flip);
    const asCredit = ((70 * 10) / 30 + (-80 * 20) / 30) * (flipRow.r_FCY - 3.5) / 100 * spot;
    expect(g.floatNim).not.toBeCloseTo(asCredit, 3);
    const split = cycleCarrySplit(
      buildLiquidityLadder(flipRow, flip, { months: 1 }),
      0,
    );
    expect(split.debitDays).toBe(20);
    expect(split.creditDays).toBe(10);
    expect(split.avgDebit).toBeCloseTo((-80 * 20) / 30, 6);
    expect(split.avgCredit).toBeCloseTo((70 * 10) / 30, 6);
  });

  it('the funding swap shifts the whole path before carry accrues', () => {
    const ladder = buildLiquidityLadder(flipRow, flip, { months: 1 });
    const unfunded = cycleCarrySplit(ladder, 0);
    const funded = cycleCarrySplit(ladder, 80);
    expect(unfunded.debitDays).toBe(20);
    expect(funded.debitDays).toBe(0);
    expect(funded.avgDebit).toBe(0);
  });
});

describe('hedge settlement is a dated line on the path', () => {
  /** Quiet book: only the hedge moves cash, so its date is the whole story. */
  const quiet = row({ cash: 100, payout: 0, collections: 0, nonLpCash: 0 });
  const onDay = (day: number): Partial<LiquidityTiming> => ({
    granularity: 'day',
    byField: {
      hedgeSettle: {
        from: (day - 1) / LADDER_DAYS_PER_MONTH,
        to: (day - 1) / LADDER_DAYS_PER_MONTH,
        curve: 'lump',
      },
    },
  });

  it('a forward delivering FCY troughs the cycle on its settlement day', () => {
    const profile = profileWith(onDay(11));
    const ladder = buildLiquidityLadder(quiet, profile, {
      months: 1,
      hedgeSettle: [-40],
    });
    expect(ladder.cycleTrough).toBeCloseTo(60, 8);
    expect(ladder.cycleTroughDay).toBe(10);
    expect(ladder.cycleClosing).toBeCloseTo(60, 8);
  });

  it('the settlement date decides whether the payin arrives in time', () => {
    // 40 out on the hedge, 30 back from collections on D15.
    const withPayin = row({ cash: 100, payout: 0, collections: 30, nonLpCash: 0 });
    const payinMidMonth = {
      collections: { from: 14 / 30, to: 14 / 30, curve: 'lump' as const },
    };
    const early = buildLiquidityLadder(
      withPayin,
      profileWith({ ...onDay(2), byField: { ...onDay(2).byField, ...payinMidMonth } }),
      { months: 1, hedgeSettle: [-90] },
    );
    const late = buildLiquidityLadder(
      withPayin,
      profileWith({ ...onDay(25), byField: { ...onDay(25).byField, ...payinMidMonth } }),
      { months: 1, hedgeSettle: [-90] },
    );
    // Settling before the payin bottoms at 10; settling after it bottoms at 40.
    expect(early.cycleTrough).toBeCloseTo(10, 8);
    expect(late.cycleTrough).toBeCloseTo(40, 8);
    expect(early.cycleClosing).toBeCloseTo(late.cycleClosing, 8);
  });

  it('a receipt lifts the close without lifting the trough', () => {
    const profile = profileWith({ granularity: 'day' });
    const bare = buildLiquidityLadder(row(), profile, { months: 1 });
    const received = buildLiquidityLadder(row(), profile, {
      months: 1,
      hedgeSettle: [40],
    });
    expect(received.cycleClosing).toBeCloseTo(bare.cycleClosing + 40, 8);
    expect(received.cycleTrough).toBeCloseTo(bare.cycleTrough, 8);
  });

  it('shows up in the bucket flows the preview draws', () => {
    const profile = profileWith({ granularity: 'month' });
    const ladder = buildLiquidityLadder(row(), profile, {
      months: 1,
      hedgeSettle: [-40],
    });
    const out = ladder.buckets.reduce((s, b) => s + b.outflow, 0);
    const inflow = ladder.buckets.reduce((s, b) => s + b.inflow, 0);
    expect(out).toBeCloseTo(90 + 40, 8);
    expect(inflow).toBeCloseTo(60, 8);
  });
});

describe('hedge settlement drives the liquidity book, not the exposure', () => {
  // Overdrawn without help, and on the σ buffer, whose H* is a cushion over the
  // payout rather than over the trough — so the swap answers to the trough alone.
  const gbpRow = row({ cash: 100, payout: -200, collections: 60 });
  const base = {
    rows: [gbpRow],
    usdCash: 900,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: 1 },
    activeLayers: new Set<LayerId>(['sigmaP']),
    policyVAR: 5,
  };
  const spread = profileWith({
    granularity: 'day',
    defaults: {
      out: { from: 0, to: 1, curve: 'even' },
      in: { from: 0, to: 1, curve: 'even' },
    },
  });
  const gbpFrom = (
    hedgeSettleByCcy?: Record<string, number[]>,
    profile: ForecastProfileState | undefined = spread,
  ) => computeDashboardModel({ ...base, forecastProfile: profile, hedgeSettleByCcy })
    .fcyComputed.find(r => r.ccy === 'GBP')!;

  it('a delivery deepens the trough, so the swap has to fund it', () => {
    const bare = gbpFrom();
    const hedged = gbpFrom({ GBP: [-40] });
    expect(hedged.lp_peak_cash).toBeCloseTo(bare.lp_peak_cash - 40, 6);
    expect(hedged.swapNear).toBeCloseTo(bare.swapNear + 40, 6);
    expect(hedged.cash_after_payins).toBeCloseTo(bare.cash_after_payins - 40, 6);
    // Same cushion either way — the σ buffer sizes off the payout, and the swap
    // is what moves to reach it from a lower trough.
    expect(hedged.cash_threshold_pre_swap).toBeCloseTo(bare.cash_threshold_pre_swap, 6);
  });

  it('keeps FX hedge settlement inside the liquidity book the swap answers', () => {
    const bare = gbpFrom();
    const hedged = gbpFrom({ GBP: [-40] });

    // FX hedging and liquidity hedging are separate books: the forward's delivery
    // is operating cash, so it belongs to the liquidity path cycle by cycle. Only
    // the funding swap stands apart, and the liquidity band is stated before it.
    expect(hedged.liquidityPlan!.map(p => p.hedgeSettle)).toEqual([-40]);
    expect(hedged.lp_peak_cash).toBeCloseTo(bare.lp_peak_cash - 40, 6);
    expect(hedged.cash_after_payins).toBeCloseTo(bare.cash_after_payins - 40, 6);
    expect(hedged.swapNear).toBeCloseTo(bare.swapNear + 40, 6);
  });

  it('a staged delivery funds the swap the same way a booked one does', () => {
    const booked = gbpFrom({ GBP: [0] });
    const staged = gbpFrom({ GBP: [-40] });

    expect(staged.liquidityPlan!.map(p => p.hedgeSettle)).toEqual([-40]);
    expect(staged.liquidityCycles![0]!.outflow).toBeCloseTo(
      booked.liquidityCycles![0]!.outflow + 40, 6,
    );
    expect(staged.lp_peak_cash).toBeCloseTo(booked.lp_peak_cash - 40, 6);
    expect(staged.cash_after_payins).toBeCloseTo(booked.cash_after_payins - 40, 6);
    expect(staged.swapNear).toBeCloseTo(booked.swapNear + 40, 6);
    expect(staged.liquidityPlan![0]!.swap_needed).toBeCloseTo(
      booked.liquidityPlan![0]!.swap_needed + 40, 6,
    );
  });

  it('a buffer layer writes the funded strip the SWAP band reads', () => {
    const off = computeDashboardModel({
      ...base,
      activeLayers: new Set<LayerId>(),
      forecastProfile: spread,
    }).fcyComputed.find(r => r.ccy === 'GBP')!;
    const on = gbpFrom();
    expect(off.swapNear).toBe(0);
    expect(off.liquidityPlan!.every(p => Math.abs(p.swap_needed) < 0.001)).toBe(true);
    expect(on.swapNear).toBeGreaterThan(0);
    expect(on.liquidityPlan!.some(p => p.swap_needed > 0.001)).toBe(true);
    expect(on.liquidityPlan![on.liquidityPlan!.length - 1]!.standing_swap)
      .toBeGreaterThan(0.001);
  });

  it('leaves the book untouched where nothing settles', () => {
    const bare = gbpFrom();
    const zero = gbpFrom({ GBP: [0] });
    expect(zero.lp_peak_cash).toBeCloseTo(bare.lp_peak_cash, 6);
    expect(zero.cash_after_payins).toBeCloseTo(bare.cash_after_payins, 6);
    expect(zero.swapNear).toBeCloseTo(bare.swapNear, 6);
  });

  it('covers the trough on either booking convention', () => {
    // Rolling adds a leg each cycle; term commits the horizon's cover today. The
    // states the desk reads are the same either way, and both fund every cycle up
    // to that cycle's H* — otherwise the regime toggle would change whether the
    // book is covered rather than only how it is traded.
    const term = { ...spread, liquidity: { ...spread.liquidity!, bookingMode: 'term' as const } };
    for (const profile of [spread, term]) {
      const row = gbpFrom({ GBP: [-40] }, profile);
      // The delivery deepens the low the cover has to reach.
      expect(row.lp_peak_cash).toBeLessThan(gbpFrom(undefined, profile).lp_peak_cash);
      for (const p of row.liquidityPlan!) {
        expect(p.post_swap_cash).toBeGreaterThanOrEqual(p.cash_threshold - 1e-6);
      }
    }
  });

  it('states the same trough whichever way the cover is booked', () => {
    // Term booking commits the horizon's cover today, so every later cycle opens on
    // cash the rolling strip has not raised yet. That is the trade, not the book:
    // the low the desk reads, the target it opens on and the cycle that binds all
    // have to survive the toggle, or the regime would be editing the exposure.
    const horizon = { ...base, shared: { ...base.shared, forecastMonths: 12 } };
    const read = (bookingMode: 'rolling' | 'term') => computeDashboardModel({
      ...horizon,
      forecastProfile: { ...spread, liquidity: { ...spread.liquidity!, bookingMode } },
    }).fcyComputed.find(r => r.ccy === 'GBP')!;
    const rolling = read('rolling');
    const term = read('term');

    expect(term.lp_peak_cash).toBeCloseTo(rolling.lp_peak_cash, 6);
    expect(term.troughCycleIndex).toBe(rolling.troughCycleIndex);
    expect(term.cycleDrawdown).toBeCloseTo(rolling.cycleDrawdown!, 6);
    expect(term.cash_threshold_pre_swap).toBeCloseTo(rolling.cash_threshold_pre_swap, 6);
    expect(term.cash_after_payins).toBeCloseTo(rolling.cash_after_payins, 6);
    // What does move is the trade: one lump up front against a strip per cycle.
    expect(term.liquidityPlan![0]!.swap_needed)
      .toBeGreaterThan(rolling.liquidityPlan![0]!.swap_needed);
    expect(term.liquidityPlan!.slice(1).every(p => p.swap_needed === 0)).toBe(true);
    expect(rolling.liquidityPlan!.slice(1).every(p => p.swap_needed > 0)).toBe(true);
  });

  it('repays the term cover on the last date, and states the close after it', () => {
    // Term cover matures with the horizon. Carrying it into the last close reported
    // a balance that still held borrowed cash, so a book hedged to its full target
    // looked flat when it was short by its own non-cash exposure.
    const horizon = { ...base, shared: { ...base.shared, forecastMonths: 12 } };
    const read = (
      bookingMode: 'rolling' | 'term',
      activeLayers = base.activeLayers,
    ) => computeDashboardModel({
      ...horizon,
      activeLayers,
      forecastProfile: { ...spread, liquidity: { ...spread.liquidity!, bookingMode } },
    }).fcyComputed.find(r => r.ccy === 'GBP')!.liquidityPlan!;
    const term = read('term');
    const last = term[term.length - 1]!;
    const unfunded = read('term', new Set<LayerId>());

    expect(last.far_leg).toBeCloseTo(-last.standing_swap, 6);
    // Handing the borrowed cash back leaves the operating close — the balance the
    // book reaches on its own flows, with no cover in it.
    expect(last.cycle_end_cash)
      .toBeCloseTo(unfunded[unfunded.length - 1]!.cycle_end_cash, 6);
    // The repayment lands at the close, so no H* on the path moves for it.
    expect(term.every(p => p.post_swap_cash >= p.cash_threshold - 1e-6)).toBe(true);
    // Rolling legs are rolled rather than let run off: nothing settles.
    expect(read('rolling').every(p => p.far_leg === 0)).toBe(true);
  });

  it('closes at zero once a cash-equivalent 100% target hedge settles and the term cover is repaid', () => {
    // Full-target hedge of a book that IS the cash (spot = cash, nothing non-cash)
    // plus a balanced cycle so the path does not accumulate. The bullet delivers
    // that cash at Tf; the term far-leg pays the cover back on the same date.
    // Cycle End used to keep the near-leg notional because it was the month-1
    // close with the cover still sitting in it.
    const cashBook = row({
      cash: 100, spot: 100, fwd: 0, nonCash: 0, nonLpCash: 0,
      payout: -200, collections: 200,
    });
    const hedge = Array.from({ length: 12 }, (_, i) => (i === 11 ? -100 : 0));
    const term = computeDashboardModel({
      ...base,
      rows: [cashBook],
      shared: { ...base.shared, forecastMonths: 12 },
      forecastProfile: { ...spread, liquidity: { ...spread.liquidity!, bookingMode: 'term' } },
      hedgeSettleByCcy: { GBP: hedge },
    }).fcyComputed.find(r => r.ccy === 'GBP')!;
    const last = term.liquidityPlan![11]!;

    expect(term.swapNear).toBeGreaterThan(0.001);
    expect(last.far_leg).toBeCloseTo(-last.standing_swap, 6);
    expect(last.hedgeSettle).toBeCloseTo(-100, 6);
    expect(last.cycle_end_cash).toBeCloseTo(0, 5);
    expect(term.cycleEndCash).toBeCloseTo(last.cycle_end_cash, 6);
    expect(term.cycleEndCash).toBeCloseTo(0, 5);
  });

  it('does not keep the term notional in Cycle End after the far leg lands', () => {
    const horizon = { ...base, shared: { ...base.shared, forecastMonths: 12 } };
    const term = computeDashboardModel({
      ...horizon,
      forecastProfile: { ...spread, liquidity: { ...spread.liquidity!, bookingMode: 'term' } },
    }).fcyComputed.find(r => r.ccy === 'GBP')!;
    const last = term.liquidityPlan![term.liquidityPlan!.length - 1]!;
    expect(term.cycleEndCash).toBeCloseTo(last.cycle_end_cash, 6);
    // The near-cycle formula would still be holding the cover.
    expect(Math.abs(
      term.cycleEndCash - (term.cash + term.swapNear + term.payout + term.collections + term.fcastFX + term.nonLpCash),
    )).toBeGreaterThan(0.01);
  });

  it('advertises the term leg the plan books, not the near cycle it outgrew', () => {
    // The row is the ticket: under term cover it has to name the trade the plan
    // executes. The USD funding stress and portfolio VaR passes both re-derive the
    // leg from the settled target, which quietly put the near cycle's shortfall on
    // the row while the plan below it booked the whole horizon.
    for (const layers of [['sigmaP', 'carryOptim'], ['sigmaP', 'carryOptim', 'portfolioDiv']]) {
      const term = computeDashboardModel({
        ...base,
        activeLayers: new Set(layers as LayerId[]),
        shared: { ...base.shared, forecastMonths: 12 },
        forecastProfile: {
          ...spread,
          liquidity: { ...spread.liquidity!, bookingMode: 'term' as const },
        },
      }).fcyComputed.find(r => r.ccy === 'GBP')!;

      expect(term.swapNear).toBeCloseTo(term.liquidityPlan![0]!.swap_needed, 6);
      // And that trade is the horizon's, well past what the near cycle alone needs.
      expect(term.swapNear)
        .toBeGreaterThan(term.cash_threshold_pre_swap - term.lp_peak_cash);
    }
  });

  it('books no cover on either convention until a layer is on', () => {
    // No layer is no funding policy — the desk is reading the book as it stands.
    // Term booking used to solve its own shortfall against H* regardless, funding
    // the path to zero and reporting that funded low as the trough.
    const horizon = {
      ...base,
      activeLayers: new Set<LayerId>(),
      shared: { ...base.shared, forecastMonths: 12 },
    };
    const read = (bookingMode: 'rolling' | 'term') => computeDashboardModel({
      ...horizon,
      forecastProfile: { ...spread, liquidity: { ...spread.liquidity!, bookingMode } },
    }).fcyComputed.find(r => r.ccy === 'GBP')!;
    const rolling = read('rolling');
    const term = read('term');

    expect(term.swapNear).toBe(0);
    expect(rolling.swapNear).toBe(0);
    expect(term.liquidityPlan!.every(p => p.swap_needed === 0)).toBe(true);
    expect(term.lp_peak_cash).toBeCloseTo(rolling.lp_peak_cash, 6);
    // And that low is an unfunded one: the path drains cycle after cycle instead of
    // being held up at a target.
    expect(term.liquidityPlan![11]!.forecasted_cash)
      .toBeLessThan(term.liquidityPlan![0]!.forecasted_cash);
  });

  it('reads the path low with no funding in it, unlike the sizing trough', () => {
    // A drain that repeats every cycle. Unfunded the path free-falls; the funded
    // plan holds each cycle up with its own near leg, so its trough stays bounded.
    // The gap between the two IS the funding — which is why the deal comparison
    // reads the path and not the plan.
    const drain = computeDashboardModel({
      ...base,
      shared: { ...base.shared, forecastMonths: 12 },
      forecastProfile: spread,
    }).fcyComputed.find(r => r.ccy === 'GBP')!;
    const lows = drain.liquidityCycles!.map(c => c.low);

    expect(drain.troughPath).toBeCloseTo(Math.min(...lows), 6);
    expect(lows[lows.length - 1]!).toBeLessThan(lows[0]!);
    expect(drain.lp_peak_cash).toBeCloseTo(drain.troughPath!, 8);
    expect(drain.liquidityPlan![drain.sizingCycleIndex ?? 0]!.forecasted_cash)
      .toBeGreaterThan(drain.lp_peak_cash);
  });

  it('leaves FX exposure and the forecast basis alone', () => {
    const bare = gbpFrom();
    const hedged = gbpFrom({ GBP: [-40] });
    // The position side of the hedge is already in Cash FX / Fwd; the settlement
    // line must not be counted a second time in the exposure.
    expect(hedged.netFxFCY).toBeCloseTo(bare.netFxFCY, 8);
    expect(hedged.netFxForecast).toBeCloseTo(bare.netFxForecast, 8);
  });

  it('counts in the cycle even with the dated path off', () => {
    const off = { ...spread, liquidity: { ...spread.liquidity!, enabled: false } };
    const bare = gbpFrom(undefined, off);
    const hedged = gbpFrom({ GBP: [-40] }, off);
    expect(hedged.lp_peak_cash).toBeCloseTo(bare.lp_peak_cash - 40, 8);
    expect(hedged.cash_after_payins).toBeCloseTo(bare.cash_after_payins - 40, 8);
    // A receipt cannot rescue the trough it arrives after.
    const received = gbpFrom({ GBP: [40] }, off);
    expect(received.lp_peak_cash).toBeCloseTo(bare.lp_peak_cash, 8);
    expect(received.cash_after_payins).toBeCloseTo(bare.cash_after_payins + 40, 8);
  });

  it('a hedge that overdraws the account is charged the debit rate', () => {
    const deliverEarly = profileWith({
      granularity: 'day',
      byField: { hedgeSettle: { from: 0, to: 0, curve: 'lump' } },
      defaults: {
        out: { from: 0, to: 0, curve: 'lump' },
        in: { from: 1, to: 1, curve: 'lump' },
      },
    });
    const quiet = { ...base, rows: [row({ cash: 100, payout: 0, collections: 0, nonLpCash: 0 })], activeLayers: new Set<LayerId>() };
    const g = computeDashboardModel({
      ...quiet,
      forecastProfile: deliverEarly,
      hedgeSettleByCcy: { GBP: [-150] },
    }).fcyComputed.find(r => r.ccy === 'GBP')!;
    // 30 days at −50 with no layer to fund it: the whole cycle is overdrawn.
    const expected = -50 * (g.r_OD - 3.5) / 100 * ccySpotRate('GBP');
    expect(g.swapNear).toBe(0);
    expect(g.floatNim).toBeCloseTo(expected, 6);
  });
});

describe('the cycle roll-up shows how much drains every cycle', () => {
  // −30 a month: each cycle drains the same 90 while the close ratchets down.
  const r = row();
  const profile = profileWith({ granularity: 'week' });

  it('reports drain, low and close for every cycle', () => {
    const { cycles } = buildLiquidityLadder(r, profile, { months: 3 });
    expect(cycles).toHaveLength(3);
    expect(cycles.map(c => c.opening)).toEqual([131.8, 101.8, 71.8]);
    expect(cycles.map(c => c.low)).toEqual([41.8, 11.8, -18.2]);
    expect(cycles.map(c => c.closing)).toEqual([101.8, 71.8, 41.8]);
    // The drain repeats even though every closing balance is different.
    expect(cycles.map(c => c.drawdown)).toEqual([90, 90, 90]);
    expect(cycles.map(c => c.outflow)).toEqual([90, 90, 90]);
    expect(cycles.map(c => c.inflow)).toEqual([60, 60, 60]);
  });

  it('counts every line that settles in the cycle, not just the payout', () => {
    const withExtras: ForecastProfileState = {
      ...profile,
      extrasByCcy: {
        [r.ccy]: {
          nwcIn: 0, nwcOut: -30, debtIn: 0, debtOut: 0,
          investIn: 0, investOut: 0, otherIn: 0, otherOut: 0,
        },
      },
    };
    const plain = buildLiquidityLadder(r, profile, { months: 1 });
    const extras = buildLiquidityLadder(r, withExtras, { months: 1 });
    expect(extras.cycles[0]!.drawdown).toBeCloseTo(plain.cycles[0]!.drawdown + 30, 8);
    expect(extras.cycles[0]!.outflow).toBeCloseTo(120, 8);
  });

  it('names the worst cycle of the horizon', () => {
    const ladder = buildLiquidityLadder(r, profile, { months: 3 });
    expect(ladder.worstCycleIndex).toBe(2);
    expect(ladder.cycles[2]!.low).toBeCloseTo(ladder.trough, 8);
  });

  it('rolls up off the days, so week buckets cannot leak across the month', () => {
    const weekly = buildLiquidityLadder(r, profile, { months: 3 });
    const daily = buildLiquidityLadder(r, profileWith({ granularity: 'day' }), {
      months: 3,
    });
    expect(weekly.cycles.map(c => c.outflow)).toEqual(daily.cycles.map(c => c.outflow));
    expect(weekly.cycles.map(c => c.low)).toEqual(daily.cycles.map(c => c.low));
  });
});

describe('sizing basis picks which funded cycle H* and the swap fund', () => {
  const r = row();
  const base = {
    rows: [r],
    usdCash: 900,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: 12 },
    activeLayers: new Set(['sigmaP'] as const),
    policyVAR: 5.0,
  };
  const on = (basis: 'cycle' | 'horizon'): ForecastProfileState =>
    profileWith({ granularity: 'week', sizingBasis: basis });

  const gbpFor = (basis: 'cycle' | 'horizon', months = 12) =>
    computeDashboardModel({
      ...base,
      shared: { ...base.shared, forecastMonths: months },
      forecastProfile: on(basis),
    }).fcyComputed.find(x => x.ccy === 'GBP')!;

  it('nearest cycle funds this cycle only', () => {
    const g = gbpFor('cycle');
    expect(g.lp_peak_cash).toBeCloseTo(41.8, 8);
    expect(g.troughCycleIndex).toBe(0);
    expect(g.cycleDrawdown).toBeCloseTo(90, 8);
  });

  it('worst cycle funds the deepest cycle of the funded path', () => {
    const near = gbpFor('cycle');
    const worst = gbpFor('horizon');
    expect(worst.lp_peak_cash).toBeLessThan(near.lp_peak_cash);
    expect(worst.troughCycleIndex).toBeGreaterThan(0);
    expect(worst.nearCycleTrough).toBeCloseTo(near.lp_peak_cash, 8);
    expect(worst.swapNear).toBeGreaterThan(near.swapNear);
    // Funded to the cushion at that deepest point, not merely to zero.
    expect(worst.lp_after_swap_trough!).toBeCloseTo(worst.cash_threshold_pre_swap, 8);
  });

  it('settles at the standing leg the structural drain needs', () => {
    const worst = gbpFor('horizon');
    // −30 a cycle has to be replaced every cycle: the rolling near leg is 30,
    // not the cumulative burn an unfunded path would report.
    expect(worst.swapNear).toBeCloseTo(30, 6);
  });

  it('does not grow the swap with the horizon once the path has settled', () => {
    expect(gbpFor('horizon', 24).swapNear).toBeCloseTo(gbpFor('horizon', 12).swapNear, 6);
    // Operating trough is the unfunded path — a longer drain goes deeper.
    expect(gbpFor('horizon', 24).lp_peak_cash).toBeLessThan(gbpFor('horizon', 12).lp_peak_cash);
  });

  it('a one-month horizon leaves both bases at the same number', () => {
    expect(gbpFor('horizon', 1).lp_peak_cash).toBeCloseTo(gbpFor('cycle', 1).lp_peak_cash, 8);
    expect(gbpFor('horizon', 1).swapNear).toBeCloseTo(gbpFor('cycle', 1).swapNear, 8);
  });

  it('publishes the funded plan behind the trough', () => {
    const plan = gbpFor('horizon').liquidityPlan!;
    expect(plan).toHaveLength(12);
    // Cycle 0 of the plan is the near cycle of the dated path.
    expect(plan[0]!.forecasted_cash).toBeCloseTo(41.8, 8);
    expect(plan[0]!.incremental_swap).toBe(0);
    // Later cycles need a bigger leg, and the extra is bookable today.
    const last = plan[11]!;
    expect(last.swap_needed).toBeCloseTo(30, 6);
    expect(last.incremental_swap).toBeCloseTo(last.swap_needed - plan[0]!.swap_needed, 6);
    // Each cycle opens where the funded one before it closed.
    expect(plan[1]!.opening_cash).toBeCloseTo(plan[0]!.cycle_end_cash, 8);
  });

  it('reports the drain even with the dated path off', () => {
    const off = computeDashboardModel({
      ...base,
      forecastProfile: {
        ...on('horizon'),
        liquidity: { ...on('horizon').liquidity!, enabled: false },
      },
    }).fcyComputed.find(x => x.ccy === 'GBP')!;
    expect(off.cycleDrawdown).toBeCloseTo(90, 8);
    expect(off.troughCycleIndex).toBeUndefined();
    expect(off.liquidityPlan).toBeUndefined();
  });

  it('turns the plan into a forward-dated funding schedule', () => {
    const plan = gbpFor('horizon').liquidityPlan!;
    const schedule = forwardSwapSchedule(plan);
    // One tranche per cycle that needs more than the leg booked today, each
    // value-dated at its own cycle.
    expect(schedule.length).toBeGreaterThan(0);
    for (const t of schedule) {
      expect(t.valueDateMonths).toBe(t.cycleIndex);
      expect(t.amount_fcy).toBeCloseTo(plan[t.cycleIndex]!.incremental_swap, 8);
    }
    // The largest tranche tops the near leg up to the standing size.
    const biggest = schedule.reduce((m, t) => Math.max(m, t.amount_fcy), 0);
    expect(plan[0]!.swap_needed + biggest).toBeCloseTo(30, 6);
  });

  it('leaves no funding schedule when every cycle covers its own trough', () => {
    const flush = computeDashboardModel({
      ...base,
      rows: [row({ cash: 400, collections: 90 })],
      forecastProfile: on('horizon'),
    }).fcyComputed.find(x => x.ccy === 'GBP')!;
    expect(forwardSwapSchedule(flush.liquidityPlan!)).toHaveLength(0);
  });
});

describe('every period starts on the target the book settled, not the raw layer sum', () => {
  const profile = profileWith({ granularity: 'week', sizingBasis: 'horizon' });
  const base = {
    rows: [row()],
    usdCash: 900,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: 12 },
    forecastProfile: profile,
  };
  const gbpFor = (layers: LayerId[], policyVAR: number, over: Partial<RowState> = {}) =>
    computeDashboardModel({
      ...base,
      rows: [row(over)],
      activeLayers: new Set(layers),
      policyVAR,
    }).fcyComputed.find(x => x.ccy === 'GBP')!;

  it('prices the funded cycle on the portfolio target, not the row-only layer sum', () => {
    // The VAR layer decides the level across the book, which the plan's own
    // per-currency stack cannot see: unanchored it funds ~19 above this target.
    const g = gbpFor(['sigmaP', 'carryOptim', 'portfolioDiv'], 5);
    expect(g.liquidityPlan![g.sizingCycleIndex!]!.cash_threshold)
      .toBeCloseTo(g.cash_threshold_pre_swap, 6);
    expect(g.lp_after_swap_trough!).toBeCloseTo(g.cash_threshold_pre_swap, 6);
  });

  it('carries the VAR verdict across the horizon, not just the funded cycle', () => {
    const loose = gbpFor(['sigmaP', 'carryOptim', 'portfolioDiv'], 20);
    const tight = gbpFor(['sigmaP', 'carryOptim', 'portfolioDiv'], 0.4);
    const targets = (g: typeof loose) => g.liquidityPlan!.map(p => p.post_swap_cash);
    // Same book, smaller budget: every period's starting target comes down.
    targets(tight).forEach((t, k) => expect(t).toBeLessThan(targets(loose)[k]!));
  });

  it('never trims a period below its floor and forecast cushion', () => {
    const tight = gbpFor(['sigmaP', 'carryOptim', 'portfolioDiv'], 0.05);
    tight.liquidityPlan!.forEach(p => {
      expect(p.cash_threshold).toBeGreaterThanOrEqual(
        p.layered.floor_contrib + p.layered.delta_sigma - 1e-9,
      );
    });
  });

  it('opens every period on a stated carry target once the carry layer is on', () => {
    const stated = gbpFor(['sigmaP', 'carryOptim'], 20, { carry_target: 150 });
    stated.liquidityPlan!.forEach(p => {
      expect(p.layered.carry_target_applied).toBe(true);
      // Opening balance + near leg — the target the desk stated, every cycle.
      expect(p.post_swap_cash).toBeCloseTo(150, 6);
    });
  });

  it('leaves the funded cycle on the row target when no layer is on', () => {
    const g = gbpFor([], 20);
    expect(g.swapNear).toBe(0);
    expect(g.liquidityPlan!.every(p => p.swap_needed === 0)).toBe(true);
  });
});

describe('an undated profile takes the default: dated, worst-case shapes', () => {
  const base = {
    usdCash: 900,
    usdNonLpCash: 154.1,
    usdParams: INITIAL_USD_PARAMS,
    activeLayers: new Set(['sigmaP'] as const),
    policyVAR: 5.0,
  };
  /** No `liquidity` block — the profile of someone who never opened the panel. */
  const undated: ForecastProfileState = { ...DEFAULT_FORECAST_PROFILE };
  const withExtras: ForecastProfileState = {
    ...DEFAULT_FORECAST_PROFILE,
    extrasByCcy: {
      GBP: {
        nwcIn: 25, nwcOut: -35, debtIn: 0, debtOut: -20,
        investIn: 0, investOut: 0, otherIn: 0, otherOut: 0,
      },
    },
  };
  const gbpFor = (profile: ForecastProfileState | undefined, months = 1) =>
    computeDashboardModel({
      ...base,
      rows: [row()],
      shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: months },
      forecastProfile: profile,
    }).fcyComputed.find(x => x.ccy === 'GBP')!;

  it('reports the lump-sum trough for a book of operating lines only', () => {
    const g = gbpFor(undated);
    expect(g.lp_peak_cash).toBeCloseTo(41.8, 8);
    expect(g.cycleDrawdown).toBeCloseTo(90, 8);
    expect(g.liquidityPlan).toHaveLength(1);
  });

  it('counts the NWC and debt lines the lump sum drops', () => {
    const g = gbpFor(withExtras);
    // 145 out against 85 in, so the trough sits below zero where cash + payout
    // alone would have shown +41.8.
    expect(g.cycleDrawdown).toBeCloseTo(145, 8);
    expect(g.lp_peak_cash).toBeCloseTo(-13.2, 8);
    expect(g.swapNear).toBeGreaterThan(gbpFor(undated).swapNear);
  });

  it('leaves a caller with no forecast profile on the lump sum', () => {
    const g = gbpFor(undefined, 12);
    expect(g.lp_peak_cash).toBeCloseTo(41.8, 8);
    expect(g.troughCycleIndex).toBeUndefined();
    expect(g.liquidityPlan).toBeUndefined();
  });

  it('still honours an explicit opt-out', () => {
    const off = gbpFor({
      ...withExtras,
      liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: false },
    });
    expect(off.lp_peak_cash).toBeCloseTo(41.8, 8);
    expect(off.liquidityPlan).toBeUndefined();
  });
});

describe('the forecast profile survives a dashboard save', () => {
  const withPath = profileWith({
    granularity: 'week',
    sizingBasis: 'horizon',
    byField: { payout: { from: 0, to: 4 / LADDER_DAYS_PER_MONTH, curve: 'back' } },
  });

  function dashboardWorkspace(): Workspace {
    return {
      entities: [{
        id: 'ent-1',
        name: 'NordTech UK',
        baseCurrency: 'GBP',
        description: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        dashboards: [
          { id: 'dash-1', name: 'FX', createdAt: '2026-01-01T00:00:00.000Z', riskProfiles: [] },
          { id: 'dash-2', name: 'Other', createdAt: '2026-01-01T00:00:00.000Z', riskProfiles: [] },
        ],
      }],
    };
  }

  it('stores the liquidity path on the dashboard it was configured on', () => {
    const ws = updateDashboardForecastProfile(dashboardWorkspace(), 'ent-1', 'dash-1', withPath);
    const [first, second] = ws.entities[0]!.dashboards;
    expect(first!.forecastProfile?.liquidity?.enabled).toBe(true);
    expect(first!.forecastProfile?.liquidity?.sizingBasis).toBe('horizon');
    expect(second!.forecastProfile).toBeUndefined();
  });

  it('comes back off the wire with the settlement windows intact', () => {
    const ws = updateDashboardForecastProfile(dashboardWorkspace(), 'ent-1', 'dash-1', withPath);
    const reloaded: Workspace = JSON.parse(JSON.stringify(ws));
    const saved = reloaded.entities[0]!.dashboards[0]!.forecastProfile!;
    expect(saved.liquidity?.byField?.payout).toEqual({
      from: 0,
      to: 4 / LADDER_DAYS_PER_MONTH,
      curve: 'back',
    });
    // And it still drives the same trough it did before the round-trip.
    const model = (profile: ForecastProfileState) =>
      computeDashboardModel({
        rows: [row()],
        usdCash: 900,
        usdNonLpCash: 154.1,
        usdParams: INITIAL_USD_PARAMS,
        shared: { r_USD: 3.5, σ_P: 0.1, days: 3, forecastMonths: 12 },
        activeLayers: new Set(['sigmaP'] as const),
        policyVAR: 5.0,
        forecastProfile: profile,
      }).fcyComputed.find(x => x.ccy === 'GBP')!;
    expect(model(saved).lp_peak_cash).toBeCloseTo(model(withPath).lp_peak_cash, 8);
  });
});
