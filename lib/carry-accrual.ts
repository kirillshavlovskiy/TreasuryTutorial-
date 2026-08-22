// Buffer Carry target — day-count conventions and the per-period lifecycle
// projection behind the carryOptim layer.
//
// The layer steers Target LP Cash so the funding-swap standing book earns a
// Buffer Carry (cash Δr vs USD). The desk column and this lifecycle both price
// that same leg:
//
//   buffer_carry_m = standing_m × spot × (r_FCY|r_OD − r_USD) / 100 / 12
//
// TWA LP cash accrual (float NIM) is a separate unfunded view — not what this
// layer targets.

import {
  CURRENCY_PARAMS,
  fundingSwapMonthCarryUsdM,
  type LayerId,
  type RowState,
  type SharedGlobals,
} from './fx-buffer';
import {
  projectLiquidityCycles,
  type ForecastProfileState,
  type LiquidityCycleProjection,
} from './forecast-profile';
import {
  carrySplitFromBalances,
  datedMonthBalances,
  HEDGE_SETTLE_LINE,
  resolveLiquidityTiming,
  type CarrySplit,
  type LiquidityTiming,
} from './liquidity-ladder';

/** Money-market day-count denominator. */
export type DayCountBasis = 360 | 365;

/**
 * Currencies whose money market accrues ACT/365 (fixed). Everything else in the
 * book — EUR, USD, JPY, CHF, and the CEE/Nordic/LatAm set — accrues ACT/360.
 */
const ACT_365_CCY: ReadonlySet<string> = new Set([
  'GBP', 'AUD', 'NZD', 'CAD', 'HKD', 'SGD', 'ZAR', 'PLN', 'THB', 'ILS',
]);

export function carryBasis(ccy: string): DayCountBasis {
  return ACT_365_CCY.has(ccy) ? 365 : 360;
}

export function carryBasisLabel(ccy: string): 'ACT/360' | 'ACT/365' {
  return carryBasis(ccy) === 365 ? 'ACT/365' : 'ACT/360';
}

/** Actual calendar days in the month `monthIndex` months ahead of `from`. */
export function monthAccrualDays(monthIndex: number, from: Date = new Date()): number {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + monthIndex + 1, 0),
  ).getUTCDate();
}

/** Year fraction for month `monthIndex` on this currency's convention. */
export function accrualFactor(ccy: string, monthIndex: number, from?: Date): number {
  return monthAccrualDays(monthIndex, from) / carryBasis(ccy);
}

/**
 * Where payouts and collections sit inside the cycle. `0` = the whole month is
 * accrued on the post-swap target, `1` = the flow lands immediately. Mid-cycle
 * (0.5) is the default the simulator assumes when no timing profile is supplied.
 */
export interface CarryFlowTiming {
  payout: number;
  payin: number;
}

export const MID_CYCLE_TIMING: CarryFlowTiming = { payout: 0.5, payin: 0.5 };

export interface CarryPeriod {
  /** 0-based month offset from today; 0 = the near cycle. */
  monthIndex: number;
  /** `M1`, `M2`, … */
  label: string;
  days: number;
  /** days / basis */
  dcf: number;
  openingCash: number;
  payout: number;
  collections: number;
  /** Target LP Cash for this cycle (M FCY) = opening + swap. */
  targetCash: number;
  /** Near-leg swap this cycle needs to reach the target (M FCY). */
  swap: number;
  /** Post-payout cushion H* (M FCY). */
  cushion: number;
  /** Cash carried into the next cycle (M FCY). */
  endCash: number;
  /** Time-weighted balance the interest actually accrues on (M FCY). */
  twaCash: number;
  /**
   * LP credit rate when long, debit rate when overdrawn (% p.a.). With intra-cycle
   * timing configured the cycle can sit on both sides of zero, and this is the
   * effective blend the split actually earns — see `creditDays` / `debitDays`.
   */
  rateApplied: number;
  /** Days of the cycle spent in credit — only set when the path is dated. */
  creditDays?: number;
  /** Days of the cycle spent overdrawn — only set when the path is dated. */
  debitDays?: number;
  /** Interest earned on the TWA LP cash balance at `rateApplied` ($USD M). */
  grossAccrualUsd: number;
  /** TWA LP cash carry vs USD ($USD M) — unfunded view; not the layer target. */
  carryVsUsd: number;
  /** Running sum of `carryVsUsd` through this period ($USD M). */
  cumCarryVsUsd: number;
  /** Running sum of `grossAccrualUsd` ($USD M). */
  cumGrossAccrualUsd: number;
  /**
   * Buffer Carry this cycle ($USD M) — cash Δr vs USD on `standing_swap`.
   * Same basis as the desk Buffer Carry column (one month of the path Σ).
   */
  bufferCarryUsd: number;
  /** Running sum of `bufferCarryUsd` through this period ($USD M). */
  cumBufferCarryUsd: number;
}

