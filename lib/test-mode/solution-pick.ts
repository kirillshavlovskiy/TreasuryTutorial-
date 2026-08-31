/**
 * One solution pick: selected funding regime + named scenario on the
 * Total-Carry / Port-CFaR curve. Overlay μ′w is folded into Total Carry
 * before anything is displayed — the desk never sees Overlay vs Program.
 */

import {
  scaleOverlayLegs,
  type EfficientCarryLeg,
  type EfficientCarryVarFrontier,
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
  carryTargetOnArm,
  chartPresetPointForScenario,
  maxVarWithinPolicyPoint,
  orderedLiquidityScenarioPoints,
  plotCarryS,
  pricedBalancedVertex,
  pricedCarryTargetVertex,
  tangencyFromTrueZero,
} from '@/lib/test-mode/portfolio-modal-align';
import {
  priceBooksAtScale,
  type PortfolioFrontierEngine,
} from '@/lib/test-mode/portfolio-liquidity-frontier';

export type SolutionScenarioId =
  | 'unhedged'
  | 'carryTarget'
  | 'relHedge'
  | 'balanced'
  | 'maxCarry'
  | 'maxReturn'
  | 'custom';

/**
 * How Carry Target fills the desk Ask.
 * `swap` — scale the unhedged funding book (k). Overlay stays at the 3× mix (t = 1).
 * `overlay` — one term overlay on the unhedged book, scaled on the
 *   existing overlay walk (same pricer as term swap). Book k = 0.
 *   Carry Target is Ask Y on that walk. Overlay t is not capped.
 * `both` — walk book k and overlay t(X) together. Overlay stays inside 3×.
 */
export type AskFillMode = 'swap' | 'overlay' | 'both';

export const ASK_FILL_MODES = ['swap', 'overlay', 'both'] as const;
export const DEFAULT_ASK_FILL_MODE: AskFillMode = 'overlay';

/** Search ceiling for overlayTToHitCarry. */
export const OVERLAY_ASK_FILL_T_MAX = 200;

export function isAskFillMode(v: unknown): v is AskFillMode {
  return v === 'swap' || v === 'overlay' || v === 'both';
}

