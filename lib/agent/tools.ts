/**
 * AI Agent tool layer — wraps the desk's own VaR / Cash Carry / CFaR /
 * Liquidity engines as LLM function-calling tools. Tools execute server-side
 * against the DeskContextSnapshot shipped with each chat request, running the
 * exact same code paths the Analytics / Liquidity tabs use, so the agent's
 * numbers match what the user sees on screen.
 *
 * Outputs are deliberately compact (headline numbers, rounded) to stay within
 * the Gemini free-tier token budget.
 */

import { tool } from 'ai';
import { z } from 'zod';

import { resolveMarketRatesForCcy } from '@/lib/fx-market-rates';
import {
  DEFAULT_FORECAST_PROFILE,
  forwardSwapSchedule,
  monthlyFlowSeriesLocalM,
  monthlyInflowSeriesLocalM,
  monthlyOutflowSeriesLocalM,
} from '@/lib/forecast-profile';
import {
  buildCashCarryAnalytics,
  buildCashForecastCarryComparison,
  hedgeCashFlowsByMonth,
  optimizeStripShapeAroundWam,
  resolvedHedgedTotalCarryUsdM,
  type StripShapeScore,
} from '@/lib/test-mode/cash-carry-analytics';
import { residualCfarClosedFormUsdM, RATE_DIFF_VOL_BP_YR } from '@/lib/test-mode/cfar-residual';
import {
  computeMonteCarloMismatchCfar,
  type McCfarInput,
  type McHedgeSettleLeg,
} from '@/lib/test-mode/cfar-montecarlo';
import { computeSimdRow } from '@/lib/dashboard-model';
import {
  dayLabel,
  resolveLiquidityTiming,
} from '@/lib/liquidity-ladder';
import {
  CURRENCY_PARAMS,
  calcOptimalBuffer,
  computeFcySwapNear,
  computeLayeredBuffer,
  type LayerId,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import { analyticsSpotUsd } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  buildHedgeVarSummary,
  isLiveHedgeTicket,
  overlayRiskFromFxBook,
  stripTicketsForCcy,
} from '@/lib/test-mode/hedge-var';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  computeAnalyticsVarUsdM,
  horizonMonths,
  monthlyVolForSetup,
  setupLabel,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import { effectiveForecastUncertainty1m } from '@/lib/forecast-profile';
import type { AttachedDataFile, DeskContextSnapshot } from '@/lib/agent/desk-context';

/** Round to N decimals for compact tool output. */
function r(v: number, dp = 3): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

const CONFIDENCE = z
  .union([z.literal(90), z.literal(95), z.literal(99)])
  .describe('VaR confidence level in percent');

const HORIZON = z
  .enum(['1w', '1m', '3m', '6m', '9m', '1y'])
  .describe('VaR volatility horizon (sqrt-T scaling)');

const BASIS = z
  .enum(['stock', 'simpleAvg', 'avgBuildup', 'totalBuildup'])
  .describe(
    'Exposure basis: stock = current Net FX only; simpleAvg = mid-point average; '
    + 'avgBuildup = time-weighted average; totalBuildup = growth path (exact path integral)',
  );

const setupOverridesSchema = z.object({
  confidencePct: CONFIDENCE.optional(),
  horizon: HORIZON.optional(),
  forecastMonths: z
    .number()
    .min(0)
    .max(24)
    .optional()
    .describe('Forecast buildup period in months (0 = stock only)'),
  exposureBasis: BASIS.optional(),
  forecastUncertainty1mPct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Incremental 1-month forecast uncertainty as a percent of monthly flow (e.g. 10 = 10%)'),
});

type SetupOverrides = z.infer<typeof setupOverridesSchema>;

function applySetupOverrides(base: VarSetup, o?: SetupOverrides | null): VarSetup {
  if (!o) return base;
  return {
    ...base,
    ...(o.confidencePct ? { confidencePct: o.confidencePct } : {}),
    ...(o.horizon ? { horizon: o.horizon } : {}),
    ...(typeof o.forecastMonths === 'number' ? { forecastMonths: o.forecastMonths } : {}),
    ...(o.exposureBasis ? { exposureBasis: o.exposureBasis } : {}),
    ...(typeof o.forecastUncertainty1mPct === 'number'
      ? { forecastUncertainty1m: o.forecastUncertainty1mPct / 100 }
      : {}),
  };
}