export interface CarryLifecycleOptions {
  timing?: CarryFlowTiming;
  /** Reference date for the calendar day counts. Defaults to now. */
  from?: Date;
  /** FCY leg of hedges settling in each cycle (signed, + = received). */
  hedgeSettle?: readonly number[];
  /**
   * The book's own funded plan for a trial row, when the caller has one.
   *
   * `projectLiquidityCycles` alone cannot see the ladder shape, the booking
   * convention, the portfolio book-target rebalance or the CFaR cover, so a
   * projection built here would price a different standing book than the desk
   * Buffer Carry column reads off `liquidityPlan`. Injecting the desk builder
   * keeps the ask and the column on one engine. Return null to fall back.
   */
  planFor?: (row: RowState, months: number) => LiquidityCycleProjection[] | null;
}

/** Time-weighted balance for a cycle: target funded up front, then flows land. */
export function twaBalance(
  targetCash: number,
  payout: number,
  collections: number,
  timing: CarryFlowTiming = MID_CYCLE_TIMING,
): number {
  return targetCash + payout * (1 - timing.payout) + collections * (1 - timing.payin);
}

/** LP credit rate when the balance is long, debit rate when it is overdrawn. */
export function rateForBalance(balance: number, r_FCY: number, r_OD: number): number {
  return balance >= 0 ? r_FCY : r_OD;
}

/** Rate spread earned per unit of average balance, as a fraction. */
function splitAccrual(
  split: CarrySplit,
  r_FCY: number,
  r_OD: number,
  r_USD: number,
): number {
  return (split.avgCredit * (r_FCY - r_USD) + split.avgDebit * (r_OD - r_USD)) / 100;
}

/**
 * Effective rate a split earns. Reported so the projection's rate column stays
 * reconcilable with its accrual; a cycle balanced exactly around zero has no
 * meaningful blend, so it reports the side it spent time on.
 */
function blendedRate(split: CarrySplit, r_FCY: number, r_OD: number): number {
  const balance = split.avgCredit + split.avgDebit;
  if (Math.abs(balance) < 1e-9) return split.debitDays > 0 ? r_OD : r_FCY;
  return (split.avgCredit * r_FCY + split.avgDebit * r_OD) / balance;
}

/** Dated end-of-day balances for one projected cycle, funded by its own swap. */
function cycleBalances(
  ccy: string,
  cycle: {
    post_swap_cash: number;
    payout: number;
    collections: number;
    invoiceFcast: number;
    hedgeSettle: number;
  },
  timing: LiquidityTiming,
): number[] {
  return datedMonthBalances(
    cycle.post_swap_cash,
    [
      { field: 'payout', amount: cycle.payout },
      { field: 'collections', amount: cycle.collections },
      { field: 'invoiceFcast', amount: cycle.invoiceFcast },
      { field: HEDGE_SETTLE_LINE, amount: cycle.hedgeSettle },
    ],
    timing,
    ccy,
  );
}

/**
 * Per-period target cash and interest accrual across the forecast lifecycle.
 *
 * Cash targets come from `projectLiquidityCycles`, so every period runs the same
 * layer stack (floor, σ, carry target, portfolio VAR) as the live book — the
 * projection is the buffer model rolled forward, not a parallel model.
 */
