// Intra-cycle liquidity ladder.
//
// The forecast profile carries MONTHLY amounts per cash line. That is enough for
// FX exposure buildup (F×T) but says nothing about when inside a month cash
// moves, so the liquidity book has to assume the worst case — every payout
// leaves before any payin arrives — and hard-code the trough as cash + payout.
//
// This module adds the missing dimension: each line gets a shape (a window
// inside its month plus a distribution curve), the monthly amount is spread over
// day slots accordingly, and the balance is run day by day. The trough is then
// the minimum of a real path and it has a date. Monthly totals are untouched by
// construction, so nothing on the FX / CFaR side changes.
//
// Note the timed path counts EVERY outflow line (payables, debt service, …),
// not just the operating payout that the lump-sum trough uses.

import {
  FORECAST_FLOW_LINES,
  flatMonthFlowAt,
  flowFieldValue,
  normalizeExtras,
  resizeMonthSeries,
  type ForecastFlowField,
  type ForecastFlowSide,
  type ForecastMonthFlow,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import { roundMoney, type RowState } from '@/lib/fx-buffer';

/** Day slots per month — matches the /30 convention used by the CFaR grid. */
export const LADDER_DAYS_PER_MONTH = 30;

export type LiquidityGranularity = 'day' | 'week' | 'month';

/** How an amount distributes across its window. */
export type FlowCurve = 'lump' | 'even' | 'front' | 'back';

/**
 * When a monthly line lands, as a window inside its own month.
 * `from` / `to` are fractions of the month (0 = 1st day, 1 = month end);
 * `from === to`, or `curve: 'lump'`, means a single-day settlement.
 */
export interface FlowShape {
  from: number;
  to: number;
  curve: FlowCurve;
}

/**
 * Hedge settlement — the FCY leg of booked and prepared hedges landing on the
 * path. Deliberately not a `ForecastFlowField`: the amounts come from the hedge
 * book rather than the forecast, and folding it into the forecast lines would
 * double-count it in the monthly series that feed FX exposure, VaR and CFaR.
 */
export const HEDGE_SETTLE_LINE = 'hedgeSettle';

/** Any line the dated path can carry — forecast inputs plus hedge settlement. */
export type LiquidityLineKey = ForecastFlowField | typeof HEDGE_SETTLE_LINE;

/**
 * Signed hedge settlement per month, per currency (M FCY, index 0 = month 1).
 * Positive = FCY received at settle, negative = FCY delivered.
 */
export type HedgeSettleByCcy = Record<string, readonly number[]>;

/**
 * Which low H* and the swap size against.
 *   `cycle`   — the nearest cycle only: fund this cycle and roll the next one.
 *   `horizon` — the worst cycle in the forecast: fund the deepest point visible,
 *               so a drain that repeats every cycle is funded before it bites.
 */
export type LiquiditySizingBasis = 'cycle' | 'horizon';

export const SIZING_BASIS_OPTIONS: {
  id: LiquiditySizingBasis;
  label: string;
  hint: string;
}[] = [
  {
    id: 'cycle',
    label: 'Nearest cycle',
    hint: 'Fund this cycle and roll the next one — the swap covers the low of cycle M1 only',
  },
  {
    id: 'horizon',
    label: 'Worst cycle',
    hint: 'Fund the deepest point in the forecast — a drain that repeats every cycle is funded before it bites',
  },
];

/**
 * How the near leg reaches the desk. Sizing basis picks WHICH low to cover;
 * this picks how the cover is bought, and the two are independent.
 *   `rolling` — a leg per cycle, each rolled at maturity. Only the cash the next
 *               cycle needs is drawn, so nothing sits idle, but a drain that
 *               repeats leaves an outstanding book growing by a leg each cycle.
 *   `term`    — one swap today, near leg sized to the deepest requirement on the
 *               whole horizon and the far leg at its end. No rollover risk and
 *               one set of points, at the cost of carrying cover before it bites.
 */
export type LiquidityBookingMode = 'rolling' | 'term';

export const BOOKING_MODE_OPTIONS: {
  id: LiquidityBookingMode;
  label: string;
  hint: string;
}[] = [
  {
    id: 'rolling',
    label: 'Rolling legs',
    hint: 'A near leg per cycle, each rolled at maturity — nothing sits idle, but a repeating drain leaves an outstanding book growing by a leg every cycle',
  },
  {
    id: 'term',
    label: 'One term swap',
    hint: 'One swap booked today covering the deepest requirement on the whole horizon — no rollover risk and one set of points, at the cost of carrying cover before it bites',
  },
];

/** Persisted intra-cycle timing config (lives on the forecast profile). */
export interface LiquidityTiming {
  /**
   * Off → the liquidity book keeps its lump-sum trough (cash + payout), which
   * also drops NWC, debt, investing and hedge settlement out of the trough and
   * leaves no per-cycle funding plan behind it.
   */
  enabled: boolean;
  granularity: LiquidityGranularity;
  /** Defaults to the worst cycle in the horizon. */
  sizingBasis?: LiquiditySizingBasis;
  /** Defaults to a leg per cycle, rolled. */
  bookingMode?: LiquidityBookingMode;
  /** Applied to every line of that side unless overridden. */
  defaults: Record<ForecastFlowSide, FlowShape>;
  /** Per-line override, all currencies. */
  byField?: Partial<Record<LiquidityLineKey, FlowShape>>;
  /** Per-currency, per-line override — wins over `byField`. */
  byCcy?: Record<string, Partial<Record<LiquidityLineKey, FlowShape>>>;
}

/** Worst case, and the exact assumption the lump-sum trough encodes. */
export const WORST_CASE_TIMING: Record<ForecastFlowSide, FlowShape> = {
  out: { from: 0, to: 0, curve: 'lump' },
  in: { from: 1, to: 1, curve: 'lump' },
};

/**
 * On by default, with worst-case shapes: for a profile nobody has dated yet this
 * reports the same trough the lump sum does, while still counting the lines the
 * lump sum ignores (NWC, debt, investing, hedge settlement) and leaving a funded
 * per-cycle plan behind the number.
 */
export const DEFAULT_LIQUIDITY_TIMING: LiquidityTiming = {
  enabled: true,
  granularity: 'week',
  sizingBasis: 'horizon',
  bookingMode: 'rolling',
  defaults: { ...WORST_CASE_TIMING },
  byField: {},
  byCcy: {},
};

/**
 * The timing block in force for a profile. A profile carrying no block has not
 * been dated by hand and takes the default; no profile at all means there is no
 * flow schedule to date, so the caller keeps its lump-sum trough.
 */
export function resolveLiquidityTiming(
  profile?: ForecastProfileState | null,
): LiquidityTiming | null {
  if (!profile) return null;
  return profile.liquidity ?? DEFAULT_LIQUIDITY_TIMING;
}

export interface LadderBucket {
  index: number;
  /** Day offsets from the start of the horizon, both inclusive. */
  startDay: number;
  endDay: number;
  label: string;
  /** Gross inflow in the bucket (≥ 0). */
  inflow: number;
  /** Gross outflow in the bucket, as a magnitude (≥ 0). */
  outflow: number;
  net: number;
  opening: number;
  closing: number;
  /** Worst point inside the bucket — after outflows, before inflows. */
  low: number;
  belowFloor: boolean;
}

/**
 * One cycle of the path rolled up — how much leaves, how deep it dips and where
 * the balance is left. The drawdown is the answer to "how much cash does this
 * cycle actually consume", which the closing balance alone does not say.
 */
export interface LadderCycle {
  /** 0-based cycle index; 0 = the nearest cycle. */
  index: number;
  label: string;
  startDay: number;
  endDay: number;
  opening: number;
  /** Gross inflow across the cycle (≥ 0). */
  inflow: number;
  /** Gross outflow across the cycle, as a magnitude (≥ 0). */
  outflow: number;
  net: number;
  /** Worst point inside the cycle (post-outflow, pre-inflow). */
  low: number;
  lowDay: number;
  /** opening − low: the cash the cycle drains at its deepest (≥ 0). */
  drawdown: number;
  closing: number;
  daysBelowFloor: number;
}

export interface LiquidityLadderResult {
  granularity: LiquidityGranularity;
  months: number;
  floor: number;
  opening: number;
  buckets: LadderBucket[];
  /** Cycle-by-cycle roll-up of the same path, one entry per forecast month. */
  cycles: LadderCycle[];
  /**
   * Index into `cycles` of the deepest low over the horizon.
   *
   * On this path no cycle is ever funded, so on a structurally negative book the
   * deepest low is always the last cycle. Sizing reads the funded projection
   * instead (`projectLiquidityCycles` with these cycle shapes), where each cycle
   * opens where its own near leg left it.
   */
  worstCycleIndex: number;
  /** Minimum of the whole path (post-outflow, pre-inflow). */
  trough: number;
  /** Day offset of the trough. */
  troughDay: number;
  /** Index of the bucket holding the trough. */
  troughBucket: number;
  /**
   * Minimum inside cycle 1 — what the swap near leg and H* size against.
   * Over a multi-month horizon the overall trough is usually the cumulative
   * drift low at the far end, which is a forecast signal, not a funding need.
   */
  cycleTrough: number;
  cycleTroughDay: number;
  /** LP balance at the end of cycle 1 — every month-1 line settled. */
  cycleClosing: number;
  /** Days below the floor inside cycle 1. */
  cycleDaysBelowFloor: number;
  /** Balance at the end of the horizon. */
  closing: number;
  /** Days in cycle 1 — one month of the ladder. */
  cycleDays: number;
  /** End-of-day balance for every day of the horizon — the basis for carry. */
  closingByDay: number[];
  /** First day carrying an outflow in cycle 1 (−1 when the cycle has none). */
  cycleStartDay: number;
  /** Last day carrying an inflow in cycle 1 (−1 when the cycle has none). */
  cycleEndDay: number;
  daysBelowFloor: number;
}

export interface LadderOptions {
  months: number;
  granularity?: LiquidityGranularity;
  /** Opening balance — LP cash for the sizing trough. */
  opening?: number;
  floor?: number;
  /**
   * Signed hedge settlement for this currency, month by month (index 0 = month
   * 1). Kept separate from the forecast lines because it is derived from the
   * hedge book; see `HEDGE_SETTLE_LINE`.
   */
  hedgeSettle?: readonly number[];
}

const clamp01 = (v: number): number =>
  !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;

const SIDE_BY_FIELD = Object.fromEntries(
  FORECAST_FLOW_LINES.map(l => [l.key, l.side]),
) as Record<ForecastFlowField, ForecastFlowSide>;

export function flowFieldSide(field: ForecastFlowField): ForecastFlowSide {
  return SIDE_BY_FIELD[field] ?? 'in';
}

/** Hedge settlement is a delivery or a receipt depending on the sign. */
export function hedgeSettleSide(amount: number): ForecastFlowSide {
  return amount >= 0 ? 'in' : 'out';
}

export function normalizeFlowShape(
  shape: Partial<FlowShape> | null | undefined,
  fallback: FlowShape,
): FlowShape {
  if (!shape) return { ...fallback };
  const from = clamp01(shape.from ?? fallback.from);
  const to = clamp01(shape.to ?? fallback.to);
  return {
    from: Math.min(from, to),
    to: Math.max(from, to),
    curve: shape.curve ?? fallback.curve,
  };
}

/**
 * Effective shape for one currency × line: per-CCY → per-field → side default.
 * `sideOverride` is for lines whose side follows the amount rather than the line
 * definition, i.e. hedge settlement.
 */
export function resolveFlowShape(
  timing: LiquidityTiming | null | undefined,
  ccy: string,
  field: LiquidityLineKey,
  sideOverride?: ForecastFlowSide,
): FlowShape {
  const side = sideOverride ?? flowFieldSide(field as ForecastFlowField);
  const sideDefault = normalizeFlowShape(
    timing?.defaults?.[side],
    WORST_CASE_TIMING[side],
  );
  const perField = timing?.byField?.[field];
  const perCcy = timing?.byCcy?.[ccy]?.[field];
  return normalizeFlowShape(perCcy ?? perField, sideDefault);
}

/** Day index inside a month (0 … LADDER_DAYS_PER_MONTH − 1) for a fraction. */
export function dayOfMonthForFraction(f: number): number {
  const raw = Math.floor(clamp01(f) * LADDER_DAYS_PER_MONTH);
  return Math.min(LADDER_DAYS_PER_MONTH - 1, Math.max(0, raw));
}

/** Weights across n slots, summing to 1. */
function curveWeights(n: number, curve: FlowCurve): number[] {
  if (n <= 1) return [1];
  if (curve === 'front' || curve === 'back') {
    const ramp = Array.from({ length: n }, (_, i) =>
      curve === 'front' ? n - i : i + 1,
    );
    const total = ramp.reduce((s, w) => s + w, 0);
    return ramp.map(w => w / total);
  }
  return Array.from({ length: n }, () => 1 / n);
}

/** Spread one monthly amount over its day slots. */
function spreadOverDays(
  target: number[],
  amount: number,
  monthIndex: number,
  shape: FlowShape,
): void {
  if (!(Math.abs(amount) > 0)) return;
  const monthStart = monthIndex * LADDER_DAYS_PER_MONTH;
  const from = dayOfMonthForFraction(shape.from);
  const to = dayOfMonthForFraction(shape.to);
  if (shape.curve === 'lump' || to <= from) {
    target[monthStart + from] += amount;
    return;
  }
  const n = to - from + 1;
  const weights = curveWeights(n, shape.curve);
  for (let i = 0; i < n; i += 1) {
    target[monthStart + from + i] += amount * weights[i]!;
  }
}

/**
 * Per-line monthly flows for a row — the same resolution the monthly inflow /
 * outflow series use, so bucket sums agree with them month by month.
 */
export function monthFlowSeriesForRow(
  row: RowState,
  months: number,
  profile?: ForecastProfileState | null,
): ForecastMonthFlow[] {
  const T = Math.max(0, Math.floor(months));
  if (T === 0) return [];
  if (profile?.mode === 'custom') {
    return resizeMonthSeries(
      profile.byCcy[row.ccy],
      T,
      row,
      profile.extrasByCcy?.[row.ccy],
    );
  }
  const extras = normalizeExtras(profile?.extrasByCcy?.[row.ccy]);
  return Array.from({ length: T }, (_, k) =>
    flatMonthFlowAt(row, extras, profile, k),
  );
}

const BUCKET_DAYS: Record<LiquidityGranularity, number> = {
  day: 1,
  week: 7,
  month: LADDER_DAYS_PER_MONTH,
};

const BUCKET_PREFIX: Record<LiquidityGranularity, string> = {
  day: 'D',
  week: 'W',
  month: 'M',
};

/**
 * Run the dated cash path for one currency and bucket it.
 *
 * Inside a bucket outflows settle before inflows, so a coarser granularity
 * reports the same trough as a daily one instead of netting the dip away.
 */
export function buildLiquidityLadder(
  row: RowState,
  profile: ForecastProfileState | null | undefined,
  opts: LadderOptions,
): LiquidityLadderResult {
  const timing = resolveLiquidityTiming(profile);
  const granularity = opts.granularity ?? timing?.granularity ?? 'week';
  // A cycle always exists, even with no forecast period (T = 0).
  const months = Math.max(1, Math.floor(opts.months) || 0);
  const totalDays = months * LADDER_DAYS_PER_MONTH;
  const opening = opts.opening ?? row.cash;
  const floor = opts.floor ?? row.cash_floor ?? 0;

  const inByDay = new Array<number>(totalDays).fill(0);
  const outByDay = new Array<number>(totalDays).fill(0);

  const monthFlows = monthFlowSeriesForRow(row, months, profile);
  monthFlows.forEach((flow, monthIndex) => {
    for (const line of FORECAST_FLOW_LINES) {
      const raw = flowFieldValue(flow, line.key);
      if (!(Math.abs(raw) > 0)) continue;
      const shape = resolveFlowShape(timing, row.ccy, line.key);
      // Signs follow RowState: inflows ≥ 0, outflows ≤ 0. Split them so a
      // mis-signed entry lands on the side it actually behaves as.
      if (raw > 0) spreadOverDays(inByDay, raw, monthIndex, shape);
      else spreadOverDays(outByDay, -raw, monthIndex, shape);
    }
  });

  // Hedge settlement lands like any other dated line: a forward delivering FCY
  // draws the balance down on its settlement date, a receipt tops it up.
  if (opts.hedgeSettle) {
    for (let monthIndex = 0; monthIndex < months; monthIndex += 1) {
      const raw = opts.hedgeSettle[monthIndex] ?? 0;
      if (!(Math.abs(raw) > 0)) continue;
      const shape = resolveFlowShape(
        timing, row.ccy, HEDGE_SETTLE_LINE, hedgeSettleSide(raw),
      );
      if (raw > 0) spreadOverDays(inByDay, raw, monthIndex, shape);
      else spreadOverDays(outByDay, -raw, monthIndex, shape);
    }
  }

  const cycleDays = Math.min(totalDays, LADDER_DAYS_PER_MONTH);
  let balance = opening;
  let trough = Number.POSITIVE_INFINITY;
  let troughDay = 0;
  let daysBelowFloor = 0;
  let cycleTrough = Number.POSITIVE_INFINITY;
  let cycleTroughDay = 0;
  let cycleDaysBelowFloor = 0;
  const lowByDay = new Array<number>(totalDays).fill(0);
  const closingByDay = new Array<number>(totalDays).fill(0);

  for (let d = 0; d < totalDays; d += 1) {
    balance -= outByDay[d]!;
    lowByDay[d] = balance;
    if (balance < trough) {
      trough = balance;
      troughDay = d;
    }
    const belowFloor = balance < floor - 1e-9;
    if (belowFloor) daysBelowFloor += 1;
    if (d < cycleDays) {
      if (balance < cycleTrough) {
        cycleTrough = balance;
        cycleTroughDay = d;
      }
      if (belowFloor) cycleDaysBelowFloor += 1;
    }
    balance += inByDay[d]!;
    closingByDay[d] = balance;
  }

  const bucketDays = BUCKET_DAYS[granularity];
  const bucketCount = Math.ceil(totalDays / bucketDays);
  const buckets: LadderBucket[] = [];
  let troughBucket = 0;

  for (let b = 0; b < bucketCount; b += 1) {
    const startDay = b * bucketDays;
    const endDay = Math.min(totalDays - 1, startDay + bucketDays - 1);
    let inflow = 0;
    let outflow = 0;
    let low = Number.POSITIVE_INFINITY;
    for (let d = startDay; d <= endDay; d += 1) {
      inflow += inByDay[d]!;
      outflow += outByDay[d]!;
      if (lowByDay[d]! < low) low = lowByDay[d]!;
    }
    const bucketOpening = startDay === 0 ? opening : closingByDay[startDay - 1]!;
    const closing = closingByDay[endDay]!;
    if (troughDay >= startDay && troughDay <= endDay) troughBucket = b;
    buckets.push({
      index: b,
      startDay,
      endDay,
      label: `${BUCKET_PREFIX[granularity]}${b + 1}`,
      inflow: roundMoney(inflow),
      outflow: roundMoney(outflow),
      net: roundMoney(inflow - outflow),
      opening: roundMoney(bucketOpening),
      closing: roundMoney(closing),
      low: roundMoney(low),
      belowFloor: low < floor - 1e-9,
    });
  }

  // Cycle-by-cycle roll-up. Built off the day arrays rather than the buckets,
  // whose weekly boundaries do not line up with the month.
  const cycles: LadderCycle[] = [];
  let worstCycleIndex = 0;
  for (let c = 0; c * LADDER_DAYS_PER_MONTH < totalDays; c += 1) {
    const startDay = c * LADDER_DAYS_PER_MONTH;
    const endDay = Math.min(totalDays - 1, startDay + LADDER_DAYS_PER_MONTH - 1);
    let inflow = 0;
    let outflow = 0;
    let low = Number.POSITIVE_INFINITY;
    let lowDay = startDay;
    let cycleBelowFloor = 0;
    for (let d = startDay; d <= endDay; d += 1) {
      inflow += inByDay[d]!;
      outflow += outByDay[d]!;
      if (lowByDay[d]! < low) {
        low = lowByDay[d]!;
        lowDay = d;
      }
      if (lowByDay[d]! < floor - 1e-9) cycleBelowFloor += 1;
    }
    const cycleOpening = startDay === 0 ? opening : closingByDay[startDay - 1]!;
    cycles.push({
      index: c,
      label: `M${c + 1}`,
      startDay,
      endDay,
      opening: roundMoney(cycleOpening),
      inflow: roundMoney(inflow),
      outflow: roundMoney(outflow),
      net: roundMoney(inflow - outflow),
      low: roundMoney(low),
      lowDay,
      drawdown: roundMoney(Math.max(0, cycleOpening - low)),
      closing: roundMoney(closingByDay[endDay]!),
      daysBelowFloor: cycleBelowFloor,
    });
    if (cycles[c]!.low < cycles[worstCycleIndex]!.low) worstCycleIndex = c;
  }

  // Cycle window — first payout to last payin within cycle 1.
  let cycleStartDay = -1;
  let cycleEndDay = -1;
  for (let d = 0; d < cycleDays; d += 1) {
    if (cycleStartDay < 0 && outByDay[d]! > 0) cycleStartDay = d;
    if (inByDay[d]! > 0) cycleEndDay = d;
  }

  return {
    granularity,
    months,
    floor,
    opening: roundMoney(opening),
    buckets,
    cycles,
    worstCycleIndex,
    trough: roundMoney(Number.isFinite(trough) ? trough : opening),
    troughDay,
    troughBucket,
    cycleTrough: roundMoney(Number.isFinite(cycleTrough) ? cycleTrough : opening),
    cycleTroughDay,
    cycleClosing: roundMoney(closingByDay[cycleDays - 1] ?? opening),
    cycleDaysBelowFloor,
    closing: roundMoney(balance),
    cycleDays,
    closingByDay,
    cycleStartDay,
    cycleEndDay,
    daysBelowFloor,
  };
}

/** Cycle window implied by the shapes alone, independent of amounts. */
export function shapeCycleWindow(
  timing: LiquidityTiming | null | undefined,
  ccy: string,
): { startDay: number; endDay: number; lengthDays: number } {
  let startDay = LADDER_DAYS_PER_MONTH - 1;
  let endDay = 0;
  for (const line of FORECAST_FLOW_LINES) {
    const shape = resolveFlowShape(timing, ccy, line.key);
    const from = dayOfMonthForFraction(shape.from);
    const to = shape.curve === 'lump' ? from : dayOfMonthForFraction(shape.to);
    if (line.side === 'out') startDay = Math.min(startDay, from);
    else endDay = Math.max(endDay, to);
  }
  if (endDay < startDay) endDay = startDay;
  return { startDay, endDay, lengthDays: endDay - startDay + 1 };
}

export interface CarrySplit {
  /** Mean of the positive part of the balance — earns the credit rate. */
  avgCredit: number;
  /** Mean of the negative part of the balance (≤ 0) — pays the debit rate. */
  avgDebit: number;
  creditDays: number;
  debitDays: number;
}

/**
 * Split a dated path into its credit and debit halves so carry can price a
 * balance that changes sign mid-cycle. A single average balance cannot: 20 days
 * overdrawn followed by 10 days in credit averages to a positive number and
 * earns the credit rate for the whole month, which is the wrong rate and often
 * the wrong sign.
 *
 * Interest accrues on the end-of-day balance. `shift` moves every day at once —
 * a funding swap lands before the first payout, so it lifts the whole path.
 */
export function carrySplitFromBalances(balances: number[], shift = 0): CarrySplit {
  const days = balances.length;
  if (days <= 0) return { avgCredit: 0, avgDebit: 0, creditDays: 0, debitDays: 0 };
  let credit = 0;
  let debit = 0;
  let creditDays = 0;
  let debitDays = 0;
  for (let d = 0; d < days; d += 1) {
    const balance = balances[d]! + shift;
    if (balance >= 0) {
      credit += balance;
      creditDays += 1;
    } else {
      debit += balance;
      debitDays += 1;
    }
  }
  return { avgCredit: credit / days, avgDebit: debit / days, creditDays, debitDays };
}

/** Credit / debit split across cycle 1 of a ladder. */
export function cycleCarrySplit(ladder: LiquidityLadderResult, shift = 0): CarrySplit {
  const days = Math.min(ladder.cycleDays, ladder.closingByDay.length);
  return carrySplitFromBalances(ladder.closingByDay.slice(0, Math.max(0, days)), shift);
}

/**
 * End-of-day balances for one month of explicit signed amounts, dated by the
 * shapes configured for `ccy`. Outflows settle before inflows inside a day, as
 * in `buildLiquidityLadder`.
 *
 * The multi-cycle projection needs this rather than a horizon ladder: it grows
 * its own amounts per cycle and chains its own opening balance through the
 * funding swaps, so its path is not a slice of the row's ladder.
 */
export function datedMonthBalances(
  opening: number,
  lines: { field: LiquidityLineKey; amount: number }[],
  timing: LiquidityTiming | null | undefined,
  ccy: string,
): number[] {
  const inByDay = new Array<number>(LADDER_DAYS_PER_MONTH).fill(0);
  const outByDay = new Array<number>(LADDER_DAYS_PER_MONTH).fill(0);
  for (const { field, amount } of lines) {
    if (!(Math.abs(amount) > 0)) continue;
    const shape = resolveFlowShape(
      timing,
      ccy,
      field,
      field === HEDGE_SETTLE_LINE ? hedgeSettleSide(amount) : undefined,
    );
    if (amount > 0) spreadOverDays(inByDay, amount, 0, shape);
    else spreadOverDays(outByDay, -amount, 0, shape);
  }
  const closing = new Array<number>(LADDER_DAYS_PER_MONTH).fill(0);
  let balance = opening;
  for (let d = 0; d < LADDER_DAYS_PER_MONTH; d += 1) {
    balance -= outByDay[d]!;
    balance += inByDay[d]!;
    closing[d] = balance;
  }
  return closing;
}

/** `D1`, `D12` … as a 1-based day label for display. */
export function dayLabel(day: number): string {
  return `D${day + 1}`;
}
