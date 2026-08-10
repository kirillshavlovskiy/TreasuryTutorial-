/**
 * Analytics Cash Carry — two layers:
 * 1) Cash interest on interest-bearing cash + forecast revenue inflows
 *    (non-cash FX items excluded; path follows exposure forecast flat/custom)
 * 2) Hedge carry (prepared + booked bullet / strip) via EURUSD swap points
 */

import {
  fcyToUsdM,
  type RowState,
} from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  monthlyFlowSeriesLocalM,
  monthlyInflowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import { stripHedgeLegCarryUsdM } from '@/lib/fx-hedge';
import {
  fwdCarryFromSwapPointsUsdM,
  interpolateSwapPoints,
  resolveCashRatesForHorizon,
  resolveForwardDepositRates,
  resolveOvernightCashRates,
  selectCreditDebitRate,
  swapPointsToPriceDelta,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  isLiveHedgeTicket,
  type HedgeTicket,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import {
  endMonthsFromScheduleWeights,
  shapedStripScheduleWeights,
} from '@/lib/test-mode/rolling-hedge';
import { horizonMonths, type VarSetup } from '@/lib/test-mode/var-setup';

export interface CashInterestLayerRow {
  ccy: string;
  /** Opening interest-bearing cash (excludes receivables / non-cash FX). */
  openingCashM: number;
  /** Σ forecast Revenue / collections over the path (future cash inflows). */
  revenueInflowM: number;
  /** Σ forecast Expenses / payouts over the path (cash outflows). */
  payoutOutflowM: number;
  /** Cash at Tf after applying monthly nets to opening cash. */
  endCashM: number;
  /** Time-weighted average cash used for interest. */
  avgCashM: number;
  side: 'credit' | 'debit';
  ratePct: number;
  creditPct: number;
  debitPct: number;
  /** Horizon months for interest accrual (forecast Tf, else VaR Th). */
  months: number;
  interestUsdM: number;
  /** Exposure forecast profile mode that drove the inflow path. */
  forecastMode: 'flat' | 'custom';
  growthRateMoM: number;
}

export interface HedgeCarryLayerRow {
  ccy: string;
  ticketId: string;
  label: string;
  structure: 'bullet' | 'strip' | 'spot';
  /** Booked live ticket vs Analytics-prepared (pending Send). */
  status: 'booked' | 'prepared';
  amountLocalM: number;
  settleMonths: number;
  fwdCarryUsdM: number;
  fcyInterestUsdM: number;
  usdInterestUsdM: number;
  totalUsdM: number;
  rFcyPct: number;
  rUsdPct: number;
  fcySide: 'credit' | 'debit';
  usdSide: 'credit' | 'debit';
  swapPoints?: number;
  swapPointsSide?: 'bid' | 'ask' | 'mid';
}

/** Carry sampled along the exposure forecast path (0 → Tf). */
export interface CarryHorizonPoint {
  months: number;
  label: string;
  /** Cash interest accrued 0→t on Analytics exposure. */
  cashInterestUsdM: number;
  /**
   * Implied FWD points if the Analytics exposure were hedged with a
   * bullet settling at t (swap-points curve vs horizon).
   */
  exposureFwdCarryUsdM: number;
  /** Prepared + booked hedge carry with reporting horizon clipped to t. */
  hedgeCarryUsdM: number;
  netUsdM: number;
  swapPoints: number | null;
  swapPointsSide: 'bid' | 'ask' | 'mid' | null;
}

/**
 * Hedge improvement split for bullet / strip at reporting horizon t:
 * FWD (swap pts) + FCY int (→settle) + USD int (settle→t).
 */
export interface HedgeImprovementBreakdown {
  /** Σ incremental hedge Δ notional (FCY M). */
  hedgeDeltaLocalM: number;
  /** Swap-points / FWD carry ($M). */
  fwdCarryUsdM: number;
  /** Overnight FCY interest recognize→settle ($M). */
  fcyInterestUsdM: number;
  /** Overnight USD interest settle→t after hedge execution ($M). */
  usdInterestUsdM: number;
  /** fwd + fcy + usd. */
  totalUsdM: number;
  structure: 'bullet' | 'strip' | 'none';
  legCount: number;
}

/**
 * One column on the Cash Carry evolution bar chart.
 * Structure view: one bar per forecast month M1…MTf (cumulative dual cash book).
 * Per-leg view: one bar per strip/bullet leg (final accrued notional attribution).
 */
export interface CarryEvolutionBar {
  /** e.g. `m1` … `m12` or `leg-0` … */
  id: string;
  label: string;
  months: number;
  /** Unhedged cash interest earned M0→t ($M). */
  defaultCarryUsdM: number;
  /** Prepared + booked hedge carry accrued to t ($M). */
  hedgeImprovementUsdM: number;
  /** default + hedge improvement. */
  improvedCarryUsdM: number;
  /** Split of hedge improvement (FWD vs post-settle USD int). */
  hedgeBreakdown: HedgeImprovementBreakdown;
  /** Swap points for a bullet settle at t on this CCY exposure. */
  swapPoints: number | null;
  swapPointsSide: 'bid' | 'ask' | 'mid' | null;
  /** Implied FWD points carry if exposure hedged to settle=t. */
  exposureFwdCarryUsdM: number;
  /** Present on per-leg bars; structure bars set `'structure'`. */
  view?: 'structure' | 'leg';
  /** 0-based strip/bullet leg index (per-leg view). */
  legIndex?: number;
  /** Leg Δ notional (FCY M) for per-leg bars. */
  amountLocalM?: number;
}

export interface CashCarryAnalytics {
  cashInterest: CashInterestLayerRow[];
  hedgeCarry: HedgeCarryLayerRow[];
  /** Carry vs months — same Tf as exposure forecast. */
  horizonSeries: CarryHorizonPoint[];
  totals: {
    cashInterestUsdM: number;
    hedgeCarryUsdM: number;
    netUsdM: number;
  };
  ratesSource: string;
  /** Exposure forecast Tf (months) used for chart + accrual. */
  horizonMonths: number;
}

function exposureForSetup(
  row: CurrencyRiskRow,
  setup: VarSetup,
): { stockM: number; flowM: number; exposureM: number } {
  const stockM = row.bar.stockNetM;
  const flowM = row.bar.flowM;
  const basis = setup.exposureBasis;
  let exposureM = stockM;
  if (basis === 'simpleAvg' || basis === 'avgBuildup') {
    exposureM = stockM + flowM * 0.5;
  } else if (basis === 'totalBuildup') {
    exposureM = stockM + flowM;
  }
  return { stockM, flowM, exposureM };
}

function bookRowByCcy(
  bookRows: readonly RowState[] | undefined,
  ccy: string,
): RowState | undefined {
  return bookRows?.find(r => r.ccy === ccy);
}

/**
 * Opening cash that earns overnight interest (not receivables / debt).
 * Uses FX Risk → Cash FX (`spot`), not Liquidity → NP Cash (`cash`).
 * `Number.isFinite(cash)` is always true on RowState, so preferring cash
 * desynced Cash Carry from the Cash FX the user edits.
 */
export function interestBearingCashM(row: RowState): number {
  if (Number.isFinite(row.spot)) return row.spot;
  if (Number.isFinite(row.cash)) return row.cash;
  return 0;
}

/**
 * Per-month cash inflows — Revenue, invoice fcast, NWC / debt / invest / other.
 * Flat / MoM growth follow exposure forecast inputs; custom uses profile months.
 */
export function monthlyRevenueSeriesLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number[] {
  return monthlyInflowSeriesLocalM(row, forecastMonths, profile);
}

/**
 * Path interest on opening cash + monthly cash nets from the exposure forecast.
 * Revenue inflows join the cash pile as they arrive (linear flat, MoM growth,
 * or custom schedule). Mid-month flow convention: interest on (start+end)/2.
 */
export function cashInterestPathToHorizon(input: {
  openingCashM: number;
  monthlyNets: readonly number[];
  monthlyRevenue: readonly number[];
  creditPct: number;
  debitPct: number;
  ccy: string;
  throughMonths: number;
  /** When set, month m uses SW→1Y term cash rates (else flat credit/debit). */
  marketRates?: FxMarketRatesBundle;
}): {
  interestUsdM: number;
  revenueInflowM: number;
  payoutOutflowM: number;
  endCashM: number;
  avgCashM: number;
  side: 'credit' | 'debit';
  ratePct: number;
} {
  const T = Math.max(0, input.throughMonths);
  const usdPer = fcyToUsdM(1, input.ccy);
  if (T < 1e-12) {
    const pick = selectCreditDebitRate(
      input.openingCashM,
      input.creditPct,
      input.debitPct,
    );
    return {
      interestUsdM: 0,
      revenueInflowM: 0,
      payoutOutflowM: 0,
      endCashM: input.openingCashM,
      avgCashM: input.openingCashM,
      side: pick.side,
      ratePct: pick.ratePct,
    };
  }

  let cash = input.openingCashM;
  let interestUsdM = 0;
  let revenueInflowM = 0;
  let payoutOutflowM = 0;
  let cashTime = 0; // ∫ cash dt (month·M)
  let tLeft = T;
  let i = 0;
  const n = Math.max(input.monthlyNets.length, input.monthlyRevenue.length);

  while (tLeft > 1e-12 && i < n) {
    const dt = Math.min(1, tLeft);
    const netFull =
      i < input.monthlyNets.length && Number.isFinite(input.monthlyNets[i]!)
        ? input.monthlyNets[i]!
        : 0;
    const revFull =
      i < input.monthlyRevenue.length &&
      Number.isFinite(input.monthlyRevenue[i]!)
        ? input.monthlyRevenue[i]!
        : 0;
    const net = netFull * dt;
    const rev = revFull * dt;
    // net = collections + payout (payout ≤ 0) → outflow = −payout
    const payout = Math.max(0, -(net - rev));
    const start = cash;
    const end = cash + net;
    const avg = (start + end) / 2;
    const monthTenor = i + dt;
    const rates = input.marketRates
      ? resolveCashRatesForHorizon(input.marketRates, input.ccy, monthTenor)
      : null;
    const creditPct = rates?.fcy.creditPct ?? input.creditPct;
    const debitPct = rates?.fcy.debitPct ?? input.debitPct;
    const pick = selectCreditDebitRate(avg, creditPct, debitPct);
    interestUsdM += avg * usdPer * (pick.ratePct / 100) * (dt / 12);
    cashTime += avg * dt;
    revenueInflowM += rev;
    payoutOutflowM += payout;
    cash = end;
    tLeft -= dt;
    i++;
  }

  // If horizon longer than scheduled months, hold end cash flat.
  if (tLeft > 1e-12) {
    const pick = selectCreditDebitRate(
      cash,
      input.creditPct,
      input.debitPct,
    );
    interestUsdM += cash * usdPer * (pick.ratePct / 100) * (tLeft / 12);
    cashTime += cash * tLeft;
  }

  const avgCashM = cashTime / T;
  const pickEnd = selectCreditDebitRate(
    avgCashM,
    input.creditPct,
    input.debitPct,
  );
  return {
    interestUsdM,
    revenueInflowM,
    payoutOutflowM,
    endCashM: cash,
    avgCashM,
    side: pickEnd.side,
    ratePct: pickEnd.ratePct,
  };
}

/** One month on the cash forecast path (opening → revenue/payout/hedge → end). */
export interface CashForecastMonthRow {
  monthIndex: number;
  label: string;
  startCashM: number;
  /** USD cash book start (proceeds from prior hedge settles). */
  startUsdCashM: number;
  revenueM: number;
  payoutM: number;
  /**
   * FCY cash at hedge settle (prepared + booked). Ticket cover is
   * exposure-signed; settling a sell of long FCY delivers −N into cash.
   */
  hedgeCashFlowM: number;
  /** max(0, hedgeCashFlowM) — FCY received at settle. */
  hedgeCashInM: number;
  /** max(0, −hedgeCashFlowM) — FCY delivered at settle (stored positive). */
  hedgeCashOutM: number;
  /** Strip/bullet legs that settle this month (for FWD + USD attribution). */
  settleLegCount: number;
  netFlowM: number;
  endCashM: number;
  /** USD cash book end after this month’s settles. */
  endUsdCashM: number;
  avgCashM: number;
  /**
   * Residual EUR overnight on FCY left on the account (after income/expenses
   * and hedge CF) — $M equivalent.
   */
  interestUsdM: number;
  /** Alias of interestUsdM — residual EUR cash interest. */
  residualEurInterestUsdM: number;
  side: 'credit' | 'debit';
  ratePct: number;
  /** Swap-points / FWD carry locked on legs settling this month ($M). */
  fwdCarryUsdM: number;
  /**
   * @deprecated Synthetic hedge-leg FCY int — always 0 on the cash book path.
   * Residual EUR is in interestUsdM / residualEurInterestUsdM.
   */
  fcyInterestUsdM: number;
  /** USD overnight on post-settle USD cash book this month ($M). */
  usdInterestUsdM: number;
  /** FWD pts + residual EUR int + USD int this month ($M). */
  hedgeCarryUsdM: number;
  /** Same as hedgeCarryUsdM — total income from the three sources. */
  incomeUsdM: number;
}

/** Map settle tenure (months from M0) → 1-based month index within Tf. */
function monthIndexForSettle(settleMonths: number, T: number): number | null {
  if (!(T > 0)) return null;
  if (settleMonths <= 0) return 1;
  const m = Math.round(settleMonths);
  if (m < 1) return 1;
  if (m > T) return null;
  return m;
}

/**
 * Per-month FCY hedge cash flows for a CCY (prepared + booked).
 * Index 0 = M1 … T−1 = MT. Sign: + = FCY received, − = FCY delivered.
 */
export function hedgeCashFlowsByMonth(input: {
  ccy: string;
  forecastMonths: number;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  setup: VarSetup;
}): number[] {
  const T = Math.max(0, Math.floor(input.forecastMonths));
  const flows = Array.from({ length: T }, () => 0);
  if (T === 0) return flows;
  const legs = collectHedgeLegs({
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    setup: input.setup,
    horizon: T,
  }).filter(l => l.ccy === input.ccy);
  for (const leg of legs) {
    const idx = monthIndexForSettle(leg.settleMonths, T);
    if (idx == null) continue;
    // Exposure-signed cover → settle delivers opposite FCY into cash.
    flows[idx - 1]! += -leg.amountLocalM;
  }
  // Spot settles into near cash (M1) — excluded from collectHedgeLegs carry path.
  for (const t of input.bookedHedges.filter(isLiveHedgeTicket)) {
    if (t.ccy !== input.ccy || t.instrument !== 'spot') continue;
    if (Math.abs(t.amountLocalM) < 1e-12) continue;
    flows[0]! += -t.amountLocalM;
  }
  return flows;
}

/**
 * Month-by-month planned hedged cash forecast — dual cash book:
 *   1) Residual EUR interest on FCY (accrued before month-end settle)
 *   2) FWD pts accrued linearly over each leg’s tenor (M1…MS), not dumped at settle
 *   3) USD interest on post-settle USD (starts the month after settle)
 *
 * Default bullet settle at end of M12 → full-year EUR int (no OD from early
 * convert) + FWD accrual from M1; cash exchange only at month-end Mm.
 */
export function buildCashForecastSchedule(input: {
  ccy: string;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  forecastMonths: number;
  marketRates: FxMarketRatesBundle;
  bookedHedges?: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  setup?: VarSetup;
}): {
  openingCashM: number;
  months: CashForecastMonthRow[];
  totals: {
    revenueInflowM: number;
    payoutOutflowM: number;
    hedgeCashInM: number;
    hedgeCashOutM: number;
    hedgeCashFlowM: number;
    endCashM: number;
    endUsdCashM: number;
    interestUsdM: number;
    residualEurInterestUsdM: number;
    fwdCarryUsdM: number;
    fcyInterestUsdM: number;
    usdInterestUsdM: number;
    hedgeCarryUsdM: number;
    incomeUsdM: number;
  };
  forecastMode: 'flat' | 'custom';
  growthRateMoM: number;
  creditPct: number;
  debitPct: number;
  usdCreditPct: number;
  usdDebitPct: number;
} | null {
  const row = bookRowByCcy(input.bookRows, input.ccy);
  if (!row) return null;
  const T = Math.max(
    0,
    Math.floor(
      Number.isFinite(input.forecastMonths) && input.forecastMonths > 0
        ? input.forecastMonths
        : 0,
    ),
  );
  const profile = input.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
  const overnight = resolveOvernightCashRates(input.marketRates, input.ccy);
  const openingCashM = interestBearingCashM(row);
  if (T === 0) {
    return {
      openingCashM,
      months: [],
      totals: {
        revenueInflowM: 0,
        payoutOutflowM: 0,
        hedgeCashInM: 0,
        hedgeCashOutM: 0,
        hedgeCashFlowM: 0,
        endCashM: openingCashM,
        endUsdCashM: 0,
        interestUsdM: 0,
        residualEurInterestUsdM: 0,
        fwdCarryUsdM: 0,
        fcyInterestUsdM: 0,
        usdInterestUsdM: 0,
        hedgeCarryUsdM: 0,
        incomeUsdM: 0,
      },
      forecastMode: profile.mode === 'custom' ? 'custom' : 'flat',
      growthRateMoM: profile.growthRateMoM ?? 0,
      creditPct: overnight.fcy.creditPct,
      debitPct: overnight.fcy.debitPct,
      usdCreditPct: overnight.usd.creditPct,
      usdDebitPct: overnight.usd.debitPct,
    };
  }

  const monthlyNets = monthlyFlowSeriesLocalM(row, T, profile);
  const monthlyRevenue = monthlyRevenueSeriesLocalM(row, T, profile);
  const hedgeFlows =
    input.setup != null
      ? hedgeCashFlowsByMonth({
          ccy: input.ccy,
          forecastMonths: T,
          bookedHedges: input.bookedHedges ?? [],
          preparedByCcy: input.preparedByCcy,
          setup: input.setup,
        })
      : Array.from({ length: T }, () => 0);
  const legs =
    input.setup != null
      ? collectHedgeLegs({
          bookedHedges: input.bookedHedges ?? [],
          preparedByCcy: input.preparedByCcy,
          setup: input.setup,
          horizon: Math.max(T, 1e-9),
        }).filter(l => l.ccy === input.ccy)
      : [];

  // Per leg: cumulative swap-points P&L at any point along its own tenor,
  // read off the interpolated market curve (not amortized total/S). Monthly
  // accrual = cumAt(month) − cumAt(month−1), so each period gets only the
  // curve's marginal points for that interval and the sum through settle
  // reproduces the curve's point at that tenor exactly (e.g. M6 = 86.26 ask).
  const legFwdCum = legs.map(leg => {
    const S = Math.max(0, leg.settleMonths);
    if (S < 1 - 1e-9 || Math.abs(leg.amountLocalM) < 1e-12) {
      return { settleMonths: 0, cumAt: () => 0 };
    }
    const cumAt = (m: number): number => {
      const t = Math.max(0, Math.min(m, S));
      if (t < 1e-9) return 0;
      const pts = fwdCarryFromSwapPointsUsdM({
        notionalLocalM: leg.amountLocalM,
        settleMonths: t,
        bundle: input.marketRates,
      });
      return pts?.fwdCarryUsdM ?? 0;
    };
    return { settleMonths: S, cumAt };
  });

  const usdPer = fcyToUsdM(1, input.ccy);
  const months: CashForecastMonthRow[] = [];
  let fcy = openingCashM;
  let usd = 0;
  let revenueInflowM = 0;
  let payoutOutflowM = 0;
  let hedgeCashInM = 0;
  let hedgeCashOutM = 0;
  let residualEurInterestUsdM = 0;
  let fwdCarryUsdM = 0;
  let usdInterestUsdM = 0;

  for (let i = 0; i < T; i++) {
    const month = i + 1;
    const rev = monthlyRevenue[i] ?? 0;
    const net = monthlyNets[i] ?? 0;
    const payout = Math.max(0, -(net - rev));
    const hedgeCashFlowM = hedgeFlows[i] ?? 0;
    const hedgeIn = Math.max(0, hedgeCashFlowM);
    const hedgeOut = Math.max(0, -hedgeCashFlowM);
    const settleLegCount = legs.filter(
      l => Math.round(l.settleMonths) === month,
    ).length;

    const startFcy = fcy;
    const startUsd = usd;

    // 1) Operating CF only — settle is month-end (after interest).
    fcy += net;

    // 2) Accrue FWD pts this month — marginal curve points for [month-1, month].
    let monthFwd = 0;
    for (const lf of legFwdCum) {
      if (lf.settleMonths < 1 - 1e-9 || month - 1 >= lf.settleMonths) continue;
      monthFwd += lf.cumAt(month) - lf.cumAt(month - 1);
    }

    // 3) Interest on mid-month balances before month-end settle.
    const midFcy = fcy;
    const midUsd = usd;
    const avgFcy = (startFcy + midFcy) / 2;
    const avgUsd = (startUsd + midUsd) / 2;
    // Month m cash rate from term structure (SW→1Y); near 0 → O/N.
    const monthRates = resolveCashRatesForHorizon(
      input.marketRates,
      input.ccy,
      month,
    );
    const eurPick = selectCreditDebitRate(
      avgFcy,
      monthRates.fcy.creditPct,
      monthRates.fcy.debitPct,
    );
    const monthResidualEur =
      avgFcy * usdPer * (eurPick.ratePct / 100) * (1 / 12);
    const usdPick = selectCreditDebitRate(
      avgUsd,
      monthRates.usd.creditPct,
      monthRates.usd.debitPct,
    );
    const monthUsdInt =
      avgUsd * (usdPick.ratePct / 100) * (1 / 12);

    // 4) Month-end settle — USD from this settle earns from next month.
    if (Math.abs(hedgeCashFlowM) >= 1e-15) {
      fcy += hedgeCashFlowM;
      usd -= hedgeCashFlowM * usdPer;
    }

    const endFcy = fcy;
    const endUsd = usd;
    const monthIncome = monthResidualEur + monthFwd + monthUsdInt;

    months.push({
      monthIndex: month,
      label: `M${month}`,
      startCashM: startFcy,
      startUsdCashM: startUsd,
      revenueM: rev,
      payoutM: payout,
      hedgeCashFlowM,
      hedgeCashInM: hedgeIn,
      hedgeCashOutM: hedgeOut,
      settleLegCount,
      netFlowM: net + hedgeCashFlowM,
      endCashM: endFcy,
      endUsdCashM: endUsd,
      avgCashM: avgFcy,
      interestUsdM: monthResidualEur,
      residualEurInterestUsdM: monthResidualEur,
      side: eurPick.side,
      ratePct: eurPick.ratePct,
      fwdCarryUsdM: monthFwd,
      fcyInterestUsdM: 0,
      usdInterestUsdM: monthUsdInt,
      hedgeCarryUsdM: monthIncome,
      incomeUsdM: monthIncome,
    });

    revenueInflowM += rev;
    payoutOutflowM += payout;
    hedgeCashInM += hedgeIn;
    hedgeCashOutM += hedgeOut;
    residualEurInterestUsdM += monthResidualEur;
    fwdCarryUsdM += monthFwd;
    usdInterestUsdM += monthUsdInt;
  }

  const incomeUsdM =
    residualEurInterestUsdM + fwdCarryUsdM + usdInterestUsdM;

  return {
    openingCashM,
    months,
    totals: {
      revenueInflowM,
      payoutOutflowM,
      hedgeCashInM,
      hedgeCashOutM,
      hedgeCashFlowM: hedgeCashInM - hedgeCashOutM,
      endCashM: fcy,
      endUsdCashM: usd,
      interestUsdM: residualEurInterestUsdM,
      residualEurInterestUsdM,
      fwdCarryUsdM,
      fcyInterestUsdM: 0,
      usdInterestUsdM,
      hedgeCarryUsdM: incomeUsdM,
      incomeUsdM,
    },
    forecastMode: profile.mode === 'custom' ? 'custom' : 'flat',
    growthRateMoM: profile.growthRateMoM ?? 0,
    creditPct: overnight.fcy.creditPct,
    debitPct: overnight.fcy.debitPct,
    usdCreditPct: overnight.usd.creditPct,
    usdDebitPct: overnight.usd.debitPct,
  };
}

export type CashForecastSchedule = NonNullable<
  ReturnType<typeof buildCashForecastSchedule>
>;

/**
 * Default (prepared + booked) hedged forecast vs no-hedge baseline.
 * Categories: residual EUR int · FWD pts · USD int · Income Σ.
 */
export interface CashForecastCarryComparison {
  ccy: string;
  hasHedge: boolean;
  hedged: CashForecastSchedule;
  /** Same cash forecast with hedges stripped (residual EUR int only). */
  unhedged: CashForecastSchedule;
  categories: {
    residualEurInterestUsdM: number;
    fwdCarryUsdM: number;
    usdInterestUsdM: number;
    hedgedIncomeUsdM: number;
    unhedgedIncomeUsdM: number;
    /** Hedged Income Σ − unhedged (no-hedge) residual EUR int. */
    hedgeVsNoHedgeUsdM: number;
  };
}

export function buildCashForecastCarryComparison(input: {
  ccy: string;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  forecastMonths: number;
  marketRates: FxMarketRatesBundle;
  bookedHedges?: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  setup?: VarSetup;
}): CashForecastCarryComparison | null {
  const hedged = buildCashForecastSchedule(input);
  if (!hedged) return null;

  const unhedged = buildCashForecastSchedule({
    ...input,
    bookedHedges: [],
    preparedByCcy: {},
  });
  if (!unhedged) return null;

  const hasHedge =
    Math.abs(hedged.totals.hedgeCashFlowM) > 1e-12 ||
    Math.abs(hedged.totals.fwdCarryUsdM) > 1e-12 ||
    Math.abs(hedged.totals.usdInterestUsdM) > 1e-12 ||
    Math.abs(
      hedged.totals.residualEurInterestUsdM -
        unhedged.totals.residualEurInterestUsdM,
    ) > 1e-12;

  const hedgedIncomeUsdM = hedged.totals.incomeUsdM;
  const unhedgedIncomeUsdM = unhedged.totals.incomeUsdM;

  return {
    ccy: input.ccy,
    hasHedge,
    hedged,
    unhedged,
    categories: {
      residualEurInterestUsdM: hedged.totals.residualEurInterestUsdM,
      fwdCarryUsdM: hedged.totals.fwdCarryUsdM,
      usdInterestUsdM: hedged.totals.usdInterestUsdM,
      hedgedIncomeUsdM,
      unhedgedIncomeUsdM,
      hedgeVsNoHedgeUsdM: hedgedIncomeUsdM - unhedgedIncomeUsdM,
    },
  };
}

/** Live swap-curve FWD for one prepared strip leg (trade Δ × pts). */
export function preparedLegFwdCarryUsdM(
  leg: PreparedHedgeProfile['legs'][number],
  prevHedgeLocalM: number,
  marketRates: FxMarketRatesBundle,
): number {
  const settle = Math.max(0, leg.settleMonths ?? leg.endMonth);
  if (settle < 1 - 1e-9) return 0;
  const delta =
    typeof leg.tradeNotionalLocalM === 'number'
      ? leg.tradeNotionalLocalM
      : leg.hedgeLocalM - prevHedgeLocalM;
  if (Math.abs(delta) < 1e-12) return 0;
  return (
    fwdCarryFromSwapPointsUsdM({
      notionalLocalM: delta,
      settleMonths: settle,
      bundle: marketRates,
    })?.fwdCarryUsdM ?? 0
  );
}

/** Live swap-curve FWD for a prepared strip (Σ trade Δ × pts). */
export function preparedStripFwdCarryUsdM(
  prep: PreparedHedgeProfile,
  marketRates: FxMarketRatesBundle,
): number {
  let prev = 0;
  let sum = 0;
  for (const leg of prep.legs) {
    sum += preparedLegFwdCarryUsdM(leg, prev, marketRates);
    prev = leg.hedgeLocalM;
  }
  return sum;
}

/** Live swap-curve FWD for a prepared bullet. */
export function preparedBulletFwdCarryUsdM(
  prep: PreparedHedgeProfile,
  marketRates: FxMarketRatesBundle,
  fallbackUsdM: number,
): number {
  const settle = Math.max(0, prep.settleMonths ?? 0);
  if (settle < 1 - 1e-9 || Math.abs(prep.coverLocalM) < 1e-12) {
    return fallbackUsdM;
  }
  return (
    fwdCarryFromSwapPointsUsdM({
      notionalLocalM: prep.coverLocalM,
      settleMonths: settle,
      bundle: marketRates,
    })?.fwdCarryUsdM ?? fallbackUsdM
  );
}

/**
 * Total carry = Income Σ with live prepared FWD (same as Cash Carry table).
 * Strip/bullet FWD from the swap curve replaces any double-counted forecast FWD.
 */
export function resolvedHedgedTotalCarryUsdM(input: {
  comparison: CashForecastCarryComparison;
  prepared?: PreparedHedgeProfile | null;
  marketRates: FxMarketRatesBundle;
}): {
  fwdCarryUsdM: number;
  totalCarryUsdM: number;
  benefitUsdM: number;
} {
  const { comparison: cmp, prepared: prep, marketRates } = input;
  let fwdCarryUsdM = cmp.categories.fwdCarryUsdM;
  if (prep?.structure === 'strip' && (prep.legs?.length ?? 0) >= 2) {
    fwdCarryUsdM = preparedStripFwdCarryUsdM(prep, marketRates);
  } else if (
    prep?.structure === 'bullet' &&
    Math.abs(prep.coverLocalM) >= 1e-12
  ) {
    fwdCarryUsdM = preparedBulletFwdCarryUsdM(
      prep,
      marketRates,
      cmp.categories.fwdCarryUsdM,
    );
  }
  const fwdAdjust = fwdCarryUsdM - cmp.categories.fwdCarryUsdM;
  return {
    fwdCarryUsdM,
    totalCarryUsdM: cmp.categories.hedgedIncomeUsdM + fwdAdjust,
    benefitUsdM: cmp.categories.hedgeVsNoHedgeUsdM + fwdAdjust,
  };
}

/**
 * Σ Total carry across currencies — same pipeline as Cash Carry “All CCY”
 * Total (buildCashForecastCarryComparison + resolvedHedgedTotalCarryUsdM).
 * Used by the Analytics tab rail so the headline cannot drift from the table.
 */
export function sumCashCarryTotalUsdM(input: {
  ccys: readonly string[];
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  forecastMonths: number;
  marketRatesFor: (ccy: string) => FxMarketRatesBundle;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  setup: VarSetup;
}): number {
  let sum = 0;
  for (const ccy of input.ccys) {
    if (!ccy || ccy === 'USD') continue;
    const marketRates = input.marketRatesFor(ccy);
    const cmp = buildCashForecastCarryComparison({
      ccy,
      bookRows: input.bookRows,
      forecastProfile: input.forecastProfile,
      forecastMonths: input.forecastMonths,
      marketRates,
      bookedHedges: input.bookedHedges,
      preparedByCcy: input.preparedByCcy,
      setup: input.setup,
    });
    if (!cmp) continue;
    sum += resolvedHedgedTotalCarryUsdM({
      comparison: cmp,
      prepared: input.preparedByCcy?.[ccy],
      marketRates,
    }).totalCarryUsdM;
  }
  return sum;
}

function cashPathForCcy(input: {
  ccy: string;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  throughMonths: number;
  marketRates: FxMarketRatesBundle;
}): ReturnType<typeof cashInterestPathToHorizon> & {
  openingCashM: number;
  forecastMode: 'flat' | 'custom';
  growthRateMoM: number;
  creditPct: number;
  debitPct: number;
  source: string;
} | null {
  const row = bookRowByCcy(input.bookRows, input.ccy);
  if (!row) return null;
  const profile = input.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
  const Tsched = Math.max(1, Math.ceil(input.throughMonths - 1e-9));
  const monthlyNets = monthlyFlowSeriesLocalM(row, Tsched, profile);
  const monthlyRevenue = monthlyRevenueSeriesLocalM(row, Tsched, profile);
  const overnight = resolveOvernightCashRates(input.marketRates, input.ccy);
  const path = cashInterestPathToHorizon({
    openingCashM: interestBearingCashM(row),
    monthlyNets,
    monthlyRevenue,
    creditPct: overnight.fcy.creditPct,
    debitPct: overnight.fcy.debitPct,
    ccy: input.ccy,
    throughMonths: input.throughMonths,
    marketRates: input.marketRates,
  });
  return {
    ...path,
    openingCashM: interestBearingCashM(row),
    forecastMode: profile.mode === 'custom' ? 'custom' : 'flat',
    growthRateMoM: profile.growthRateMoM ?? 0,
    creditPct: overnight.fcy.creditPct,
    debitPct: overnight.fcy.debitPct,
    source: `${overnight.source} · future ← SW–1Y term`,
  };
}

function tenureMonthsFromTicket(t: HedgeTicket, setup: VarSetup): number {
  const label = t.maturityLabel ?? t.maturity ?? '';
  const m = /(?:^|[^\d])(\d+)\s*m/i.exec(String(label));
  if (m) return Number(m[1]);
  const y = /(?:^|[^\d])(\d+)\s*y/i.exec(String(label));
  if (y) return Number(y[1]) * 12;
  if (t.instrument === 'spot') return 0;
  return horizonMonths(setup.horizon);
}

/**
 * Attach implied FWD carry from EURUSD Swap Points to a prepared package.
 * Strip legs use incremental Δ notional; bullet uses coverLocalM @ Tf.
 */
export function assignImpliedCarryFromSwapPoints(
  profile: PreparedHedgeProfile,
  input: {
    marketRates: FxMarketRatesBundle;
    bulletSettleMonths: number;
  },
): PreparedHedgeProfile {
  const { marketRates, bulletSettleMonths } = input;

  if (profile.structure === 'strip' && profile.legs.length > 0) {
    let prev = 0;
    let sum = 0;
    const legs = profile.legs.map(leg => {
      const delta =
        typeof leg.tradeNotionalLocalM === 'number'
          ? leg.tradeNotionalLocalM
          : leg.hedgeLocalM - prev;
      prev = leg.hedgeLocalM;
      const settle = Math.max(0, leg.settleMonths ?? leg.endMonth);
      // Spot / start conversion (< 1m) — no forward points.
      const pts =
        settle < 1 - 1e-12
          ? null
          : fwdCarryFromSwapPointsUsdM({
              notionalLocalM: delta,
              settleMonths: settle,
              bundle: marketRates,
            });
      const impliedCarryUsdM = pts?.fwdCarryUsdM ?? 0;
      sum += impliedCarryUsdM;
      return {
        ...leg,
        settleMonths: settle,
        tradeNotionalLocalM: delta,
        impliedCarryUsdM,
        swapPoints: pts?.points,
        swapPointsSide: pts?.side,
      };
    });
    return {
      ...profile,
      legs,
      impliedCarryUsdM: sum,
      swapPoints: legs[legs.length - 1]?.swapPoints,
      swapPointsSide: legs[legs.length - 1]?.swapPointsSide,
    };
  }

  const settle = Math.max(0, bulletSettleMonths);
  const pts =
    settle < 1 - 1e-12
      ? null
      : fwdCarryFromSwapPointsUsdM({
          notionalLocalM: profile.coverLocalM,
          settleMonths: Math.max(settle, 0.25),
          bundle: marketRates,
        });
  return {
    ...profile,
    settleMonths: settle,
    impliedCarryUsdM: pts?.fwdCarryUsdM ?? 0,
    swapPoints: pts?.points,
    swapPointsSide: pts?.side,
  };
}

function pushFwdCarryRow(
  rows: HedgeCarryLayerRow[],
  input: {
    ccy: string;
    ticketId: string;
    label: string;
    structure: 'bullet' | 'strip';
    status: 'booked' | 'prepared';
    amountLocalM: number;
    settleMonths: number;
    horizon: number;
    marketRates: FxMarketRatesBundle;
  },
): string {
  const settle = Math.max(input.settleMonths, 0);
  const overnight = resolveOvernightCashRates(input.marketRates, input.ccy);
  // Spot / start (< 1m): no forward points — do not floor to 0.25 (that
  // invented SW pts on M0).
  const pts =
    settle < 1 - 1e-9
      ? null
      : fwdCarryFromSwapPointsUsdM({
          notionalLocalM: input.amountLocalM,
          settleMonths: settle,
          bundle: input.marketRates,
        });
  // Leg table = swap-points only. Residual EUR / USD int live on the dual
  // cash-forecast book (not per-leg notional overnight).
  const fwdCarryUsdM = pts?.fwdCarryUsdM ?? 0;
  rows.push({
    ccy: input.ccy,
    ticketId: input.ticketId,
    label: input.label,
    structure: input.structure,
    status: input.status,
    amountLocalM: input.amountLocalM,
    settleMonths: settle,
    fwdCarryUsdM,
    fcyInterestUsdM: 0,
    usdInterestUsdM: 0,
    totalUsdM: fwdCarryUsdM,
    rFcyPct: overnight.fcy.creditPct,
    rUsdPct: overnight.usd.creditPct,
    fcySide: 'credit',
    usdSide: 'credit',
    swapPoints: pts?.points,
    swapPointsSide: pts?.side,
  });
  return `${overnight.source} + swap points`;
}

type HedgeLegSample = {
  ccy: string;
  amountLocalM: number;
  settleMonths: number;
  recognizeMonths: number;
  structure: 'bullet' | 'strip';
};

/** Collect hedge legs (prepared + booked) for horizon sampling. */
function collectHedgeLegs(input: {
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  setup: VarSetup;
  horizon: number;
}): HedgeLegSample[] {
  const legs: HedgeLegSample[] = [];
  const preparedCcys = new Set<string>();
  for (const [ccy, prep] of Object.entries(input.preparedByCcy ?? {})) {
    if (prep.structure === 'strip' && prep.legs.length > 0) {
      preparedCcys.add(ccy);
      let prev = 0;
      for (const leg of prep.legs) {
        const delta =
          typeof leg.tradeNotionalLocalM === 'number'
            ? leg.tradeNotionalLocalM
            : leg.hedgeLocalM - prev;
        prev = leg.hedgeLocalM;
        if (Math.abs(delta) < 1e-12) continue;
        legs.push({
          ccy,
          amountLocalM: delta,
          settleMonths: leg.settleMonths ?? leg.endMonth,
          recognizeMonths: leg.startMonth,
          structure: 'strip',
        });
      }
    } else if (Math.abs(prep.coverLocalM) >= 1e-12) {
      preparedCcys.add(ccy);
      legs.push({
        ccy,
        amountLocalM: prep.coverLocalM,
        settleMonths:
          prep.settleMonths != null ? prep.settleMonths : input.horizon,
        recognizeMonths: 0,
        structure: 'bullet',
      });
    }
  }
  for (const t of input.bookedHedges.filter(isLiveHedgeTicket)) {
    if (t.instrument === 'spot') continue;
    // Prepared package already represents this CCY — don't double-count FWD.
    if (preparedCcys.has(t.ccy)) continue;
    legs.push({
      ccy: t.ccy,
      amountLocalM: t.amountLocalM,
      settleMonths: tenureMonthsFromTicket(t, input.setup),
      recognizeMonths: 0,
      structure: t.stripId != null ? 'strip' : 'bullet',
    });
  }
  return legs;
}

const EMPTY_HEDGE_IMPROVEMENT: HedgeImprovementBreakdown = {
  hedgeDeltaLocalM: 0,
  fwdCarryUsdM: 0,
  fcyInterestUsdM: 0,
  usdInterestUsdM: 0,
  totalUsdM: 0,
  structure: 'none',
  legCount: 0,
};

/**
 * Accrue prepared/booked hedge improvement to reporting month t, split into:
 * - FWD / swap-points carry (hedge Δ carry)
 * - FCY overnight (recognize → settle)
 * - USD overnight after settle until t (post-execution to forecast horizon)
 */
export function hedgeImprovementBreakdownToT(
  legs: readonly HedgeLegSample[],
  t: number,
  marketRates: FxMarketRatesBundle,
): HedgeImprovementBreakdown {
  if (legs.length === 0) return { ...EMPTY_HEDGE_IMPROVEMENT };

  let hedgeDeltaLocalM = 0;
  let fwdCarryUsdM = 0;
  let fcyInterestUsdM = 0;
  let usdInterestUsdM = 0;
  let hasStrip = false;
  let hasBullet = false;

  for (const leg of legs) {
    hedgeDeltaLocalM += leg.amountLocalM;
    if (leg.structure === 'strip') hasStrip = true;
    else hasBullet = true;

    const settle = Math.max(0, leg.settleMonths);
    const recog = Math.max(0, Math.min(leg.recognizeMonths, settle));
    const fwd = resolveForwardDepositRates(
      marketRates,
      leg.ccy,
      Math.max(settle, 0.25),
    );
    // Cash interest: O/N only near 0; else SW→1Y term at holding tenor.
    const fcyHorizon = Math.max(0, settle - recog);
    const usdHorizon = Math.max(0, Math.max(t, settle) - settle);
    const fcyCash = resolveCashRatesForHorizon(
      marketRates,
      leg.ccy,
      fcyHorizon,
    );
    const usdCash = resolveCashRatesForHorizon(
      marketRates,
      leg.ccy,
      usdHorizon,
    );
    const pts =
      settle < 1 - 1e-9
        ? null
        : fwdCarryFromSwapPointsUsdM({
            notionalLocalM: leg.amountLocalM,
            settleMonths: settle,
            bundle: marketRates,
          });
    const reportT = Math.max(t, 1e-12);

    if (t + 1e-9 < settle) {
      // Before settle: only partial FCY accrual; no FWD lock-in / USD post-settle yet.
      const usdNotional = leg.amountLocalM * fcyToUsdM(1, leg.ccy);
      const elapsed = Math.max(0, Math.min(t, settle) - recog);
      const fcyCashElapsed = resolveCashRatesForHorizon(
        marketRates,
        leg.ccy,
        elapsed,
      );
      const fcyPick = selectCreditDebitRate(
        leg.amountLocalM,
        fcyCashElapsed.fcy.creditPct,
        fcyCashElapsed.fcy.debitPct,
      );
      fcyInterestUsdM +=
        usdNotional * (fcyPick.ratePct / 100) * (elapsed / 12);
      continue;
    }

    const carry = stripHedgeLegCarryUsdM({
      notionalLocalM: leg.amountLocalM,
      ccy: leg.ccy,
      recognizeMonths: recog,
      settleMonths: settle,
      forecastEndMonths: reportT,
      fcyFwdRates: fwd.fcy,
      usdFwdRates: fwd.usd,
      fcyCashRates: fcyCash.fcy,
      usdCashRates: usdCash.usd,
      swapPointsCarryUsdM: pts?.fwdCarryUsdM ?? 0,
      swapPoints: pts?.points,
      swapPointsSide: pts?.side,
    });
    fwdCarryUsdM += carry.fwdCarryUsdM;
    fcyInterestUsdM += carry.fcyInterestUsdM;
    usdInterestUsdM += carry.usdInterestUsdM;
  }

  const structure: HedgeImprovementBreakdown['structure'] =
    hasStrip && !hasBullet ? 'strip' : hasBullet && !hasStrip ? 'bullet' : 'strip';

  return {
    hedgeDeltaLocalM,
    fwdCarryUsdM,
    fcyInterestUsdM,
    usdInterestUsdM,
    totalUsdM: fwdCarryUsdM + fcyInterestUsdM + usdInterestUsdM,
    structure: hasStrip || hasBullet ? structure : 'none',
    legCount: legs.length,
  };
}

function hedgeCarryAccruedToT(
  legs: readonly HedgeLegSample[],
  t: number,
  marketRates: FxMarketRatesBundle,
): number {
  return hedgeImprovementBreakdownToT(legs, t, marketRates).totalUsdM;
}

/** Notional-weighted average settle months from M0 (strategy WAM). */
export function hedgeSettleWamMonths(
  legs: readonly HedgeLegSample[],
): number {
  let wSum = 0;
  let nSum = 0;
  for (const leg of legs) {
    const w = Math.abs(leg.amountLocalM);
    if (w < 1e-12) continue;
    wSum += w * Math.max(0, leg.settleMonths);
    nSum += w;
  }
  return nSum < 1e-12 ? 0 : wSum / nSum;
}

/**
 * Overnight interest on a signed cash balance already expressed in $M.
 * Long → +credit% · Short → −debit% (OD cost — never a positive earn on a short).
 */
function overnightInterestUsdM(
  signedBalanceUsdM: number,
  creditPct: number,
  debitPct: number,
  dtMonths: number,
): number {
  if (Math.abs(signedBalanceUsdM) < 1e-15 || dtMonths < 1e-15) return 0;
  if (signedBalanceUsdM >= 0) {
    return signedBalanceUsdM * (creditPct / 100) * (dtMonths / 12);
  }
  return -Math.abs(signedBalanceUsdM) * (debitPct / 100) * (dtMonths / 12);
}

/**
 * Month-step dual cash book M0→Tf — same convention as
 * `buildCashForecastSchedule`:
 *   1) apply forecast net + any settles this month
 *   2) accrue FCY/USD cash interest on mid-month averages
 *
 * Rates: month m uses term structure at tenor m (SW→1Y); near 0 → O/N.
 * Month index: 0 = opening spot settles (before M1); 1…Tf = month-end Mm.
 */
function simulateSettleCashPath(input: {
  openingCashM: number;
  monthlyNets: readonly number[];
  throughMonths: number;
  settleCashFlowsByMonth: ReadonlyMap<number, number>;
  marketRates: FxMarketRatesBundle;
  ccy: string;
}): {
  fcyInterestUsdM: number;
  usdInterestUsdM: number;
  newCarryUsdM: number;
  settledCashFlowM: number;
  endFcyCashM: number;
  endUsdCashM: number;
} {
  const Tf = Math.max(0, Math.floor(input.throughMonths + 1e-12));
  const usdPer = Math.max(1e-12, fcyToUsdM(1, input.ccy));
  let fcy = input.openingCashM;
  let usd = 0;
  let fcyInterestUsdM = 0;
  let usdInterestUsdM = 0;
  let settledCashFlowM = 0;

  const takeSettle = (monthEnd: number) => {
    const want = input.settleCashFlowsByMonth.get(monthEnd) ?? 0;
    if (Math.abs(want) < 1e-15) return 0;
    fcy += want;
    usd -= want * usdPer;
    settledCashFlowM += want;
    return want;
  };

  // M0 = start conversion before the forecast loop.
  takeSettle(0);

  for (let m = 1; m <= Tf; m++) {
    const fcyStart = fcy;
    const usdStart = usd;
    const net =
      m - 1 < input.monthlyNets.length &&
      Number.isFinite(input.monthlyNets[m - 1]!)
        ? input.monthlyNets[m - 1]!
        : 0;
    // Operating CF → accrue → month-end settle (USD earns next month).
    fcy += net;
    const fcyAvg = (fcyStart + fcy) / 2;
    const usdAvg = (usdStart + usd) / 2;
    // Future cash rate from term structure at month tenor (SW…1Y).
    const rates = resolveCashRatesForHorizon(
      input.marketRates,
      input.ccy,
      m,
    );
    fcyInterestUsdM += overnightInterestUsdM(
      fcyAvg * usdPer,
      rates.fcy.creditPct,
      rates.fcy.debitPct,
      1,
    );
    usdInterestUsdM += overnightInterestUsdM(
      usdAvg,
      rates.usd.creditPct,
      rates.usd.debitPct,
      1,
    );
    takeSettle(m);
  }

  return {
    fcyInterestUsdM,
    usdInterestUsdM,
    newCarryUsdM: fcyInterestUsdM + usdInterestUsdM,
    settledCashFlowM,
    endFcyCashM: fcy,
    endUsdCashM: usd,
  };
}

/** Aggregate leg notionals into month-end FCY cash flows (deliver = −Δ). */
function settleCashFlowsFromLegs(
  legs: readonly { settleMonths: number; amountLocalM: number }[],
): Map<number, number> {
  const byMonth = new Map<number, number>();
  for (const leg of legs) {
    if (Math.abs(leg.amountLocalM) < 1e-15) continue;
    const m = Math.max(0, Math.round(leg.settleMonths));
    byMonth.set(m, (byMonth.get(m) ?? 0) - leg.amountLocalM);
  }
  return byMonth;
}

/**
 * Map strategy legs onto a target settle WAM.
 * - WAM 0 → all spot (bullet collapse)
 * - book → natural strip/bullet tenors
 * - other → scale tenors so notional-weighted WAM = target (strip shape kept)
 * Settles are clamped to [0, maxSettle] so FWD/cash stay inside Tf.
 */
function legsForTargetWam(
  legs: readonly HedgeLegSample[],
  targetWam: number,
  naturalWam: number,
  isBook: boolean,
  maxSettle: number,
): { settleMonths: number; amountLocalM: number }[] {
  const cap = Math.max(0, maxSettle);
  const clamp = (m: number) => Math.min(cap, Math.max(0, m));
  if (legs.length === 0) return [];
  if (isBook) {
    return legs.map(l => ({
      settleMonths: clamp(l.settleMonths),
      amountLocalM: l.amountLocalM,
    }));
  }
  if (targetWam <= 1e-12) {
    return legs.map(l => ({
      settleMonths: 0,
      amountLocalM: l.amountLocalM,
    }));
  }
  if (legs.length === 1 || naturalWam < 1e-12) {
    return legs.map(l => ({
      settleMonths: clamp(targetWam),
      amountLocalM: l.amountLocalM,
    }));
  }
  const scale = targetWam / naturalWam;
  return legs.map(l => ({
    settleMonths: clamp(l.settleMonths * scale),
    amountLocalM: l.amountLocalM,
  }));
}

/**
 * Swap-points FWD carry for legs. Spot / start conversion (settle &lt; 1m)
 * has **no** forward points — sold at the beginning, not on the fwd curve.
 * Do not floor tenor to 0.25m (that invented SW pts on M0).
 */
function fwdCarryForLegsUsdM(
  legs: readonly { settleMonths: number; amountLocalM: number }[],
  bundle: FxMarketRatesBundle,
): number {
  let sum = 0;
  for (const leg of legs) {
    if (Math.abs(leg.amountLocalM) < 1e-12) continue;
    // Beginning sale (M0 / start): 0 FWD pts.
    if (leg.settleMonths < 1 - 1e-9) continue;
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: leg.amountLocalM,
      settleMonths: leg.settleMonths,
      bundle,
    });
    sum += pts?.fwdCarryUsdM ?? 0;
  }
  return sum;
}

