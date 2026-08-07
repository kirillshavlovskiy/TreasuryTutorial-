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
    label: 'Expected stock',
    short: 'Stock',
    description: 'Expected stock (S) — no forecast buildup',
  },
  {
    id: 'varNeutral',
    label: 'VaR-neutral',
    short: 'VaR-neutral',
    description:
      'VaR-neutral: growth → path CoG; simple/TW → Ē — strip per window',
  },
  {
    id: 'totalExpected',
    label: 'Total expected',
    short: 'E_end',
    description:
      'Target: E_end — bullet = 1×Tf; strip = n×Δe tenors; H=Σ from M0',
  },
];

export interface ExposurePathPoint {
  /** Months from now. */
  t: number;
  /** Accrued exposure e(t) (local M). */
  exposureM: number;
}

/** Longest Analytics VaR tenure chip (1y) — used to keep post-Tf resid visible. */
const MAX_VAR_EVOLUTION_MONTHS = 12;

/**
 * Chart window: forecast buildup + active Th + full VaR-evolution span so
 * residual after Tf (e flat, V(t) still growing) stays on the path / VaR charts.
 */
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
  return Math.max(Th, Tf, sched, MAX_VAR_EVOLUTION_MONTHS, 1);
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
 * First time t∈(0,T] where |e| crosses or lands on |H|.
 * Ignores a start that sits exactly on the hedge (not a real crossing).
 * Landing on H at Tf (Target) counts — previously missed when b≡H.
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
    // Landed on H from below/above (e.g. Target H = E(Tf) at path end).
    if (a + 1e-9 < H && Math.abs(b - H) <= 1e-9) {
      const tStar = path[i]!.t;
      if (tStar > 1e-6) return tStar;
    }
    // Strict sign change.
    if ((a - H) * (b - H) >= 0) continue;
    if (Math.abs(b - a) < 1e-15) return path[i]!.t;
    const w = (H - a) / (b - a);
    const tStar = path[i - 1]!.t + w * (path[i]!.t - path[i - 1]!.t);
    if (tStar < 1e-6) continue;
    return tStar;
  }
  return null;
}

/**
 * Where strip cash / forward settlement lands for carry and booking.
 * Contract window (start/end) stays for schedule; this is the economic settle.
 */
export type StripCashDeliveryAt = 'periodEnd' | 'periodStart' | 'matchExposure';

/** Real settlement months from M0 for a strip edge under the cash-delivery mode. */
export function resolveStripCashSettleMonths(
  edge: {
    startMonth: number;
    endMonth: number;
    hedgeLocalM: number;
  },
  path: readonly ExposurePathPoint[],
  mode: StripCashDeliveryAt,
  windowMonths: number,
): number {
  const clamp = (t: number) =>
    Math.min(Math.max(windowMonths, 0), Math.max(0, t));
  if (mode === 'periodStart') {
    return clamp(edge.startMonth);
  }
  if (mode === 'matchExposure') {
    const tMeet = hedgeBreakevenMonths(path, edge.hedgeLocalM);
    if (tMeet != null && tMeet > edge.startMonth - 1e-9) {
      return clamp(tMeet);
    }
    return clamp(edge.endMonth);
  }
  return clamp(edge.endMonth);
}

/**
 * Bullet forward cash settle from M0 under the same delivery modes as strip.
 * Period end = Tf; period start ≈ M0; e∩H = first path match to cover H.
 */
export function resolveBulletCashSettleMonths(
  hedgeLocalM: number,
  path: readonly ExposurePathPoint[],
  mode: StripCashDeliveryAt,
  forecastMonths: number,
): number {
  const Tf = Math.max(0, forecastMonths);
  const clamp = (t: number) => Math.min(Tf, Math.max(0, t));
  if (mode === 'periodStart') return 0;
  if (mode === 'matchExposure') {
    const tMeet = hedgeBreakevenMonths(path, hedgeLocalM);
    if (tMeet != null) return clamp(tMeet);
    return clamp(Tf);
  }
  return clamp(Tf);
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
  /**
   * USD Budget Risk vs T0 spot from t to settle T:
   * |e−H| × S₀ × σ₁ₘ × z × √max(T−t, 0). Zero when matched at settle.
   */
  budgetRiskUsdM: number;
  /** End unmatched notional e(T)−H(T). */
  budgetNetM: number;
}

