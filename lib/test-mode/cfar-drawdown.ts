import {
  zForConfidence,
  type VarConfidencePct,
} from '@/lib/test-mode/var-confidence';

/**
 * CFaR — critical cash absorption from bridge-funding a settlement gap.
 *
 * A forward locks the RATE at trade date, but no cash moves until it
 * settles. If the desk needs cash before that, it bridges via spot (convert
 * the open gap now) + a swap back to the hedge's maturity. The only place FX
 * volatility actually touches cash is that one spot leg, executed at
 * whichever moment funding is needed — a point-in-time draw, not a
 * continuously-accruing path.
 *
 * So for a KNOWN (deterministic) gap g(t) at time t, the uncertainty in what
 * bridging it costs is a plain delta-normal VaR on a fixed notional:
 *
 *   cost(t) ~ Normal(0, (S₀·σ·√t·|g(t)|)²)
 *
 * g(t) itself is a scheduling fact (see settlementResidualKnotsForHedge /
 * settlementFundingGapForHedge in cfar-residual.ts) — never simulated. Only
 * "what does spot happen to be when I'm forced to bridge" is stochastic, and
 * that's independent at every t (no compounding across settlements: cash
 * already delivered by a settled leg is gone, it isn't sitting at risk
 * waiting to be re-marked). CriticalCash is the worst point-in-time draw
 * over the horizon, closed-form — no Monte Carlo needed.
 */

/** A knot on a piecewise-linear exposure path e(t). */
export interface ExposureKnot {
  /** Months from T0. */
  t: number;
  /** Signed exposure (local M) at t. */
  e: number;
}

/**
 * Closed-form ∫₀^T e(t)² dt for a piecewise-linear path. A segment e₀→e₁ over
 * length τ contributes τ·(e₀² + e₀e₁ + e₁²)/3. Exact for gradual, sudden
 * (near-vertical segment), symmetric and asymmetric flips alike. Used by the
 * Analytics VaR path engine (var-setup.ts); CFaR itself no longer needs a
 * path integral now that it's point-in-time rather than running-max.
 */
export function pathIntegralE2FromKnots(knots: readonly ExposureKnot[]): number {
  let sum = 0;
  for (let i = 0; i < knots.length - 1; i += 1) {
    const a = knots[i]!;
    const b = knots[i + 1]!;
    const tau = b.t - a.t;
    if (tau <= 0) continue;
    sum += (tau * (a.e * a.e + a.e * b.e + b.e * b.e)) / 3;
  }
  return Math.max(0, sum);
}

/** Interpolated exposure e(t) on a piecewise-linear knot path. */
export function exposureAtKnots(knots: readonly ExposureKnot[], t: number): number {
  if (knots.length === 0) return 0;
  if (t <= knots[0]!.t) return knots[0]!.e;
  for (let i = 0; i < knots.length - 1; i += 1) {
    const a = knots[i]!;
    const b = knots[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span > 1e-12 ? (t - a.t) / span : 0;
      return a.e + f * (b.e - a.e);
    }
  }
  return knots[knots.length - 1]!.e;
}

/**
 * Build a flip schedule: E0 at T0 → 0 at Tflip → −Ef at Tf.
 * `mode='sudden'` steps sign at Tflip (|e| never shrinks); `'gradual'` ramps
 * linearly through zero. Ef defaults to E0 (symmetric) — pass a different Ef
 * for asymmetric flips. Setting Ef negative-of-desired encodes a partial flip.
 */
export function buildFlipKnots(input: {
  e0: number;
  ef?: number;
  tflip: number;
  tf: number;
  mode: 'gradual' | 'sudden';
}): ExposureKnot[] {
  const { e0, tflip, tf, mode } = input;
  const ef = input.ef ?? e0;
  if (mode === 'sudden') {
    return [
      { t: 0, e: e0 },
      { t: Math.max(0, tflip - 1e-6), e: e0 },
      { t: tflip, e: -ef },
      { t: tf, e: -ef },
    ];
  }
  return [
    { t: 0, e: e0 },
    { t: tflip, e: 0 },
    { t: tf, e: -ef },
  ];
}

