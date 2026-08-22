/**
 * One solution pick: selected funding regime + named scenario on the
 * Total-Carry / Port-CFaR curve. Overlay μ′w is folded into Total Carry
 * before anything is displayed — the desk never sees Overlay vs Program.
 */

import {
  scaleOverlayLegs,
  type EfficientCarryLeg,
} from '@/lib/portfolio-alloc';
import type {
  PortfolioCarryFrontier,
  PortfolioCarryFrontierPoint,
  RowState,
} from '@/lib/fx-buffer';
import { cfarTailProbability } from '@/lib/test-mode/liquidity-strategies';
import type { LiquidityStrategyId, LiquidityStrategyResult } from '@/lib/test-mode/liquidity-strategies';
import {
  DEFAULT_DESK_TARGET_CARRY_USD_YR,
  maxVarWithinPolicyPoint,
  orderedLiquidityScenarioPoints,
} from '@/lib/test-mode/portfolio-modal-align';
import {
  priceBooksAtScale,
  type PortfolioFrontierEngine,
} from '@/lib/test-mode/portfolio-liquidity-frontier';

export type SolutionScenarioId =
  | 'unhedged'
  | 'carryTarget'
  | 'balanced'
  | 'maxCarry'
  | 'maxReturn'
  | 'custom';

/** Single UI/desk selection — chart, strip, regimes, and summary all read this. */
export type PortfolioSelection = {
  kind: SolutionScenarioId;
  point: PortfolioCarryFrontierPoint;
};

export function normalizeSelectionPoint(
  kind: SolutionScenarioId,
  point: PortfolioCarryFrontierPoint,
  unhedgedOriginUsdM: number,
): PortfolioCarryFrontierPoint {
  if (kind === 'unhedged') {
    return {
      ...point,
      k: 0,
      portfolioVarUsd: Math.max(0, unhedgedOriginUsdM),
      totalCarryUsdYr: 0,
    };
  }
  return point;
}

/**
 * Policy VAR dial write-back for a committed selection.
 * `null` = leave the dial unchanged (Unhedged).
 */
export function policyVarForSelection(input: {
  kind: SolutionScenarioId;
  point: PortfolioCarryFrontierPoint;
  policyVAR: number | undefined;
  approvalTierUsd: number;
}): number | null {
  if (input.kind === 'unhedged') return null;
  if (input.kind === 'maxCarry') return input.approvalTierUsd;
  return Math.round(input.point.portfolioVarUsd * 10) / 10;
}

export function persistScenarioId(kind: SolutionScenarioId): string | null {
  return kind === 'custom' ? null : kind;
}

/** True when two selection points are the same chart/strip sample. */
export function selectionPointsEqual(
  a: PortfolioCarryFrontierPoint,
  b: PortfolioCarryFrontierPoint,
): boolean {
  return Math.abs(a.portfolioVarUsd - b.portfolioVarUsd) < 1e-6
    && Math.abs(a.totalCarryUsdYr - b.totalCarryUsdYr) < 1e-9
    && Math.abs((a.k ?? 0) - (b.k ?? 0)) < 1e-6;
}

/**
 * Re-price the current selection onto a rebuilt frontier (CCY filter,
 * overlay lift, policy cap). Returns null when the named preset is gone.
 */
export function remapSelectionToFrontier(input: {
  selection: PortfolioSelection;
  frontier: PortfolioCarryFrontier;
  policyCapUsd: number;
  carryTargetUsdYr?: number;
  confidencePct: number;
  unhedgedOriginUsdM: number;
}): PortfolioSelection | null {
  const point = pointForScenario({
    frontier: input.frontier,
    scenarioId: input.selection.kind,
    policyCapUsd: input.policyCapUsd,
    carryTargetUsdYr: input.carryTargetUsdYr,
    confidencePct: input.confidencePct,
    customPoint: input.selection.kind === 'custom' ? input.selection.point : null,
  });
  if (!point) return null;
  return {
    kind: input.selection.kind,
    point: normalizeSelectionPoint(
      input.selection.kind,
      point,
      input.unhedgedOriginUsdM,
    ),
  };
}

export type SolutionPick = {
  regimeId: LiquidityStrategyId | string;
  scenarioId: SolutionScenarioId;
  k: number;
  overlayT: number;
  point: PortfolioCarryFrontierPoint;
  overlayLegs: EfficientCarryLeg[];
  totalCarryByCcy: Record<string, number>;
  cfarByCcy: Record<string, number>;
};

/** 0 at the unhedged origin, 1 at Max Policy Risk. Linear in CFaR. */
export function overlayTAlongPath(
  x: number,
  originX: number,
  maxCarryX: number,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(originX)) return 0;
  if (!(maxCarryX > originX + 1e-9)) return 0;
  if (x <= originX + 1e-9) return 0;
  if (x >= maxCarryX - 1e-9) return 1;
  return Math.min(1, Math.max(0, (x - originX) / (maxCarryX - originX)));
}