/**
 * One settle-WAM scenario: same hedge Δ / strip shape, WAM shifted to Mm.
 */
export interface SettleWamScenario {
  settleMonths: number;
  label: string;
  isCurrentWam: boolean;
  beyondForecast: boolean;
  structure: HedgeImprovementBreakdown['structure'];
  legCount: number;
  hedgeDeltaLocalM: number;
  /** Sum of FCY cash flows exchanged (strip = staggered; still totals −Δ). */
  settledCashFlowM: number;
  /** Human label of leg settle months, e.g. "M3/M6/M9/M12". */
  settleScheduleLabel: string;
  /**
   * Old = unhedged FCY cash interest @ Tf (same for every row).
   */
  defaultCarryUsdM: number;
  unhedgedCarryUsdM: number;
  /** New = FCY int + USD int with this settle schedule. */
  newCarryUsdM: number;
  /** Sum of swap-points on each leg at its settle tenor. */
  fwdCarryUsdM: number;
  fcyInterestUsdM: number;
  usdInterestUsdM: number;
  /** New − Old (cash interest only; FWD excluded). */
  interestDeltaUsdM: number;
  /**
   * Enhancement = New − Old + FWD pts
   * (full benefit vs do-nothing — interest delta and forward points).
   */
  enhancementUsdM: number;
  /** Alias of enhancementUsdM (benefit vs do-nothing including FWD). */
  totalUsdM: number;
  /** Absolute carry earned = New + FWD pts (not minus Old). */
  totalCarryUsdM: number;
  enhancementVsBookUsdM: number;
  totalVsBookUsdM: number;
}

