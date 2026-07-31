'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
  inferHedgePathBasis,
  resolveChartMonthlyFlows,
  resyncHedgeRatiosToNearestRegime,
  type HedgePathBasisId,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  buildHedgeVarSummary,
  buildStripHedgedVarProfile,
  equalVarLinearHedgeNotionalLocalM,
  overlayRiskFromFxBook,
  stripTicketsForCcy,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import {
  buildRollingHedgeEdges,
  hasRollingStripForCcy,
  mergeRollingStripIntoBook,
  needsRollingHedges,
  proposeRollingHedgeTickets,
  resyncBookedRollingStrips,
  sizingForHedgePathBasis,
  stripForwardLegsFromEdges,
  varSetupForHedgeStructure,
  varSetupForPathHedgeRegime,
  type ForecastHedgeStructure,
  type RollingHedgeEdge,
  type StripForwardLeg,
} from '@/lib/test-mode/rolling-hedge';
import { VAR_CONFIDENCE_OPTIONS } from '@/lib/test-mode/var-confidence';
import {
  RiskPerspectiveSelector,
  riskPerspectiveMeta,
  type RiskPerspective,
} from '@/components/test-mode/RiskPerspectiveSelector';
import {
  FORECAST_PERIOD_OPTIONS,
  FORECAST_UNCERTAINTY_OPTIONS,
  accruedPositionFromScheduleM,
  forecastPeriodIdForMonths,
  growingVarByHorizonUsdM,
  horizonMonths,
  monthlyVolForSetup,
  normalizeVarSetup,
  setupLabel,
  VAR_EXPOSURE_OPTIONS,
  VAR_HORIZON_OPTIONS,
  VAR_PROFILE_OPTIONS,
  VAR_VOL_SOURCE_OPTIONS,
  volForHorizon,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.9 1.01 1.55 1.01H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}

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
  risk: seedRisk,
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
  /** Live FX Risk table stock/flow — not entity seed (e.g. EUR 1.9). */
  const risk = useMemo(
    () =>
      overlayRiskFromFxBook(
        seedRisk,
        bookRows,
        setup,
        forecastProfile,
      ),
    [seedRisk, bookRows, setup, forecastProfile],
  );
  const σ1m = monthlyVolForSetup(setup);
  const vol = volForHorizon(setup.horizon, setup);
  const profile = VAR_PROFILE_OPTIONS.find(o => o.id === setup.exposureBasis)
    ?? VAR_EXPOSURE_OPTIONS.find(o => o.id === setup.exposureBasis);
  const volOpt = VAR_VOL_SOURCE_OPTIONS.find(o => o.id === setup.volSource);
  const customSchedule = forecastProfile.mode === 'custom';
  const [varParamsOpen, setVarParamsOpen] = useState(false);
  const [perspective, setPerspective] = useState<RiskPerspective>('fxRisk');
  const u1m = setup.forecastUncertainty1m ?? 0;
  const uPresetMatch = FORECAST_UNCERTAINTY_OPTIONS.find(
    o => Math.abs(o.value - u1m) < 1e-12,
  );
  const [uCustomOpen, setUCustomOpen] = useState(() => uPresetMatch == null && u1m > 0);
  const [uCustomDraft, setUCustomDraft] = useState(() =>
    Number((u1m * 100).toFixed(2)).toString(),
  );
  const uncertaintyCustom =
    uCustomOpen || (uPresetMatch == null && u1m > 0);

  // Migrate Cash-only stock off the VaR profile picker; fill convention defaults.
  useEffect(() => {
    const next = normalizeVarSetup(setup);
    if (
      next.exposureBasis !== setup.exposureBasis ||
      next.averagingConvention !== setup.averagingConvention
    ) {
      onSetupChange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot migrate
  }, [setup.exposureBasis, setup.averagingConvention]);

  /** Chart opens only when user picks a currency in the Live VaR table. */
  const [chartCcy, setChartCcy] = useState<string | null>(null);
  const [pathBasis, setPathBasis] = useState<HedgePathBasisId>('totalExpected');
  const [hedgeStructure, setHedgeStructure] =
    useState<ForecastHedgeStructure>('bullet');
  const stripAvailable = needsRollingHedges(setup);
  /** Booked strip ⇒ Live VaR uses strip Th sizing (legs still from M0). */
  const stripBooked = bookedHedges.some(t => Boolean(t.stripId));
  const effectiveStructure: ForecastHedgeStructure =
    stripAvailable && (hedgeStructure === 'strip' || stripBooked)
      ? 'strip'
      : 'bullet';
  /** Path-chart / apply: bullet sizes Equal-VaR at Th = Tf. */
  const chartSizingSetup = useMemo(
    () => varSetupForHedgeStructure(setup, effectiveStructure),
    [setup, effectiveStructure],
  );

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

  /**
   * Live VaR + path modal share this book: bullet sizes Equal-VaR / open Exp at
   * Th = Tf (e.g. 3m simple avg → Ē = 3.7), matching the path-chart VN chip.
   * Strip keeps Analytics Th for the first roll window.
   */
  const summary = useMemo(
    () =>
      buildHedgeVarSummary(
        risk,
        hedgeRatios,
        chartSizingSetup,
        bookedHedges,
        monthlyFlowsByCcy,
      ),
    [risk, hedgeRatios, chartSizingSetup, bookedHedges, monthlyFlowsByCcy],
  );

  /**
   * Profile / sizing change: re-snap Cash·VN·Target % and rebuild booked
   * strips (all M0 legs) so Live VaR does not need the path modal.
   */
  const hedgeSetupSig = [
    setup.exposureBasis,
    setup.averagingConvention,
    setup.forecastMonths,
    setup.horizon,
    setup.confidencePct,
    setup.forecastUncertainty1m,
    setup.volSource,
    chartSizingSetup.horizon,
    chartSizingSetup.exposureBasis,
  ].join('|');
  const prevHedgeSetupSig = useRef<string | null>(null);
  useEffect(() => {
    if (prevHedgeSetupSig.current === null) {
      prevHedgeSetupSig.current = hedgeSetupSig;
      return;
    }
    if (prevHedgeSetupSig.current === hedgeSetupSig) return;
    prevHedgeSetupSig.current = hedgeSetupSig;
    if (onHedgeRatiosChange) {
      const synced = resyncHedgeRatiosToNearestRegime(summary.rows, hedgeRatios);
      if (synced) onHedgeRatiosChange(synced);
    }
    if (onBookedHedgesChange) {
      const bars = risk.map(r => ({
        ccy: r.bar.ccy,
        stockNetM: r.bar.stockNetM,
        flowM: r.bar.flowM,
      }));
      const rebuilt = resyncBookedRollingStrips(
        bookedHedges,
        bars,
        setup,
        monthlyFlowsByCcy,
      );
      if (rebuilt) onBookedHedgesChange(rebuilt);
    }
  }, [
    hedgeSetupSig,
    summary.rows,
    hedgeRatios,
    onHedgeRatiosChange,
    onBookedHedgesChange,
    bookedHedges,
    risk,
    setup,
    monthlyFlowsByCcy,
  ]);

  const chartRow = chartCcy
    ? summary.rows.find(r => r.ccy === chartCcy)
    : undefined;
  const chartBar = chartCcy
    ? risk.find(r => r.bar.ccy === chartCcy)?.bar
    : undefined;
  /** Non-USD exposures available for the VaR evolution chart. */
  const evolutionCcys = useMemo(
    () =>
      risk
        .map(r => r.bar.ccy)
        .filter(ccy => ccy !== 'USD'),
    [risk],
  );
  const [evoCcy, setEvoCcy] = useState<string>('EUR');
  useEffect(() => {
    if (evolutionCcys.length === 0) return;
    if (!evolutionCcys.includes(evoCcy)) {
      setEvoCcy(
        evolutionCcys.includes('EUR') ? 'EUR' : evolutionCcys[0]!,
      );
    }
  }, [evolutionCcys, evoCcy]);
  const evoBar = risk.find(r => r.bar.ccy === evoCcy)?.bar;
  const hedged =
    bookedHedges.length > 0 || summary.rows.some(r => r.hedgeRatio > 1e-9);

  const applyPathBasis = (
    basis: HedgePathBasisId,
    structure?: ForecastHedgeStructure,
  ) => {
    if (!chartRow || !chartBar) return;
    setPathBasis(basis);
    const flowM =
      setup.forecastMonths > 0 && Math.abs(chartBar.flowM) > 1e-15
        ? chartBar.flowM
        : 0;
    const flowsForCcy = monthlyFlowsByCcy[chartRow.ccy];
    const { startM, endM, flows } = resolveChartMonthlyFlows(
      chartBar.stockNetM,
      flowM,
      setup,
      flowsForCcy,
    );
    // Prefer structure from the chart (avoids stale parent 'bullet' on Strip click).
    const structureNow = structure ?? hedgeStructure;
    if (structure && structure !== hedgeStructure) {
      setHedgeStructure(structure);
    }
    // Strip: preview only (Cash/VN/Target chips). Book via "Book … forwards".
    if (structureNow === 'strip' && needsRollingHedges(setup)) {
      return;
    }
    if (!onHedgeRatiosChange) return;
    const bulletEq = equalVarLinearHedgeNotionalLocalM(
      chartBar.stockNetM,
      flowM,
      chartRow.ccy,
      varSetupForPathHedgeRegime(setup, 'bullet'),
      undefined,
      flowsForCcy ?? flows,
    ).amountLocalM;
    const target = hedgeBasisNotionalLocalM(
      basis,
      startM,
      endM,
      bulletEq,
    );
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
      monthlyFlowsByCcy[chartRow.ccy] ?? [],
    );
    onBookedHedgesChange(
      mergeRollingStripIntoBook(bookedHedges, tickets, chartRow.ccy),
    );
    onHedgeRatiosChange?.({ ...hedgeRatios, [chartRow.ccy]: 0 });
    closePathChart();
  };

  /**
   * Same hedge book as path modal: booked strip → strip by pathBasis →
   * Decision H, else Target E(Tf) preview so resid@Tf is always wired.
   */
  const evoHedgeLegs = useMemo((): StripForwardLeg[] => {
    if (!evoBar) return [];
    const Tf = setup.forecastMonths;
    if (!(Tf > 0)) return [];
    const flowM = Math.abs(evoBar.flowM) > 1e-15 ? evoBar.flowM : 0;
    const flows =
      monthlyFlowsByCcy[evoBar.ccy] ??
      Array.from({ length: Tf }, () => flowM);
    const endM = accruedPositionFromScheduleM(evoBar.stockNetM, flows, Tf);

    const booked = stripTicketsForCcy(bookedHedges, evoBar.ccy)
      .slice()
      .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
    if (booked.length > 0) {
      let cumul = 0;
      return booked.map((t, i) => {
        cumul += t.amountLocalM;
        const tenureMonths = horizonMonths(t.maturity ?? setup.horizon);
        return {
          index: t.stripEdgeIndex ?? i,
          label: `M0–M${Math.round(tenureMonths)}`,
          tenureMonths,
          amountLocalM: t.amountLocalM,
          cumulCoverLocalM: cumul,
          endExposureM: endM,
          stockStartM: evoBar.stockNetM,
        };
      });
    }

    if (effectiveStructure === 'strip' && needsRollingHedges(setup)) {
      return stripForwardLegsFromEdges(
        buildRollingHedgeEdges(
          evoBar.stockNetM,
          flows,
          setup,
          sizingForHedgePathBasis(pathBasis),
        ),
      );
    }

    const row = summary.rows.find(r => r.ccy === evoBar.ccy);
    const decisionH = row?.hedgeNotionalLocalM ?? 0;
    const H = Math.abs(decisionH) > 1e-12 ? decisionH : endM;
    return [
      {
        index: 0,
        label: `M0–M${Math.round(Tf)}`,
        tenureMonths: Tf,
        amountLocalM: H,
        cumulCoverLocalM: H,
        endExposureM: endM,
        stockStartM: evoBar.stockNetM,
      },
    ];
  }, [
    evoBar,
    bookedHedges,
    effectiveStructure,
    setup,
    monthlyFlowsByCcy,
    pathBasis,
    summary.rows,
  ]);

  /** Open + resid VaR through the longest horizon chip (post-Tf e flat; VN gap stays). */
  const evoProfile = useMemo(() => {
    if (!evoBar || evoHedgeLegs.length === 0) return [];
    const Tf = setup.forecastMonths;
    if (!(Tf > 0)) return [];
    const flowM = Math.abs(evoBar.flowM) > 1e-15 ? evoBar.flowM : 0;
    const schedule =
      monthlyFlowsByCcy[evoBar.ccy] ??
      Array.from({ length: Math.ceil(Tf) }, () => flowM);
    const Eref = Math.abs(
      accruedPositionFromScheduleM(evoBar.stockNetM, schedule, Tf),
    );
    const throughMonths = Math.max(
      Tf,
      ...VAR_HORIZON_OPTIONS.map(h => h.months),
    );
    return buildStripHedgedVarProfile(
      evoBar.stockNetM,
      flowM,
      evoBar.ccy,
      setup,
      evoHedgeLegs.map(l => ({
        amountLocalM: l.amountLocalM,
        tenureMonths: l.tenureMonths,
        recognizeFromMonths: 0,
      })),
      schedule,
      1,
      Eref > 1e-12 ? Eref : undefined,
      throughMonths,
    );
  }, [evoBar, evoHedgeLegs, setup, monthlyFlowsByCcy]);

  /** Horizon pickers: open VaR + resid VaR (samples past Tf when forecast is short). */
  const evoTerm = useMemo(() => {
    if (!evoBar) return [];
    const flowM =
      setup.forecastMonths > 0 && Math.abs(evoBar.flowM) > 1e-15
        ? evoBar.flowM
        : 0;
    const flows = monthlyFlowsByCcy[evoBar.ccy];
    const open = growingVarByHorizonUsdM(
      evoBar.stockNetM,
      flowM,
      evoBar.ccy,
      setup,
      flows,
    );
    const atProfile = (months: number) => {
      if (evoProfile.length === 0) return null;
      return (
        evoProfile.find(p => Math.abs(p.t - months) < 1e-6) ??
        evoProfile.reduce((best, p) =>
          Math.abs(p.t - months) < Math.abs(best.t - months) ? p : best,
        )
      );
    };
    return open.map(t => {
      const p = atProfile(t.months);
      return {
        ...t,
        residualVarUsdM: p?.hedgedVarUsdM ?? null,
        absResidualM: p?.residualCoverLocalM ?? null,
      };
    });
  }, [evoBar, setup, monthlyFlowsByCcy, evoProfile]);

  const maxTermVar = Math.max(
    1e-9,
    ...evoTerm.map(t => Math.max(t.varUsdM, t.residualVarUsdM ?? 0)),
  );
  const showEvoHedge = evoProfile.length > 0;

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

      <RiskPerspectiveSelector value={perspective} onChange={setPerspective} />

      {perspective !== 'fxRisk' ? (
        <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-10 text-center text-xs text-slate-500">
          {riskPerspectiveMeta(perspective).label} view is coming soon on Analytics.
        </div>
      ) : (
      <>
      {/* ── Input exposure metrics ── */}
      <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              Input exposure metrics
            </div>
            <p className="mt-0.5 text-[10px] text-slate-500">
              Forecast period (Tf) and optional 1m forecast uncertainty — shape Exp and VaR
              curvature vs tenure.
              {customSchedule ? ' Profile: custom.' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenForecastProfile?.()}
            disabled={!onOpenForecastProfile || setup.forecastMonths === 0}
            title={
              setup.forecastMonths === 0
                ? 'No forecast period — pick 1 month+ to edit Revenue / Expenses profile'
                : 'Forecast profile — flat or custom per-period Revenue / Expenses'
            }
            aria-label="Open forecast profile setup"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <GearIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium text-slate-400">Forecast period</div>
          <div
            className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
            role="group"
            aria-label="Forecast period"
          >
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
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    on
                      ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
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
            Incremental forecast uncertainty (1m)
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Forecast uncertainty"
            >
              {FORECAST_UNCERTAINTY_OPTIONS.map(opt => {
                const on = !uncertaintyCustom && Math.abs(u1m - opt.value) < 1e-12;
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
                    onClick={() => {
                      setUCustomOpen(false);
                      patch({ forecastUncertainty1m: opt.value });
                    }}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      on
                        ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
              <button
                type="button"
                title="Enter an exact 1m forecast uncertainty (%)"
                disabled={setup.forecastMonths === 0 || setup.exposureBasis === 'stock'}
                onClick={() => {
                  setUCustomOpen(true);
                  setUCustomDraft(Number((u1m * 100).toFixed(2)).toString());
                  if (u1m <= 0) {
                    const starter = 0.15;
                    setUCustomDraft('15');
                    patch({ forecastUncertainty1m: starter });
                  }
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  uncertaintyCustom
                    ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Custom
              </button>
            </div>
            {uncertaintyCustom && (
              <label
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-[11px] text-slate-300"
                title="Exact 1m relative forecast uncertainty"
              >
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  disabled={setup.forecastMonths === 0 || setup.exposureBasis === 'stock'}
                  className="w-16 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 text-right font-mono text-[11px] text-slate-100 disabled:opacity-40"
                  value={uCustomDraft}
                  onChange={e => {
                    setUCustomDraft(e.target.value);
                    const pct = Number(e.target.value);
                    if (!Number.isFinite(pct) || pct < 0) return;
                    setUCustomOpen(true);
                    patch({ forecastUncertainty1m: pct / 100 });
                  }}
                />
                <span className="text-slate-500">%</span>
              </label>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-500">
            {setup.forecastMonths === 0
              ? 'Pick a forecast period &gt; 0 to enable quantity uncertainty.'
              : `σ_E = |F|×${(u1m * 100).toFixed(2).replace(/\.?0+$/, '')}%×√g · g=min(Th,Tf=${setup.forecastMonths}m) — higher u steepens VaR vs tenure.`}
          </p>
        </div>
      </section>

      {/* ── VaR setup: profile chips + gear modal (avg + σ) ── */}
      <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              VaR setup
            </div>
            <p className="mt-0.5 text-[10px] text-slate-500">
              Pick the exposure profile. Gear opens averaging convention, σ₁ₘ source, and
              future VaR parameters.
            </p>
          </div>
          <button
            type="button"
            title="VaR parameters — averaging & volatility"
            aria-label="Open VaR parameters"
            onClick={() => setVarParamsOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
          >
            <GearIcon className="h-3.5 w-3.5" />
          </button>
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
            {VAR_PROFILE_OPTIONS.map(opt => {
              const on = setup.exposureBasis === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={opt.description}
                  onClick={() => {
                    patch({ exposureBasis: opt.id });
                  }}
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
            {profile?.description} σ₁ₘ {(σ1m * 100).toFixed(1)}% (
            {volOpt?.label ?? setup.volSource}).
          </p>
        </div>
      </section>

      {varParamsOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="var-params-title"
            onClick={e => {
              if (e.target === e.currentTarget) setVarParamsOpen(false);
            }}
          >
            <div className="w-full max-w-lg rounded-xl border border-slate-600 bg-slate-900 p-5 shadow-2xl">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4
                    id="var-params-title"
                    className="text-sm font-semibold text-slate-100"
                  >
                    VaR parameters
                  </h4>
                  <p className="mt-1 text-[11px] text-slate-400">
                    σ₁ₘ source and future computational parameters. VaR profile
                    (simple / time-weighted / growth path) is set on the main
                    Analytics panel.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setVarParamsOpen(false)}
                  className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Close
                </button>
              </div>

              <div className="mt-4 space-y-5">
                <div>
                  <div className="mb-1.5 text-[11px] font-medium text-slate-400">
                    Volatility σ₁ₘ
                  </div>
                  <div
                    className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
                    role="group"
                    aria-label="Volatility source"
                  >
                    {VAR_VOL_SOURCE_OPTIONS.map(opt => {
                      const on = setup.volSource === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          title={opt.description}
                          onClick={() => patch({ volSource: opt.id })}
                          className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                            on
                              ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                              : 'text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          {opt.label}
                          <span className="ml-1 font-mono text-[10px] font-normal opacity-80">
                            {(opt.monthlyVol * 100).toFixed(1)}%
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[10px] text-slate-500">
                    {volOpt?.description ?? ''} Active σ₁ₘ = {(σ1m * 100).toFixed(2)}% ·
                    σ_T = {(vol * 100).toFixed(2)}% at {setup.horizon}.
                  </p>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* ── VaR evolution: bar chart (pick horizon) + confidence on the right ── */}
      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              VaR evolution · select horizon
            </div>
            {evolutionCcys.length > 0 && (
              <div
                className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
                role="group"
                aria-label="Evolution currency"
              >
                {evolutionCcys.map(ccy => {
                  const on = evoCcy === ccy;
                  return (
                    <button
                      key={ccy}
                      type="button"
                      title={`Show ${ccy} VaR vs tenure`}
                      onClick={() => setEvoCcy(ccy)}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                        on
                          ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {ccy}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-500">
            {evoCcy} · Profile: {profile?.label ?? setup.exposureBasis}
            {' · '}
            Tf = {setup.forecastMonths === 0 ? '0 (stock)' : `${setup.forecastMonths}m`}
            {customSchedule ? ' · custom schedule' : ''}
            {showEvoHedge
              ? ' · stacked bar: green reduction / yellow remaining · columns after Tf = beyond forecast (e flat, resid still grows)'
              : ' — click a column to set the active VaR horizon.'}
          </p>
        </div>

        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            {evoTerm.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">
                No FX book to project.
              </p>
            ) : (
              <>
                <div
                  className="grid gap-1"
                  style={{
                    gridTemplateColumns: `repeat(${evoTerm.length}, minmax(0, 1fr))`,
                  }}
                >
                  {evoTerm.map(t => {
                    const openH = Math.max(
                      8,
                      Math.round((t.varUsdM / maxTermVar) * 100),
                    );
                    const residH =
                      t.residualVarUsdM != null
                        ? Math.min(
                            openH,
                            Math.max(
                              t.residualVarUsdM > 1e-12 ? 3 : 0,
                              Math.round(
                                (t.residualVarUsdM / maxTermVar) * 100,
                              ),
                            ),
                          )
                        : 0;
                    const coveredH = Math.max(0, openH - residH);
                    const on = setup.horizon === t.id;
                    const beyondForecast =
                      setup.forecastMonths > 0 &&
                      t.months > setup.forecastMonths + 1e-9;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        title={
                          t.residualVarUsdM != null
                            ? `${evoCcy} ${t.label}: open ${fmtVarK(t.varUsdM)} · resid ${fmtVarK(t.residualVarUsdM)} · |e−H| ${t.absResidualM != null ? fmtSignedM(t.absResidualM) : '—'}${beyondForecast ? ' · beyond forecast (e flat)' : ''}`
                            : `${evoCcy} ${t.label}: ${fmtVarK(t.varUsdM)}`
                        }
                        onClick={() => patch({ horizon: t.id })}
                        className={`flex flex-col items-center rounded-md px-0.5 py-1 transition-colors ${
                          on
                            ? 'bg-emerald-500/10'
                            : beyondForecast
                              ? 'bg-slate-800/40 hover:bg-slate-800/70'
                              : 'hover:bg-slate-800/50'
                        }`}
                      >
                        <div className="mb-1 flex min-h-[2rem] flex-col items-center justify-end gap-0.5 font-mono text-[9px] tabular-nums leading-none">
                          <span
                            className={
                              on ? 'text-slate-200' : 'text-slate-400'
                            }
                          >
                            {fmtVarK(t.varUsdM)}
                          </span>
                          {t.residualVarUsdM != null && (
                            <span className="text-amber-300/90">
                              {fmtVarK(t.residualVarUsdM)}
                            </span>
                          )}
                        </div>
                        {/* One wide stacked bar: yellow remaining + green reduction */}
                        <div
                          className={`flex h-[100px] w-full items-end justify-center border-b ${
                            beyondForecast
                              ? 'border-slate-600/80 bg-slate-800/20'
                              : 'border-slate-700/80'
                          }`}
                        >
                          <div
                            className={`flex w-7 flex-col justify-end overflow-hidden rounded-t-sm sm:w-8 ${
                              on ? 'ring-1 ring-emerald-400/40' : ''
                            }`}
                            style={{ height: openH }}
                          >
                            {coveredH > 0 && (
                              <div
                                className="w-full bg-emerald-400/80"
                                style={{ height: coveredH }}
                                title="VaR reduction"
                              />
                            )}
                            {residH > 0 && (
                              <div
                                className={`w-full ${
                                  beyondForecast
                                    ? 'bg-amber-200/70'
                                    : 'bg-amber-300/90'
                                }`}
                                style={{ height: residH }}
                                title={
                                  beyondForecast
                                    ? 'Remaining resid VaR (beyond forecast)'
                                    : 'Remaining resid VaR'
                                }
                              />
                            )}
                          </div>
                        </div>
                        <span
                          className={`mt-1 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-[10px] font-semibold ${
                            on
                              ? 'bg-emerald-500/30 text-emerald-100 ring-1 ring-emerald-400/50'
                              : beyondForecast
                                ? 'text-slate-400'
                                : 'text-slate-500'
                          }`}
                        >
                          {shortHorizonLabel(t.label)}
                        </span>
                        {beyondForecast && (
                          <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wide text-slate-500">
                            post-Tf
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-center text-[10px] text-slate-500">
                  {evoCcy} · Active:{' '}
                  <span className="font-medium text-emerald-300">
                    {evoTerm.find(t => t.id === setup.horizon)?.label ??
                      setup.horizon}
                  </span>
                  {' · '}
                  <span className="text-emerald-300/90">green = reduction</span>
                  {' · '}
                  <span className="text-amber-300/90">yellow = remaining</span>
                  {showEvoHedge && evoProfile.length > 0 && (() => {
                    const Tf = setup.forecastMonths;
                    const atTf =
                      evoProfile.find(p => Math.abs(p.t - Tf) < 1e-6) ??
                      evoProfile.reduce((best, p) =>
                        Math.abs(p.t - Tf) < Math.abs(best.t - Tf) ? p : best,
                      );
                    const atEnd = evoProfile[evoProfile.length - 1]!;
                    const pastTf = atEnd.t > Tf + 1e-9;
                    return (
                      <>
                        {' · resid @ Tf '}
                        <span className="font-mono text-amber-300">
                          {fmtVarK(atTf.hedgedVarUsdM)}
                        </span>
                        {pastTf && (
                          <>
                            {' · resid @ '}
                            {Number.isInteger(atEnd.t)
                              ? `${atEnd.t}m`
                              : `${atEnd.t.toFixed(1)}m`}{' '}
                            <span className="font-mono text-amber-300">
                              {fmtVarK(atEnd.hedgedVarUsdM)}
                            </span>
                            <span className="text-slate-600">
                              {' '}
                              (e flat · VN gap stays)
                            </span>
                          </>
                        )}
                      </>
                    );
                  })()}
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
          hint={
            hedged
              ? 'Σ resid VaR = V·|e−H|/E (same as evolution yellow)'
              : 'No hedge yet'
          }
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
          {stripBooked
            ? ' · strip: each forward from M0 (own size + tenure VaR)'
            : effectiveStructure === 'strip'
              ? ' · strip sizing (Th windows)'
              : ''}
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
                <th
                  className="py-2 pr-3 font-medium"
                  title="Cash / Net FX stock at t=0 (not path-end or Target)"
                >
                  Stock
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Equal-VaR bullet on the open book (Decision mid). Does not shrink when you hedge."
                >
                  VaR-neutral N
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Total expected path-end — Decision 100% Target (exposure-signed)"
                >
                  Target N
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="% of |Target|. Strip booked → |strip cover| / |Target| (Decision % ignored)."
                >
                  Hedge %
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Hedge cover (same sign as Target). 100% Target / Target strip → Hedge N = Target N."
                >
                  Hedge N
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="VaR after / VaR @ Δ1 — 0 = fully offset, 1 = unhedged"
                >
                  Δ
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Path e(Th) − H — same |e−H| as VaR evolution / path modal"
                >
                  Residual
                </th>
                <th className="py-2 pr-3 font-medium">VaR @ Δ1</th>
                <th
                  className="py-2 font-medium"
                  title="Resid VaR = V·|e−H|/E(Tf) after bullet (Analytics weighted-avg profile) — same as evolution yellow"
                >
                  VaR after
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map(r => (
                <tr
                  key={r.ccy}
                  className="cursor-pointer border-b border-slate-800/80 hover:bg-violet-500/10"
                  onClick={() => {
                    // Bullet P&L / path default = VaR-neutral (not Target).
                    // Strip may infer from an applied hedge; else start at VN too.
                    const inferred =
                      Math.abs(r.hedgeNotionalLocalM) > 1e-9
                        ? inferHedgePathBasis(
                            r.hedgeNotionalLocalM,
                            r.stockHedgeLocalM,
                            r.targetHedgeLocalM,
                            r.equalVarHedgeLocalM,
                          )
                        : 'varNeutral';
                    setPathBasis(inferred);
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
                    {fmtSignedM(r.stockHedgeLocalM)}
                  </td>
                  <td
                    className="py-2 pr-3 font-mono text-sky-300/90"
                    title={
                      r.hedgeCapped
                        ? 'Equal-VaR on open book — capped by accrued position at Th'
                        : 'Equal-VaR bullet matching open-book VaR @ Δ1 (Decision mid)'
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
                key={`${chartRow.ccy}-${pathBasis}-${effectiveStructure}-${setup.horizon}-${chartSizingSetup.horizon}-${setup.forecastMonths}-${setup.exposureBasis}-${hasRollingStripForCcy(bookedHedges, chartRow.ccy) ? 'strip' : 'open'}`}
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
                  onBookedHedgesChange && hedgeStructure === 'strip'
                    ? bookRollingStrip
                    : undefined
                }
                stripAlreadyBooked={
                  chartRow
                    ? hasRollingStripForCcy(bookedHedges, chartRow.ccy)
                    : false
                }
                hedgeStructure={hedgeStructure}
                onHedgeStructureChange={setHedgeStructure}
              />
            </div>
          </div>,
          document.body,
        )}
      </>
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