export function overlayCarryUsdYrM(
  capLegs: readonly EfficientCarryLeg[] | null | undefined,
  t: number,
): number {
  if (!capLegs?.length || !(t > 0)) return 0;
  const s = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  return capLegs.reduce((sum, l) => sum + l.carryUsdYrM * s, 0);
}

export function pathOriginX(points: readonly PortfolioCarryFrontierPoint[]): number {
  const x = points[0]?.portfolioVarUsd;
  return typeof x === 'number' && Number.isFinite(x) ? Math.max(0, x) : 0;
}

export function pathMaxCarryX(
  points: readonly PortfolioCarryFrontierPoint[],
  policyCapUsd: number,
): number {
  const origin = pathOriginX(points);
  const hit = maxVarWithinPolicyPoint(points, policyCapUsd);
  return hit && hit.portfolioVarUsd > origin + 1e-6
    ? hit.portfolioVarUsd
    : origin;
}

function liftPoint(
  p: PortfolioCarryFrontierPoint,
  originX: number,
  maxCarryX: number,
  capLegs: readonly EfficientCarryLeg[],
): PortfolioCarryFrontierPoint {
  const t = overlayTAlongPath(p.portfolioVarUsd, originX, maxCarryX);
  return {
    ...p,
    totalCarryUsdYr: p.totalCarryUsdYr + overlayCarryUsdYrM(capLegs, t),
  };
}

/**
 * Every sample Y becomes Total Carry (walk program + overlay at t(X)).
 * X is unchanged. Overlay off → identity.
 */
export function liftFrontierToTotalCarry(input: {
  frontier: PortfolioCarryFrontier;
  capLegs?: readonly EfficientCarryLeg[] | null;
  policyCapUsd: number;
}): PortfolioCarryFrontier {
  const { frontier, capLegs, policyCapUsd } = input;
  if (!capLegs?.length) return frontier;
  const originX = pathOriginX(frontier.points);
  const maxCarryX = pathMaxCarryX(frontier.points, policyCapUsd);
  const lift = (p: PortfolioCarryFrontierPoint) =>
    liftPoint(p, originX, maxCarryX, capLegs);
  return {
    ...frontier,
    points: frontier.points.map(lift),
    farPoints: (frontier.farPoints ?? []).map(lift),
  };
}