function settleScheduleLabel(
  legs: readonly { settleMonths: number }[],
): string {
  if (legs.length === 0) return '—';
  const months = [
    ...new Set(legs.map(l => Math.max(0, Math.round(l.settleMonths)))),
  ].sort((a, b) => a - b);
  return months.map(m => `M${m}`).join('/');
}

/**
 * Settle WAM scenarios.
 *
 * Bullet — **12 periods** M1…M12 when Tf=12:
 *   M1 = convert at **start** (sell spot now) → **0 FWD pts**, then full Tf
 *   months of cash interest (12 USD periods).
 *   M2…M12 = settle at month-end Mm with swap-points for tenor m.
 *
 * Strip — M0…M12: scale leg tenors (M0 = all spot, 0 FWD). Book keeps
 * natural tenors. Rank by Enhancement = New − Old + FWD pts.
 */
export function buildSettleWamScenarios(input: {
  ccy: string;
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRates: FxMarketRatesBundle;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  maxSettleMonths?: number;
  /**
   * `structure` (default) — ladder follows prepared/booked strip or bullet shape.
   * `bullet` — always a static one-leg bullet Enhancement curve for each Mm;
   * used for WAM target selection before strip count / skew / kurtosis.
   */
  ladderMode?: 'structure' | 'bullet';
}): SettleWamScenario[] {
  const row = input.risk.find(r => r.bar.ccy === input.ccy);
  if (!row) return [];

  const Tf =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? Math.floor(input.setup.forecastMonths + 1e-12)
      : Math.floor(horizonMonths(input.setup.horizon) + 1e-12);
  const reportT = Math.max(0, Tf);
  const maxM = Math.max(
    0,
    Math.min(24, Math.floor(input.maxSettleMonths ?? 12)),
  );
  const forceBulletLadder = input.ladderMode === 'bullet';

  const strategyLegs = collectHedgeLegs({
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    setup: input.setup,
    horizon: Math.max(reportT, 1e-9),
  }).filter(l => l.ccy === input.ccy);

  const hedgeDeltaLocalM = strategyLegs.reduce(
    (s, l) => s + l.amountLocalM,
    0,
  );

  const bookRow = bookRowByCcy(input.bookRows, input.ccy);
  const profile = input.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
  const Tsched = Math.max(1, reportT, maxM);
  const monthlyNets = bookRow
    ? monthlyFlowSeriesLocalM(bookRow, Tsched, profile)
    : Array.from({ length: Tsched }, () => 0);
  const openingCashM = bookRow ? interestBearingCashM(bookRow) : 0;

  const pathBase = {
    openingCashM,
    monthlyNets,
    throughMonths: reportT,
    marketRates: input.marketRates,
    ccy: input.ccy,
  };

  const unhedged = simulateSettleCashPath({
    ...pathBase,
    settleCashFlowsByMonth: new Map(),
  });
  const unhedgedCarryUsdM = unhedged.fcyInterestUsdM;
  const defaultCarryUsdM = unhedgedCarryUsdM;

  const hasStrip = strategyLegs.some(l => l.structure === 'strip');
  const hasBullet = strategyLegs.some(l => l.structure === 'bullet');
  const structure: HedgeImprovementBreakdown['structure'] = forceBulletLadder
    ? strategyLegs.length === 0
      ? 'none'
      : 'bullet'
    : strategyLegs.length === 0
      ? 'none'
      : hasStrip && !hasBullet
        ? 'strip'
        : hasBullet && !hasStrip
          ? 'bullet'
          : 'strip';
  const isBulletOnly = forceBulletLadder || structure === 'bullet';
  const ladderLegCount = forceBulletLadder
    ? Math.abs(hedgeDeltaLocalM) < 1e-12
      ? 0
      : 1
    : strategyLegs.length;

  const currentWam = hedgeSettleWamMonths(strategyLegs);
  // Bullet ladder is M1…M12 (12 periods); strip keeps M0…M12.
  const mFirst = isBulletOnly ? 1 : 0;
  let currentIdx = mFirst;
  let bestDist = Infinity;
  for (let m = mFirst; m <= maxM; m++) {
    const d = Math.abs(m - currentWam);
    if (d < bestDist) {
      bestDist = d;
      currentIdx = m;
    }
  }

  const bulletLegsAt = (settleMonths: number) => [
    { settleMonths, amountLocalM: hedgeDeltaLocalM },
  ];

  const bookLegs =
    Math.abs(hedgeDeltaLocalM) < 1e-12
      ? []
      : forceBulletLadder
        ? currentIdx === 1
          ? bulletLegsAt(0)
          : bulletLegsAt(currentIdx)
        : legsForTargetWam(
            strategyLegs,
            currentWam,
            currentWam,
            true,
            reportT,
          );
  const bookPath = simulateSettleCashPath({
    ...pathBase,
    settleCashFlowsByMonth: settleCashFlowsFromLegs(bookLegs),
  });
  const bookFwd = fwdCarryForLegsUsdM(bookLegs, input.marketRates);
  const bookInterestDelta = bookPath.newCarryUsdM - unhedgedCarryUsdM;
  const bookEnhancement = bookInterestDelta + bookFwd;

  const scenarios: SettleWamScenario[] = [];
  for (let m = mFirst; m <= maxM; m++) {
    const isBook = strategyLegs.length > 0 && m === currentIdx;
    /** Bullet M1 = sell at start (spot): 0 FWD, then full Tf interest periods. */
    const isStartConversion = isBulletOnly ? m === 1 : m === 0;
    const legs =
      Math.abs(hedgeDeltaLocalM) < 1e-12
        ? []
        : isBook
          ? bookLegs
          : forceBulletLadder
            ? isStartConversion
              ? bulletLegsAt(0)
              : bulletLegsAt(m)
            : isStartConversion
              ? strategyLegs.map(l => ({
                  settleMonths: 0,
                  amountLocalM: l.amountLocalM,
                }))
              : legsForTargetWam(
                  strategyLegs,
                  m,
                  currentWam,
                  false,
                  reportT,
                );
    const path = simulateSettleCashPath({
      ...pathBase,
      settleCashFlowsByMonth: settleCashFlowsFromLegs(legs),
    });
    const fwdCarryUsdM = fwdCarryForLegsUsdM(legs, input.marketRates);
    const newCarryUsdM = path.newCarryUsdM;
    const interestDeltaUsdM = newCarryUsdM - unhedgedCarryUsdM;
    // Enhancement includes FWD pts — full benefit vs do-nothing.
    const enhancementUsdM = interestDeltaUsdM + fwdCarryUsdM;
    const totalUsdM = enhancementUsdM;
    const totalCarryUsdM = newCarryUsdM + fwdCarryUsdM;

    scenarios.push({
      settleMonths: m,
      label: `M${m}`,
      isCurrentWam: isBook,
      beyondForecast: reportT > 0 && m > reportT,
      structure,
      legCount: ladderLegCount,
      hedgeDeltaLocalM,
      settledCashFlowM: path.settledCashFlowM,
      settleScheduleLabel: isStartConversion
        ? isBulletOnly
          ? 'M1·start'
          : 'M0·start'
        : settleScheduleLabel(legs),
      defaultCarryUsdM,
      unhedgedCarryUsdM,
      newCarryUsdM,
      fwdCarryUsdM,
      fcyInterestUsdM: path.fcyInterestUsdM,
      usdInterestUsdM: path.usdInterestUsdM,
      interestDeltaUsdM,
      enhancementUsdM,
      totalUsdM,
      totalCarryUsdM,
      enhancementVsBookUsdM: enhancementUsdM - bookEnhancement,
      totalVsBookUsdM: enhancementUsdM - bookEnhancement,
    });
  }
  return scenarios;
}

