/**
 * Map the per-currency left-end frontier onto the limited-universe plot
 * so a one-name book (EUR-only, …) traces the same standing / CFaR / carry
 * curve as LiquidityFrontierModal.
 *
 * Overlay Policy-VAR presets stay on sweepPortfolioCarryFrontier; this module
 * only prices the drawn arms (and projects a preset's k onto those arms).
 */

import { allocateCarryVarUsd } from '@/lib/portfolio-alloc';
import {
  approvalTierCapUsd,
  ccySpotRate,
  POLICY_VAR_LIMITS,
  type PortfolioCarryFrontier,
  type PortfolioCarryFrontierPoint,
  type RowState,
} from '@/lib/fx-buffer';
import {
  bookCashCarryK,
  buildLiquidityLeftEndFrontier,
  carryFwd,
  frontierCarryDotsK,
  liquidityFrontierDial,
  priceLiquidityStanding,
  sectionCfarUsdM,
  signedPeakStanding,
  type LiquidityFrontierInput,
  type LiquidityFrontierPoint,
  type LiquidityLeftEndResult,
} from '@/lib/test-mode/liquidity-frontier';
import type { LiquidityStrategy } from '@/lib/test-mode/liquidity-strategies';
import { sumNetCfarUsdM } from '@/lib/test-mode/cfar-net-by-ccy';

/**
 * Unhedged origin X — CFaR-tab FX-only Net **sum** at the live confidence.
 * Never RSS those Nets (that is Port. CFaR / the overlay sweep's old k=0).
 */
export function unhedgedSectionCfarUsdM(
  netByCcy: Record<string, number> | undefined,
  includeCcy?: (ccy: string) => boolean,
): number {
  if (!netByCcy) return 0;
  const picked: Record<string, number> = {};
  for (const [ccy, v] of Object.entries(netByCcy)) {
    if (ccy === 'USD') continue;
    if (includeCcy && !includeCcy(ccy)) continue;
    if (Number.isFinite(v) && v > 0) picked[ccy] = v;
  }
  return sumNetCfarUsdM(picked);
}

export type SoloAlignEngine = Omit<LiquidityFrontierInput, 'row' | 'strategy' | 'bookStanding' | 'carryUsdK'>;

/**
 * Unhedged → Conservative as a priced standing walk.
 * Each t is `priceLiquidityStanding(t × S)` — not a hypot interpolant
 * and not the regime-table sums.
 */
export function pricedFundingWalk(input: {
  byCcy: readonly { ccy: string; plan?: readonly { standing_swap: number }[] }[];
  rows: readonly RowState[];
  engine: SoloAlignEngine;
  includeCcy?: (ccy: string) => boolean;
  /** CFaR-tab FX-only Net sum — green must start here, not a partial book sum. */
  unhedgedCfarUsdM?: number;
  steps?: number;
}): {
  origin: PortfolioCarryFrontierPoint;
  hold: PortfolioCarryFrontierPoint;
  path: PortfolioCarryFrontierPoint[];
} | null {
  const standingBy = new Map(
    input.byCcy.map(c => [c.ccy, signedPeakStanding(c.plan)] as const),
  );
  const books = input.rows
    .filter(r => (
      r.ccy !== 'USD'
      && (!input.includeCcy || input.includeCcy(r.ccy))
    ))
    .map(row => ({
      ccy: row.ccy,
      row,
      standing: standingBy.get(row.ccy) ?? 0,
    }));
  if (books.length === 0) return null;

  const evalAt = (t: number): PortfolioCarryFrontierPoint => {
    let cfar = 0;
    let carry = 0;
    for (const b of books) {
      const S = t * b.standing;
      const bookK = bookCashCarryK(
        b.standing, ccySpotRate(b.row.ccy), b.row.r_FCY,
        input.engine.shared.r_USD, b.row.r_OD,
      );
      const priced = priceLiquidityStanding(
        { ...input.engine, row: b.row }, S, bookK,
      );
      cfar += priced.open.finalCfarUsdM;
      carry += priced.open.totalCarryUsdYrM;
    }
    return {
      k: t - 1,
      portfolioVarUsd: cfar,
      totalCarryUsdYr: carry,
      floorBoundCcys: [],
    };
  };

  const n = Math.max(4, input.steps ?? 10);
  const sampled: PortfolioCarryFrontierPoint[] = [];
  for (let i = 1; i <= n; i++) sampled.push(evalAt(i / n));
  const tabUnhedged = typeof input.unhedgedCfarUsdM === 'number'
    && Number.isFinite(input.unhedgedCfarUsdM)
    && input.unhedgedCfarUsdM > 1e-9
    ? input.unhedgedCfarUsdM
    : null;
  const origin: PortfolioCarryFrontierPoint = {
    k: -1,
    portfolioVarUsd: tabUnhedged ?? sampled[0]!.portfolioVarUsd,
    totalCarryUsdYr: 0,
    floorBoundCcys: [],
  };
  const hold = sampled[sampled.length - 1]!;
  return {
    origin,
    hold: { ...hold, k: 0 },
    path: [origin, ...sampled.slice(0, -1), { ...hold, k: 0 }],
  };
}

