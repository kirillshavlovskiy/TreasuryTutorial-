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
  CURRENCY_PARAMS,
  POLICY_VAR_LIMITS,
  ccySpotRate,
  frontierTangencyIndex,
  type PortfolioCarryFrontier,
  type RowState,
} from '@/lib/fx-buffer';
import {
  VAR_Z_BY_CONFIDENCE,
  isVarConfidencePct,
  zForConfidence,
} from '@/lib/test-mode/var-confidence';
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

const SQRT_21 = Math.sqrt(21);

/** Overlay FCY (H* − hold) + Swap Near. Not Swap Book / far outstanding. */
export function overlayPlusNearFcyM(overlayFcyM: number, swapNearFcyM: number): number {
  const a = Number.isFinite(overlayFcyM) ? overlayFcyM : 0;
  const b = Number.isFinite(swapNearFcyM) ? swapNearFcyM : 0;
  return a + b;
}

/**
 * FX CFaR of a FCY position — vol × z × |S| × spot, not the notional.
 * 1-month σ = σ_daily × √21; horizon scales √months from that.
 */
export function fxPositionCfarUsdM(
  fcyM: number,
  ccy: string,
  confidencePct: number,
  horizonMonths = 1,
): number {
  if (!Number.isFinite(fcyM) || Math.abs(fcyM) < 1e-12) return 0;
  const spot = ccySpotRate(ccy);
  const sigmaDaily = CURRENCY_PARAMS[ccy]?.σ_daily ?? 0;
  const z = isVarConfidencePct(confidencePct)
    ? zForConfidence(confidencePct)
    : VAR_Z_BY_CONFIDENCE[95];
  const months = Number.isFinite(horizonMonths) && horizonMonths > 0 ? horizonMonths : 1;
  const vol = sigmaDaily * SQRT_21 * Math.sqrt(months) * z;
  return Math.sign(fcyM) * Math.abs(fcyM) * Math.max(0, spot) * vol;
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

/** Swap/overlay add on top of the FX-hedge basis — peel the section. */
function swapProgramCfarUsdM(pricedUsdM: number, sectionUsdM: number): number {
  const priced = Math.max(0, pricedUsdM);
  const section = Math.max(0, sectionUsdM);
  return Math.sqrt(Math.max(0, priced * priced - section * section));
}

function rssBasisCfarUsdM(basisUsdM: number, addUsdM: number): number {
  const basis = Math.max(0, basisUsdM);
  const add = Math.max(0, addUsdM);
  if (add < 1e-12) return basis;
  return Math.hypot(basis, add);
}

function aggregate(
  legs: readonly {
    ccy: string;
    standing: number;
    sectionUsdM: number;
    pt: LiquidityFrontierPoint;
  }[],
  scale: number,
  cover: number,
  arm: PortfolioFrontierPoint['arm'],
  basisUsdM: number,
): PortfolioFrontierPoint {
  const carryUsdYrM = legs.reduce((s, l) => s + l.pt.totalCarryUsdYrM, 0);
  const risk = diversifiedUsdRisk(
    legs.map(l => ({
      ccy: l.ccy,
      usdM: signedCfarUsdM(
        swapProgramCfarUsdM(l.pt.finalCfarUsdM, l.sectionUsdM),
        l.standing,
      ),
    })),
  );
  return {
    scale,
    cover,
    arm,
    carryUsdYrM,
    cfarUsdM: rssBasisCfarUsdM(basisUsdM, risk.portfolioUsdM),
    standaloneCfarUsdM: rssBasisCfarUsdM(basisUsdM, risk.standaloneUsdM),
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
  for (const t of [0.01, 0.02, 0.04, 0.06, 0.08]) set.add(t);
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
    sectionUsdM: b.sectionUsdM,
    pt: leftEndOriginPoint(b.sectionUsdM),
  }));
  // Unhedged X is the CFaR-tab All CCY Net — FX-hedge basis before any
  // swap programme or overlay. Do not RSS / diversify that pin; the tab
  // does not.
  const tabNetUsdM = books.reduce((s, b) => s + Math.max(0, b.sectionUsdM), 0);
  const origin = {
    ...aggregate(originLegs, 0, 0, 'open', tabNetUsdM),
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
        return {
          ccy: b.ccy,
          standing: riskStanding(b.standing, target),
          target,
          pair,
          sectionUsdM: b.sectionUsdM,
        };
      });
      const openPt = aggregate(
        priced.map(l => ({
          ccy: l.ccy,
          standing: l.standing,
          sectionUsdM: l.sectionUsdM,
          pt: l.pair.open,
        })),
        scale, 0, 'open', tabNetUsdM,
      );
      const farPt = aggregate(
        priced.map(l => ({
          ccy: l.ccy,
          standing: l.standing,
          sectionUsdM: l.sectionUsdM,
          pt: l.pair.far,
        })),
        scale, 1, 'far', tabNetUsdM,
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
        sectionUsdM: b.section,
        pt: priceIsoSSlice(b.open, b.far, b.section, cover),
      }));
      mix.push(aggregate(legs, sweetT, cover, 'mix', tabNetUsdM));
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

