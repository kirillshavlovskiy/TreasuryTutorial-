/**
 * FX-hedge-only Net CFaR per currency — cover sizing input.
 *
 * Book + FX hedges + FX-path carry. Does not read liquidity buffer layers or
 * the funding swap, so a CFaR-cover swap sized from this number cannot feed
 * back into its own size. Displayed CFaR RSS-combines the funding-swap bridge
 * in a second pass after the desk has booked the swap.
 */

import { fxBookNetLocalM, type RowState } from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  monthlyFlowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import { resolveMarketRatesForCcy, type FxMarketRatesBundle } from '@/lib/fx-market-rates';
import {
  buildCashForecastCarryComparison,
  resolvedHedgedTotalCarryUsdM,
} from '@/lib/test-mode/cash-carry-analytics';
import { residualCfarClosedFormUsdM } from '@/lib/test-mode/cfar-residual';
import { fundingSwapOutstandingByMonth } from '@/lib/test-mode/cfar-funding-swap';
import type { HedgeTicket, PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import { horizonMonths, type VarSetup } from '@/lib/test-mode/var-setup';

export function fxHedgeNetCfarByCcyUsdM(input: {
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
   */
  fundingPlanByCcy?: Readonly<
    Record<string, readonly { standing_swap: number; far_leg?: number }[]>
  >;
}): Record<string, number> {
  const T = input.setup.forecastMonths > 0
    ? input.setup.forecastMonths
    : horizonMonths(input.setup.horizon);
  const profile = input.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
  const bookedHedges = input.bookedHedges ?? [];
  const preparedByCcy = input.preparedByCcy ?? {};
  const out: Record<string, number> = {};

  for (const row of input.rows) {
    if (row.ccy === 'USD') continue;
    const stockM = fxBookNetLocalM(row);
    const flows = monthlyFlowSeriesLocalM(row, Math.max(1, T), profile);
    if (Math.abs(stockM) < 1e-9 && !flows.some(f => Math.abs(f) > 1e-9)) continue;

    const rates = resolveMarketRatesForCcy(
      input.marketRatesByCcy, row.ccy, input.ratesScopeId,
    );
    const cmp = buildCashForecastCarryComparison({
      ccy: row.ccy,
      bookRows: input.rows,
      forecastProfile: profile,
      forecastMonths: input.setup.forecastMonths,
      marketRates: rates,
      bookedHedges,
      preparedByCcy,
      setup: input.setup,
    });
    const carryUsdM = cmp
      ? resolvedHedgedTotalCarryUsdM({
          comparison: cmp,
          prepared: preparedByCcy[row.ccy],
          marketRates: rates,
        }).totalCarryUsdM
      : 0;

    const funding = fundingSwapOutstandingByMonth(
      input.fundingPlanByCcy?.[row.ccy],
      T,
    );
    const net = residualCfarClosedFormUsdM({
      stockM,
      monthlyFlows: flows,
      ccy: row.ccy,
      setup: input.setup,
      bookedHedges,
      prepared: preparedByCcy[row.ccy],
      tenureMonths: T,
      carryUsdM,
      forecastProfile: profile,
      fundingSwapOutstandingM: funding.outstandingM,
      fundingSwapTermSettles: funding.termSettles,
    }).netCashUsdM;
    if (net > 0.001) out[row.ccy] = net;
  }
  return out;
}

export function sumNetCfarUsdM(byCcy: Record<string, number> | undefined): number {
  if (!byCcy) return 0;
  return Object.values(byCcy).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
}
