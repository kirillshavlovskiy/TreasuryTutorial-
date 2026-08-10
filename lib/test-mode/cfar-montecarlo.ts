import type { CfarBandPoint, CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';

/**
 * Monte Carlo cash-mismatch CFaR — replaces the closed-form spot/swap-bridge
 * split in cfar-residual.ts per the 2026-08-10 decision to (a) drop the
 * swap-bridge bucket entirely (this analysis does not cover how a gap would
 * actually be funded — no swap/liquidity assumption), (b) simulate the
 * stochastic INPUTS (gross flow realizations, intra-month in/out timing,
 * carry) via Monte Carlo while still applying the FX shock POINT-IN-TIME at
 * each interval (no continuous accrual — an unconverted mismatch does not
 * itself generate cash P&L; only the worst point-in-time draw does), and
 * (c) treat carry as a stochastic process (both the rate differential and
 * the notional it applies to are random), not a predetermined accrual.
 *
 * Time grid per path = forecast month boundaries + one intra-month
 * checkpoint per month (outflow assumed to hit before inflow — the
 * conservative ordering: cash is needed before it's received) + every hedge
 * settlement date. Between consecutive grid points, the FX-risk draw uses
 * the LOCAL step length (time since the previous checkpoint), not cumulative
 * time from T0 — so a mismatch that closes quickly (fine strip, tight
 * in/out timing) is exposed to volatility for less time and contributes
 * less risk. This is what makes settlement frequency lower CFaR without any
 * separate swap-bridge term: more legs → more, shorter intervals → smaller
 * √(local step) at each one. Carry, by contrast, genuinely accrues over
 * elapsed time (it's a real flow, not a mark), so it's summed across the
 * whole path, not reset per interval.
 *
 * Output shape matches {@link CfarBandsResult} exactly (running-max of the
 * point-in-time draw, percentiled ACROSS paths at each grid point) so the
 * existing CfarDrawdownChart renders it unchanged. One representational
 * difference from the old closed-form bands: a running-max-of-magnitude is
 * one-sided (≥0) by construction, so p05..p95 here span worst→mildest
 * outcome (all on the loss side) rather than a symmetric ±band — which is
 * arguably more honest for a cash-shortfall metric (there's no real "upside"
 * to a mismatch magnitude to show on the other side of zero).
 */

export interface McHedgeSettleLeg {
  /** Month this leg's notional actually settles (delivers cash). */
  settleMonths: number;
  /** Signed notional delivered at settlement (local M; matches exposure sign). */
  notionalLocalM: number;
}

export interface McCfarInput {
  stockM: number;
  /** Gross monthly inflows (≥0, local M), length = tenureMonths. */
  monthlyInflows: readonly number[];
  /** Gross monthly outflows (≥0, local M), length = tenureMonths. */
  monthlyOutflows: readonly number[];
  tenureMonths: number;
  spotUsd: number;
  /** Fractional monthly FX vol (e.g. 0.025 = 2.5%/mo). */
  sigmaFxMonthly: number;
  /** 90 / 95 / 99 — used both for the intra-path z and the cross-path percentile. */
  confidencePct: number;
  /** Relative 1m forecast uncertainty on flow amounts (0..1). Applied independently to each month's in/out draw. */
  forecastUncertainty1m: number;
  /** Deterministic hedge settlement schedule — empty for an open/unhedged book. */
  hedgeSettleSchedule: readonly McHedgeSettleLeg[];
  /** Mean rate differential (Δr = r_USD − r_FCY), % p.a. — carry's stochastic mean. */
  carryMeanPctPa: number;
  /** Std dev of the rate differential, % p.a. — carry's stochastic vol. */
  carryVolPctPa: number;
  /** Monte Carlo path count. Default 1500 — enough for a stable p95 band without being slow with per-point tracking. */
  paths?: number;
  /** Seed for reproducibility (same inputs → same output on every render). */
  seed?: number;
}

/** Diagnostics beyond the shared CfarBandsResult shape. */
export interface McCfarDiagnostics {
  carryMeanUsdM: number;
  carryStdUsdM: number;
  paths: number;
  gridPoints: number;
}

/** Deterministic PRNG (mulberry32) — reproducible across renders for the same seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Standard normal draw via Box-Muller, consuming two uniforms from rng. */
function nextGaussian(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function zForConfidencePct(pct: number): number {
  if (pct >= 99) return 2.3263;
  if (pct >= 95) return 1.6449;
  if (pct >= 90) return 1.2816;
  return 1.6449;
}

/** Quantile of an ALREADY-SORTED array via linear interpolation. */
function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/** Deterministic cumulative settled hedge cover at time t (local M, signed). */
function hedgeSettledAt(schedule: readonly McHedgeSettleLeg[], t: number): number {
  let cum = 0;
  for (const leg of schedule) {
    if (leg.settleMonths <= t + 1e-9) cum += leg.notionalLocalM;
  }
  return cum;
}

/** Sorted, deduplicated grid of every point-in-time worth checking. */
function buildTimeGrid(tenureMonths: number, hedgeSettleSchedule: readonly McHedgeSettleLeg[]): number[] {
  const T = Math.max(1, Math.round(tenureMonths));
  const points = new Set<number>([0]);
  for (let m = 1; m <= T; m += 1) {
    // Intra-month checkpoint: outflow assumed to hit first (conservative —
    // cash is needed before it's received), at 40% through the month;
    // inflow lands at month-end.
    points.add(m - 0.6);
    points.add(m);
  }
  for (const leg of hedgeSettleSchedule) {
    if (leg.settleMonths > 0 && leg.settleMonths <= T) points.add(leg.settleMonths);
  }
  return Array.from(points).sort((a, b) => a - b);
}

/**
 * Monte Carlo cash-mismatch CFaR: simulates stochastic gross in/out flow
 * realizations (with conservative intra-month ordering) and a stochastic
 * carry rate differential, applies the FX shock point-in-time at each
 * interval (local step, not cumulative), and returns percentile bands at
 * every grid point plus the confidence-level headline peaks — a direct,
 * drop-in {@link CfarBandsResult}.
 */
export function computeMonteCarloMismatchCfar(
  input: McCfarInput,
): CfarBandsResult & McCfarDiagnostics {
  const T = Math.max(1, Math.round(input.tenureMonths));
  const grid = buildTimeGrid(T, input.hedgeSettleSchedule);
  const G = grid.length;
  const zConf = zForConfidencePct(input.confidencePct);
  const paths = Math.max(200, Math.min(4000, Math.round(input.paths ?? 1500)));
  const rng = mulberry32(input.seed ?? 0x5f3759df);
  const u = Math.max(0, input.forecastUncertainty1m);

  // [path][gridIdx] running-max so far — monotonically non-decreasing in
  // gridIdx by construction, which is what lets a fixed-confidence
  // percentile across paths at each point still form a clean, non-decreasing
  // curve (the headline number is then just that curve's last point).
  const runningGross: Float64Array[] = [];
  const runningNet: Float64Array[] = [];
  const mismatchSum = new Float64Array(G);
  const carrySum = new Float64Array(G);
  const totalCarry: number[] = [];

  for (let k = 0; k < paths; k += 1) {
    const inRealized: number[] = new Array(T + 1).fill(0);
    const outRealized: number[] = new Array(T + 1).fill(0);
    const rateDiffRealized: number[] = new Array(T + 1).fill(0);
    for (let m = 1; m <= T; m += 1) {
      const fIn = input.monthlyInflows[m - 1] ?? 0;
      const fOut = input.monthlyOutflows[m - 1] ?? 0;
      inRealized[m] = Math.max(0, fIn * (1 + u * nextGaussian(rng)));
      outRealized[m] = Math.max(0, fOut * (1 + u * nextGaussian(rng)));
      rateDiffRealized[m] = input.carryMeanPctPa + input.carryVolPctPa * nextGaussian(rng);
    }

    const gross = new Float64Array(G);
    const net = new Float64Array(G);
    let eRunning = input.stockM;
    let carryCum = 0;
    let worstGrossSoFar = 0;
    let worstNetSoFar = 0;
    let tPrev = 0;
    let monthCursor = 0;

    for (let gi = 0; gi < G; gi += 1) {
      const t = grid[gi]!;
      const m = Math.ceil(t - 1e-9);
      if (t + 1e-9 >= m - 0.6 && monthCursor < m && t <= m - 0.6 + 1e-9) {
        eRunning -= outRealized[m] ?? 0;
      } else if (Math.abs(t - m) < 1e-9 && m > 0) {
        eRunning += inRealized[m] ?? 0;
        monthCursor = m;
      }
      const hSettled = hedgeSettledAt(input.hedgeSettleSchedule, t);
      const mismatch = eRunning - hSettled;
      const dt = Math.max(0, t - tPrev);
      const rateDiffPctPa = rateDiffRealized[Math.max(1, m)] ?? input.carryMeanPctPa;
      carryCum += (mismatch * input.spotUsd * (rateDiffPctPa / 100) * dt) / 12;
      const grossDraw =
        zConf * input.spotUsd * input.sigmaFxMonthly * Math.sqrt(dt) * Math.abs(mismatch);
      const netDraw = grossDraw - carryCum;
      if (grossDraw > worstGrossSoFar) worstGrossSoFar = grossDraw;
      if (netDraw > worstNetSoFar) worstNetSoFar = netDraw;
      gross[gi] = worstGrossSoFar;
      net[gi] = worstNetSoFar;
      mismatchSum[gi]! += mismatch;
      carrySum[gi]! += carryCum;
      tPrev = t;
    }

    runningGross.push(gross);
    runningNet.push(net);
    totalCarry.push(carryCum);
  }

  // Percentile across paths at each grid point. Loss magnitude → deepest
  // (worst) at p05, mildest at p95, matching the sign/ordering convention
  // the existing chart and marker-picking logic already expect.
  const col = (arrays: Float64Array[], gi: number): number[] => {
    const out = new Array(arrays.length);
    for (let k = 0; k < arrays.length; k += 1) out[k] = arrays[k]![gi]!;
    out.sort((a, b) => a - b);
    return out;
  };
  const pConf = input.confidencePct / 100;

  const points: CfarBandPoint[] = new Array(G);
  let criticalCashUsdM = 0;
  let netCriticalCashUsdM = 0;
  let grossPeakMonth = 0;
  let peakMonth = 0;
  const grossConfCurve = new Array<number>(G);
  const netConfCurve = new Array<number>(G);
  for (let gi = 0; gi < G; gi += 1) {
    const grossSorted = col(runningGross, gi);
    const netSorted = col(runningNet, gi);
    const g95 = quantileSorted(grossSorted, pConf); // worst
    const g05 = quantileSorted(grossSorted, 0.05); // mildest
    const g75 = quantileSorted(grossSorted, 0.75);
    const g25 = quantileSorted(grossSorted, 0.25);
    const g50 = quantileSorted(grossSorted, 0.5);
    const n95 = quantileSorted(netSorted, pConf);
    grossConfCurve[gi] = g95;
    netConfCurve[gi] = n95;
    const meanCarry = (carrySum[gi] ?? 0) / paths;
    points[gi] = {
      t: grid[gi]!,
      exposureLocalM: (mismatchSum[gi] ?? 0) / paths,
      carryUsdM: meanCarry,
      p05: -g95,
      p25: -g75,
      p50: -g50,
      p75: -g25,
      p95: -g05,
      netP05: -n95,
      netP50: meanCarry,
    };
    if (g95 > criticalCashUsdM) {
      criticalCashUsdM = g95;
      grossPeakMonth = grid[gi]!;
    }
    if (n95 > netCriticalCashUsdM) {
      netCriticalCashUsdM = n95;
      peakMonth = grid[gi]!;
    }
  }
  // Running-max curves plateau once nothing worse happens later — report the
  // FIRST point each confidence curve reaches its own final value, not just
  // the last grid index, so the marker sits where the risk actually stopped
  // growing rather than always at maturity.
  const plateauStart = (curve: readonly number[], finalVal: number): number => {
    const tol = Math.max(1e-9, finalVal * 1e-6);
    for (let gi = 0; gi < curve.length; gi += 1) {
      if (curve[gi]! >= finalVal - tol) return grid[gi]!;
    }
    return grid[grid.length - 1]!;
  };
  grossPeakMonth = plateauStart(grossConfCurve, criticalCashUsdM);
  peakMonth = plateauStart(netConfCurve, netCriticalCashUsdM);

  const carryMean = totalCarry.reduce((a, b) => a + b, 0) / Math.max(1, totalCarry.length);
  const carryVar =
    totalCarry.reduce((a, b) => a + (b - carryMean) * (b - carryMean), 0) /
    Math.max(1, totalCarry.length);

  return {
    points,
    openPathVarUsdM: criticalCashUsdM,
    criticalCashUsdM,
    netCriticalCashUsdM,
    peakMonth,
    grossPeakMonth,
    kEmpirical: 1,
    carryMeanUsdM: carryMean,
    carryStdUsdM: Math.sqrt(carryVar),
    paths,
    gridPoints: G,
  };
}