function extraUsd(x: number, pin: number): number {
  if (!(pin > 0) || x <= pin + 1e-9) return Math.max(0, x - pin);
  return Math.sqrt(Math.max(0, x * x - pin * pin));
}

function lerpFund(
  path: readonly PortfolioCarryFrontierPoint[],
  u: number,
): PortfolioCarryFrontierPoint {
  if (path.length === 0) {
    return { k: -1, portfolioVarUsd: 0, totalCarryUsdYr: 0, floorBoundCcys: [] };
  }
  if (u <= 0) return path[0]!;
  if (u >= 1) return path[path.length - 1]!;
  const t = u * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(t));
  const w = t - i;
  const a = path[i]!;
  const b = path[i + 1]!;
  return {
    k: a.k + w * (b.k - a.k),
    portfolioVarUsd: a.portfolioVarUsd + w * (b.portfolioVarUsd - a.portfolioVarUsd),
    totalCarryUsdYr: a.totalCarryUsdYr + w * (b.totalCarryUsdYr - a.totalCarryUsdYr),
    floorBoundCcys: w < 0.5 ? a.floorBoundCcys : b.floorBoundCcys,
  };
}

/**
 * Green open arm: overlay from Unhedged, funding ramps with it.
 * Do not draw a funding-only chord to Conservative — that is the dashed line.
 */
export function mixFundingAndOverlay(
  walk: { path: PortfolioCarryFrontierPoint[]; hold: PortfolioCarryFrontierPoint },
  sweep: PortfolioCarryFrontier,
  unhedgedCfarUsdM: number,
): PortfolioCarryFrontier {
  const pin = unhedgedCfarUsdM > 1e-9
    ? unhedgedCfarUsdM
    : (walk.path[0]?.portfolioVarUsd ?? 0);
  const origin: PortfolioCarryFrontierPoint = {
    k: 0,
    portfolioVarUsd: pin,
    totalCarryUsdYr: 0,
    floorBoundCcys: [],
  };
  const kHold = Math.max(1e-3, extraUsd(walk.hold.portfolioVarUsd, pin));
  const overlay = sweep.points.filter(p => p.k >= -1e-12);
  const points: PortfolioCarryFrontierPoint[] = [origin];
  for (const o of overlay) {
    if (o.k <= 1e-12) continue;
    const u = Math.min(1, o.k / kHold);
    const f = lerpFund(walk.path, u);
    points.push({
      k: o.k,
      portfolioVarUsd: Math.hypot(pin, extraUsd(f.portfolioVarUsd, pin), extraUsd(o.portfolioVarUsd, pin)),
      totalCarryUsdYr: f.totalCarryUsdYr + o.totalCarryUsdYr,
      floorBoundCcys: o.floorBoundCcys,
    });
  }
  const sweetK = sweep.sweetSpotIndex >= 0
    ? sweep.points[sweep.sweetSpotIndex]?.k
    : undefined;
  const sweetSpotIndex = sweetK != null && sweetK > 1e-12
    ? points.findIndex(p => Math.abs(p.k - sweetK) < 1e-9)
    : -1;
  return {
    ...sweep,
    points,
    sweetSpotIndex,
  };
}

/** @deprecated use mixFundingAndOverlay — funding-only-then-overlay is the straight chord. */
export function stitchOverlayAfterHold(
  walk: { path: PortfolioCarryFrontierPoint[]; hold: PortfolioCarryFrontierPoint },
  sweep: PortfolioCarryFrontier,
  unhedgedCfarUsdM: number,
): PortfolioCarryFrontier {
  return mixFundingAndOverlay(walk, sweep, unhedgedCfarUsdM);
}

