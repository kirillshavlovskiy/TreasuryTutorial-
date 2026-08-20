/**
 * Portfolio liquidity frontier — total carry vs diversified CFaR.
 *
 * Carry is additive in USD. CFaR is not: the desk CORR_MATRIX (same 14×14
 * used by computePortfolioVAR / portfolioDiv) folds per-CCY CFaR into one
 * quadratic form. Buffer layers size each CCY's book S; this module only
 * aggregates those books.
 */

import {
  CORR_CURRENCIES,
  CORR_MATRIX,
  POLICY_VAR_LIMITS,
  ccySpotRate,
  type PortfolioCarryFrontier,
  type RowState,
} from '@/lib/fx-buffer';
import {
  bookCashCarryK,
  isoSSliceAlphas,
  leftEndOriginPoint,
  priceIsoSSlice,
  priceLiquidityStanding,
  sectionCfarUsdM,
  signedPeakStanding,
  type LiquidityFrontierInput,
  type LiquidityFrontierPoint,
} from '@/lib/test-mode/liquidity-frontier';
import type {
  LiquidityStrategy,
  LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';

export type PortfolioFrontierEngine = Omit<
  LiquidityFrontierInput,
  'row' | 'strategy' | 'bookStanding' | 'carryUsdK'
>;

export interface DiversifiedUsdRiskLeg {
  ccy: string;
  /** Signed USD risk that entered the quadratic form. */
  usdM: number;
  /** Euler share of portfolioUsdM — the column sums to the diversified total. */
  componentUsdM: number;
}

export interface DiversifiedUsdRisk {
  portfolioUsdM: number;
  standaloneUsdM: number;
  divBenefitUsdM: number;
  divFactor: number;
  byCcy: DiversifiedUsdRiskLeg[];
}

export interface PortfolioFrontierPoint {
  scale: number;
  cover: number;
  arm: 'open' | 'far' | 'mix';
  carryUsdYrM: number;
  cfarUsdM: number;
  standaloneCfarUsdM: number;
  divFactor: number;
  levered: boolean;
}

export interface PortfolioLiquidityFrontier {
  origin: PortfolioFrontierPoint;
  open: PortfolioFrontierPoint[];
  far: PortfolioFrontierPoint[];
  mix: PortfolioFrontierPoint[];
  /** `overlay` = hold + s × Σ⁻¹μ legs; `book-scale` = common t on live S. */
  walk: 'overlay' | 'book-scale';
  /** Scale on the overlay walk at the live/earn sweet (1 = Policy VAR fill). */
  sweetScale: number;
  /**
   * Auto-detected knee on the open arm (scale ≥ 0, hold → cap → leverage) —
   * the point on the ACTUAL carry/CFaR curve farthest from a straight line
   * between its ends. Unlike `sweetScale` (which just echoes back wherever
   * Policy VAR / the carry ask already put the live book — see
   * buildEfficientCarryVarFrontier's degenerate Σ⁻¹μ ray, which has no
   * curvature to search), this arm genuinely bends: CFaR aggregation is not
   * scale-invariant, so there is a real optimum to find here. Null when the
   * arm has fewer than 3 finite points.
   */
  autoSweet: PortfolioFrontierPoint | null;
  book: {
    carryUsdYrM: number;
    sumCfarUsdM: number;
    portCfarUsdM: number;
    divFactor: number;
  };
}

/**
 * Point on `pts` farthest from the straight chord joining its first and last
 * point — the bend in the curve. Same method used for the portfolio carry/VAR
 * frontier (see `frontierKneeIndex` in fx-buffer.ts); duplicated here rather
 * than shared because the two operate on different point shapes and axes.
 */
function armKneeIndex(
  pts: readonly { cfarUsdM: number; carryUsdYrM: number }[],
): number {
  if (pts.length === 0) return -1;
  if (pts.length < 3) return pts.length - 1;
  const p0 = pts[0]!;
  const pN = pts[pts.length - 1]!;
  const dx = pN.cfarUsdM - p0.cfarUsdM;
  const dy = pN.carryUsdYrM - p0.carryUsdYrM;
  const norm = Math.hypot(dx, dy);
  if (norm < 1e-9) return 0;
  let bestIdx = 0;
  let bestDist = -Infinity;
  pts.forEach((p, i) => {
    const cross = (p.cfarUsdM - p0.cfarUsdM) * dy - (p.carryUsdYrM - p0.carryUsdYrM) * dx;
    const dist = Math.abs(cross) / norm;
    if (dist > bestDist) { bestDist = dist; bestIdx = i; }
  });
  return bestIdx;
}

/** Pairwise FX corr from the desk matrix; unknown names are uncorrelated. */
export function pairCorr(a: string, b: string): number {
  if (a === b) return 1;
  const i = CORR_CURRENCIES.indexOf(a);
  const j = CORR_CURRENCIES.indexOf(b);
  if (i < 0 || j < 0) return 0;
  return CORR_MATRIX[i]![j]!;
}

/**
 * √(v' ρ v) on signed USD risk. Same mechanics as computePortfolioVAR's
 * variance sum, but the vector is already in USD (CFaR), not z×vol(FCY).
 */
export function diversifiedUsdRisk(
  contribs: readonly { ccy: string; usdM: number }[],
): DiversifiedUsdRisk {
  const xs = contribs.filter(c => Number.isFinite(c.usdM) && Math.abs(c.usdM) > 1e-12);
  const standaloneUsdM = xs.reduce((s, c) => s + Math.abs(c.usdM), 0);
  if (xs.length === 0) {
    return {
      portfolioUsdM: 0,
      standaloneUsdM: 0,
      divBenefitUsdM: 0,
      divFactor: 1,
      byCcy: [],
    };
  }
  let variance = 0;
  const rhoV = xs.map(a => {
    let s = 0;
    for (const b of xs) s += pairCorr(a.ccy, b.ccy) * b.usdM;
    return s;
  });
  for (let i = 0; i < xs.length; i++) variance += xs[i]!.usdM * rhoV[i]!;
  const portfolioUsdM = Math.sqrt(Math.max(0, variance));
  const byCcy: DiversifiedUsdRiskLeg[] = xs.map((a, i) => ({
    ccy: a.ccy,
    usdM: a.usdM,
    componentUsdM: portfolioUsdM > 1e-12
      ? a.usdM * rhoV[i]! / portfolioUsdM
      : 0,
  }));
  return {
    portfolioUsdM,
    standaloneUsdM,
    divBenefitUsdM: standaloneUsdM - portfolioUsdM,
    divFactor: standaloneUsdM > 0 ? portfolioUsdM / standaloneUsdM : 1,
    byCcy,
  };
}

/**
 * Book CFaR ± overlay Euler, then √(v′ρv). Total is below Σ |v|
 * — that gap is the desk 14×14 diversification.
 */
export function regimePortfolioCfar(
  byCcy: readonly { ccy: string; cfarUsdM: number; standing: number }[],
  overlay?: readonly { ccy: string; componentVarUsdM: number }[],
  includeCcy?: (ccy: string) => boolean,
): DiversifiedUsdRisk {
  const overlayBy = new Map(
    (overlay ?? []).map(o => [o.ccy, o.componentVarUsdM] as const),
  );
  const seen = new Set<string>();
  const contribs: { ccy: string; usdM: number }[] = [];
  for (const c of byCcy) {
    if (includeCcy && !includeCcy(c.ccy)) continue;
    seen.add(c.ccy);
    contribs.push({
      ccy: c.ccy,
      usdM: signedCfarUsdM(c.cfarUsdM, c.standing) + (overlayBy.get(c.ccy) ?? 0),
    });
  }
  for (const o of overlay ?? []) {
    if (seen.has(o.ccy)) continue;
    if (includeCcy && !includeCcy(o.ccy)) continue;
    contribs.push({ ccy: o.ccy, usdM: o.componentVarUsdM });
  }
  return diversifiedUsdRisk(contribs);
}

/** Sign CFaR by standing so long/short books can offset in the quadratic form. */
export function signedCfarUsdM(cfarUsdM: number, standing: number): number {
  const mag = Math.abs(cfarUsdM);
  if (mag < 1e-12) return 0;
  if (Math.abs(standing) < 1e-9) return mag;
  return Math.sign(standing) * mag;
}

/**
 * Quadratic-form sign at a walk scale. t = 0 must keep the live book's
 * direction — treating |S|≈0 as unsigned fabricates the all-positive
 * CFaR-tab Unhedged the priced arms immediately leave.
 */
export function riskStanding(live: number, target: number): number {
  return Math.abs(target) >= 1e-9 ? target : live;
}

export function portfolioCfarSnapshot(
  byCcy: readonly { ccy: string; cfarUsdM: number; standing: number }[],
): DiversifiedUsdRisk {
  return diversifiedUsdRisk(
    byCcy.map(c => ({ ccy: c.ccy, usdM: signedCfarUsdM(c.cfarUsdM, c.standing) })),
  );
}

function aggregate(
  legs: readonly { ccy: string; standing: number; pt: LiquidityFrontierPoint }[],
  scale: number,
  cover: number,
  arm: PortfolioFrontierPoint['arm'],
): PortfolioFrontierPoint {
  const carryUsdYrM = legs.reduce((s, l) => s + l.pt.totalCarryUsdYrM, 0);
  const risk = diversifiedUsdRisk(
    legs.map(l => ({
      ccy: l.ccy,
      usdM: signedCfarUsdM(l.pt.finalCfarUsdM, l.standing),
    })),
  );
  return {
    scale,
    cover,
    arm,
    carryUsdYrM,
    cfarUsdM: risk.portfolioUsdM,
    standaloneCfarUsdM: risk.standaloneUsdM,
    divFactor: risk.divFactor,
    levered: legs.some(l => l.pt.levered) || scale > 1 + 1e-6,
  };
}

/**
 * Live S when overlay is omitted; hold + s×cap overlay when the Σ⁻¹μ legs
 * are known. `sweetT` is the earn/VAR fraction already in the live book
 * (1 = live is the Policy VAR fill). Hold = live − sweetT × cap.
 */
export function standingAtScale(
  live: number,
  scale: number,
  overlayFcy: number | undefined,
  sweetT = 1,
): number {
  if (overlayFcy == null || !Number.isFinite(overlayFcy) || Math.abs(overlayFcy) < 1e-9) {
    return scale * live;
  }
  const t = Number.isFinite(sweetT) ? Math.max(0, sweetT) : 1;
  const hold = live - t * overlayFcy;
  return hold + scale * overlayFcy;
}

/** Default upper scale (VAR-cap fill = 1) walked past the cap for a bit of leverage tail. */
const DEFAULT_MAX_SCALE_OVERLAY = 1.2;
const DEFAULT_MAX_SCALE_BOOK = 1.4;

function collectScales(overlayMode: boolean, sweetT = 1, maxScale?: number): number[] {
  const set = new Set<number>([0, 1]);
  const n = overlayMode ? 48 : 36;
  for (let i = 1; i <= n; i++) set.add(i / n);
  if (overlayMode) {
    set.add(-1);
    for (let i = 1; i <= 16; i++) set.add(-i / 16);
    const cap = Math.max(DEFAULT_MAX_SCALE_OVERLAY, maxScale ?? DEFAULT_MAX_SCALE_OVERLAY);
    for (let i = 1; i <= 12; i++) set.add(1 + (cap - 1) * (i / 12));
    if (Number.isFinite(sweetT) && sweetT > 1e-6 && sweetT < cap) set.add(sweetT);
  } else {
    const cap = Math.max(DEFAULT_MAX_SCALE_BOOK, maxScale ?? DEFAULT_MAX_SCALE_BOOK);
    for (let i = 1; i <= 12; i++) set.add(1 + (cap - 1) * (i / 12));
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Overlay plot scale: −1 = unfunded origin, 0 = hold, 1 = Policy VAR cap.
 * Negative scales walk each book from 0 → hold so green and rose meet at origin.
 */
export function overlayStandingAtPlotScale(
  live: number,
  scale: number,
  overlayFcy: number | undefined,
  sweetT = 1,
): number {
  if (scale < 0) {
    const hold = standingAtScale(live, 0, overlayFcy, sweetT);
    const u = Math.min(1, Math.max(0, 1 + scale));
    return u * hold;
  }
  return standingAtScale(live, scale, overlayFcy, sweetT);
}

function mixAlphas(
  slices: readonly {
    open: LiquidityFrontierPoint;
    far: LiquidityFrontierPoint;
    section: number;
  }[],
): number[] {
  const alphas = new Set<number>([0, 1]);
  for (let i = 1; i < 24; i++) alphas.add(i / 24);
  for (const sl of slices) {
    for (const a of isoSSliceAlphas(sl.open, sl.far, sl.section, 32)) alphas.add(a);
  }
  return [...alphas].sort((a, b) => a - b);
}

export function buildPortfolioLiquidityFrontier(input: {
  result: LiquidityStrategyResult;
  strategy: LiquidityStrategy;
  rows: readonly RowState[];
  engine: PortfolioFrontierEngine;
  /**
   * Overlay FCY at the Policy VAR fill (H* − hold) per CCY from
   * `allocateCarryVarUsd` cap legs. When set, the arms walk that mix
   * (hold → VAR cap → slight leverage), not a common scale of the live books.
   */
  overlayFcyByCcy?: Readonly<Record<string, number>>;
  /**
   * Fraction of the cap overlay already in the live book (earn ask / VAR fill).
   * Default 1 — live is the cap. The sweet marker sits at this scale.
   */
  overlaySweetT?: number;
}): PortfolioLiquidityFrontier {
  const overlayMap = input.overlayFcyByCcy;
  const overlayMode = overlayMap != null && Object.keys(overlayMap).length > 0;
  const sweetT = overlayMode && Number.isFinite(input.overlaySweetT)
    ? Math.max(0, input.overlaySweetT!)
    : 1;
  const rowByCcy = new Map(input.rows.map(r => [r.ccy, r] as const));
  // Rows are the ticked universe. Unticked names must not keep their
  // section CFaR in the quadratic form or Conservative/Balanced/Max Carry
  // stay on the old multi-ccy curve.
  const books = input.result.byCcy.filter(c => rowByCcy.has(c.ccy)).map(c => {
    const row = rowByCcy.get(c.ccy);
    const standing = signedPeakStanding(c.plan);
    const overlayFcy = overlayMap?.[c.ccy];
    const sectionUsdM = sectionCfarUsdM(input.engine.cfarNetByCcyUsd, c.ccy);
    const bookCashK = row
      ? bookCashCarryK(
          standing,
          ccySpotRate(row.ccy),
          row.r_FCY,
          input.engine.shared.r_USD,
          row.r_OD,
        )
      : 0;
    return {
      ccy: c.ccy,
      standing,
      overlayFcy,
      cfarUsdM: c.cfarUsdM,
      sectionUsdM,
      row,
      bookCashK,
    };
  });

  const originLegs = books.map(b => ({
    ccy: b.ccy,
    standing: riskStanding(b.standing, 0),
    pt: leftEndOriginPoint(b.sectionUsdM),
  }));
  // Unhedged X is the CFaR-tab All CCY Net — Σ of per-name Nets, same
  // headline as the CFaR tab. Do not RSS / diversify that pin; the tab
  // does not.
  const tabNetUsdM = books.reduce((s, b) => s + Math.max(0, b.sectionUsdM), 0);
  const origin = {
    ...aggregate(originLegs, 0, 0, 'open'),
    cfarUsdM: tabNetUsdM,
    standaloneCfarUsdM: tabNetUsdM,
    divFactor: 1,
  };

  const priceAt = (
    b: (typeof books)[number],
    target: number,
  ): { open: LiquidityFrontierPoint; far: LiquidityFrontierPoint } => {
    if (!b.row || Math.abs(target) < 1e-6) {
      const originPt = leftEndOriginPoint(b.sectionUsdM);
      return { open: originPt, far: originPt };
    }
    const priced = priceLiquidityStanding(
      { ...input.engine, row: b.row },
      target,
      b.bookCashK,
    );
    return { open: priced.open, far: priced.far };
  };

  const buildArms = (maxScale: number) => {
    const scales = collectScales(overlayMode, sweetT, maxScale);
    const armOpen: PortfolioFrontierPoint[] = [];
    const armFar: PortfolioFrontierPoint[] = [];
    for (const scale of scales) {
      const priced = books.map(b => {
        const target = overlayMode
          ? overlayStandingAtPlotScale(b.standing, scale, b.overlayFcy, sweetT)
          : standingAtScale(b.standing, scale, b.overlayFcy, sweetT);
        const pair = priceAt(b, target);
        return { ccy: b.ccy, standing: riskStanding(b.standing, target), target, pair };
      });
      const openPt = aggregate(
        priced.map(l => ({ ccy: l.ccy, standing: l.standing, pt: l.pair.open })),
        scale, 0, 'open',
      );
      const farPt = aggregate(
        priced.map(l => ({ ccy: l.ccy, standing: l.standing, pt: l.pair.far })),
        scale, 1, 'far',
      );
      if (priced.every(l => Math.abs(l.target) < 1e-6)) {
        armOpen.push({
          ...openPt,
          cfarUsdM: tabNetUsdM,
          standaloneCfarUsdM: tabNetUsdM,
          divFactor: 1,
        });
        armFar.push({
          ...farPt,
          cfarUsdM: tabNetUsdM,
          standaloneCfarUsdM: tabNetUsdM,
          divFactor: 1,
        });
      } else {
        armOpen.push(openPt);
        armFar.push(farPt);
      }
    }
    return { armOpen, armFar };
  };

  const defaultMaxScale = overlayMode ? DEFAULT_MAX_SCALE_OVERLAY : DEFAULT_MAX_SCALE_BOOK;
  const policyMaxUsd = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  let openScale = defaultMaxScale;
  const { armOpen: open0, armFar: far0 } = buildArms(openScale);
  let open = open0;
  // Book-scale only: open arm must reach the top policy rung ($20M) so
  // Max Carry is a CFaR-fill. Overlay scale 1 is already the VAR cap.
  const hardCeilingScale = defaultMaxScale * 12;
  const openCfarHi = (arm: readonly PortfolioFrontierPoint[]) =>
    Math.max(0, ...arm.map(p => p.cfarUsdM).filter(Number.isFinite));
  if (!overlayMode) {
    for (let i = 0; i < 6 && openScale < hardCeilingScale; i++) {
      if (openCfarHi(open) >= policyMaxUsd - 1e-6) break;
      openScale = Math.min(hardCeilingScale, openScale * 1.8);
      open = buildArms(openScale).armOpen;
    }
  }
  // Far-arm CIP chase is independent — do not reuse that scale for green.
  let far = far0;
  let farScale = defaultMaxScale;
  for (let i = 0; i < 5 && farScale < hardCeilingScale; i++) {
    const tail = [...far]
      .filter(p => p.scale > 1 - 1e-6 && Number.isFinite(p.carryUsdYrM))
      .sort((a, b) => a.scale - b.scale);
    if (tail.length < 2) break;
    const crossed = tail.some((p, idx) => (
      idx > 0 && p.carryUsdYrM <= 0 && tail[idx - 1]!.carryUsdYrM > 0
    ));
    if (crossed) break;
    const last = tail[tail.length - 1]!;
    const prev = tail[tail.length - 2]!;
    if (!(last.carryUsdYrM < prev.carryUsdYrM)) break;
    farScale = Math.min(hardCeilingScale, farScale * 1.8);
    far = buildArms(farScale).armFar;
  }

  const mix: PortfolioFrontierPoint[] = [];
  const liveTwins = books.map(b => {
    const priced = priceAt(b, b.standing);
    return {
      ccy: b.ccy,
      standing: b.standing,
      open: priced.open,
      far: priced.far,
      section: b.sectionUsdM,
    };
  });
  if (liveTwins.length > 0 && liveTwins.some(b => Math.abs(b.standing) >= 0.01)) {
    for (const cover of mixAlphas(liveTwins)) {
      const legs = liveTwins.map(b => ({
        ccy: b.ccy,
        standing: b.standing,
        pt: priceIsoSSlice(b.open, b.far, b.section, cover),
      }));
      mix.push(aggregate(legs, sweetT, cover, 'mix'));
    }
  }

  const snapshot = portfolioCfarSnapshot(
    books.map(b => ({ ccy: b.ccy, cfarUsdM: b.cfarUsdM, standing: b.standing })),
  );
  const bookCarry = input.result.byCcy.reduce(
    (s, c) => s + c.cashCarryUsdYrM + c.hedgeCarryUsdYrM
      + c.swapInterestUsdYrM + c.swapPointsUsdYrM,
    0,
  );

  // Book-scale Balanced is the knee PAST Conservative (t ≥ 1). The RSS bow
  // of the funding approach (t < 1) is not Balanced — that put Conservative
  // between Balanced and Max Carry.
  const kneeMinScale = overlayMode ? -1e-6 : 1 - 1e-6;
  const openForKnee = open
    .filter(p => (
      p.scale >= kneeMinScale
      && Number.isFinite(p.cfarUsdM)
      && Number.isFinite(p.carryUsdYrM)
    ))
    .sort((a, b) => a.scale - b.scale);
  const kneeIdx = armKneeIndex(openForKnee);
  const autoSweet = kneeIdx >= 0 ? (openForKnee[kneeIdx] ?? null) : null;

  return {
    origin,
    open,
    far,
    mix,
    walk: overlayMode ? 'overlay' : 'book-scale',
    sweetScale: overlayMode ? sweetT : 1,
    autoSweet,
    book: {
      carryUsdYrM: bookCarry,
      sumCfarUsdM: snapshot.standaloneUsdM,
      portCfarUsdM: snapshot.portfolioUsdM,
      divFactor: snapshot.divFactor,
    },
  };
}

/**
 * Same standing walk as the per-currency left-end: S(t) = t × S_book.
 * Conservative is t = 1 on that arm — not a second pricer after a kink.
 * Origin is the CFaR-tab All CCY Net (Σ of Nets) at $0 carry — both
 * arms leave that vertex. Not the cover-sizing FX-only leftover.
 */
export function toPortfolioCarryFrontier(
  liq: PortfolioLiquidityFrontier,
): PortfolioCarryFrontier {
  const origin = {
    k: 0,
    portfolioVarUsd: liq.origin.cfarUsdM,
    totalCarryUsdYr: 0,
    floorBoundCcys: [] as string[],
  };
  const toPt = (p: PortfolioFrontierPoint) => ({
    k: p.scale,
    portfolioVarUsd: p.cfarUsdM,
    totalCarryUsdYr: p.carryUsdYrM,
    floorBoundCcys: [] as string[],
    levered: p.levered,
  });
  const originX = origin.portfolioVarUsd;
  const opens = [...liq.open]
    .filter(p => (
      p.scale > 1e-9
      && Number.isFinite(p.cfarUsdM)
      && p.cfarUsdM >= originX - 1e-6
    ))
    .sort((a, b) => a.scale - b.scale)
    .map(toPt);
  const fars = [...liq.far]
    .filter(p => (
      p.scale > 1e-9
      && Number.isFinite(p.cfarUsdM)
      && p.cfarUsdM >= originX - 1e-6
    ))
    .sort((a, b) => a.scale - b.scale)
    .map(toPt);
  const points = [origin, ...opens];
  const farPoints = [origin, ...fars];
  const sweetScale = liq.autoSweet?.scale;
  const sweetSpotIndex = sweetScale != null
    ? points.findIndex(p => Math.abs(p.k - sweetScale) < 1e-9)
    : -1;
  return {
    points,
    farPoints,
    sweetSpotIndex,
    nearestClampCcy: null,
    nearestClampVarUsd: liq.autoSweet?.cfarUsdM ?? null,
    walk: 'book-scale',
  };
}

