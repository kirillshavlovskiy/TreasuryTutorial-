/**
 * Named overlay presets on the limited-universe carry/VAR curve.
 *
 * Conservative = nearest $5M Treasury rung
 * Balanced     = sweep knee (`sweetSpotIndex`)
 * Max Carry    = nearest $20M CFO rung
 * Max E[Return]= max of strategy E[return]
 *   determined carry − E[loss] on hedgeable standing CFaR
 * (same `probabilityWeightedReturnUsdM` as the Book Weighted column;
 * if the unconstrained winner is the swept edge, falls back to the best
 * point inside Policy VAR)
 *
 * Shared by the Optimize cards, the plot markers, and apply-on-click so the
 * three surfaces cannot drift apart on what "Balanced" means.
 */

import {
  computePortfolioCarryFrontier,
  type PortfolioCarryFrontierInput,
} from '@/lib/dashboard-model';
import {
  POLICY_VAR_LIMITS,
  universePolicyVarCap,
  type PortfolioCarryFrontier,
  type PortfolioCarryFrontierPoint,
} from '@/lib/fx-buffer';
import {
  probabilityWeightedReturnUsdM,
} from '@/lib/test-mode/liquidity-strategies';
import { paretoSkyline } from '@/lib/test-mode/pareto-scenarios';

export type PortfolioScenarioId =
  | 'unhedged'
  | 'conservative'
  | 'carryTarget'
  | 'balanced'
  | 'maxCarry'
  | 'maxReturn';

export interface PortfolioScenarioDef {
  id: PortfolioScenarioId;
  label: string;
  point: PortfolioCarryFrontierPoint | null;
  disabledHint?: string;
}

export const PORTFOLIO_SCENARIO_COLORS: Record<PortfolioScenarioId, string> = {
  unhedged: '#94a3b8',
  conservative: '#60a5fa',
  carryTarget: '#60a5fa',
  balanced: '#f59e0b',
  maxCarry: '#a78bfa',
  maxReturn: '#34d399',
};

export function roundPolicyVar(usdM: number): number {
  return Math.round(usdM * 10) / 10;
}

/** Nearest sampled point to a target VAR ($M) — used for the fixed-tier scenarios. */
export function nearestFrontierPoint(
  points: readonly PortfolioCarryFrontierPoint[],
  targetVarUsd: number,
): PortfolioCarryFrontierPoint | null {
  if (points.length === 0) return null;
  let best = points[0]!;
  for (const p of points) {
    if (Math.abs(p.portfolioVarUsd - targetVarUsd) < Math.abs(best.portfolioVarUsd - targetVarUsd)) best = p;
  }
  return best;
}

/**
 * Strategy E[return] at a frontier point — same Book Weighted column:
 *   determined income (cash + swap carry from rates × exposure)
 *   − E[loss] on hedgeable standing CFaR above the unhedged floor
 *
 * Portfolio CFaR already embeds pair VaR, notional size, and Σ factor
 * sensitivities (vols × correlations). Haircutting the full CFaR would
 * charge residual cash-path risk that no overlay changes.
 */
export function strategyExpectedReturnUsdM(
  point: Pick<PortfolioCarryFrontierPoint, 'totalCarryUsdYr' | 'portfolioVarUsd'>,
  confidencePct: number,
  floorCfarUsdM = 0,
): number {
  return probabilityWeightedReturnUsdM(
    point.totalCarryUsdYr,
    point.portfolioVarUsd,
    confidencePct,
    floorCfarUsdM,
  );
}

/**
 * Point maximizing strategy E[return] at the desk's confidence chip.
 *
 * When the unconstrained winner sits on the far edge of the swept range
 * (objective still climbing with the window), fall back to the best point
 * still inside `policyCapUsdM` so Max E[Return] stays selectable under the
 * live Policy VAR — instead of going permanently n/a on a rising ray.
 * Null only when there is no usable point in that window.
 */
