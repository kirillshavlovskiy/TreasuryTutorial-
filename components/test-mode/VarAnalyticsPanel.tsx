'use client';

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExposureHedgePathChart } from '@/components/test-mode/ExposureHedgePathChart';
import {
  DEFAULT_FORECAST_PROFILE,
  monthlyFlowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import type { RowState } from '@/lib/fx-buffer';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  hedgeBasisNotionalLocalM,
  hedgeRatioForNumber,
  resolveChartMonthlyFlows,
  type HedgePathBasisId,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  buildHedgeVarSummary,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import {
  buildRollingHedgeEdges,
  hasRollingStripForCcy,
  mergeRollingStripIntoBook,
  needsRollingHedges,
  proposeRollingHedgeTickets,
  type RollingHedgeEdge,
} from '@/lib/test-mode/rolling-hedge';
import { VAR_CONFIDENCE_OPTIONS } from '@/lib/test-mode/var-confidence';
import {
  FORECAST_PERIOD_OPTIONS,
  FORECAST_UNCERTAINTY_OPTIONS,
  forecastPeriodIdForMonths,
  growingVarByHorizonUsdM,
  setupLabel,
  VAR_EXPOSURE_OPTIONS,
  volForHorizon,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

interface VarAnalyticsPanelProps {
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  onSetupChange: (setup: VarSetup) => void;
  hedgeRatios?: Record<string, number>;
  onHedgeRatiosChange?: (ratios: Record<string, number>) => void;
  bookedHedges?: HedgeTicket[];
  onBookedHedgesChange?: (tickets: HedgeTicket[]) => void;
  title?: string;
  /** Live FX book rows — used with forecastProfile for custom month schedules. */
  bookRows?: RowState[];
  /** Flat or custom Revenue/Expenses schedule from FX Risk. */
  forecastProfile?: ForecastProfileState;
  /** Opens the same Forecast profile modal as FX Risk. */
  onOpenForecastProfile?: () => void;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

function fmtSignedM(v: number): string {
  const sign = v >= 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(2)}M`;
}

function shortHorizonLabel(label: string): string {
  return label
    .replace(' months', 'm')
    .replace(' month', 'm')
    .replace(' week', 'w')
    .replace(' year', 'y');
}

function stubRowFromBar(ccy: string, flowM: number): RowState {
  return {
    id: ccy,
    ccy,
    σ_daily: 0,
    r_FCY: 0,
    r_OD: 0,
    β_IR: 0,
    spot: 0,
    fwd: 0,
    nonCash: 0,
    nonCashAsset: 0,
    cash: 0,
    payout: 0,
    collections: flowM,
    fcastFX: 0,
    nonNpCash: 0,
    cash_floor: 0,
    ir_asset_notional: 0,
    ir_asset_rate: 0,
    ir_liab_notional: 0,
    ir_liab_rate: 0,
    ir_net_dur: 0,
  };
}

/**
 * Analytics — exposure inputs + VaR engine (shared across Decision / Ladder / Risk Metrics).
 * Active VaR horizon is chosen on the evolution chart (no separate period chips).
 */
export function VarAnalyticsPanel({
  risk,
  setup,
  onSetupChange,
  hedgeRatios = {},
  onHedgeRatiosChange,
  bookedHedges = [],
  onBookedHedgesChange,
  title = 'Analytics — VaR setup',
  bookRows,
  forecastProfile = DEFAULT_FORECAST_PROFILE,
  onOpenForecastProfile,
}: VarAnalyticsPanelProps) {
  const vol = volForHorizon(setup.horizon);
  const profile = VAR_EXPOSURE_OPTIONS.find(o => o.id === setup.exposureBasis);
  const customSchedule = forecastProfile.mode === 'custom';
  /** Chart opens only when user picks a currency in the Live VaR table. */
  const [chartCcy, setChartCcy] = useState<string | null>(null);
  const [pathBasis, setPathBasis] = useState<HedgePathBasisId>('totalExpected');

  const monthlyFlowsByCcy = useMemo(() => {
    const out: Record<string, number[]> = {};
    const T = setup.forecastMonths;
    if (T <= 0) return out;
    const rowsByCcy = new Map((bookRows ?? []).map(r => [r.ccy, r]));
    for (const { bar } of risk) {
      if (bar.ccy === 'USD') continue;
      const row =
        rowsByCcy.get(bar.ccy) ??
        stubRowFromBar(
          bar.ccy,
          setup.forecastMonths > 0 && Math.abs(bar.flowM) > 1e-15 ? bar.flowM : 0,
        );
      out[bar.ccy] = monthlyFlowSeriesLocalM(row, T, forecastProfile);
    }
    return out;
  }, [bookRows, forecastProfile, risk, setup.forecastMonths]);

  const summary = useMemo(
    () =>
      buildHedgeVarSummary(
        risk,
        hedgeRatios,
        setup,
        bookedHedges,
        monthlyFlowsByCcy,
      ),
    [risk, hedgeRatios, setup, bookedHedges, monthlyFlowsByCcy],
  );

  const chartRow = chartCcy
    ? summary.rows.find(r => r.ccy === chartCcy)
    : undefined;
  const chartBar = chartCcy
    ? risk.find(r => r.bar.ccy === chartCcy)?.bar
    : undefined;
  const eurBar = risk.find(r => r.bar.ccy === 'EUR')?.bar;
  const hedged =
    bookedHedges.length > 0 || summary.rows.some(r => r.hedgeRatio > 1e-9);

  const applyPathBasis = (basis: HedgePathBasisId) => {
    if (!onHedgeRatiosChange || !chartRow || !chartBar) return;
    setPathBasis(basis);
    const flowM =
      setup.forecastMonths > 0 && Math.abs(chartBar.flowM) > 1e-15
        ? chartBar.flowM
        : 0;
    const { startM, endM, flows } = resolveChartMonthlyFlows(
      chartBar.stockNetM,
      flowM,
      setup,
      monthlyFlowsByCcy[chartRow.ccy],
    );
    // When Tf > Th: Cash → S@start; Total → E@end; VaR-neutral → mid.
    const sizing =
      basis === 'cash'
        ? 'stockStart'
        : basis === 'totalExpected'
          ? 'windowEnd'
          : 'varNeutral';
    const target =
      needsRollingHedges(setup) &&
      (basis === 'cash' ||
        basis === 'totalExpected' ||
        basis === 'varNeutral')
        ? buildRollingHedgeEdges(startM, flows, setup, sizing)[0]
            ?.hedgeLocalM ??
          chartRow.equalVarHedgeLocalM
        : hedgeBasisNotionalLocalM(
            basis,
            startM,
            endM,
            chartRow.equalVarHedgeLocalM,
          );
    // Decision scale: 100% = Target (Total expected).
    const target100 = Math.abs(chartRow.targetHedgeLocalM);
    const ratio =
      target100 < 1e-12
        ? 0
        : Math.min(1, hedgeRatioForNumber(target, chartRow.targetHedgeLocalM));
    onHedgeRatiosChange({ ...hedgeRatios, [chartRow.ccy]: ratio });
  };

  const closePathChart = () => setChartCcy(null);

  const bookRollingStrip = (edges: RollingHedgeEdge[]) => {
    if (!onBookedHedgesChange || !chartRow) return;
    if (hasRollingStripForCcy(bookedHedges, chartRow.ccy)) {
      closePathChart();
      return;
    }
    const ticketBasis =
      pathBasis === 'cash'
        ? 'stock'
        : pathBasis === 'totalExpected'
          ? 'totalBuildup'
          : setup.exposureBasis === 'stock'
            ? 'simpleAvg'
            : setup.exposureBasis;
    const tickets = proposeRollingHedgeTickets(
      chartRow.ccy,
      edges,
      setup,
      ticketBasis,
    );
    onBookedHedgesChange(
      mergeRollingStripIntoBook(bookedHedges, tickets, chartRow.ccy),
    );
    onHedgeRatiosChange?.({ ...hedgeRatios, [chartRow.ccy]: 0 });
    closePathChart();
  };

  const eurTerm = useMemo(() => {
    if (!eurBar) return [];
    const flowM =
      setup.forecastMonths > 0 && Math.abs(eurBar.flowM) > 1e-15 ? eurBar.flowM : 0;
    const flows = monthlyFlowsByCcy.EUR;
    return growingVarByHorizonUsdM(
      eurBar.stockNetM,
      flowM,
      'EUR',
      setup,
      flows,
    );
  }, [eurBar, setup, monthlyFlowsByCcy]);

  const maxTermVar = Math.max(1e-9, ...eurTerm.map(t => t.varUsdM));

  const patch = (partial: Partial<VarSetup>) => onSetupChange({ ...setup, ...partial });

  return (
    <div className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200">
      <div>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          Exposure inputs set the hedge target and VaR profile. Pick the active tenure on the
          evolution chart — it drives Hedging Decision, Live Ladder, and Risk Metrics.
        </p>
      </div>

      {/* ── Input exposure metrics ── */}
      <section className="space-y-3 rounded-lg border border-violet-700/40 bg-violet-950/20 p-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">
            Input exposure metrics
          </div>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Forecast period (Tf), profile, and optional 1m forecast uncertainty — shape Exp and
            VaR curvature vs tenure.
          </p>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium text-slate-400">Forecast period</div>
          <div className="flex flex-wrap gap-2">
            {FORECAST_PERIOD_OPTIONS.map(opt => {
              const on = forecastPeriodIdForMonths(setup.forecastMonths) === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={
                    opt.months === 0
                      ? 'No forecast — stock only'
                      : `Revenue path builds for ${opt.months}m (caps growth / sets average area)`
                  }
                  onClick={() => patch({ forecastMonths: opt.months })}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                    on
                      ? 'border-violet-500 bg-violet-500/20 text-violet-100'
                      : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium text-slate-400">
            Forecast profile
          </div>
          <button
            type="button"
            onClick={() => onOpenForecastProfile?.()}
            disabled={!onOpenForecastProfile || setup.forecastMonths === 0}
            className="rounded-lg border border-violet-500/50 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-100 hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              setup.forecastMonths === 0
                ? 'No forecast period — pick 1 month+ to edit Revenue / Expenses profile'
                : 'Edit flat or custom per-period Revenue / Expenses'
            }
          >
            Forecast profile…
            {customSchedule && (
              <span className="ml-1 text-[10px] font-semibold text-violet-300">
                custom
              </span>
            )}
          </button>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium text-slate-400">
            Incremental forecast uncertainty (1m)
          </div>
          <div className="flex flex-wrap gap-2">
            {FORECAST_UNCERTAINTY_OPTIONS.map(opt => {
              const on =
                Math.abs((setup.forecastUncertainty1m ?? 0) - opt.value) < 1e-12;
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={
                    opt.value === 0
                      ? 'FX path only — no quantity uncertainty on the forecast'
                      : `1m relative vol of monthly flow F. Accrues as √g over g=min(Th,Tf); folds into FX √T as √(E²+σ_E²).`
                  }
                  disabled={setup.forecastMonths === 0 || setup.exposureBasis === 'stock'}
                  onClick={() => patch({ forecastUncertainty1m: opt.value })}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    on
                      ? 'border-amber-500 bg-amber-500/20 text-amber-100'
                      : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-500">
            {setup.exposureBasis === 'stock' || setup.forecastMonths === 0
              ? 'Applies to simple/weighted avg / growth path when Tf > 0 (stock ignores forecast u).'
              : `σ_E = |F|×${((setup.forecastUncertainty1m ?? 0) * 100).toFixed(0)}%×√g · g=min(Th,Tf=${setup.forecastMonths}m) — higher u steepens VaR vs tenure.`}
          </p>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium text-slate-400">
            VaR profile (exposure basis)
          </div>
          <div
            className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
            role="group"
            aria-label="VaR profile"
          >
            {VAR_EXPOSURE_OPTIONS.map(opt => {
              const on = setup.exposureBasis === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={opt.description}
                  onClick={() => patch({ exposureBasis: opt.id })}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    on
                      ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {opt.label}
                  <span className="ml-1 text-[9px] font-normal opacity-70">
                    {opt.varProfile === 'sqrtT' ? '√T' : 'path'}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-500">
            {profile?.description}
          </p>
        </div>
      </section>

      {/* ── VaR evolution: bar chart (pick horizon) + confidence on the right ── */}
      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            EUR VaR evolution · select horizon
          </div>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Profile: {profile?.label ?? setup.exposureBasis}
            {' · '}
            Tf = {setup.forecastMonths === 0 ? '0 (stock)' : `${setup.forecastMonths}m`}
            {customSchedule ? ' · custom schedule' : ''}
            {(setup.forecastUncertainty1m ?? 0) > 0
              ? ` · u₁ₘ ${((setup.forecastUncertainty1m ?? 0) * 100).toFixed(0)}%`
              : ''}
            {' — click a column to set the active VaR horizon for all tabs.'}
          </p>
        </div>

        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            {eurTerm.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">No EUR book to project.</p>
            ) : (
              <>
                <div
                  className="grid gap-1"
                  style={{ gridTemplateColumns: `repeat(${eurTerm.length}, minmax(0, 1fr))` }}
                >
                  {eurTerm.map(t => {
                    const barH = Math.max(10, Math.round((t.varUsdM / maxTermVar) * 120));
                    const on = setup.horizon === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        title={`${t.label}: ${fmtVarK(t.varUsdM)} — set as active horizon`}
                        onClick={() => patch({ horizon: t.id })}
                        className={`flex flex-col items-center rounded-md px-0.5 py-1 transition-colors ${
                          on ? 'bg-emerald-500/10' : 'hover:bg-slate-800/50'
                        }`}
                      >
                        <span
                          className={`mb-1 h-4 font-mono text-[10px] tabular-nums leading-none ${
                            on ? 'text-emerald-300' : 'text-slate-400'
                          }`}
                        >
                          {fmtVarK(t.varUsdM)}
                        </span>
                        <div className="flex h-[120px] w-full items-end justify-center border-b border-slate-700/80">
                          <div
                            className={`w-6 rounded-t-sm sm:w-7 ${
                              on
                                ? 'bg-emerald-500 shadow-[0_0_0_1px_rgba(110,231,183,0.45)]'
                                : 'bg-slate-500 hover:bg-slate-400'
                            }`}
                            style={{ height: barH }}
                          />
                        </div>
                        <span
                          className={`mt-1.5 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-[10px] font-semibold ${
                            on
                              ? 'bg-emerald-500/30 text-emerald-100 ring-1 ring-emerald-400/50'
                              : 'text-slate-500'
                          }`}
                        >
                          {shortHorizonLabel(t.label)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-center text-[10px] text-slate-500">
                  Active:{' '}
                  <span className="font-medium text-emerald-300">
                    {eurTerm.find(t => t.id === setup.horizon)?.label ?? setup.horizon}
                  </span>
                  {' · '}
                  σ = {(vol * 100).toFixed(2)}%
                  {profile?.varProfile === 'sqrtT'
                    ? ' · √T curvature'
                    : ' · path curvature'}
                </p>
              </>
            )}
          </div>

          <div className="flex w-[7.5rem] shrink-0 flex-col gap-1.5 border-l border-slate-800 pl-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-blue-300">
              Confidence
            </div>
            {VAR_CONFIDENCE_OPTIONS.map(opt => {
              const on = setup.confidencePct === opt.pct;
              return (
                <button
                  key={opt.pct}
                  type="button"
                  onClick={() => patch({ confidencePct: opt.pct })}
                  className={`rounded-lg border px-2.5 py-2 text-left text-xs font-semibold transition-colors ${
                    on
                      ? 'border-blue-500 bg-blue-500/20 text-blue-100'
                      : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  {opt.label}
                  <span className="mt-0.5 block font-mono text-[10px] font-normal text-slate-500">
                    z = {opt.z}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="VaR at Δ = 1"
          value={fmtVarK(summary.totalVarBeforeUsdM)}
          hint={
            profile?.varProfile === 'path'
              ? 'Path-integrated · undiversified Σ'
              : '√T profile · undiversified Σ'
          }
        />
        <Stat
          label="VaR after hedge"
          value={fmtVarK(summary.totalVarAfterUsdM)}
          hint={hedged ? 'Residual from Decision layer' : 'No hedge yet'}
          accent
        />
        <Stat
          label="VaR reduction"
          value={fmtVarK(summary.varReductionUsdM)}
          hint={
            summary.totalVarBeforeUsdM > 1e-12
              ? `${((summary.varReductionUsdM / summary.totalVarBeforeUsdM) * 100).toFixed(0)}% cut`
              : '—'
          }
        />
      </div>

      <div className="space-y-3">
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Live VaR · {setupLabel(setup)}
          {hedged ? ' · after Hedging Decision' : ' · Δ = 1 (unhedged)'}
          {customSchedule ? ' · custom schedule' : ''}
          <span className="ml-2 font-normal normal-case text-slate-600">
            — click a currency row to open the path chart
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th className="py-2 pr-3 font-medium">CCY</th>
                <th className="py-2 pr-3 font-medium">Exposure @ Δ1</th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="VaR-neutral Equal-VaR bullet (Decision mid)"
                >
                  VaR-neutral N
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Total expected — Decision 100% Target"
                >
                  Target N
                </th>
                <th className="py-2 pr-3 font-medium" title="% of Target">
                  Hedge %
                </th>
                <th className="py-2 pr-3 font-medium">Hedge N</th>
                <th className="py-2 pr-3 font-medium">Δ</th>
                <th className="py-2 pr-3 font-medium">Residual</th>
                <th className="py-2 pr-3 font-medium">VaR @ Δ1</th>
                <th className="py-2 font-medium">VaR after</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map(r => (
                <tr
                  key={r.ccy}
                  className="cursor-pointer border-b border-slate-800/80 hover:bg-violet-500/10"
                  onClick={() => {
                    setPathBasis(
                      needsRollingHedges(setup) ? 'totalExpected' : 'varNeutral',
                    );
                    setChartCcy(r.ccy);
                  }}
                  title={`Open ${r.ccy} exposure path vs hedge`}
                >
                  <td className="py-2 pr-3 font-semibold text-violet-200">
                    {r.ccy}
                    <span className="ml-1 text-[9px] font-normal text-violet-400/80">
                      path
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-300">
                    {fmtSignedM(r.openExposureLocalM)}
                  </td>
                  <td
                    className="py-2 pr-3 font-mono text-sky-300/90"
                    title={
                      r.hedgeCapped
                        ? 'Capped by accrued forecast position at Th'
                        : 'Linear bullet notional matching open VaR'
                    }
                  >
                    {fmtSignedM(r.equalVarHedgeLocalM)}
                    {r.hedgeCapped ? (
                      <span className="ml-1 text-[9px] text-amber-400/90">cap</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 font-mono text-violet-200/90">
                    {fmtSignedM(r.targetHedgeLocalM)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-emerald-300/90">
                    {Math.round(r.hedgeRatio * 100)}%
                  </td>
                  <td className="py-2 pr-3 font-mono text-emerald-200">
                    {fmtSignedM(r.hedgeNotionalLocalM)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-amber-300">
                    {r.delta.toFixed(2)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-400">
                    {fmtSignedM(r.residualLocalM)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-500">
                    {fmtVarK(r.varBeforeUsdM)}
                  </td>
                  <td className="py-2 font-mono font-semibold text-slate-300">
                    {fmtVarK(r.varAfterUsdM)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {chartCcy &&
        chartRow &&
        chartBar &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exposure-path-title"
            onClick={e => {
              if (e.target === e.currentTarget) closePathChart();
            }}
          >
            <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h4
                    id="exposure-path-title"
                    className="text-sm font-semibold text-white"
                  >
                    {chartCcy} — exposure path vs hedge
                  </h4>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    Selected regime:{' '}
                    <span className="font-semibold text-violet-200">
                      {pathBasis === 'cash'
                        ? 'Cash (stock)'
                        : pathBasis === 'varNeutral'
                          ? 'VaR-neutral'
                          : 'Target (Total)'}
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closePathChart}
                  className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Close
                </button>
              </div>
              <ExposureHedgePathChart
                key={`${chartRow.ccy}-${chartRow.hedgeRatio.toFixed(4)}-${chartRow.hedgeNotionalLocalM.toFixed(3)}-${setup.horizon}-${setup.forecastMonths}-${setup.exposureBasis}`}
                ccy={chartRow.ccy}
                stockM={chartBar.stockNetM}
                monthlyFlowM={
                  setup.forecastMonths > 0 && Math.abs(chartBar.flowM) > 1e-15
                    ? chartBar.flowM
                    : 0
                }
                monthlyFlows={monthlyFlowsByCcy[chartRow.ccy]}
                setup={setup}
                appliedHedgeLocalM={chartRow.hedgeNotionalLocalM}
                hedgeRatio={chartRow.hedgeRatio}
                equalVarHedgeLocalM={chartRow.equalVarHedgeLocalM}
                endExposureM={chartRow.openExposureLocalM}
                selectedBasis={pathBasis}
                onSelectedBasisChange={setPathBasis}
                onApplyBasis={applyPathBasis}
                onBookRollingStrip={
                  onBookedHedgesChange ? bookRollingStrip : undefined
                }
                stripAlreadyBooked={
                  chartRow
                    ? hasRollingStripForCcy(bookedHedges, chartRow.ccy)
                    : false
                }
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        accent
          ? 'border-blue-600/40 bg-blue-500/10'
          : 'border-slate-800 bg-slate-950/50'
      }`}
    >
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${accent ? 'text-blue-200' : ''}`}>
        {value}
      </div>
      <div className="text-[10px] text-slate-600">{hint}</div>
    </div>
  );
}
