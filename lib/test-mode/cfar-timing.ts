import type { ExposureKnot } from '@/lib/test-mode/cfar-drawdown';

/**
 * Intra-month payin / payout timing mismatch — the cash drawdown that exists
 * even when a currency's monthly flows net to zero.
 *
 * Everywhere else the CFaR engine consumes NET monthly flows F_k = in_k − out_k
 * and lets exposure accrue smoothly across the month. That is right for the
 * FX-rate question (what is my average exposure over the period) but it hides
 * the cash question: a book paying EUR 10M of payroll mid-month against EUR 10M
 * of collections that only land at EOM has F_k = 0, yet the desk is short
 * EUR 10M for half of every month and has to bridge it.
 *
 * This module models that gap explicitly. For each month k the real cash path
 * steps DOWN by the gross outflow at t = k + f_out and UP by the gross inflow
 * at t = k + f_in, while the netted path the rest of the engine uses ramps
 * linearly by F_k. The mismatch is the difference between the two:
 *
 *   d(t) = c_real(t) − c_netted(t)
 *
 * d is zero at every month boundary by construction (the same cash has moved
 * either way by then), so it is purely the intra-month sawtooth the monthly
 * grid throws away — a drawdown layered ON TOP of the general pay/payout
 * mismatch, never a re-count of it. d(t) < 0 means extra funding is needed.
 *
 * Two things this deliberately does NOT do: it does not let an existing FCY
 * balance absorb the dip (the engine's stock is a net FX position, not a
 * spendable balance, so treating it as a buffer would understate the bridge),
 * and it does not net hedge legs that settle inside the month against it. Both
 * make the timing layer conservative, which is why it is reported as its own
 * isolated contribution rather than folded silently into the headline.
 */

/** Where inside the month a cash leg lands (0 = 1st, 1 = last day). */
export interface CashTimingProfile {
  /** Fraction of the month elapsed when gross payouts leave. */
  payoutFraction: number;
  /** Fraction of the month elapsed when gross payins arrive. */
  payinFraction: number;
}

/**
 * Payout mid-month, payin at EOM — the same convention the workspace carry
 * calendar defaults to (`DEFAULT_TIMING` in workspace-store), so CFaR and carry
 * describe the same month.
 */
export const DEFAULT_CASH_TIMING: CashTimingProfile = {
  payoutFraction: 0.5,
  payinFraction: 1,
};