/** Hold-the-book funding: cash + swap interest, no far-leg CIP / hedge FWD. */
export function conservativeFundingPoint(input: {
  byCcy: readonly {
    ccy: string;
    cashCarryUsdYrM: number;
    swapInterestUsdYrM: number;
    cfarUsdM: number;
  }[];
  includeCcy?: (ccy: string) => boolean;
}): PortfolioCarryFrontierPoint {
  const rows = input.byCcy.filter(c => !input.includeCcy || input.includeCcy(c.ccy));
  const cfar = rows.reduce((s, c) => s + (Number.isFinite(c.cfarUsdM) ? c.cfarUsdM : 0), 0);
  const carry = rows.reduce((s, c) => (
    s + (Number.isFinite(c.cashCarryUsdYrM) ? c.cashCarryUsdYrM : 0)
    + (Number.isFinite(c.swapInterestUsdYrM) ? c.swapInterestUsdYrM : 0)
  ), 0);
  return {
    k: 0,
    portfolioVarUsd: cfar,
    totalCarryUsdYr: carry,
    floorBoundCcys: [],
  };
}

/** Funded H* book for Conservative — never the unfunded overdraft row. */
export function pickConservativeFundingBook<T extends { strategy: { id: string } }>(
  results: readonly T[],
  preferredId?: string,
): T | null {
  const funded = results.filter(r => r.strategy.id !== 'unfunded');
  if (preferredId && preferredId !== 'unfunded') {
    const hit = funded.find(r => r.strategy.id === preferredId);
    if (hit) return hit;
  }
  return funded.find(r => r.strategy.id === 'rollingProgramme')
    ?? funded[0]
    ?? null;
}

function fromLeftPoint(
  p: LiquidityFrontierPoint,
  k: number,
): PortfolioCarryFrontierPoint {
  return {
    k,
    portfolioVarUsd: p.finalCfarUsdM,
    totalCarryUsdYr: p.totalCarryUsdYrM,
    floorBoundCcys: [],
    levered: p.levered,
  };
}

/** Same default cash-carry grid the per-currency modal uses before the cap slider moves. */
export function modalDefaultCarryUsdK(
  row: RowState,
  engine: SoloAlignEngine,
  bookStanding: number,
): number[] {
  const bookK = bookCashCarryK(
    bookStanding,
    ccySpotRate(row.ccy),
    row.r_FCY,
    engine.shared.r_USD,
    row.r_OD,
  );
  const searching = liquidityFrontierDial(engine.activeLayers) !== 'cash_floor';
  const levMin = Math.max(10, Math.ceil(Math.max(bookK, 0) / 5) * 5);
  return frontierCarryDotsK(bookK, {
    targetCashK: searching ? bookK : 0,
    tail: levMin > bookK + 0.5,
    maxK: levMin,
  });
}

export function portfolioFrontierFromLeftEnd(
  left: LiquidityLeftEndResult,
): PortfolioCarryFrontier {
  const origin = fromLeftPoint(left.origin, 0);
  const opens = left.upper
    .filter(p => p.delta < 1e-9)
    .sort((a, b) => a.finalCfarUsdM - b.finalCfarUsdM || a.peakBook - b.peakBook);
  const fars = [...left.lower]
    .sort((a, b) => a.finalCfarUsdM - b.finalCfarUsdM || a.peakBook - b.peakBook);
  return {
    points: [origin, ...opens.map(p => fromLeftPoint(p, p.peakBook))],
    farPoints: [origin, ...fars.map(p => fromLeftPoint(p, p.peakBook))],
    sweetSpotIndex: -1,
    nearestClampCcy: null,
    nearestClampVarUsd: null,
  };
}

/** Pin section / origin CFaR for one name (overdraft FX-only Net). */
export function engineWithSectionCfar(
  engine: SoloAlignEngine,
  ccy: string,
  sectionUsdM: number | undefined,
): SoloAlignEngine {
  if (sectionUsdM == null || !Number.isFinite(sectionUsdM)) return engine;
  return {
    ...engine,
    cfarNetByCcyUsd: {
      ...engine.cfarNetByCcyUsd,
      [ccy]: Math.max(0, sectionUsdM),
    },
  };
}

