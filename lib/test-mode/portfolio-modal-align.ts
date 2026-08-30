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
  findIsoMixFar,
  frontierCarryDotsK,
  isoMixCipUsdYrM,
  leftEndOriginPoint,
  liquidityFrontierDial,
  priceLiquidityStanding,
  sectionCfarUsdM,
  signedPeakStanding,
  type LiquidityFrontierDial,
  type LiquidityFrontierInput,
  type LiquidityFrontierPoint,
  type LiquidityLeftEndResult,
} from '@/lib/test-mode/liquidity-frontier';
import {
  cfarTailProbability,
  type LiquidityStrategy,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import {
  buildPortfolioLiquidityFrontier,
  overlayStandingAtPlotScale,
  overlayWalkMaxScale,
  standingAtScale,
  toPortfolioCarryFrontier,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
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

/** Modal Leverage slider floor ($K) — same rounding as the control. */
export function modalLevMinK(bookCashK: number): number {
  return Math.max(10, Math.ceil(Math.max(bookCashK, 0) / 5) * 5);
}

/** Overlay t that prints `cashK` on one cap standing. */
export function overlayTFromCashCarryK(
  cashK: number,
  overlayFcyM: number,
  row: RowState,
  r_USD: number,
): number {
  if (!(cashK > 0.5) || !(Math.abs(overlayFcyM) > 0.01)) return 0;
  const capK = bookCashCarryK(
    overlayFcyM, ccySpotRate(row.ccy), row.r_FCY, r_USD, row.r_OD,
  );
  if (!(Math.abs(capK) > 0.5)) return 0;
  return cashK / Math.abs(capK);
}

/**
 * Dashed-tail cap both charts walk to.
 *
 * Overlay: max(Ask pad 1.25×tAsk, 1.2, modal levMin $K → t). Swap / Both:
 * null — the book-scale builder auto-extends unless the caller passes the
 * parent walk's tip k as a hard cap.
 */
export function alignedInspectMaxScale(input: {
  askFillMode?: 'overlay' | 'swap' | 'both' | null;
  tAsk: number;
  overlayCapFcyM?: number | null;
  row?: RowState | null;
  r_USD?: number;
  bookCashK?: number;
  maxCarryK?: number | null;
}): number | null {
  if (input.askFillMode !== 'overlay') return null;
  const fromAsk = overlayWalkMaxScale(input.tAsk);
  const fcy = input.overlayCapFcyM;
  const row = input.row;
  if (
    typeof fcy !== 'number' || !(Math.abs(fcy) > 0.01)
    || !row || typeof input.r_USD !== 'number'
  ) {
    return fromAsk;
  }
  const bookK = typeof input.bookCashK === 'number' && Number.isFinite(input.bookCashK)
    ? input.bookCashK
    : 0;
  const capK = Math.max(
    modalLevMinK(bookK),
    typeof input.maxCarryK === 'number' && input.maxCarryK > 0 ? input.maxCarryK : 0,
  );
  return Math.max(fromAsk, overlayTFromCashCarryK(capK, fcy, row, input.r_USD));
}

/** Tip k on a priced walk (parent chart → modal hard cap). */
export function frontierWalkTipK(
  points: readonly { k: number }[] | null | undefined,
): number | null {
  if (!points?.length) return null;
  const hi = Math.max(...points.map(p => p.k).filter(Number.isFinite));
  return Number.isFinite(hi) && hi > 1 + 1e-6 ? hi : null;
}

/**
 * Dashed tail past the live book.
 *
 * Explicit `levered` wins: native left-end / solo walks store FCY standing
 * in `k` (often ≫ 1) and stamp the flag from cash-carry vs the live book.
 * ORing `k > 1` dashed that whole arm. Overlay / book-scale walks stamp
 * `levered` from t/k > 1. Flag omitted → fall back to k > 1 (overlay t).
 */
export function isWalkLevered(p: { k: number; levered?: boolean }): boolean {
  if (p.levered === true) return true;
  if (p.levered === false) return false;
  return Number.isFinite(p.k) && p.k > 1 + 1e-6;
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
  const levMin = modalLevMinK(bookK);
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

function portfolioPtToLeft(
  p: PortfolioCarryFrontierPoint,
  delta: 0 | 1,
  standing: number,
): LiquidityFrontierPoint {
  return {
    ...leftEndOriginPoint(p.portfolioVarUsd),
    delta,
    multiple: p.k,
    phase: delta >= 1 ? 'hedged' : 'unfunded',
    peakBook: standing,
    carryM: standing,
    cashCarryUsdYrM: p.totalCarryUsdYr,
    totalCarryUsdYrM: p.totalCarryUsdYr,
    finalCfarUsdM: Math.max(0, p.portfolioVarUsd),
    levered: isWalkLevered(p),
  };
}

/**
 * Stroke the same (CFaR, carry) arm the parent draws for a one-name
 * filtered universe. Origin stays unhedged; later vertices keep walk k.
 */
export function leftEndFromPortfolioFrontier(
  port: PortfolioCarryFrontier,
  input: {
    dial: LiquidityFrontierDial;
    liveStanding: number;
    overlayFcyM?: number;
    walk: 'overlay' | 'book-scale';
    bookCashK?: number;
  },
): LiquidityLeftEndResult {
  const originX = port.points[0]?.portfolioVarUsd ?? 0;
  const origin = leftEndOriginPoint(originX);
  const sweetT = input.walk === 'overlay' ? 0 : 1;
  const standingOf = (k: number) => (
    input.walk === 'overlay'
      ? overlayStandingAtPlotScale(input.liveStanding, k, input.overlayFcyM, sweetT)
      : standingAtScale(input.liveStanding, k, input.overlayFcyM, sweetT)
  );
  const upper = port.points
    .filter(p => p.k > 1e-9)
    .map(p => portfolioPtToLeft(p, 0, standingOf(p.k)));
  const farSrc = port.farPoints ?? [];
  const lower = farSrc
    .filter(p => p.k > 1e-9)
    .map(p => portfolioPtToLeft(p, 1, standingOf(p.k)));
  // Inspect conversion stores total Y only (`cipUsdYrM` stays 0). Stamp
  // CIP from the paired far twin (k or standing) so d=0↔d=1 has a Y path.
  for (const open of upper) {
    const far = findIsoMixFar(open, lower);
    if (!far) continue;
    const cip = isoMixCipUsdYrM(open, far);
    if (Number.isFinite(cip) && Math.abs(cip) > 1e-12) {
      open.cipUsdYrM = cip;
      far.cipUsdYrM = cip;
    }
  }
  const tip = upper[upper.length - 1] ?? origin;
  return {
    dial: input.dial,
    walk: 'carry_pair',
    cfarOriginUsdM: originX,
    origin,
    upper,
    lower,
    curve: [origin, ...upper],
    points: [...upper, ...lower],
    applied: tip,
    constraint: {
      dial: input.dial,
      hCarryUsdYrM: null,
      vCfarUsdM: null,
      openHit: null,
      hedgeHit: null,
    },
    bookStanding: input.liveStanding,
    bookCashK: input.bookCashK ?? 0,
  };
}

/**
 * One-name inspect walk — same builder as the EUR-only portfolio chart.
 * Overlay fill: unhedged book + scaled term overlay. Swap / Both: book-scale.
 */
export function buildCcyInspectLeftEnd(input: {
  row: RowState;
  engine: SoloAlignEngine;
  result: LiquidityStrategyResult;
  askFillMode: 'overlay' | 'swap' | 'both';
  overlayCapFcyM?: number | null;
  maxScale?: number | null;
  sectionCfarUsdM?: number;
}): LiquidityLeftEndResult {
  const engine = engineWithSectionCfar(input.engine, input.row.ccy, input.sectionCfarUsdM);
  const overlayFcy = typeof input.overlayCapFcyM === 'number'
    && Number.isFinite(input.overlayCapFcyM)
    && Math.abs(input.overlayCapFcyM) > 0.01
    ? input.overlayCapFcyM
    : null;
  const overlayFill = input.askFillMode === 'overlay' && overlayFcy != null;
  const filtered: LiquidityStrategyResult = {
    ...input.result,
    byCcy: input.result.byCcy.filter(c => c.ccy === input.row.ccy),
  };
  const scaleCap = typeof input.maxScale === 'number' && Number.isFinite(input.maxScale) && input.maxScale > 0
    ? { maxScale: input.maxScale }
    : {};
  const liq = buildPortfolioLiquidityFrontier({
    result: filtered,
    strategy: input.result.strategy,
    rows: [input.row],
    engine,
    ...scaleCap,
    ...(overlayFill
      ? {
          overlayFcyByCcy: { [input.row.ccy]: overlayFcy },
          overlaySweetT: 0,
        }
      : {}),
  });
  const port = toPortfolioCarryFrontier(liq);
  const live = overlayFill
    ? 0
    : signedPeakStanding(filtered.byCcy[0]?.plan);
  const bookK = overlayFill || !input.row
    ? 0
    : bookCashCarryK(
      live,
      ccySpotRate(input.row.ccy),
      input.row.r_FCY,
      engine.shared.r_USD,
      input.row.r_OD,
    );
  return leftEndFromPortfolioFrontier(port, {
    dial: liquidityFrontierDial(engine.activeLayers),
    liveStanding: live,
    overlayFcyM: overlayFcy ?? undefined,
    walk: liq.walk,
    bookCashK: bookK,
  });
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
 * Efficient skyline on the Total-Carry / Port-CFaR plane.
 *
 * The book-scale walk is a parametric trace in k. Diversified CFaR is not
 * monotone in k (RSS bow on t < 1), so joining samples in sweep order draws
 * dominated points — the jag around ~$1.5M. Sweep richest carry first and
 * keep a point only when it beats every richer point on risk. Result is
 * ascending carry / ascending CFaR so a line through it cannot double back.
 */
export function efficientCarryVarEnvelope(
  points: readonly PortfolioCarryFrontierPoint[],
): PortfolioCarryFrontierPoint[] {
  const finite = points.filter(p => (
    Number.isFinite(p.portfolioVarUsd) && Number.isFinite(p.totalCarryUsdYr)
  ));
  if (finite.length <= 1) return finite;
  const byCarryDesc = [...finite].sort((a, b) => (
    b.totalCarryUsdYr - a.totalCarryUsdYr
    || a.portfolioVarUsd - b.portfolioVarUsd
  ));
  const keep: PortfolioCarryFrontierPoint[] = [];
  let bestX = Number.POSITIVE_INFINITY;
  for (const p of byCarryDesc) {
    if (p.portfolioVarUsd < bestX - 1e-9) {
      keep.push(p);
      bestX = p.portfolioVarUsd;
    }
  }
  return keep.reverse();
}

/**
 * CCY modal arm: every priced sample in walk order (k).
 * Do not run the max-carry envelope — that drops unhedged $0 at the
 * same CFaR and leaves the orange gap at the k-stack peak.
 */
function walkOrderArm(
  points: readonly PortfolioCarryFrontierPoint[],
): PortfolioCarryFrontierPoint[] {
  return points
    .filter(p => (
      Number.isFinite(p.portfolioVarUsd) && Number.isFinite(p.totalCarryUsdYr)
    ))
    .sort((a, b) => a.k - b.k || a.portfolioVarUsd - b.portfolioVarUsd);
}

/** @deprecated use plotStandingCarryArm — envelope is not the drawn stroke. */
export function plotCarryVarArm(
  points: readonly PortfolioCarryFrontierPoint[],
): PortfolioCarryFrontierPoint[] {
  return walkOrderArm(points);
}

/** Open / cash arm — same walk-order samples the CCY modal strokes. */
export function plotStandingCarryArm(
  points: readonly PortfolioCarryFrontierPoint[],
): PortfolioCarryFrontierPoint[] {
  return walkOrderArm(points);
}

/** Far / CIP arm — same walk, signed cash + points. */
export function plotFarCarryArm(
  points: readonly PortfolioCarryFrontierPoint[],
): PortfolioCarryFrontierPoint[] {
  return walkOrderArm(points);
}

export function frontierMonotoneStats(
  points: readonly PortfolioCarryFrontierPoint[],
): { n: number; xBacktracks: number; yDips: number; envelopeN: number } {
  let xBacktracks = 0;
  let yDips = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (b.portfolioVarUsd < a.portfolioVarUsd - 1e-9) xBacktracks += 1;
    if (b.totalCarryUsdYr < a.totalCarryUsdYr - 1e-9) yDips += 1;
  }
  return {
    n: points.length,
    xBacktracks,
    yDips,
    envelopeN: efficientCarryVarEnvelope(points).length,
  };
}

/** Live book samples from origin → hold (k ≤ 1). */
export function liveBookArm<T extends { k: number }>(
  points: readonly T[],
): T[] {
  return points.filter(p => Number.isFinite(p.k) && p.k >= -1e-12 && p.k <= 1 + 1e-6);
}

/**
 * Drop vertices that sit on the same CFaR (true stack). Distinct X —
 * even a $1k step — stays. Do not use a % of the axis span: that
 * collapsed a $300k run into one vertex and drew the 9-dot polyline.
 */
export function collapseNearVerticalRuns(
  pts: readonly { x: number; y: number }[],
  xTol?: number,
): { x: number; y: number }[] {
  if (pts.length <= 2) return [...pts];
  const explicitX = typeof xTol === 'number' && Number.isFinite(xTol);
  const xBand = explicitX ? xTol : 1e-6;
  const out: { x: number; y: number }[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(p);
      continue;
    }
    const sameX = Math.abs(p.x - prev.x) <= xBand;
    // Default: a vertical standing walk (same CFaR, rising carry) is
    // the overlay stem — keep it. Explicit xTol is the old X-only fold.
    if (!sameX || (!explicitX && Math.abs(p.y - prev.y) > 1e-9)) out.push(p);
  }
  const last = pts[pts.length - 1]!;
  const tail = out[out.length - 1]!;
  if (last !== tail) {
    if (out.length === 1 || Math.abs(last.x - tail.x) > xBand) out.push(last);
    else if (explicitX) out[out.length - 1] = last;
    else if (Math.abs(last.y - tail.y) > 1e-9) out.push(last);
  }
  return out;
}

/**
 * Screen-space thin only when two vertices land on the same pixel
 * (both axes). A 16px X-only decimate is what stripped the overlay
 * arm down to a handful of chords.
 */
export function thinScreenCollocated(
  pts: readonly { x: number; y: number }[],
  screenX: (worldX: number) => number,
  screenY: (worldY: number) => number,
  minPx = 2,
): { x: number; y: number }[] {
  if (pts.length <= 2) return [...pts];
  const px = Math.max(1, minPx);
  const out = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = out[out.length - 1]!;
    const p = pts[i]!;
    if (
      Math.abs(screenX(p.x) - screenX(prev.x)) >= px
      || Math.abs(screenY(p.y) - screenY(prev.y)) >= px
    ) {
      out.push(p);
    }
  }
  const last = pts[pts.length - 1]!;
  const tail = out[out.length - 1]!;
  if (Math.abs(last.x - tail.x) > 1e-12 || Math.abs(last.y - tail.y) > 1e-12) {
    out.push(last);
  }
  return out;
}

/**
 * Modal stroke: first vertex is unhedged (originX, $0), then every
 * priced sample. No envelope, collapse, or decimate — the CCY modal
 * is `toPath([origin, ...openSolid])`.
 *
 * Do not invent a vertical stem: when the first priced sample is already
 * a huge Y at the origin X (overlay t=1 dumped onto k=0), drop that lift
 * and keep the rest. The walk itself must start at $0 with small steps.
 */
export function chartOpenPath(
  skyline: readonly { x: number; y: number }[],
  originX: number,
  pinUnhedgedZero: boolean,
): { x: number; y: number }[] {
  const samples = skyline.filter(p => (
    Number.isFinite(p.x) && Number.isFinite(p.y)
  ));
  if (originX <= 1e-9 || !pinUnhedgedZero) return [...samples];
  const rest = samples.filter(p => Math.hypot(p.x - originX, p.y) > 1e-4);
  const first = rest[0];
  const dumpedLift = first != null
    && Math.abs(first.x - originX) <= 1e-3
    && Math.abs(first.y) > 0.20
    && !rest.some(p => Math.abs(p.y) > 1e-6 && Math.abs(p.y) < Math.abs(first.y) * 0.25);
  const kept = dumpedLift
    ? rest.filter(p => Math.abs(p.x - originX) > 1e-3 || Math.abs(p.y) <= 0.20)
    : rest;
  return [{ x: originX, y: 0 }, ...kept];
}

/** Split a priced walk into live-book (solid) vs k>1 leverage (dashed). */
export function splitLeveredChartPath(
  walk: readonly PortfolioCarryFrontierPoint[],
  originX: number,
): { solid: { x: number; y: number }[]; levered: { x: number; y: number }[] } {
  const toXy = (p: PortfolioCarryFrontierPoint) => ({
    x: p.portfolioVarUsd,
    y: p.totalCarryUsdYr,
  });
  const solidWalk = walk.filter(p => !isWalkLevered(p));
  const levWalk = walk.filter(p => isWalkLevered(p));
  const solid = chartOpenPath(solidWalk.map(toXy), originX, true);
  if (levWalk.length === 0) return { solid, levered: [] };
  const join = solid[solid.length - 1]
    ?? (solidWalk.length > 0 ? toXy(solidWalk[solidWalk.length - 1]!) : { x: originX, y: 0 });
  return { solid, levered: [join, ...levWalk.map(toXy)] };
}

/** Same as `chartOpenPath`. No fill arg, no hull, no stem filter. */
export const chartFrontierStroke = chartOpenPath;

export type ChartPathTrace = {
  nRaw: number;
  nSkyline: number;
  nDrawn: number;
  originX: number;
  originY: number;
  liftedOrigin: boolean;
  pinApplied: boolean;
  nearOriginTol: number;
  nNearOrigin: number;
  nearOriginDx: number;
  nearOriginDy: number;
  hookRisk: boolean;
  rawHead: { k: number; x: number; y: number }[];
  drawn: { x: number; y: number }[];
};

/**
 * Drawn stroke = origin ($0 @ unhedged CFaR) + monotone walk samples.
 */
export function chartPathTrace(
  points: readonly PortfolioCarryFrontierPoint[],
  originX: number,
  pinUnhedgedZero: boolean,
): ChartPathTrace {
  const skyline = plotStandingCarryArm(points);
  const xy = skyline.map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr }));
  const drawn = chartFrontierStroke(xy, originX, pinUnhedgedZero);
  const xs = points.map(p => p.portfolioVarUsd);
  const span = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;
  const nearOriginTol = Math.max(0.08, span * 0.02);
  const originPt = skyline.find(p => Math.abs(p.portfolioVarUsd - originX) <= 1e-3)
    ?? skyline[0];
  const originY = pinUnhedgedZero && originX > 1e-9
    ? 0
    : (originPt?.totalCarryUsdYr ?? 0);
  const liftedOrigin = !pinUnhedgedZero
    && Number.isFinite(originPt?.totalCarryUsdYr)
    && Math.abs(originPt!.totalCarryUsdYr) > 1e-3;
  const pinApplied = Boolean(pinUnhedgedZero && originX > 1e-9);
  const near = skyline.filter(p => Math.abs(p.portfolioVarUsd - originX) <= nearOriginTol);
  const nearXs = near.map(p => p.portfolioVarUsd);
  const nearYs = near.map(p => p.totalCarryUsdYr);
  const nearOriginDx = nearXs.length > 0 ? Math.max(...nearXs) - Math.min(...nearXs) : 0;
  const nearOriginDy = nearYs.length > 0 ? Math.max(...nearYs) - Math.min(...nearYs) : 0;
  return {
    nRaw: points.length,
    nSkyline: skyline.length,
    nDrawn: drawn.length,
    originX,
    originY,
    liftedOrigin,
    pinApplied,
    nearOriginTol,
    nNearOrigin: near.length,
    nearOriginDx,
    nearOriginDy,
    hookRisk: near.length >= 3 && nearOriginDx <= nearOriginTol && nearOriginDy > 0.02,
    rawHead: skyline.slice(0, 6).map(p => ({
      k: p.k,
      x: p.portfolioVarUsd,
      y: p.totalCarryUsdYr,
    })),
    drawn: drawn.slice(0, 8),
  };
}

