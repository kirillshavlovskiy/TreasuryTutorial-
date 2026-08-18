// Funding programmes for the liquidity position, priced against each other.
//
// The dated path (`buildLiquidityLadder`) says how deep the book dips and when.
// It does not say how the desk covers the dip, and the cover is a real choice
// with a real price: run the overdraft, buy a leg per cycle, or commit one term
// swap today. This module runs each of those over the same path and charges
// them on the same interest ledger, so the comparison is like for like.
//
// The carry ledger matches the desk P&L. Strategies differ in the book they
// put on — peak, trips, the gap vs H* — not in a second cash-carry number.
//
//   Cash Carry  = desk Cash Carry $k: staged dual-book cash when a hedge is
//                 on, else cycle-1 unfunded LP NIM (`floatNim`). Same on every
//                 strategy — the funding swap lives in Swap cash.
//   Hedge Cash  = desk FWD pts / Hedge Cash $k (Cash Carry tab FWD). Same on
//                 every strategy. Cash + Hedge = desk Total without the
//                 funding-swap overlay.
//   Swap cash   = Σ cycle cash Δr on the standing book   desk Buffer Carry
//   Swap points = Market data far-leg CIP on that book   desk CIP
//                 Live regime uses the desk CIP map when provided (already Δ-scaled).
//   Swap Carry  = Swap cash + Swap points                ~0 when points are mid
//   net cost    = −(Cash + Hedge + Swap Carry)
//
// Both swap legs come from the same helpers the Liquidity tab prints, so the two
// views cannot drift apart on rate convention or on averaging.
//
// Note `sizingBasis` never reaches `projectLiquidityCycles` — only `bookingMode`
// does — so rolling-on-cycle and rolling-on-horizon book identical notional.
// They are still different programmes: one goes back to market every cycle at
// whatever the points are then, the other pre-books the whole strip today. That
// is a rollover-risk difference, not a notional one, and the strategies below
// are cut along what the model actually distinguishes rather than along a 2×2
// that would report two duplicate pairs.