/** Continuous strip shape knobs around a pinned settle WAM. */
export interface StripShapeParams {
  /** 1 = bullet; ≥2 = strip legs. */
  legCount: number;
  /** 0 = front-loaded, 0.5 = mid, 1 = back-loaded. */
  centerOfMass: number;
  /** −1 = wings, 0 = flat, +1 = peaked near CoM. */
  kurtosis: number;
}

export interface StripShapeLegBar {
  settleMonths: number;
  amountLocalM: number;
  /** Sched-% weight (sums to 1). */
  weight: number;
  label: string;
}

export interface StripShapeScore extends StripShapeParams {
  structure: 'bullet' | 'strip';
  settleMonths: number[];
  /** Per-leg settle / notional — for chart bars after Apply shape. */
  legs: StripShapeLegBar[];
  settleScheduleLabel: string;
  /** Realized notional-weighted WAM after pin (≈ target). */
  wamMonths: number;
  hedgeDeltaLocalM: number;
  enhancementUsdM: number;
  interestDeltaUsdM: number;
  fwdCarryUsdM: number;
  newCarryUsdM: number;
  fcyInterestUsdM: number;
  usdInterestUsdM: number;
  /** Enhancement − bullet @ same WAM. */
  vsBulletUsdM: number;
}

export interface OptimizeStripShapeResult {
  targetWamMonths: number;
  startConversion: boolean;
  bullet: StripShapeScore;
  best: StripShapeScore;
  top: StripShapeScore[];
  /** Full scored grid (legCount × CoM × kurtosis), sorted best-first. */
  candidates: StripShapeScore[];
}

