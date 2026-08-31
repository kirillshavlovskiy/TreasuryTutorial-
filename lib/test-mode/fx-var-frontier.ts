/**
 * Group FX VaR — diversified portfolio risk and carry vs √(v′ρv) frontier.
 *
 * Per-CCY Analytics VaR is signed by residual exposure (long +, short −)
 * so EUR vs JPY offsets through the desk CORR_MATRIX. Hedge scale t=0 is
 * the open book; t=1 is the live cover. Subset mixes (hedge / don't) give
 * the discrete efficient frontier across all currencies.
 */

import {
  CURRENCY_PARAMS,
  ccySpotRate,
  fxBookNetLocalM,
  type RowState,
} from '@/lib/fx-buffer';
import { monthlyFxFlowSeriesLocalM, type ForecastProfileState } from '@/lib/forecast-profile';
import { residualVarFromMismatchUsdM, type HedgeVarRow } from '@/lib/test-mode/hedge-var';
import {
  atlasRiskCorr,
  impliedFxVol,
  type UsdRiskLeg,
} from '@/lib/fx-market-risk';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import { fwdHedgeCarryFromMarketUsd } from '@/lib/fx-hedge';
import {
  diversifiedUsdRisk,
  type DiversifiedUsdRisk,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import { zForConfidence, type VarConfidencePct } from '@/lib/test-mode/var-confidence';
import { solveHedgeFrontierAtCap } from '@/lib/test-mode/fx-hedge-frontier-optimizer';

type AtlasCorrFn = (a: UsdRiskLeg, b: UsdRiskLeg) => number;

export function signedFxVarUsdM(varUsdM: number, exposureLocalM: number): number {
  if (!(varUsdM > 0) || !Number.isFinite(varUsdM)) return 0;
  return exposureLocalM < -1e-12 ? -varUsdM : varUsdM;
}

export function openPathExposureLocalM(row: HedgeVarRow): number {
  return row.residualLocalM + row.hedgeNotionalLocalM;
}

export function fxVarContribs(
  rows: readonly HedgeVarRow[],
  which: 'before' | 'after',
): { ccy: string; usdM: number }[] {
  return rows
    .filter(r => r.ccy !== 'USD')
    .map(r => ({
      ccy: r.ccy,
      usdM:
        which === 'before'
          ? signedFxVarUsdM(r.varBeforeUsdM, openPathExposureLocalM(r))
          : signedFxVarUsdM(r.varAfterUsdM, r.residualLocalM),
    }))
    .filter(c => Math.abs(c.usdM) > 1e-12);
}

/**
 * Mix-table VaR: before = atlas indiv @ Δ=1; after = indiv × (1 − w).
 * Live `weights` (and force-open = 0) win over booked path VaR.
 */
export function fxMixSignedContribs(
  rows: readonly HedgeVarRow[],
  atlas: {
    indiv: Readonly<Record<string, number>>;
    local?: Readonly<Record<string, number>>;
  },
  weights: Readonly<Record<string, number>> | undefined,
  which: 'before' | 'after',
): { ccy: string; usdM: number }[] {
  return rows
    .filter(r => r.ccy !== 'USD')
    .map(r => {
      const before = atlas.indiv[r.ccy] ?? r.varBeforeUsdM;
      const w = which === 'before' ? 0 : clampHedgeWeight(weights?.[r.ccy] ?? 0);
      const usdM = before * (1 - w);
      const local = (atlas.local?.[r.ccy] ?? r.targetHedgeLocalM) * (1 - w);
      return { ccy: r.ccy, usdM: signedFxVarUsdM(usdM, local) };
    })
    .filter(c => Math.abs(c.usdM) > 1e-12);
}

/** Selected mix + live drags + excluded names (w = 0). */
export function fxLiveMixWeights(
  selected: Readonly<Record<string, number>> | undefined,
  live: Readonly<Record<string, number>> | undefined,
  forceOpenCcys: readonly string[] = [],
): Record<string, number> {
  const next: Record<string, number> = { ...(selected ?? {}), ...(live ?? {}) };
  for (const ccy of forceOpenCcys) next[ccy] = 0;
  return next;
}

export function fxDiversifiedBooks(rows: readonly HedgeVarRow[]): {
  before: DiversifiedUsdRisk;
  after: DiversifiedUsdRisk;
} {
  return {
    before: diversifiedUsdRisk(fxVarContribs(rows, 'before')),
    after: diversifiedUsdRisk(fxVarContribs(rows, 'after')),
  };
}

export type FxCarryVarPoint = {
  id: string;
  t: number;
  carryUsdYrM: number;
  divVarUsdM: number;
  standaloneVarUsdM: number;
  kind: 'walk' | 'mix' | 'unhedged' | 'hedged';
  /** Hedge weight in [0, 1] per CCY at this point (1 = 100% of Target). */
  hedgeByCcy?: Record<string, number>;
  /** Per CCY×tenor weight (`EUR:1`). Atlas peels legs, not whole names. */
  hedgeByLeg?: Record<string, number>;
  /** Hedge carry locked at this mix, USDmm (MXN long is a cost). */
  carryByCcy?: Record<string, number>;
};

/** Atlas Efficient Frontier samples — arc-length-equal steps, 20 knots. */
export const ATLAS_FRONTIER_POINTS = 20;

export function atlasLegKey(ccy: string, tenorMonths: number): string {
  return `${ccy}:${tenorMonths}`;
}

function clampHedgeWeight(w: number): number {
  if (!Number.isFinite(w)) return 0;
  return Math.min(1, Math.max(0, w));
}

/** Leg key first (`JPY:12`), then the whole-name weight (CCY walk). */
export function atlasLegHedgeWeight(
  weights: Readonly<Record<string, number>> | undefined,
  ccy: string,
  tenorMonths: number,
): number {
  if (!weights) return 1;
  const keyed = weights[atlasLegKey(ccy, tenorMonths)];
  if (typeof keyed === 'number' && Number.isFinite(keyed)) {
    return clampHedgeWeight(keyed);
  }
  return clampHedgeWeight(weights[ccy] ?? 0);
}

/** Exact Optimize weight for Book / chips — 15.7%, not a rounded 16%. */
export function formatHedgePct(w: number): string {
  if (!Number.isFinite(w)) return '0%';
  const pct = Math.min(100, Math.max(0, w * 100));
  if (pct < 0.05) return '0%';
  if (pct > 99.95) return '100%';
  const nearest = Math.round(pct);
  if (Math.abs(pct - nearest) < 0.05) return `${nearest}%`;
  return `${pct.toFixed(1)}%`;
}

/**
 * Book / Approve reprint the selected Optimize mix: Atlas Target, cover,
 * individual VaR at Δ=1 and Resid VaR = indiv × (1−w).
 */
export function applyAtlasMixToHedgeRows(
  rows: readonly HedgeVarRow[],
  point: FxCarryVarPoint | null | undefined,
  atlas: {
    indiv: Readonly<Record<string, number>>;
    local?: Readonly<Record<string, number>>;
  },
): HedgeVarRow[] {
  if (!point?.hedgeByCcy) return [...rows];
  return rows.map(r => {
    if (r.ccy === 'USD') return r;
    const w = clampHedgeWeight(point.hedgeByCcy?.[r.ccy] ?? r.hedgeRatio);
    const target = atlas.local?.[r.ccy] ?? r.targetHedgeLocalM;
    const cover = w * target;
    const before = atlas.indiv[r.ccy] ?? r.varBeforeUsdM;
    const after = before * (1 - w);
    return {
      ...r,
      hedgeRatio: w,
      targetHedgeLocalM: target,
      hedgeNotionalLocalM: cover,
      residualLocalM: target - cover,
      varBeforeUsdM: before,
      varAfterUsdM: after,
      delta: before < 1e-12 ? 0 : Math.min(1, after / before),
    };
  });
}

/** Locked CIP on the hedge trade (w × full 12M-bullet carry). Live `weight` wins. */
export function atlasMixLockedCarryUsdM(
  point: FxCarryVarPoint | null | undefined,
  ccy: string,
  fullCarryUsdM: number,
  weight?: number,
): number {
  const w = clampHedgeWeight(
    typeof weight === 'number' && Number.isFinite(weight)
      ? weight
      : (point?.hedgeByCcy?.[ccy] ?? 0),
  );
  return fullCarryUsdM * w;
}

function carryAt(
  ccys: readonly string[],
  cashByCcy: Record<string, number>,
  hedgeCarryByCcy: Record<string, number>,
  hedged: ReadonlySet<string> | number,
): number {
  let s = 0;
  for (const ccy of ccys) {
    const cash = cashByCcy[ccy] ?? 0;
    const hx = hedgeCarryByCcy[ccy] ?? 0;
    const w = typeof hedged === 'number' ? hedged : hedged.has(ccy) ? 1 : 0;
    s += cash + w * hx;
  }
  return s;
}

/** Continuous common-cover walk: t=0 open book → t=1 live hedge. */
export function fxHedgeScaleWalk(
  rows: readonly HedgeVarRow[],
  cashByCcy: Record<string, number>,
  hedgeCarryByCcy: Record<string, number>,
  steps = 13,
): FxCarryVarPoint[] {
  const fx = rows.filter(r => r.ccy !== 'USD');
  if (fx.length === 0) return [];
  const ccys = fx.map(r => r.ccy);
  const out: FxCarryVarPoint[] = [];
  const n = Math.max(2, steps);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const contribs = fx.map(r => {
      const pathE = openPathExposureLocalM(r);
      const Eref = Math.abs(r.targetHedgeLocalM) > 1e-12 ? r.targetHedgeLocalM : pathE;
      const cover = t * r.hedgeNotionalLocalM;
      const varUsdM = residualVarFromMismatchUsdM(r.varBeforeUsdM, pathE, cover, Eref);
      return { ccy: r.ccy, usdM: signedFxVarUsdM(varUsdM, pathE - cover) };
    });
    const risk = diversifiedUsdRisk(contribs);
    out.push({
      id: `walk-${i}`,
      t,
      carryUsdYrM: carryAt(ccys, cashByCcy, hedgeCarryByCcy, t),
      divVarUsdM: risk.portfolioUsdM,
      standaloneVarUsdM: risk.standaloneUsdM,
      kind: i === 0 ? 'unhedged' : i === n - 1 ? 'hedged' : 'walk',
    });
  }
  return out;
}

