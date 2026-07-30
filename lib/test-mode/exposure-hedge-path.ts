/**
 * Exposure path vs flat hedge — for Analytics chart / breakeven timing.
 *
 * e(t) grows with the monthly schedule (or flat F). Applied hedge is a flat
 * notional H. Breakeven = first t>0 where |e| strictly crosses |H|.
 */

import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  zForConfidence,
  type VarConfidencePct,
} from '@/lib/test-mode/var-confidence';
import {
  accruedPositionFromScheduleM,
  averageExposureFromScheduleM,
  growingExposurePathFactorFromSchedule,
  horizonMonths,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

export type HedgePathBasisId = 'cash' | 'varNeutral' | 'totalExpected';

export const HEDGE_PATH_BASIS_OPTIONS: {
  id: HedgePathBasisId;
  label: string;
  short: string;
  description: string;
}[] = [
  {
    id: 'cash',
    label: 'Cash exposure',
    short: 'Cash',
    description: 'Stock Net FX only (S) — no forecast buildup',
  },
  {
    id: 'varNeutral',
    label: 'VaR-neutral',
    short: 'VaR-neutral',
    description: 'Equal-VaR bullet from Analytics method (Ē or RMS)',
  },
  {
    id: 'totalExpected',
    label: 'Total expected',
    short: 'E_end',
    description: 'End buildup S+ΣF over the chart window',
  },
];

export interface ExposurePathPoint {
  /** Months from now. */
  t: number;
  /** Accrued exposure e(t) (local M). */
  exposureM: number;
}

/** Chart window: long enough to show both VaR horizon and forecast buildup. */
export function chartHorizonMonths(
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'>,
  monthlyFlows?: readonly number[],
): number {
  const Th = horizonMonths(setup.horizon);
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  const sched = monthlyFlows?.length ?? 0;
  return Math.max(Th, Tf, sched, 1);
}

/** Piecewise-linear exposure path from stock + monthly nets. */
export function buildExposurePathPoints(
  stockM: number,
  monthlyFlows: readonly number[],
  horizonMonthsT: number,
  stepsPerMonth = 4,
): ExposurePathPoint[] {
  const T = horizonMonthsT > 0 && Number.isFinite(horizonMonthsT) ? horizonMonthsT : 0;
  const S = Number.isFinite(stockM) ? stockM : 0;
  if (T <= 0) return [{ t: 0, exposureM: S }];

  const pts: ExposurePathPoint[] = [{ t: 0, exposureM: S }];
  let e = S;
  const step = 1 / Math.max(1, stepsPerMonth);
  let t = 0;

  while (t < T - 1e-12) {
    const monthIndex = Math.floor(t + 1e-12);
    const F =
      monthIndex < monthlyFlows.length && Number.isFinite(monthlyFlows[monthIndex]!)
        ? monthlyFlows[monthIndex]!
        : 0;
    const du = Math.min(step, T - t, monthIndex + 1 - t);
    if (du <= 1e-15) break;
    e += F * du;
    t += du;
    pts.push({ t, exposureM: e });
  }
  // Guarantee exact endpoint
  const last = pts[pts.length - 1]!;
  if (Math.abs(last.t - T) > 1e-9) {
    pts.push({ t: T, exposureM: e });
  }
  return pts;
}

/** Resolve month-net series for the chart window (custom or flat F×Tf). */
export function resolveChartMonthlyFlows(
  stockM: number,
  monthlyFlowM: number,
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'>,
  monthlyFlows?: readonly number[],
): { flows: number[]; windowMonths: number; startM: number; endM: number } {
  const windowMonths = chartHorizonMonths(setup, monthlyFlows);
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  let flows: number[];
  if (monthlyFlows && monthlyFlows.length > 0) {
    flows = [...monthlyFlows];
  } else {
    const F = Tf > 0 && Number.isFinite(monthlyFlowM) ? monthlyFlowM : 0;
    const n = Math.max(0, Math.ceil(Math.min(windowMonths, Tf)));
    flows = Array.from({ length: n }, () => F);
  }
  const startM = Number.isFinite(stockM) ? stockM : 0;
  const endM = accruedPositionFromScheduleM(startM, flows, windowMonths);
  return { flows, windowMonths, startM, endM };
}

/**
 * Target notional for a hedge-basis chip (signed with exposure).
 * VaR-neutral uses Equal-VaR N from the summary (method already applied).
 */
export function hedgeBasisNotionalLocalM(
  basis: HedgePathBasisId,
  stockM: number,
  endExposureM: number,
  equalVarHedgeLocalM: number,
): number {
  const sign =
    Math.abs(endExposureM) > 1e-12
      ? endExposureM >= 0
        ? 1
        : -1
      : stockM >= 0
        ? 1
        : -1;
  if (basis === 'cash') return sign * Math.abs(stockM);
  if (basis === 'totalExpected') return sign * Math.abs(endExposureM);
  return equalVarHedgeLocalM;
}

/**
 * Ratio of a reference notional (usually Target / Total expected) that matches
 * a desired hedge size. Caller may clamp to ≤1 (Decision max = 100% Target).
 */
export function hedgeRatioForNumber(
  targetLocalM: number,
  referenceLocalM: number,
): number {
  const ref = Math.abs(referenceLocalM);
  if (ref < 1e-12) return 0;
  return Math.abs(targetLocalM) / ref;
}

/**
 * First time t∈(0,T] where |e| strictly crosses |H|.
 * Ignores a start that sits exactly on the hedge (not a real crossing).
 */
export function hedgeBreakevenMonths(
  path: readonly ExposurePathPoint[],
  hedgeLocalM: number,
): number | null {
  if (path.length < 2 || Math.abs(hedgeLocalM) < 1e-12) return null;
  const H = Math.abs(hedgeLocalM);
  for (let i = 1; i < path.length; i++) {
    const a = Math.abs(path[i - 1]!.exposureM);
    const b = Math.abs(path[i]!.exposureM);
    // Strict sign change only — touching at t=0 when H=S must not count.
    if ((a - H) * (b - H) >= 0) continue;
    if (Math.abs(b - a) < 1e-15) return path[i]!.t;
    const w = (H - a) / (b - a);
    const tStar = path[i - 1]!.t + w * (path[i]!.t - path[i - 1]!.t);
    if (tStar < 1e-6) continue;
    return tStar;
  }
  return null;
}

/** At t: positive = overhedged (|H| > |e|). */
export function overhedgeGapM(exposureM: number, hedgeLocalM: number): number {
  return Math.abs(hedgeLocalM) - Math.abs(exposureM);
}

export interface ResidualPathPoint {
  t: number;
  /** e(t) − H (signed). */
  residualM: number;
  /** |e − H| — path shape / recognition timing. */
  absResidualM: number;
  /**
   * Accrued residual-VaR path factor √∫₀ᵗ (e−H)² dt.
   * Flat hedge leaves an offset from t=0, so this grows immediately
   * (≈ |r|√t when |e−H| is roughly constant) — not flat until BE.
   */
  cumPathFactor: number;
  /** End unmatched notional e(T)−H(T). */
  budgetNetM: number;
}

export interface ResidualPathOpts {
  /** Strategy that sized H (label / inference); accrual is always √∫(e−H)² from 0. */
  basis: HedgePathBasisId;
  startM: number;
  endM: number;
  /** Time-varying hedge (rolling strip). When set, r(t)=e(t)−H(t). */
  hedgeAt?: (t: number) => number;
}

/** Nearest chip basis for an applied hedge notional. */
export function inferHedgePathBasis(
  hedgeLocalM: number,
  startM: number,
  endM: number,
  equalVarHedgeLocalM: number,
): HedgePathBasisId {
  const h = Math.abs(hedgeLocalM);
  const opts: { id: HedgePathBasisId; n: number }[] = [
    { id: 'cash', n: Math.abs(startM) },
    { id: 'varNeutral', n: Math.abs(equalVarHedgeLocalM) },
    { id: 'totalExpected', n: Math.abs(endM) },
  ];
  let best = opts[0]!;
  let bestDist = Math.abs(h - best.n);
  for (const o of opts.slice(1)) {
    const d = Math.abs(h - o.n);
    if (d < bestDist - 1e-12) {
      best = o;
      bestDist = d;
    }
  }
  return best.id;
}

/** ∫_a^b r(t)² dt on a linear residual segment r(t)=r0+(r1-r0)·(t-t0)/(t1-t0). */
function integrateR2Segment(
  t0: number,
  t1: number,
  r0: number,
  r1: number,
  a: number,
  b: number,
): number {
  if (b <= a + 1e-15 || t1 <= t0 + 1e-15) return 0;
  const lo = Math.max(a, t0);
  const hi = Math.min(b, t1);
  if (hi <= lo + 1e-15) return 0;
  const span = t1 - t0;
  const u0 = (lo - t0) / span;
  const u1 = (hi - t0) / span;
  const ru0 = r0 + (r1 - r0) * u0;
  const ru1 = r0 + (r1 - r0) * u1;
  const dt = hi - lo;
  const dr = ru1 - ru0;
  return ru0 * ru0 * dt + ru0 * dr * dt + (dr * dr * dt) / 3;
}

/**
 * Rose = |e−H| path shape (H flat or H(t) via opts.hedgeAt).
 * Orange = √∫₀ᵗ (e−H)² — residual path factor from t=0.
 * A constant (linear) hedge vs growing e(t) leaves an offset immediately, so
 * residual VaR cannot stay flat in the first month; when |r|≈const it tracks |r|√t.
 */
export function buildResidualPath(
  path: readonly ExposurePathPoint[],
  hedgeLocalM: number,
  opts?: ResidualPathOpts | number,
): ResidualPathPoint[] {
  if (path.length === 0) return [];
  const Hflat = Number.isFinite(hedgeLocalM) ? hedgeLocalM : 0;
  // Back-compat: third arg used to be designatedEndM number
  const resolved: ResidualPathOpts =
    typeof opts === 'number'
      ? {
          basis: 'totalExpected',
          startM: path[0]?.exposureM ?? 0,
          endM: opts,
        }
      : opts ?? {
          basis: 'totalExpected',
          startM: path[0]?.exposureM ?? 0,
          endM: path[path.length - 1]?.exposureM ?? 0,
        };

  const endT = path[path.length - 1]?.t ?? 0;
  const hedgeAt = resolved.hedgeAt;
  const Hof = (t: number) => (hedgeAt != null ? hedgeAt(t) : Hflat);
  const endExposure = path[path.length - 1]?.exposureM ?? 0;
  const budgetNetM = endExposure - Hof(endT);

  const out: ResidualPathPoint[] = [];
  let integ = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    const Hp = Hof(p.t);
    const r = p.exposureM - Hp;
    if (i > 0) {
      const prev = path[i - 1]!;
      const Hprev = Hof(prev.t);
      const r0 = prev.exposureM - Hprev;
      // Full residual (over- and under-hedge) from t=0 — not gated on BE.
      integ += integrateR2Segment(prev.t, p.t, r0, r, prev.t, p.t);
    }
    out.push({
      t: p.t,
      residualM: r,
      absResidualM: Math.abs(r),
      budgetNetM,
      cumPathFactor: Math.sqrt(Math.max(0, integ)),
    });
  }
  return out;
}

/** Residual VaR (USD M): path factor × spot × σ_1m × z. */
export function residualPathVarUsdM(
  cumPathFactorAtT: number,
  ccy: string,
  confidencePct: VarConfidencePct | number,
): number {
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  return (
    Math.max(0, cumPathFactorAtT) *
    spotUsd *
    NORDTECH_VAR.monthlyVol *
    zForConfidence(confidencePct as VarConfidencePct)
  );
}

/** Time-avg Ē and RMS for labels. */
export function pathLevelStats(
  stockM: number,
  monthlyFlows: readonly number[],
  setup: Pick<VarSetup, 'horizon'>,
): { timeAvgM: number; rmsM: number; endM: number } {
  const Th = horizonMonths(setup.horizon);
  const flows = monthlyFlows.length > 0 ? monthlyFlows : [];
  const endM = accruedPositionFromScheduleM(stockM, flows, Th);
  const timeAvgM = averageExposureFromScheduleM(stockM, flows, Th);
  const pathFactor = growingExposurePathFactorFromSchedule(stockM, flows, Th);
  const rmsM = Th > 1e-12 ? pathFactor / Math.sqrt(Th) : Math.abs(stockM);
  return { timeAvgM, rmsM, endM };
}