export function buildSoloCcyAlignedFrontier(input: {
  row: RowState;
  engine: SoloAlignEngine;
  strategy: LiquidityStrategy;
  bookStanding: number;
  /** Overdraft / FX-only Net ($M) — origin X. Overrides engine.cfarNetByCcyUsd. */
  sectionCfarUsdM?: number;
}): PortfolioCarryFrontier {
  const engine = engineWithSectionCfar(input.engine, input.row.ccy, input.sectionCfarUsdM);
  const left = buildLiquidityLeftEndFrontier({
    ...engine,
    row: input.row,
    strategy: input.strategy,
    bookStanding: input.bookStanding,
    carryUsdK: modalDefaultCarryUsdK(input.row, engine, input.bookStanding),
  });
  return portfolioFrontierFromLeftEnd(left);
}

/**
 * Overlay sweep k ($M 1-month VAR fill units) → modal open-arm (CFaR, carry)
 * of that currency's Σ⁻¹μ standing.
 *
 * k = 0 is the unhedged origin: section CFaR, $0 carry. Do not price a
 * leftover book standing — that lifts the marker off the X-axis.
 */
/**
 * Desk Target Carry when Earn is blank ($M/yr). $32k/yr — not the H* book's
 * own cash carry (that is what pinned the marker at ~$114k).
 */
export const DEFAULT_DESK_TARGET_CARRY_USD_YR = 32 / 1000;

/**
 * Open-arm point whose cash carry matches a desk Target Carry ($M/yr).
 * Interpolates the segment that straddles the ask. Off-arm asks return null.
 */
export function carryTargetOnArm(
  points: readonly PortfolioCarryFrontierPoint[],
  targetUsdYr: number,
): PortfolioCarryFrontierPoint | null {
  if (!Number.isFinite(targetUsdYr)) return null;
  const arm = points
    .filter(p => (
      Number.isFinite(p.portfolioVarUsd)
      && Number.isFinite(p.totalCarryUsdYr)
      && p.k >= -1e-12
    ))
    .sort((a, b) => a.k - b.k || a.portfolioVarUsd - b.portfolioVarUsd);
  if (arm.length === 0) return null;
  for (const p of arm) {
    if (Math.abs(p.totalCarryUsdYr - targetUsdYr) < 1e-9) return p;
  }
  for (let i = 0; i < arm.length - 1; i++) {
    const a = arm[i]!;
    const b = arm[i + 1]!;
    const lo = Math.min(a.totalCarryUsdYr, b.totalCarryUsdYr);
    const hi = Math.max(a.totalCarryUsdYr, b.totalCarryUsdYr);
    if (targetUsdYr < lo - 1e-12 || targetUsdYr > hi + 1e-12) continue;
    const span = b.totalCarryUsdYr - a.totalCarryUsdYr;
    if (Math.abs(span) < 1e-12) continue;
    return lerpFrontierPoint(a, b, (targetUsdYr - a.totalCarryUsdYr) / span);
  }
  return null;
}

/**
 * Max Policy Risk: highest open-arm CFaR still inside the policy cap.
 * Overlay k≥0 only — the funding approach is not a Policy VAR fill.
 * If the sweep straddles the cap, interpolate onto the cap so the
 * scenario is the fill, not the last sample $2M short of it.
 */
export function maxVarWithinPolicyPoint(
  points: readonly PortfolioCarryFrontierPoint[],
  policyCapUsd: number,
): PortfolioCarryFrontierPoint | null {
  if (!(policyCapUsd > 0)) return null;
  const overlay = points.filter(p => (
    Number.isFinite(p.portfolioVarUsd) && p.k >= -1e-12
  ));
  const inside = overlay.filter(p => p.portfolioVarUsd <= policyCapUsd + 1e-6);
  if (inside.length === 0) return null;
  let best = inside[0]!;
  for (const p of inside) {
    if (p.portfolioVarUsd > best.portfolioVarUsd) best = p;
  }
  const next = overlay.find(p => p.portfolioVarUsd > policyCapUsd + 1e-6);
  if (next && best.portfolioVarUsd < policyCapUsd - 1e-6) {
    const span = next.portfolioVarUsd - best.portfolioVarUsd;
    if (span > 1e-9) {
      const t = (policyCapUsd - best.portfolioVarUsd) / span;
      return {
        k: best.k + t * (next.k - best.k),
        portfolioVarUsd: policyCapUsd,
        totalCarryUsdYr: best.totalCarryUsdYr
          + t * (next.totalCarryUsdYr - best.totalCarryUsdYr),
        floorBoundCcys: best.floorBoundCcys,
      };
    }
  }
  return best;
}