/** Live risk rows — seed bars overlaid with the edited FX Risk table. */
function liveRisk(ctx: DeskContextSnapshot, setup: VarSetup): CurrencyRiskRow[] {
  return overlayRiskFromFxBook(ctx.risk, ctx.bookRows, setup, ctx.forecastProfile);
}

/** Per-CCY custom monthly flow schedules from the live book (uneven months). */
function monthlyFlowsByCcy(
  ctx: DeskContextSnapshot,
  setup: VarSetup,
  risk: CurrencyRiskRow[],
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const T = setup.forecastMonths;
  if (!(T > 0)) return out;
  const rowsByCcy = new Map(ctx.bookRows.map(rw => [rw.ccy, rw]));
  for (const { bar } of risk) {
    if (bar.ccy === 'USD') continue;
    const row = rowsByCcy.get(bar.ccy);
    if (row) {
      out[bar.ccy] = monthlyFlowSeriesLocalM(row, T, ctx.forecastProfile);
    }
  }
  return out;
}

function ratesFor(ctx: DeskContextSnapshot, ccy: string) {
  return resolveMarketRatesForCcy(ctx.marketRatesByCcy, ccy, ctx.ratesScopeId);
}

function nonUsdCcys(risk: CurrencyRiskRow[]): string[] {
  return risk.map(rr => rr.bar.ccy).filter(c => c !== 'USD');
}

/** Same SharedGlobals the Liquidity tab boots with. */
function sharedFromSetup(setup: VarSetup, sigmaP?: number): SharedGlobals {
  return {
    r_USD: 3.5,
    σ_P: typeof sigmaP === 'number' ? sigmaP : 0.1,
    days: 3,
    forecastMonths: setup.forecastMonths,
  };
}

const LAYER_IDS = ['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv', 'cfarCover'] as const;
const layersSchema = z
  .array(z.enum(LAYER_IDS))
  .optional()
  .describe(
    'Liquidity buffer layers to apply: sigmaP = payout-uncertainty cushion, '
      + 'floorH = zero-cash-target trough (USD-capital credit-rate, no FCY debit), carryOptim = carry-optimal H*, portfolioDiv = portfolio VaR cap. '
      + 'Omit for the unlayered path (trough + swap with no extra cushion).',
  );

function layersFromIds(ids?: readonly LayerId[] | null): Set<LayerId> {
  return new Set(ids ?? []);
}

function liquidityBookRows(ctx: DeskContextSnapshot, ccy?: string) {
  const target = ccy?.toUpperCase();
  return ctx.bookRows.filter(row => row.ccy !== 'USD' && (!target || row.ccy === target));
}

function hedgeSettleMap(
  ctx: DeskContextSnapshot,
  setup: VarSetup,
  rows: { ccy: string }[],
): Record<string, number[]> {
  const T = Math.max(1, Math.round(setup.forecastMonths) || 1);
  const map: Record<string, number[]> = {};
  for (const row of rows) {
    const flows = hedgeCashFlowsByMonth({
      ccy: row.ccy,
      forecastMonths: T,
      bookedHedges: ctx.bookedHedges,
      preparedByCcy: ctx.preparedByCcy,
      setup,
    });
    if (flows.some(f => Math.abs(f) > 1e-9)) map[row.ccy] = flows;
  }
  return map;
}

/** Planned hedge settlement schedule (booked strip → booked bullet → prepared). */
function hedgeSettleScheduleForCcy(
  ctx: DeskContextSnapshot,
  ccy: string,
  setup: VarSetup,
  tenureMonths: number,
): McHedgeSettleLeg[] {
  const strip = stripTicketsForCcy(ctx.bookedHedges, ccy)
    .slice()
    .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
  if (strip.length > 0) {
    return strip.map(t => ({
      settleMonths: horizonMonths(t.maturity ?? setup.horizon),
      notionalLocalM: t.amountLocalM,
    }));
  }
  const bullet = ctx.bookedHedges.find(
    t => t.ccy === ccy && isLiveHedgeTicket(t) && !t.stripId,
  );
  if (bullet) {
    return [
      {
        settleMonths: horizonMonths(bullet.maturity ?? setup.horizon),
        notionalLocalM: bullet.amountLocalM,
      },
    ];
  }
  const prep = ctx.preparedByCcy[ccy];
  if (prep) {
    if (prep.structure === 'strip' && prep.legs.length > 0) {
      return prep.legs.map(l => ({
        settleMonths: l.settleMonths ?? l.endMonth,
        notionalLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
      }));
    }
    if (Math.abs(prep.coverLocalM) > 1e-9) {
      return [
        {
          settleMonths: prep.settleMonths ?? tenureMonths,
          notionalLocalM: prep.coverLocalM,
        },
      ];
    }
  }
  return [];
}