export function maxExpectedReturnFrontierPoint(
  points: readonly PortfolioCarryFrontierPoint[],
  tailProb: number,
): PortfolioCarryFrontierPoint | null {
  if (points.length === 0) return null;
  let bestIdx = 0;
  let bestScore = points[0]!.totalCarryUsdYr - points[0]!.portfolioVarUsd * tailProb;
  points.forEach((p, i) => {
    const score = p.totalCarryUsdYr - p.portfolioVarUsd * tailProb;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  if (bestIdx === points.length - 1 && points.length > 1) return null;
  return points[bestIdx] ?? null;
}

/** Named (or custom-k) point on an already-lifted Total-Carry curve. */
export function pointForScenario(input: {
  frontier: PortfolioCarryFrontier;
  scenarioId: SolutionScenarioId;
  policyCapUsd: number;
  carryTargetUsdYr?: number;
  confidencePct: number;
  customPoint?: PortfolioCarryFrontierPoint | null;
}): PortfolioCarryFrontierPoint | null {
  if (input.scenarioId === 'custom') {
    const k = input.customPoint?.k;
    if (k == null || !Number.isFinite(k)) return input.customPoint ?? null;
    const hit = input.frontier.points.find(p => Math.abs(p.k - k) < 1e-3);
    if (hit) return hit;
    // Universe changed (e.g. CCY filter) — snap to nearest k on the new arm.
    let best: PortfolioCarryFrontierPoint | null = null;
    for (const p of input.frontier.points) {
      if (!Number.isFinite(p.k)) continue;
      if (!best || Math.abs(p.k - k) < Math.abs(best.k - k)) best = p;
    }
    return best ?? input.customPoint ?? null;
  }
  const hold = input.frontier.points.find(p => Math.abs(p.k - 1) < 1e-6) ?? null;
  const ordered = orderedLiquidityScenarioPoints({
    points: input.frontier.points,
    conservative: hold,
    policyCapUsd: input.policyCapUsd,
    originCfarUsd: input.frontier.points[0]?.portfolioVarUsd ?? null,
    carryTargetUsdYr: input.carryTargetUsdYr,
  });
  if (input.scenarioId === 'unhedged') return ordered.origin;
  if (input.scenarioId === 'carryTarget') {
    if (ordered.carryTarget) return ordered.carryTarget;
    const ask = typeof input.carryTargetUsdYr === 'number' && Number.isFinite(input.carryTargetUsdYr)
      ? input.carryTargetUsdYr
      : DEFAULT_DESK_TARGET_CARRY_USD_YR;
    const arm = input.frontier.points.filter(p => (
      Number.isFinite(p.totalCarryUsdYr) && p.k >= -1e-12
    ));
    if (arm.length === 0) return ordered.origin;
    const hi = arm.reduce((best, p) => (
      p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
    ));
    const lo = arm.reduce((best, p) => (
      p.totalCarryUsdYr <= best.totalCarryUsdYr ? p : best
    ));
    if (ask >= hi.totalCarryUsdYr - 1e-12) return hi;
    if (ask <= lo.totalCarryUsdYr + 1e-12) return lo;
    return ordered.origin;
  }
  if (input.scenarioId === 'balanced') return ordered.balanced;
  if (input.scenarioId === 'maxCarry') return ordered.maxCarry;
  if (input.scenarioId === 'maxReturn') {
    return maxExpectedReturnFrontierPoint(
      input.frontier.points,
      cfarTailProbability(input.confidencePct),
    );
  }
  return null;
}

export function overlayTForPoint(input: {
  point: PortfolioCarryFrontierPoint;
  frontier: PortfolioCarryFrontier;
  policyCapUsd: number;
  scenarioId: SolutionScenarioId | null;
}): number {
  if (input.scenarioId === 'unhedged') return 0;
  if (input.scenarioId === 'maxCarry') return 1;
  const originX = pathOriginX(input.frontier.points);
  const maxCarryX = pathMaxCarryX(input.frontier.points, input.policyCapUsd);
  return overlayTAlongPath(input.point.portfolioVarUsd, originX, maxCarryX);
}

export function priceSolutionAtPoint(input: {
  point: PortfolioCarryFrontierPoint;
  scenarioId: SolutionScenarioId;
  result: LiquidityStrategyResult;
  rows: readonly RowState[];
  engine: PortfolioFrontierEngine;
  capLegs?: readonly EfficientCarryLeg[] | null;
  overlayT: number;
  unhedged?: boolean;
}): Pick<SolutionPick, 'overlayLegs' | 'totalCarryByCcy' | 'cfarByCcy'> {
  const unhedged = input.unhedged || input.scenarioId === 'unhedged';
  const overlayLegs = (
    !unhedged && input.capLegs?.length && input.overlayT > 1e-12
  )
    ? scaleOverlayLegs(input.capLegs, input.overlayT)
    : [];
  const overlayBy = new Map(overlayLegs.map(l => [l.ccy, l.carryUsdYrM] as const));
  const priced = priceBooksAtScale({
    result: input.result,
    rows: input.rows,
    engine: input.engine,
    scale: unhedged ? 0 : input.point.k,
  });
  const totalCarryByCcy: Record<string, number> = {};
  const cfarByCcy: Record<string, number> = {};
  for (const p of priced) {
    const overlay = overlayBy.get(p.ccy) ?? 0;
    totalCarryByCcy[p.ccy] = unhedged ? 0 : p.carryUsdYrM + overlay;
    cfarByCcy[p.ccy] = p.cfarUsdM;
  }
  for (const l of overlayLegs) {
    if (Object.prototype.hasOwnProperty.call(totalCarryByCcy, l.ccy)) continue;
    totalCarryByCcy[l.ccy] = unhedged ? 0 : l.carryUsdYrM;
  }
  return { overlayLegs, totalCarryByCcy, cfarByCcy };
}

export function buildSolutionPick(input: {
  regimeId: LiquidityStrategyId | string;
  scenarioId: SolutionScenarioId;
  point: PortfolioCarryFrontierPoint;
  frontier: PortfolioCarryFrontier;
  policyCapUsd: number;
  result: LiquidityStrategyResult;
  rows: readonly RowState[];
  engine: PortfolioFrontierEngine;
  capLegs?: readonly EfficientCarryLeg[] | null;
}): SolutionPick {
  const overlayT = overlayTForPoint({
    point: input.point,
    frontier: input.frontier,
    policyCapUsd: input.policyCapUsd,
    scenarioId: input.scenarioId,
  });
  const priced = priceSolutionAtPoint({
    point: input.point,
    scenarioId: input.scenarioId,
    result: input.result,
    rows: input.rows,
    engine: input.engine,
    capLegs: input.capLegs,
    overlayT,
    unhedged: input.scenarioId === 'unhedged',
  });
  return {
    regimeId: input.regimeId,
    scenarioId: input.scenarioId,
    k: input.scenarioId === 'unhedged' ? 0 : input.point.k,
    overlayT,
    point: input.scenarioId === 'unhedged'
      ? { ...input.point, k: 0, totalCarryUsdYr: 0 }
      : input.point,
    ...priced,
  };
}

export function deskCarryTargetUsdYr(portfolioCarryK?: number | null): number {
  return portfolioCarryK != null && Number.isFinite(portfolioCarryK)
    ? portfolioCarryK / 1000
    : DEFAULT_DESK_TARGET_CARRY_USD_YR;
}

export function solutionWeightedReturnUsdM(
  totalCarryUsdYr: number,
  portCfarUsdM: number,
  confidencePct: number,
): number {
  const tail = cfarTailProbability(confidencePct);
  return totalCarryUsdYr - portCfarUsdM * tail;
}