function lerpFrontierPoint(
  a: PortfolioCarryFrontierPoint,
  b: PortfolioCarryFrontierPoint,
  t: number,
): PortfolioCarryFrontierPoint {
  const u = Math.min(1, Math.max(0, t));
  return {
    k: a.k + u * (b.k - a.k),
    portfolioVarUsd: a.portfolioVarUsd + u * (b.portfolioVarUsd - a.portfolioVarUsd),
    totalCarryUsdYr: a.totalCarryUsdYr + u * (b.totalCarryUsdYr - a.totalCarryUsdYr),
    floorBoundCcys: a.floorBoundCcys,
    levered: a.levered || b.levered,
  };
}

function kneeBetween(
  pts: readonly PortfolioCarryFrontierPoint[],
): PortfolioCarryFrontierPoint | null {
  if (pts.length === 0) return null;
  if (pts.length < 3) return pts[Math.floor(pts.length / 2)] ?? pts[0]!;
  const p0 = pts[0]!;
  const pN = pts[pts.length - 1]!;
  const dx = pN.portfolioVarUsd - p0.portfolioVarUsd;
  const dy = pN.totalCarryUsdYr - p0.totalCarryUsdYr;
  const norm = Math.hypot(dx, dy);
  if (norm < 1e-9) return pts[Math.floor(pts.length / 2)]!;
  let best = pts[0]!;
  let bestDist = -Infinity;
  for (const p of pts) {
    const cross = (p.portfolioVarUsd - p0.portfolioVarUsd) * dy
      - (p.totalCarryUsdYr - p0.totalCarryUsdYr) * dx;
    const dist = Math.abs(cross) / norm;
    if (dist > bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/** d(carry)/d(CFaR) at `at`, from neighboring samples on the arm. */
export function localCarryCfarSlope(
  pts: readonly { portfolioVarUsd: number; totalCarryUsdYr: number }[],
  at: { portfolioVarUsd: number },
): number | null {
  const sorted = pts
    .filter(p => Number.isFinite(p.portfolioVarUsd) && Number.isFinite(p.totalCarryUsdYr))
    .sort((a, b) => a.portfolioVarUsd - b.portfolioVarUsd);
  if (sorted.length < 2) return null;
  let i = 0;
  let bestD = Infinity;
  for (let k = 0; k < sorted.length; k++) {
    const d = Math.abs(sorted[k]!.portfolioVarUsd - at.portfolioVarUsd);
    if (d < bestD) {
      bestD = d;
      i = k;
    }
  }
  const lo = i > 0 ? i - 1 : i;
  const hi = i < sorted.length - 1 ? i + 1 : i;
  if (lo === hi) return null;
  const dx = sorted[hi]!.portfolioVarUsd - sorted[lo]!.portfolioVarUsd;
  if (!(dx > 1e-9)) return null;
  return (sorted[hi]!.totalCarryUsdYr - sorted[lo]!.totalCarryUsdYr) / dx;
}

/**
 * Supporting line from the $0-carry origin: argmax (carry − y0)/(CFaR − x0).
 * That touch point is where the Unhedged ray is tangent to the arm.
 */
export function tangencyFromOrigin(
  pts: readonly PortfolioCarryFrontierPoint[],
  origin: { portfolioVarUsd: number; totalCarryUsdYr: number },
): PortfolioCarryFrontierPoint | null {
  let best: PortfolioCarryFrontierPoint | null = null;
  let bestRatio = -Infinity;
  for (const p of pts) {
    const dx = p.portfolioVarUsd - origin.portfolioVarUsd;
    if (!(dx > 1e-9) || !Number.isFinite(p.totalCarryUsdYr)) continue;
    const ratio = (p.totalCarryUsdYr - origin.totalCarryUsdYr) / dx;
    if (!Number.isFinite(ratio)) continue;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = p;
    }
  }
  return best;
}

/**
 * Classical tangency: (γ − origin) ∥ γ′.
 * Cross product (x−x0)·z′ − (z−z0)·x′ = 0 at the touch point.
 * `mapCarry` is the plot Y (asinh) so the same line is straight on screen.
 */
export function tangencyByParallelDerivative(
  pts: readonly PortfolioCarryFrontierPoint[],
  origin: { portfolioVarUsd: number; totalCarryUsdYr: number },
  input?: {
    mapCarry?: (usdYr: number) => number;
    pick?: (p: PortfolioCarryFrontierPoint) => boolean;
  },
): PortfolioCarryFrontierPoint | null {
  const mapCarry = input?.mapCarry ?? ((v: number) => v);
  const arm = pts
    .filter(p => Number.isFinite(p.portfolioVarUsd) && Number.isFinite(p.totalCarryUsdYr))
    .sort((a, b) => a.portfolioVarUsd - b.portfolioVarUsd || a.k - b.k);
  if (arm.length < 3) return null;
  let best: PortfolioCarryFrontierPoint | null = null;
  let bestAbs = Infinity;
  for (let i = 1; i < arm.length - 1; i++) {
    const p = arm[i]!;
    if (input?.pick && !input.pick(p)) continue;
    const dx = arm[i + 1]!.portfolioVarUsd - arm[i - 1]!.portfolioVarUsd;
    const dz = mapCarry(arm[i + 1]!.totalCarryUsdYr) - mapCarry(arm[i - 1]!.totalCarryUsdYr);
    if (!(Math.abs(dx) > 1e-12)) continue;
    const rx = p.portfolioVarUsd - origin.portfolioVarUsd;
    const rz = mapCarry(p.totalCarryUsdYr) - mapCarry(origin.totalCarryUsdYr);
    if (!(rx > 1e-12)) continue;
    const cross = rx * dz - rz * dx;
    if (Math.abs(cross) < bestAbs) {
      bestAbs = Math.abs(cross);
      best = p;
    }
  }
  return best;
}

/** Same asinh band `carryAxisFromArms` uses when the plot does not pass `s`. */
export function plotCarryS(pts: readonly { totalCarryUsdYr: number }[]): number {
  const yHi = Math.max(0.012, ...pts.map(p => p.totalCarryUsdYr).filter(Number.isFinite));
  const yLo = Math.min(0, ...pts.map(p => p.totalCarryUsdYr).filter(Number.isFinite));
  return Math.max(0.012, yHi, Math.abs(yLo) * 1.2);
}

/**
 * Supporting-ray touch from true (0, 0) on the whole open arm.
 * Plot space: X = CFaR, Z = asinh(carry / s). Touch = the sample that
 * maximises Z/X — the unique hull vertex whose ray from the origin stays
 * on one side of every other sample. Interpolating off that vertex makes
 * a secant through the green polyline; do not lerp.
 */
export function tangencyFromTrueZero(
  pts: readonly PortfolioCarryFrontierPoint[],
  carryS?: number,
): PortfolioCarryFrontierPoint | null {
  const arm = pts
    .filter(p => (
      Number.isFinite(p.portfolioVarUsd)
      && Number.isFinite(p.totalCarryUsdYr)
      && p.portfolioVarUsd > 1e-9
    ))
    .sort((a, b) => a.portfolioVarUsd - b.portfolioVarUsd || a.k - b.k);
  if (arm.length === 0) return null;

  const s = Math.max(carryS ?? plotCarryS(arm), 1e-6);
  let best = arm[0]!;
  let bestRatio = -Infinity;
  for (const p of arm) {
    const z = carryFwd(p.totalCarryUsdYr, s);
    if (!Number.isFinite(z)) continue;
    const ratio = z / p.portfolioVarUsd;
    if (ratio > bestRatio + 1e-15) {
      bestRatio = ratio;
      best = p;
    }
  }
  return bestRatio > -Infinity ? best : null;
}

/**
 * Open-arm presets: $0-carry origin, optional Carry Target, Balanced,
 * Max Policy Risk. Balanced is the (0, 0) supporting-ray touch.
 */
export function orderedLiquidityScenarioPoints(input: {
  points: readonly PortfolioCarryFrontierPoint[];
  conservative?: PortfolioCarryFrontierPoint | null;
  policyCapUsd: number;
  originCfarUsd?: number | null;
  /** Plot asinh band — must match the chart or the graze drifts. */
  carryS?: number;
  /** Desk Target Carry ($M/yr). When set, Carry Target sits on this Y. */
  carryTargetUsdYr?: number | null;
}): {
  origin: PortfolioCarryFrontierPoint | null;
  conservative: PortfolioCarryFrontierPoint | null;
  carryTarget: PortfolioCarryFrontierPoint | null;
  balanced: PortfolioCarryFrontierPoint | null;
  maxCarry: PortfolioCarryFrontierPoint | null;
} {
  const arm = input.points
    .filter(p => Number.isFinite(p.portfolioVarUsd) && Number.isFinite(p.totalCarryUsdYr) && p.k >= -1e-12)
    .sort((a, b) => a.k - b.k || a.portfolioVarUsd - b.portfolioVarUsd);
  const empty = {
    origin: null, conservative: null, carryTarget: null, balanced: null, maxCarry: null,
  };
  if (arm.length === 0) return empty;

  const walkOrigin = arm[0]!;
  const originCfar = Math.max(0, walkOrigin.portfolioVarUsd);
  const origin: PortfolioCarryFrontierPoint = {
    k: 0,
    portfolioVarUsd: originCfar,
    totalCarryUsdYr: 0,
    floorBoundCcys: [],
  };

  const afterOrigin = arm.filter(p => p.portfolioVarUsd > originCfar + 1e-6);
  const book = input.conservative
    && input.conservative.portfolioVarUsd > originCfar + 1e-6
    ? input.conservative
    : afterOrigin.find(p => Math.abs(p.k - 1) < 1e-6)
      ?? afterOrigin[0]
      ?? null;
  const balanced = tangencyFromTrueZero(arm, input.carryS);
  const ask = typeof input.carryTargetUsdYr === 'number' && Number.isFinite(input.carryTargetUsdYr)
    ? input.carryTargetUsdYr
    : DEFAULT_DESK_TARGET_CARRY_USD_YR;
  // Synthetic origin (Y = 0) is not always the first walk sample — after
  // lift, k = 0 still has program carry. Search from Unhedged so Earn
  // interpolates onto the first segment instead of going null / clamping
  // every desk $K to the same hold point.
  const searchArm = [
    origin,
    ...arm.filter(p => p.portfolioVarUsd > originCfar + 1e-6 || p.k > 1e-12),
  ];
  const carryTarget = carryTargetOnArm(searchArm, ask);
  if (!book) {
    return { origin, conservative: null, carryTarget, balanced, maxCarry: null };
  }

  const afterBook = arm.filter(p => (
    p.k >= book.k - 1e-9 && p.portfolioVarUsd > book.portfolioVarUsd + 1e-6
  ));
  // Never use Conservative's own CFaR as the Max Carry cap — that pins
  // Balanced and Max Carry onto the same X as the hold.
  const requested = approvalTierCapUsd(input.policyCapUsd);
  const roomPastBook = POLICY_VAR_LIMITS.find(p => p.usd > book.portfolioVarUsd + 0.05)?.usd
    ?? POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  const cap = requested <= book.portfolioVarUsd + 0.05 ? roomPastBook : requested;
  let maxCarry = maxVarWithinPolicyPoint([book, ...afterBook], cap);
  if (!maxCarry || maxCarry.portfolioVarUsd <= book.portfolioVarUsd + 1e-6) {
    maxCarry = afterBook[afterBook.length - 1] ?? null;
  }
  if (!maxCarry) {
    return { origin, conservative: book, carryTarget, balanced, maxCarry: null };
  }

  return { origin, conservative: book, carryTarget, balanced, maxCarry };
}

export function overlayKToModalXy(
  k: number,
  row: RowState,
  engine: SoloAlignEngine,
  bookStanding: number,
): { x: number; y: number } | null {
  if (!Number.isFinite(k)) return null;
  if (Math.abs(k) < 1e-9) {
    return { x: sectionCfarUsdM(engine.cfarNetByCcyUsd, row.ccy), y: 0 };
  }
  const mu = (row.r_FCY - engine.shared.r_USD) / 100;
  const alloc = allocateCarryVarUsd({ ccys: [row.ccy], mu: [mu], varCapUsdM: 1 });
  if (!alloc) return null;
  const spot = ccySpotRate(row.ccy);
  const standing = spot > 1e-12 ? (k * alloc.wUsdM[0]!) / spot : 0;
  const bookK = bookCashCarryK(
    bookStanding, spot, row.r_FCY, engine.shared.r_USD, row.r_OD,
  );
  const priced = priceLiquidityStanding({ ...engine, row }, standing, bookK);
  return { x: priced.cfarOpenUsdM, y: priced.open.totalCarryUsdYrM };
}