/** Total hedge carry + cumulative monthly schedule for the CFaR offset. */
function carryForCcy(
  ctx: DeskContextSnapshot,
  ccy: string,
  setup: VarSetup,
): { totalCarryUsdM: number; carryScheduleUsdM?: number[] } {
  const rates = ratesFor(ctx, ccy);
  const cmp = buildCashForecastCarryComparison({
    ccy,
    bookRows: ctx.bookRows,
    forecastProfile: ctx.forecastProfile,
    forecastMonths: setup.forecastMonths,
    marketRates: rates,
    bookedHedges: ctx.bookedHedges,
    preparedByCcy: ctx.preparedByCcy,
    setup,
  });
  if (!cmp) return { totalCarryUsdM: 0 };
  const resolved = resolvedHedgedTotalCarryUsdM({
    comparison: cmp,
    prepared: ctx.preparedByCcy[ccy],
    marketRates: rates,
  });
  const totalCarryUsdM = resolved.totalCarryUsdM;
  // Cumulative schedule scaled so the terminal value equals the resolved total
  // (same convention as the CFaR tab).
  const months = cmp.hedged.months;
  let acc = 0;
  const cum = months.map(m => {
    acc += Number.isFinite(m.hedgeCarryUsdM) ? m.hedgeCarryUsdM : 0;
    return acc;
  });
  const last = cum[cum.length - 1] ?? 0;
  if (Math.abs(last) < 1e-12) return { totalCarryUsdM };
  const scale = totalCarryUsdM / last;
  return { totalCarryUsdM, carryScheduleUsdM: cum.map(c => c * scale) };
}

function compactShape(s: StripShapeScore) {
  return {
    structure: s.structure,
    legCount: s.settleMonths.length,
    settleMonths: s.settleMonths.map(m => r(m, 2)),
    wamMonths: r(s.wamMonths, 2),
    schedule: s.settleScheduleLabel,
    enhancementUsdM: r(s.enhancementUsdM),
    fwdCarryUsdM: r(s.fwdCarryUsdM),
    interestDeltaUsdM: r(s.interestDeltaUsdM),
    vsBulletUsdM: r(s.vsBulletUsdM),
  };
}

