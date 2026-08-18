/**
 * FX-hedge Net CFaR per currency — cover sizing and displayed headlines.
 *
 * Cover is Monte Carlo size + timing only (ledger A vs C). It does not revalue
 * the structural funding gap at simulated spot, and it does not read liquidity
 * buffer layers or the funding swap, so a CFaR-cover swap sized from this
 * number cannot feed back into its own size.
 *
 * Displayed CFaR RSS-combines the funding-swap rate-diff bridge in a second
 * pass after the desk has booked the swap.
 */

import { CURRENCY_PARAMS, fxBookNetLocalM, type RowState } from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  effectiveForecastUncertainty1m,
  monthlyInflowSeriesLocalM,
  monthlyOutflowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import { resolveMarketRatesForCcy, type FxMarketRatesBundle } from '@/lib/fx-market-rates';
import {
  analyticsForwardsFromOverlays,
  retainedFundingPlanByCcy,
  type SwapForwardOverlay,
} from '@/lib/fx-hedge';
import {
  buildCashForecastCarryComparison,
  resolvedHedgedTotalCarryUsdM,
  type AnalyticsForwardLeg,
} from '@/lib/test-mode/cash-carry-analytics';
import {
  applyFundingSwapBridge,
  fundingSwapBridgeBands,
  fundingSwapOutstandingByMonth,
} from '@/lib/test-mode/cfar-funding-swap';
import {
  computeMonteCarloMismatchCfar,
  type McCfarInput,
  type McHedgeSettleLeg,
} from '@/lib/test-mode/cfar-montecarlo';
import { rateVolBpYrFor } from '@/lib/test-mode/cfar-residual';
import type { CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';
import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  isLiveHedgeTicket,
  stripTicketsForCcy,
  type HedgeTicket,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import {
  horizonMonths,
  monthlyVolForSetup,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

export type FxHedgeCfarInput = {
  rows: readonly RowState[];
  setup: VarSetup;
  forecastProfile?: ForecastProfileState | null;
  bookedHedges?: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  ratesScopeId?: string | null;
  /**
   * Outstanding funding-swap book per CCY. Omit for cover sizing (FX-only).
   * Pass the live / strategy plan to get displayed Net CFaR.
   * When {@link swapForwardOverlayByCcy} is set, standing/far are scaled by
   * (1−Δ) for the bridge only — never written back into liquidityCycles.
   */
  fundingPlanByCcy?: Readonly<
    Record<string, readonly { standing_swap: number; far_leg?: number }[]>
  >;
  /** Desk Swap+Fwd replacement overlays — gross forward + retained-far scale. */
  swapForwardOverlayByCcy?: Readonly<Record<string, SwapForwardOverlay>>;
};

function hashSeedForCcy(ccy: string): number {
  let h = 0x5f3759df;
  for (let i = 0; i < ccy.length; i += 1) {
    h = Math.imul(h ^ ccy.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Same booked → prepared priority as the CFaR analysis Monte Carlo job. */
export function hedgeSettleScheduleForCfar(
  bookedHedges: readonly HedgeTicket[],
  prepared: PreparedHedgeProfile | undefined,
  ccy: string,
  setup: VarSetup,
  tenureMonths: number,
  extraForward?: AnalyticsForwardLeg | null,
): McHedgeSettleLeg[] {
  const bookedStrip = stripTicketsForCcy(bookedHedges, ccy)
    .slice()
    .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
  if (bookedStrip.length > 0) {
    return bookedStrip.map(t => ({
      settleMonths: horizonMonths(t.maturity ?? setup.horizon),
      notionalLocalM: t.amountLocalM,
    }));
  }
  const bookedBullet = bookedHedges.find(
    t => t.ccy === ccy && isLiveHedgeTicket(t) && !t.stripId,
  );
  if (bookedBullet) {
    return [{
      settleMonths: horizonMonths(bookedBullet.maturity ?? setup.horizon),
      notionalLocalM: bookedBullet.amountLocalM,
    }];
  }
  if (prepared?.structure === 'strip' && prepared.legs.length > 0) {
    return prepared.legs.map(l => ({
      settleMonths: l.settleMonths ?? l.endMonth,
      notionalLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
    }));
  }
  if (prepared && Math.abs(prepared.coverLocalM) > 1e-9) {
    return [{
      settleMonths: prepared.settleMonths ?? tenureMonths,
      notionalLocalM: prepared.coverLocalM,
    }];
  }
  if (extraForward && Math.abs(extraForward.amountLocalM) > 1e-9) {
    return [{
      settleMonths: extraForward.settleMonths,
      notionalLocalM: extraForward.amountLocalM,
    }];
  }
  return [];
}

function mcInputForRow(
  row: RowState,
  input: FxHedgeCfarInput,
  T: number,
  profile: ForecastProfileState,
  bookedHedges: readonly HedgeTicket[],
  extraForwards: readonly AnalyticsForwardLeg[],
): McCfarInput | null {
  const ccy = row.ccy;
  if (!ccy || ccy === 'USD') return null;
  const stockM = fxBookNetLocalM(row);
  const monthlyInflows = monthlyInflowSeriesLocalM(row, T, profile);
  const monthlyOutflows = monthlyOutflowSeriesLocalM(row, T, profile);
  if (
    Math.abs(stockM) < 1e-9
    && !monthlyInflows.some(f => Math.abs(f) > 1e-9)
    && !monthlyOutflows.some(f => Math.abs(f) > 1e-9)
  ) {
    return null;
  }
  const rates = resolveMarketRatesForCcy(
    input.marketRatesByCcy, ccy, input.ratesScopeId,
  );
  const cmp = buildCashForecastCarryComparison({
    ccy,
    bookRows: input.rows,
    forecastProfile: profile,
    forecastMonths: input.setup.forecastMonths,
    marketRates: rates,
    bookedHedges,
    preparedByCcy: input.preparedByCcy,
    setup: input.setup,
    extraForwards,
  });
  const carryUsdM = cmp
    ? resolvedHedgedTotalCarryUsdM({
        comparison: cmp,
        prepared: input.preparedByCcy?.[ccy],
        marketRates: rates,
      }).totalCarryUsdM
    : 0;
  const extra = extraForwards.find(f => f.ccy === ccy) ?? null;
  return {
    stockM,
    monthlyInflows,
    monthlyOutflows,
    tenureMonths: T,
    spotUsd: NORDTECH_VAR.spotUsd[ccy] ?? 1,
    sigmaFxMonthly: monthlyVolForSetup(input.setup),
    confidencePct: input.setup.confidencePct,
    forecastUncertainty1m: effectiveForecastUncertainty1m(
      profile,
      ccy,
      input.setup.forecastUncertainty1m,
    ),
    hedgeSettleSchedule: hedgeSettleScheduleForCfar(
      bookedHedges,
      input.preparedByCcy?.[ccy],
      ccy,
      input.setup,
      T,
      extra,
    ),
    hedgeCarryScheduleUsdM:
      T > 0 && Number.isFinite(carryUsdM)
        ? Array.from({ length: T }, (_, k) => (carryUsdM * (k + 1)) / T)
        : undefined,
    usdRatePctPa: CURRENCY_PARAMS.USD?.carry ?? 0,
    fcyRatePctPa: CURRENCY_PARAMS[ccy]?.carry ?? 0,
    rateVolPctPa: rateVolBpYrFor(ccy, input.setup) / 100,
    seed: hashSeedForCcy(ccy),
  };
}

/** FX-only Monte Carlo bands per CCY — no funding swap. */
export function fxHedgeMcCfarByCcy(
  input: Omit<FxHedgeCfarInput, 'fundingPlanByCcy'>,
): Record<string, CfarBandsResult> {
  const T = input.setup.forecastMonths > 0
    ? input.setup.forecastMonths
    : horizonMonths(input.setup.horizon);
  const profile = input.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
  const bookedHedges = input.bookedHedges ?? [];
  const extraForwards = analyticsForwardsFromOverlays({
    overlayByCcy: input.swapForwardOverlayByCcy,
    forecastMonths: T,
  });
  const out: Record<string, CfarBandsResult> = {};
  for (const row of input.rows) {
    const mc = mcInputForRow(
      row, input, Math.max(1, T), profile, bookedHedges, extraForwards,
    );
    if (!mc) continue;
    out[row.ccy] = computeMonteCarloMismatchCfar(mc);
  }
  return out;
}

function displayedNetFromFx(
  fxByCcy: Record<string, CfarBandsResult>,
  input: Pick<
    FxHedgeCfarInput,
    'fundingPlanByCcy' | 'setup' | 'swapForwardOverlayByCcy'
  >,
): Record<string, number> {
  const T = input.setup.forecastMonths > 0
    ? input.setup.forecastMonths
    : horizonMonths(input.setup.horizon);
  const retainedPlan = retainedFundingPlanByCcy(
    input.fundingPlanByCcy,
    input.swapForwardOverlayByCcy,
  );
  const out: Record<string, number> = {};
  for (const [ccy, fx] of Object.entries(fxByCcy)) {
    const funding = fundingSwapOutstandingByMonth(
      retainedPlan?.[ccy],
      T,
    );
    const bridge = fundingSwapBridgeBands({
      outstandingM: funding.outstandingM,
      T,
      spotUsd: NORDTECH_VAR.spotUsd[ccy] ?? 1,
      sigmaMonthly: rateVolBpYrFor(ccy, input.setup) / 10000 / Math.sqrt(12),
      confidencePct: input.setup.confidencePct,
      termSettles: funding.termSettles,
    });
    const net = applyFundingSwapBridge(fx, bridge).netCriticalCashUsdM;
    if (net > 0.001) out[ccy] = net;
  }
  return out;
}

/**
 * Net CFaR per CCY. Omit `fundingPlanByCcy` for cover sizing (FX-only).
 * Pass the live / strategy plan for displayed Net (FX + swap-bridge).
 */
export function fxHedgeNetCfarByCcyUsdM(
  input: FxHedgeCfarInput,
): Record<string, number> {
  return displayedNetFromFx(fxHedgeMcCfarByCcy(input), input);
}

/** Displayed nets from a precomputed FX-only MC run — one MC, many swap books. */
export function displayedCfarNetByCcyUsdM(
  fxByCcy: Record<string, CfarBandsResult>,
  input: Pick<
    FxHedgeCfarInput,
    'fundingPlanByCcy' | 'setup' | 'swapForwardOverlayByCcy'
  >,
): Record<string, number> {
  return displayedNetFromFx(fxByCcy, input);
}

export function sumNetCfarUsdM(byCcy: Record<string, number> | undefined): number {
  if (!byCcy) return 0;
  return Object.values(byCcy).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
}

/**
 * Displayed Net CFaR when only the FX-only scalar is known.
 * Swap leg is Net CFaR on the standing path (gross |S|·√t minus Buffer
 * Carry accrued to t) — not a linear scale on carry or on |S|.
 * RSS with FX-only Net.
 */
export function displayedCfarUsdMFromFxNet(
  fxNetUsdM: number,
  ccy: string,
  plan: readonly { standing_swap: number; far_leg?: number }[] | undefined,
  setup: VarSetup,
  carryScheduleUsdM?: readonly number[],
): number {
  const fx = Math.max(0, Number.isFinite(fxNetUsdM) ? fxNetUsdM : 0);
  const T = setup.forecastMonths > 0
    ? setup.forecastMonths
    : horizonMonths(setup.horizon);
  const funding = fundingSwapOutstandingByMonth(plan, T);
  if (funding.outstandingM.length === 0) return fx;
  const bridge = fundingSwapBridgeBands({
    outstandingM: funding.outstandingM,
    T,
    spotUsd: NORDTECH_VAR.spotUsd[ccy] ?? 1,
    sigmaMonthly: rateVolBpYrFor(ccy, setup) / 10000 / Math.sqrt(12),
    confidencePct: setup.confidencePct,
    termSettles: funding.termSettles,
    carryScheduleUsdM,
  });
  const swapNet = Math.max(0, bridge?.netCriticalCashUsdM ?? 0);
  if (swapNet < 1e-12) return fx;
  return Math.sqrt(fx * fx + swapNet * swapNet);
}