export function projectCarryLifecycle(
  row: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  months: number,
  forecastProfile?: ForecastProfileState | null,
  options: CarryLifecycleOptions = {},
): CarryPeriod[] {
  const timing = options.timing ?? MID_CYCLE_TIMING;
  const spot = CURRENCY_PARAMS[row.ccy]?.spot ?? 0;
  const cycles = options.planFor?.(row, months)
    ?? projectLiquidityCycles(
      row, shared, activeLayers, months, forecastProfile, options.hedgeSettle,
    );

  let cumCarry = 0;
  let cumGross = 0;
  let cumBuffer = 0;

  const resolved = resolveLiquidityTiming(forecastProfile);
  const dated = resolved?.enabled ? resolved : null;

  return cycles.map(c => {
    const days = monthAccrualDays(c.cycleIndex, options.from);
    const dcf = days / carryBasis(row.ccy);
    // Dated: each day accrues on its own side of zero, so a cycle that dips
    // into overdraft and recovers pays the debit rate only for the days it is
    // actually overdrawn. The split is an average balance over the cycle, and
    // dcf carries the calendar length, so the two compose as before.
    const split = dated
      ? carrySplitFromBalances(cycleBalances(row.ccy, c, dated))
      : null;
    // Undated, the hedge leg is weighted like the flow it behaves as: a delivery
    // leaves on the payout timing, a receipt arrives on the payin timing.
    const twaCash = split
      ? split.avgCredit + split.avgDebit
      : twaBalance(c.post_swap_cash, c.payout, c.collections, timing)
        + c.hedgeSettle * (1 - (c.hedgeSettle < 0 ? timing.payout : timing.payin));
    const rateApplied = split
      ? blendedRate(split, row.r_FCY, row.r_OD)
      : rateForBalance(twaCash, row.r_FCY, row.r_OD);
    const grossAccrualUsd = split
      ? splitAccrual(split, row.r_FCY, row.r_OD, 0) * spot * dcf
      : twaCash * spot * (rateApplied / 100) * dcf;
    const carryVsUsd = split
      ? splitAccrual(split, row.r_FCY, row.r_OD, shared.r_USD) * spot * dcf
      : twaCash * spot * ((rateApplied - shared.r_USD) / 100) * dcf;
    const bufferCarryUsd = fundingSwapMonthCarryUsdM(
      c.standing_swap, spot, row.r_FCY, shared.r_USD, row.r_OD, 'cashDelta',
    );
    cumCarry += carryVsUsd;
    cumGross += grossAccrualUsd;
    cumBuffer += bufferCarryUsd;

    return {
      monthIndex: c.cycleIndex,
      label: `M${c.cycleIndex + 1}`,
      days,
      dcf,
      openingCash: c.opening_cash,
      payout: c.payout,
      collections: c.collections,
      targetCash: c.post_swap_cash,
      swap: c.swap_needed,
      cushion: c.cash_threshold,
      endCash: c.cycle_end_cash,
      twaCash,
      rateApplied,
      creditDays: split?.creditDays,
      debitDays: split?.debitDays,
      grossAccrualUsd,
      carryVsUsd,
      cumCarryVsUsd: cumCarry,
      cumGrossAccrualUsd: cumGross,
      bufferCarryUsd,
      cumBufferCarryUsd: cumBuffer,
    };
  });
}

export interface CarrySolveInput {
  ccy: string;
  r_FCY: number;
  r_OD: number;
  r_USD: number;
  payout: number;
  collections: number;
  invoiceFcast?: number;
  /** FCY leg of hedges settling in this cycle (signed, + = received). */
  hedgeSettle?: number;
  monthIndex?: number;
  timing?: CarryFlowTiming;
  /**
   * Intra-cycle settlement timing. When set, the solve runs on the dated path
   * instead of one average balance, so it agrees with the lifecycle projection.
   */
  liquidity?: LiquidityTiming | null;
  from?: Date;
}