export function priceBooksAtScale(input: {
  result: LiquidityStrategyResult;
  rows: readonly RowState[];
  engine: PortfolioFrontierEngine;
  /** Overlay walk: 0 = hold, 1 = Policy VAR cap. Book-scale: 0 = origin, 1 = hold. */
  scale: number;
  overlayFcyByCcy?: Readonly<Record<string, number>>;
  overlaySweetT?: number;
}): { ccy: string; cfarUsdM: number; standing: number; sectionUsdM: number; carryUsdYrM: number }[] {
  const rowByCcy = new Map(input.rows.map(r => [r.ccy, r] as const));
  const seen = new Set<string>();
  const books: { ccy: string; standing: number; sectionUsdM: number; row?: RowState; bookCashK: number }[] = [];
  for (const c of input.result.byCcy) {
    const row = rowByCcy.get(c.ccy);
    if (!row) continue;
    seen.add(c.ccy);
    const standing = signedPeakStanding(c.plan);
    books.push({
      ccy: c.ccy,
      standing,
      sectionUsdM: sectionCfarUsdM(input.engine.cfarNetByCcyUsd, c.ccy),
      row,
      bookCashK: bookCashCarryK(
        standing,
        ccySpotRate(row.ccy),
        row.r_FCY,
        input.engine.shared.r_USD,
        row.r_OD,
      ),
    });
  }
  for (const row of input.rows) {
    if (row.ccy === 'USD' || seen.has(row.ccy)) continue;
    books.push({
      ccy: row.ccy,
      standing: 0,
      sectionUsdM: sectionCfarUsdM(input.engine.cfarNetByCcyUsd, row.ccy),
      row,
      bookCashK: 0,
    });
  }
  const t = Number.isFinite(input.scale) ? input.scale : 0;
  const overlayMap = input.overlayFcyByCcy;
  const sweetT = Number.isFinite(input.overlaySweetT) ? input.overlaySweetT! : 1;
  return books.map(b => {
    const overlayFcy = overlayMap?.[b.ccy];
    const target = overlayFcy != null
      ? overlayStandingAtPlotScale(b.standing, t, overlayFcy, sweetT)
      : t * b.standing;
    if (!b.row || Math.abs(target) < 1e-6) {
      return {
        ccy: b.ccy,
        cfarUsdM: Math.max(0, b.sectionUsdM),
        standing: riskStanding(b.standing, target),
        sectionUsdM: b.sectionUsdM,
        carryUsdYrM: 0,
      };
    }
    const priced = priceLiquidityStanding(
      { ...input.engine, row: b.row },
      target,
      b.bookCashK,
    );
    return {
      ccy: b.ccy,
      cfarUsdM: priced.open.finalCfarUsdM,
      standing: target,
      sectionUsdM: b.sectionUsdM,
      carryUsdYrM: priced.open.totalCarryUsdYrM,
    };
  });
}

/**
 * Per-CCY Euler split of the selected plot CFaR (Unhedged / Conservative /
 * Balanced / custom). Basis is the CFaR-tab Net; incrementals are the
 * priced standing at `books` plus overlay Euler. Components sum to
 * `headlineUsdM` (the plot X), so GBP with overlay is no longer a dash.
 */