/**
 * Discrete efficient frontier: each CCY either open or fully on the live
 * hedge. Pareto = no other mix has ≤ diversified VaR and ≥ carry.
 */
export function fxCarryVarPareto(
  rows: readonly HedgeVarRow[],
  cashByCcy: Record<string, number>,
  hedgeCarryByCcy: Record<string, number>,
): FxCarryVarPoint[] {
  const fx = rows
    .filter(r => r.ccy !== 'USD')
    .sort((a, b) => b.varBeforeUsdM - a.varBeforeUsdM)
    .slice(0, 8);
  if (fx.length === 0) return [];
  const ccys = fx.map(r => r.ccy);
  const n = fx.length;
  const mixes: FxCarryVarPoint[] = [];
  const limit = 1 << n;
  for (let mask = 0; mask < limit; mask++) {
    const hedged = new Set<string>();
    const contribs: { ccy: string; usdM: number }[] = [];
    for (let i = 0; i < n; i++) {
      const r = fx[i]!;
      const on = ((mask >> i) & 1) === 1;
      if (on) hedged.add(r.ccy);
      contribs.push({
        ccy: r.ccy,
        usdM: on
          ? signedFxVarUsdM(r.varAfterUsdM, r.residualLocalM)
          : signedFxVarUsdM(r.varBeforeUsdM, openPathExposureLocalM(r)),
      });
    }
    const risk = diversifiedUsdRisk(contribs);
    mixes.push({
      id: `mix-${mask}`,
      t: hedged.size / n,
      carryUsdYrM: carryAt(ccys, cashByCcy, hedgeCarryByCcy, hedged),
      divVarUsdM: risk.portfolioUsdM,
      standaloneVarUsdM: risk.standaloneUsdM,
      kind: mask === 0 ? 'unhedged' : mask === limit - 1 ? 'hedged' : 'mix',
    });
  }
  return paretoFront(mixes);
}

export function paretoFront(pts: readonly FxCarryVarPoint[]): FxCarryVarPoint[] {
  const kept = pts.filter((p, i) =>
    !pts.some((q, j) =>
      j !== i
      && q.divVarUsdM <= p.divVarUsdM + 1e-9
      && q.carryUsdYrM >= p.carryUsdYrM - 1e-9
      && (q.divVarUsdM < p.divVarUsdM - 1e-9 || q.carryUsdYrM > p.carryUsdYrM + 1e-9),
    ),
  );
  return kept.sort((a, b) => a.divVarUsdM - b.divVarUsdM || b.carryUsdYrM - a.carryUsdYrM);
}

/**
 * GS-style efficient curve: start fully on the live hedge (min VaR), then
 * unhedge one CCY at a time in carry-per-VaR order. Fine t-steps on the
 * first names pack points at the left, then the curve flattens as leftover
 * risk adds less carry.
 */