/** Dated balances for a solve, measured from a zero target so a target shifts them all. */
function solveBalances(input: CarrySolveInput, timing: LiquidityTiming): number[] {
  return datedMonthBalances(
    0,
    [
      { field: 'payout', amount: input.payout },
      { field: 'collections', amount: input.collections },
      { field: 'invoiceFcast', amount: input.invoiceFcast ?? 0 },
      { field: HEDGE_SETTLE_LINE, amount: input.hedgeSettle ?? 0 },
    ],
    timing,
    input.ccy,
  );
}

function datedTiming(input: CarrySolveInput): LiquidityTiming | null {
  return input.liquidity?.enabled ? input.liquidity : null;
}

/** Carry vs USD ($USD M) a given Target LP Cash earns over one period. */
export function carryForTarget(targetCash: number, input: CarrySolveInput): number {
  const spot = CURRENCY_PARAMS[input.ccy]?.spot ?? 0;
  const dcf = accrualFactor(input.ccy, input.monthIndex ?? 0, input.from);
  const timing = datedTiming(input);
  if (timing) {
    const split = carrySplitFromBalances(solveBalances(input, timing), targetCash);
    return splitAccrual(split, input.r_FCY, input.r_OD, input.r_USD) * spot * dcf;
  }
  const hedge = input.hedgeSettle ?? 0;
  const flowTiming = input.timing ?? MID_CYCLE_TIMING;
  const twa = twaBalance(targetCash, input.payout, input.collections, input.timing)
    + hedge * (1 - (hedge < 0 ? flowTiming.payout : flowTiming.payin));
  const rate = rateForBalance(twa, input.r_FCY, input.r_OD);
  return twa * spot * ((rate - input.r_USD) / 100) * dcf;
}

/**
 * Whether any target can earn positive carry against USD. A long balance earns
 * r_FCY and a short one pays r_OD, so when the two straddle USD
 * (r_FCY ≤ r_USD ≤ r_OD) both sides lose and the best attainable carry is zero —
 * PLN at 3.41 / 4.41 against USD 3.50 is the standing example. Positive carry
 * needs either a credit rate above USD (earn it long) or a debit rate below USD
 * (borrow it and hold USD instead).
 */
export function canEarnPositiveCarry(input: CarrySolveInput): boolean {
  return input.r_FCY > input.r_USD || input.r_OD < input.r_USD;
}

/**
 * Inverse of `carryForTarget` on a dated path.
 *
 * Raising the target lifts every day's balance at once, so carry is piecewise
 * linear in the target with a kink at each day the balance crosses zero. Its
 * slope falls by (r_FCY − r_OD) per crossing — always negative, since the
 * overdraft rate is above the credit rate — which makes the curve concave: it
 * rises to a peak near a zero balance and falls away on both sides. An ask below
 * that peak therefore has two answers, one funded and one overdrawn, and this
 * returns the smaller position in absolute terms; an ask above it has none.
 */
function datedTargetForCarry(
  carryUsd: number,
  input: CarrySolveInput,
  liquidity: LiquidityTiming,
  spot: number,
  dcf: number,
): number | null {
  const base = solveBalances(input, liquidity);
  const n = base.length;
  if (n === 0) return null;
  const sCredit = (input.r_FCY - input.r_USD) / 100;
  const sDebit = (input.r_OD - input.r_USD) / 100;
  const unit = (spot * dcf) / n;
  const sum = base.reduce((s, b) => s + b, 0);
  const at = (target: number) => {
    let acc = 0;
    for (const b of base) {
      const v = b + target;
      acc += v >= 0 ? v * sCredit : v * sDebit;
    }
    return acc * unit;
  };

  const kinks = base.map(b => -b).sort((a, b) => a - b);
  const roots: number[] = [];
  // Beyond the outer kinks every day sits on one side, so the branch is a single
  // line and inverts exactly: carry = unit × spread × (sum + n × target).
  const outer: [number, 'below' | 'above'][] = [[sDebit, 'below'], [sCredit, 'above']];
  for (const [spread, side] of outer) {
    if (Math.abs(spread) < 1e-12) continue;
    const target = (carryUsd / (unit * spread) - sum) / n;
    const inBranch = side === 'below' ? target <= kinks[0]! : target >= kinks[n - 1]!;
    if (inBranch) roots.push(target);
  }
  // Interior segments are linear between consecutive crossings.
  for (let i = 0; i < n - 1; i += 1) {
    const t0 = kinks[i]!;
    const t1 = kinks[i + 1]!;
    if (t1 - t0 < 1e-12) continue;
    const f0 = at(t0);
    const f1 = at(t1);
    if (Math.abs(f1 - f0) < 1e-15) continue;
    if ((f0 - carryUsd) * (f1 - carryUsd) > 0) continue;
    roots.push(t0 + ((carryUsd - f0) * (t1 - t0)) / (f1 - f0));
  }
  if (roots.length === 0) return null;
  return roots.reduce((best, t) => (Math.abs(t) < Math.abs(best) ? t : best));
}