function pinSettleMonthsToWam(
  ends: readonly number[],
  amounts: readonly number[],
  targetWam: number,
  maxSettle: number,
): number[] {
  const cap = Math.max(0, maxSettle);
  const clamp = (m: number) => Math.min(cap, Math.max(0, m));
  if (ends.length === 0) return [];
  if (targetWam <= 1e-12) return ends.map(() => 0);
  let wSum = 0;
  let nSum = 0;
  for (let i = 0; i < ends.length; i++) {
    const w = Math.abs(amounts[i] ?? 0);
    if (w < 1e-12) continue;
    wSum += w * Math.max(0, ends[i]!);
    nSum += w;
  }
  const naturalWam = nSum < 1e-12 ? 0 : wSum / nSum;
  if (naturalWam < 1e-12 || ends.length === 1) {
    return ends.map(() => clamp(targetWam));
  }
  const scale = targetWam / naturalWam;
  return ends.map(e => clamp(e * scale));
}

/**
 * Explicit per-leg override for scoreStripShapeAroundWam — e.g. hand-tuned
 * "Strip schedule · tick trades" edits (settle date + Hedge % per leg).
 * Pairs are zipped by index (settleMonthsRaw[i] ↔ weightsRaw[i]) *before*
 * filtering/sorting so a rejected entry can't desync the two arrays.
 */
function buildCustomStripLegs(
  settleMonthsRaw: readonly number[] | null | undefined,
  weightsRaw: readonly number[] | null | undefined,
  reportT: number,
  hedgeDeltaLocalM: number,
): { legs: { settleMonths: number; amountLocalM: number }[]; weights: number[] } | null {
  if (!settleMonthsRaw?.length || !weightsRaw?.length) return null;
  if (settleMonthsRaw.length !== weightsRaw.length) return null;
  const pairs = settleMonthsRaw
    .map((m, i) => ({ m, w: weightsRaw[i] ?? 0 }))
    .filter(
      p =>
        Number.isFinite(p.m) &&
        p.m > 1e-9 &&
        p.m <= reportT + 1e-9 &&
        Number.isFinite(p.w) &&
        p.w > 0,
    )
    .sort((a, b) => a.m - b.m);
  if (pairs.length === 0) return null;
  const wSum = pairs.reduce((s, p) => s + p.w, 0);
  if (!(wSum > 1e-12)) return null;
  const weights = pairs.map(p => p.w / wSum);
  const legs = pairs.map((p, i) => ({
    settleMonths: Math.round(p.m * 1000) / 1000,
    amountLocalM: weights[i]! * hedgeDeltaLocalM,
  }));
  return { legs, weights };
}

/**
 * Score one (legs, CoM, kurtosis) strip/bullet shape pinned to target WAM.
 * Notionals follow Sched-% weights; settles are scaled so WAM ≈ target.
 */