export function fxCarryEfficientCurve(
  rows: readonly HedgeVarRow[],
  cashByCcy: Record<string, number>,
  hedgeCarryByCcy: Record<string, number>,
): FxCarryVarPoint[] {
  const fx = rows.filter(r => r.ccy !== 'USD');
  if (fx.length === 0) return [];
  const weights: Record<string, number> = {};
  for (const r of fx) weights[r.ccy] = 1;

  const pointAt = (w: Record<string, number>, id: string, kind: FxCarryVarPoint['kind']): FxCarryVarPoint => {
    const contribs = fx.map(r => {
      const t = w[r.ccy] ?? 0;
      const pathE = openPathExposureLocalM(r);
      const Eref = Math.abs(r.targetHedgeLocalM) > 1e-12 ? r.targetHedgeLocalM : pathE;
      const cover = t * r.hedgeNotionalLocalM;
      const varUsdM = residualVarFromMismatchUsdM(r.varBeforeUsdM, pathE, cover, Eref);
      return { ccy: r.ccy, usdM: signedFxVarUsdM(varUsdM, pathE - cover) };
    });
    const risk = diversifiedUsdRisk(contribs);
    let carry = 0;
    for (const r of fx) {
      const t = w[r.ccy] ?? 0;
      carry += (cashByCcy[r.ccy] ?? 0) + t * (hedgeCarryByCcy[r.ccy] ?? 0);
    }
    return {
      id,
      t: 1 - fx.reduce((s, r) => s + (w[r.ccy] ?? 0), 0) / fx.length,
      carryUsdYrM: carry,
      divVarUsdM: risk.portfolioUsdM,
      standaloneVarUsdM: risk.standaloneUsdM,
      kind,
    };
  };

  const curve: FxCarryVarPoint[] = [pointAt(weights, 'curve-hedged', 'hedged')];
  const open = new Set(fx.map(r => r.ccy));
  let step = 0;
  while (open.size > 0) {
    const now = curve[curve.length - 1]!;
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const ccy of open) {
      const trial = { ...weights, [ccy]: 0 };
      const p = pointAt(trial, 'tmp', 'mix');
      const dVar = p.divVarUsdM - now.divVarUsdM;
      const dCarry = p.carryUsdYrM - now.carryUsdYrM;
      const score = dVar > 1e-8 ? dCarry / dVar : dCarry > 1e-8 ? 1e9 : dVar < -1e-8 ? 1e8 : -1e9;
      if (score > bestScore) {
        bestScore = score;
        best = ccy;
      }
    }
    if (!best) break;
    const nSteps = step === 0 ? 16 : step === 1 ? 8 : 4;
    for (let i = 1; i <= nSteps; i++) {
      const t = 1 - i / nSteps;
      weights[best] = t;
      const kind =
        open.size === 1 && i === nSteps ? 'unhedged' : 'walk';
      curve.push(pointAt({ ...weights }, `curve-${step}-${i}`, kind));
    }
    open.delete(best);
    step += 1;
  }
  return curve;
}

export function fxCarryVarFrontier(input: {
  rows: readonly HedgeVarRow[];
  cashByCcy?: Record<string, number>;
  hedgeCarryByCcy?: Record<string, number>;
}): {
  before: DiversifiedUsdRisk;
  after: DiversifiedUsdRisk;
  walk: FxCarryVarPoint[];
  pareto: FxCarryVarPoint[];
  curve: FxCarryVarPoint[];
} {
  const cash = input.cashByCcy ?? {};
  const hx = input.hedgeCarryByCcy ?? {};
  const books = fxDiversifiedBooks(input.rows);
  return {
    ...books,
    walk: fxHedgeScaleWalk(input.rows, cash, hx),
    pareto: fxCarryVarPareto(input.rows, cash, hx),
    curve: fxCarryEfficientCurve(input.rows, cash, hx),
  };
}

function targetCoverLocalM(row: HedgeVarRow): number {
  return Math.abs(row.targetHedgeLocalM) > 1e-12
    ? row.targetHedgeLocalM
    : openPathExposureLocalM(row);
}

/**
 * Atlas Basic-mode point: carry is hedge carry only (E × c × T on the
 * hedged weight). Residual VaR scales with (1 − w) against the open book.
 * w = 1 is 100% of Target, not the live Decision %.
 */
export function fxAtlasPointAtWeights(
  rows: readonly HedgeVarRow[],
  hedgeCarryByCcy: Record<string, number>,
  weights: Record<string, number>,
  id: string,
  kind: FxCarryVarPoint['kind'],
): FxCarryVarPoint {
  const fx = rows.filter(r => r.ccy !== 'USD');
  const hedgeByCcy: Record<string, number> = {};
  const contribs = fx.map(r => {
    const w = Math.min(1, Math.max(0, weights[r.ccy] ?? 0));
    hedgeByCcy[r.ccy] = w;
    const pathE = openPathExposureLocalM(r);
    const Eref = targetCoverLocalM(r);
    const cover = w * Eref;
    const varUsdM = residualVarFromMismatchUsdM(r.varBeforeUsdM, pathE, cover, Eref);
    return { ccy: r.ccy, usdM: signedFxVarUsdM(varUsdM, pathE - cover) };
  });
  const risk = diversifiedUsdRisk(contribs);
  const carryByCcy: Record<string, number> = {};
  let carry = 0;
  for (const r of fx) {
    const add = (hedgeCarryByCcy[r.ccy] ?? 0) * (hedgeByCcy[r.ccy] ?? 0);
    carryByCcy[r.ccy] = add;
    carry += add;
  }
  const avgW = fx.length === 0
    ? 0
    : fx.reduce((s, r) => s + (hedgeByCcy[r.ccy] ?? 0), 0) / fx.length;
  return {
    id,
    t: 1 - avgW,
    carryUsdYrM: carry,
    divVarUsdM: risk.portfolioUsdM,
    standaloneVarUsdM: risk.standaloneUsdM,
    kind,
    hedgeByCcy,
    carryByCcy,
  };
}

export function fxAtlasSweetPoint(
  curve: readonly FxCarryVarPoint[],
): FxCarryVarPoint | null {
  if (curve.length === 0) return null;
  return curve.reduce((best, p) => {
    if (p.carryUsdYrM > best.carryUsdYrM + 1e-9) return p;
    if (Math.abs(p.carryUsdYrM - best.carryUsdYrM) <= 1e-9
      && p.divVarUsdM < best.divVarUsdM - 1e-9) {
      return p;
    }
    return best;
  });
}

function atlasUnhedgeScore(
  now: FxCarryVarPoint,
  trial: FxCarryVarPoint,
): number {
  const dVar = trial.divVarUsdM - now.divVarUsdM;
  const dCarry = trial.carryUsdYrM - now.carryUsdYrM;
  if (dVar > 1e-8) return dCarry / dVar;
  if (dCarry > 1e-8) return 1e9;
  if (dVar < -1e-8) return 1e8;
  return -1e9;
}

/** $6k carry — GBP vs USD is dust; not worth the VaR of leaving it open. */
const ATLAS_MIN_UNHEDGE_CARRY_USD_M = 0.006;
/** $30k carry per $1mm extra diversified VaR. */
const ATLAS_MIN_UNHEDGE_CARRY_PER_VAR = 0.03;