/**
 * Inverse of `carryForTarget`: the Target LP Cash whose one-period accrual hits
 * `carryUsd`. Returns null when no target reaches it — either the rate
 * differential is too flat to invert, or the ask sits outside what the currency
 * can earn at all (see `canEarnPositiveCarry`).
 */
export function targetForCarry(carryUsd: number, input: CarrySolveInput): number | null {
  const spot = CURRENCY_PARAMS[input.ccy]?.spot ?? 0;
  if (spot <= 0) return null;
  const dcf = accrualFactor(input.ccy, input.monthIndex ?? 0, input.from);
  const dated = datedTiming(input);
  if (dated) return datedTargetForCarry(carryUsd, input, dated, spot, dcf);
  const timing = input.timing ?? MID_CYCLE_TIMING;
  const hedge = input.hedgeSettle ?? 0;
  const flowOffset =
    input.payout * (1 - timing.payout) + input.collections * (1 - timing.payin)
    + hedge * (1 - (hedge < 0 ? timing.payout : timing.payin));

  // The applied rate depends on the sign of the balance we are solving for, so
  // try the credit rate first and fall back to the debit rate when the solution
  // turns out to be overdrawn.
  for (const rate of [input.r_FCY, input.r_OD]) {
    const spread = (rate - input.r_USD) / 100;
    if (Math.abs(spread) < 1e-6) continue;
    const twa = carryUsd / (spot * spread * dcf);
    const consistent = twa >= 0 ? rate === input.r_FCY : rate === input.r_OD;
    if (consistent) return twa - flowOffset;
  }
  return null;
}

/** Path Σ Buffer Carry over the horizon — the desk Buffer Carry column ($USD M). */
export function pathBufferCarry(
  row: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  months: number,
  forecastProfile?: ForecastProfileState | null,
  options: CarryLifecycleOptions = {},
): number {
  const periods = projectCarryLifecycle(
    row, shared, activeLayers, months, forecastProfile, options,
  );
  return periods.length ? periods[periods.length - 1]!.cumBufferCarryUsd : 0;
}

/** Target LP Cash that produces a Buffer Carry path — exact hit or the reachable extreme. */
export interface BufferCarrySolve {
  /** Target LP Cash (M FCY). */
  target: number;
  /** Path Buffer Carry that target actually earns ($USD M). */
  carryUsd: number;
  /** False when the ask sat outside the reachable range and we took the extreme. */
  exact: boolean;
}

/**
 * Inverse of {@link pathBufferCarry}: the Target LP Cash whose standing path earns
 * `carryUsd` over the horizon.
 *
 * Buffer Carry is the Σ across every cycle's standing book, and standing chains
 * forward through the plan under the live layer stack (floors, σ, VAR clamps).
 * There is no closed form through that, so the target is found numerically.
 * Solving one month instead would miss by the number of cycles — M1 standing is
 * only the first leg of the book.
 *
 * The curve is not continuous: clamps hold the book flat and then jump, and an
 * isolated target can read differently from its neighbours. Bisecting a raw
 * outer bracket converges onto those jumps and returns a target whose carry is
 * nothing like the ask, so this sweeps a grid first, takes an adjacent pair that
 * genuinely straddles the ask, and only bisects inside that smooth interval.
 *
 * When no standing path reaches the ask, the extreme that gets closest is
 * returned with `exact: false` — the desk still gets a book, not a lecture.
 */