import { fundedPlanFor } from '@/lib/dashboard-model';
import {
  analyticsForwardsFromOverlays,
  clampHedgeDelta,
  type SwapForwardOverlay,
} from '@/lib/fx-hedge';
import {
  swapLegSchedule,
  type ForecastProfileState,
  type LiquidityCycleProjection,
  type SwapLegScheduleRow,
} from '@/lib/forecast-profile';
import {
  fundingSwapFarLegCipUsdM,
  fundingSwapPathFarCipUsdM,
  resolveMarketRatesForCcy,
  resolveOvernightCashRates,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import {
  cashForecastCarrySplitByCcyUsdM,
  hedgeCashFlowsByMonth,
  withNonCashFxConversion,
} from '@/lib/test-mode/cash-carry-analytics';
import {
  displayedCfarNetByCcyUsdM,
  fxHedgeMcCfarByCcy,
  sumNetCfarUsdM,
} from '@/lib/test-mode/cfar-net-by-ccy';
import type { HedgeTicket, PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import type { VarSetup } from '@/lib/test-mode/var-setup';
import {
  ccySpotRate,
  computeLayeredBuffer,
  fundingSwapCarryLegs,
  fundingSwapCashDeltaUsdYr,
  fundingSwapCashFcyRate,
  fundingSwapCipPointsUsdYr,
  fundingSwapFarSettleMonths,
  fundingSwapOverlayUsdYr,
  fxBookNetLocalM,
  roundMoney,
  swapFarLegNotional,
  usdToFcyM,
  type LayerId,
  type BufferChipKey,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import {
  buildLiquidityLadder,
  carrySplitFromBalances,
  cycleCarrySplit,
  monthFlowSeriesForRow,
  resolveLiquidityTiming,
  type HedgeSettleByCcy,
  type LiquidityBookingMode,
  type LiquidityLadderResult,
  type LiquiditySizingBasis,
} from '@/lib/liquidity-ladder';

export type LiquidityStrategyId =
  | 'unfunded'
  | 'nearCycle'
  | 'rollingProgramme'
  | 'termSwap';

export interface LiquidityStrategy {
  id: LiquidityStrategyId;
  label: string;
  /** What the desk actually puts on, in one line. */
  summary: string;
  /** What it costs and what it leaves exposed. */
  tradeoff: string;
  /**
   * Regime written onto `forecastProfile.liquidity` when this strategy is
   * adopted. The baseline has none — not funding is a comparison, not a book.
   */
  regime: {
    sizingBasis: LiquiditySizingBasis;
    bookingMode: LiquidityBookingMode;
  } | null;
}

export const LIQUIDITY_STRATEGIES: readonly LiquidityStrategy[] = [
  {
    id: 'unfunded',
    label: 'Run the overdraft',
    summary: 'No swap. The trough goes negative and the account pays the debit rate.',
    tradeoff:
      'Nothing is committed and no points are paid, but the cover costs r_OD rather than the rate differential, and every cycle that dips below the floor stays below it.',
    regime: null,
  },
  {
    id: 'nearCycle',
    label: 'Near cycle only',
    summary: 'Trade the M1 leg spot and go back to market each cycle for the next one.',
    tradeoff:
      'Only the cash the next cycle needs is drawn, so nothing sits idle — at the cost of a trip to market every cycle, each at whatever the points are then.',
    regime: { sizingBasis: 'cycle', bookingMode: 'rolling' },
  },
  {
    id: 'rollingProgramme',
    label: 'Rolling programme',
    summary: 'Same legs, all booked today: M1 spot plus the rest as forward-starting swaps.',
    tradeoff:
      'Identical notional to the near-cycle plan, so identical carry — but the whole strip is priced today, so no cycle is left to roll at an unknown level.',
    regime: { sizingBasis: 'horizon', bookingMode: 'rolling' },
  },
  {
    id: 'termSwap',
    label: 'One term swap',
    summary: 'A single leg today, sized so every cycle on the horizon still clears H*.',
    tradeoff:
      'One trade, one set of points and no rollover risk, paid for by carrying the deepest cycle’s cover from day one — before it bites.',
    regime: { sizingBasis: 'horizon', bookingMode: 'term' },
  },
];

export function liquidityStrategyMeta(id: LiquidityStrategyId): LiquidityStrategy {
  return LIQUIDITY_STRATEGIES.find(s => s.id === id) ?? LIQUIDITY_STRATEGIES[0]!;
}

/**
 * Which strategy the desk is running now, read off the persisted regime.
 * `rolling` splits on sizing basis: the nearest cycle funds one leg at a time,
 * the worst cycle commits the strip.
 */
export function strategyForRegime(
  sizingBasis: LiquiditySizingBasis,
  bookingMode: LiquidityBookingMode,
): LiquidityStrategy {
  if (bookingMode === 'term') return liquidityStrategyMeta('termSwap');
  return liquidityStrategyMeta(
    sizingBasis === 'cycle' ? 'nearCycle' : 'rollingProgramme',
  );
}

/**
 * Layers the comparison sizes H* on. The floor and the payout-uncertainty
 * cushion are the non-discretionary part of the requirement; carry and
 * portfolio optimisation settle across the whole book's budget, which the
 * Analytics view does not own, so leaving them out keeps every strategy sized
 * on the same policy rather than on a budget verdict this module invented.
 */
export const FUNDING_POLICY_LAYERS: readonly LayerId[] = ['floorH', 'sigmaP'];

/** What sizes H* — the constraint the funding regime is satisfying. */
export type BufferConstraint = 'var' | 'carry' | 'balance';

export function resolveBufferConstraint(
  active: Set<LayerId> | undefined,
): BufferConstraint {
  const a = active ?? new Set<LayerId>();
  if (a.has('portfolioDiv')) return 'var';
  if (a.has('carryOptim')) return 'carry';
  return 'balance';
}

export function bufferConstraintLabel(constraint: BufferConstraint): string {
  if (constraint === 'var') return 'VaR';
  if (constraint === 'carry') return 'Carry';
  return 'Balance';
}

export function bufferConstraintDetail(
  active: Set<LayerId> | undefined,
): string {
  const a = active ?? new Set<LayerId>();
  const bits: string[] = [];
  if (a.has('cfarCover') || a.has('sigmaP')) bits.push('Forecast accuracy');
  if (a.has('portfolioDiv')) bits.push('Portfolio VaR');
  if (a.has('carryOptim')) bits.push('Buffer Carry target');
  if (a.has('floorH')) bits.push('Min floor');
  return bits.length > 0 ? bits.join(' · ') : 'Unfunded trough (no layer)';
}

/**
 * Tail mass at a VaR/CFaR confidence chip: 90% → 10%, 95% → 5%, 99% → 1%.
 * Ranking score for E[return] on standing CFaR. Not E[max(0,−X)] of the
 * implied normal — that is ~24% of standing at 95% and flips the open arm.
 */
export function cfarTailProbability(confidencePct: number): number {
  if (!Number.isFinite(confidencePct)) return 0;
  return Math.max(0, Math.min(1, (100 - confidencePct) / 100));
}

/** Same as the confidence chip tail — used by E[loss] on standing CFaR. */
export function cfarExpectedLossWeight(confidencePct: number): number {
  return cfarTailProbability(confidencePct);
}

/**
 * Standing / hedgeable CFaR orthogonal to the residual floor.
 * Frontier (and displayed Net) RSS the section with the S-leg:
 *   X = √(floor² + standing²)  →  standing = √(max(0, X² − floor²)).
 * Origin / fully flattened: X = floor → standing = 0. Do not invert σ
 * from the total quantile — that haircuts unhedgeable cash-path CFaR.
 */
export function hedgeableCfarUsdM(
  cfarUsdM: number,
  floorCfarUsdM = 0,
): number {
  const x = Number.isFinite(cfarUsdM) ? Math.max(0, cfarUsdM) : 0;
  const floor = Number.isFinite(floorCfarUsdM) ? Math.max(0, floorCfarUsdM) : 0;
  if (x <= floor + 1e-12) return 0;
  return Math.sqrt(x * x - floor * floor);
}

export function expectedCfarLossUsdM(
  cfarUsdM: number,
  confidencePct: number,
  floorCfarUsdM = 0,
): number {
  return hedgeableCfarUsdM(cfarUsdM, floorCfarUsdM)
    * cfarExpectedLossWeight(confidencePct);
}

/**
 * Ranking score: certain carry minus tail × standing CFaR.
 * Origin / flattened: standing = 0 → E[return] = carry.
 * One-sided E[max(0,−X)] = σ/√(2π) scales with |S| like open cash and
 * mirrors the green arm below zero — do not use it here.
 */
export function probabilityWeightedReturnUsdM(
  carryUsdM: number,
  cfarUsdM: number,
  confidencePct: number,
  floorCfarUsdM = 0,
): number {
  const carry = Number.isFinite(carryUsdM) ? carryUsdM : 0;
  return carry - expectedCfarLossUsdM(cfarUsdM, confidencePct, floorCfarUsdM);
}

/**
 * Residual FX Δ: 0 = book flattened (hedged), 1 = book left open.
 * Certain carry is Cash + FWD + Swap cash + CIP × (1−Δ). Expected return nets
 * E[loss] on standing CFaR above the flattened floor, not the residual
 * quantile itself.
 */
export interface ResidualWeightedReturn {
  delta: 0 | 1;
  carryUsdM: number;
  cfarUsdM: number;
  weightedUsdM: number;
}

export function certainCarryAtResidualUsdM(
  c: Pick<
    LiquidityStrategyCcy,
    | 'cashCarryUsdYrM'
    | 'hedgeCarryUsdYrM'
    | 'swapInterestUsdYrM'
    | 'cipFullUsdYrM'
  >,
  delta: number,
): number {
  const hedged = 1 - clampHedgeDelta(delta);
  return (
    usdMToCarryK(c.cashCarryUsdYrM)
    + usdMToCarryK(c.hedgeCarryUsdYrM)
    + usdMToCarryK(c.swapInterestUsdYrM)
    + usdMToCarryK(c.cipFullUsdYrM * hedged)
  ) / 1000;
}

function residualRiskOverlay(
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
    delta: residual,
    exposureLocalM: E,
    swapNearLocalM: S,
    swapStandingLocalM: standing,
    forwardLocalM: dust(-(1 - residual) * net),
    remainingFarLocalM: dust(-residual * S),
    residualNearLocalM: dust(residual * S),
    finalNetLocalM: dust(residual * net),
  };
}

function displayedCfarAtResidual(
  result: LiquidityStrategyResult,
  input: LiquidityStrategyInput,
  delta: number,
): Record<string, number> {
  if (!input.setup) {
    return Object.fromEntries(result.byCcy.map(c => [c.ccy, c.cfarUsdM]));
  }
  const rowByCcy = new Map(input.rows.map(r => [r.ccy, r]));
  const overlays: Record<string, SwapForwardOverlay> = {};
  const planByCcy = Object.fromEntries(result.byCcy.map(c => [c.ccy, c.plan]));
  for (const c of result.byCcy) {
    const row = rowByCcy.get(c.ccy);
    if (!row) continue;
    overlays[c.ccy] = residualRiskOverlay(row, c.plan, delta);
  }
  const fx = fxHedgeMcCfarByCcy({
    rows: input.rows,
    setup: input.setup,
    forecastProfile: input.forecastProfile,
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    marketRatesByCcy: input.marketRatesByCcy,
    ratesScopeId: input.ratesScopeId,
    swapForwardOverlayByCcy: overlays,
  });
  return displayedCfarNetByCcyUsdM(fx, {
    setup: input.setup,
    fundingPlanByCcy: planByCcy,
    swapForwardOverlayByCcy: overlays,
  });
}

function residualSlice(
  result: LiquidityStrategyResult,
  cfarByCcy: Record<string, number>,
  delta: 0 | 1,
  confidencePct: number,
  floorCfarUsdM: number,
): ResidualWeightedReturn {
  const carryUsdM = result.byCcy.reduce(
    (s, c) => s + certainCarryAtResidualUsdM(c, delta),
    0,
  );
  const cfarUsdM = result.byCcy.reduce(
    (s, c) => s + (cfarByCcy[c.ccy] ?? 0),
    0,
  );
  return {
    delta,
    carryUsdM,
    cfarUsdM,
    weightedUsdM: probabilityWeightedReturnUsdM(
      carryUsdM, cfarUsdM, confidencePct, floorCfarUsdM,
    ),
  };
}

/** Certain carry + CFaR tail at residual Δ=0 (hedged) and Δ=1 (open). */
export function weightedReturnByResidualDelta(
  result: LiquidityStrategyResult,
  input: LiquidityStrategyInput,
  confidencePct: number,
): {
  hedged: ResidualWeightedReturn;
  open: ResidualWeightedReturn;
  cfarHedgedByCcy: Record<string, number>;
  cfarOpenByCcy: Record<string, number>;
} {
  const cfarHedgedByCcy = displayedCfarAtResidual(result, input, 0);
  const cfarOpenByCcy = displayedCfarAtResidual(result, input, 1);
  const floorCfarUsdM = result.byCcy.reduce(
    (s, c) => s + (cfarHedgedByCcy[c.ccy] ?? 0),
    0,
  );
  return {
    hedged: residualSlice(result, cfarHedgedByCcy, 0, confidencePct, floorCfarUsdM),
    open: residualSlice(result, cfarOpenByCcy, 1, confidencePct, floorCfarUsdM),
    cfarHedgedByCcy,
    cfarOpenByCcy,
  };
}

export function rowWeightedReturnAtResidualUsdM(
  c: LiquidityStrategyCcy,
  cfarUsdM: number,
  delta: number,
  confidencePct: number,
  floorCfarUsdM = 0,
): number {
  return probabilityWeightedReturnUsdM(
    certainCarryAtResidualUsdM(c, delta),
    cfarUsdM,
    confidencePct,
    floorCfarUsdM,
  );
}

export interface LiquidityStrategyInput {
  rows: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  /** Forecast cycles to run. Below 1 there is no path and nothing to compare. */
  months: number;
  shared: SharedGlobals;
  /** Defaults to `FUNDING_POLICY_LAYERS`. */
  activeLayers?: Set<LayerId>;
  hedgeSettleByCcy?: HedgeSettleByCcy;
  /**
   * Desk-computed funded plan per CCY. The strategy that matches the book's
   * live regime uses this strip instead of recomputing one that can diverge
   * (book-target iteration, carry / VaR layers, the no-layer gate).
   */
  livePlanByCcy?: Readonly<Record<string, readonly LiquidityCycleProjection[]>>;
  /** FX-hedge Net CFaR per CCY (USD M) — sizes the CFaR cover layer. */
  cfarNetByCcyUsd?: Record<string, number>;
  /** Closed-form displayed CFaR (FX hedge + this strategy's funding book). */
  setup?: VarSetup;
  bookedHedges?: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  ratesScopeId?: string;
  /**
   * Desk Swap+Fwd overlays. Live CIP scales by (1−Δ) (or the desk CIP map);
   * `livePlanByCcy` stays the unscaled standing book.
   */
  swapForwardOverlayByCcy?: Readonly<Record<string, SwapForwardOverlay>>;
  /** Desk Hedge carry per CCY ($M p.a.) — the map the P&L row already prints. */
  deskHedgeCarryByCcyUsdM?: Record<string, number>;
  /**
   * Desk Cash Carry per CCY ($M) — staged dual-book cash when a hedge is on.
   * Unhedged names fall through to cycle-1 LP NIM, the same `floatNim` the
   * Liquidity P&L prints.
   */
  deskCashCarryByCcyUsdM?: Record<string, number>;
  /**
   * Desk FX HEDGE CIP per CCY ($M) — already Δ-scaled. Live regime prints this
   * instead of re-deriving far-leg points, so Analytics cannot drift from the
   * Liquidity CIP column.
   */
  deskCipByCcyUsdM?: Record<string, number>;
}

/** Desk `liquidityPlan` keyed by currency — the strip Analytics / Decision consume. */
export function livePlanByCcyFrom(
  rows: readonly { ccy: string; liquidityPlan?: readonly LiquidityCycleProjection[] }[],
): Record<string, LiquidityCycleProjection[]> {
  const out: Record<string, LiquidityCycleProjection[]> = {};
  for (const r of rows) {
    if (r.liquidityPlan && r.liquidityPlan.length > 0) {
      out[r.ccy] = [...r.liquidityPlan];
    }
  }
  return out;
}

/** One currency's funding programme under one strategy. */
export interface LiquidityStrategyCcy {
  ccy: string;
  spot: number;
  cycles: number;
  /** Near leg for the cycle in front of us (M FCY). */
  bookNow: number;
  /** Notional traded today — the spot leg plus any leg pre-booked forward. */
  committedToday: number;
  /** Peak swap notional outstanding over the horizon (M FCY). */
  peakBook: number;
  /** Mean outstanding across cycles — what the USD give-up accrues on. */
  avgBook: number;
  /** Mean positive FCY balance on this strategy's dated path. */
  avgCredit: number;
  /** Mean negative FCY balance on that path (≤ 0). */
  avgDebit: number;
  /** USD forgone to hold the swap book, $M p.a. */
  usdGiveUpUsdYrM: number;
  /** Interest earned on positive FCY balances, $M p.a. (≥ 0). */
  fcyEarnedUsdYrM: number;
  /** Overdraft interest paid on negative balances, $M p.a. (≥ 0). */
  odPaidUsdYrM: number;
  /** Unfunded cash carry vs USD — FX path only, no funding swap ($M p.a. P&L). */
  cashCarryUsdYrM: number;
  /** Desk Hedge Cash / FWD pts ($M p.a.) — same on every strategy. */
  hedgeCarryUsdYrM: number;
  /** FCY O/N on the funding-swap standing book ($M p.a. P&L). */
  swapOnUsdYrM: number;
  /** Funding-swap far-leg CIP from Market data swap points ($M). */
  swapPointsUsdYrM: number;
  /** Funding-swap cash leg: Σ cycle cash Δr vs USD. Desk Swap Carry column. */
  swapInterestUsdYrM: number;
  /**
   * Unscaled CIP / FWD pts ($M p.a.) — residual Δ=0 (fully hedged).
   * Displayed CIP is this × (1−Δ_live).
   */
  cipFullUsdYrM: number;
  /** Swap cash + Swap points. ~0 when the far leg prices at CIP mid. */
  swapCarryUsdYrM: number;
  /** −(cash + hedge + swapCarry). Cost framing for the cards and the tab rail. */
  netCostUsdYrM: number;
  /** Deepest low on the funded dated path (M FCY). */
  trough: number;
  /** Cycles whose low sits under the cash floor. */
  floorBreaches: number;
  /** Deepest shortfall of a cycle low against its own cushion H* (≤ 0). */
  gapToThreshold: number;
  /** Trades the desk has to put on over the horizon. */
  marketTrips: number;
  plan: readonly LiquidityCycleProjection[];
  schedule: readonly LiquiditySwapLegRow[];
  /** Displayed Net CFaR (USD M) — FX hedge + this strategy's funding-swap bridge. */
  cfarUsdM: number;
}

/** Funding-strip cycle: cash Δr + CIP on the standing book (same basis as the row). */
export interface LiquiditySwapLegRow extends SwapLegScheduleRow {
  fcyOnUsdYr: number;
  usdOnUsdYr: number;
  pointsUsdYr: number;
  /** Every funding leg is a swap (near + far) — points always apply. */
  hasPoints: boolean;
  /** FCY O/N + USD O/N — the rate-diff carry. Points offset this at CIP mid. */
  interestUsdYr: number;
  netUsdYr: number;
}

/** Display $k — same integer rounding the Liquidity P&L uses for |k| ≥ 10. */
export function usdMToCarryK(usdM: number): number {
  const k = usdM * 1000;
  if (!Number.isFinite(k) || Math.abs(k) < 0.5) return 0;
  return Math.round(k);
}

export function strategyBookCarryK(
  byCcy: readonly Pick<
    LiquidityStrategyCcy,
    | 'cashCarryUsdYrM'
    | 'hedgeCarryUsdYrM'
    | 'swapInterestUsdYrM'
    | 'swapPointsUsdYrM'
  >[],
): { cash: number; hedge: number; swap: number; cip: number; total: number } {
  const cash = byCcy.reduce((s, c) => s + usdMToCarryK(c.cashCarryUsdYrM), 0);
  const hedge = byCcy.reduce((s, c) => s + usdMToCarryK(c.hedgeCarryUsdYrM), 0);
  const swap = byCcy.reduce((s, c) => s + usdMToCarryK(c.swapInterestUsdYrM), 0);
  const cip = byCcy.reduce((s, c) => s + usdMToCarryK(c.swapPointsUsdYrM), 0);
  return { cash, hedge, swap, cip, total: cash + hedge + swap + cip };
}

export function swapLegScheduleWithCarry(
  schedule: readonly SwapLegScheduleRow[],
  spot: number,
  r_FCY: number,
  r_USD: number,
  r_OD?: number,
  opts?: {
    bundle?: FxMarketRatesBundle | null;
    /** Far-leg tenor — term uses the horizon on the first cycle only; rolling is 1M each. */
    farSettleMonths?: number;
    /** Live Swap+Fwd Δ retention — same scale as the desk CIP column. */
    cipScale?: number;
  },
): LiquiditySwapLegRow[] {
  const farMonths = Math.max(1, opts?.farSettleMonths ?? 1);
  const cipScale = opts?.cipScale ?? 1;
  const monthFrac = 1 / 12;
  const term = farMonths > 1;
  return schedule.map((l, i) => {
    const standing = l.outstanding;
    const fcyRate = fundingSwapCashFcyRate(standing, r_FCY, r_OD);
    const fcyOnUsdYr = standing * (fcyRate / 100) * spot * monthFrac;
    const usdOnUsdYr = -standing * (r_USD / 100) * spot * monthFrac;
    const interestUsdYr = fundingSwapCashDeltaUsdYr(
      standing, spot, r_FCY, r_USD, r_OD,
    ) * monthFrac;
    const settleMonths = term ? (i === 0 ? farMonths : 0) : 1;
    const fallbackPts = settleMonths === 0
      ? 0
      : fundingSwapOverlayUsdYr(
          standing, spot, r_FCY, r_USD, r_OD,
        ).pointsUsdYr * (settleMonths / 12);
    const pointsUsdYr = settleMonths === 0
      ? 0
      : fundingSwapFarLegCipUsdM({
          standingLocalM: standing,
          settleMonths,
          bundle: opts?.bundle,
          fallbackUsdM: fallbackPts,
        }) * cipScale;
    return {
      ...l,
      fcyOnUsdYr,
      usdOnUsdYr,
      pointsUsdYr,
      hasPoints: settleMonths > 0,
      interestUsdYr,
      netUsdYr: interestUsdYr + pointsUsdYr,
    };
  });
}

export interface LiquidityStrategyResult {
  strategy: LiquidityStrategy;
  byCcy: LiquidityStrategyCcy[];
  /** Notional to trade today across the book, USD $M at spot. */
  committedTodayUsdM: number;
  /** Near legs for the cycle in front of us, USD $M at spot. */
  bookNowUsdM: number;
  /** Peak swap book across the horizon, USD $M at spot. */
  peakBookUsdM: number;
  usdGiveUpUsdYrM: number;
  fcyEarnedUsdYrM: number;
  odPaidUsdYrM: number;
  cashCarryUsdYrM: number;
  hedgeCarryUsdYrM: number;
  swapOnUsdYrM: number;
  swapPointsUsdYrM: number;
  swapInterestUsdYrM: number;
  swapCarryUsdYrM: number;
  netCostUsdYrM: number;
  marketTrips: number;
  floorBreaches: number;
  /** Worst per-currency shortfall against H*, in USD $M (≤ 0). */
  gapToThresholdUsdM: number;
  /** What sizes H* on this book — VaR, Carry, or Balance. */
  constraint: BufferConstraint;
  /** Layer names behind the constraint. */
  constraintDetail: string;
  /**
   * Displayed Net CFaR (USD M) — FX hedge + this strategy's funding-swap
   * bridge. 0 when setup was not passed (cover-sizing callers).
   */
  finalCfarUsdM: number;
}

interface PathStats {
  avgCredit: number;
  avgDebit: number;
  trough: number;
  floorBreaches: number;
}

function cfarCoverFcyFor(ccy: string, netByCcy?: Record<string, number>): number {
  const usd = netByCcy?.[ccy];
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0.001) return 0;
  return usdToFcyM(usd, ccy);
}

/**
 * Funding-swap overlay for one currency:
 *   cash  — `fundingSwapCarryLegs` (same call as the desk P&L Buffer Carry)
 *   points — Market data far-leg CIP via `fundingSwapPathFarCipUsdM`
 *            (rolling = Σ 1M; term = one far tenor on M1 standing)
 *            Live regime scales by (1−Δ), same as the desk CIP column.
 */
function liveCipRetention(
  ccy: string,
  strategy: LiquidityStrategy,
  liveStrategyId: LiquidityStrategyId,
  overlays?: Readonly<Record<string, SwapForwardOverlay>>,
): number {
  if (strategy.id !== liveStrategyId) return 1;
  const overlay = overlays?.[ccy];
  if (!overlay) return 1;
  return 1 - clampHedgeDelta(overlay.delta);
}

function deskSwapOverlay(
  row: RowState,
  input: LiquidityStrategyInput,
  plan: readonly LiquidityCycleProjection[],
  cipScale = 1,
): { fcyOnUsdYr: number; pointsUsdYr: number; interestUsdYr: number; netUsdYr: number } {
  const legs = fundingSwapCarryLegs({
    ccy: row.ccy,
    plan,
    r_FCY: row.r_FCY,
    r_USD: input.shared.r_USD,
    r_OD: row.r_OD,
  });
  const spot = ccySpotRate(row.ccy);
  const standingFallback = swapFarLegNotional(
    plan,
    plan[0]?.swap_needed ?? 0,
  );
  const pointsUsdYr = fundingSwapPathFarCipUsdM({
    plan,
    standingFallback,
    forecastMonths: input.shared.forecastMonths ?? input.months,
    bundle: resolveMarketRatesForCcy(
      input.marketRatesByCcy, row.ccy, input.ratesScopeId,
    ),
    fallbackAnnualUsdYr: S =>
      fundingSwapCipPointsUsdYr(S, spot, row.r_FCY, input.shared.r_USD),
  }) * cipScale;
  return {
    fcyOnUsdYr: legs.fcyOnUsdM,
    pointsUsdYr,
    interestUsdYr: legs.cashUsdM,
    netUsdYr: legs.cashUsdM + pointsUsdYr,
  };
}

function unfundedCashCarryUsdYr(
  split: { avgCredit: number; avgDebit: number },
  spot: number,
  r_FCY: number,
  r_OD: number,
  r_USD: number,
): number {
  return (split.avgCredit * (r_FCY - r_USD) + split.avgDebit * (r_OD - r_USD)) / 100 * spot;
}

/**
 * Interest split and low of a dated path, with each cycle lifted by the cash its
 * own near leg landed. Shifting is legitimate because the shape is invariant to
 * funding — a leg landing before the first payout raises every day of the cycle
 * by the same amount, leaving the drain and the net change untouched.
 *
 * Interest accrues on end-of-day balances; the low is the intraday one, after
 * that day's outflows and before its inflows, which is the number the floor and
 * H* are tested against.
 */
function pathStats(
  ladder: LiquidityLadderResult,
  shiftByCycle: readonly number[],
  floor: number,
): PathStats {
  let creditSum = 0;
  let debitSum = 0;
  let days = 0;
  let floorBreaches = 0;
  let trough = Number.POSITIVE_INFINITY;

  ladder.cycles.forEach((cycle, k) => {
    const shift = shiftByCycle[k] ?? 0;
    const slice = ladder.closingByDay.slice(cycle.startDay, cycle.endDay + 1);
    const split = carrySplitFromBalances(slice, shift);
    creditSum += split.avgCredit * slice.length;
    debitSum += split.avgDebit * slice.length;
    days += slice.length;

    const low = roundMoney(cycle.low + shift);
    if (low < floor - 1e-9) floorBreaches += 1;
    if (low < trough) trough = low;
  });

  return {
    avgCredit: days > 0 ? creditSum / days : 0,
    avgDebit: days > 0 ? debitSum / days : 0,
    trough: Number.isFinite(trough) ? trough : ladder.opening,
    floorBreaches,
  };
}

/**
 * Deepest shortfall of the unfunded path against the policy cushion, cycle by
 * cycle. The funded strategies read this off their own plan; the baseline has
 * no plan, so H* is re-run here on the same layer stack with the unfunded
 * openings — the requirement does not go away just because nothing funds it.
 */
function unfundedGapToThreshold(
  row: RowState,
  ladder: LiquidityLadderResult,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  forecastProfile: ForecastProfileState | null | undefined,
  cfarCoverFcy = 0,
): number {
  const flows = monthFlowSeriesForRow(row, ladder.cycles.length, forecastProfile);
  let worst = 0;
  ladder.cycles.forEach((cycle, k) => {
    const layered = computeLayeredBuffer(
      Math.abs(flows[k]?.payout ?? 0),
      cycle.low,
      shared.σ_P,
      shared.r_USD,
      row.r_FCY,
      row.r_OD,
      row.cash_floor,
      activeLayers,
      cycle.opening,
      row.carry_target,
      cfarCoverFcy,
    );
    worst = Math.min(worst, cycle.low - layered.cash_threshold);
  });
  return roundMoney(worst);
}

function evaluateCcy(
  row: RowState,
  ladder: LiquidityLadderResult,
  strategy: LiquidityStrategy,
  input: LiquidityStrategyInput,
  activeLayers: Set<LayerId>,
  liveStrategyId: LiquidityStrategyId,
): LiquidityStrategyCcy {
  const spot = ccySpotRate(row.ccy);
  const cycles = ladder.cycles.length;
  const hedgeSettle = input.hedgeSettleByCcy?.[row.ccy];
  const cfarCoverFcy = cfarCoverFcyFor(row.ccy, input.cfarNetByCcyUsd);
  const deskPlan = input.livePlanByCcy?.[row.ccy];
  const useDeskStrip =
    strategy.regime !== null
    && strategy.id === liveStrategyId
    && deskPlan != null
    && deskPlan.length > 0;

  const plan: LiquidityCycleProjection[] =
    strategy.regime === null
      ? []
      : useDeskStrip
        ? [...deskPlan]
        : fundedPlanFor(
            row,
            input.shared,
            activeLayers,
            ladder,
            input.forecastProfile,
            hedgeSettle,
            undefined,
            strategy.regime.bookingMode,
            cfarCoverFcy,
          );
  const farSettleMonths =
    strategy.regime?.bookingMode === 'term'
      ? fundingSwapFarSettleMonths(plan, input.shared.forecastMonths ?? input.months)
      : 1;
  const cipScale = liveCipRetention(
    row.ccy, strategy, liveStrategyId, input.swapForwardOverlayByCcy,
  );
  const schedule = swapLegScheduleWithCarry(
    plan.length > 0 ? swapLegSchedule(plan) : [],
    spot,
    row.r_FCY,
    input.shared.r_USD,
    row.r_OD,
    {
      bundle: resolveMarketRatesForCcy(
        input.marketRatesByCcy, row.ccy, input.ratesScopeId,
      ),
      farSettleMonths,
      cipScale,
    },
  );

  // A leg lands before the cycle's first payout, so the whole cycle sits that
  // much higher than the unfunded ladder shows it.
  const shiftByCycle = ladder.cycles.map((cycle, k) => {
    const cyclePlan = plan[k];
    return cyclePlan ? cyclePlan.post_swap_cash - cycle.opening : 0;
  });
  const stats = pathStats(ladder, shiftByCycle, ladder.floor);

  const book = plan.map(p => p.standing_swap);
  const peakBook = book.reduce(
    (best, v) => (Math.abs(v) > Math.abs(best) ? v : best),
    0,
  );
  const avgBook = book.length > 0 ? book.reduce((s, v) => s + v, 0) / book.length : 0;

  const usdGiveUpUsdYrM = avgBook * spot * (input.shared.r_USD / 100);
  const fcyEarnedUsdYrM = stats.avgCredit * spot * (row.r_FCY / 100);
  const odPaidUsdYrM = -stats.avgDebit * spot * (row.r_OD / 100);

  // Cash Carry is the desk P&L number: staged dual-book cash when a hedge is
  // on, otherwise cycle-1 unfunded LP NIM (`floatNim`). Same on every strategy
  // — the funding swap is Swap cash, not a second cash-carry figure.
  const deskCash = input.deskCashCarryByCcyUsdM?.[row.ccy];
  const cashCarryUsdYrM =
    typeof deskCash === 'number' && Number.isFinite(deskCash)
      ? deskCash
      : unfundedCashCarryUsdYr(
          cycleCarrySplit(ladder, 0),
          spot, row.r_FCY, row.r_OD, input.shared.r_USD,
        );
  const deskHedge = input.deskHedgeCarryByCcyUsdM?.[row.ccy];
  const hedgeCarryUsdYrM =
    typeof deskHedge === 'number' && Number.isFinite(deskHedge) ? deskHedge : 0;
  const overlayFull = deskSwapOverlay(row, input, plan, 1);
  const overlay = cipScale === 1
    ? overlayFull
    : deskSwapOverlay(row, input, plan, cipScale);
  const deskCip = input.deskCipByCcyUsdM?.[row.ccy];
  let cipFullUsdYrM = overlayFull.pointsUsdYr;
  let pointsUsdYr = overlay.pointsUsdYr;
  if (
    strategy.id === liveStrategyId
    && typeof deskCip === 'number'
    && Number.isFinite(deskCip)
  ) {
    pointsUsdYr = deskCip;
    if (cipScale > 1e-9) cipFullUsdYrM = deskCip / cipScale;
  }
  const cashCarryRounded = roundMoney(cashCarryUsdYrM);
  const hedgeCarryRounded = roundMoney(hedgeCarryUsdYrM);
  const swapInterestUsdYrM = roundMoney(overlayFull.interestUsdYr);
  const swapPointsUsdYrM = roundMoney(pointsUsdYr);
  cipFullUsdYrM = roundMoney(cipFullUsdYrM);
  const totalCarryUsdYrM = roundMoney(
    cashCarryRounded + hedgeCarryRounded + swapInterestUsdYrM + swapPointsUsdYrM,
  );

  const gapToThreshold =
    strategy.regime === null
      ? unfundedGapToThreshold(
          row, ladder, input.shared, activeLayers, input.forecastProfile, cfarCoverFcy,
        )
      : roundMoney(
          plan.reduce(
            (worst, p) =>
              Math.min(worst, p.forecasted_cash + p.swap_needed - p.cash_threshold),
            0,
          ),
        );

  // Trips to market, not legs: the rolling programme prices its whole strip
  // today, so it costs one visit however many legs it carries.
  const marketTrips =
    strategy.id === 'unfunded'
      ? 0
      : strategy.id === 'nearCycle'
        ? schedule.length
        : Math.min(1, schedule.length);
  const committedToday =
    strategy.id === 'nearCycle'
      ? (schedule[0]?.newLeg ?? 0)
      : schedule.reduce((s, l) => s + l.newLeg, 0);

  const rawSchedulePts = schedule.reduce((s, l) => s + l.pointsUsdYr, 0);
  const legs =
    schedule.length === 0
      ? schedule
      : Math.abs(rawSchedulePts) > 1e-12
        ? schedule.map(l => {
            const factor = swapPointsUsdYrM / rawSchedulePts;
            return {
              ...l,
              pointsUsdYr: l.pointsUsdYr * factor,
              netUsdYr: l.interestUsdYr + l.pointsUsdYr * factor,
            };
          })
        : Math.abs(swapPointsUsdYrM) < 1e-12
          ? schedule
          : schedule.map((l, i) =>
              i === 0
                ? {
                    ...l,
                    pointsUsdYr: swapPointsUsdYrM,
                    hasPoints: true,
                    netUsdYr: l.interestUsdYr + swapPointsUsdYrM,
                  }
                : l,
            );

  return {
    ccy: row.ccy,
    spot,
    cycles,
    bookNow: roundMoney(plan[0]?.swap_needed ?? 0),
    committedToday: roundMoney(committedToday),
    peakBook: roundMoney(peakBook),
    avgBook: roundMoney(avgBook),
    avgCredit: roundMoney(stats.avgCredit),
    avgDebit: roundMoney(stats.avgDebit),
    usdGiveUpUsdYrM: roundMoney(usdGiveUpUsdYrM),
    fcyEarnedUsdYrM: roundMoney(fcyEarnedUsdYrM),
    odPaidUsdYrM: roundMoney(odPaidUsdYrM),
    cashCarryUsdYrM: cashCarryRounded,
    hedgeCarryUsdYrM: hedgeCarryRounded,
    swapOnUsdYrM: roundMoney(overlayFull.fcyOnUsdYr),
    swapPointsUsdYrM,
    cipFullUsdYrM,
    swapInterestUsdYrM,
    swapCarryUsdYrM: roundMoney(swapInterestUsdYrM + swapPointsUsdYrM),
    netCostUsdYrM: roundMoney(-totalCarryUsdYrM),
    trough: stats.trough,
    floorBreaches: stats.floorBreaches,
    gapToThreshold,
    marketTrips,
    plan,
    schedule: legs,
    cfarUsdM: 0,
  };
}

/**
 * Every strategy priced over the same dated path, in declaration order.
 *
 * USD rows are skipped: the swap funds an FCY position out of USD, so USD is
 * the funding side of the trade rather than a book that needs covering.
 */
export function evaluateLiquidityStrategies(
  input: LiquidityStrategyInput,
): LiquidityStrategyResult[] {
  const months = Math.floor(input.months);
  if (!(months > 0)) return [];
  const activeLayers =
    input.activeLayers ?? new Set<LayerId>(FUNDING_POLICY_LAYERS);
  const timing = resolveLiquidityTiming(input.forecastProfile);
  const liveStrategyId = strategyForRegime(
    timing?.sizingBasis ?? 'horizon',
    timing?.bookingMode ?? 'rolling',
  ).id;

  const paths = input.rows
    .filter(row => row.ccy && row.ccy !== 'USD')
    .map(row => ({
      row,
      ladder: buildLiquidityLadder(row, input.forecastProfile, {
        months,
        opening: row.cash,
        floor: row.cash_floor,
        hedgeSettle: input.hedgeSettleByCcy?.[row.ccy],
      }),
    }));
  if (paths.length === 0) return [];

  const fxCfarByCcy = input.setup
    ? fxHedgeMcCfarByCcy({
        rows: input.rows,
        setup: input.setup,
        forecastProfile: input.forecastProfile,
        bookedHedges: input.bookedHedges,
        preparedByCcy: input.preparedByCcy,
        marketRatesByCcy: input.marketRatesByCcy,
        ratesScopeId: input.ratesScopeId,
        swapForwardOverlayByCcy: input.swapForwardOverlayByCcy,
      })
    : {};

  return LIQUIDITY_STRATEGIES.map(strategy => {
    const byCcy = paths.map(({ row, ladder }) =>
      evaluateCcy(row, ladder, strategy, input, activeLayers, liveStrategyId),
    );
    const sumUsd = (pick: (c: LiquidityStrategyCcy) => number): number =>
      roundMoney(byCcy.reduce((s, c) => s + pick(c) * c.spot, 0));
    const sum = (pick: (c: LiquidityStrategyCcy) => number): number =>
      roundMoney(byCcy.reduce((s, c) => s + pick(c), 0));

    const planByCcy = Object.fromEntries(byCcy.map(c => [c.ccy, c.plan]));
    const cfarByCcy = input.setup
      ? displayedCfarNetByCcyUsdM(fxCfarByCcy, {
          setup: input.setup,
          fundingPlanByCcy: planByCcy,
          swapForwardOverlayByCcy: input.swapForwardOverlayByCcy,
        })
      : {};
    const byCcyWithCfar = byCcy.map(c => ({
      ...c,
      cfarUsdM: cfarByCcy[c.ccy] ?? 0,
    }));
    const finalCfarUsdM = input.setup ? sumNetCfarUsdM(cfarByCcy) : 0;

    return {
      strategy,
      byCcy: byCcyWithCfar,
      committedTodayUsdM: sumUsd(c => c.committedToday),
      bookNowUsdM: sumUsd(c => c.bookNow),
      peakBookUsdM: sumUsd(c => c.peakBook),
      usdGiveUpUsdYrM: sum(c => c.usdGiveUpUsdYrM),
      fcyEarnedUsdYrM: sum(c => c.fcyEarnedUsdYrM),
      odPaidUsdYrM: sum(c => c.odPaidUsdYrM),
      cashCarryUsdYrM: sum(c => c.cashCarryUsdYrM),
      hedgeCarryUsdYrM: sum(c => c.hedgeCarryUsdYrM),
      swapOnUsdYrM: sum(c => c.swapOnUsdYrM),
      swapPointsUsdYrM: sum(c => c.swapPointsUsdYrM),
      swapInterestUsdYrM: sum(c => c.swapInterestUsdYrM),
      swapCarryUsdYrM: sum(c => c.swapCarryUsdYrM),
      netCostUsdYrM: sum(c => c.netCostUsdYrM),
      marketTrips: byCcy.reduce((s, c) => s + c.marketTrips, 0),
      floorBreaches: byCcy.reduce((s, c) => s + c.floorBreaches, 0),
      gapToThresholdUsdM: roundMoney(
        byCcy.reduce((worst, c) => Math.min(worst, c.gapToThreshold * c.spot), 0),
      ),
      constraint: resolveBufferConstraint(activeLayers),
      constraintDetail: bufferConstraintDetail(activeLayers),
      finalCfarUsdM,
    };
  });
}

/** Net annual funding cost of the regime the book is running, in USD $M. */
export function liveLiquidityCostUsdYrM(
  input: LiquidityStrategyInput,
  sizingBasis: LiquiditySizingBasis,
  bookingMode: LiquidityBookingMode,
): number {
  const live = strategyForRegime(sizingBasis, bookingMode);
  const results = evaluateLiquidityStrategies(input);
  return results.find(r => r.strategy.id === live.id)?.netCostUsdYrM ?? 0;
}

/** The Analytics props this comparison is derived from. */
export interface LiquidityAnalyticsSource {
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  ratesScopeId?: string;
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  /** Desk layers — counterfactuals size H* on the same stack the book is running. */
  activeLayers?: Set<LayerId>;
  /** Toggle the same buffer-layer stack used by the Liquidity tab. */
  onLayerToggle?: (id: LayerId) => void;
  /** Open the desk settings dialog for a buffer chip (gear). */
  layerPanel?: BufferChipKey | null;
  onLayerPanelChange?: (id: BufferChipKey | null) => void;
  /** Desk-computed funded plan per CCY. Live strategy uses this strip as-is. */
  livePlanByCcy?: Readonly<Record<string, readonly LiquidityCycleProjection[]>>;
  /** FX-hedge Net CFaR per CCY (USD M) — sizes the CFaR cover layer. */
  cfarNetByCcyUsd?: Record<string, number>;
  /** Desk Swap+Fwd overlays — retention is applied inside the CFaR bridge only. */
  swapForwardOverlayByCcy?: Readonly<Record<string, SwapForwardOverlay>>;
  /**
   * The desk's own globals. `r_USD` prices the carry differential and `σ_P`
   * sizes the payout cushion that sets `standing_swap`, so re-deriving them
   * here would price a different book than the Liquidity tab is running.
   */
  deskShared?: SharedGlobals;
  /** Desk Hedge carry per CCY ($M p.a.) — the map the P&L row already prints. */
  deskHedgeCarryByCcyUsdM?: Record<string, number>;
  /** Desk Cash Carry per CCY ($M) — staged dual-book cash when a hedge is on. */
  deskCashCarryByCcyUsdM?: Record<string, number>;
  /** Desk FX HEDGE CIP per CCY ($M) — already Δ-scaled. */
  deskCipByCcyUsdM?: Record<string, number>;
  /** Shared VaR/CFaR setup editor — confidence chips on Liquidity Analytics. */
  onSetupChange?: (setup: VarSetup) => void;
}

/**
 * Evaluator input built from the Analytics panel's own props, so the headline on
 * the tab rail and the table inside the view are the same computation rather
 * than two that happen to agree.
 *
 * The USD rate comes off the same curve Cash Carry prices against, and the FCY
 * leg of every booked or prepared hedge lands on the path like any other dated
 * line — funding has to cover deliveries the desk has already committed to.
 */
export function liquidityStrategyInputFrom(
  src: LiquidityAnalyticsSource,
): LiquidityStrategyInput {
  const months = src.setup.forecastMonths;
  const usdBundle = resolveMarketRatesForCcy(
    src.marketRatesByCcy,
    'USD',
    src.ratesScopeId,
  );
  const hedgeSettleByCcy: Record<string, number[]> = {};
  if (months > 0) {
    for (const row of src.bookRows ?? []) {
      const flows = withNonCashFxConversion(
        row,
        hedgeCashFlowsByMonth({
          ccy: row.ccy,
          forecastMonths: months,
          bookedHedges: src.bookedHedges,
          preparedByCcy: src.preparedByCcy,
          setup: src.setup,
        }),
        months,
        src.forecastProfile,
      );
      if (flows.some(f => Math.abs(f) > 1e-9)) hedgeSettleByCcy[row.ccy] = flows;
    }
  }
  const deskCashCarryByCcyUsdM: Record<string, number> = {
    ...(src.deskCashCarryByCcyUsdM ?? {}),
  };
  const deskHedgeCarryByCcyUsdM: Record<string, number> = {
    ...(src.deskHedgeCarryByCcyUsdM ?? {}),
  };
  if (months > 0 && (src.bookRows?.length ?? 0) > 0) {
    const split = cashForecastCarrySplitByCcyUsdM({
      rows: src.bookRows ?? [],
      forecastProfile: src.forecastProfile,
      forecastMonths: months,
      bookedHedges: src.bookedHedges,
      preparedByCcy: src.preparedByCcy,
      setup: src.setup,
      marketRatesByCcy: src.marketRatesByCcy,
      ratesScopeId: src.ratesScopeId,
      extraForwards: analyticsForwardsFromOverlays({
        overlayByCcy: src.swapForwardOverlayByCcy,
        planByCcy: src.livePlanByCcy,
        forecastMonths: months,
      }),
    });
    for (const [ccy, legs] of Object.entries(split)) {
      if (deskCashCarryByCcyUsdM[ccy] === undefined) {
        deskCashCarryByCcyUsdM[ccy] = legs.cashUsdM;
      }
      if (deskHedgeCarryByCcyUsdM[ccy] === undefined) {
        deskHedgeCarryByCcyUsdM[ccy] = legs.fwdUsdM;
      }
    }
  }
  return {
    rows: src.bookRows ?? [],
    forecastProfile: src.forecastProfile,
    months,
    shared: src.deskShared
      ? { ...src.deskShared, forecastMonths: months }
      : {
          r_USD: resolveOvernightCashRates(usdBundle, 'USD').usd.creditPct,
          σ_P: src.setup.forecastUncertainty1m ?? 0,
          days: 3,
          forecastMonths: months,
        },
    hedgeSettleByCcy,
    activeLayers: src.activeLayers,
    livePlanByCcy: src.livePlanByCcy,
    cfarNetByCcyUsd: src.cfarNetByCcyUsd,
    setup: src.setup,
    bookedHedges: src.bookedHedges,
    preparedByCcy: src.preparedByCcy,
    marketRatesByCcy: src.marketRatesByCcy,
    ratesScopeId: src.ratesScopeId,
    swapForwardOverlayByCcy: src.swapForwardOverlayByCcy,
    deskHedgeCarryByCcyUsdM,
    deskCashCarryByCcyUsdM,
    deskCipByCcyUsdM: src.deskCipByCcyUsdM,
  };
}