/**
 * Unhedge only a name that pays real carry for the extra VaR.
 * A flat pair (GBP) does not earn, so it stays on Target — opening it
 * is the far-right worst mix.
 */
export function atlasUnhedgeWorthIt(
  now: FxCarryVarPoint,
  trial: FxCarryVarPoint,
): boolean {
  const dCarry = trial.carryUsdYrM - now.carryUsdYrM;
  const dVar = trial.divVarUsdM - now.divVarUsdM;
  if (dCarry <= 1e-9) return false;
  if (dCarry < ATLAS_MIN_UNHEDGE_CARRY_USD_M) return false;
  if (dVar > 1e-8 && dCarry / dVar < ATLAS_MIN_UNHEDGE_CARRY_PER_VAR) return false;
  return true;
}

/**
 * Atlas Frontier plots a rising-VaR polyline. Peeling a small offsetting
 * name (PLN after JPY is open) first cuts VaR then puts it back — a
 * 4–8 point scribble Atlas never draws. Keep first / last and drop the hook.
 */
export function atlasMonotoneEfficient(
  curve: readonly FxCarryVarPoint[],
): FxCarryVarPoint[] {
  if (curve.length <= 2) return [...curve];
  const vSpan = Math.max(...curve.map(p => p.divVarUsdM))
    - Math.min(...curve.map(p => p.divVarUsdM));
  const minStep = Math.max(1e-4, vSpan * 0.015);
  const out: FxCarryVarPoint[] = [curve[0]!];
  for (let i = 1; i < curve.length - 1; i++) {
    const p = curve[i]!;
    const last = out[out.length - 1]!;
    if (p.divVarUsdM < last.divVarUsdM - 1e-9) continue;
    if (p.divVarUsdM - last.divVarUsdM < minStep) continue;
    out.push(p);
  }
  const end = curve[curve.length - 1]!;
  if (out[out.length - 1]!.id !== end.id) out.push(end);
  return out;
}

/**
 * Independent per-cap solves are mostly-but-not-globally concave in carry:
 * a later (larger-cap) point can land a little BELOW an earlier one from
 * solver noise alone (verified: a real 6-currency run showed carry dip from
 * -$0.093M to -$0.113M between two consecutive raw points, then climb
 * smoothly to +$0.207M afterward). atlasWorthyStopIndex assumes each step
 * is checked against a genuinely non-decreasing sequence and stops for
 * good on the FIRST decrease it sees — a transient dip like that one
 * short-circuited the whole walk at ~30% of its true achievable carry.
 * Drop any point that dips below the best carry seen so far (mirrors
 * atlasMonotoneEfficient's VaR-scribble drop, but for carry) so the
 * worthy-stop check only ever sees real, sustained progress.
 */
export function atlasMonotoneCarry(
  curve: readonly FxCarryVarPoint[],
): FxCarryVarPoint[] {
  const out: FxCarryVarPoint[] = [];
  let runningMax = Number.NEGATIVE_INFINITY;
  for (const p of curve) {
    if (p.carryUsdYrM >= runningMax - 1e-9) {
      out.push(p);
      runningMax = Math.max(runningMax, p.carryUsdYrM);
    }
  }
  return out;
}

/**
 * Atlas Basic efficient set: fully hedged → unhedge only when carry rises
 * by enough to pay for the extra VaR. Dust pairs (GBP vs USD) stay hedged.
 * Unhedged is a separate point (Basic carry = 0), not on the blue line.
 */
function walkAtlasEfficientSet(
  names: readonly string[],
  pointAt: (
    weights: Record<string, number>,
    id: string,
    kind: FxCarryVarPoint['kind'],
  ) => FxCarryVarPoint,
): {
  curve: FxCarryVarPoint[];
  sweet: FxCarryVarPoint | null;
  fullyHedged: FxCarryVarPoint | null;
  unhedged: FxCarryVarPoint | null;
} {
  if (names.length === 0) {
    return { curve: [], sweet: null, fullyHedged: null, unhedged: null };
  }
  const zeros: Record<string, number> = {};
  const weights: Record<string, number> = {};
  for (const name of names) {
    zeros[name] = 0;
    weights[name] = 1;
  }
  const unhedged = pointAt(zeros, 'atlas-unhedged', 'unhedged');
  const curve: FxCarryVarPoint[] = [
    pointAt({ ...weights }, 'atlas-hedged', 'hedged'),
  ];
  const open = new Set(names);
  let step = 0;
  while (open.size > 0) {
    const now = curve[curve.length - 1]!;
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const name of open) {
      const trial = pointAt({ ...weights, [name]: 0 }, 'tmp', 'mix');
      if (!atlasUnhedgeWorthIt(now, trial)) continue;
      const score = atlasUnhedgeScore(now, trial);
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    if (!best || bestScore <= 0) break;
    const full = pointAt({ ...weights, [best]: 0 }, 'tmp', 'mix');
    const dVarFull = full.divVarUsdM - now.divVarUsdM;
    const nSteps = dVarFull <= 1e-4
      ? 1
      : step === 0 ? 16 : step === 1 ? 8 : 4;
    for (let i = 1; i <= nSteps; i++) {
      weights[best] = 1 - i / nSteps;
      curve.push(
        pointAt({ ...weights }, `atlas-${step}-${i}`, 'walk'),
      );
    }
    open.delete(best);
    step += 1;
  }
  const rising = atlasMonotoneEfficient(curve);
  const sweet = fxAtlasSweetPoint(rising);
  const sweetIdx = sweet ? rising.findIndex(p => p.id === sweet.id) : -1;
  const efficient = sweetIdx >= 0 ? rising.slice(0, sweetIdx + 1) : rising;
  if (efficient.length > 0 && sweet) {
    efficient[efficient.length - 1] = { ...sweet, kind: 'mix' };
  }
  return {
    curve: efficient,
    sweet: efficient[efficient.length - 1] ?? sweet,
    fullyHedged: efficient[0] ?? null,
    unhedged,
  };
}

/**
 * GS Atlas efficient curve for the hedge Optimize step.
 * Start fully on Target (min VaR, lock all hedge carry). Unhedge the
 * name that adds the most carry per extra diversified VaR — negative-carry
 * hedges come off first. Sweet = max carry, then lower VaR. Unhedged
 * stays off the plotted set (Basic carry = 0).
 */
export function fxAtlasHedgeFrontier(
  rows: readonly HedgeVarRow[],
  hedgeCarryByCcy: Record<string, number>,
): {
  curve: FxCarryVarPoint[];
  sweet: FxCarryVarPoint | null;
  fullyHedged: FxCarryVarPoint | null;
  unhedged: FxCarryVarPoint | null;
} {
  const fx = rows.filter(r => r.ccy !== 'USD');
  return walkAtlasEfficientSet(
    fx.map(r => r.ccy),
    (weights, id, kind) => fxAtlasPointAtWeights(fx, hedgeCarryByCcy, weights, id, kind),
  );
}