export function scoreStripShapeAroundWam(input: {
  ccy: string;
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRates: FxMarketRatesBundle;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  /** Target settle WAM months (0 = start / spot conversion). */
  targetWamMonths: number;
  legCount: number;
  centerOfMass?: number;
  kurtosis?: number;
  /** Override Δ; default = prepared/booked strategy Δ for ccy. */
  hedgeDeltaLocalM?: number;
  /**
   * Explicit settle months per leg — overrides the CoM/kurtosis-derived
   * regime shape with the live "Strip schedule · tick trades" ladder.
   * Must pair with customWeights (same length, index-aligned).
   */
  customSettleMonths?: readonly number[] | null;
  /** Notional shares per leg (need not pre-sum to 1 — renormalized here). */
  customWeights?: readonly number[] | null;
}): StripShapeScore | null {
  const row = input.risk.find(r => r.bar.ccy === input.ccy);
  if (!row) return null;

  const Tf =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? Math.floor(input.setup.forecastMonths + 1e-12)
      : Math.floor(horizonMonths(input.setup.horizon) + 1e-12);
  const reportT = Math.max(0, Tf);
  if (!(reportT > 0)) return null;

  const strategyLegs = collectHedgeLegs({
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    setup: input.setup,
    horizon: Math.max(reportT, 1e-9),
  }).filter(l => l.ccy === input.ccy);

  const hedgeDeltaLocalM =
    typeof input.hedgeDeltaLocalM === 'number' &&
    Number.isFinite(input.hedgeDeltaLocalM)
      ? input.hedgeDeltaLocalM
      : strategyLegs.reduce((s, l) => s + l.amountLocalM, 0);
  if (Math.abs(hedgeDeltaLocalM) < 1e-12) return null;

  const bookRow = bookRowByCcy(input.bookRows, input.ccy);
  const profile = input.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
  const monthlyNets = bookRow
    ? monthlyFlowSeriesLocalM(bookRow, reportT, profile)
    : Array.from({ length: reportT }, () => 0);
  const pathBase = {
    openingCashM: bookRow ? interestBearingCashM(bookRow) : 0,
    monthlyNets,
    throughMonths: reportT,
    marketRates: input.marketRates,
    ccy: input.ccy,
  };

  const unhedged = simulateSettleCashPath({
    ...pathBase,
    settleCashFlowsByMonth: new Map(),
  });
  const unhedgedCarryUsdM = unhedged.fcyInterestUsdM;

  const n = Math.max(1, Math.min(reportT, Math.round(input.legCount)));
  const com =
    typeof input.centerOfMass === 'number' && Number.isFinite(input.centerOfMass)
      ? Math.min(1, Math.max(0, input.centerOfMass))
      : 0.5;
  const kurt =
    typeof input.kurtosis === 'number' && Number.isFinite(input.kurtosis)
      ? Math.min(1, Math.max(-1, input.kurtosis))
      : 0;
  const target = Math.min(reportT, Math.max(0, input.targetWamMonths));

  const custom = buildCustomStripLegs(
    input.customSettleMonths,
    input.customWeights,
    reportT,
    hedgeDeltaLocalM,
  );

  let legs: { settleMonths: number; amountLocalM: number }[];
  let weights: number[];
  if (custom) {
    legs = custom.legs;
    weights = custom.weights;
  } else if (n === 1) {
    weights = [1];
    legs = [{ settleMonths: target, amountLocalM: hedgeDeltaLocalM }];
  } else {
    weights = shapedStripScheduleWeights(n, com, kurt);
    const ends = endMonthsFromScheduleWeights(weights, reportT);
    const amounts = weights.map(w => w * hedgeDeltaLocalM);
    const settles = pinSettleMonthsToWam(ends, amounts, target, reportT);
    legs = settles.map((settleMonths, i) => ({
      settleMonths,
      amountLocalM: amounts[i]!,
    }));
  }
  const effectiveLegCount = legs.length;

  const path = simulateSettleCashPath({
    ...pathBase,
    settleCashFlowsByMonth: settleCashFlowsFromLegs(legs),
  });
  const fwdCarryUsdM = fwdCarryForLegsUsdM(legs, input.marketRates);
  const newCarryUsdM = path.newCarryUsdM;
  const interestDeltaUsdM = newCarryUsdM - unhedgedCarryUsdM;
  const enhancementUsdM = interestDeltaUsdM + fwdCarryUsdM;
  const wamMonths = hedgeSettleWamMonths(
    legs.map(l => ({
      ccy: input.ccy,
      amountLocalM: l.amountLocalM,
      settleMonths: l.settleMonths,
      recognizeMonths: 0,
      structure: effectiveLegCount === 1 ? ('bullet' as const) : ('strip' as const),
    })),
  );
  const legBars: StripShapeLegBar[] = legs.map((l, i) => ({
    settleMonths: l.settleMonths,
    amountLocalM: l.amountLocalM,
    weight: weights[i] ?? 1 / legs.length,
    label: `L${i + 1}`,
  }));

  return {
    legCount: effectiveLegCount,
    centerOfMass: effectiveLegCount === 1 ? 0.5 : com,
    kurtosis: effectiveLegCount === 1 ? 0 : kurt,
    structure: effectiveLegCount === 1 ? 'bullet' : 'strip',
    settleMonths: legs.map(l => l.settleMonths),
    legs: legBars,
    settleScheduleLabel:
      target <= 1e-12 && effectiveLegCount === 1
        ? 'M1·start'
        : settleScheduleLabel(legs),
    wamMonths,
    hedgeDeltaLocalM,
    enhancementUsdM,
    interestDeltaUsdM,
    fwdCarryUsdM,
    newCarryUsdM,
    fcyInterestUsdM: path.fcyInterestUsdM,
    usdInterestUsdM: path.usdInterestUsdM,
    vsBulletUsdM: 0,
  };
}

/**
 * Grid-search strip leg count × center-of-mass × kurtosis around a pinned WAM.
 * Objective: maximize Enhancement (New − Old + FWD pts) at fixed hedge Δ.
 */
export function optimizeStripShapeAroundWam(input: {
  ccy: string;
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRates: FxMarketRatesBundle;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  targetWamMonths: number;
  hedgeDeltaLocalM?: number;
  /** Max strip legs to search (clamped to Tf). Default min(8, Tf). */
  maxLegCount?: number;
  centerOfMassSteps?: readonly number[];
  kurtosisSteps?: readonly number[];
  topN?: number;
}): OptimizeStripShapeResult | null {
  const Tf =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? Math.floor(input.setup.forecastMonths + 1e-12)
      : Math.floor(horizonMonths(input.setup.horizon) + 1e-12);
  if (!(Tf > 0)) return null;

  const target = Math.min(Tf, Math.max(0, input.targetWamMonths));
  const startConversion = target <= 1e-12;
  const base = {
    ccy: input.ccy,
    risk: input.risk,
    setup: input.setup,
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    marketRates: input.marketRates,
    bookRows: input.bookRows,
    forecastProfile: input.forecastProfile,
    targetWamMonths: target,
    hedgeDeltaLocalM: input.hedgeDeltaLocalM,
  };

  const bullet = scoreStripShapeAroundWam({
    ...base,
    legCount: 1,
    centerOfMass: 0.5,
    kurtosis: 0,
  });
  if (!bullet) return null;

  const maxLegs = Math.max(
    2,
    Math.min(Tf, Math.floor(input.maxLegCount ?? Math.min(8, Tf))),
  );
  const comSteps = input.centerOfMassSteps ?? [0.15, 0.3, 0.5, 0.7, 0.85];
  const kurtSteps = input.kurtosisSteps ?? [-1, -0.5, 0, 0.5, 1];
  const topN = Math.max(1, Math.floor(input.topN ?? 8));

  const candidates: StripShapeScore[] = [
    { ...bullet, vsBulletUsdM: 0 },
  ];

  for (let n = 2; n <= maxLegs; n++) {
    for (const com of comSteps) {
      for (const kurt of kurtSteps) {
        const scored = scoreStripShapeAroundWam({
          ...base,
          legCount: n,
          centerOfMass: com,
          kurtosis: kurt,
        });
        if (!scored) continue;
        candidates.push({
          ...scored,
          vsBulletUsdM: scored.enhancementUsdM - bullet.enhancementUsdM,
        });
      }
    }
  }

  candidates.sort((a, b) => b.enhancementUsdM - a.enhancementUsdM);
  const best = candidates[0]!;
  return {
    targetWamMonths: target,
    startConversion,
    bullet: { ...bullet, vsBulletUsdM: 0 },
    best,
    top: candidates.slice(0, topN),
    candidates,
  };
}

/**
 * Settle-WAM ladder for a **fixed** strip/bullet shape (legs × CoM × kurtosis).
 * Same shape is pinned to each Mm so the desk can re-check whether the
 * selected WAM is still optimal after Apply shape.
 */
export function buildShapedSettleWamScenarios(input: {
  ccy: string;
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRates: FxMarketRatesBundle;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  legCount: number;
  centerOfMass: number;
  kurtosis: number;
  maxSettleMonths?: number;
  hedgeDeltaLocalM?: number;
  /**
   * Override “book” WAM marker (e.g. applied shape’s realized WAM). When
   * omitted, uses notional-weighted settle WAM of strategy legs.
   */
  bookWamMonths?: number;
}): SettleWamScenario[] {
  const Tf =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? Math.floor(input.setup.forecastMonths + 1e-12)
      : Math.floor(horizonMonths(input.setup.horizon) + 1e-12);
  const reportT = Math.max(0, Tf);
  const maxM = Math.max(
    1,
    Math.min(24, Math.floor(input.maxSettleMonths ?? 12)),
  );
  if (!(reportT > 0)) return [];

  const strategyLegs = collectHedgeLegs({
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    setup: input.setup,
    horizon: Math.max(reportT, 1e-9),
  }).filter(l => l.ccy === input.ccy);

  const hedgeDeltaLocalM =
    typeof input.hedgeDeltaLocalM === 'number' &&
    Number.isFinite(input.hedgeDeltaLocalM)
      ? input.hedgeDeltaLocalM
      : strategyLegs.reduce((s, l) => s + l.amountLocalM, 0);
  if (Math.abs(hedgeDeltaLocalM) < 1e-12) return [];

  const currentWam =
    typeof input.bookWamMonths === 'number' &&
    Number.isFinite(input.bookWamMonths)
      ? input.bookWamMonths
      : hedgeSettleWamMonths(strategyLegs);
  let currentIdx = 1;
  let bestDist = Infinity;
  for (let m = 1; m <= maxM; m++) {
    const d = Math.abs(m - currentWam);
    if (d < bestDist) {
      bestDist = d;
      currentIdx = m;
    }
  }

  const base = {
    ccy: input.ccy,
    risk: input.risk,
    setup: input.setup,
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    marketRates: input.marketRates,
    bookRows: input.bookRows,
    forecastProfile: input.forecastProfile,
    hedgeDeltaLocalM,
    legCount: input.legCount,
    centerOfMass: input.centerOfMass,
    kurtosis: input.kurtosis,
  };

  const bookScore = scoreStripShapeAroundWam({
    ...base,
    targetWamMonths: currentIdx,
  });
  if (!bookScore) return [];
  const bookEnhancement = bookScore.enhancementUsdM;
  const unhedgedCarryUsdM =
    bookScore.newCarryUsdM - bookScore.interestDeltaUsdM;
  const defaultCarryUsdM = unhedgedCarryUsdM;

  const scenarios: SettleWamScenario[] = [];
  for (let m = 1; m <= maxM; m++) {
    const scored = scoreStripShapeAroundWam({
      ...base,
      targetWamMonths: m,
    });
    if (!scored) continue;
    const enhancementUsdM = scored.enhancementUsdM;
    scenarios.push({
      settleMonths: m,
      label: `M${m}`,
      isCurrentWam: m === currentIdx,
      beyondForecast: reportT > 0 && m > reportT,
      structure: scored.structure,
      legCount: scored.legCount,
      hedgeDeltaLocalM,
      settledCashFlowM: -hedgeDeltaLocalM,
      settleScheduleLabel: scored.settleScheduleLabel,
      defaultCarryUsdM,
      unhedgedCarryUsdM,
      newCarryUsdM: scored.newCarryUsdM,
      fwdCarryUsdM: scored.fwdCarryUsdM,
      fcyInterestUsdM: scored.fcyInterestUsdM,
      usdInterestUsdM: scored.usdInterestUsdM,
      interestDeltaUsdM: scored.interestDeltaUsdM,
      enhancementUsdM,
      totalUsdM: enhancementUsdM,
      totalCarryUsdM: scored.newCarryUsdM + scored.fwdCarryUsdM,
      enhancementVsBookUsdM: enhancementUsdM - bookEnhancement,
      totalVsBookUsdM: enhancementUsdM - bookEnhancement,
    });
  }
  return scenarios;
}