/** Piecewise-linear growing-book knots: e(0)=stock, +F_i each month to T. */
export function buildGrowingKnots(
  stockM: number,
  monthlyFlows: readonly number[],
  horizonMonthsT: number,
): ExposureKnot[] {
  const T = horizonMonthsT > 0 && Number.isFinite(horizonMonthsT) ? horizonMonthsT : 0;
  const s = Number.isFinite(stockM) ? stockM : 0;
  if (T <= 0) return [{ t: 0, e: s }];
  const knots: ExposureKnot[] = [{ t: 0, e: s }];
  let e = s;
  let t = 0;
  let i = 0;
  while (t < T - 1e-9) {
    const dt = Math.min(1, T - t);
    const F = i < monthlyFlows.length && Number.isFinite(monthlyFlows[i]!) ? monthlyFlows[i]! : 0;
    e += F * dt;
    t += dt;
    knots.push({ t, e });
    i += 1;
  }
  return knots;
}

/** One time-slice of the CFaR fan (all USD M, cash P&L signed loss-negative). */
export interface CfarBandPoint {
  /** Months from T0. */
  t: number;
  /** Signed gap g(t) at this point (local M) — the notional a bridge would need. */
  exposureLocalM: number;
  /** Deterministic carry accrued to t (USD M, + earn). */
  carryUsdM: number;
  /** Point-in-time bridge-funding cost percentiles (pre-carry). */
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  /** Net-of-carry adverse (p05) and median band. */
  netP05: number;
  netP50: number;
}

export interface CfarBandsResult {
  points: CfarBandPoint[];
  /** Peak point-in-time bridge-funding VaR z·S₀·σ·√t·|g(t)| (USD M, gross). */
  openPathVarUsdM: number;
  /** Same as openPathVarUsdM — kept as a separate field for interface stability. */
  criticalCashUsdM: number;
  /** Peak net-of-carry bridge-funding VaR (USD M). */
  netCriticalCashUsdM: number;
  /** Month of the worst net point (0 when net is fully offset by carry). */
  peakMonth: number;
  /** Month of the worst gross (pre-carry) point. */
  grossPeakMonth: number;
  /** No longer meaningful (point-in-time calc has no running-max uplift) — always 1. */
  kEmpirical: number;
}

/**
 * Standard-normal quantiles for the percentile bands (closed form), at the
 * conventional 90/95/99 confidence family. Only the p25/p75-to-p05/p95 RATIO
 * is used at runtime (0.6745/1.6449 ≈ 0.41) — the outer band itself is
 * rescaled to the caller's actual chosen confidence (see INNER_OUTER_RATIO
 * below), so the whole fan visibly resizes when confidence changes instead
 * of only the headline marker moving against a frozen shape.
 */
const Z_QUANTILE = { p05: -1.6449, p25: -0.6745, p50: 0, p75: 0.6745, p95: 1.6449 } as const;
/** Inner (p25/p75) band as a fraction of the outer (p05/p95) band — kept
 * constant across confidence levels so the fan's nesting proportions don't
 * change, only its overall size. */
const INNER_OUTER_RATIO = Z_QUANTILE.p25 / Z_QUANTILE.p05;

/**
 * CFaR bands: closed-form point-in-time bridge-funding VaR at each t, plus
 * the deterministic carry accrual. For a KNOWN gap g(t), cost(t) is a plain
 * delta-normal draw — S₀·σ·√t·|g(t)|·Z — independent at every t (no path
 * compounding: the mirror-symmetry of a Normal makes the formula the same
 * regardless of g(t)'s sign, so |g(t)| is all that matters). No Monte Carlo,
 * no seed — replaces the earlier running-max path-integral simulation.
 */