export const ATLAS_TENOR_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export type FxAtlasLeg = {
  ccy: string;
  tenorMonths: number;
  exposureLocalM: number;
  exposureUsdM: number;
  signedVarUsdM: number;
  hedgeCarryUsdM: number;
};

/** Stock in 1m, later months = FX-changing flow only. Sum = hedge Target. */
export function datedAtlasExposuresLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number[] {
  const T = Math.max(1, Math.round(forecastMonths) || 12);
  const stock = fxBookNetLocalM(row);
  const flows = monthlyFxFlowSeriesLocalM(row, T, profile);
  return Array.from({ length: T }, (_, i) => {
    const f = flows[i] ?? 0;
    return i === 0 ? stock + f : f;
  });
}

/**
 * Locked hedge carry for one name: Tf swap points / CIP on Σ Target
 * (the 12M bullet Book actually trades), not Σ dated-leg CIP.
 * Dated 1m…12m CIP on EUR 12.10mm is ~$0.11mm; 12M points are ~$0.21mm.
 */
export function atlasDatedHedgeCarryUsdM(input: {
  row: RowState;
  forecastMonths: number;
  forecastProfile?: ForecastProfileState | null;
  bundle?: FxMarketRatesBundle | null;
  rUsd?: number;
  hedgeRatio?: number;
}): number {
  const w = Number.isFinite(input.hedgeRatio)
    ? Math.min(1, Math.max(0, input.hedgeRatio as number))
    : 1;
  if (w < 1e-12) return 0;
  const rUsd = input.rUsd ?? 4;
  const rFcy =
    input.row.r_FCY ?? CURRENCY_PARAMS[input.row.ccy]?.carry ?? 0;
  const legs = buildFxAtlasLegs({
    rows: [input.row],
    forecastMonths: input.forecastMonths,
    forecastProfile: input.forecastProfile,
    rUsd,
    priceHedgeCarry: (ccy, trade, months) =>
      fwdHedgeCarryFromMarketUsd(
        trade,
        ccy,
        rFcy,
        rUsd,
        months,
        input.bundle,
      ),
  });
  return w * legs.reduce((s, l) => s + l.hedgeCarryUsdM, 0);
}

export function fxAtlasAnnVol(
  ccy: string,
  tenorMonths = 12,
  bundle?: FxMarketRatesBundle | null,
): number {
  return impliedFxVol(ccy, tenorMonths, bundle);
}

export function fxAtlasLegVarUsdM(
  exposureLocalM: number,
  spotUsd: number,
  tenorMonths: number,
  annVol: number,
  z: number,
): number {
  if (!(Math.abs(exposureLocalM) > 1e-12) || !(spotUsd > 0) || !(annVol > 0) || !(z > 0)) {
    return 0;
  }
  return Math.abs(exposureLocalM) * spotUsd * annVol * Math.sqrt(tenorMonths / 12) * z;
}

export function buildFxAtlasLegs(input: {
  rows: readonly RowState[];
  forecastMonths?: number;
  forecastProfile?: ForecastProfileState | null;
  confidencePct?: VarConfidencePct;
  rUsd?: number;
  priceHedgeCarry?: (
    ccy: string,
    hedgeTradeLocalM: number,
    tenorMonths: number,
  ) => number;
  volFor?: (ccy: string, tenorMonths: number) => number;
}): FxAtlasLeg[] {
  const T = Math.max(1, Math.round(input.forecastMonths ?? 12) || 12);
  const z = zForConfidence(input.confidencePct ?? 95);
  const rUsd = input.rUsd ?? 4;
  const out: FxAtlasLeg[] = [];
  for (const row of input.rows) {
    if (row.ccy === 'USD') continue;
    const spot = ccySpotRate(row.ccy);
    const rFcy = row.r_FCY ?? CURRENCY_PARAMS[row.ccy]?.carry ?? 0;
    const dated = datedAtlasExposuresLocalM(row, T, input.forecastProfile);
    dated.forEach((localM, i) => {
      if (Math.abs(localM) < 1e-9) return;
      const months = Math.min(12, i + 1);
      const usdM = localM * spot;
      const annVol = input.volFor?.(row.ccy, months) ?? fxAtlasAnnVol(row.ccy, months);
      const varUsdM = fxAtlasLegVarUsdM(localM, spot, months, annVol, z);
      const hedgeTrade = -localM;
      // Carry is the Tf bullet on this slice of Target — Book does not
      // trade a 1m forward on month-1 stock. VaR stays tenor-dated.
      const hedgeCarryUsdM = input.priceHedgeCarry
        ? input.priceHedgeCarry(row.ccy, hedgeTrade, T)
        : -hedgeTrade * spot * (rUsd - rFcy) / 100 * (T / 12);
      out.push({
        ccy: row.ccy,
        tenorMonths: months,
        exposureLocalM: localM,
        exposureUsdM: usdM,
        signedVarUsdM: localM < 0 ? -varUsdM : varUsdM,
        hedgeCarryUsdM,
      });
    });
  }
  return out;
}

function fxAtlasPointAtLegWeights(
  legs: readonly FxAtlasLeg[],
  weights: Record<string, number>,
  id: string,
  kind: FxCarryVarPoint['kind'],
  corr: AtlasCorrFn = atlasRiskCorr,
): FxCarryVarPoint {
  const ccys = [...new Set(legs.map(l => l.ccy))];
  const hedgeByLeg: Record<string, number> = {};
  const notionByCcy: Record<string, number> = {};
  const weightByCcy: Record<string, number> = {};
  for (const l of legs) {
    const w = atlasLegHedgeWeight(weights, l.ccy, l.tenorMonths);
    hedgeByLeg[atlasLegKey(l.ccy, l.tenorMonths)] = w;
    const n = Math.abs(l.exposureUsdM);
    notionByCcy[l.ccy] = (notionByCcy[l.ccy] ?? 0) + n;
    weightByCcy[l.ccy] = (weightByCcy[l.ccy] ?? 0) + w * n;
  }
  const hedgeByCcy: Record<string, number> = {};
  for (const ccy of ccys) {
    const n = notionByCcy[ccy] ?? 0;
    hedgeByCcy[ccy] = n > 1e-12
      ? clampHedgeWeight((weightByCcy[ccy] ?? 0) / n)
      : clampHedgeWeight(weights[ccy] ?? 0);
  }
  const contribs = legs.map(l => ({
    ccy: l.ccy,
    tenorMonths: l.tenorMonths,
    usdM: (1 - (hedgeByLeg[atlasLegKey(l.ccy, l.tenorMonths)] ?? 0))
      * l.signedVarUsdM,
  }));
  const risk = diversifiedUsdRisk(contribs, corr);
  const carryByCcy: Record<string, number> = {};
  let carry = 0;
  for (const l of legs) {
    const w = hedgeByLeg[atlasLegKey(l.ccy, l.tenorMonths)] ?? 0;
    const add = l.hedgeCarryUsdM * w;
    carryByCcy[l.ccy] = (carryByCcy[l.ccy] ?? 0) + add;
    carry += add;
  }
  const avgW = ccys.length === 0
    ? 0
    : ccys.reduce((s, c) => s + (hedgeByCcy[c] ?? 0), 0) / ccys.length;
  return {
    id,
    t: 1 - avgW,
    carryUsdYrM: carry,
    divVarUsdM: risk.portfolioUsdM,
    standaloneVarUsdM: risk.standaloneUsdM,
    kind,
    hedgeByCcy,
    hedgeByLeg,
    carryByCcy,
  };
}