export function maxExpectedReturnFrontierPoint(
  points: readonly PortfolioCarryFrontierPoint[],
  confidencePct: number,
  floorCfarUsdM?: number | null,
  policyCapUsdM?: number | null,
): PortfolioCarryFrontierPoint | null {
  if (points.length === 0) return null;
  const finiteVars = points.map(p => p.portfolioVarUsd).filter(Number.isFinite);
  const floor = floorCfarUsdM != null && Number.isFinite(floorCfarUsdM)
    ? Math.max(0, floorCfarUsdM)
    : (finiteVars.length > 0 ? Math.min(...finiteVars) : 0);
  const scoreOf = (p: PortfolioCarryFrontierPoint) => (
    strategyExpectedReturnUsdM(p, confidencePct, floor)
  );
  const pickBest = (pool: readonly PortfolioCarryFrontierPoint[]) => {
    let bestIdx = 0;
    let bestScore = scoreOf(pool[0]!);
    pool.forEach((p, i) => {
      const score = scoreOf(p);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    return { bestIdx, best: pool[bestIdx]! };
  };

  const global = pickBest(points);
  const atSweepEdge = global.bestIdx === points.length - 1 && points.length > 1;
  if (!atSweepEdge) return global.best;

  const cap = policyCapUsdM != null && Number.isFinite(policyCapUsdM) && policyCapUsdM > 0
    ? policyCapUsdM
    : null;
  if (cap == null) return null;
  const within = points.filter(p => (
    Number.isFinite(p.portfolioVarUsd) && p.portfolioVarUsd <= cap + 0.05
  ));
  if (within.length === 0) return null;
  return pickBest(within).best;
}

export function portfolioScenarioDefs(
  frontier: PortfolioCarryFrontier | null,
  confidencePct: number,
): PortfolioScenarioDef[] {
  const pts = frontier?.points ?? [];
  const minTier = POLICY_VAR_LIMITS[0]!.usd;
  const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  const sweet = frontier && frontier.sweetSpotIndex >= 0
    ? frontier.points[frontier.sweetSpotIndex] ?? null
    : null;
  const directorTier = POLICY_VAR_LIMITS[1]?.usd ?? 10;
  const floorCfarUsdM = pts.length > 0
    ? Math.min(...pts.map(p => p.portfolioVarUsd).filter(Number.isFinite))
    : 0;
  return [
    {
      id: 'conservative',
      label: 'Conservative',
      point: nearestFrontierPoint(pts, minTier),
    },
    {
      id: 'balanced',
      label: 'Balanced',
      // Floor-clamp knee when the ray actually bends; otherwise the Director
      // $10M rung — a real third book, not a 2× scale of Conservative.
      point: sweet ?? nearestFrontierPoint(pts, directorTier),
      disabledHint: sweet
        ? undefined
        : (frontier?.nearestClampVarUsd != null
          ? `no knee in range — first clamp is ${frontier.nearestClampCcy} at $${frontier.nearestClampVarUsd.toFixed(1)}M VaR; using the $${directorTier.toFixed(0)}M Director rung`
          : `no floor-clamp knee — using the $${directorTier.toFixed(0)}M Director rung`),
    },
    {
      id: 'maxCarry',
      label: 'Max Carry',
      point: nearestFrontierPoint(pts, maxTier),
    },
    {
      id: 'maxReturn',
      label: 'Max E[Return]',
      point: maxExpectedReturnFrontierPoint(pts, confidencePct, floorCfarUsdM, maxTier),
      disabledHint: 'no frontier point inside the Policy VAR window to score',
    },
  ];
}

export interface PricedOverlaySample {
  overlayVarUsdM: number;
  bookCarryUsdYrM: number;
  overlayCarryUsdYrM?: number;
  mix?: string;
}

export interface GeneratedParetoPick {
  id: PortfolioScenarioId;
  label: string;
  rationale: string;
  short: string;
  overlayVarUsdM: number;
  bookCarryUsdYrM: number;
  mix: string;
  disabled: boolean;
  disabledHint?: string;
}

/** VAR gap that still counts as the same named book (not a 4× scale clone). */
const SAME_BOOK_VAR_M = 1.5;

function sameVar(a: number, b: number, tol = 0.45): boolean {
  return Math.abs(a - b) < tol;
}

function richestAtOrBelow(
  samples: readonly PricedOverlaySample[],
  capUsdM: number,
): PricedOverlaySample | null {
  const inside = samples.filter(s => (
    Number.isFinite(s.overlayVarUsdM)
    && Number.isFinite(s.bookCarryUsdYrM)
    && s.overlayVarUsdM <= capUsdM + 1e-9
  ));
  if (inside.length === 0) return null;
  return inside.reduce((best, s) => (
    s.bookCarryUsdYrM > best.bookCarryUsdYrM
    || (s.bookCarryUsdYrM === best.bookCarryUsdYrM && s.overlayVarUsdM < best.overlayVarUsdM)
      ? s
      : best
  ));
}

function minVarHittingCarry(
  samples: readonly PricedOverlaySample[],
  carryTargetUsdYrM: number,
): PricedOverlaySample | null {
  const hits = samples.filter(s => s.bookCarryUsdYrM + 1e-9 >= carryTargetUsdYrM);
  if (hits.length === 0) return null;
  return hits.reduce((best, s) => s.overlayVarUsdM < best.overlayVarUsdM ? s : best);
}

function skylineKneeSample(
  samples: readonly PricedOverlaySample[],
): PricedOverlaySample | null {
  const sky = paretoSkyline(samples.map(s => ({
    carryUsdYrM: s.bookCarryUsdYrM,
    riskUsdM: s.overlayVarUsdM,
  })));
  if (sky.length < 3) return null;
  const p0 = sky[0]!;
  const pN = sky[sky.length - 1]!;
  const dx = pN.riskUsdM - p0.riskUsdM;
  const dy = pN.carryUsdYrM - p0.carryUsdYrM;
  const norm = Math.hypot(dx, dy);
  if (norm < 1e-9) return null;
  let bestIdx = -1;
  let bestDist = -Infinity;
  sky.forEach((p, i) => {
    if (i === 0 || i === sky.length - 1) return;
    const cross = (p.riskUsdM - p0.riskUsdM) * dy - (p.carryUsdYrM - p0.carryUsdYrM) * dx;
    const dist = Math.abs(cross) / norm;
    if (dist > bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  });
  if (bestIdx < 0 || bestDist < 1e-6) return null;
  const knee = sky[bestIdx]!;
  return samples.find(s => (
    Math.abs(s.overlayVarUsdM - knee.riskUsdM) < 1e-6
    && Math.abs(s.bookCarryUsdYrM - knee.carryUsdYrM) < 1e-6
  )) ?? null;
}

/** Overlay VAR knots to price when generating Pareto books. */
export function overlaySampleVars(
  frontier: PortfolioCarryFrontier | null,
  budgetUsdM: number,
): number[] {
  const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  const minTier = POLICY_VAR_LIMITS[0]!.usd;
  const director = POLICY_VAR_LIMITS[1]?.usd ?? 10;
  const vars = new Set<number>([minTier, director, maxTier, budgetUsdM]);
  for (let v = minTier; v <= maxTier + 1e-9; v += 0.5) {
    vars.add(Math.round(v * 10) / 10);
  }
  if (frontier?.nearestClampVarUsd != null && frontier.nearestClampVarUsd <= maxTier * 1.05) {
    vars.add(frontier.nearestClampVarUsd);
  }
  if (frontier && frontier.sweetSpotIndex >= 0) {
    const k = frontier.points[frontier.sweetSpotIndex]?.portfolioVarUsd;
    if (k != null) vars.add(k);
  }
  const pts = frontier?.points ?? [];
  if (pts.length > 2) {
    const step = Math.max(1, Math.floor(pts.length / 12));
    for (let i = 0; i < pts.length; i += step) {
      vars.add(pts[i]!.portfolioVarUsd);
    }
    vars.add(pts[pts.length - 1]!.portfolioVarUsd);
  }
  return [...vars]
    .filter(v => Number.isFinite(v) && v > 0.3 && v <= maxTier * 1.05)
    .sort((a, b) => a - b);
}

/**
 * Named books a desk would actually run — optima on the sampled Pareto
 * front, not $5M/$20M clones of one mix.
 *
 *   Conservative — max cash Δr s.t. overlay VAR ≤ $5M (Treasury)
 *   Balanced     — typed carry ask at min VAR, else the Policy-feasible
 *                  book when that is interior, else Director / skyline
 *                  mid — never a $20M clone of Conservative
 *   Max Carry    — max cash Δr s.t. overlay VAR ≤ $20M (can be inside
 *                  the cap if carry already turned over)
 *   Max E[Return]— interior max of strategy E[return]
 *                  (determined cash Δr − E[loss] on overlay VaR;
 *                  VaR already embeds pair size × factor sensitivities)
 */
export function generateUsableParetoScenarios(input: {
  samples: readonly PricedOverlaySample[];
  budgetUsdM: number;
  carryTargetUsdYrM?: number;
  confidencePct: number;
  treasuryUsdM?: number;
  universeMaxUsdM?: number;
}): GeneratedParetoPick[] {
  const treasury = input.treasuryUsdM ?? POLICY_VAR_LIMITS[0]!.usd;
  const universeMax = input.universeMaxUsdM ?? POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  const director = POLICY_VAR_LIMITS[1]?.usd ?? 10;
  const budget = input.budgetUsdM > 0 ? input.budgetUsdM : director;
  const samples = input.samples.filter(s => (
    Number.isFinite(s.overlayVarUsdM)
    && Number.isFinite(s.bookCarryUsdYrM)
    && s.overlayVarUsdM <= universeMax * 1.05 + 1e-9
  ));

  const pick = (
    id: PortfolioScenarioId,
    label: string,
    sample: PricedOverlaySample | null,
    rationale: string,
    disabledHint?: string,
  ): GeneratedParetoPick => ({
    id,
    label,
    rationale,
    short: sample?.mix || (sample ? `$${sample.overlayVarUsdM.toFixed(1)}M fill` : (disabledHint ?? 'n/a')),
    overlayVarUsdM: sample?.overlayVarUsdM ?? 0,
    bookCarryUsdYrM: sample?.bookCarryUsdYrM ?? 0,
    mix: sample?.mix ?? '',
    disabled: sample == null,
    disabledHint,
  });

  const conservative = richestAtOrBelow(samples, treasury);
  const maxCarry = richestAtOrBelow(samples, universeMax);

  const ask = input.carryTargetUsdYrM != null && Number.isFinite(input.carryTargetUsdYrM)
    ? input.carryTargetUsdYrM
    : null;
  const hitAsk = ask != null && ask > 0 ? minVarHittingCarry(samples, ask) : null;
  const knee = skylineKneeSample(samples);
  const budgetFill = richestAtOrBelow(samples, budget);
  const directorFill = richestAtOrBelow(samples, director);
  const budgetIsUniverseMax = sameVar(budget, universeMax, SAME_BOOK_VAR_M);
  const distinctFromEnds = (s: PricedOverlaySample | null) => (
    s != null
    && !(conservative && sameVar(s.overlayVarUsdM, conservative.overlayVarUsdM, SAME_BOOK_VAR_M))
    && !(maxCarry && sameVar(s.overlayVarUsdM, maxCarry.overlayVarUsdM, SAME_BOOK_VAR_M))
  );
  const nearestTo = (targetUsdM: number): PricedOverlaySample | null => {
    const interior = samples.filter(distinctFromEnds);
    if (interior.length === 0) return null;
    return interior.reduce((best, s) => (
      Math.abs(s.overlayVarUsdM - targetUsdM) < Math.abs(best.overlayVarUsdM - targetUsdM) ? s : best
    ));
  };

  type BalancedWhy = 'ask' | 'budget' | 'knee' | 'director' | 'mid';
  let balanced: PricedOverlaySample | null = null;
  let balancedWhy: BalancedWhy | null = null;
  if (distinctFromEnds(hitAsk)) {
    balanced = hitAsk;
    balancedWhy = 'ask';
  } else if (!budgetIsUniverseMax && distinctFromEnds(budgetFill)) {
    balanced = budgetFill;
    balancedWhy = 'budget';
  } else if (distinctFromEnds(knee)) {
    balanced = knee;
    balancedWhy = 'knee';
  } else if (distinctFromEnds(directorFill)) {
    balanced = directorFill;
    balancedWhy = 'director';
  } else if (conservative && maxCarry) {
    const mid = nearestTo((conservative.overlayVarUsdM + maxCarry.overlayVarUsdM) / 2);
    if (mid) {
      balanced = mid;
      balancedWhy = 'mid';
    }
  }

  const balancedRationale = (): string => {
    if (balancedWhy === 'ask' && ask != null) {
      return `Min overlay VAR that still prints the $${(ask * 1000).toFixed(0)}K/yr carry ask.`;
    }
    if (balancedWhy === 'budget') {
      return `Max cash Δr with overlay VAR ≤ the $${budget.toFixed(0)}M Policy budget — the book you can run without raising the cap.`;
    }
    if (balancedWhy === 'knee') {
      return 'Pareto knee — last increment of VAR that still buys meaningful cash Δr.';
    }
    if (balancedWhy === 'director') {
      return `Max cash Δr at the $${director.toFixed(0)}M Director rung — an interior book, not a scale of Conservative.`;
    }
    if (balancedWhy === 'mid' && balanced) {
      return `Interior Pareto book at $${balanced.overlayVarUsdM.toFixed(1)}M VAR — midpoint of the Treasury and Max Carry fills.`;
    }
    return `Max cash Δr with overlay VAR ≤ the $${budget.toFixed(0)}M Policy budget. The book you can run without raising the cap.`;
  };

  let maxReturn: PricedOverlaySample | null = null;
  if (samples.length > 0) {
    let best = samples[0]!;
    // Overlay VaR is already the discretionary standing (no residual floor) —
    // same E[return] = determined carry − tail × VaR as the Book Weighted column.
    let bestScore = probabilityWeightedReturnUsdM(
      best.bookCarryUsdYrM,
      best.overlayVarUsdM,
      input.confidencePct,
      0,
    );
    for (const s of samples) {
      const score = probabilityWeightedReturnUsdM(
        s.bookCarryUsdYrM,
        s.overlayVarUsdM,
        input.confidencePct,
        0,
      );
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    const atEdge = samples.some(s => s.overlayVarUsdM > best.overlayVarUsdM + SAME_BOOK_VAR_M);
    const dup = (conservative && sameVar(best.overlayVarUsdM, conservative.overlayVarUsdM, SAME_BOOK_VAR_M))
      || (maxCarry && sameVar(best.overlayVarUsdM, maxCarry.overlayVarUsdM, SAME_BOOK_VAR_M))
      || (balanced && sameVar(best.overlayVarUsdM, balanced.overlayVarUsdM, SAME_BOOK_VAR_M));
    maxReturn = atEdge && !dup ? best : null;
  }

  return [
    pick(
      'conservative',
      'Conservative',
      conservative,
      `Max cash Δr on this strip with overlay VAR ≤ $${treasury.toFixed(0)}M (Treasury). Pareto: richest feasible Treasury book.`,
      'no sample inside the $5M Treasury cap',
    ),
    pick(
      'balanced',
      balancedWhy === 'ask' ? 'Hit carry target' : 'Balanced',
      balanced,
      balancedRationale(),
      'no distinct interior book on this front',
    ),
    pick(
      'maxCarry',
      'Max Carry',
      maxCarry,
      maxCarry && maxCarry.overlayVarUsdM < universeMax - 0.8
        ? `Carry already turns over at $${maxCarry.overlayVarUsdM.toFixed(1)}M — richer than filling the $${universeMax.toFixed(0)}M cap.`
        : `Max cash Δr with overlay VAR ≤ $${universeMax.toFixed(0)}M (CFO). Not a liquidity-walk tail.`,
      'no sample inside the $20M universe',
    ),
    pick(
      'maxReturn',
      'Max E[Return]',
      maxReturn,
      `Interior max of strategy E[return]: determined cash Δr − E[loss] on overlay VaR `
        + `(pair size × factor sensitivities) at ${input.confidencePct}% confidence.`,
      'risk-adjusted optimum sits on Conservative, Balanced, or Max Carry — no distinct interior book',
    ),
  ];
}

/** X-window that frames the knee so a mild bend is not flattened by $5–$20. */
export function limitedUniverseWindow(
  pts: readonly PortfolioCarryFrontierPoint[],
  defs: readonly PortfolioScenarioDef[],
): { xMin: number; xMax: number } | null {
  const sweet = defs.find(d => d.id === 'balanced')?.point;
  if (sweet && Number.isFinite(sweet.portfolioVarUsd) && sweet.portfolioVarUsd > 0.2) {
    const s = sweet.portfolioVarUsd;
    const lo = Math.max(0, s * 0.4);
    const hi = s * 1.9;
    const pad = Math.max(0.4, (hi - lo) * 0.08);
    return { xMin: Math.max(0, lo - pad), xMax: hi + pad };
  }
  const xs: number[] = [];
  for (const d of defs) {
    if (d.point && Number.isFinite(d.point.portfolioVarUsd)) xs.push(d.point.portfolioVarUsd);
  }
  if (xs.length >= 2) {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    const pad = Math.max(0.5, (hi - lo) * 0.1);
    return { xMin: Math.max(0, lo - pad), xMax: hi + pad };
  }
  const vars = pts.map(p => p.portfolioVarUsd).filter(Number.isFinite);
  if (vars.length < 2) return null;
  const hi = Math.max(...vars);
  return { xMin: Math.max(0, hi * 0.15), xMax: hi };
}

/** Unclamped Σ⁻¹μ ray as a 2-point chord — any floor-clamp peels the live curve off it. */
export function unclampedRayChord(
  pts: readonly PortfolioCarryFrontierPoint[],
): { x: number; y: number }[] | null {
  const free = pts.filter(p => p.floorBoundCcys.length === 0);
  const a = (free.length >= 2 ? free[0] : pts[0])!;
  const b = (free.length >= 2 ? free[free.length - 1] : pts[1])!;
  if (!a || !b) return null;
  const dx = b.portfolioVarUsd - a.portfolioVarUsd;
  if (Math.abs(dx) < 1e-9) return null;
  const slope = (b.totalCarryUsdYr - a.totalCarryUsdYr) / dx;
  const x0 = pts[0]!.portfolioVarUsd;
  const x1 = pts[pts.length - 1]!.portfolioVarUsd;
  return [
    { x: x0, y: a.totalCarryUsdYr + slope * (x0 - a.portfolioVarUsd) },
    { x: x1, y: a.totalCarryUsdYr + slope * (x1 - a.portfolioVarUsd) },
  ];
}

export function aroundSweetPoints(
  pts: readonly PortfolioCarryFrontierPoint[],
  sweetVar: number,
): { x: number; y: number }[] {
  const lo = sweetVar * 0.62;
  const hi = sweetVar * 1.48;
  return pts
    .filter(p => p.portfolioVarUsd >= lo && p.portfolioVarUsd <= hi)
    .map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr }));
}

/**
 * Probe at $20M, stretch the window around the first floor-clamp, then walk
 * out while aggregate carry is still declining — same universe the zip
 * Optimize plot / named presets are built on.
 */
export function buildLimitedUniverseFrontier(
  input: Omit<PortfolioCarryFrontierInput, 'policyVAR'>,
): PortfolioCarryFrontier | null {
  const rows = input.rows.filter(r => r.ccy !== 'USD');
  if (rows.length < 2) return null;
  const base = { ...input, rows };
  const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  const probe = computePortfolioCarryFrontier({ ...base, policyVAR: maxTier }, 8, 1);
  let cap = universePolicyVarCap(probe.nearestClampVarUsd);
  let fine = computePortfolioCarryFrontier({ ...base, policyVAR: cap }, 48, 1);
  const hardCeiling = maxTier * 20;
  for (let i = 0; i < 6 && cap < hardCeiling; i++) {
    const pts = fine.points;
    const crossed = pts.some((p, idx) => (
      idx > 0 && p.totalCarryUsdYr <= 0 && pts[idx - 1]!.totalCarryUsdYr > 0
    ));
    if (crossed) break;
    const declining = pts.length >= 2
      && pts[pts.length - 1]!.totalCarryUsdYr < pts[pts.length - 2]!.totalCarryUsdYr;
    if (!declining) break;
    cap = Math.min(hardCeiling, cap * 1.8);
    fine = computePortfolioCarryFrontier({ ...base, policyVAR: cap }, 48, 1);
  }
  return fine;
}