/**
 * CIP / market validation for settle-WAM scenarios.
 *
 * Early full settle (EUR OD + USD credit) and late FWD points are two ways to
 * realize the same interest differential — not two independent profits.
 * Cash markets with debit/credit spreads must not beat mid forward points.
 */
export interface SettleWamCipValidation {
  hedgeDeltaLocalM: number;
  Tf: number;
  spotMid: number;
  m0EnhancementUsdM: number;
  m0TotalUsdM: number;
  bookTotalUsdM: number;
  tfFwdBidUsdM: number;
  tfFwdMidUsdM: number;
  /** N·S·(r_usd_credit − r_eur_debit)·Tf/12 using overnight cash. */
  overnightSpreadSyntheticUsdM: number;
  /** N·S·(r_usd_mid − r_eur_mid)·Tf/12 using overnight cash. */
  overnightMidSyntheticUsdM: number;
  /** Same client spread using term deposits @ Tf. */
  termSpreadSyntheticUsdM: number;
  overnightSource: string;
  termSource: string;
  /** M0 Enhancement − Tf FWD bid (≈0 ⇒ substitutes). */
  substituteGapUsdM: number;
  /** True if overnight client spreads beat mid FWD — should be false. */
  cashSpreadsBeatMidFwd: boolean;
  /** True if |M0 Enh − Tf FWD| is small vs |Tf FWD|. */
  areSubstitutes: boolean;
  /** True if spot-collapse Total beats book Total (false lunch for strips). */
  spotBeatsBookOnTotal: boolean;
  pass: boolean;
  verdict: string;
}

export function validateSettleWamVsFwd(input: {
  scenarios: readonly SettleWamScenario[];
  marketRates: FxMarketRatesBundle;
  ccy: string;
  Tf?: number;
}): SettleWamCipValidation | null {
  // Start conversion: M0 (strip) or bullet M1·start (settle opening, 0 FWD).
  const m0 =
    input.scenarios.find(s => s.settleScheduleLabel.includes('start')) ??
    input.scenarios.find(s => s.settleMonths === 0) ??
    input.scenarios[0];
  if (!m0 || Math.abs(m0.hedgeDeltaLocalM) < 1e-12) return null;

  const Tf =
    typeof input.Tf === 'number' && input.Tf > 0
      ? Math.floor(input.Tf + 1e-12)
      : Math.max(
          ...input.scenarios.map(s => s.settleMonths),
          12,
        );
  const N = m0.hedgeDeltaLocalM;
  const spotMid = input.marketRates.spot?.mid ?? fcyToUsdM(1, input.ccy);
  const notionalUsdM = Math.abs(N) * Math.max(1e-12, spotMid);
  const tYears = Math.max(1e-12, Tf / 12);

  const overnight = resolveOvernightCashRates(input.marketRates, input.ccy);
  const term = resolveForwardDepositRates(
    input.marketRates,
    input.ccy,
    Tf,
  );

  const overnightSpreadSyntheticUsdM =
    notionalUsdM *
    ((overnight.usd.creditPct - overnight.fcy.debitPct) / 100) *
    tYears;
  const oMidUsd =
    (overnight.usd.creditPct + overnight.usd.debitPct) / 2;
  const oMidFcy =
    (overnight.fcy.creditPct + overnight.fcy.debitPct) / 2;
  const overnightMidSyntheticUsdM =
    notionalUsdM * ((oMidUsd - oMidFcy) / 100) * tYears;

  const termSpreadSyntheticUsdM =
    notionalUsdM *
    ((term.usd.creditPct - term.fcy.debitPct) / 100) *
    tYears;

  const tfFwd = fwdCarryFromSwapPointsUsdM({
    notionalLocalM: N,
    settleMonths: Math.max(Tf, 0.25),
    bundle: input.marketRates,
  });
  const tfFwdBidUsdM = tfFwd?.fwdCarryUsdM ?? 0;
  const curve = interpolateSwapPoints(input.marketRates.deposits, Tf);
  const tfFwdMidUsdM = curve
    ? N * swapPointsToPriceDelta(curve.mid, input.marketRates.pair || 'EURUSD')
    : tfFwdBidUsdM;

  const book = input.scenarios.find(s => s.isCurrentWam) ?? m0;
  const m0EnhancementUsdM = m0.enhancementUsdM;
  const m0TotalUsdM = m0.totalUsdM;
  const bookTotalUsdM = book.totalUsdM;
  // Interest-only gap vs FWD (CIP substitute check) — FWD is already in Enhancement.
  const substituteGapUsdM = m0.interestDeltaUsdM - tfFwdBidUsdM;
  const scale = Math.max(Math.abs(tfFwdBidUsdM), 50e-3);
  const areSubstitutes = Math.abs(m0TotalUsdM - bookTotalUsdM) <= 0.2 * scale;
  const cashSpreadsBeatMidFwd =
    overnightSpreadSyntheticUsdM > tfFwdMidUsdM + 1e-6;

  // Rank on Enhancement (= New − Old + FWD). Allow ~15% CIP noise.
  const tol = 0.15 * scale;
  const m0TotalBeatsMidFwd = m0TotalUsdM > tfFwdMidUsdM + tol;
  const spotBeatsBookOnTotal = m0TotalUsdM > bookTotalUsdM + tol;
  const pass =
    !cashSpreadsBeatMidFwd && !m0TotalBeatsMidFwd && !spotBeatsBookOnTotal;

  const verdict = pass
    ? `PASS — Enhancement = New − Old + FWD. M0 ${((m0TotalUsdM) * 1000).toFixed(0)}K ≈ book ${((bookTotalUsdM) * 1000).toFixed(0)}K ≈ mid FWD ${((tfFwdMidUsdM) * 1000).toFixed(0)}K (CIP). O/N client spreads ${((overnightSpreadSyntheticUsdM) * 1000).toFixed(0)}K < mid FWD.`
    : `FAIL — spot Enhancement materially beats forwards (M0 ${((m0TotalUsdM) * 1000).toFixed(0)}K vs book ${((bookTotalUsdM) * 1000).toFixed(0)}K / mid FWD ${((tfFwdMidUsdM) * 1000).toFixed(0)}K). Check strip scheduling and O/N vs swap-point consistency.`;

  return {
    hedgeDeltaLocalM: N,
    Tf,
    spotMid,
    m0EnhancementUsdM,
    m0TotalUsdM,
    bookTotalUsdM,
    tfFwdBidUsdM,
    tfFwdMidUsdM,
    overnightSpreadSyntheticUsdM,
    overnightMidSyntheticUsdM,
    termSpreadSyntheticUsdM,
    overnightSource: overnight.source,
    termSource: term.source,
    substituteGapUsdM,
    cashSpreadsBeatMidFwd,
    areSubstitutes,
    spotBeatsBookOnTotal,
    pass,
    verdict,
  };
}

/**
 * Carry evolution bars for one CCY: one column per forecast month M1…MTf.
 * Cumulative dual cash book income through each month-end.
 */
export function buildCarryEvolutionBars(input: {
  ccy: string;
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRates: FxMarketRatesBundle;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
}): CarryEvolutionBar[] {
  const row = input.risk.find(r => r.bar.ccy === input.ccy);
  if (!row) return [];

  const TfRaw =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? input.setup.forecastMonths
      : horizonMonths(input.setup.horizon);
  const Tf = Math.max(0, Math.floor(TfRaw + 1e-12));
  if (Tf < 1) return [];

  const { exposureM } = exposureForSetup(row, input.setup);

  const hedgeLegs = collectHedgeLegs({
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    setup: input.setup,
    horizon: Math.max(Tf, 1e-9),
  }).filter(l => l.ccy === input.ccy);

  const columns = Array.from({ length: Tf }, (_, i) => {
    const month = i + 1;
    return {
      id: `m${month}`,
      label: `M${month}`,
      months: month,
    };
  });

  const hasStrip = hedgeLegs.some(l => l.structure === 'strip');
  const hasBullet = hedgeLegs.some(l => l.structure === 'bullet');
  const structure: HedgeImprovementBreakdown['structure'] =
    hedgeLegs.length === 0
      ? 'none'
      : hasStrip && !hasBullet
        ? 'strip'
        : hasBullet && !hasStrip
          ? 'bullet'
          : 'strip';
  const hedgeDeltaLocalM = hedgeLegs.reduce(
    (s, l) => s + l.amountLocalM,
    0,
  );

  return columns.map(col => {
    const t = col.months;
    const forecastMonths = Math.max(1, Math.round(col.months));
    const schedBase = {
      ccy: input.ccy,
      bookRows: input.bookRows,
      forecastProfile: input.forecastProfile,
      forecastMonths,
      marketRates: input.marketRates,
      setup: input.setup,
    };
    // Same dual cash book as Planned Consolidated Hedged Cash forecast.
    const hedged = buildCashForecastSchedule({
      ...schedBase,
      bookedHedges: input.bookedHedges,
      preparedByCcy: input.preparedByCcy,
    });
    const unhedged = buildCashForecastSchedule({
      ...schedBase,
      bookedHedges: [],
      preparedByCcy: {},
    });
    const defaultCarryUsdM = unhedged?.totals.incomeUsdM ?? 0;
    const fwdCarryUsdM = hedged?.totals.fwdCarryUsdM ?? 0;
    const fcyInterestUsdM = hedged?.totals.residualEurInterestUsdM ?? 0;
    const usdInterestUsdM = hedged?.totals.usdInterestUsdM ?? 0;
    const hedgedIncomeUsdM = hedged?.totals.incomeUsdM ?? 0;
    const hedgeImprovementUsdM = hedgedIncomeUsdM - defaultCarryUsdM;
    const hedgeBreakdown: HedgeImprovementBreakdown = {
      hedgeDeltaLocalM,
      fwdCarryUsdM,
      fcyInterestUsdM,
      usdInterestUsdM,
      totalUsdM: hedgeImprovementUsdM,
      structure,
      legCount: hedgeLegs.length,
    };
    const pts =
      t > 1e-12
        ? fwdCarryFromSwapPointsUsdM({
            notionalLocalM: exposureM,
            settleMonths: t,
            bundle: input.marketRates,
          })
        : null;
    return {
      id: col.id,
      label: col.label,
      months: col.months,
      defaultCarryUsdM,
      hedgeImprovementUsdM,
      improvedCarryUsdM: hedgedIncomeUsdM,
      hedgeBreakdown,
      swapPoints: pts?.points ?? null,
      swapPointsSide: pts?.side ?? null,
      exposureFwdCarryUsdM: pts?.fwdCarryUsdM ?? 0,
      view: 'structure',
    };
  });
}

/**
 * Per-leg bars from explicit settle/Δ samples (prepared package or applied
 * shape preview). Same metrics as Carry Evolution · Per leg.
 */
export function buildCarryEvolutionLegBarsFromSamples(input: {
  ccy: string;
  setup: VarSetup;
  marketRates: FxMarketRatesBundle;
  legs: readonly {
    settleMonths: number;
    amountLocalM: number;
    recognizeMonths?: number;
    structure?: 'bullet' | 'strip';
    label?: string;
  }[];
}): CarryEvolutionBar[] {
  const TfRaw =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? input.setup.forecastMonths
      : horizonMonths(input.setup.horizon);
  const Tf = Math.max(0, Math.floor(TfRaw + 1e-12));
  if (Tf < 1 || input.legs.length === 0) return [];

  const reportT = Math.max(Tf, 1e-12);
  const multi = input.legs.length > 1;

  return input.legs.map((leg, index) => {
    const settle = Math.max(0, leg.settleMonths);
    const recog = Math.max(
      0,
      Math.min(leg.recognizeMonths ?? 0, settle),
    );
    const structure = leg.structure ?? (multi ? 'strip' : 'bullet');
    const fwd = resolveForwardDepositRates(
      input.marketRates,
      input.ccy,
      Math.max(settle, 0.25),
    );
    const fcyHorizon = Math.max(0, settle - recog);
    const usdHorizon = Math.max(0, reportT - settle);
    const fcyCash = resolveCashRatesForHorizon(
      input.marketRates,
      input.ccy,
      fcyHorizon,
    );
    const usdCash = resolveCashRatesForHorizon(
      input.marketRates,
      input.ccy,
      usdHorizon,
    );
    // Do-nothing: FCY cash for full Tf at term-matched tenor.
    const defaultCash = resolveCashRatesForHorizon(
      input.marketRates,
      input.ccy,
      reportT,
    );
    const pts =
      settle < 1 - 1e-12
        ? null
        : fwdCarryFromSwapPointsUsdM({
            notionalLocalM: leg.amountLocalM,
            settleMonths: settle,
            bundle: input.marketRates,
          });
    const usdNotional = leg.amountLocalM * fcyToUsdM(1, input.ccy);
    const fcyPick = selectCreditDebitRate(
      leg.amountLocalM,
      defaultCash.fcy.creditPct,
      defaultCash.fcy.debitPct,
    );
    const defaultCarryUsdM =
      usdNotional * (fcyPick.ratePct / 100) * (reportT / 12);

    const carry = stripHedgeLegCarryUsdM({
      notionalLocalM: leg.amountLocalM,
      ccy: input.ccy,
      recognizeMonths: recog,
      settleMonths: settle,
      forecastEndMonths: reportT,
      fcyFwdRates: fwd.fcy,
      usdFwdRates: fwd.usd,
      fcyCashRates: fcyCash.fcy,
      usdCashRates: usdCash.usd,
      swapPointsCarryUsdM: pts?.fwdCarryUsdM ?? 0,
      swapPoints: pts?.points,
      swapPointsSide: pts?.side,
    });
    const improvedCarryUsdM = carry.totalUsdM;
    const hedgeImprovementUsdM = improvedCarryUsdM - defaultCarryUsdM;
    const settleLabel = settle < 1 - 1e-12 ? 'M0' : `M${Math.round(settle)}`;
    const label =
      leg.label ??
      (!multi && structure === 'bullet'
        ? `Bullet · ${settleLabel}`
        : `L${index + 1} · ${settleLabel}`);

    return {
      id: `leg-${index}`,
      label,
      months: Math.max(settle, 1e-9),
      defaultCarryUsdM,
      hedgeImprovementUsdM,
      improvedCarryUsdM,
      hedgeBreakdown: {
        hedgeDeltaLocalM: leg.amountLocalM,
        fwdCarryUsdM: carry.fwdCarryUsdM,
        fcyInterestUsdM: carry.fcyInterestUsdM,
        usdInterestUsdM: carry.usdInterestUsdM,
        totalUsdM: hedgeImprovementUsdM,
        structure,
        legCount: 1,
      },
      swapPoints: pts?.points ?? null,
      swapPointsSide: pts?.side ?? null,
      exposureFwdCarryUsdM: pts?.fwdCarryUsdM ?? 0,
      view: 'leg' as const,
      legIndex: index,
      amountLocalM: leg.amountLocalM,
    };
  });
}