/** Price a live per-CCY mix on the Atlas tenor legs (bar tweaks on Optimize). */
export function fxAtlasPointAtCcyWeights(
  legs: readonly FxAtlasLeg[],
  weightsByCcy: Readonly<Record<string, number>>,
  corr: AtlasCorrFn = atlasRiskCorr,
  id = 'live-mix',
): FxCarryVarPoint {
  return fxAtlasPointAtLegWeights(legs, { ...weightsByCcy }, id, 'mix', corr);
}

/**
 * True when `live` is inside / below the pre-rendered set: some frontier
 * knot has lower-or-equal VaR and higher-or-equal carry (strict in one).
 */
export function fxAtlasMixWorseThanFrontier(
  live: Pick<FxCarryVarPoint, 'divVarUsdM' | 'carryUsdYrM'>,
  curve: readonly Pick<FxCarryVarPoint, 'divVarUsdM' | 'carryUsdYrM'>[],
  eps = 1e-4,
): boolean {
  if (curve.length === 0) return false;
  const onSet = curve.some(p =>
    Math.abs(p.divVarUsdM - live.divVarUsdM) <= eps
    && Math.abs(p.carryUsdYrM - live.carryUsdYrM) <= eps,
  );
  if (onSet) return false;
  return curve.some(p =>
    p.divVarUsdM <= live.divVarUsdM + eps
    && p.carryUsdYrM >= live.carryUsdYrM - eps
    && (p.divVarUsdM < live.divVarUsdM - eps || p.carryUsdYrM > live.carryUsdYrM + eps),
  );
}

function mixHedgeWeights(
  a: Readonly<Record<string, number>> | undefined,
  b: Readonly<Record<string, number>> | undefined,
  t: number,
): Record<string, number> {
  const keys = new Set([
    ...Object.keys(a ?? {}),
    ...Object.keys(b ?? {}),
  ]);
  const out: Record<string, number> = {};
  for (const k of keys) {
    const av = a?.[k] ?? 0;
    const bv = b?.[k] ?? 0;
    out[k] = av + t * (bv - av);
  }
  return out;
}

/**
 * Atlas Efficient Frontier sheet: 20 knots. Spaced by cumulative distance
 * along the actual (VaR, Carry) path — each axis normalized by its own
 * end-to-end range first — not by equal steps in raw carry. Equal-carry
 * spacing puts many of the 20 knots inside a single steep segment
 * whenever the walk has a near-vertical jump (a real critical-line kink:
 * a big carry gain for almost no extra VaR, not a bug in the walk
 * itself), starving every other segment of knots. Verified on a real
 * 5-currency book: equal-carry spacing put 3 of 20 knots within 0.0005
 * VaR of each other right at such a kink, then a big gap either side —
 * visibly clustered/broken next to the vendor's own smooth curve for the
 * same book. Arc-length spacing spreads knots by how far the mix
 * actually moved, so it degrades gracefully at a kink instead of piling
 * up on top of it.
 */
export function resampleAtlasEqualCarry(
  path: readonly FxCarryVarPoint[],
  pointAt: (
    weights: Record<string, number>,
    id: string,
    kind: FxCarryVarPoint['kind'],
  ) => FxCarryVarPoint,
  n = ATLAS_FRONTIER_POINTS,
): FxCarryVarPoint[] {
  if (path.length === 0) return [];
  if (path.length === 1 || n <= 2) return [...path];
  const y0 = path[0]!.carryUsdYrM;
  const y1 = path[path.length - 1]!.carryUsdYrM;
  if (Math.abs(y1 - y0) < 1e-9) return [path[0]!, path[path.length - 1]!];
  const varSpan = Math.max(
    Math.abs(path[path.length - 1]!.divVarUsdM - path[0]!.divVarUsdM),
    1e-9,
  );
  const carrySpan = Math.max(Math.abs(y1 - y0), 1e-9);
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const dv = (path[i]!.divVarUsdM - path[i - 1]!.divVarUsdM) / varSpan;
    const dc = (path[i]!.carryUsdYrM - path[i - 1]!.carryUsdYrM) / carrySpan;
    cum.push(cum[i - 1]! + Math.hypot(dv, dc));
  }
  const total = cum[cum.length - 1]!;
  const out: FxCarryVarPoint[] = [];
  for (let i = 0; i < n; i++) {
    const target = total * (i / (n - 1));
    let s = 0;
    while (
      s < path.length - 2
      && cum[s + 1]! < target - 1e-12
    ) {
      s += 1;
    }
    const a = path[s]!;
    const b = path[s + 1] ?? a;
    const segLen = cum[s + 1]! - cum[s]!;
    const t = segLen < 1e-12
      ? 0
      : Math.min(1, Math.max(0, (target - cum[s]!) / segLen));
    const weights = mixHedgeWeights(
      a.hedgeByLeg ?? a.hedgeByCcy,
      b.hedgeByLeg ?? b.hedgeByCcy,
      t,
    );
    const kind: FxCarryVarPoint['kind'] =
      i === 0 ? 'hedged' : i === n - 1 ? 'mix' : 'walk';
    const id = i === 0
      ? (path[0]!.id || 'atlas-hedged')
      : i === n - 1
        ? (path[path.length - 1]!.id || 'atlas-sweet')
        : `atlas-ef-${i}`;
    out.push(pointAt(weights, id, kind));
  }
  return out;
}

export type FxAtlasFrontierOpts = {
  /** Names pinned fully open (hedge 0%). The rest re-solve at each VaR cap. */
  forceOpenCcys?: ReadonlySet<string>;
};

/** Optimizer pins: u = 1 means the leg stays unhedged. */
export function atlasForceOpenPins(
  legs: readonly FxAtlasLeg[],
  forceOpenCcys?: ReadonlySet<string>,
): Map<number, 0 | 1> | undefined {
  if (!forceOpenCcys || forceOpenCcys.size === 0) return undefined;
  const pins = new Map<number, 0 | 1>();
  legs.forEach((l, i) => {
    if (forceOpenCcys.has(l.ccy)) pins.set(i, 1);
  });
  return pins.size > 0 ? pins : undefined;
}