export const CASH_TIMING_PRESETS: {
  id: 'start' | 'mid' | 'end';
  label: string;
  fraction: number;
}[] = [
  { id: 'start', label: 'Start', fraction: 0 },
  { id: 'mid', label: 'Mid', fraction: 0.5 },
  { id: 'end', label: 'EOM', fraction: 1 },
];

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function finite(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function normalizeCashTiming(
  timing: Partial<CashTimingProfile> | null | undefined,
): CashTimingProfile {
  if (!timing) return DEFAULT_CASH_TIMING;
  return {
    payoutFraction: clamp01(
      timing.payoutFraction ?? DEFAULT_CASH_TIMING.payoutFraction,
    ),
    payinFraction: clamp01(
      timing.payinFraction ?? DEFAULT_CASH_TIMING.payinFraction,
    ),
  };
}

/**
 * Bridge for callers holding a workspace `TimingProfile` — feed it the output
 * of `resolveTimingFractions`, keeping this module free of workspace imports.
 */
export function cashTimingFromFractions(f: {
  fPayout: number;
  fPayin: number;
}): CashTimingProfile {
  return normalizeCashTiming({
    payoutFraction: f.fPayout,
    payinFraction: f.fPayin,
  });
}

/** Months the desk carries the gap for — |f_in − f_out|, the exposure window. */
export function timingWindowMonths(timing: CashTimingProfile): number {
  const t = normalizeCashTiming(timing);
  return Math.abs(t.payinFraction - t.payoutFraction);
}

export interface TimingMismatchInput {
  /** Gross inflows per month (local M, ≥ 0). */
  monthlyInflows?: readonly number[];
  /** Gross outflows per month as positive magnitudes (local M, ≥ 0). */
  monthlyOutflowsAbs?: readonly number[];
  timing?: Partial<CashTimingProfile> | null;
  horizonMonths: number;
}

const JUMP_EPS = 1e-6;

/** Append a knot, keeping t non-decreasing and collapsing duplicates. */
function pushKnot(knots: ExposureKnot[], t: number, e: number): void {
  const last = knots[knots.length - 1];
  if (last && t <= last.t + 1e-12) {
    last.e = e;
    return;
  }
  knots.push({ t, e });
}

/**
 * Piecewise-linear d(t) — the timing-only deviation from the netted monthly
 * path, in local M. Returns a flat zero path when no gross flows are supplied
 * (so callers that never wire up inflows/outflows are unaffected).
 */
export function buildTimingMismatchKnots(
  input: TimingMismatchInput,
): ExposureKnot[] {
  const T =
    Number.isFinite(input.horizonMonths) && input.horizonMonths > 0
      ? input.horizonMonths
      : 0;
  if (T <= 0) return [{ t: 0, e: 0 }];
  const timing = normalizeCashTiming(input.timing);
  const inflows = input.monthlyInflows ?? [];
  const outflows = input.monthlyOutflowsAbs ?? [];
  if (inflows.length === 0 && outflows.length === 0) {
    return [
      { t: 0, e: 0 },
      { t: T, e: 0 },
    ];
  }

  const knots: ExposureKnot[] = [{ t: 0, e: 0 }];
  const months = Math.ceil(T - 1e-9);
  for (let k = 0; k < months; k += 1) {
    const monthEnd = Math.min(T, k + 1);
    const inflow = Math.abs(finite(inflows[k]));
    const outflow = Math.abs(finite(outflows[k]));
    if (inflow < 1e-12 && outflow < 1e-12) {
      pushKnot(knots, monthEnd, 0);
      continue;
    }
    const net = inflow - outflow;
    const events = [
      { f: timing.payoutFraction, amount: -outflow },
      { f: timing.payinFraction, amount: inflow },
    ].sort((a, b) => a.f - b.f);

    let settled = 0;
    for (const ev of events) {
      const t = k + ev.f;
      if (t > T + 1e-9) break;
      // Level the netted path has reached at this instant.
      const netted = net * ev.f;
      pushKnot(knots, Math.min(monthEnd, Math.max(k, t - JUMP_EPS)), settled - netted);
      settled += ev.amount;
      pushKnot(knots, Math.min(monthEnd, t), settled - netted);
    }
    // A full month closes at zero — both paths have moved the same cash by
    // then. A horizon that cuts the month short does not: any leg still to
    // come (an EOM payin on a T = 2.5m horizon) leaves the gap open at T.
    pushKnot(knots, monthEnd, settled - net * (monthEnd - k));
  }
  return knots;
}

export interface TimingMismatchPoint {
  t: number;
  /** Signed deviation from the netted path (local M); negative = shortfall. */
  gapLocalM: number;
}

export interface TimingMismatchResult {
  points: TimingMismatchPoint[];
  /** Worst |d(t)| over the horizon (local M) — the notional CFaR prices. */
  maxGapLocalM: number;
  /** Worst |d(t)| converted at the currency's reference spot (USD M). */
  maxGapUsdM: number;
  /** Worst funding shortfall (positive magnitude of the most negative d). */
  maxShortfallLocalM: number;
  /** Month of the worst |d(t)|. */
  peakMonth: number;
  /** Months the gap stays open each cycle — |f_in − f_out|. */
  windowMonths: number;
}

/**
 * Peak intra-month mismatch for the funding-gap style readouts. Deterministic
 * (zero volatility): this is the notional the desk has to bridge, before any
 * FX uncertainty on the rate it bridges at.
 */
export function timingMismatchGap(
  input: TimingMismatchInput & { spotUsd?: number },
): TimingMismatchResult {
  const knots = buildTimingMismatchKnots(input);
  const spot =
    typeof input.spotUsd === 'number' && Number.isFinite(input.spotUsd)
      ? input.spotUsd
      : 1;
  let maxAbs = 0;
  let worstNegative = 0;
  let peakMonth = 0;
  for (const k of knots) {
    if (Math.abs(k.e) > maxAbs) {
      maxAbs = Math.abs(k.e);
      peakMonth = k.t;
    }
    if (k.e < worstNegative) worstNegative = k.e;
  }
  return {
    points: knots.map(k => ({ t: k.t, gapLocalM: k.e })),
    maxGapLocalM: maxAbs,
    maxGapUsdM: maxAbs * spot,
    maxShortfallLocalM: Math.abs(worstNegative),
    peakMonth,
    windowMonths: timingWindowMonths(normalizeCashTiming(input.timing)),
  };
}