export function buildAgentTools(
  ctx: DeskContextSnapshot,
  attachedData: AttachedDataFile[],
) {
  return {
    get_desk_state: tool({
      description:
        'Read the current state of the FX desk: entity, VaR setup, per-currency exposures '
        + '(stock + monthly flow), hedge ratios, booked hedges, prepared hedge packages, and '
        + 'which currencies have uploaded market data. Call this first to ground the conversation.',
      inputSchema: z.object({}),
      execute: async () => {
        const setup = ctx.varSetup;
        const risk = liveRisk(ctx, setup);
        return {
          entity: ctx.entityName,
          dashboard: ctx.dashboardName,
          varSetup: {
            label: setupLabel(setup),
            confidencePct: setup.confidencePct,
            horizon: setup.horizon,
            forecastMonths: setup.forecastMonths,
            exposureBasis: setup.exposureBasis,
            forecastUncertainty1mPct: r(setup.forecastUncertainty1m * 100, 1),
            monthlyVolPct: r(monthlyVolForSetup(setup) * 100, 2),
          },
          currencies: risk
            .filter(rr => rr.bar.ccy !== 'USD')
            .map(rr => {
              const row = ctx.bookRows.find(rw => rw.ccy === rr.bar.ccy);
              return {
                ccy: rr.bar.ccy,
                direction: rr.bar.direction,
                stockNetLocalM: r(rr.bar.stockNetM),
                monthlyFlowLocalM: r(rr.bar.flowM),
                openingCashLocalM: row ? r(row.cash) : null,
                monthlyPayoutLocalM: row ? r(row.payout) : null,
                monthlyCollectionsLocalM: row ? r(row.collections) : null,
                cashFloorLocalM: row ? r(row.cash_floor ?? 0) : null,
                hedgeRatioPct: r((ctx.hedgeRatios[rr.bar.ccy] ?? 0) * 100, 1),
                hasUploadedMarketRates: Boolean(ctx.marketRatesByCcy[rr.bar.ccy]),
                hasPreparedHedge: Boolean(ctx.preparedByCcy[rr.bar.ccy]),
              };
            }),
          bookedHedges: ctx.bookedHedges.filter(isLiveHedgeTicket).map(t => ({
            ccy: t.ccy,
            instrument: t.instrument,
            amountLocalM: r(t.amountLocalM),
            maturity: t.maturityLabel ?? t.maturity ?? 'spot',
            strip: Boolean(t.stripId),
          })),
          attachedFiles: attachedData.map(f => ({
            name: f.name,
            rows: f.totalRows,
            headers: f.headers,
          })),
        };
      },
    }),

    compute_var: tool({
      description:
        'Run the desk parametric VaR engine (same as the Analytics tab) across all currencies. '
        + 'Optionally override the VaR setup (confidence, horizon, forecast months, exposure basis, '
        + 'forecast uncertainty) and per-currency hedge ratios to explore what-if scenarios. '
        + 'Returns open VaR, residual VaR after hedges, and hedge notionals per currency plus totals (USD millions).',
      inputSchema: z.object({
        setupOverrides: setupOverridesSchema.optional(),
        hedgeRatiosPct: z
          .record(z.string(), z.number().min(0).max(100))
          .optional()
          .describe(
            'What-if hedge ratio per currency as percent of Target (e.g. {"EUR": 100}). '
            + 'Omit to use the ratios currently set on the desk.',
          ),
      }),
      execute: async ({ setupOverrides, hedgeRatiosPct }) => {
        const setup = applySetupOverrides(ctx.varSetup, setupOverrides);
        const risk = liveRisk(ctx, setup);
        const ratios = hedgeRatiosPct
          ? Object.fromEntries(
              Object.entries(hedgeRatiosPct).map(([c, v]) => [c, v / 100]),
            )
          : ctx.hedgeRatios;
        const summary = buildHedgeVarSummary(
          risk,
          ratios,
          setup,
          ctx.bookedHedges,
          monthlyFlowsByCcy(ctx, setup, risk),
          ctx.forecastProfile,
        );
        return {
          setup: setupLabel(setup),
          rows: summary.rows.map(row => ({
            ccy: row.ccy,
            direction: row.direction,
            openExposureLocalM: r(row.openExposureLocalM),
            targetHedgeLocalM: r(row.targetHedgeLocalM),
            equalVarHedgeLocalM: r(row.equalVarHedgeLocalM),
            hedgeRatioPct: r(row.hedgeRatio * 100, 1),
            hedgeNotionalLocalM: r(row.hedgeNotionalLocalM),
            residualLocalM: r(row.residualLocalM),
            varBeforeUsdM: r(row.varBeforeUsdM),
            varAfterUsdM: r(row.varAfterUsdM),
          })),
          totals: {
            varBeforeUsdM: r(summary.totalVarBeforeUsdM),
            varAfterUsdM: r(summary.totalVarAfterUsdM),
            varReductionUsdM: r(summary.varReductionUsdM),
          },
        };
      },
    }),

    compute_var_for_custom_exposure: tool({
      description:
        'Run the parametric VaR engine on an arbitrary exposure that is NOT on the desk — '
        + 'e.g. numbers taken from a user-uploaded file. Provide the currency, current stock '
        + '(local currency millions) and optionally a monthly flow. Uses the desk VaR setup unless overridden.',
      inputSchema: z.object({
        ccy: z.string().describe('ISO currency code, e.g. EUR'),
        stockLocalM: z.number().describe('Current net exposure, local currency millions (signed)'),
        monthlyFlowLocalM: z
          .number()
          .optional()
          .describe('Expected monthly flow buildup, local currency millions (signed)'),
        setupOverrides: setupOverridesSchema.optional(),
      }),
      execute: async ({ ccy, stockLocalM, monthlyFlowLocalM, setupOverrides }) => {
        const setup = applySetupOverrides(ctx.varSetup, setupOverrides);
        const c = ccy.toUpperCase();
        const varUsdM = computeAnalyticsVarUsdM(
          stockLocalM,
          monthlyFlowLocalM ?? 0,
          c,
          setup,
        );
        return {
          ccy: c,
          setup: setupLabel(setup),
          spotUsdPerCcy: analyticsSpotUsd(c),
          varUsdM: r(varUsdM),
        };
      },
    }),

    analyze_cash_carry: tool({
      description:
        'Run the Cash Carry analytics engine (same as the Cash Carry tab): cash interest per '
        + 'currency, carry of booked/prepared hedges (forward points + interest legs), and net totals '
        + 'over the forecast horizon (USD millions). Optionally filter to one currency.',
      inputSchema: z.object({
        ccy: z.string().optional().describe('Restrict to one currency (ISO code)'),
        setupOverrides: setupOverridesSchema.optional(),
      }),
      execute: async ({ ccy, setupOverrides }) => {
        const setup = applySetupOverrides(ctx.varSetup, setupOverrides);
        let risk = liveRisk(ctx, setup);
        const target = ccy?.toUpperCase();
        if (target) risk = risk.filter(rr => rr.bar.ccy === target);
        if (risk.length === 0) {
          return { error: `No exposure found for ${target ?? 'the requested filter'}` };
        }
        const primary = target ?? nonUsdCcys(risk)[0] ?? 'EUR';
        const analytics = buildCashCarryAnalytics({
          risk,
          setup,
          bookedHedges: ctx.bookedHedges,
          preparedByCcy: ctx.preparedByCcy,
          marketRates: ratesFor(ctx, primary),
          bookRows: ctx.bookRows,
          forecastProfile: ctx.forecastProfile,
        });
        return {
          horizonMonths: r(analytics.horizonMonths, 1),
          ratesSource: analytics.ratesSource,
          cashInterest: analytics.cashInterest.map(row => ({
            ccy: row.ccy,
            openingCashLocalM: r(row.openingCashM),
            endCashLocalM: r(row.endCashM),
            avgCashLocalM: r(row.avgCashM),
            side: row.side,
            ratePct: r(row.ratePct, 2),
            interestUsdM: r(row.interestUsdM),
          })),
          hedgeCarry: analytics.hedgeCarry.map(row => ({
            ccy: row.ccy,
            label: row.label,
            structure: row.structure,
            status: row.status,
            amountLocalM: r(row.amountLocalM),
            settleMonths: r(row.settleMonths, 1),
            fwdCarryUsdM: r(row.fwdCarryUsdM),
            totalUsdM: r(row.totalUsdM),
          })),
          totals: {
            cashInterestUsdM: r(analytics.totals.cashInterestUsdM),
            hedgeCarryUsdM: r(analytics.totals.hedgeCarryUsdM),
            netUsdM: r(analytics.totals.netUsdM),
          },
        };
      },
    }),

    optimize_carry_structure: tool({
      description:
        'Search hedge strip shapes (leg count, center of mass, kurtosis) around a target '
        + 'weighted-average maturity to maximise carry enhancement for one currency — the same '
        + 'shape optimizer as the Cash Carry tab. Returns the bullet baseline, the best shape, and top candidates.',
      inputSchema: z.object({
        ccy: z.string().describe('Currency to optimize (ISO code)'),
        targetWamMonths: z
          .number()
          .min(0)
          .max(24)
          .describe('Target weighted-average maturity of the strip, in months'),
        maxLegCount: z.number().int().min(2).max(12).optional(),
        topN: z.number().int().min(1).max(10).optional(),
      }),
      execute: async ({ ccy, targetWamMonths, maxLegCount, topN }) => {
        const setup = ctx.varSetup;
        const risk = liveRisk(ctx, setup);
        const target = ccy.toUpperCase();
        const result = optimizeStripShapeAroundWam({
          ccy: target,
          risk,
          setup,
          bookedHedges: ctx.bookedHedges,
          preparedByCcy: ctx.preparedByCcy,
          marketRates: ratesFor(ctx, target),
          bookRows: ctx.bookRows,
          forecastProfile: ctx.forecastProfile,
          targetWamMonths,
          maxLegCount,
          topN: topN ?? 5,
        });
        if (!result) {
          return { error: 'Optimizer needs a positive forecast period (set forecastMonths > 0).' };
        }
        return {
          ccy: target,
          targetWamMonths: r(result.targetWamMonths, 2),
          bulletBaseline: compactShape(result.bullet),
          best: compactShape(result.best),
          top: result.top.map(compactShape),
        };
      },
    }),

    analyze_liquidity: tool({
      description:
        'Run the Liquidity tab engine: dated cash path (trough, drawdown, days below floor), '
        + 'H* buffer, near-leg swap needed, and the funded cycle-by-cycle plan. This is cash '
        + 'funding / intra-month timing — not FX CFaR. Call this for liquidity risk, payout '
        + 'gaps, swap cover, or "can I fund the next 12 months". Optionally filter to one '
        + 'currency and toggle buffer layers.',
      inputSchema: z.object({
        ccy: z.string().optional().describe('Restrict to one currency (ISO code)'),
        layers: layersSchema,
        sigmaP: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Payout forecast uncertainty as a fraction (0.10 = 10%). Default 0.10.'),
      }),
      execute: async ({ ccy, layers, sigmaP }) => {
        const setup = ctx.varSetup;
        const rows = liquidityBookRows(ctx, ccy);
        if (rows.length === 0) {
          return {
            error: ccy
              ? `No live liquidity book row for ${ccy.toUpperCase()}. Open the FX Risk or Liquidity tab.`
              : 'No live FX/liquidity book rows on the desk. Open the FX Risk or Liquidity tab so the book is available.',
          };
        }
        const shared = sharedFromSetup(setup, sigmaP);
        const active = layersFromIds(layers);
        const profile = ctx.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
        const timing = resolveLiquidityTiming(profile);
        const hedgeSettleByCcy = hedgeSettleMap(ctx, setup, rows);
        const results = rows.map(row => {
          const sim = computeSimdRow(
            row,
            shared,
            active,
            undefined,
            undefined,
            undefined,
            profile,
            hedgeSettleByCcy,
          );
          const plan = sim.liquidityPlan ?? [];
          const cycles = sim.liquidityCycles ?? [];
          const fwd = forwardSwapSchedule(plan);
          const daysBelowFloor = sim.daysBelowFloor
            ?? cycles.reduce((s, c) => s + c.daysBelowFloor, 0);
          const troughDay = sim.troughDay;
          return {
            ccy: row.ccy,
            openingCashLocalM: r(row.cash),
            monthlyPayoutLocalM: r(row.payout),
            monthlyCollectionsLocalM: r(row.collections),
            cashFloorLocalM: r(row.cash_floor ?? 0),
            troughCashLocalM: r(sim.lp_peak_cash),
            troughLabel: typeof troughDay === 'number' ? dayLabel(troughDay) : null,
            troughCycle: (sim.troughCycleIndex ?? 0) + 1,
            cycleDrawdownLocalM: r(sim.cycleDrawdown ?? 0),
            daysBelowFloor,
            hStarLocalM: r(sim.cash_threshold_pre_swap),
            swapNeededLocalM: r(sim.swapNear),
            cycleEndCashLocalM: r(sim.cash_after_payins),
            carryDir: sim.carryDir,
            cycles: plan.slice(0, 12).map(p => ({
              cycle: p.cycleIndex + 1,
              openingCashLocalM: r(p.opening_cash),
              troughCashLocalM: r(p.forecasted_cash),
              drawdownLocalM: r(p.drawdown),
              swapNeededLocalM: r(p.swap_needed),
              standingSwapLocalM: r(p.standing_swap),
              cycleEndCashLocalM: r(p.cycle_end_cash),
            })),
            forwardSwapPlan: fwd.map(t => ({
              valueDateMonths: t.valueDateMonths,
              amountLocalM: r(t.amount_fcy),
            })),
          };
        });
        return {
          horizonMonths: r(shared.forecastMonths ?? 1, 1),
          timingEnabled: Boolean(timing?.enabled),
          sizingBasis: timing?.sizingBasis ?? 'horizon',
          bookingMode: timing?.bookingMode ?? 'rolling',
          layers: [...active],
          sigmaP: r(shared.σ_P, 2),
          rows: results,
        };
      },
    }),

    optimize_liquidity_buffer: tool({
      description:
        'Size the liquidity buffer H* and the FX-swap near leg the Liquidity tab would book, '
        + 'using the same layered-buffer + optimal-buffer engines (payout uncertainty, cash floor, '
        + 'carry-optimal z). Use this to answer "how much buffer / swap do I need". What-if layers '
        + 'and σ_P without changing the desk.',
      inputSchema: z.object({
        ccy: z.string().optional().describe('Restrict to one currency (ISO code); omit for all'),
        layers: layersSchema,
        sigmaP: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Payout forecast uncertainty as a fraction (0.10 = 10%). Default 0.10.'),
      }),
      execute: async ({ ccy, layers, sigmaP }) => {
        const setup = ctx.varSetup;
        const rows = liquidityBookRows(ctx, ccy);
        if (rows.length === 0) {
          return {
            error: 'No live FX/liquidity book rows on the desk. Open the FX Risk or Liquidity tab.',
          };
        }
        const shared = sharedFromSetup(setup, sigmaP);
        const active = layersFromIds(layers);
        const profile = ctx.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
        const hedgeSettleByCcy = hedgeSettleMap(ctx, setup, rows);
        const formulaLayersActive =
          active.has('floorH') || active.has('sigmaP')
          || active.has('carryOptim') || active.has('portfolioDiv');
        const results = rows.map(row => {
          const sim = computeSimdRow(
            row,
            shared,
            active,
            undefined,
            undefined,
            undefined,
            profile,
            hedgeSettleByCcy,
          );
          const opt = calcOptimalBuffer({
            P: Math.abs(row.payout) || 0.001,
            σ_P: shared.σ_P,
            r_USD: shared.r_USD,
            r_FCY: row.r_FCY,
            r_OD: row.r_OD,
            days: shared.days,
            cash_floor: row.cash_floor,
          });
          const layered = computeLayeredBuffer(
            Math.abs(row.payout),
            sim.lp_peak_cash,
            shared.σ_P,
            shared.r_USD,
            row.r_FCY,
            row.r_OD,
            row.cash_floor,
            active,
            row.cash,
            row.carry_target,
          );
          const swapNear = computeFcySwapNear(
            layered.cash_threshold,
            row.cash + row.nonLpCash,
            row.fcastFX,
            row.r_OD,
            shared.r_USD,
            formulaLayersActive,
            sim.lp_peak_cash,
          );
          return {
            ccy: row.ccy,
            openingCashLocalM: r(row.cash),
            troughCashLocalM: r(sim.lp_peak_cash),
            layeredHStarLocalM: r(layered.cash_threshold),
            optimalHStarLocalM: r(opt.H_optimal),
            optimalHPctOfPayout: r(opt.H_pct_of_P, 1),
            shortfallProbPct: r(opt.shortfall_prob_pct, 1),
            swapNeededLocalM: r(swapNear),
            carryDir: layered.carry_dir,
            deltaRPct: r(layered.delta_r, 2),
            layerContrib: {
              floorLocalM: r(layered.floor_contrib),
              sigmaLocalM: r(layered.delta_sigma),
              carryLocalM: r(layered.delta_carry),
            },
          };
        });
        return {
          layers: [...active],
          sigmaP: r(shared.σ_P, 2),
          rows: results,
        };
      },
    }),

    compute_cfar: tool({
      description:
        'Compute Cash Flow at Risk (CFaR) — the peak bridge-funding cash reserve the book may need — '
        + 'per currency, using the same engine as the CFaR tab. Closed form by default (fast, matches tab '
        + 'headlines); set method="monteCarlo" for the full cash-mismatch simulation (slower, includes '
        + 'flow-timing jitter and rate-path uncertainty). Netted against expected hedge carry. All USD millions.',
      inputSchema: z.object({
        ccy: z.string().optional().describe('Restrict to one currency (ISO code); omit for all'),
        method: z.enum(['closedForm', 'monteCarlo']).optional(),
        setupOverrides: setupOverridesSchema.optional(),
      }),
      execute: async ({ ccy, method, setupOverrides }) => {
        const setup = applySetupOverrides(ctx.varSetup, setupOverrides);
        const risk = liveRisk(ctx, setup);
        const T = Math.max(
          1,
          setup.forecastMonths > 0
            ? Math.round(setup.forecastMonths)
            : Math.round(horizonMonths(setup.horizon)),
        );
        const target = ccy?.toUpperCase();
        const ccys = nonUsdCcys(risk).filter(c => !target || c === target);
        if (ccys.length === 0) {
          return { error: `No exposure found for ${target ?? 'the requested filter'}` };
        }
        const rowsByCcy = new Map(ctx.bookRows.map(rw => [rw.ccy, rw]));
        const profile = ctx.forecastProfile ?? DEFAULT_FORECAST_PROFILE;
        const results = ccys.map(c => {
          const bar = risk.find(rr => rr.bar.ccy === c)!.bar;
          const bookRow = rowsByCcy.get(c);
          const flows = bookRow
            ? monthlyFlowSeriesLocalM(bookRow, T, profile)
            : Array.from({ length: T }, () => bar.flowM);
          const inflows = bookRow ? monthlyInflowSeriesLocalM(bookRow, T, profile) : [];
          const outflows = bookRow ? monthlyOutflowSeriesLocalM(bookRow, T, profile) : [];
          const carry = carryForCcy(ctx, c, setup);
          const prepared = ctx.preparedByCcy[c] ?? null;

          if (method === 'monteCarlo') {
            const mcInput: McCfarInput = {
              stockM: bar.stockNetM,
              monthlyInflows: inflows,
              monthlyOutflows: outflows,
              tenureMonths: T,
              spotUsd: analyticsSpotUsd(c),
              sigmaFxMonthly: monthlyVolForSetup(setup),
              confidencePct: setup.confidencePct,
              forecastUncertainty1m: effectiveForecastUncertainty1m(
                profile,
                c,
                setup.forecastUncertainty1m,
              ),
              hedgeSettleSchedule: hedgeSettleScheduleForCcy(ctx, c, setup, T),
              hedgeCarryScheduleUsdM: carry.carryScheduleUsdM,
              usdRatePctPa: CURRENCY_PARAMS.USD?.carry ?? 0,
              fcyRatePctPa: CURRENCY_PARAMS[c]?.carry ?? 0,
              rateVolPctPa: (RATE_DIFF_VOL_BP_YR[c] ?? 80) / 100,
              // Capped paths: keeps a multi-currency tool call inside the chat
              // response window; headline moves <1% vs the tab's 1000 paths.
              paths: 500,
              seed: 0x5f3759df,
            };
            const bands = computeMonteCarloMismatchCfar(mcInput);
            return {
              ccy: c,
              method: 'monteCarlo' as const,
              hedged: mcInput.hedgeSettleSchedule.length > 0,
              grossCfarUsdM: r(bands.criticalCashUsdM),
              netCfarUsdM: r(bands.netCriticalCashUsdM),
              peakMonth: r(bands.peakMonth, 1),
              expectedCarryUsdM: r(carry.totalCarryUsdM),
              peakBridgeFundingUsdM: r(bands.peakBridgeFundingUsdM),
            };
          }

          const closed = residualCfarClosedFormUsdM({
            stockM: bar.stockNetM,
            monthlyFlows: flows,
            ccy: c,
            setup,
            bookedHedges: ctx.bookedHedges,
            prepared,
            tenureMonths: T,
            carryUsdM: carry.totalCarryUsdM,
            forecastProfile: ctx.forecastProfile,
          });
          return {
            ccy: c,
            method: 'closedForm' as const,
            hedged: closed.hedged,
            grossCfarUsdM: r(closed.grossCashUsdM),
            netCfarUsdM: r(closed.netCashUsdM),
            peakMonth: r(closed.peakMonth, 1),
            expectedCarryUsdM: r(carry.totalCarryUsdM),
          };
        });
        return {
          tenureMonths: T,
          confidencePct: setup.confidencePct,
          rows: results,
        };
      },
    }),

    read_uploaded_data: tool({
      description:
        'Read the raw data files the user attached to the chat (CSV / Excel, parsed into tables). '
        + 'Returns headers and rows so you can map columns to currencies, exposures, and monthly flows, '
        + 'then feed them into the other tools.',
      inputSchema: z.object({
        fileName: z.string().optional().describe('Read one specific file; omit for all'),
        maxRows: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ fileName, maxRows }) => {
        const files = attachedData.filter(
          f => !fileName || f.name.toLowerCase() === fileName.toLowerCase(),
        );
        if (files.length === 0) {
          return {
            error: attachedData.length === 0
              ? 'No files attached. Ask the user to attach a CSV or Excel file with the paperclip button.'
              : `No attached file named "${fileName}". Available: ${attachedData.map(f => f.name).join(', ')}`,
          };
        }
        const cap = maxRows ?? 100;
        return {
          files: files.map(f => ({
            name: f.name,
            kind: f.kind,
            sheetName: f.sheetName,
            headers: f.headers,
            totalRows: f.totalRows,
            rows: f.rows.slice(0, cap),
            truncated: f.totalRows > Math.min(cap, f.rows.length),
          })),
        };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