export function splitPlotCfarByCcy(input: {
  books: readonly { ccy: string; cfarUsdM: number; standing: number; sectionUsdM: number }[];
  tabNetByCcyUsd: Record<string, number>;
  overlay?: readonly { ccy: string; componentVarUsdM: number }[];
  headlineUsdM: number;
  includeCcy?: (ccy: string) => boolean;
}): DiversifiedUsdRisk {
  const overlayBy = new Map(
    (input.overlay ?? []).map(o => [o.ccy, o.componentVarUsdM] as const),
  );
  const seen = new Set<string>();
  const contribs: { ccy: string; usdM: number }[] = [];
  const basisBy = new Map<string, number>();
  const addBasis = (ccy: string, v: number) => {
    if (ccy === 'USD' || !Number.isFinite(v) || v <= 0) return;
    basisBy.set(ccy, (basisBy.get(ccy) ?? 0) + v);
  };
  for (const b of input.books) {
    seen.add(b.ccy);
    addBasis(b.ccy, input.tabNetByCcyUsd[b.ccy] ?? b.sectionUsdM);
    const overlay = (input.includeCcy && !input.includeCcy(b.ccy))
      ? 0
      : (overlayBy.get(b.ccy) ?? 0);
    contribs.push({
      ccy: b.ccy,
      usdM: signedCfarUsdM(
        swapProgramCfarUsdM(b.cfarUsdM, b.sectionUsdM),
        b.standing,
      ) + overlay,
    });
  }
  for (const [ccy, v] of Object.entries(input.tabNetByCcyUsd)) {
    if (seen.has(ccy)) continue;
    seen.add(ccy);
    addBasis(ccy, v);
    const overlay = (input.includeCcy && !input.includeCcy(ccy))
      ? 0
      : (overlayBy.get(ccy) ?? 0);
    contribs.push({ ccy, usdM: overlay });
  }
  for (const o of input.overlay ?? []) {
    if (seen.has(o.ccy)) continue;
    if (input.includeCcy && !input.includeCcy(o.ccy)) continue;
    seen.add(o.ccy);
    contribs.push({ ccy: o.ccy, usdM: o.componentVarUsdM });
  }
  const inc = diversifiedUsdRisk(contribs);
  const headline = Math.max(0, input.headlineUsdM);
  const B = [...basisBy.values()].reduce((s, v) => s + v, 0);
  const P = inc.portfolioUsdM;
  const denom = B * B + P * P;
  const eBy = new Map(inc.byCcy.map(c => [c.ccy, c.componentUsdM] as const));
  const names = new Set([
    ...basisBy.keys(),
    ...eBy.keys(),
    ...input.books.map(b => b.ccy),
    ...Object.keys(input.tabNetByCcyUsd).filter(c => c !== 'USD'),
  ]);
  const byCcy: DiversifiedUsdRiskLeg[] = [...names].map(ccy => {
    const b = basisBy.get(ccy) ?? 0;
    const e = eBy.get(ccy) ?? 0;
    const usdM = contribs.find(c => c.ccy === ccy)?.usdM ?? b;
    const componentUsdM = denom > 1e-18
      ? (b * B + e * P) / denom * headline
      : 0;
    return { ccy, usdM, componentUsdM };
  });
  const standaloneUsdM = byCcy.reduce((s, c) => s + Math.abs(c.usdM), 0);
  return {
    portfolioUsdM: headline,
    standaloneUsdM: standaloneUsdM > 0 ? standaloneUsdM : headline,
    divBenefitUsdM: Math.max(0, (standaloneUsdM > 0 ? standaloneUsdM : headline) - headline),
    divFactor: standaloneUsdM > 1e-12 ? headline / standaloneUsdM : 1,
    byCcy,
  };
}

/**
 * Regime table CFaR — same numbers as the carry/CFaR plot.
 * Unfunded = Unhedged pin (CFaR-tab All CCY Net Σ).
 * Funded = open arm at t = 1 (Conservative). Not cover-sizing leftovers
 * and not overlay Euler.
 */
export function priceRegimeChartCfar(input: {
  result: LiquidityStrategyResult;
  strategy: LiquidityStrategy;
  rows: readonly RowState[];
  engine: PortfolioFrontierEngine;
}): { sumUsdM: number; portUsdM: number } {
  if (input.result.strategy.id === 'unfunded') {
    const tab = input.rows.reduce(
      (s, r) => s + Math.max(0, sectionCfarUsdM(input.engine.cfarNetByCcyUsd, r.ccy)),
      0,
    );
    return { sumUsdM: tab, portUsdM: tab };
  }
  const liq = buildPortfolioLiquidityFrontier(input);
  const hold = liq.open.find(p => Math.abs(p.scale - 1) < 1e-6) ?? liq.origin;
  return {
    sumUsdM: hold.standaloneCfarUsdM,
    portUsdM: hold.cfarUsdM,
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
      (liq.walk === 'overlay' ? p.scale >= -1 - 1e-9 : p.scale > 1e-9)
      && Number.isFinite(p.cfarUsdM)
      && p.cfarUsdM >= originX - 1e-6
    ))
    .sort((a, b) => a.scale - b.scale)
    .map(toPt);
  const fars = [...liq.far]
    .filter(p => (
      (liq.walk === 'overlay' ? p.scale >= -1 - 1e-9 : p.scale > 1e-9)
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
    walk: liq.walk,
    // Same tangency definition as the Σ⁻¹μ overlay walk — argmax
    // (carry−originCarry)/(CFaR−originCfar) is parameterization-agnostic,
    // it works on any (k, CFaR, carry) point set. Origin is `origin` itself
    // (the pinned Unhedged CFaR, carry $0) — NOT literal (0,0): the
    // achievable domain here starts at the Unhedged CFaR floor, often deep
    // in six figures, so a ray from true zero would cut under the whole
    // curve. No golden-section refinement here (this walk's points are
    // already priced at fixed, meaningful scales — S(t) fractions/multiples
    // of the book — not an arbitrary sampling grid to interpolate between).
    tangencyIndex: frontierTangencyIndex(points, origin.portfolioVarUsd, origin.totalCarryUsdYr),
  };
}