/**
 * A currency whose own carry doesn't clear the dust bar (atlasUnhedgeWorthIt
 * — "$6k carry — GBP vs USD is dust; not worth the VaR of leaving it open")
 * must never be opened at ANY cap, full stop. That check is a per-NAME gate
 * in walkAtlasEfficientSet (a currency only ever gets peeled if opening IT
 * pays for the VaR), but the tenor-level solver has no equivalent: its
 * per-cap re-optimization can nudge a zero-carry name open purely for
 * portfolio-variance reasons (it happens to be correlated with something
 * else that's opening) even though NOTHING compensates for taking that
 * name's own FX risk. atlasWorthyStopIndex only gates how far the whole
 * curve walks, not which currencies are eligible to open at all within a
 * cap that does clear the bar — so a dust name could still show a partial
 * hedge ratio at an otherwise-worthwhile point. Pin every leg of a dust
 * name at u=0 for the whole sweep instead, same as a user's explicit "keep
 * hedged". Tested against the pure fully-hedged baseline (opening every
 * OTHER name first can only make a name's own carry look relatively less
 * attractive, never more, so this is the single most generous point to
 * test it — if it fails here, it fails everywhere).
 */
export function atlasDustCurrencyPins(
  legs: readonly FxAtlasLeg[],
  pointAt: (
    weights: Record<string, number>,
    id: string,
    kind: FxCarryVarPoint['kind'],
  ) => FxCarryVarPoint,
): Map<number, 0 | 1> {
  const pins = new Map<number, 0 | 1>();
  const keys = [...new Set(legs.map(l => atlasLegKey(l.ccy, l.tenorMonths)))];
  if (keys.length === 0) return pins;
  const ones: Record<string, number> = {};
  for (const key of keys) ones[key] = 1;
  const fullyHedged = pointAt(ones, 'tmp-dust-hedged', 'hedged');
  const ccys = [...new Set(legs.map(l => l.ccy))];
  for (const ccy of ccys) {
    const trialWeights = { ...ones };
    legs.forEach(l => {
      if (l.ccy === ccy) trialWeights[atlasLegKey(l.ccy, l.tenorMonths)] = 0;
    });
    const trial = pointAt(trialWeights, 'tmp-dust-trial', 'mix');
    if (!atlasUnhedgeWorthIt(fullyHedged, trial)) {
      legs.forEach((l, idx) => {
        if (l.ccy === ccy) pins.set(idx, 0);
      });
    }
  }
  return pins;
}

const TENOR_FRONTIER_SWEEP_POINTS = 48;

/**
 * Optimize-step curve: per-(CCY×tenor) leg efficient frontier, re-solved
 * from scratch at each VaR budget (see fx-hedge-frontier-optimizer.ts),
 * then resampled to 20 equal-carry knots — same contract as a vendor
 * reference Efficient Frontier sheet.
 *
 * Previously walked greedily (peel the single best-scoring leg fully off,
 * one at a time, never revisit) — a monotonic ratchet that cannot express
 * a reference frontier un-hedging one leg while re-hedging another at the
 * same risk budget (verified against a real vendor frontier: this
 * happens, and the greedy walk landed materially short of the achievable
 * carry at matched VaR). The box-constrained solver re-optimizes the
 * whole free set at each cap instead.
 */
export function fxAtlasTenorFrontier(
  legs: readonly FxAtlasLeg[],
  corr: AtlasCorrFn = atlasRiskCorr,
  opts?: FxAtlasFrontierOpts,
): {
  curve: FxCarryVarPoint[];
  sweet: FxCarryVarPoint | null;
  fullyHedged: FxCarryVarPoint | null;
  unhedged: FxCarryVarPoint | null;
  /** Currencies whose own carry is dust — cleaned back to 100% hedged in `sweet` only. */
  dustPinnedCcys: string[];
} {
  const keys = [...new Set(legs.map(l => atlasLegKey(l.ccy, l.tenorMonths)))];
  const pointAt = (
    weights: Record<string, number>,
    id: string,
    kind: FxCarryVarPoint['kind'],
  ) => fxAtlasPointAtLegWeights(legs, weights, id, kind, corr);
  if (keys.length === 0) {
    return { curve: [], sweet: null, fullyHedged: null, unhedged: null, dustPinnedCcys: [] };
  }
  const zeros: Record<string, number> = {};
  for (const key of keys) zeros[key] = 0;
  const unhedged = pointAt(zeros, 'atlas-unhedged', 'unhedged');
  // Reporting-only now (see the sweet-point comment below for why this no
  // longer forces anything): a vendor reference frontier has NO per-name
  // dust gate anywhere, curve or recommendation — verified on an isolated
  // GBP report (walks its full range even for a near-zero-carry name) and
  // an isolated PLN report (recommends fully OPEN at zero cost, which a
  // dust gate on PLN would have blocked). Kept only to flag, in the log,
  // which currencies fail the old per-name check yet still end up with
  // some open weight at the recommended point.
  const dustCcys = [...new Set(
    [...atlasDustCurrencyPins(legs, pointAt).keys()].map(i => legs[i]!.ccy),
  )].filter(ccy => !opts?.forceOpenCcys?.has(ccy));
  const forcedPins = atlasForceOpenPins(legs, opts?.forceOpenCcys);

  const maxCapUsdM = Math.max(0, unhedged.divVarUsdM);
  const path: FxCarryVarPoint[] = [];
  // Each cap is solved independently. An earlier version carried forward
  // fully-open legs as forced pins for the next (larger) cap to guarantee
  // monotonicity by construction — verified against a real 5-currency
  // vendor reference frontier that this makes carry MATERIALLY WORSE in
  // the middle of the curve (forcing a leg to stay open prevents the
  // solver from partially closing it again when that turns out to be part
  // of the true joint optimum at a larger cap — carry error grew to ~7x
  // larger than the unconstrained solve's worst point). Independent solves
  // are more accurate; any residual non-monotonicity is handled below.
  for (let i = 0; i <= TENOR_FRONTIER_SWEEP_POINTS; i++) {
    const cap = (maxCapUsdM * i) / TENOR_FRONTIER_SWEEP_POINTS;
    const sol = solveHedgeFrontierAtCap(legs, corr, cap, 1.645, forcedPins);
    const weightsAtCap: Record<string, number> = {};
    legs.forEach((l, idx) => {
      weightsAtCap[atlasLegKey(l.ccy, l.tenorMonths)] = 1 - sol.u[idx]!;
    });
    const kind: FxCarryVarPoint['kind'] = i === 0 ? 'hedged' : 'walk';
    const id = i === 0 ? 'atlas-hedged' : `atlas-${i - 1}`;
    path.push(pointAt(weightsAtCap, id, kind));
  }

  // The full achievable range, not truncated at any per-step materiality
  // bar. atlasWorthyStopIndex's old $6k-per-step floor was sized for the
  // currency-level walk's coarse jumps (one whole name's full unhedge);
  // against this walk's much finer per-cap steps it rejected the FIRST
  // comparison whenever a name's entire achievable carry (e.g. a single
  // small currency's ~$6.6k full swing) was smaller than that one-shot
  // bar, collapsing a genuine, smooth 24-point curve down to 1 point —
  // verified against a real single-currency (PLN) reference report,
  // which shows its best point at fully OPEN/zero cost, not fully hedged
  // at negative carry. The vendor's own published curve has no per-step
  // gate either (verified on an isolated GBP report: it walks its full
  // range even for a near-zero-carry name). fxAtlasSweetPoint (below)
  // still finds the correct global max on this full, monotone-carry
  // range; dust-currency protection happens separately (see dustCcys).
  const rising = atlasMonotoneCarry(atlasMonotoneEfficient(path));
  const resampled = resampleAtlasEqualCarry(rising, pointAt);
  // Linear weight interpolation between two monotonic raw knots does not
  // guarantee a monotonic VaR at the interpolated point — risk is a
  // quadratic (not linear) function of the weights. atlasMonotoneEfficient
  // would fix that by DROPPING the offending knot, which breaks the
  // "exactly ATLAS_FRONTIER_POINTS knots" contract equal-carry resampling
  // exists to guarantee. Clamp instead: nudge divVarUsdM up to match the
  // previous knot on the rare occasion it dips (a running max), keeping
  // every knot's carry/weights untouched and the count exact.
  let runningMaxVar = Number.NEGATIVE_INFINITY;
  const sampled = resampled.map(p => {
    if (p.divVarUsdM < runningMaxVar) {
      const clamped = { ...p, divVarUsdM: runningMaxVar };
      return clamped;
    }
    runningMaxVar = p.divVarUsdM;
    return p;
  });
  // Recommended = the true global max-carry point on this full, unclamped
  // frontier, no cleaning. An earlier version snapped any currency
  // flagged "dust" (atlasDustCurrencyPins) back to 100% hedged here — but
  // a real single-currency (PLN) vendor reference proved that wrong: PLN
  // clears the $6k absolute floor but not the 3%-of-VaR ratio floor, yet
  // the vendor's own optimum for it is fully OPEN at zero cost, not
  // hedged at a loss. Those per-VaR/per-name thresholds were carried over
  // from the old currency-level walk and don't hold up against a real
  // report: the solver's own unconstrained math already puts a genuinely
  // negative-mu name (e.g. EUR, GBP with real market rates) at 100%
  // hedged on its own, with no gate needed — and correctly opens a
  // genuinely positive-mu name (PLN, TRY, MXN, JPY here) however small
  // its edge, matching the vendor. dustPinnedCcys is now reporting-only:
  // which currencies fail that per-name check yet still show some open
  // weight at the recommended point, for visibility into where the
  // solver and that heuristic disagree — it no longer changes the mix.
  const sweet = fxAtlasSweetPoint(sampled);
  const sweetIdx = sweet ? sampled.findIndex(p => p.id === sweet.id) : -1;
  const efficient = sweetIdx >= 0 ? sampled.slice(0, sweetIdx + 1) : sampled;
  if (efficient.length > 0 && sweet) {
    efficient[efficient.length - 1] = { ...sweet, kind: 'mix' };
  }
  const dustPinnedCcys = dustCcys.filter(ccy => {
    const raw = sweet?.hedgeByCcy?.[ccy] ?? 1;
    return raw < 1 - 1e-9;
  });
  return {
    curve: efficient,
    sweet: efficient[efficient.length - 1] ?? sweet,
    fullyHedged: efficient[0] ?? null,
    unhedged,
    dustPinnedCcys,
  };
}