export function splitOverlayFillOpenArm<T extends { k: number }>(
  points: readonly T[],
): { approach: T[]; overlay: T[] } {
  const holdIdx = points.findIndex(p => Number.isFinite(p.k) && Math.abs(p.k - 1) < 1e-6);
  if (holdIdx < 0) return { approach: [...points], overlay: [] };
  return {
    approach: points.slice(0, holdIdx + 1),
    overlay: points.slice(holdIdx),
  };
}

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
 * Balanced on the chart: supporting-ray touch among **priced walk vertices
 * that the stroke draws**. The pin ($0 @ unhedged CFaR) is not a ticket.
 * Overlay dumped onto k=0 at origin X is not a ticket. Do not lerp.
 */
export function pricedBalancedVertex(
  points: readonly PortfolioCarryFrontierPoint[],
  originX: number,
  carryS?: number,
): PortfolioCarryFrontierPoint | null {
  const skyline = plotStandingCarryArm(points);
  const drawn = chartOpenPath(
    skyline.map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr })),
    originX,
    true,
  );
  const priced: PortfolioCarryFrontierPoint[] = [];
  for (const s of drawn) {
    const hit = skyline.find(p => (
      Math.abs(p.portfolioVarUsd - s.x) < 1e-6
      && Math.abs(p.totalCarryUsdYr - s.y) < 1e-6
    ));
    if (!hit) continue;
    if (Math.abs(hit.totalCarryUsdYr) < 1e-9) continue;
    priced.push(hit);
  }
  if (priced.length > 0) return tangencyFromTrueZero(priced, carryS);
  const off = skyline.filter(p => (
    p.portfolioVarUsd > originX + 1e-6
    && Math.abs(p.totalCarryUsdYr) > 1e-9
  ));
  if (off.length > 0) return tangencyFromTrueZero(off, carryS);
  const live = skyline.filter(p => (
    p.k > 1e-12 && Math.abs(p.totalCarryUsdYr) > 1e-9
  ));
  return tangencyFromTrueZero(live, carryS);
}