export interface ResidualPathOpts {
  /** Strategy that sized H (label / inference). */
  basis: HedgePathBasisId;
  startM: number;
  endM: number;
  /** Time-varying hedge (rolling strip). When set, r(t)=e(t)−H(t). */
  hedgeAt?: (t: number) => number;
  /** Currency for T0 spot → USD budget risk. */
  ccy?: string;
  /** VaR confidence for z in budget risk. */
  confidencePct?: VarConfidencePct | number;
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

/**
 * After Analytics VaR profile / sizing changes, Hedge % is still “of Target”
 * and goes stale vs Cash / VaR-neutral / Target chips. Re-snap each active
 * currency to the nearest chip under the new book (same as opening the path
 * modal and re-applying the regime).
 */
export function resyncHedgeRatiosToNearestRegime(
  rows: readonly {
    ccy: string;
    hedgeRatio: number;
    stockHedgeLocalM: number;
    targetHedgeLocalM: number;
    equalVarHedgeLocalM: number;
  }[],
  ratios: Record<string, number>,
): Record<string, number> | null {
  const next = { ...ratios };
  let changed = false;
  for (const r of rows) {
    const ratio = next[r.ccy] ?? r.hedgeRatio;
    if (!(ratio > 1e-9)) continue;
    if (Math.abs(r.targetHedgeLocalM) < 1e-9) {
      if (Math.abs(next[r.ccy] ?? 0) > 1e-9) {
        next[r.ccy] = 0;
        changed = true;
      }
      continue;
    }
    // Cover notional implied by preserved % under the new Target.
    const cover = r.targetHedgeLocalM * ratio;
    const basis = inferHedgePathBasis(
      cover,
      r.stockHedgeLocalM,
      r.targetHedgeLocalM,
      r.equalVarHedgeLocalM,
    );
    const desired = hedgeBasisNotionalLocalM(
      basis,
      r.stockHedgeLocalM,
      r.targetHedgeLocalM,
      r.equalVarHedgeLocalM,
    );
    const newRatio = Math.min(
      1,
      hedgeRatioForNumber(desired, r.targetHedgeLocalM),
    );
    if (Math.abs(newRatio - ratio) > 1e-9) {
      next[r.ccy] = newRatio;
      changed = true;
    }
  }
  return changed ? next : null;
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
 * USD Budget Risk vs T0 (USD M):
 *   |e−H| × S₀ × σ₁ₘ × z × √max(τ, 0)
 * where τ = remaining months to settle. Matched at settle → 0.
 */
export function budgetRiskUsdM(
  absResidualM: number,
  remainingMonths: number,
  ccy: string,
  confidencePct: VarConfidencePct | number,
): number {
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  const tau = Math.max(0, remainingMonths);
  return (
    Math.abs(absResidualM) *
    spotUsd *
    NORDTECH_VAR.monthlyVol *
    zForConfidence(confidencePct as VarConfidencePct) *
    Math.sqrt(tau)
  );
}

/**
 * Rose = |e−H| path shape (H flat or H(t) via opts.hedgeAt).
 * Orange = √∫₀ᵗ (e−H)² — residual path factor from t=0.
 * budgetRiskUsdM = USD Budget Risk vs T0 when ccy/confidence supplied.
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
  const ccy = resolved.ccy;
  const confidencePct = resolved.confidencePct;

  const out: ResidualPathPoint[] = [];
  let integ = 0;
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    const Hp = Hof(p.t);
    const r = p.exposureM - Hp;
    const absR = Math.abs(r);
    const remaining = Math.max(0, endT - p.t);
    if (i > 0) {
      const prev = path[i - 1]!;
      const Hprev = Hof(prev.t);
      const r0 = prev.exposureM - Hprev;
      integ += integrateR2Segment(prev.t, p.t, r0, r, prev.t, p.t);
    }
    out.push({
      t: p.t,
      residualM: r,
      absResidualM: absR,
      cumPathFactor: Math.sqrt(Math.max(0, integ)),
      budgetNetM,
      budgetRiskUsdM:
        ccy != null && confidencePct != null
          ? budgetRiskUsdM(absR, remaining, ccy, confidencePct)
          : 0,
    });
  }
  return out;
}

/** @deprecated Prefer budgetRiskUsdM — path-factor residual VaR (legacy). */
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