export function parseAskFillMode(v: unknown): AskFillMode {
  return isAskFillMode(v) ? v : DEFAULT_ASK_FILL_MODE;
}

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
  askFillMode?: AskFillMode;
}): number | null {
  if (input.kind === 'unhedged') return null;
  if (input.kind === 'maxCarry') return input.approvalTierUsd;
  // Overlay fill keeps the live book — do not write ticket CFaR back
  // into Policy VAR. The dial is the 3× overlay cap.
  if (input.kind === 'carryTarget' && input.askFillMode === 'overlay') return null;
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
  askFillMode?: AskFillMode;
  capLegs?: readonly EfficientCarryLeg[] | null;
  bookHoldY?: number;
  /** CFaR-tab Net sum — chart origin X; aligns presets with the plot. */
  chartOriginX?: number;
}): PortfolioSelection | null {
  const originX = typeof input.chartOriginX === 'number' && Number.isFinite(input.chartOriginX)
    ? Math.max(0, input.chartOriginX)
    : input.unhedgedOriginUsdM;
  const kind = input.selection.kind;
  if (kind !== 'custom' && kind !== 'maxReturn' && kind !== 'relHedge') {
    const chartHit = chartPresetPointForScenario({
      scenarioId: kind,
      points: input.frontier.points,
      originX,
      policyCapUsd: input.policyCapUsd,
      confidencePct: input.confidencePct,
      carryTargetUsdYr: input.carryTargetUsdYr,
    });
    if (chartHit) {
      return {
        kind,
        point: normalizeSelectionPoint(kind, chartHit, input.unhedgedOriginUsdM),
      };
    }
  }
  const point = pointForScenario({
    frontier: input.frontier,
    scenarioId: input.selection.kind,
    policyCapUsd: input.policyCapUsd,
    carryTargetUsdYr: input.carryTargetUsdYr,
    confidencePct: input.confidencePct,
    customPoint: input.selection.kind === 'custom' ? input.selection.point : null,
    askFillMode: input.askFillMode,
    capLegs: input.capLegs,
    bookHoldY: input.bookHoldY,
    chartOriginX: originX,
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

/**
 * Desk Liquidity FX HEDGE feed from an accepted frontier mix.
 * Not Swap+Fwd Δ — Swap Near / residual stay on the funding book.
 */
export type OptimizerOverlayDesk = {
  forwardLocalM: number;
  usdM: number;
  carryUsdYrM: number;
  componentVarUsdM: number;
};

const OVERLAY_NOTIONAL_DUST = 1e-9;

/** Mix FCY / carry / Euler VAR the desk reads after Accept. Dust dropped. */
export function optimizerOverlayFromLegs(
  legs: readonly EfficientCarryLeg[],
): Record<string, OptimizerOverlayDesk> {
  const out: Record<string, OptimizerOverlayDesk> = {};
  for (const l of legs) {
    if (Math.abs(l.fcyM) < OVERLAY_NOTIONAL_DUST && Math.abs(l.usdM) < OVERLAY_NOTIONAL_DUST) {
      continue;
    }
    out[l.ccy] = {
      forwardLocalM: l.fcyM,
      usdM: l.usdM,
      carryUsdYrM: l.carryUsdYrM,
      componentVarUsdM: l.componentVarUsdM,
    };
  }
  return out;
}

/**
 * Live-desk swap cash + CIP + overlay μ. The solution strip does not use
 * this — that row is priceBooksAtScale(k) + overlay μ(t) so Σ equals the
 * selected chart Y. Keep the helper for logs and the live Cash Carry tab.
 */
export function stripDisplayedCarryUsdM(input: {
  swapInterestUsdYrM?: number;
  swapPointsUsdYrM?: number;
  overlayCarryUsdYrM?: number;
}): number {
  return (
    (Number.isFinite(input.swapInterestUsdYrM) ? input.swapInterestUsdYrM! : 0)
    + (Number.isFinite(input.swapPointsUsdYrM) ? input.swapPointsUsdYrM! : 0)
    + (Number.isFinite(input.overlayCarryUsdYrM) ? input.overlayCarryUsdYrM! : 0)
  );
}

/** Named scenario, else Carry Target — the desk ask is the default input. */
export function resolveFrontierScenarioId(
  explicit?: SolutionScenarioId | null,
): SolutionScenarioId {
  return explicit ?? 'carryTarget';
}

/** Desk CFaR $ after Accept: funding-regime Net CFaR + overlay Euler share. */
export function acceptedDeskCfarByCcy(
  pick: Pick<SolutionPick, 'cfarByCcy' | 'overlayLegs'>,
): Record<string, number> {
  const out: Record<string, number> = { ...pick.cfarByCcy };
  for (const l of pick.overlayLegs) {
    out[l.ccy] = (out[l.ccy] ?? 0) + l.componentVarUsdM;
  }
  return out;
}

/** Overlay portfolio VAR — Euler components sum to the diversified mix VAR. */
export function overlayPortfolioVarUsdM(
  legs: readonly EfficientCarryLeg[] | null | undefined,
): number {
  if (!legs?.length) return 0;
  return legs.reduce((s, l) => s + l.componentVarUsdM, 0);
}

/**
 * Ticket CFaR: √(bookPort² + overlayPort²).
 * Funding-book CFaR is rate-vol on the swap; overlay is FX spot VAR on the
 * mix. Independent residual — not Book CFaR + overlay Euler dumped into
 * one column, and not Target Carry.
 */
export function ticketCfarUsdM(
  bookPortUsdM: number,
  overlayLegs: readonly EfficientCarryLeg[] | null | undefined,
): number {
  const book = Math.max(0, Number.isFinite(bookPortUsdM) ? bookPortUsdM : 0);
  const overlay = Math.max(0, overlayPortfolioVarUsdM(overlayLegs));
  return Math.hypot(book, overlay);
}

/** Euler split of ticket CFaR so per-CCY Total sums to √(Book²+Overlay²). */
export function splitTicketCfarByCcy(
  rows: readonly { ccy: string; bookCfarUsdM: number; overlayCfarUsdM: number }[],
  bookPortUsdM: number,
  overlayPortUsdM: number,
): Record<string, number> {
  const bookPort = Math.max(0, bookPortUsdM);
  const overlayPort = overlayPortUsdM;
  const ticket = Math.hypot(bookPort, Math.max(0, overlayPort));
  const bookShare = ticket > 1e-12 ? (bookPort * bookPort) / ticket : 0;
  const overlayShare = ticket > 1e-12 ? (overlayPort * overlayPort) / ticket : 0;
  const bookAbs = rows.reduce((s, r) => s + Math.abs(r.bookCfarUsdM), 0);
  const out: Record<string, number> = {};
  for (const r of rows) {
    const bookPart = bookAbs > 1e-12
      ? (Math.abs(r.bookCfarUsdM) / bookAbs) * bookShare
      : 0;
    const overlayPart = Math.abs(overlayPort) > 1e-12
      ? (r.overlayCfarUsdM / overlayPort) * overlayShare
      : 0;
    out[r.ccy] = bookPart + overlayPart;
  }
  return out;
}

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
  const s = Number.isFinite(t) ? Math.max(0, t) : 0;
  return scaleOverlayLegs(capLegs, s).reduce((sum, l) => sum + l.carryUsdYrM, 0);
}

/**
 * Overlay scale t so μ′w(t) hits `targetUsdYrM`. t may exceed 1 (past the
 * 3× Policy VAR mix). Returns 0 when the ray cannot move toward the target.
 */
export function overlayTToHitCarry(input: {
  capLegs?: readonly EfficientCarryLeg[] | null;
  targetUsdYrM: number;
}): number {
  const legs = input.capLegs;
  const target = input.targetUsdYrM;
  if (!legs?.length || !Number.isFinite(target) || Math.abs(target) < 1e-12) {
    return 0;
  }
  const carryAt = (t: number) => overlayCarryUsdYrM(legs, t);
  const c1 = carryAt(1);
  if (Math.abs(c1) < 1e-12 || c1 * target <= 0) return 0;

  const rising = c1 > 0;
  const past = (c: number) => (rising ? c >= target - 1e-12 : c <= target + 1e-12);
  let hi = 1;
  let cHi = c1;
  if (!past(c1)) {
    while (hi < OVERLAY_ASK_FILL_T_MAX && !past(cHi)) {
      hi = Math.min(OVERLAY_ASK_FILL_T_MAX, hi * 2);
      cHi = carryAt(hi);
    }
    if (!past(cHi)) return hi;
  }

  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const below = rising ? carryAt(mid) < target : carryAt(mid) > target;
    if (below) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Overlay t used when lifting the book-scale arm.
 * `undefined` = walk t(X) (Fill Ask = Both).
 */
export function resolveAskFillLiftT(input: {
  askFillMode: AskFillMode;
  capLegs?: readonly EfficientCarryLeg[] | null;
  universePoints: readonly PortfolioCarryFrontierPoint[];
  policyCapUsd: number;
  carryTargetUsdYr: number;
}): number | undefined {
  if (input.askFillMode === 'both') return undefined;
  // Swap = the funding book ONLY. No overlay leg at all (t = 0). The book
  // walk is capped at k = 1 upstream — the operating programme, not a
  // levered carry vehicle. Carry deployment lives in Overlay / Both.
  if (input.askFillMode === 'swap') return 0;
  if (input.carryTargetUsdYr <= 1e-12) return 0;
  return overlayTToHitCarry({
    capLegs: input.capLegs,
    targetUsdYrM: input.carryTargetUsdYr,
  });
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

/**
 * Fill Ask = Overlay chart: the Σ⁻¹μ ray already in `mvFrontier`.
 * Y is overlay μ only. X is overlay VAR. k is overlay t (0 = pin, 1 = 3×).
 */
export function overlayRayFrontier(
  mv: EfficientCarryVarFrontier,
  opts?: { maxT?: number },
): PortfolioCarryFrontier {
  const src = [...mv.ray].sort((a, b) => a.t - b.t);
  const maxT = typeof opts?.maxT === 'number' && Number.isFinite(opts.maxT)
    ? Math.max(1, opts.maxT)
    : 1;
  const at = (t: number) => {
    if (src.length === 0) return null;
    const first = src[0]!;
    const last = src[src.length - 1]!;
    if (t <= first.t + 1e-12) return first;
    if (t > last.t + 1e-12 && last.t > 1e-12) {
      const u = t / last.t;
      return {
        t,
        carryUsdYrM: last.carryUsdYrM * u,
        varUsdM: last.varUsdM * u,
      };
    }
    if (t >= last.t - 1e-12) return last;
    for (let i = 1; i < src.length; i++) {
      const b = src[i]!;
      if (t > b.t + 1e-12) continue;
      const a = src[i - 1]!;
      const u = (t - a.t) / Math.max(1e-12, b.t - a.t);
      return {
        t,
        carryUsdYrM: a.carryUsdYrM + u * (b.carryUsdYrM - a.carryUsdYrM),
        varUsdM: a.varUsdM + u * (b.varUsdM - a.varUsdM),
      };
    }
    return last;
  };
  const ts = new Set(src.map(p => p.t));
  for (let i = 0; i <= 24; i++) ts.add((i / 24) * maxT);
  if (Number.isFinite(mv.sweet.t)) ts.add(Math.min(maxT, Math.max(0, mv.sweet.t)));
  if (maxT > 1) ts.add(maxT);
  const points: PortfolioCarryFrontierPoint[] = [];
  for (const t of [...ts].sort((a, b) => a - b)) {
    const p = at(t);
    if (!p) continue;
    points.push({
      k: t,
      portfolioVarUsd: Math.max(0, p.varUsdM),
      totalCarryUsdYr: p.carryUsdYrM,
      floorBoundCcys: [],
      levered: t > 1 + 1e-6,
    });
  }
  const sweetT = Math.min(1, Math.max(0, mv.sweet.t));
  const sweetSpotIndex = points.findIndex(p => Math.abs(p.k - sweetT) < 1e-6);
  return {
    points,
    farPoints: [],
    sweetSpotIndex,
    nearestClampCcy: null,
    nearestClampVarUsd: null,
    walk: 'overlay',
  };
}

/**
 * Overlay fill uses the same book-scale k-walk as Swap/Both.
 * Overlay t sizes to Ask (may exceed the 3× mix). X stays book CFaR.
 */
export function buildOverlayFillFrontier(input: {
  universe: PortfolioCarryFrontier;
  capLegs: readonly EfficientCarryLeg[];
  carryTargetUsdYr: number;
  policyCapUsd?: number;
}): PortfolioCarryFrontier {
  const hold = input.universe.points.find(p => Math.abs(p.k - 1) < 1e-6);
  if (!hold || input.capLegs.length === 0) return input.universe;

  const bookY = hold.totalCarryUsdYr;
  const ask = Number.isFinite(input.carryTargetUsdYr) ? input.carryTargetUsdYr : bookY;
  const t = ask > bookY + 1e-12
    ? overlayTToHitCarry({
      capLegs: input.capLegs,
      targetUsdYrM: ask - bookY,
    })
    : 0;
  const policyCapUsd = typeof input.policyCapUsd === 'number' && input.policyCapUsd > 0
    ? input.policyCapUsd
    : Math.max(...input.universe.points.map(p => p.portfolioVarUsd), 1);
  const lifted = liftFrontierToTotalCarry({
    frontier: input.universe,
    capLegs: input.capLegs,
    policyCapUsd,
    overlayT: t,
  });
  return lifted;
}

/** Selected (or comparison) funding hold + overlay μ at t. X is book CFaR. */
export function overlayFillAtHold(input: {
  holdX: number;
  bookY: number;
  capLegs?: readonly EfficientCarryLeg[] | null;
  overlayT: number;
}): { totalCarryUsdYr: number; portUsdM: number } {
  const t = Number.isFinite(input.overlayT) ? Math.max(0, input.overlayT) : 0;
  return {
    totalCarryUsdYr: input.bookY + overlayCarryUsdYrM(input.capLegs, t),
    portUsdM: Math.max(0, input.holdX),
  };
}

/** Lower bound for walk-order filters. Book k starts at 0. */
export const SWAP_APPROACH_K0 = -1;

/** Book CFaR band where the k-stack sits on the unhedged origin (matches chartOpenPath). */
const UNHEDGED_ORIGIN_X_TOL = 1e-3;

/** Farthest-from-chord bend on the live book walk (k ∈ [0, 1]). */
function bookWalkKneeX(
  points: readonly PortfolioCarryFrontierPoint[],
): number | null {
  const seg = points
    .filter(p => (
      Number.isFinite(p.k)
      && p.k >= -1e-12
      && p.k <= 1 + 1e-6
      && Number.isFinite(p.portfolioVarUsd)
      && Number.isFinite(p.totalCarryUsdYr)
    ))
    .sort((a, b) => a.k - b.k || a.portfolioVarUsd - b.portfolioVarUsd);
  if (seg.length < 2) return seg[0]?.portfolioVarUsd ?? null;
  if (seg.length < 3) return seg[seg.length - 1]!.portfolioVarUsd;
  const p0 = seg[0]!;
  const pN = seg[seg.length - 1]!;
  const dx = pN.portfolioVarUsd - p0.portfolioVarUsd;
  const dy = pN.totalCarryUsdYr - p0.totalCarryUsdYr;
  const norm = Math.hypot(dx, dy);
  if (norm < 1e-9) return pN.portfolioVarUsd;
  let bestIdx = 0;
  let bestDist = -Infinity;
  for (let i = 0; i < seg.length; i += 1) {
    const p = seg[i]!;
    const cross = (p.portfolioVarUsd - p0.portfolioVarUsd) * dy
      - (p.totalCarryUsdYr - p0.totalCarryUsdYr) * dx;
    const dist = Math.abs(cross) / norm;
    if (dist > bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return seg[bestIdx]!.portfolioVarUsd;
}

/** Max book CFaR on the live arm (k ∈ (0, 1]). */
function maxLiveBookArmX(
  points: readonly PortfolioCarryFrontierPoint[],
): number | null {
  const xs = points
    .filter(p => (
      Number.isFinite(p.k)
      && p.k > 1e-12
      && p.k <= 1 + 1e-6
      && Number.isFinite(p.portfolioVarUsd)
    ))
    .map(p => p.portfolioVarUsd);
  return xs.length > 0 ? Math.max(...xs) : null;
}

function capSwapRampEndX(
  end: number,
  bookCap: number | null,
  rampMin: number,
): number {
  if (!(end > rampMin + 1e-9)) return rampMin + 0.018;
  if (bookCap != null && bookCap > rampMin + 1e-9) {
    return Math.min(end, bookCap);
  }
  return end;
}

/**
 * X where parked overlay (Fill Ask = Swap) reaches full scale on the walk.
 * Ramps from the origin column to the book knee so Balanced keeps full
 * Overlay(t) while the origin hook stays gradual.
 */
export function swapParkedOverlayRampEndX(
  points: readonly PortfolioCarryFrontierPoint[],
  originX: number,
  _policyCapUsd: number,
): number {
  const rampMin = originX + UNHEDGED_ORIGIN_X_TOL;
  const carryS = plotCarryS(points);
  const hold = points.find(p => Math.abs(p.k - 1) < 1e-6);
  const bookCap = hold?.portfolioVarUsd ?? maxLiveBookArmX(points);

  const balanced = pricedBalancedVertex(points, originX, carryS);
  const kneeX = bookWalkKneeX(points);
  const rampEnds = [balanced?.portfolioVarUsd, kneeX].filter((x): x is number => (
    typeof x === 'number' && x > rampMin + 1e-9
  ));
  if (rampEnds.length > 0) {
    return capSwapRampEndX(Math.min(...rampEnds), bookCap, rampMin);
  }

  const live = points.filter(p => (
    Number.isFinite(p.k)
    && p.k > 1e-12
    && Number.isFinite(p.portfolioVarUsd)
  ));
  const touch = tangencyFromTrueZero(live, carryS);
  if (touch && touch.portfolioVarUsd > rampMin + 1e-9) {
    return capSwapRampEndX(touch.portfolioVarUsd, bookCap, rampMin);
  }

  if (bookCap != null && bookCap > rampMin + 1e-9) {
    return bookCap;
  }

  return rampMin + 0.018;
}

/** Effective overlay t for Fill Ask = Swap (parked scale, gradual origin ramp). */
export function swapParkedOverlayScale(
  p: PortfolioCarryFrontierPoint,
  originX: number,
  rampEndX: number,
  parkedOverlayT: number,
): number {
  if (!(parkedOverlayT > 0)) return 0;
  if (p.k <= 1e-12) return 0;
  if (p.k >= 1 - 1e-6) return parkedOverlayT;
  if (Math.abs(p.portfolioVarUsd - originX) <= UNHEDGED_ORIGIN_X_TOL) {
    return 0;
  }
  const rampStart = originX + UNHEDGED_ORIGIN_X_TOL;
  const rampEnd = rampEndX > rampStart + 1e-9
    ? rampEndX
    : rampStart + 0.018;
  return parkedOverlayT * overlayTAlongPath(p.portfolioVarUsd, rampStart, rampEnd);
}

/**
 * Every sample Y becomes Total Carry (walk program + overlay at t(X)).
 * X is unchanged. Overlay off → identity.
 *
 * Constant `overlayT` (Fill Ask = Swap) parks overlay at that scale; it
 * ramps in with t(X) from the origin column to the book knee so the k-stack
 * stays book-only and Balanced keeps full Overlay(t).
 * Omit `overlayT` to walk t with X (Fill Ask = Both). Do not replace k≤1
 * Y with k × hold Total — that invents a synthetic arm.
 */
export function liftFrontierToTotalCarry(input: {
  frontier: PortfolioCarryFrontier;
  capLegs?: readonly EfficientCarryLeg[] | null;
  policyCapUsd: number;
  /** Constant overlay scale (swap / overlay fill). Omit to walk t(X). */
  overlayT?: number;
}): PortfolioCarryFrontier {
  const { frontier, capLegs, policyCapUsd, overlayT } = input;
  if (!capLegs?.length) return frontier;
  const originX = pathOriginX(frontier.points);
  const maxCarryX = pathMaxCarryX(frontier.points, policyCapUsd);
  const parkedOverlayT = typeof overlayT === 'number' && Number.isFinite(overlayT)
    ? Math.max(0, overlayT)
    : null;
  const swapRampEndX = parkedOverlayT != null
    ? swapParkedOverlayRampEndX(frontier.points, originX, policyCapUsd)
    : maxCarryX;
  const lift = (p: PortfolioCarryFrontierPoint) => {
    const t = parkedOverlayT != null
      ? swapParkedOverlayScale(p, originX, swapRampEndX, parkedOverlayT)
      : overlayTAlongPath(p.portfolioVarUsd, originX, maxCarryX);
    const overlayAdd = overlayCarryUsdYrM(capLegs, t);
    return {
      ...p,
      totalCarryUsdYr: p.totalCarryUsdYr + overlayAdd,
    };
  };
  return {
    ...frontier,
    points: frontier.points.map(lift),
    farPoints: frontier.farPoints ?? [],
  };
}

/**
 * Pin the lifted book walk at unhedged $0 without a second walk.
 * k ≤ 1: Y = k × hold Total (so k=0 is $0, k=1 is table Total).
 * k > 1 stays on the lifted |cash|+overlay walk (Max Carry leverage).
 * X is unchanged (book CFaR).
 */
export function rebaseLiveBookArmToHoldY(
  frontier: PortfolioCarryFrontier,
  holdY: number,
): PortfolioCarryFrontier {
  if (!Number.isFinite(holdY)) return frontier;
  const map = (p: PortfolioCarryFrontierPoint): PortfolioCarryFrontierPoint => (
    Number.isFinite(p.k) && p.k <= 1 + 1e-6
      ? { ...p, totalCarryUsdYr: Math.max(0, p.k) * holdY }
      : p
  );
  return {
    ...frontier,
    points: frontier.points.map(map),
    farPoints: frontier.farPoints ?? [],
  };
}

/** Write table Total onto the sample closest to the selected k. */
export function stampFrontierPointY(
  frontier: PortfolioCarryFrontier,
  k: number,
  y: number,
): PortfolioCarryFrontier {
  if (!Number.isFinite(k) || !Number.isFinite(y) || frontier.points.length === 0) {
    return frontier;
  }
  let bestI = 0;
  for (let i = 1; i < frontier.points.length; i++) {
    if (Math.abs(frontier.points[i]!.k - k) < Math.abs(frontier.points[bestI]!.k - k)) {
      bestI = i;
    }
  }
  return {
    ...frontier,
    points: frontier.points.map((p, i) => (
      i === bestI ? { ...p, totalCarryUsdYr: y } : p
    )),
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

/** Live-book Rel hedge = CIP-on far twin at hold scale (k=1). Not green |cash|. */
export function relHedgeFarPoint(
  frontier: PortfolioCarryFrontier | null | undefined,
): PortfolioCarryFrontierPoint | null {
  const far = frontier?.farPoints ?? [];
  if (far.length === 0) return null;
  const hold = far.find(p => Math.abs(p.k - 1) < 1e-6);
  if (hold) return hold;
  let best: PortfolioCarryFrontierPoint | null = null;
  for (const p of far) {
    if (!(p.k > 1e-9)) continue;
    if (!best || Math.abs(p.k - 1) < Math.abs(best.k - 1)) best = p;
  }
  return best;
}

/** Named (or custom-k) point on an already-lifted Total-Carry curve. */
/**
 * Overlay fill: live book on the lifted k-walk (k = 1).
 */
export function overlayFillDeskPoint(
  frontier: PortfolioCarryFrontier,
  _askUsdYr?: number,
  _capLegs?: readonly EfficientCarryLeg[] | null,
  _bookHoldY?: number,
): PortfolioCarryFrontierPoint | null {
  const hold = frontier.points.find(p => Math.abs(p.k - 1) < 1e-6)
    ?? frontier.points[0]
    ?? null;
  if (!hold) return null;
  return {
    ...hold,
    k: 1,
    portfolioVarUsd: Math.max(0, hold.portfolioVarUsd),
  };
}

export function pointForScenario(input: {
  frontier: PortfolioCarryFrontier;
  scenarioId: SolutionScenarioId;
  policyCapUsd: number;
  carryTargetUsdYr?: number;
  confidencePct: number;
  customPoint?: PortfolioCarryFrontierPoint | null;
  askFillMode?: AskFillMode;
  capLegs?: readonly EfficientCarryLeg[] | null;
  bookHoldY?: number;
  /** CFaR-tab Net sum — same origin as PortfolioCarryVarFrontierPlot x0. */
  chartOriginX?: number;
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
  if (input.scenarioId === 'relHedge') {
    return relHedgeFarPoint(input.frontier);
  }
  const hold = input.frontier.points.find(p => Math.abs(p.k - 1) < 1e-6) ?? null;
  const originX = typeof input.chartOriginX === 'number' && Number.isFinite(input.chartOriginX)
    ? Math.max(0, input.chartOriginX)
    : Math.max(0, input.frontier.points[0]?.portfolioVarUsd ?? 0);
  const carryS = plotCarryS(input.frontier.points);
  const ordered = orderedLiquidityScenarioPoints({
    points: input.frontier.points,
    conservative: hold,
    policyCapUsd: input.policyCapUsd,
    originCfarUsd: originX,
    carryS,
    carryTargetUsdYr: input.carryTargetUsdYr,
  });
  if (input.scenarioId === 'unhedged') return ordered.origin;
  if (input.scenarioId === 'carryTarget') {
    const ask = typeof input.carryTargetUsdYr === 'number' && Number.isFinite(input.carryTargetUsdYr)
      ? input.carryTargetUsdYr
      : DEFAULT_DESK_TARGET_CARRY_USD_YR;
    const chartHit = pricedCarryTargetVertex(input.frontier.points, originX, ask);
    if (chartHit) return chartHit;
    // Overlay fill fallback when Ask is off the drawn arm.
    if (input.askFillMode === 'overlay') {
      const arm = input.frontier.points.filter(p => (
        Number.isFinite(p.totalCarryUsdYr)
        && Number.isFinite(p.portfolioVarUsd)
        && p.k >= SWAP_APPROACH_K0 - 1e-12
      ));
      const hit = carryTargetOnArm(arm, ask);
      if (hit) return hit;
      if (arm.length > 0) {
        const hi = arm.reduce((best, p) => (
          p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
        ));
        const lo = arm.reduce((best, p) => (
          p.totalCarryUsdYr <= best.totalCarryUsdYr ? p : best
        ));
        if (ask >= hi.totalCarryUsdYr - 1e-12) return hi;
        if (ask <= lo.totalCarryUsdYr + 1e-12) return lo;
      }
    }
    if (ordered.carryTarget) return ordered.carryTarget;
    const arm = input.frontier.points.filter(p => (
      Number.isFinite(p.totalCarryUsdYr)
      && Number.isFinite(p.portfolioVarUsd)
      && p.k >= SWAP_APPROACH_K0 - 1e-12
    ));
    if (arm.length === 0) return ordered.origin;
    const hit = carryTargetOnArm(arm, ask);
    if (hit) return hit;
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
  if (input.scenarioId === 'balanced') {
    return pricedBalancedVertex(input.frontier.points, originX, carryS) ?? ordered.balanced;
  }
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
  /** Σ⁻¹μ sweet t (carry-binding fill). Carry Target uses this, not t(X). */
  overlaySweetT?: number;
  /** Constant overlay scale from Fill Ask. */
  fixedOverlayT?: number;
}): number {
  if (input.scenarioId === 'unhedged' || input.scenarioId === 'relHedge') return 0;
  if (input.frontier.walk === 'overlay') {
    return Math.max(0, input.point.k);
  }
  if (input.point.k < -1e-12) {
    return Math.min(1, Math.max(0, input.point.k - SWAP_APPROACH_K0));
  }
  if (typeof input.fixedOverlayT === 'number' && Number.isFinite(input.fixedOverlayT)) {
    return Math.max(0, input.fixedOverlayT);
  }
  if (input.scenarioId === 'maxCarry') return 1;
  if (
    input.scenarioId === 'carryTarget'
    && typeof input.overlaySweetT === 'number'
    && Number.isFinite(input.overlaySweetT)
  ) {
    return Math.min(1, Math.max(0, input.overlaySweetT));
  }
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
  const included = new Set(input.rows.map(r => r.ccy));
  const totalCarryByCcy: Record<string, number> = {};
  const cfarByCcy: Record<string, number> = {};
  if (unhedged) {
    for (const r of input.rows) {
      if (r.ccy === 'USD') continue;
      if (included.size > 0 && !included.has(r.ccy)) continue;
      totalCarryByCcy[r.ccy] = 0;
      cfarByCcy[r.ccy] = 0;
    }
    return { overlayLegs: [], totalCarryByCcy, cfarByCcy };
  }
  const k = Number.isFinite(input.point.k) ? Math.max(0, input.point.k) : 1;
  const priced = priceBooksAtScale({
    result: input.result,
    rows: input.rows,
    engine: input.engine,
    scale: k,
  });
  for (const p of priced) {
    if (included.size > 0 && !included.has(p.ccy)) continue;
    totalCarryByCcy[p.ccy] = p.carryUsdYrM + (overlayBy.get(p.ccy) ?? 0);
    cfarByCcy[p.ccy] = p.cfarUsdM;
  }
  for (const l of overlayLegs) {
    if (Object.prototype.hasOwnProperty.call(totalCarryByCcy, l.ccy)) continue;
    if (included.size > 0 && !included.has(l.ccy)) continue;
    totalCarryByCcy[l.ccy] = l.carryUsdYrM;
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
  overlaySweetT?: number;
  fixedOverlayT?: number;
}): SolutionPick {
  const overlayT = overlayTForPoint({
    point: input.point,
    frontier: input.frontier,
    policyCapUsd: input.policyCapUsd,
    scenarioId: input.scenarioId,
    overlaySweetT: input.overlaySweetT,
    fixedOverlayT: input.fixedOverlayT,
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