/**
 * Carry Target on the chart: Ask Y on the same search arm as preset chips
 * ($0 @ chart origin, then priced walk samples). Matches `chartOpenPath` pin.
 */
export function pricedCarryTargetVertex(
  points: readonly PortfolioCarryFrontierPoint[],
  originX: number,
  targetUsdYr: number,
): PortfolioCarryFrontierPoint | null {
  if (!Number.isFinite(targetUsdYr)) return null;
  const arm = points
    .filter(p => (
      Number.isFinite(p.portfolioVarUsd)
      && Number.isFinite(p.totalCarryUsdYr)
      && p.k >= -1 - 1e-12
    ))
    .sort((a, b) => a.k - b.k || a.portfolioVarUsd - b.portfolioVarUsd);
  const originCfar = Math.max(0, originX);
  const origin: PortfolioCarryFrontierPoint = {
    k: 0,
    portfolioVarUsd: originCfar,
    totalCarryUsdYr: 0,
    floorBoundCcys: [],
  };
  const searchArm = [
    origin,
    ...arm.filter(p => p.portfolioVarUsd > originCfar + 1e-6 || p.k > 1e-12),
  ];
  return carryTargetOnArm(searchArm, targetUsdYr);
}

export type ChartPresetScenarioId =
  | 'unhedged'
  | 'carryTarget'
  | 'balanced'
  | 'maxCarry'
  | 'maxReturn';