export function targetForBufferCarry(
  carryUsd: number,
  row: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  months: number,
  forecastProfile?: ForecastProfileState | null,
  options: CarryLifecycleOptions = {},
): BufferCarrySolve | null {
  const at = (target: number) => pathBufferCarry(
    { ...row, carry_target: target }, shared, activeLayers, months,
    forecastProfile, options,
  );

  // Tighter than the $k the column rounds to, so an accepted solve and the
  // displayed Buffer Carry read as the same number.
  const tolerance = Math.max(1e-6, Math.abs(carryUsd) * 1e-5);
  const STEPS = 32;
  // Holding exactly nothing switches the funding path off, so a zero target sits
  // well off the curve its own neighbours trace. It is a legitimate ask but not a
  // point the book passes through on the way anywhere, and sampling it invents a
  // sign change that no root lives in. Step over it.
  const isolated = (t: number) => Math.abs(t) < 1e-9;
  const hit = (target: number, carry: number): BufferCarrySolve | null =>
    Math.abs(carry - carryUsd) <= tolerance
      ? { target, carryUsd: carry, exact: true }
      : null;

  let lo = 0;
  let hi = 0;
  let fLo = 0;
  let bracketed = false;
  let maxCarry = -Infinity;
  let targetAtMax = 0;
  let minCarry = Infinity;
  let targetAtMin = 0;
  let sampled = false;
  const spot = CURRENCY_PARAMS[row.ccy]?.spot ?? 1;
  const yearFrac = Math.max(months, 1) / 12;
  const dCredit = Math.abs((row.r_FCY - shared.r_USD) / 100);
  const dDebit = Math.abs((row.r_OD - shared.r_USD) / 100);
  const rate = Math.max(dCredit, dDebit, 1e-5);
  const impliedFcy = Math.abs(carryUsd) / (Math.max(spot, 1e-8) * rate * yearFrac);
  const cashAbs = Math.max(Math.abs(row.cash), 1);

  const consider = (t: number, f: number) => {
    if (isolated(t) || !Number.isFinite(f)) return;
    sampled = true;
    if (f > maxCarry) {
      maxCarry = f;
      targetAtMax = t;
    }
    if (f < minCarry) {
      minCarry = f;
      targetAtMin = t;
    }
  };

  for (let w = 0; w < 8 && !bracketed; w += 1) {
    const span = Math.max(cashAbs * 4, impliedFcy * 1.5, 50) * 2 ** w;
    const from = row.cash - span;
    const step = (2 * span) / STEPS;
    let prev = from;
    let fPrev = at(prev);
    consider(prev, fPrev);
    const exactPrev = hit(prev, fPrev);
    if (exactPrev) return exactPrev;
    for (let i = 1; i <= STEPS; i += 1) {
      const t = from + step * i;
      if (isolated(t)) continue;
      const f = at(t);
      consider(t, f);
      const exact = hit(t, f);
      if (exact) return exact;
      if ((carryUsd - fPrev) * (carryUsd - f) <= 0) {
        lo = prev;
        hi = t;
        fLo = fPrev;
        bracketed = true;
        break;
      }
      prev = t;
      fPrev = f;
    }
  }

  if (bracketed) {
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (isolated(mid)) break;
      const fMid = at(mid);
      const exact = hit(mid, fMid);
      if (exact) return exact;
      if ((carryUsd - fLo) * (carryUsd - fMid) <= 0) {
        hi = mid;
      } else {
        lo = mid;
        fLo = fMid;
      }
    }
    const solved = (lo + hi) / 2;
    const landed = at(solved);
    const exact = hit(solved, landed);
    if (exact) return exact;
  }

  if (!sampled || !Number.isFinite(maxCarry) || !Number.isFinite(minCarry)) {
    return null;
  }
  // Rates too flat to move carry — only succeed if we are already there.
  if (maxCarry - minCarry <= tolerance) return null;

  if (carryUsd >= maxCarry) {
    return { target: targetAtMax, carryUsd: maxCarry, exact: false };
  }
  if (carryUsd <= minCarry) {
    return { target: targetAtMin, carryUsd: minCarry, exact: false };
  }
  return null;
}
