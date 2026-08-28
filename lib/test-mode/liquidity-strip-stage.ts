/**
 * Liquidity Book → staged FX package.
 *
 * Residual Δ is the frontier slider (1 = open, 0 = far). CIP on the funding
 * strip stays on the far share (1−Δ). The open share is an FX strip the desk
 * can Stage / Send like any other hedge — it must not write swapNear into
 * the unfunded liquidity path.
 */

import { bothSidesPayVsUsd, CURRENCY_PARAMS, ccySpotRate } from '@/lib/fx-buffer';
import { clampHedgeDelta, type SwapForwardOverlay } from '@/lib/fx-hedge';
import {
  resolveMarketRatesForCcy,
  resolveOvernightCashRates,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { assignImpliedCarryFromSwapPoints } from '@/lib/test-mode/cash-carry-analytics';
import type { PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import { signedPeakStanding } from '@/lib/test-mode/liquidity-frontier';
import type { LiquiditySwapLegRow } from '@/lib/test-mode/liquidity-strategies';

const RESIDUAL_STAGE_EPS = 1e-6;
const NOTIONAL_DUST = 0.001;

export type FundingStripStageLeg = Pick<
  LiquiditySwapLegRow,
  | 'cycleIndex'
  | 'valueDateMonths'
  | 'newLeg'
  | 'outstanding'
  | 'settleMonths'
  | 'preBookable'
>;

export function scaleFundingScheduleToBook<
  T extends { newLeg: number; rolledForward: number; outstanding: number },
>(
  schedule: readonly T[],
  targetPeakFcyM: number | undefined,
): T[] {
  if (
    typeof targetPeakFcyM !== 'number'
    || !Number.isFinite(targetPeakFcyM)
    || Math.abs(targetPeakFcyM) < 1e-9
    || schedule.length === 0
  ) return [...schedule];
  const basePeak = signedPeakStanding(
    schedule.map(l => ({ standing_swap: l.outstanding })),
  );
  if (Math.abs(basePeak) < 1e-9) return [...schedule];
  const f = targetPeakFcyM / basePeak;
  if (!Number.isFinite(f) || Math.abs(f - 1) < 1e-6) return [...schedule];
  return schedule.map(l => ({
    ...l,
    newLeg: l.newLeg * f,
    rolledForward: l.rolledForward * f,
    outstanding: l.outstanding * f,
  }));
}

export type StandingStripMode = 'rolling' | 'term' | 'stripTerm';

/**
 * A carry standing of `bookFcyM` held OPEN — this is the carry position, so
 * there is NO back-conversion leg. `outstanding` stays flat at `bookFcyM`
 * (not an oscillation that time-averages to ~0). Hedging is the Δ residual,
 * not a leg here.
 *
 * - `term`      — one forward: sell the book, value-dated at the term maturity.
 * - `rolling`   — roll the near leg each month (1M). Roll size is constant
 *                 because the position is.
 * - `stripTerm` — forward strip: value-dated each month, all settling at the
 *                 shared term maturity, building monotonically to `book`.
 *                 `shapeWeights` (e.g. per-month funding activity) tilt the
 *                 slice sizes; omitted → equal `book / T` slices. Weights are
 *                 taken as magnitudes so the strip never flips sign or
 *                 overshoots `book`.
 */
export function buildStandingStripToTerm(
  bookFcyM: number,
  termMonths: number,
  mode: StandingStripMode = 'term',
  shapeWeights?: readonly number[],
): LiquiditySwapLegRow[] {
  const T = Math.max(1, Math.floor(termMonths));
  if (!Number.isFinite(bookFcyM) || Math.abs(bookFcyM) < NOTIONAL_DUST) return [];
  const priced = {
    fcyOnUsdYr: 0, usdOnUsdYr: 0, pointsUsdYr: 0, midPoints: null,
    interestUsdYr: 0, netUsdYr: 0,
  } as const;
  const near = (over: Partial<LiquiditySwapLegRow>): LiquiditySwapLegRow => ({
    ...priced, hasPoints: true,
    cycleIndex: 0, valueDateMonths: 0, newLeg: bookFcyM,
    rolledForward: 0, outstanding: bookFcyM, preBookable: false, settleMonths: T,
    ...over,
  });

  if (mode === 'rolling' && !shapeWeights) {
    // No funding-need shape → a flat Book S standing rolled 1M each cycle.
    return Array.from({ length: T }, (_, i) => near({
      cycleIndex: i, valueDateMonths: i,
      rolledForward: i === 0 ? 0 : bookFcyM,
      preBookable: i > 0, settleMonths: 1,
    }));
  }

  if (mode === 'rolling' || mode === 'stripTerm') {
    // Monotone build to Book S, per-cycle slice tilted by the funding-need
    // shape. Same accumulation for both regimes — they differ only in tenor:
    // strip-to-term settles every leg at the shared maturity (T − i);
    // rolling rolls 1M.
    const w = Array.from({ length: T }, (_, i) => {
      const raw = shapeWeights?.[i];
      return typeof raw === 'number' && Number.isFinite(raw) ? Math.abs(raw) : 0;
    });
    const wSum = w.reduce((s, v) => s + v, 0);
    const frac = wSum > NOTIONAL_DUST
      ? w.map(v => v / wSum)
      : Array.from({ length: T }, () => 1 / T);
    let cum = 0;
    return Array.from({ length: T }, (_, i) => {
      const slice = bookFcyM * frac[i]!;
      const prev = cum;
      cum += slice;
      return near({
        cycleIndex: i, valueDateMonths: i, newLeg: slice,
        rolledForward: prev, outstanding: cum,
        preBookable: i > 0,
        settleMonths: mode === 'rolling' ? 1 : T - i,
      });
    });
  }

  return [near({})];
}

/**
 * Both fill funding strip. Overlay (H* − hold) stays off this ledger — it
 * books on the first spot line in the UI.
 *
 * Keep the operating legs (the real monthly funding profile) and add a FLAT
 * carry standing for the excess (`Book S − operating peak`), shaped by the
 * regime (term / rolling / strip-to-term). Scaling the operating oscillation
 * instead would time-average to ~0 and earn no rate-differential carry.
 */
export function bothBookScheduleFor(
  operating: readonly LiquiditySwapLegRow[],
  bookFcyM: number | undefined,
  bookingMode: StandingStripMode,
): LiquiditySwapLegRow[] {
  if (
    typeof bookFcyM !== 'number' || !Number.isFinite(bookFcyM)
    || operating.length === 0
  ) return [...operating];
  const opPeak = signedPeakStanding(
    operating.map(l => ({ standing_swap: l.outstanding })),
  );
  const carryAdd = bookFcyM - opPeak;
  // Nothing to add (or the scenario book is smaller / opposite the operating
  // book — the operating programme already covers it).
  if (Math.abs(carryAdd) < NOTIONAL_DUST || carryAdd * bookFcyM < 0) {
    return [...operating];
  }
  const term = Math.max(...operating.map(l => l.valueDateMonths)) + 1;
  const carry = buildStandingStripToTerm(carryAdd, term, bookingMode);
  const byCycle = new Map<number, LiquiditySwapLegRow>(
    operating.map(l => [l.cycleIndex, { ...l }]),
  );
  for (const s of carry) {
    const ex = byCycle.get(s.cycleIndex);
    byCycle.set(s.cycleIndex, ex
      ? {
        ...ex,
        newLeg: ex.newLeg + s.newLeg,
        rolledForward: ex.rolledForward + s.rolledForward,
        outstanding: ex.outstanding + s.outstanding,
      }
      : s);
  }
  return [...byCycle.values()].sort((a, b) => a.cycleIndex - b.cycleIndex);
}

/**
 * The strip Book / Near / Far stages and renders.
 * - Overlay fill: operating legs only (funding strip stays off the overlay table).
 * - Swap fill (`rolling` and `strip-to-term`): a strip that builds
 *   MONOTONICALLY to Book S, with the per-month slice tilted by the operating
 *   schedule's funding activity (|newLeg|). Keeps a real month-to-month shape
 *   without amplifying the operating oscillation or flipping sign. The two
 *   regimes differ only in tenor (rolling rolls 1M; strip-to-term settles
 *   every leg at the shared maturity). `term` fill is a single bullet.
 *   Falls back to a flat Book S standing when there is no usable operating
 *   schedule.
 * - Both: operating legs + a flat carry standing for Book S − operating peak.
 */
export function scenarioFundingScheduleFor(
  operating: readonly LiquiditySwapLegRow[],
  bookFcyM: number | undefined,
  fillMode: 'swap' | 'overlay' | 'both' | undefined,
  bookingMode: StandingStripMode,
): LiquiditySwapLegRow[] {
  if (fillMode === 'overlay') return [...operating];
  if (fillMode === 'swap') {
    const hasBook = typeof bookFcyM === 'number' && Number.isFinite(bookFcyM);
    const term = operating.length === 0
      ? 1
      : Math.max(...operating.map(l => l.valueDateMonths)) + 1;
    const shapeWeights = bookingMode !== 'term' && operating.length > 1
      ? alignWeightsToTerm(operating, term)
      : undefined;
    const standing = hasBook
      ? buildStandingStripToTerm(bookFcyM!, term, bookingMode, shapeWeights)
      : [];
    return standing.length > 0 ? standing : [...operating];
  }
  return bothBookScheduleFor(operating, bookFcyM, bookingMode);
}

/** Per-cycle |newLeg| of the operating strip, indexed 0..T−1 (0 where absent). */
function alignWeightsToTerm(
  operating: readonly LiquiditySwapLegRow[],
  term: number,
): number[] {
  const w = Array.from({ length: Math.max(1, term) }, () => 0);
  for (const l of operating) {
    const i = Math.round(l.valueDateMonths);
    if (i >= 0 && i < w.length) w[i] += Math.abs(l.newLeg);
  }
  return w;
}

/**
 * Notional FCY on a strip line — a CONTRACT/TRADE-level figure, not the
 * accrued book. That is the size dealt on this line:
 * - strip-to-term / term — `newLeg` (each forward slice; equal slices read
 *   flat by design — the building position is the Book column, not this one)
 * - rolling — `outstanding` (each roll re-deals the whole standing)
 * The accrued running book (`outstanding`) belongs in the Book S / Book $
 * column; never conflate the two.
 */
export function stripDisplayedSwapFcyM(
  leg: Pick<FundingStripStageLeg, 'newLeg' | 'outstanding'>,
  bookingMode: StandingStripMode | undefined,
): number {
  return bookingMode === 'rolling' ? leg.outstanding : leg.newLeg;
}

function finiteOrZero(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Hedge-table header / first-spot Notional FCY.
 *
 * Overlay Mix (H* − hold) only — the same signed number as Sweet Overlay FCY.
 * Never add Book S: Overlay −47.43 + Book S +79.36 = +31.93 hides a short
 * EUR overlay behind a long “total hedge”.
 */
export function hedgeOverlayNotionalFcyM(overlayFcyM: number | undefined): number {
  return finiteOrZero(overlayFcyM);
}

/** Overlay USD on the hedge table — Mix $ , not Overlay $ + Book $. */
export function hedgeOverlayNotionalUsdM(overlayUsdM: number | undefined): number {
  return finiteOrZero(overlayUsdM);
}

/**
 * Nested-leg Notional FCY. Overlay books on the first spot as its own
 * signed notional; later legs show the funding-swap contract size
 * (`stripDisplayedSwapFcyM`). Overlay is never netted into the swap figure.
 */
export function hedgeLegNotionalFcyM(input: {
  overlayFcyM: number | undefined;
  swapFcyM: number;
  overlayOnThisLeg: boolean;
}): number {
  if (input.overlayOnThisLeg) return hedgeOverlayNotionalFcyM(input.overlayFcyM);
  return finiteOrZero(input.swapFcyM);
}

export function hedgeLegNotionalUsdM(input: {
  overlayUsdM: number | undefined;
  swapFcyM: number;
  spot: number;
  overlayOnThisLeg: boolean;
}): number {
  if (input.overlayOnThisLeg) return hedgeOverlayNotionalUsdM(input.overlayUsdM);
  const swap = finiteOrZero(input.swapFcyM);
  const spot = input.spot > 1e-12 ? input.spot : 1;
  return swap * spot;
}

/**
 * Overlay Euler CFaR on the hedge table — keep the diversifier sign.
 * Sweet Overlay CFaR −$35K must not print as unsigned $35K.
 */
export function hedgeOverlayCfarUsdM(overlayCfarUsdM: number | undefined): number {
  return finiteOrZero(overlayCfarUsdM);
}

/**
 * Book-table Schedule cell for one funding-swap leg.
 *
 * `valueDateMonths` is the near (months from today); `settleMonths` is the
 * remaining tenor, so far = near + tenor. Spot 1M stays `M1`. Longer windows
 * are `0M-12M` / `1M-12M` — never `12M far`.
 */
export function fundingSwapTenorLabel(
  leg: Pick<FundingStripStageLeg, 'valueDateMonths' | 'settleMonths'>,
): string {
  const start = Math.max(0, leg.valueDateMonths);
  const tenor = Math.max(0, leg.settleMonths);
  if (tenor > 1) return `${start}M-${start + tenor}M`;
  return `M${start + 1}`;
}

/** Peak signed Swap Book on a funding strip — matches Book S after scaling. */
export function peakFundingSwapBookM(
  schedule: readonly Pick<FundingStripStageLeg, 'outstanding'>[],
): number {
  return signedPeakStanding(
    schedule.map(l => ({ standing_swap: l.outstanding })),
  );
}

/**
 * Overlay that only sets Δ so CIP retention/CFaR-bridge scaling read right.
 * No extra FX forward.
 *
 * `residual` here is the frontier's own convention (1 = open/nothing
 * hedged, 0 = far/fully hedged — see the module comment). SwapForwardOverlay
 * .delta is the OPPOSITE convention everywhere else it's read
 * (allocateSwapForwardOverlay: "replacement fraction moved to forward",
 * Δ=1 = fully hedged — see retainedFundingPlanByCcy's own test, which
 * expects (1-Δ) retained under THAT convention). Passing residual straight
 * through as delta silently inverted CIP retention and the CFaR bridge for
 * every chart-picked residual: a fully open (residual=1) position read as
 * fully hedged (delta=1), retaining ZERO of its real risk instead of all
 * of it. Invert once, here, at the one point a frontier residual becomes a
 * SwapForwardOverlay — every downstream reader of .delta already assumes
 * the hedge-coverage convention and must not be touched.
 */
export function overlayDeltaStub(residual: number): SwapForwardOverlay {
  const delta = 1 - clampHedgeDelta(residual);
  return {
    delta,
    exposureLocalM: 0,
    swapNearLocalM: 0,
    swapStandingLocalM: 0,
    forwardLocalM: 0,
    remainingFarLocalM: 0,
    residualNearLocalM: 0,
    finalNetLocalM: 0,
  };
}

/** Desk overlays, with modeled residual Δ replacing any CCY the book has picked. */
export function mergeResidualOverlays(
  desk: Readonly<Record<string, SwapForwardOverlay>> | undefined,
  residualByCcy: Readonly<Record<string, number>>,
): Record<string, SwapForwardOverlay> {
  const next: Record<string, SwapForwardOverlay> = { ...(desk ?? {}) };
  for (const [ccy, residual] of Object.entries(residualByCcy)) {
    next[ccy] = overlayDeltaStub(residual);
  }
  return next;
}

export function residualNeedsFxStage(residual: number): boolean {
  return clampHedgeDelta(residual) > RESIDUAL_STAGE_EPS;
}

/** Stage all may fill an empty CCY or replace a liquidity package — never Carry / Decision. */
export function canLiquidityStageReplace(
  existing: PreparedHedgeProfile | undefined,
): boolean {
  if (!existing) return true;
  return existing.preparedFor === 'liquidity';
}

/** Own Δ if modeled, else the last frontier / mix Δ (Stage all). */
export function residualForStage(
  ccy: string,
  residualByCcy: Readonly<Record<string, number>>,
  lastMixResidual?: number | null,
): number | undefined {
  const own = residualByCcy[ccy];
  if (typeof own === 'number' && Number.isFinite(own)) return own;
  if (typeof lastMixResidual === 'number' && Number.isFinite(lastMixResidual)) {
    return lastMixResidual;
  }
  return undefined;
}

/**
 * One FX bullet for the OPEN residual of a funding programme.
 * Δ = 0 (far) → null. Δ > 0 → Σ newLeg × Δ as a single forward at Tf.
 * The dated swap ledger stays on Liquidity — not copied into hedge legs.
 */
export function fundingStripPreparedProfile(input: {
  ccy: string;
  schedule: readonly FundingStripStageLeg[];
  residual: number;
  forecastMonths: number;
  marketRates?: FxMarketRatesBundle | null;
  ratesScopeId?: string | null;
}): PreparedHedgeProfile | null {
  const residual = clampHedgeDelta(input.residual);
  if (residual < RESIDUAL_STAGE_EPS) return null;

  const trades = input.schedule.filter(
    l => Math.abs(l.newLeg) > NOTIONAL_DUST && l.settleMonths > 0,
  );
  if (trades.length === 0) return null;

  const bundle = input.marketRates
    ?? resolveMarketRatesForCcy(undefined, input.ccy, input.ratesScopeId);
  const p = CURRENCY_PARAMS[input.ccy];
  const r_USD = resolveOvernightCashRates(bundle, input.ccy).usd.creditPct;
  const sellPayFar = Boolean(
    p
    && bothSidesPayVsUsd(ccySpotRate(input.ccy), p.carry, r_USD, p.r_OD),
  );

  const months = Math.max(1, Math.floor(input.forecastMonths));
  // FX book gets ONE bullet for the open residual = Δ × the peak standing
  // book, not Σ leg notionals. A monthly-roll standing re-trades the same
  // book every cycle — summing legs would over-cover T×. For a monotonic
  // build-up strip the peak equals Σ newLeg, so this is unchanged there.
  const peakBook = peakFundingSwapBookM(input.schedule);
  const coverLocalM = residual * (sellPayFar ? Math.abs(peakBook) : peakBook);
  const bulletSettle = trades.length === 1
    ? Math.max(1, trades[0]!.settleMonths)
    : months;

  const raw: PreparedHedgeProfile = {
    structure: 'bullet',
    basis: 'cash',
    ticketBasis: 'stock',
    legs: [],
    coverLocalM,
    hedgeRatio: residual,
    settleMonths: bulletSettle,
    cashDeliveryAt: 'periodEnd',
    preparedFor: 'liquidity',
  };

  if (Math.abs(raw.coverLocalM) < NOTIONAL_DUST) return null;

  return {
    ...assignImpliedCarryFromSwapPoints(raw, {
      marketRates: bundle,
      bulletSettleMonths: bulletSettle,
      ccy: input.ccy,
    }),
    preparedFor: 'liquidity',
  };
}