/**
 * Chart / chip / selection preset — same origin X and plotCarryS as
 * PortfolioCarryVarFrontierPlot so auto-wiring and click-back stay aligned.
 */
export function chartPresetPointForScenario(input: {
  scenarioId: ChartPresetScenarioId;
  points: readonly PortfolioCarryFrontierPoint[];
  originX: number;
  policyCapUsd: number;
  confidencePct: number;
  carryTargetUsdYr?: number | null;
  conservative?: PortfolioCarryFrontierPoint | null;
  carryS?: number;
  tailProb?: number;
}): PortfolioCarryFrontierPoint | null {
  const pts = input.points;
  const originX = Math.max(0, input.originX);
  const s = input.carryS ?? plotCarryS(pts);
  const ordered = orderedLiquidityScenarioPoints({
    points: pts,
    conservative: input.conservative,
    policyCapUsd: input.policyCapUsd,
    originCfarUsd: originX,
    carryS: s,
    carryTargetUsdYr: input.carryTargetUsdYr,
  });
  switch (input.scenarioId) {
    case 'unhedged':
      return ordered.origin;
    case 'carryTarget': {
      const ask = typeof input.carryTargetUsdYr === 'number' && Number.isFinite(input.carryTargetUsdYr)
        ? input.carryTargetUsdYr
        : DEFAULT_DESK_TARGET_CARRY_USD_YR;
      return pricedCarryTargetVertex(pts, originX, ask) ?? ordered.carryTarget;
    }
    case 'balanced':
      return pricedBalancedVertex(pts, originX, s) ?? ordered.balanced;
    case 'maxCarry':
      return ordered.maxCarry;
    case 'maxReturn': {
      const tail = input.tailProb ?? cfarTailProbability(input.confidencePct);
      if (pts.length === 0) return null;
      let bestIdx = 0;
      let bestScore = pts[0]!.totalCarryUsdYr - pts[0]!.portfolioVarUsd * tail;
      pts.forEach((p, i) => {
        const score = p.totalCarryUsdYr - p.portfolioVarUsd * tail;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      });
      if (bestIdx === pts.length - 1 && pts.length > 1) return null;
      return pts[bestIdx] ?? null;
    }
    default:
      return null;
  }
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
    .filter(p => (
      Number.isFinite(p.portfolioVarUsd)
      && Number.isFinite(p.totalCarryUsdYr)
      && p.k >= -1 - 1e-12
    ))
    .sort((a, b) => a.k - b.k || a.portfolioVarUsd - b.portfolioVarUsd);
  const empty = {
    origin: null, conservative: null, carryTarget: null, balanced: null, maxCarry: null,
  };
  if (arm.length === 0) return empty;

  const walkOrigin = arm[0]!;
  const originCfar = (
    typeof input.originCfarUsd === 'number'
    && Number.isFinite(input.originCfarUsd)
    && input.originCfarUsd > 1e-9
  )
    ? Math.max(0, input.originCfarUsd)
    : Math.max(0, walkOrigin.portfolioVarUsd);
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
  const balanced = pricedBalancedVertex(arm, originCfar, input.carryS);
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
  let carryTarget = carryTargetOnArm(searchArm, ask);
  if (!carryTarget && searchArm.length > 0) {
    const hi = searchArm.reduce((best, p) => (
      p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
    ));
    const lo = searchArm.reduce((best, p) => (
      p.totalCarryUsdYr <= best.totalCarryUsdYr ? p : best
    ));
    if (ask >= hi.totalCarryUsdYr - 1e-12) carryTarget = hi;
    else if (ask <= lo.totalCarryUsdYr + 1e-12) carryTarget = lo;
  }
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

/** CCY-row ticket the modal must land on (not Port. CFaR / Policy VAR). */
export type CcyModalTicket = {
  cfarUsdM: number;
  carryUsdYrM: number;
  bookUsdYrM: number;
  overlayUsdYrM: number;
  bookStandingFcyM: number;
  bookStandingUsdM?: number;
};

export function ccyModalAlignTicket(
  sp: {
    cfarUsdM: number;
    carryUsdYrM: number;
    bookUsdYrM: number;
    overlayUsdYrM: number;
    bookStandingFcyM: number;
    bookStandingUsdM?: number;
  } | null | undefined,
): CcyModalTicket | null {
  if (!sp) return null;
  if (!(Math.abs(sp.bookStandingFcyM) > 0.01)) return null;
  if (!Number.isFinite(sp.cfarUsdM) || !Number.isFinite(sp.carryUsdYrM)) return null;
  return {
    cfarUsdM: sp.cfarUsdM,
    carryUsdYrM: sp.carryUsdYrM,
    bookUsdYrM: sp.bookUsdYrM,
    overlayUsdYrM: sp.overlayUsdYrM,
    bookStandingFcyM: sp.bookStandingFcyM,
    bookStandingUsdM: sp.bookStandingUsdM,
  };
}

/**
 * Target Carry / Target VAR cuts for the CCY modal.
 * Swap / Both: this name’s Total carry and Total CFaR (same as the chip).
 * Overlay fill: chips only — do not stamp portfolio X/Y onto an origin walk.
 * Never Policy VAR.
 */
export function modalCcyTicketTargets(input: {
  overlayFill: boolean;
  ticket?: Pick<CcyModalTicket, 'cfarUsdM' | 'carryUsdYrM'> | null;
}): {
  carryUsdYrM: number | null;
  cfarUsdM: number | null;
  pinVar: boolean;
} {
  if (input.overlayFill || !input.ticket) {
    return { carryUsdYrM: null, cfarUsdM: null, pinVar: false };
  }
  const carry = Number.isFinite(input.ticket.carryUsdYrM)
    ? input.ticket.carryUsdYrM
    : null;
  const cfar = Number.isFinite(input.ticket.cfarUsdM) && input.ticket.cfarUsdM > 1e-9
    ? input.ticket.cfarUsdM
    : null;
  return {
    carryUsdYrM: carry != null && Math.abs(carry) > 1e-9 ? carry : null,
    cfarUsdM: cfar,
    pinVar: cfar != null,
  };
}

function sameSignStanding(a: number, b: number): boolean {
  if (Math.abs(a) < 1e-6 || Math.abs(b) < 1e-6) return true;
  return Math.sign(a) === Math.sign(b);
}

function nearestStandingPoint(
  pts: readonly LiquidityFrontierPoint[],
  standing: number,
): LiquidityFrontierPoint | null {
  let best: LiquidityFrontierPoint | null = null;
  let bestD = Infinity;
  for (const p of pts) {
    const d = Math.abs(p.peakBook - standing);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * Land the live Book S vertex on this CCY’s table ticket (Total CFaR, Total
 * carry = Book + Overlay). Same standing walk — not a second overlay sweep.
 *
 * Approach samples with the book’s sign morph toward the ticket; origin stays
 * unhedged. Far arm gets overlay Y only (CIP shape stays).
 */
export function alignLeftEndToCcyTicket(
  left: LiquidityLeftEndResult,
  ticket: CcyModalTicket | null | undefined,
): LiquidityLeftEndResult {
  if (!ticket) return left;
  const bookS = ticket.bookStandingFcyM;
  if (!(Math.abs(bookS) > 0.01)) return left;
  const opens = left.upper.filter(p => p.delta < 1e-9);
  const atBook = nearestStandingPoint(opens, bookS);
  if (!atBook || !sameSignStanding(atBook.peakBook, bookS)) return left;
  if (Math.abs(atBook.peakBook - bookS) > Math.max(1, 0.2 * Math.abs(bookS))) {
    return left;
  }
  const dX = ticket.cfarUsdM - atBook.finalCfarUsdM;
  const dYOpen = ticket.carryUsdYrM - atBook.totalCarryUsdYrM;
  const dYFar = Number.isFinite(ticket.overlayUsdYrM) ? ticket.overlayUsdYrM : 0;
  if (Math.abs(dX) < 1e-6 && Math.abs(dYOpen) < 1e-6 && Math.abs(dYFar) < 1e-6) {
    return left;
  }
  const uOf = (standing: number): number => {
    if (!sameSignStanding(standing, bookS) || Math.abs(standing) < 1e-6) return 0;
    return Math.min(1, Math.abs(standing) / Math.abs(bookS));
  };
  const mapOpen = (p: LiquidityFrontierPoint): LiquidityFrontierPoint => {
    const u = uOf(p.peakBook);
    if (u < 1e-12) return p;
    return {
      ...p,
      finalCfarUsdM: Math.max(0, p.finalCfarUsdM + u * dX),
      totalCarryUsdYrM: p.totalCarryUsdYrM + u * dYOpen,
    };
  };
  const mapFar = (p: LiquidityFrontierPoint): LiquidityFrontierPoint => {
    const u = uOf(p.peakBook);
    if (u < 1e-12 || Math.abs(dYFar) < 1e-12) return p;
    return {
      ...p,
      totalCarryUsdYrM: p.totalCarryUsdYrM + u * dYFar,
    };
  };
  const upperRaw = left.upper.map(p => (p.delta < 1e-9 ? mapOpen(p) : p));
  const lowerRaw = left.lower.map(mapFar);
  const farTwinOf = (open: LiquidityFrontierPoint) =>
    lowerRaw.find(p => Math.abs(p.peakBook - open.peakBook) < 1e-4)
    ?? lowerRaw.find(p => Math.abs(p.multiple - open.multiple) < 1e-6);
  // Morph updates total Y/X. Restamp cash/CIP so the yellow d=0↔d=1 mix
  // interpolates the drawn Total and far dots — not pre-morph cash.
  const upper = upperRaw.map(p => {
    if (p.delta >= 1e-9) return p;
    const far = farTwinOf(p);
    if (!far) return p;
    return {
      ...p,
      cashCarryUsdYrM: p.totalCarryUsdYrM,
      cipUsdYrM: far.totalCarryUsdYrM - p.totalCarryUsdYrM,
    };
  });
  const lower = lowerRaw.map(p => {
    const open = upper.find(o => (
      o.delta < 1e-9 && Math.abs(o.peakBook - p.peakBook) < 1e-4
    ));
    if (!open) return p;
    return {
      ...p,
      cashCarryUsdYrM: open.totalCarryUsdYrM,
      cipUsdYrM: p.totalCarryUsdYrM - open.totalCarryUsdYrM,
    };
  });
  const points = left.points.map(p => {
    if (p.delta < 1e-9) {
      const mapped = mapOpen(p);
      const far = farTwinOf(mapped);
      if (!far) return mapped;
      return {
        ...mapped,
        cashCarryUsdYrM: mapped.totalCarryUsdYrM,
        cipUsdYrM: far.totalCarryUsdYrM - mapped.totalCarryUsdYrM,
      };
    }
    const mapped = mapFar(p);
    const open = upper.find(o => (
      o.delta < 1e-9 && Math.abs(o.peakBook - mapped.peakBook) < 1e-4
    ));
    if (!open) return mapped;
    return {
      ...mapped,
      cashCarryUsdYrM: open.totalCarryUsdYrM,
      cipUsdYrM: mapped.totalCarryUsdYrM - open.totalCarryUsdYrM,
    };
  });
  const openLine = upper.filter(p => p.delta < 1e-9);
  const stamped = nearestStandingPoint(openLine, bookS);
  const openHit = stamped
    ? {
        cfarUsdM: stamped.finalCfarUsdM,
        carryUsdYrM: stamped.totalCarryUsdYrM,
        standing: stamped.peakBook,
      }
    : left.constraint.openHit;
  const farAt = nearestStandingPoint(lower, bookS);
  const hedgeHit = farAt && sameSignStanding(farAt.peakBook, bookS)
    ? {
        cfarUsdM: farAt.finalCfarUsdM,
        carryUsdYrM: farAt.totalCarryUsdYrM,
        standing: farAt.peakBook,
      }
    : left.constraint.hedgeHit;
  return {
    ...left,
    upper,
    lower,
    points,
    curve: [left.origin, ...openLine],
    applied: openLine[openLine.length - 1] ?? left.applied,
    constraint: {
      ...left.constraint,
      openHit,
      hedgeHit,
    },
  };
}

/** Header: Book S is FCY, Book $ is USD. Never label FCY as $. */
export function bookStandingChipLabel(
  standingFcyM: number,
  standingUsdM: number,
): string {
  const fcy = `Book S ${standingFcyM.toFixed(1)} M`;
  if (!(Math.abs(standingUsdM) > 0.05)) return fcy;
  return `${fcy} · Book $${Math.abs(standingUsdM).toFixed(1)}M`;
}