/**
 * Per-leg carry evolution: one column per strip/bullet leg with **final**
 * accrued carry (FWD + FCY + USD through Tf) and enhancement vs do-nothing
 * on that leg’s notional. Notional attribution — sums may differ from the
 * dual cash-book structure view.
 */
export function buildCarryEvolutionLegBars(input: {
  ccy: string;
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRates: FxMarketRatesBundle;
}): CarryEvolutionBar[] {
  const row = input.risk.find(r => r.bar.ccy === input.ccy);
  if (!row) return [];

  const TfRaw =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? input.setup.forecastMonths
      : horizonMonths(input.setup.horizon);
  const Tf = Math.max(0, Math.floor(TfRaw + 1e-12));
  if (Tf < 1) return [];

  const hedgeLegs = collectHedgeLegs({
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    setup: input.setup,
    horizon: Math.max(Tf, 1e-9),
  }).filter(l => l.ccy === input.ccy);

  if (hedgeLegs.length === 0) return [];

  return buildCarryEvolutionLegBarsFromSamples({
    ccy: input.ccy,
    setup: input.setup,
    marketRates: input.marketRates,
    legs: hedgeLegs.map(l => ({
      settleMonths: l.settleMonths,
      amountLocalM: l.amountLocalM,
      recognizeMonths: l.recognizeMonths,
      structure: l.structure,
    })),
  });
}

/**
 * Sample cash / implied-FWD / hedge carry at months along [0, Tf].
 * Chart x-axis matches the Analytics exposure forecast period.
 */
export function buildCarryHorizonSeries(input: {
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRates: FxMarketRatesBundle;
  horizonMonths: number;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
}): CarryHorizonPoint[] {
  const Tf = Math.max(0, input.horizonMonths);
  if (Tf < 1e-12) {
    return [
      {
        months: 0,
        label: 'M0',
        cashInterestUsdM: 0,
        exposureFwdCarryUsdM: 0,
        hedgeCarryUsdM: 0,
        netUsdM: 0,
        swapPoints: null,
        swapPointsSide: null,
      },
    ];
  }

  const monthSet = new Set<number>([0, Tf]);
  const ceilTf = Math.ceil(Tf - 1e-9);
  for (let m = 1; m <= ceilTf; m++) {
    if (m <= Tf + 1e-9) monthSet.add(m);
  }
  for (const d of input.marketRates.deposits) {
    if (d.months != null && d.months > 0 && d.months <= Tf + 1e-9) {
      monthSet.add(d.months);
    }
  }
  const hedgeLegs = collectHedgeLegs({
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    setup: input.setup,
    horizon: Tf,
  });
  for (const leg of hedgeLegs) {
    if (leg.settleMonths > 0 && leg.settleMonths <= Tf + 1e-9) {
      monthSet.add(leg.settleMonths);
    }
  }
  const months = [...monthSet].sort((a, b) => a - b);

  const exposureRows = input.risk
    .map(row => {
      const { exposureM } = exposureForSetup(row, input.setup);
      if (Math.abs(exposureM) < 1e-12) return null;
      return { ccy: row.bar.ccy, exposureM };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  return months.map(t => {
    const cashInterestUsdM = input.risk.reduce((s, row) => {
      const path = cashPathForCcy({
        ccy: row.bar.ccy,
        bookRows: input.bookRows,
        forecastProfile: input.forecastProfile,
        throughMonths: t,
        marketRates: input.marketRates,
      });
      return s + (path?.interestUsdM ?? 0);
    }, 0);

    let exposureFwdCarryUsdM = 0;
    let swapPoints: number | null = null;
    let swapPointsSide: 'bid' | 'ask' | 'mid' | null = null;
    if (t > 1e-12) {
      for (const r of exposureRows) {
        const pts = fwdCarryFromSwapPointsUsdM({
          notionalLocalM: r.exposureM,
          settleMonths: t,
          bundle: input.marketRates,
        });
        if (pts) {
          exposureFwdCarryUsdM += pts.fwdCarryUsdM;
          if (swapPoints == null) {
            swapPoints = pts.points;
            swapPointsSide = pts.side;
          }
        }
      }
    }

    const hedgeCarryUsdM = hedgeCarryAccruedToT(
      hedgeLegs,
      t,
      input.marketRates,
    );

    const label =
      Math.abs(t - Math.round(t)) < 1e-6
        ? `M${Math.round(t)}`
        : `t=${t.toFixed(2)}`;
    return {
      months: t,
      label,
      cashInterestUsdM,
      exposureFwdCarryUsdM,
      hedgeCarryUsdM,
      netUsdM: cashInterestUsdM + hedgeCarryUsdM,
      swapPoints,
      swapPointsSide,
    };
  });
}

/**
 * Build Cash Carry analytics for the entity/group book.
 * Includes Analytics-prepared packages (pending Send) and live booked hedges.
 * Horizon / chart x-axis = exposure forecast Tf.
 */
export function buildCashCarryAnalytics(input: {
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRates: FxMarketRatesBundle;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
}): CashCarryAnalytics {
  const Tf =
    typeof input.setup.forecastMonths === 'number' &&
    input.setup.forecastMonths > 0
      ? input.setup.forecastMonths
      : horizonMonths(input.setup.horizon);
  const horizon = Math.max(Tf, 1e-9);

  const cashInterest: CashInterestLayerRow[] = [];
  let ratesSource = 'CURRENCY_PARAMS NP';

  for (const row of input.risk) {
    const path = cashPathForCcy({
      ccy: row.bar.ccy,
      bookRows: input.bookRows,
      forecastProfile: input.forecastProfile,
      throughMonths: horizon,
      marketRates: input.marketRates,
    });
    if (!path) continue;
    if (
      Math.abs(path.openingCashM) < 1e-12 &&
      Math.abs(path.revenueInflowM) < 1e-12 &&
      Math.abs(path.interestUsdM) < 1e-12
    ) {
      continue;
    }
    ratesSource = path.source;
    cashInterest.push({
      ccy: row.bar.ccy,
      openingCashM: path.openingCashM,
      revenueInflowM: path.revenueInflowM,
      payoutOutflowM: path.payoutOutflowM,
      endCashM: path.endCashM,
      avgCashM: path.avgCashM,
      side: path.side,
      ratePct: path.ratePct,
      creditPct: path.creditPct,
      debitPct: path.debitPct,
      months: horizon,
      interestUsdM: path.interestUsdM,
      forecastMode: path.forecastMode,
      growthRateMoM: path.growthRateMoM,
    });
  }

  const hedgeCarry: HedgeCarryLayerRow[] = [];

  // Layer 2a — Analytics-prepared (not yet Sent)
  for (const [ccy, prep] of Object.entries(input.preparedByCcy ?? {})) {
    if (prep.structure === 'strip' && prep.legs.length > 0) {
      let prev = 0;
      for (const leg of prep.legs) {
        const delta =
          typeof leg.tradeNotionalLocalM === 'number'
            ? leg.tradeNotionalLocalM
            : leg.hedgeLocalM - prev;
        prev = leg.hedgeLocalM;
        if (Math.abs(delta) < 1e-12) continue;
        const settle = leg.settleMonths ?? leg.endMonth;
        ratesSource = pushFwdCarryRow(hedgeCarry, {
          ccy,
          ticketId: `prep-${ccy}-${leg.index}`,
          label: `${leg.label} · prepared`,
          structure: 'strip',
          status: 'prepared',
          amountLocalM: delta,
          settleMonths: settle,
          horizon,
          marketRates: input.marketRates,
        });
      }
      continue;
    }
    if (Math.abs(prep.coverLocalM) < 1e-12) continue;
    const bulletSettle =
      prep.settleMonths != null ? prep.settleMonths : horizon;
    ratesSource = pushFwdCarryRow(hedgeCarry, {
      ccy,
      ticketId: `prep-${ccy}-bullet`,
      label: `M0–M${Math.round(bulletSettle)} · prepared`,
      structure: 'bullet',
      status: 'prepared',
      amountLocalM: prep.coverLocalM,
      settleMonths: bulletSettle,
      horizon,
      marketRates: input.marketRates,
    });
  }

  // Layer 2b — live booked (skip CCY that already has a prepared package)
  const preparedCcys = new Set(
    Object.entries(input.preparedByCcy ?? {})
      .filter(
        ([, prep]) =>
          (prep.structure === 'strip' && prep.legs.length > 0) ||
          Math.abs(prep.coverLocalM) >= 1e-12,
      )
      .map(([ccy]) => ccy),
  );
  for (const t of input.bookedHedges.filter(isLiveHedgeTicket)) {
    if (preparedCcys.has(t.ccy)) continue;
    const settle = tenureMonthsFromTicket(t, input.setup);
    if (t.instrument === 'spot') {
      const overnight = resolveOvernightCashRates(input.marketRates, t.ccy);
      ratesSource = overnight.source;
      const pick = selectCreditDebitRate(
        t.amountLocalM,
        overnight.fcy.creditPct,
        overnight.fcy.debitPct,
      );
      const usdNotional = t.amountLocalM * fcyToUsdM(1, t.ccy);
      const interestUsdM =
        usdNotional * (pick.ratePct / 100) * (horizon / 12);
      hedgeCarry.push({
        ccy: t.ccy,
        ticketId: t.id,
        label: `SPOT ${t.ccy}`,
        structure: 'spot',
        status: 'booked',
        amountLocalM: t.amountLocalM,
        settleMonths: 0,
        fwdCarryUsdM: 0,
        fcyInterestUsdM: interestUsdM,
        usdInterestUsdM: 0,
        totalUsdM: interestUsdM,
        rFcyPct: pick.ratePct,
        rUsdPct: 0,
        fcySide: pick.side,
        usdSide: 'credit',
      });
      continue;
    }
    ratesSource = pushFwdCarryRow(hedgeCarry, {
      ccy: t.ccy,
      ticketId: t.id,
      label:
        t.stripId != null
          ? `${t.maturityLabel ?? t.maturity ?? 'FWD'} · strip`
          : `${t.maturityLabel ?? t.maturity ?? 'FWD'} · bullet`,
      structure: t.stripId != null ? 'strip' : 'bullet',
      status: 'booked',
      amountLocalM: t.amountLocalM,
      settleMonths: settle,
      horizon,
      marketRates: input.marketRates,
    });
  }

  const cashInterestUsdM = cashInterest.reduce((s, r) => s + r.interestUsdM, 0);
  const hedgeCarryUsdM = hedgeCarry.reduce((s, r) => s + r.totalUsdM, 0);
  const horizonSeries = buildCarryHorizonSeries({
    risk: input.risk,
    setup: input.setup,
    bookedHedges: input.bookedHedges,
    preparedByCcy: input.preparedByCcy,
    marketRates: input.marketRates,
    horizonMonths: horizon,
    bookRows: input.bookRows,
    forecastProfile: input.forecastProfile,
  });

  return {
    cashInterest,
    hedgeCarry,
    horizonSeries,
    totals: {
      cashInterestUsdM,
      hedgeCarryUsdM,
      netUsdM: cashInterestUsdM + hedgeCarryUsdM,
    },
    ratesSource,
    horizonMonths: horizon,
  };
}
