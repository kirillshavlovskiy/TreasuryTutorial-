/**
 * Liquidity efficient frontier from the left end.
 *
 * 1. Step cash carry in the direction the book can actually print
 *    (+$K when either side earns vs USD; −$K when both sides pay, e.g. PLN).
 *    Invert the standing S that prints that cash — that is the exposure.
 * 2. CFaR X depends on whether the far is on (desk Δ = 0 → far on):
 *    no far  — FX σ revaluation of |S| held to the far date (open cash).
 *    far on  — rate-diff unwind: settle the locked far early via a swap
 *              to raise USD vs K. Not a second spot mark of S.
 * 3. Two carry outcomes at that S:
 *    open (cover 0) — incomplete hedge. Y = cash Δr (can be negative).
 *    far  (cover 1) — complete far-leg hedge. Y = cash + swap points.
 */

import { fundedPlanFor } from '@/lib/dashboard-model';
import {
  clampHedgeDelta,
  fwdHedgeCarryFromMarketUsd,
  type SwapForwardOverlay,
} from '@/lib/fx-hedge';
import type { ForecastProfileState, LiquidityCycleProjection } from '@/lib/forecast-profile';
import {
  fundingSwapPathFarCipUsdM,
  resolveMarketRatesForCcy,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { computeCfarBands } from '@/lib/test-mode/cfar-drawdown';
import { fundingSwapKnotsFromOutstanding } from '@/lib/test-mode/cfar-funding-swap';
import { rateVolBpYrFor } from '@/lib/test-mode/cfar-residual';
import {
  displayedCfarUsdMFromFxNet,
  fxHedgeMcCfarByCcy,
} from '@/lib/test-mode/cfar-net-by-ccy';
import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import type { HedgeTicket, PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import {
  resolveBufferConstraint,
  type LiquidityStrategy,
} from '@/lib/test-mode/liquidity-strategies';
import { monthlyVolForSetup, type VarSetup } from '@/lib/test-mode/var-setup';
import {
  ccySpotRate,
  fundingSwapCarryLegs,
  fundingSwapCashDeltaUsdYr,
  fundingSwapCipPointsUsdYr,
  fundingSwapFarSettleMonths,
  fundingSwapMonthCarryUsdM,
  fxBookNetLocalM,
  roundMoney,
  swapFarLegNotional,
  usdToFcyM,
  type LayerId,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import {
  buildLiquidityLadder,
  carrySplitFromBalances,
  type HedgeSettleByCcy,
} from '@/lib/liquidity-ladder';

export type LiquidityFrontierDial = 'carry_target' | 'cash_floor' | 'var_target';
export type LiquidityFrontierWalk = 'delta' | 'swap_size' | 'carry_pair';
export type LiquidityFrontierPhase = 'unfunded' | 'hedged' | 'overhedged' | 'inverse';

export function liquidityFrontierDial(
  active: Set<LayerId> | undefined,
): LiquidityFrontierDial {
  const constraint = resolveBufferConstraint(active);
  if (constraint === 'carry') return 'carry_target';
  if (constraint === 'var') return 'var_target';
  return 'cash_floor';
}

export function liquidityFrontierWalkMode(
  active: Set<LayerId> | undefined,
): LiquidityFrontierWalk {
  return liquidityFrontierDial(active) === 'cash_floor' ? 'delta' : 'swap_size';
}

export function liquidityFrontierDialLabel(dial: LiquidityFrontierDial): string {
  if (dial === 'carry_target') return 'Target Carry';
  if (dial === 'var_target') return 'Target VAR';
  return 'Min floor';
}

/**
 * Sweet-spot S on open: the Target Carry / Target VAR gold ring, not the
 * origin. Min floor has no cut, so the walk stays at carry $0.
 */
export function snapFrontierStandKey(
  dial: LiquidityFrontierDial,
  hit: { standing: number } | null,
  twins: readonly { key: string; standing: number }[],
): string {
  if (dial === 'cash_floor' || !hit || Math.abs(hit.standing) < 1e-6) return 'origin';
  let bestKey = 'origin';
  let bestD = Infinity;
  for (const t of twins) {
    if (t.key === 'origin' || Math.abs(t.standing) < 1e-6) continue;
    const d = Math.abs(t.standing - hit.standing);
    if (d < bestD) {
      bestD = d;
      bestKey = t.key;
    }
  }
  return bestKey;
}

export interface LiquidityFrontierPoint {
  /** Swap+Fwd replacement — shifts the carry curve vs VAR. */
  delta: number;
  /**
   * Hedge multiple on the live cover book.
   * 0 = unfunded, 1 = fully hedged, >1 = overhedged, <0 = inverse.
   */
  multiple: number;
  phase: LiquidityFrontierPhase;
  /** Sort key: unfunded, then long hedge, then deeper inverse. */
  intensity: number;
  /** Floor and Target LP Cash move together on the walk. */
  bufferM: number;
  carryM: number;
  cashCarryUsdYrM: number;
  swapCashUsdYrM: number;
  cipUsdYrM: number;
  hedgeCarryUsdYrM: number;
  /**
   * One carry metric: cash + swap cash Δr + hedge.
   * CIP is the points offset — it is not this curve. Including it flattens
   * the walk (cover looks carry-neutral).
   */
  totalCarryUsdYrM: number;
  finalCfarUsdM: number;
  peakBook: number;
  /** Beyond the live book — dashed leverage tail. */
  levered: boolean;
}

export interface LiquidityFrontierInput {
  row: RowState;
  strategy: LiquidityStrategy;
  months: number;
  shared: SharedGlobals;
  activeLayers?: Set<LayerId>;
  forecastProfile?: ForecastProfileState | null;
  hedgeSettleByCcy?: HedgeSettleByCcy;
  cfarNetByCcyUsd?: Record<string, number>;
  setup?: VarSetup;
  bookedHedges?: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  ratesScopeId?: string;
  swapForwardOverlayByCcy?: Readonly<Record<string, SwapForwardOverlay>>;
  /** How many long-side steps besides 0 and 1. Default 2. */
  steps?: number;
  deltas?: readonly number[];
  /** Override hedge multiples (0 = unfunded, 1 = cover, <0 = inverse). */
  multiples?: readonly number[];
  /** Floor steps for the Δ = 0 left-end walk. */
  floors?: readonly number[];
  /** Positive cash-carry steps in $K (default: dense near 0, then book / ask / tail). */
  carryUsdK?: readonly number[];
  /** Live swap standing (M FCY) — solid book; cash steps past this are dashed. */
  bookStanding?: number;
}

export interface LiquidityFrontierResult {
  dial: LiquidityFrontierDial;
  points: LiquidityFrontierPoint[];
  skyline: LiquidityFrontierPoint[];
  applied: LiquidityFrontierPoint | null;
  best: LiquidityFrontierPoint | null;
  /** Unfunded (or inverse) point where carry and CFaR grow together. */
  riskEnd: LiquidityFrontierPoint | null;
  /** FX-only Net CFaR from the CFaR section — zero-carry axis starts here. */
  cfarOriginUsdM: number;
  degenerate: boolean;
}

const DEFAULT_STEPS = 2;
const DEFAULT_DELTAS = [0, 0.25, 0.5, 0.75, 1] as const;

function coverFcy(ccy: string, netByCcy?: Record<string, number>): number {
  const usd = netByCcy?.[ccy];
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0.001) return 0;
  return usdToFcyM(usd, ccy);
}

function liveCarryAsk(row: RowState): number {
  return typeof row.carry_target === 'number' && Number.isFinite(row.carry_target)
    ? row.carry_target
    : row.cash;
}

function phaseOf(k: number): LiquidityFrontierPhase {
  if (Math.abs(k) < 1e-9) return 'unfunded';
  if (k < 0) return 'inverse';
  if (k > 1 + 1e-9) return 'overhedged';
  return 'hedged';
}

/** Unfunded first, then long hedge rising, then inverse going deeper. */
export function hedgeIntensity(k: number): number {
  if (Math.abs(k) < 1e-9) return 0;
  if (k > 0) return k;
  return 10 - k;
}

/** Unfunded → cover → overhedge, then inverse. Inverse is the PAY-ccy positive tail. */
export const FRONTIER_WALK_MULTIPLES = [0, 0.5, 1, 1.5, 2, -0.5, -1, -2] as const;

const DEFAULT_MULTIPLES = FRONTIER_WALK_MULTIPLES;

export function hedgeMultiples(steps: number): number[] {
  if (steps <= 2) return [...DEFAULT_MULTIPLES];
  const n = Math.max(1, steps);
  const out: number[] = [0, 1, -1];
  for (let i = 1; i <= n; i += 1) {
    out.push(i / n);
    out.push(1 + i / n);
  }
  const seen = new Set<string>();
  return out
    .map(roundMoney)
    .filter(k => {
      const key = k.toFixed(4);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => hedgeIntensity(a) - hedgeIntensity(b));
}

function scalePlan(
  plan: readonly LiquidityCycleProjection[],
  k: number,
): LiquidityCycleProjection[] {
  if (Math.abs(k) < 1e-9 || plan.length === 0) return [];
  return plan.map(p => ({
    ...p,
    swap_needed: p.swap_needed * k,
    standing_swap: p.standing_swap * k,
    incremental_swap: p.incremental_swap * k,
    far_leg: (p.far_leg ?? 0) * k,
  }));
}

/** Cumulative Buffer Carry (cash Δr, no CIP) through each forecast month. */
function bufferCarryScheduleUsdM(
  plan: readonly { standing_swap: number }[],
  months: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD: number,
): number[] {
  if (plan.length === 0 || months <= 0) return [];
  let cum = 0;
  return Array.from({ length: months }, (_, i) => {
    const standing = plan[Math.min(i, plan.length - 1)]!.standing_swap;
    cum += fundingSwapMonthCarryUsdM(
      standing, spot, r_FCY, r_USD, r_OD, 'cashDelta',
    );
    return cum;
  });
}

function unfundedCashCarryUsdYr(
  ladder: ReturnType<typeof buildLiquidityLadder>,
  spot: number,
  r_FCY: number,
  r_OD: number,
  r_USD: number,
): number {
  let creditSum = 0;
  let debitSum = 0;
  let days = 0;
  for (const cycle of ladder.cycles) {
    const slice = ladder.closingByDay.slice(cycle.startDay, cycle.endDay + 1);
    const split = carrySplitFromBalances(slice, 0);
    creditSum += split.avgCredit * slice.length;
    debitSum += split.avgDebit * slice.length;
    days += slice.length;
  }
  if (days <= 0) return 0;
  const avgCredit = creditSum / days;
  const avgDebit = debitSum / days;
  return (avgCredit * (r_FCY - r_USD) + avgDebit * (r_OD - r_USD)) / 100 * spot;
}

function buildCoverPlan(
  row: RowState,
  strategy: LiquidityStrategy,
  input: LiquidityFrontierInput,
  layers: Set<LayerId>,
): LiquidityCycleProjection[] {
  if (strategy.regime === null) return [];
  const months = Math.floor(input.months);
  const ladder = buildLiquidityLadder(row, input.forecastProfile, {
    months,
    opening: row.cash,
    floor: row.cash_floor,
    hedgeSettle: input.hedgeSettleByCcy?.[row.ccy],
  });
  return fundedPlanFor(
    row,
    input.shared,
    layers,
    ladder,
    input.forecastProfile,
    input.hedgeSettleByCcy?.[row.ccy],
    undefined,
    strategy.regime.bookingMode,
    coverFcy(row.ccy, input.cfarNetByCcyUsd),
  );
}

/**
 * Δ on this chart is residual risk: 0 = book flattened (low VAR, left),
 * 1 = book left open (high VAR, right). That is the positive-carry tail.
 *
 * `delta` (the parameter) is this chart convention throughout — every field
 * below (forwardLocalM, remainingFarLocalM, etc.) is computed from it and
 * stays exactly as-is; that's the real notional math the chart renders and
 * it is correct. But the RETURNED `delta:` field feeds fxHedgeMcCfarByCcy
 * → displayedCfarNetByCcyUsdM → retainedFundingPlanByCcy, which is proven
 * (see its own test) to expect the OPPOSITE hedge-coverage convention
 * (Δ=1 = fully hedged). Storing `residual` there directly made a
 * fully-open chart point (nothing hedged) read as fully hedged downstream,
 * retaining ZERO of its real funding-swap CFaR bridge instead of all of
 * it. Invert only that one stored field — see overlayDeltaStub's matching
 * fix for the chart's residual-picker path.
 */
function overlayFor(
  row: RowState,
  plan: readonly LiquidityCycleProjection[],
  delta: number,
): SwapForwardOverlay {
  const dust = (v: number) => (Math.abs(v) < 0.005 ? 0 : v);
  const residual = clampHedgeDelta(delta);
  const E = fxBookNetLocalM(row);
  const S = plan[0]?.swap_needed ?? 0;
  const standing = plan.reduce(
    (best, p) => (Math.abs(p.standing_swap) > Math.abs(best) ? p.standing_swap : best),
    0,
  );
  const net = E + S;
  return {
    delta: 1 - residual,
    exposureLocalM: E,
    swapNearLocalM: S,
    swapStandingLocalM: standing,
    forwardLocalM: dust(-(1 - residual) * net),
    remainingFarLocalM: dust(-residual * S),
    residualNearLocalM: dust(residual * S),
    finalNetLocalM: dust(residual * net),
  };
}

function pricePoint(
  row: RowState,
  strategy: LiquidityStrategy,
  input: LiquidityFrontierInput,
  delta: number,
  multiple: number,
  coverPlan: readonly LiquidityCycleProjection[],
  fxByCcy: ReturnType<typeof fxHedgeMcCfarByCcy>,
  buffer?: { floor: number; carry: number },
): LiquidityFrontierPoint {
  const plan = scalePlan(coverPlan, multiple);
  const liveH = Math.max(row.cash_floor, liveCarryAsk(row));
  const level = roundMoney(multiple * Math.max(liveH, 1));
  const trial = {
    ...row,
    cash_floor: Math.max(0, buffer?.floor ?? level),
    carry_target: buffer?.carry ?? level,
  };
  const months = Math.floor(input.months);
  const ladder = buildLiquidityLadder(trial, input.forecastProfile, {
    months,
    opening: trial.cash,
    floor: trial.cash_floor,
    hedgeSettle: input.hedgeSettleByCcy?.[trial.ccy],
  });
  const overlay = overlayFor(trial, plan, delta);
  const spot = ccySpotRate(trial.ccy);
  const cashCarryUsdYrM = unfundedCashCarryUsdYr(
    ladder, spot, trial.r_FCY, trial.r_OD, input.shared.r_USD,
  );
  const legs = fundingSwapCarryLegs({
    ccy: trial.ccy,
    plan,
    r_FCY: trial.r_FCY,
    r_USD: input.shared.r_USD,
    r_OD: trial.r_OD,
    forecastMonths: input.shared.forecastMonths ?? input.months,
  });
  const standingFallback = swapFarLegNotional(plan, plan[0]?.swap_needed ?? 0);
  const cipUsdYrM = plan.length === 0
    ? 0
    : fundingSwapPathFarCipUsdM({
        plan,
        standingFallback,
        forecastMonths: input.shared.forecastMonths ?? input.months,
        bundle: resolveMarketRatesForCcy(
          input.marketRatesByCcy, trial.ccy, input.ratesScopeId,
        ),
        fallbackAnnualUsdYr: S =>
          fundingSwapCipPointsUsdYr(S, spot, trial.r_FCY, input.shared.r_USD),
      });
  const settleMonths = strategy.regime?.bookingMode === 'term'
    ? fundingSwapFarSettleMonths(plan, input.shared.forecastMonths ?? input.months)
    : Math.max(1, input.shared.forecastMonths ?? input.months);
  const hedgeCarryUsdYrM = fwdHedgeCarryFromMarketUsd(
    overlay.forwardLocalM,
    trial.ccy,
    trial.r_FCY,
    input.shared.r_USD,
    settleMonths,
    resolveMarketRatesForCcy(input.marketRatesByCcy, trial.ccy, input.ratesScopeId),
  );
  const swapCashUsdYrM = legs.cashUsdM;
  const totalCarryUsdYrM = roundMoney(
    cashCarryUsdYrM + swapCashUsdYrM + hedgeCarryUsdYrM,
  );
  const peakBook = plan.reduce((best, p) => (
    Math.abs(p.standing_swap) > Math.abs(best) ? p.standing_swap : best
  ), 0);
  const fxNet = fxByCcy[trial.ccy]?.netCriticalCashUsdM
    ?? sectionCfarUsdM(input.cfarNetByCcyUsd, trial.ccy);
  const horizon = input.setup
    ? (input.setup.forecastMonths > 0
      ? input.setup.forecastMonths
      : months)
    : months;
  const finalCfarUsdM = input.setup
    ? displayedCfarUsdMFromFxNet(
        fxNet,
        trial.ccy,
        plan,
        input.setup,
        bufferCarryScheduleUsdM(
          plan, horizon, spot, trial.r_FCY, input.shared.r_USD, trial.r_OD,
        ),
      )
    : fxNet;

  return {
    delta,
    multiple: roundMoney(multiple),
    phase: phaseOf(multiple),
    intensity: hedgeIntensity(multiple),
    bufferM: trial.cash_floor,
    carryM: trial.carry_target,
    cashCarryUsdYrM: roundMoney(cashCarryUsdYrM),
    swapCashUsdYrM: roundMoney(swapCashUsdYrM),
    cipUsdYrM: roundMoney(cipUsdYrM),
    hedgeCarryUsdYrM: roundMoney(hedgeCarryUsdYrM),
    totalCarryUsdYrM,
    finalCfarUsdM,
    peakBook: roundMoney(peakBook),
    levered: false,
  };
}

function groupByDelta(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[][] {
  const by = new Map<string, LiquidityFrontierPoint[]>();
  for (const p of points) {
    const k = p.delta.toFixed(4);
    const arr = by.get(k) ?? [];
    arr.push(p);
    by.set(k, arr);
  }
  return [...by.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, arr]) => arr);
}

const POSITIVE_CARRY = 1e-9;

export function sectionCfarUsdM(
  cfarNetByCcyUsd: Record<string, number> | undefined,
  ccy: string,
): number {
  const v = cfarNetByCcyUsd?.[ccy];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return v;
}

/**
 * Upper tail: CFaR from Δ → 1 at a fixed book (unfunded, else inverse).
 * Positive carry only — not a buffer walk.
 */
export function liquidityFrontierUpperTail(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[] {
  const pick = (pred: (p: LiquidityFrontierPoint) => boolean) =>
    points
      .filter(p => pred(p) && p.totalCarryUsdYrM > POSITIVE_CARRY)
      .sort((a, b) => a.delta - b.delta || a.finalCfarUsdM - b.finalCfarUsdM);
  const unfunded = pick(p => Math.abs(p.multiple) < 1e-9);
  if (unfunded.length >= 1) return unfunded;
  return pick(p => p.multiple < -1e-9);
}

/**
 * Bottom band: Δ = 0, buffer allocation +/−. Not a mirror of the upper tail.
 */
export function liquidityFrontierBufferBand(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[] {
  return points
    .filter(p => Math.abs(p.delta) < 1e-9)
    .sort((a, b) => a.multiple - b.multiple);
}

export const LEFT_END_DELTAS = [0, 0.25, 0.5, 0.75, 1] as const;
/** Unhedged (Δ = 1) swap-size steps for Target Carry / Target VAR. */
export const SWAP_SIZE_MULTIPLES = [0, 0.25, 0.5, 0.75, 1, 1.5, 2] as const;
/** Positive cash-carry grid ($K). Each step sizes S; CFaR is S to the far settle. */
export const CARRY_STEP_USD_K = [1, 2, 3, 5, 8, 12, 18, 25] as const;
/** Sub-$1K through a few $K — the RSS knee next to origin / section CFaR. */
export const FRONTIER_NEAR_ORIGIN_K = [0.25, 0.5, 0.75, 1, 1.5, 2, 3] as const;
/** Kept for callers that still want the old 1–25 linear left set. */
export const FRONTIER_STEEP_K = [1, 2, 3, 5, 8, 12, 18, 25] as const;
/** Incomplete hedge: forward < cash-settled near. 1 = far leg on. */
export const HEDGE_COVERS = [0, 1] as const;
/** Samples along one iso-S Δ slice (open → far). Not a third family of arms. */
export const ISO_S_SLICE_STEPS = 96;

/** Stride for an explicit cash-carry walk — $10K only while the cap is small. */
export function carryStepStrideK(maxK: number): number {
  const cap = Math.max(10, Number.isFinite(maxK) ? maxK : 100);
  if (cap <= 80) return 10;
  if (cap <= 200) return 20;
  if (cap <= 500) return 50;
  if (cap <= 1500) return 100;
  return 250;
}

/** Cash-carry grid up to `maxK` ($K). Stride grows with the cap so a $1,000k ask is not 100 dots. */
export function carryStepsToMaxK(maxK: number): number[] {
  const cap = Math.max(10, Math.round(Number.isFinite(maxK) ? maxK : 100));
  const step = carryStepStrideK(cap);
  const out: number[] = [];
  for (let k = step; k <= cap + 1e-9; k += step) out.push(roundCarryK(k));
  if (out.length === 0 || Math.abs(out[out.length - 1]! - cap) > 0.05) out.push(roundCarryK(cap));
  return out;
}

function roundCarryK(k: number): number {
  if (k < 2) return Math.round(k * 20) / 20;
  return Math.round(k * 10) / 10;
}

/**
 * Cash-carry $K dots: geometric from the origin so the green/red polylines
 * are not a handful of long chords. Dense next to 0 carry / section CFaR
 * (RSS knee), then log-spaced out to the book and any leverage cap.
 */
export function frontierCarryDotsK(
  bookCashK: number,
  opts?: { targetCashK?: number; tail?: boolean; maxK?: number },
): number[] {
  const book = Number.isFinite(bookCashK) && bookCashK > 0.5
    ? roundCarryK(bookCashK)
    : 0;
  const rawTarget = opts?.targetCashK;
  const target = typeof rawTarget === 'number' && Number.isFinite(rawTarget) && rawTarget > 0.5
    ? roundCarryK(rawTarget)
    : 0;
  const focus = Math.max(book, target);
  const asked = opts?.maxK;
  const askedCap = typeof asked === 'number' && Number.isFinite(asked) && asked > 0.5
    ? roundCarryK(asked)
    : 0;
  let cap = focus > 0.5 ? focus : 50;
  if (opts?.tail && askedCap > cap + 0.5) cap = askedCap;
  else if (opts?.tail && focus > 0.5) cap = Math.max(focus * 2, focus + 40);
  const out = new Set<number>();
  for (const k of FRONTIER_NEAR_ORIGIN_K) {
    if (k < cap - 0.05) out.add(k);
  }
  const start = 4;
  const restBudget = 22;
  if (start < cap - 0.5) {
    const ratio = Math.max(1.16, (cap / start) ** (1 / restBudget));
    let k = start;
    for (let i = 0; i < restBudget; i += 1) {
      if (k >= cap - 0.25) break;
      out.add(roundCarryK(k));
      k *= ratio;
    }
  }
  if (book > 0.5 && book < cap + 0.05) out.add(book);
  if (target > 0.5 && target < cap + 0.05) out.add(target);
  out.add(roundCarryK(cap));
  return [...out].filter(k => k > 0.2).sort((a, b) => a - b);
}

/** Peak signed standing on a funding-swap strip. */
export function signedPeakStanding(
  plan: readonly { standing_swap: number }[] | undefined,
): number {
  if (!plan || plan.length === 0) return 0;
  return plan.reduce(
    (best, p) => (Math.abs(p.standing_swap) > Math.abs(best) ? p.standing_swap : best),
    0,
  );
}

/** Open-book cash carry of `standing`, in $K. */
export function bookCashCarryK(
  standing: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
): number {
  if (!Number.isFinite(standing) || Math.abs(standing) < 1e-6) return 0;
  return Math.abs(fundingSwapCashDeltaUsdYr(standing, spot, r_FCY, r_USD, r_OD)) * 1000;
}

/** Standing S (M FCY) that prints `cashUsdYr` on the cash-Δr book. */
export function standingFromCashCarryUsdYr(
  cashUsdYr: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
): number {
  if (!Number.isFinite(cashUsdYr) || Math.abs(cashUsdYr) < 1e-12) return 0;
  const perLong = fundingSwapCashDeltaUsdYr(1, spot, r_FCY, r_USD, r_OD);
  const perShort = fundingSwapCashDeltaUsdYr(-1, spot, r_FCY, r_USD, r_OD);
  if (cashUsdYr > 0) {
    if (perLong > 1e-12) return cashUsdYr / perLong;
    if (perShort > 1e-12) return -cashUsdYr / perShort;
    return 0;
  }
  if (perLong < -1e-12) return cashUsdYr / perLong;
  if (perShort < -1e-12) return -cashUsdYr / perShort;
  return 0;
}

/**
 * Sign of the earn-side invert. +1 when long or short earns vs USD.
 * −1 when both sides pay (PLN straddling r_USD) — still walk |cash| on the
 * +Y open arm and invert S from the pay side.
 */
export function frontierCashCarrySign(
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
): 1 | -1 {
  const perLong = fundingSwapCashDeltaUsdYr(1, spot, r_FCY, r_USD, r_OD);
  const perShort = fundingSwapCashDeltaUsdYr(-1, spot, r_FCY, r_USD, r_OD);
  if (perLong > 1e-12 || perShort > 1e-12) return 1;
  return -1;
}

/** S for a +$K cash step: earn-side invert, else pay-side invert (PLN). */
export function standingForCashCarryStep(
  cashK: number,
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
): number {
  const mag = Math.abs(cashK) / 1000;
  if (!(mag > 1e-12)) return 0;
  const earn = standingFromCashCarryUsdYr(mag, spot, r_FCY, r_USD, r_OD);
  if (Math.abs(earn) > 1e-6) return earn;
  return standingFromCashCarryUsdYr(-mag, spot, r_FCY, r_USD, r_OD);
}

/** Open-arm Y is always the cash action on the + side. */
export function frontierOpenCashUsdYr(cashUsdYr: number): number {
  return Math.abs(cashUsdYr);
}

/**
 * CIP add-on from open Y → far Y.
 * Open arm is always |cash|; far arm is signed cash + market points
 * (design: Y_far = cash + points). When cash pays (PLN) and CIP earns,
 * far sits near / above $0 — do not force −|points| (that was the old
 * deposit-CIP offset, and it flips corrected USDPLN CIP back to a cost).
 */
export function frontierFarPointsUsdYr(
  cashUsdYr: number,
  pointsUsdYr: number,
): number {
  const openY = Math.abs(cashUsdYr);
  const farY = cashUsdYr + pointsUsdYr;
  return farY - openY;
}

/** Default asinh linear band (~$12K). Overridden per plot from the open-cash arm. */
export const CARRY_LOG_S = 0.012;

export function carryFwd(usdM: number, s: number = CARRY_LOG_S): number {
  const v = usdM / Math.max(s, 1e-6);
  return Math.log(v + Math.sqrt(v * v + 1));
}

/**
 * Y domain: green open-cash on the + side. When far CIP is far below $0
 * (PLN), keep that arm on the plot — do not frame Y only on open cash.
 * If open itself dips below $0, protect that share and compress far.
 */
export function carryAxisFromArms(
  openMin: number,
  openMax: number,
  farMin: number,
): { s: number; zNeg: number; zPos: number } {
  const yHi = Math.max(openMax, 0.012);
  const yOpenLo = Math.min(0, openMin);
  const s = Math.max(CARRY_LOG_S, yHi, Math.abs(yOpenLo) * 1.2);
  const zPos = Math.max(carryFwd(yHi, s), 0.55);
  const zFar = carryFwd(Math.min(0, farMin), s);
  const padNeg = -zPos * 0.32;

  if (yOpenLo < -1e-4) {
    const zOpenLo = carryFwd(yOpenLo, s);
    const zOpenNeed = Math.min(zOpenLo, -zPos * 0.28);
    let zNeg = Math.min(zOpenNeed, zFar);
    const openDrop = -zOpenNeed;
    if (openDrop > 0.05) {
      const share = openDrop / (zPos - zNeg);
      if (share < 0.2) zNeg = zPos - openDrop / 0.2;
    }
    return { s, zPos, zNeg };
  }

  // Open is all on +. Include far CIP; keep ≥22% of the plot for green.
  let zNeg = Math.min(padNeg, zFar);
  const minOpenShare = 0.22;
  const zNegLimit = zPos * (1 - 1 / minOpenShare);
  zNeg = Math.max(zNeg, zNegLimit);
  return { s, zPos, zNeg };
}

function farSettlePlan(
  standing: number,
  months: number,
): { standing_swap: number; far_leg: number; swap_needed: number }[] {
  const T = Math.max(1, Math.floor(months));
  return Array.from({ length: T }, (_, i) => ({
    standing_swap: standing,
    swap_needed: i === 0 ? standing : 0,
    far_leg: i === T - 1 ? -standing : 0,
  }));
}

function rssSectionCfar(sectionUsdM: number, swapUsdM: number): number {
  const fx = Math.max(0, sectionUsdM);
  const swap = Math.max(0, swapUsdM);
  if (swap < 1e-12) return fx;
  return Math.sqrt(fx * fx + swap * swap);
}

function standingCfarBandsUsdM(
  standing: number,
  months: number,
  ccy: string,
  setup: VarSetup,
  sigmaMonthly: number,
): number {
  const T = Math.max(1, Math.floor(months));
  const outstandingM = Array.from({ length: T }, () => standing);
  const knots = fundingSwapKnotsFromOutstanding(outstandingM, T, true);
  if (knots.length === 0) return 0;
  const bands = computeCfarBands({
    knots,
    spotUsd: NORDTECH_VAR.spotUsd[ccy] ?? 1,
    sigmaMonthly,
    confidencePct: setup.confidencePct,
  });
  return Math.max(0, bands.criticalCashUsdM);
}

/**
 * Open cash (no far) — |S| revalued at FX σ until the far date.
 * Not the rate-diff bridge, and not net of the cash carry already on Y.
 */
export function farSettleExposureCfarUsdM(
  standing: number,
  months: number,
  ccy: string,
  setup: VarSetup,
  sectionUsdM: number,
): number {
  return rssSectionCfar(
    sectionUsdM,
    standingCfarBandsUsdM(standing, months, ccy, setup, monthlyVolForSetup(setup)),
  );
}

/**
 * Far on (desk Δ = 0) — early unwind of the locked far via a swap to raise
 * USD vs K. FX-hedge CFaR is the basis; only rate-diff vol is added.
 * Same S as open, much smaller add — not a shared vertical, and not a
 * jump left of the Unhedged vertex.
 */
export function farSettleUnwindCfarUsdM(
  standing: number,
  months: number,
  ccy: string,
  setup: VarSetup,
  sectionUsdM: number,
): number {
  const sigmaRate =
    rateVolBpYrFor(ccy, setup) / 10000 / Math.sqrt(12);
  return rssSectionCfar(
    sectionUsdM,
    standingCfarBandsUsdM(standing, months, ccy, setup, sigmaRate),
  );
}

/** Δ = 0 already has the section CFaR. Buffer adds on top of that — never 0. */
export function cfarAtZeroDelta(
  sectionUsdM: number,
  pricedUsdM: number,
  pricedFloor0UsdM: number,
): number {
  const base = Math.max(0, sectionUsdM);
  const add = Math.max(0, pricedUsdM - pricedFloor0UsdM);
  return roundMoney(base + add);
}

export function leftEndOriginPoint(originCfar: number): LiquidityFrontierPoint {
  return {
    delta: 0,
    multiple: 0,
    phase: 'unfunded',
    intensity: 0,
    bufferM: 0,
    carryM: 0,
    cashCarryUsdYrM: 0,
    swapCashUsdYrM: 0,
    cipUsdYrM: 0,
    hedgeCarryUsdYrM: 0,
    totalCarryUsdYrM: 0,
    finalCfarUsdM: Math.max(0, originCfar),
    peakBook: 0,
    levered: false,
  };
}

/**
 * One polyline: floor walk at Δ = 0. CFaR grows with buffer.
 */
export function liquidityFrontierLeftEndCurve(
  points: readonly LiquidityFrontierPoint[],
  _originCfar?: number,
): LiquidityFrontierPoint[] {
  return points
    .filter(p => Math.abs(p.delta) < 1e-9)
    .sort((a, b) => a.bufferM - b.bufferM);
}

export interface LiquidityFrontierHit {
  cfarUsdM: number;
  carryUsdYrM: number;
  standing: number;
}

export interface LiquidityFrontierConstraint {
  dial: LiquidityFrontierDial;
  /** Horizontal — Target Carry (open-book cash). */
  hCarryUsdYrM: number | null;
  /** Vertical — live Net CFaR / VAR. */
  vCfarUsdM: number | null;
  openHit: LiquidityFrontierHit | null;
  hedgeHit: LiquidityFrontierHit | null;
}

/** Open/far pair sitting on the constraint rings so the picker can land there. */
export function constraintTwinFromHits(
  openHit: LiquidityFrontierHit,
  hedgeHit: LiquidityFrontierHit,
  templateOpen: LiquidityFrontierPoint,
  templateFar: LiquidityFrontierPoint,
): { key: string; open: LiquidityFrontierPoint; far: LiquidityFrontierPoint } {
  const cash = openHit.carryUsdYrM;
  const points = hedgeHit.carryUsdYrM - openHit.carryUsdYrM;
  return {
    key: openHit.standing.toFixed(4),
    open: {
      ...templateOpen,
      delta: 0,
      phase: 'unfunded',
      peakBook: openHit.standing,
      carryM: openHit.standing,
      multiple: openHit.standing,
      cashCarryUsdYrM: cash,
      swapCashUsdYrM: cash,
      cipUsdYrM: points,
      hedgeCarryUsdYrM: 0,
      totalCarryUsdYrM: openHit.carryUsdYrM,
      finalCfarUsdM: openHit.cfarUsdM,
    },
    far: {
      ...templateFar,
      delta: 1,
      phase: 'hedged',
      peakBook: hedgeHit.standing,
      carryM: hedgeHit.standing,
      multiple: hedgeHit.standing,
      cashCarryUsdYrM: cash,
      swapCashUsdYrM: cash,
      cipUsdYrM: points,
      hedgeCarryUsdYrM: points,
      totalCarryUsdYrM: hedgeHit.carryUsdYrM,
      finalCfarUsdM: hedgeHit.cfarUsdM,
    },
  };
}

export interface LiquidityLeftEndResult {
  dial: LiquidityFrontierDial;
  walk: LiquidityFrontierWalk;
  cfarOriginUsdM: number;
  origin: LiquidityFrontierPoint;
  upper: LiquidityFrontierPoint[];
  lower: LiquidityFrontierPoint[];
  curve: LiquidityFrontierPoint[];
  points: LiquidityFrontierPoint[];
  applied: LiquidityFrontierPoint | null;
  constraint: LiquidityFrontierConstraint;
  /** Live book standing (M FCY) used for the solid / dashed split. */
  bookStanding: number;
  /** Open cash of that book, $K. */
  bookCashK: number;
}

export function interpAlong(
  pts: readonly LiquidityFrontierPoint[],
  at: number,
  axis: 'cfar' | 'carry',
): LiquidityFrontierHit | null {
  if (pts.length === 0) return null;
  const key = (p: LiquidityFrontierPoint) =>
    axis === 'cfar' ? p.finalCfarUsdM : p.totalCarryUsdYrM;
  const sorted = [...pts].sort((a, b) => key(a) - key(b));
  const lo0 = key(sorted[0]!);
  const hi0 = key(sorted[sorted.length - 1]!);
  if (at < lo0 - 1e-9 || at > hi0 + 1e-9) return null;
  if (sorted.length === 1 || Math.abs(hi0 - lo0) < 1e-12) {
    const p = sorted[0]!;
    return {
      cfarUsdM: p.finalCfarUsdM,
      carryUsdYrM: p.totalCarryUsdYrM,
      standing: p.peakBook,
    };
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const ka = key(a);
    const kb = key(b);
    if (at < Math.min(ka, kb) - 1e-9 || at > Math.max(ka, kb) + 1e-9) continue;
    const w = Math.abs(kb - ka) < 1e-12 ? 1 : (at - ka) / (kb - ka);
    return {
      cfarUsdM: a.finalCfarUsdM + (b.finalCfarUsdM - a.finalCfarUsdM) * w,
      carryUsdYrM: a.totalCarryUsdYrM + (b.totalCarryUsdYrM - a.totalCarryUsdYrM) * w,
      standing: a.peakBook + (b.peakBook - a.peakBook) * w,
    };
  }
  return null;
}

/**
 * Price one residual-risk step. Swap standing and swap CFaR are Δ × book.
 * Overlay hedge is (1−Δ) of the full book — not an empty k = 0 plan.
 */
function priceResidualDelta(
  row: RowState,
  strategy: LiquidityStrategy,
  input: LiquidityFrontierInput,
  delta: number,
  bookK: number,
  coverPlan: readonly LiquidityCycleProjection[],
): LiquidityFrontierPoint {
  const residual = clampHedgeDelta(delta);
  const fullPlan = scalePlan(coverPlan, bookK);
  const residualPlan = scalePlan(coverPlan, bookK * residual);
  const section = sectionCfarUsdM(input.cfarNetByCcyUsd, row.ccy);
  const months = Math.floor(input.months);
  const ladder = buildLiquidityLadder(row, input.forecastProfile, {
    months,
    opening: row.cash,
    floor: row.cash_floor,
    hedgeSettle: input.hedgeSettleByCcy?.[row.ccy],
  });
  const overlay = overlayFor(row, fullPlan, residual);
  const spot = ccySpotRate(row.ccy);
  const cashCarryUsdYrM = unfundedCashCarryUsdYr(
    ladder, spot, row.r_FCY, row.r_OD, input.shared.r_USD,
  );
  const legs = fundingSwapCarryLegs({
    ccy: row.ccy,
    plan: residualPlan,
    r_FCY: row.r_FCY,
    r_USD: input.shared.r_USD,
    r_OD: row.r_OD,
    forecastMonths: input.shared.forecastMonths ?? input.months,
  });
  const standingFallback = swapFarLegNotional(
    residualPlan, residualPlan[0]?.swap_needed ?? 0,
  );
  const cipUsdYrM = residualPlan.length === 0
    ? 0
    : fundingSwapPathFarCipUsdM({
        plan: residualPlan,
        standingFallback,
        forecastMonths: input.shared.forecastMonths ?? input.months,
        bundle: resolveMarketRatesForCcy(
          input.marketRatesByCcy, row.ccy, input.ratesScopeId,
        ),
        fallbackAnnualUsdYr: S =>
          fundingSwapCipPointsUsdYr(S, spot, row.r_FCY, input.shared.r_USD),
      });
  const settleMonths = strategy.regime?.bookingMode === 'term'
    ? fundingSwapFarSettleMonths(fullPlan, input.shared.forecastMonths ?? input.months)
    : Math.max(1, input.shared.forecastMonths ?? input.months);
  const hedgeCarryUsdYrM = fwdHedgeCarryFromMarketUsd(
    overlay.forwardLocalM,
    row.ccy,
    row.r_FCY,
    input.shared.r_USD,
    settleMonths,
    resolveMarketRatesForCcy(input.marketRatesByCcy, row.ccy, input.ratesScopeId),
  );
  const swapCashUsdYrM = legs.cashUsdM;
  const totalCarryUsdYrM = roundMoney(
    cashCarryUsdYrM + swapCashUsdYrM + hedgeCarryUsdYrM,
  );
  const peakBook = residualPlan.reduce((best, p) => (
    Math.abs(p.standing_swap) > Math.abs(best) ? p.standing_swap : best
  ), 0);
  const horizon = input.setup
    ? (input.setup.forecastMonths > 0 ? input.setup.forecastMonths : months)
    : months;
  const finalCfarUsdM = input.setup
    ? displayedCfarUsdMFromFxNet(
        section,
        row.ccy,
        residualPlan,
        input.setup,
        bufferCarryScheduleUsdM(
          residualPlan, horizon, spot, row.r_FCY, input.shared.r_USD, row.r_OD,
        ),
      )
    : section;

  return {
    delta: residual,
    multiple: roundMoney(bookK),
    phase: phaseOf(bookK * residual),
    intensity: hedgeIntensity(bookK * residual),
    bufferM: row.cash_floor,
    carryM: liveCarryAsk(row),
    cashCarryUsdYrM: roundMoney(cashCarryUsdYrM),
    swapCashUsdYrM: roundMoney(swapCashUsdYrM),
    cipUsdYrM: roundMoney(cipUsdYrM),
    hedgeCarryUsdYrM: roundMoney(hedgeCarryUsdYrM),
    totalCarryUsdYrM,
    finalCfarUsdM,
    peakBook: roundMoney(peakBook),
    levered: false,
  };
}

function priceCarryPair(
  row: RowState,
  standing: number,
  cashUsdYr: number,
  pointsUsdYr: number,
  cover: number,
  cfarUsdM: number,
  levered: boolean,
): LiquidityFrontierPoint {
  const alpha = clampHedgeDelta(cover);
  const complete = alpha >= 1 - 1e-9;
  const y = roundMoney(cashUsdYr + alpha * pointsUsdYr);
  return {
    delta: alpha,
    multiple: roundMoney(standing),
    phase: complete ? 'hedged' : alpha < 1e-9 ? 'unfunded' : 'hedged',
    intensity: hedgeIntensity(complete ? 1 : alpha),
    bufferM: row.cash_floor,
    carryM: standing,
    cashCarryUsdYrM: roundMoney(cashUsdYr),
    swapCashUsdYrM: roundMoney(cashUsdYr),
    cipUsdYrM: roundMoney(pointsUsdYr),
    hedgeCarryUsdYrM: roundMoney(alpha * pointsUsdYr),
    totalCarryUsdYrM: y,
    finalCfarUsdM: cfarUsdM,
    peakBook: roundMoney(standing),
    levered,
  };
}

/**
 * CFaR of a partial far-on at one S.
 * Leftover FX on (1−α)S and unwind on αS, RSS'd, then RSS'd with the
 * FX-hedge basis. Cover α: 0 = open cash, 1 = far on.
 */
export function rssMixCfarUsdM(
  sectionUsdM: number,
  cfarOpenUsdM: number,
  cfarFarUsdM: number,
  cover: number,
): number {
  const section = Math.max(0, sectionUsdM);
  const open = Math.max(0, cfarOpenUsdM);
  const far = Math.max(0, cfarFarUsdM);
  const fxAdd = Math.sqrt(Math.max(0, open * open - section * section));
  const rateAdd = Math.sqrt(Math.max(0, far * far - section * section));
  const alpha = clampHedgeDelta(cover);
  const add = Math.hypot((1 - alpha) * fxAdd, alpha * rateAdd);
  return Math.hypot(section, add);
}

/** Price one cover on the iso-S slice between an open/far twin pair. */
export function priceIsoSSlice(
  open: LiquidityFrontierPoint,
  far: LiquidityFrontierPoint,
  sectionUsdM: number,
  cover: number,
): LiquidityFrontierPoint {
  const alpha = clampHedgeDelta(cover);
  const cash = open.cashCarryUsdYrM;
  const points = open.cipUsdYrM;
  if (alpha < 1e-9) return open;
  if (alpha >= 1 - 1e-9) return far;
  return {
    ...open,
    delta: alpha,
    phase: 'hedged',
    intensity: hedgeIntensity(alpha),
    hedgeCarryUsdYrM: roundMoney(alpha * points),
    totalCarryUsdYrM: roundMoney(cash + alpha * points),
    finalCfarUsdM: roundMoney(rssMixCfarUsdM(
      sectionUsdM, open.finalCfarUsdM, far.finalCfarUsdM, alpha,
    )),
    peakBook: open.peakBook,
    levered: open.levered,
  };
}

function snapIsoAlpha(cover: number): number {
  const a = Math.min(1, Math.max(0, cover));
  return Math.round(a * 1e6) / 1e6;
}

/**
 * Cover α knots for the selected-S yellow mix.
 * Uniform α is the RSS mix in the (FX, unwind) plane; extra knots sit at the
 * asinh Y = 0 crossing and at the FX/unwind RSS corner so the polyline is
 * the mix, not a chord.
 */
export function isoSSliceAlphas(
  open: Pick<LiquidityFrontierPoint, 'cashCarryUsdYrM' | 'cipUsdYrM' | 'finalCfarUsdM'>,
  far: Pick<LiquidityFrontierPoint, 'finalCfarUsdM'>,
  sectionUsdM: number,
  steps = ISO_S_SLICE_STEPS,
): number[] {
  const n = Math.max(8, Math.floor(steps));
  const alphas = new Set<number>([0, 1]);
  for (let i = 1; i < n; i += 1) alphas.add(snapIsoAlpha(i / n));
  const cash = open.cashCarryUsdYrM;
  const cip = open.cipUsdYrM;
  if (Math.abs(cip) > 1e-12) {
    const a0 = -cash / cip;
    if (a0 > 0 && a0 < 1) {
      for (const w of [-0.08, -0.04, -0.02, -0.01, 0, 0.01, 0.02, 0.04, 0.08]) {
        const a = a0 + w;
        if (a > 0 && a < 1) alphas.add(snapIsoAlpha(a));
      }
    }
  }
  const section = Math.max(0, sectionUsdM);
  const fxAdd = Math.sqrt(Math.max(0, open.finalCfarUsdM ** 2 - section ** 2));
  const rateAdd = far.finalCfarUsdM + 1e-12 >= section
    ? Math.sqrt(Math.max(0, far.finalCfarUsdM ** 2 - section ** 2))
    : Math.max(0, far.finalCfarUsdM);
  const den = fxAdd * fxAdd + rateAdd * rateAdd;
  if (den > 1e-16) {
    const aStar = (fxAdd * fxAdd) / den;
    if (aStar > 0 && aStar < 1) {
      for (const w of [-0.06, -0.03, -0.015, 0, 0.015, 0.03, 0.06]) {
        const a = aStar + w;
        if (a > 0 && a < 1) alphas.add(snapIsoAlpha(a));
      }
    }
  }
  return [...alphas].sort((a, b) => a - b);
}

/** Dense polyline for the selected-S Δ curve (endpoints + interior). */
export function isoSSlicePoints(
  open: LiquidityFrontierPoint,
  far: LiquidityFrontierPoint,
  sectionUsdM: number,
  steps = ISO_S_SLICE_STEPS,
): LiquidityFrontierPoint[] {
  return isoSSliceAlphas(open, far, sectionUsdM, steps).map(a =>
    priceIsoSSlice(open, far, sectionUsdM, a),
  );
}

export type LiquidityStandingPriceInput = Pick<
  LiquidityFrontierInput,
  | 'row'
  | 'months'
  | 'shared'
  | 'setup'
  | 'marketRatesByCcy'
  | 'ratesScopeId'
  | 'cfarNetByCcyUsd'
>;

export interface LiquidityStandingPrice {
  sectionUsdM: number;
  cashUsdYr: number;
  pointsUsdYr: number;
  cfarOpenUsdM: number;
  cfarFarUsdM: number;
  open: LiquidityFrontierPoint;
  far: LiquidityFrontierPoint;
}

/**
 * Price open-cash and far-on at an arbitrary signed standing.
 * FX-hedge CFaR is the basis. Open adds FX bands; far adds rate-diff
 * bands. Same S, different X — both ≥ basis.
 */
export function priceLiquidityStanding(
  input: LiquidityStandingPriceInput,
  standing: number,
  liveBookCashK = 0,
): LiquidityStandingPrice {
  const row = input.row;
  const months = Math.floor(input.months);
  const spot = ccySpotRate(row.ccy);
  const horizon = input.setup
    ? (input.setup.forecastMonths > 0 ? input.setup.forecastMonths : months)
    : months;
  const section = sectionCfarUsdM(input.cfarNetByCcyUsd, row.ccy);
  if (!(months > 0) || !Number.isFinite(standing) || Math.abs(standing) < 1e-9) {
    const origin = leftEndOriginPoint(section);
    return {
      sectionUsdM: section,
      cashUsdYr: 0,
      pointsUsdYr: 0,
      cfarOpenUsdM: section,
      cfarFarUsdM: section,
      open: origin,
      far: origin,
    };
  }
  const plan = farSettlePlan(standing, horizon);
  const cashUsdYr = fundingSwapCashDeltaUsdYr(
    standing, spot, row.r_FCY, input.shared.r_USD, row.r_OD,
  );
  const pointsUsdYr = fundingSwapPathFarCipUsdM({
    plan,
    standingFallback: standing,
    forecastMonths: input.shared.forecastMonths ?? horizon,
    bookingMode: 'term',
    bundle: resolveMarketRatesForCcy(
      input.marketRatesByCcy, row.ccy, input.ratesScopeId,
    ),
    fallbackAnnualUsdYr: S =>
      fundingSwapCipPointsUsdYr(S, spot, row.r_FCY, input.shared.r_USD),
  }) * (12 / Math.max(1, horizon));
  const cfarOpenUsdM = input.setup
    ? farSettleExposureCfarUsdM(standing, horizon, row.ccy, input.setup, section)
    : section;
  const cfarFarUsdM = input.setup
    ? farSettleUnwindCfarUsdM(standing, horizon, row.ccy, input.setup, section)
    : section;
  const cashK = bookCashCarryK(standing, spot, row.r_FCY, input.shared.r_USD, row.r_OD);
  const levered = liveBookCashK > 0.5 && cashK > liveBookCashK + 0.5;
  const openCashUsdYr = frontierOpenCashUsdYr(cashUsdYr);
  const farPointsUsdYr = frontierFarPointsUsdYr(cashUsdYr, pointsUsdYr);
  return {
    sectionUsdM: section,
    cashUsdYr,
    pointsUsdYr,
    cfarOpenUsdM,
    cfarFarUsdM,
    open: priceCarryPair(row, standing, openCashUsdYr, farPointsUsdYr, 0, cfarOpenUsdM, levered),
    far: priceCarryPair(row, standing, openCashUsdYr, farPointsUsdYr, 1, cfarFarUsdM, levered),
  };
}

export function buildLiquidityLeftEndFrontier(
  input: LiquidityFrontierInput,
): LiquidityLeftEndResult {
  const dial = liquidityFrontierDial(input.activeLayers);
  const originCfar = sectionCfarUsdM(input.cfarNetByCcyUsd, input.row.ccy);
  const origin = leftEndOriginPoint(originCfar);
  const noneConstraint: LiquidityFrontierConstraint = {
    dial, hCarryUsdYrM: null, vCfarUsdM: null, openHit: null, hedgeHit: null,
  };
  const empty: LiquidityLeftEndResult = {
    dial,
    walk: 'carry_pair',
    cfarOriginUsdM: originCfar,
    origin,
    upper: [],
    lower: [],
    curve: [origin],
    points: [],
    applied: null,
    constraint: noneConstraint,
    bookStanding: 0,
    bookCashK: 0,
  };
  const months = Math.floor(input.months);
  if (!(months > 0)) return empty;

  const row = input.row;
  const spot = ccySpotRate(row.ccy);
  const targetS = typeof row.carry_target === 'number' && Number.isFinite(row.carry_target)
    ? row.carry_target
    : null;
  const liveS = input.bookStanding != null && Math.abs(input.bookStanding) > 0.01
    ? input.bookStanding
    : (targetS != null && Math.abs(targetS) > 0.01 ? targetS : 0);
  const bookCashK = bookCashCarryK(
    liveS, spot, row.r_FCY, input.shared.r_USD, row.r_OD,
  );
  const searching = dial !== 'cash_floor';
  const stepsK = (input.carryUsdK && input.carryUsdK.length > 0
    ? [...input.carryUsdK]
    : frontierCarryDotsK(bookCashK, {
        targetCashK: searching ? bookCashK : 0,
        tail: searching,
      })
  ).filter(k => Number.isFinite(k) && k > 0).sort((a, b) => a - b);

  const priceStanding = (standing: number) => {
    const priced = priceLiquidityStanding(input, standing, bookCashK);
    return {
      cashUsdYr: priced.cashUsdYr,
      pointsUsdYr: priced.pointsUsdYr,
      cfarOpenUsdM: priced.cfarOpenUsdM,
      cfarFarUsdM: priced.cfarFarUsdM,
    };
  };

  const upper: LiquidityFrontierPoint[] = [];
  const lower: LiquidityFrontierPoint[] = [];
  const points: LiquidityFrontierPoint[] = [];

  for (const k of stepsK) {
    const standing = standingForCashCarryStep(
      k, spot, row.r_FCY, input.shared.r_USD, row.r_OD,
    );
    if (Math.abs(standing) < 1e-6) continue;
    const priced = priceStanding(standing);
    const openCashUsdYr = frontierOpenCashUsdYr(priced.cashUsdYr);
    const pointsUsdYr = frontierFarPointsUsdYr(priced.cashUsdYr, priced.pointsUsdYr);
    const levered = bookCashK > 0.5 && k > bookCashK + 0.5;
    for (const cover of HEDGE_COVERS) {
      const p = priceCarryPair(
        row,
        standing,
        openCashUsdYr,
        pointsUsdYr,
        cover,
        cover >= 1 - 1e-9 ? priced.cfarFarUsdM : priced.cfarOpenUsdM,
        levered,
      );
      points.push(p);
      if (cover >= 1 - 1e-9) lower.push(p);
      else upper.push(p);
    }
  }
  upper.sort((a, b) => a.finalCfarUsdM - b.finalCfarUsdM || a.delta - b.delta);
  lower.sort((a, b) => a.finalCfarUsdM - b.finalCfarUsdM);
  const openLine = upper.filter(p => p.delta < 1e-9);
  const openWithOrigin = [origin, ...openLine];
  const farWithOrigin = [origin, ...lower];
  const tip = openLine[openLine.length - 1] ?? lower[lower.length - 1] ?? origin;

  const markS = targetS != null && Math.abs(targetS) > 0.01 ? targetS : liveS;
  const showCarryCut = Math.abs(markS) > 0.01
    && (dial === 'carry_target' || (targetS != null && Math.abs(targetS) > 0.01));
  const showVarCut = dial === 'var_target';
  let constraint: LiquidityFrontierConstraint = { ...noneConstraint };
  if ((showCarryCut || showVarCut) && Math.abs(markS) > 0.01) {
    const priced = priceStanding(markS);
    const vFar = priced.cfarFarUsdM;
    const openY = frontierOpenCashUsdYr(priced.cashUsdYr);
    const farY = openY + frontierFarPointsUsdYr(priced.cashUsdYr, priced.pointsUsdYr);
    constraint = {
      dial,
      hCarryUsdYrM: showCarryCut ? openY : null,
      vCfarUsdM: showVarCut ? vFar : null,
      openHit: showVarCut
        ? (interpAlong(openWithOrigin, vFar, 'cfar') ?? {
            cfarUsdM: priced.cfarOpenUsdM,
            carryUsdYrM: openY,
            standing: markS,
          })
        : {
            cfarUsdM: priced.cfarOpenUsdM,
            carryUsdYrM: openY,
            standing: markS,
          },
      hedgeHit: showVarCut
        ? (interpAlong(farWithOrigin, vFar, 'cfar') ?? {
            cfarUsdM: priced.cfarFarUsdM,
            carryUsdYrM: farY,
            standing: markS,
          })
        : {
            cfarUsdM: priced.cfarFarUsdM,
            carryUsdYrM: farY,
            standing: markS,
          },
    };
  } else if (showVarCut) {
    const bookOpen = [...openLine].reverse().find(p => !p.levered) ?? openLine[openLine.length - 1];
    const v = bookOpen?.finalCfarUsdM ?? originCfar;
    constraint = {
      dial,
      hCarryUsdYrM: null,
      vCfarUsdM: v,
      openHit: interpAlong(openWithOrigin, v, 'cfar')
        ?? (bookOpen
          ? { cfarUsdM: bookOpen.finalCfarUsdM, carryUsdYrM: bookOpen.totalCarryUsdYrM, standing: bookOpen.peakBook }
          : null),
      hedgeHit: interpAlong(farWithOrigin, v, 'cfar'),
    };
  }

  return {
    dial,
    walk: 'carry_pair',
    cfarOriginUsdM: originCfar,
    origin,
    upper,
    lower,
    curve: [origin, ...openLine],
    points,
    applied: tip,
    constraint,
    bookStanding: liveS,
    bookCashK,
  };
}

export function liquidityFrontierPositive(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[] {
  return points.filter(p => p.totalCarryUsdYrM > POSITIVE_CARRY);
}

/**
 * One (Carry, VAR) point per Δ. Prefers the live cover (k = 1).
 * This is the series the 2D chart draws — not a family of curves.
 */
export function liquidityFrontierWalk(
  points: readonly LiquidityFrontierPoint[],
  delta: number,
): LiquidityFrontierPoint[] {
  return points
    .filter(p => Math.abs(p.delta - delta) < 1e-6)
    .sort((a, b) => a.intensity - b.intensity || a.multiple - b.multiple);
}

export function liquidityFrontierByDelta(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[] {
  const by = new Map<string, LiquidityFrontierPoint>();
  for (const p of points) {
    const k = p.delta.toFixed(4);
    const prev = by.get(k);
    if (!prev) {
      by.set(k, p);
      continue;
    }
    const prevLive = Math.abs(prev.multiple - 1) < 1e-9;
    const nextLive = Math.abs(p.multiple - 1) < 1e-9;
    if (nextLive && !prevLive) by.set(k, p);
  }
  return [...by.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, p]) => p);
}

export function liquidityFrontierPositiveTail(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[] {
  return liquidityFrontierByDelta(points);
}

export function liquidityFrontierRays(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[][] {
  return groupByDelta(liquidityFrontierPositive(points))
    .map(arr => [...arr].sort(
      (a, b) => a.finalCfarUsdM - b.finalCfarUsdM || a.multiple - b.multiple,
    ));
}

export function growingRiskCarryEnd(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint | null {
  const tail = liquidityFrontierPositiveTail(points);
  return tail[tail.length - 1] ?? null;
}

/**
 * Efficient set on the carry–VAR plane: higher carry is better, lower
 * Final CFaR is better.
 */
export function liquidityFrontierSkyline(
  points: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[] {
  const byVar = [...points].sort(
    (a, b) => a.finalCfarUsdM - b.finalCfarUsdM || b.totalCarryUsdYrM - a.totalCarryUsdYrM,
  );
  const keep: LiquidityFrontierPoint[] = [];
  let bestCarry = Number.NEGATIVE_INFINITY;
  for (const p of byVar) {
    if (p.totalCarryUsdYrM > bestCarry + 1e-9) {
      keep.push(p);
      bestCarry = p.totalCarryUsdYrM;
    }
  }
  return keep;
}

export function highestCarryOnSkyline(
  skyline: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint | null {
  return skyline.reduce<LiquidityFrontierPoint | null>(
    (best, p) => (best == null || p.totalCarryUsdYrM > best.totalCarryUsdYrM ? p : best),
    null,
  );
}

export function isDegenerateLiquidityFrontier(
  all: readonly LiquidityFrontierPoint[],
  skyline: readonly LiquidityFrontierPoint[],
): boolean {
  if (skyline.length < 2) return true;
  const carries = all.map(p => p.totalCarryUsdYrM);
  const lo = Math.min(...carries);
  const hi = Math.max(...carries);
  return hi - lo <= 1e-9;
}

function uniqueDeltas(live: number, extra?: readonly number[]): number[] {
  const raw = [...(extra ?? DEFAULT_DELTAS), live];
  const seen = new Set<string>();
  const out: number[] = [];
  for (const d of raw) {
    const v = Math.min(1, Math.max(0, d));
    const k = v.toFixed(4);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.sort((a, b) => a - b);
}

export function buildLiquidityFrontier(
  input: LiquidityFrontierInput,
): LiquidityFrontierResult {
  const months = Math.floor(input.months);
  const dial = liquidityFrontierDial(input.activeLayers);
  const empty: LiquidityFrontierResult = {
    dial, points: [], skyline: [], applied: null, best: null, riskEnd: null,
    cfarOriginUsdM: 0, degenerate: true,
  };
  if (!(months > 0)) return empty;

  const layers = new Set<LayerId>(input.activeLayers ?? []);
  layers.add('floorH');
  layers.add('carryOptim');

  const liveDelta = input.swapForwardOverlayByCcy?.[input.row.ccy]?.delta ?? 0;
  const deltas = uniqueDeltas(liveDelta, input.deltas);
  const multiples = (input.multiples ?? hedgeMultiples(input.steps ?? DEFAULT_STEPS))
    .map(roundMoney);

  const coverPlan = buildCoverPlan(input.row, input.strategy, input, layers);

  const fxByDelta = new Map<number, ReturnType<typeof fxHedgeMcCfarByCcy>>();
  for (const delta of deltas) {
    if (!input.setup) {
      fxByDelta.set(delta, {});
      continue;
    }
    const overlay = overlayFor(input.row, coverPlan, delta);
    fxByDelta.set(delta, fxHedgeMcCfarByCcy({
      rows: [input.row],
      setup: input.setup,
      forecastProfile: input.forecastProfile,
      bookedHedges: input.bookedHedges,
      preparedByCcy: input.preparedByCcy,
      marketRatesByCcy: input.marketRatesByCcy,
      ratesScopeId: input.ratesScopeId,
      swapForwardOverlayByCcy: { [input.row.ccy]: overlay },
    }));
  }

  const points: LiquidityFrontierPoint[] = [];
  for (const delta of deltas) {
    const fx = fxByDelta.get(delta) ?? {};
    for (const k of multiples) {
      points.push(pricePoint(
        input.row, input.strategy, input, delta, k, coverPlan, fx,
      ));
    }
  }

  const applied = pricePoint(
    input.row, input.strategy, input, liveDelta, 1, coverPlan,
    fxByDelta.get(liveDelta) ?? {},
  );
  applied.bufferM = input.row.cash_floor;
  applied.carryM = liveCarryAsk(input.row);

  const skyline = liquidityFrontierSkyline(points);
  return {
    dial,
    points,
    skyline,
    applied,
    best: highestCarryOnSkyline(skyline),
    riskEnd: growingRiskCarryEnd(points),
    cfarOriginUsdM: sectionCfarUsdM(input.cfarNetByCcyUsd, input.row.ccy),
    degenerate: isDegenerateLiquidityFrontier(points, skyline),
  };
}