/**
 * Atlas "Hedge Carry Cost vs Risk Reduction by Currency".
 *
 * One bubble per residual CCY×tenor. `hedgeByCcy` scales the book to a
 * frontier mix (1 = already on Target). X = carry given up by covering
 * that residual tenor (% of its open USD notional). Y = Euler share of
 * residual diversified VaR. Fully covered names drop out.
 */
export type FxAtlasMarginalPoint = {
  id: string;
  ccy: string;
  tenorMonths: number;
  marginalCarryCostPct: number;
  marginalRiskReductionPct: number;
  hedgeNotionalUsdM: number;
  hedgeCarryUsdM: number;
  eulerUsdM: number;
  efficiency: number;
  isFreeHedge: boolean;
};

function atlasOpenFrac(
  ccy: string,
  hedgeByCcy?: Readonly<Record<string, number>>,
): number {
  if (!hedgeByCcy) return 1;
  const w = hedgeByCcy[ccy];
  if (!Number.isFinite(w)) return 1;
  return 1 - Math.min(1, Math.max(0, w));
}

export function fxAtlasMarginalEffects(
  legs: readonly FxAtlasLeg[],
  hedgeByCcy?: Readonly<Record<string, number>>,
  corr: AtlasCorrFn = atlasRiskCorr,
): FxAtlasMarginalPoint[] {
  const residual = legs.map(l => {
    const open = atlasOpenFrac(l.ccy, hedgeByCcy);
    return {
      ...l,
      signedVarUsdM: open * l.signedVarUsdM,
      exposureUsdM: open * l.exposureUsdM,
      hedgeCarryUsdM: open * l.hedgeCarryUsdM,
    };
  });
  const xs = residual.filter(
    l => Number.isFinite(l.signedVarUsdM)
      && Math.abs(l.signedVarUsdM) > 1e-12
      && Math.abs(l.exposureUsdM) > 1e-12,
  );
  if (xs.length === 0) return [];
  const risk = diversifiedUsdRisk(
    xs.map(l => ({ ccy: l.ccy, tenorMonths: l.tenorMonths, usdM: l.signedVarUsdM })),
    corr,
  );
  const port = risk.portfolioUsdM;
  return xs.map((l, i) => {
    const euler = risk.byCcy[i]?.componentUsdM ?? 0;
    const notional = Math.max(Math.abs(l.exposureUsdM), 1e-9);
    const marginalCarryCostPct = (-l.hedgeCarryUsdM / notional) * 100;
    const marginalRiskReductionPct = port > 1e-12 ? (euler / port) * 100 : 0;
    return {
      id: `marg-${l.ccy}-${l.tenorMonths}`,
      ccy: l.ccy,
      tenorMonths: l.tenorMonths,
      marginalCarryCostPct,
      marginalRiskReductionPct,
      hedgeNotionalUsdM: notional,
      hedgeCarryUsdM: l.hedgeCarryUsdM,
      eulerUsdM: euler,
      efficiency:
        marginalCarryCostPct > 1e-9
          ? marginalRiskReductionPct / marginalCarryCostPct
          : Number.POSITIVE_INFINITY,
      isFreeHedge:
        marginalCarryCostPct <= 1e-9 && marginalRiskReductionPct > 1e-9,
    };
  });
}
