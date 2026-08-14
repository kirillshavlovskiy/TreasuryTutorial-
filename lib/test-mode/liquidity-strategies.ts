// Funding programmes for the liquidity position, priced against each other.
//
// The dated path (`buildLiquidityLadder`) says how deep the book dips and when.
// It does not say how the desk covers the dip, and the cover is a real choice
// with a real price: run the overdraft, buy a leg per cycle, or commit one term
// swap today. This module runs each of those over the same path and charges
// them on the same interest ledger, so the comparison is like for like.
//
// The carry ledger matches the desk: unfunded cash carry (FX path only) plus
// the funding-swap overlay (FCY O/N + USD O/N + CIP mid points). The overlay
// nets to 0 at mid, so strategies differ in the book they put on — peak, trips,
// the gap vs H* — not in a second cash-carry number that loops back into CFaR.
//
//   Cash Carry  = unfunded path × (r_actual − r_USD)     same on every strategy
//   Swap Carry  = overlay on that strategy's avg book    0 at CIP mid
//   net cost    = −(Cash Carry + Swap Carry)
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
  swapLegSchedule,
  type ForecastProfileState,
  type LiquidityCycleProjection,
  type SwapLegScheduleRow,
} from '@/lib/forecast-profile';
import {
  resolveMarketRatesForCcy,
  resolveOvernightCashRates,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { hedgeCashFlowsByMonth, withNonCashFxConversion } from '@/lib/test-mode/cash-carry-analytics';
import { fxHedgeNetCfarByCcyUsdM, sumNetCfarUsdM } from '@/lib/test-mode/cfar-net-by-ccy';
import type { HedgeTicket, PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import type { VarSetup } from '@/lib/test-mode/var-setup';
import {
  ccySpotRate,
  computeLayeredBuffer,
  fundingSwapOverlayUsdYr,
  roundMoney,
  usdToFcyM,
  type LayerId,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import {
  buildLiquidityLadder,
  carrySplitFromBalances,
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
  if (a.has('cfarCover') || a.has('portfolioDiv') || a.has('sigmaP')) return 'var';
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
  if (a.has('cfarCover')) bits.push('CFaR cover');
  if (a.has('portfolioDiv')) bits.push('Portfolio VaR');
  if (a.has('sigmaP')) bits.push('Payout σ');
  if (a.has('carryOptim')) bits.push('Carry target');
  if (a.has('floorH')) bits.push('Min floor');
  return bits.length > 0 ? bits.join(' · ') : 'Unfunded trough (no layer)';
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
  /** FCY O/N on the funding-swap notional ($M p.a. P&L). */
  swapOnUsdYrM: number;
  /** CIP mid swap points on that notional ($M p.a. P&L). */
  swapPointsUsdYrM: number;
  /** Rate-diff carry = FCY O/N + USD O/N (= −points). The number the strip shows. */
  swapInterestUsdYrM: number;
  /** Funding-swap overlay = FCY O/N + USD O/N + points. 0 at CIP mid. */
  swapCarryUsdYrM: number;
  /** −(cashCarry + swapCarry). Cost framing for the cards and the tab rail. */
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
}

/** Funding-strip leg plus the CIP overlay on that trade (not the running book). */
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

export function swapLegScheduleWithCarry(
  schedule: readonly SwapLegScheduleRow[],
  spot: number,
  r_FCY: number,
  r_USD: number,
): LiquiditySwapLegRow[] {
  return schedule.map(l => {
    const o = fundingSwapOverlayUsdYr(l.newLeg, spot, r_FCY, r_USD);
    return {
      ...l,
      fcyOnUsdYr: o.fcyOnUsdYr,
      usdOnUsdYr: o.usdOnUsdYr,
      pointsUsdYr: o.pointsUsdYr,
      hasPoints: true,
      interestUsdYr: o.fcyOnUsdYr + o.usdOnUsdYr,
      netUsdYr: o.netUsdYr,
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

function unfundedCashCarryUsdYr(
  stats: PathStats,
  spot: number,
  r_FCY: number,
  r_OD: number,
  r_USD: number,
): number {
  return (stats.avgCredit * (r_FCY - r_USD) + stats.avgDebit * (r_OD - r_USD)) / 100 * spot;
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
  const schedule = swapLegScheduleWithCarry(
    plan.length > 0 ? swapLegSchedule(plan) : [],
    spot,
    row.r_FCY,
    input.shared.r_USD,
  );

  // A leg lands before the cycle's first payout, so the whole cycle sits that
  // much higher than the unfunded ladder shows it.
  const shiftByCycle = ladder.cycles.map((cycle, k) => {
    const cyclePlan = plan[k];
    return cyclePlan ? cyclePlan.post_swap_cash - cycle.opening : 0;
  });
  const stats = pathStats(ladder, shiftByCycle, ladder.floor);

  const book = plan.map(p => p.standing_swap);
  const peakBook = book.reduce((m, v) => Math.max(m, v), 0);
  const avgBook = book.length > 0 ? book.reduce((s, v) => s + v, 0) / book.length : 0;

  const usdGiveUpUsdYrM = avgBook * spot * (input.shared.r_USD / 100);
  const fcyEarnedUsdYrM = stats.avgCredit * spot * (row.r_FCY / 100);
  const odPaidUsdYrM = -stats.avgDebit * spot * (row.r_OD / 100);

  // Cash Carry is the unfunded path (same number on every strategy). Swap Carry
  // is the funding-swap overlay on that path — additive, CIP mid nets to 0.
  const unfunded = pathStats(ladder, ladder.cycles.map(() => 0), ladder.floor);
  const cashCarryUsdYrM = unfundedCashCarryUsdYr(
    unfunded, spot, row.r_FCY, row.r_OD, input.shared.r_USD,
  );
  const overlay = fundingSwapOverlayUsdYr(avgBook, spot, row.r_FCY, input.shared.r_USD);

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
    cashCarryUsdYrM: roundMoney(cashCarryUsdYrM),
    swapOnUsdYrM: roundMoney(overlay.fcyOnUsdYr),
    swapPointsUsdYrM: roundMoney(overlay.pointsUsdYr),
    swapInterestUsdYrM: roundMoney(overlay.fcyOnUsdYr + overlay.usdOnUsdYr),
    swapCarryUsdYrM: roundMoney(overlay.netUsdYr),
    netCostUsdYrM: roundMoney(-(cashCarryUsdYrM + overlay.netUsdYr)),
    trough: stats.trough,
    floorBreaches: stats.floorBreaches,
    gapToThreshold,
    marketTrips,
    plan,
    schedule,
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

  return LIQUIDITY_STRATEGIES.map(strategy => {
    const byCcy = paths.map(({ row, ladder }) =>
      evaluateCcy(row, ladder, strategy, input, activeLayers, liveStrategyId),
    );
    const sumUsd = (pick: (c: LiquidityStrategyCcy) => number): number =>
      roundMoney(byCcy.reduce((s, c) => s + pick(c) * c.spot, 0));
    const sum = (pick: (c: LiquidityStrategyCcy) => number): number =>
      roundMoney(byCcy.reduce((s, c) => s + pick(c), 0));

    const planByCcy = Object.fromEntries(byCcy.map(c => [c.ccy, c.plan]));
    const finalCfarUsdM = input.setup
      ? sumNetCfarUsdM(fxHedgeNetCfarByCcyUsdM({
          rows: input.rows,
          setup: input.setup,
          forecastProfile: input.forecastProfile,
          bookedHedges: input.bookedHedges,
          preparedByCcy: input.preparedByCcy,
          marketRatesByCcy: input.marketRatesByCcy,
          ratesScopeId: input.ratesScopeId,
          fundingPlanByCcy: planByCcy,
        }))
      : 0;

    return {
      strategy,
      byCcy,
      committedTodayUsdM: sumUsd(c => c.committedToday),
      bookNowUsdM: sumUsd(c => c.bookNow),
      peakBookUsdM: sumUsd(c => c.peakBook),
      usdGiveUpUsdYrM: sum(c => c.usdGiveUpUsdYrM),
      fcyEarnedUsdYrM: sum(c => c.fcyEarnedUsdYrM),
      odPaidUsdYrM: sum(c => c.odPaidUsdYrM),
      cashCarryUsdYrM: sum(c => c.cashCarryUsdYrM),
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
  /** Desk-computed funded plan per CCY. Live strategy uses this strip as-is. */
  livePlanByCcy?: Readonly<Record<string, readonly LiquidityCycleProjection[]>>;
  /** FX-hedge Net CFaR per CCY (USD M) — sizes the CFaR cover layer. */
  cfarNetByCcyUsd?: Record<string, number>;
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
  return {
    rows: src.bookRows ?? [],
    forecastProfile: src.forecastProfile,
    months,
    shared: {
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
  };
}