export function computeCfarBands(input: {
  knots: readonly ExposureKnot[];
  spotUsd: number;
  sigmaMonthly: number;
  confidencePct: VarConfidencePct | number;
  carryUsdM?: number;
  /**
   * Cumulative carry accrued to the end of each month (USD M, index i =
   * cumulative through month i+1). When supplied, carry is netted using this
   * exact platform schedule (piecewise-linear between month knots) instead of
   * the flat `carryTotal·t/T` ramp — so the offset traces the realized book
   * leg-for-leg (front/back-skewed strips no longer average out).
   */
  carryScheduleUsdM?: readonly number[];
  /** Sample count across the horizon (default scales with T). */
  steps?: number;
}): CfarBandsResult {
  const { knots, spotUsd, sigmaMonthly } = input;
  const carryTotal = Number.isFinite(input.carryUsdM) ? input.carryUsdM! : 0;
  const T = knots.length > 0 ? knots[knots.length - 1]!.t : 0;
  const carrySched =
    input.carryScheduleUsdM && input.carryScheduleUsdM.length > 0
      ? input.carryScheduleUsdM
      : null;
  // Cumulative carry accrued to time t (months). Piecewise-linear on the month
  // grid when a schedule is given; else the flat carryTotal·t/T ramp.
  const carryAt = (t: number): number => {
    if (!carrySched) return T > 0 ? carryTotal * (t / T) : 0;
    const n = carrySched.length;
    if (t <= 0) return 0;
    if (t >= n) return carrySched[n - 1]!;
    const k = Math.floor(t);
    const frac = t - k;
    const lo = k === 0 ? 0 : carrySched[k - 1]!;
    const hi = carrySched[k]!;
    return lo + (hi - lo) * frac;
  };
  // Confidence for the headline peak (90/95/99 from setup) — independent of
  // the fixed 5/25/75/95 percentiles drawn for the visual fan below.
  const zConf = zForConfidence(input.confidencePct as VarConfidencePct);
  const steps = input.steps ?? Math.max(24, Math.min(96, Math.ceil(T * 4)));
  if (T <= 0) {
    return {
      points: [{ t: 0, exposureLocalM: exposureAtKnots(knots, 0), carryUsdM: 0, p05: 0, p25: 0, p50: 0, p75: 0, p95: 0, netP05: 0, netP50: 0 }],
      openPathVarUsdM: 0,
      criticalCashUsdM: 0,
      netCriticalCashUsdM: 0,
      peakMonth: 0,
      grossPeakMonth: 0,
      kEmpirical: 1,
    };
  }
  const dt = T / steps;
  const points: CfarBandPoint[] = [];
  let criticalCashUsdM = 0;
  let netCriticalCashUsdM = 0;
  let peakMonth = 0;
  let grossPeakMonth = 0;
  const checkPeak = (t: number) => {
    const carry = carryAt(t);
    const scale = Math.abs(exposureAtKnots(knots, t)) * spotUsd * sigmaMonthly * Math.sqrt(t);
    const confMag = scale * zConf;
    if (confMag > criticalCashUsdM) {
      criticalCashUsdM = confMag;
      grossPeakMonth = t;
    }
    const netConfMag = confMag - carry;
    if (netConfMag > netCriticalCashUsdM) {
      netCriticalCashUsdM = netConfMag;
      peakMonth = t;
    }
  };
  for (let i = 0; i <= steps; i += 1) {
    const t = i * dt;
    const carry = carryAt(t);
    // Bridge-funding cost scale at t: |g(t)|·S₀·σ·√t. A symmetric shock to a
    // fixed notional has the same-shaped P&L distribution regardless of
    // g(t)'s sign, so only the magnitude matters.
    const scale = Math.abs(exposureAtKnots(knots, t)) * spotUsd * sigmaMonthly * Math.sqrt(t);
    // Outer band matches the caller's actual confidence exactly (so the
    // headline marker always lands ON the p05/p95 boundary); inner band
    // keeps the same proportion of it regardless of confidence.
    const p05 = scale * -zConf;
    const netP05 = p05 + carry;
    points.push({
      t,
      exposureLocalM: exposureAtKnots(knots, t),
      carryUsdM: carry,
      p05,
      p25: scale * -zConf * INNER_OUTER_RATIO,
      p50: 0,
      p75: scale * zConf * INNER_OUTER_RATIO,
      p95: scale * zConf,
      netP05,
      netP50: carry,
    });
    // Headline peak at the caller's actual confidence (independent of the
    // fixed-percentile bands plotted above).
    checkPeak(t);
  }
  // g(t) can jump sharply right at each settlement — a uniform grid can
  // straddle a jump and miss the true peak just before it. Also check every
  // exact knot t-value (where settlement-driven discontinuities actually
  // live) so the reported peak doesn't depend on grid/settlement alignment.
  for (const k of knots) checkPeak(k.t);
  return {
    points,
    openPathVarUsdM: criticalCashUsdM,
    criticalCashUsdM,
    netCriticalCashUsdM,
    peakMonth,
    grossPeakMonth,
    kEmpirical: 1,
  };
}
