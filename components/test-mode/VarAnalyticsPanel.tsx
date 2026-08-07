'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ExposureHedgePathChart,
  type HedgePathPrepareAction,
  type HedgePathSummaryMetrics,
} from '@/components/test-mode/ExposureHedgePathChart';
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
  residualVarFromMismatchUsdM,
  setPreparedHedgeForCcy,
  stripTicketsForCcy,
  varSetupWithLineUncertainty,
  type HedgeTicket,
  type HedgeVarRow,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import {
  buildRollingHedgeEdges,
  clearRollingStripForCcy,
  hasRollingStripForCcy,
  needsRollingHedges,
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
import { CashCarryAnalyticsView } from '@/components/test-mode/CashCarryAnalyticsView';
import {
  assignImpliedCarryFromSwapPoints,
  buildCashForecastCarryComparison,
} from '@/lib/test-mode/cash-carry-analytics';
import { getActiveMarketRates } from '@/lib/fx-market-rates';
import {
  RiskPerspectiveSelector,
  riskPerspectiveMeta,
  type RiskPerspective,
  type RiskPerspectiveTabStat,
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
  type VarHorizonId,
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
  /** Staged packages for Hedging Decision (Send books them). */
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  onPreparedByCcyChange?: (next: Record<string, PreparedHedgeProfile>) => void;
  /** Shared with Hedging Decision — bullet vs rolling strip. */
  hedgeStructure?: ForecastHedgeStructure;
  onHedgeStructureChange?: (s: ForecastHedgeStructure) => void;
  title?: string;
  /** Live FX book rows — used with forecastProfile for custom month schedules. */
  bookRows?: RowState[];
  /** Flat or custom Revenue/Expenses schedule from FX Risk. */
  forecastProfile?: ForecastProfileState;
  /** Opens the same Forecast profile modal as FX Risk. */
  onOpenForecastProfile?: () => void;
  /** Entity/group scope for overnight cash + swap-points curves (Market data). */
  ratesScopeId?: string;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

/** Tab-rail Resid VaR — $M when ≥ $0.1M, else $K. */
function fmtTabResidVar(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 1e-12) return '—';
  if (Math.abs(usdM) >= 0.1) return `$${usdM.toFixed(2)}M`;
  return `$${(usdM * 1000).toFixed(1)}K`;
}

/** Tab-rail Total carry — signed $K. */
function fmtTabCarryK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 1e-12) return '—';
  const k = usdM * 1000;
  const sign = k >= 0 ? '+' : '−';
  return `${sign}${Math.abs(k).toFixed(1)}K`;
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

/** Live VaR regime chip: Stock · VaR · Total. */
function hedgeRegimeShortLabel(id: HedgePathBasisId): string {
  if (id === 'cash') return 'Stock';
  if (id === 'totalExpected') return 'Total';
  return 'VaR';
}

/** Live VaR structure chip: Bullet · Strip · N-leg. */
function hedgeStructureShortLabel(
  s: ForecastHedgeStructure,
  legCount?: number,
): string {
  if (s !== 'strip') return 'Bullet';
  return typeof legCount === 'number' && legCount > 0
    ? `Strip · ${legCount}`
    : 'Strip';
}

/** Longest VaR horizon chip at or before the forecast (for setup clamp). */
function longestHorizonWithinForecast(forecastMonths: number): VarHorizonId {
  const Tf = forecastMonths > 0 ? forecastMonths : 0;
  let best = VAR_HORIZON_OPTIONS[0]!;
  for (const h of VAR_HORIZON_OPTIONS) {
    if (h.months <= Tf + 1e-9) best = h;
  }
  return best.id;
}

/** Compact ⓘ control — chart reading notes live here, not in footer prose. */
function ChartInfoButton({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative inline-flex" ref={rootRef}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(v => !v)}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold leading-none transition-colors ${
          open
            ? 'border-sky-400 bg-sky-500/20 text-sky-100'
            : 'border-slate-600 text-slate-400 hover:border-slate-400 hover:text-slate-200'
        }`}
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-lg border border-slate-600 bg-slate-900 p-3 text-left text-[10px] leading-relaxed text-slate-300 shadow-xl"
        >
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {label}
          </div>
          {children}
        </div>
      )}
    </div>
  );
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
  preparedByCcy = {},
  onPreparedByCcyChange,
  hedgeStructure: controlledStructure,
  onHedgeStructureChange,
  title: _moduleTitle = 'Analytics — VaR setup',
  bookRows,
  forecastProfile = DEFAULT_FORECAST_PROFILE,
  onOpenForecastProfile,
  ratesScopeId,
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
  const [pathSummaryMetrics, setPathSummaryMetrics] =
    useState<HedgePathSummaryMetrics | null>(null);
  const [pathPrepareAction, setPathPrepareAction] =
    useState<HedgePathPrepareAction | null>(null);
  const [pathBasis, setPathBasis] = useState<HedgePathBasisId>('varNeutral');
  /** Last applied Cash / VN / Total per CCY — Live VaR label (not only inferred). */
  const [regimeByCcy, setRegimeByCcy] = useState<
    Record<string, HedgePathBasisId>
  >({});
  /** Last chosen Bullet / Strip per CCY — Live VaR tag (not the word “path”). */
  const [structureByCcy, setStructureByCcy] = useState<
    Record<string, ForecastHedgeStructure>
  >({});
  /** Manual strip leg count per CCY (null/missing = default ceil(Tf/Th)). */
  const [stripLegCountByCcy, setStripLegCountByCcy] = useState<
    Record<string, number | null>
  >({});
  /** Brief notice when user clicks a post-Tf evolution column. */
  const [postTfNotice, setPostTfNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!postTfNotice) return;
    const t = window.setTimeout(() => setPostTfNotice(null), 4500);
    return () => window.clearTimeout(t);
  }, [postTfNotice]);
  /** Active VaR horizon for hedging setup must be ≤ forecast Tf. */
  useEffect(() => {
    const Tf = setup.forecastMonths;
    if (!(Tf > 0)) return;
    if (horizonMonths(setup.horizon) <= Tf + 1e-9) return;
    onSetupChange({
      ...setup,
      horizon: longestHorizonWithinForecast(Tf),
    });
  }, [setup, onSetupChange]);
  const [localStructure, setLocalStructure] =
    useState<ForecastHedgeStructure>('bullet');
  const hedgeStructure = controlledStructure ?? localStructure;
  const setHedgeStructure = (s: ForecastHedgeStructure) => {
    if (onHedgeStructureChange) onHedgeStructureChange(s);
    else setLocalStructure(s);
  };
  const stripAvailable = needsRollingHedges(setup);
  /** Booked strip ⇒ Live VaR uses strip Th sizing (legs still from M0). */
  const stripBooked = bookedHedges.some(t => Boolean(t.stripId));
  const effectiveStructure: ForecastHedgeStructure =
    stripAvailable && (hedgeStructure === 'strip' || stripBooked)
      ? 'strip'
      : 'bullet';

  const structureTagFor = (
    ccy: string,
    hedgeNotionalLocalM: number,
  ): ForecastHedgeStructure | null => {
    if (hasRollingStripForCcy(bookedHedges, ccy)) return 'strip';
    if (structureByCcy[ccy]) return structureByCcy[ccy]!;
    // Prepared-but-not-yet-booked strip (staged from Cash Carry / Decision) —
    // tag it Strip so Live VaR sizes off the strip regime, not the bullet ratio.
    if (preparedByCcy[ccy]?.structure === 'strip') return 'strip';
    if (Math.abs(hedgeNotionalLocalM) > 1e-9) {
      return stripAvailable && hedgeStructure === 'strip' ? 'strip' : 'bullet';
    }
    return null;
  };
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
        forecastProfile,
      ),
    [
      risk,
      hedgeRatios,
      chartSizingSetup,
      bookedHedges,
      monthlyFlowsByCcy,
      forecastProfile,
    ],
  );

  /**
   * Strip ladder covers matching the path modal (per-window Equal-VaR for VN).
   * Live VaR VaR-neutral N / leg tags use this — not bullet EQ@Tf.
   */
  const stripMetaByCcy = useMemo(() => {
    const out: Record<
      string,
      {
        legs: number;
        vnCoverM: number;
        cashCoverM: number;
        targetCoverM: number;
      }
    > = {};
    if (!stripAvailable) return out;
    const Tf = setup.forecastMonths;
    const Th = horizonMonths(setup.horizon);
    if (!(Tf > 0) || !(Th > 0)) return out;
    const defaultLegs = Math.max(2, Math.ceil(Tf / Th - 1e-12));
    for (const { bar } of risk) {
      if (bar.ccy === 'USD') continue;
      const booked = stripTicketsForCcy(bookedHedges, bar.ccy);
      const preparedStrip = preparedByCcy[bar.ccy];
      const preparedLegCount =
        preparedStrip?.structure === 'strip'
          ? preparedStrip.legs.length
          : 0;
      const legCount =
        booked.length > 0
          ? booked.length
          : Math.max(
              2,
              preparedLegCount || stripLegCountByCcy[bar.ccy] || defaultLegs,
            );
      const flowM =
        Tf > 0 && Math.abs(bar.flowM) > 1e-15 ? bar.flowM : 0;
      const flows =
        monthlyFlowsByCcy[bar.ccy] ??
        Array.from({ length: Math.ceil(Tf) }, () => flowM);
      const opts = {
        legCount,
        ccy: bar.ccy,
        varSetup: setup,
      };
      const vn = buildRollingHedgeEdges(
        bar.stockNetM,
        flows,
        setup,
        'varNeutral',
        opts,
      );
      const cash = buildRollingHedgeEdges(
        bar.stockNetM,
        flows,
        setup,
        'stockStart',
        opts,
      );
      const target = buildRollingHedgeEdges(
        bar.stockNetM,
        flows,
        setup,
        'windowEnd',
        opts,
      );
      out[bar.ccy] = {
        legs: Math.max(vn.length, booked.length, legCount),
        vnCoverM: vn[vn.length - 1]?.hedgeLocalM ?? 0,
        cashCoverM: cash[cash.length - 1]?.hedgeLocalM ?? 0,
        targetCoverM: target[target.length - 1]?.hedgeLocalM ?? 0,
      };
    }
    return out;
  }, [
    stripAvailable,
    setup,
    risk,
    bookedHedges,
    monthlyFlowsByCcy,
    stripLegCountByCcy,
    preparedByCcy,
  ]);

  /**
   * Live VaR rows: honor staged Analytics packages (Cash Carry Prebook / path
   * Book) before Decision % — otherwise carry-shaped cover never appears in
   * Hedge N / Resid VaR until Send. Booked strips still win over prepared.
   */
  const liveRows = useMemo((): HedgeVarRow[] => {
    return summary.rows.map(r => {
      const meta = stripMetaByCcy[r.ccy];
      const prep = preparedByCcy[r.ccy];
      const hasStrip = hasRollingStripForCcy(bookedHedges, r.ccy);
      const struct = structureTagFor(r.ccy, r.hedgeNotionalLocalM);

      const applyCover = (
        cover: number,
        equalVarHedgeLocalM: number,
      ): HedgeVarRow => {
        const pathExposureM = r.residualLocalM + r.hedgeNotionalLocalM;
        const ErefM =
          Math.abs(r.targetHedgeLocalM) > 1e-12
            ? r.targetHedgeLocalM
            : pathExposureM;
        const varAfterUsdM = residualVarFromMismatchUsdM(
          r.varBeforeUsdM,
          pathExposureM,
          cover,
          ErefM,
        );
        const delta =
          r.varBeforeUsdM < 1e-12
            ? 0
            : Math.min(1, Math.max(0, varAfterUsdM / r.varBeforeUsdM));
        const targetAbs = Math.abs(r.targetHedgeLocalM);
        return {
          ...r,
          equalVarHedgeLocalM,
          hedgeNotionalLocalM: cover,
          hedgeRatio:
            targetAbs < 1e-12 ? 0 : Math.min(1, Math.abs(cover) / targetAbs),
          residualLocalM: pathExposureM - cover,
          varAfterUsdM,
          delta,
        };
      };

      // 1) Booked strip — summary already has strip notionals; only refresh VN.
      if (hasStrip) {
        return meta
          ? { ...r, equalVarHedgeLocalM: meta.vnCoverM }
          : r;
      }

      // 2) Staged prepared package (Carry Prebook or FX Risk Book) — use Σ cover.
      if (prep && Math.abs(prep.coverLocalM) >= 1e-12) {
        const equalVarHedgeLocalM =
          struct === 'strip' && meta ? meta.vnCoverM : r.equalVarHedgeLocalM;
        return applyCover(prep.coverLocalM, equalVarHedgeLocalM);
      }

      // 3) Strip regime preview (no prepared) — Cash / VN / Target from ladder.
      if (struct === 'strip' && meta) {
        const equalVarHedgeLocalM = meta.vnCoverM;
        const regime =
          regimeByCcy[r.ccy] ??
          (Math.abs(r.hedgeNotionalLocalM) > 1e-9
            ? inferHedgePathBasis(
                r.hedgeNotionalLocalM,
                r.stockHedgeLocalM,
                r.targetHedgeLocalM,
                equalVarHedgeLocalM,
              )
            : null);
        if (regime == null) {
          return { ...r, equalVarHedgeLocalM };
        }
        const cover =
          regime === 'cash'
            ? meta.cashCoverM
            : regime === 'totalExpected'
              ? meta.targetCoverM
              : meta.vnCoverM;
        return applyCover(cover, equalVarHedgeLocalM);
      }

      return r;
    });
  }, [
    summary.rows,
    stripMetaByCcy,
    bookedHedges,
    regimeByCcy,
    structureByCcy,
    hedgeStructure,
    stripAvailable,
    preparedByCcy,
  ]);

  /**
   * Profile / sizing change: re-snap Cash·VN·Target % and rebuild booked
   * strips (all M0 legs) so Live VaR does not need the path modal.
   */
  const lineUncertaintySig = JSON.stringify(
    forecastProfile.uncertainty1mByCcy ?? {},
  );
  const hedgeSetupSig = [
    setup.exposureBasis,
    setup.averagingConvention,
    setup.forecastMonths,
    setup.horizon,
    setup.confidencePct,
    setup.forecastUncertainty1m,
    lineUncertaintySig,
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
    ? liveRows.find(r => r.ccy === chartCcy) ??
      summary.rows.find(r => r.ccy === chartCcy)
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
    setRegimeByCcy(prev => ({ ...prev, [chartRow.ccy]: basis }));
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
    const nextStructure = structure ?? hedgeStructure;
    if (structure && structure !== hedgeStructure) {
      setHedgeStructure(structure);
    }
    setStructureByCcy(prev => ({ ...prev, [chartRow.ccy]: nextStructure }));
    // Never auto-book strips from Analytics chips — only Decision % / regime.
    // Keep Cash Carry / FX Risk prepared packages: regime only updates the
    // Decision % slider. Prebook/Book is replaced only by an explicit Book.
    if (
      onBookedHedgesChange &&
      hasRollingStripForCcy(bookedHedges, chartRow.ccy)
    ) {
      onBookedHedgesChange(clearRollingStripForCcy(bookedHedges, chartRow.ccy));
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
    let target: number;
    if (nextStructure === 'strip' && needsRollingHedges(setup)) {
      const Th = horizonMonths(setup.horizon);
      const Tf = setup.forecastMonths;
      const defaultLegs =
        Tf > 0 && Th > 0 ? Math.max(2, Math.ceil(Tf / Th - 1e-12)) : 2;
      const legCount = Math.max(
        2,
        stripLegCountByCcy[chartRow.ccy] ?? defaultLegs,
      );
      const edges = buildRollingHedgeEdges(
        startM,
        flows,
        setup,
        sizingForHedgePathBasis(basis),
        { legCount, ccy: chartRow.ccy, varSetup: setup },
      );
      target = edges[edges.length - 1]?.hedgeLocalM ?? 0;
    } else {
      target = hedgeBasisNotionalLocalM(basis, startM, endM, bulletEq);
    }
    const target100 = Math.abs(chartRow.targetHedgeLocalM);
    const ratio =
      target100 < 1e-12
        ? 0
        : Math.min(1, hedgeRatioForNumber(target, chartRow.targetHedgeLocalM));
    onHedgeRatiosChange({ ...hedgeRatios, [chartRow.ccy]: ratio });
  };

  const closePathChart = () => setChartCcy(null);

  /**
   * Path-chart Book → stage package for Hedging Decision.
   * Live book only updates when user clicks Send under that CCY.
   */
  const bookHedgeProfile = (args: {
    structure: ForecastHedgeStructure;
    basis: HedgePathBasisId;
    edges: RollingHedgeEdge[];
    cashSettleByEdgeIndex?: Record<number, number>;
    bulletSettleMonths?: number;
    cashDeliveryAt?: 'periodEnd' | 'periodStart' | 'matchExposure';
    coverPct?: number;
  }) => {
    if (!chartRow || !chartBar || !onPreparedByCcyChange) return;
    const {
      structure,
      basis,
      edges,
      cashSettleByEdgeIndex,
      bulletSettleMonths: chartBulletSettle,
      cashDeliveryAt,
      coverPct: coverPctArg,
    } = args;
    const coverPct = Math.min(1, Math.max(0, coverPctArg ?? 1));
    setPathBasis(basis);
    setHedgeStructure(structure);
    setStructureByCcy(prev => ({ ...prev, [chartRow.ccy]: structure }));
    setRegimeByCcy(prev => ({ ...prev, [chartRow.ccy]: basis }));

    const ticketBasis =
      basis === 'cash'
        ? 'stock'
        : basis === 'totalExpected'
          ? 'totalBuildup'
          : setup.exposureBasis === 'stock'
            ? 'simpleAvg'
            : setup.exposureBasis;
    const defaultTf = setup.forecastMonths || horizonMonths(setup.horizon);

    if (structure === 'strip' && edges.length > 1) {
      setStripLegCountByCcy(prev => ({
        ...prev,
        [chartRow.ccy]: edges.length,
      }));
      const coverLocalM = edges[edges.length - 1]?.hedgeLocalM ?? 0;
      const profile = assignImpliedCarryFromSwapPoints(
        {
          structure: 'strip',
          basis,
          ticketBasis,
          legs: edges.map(e => ({
            index: e.index,
            startMonth: e.startMonth,
            endMonth: e.endMonth,
            settleMonths: cashSettleByEdgeIndex?.[e.index] ?? e.endMonth,
            hedgeLocalM: e.hedgeLocalM,
            label: e.label,
            stockStartM: e.stockStartM,
            endExposureM: e.endExposureM,
          })),
          coverLocalM,
          hedgeRatio: coverPct,
          cashDeliveryAt,
        },
        {
          marketRates: getActiveMarketRates(ratesScopeId),
          bulletSettleMonths: defaultTf,
        },
      );
      onPreparedByCcyChange(
        setPreparedHedgeForCcy(preparedByCcy, chartRow.ccy, {
          ...profile,
          preparedFor: 'var',
        }),
      );
      closePathChart();
      return;
    }

    // Bullet: stage one forward; do not book live.
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
    const bulletEq = equalVarLinearHedgeNotionalLocalM(
      chartBar.stockNetM,
      flowM,
      chartRow.ccy,
      varSetupForPathHedgeRegime(setup, 'bullet'),
      undefined,
      flowsForCcy ?? flows,
    ).amountLocalM;
    const target =
      hedgeBasisNotionalLocalM(basis, startM, endM, bulletEq) * coverPct;
    const target100 = Math.abs(chartRow.targetHedgeLocalM);
    const ratio =
      target100 < 1e-12
        ? 0
        : Math.min(1, hedgeRatioForNumber(target, chartRow.targetHedgeLocalM));
    const bulletSettle = chartBulletSettle ?? defaultTf;
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'bullet',
        basis,
        ticketBasis,
        legs: [],
        coverLocalM: target,
        hedgeRatio: coverPctArg != null ? coverPct : ratio,
        cashDeliveryAt,
        settleMonths: bulletSettle,
      },
      {
        marketRates: getActiveMarketRates(ratesScopeId),
        bulletSettleMonths: bulletSettle,
      },
    );
    onPreparedByCcyChange(
      setPreparedHedgeForCcy(preparedByCcy, chartRow.ccy, {
        ...profile,
        preparedFor: 'var',
      }),
    );
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
          { ccy: evoBar.ccy, varSetup: setup },
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
    const evoSetup = varSetupWithLineUncertainty(
      setup,
      evoBar.ccy,
      forecastProfile,
    );
    return buildStripHedgedVarProfile(
      evoBar.stockNetM,
      flowM,
      evoBar.ccy,
      evoSetup,
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
  }, [evoBar, evoHedgeLegs, setup, monthlyFlowsByCcy, forecastProfile]);

  /** Horizon pickers: open VaR + resid VaR (samples past Tf when forecast is short). */
  const evoTerm = useMemo(() => {
    if (!evoBar) return [];
    const flowM =
      setup.forecastMonths > 0 && Math.abs(evoBar.flowM) > 1e-15
        ? evoBar.flowM
        : 0;
    const flows = monthlyFlowsByCcy[evoBar.ccy];
    const evoSetup = varSetupWithLineUncertainty(
      setup,
      evoBar.ccy,
      forecastProfile,
    );
    const open = growingVarByHorizonUsdM(
      evoBar.stockNetM,
      flowM,
      evoBar.ccy,
      evoSetup,
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
  }, [evoBar, setup, monthlyFlowsByCcy, evoProfile, forecastProfile]);

  const maxTermVar = Math.max(
    1e-9,
    ...evoTerm.map(t => Math.max(t.varUsdM, t.residualVarUsdM ?? 0)),
  );
  const showEvoHedge = evoProfile.length > 0;

  const patch = (partial: Partial<VarSetup>) => onSetupChange({ ...setup, ...partial });

  const marketRates = useMemo(
    () => getActiveMarketRates(ratesScopeId),
    [ratesScopeId],
  );

  /** Portfolio Total carry @ Tf — Cash Carry tab figure (design 1c). */
  const cashCarryTotalUsdM = useMemo(() => {
    const ccys = new Set<string>();
    for (const r of risk) ccys.add(r.bar.ccy);
    for (const row of bookRows ?? []) {
      if (row.ccy) ccys.add(row.ccy);
    }
    let sum = 0;
    for (const ccy of ccys) {
      const cmp = buildCashForecastCarryComparison({
        ccy,
        bookRows,
        forecastProfile,
        forecastMonths: setup.forecastMonths,
        marketRates,
        bookedHedges,
        preparedByCcy,
        setup,
      });
      if (cmp) sum += cmp.categories.hedgedIncomeUsdM;
    }
    return sum;
  }, [
    risk,
    bookRows,
    forecastProfile,
    setup,
    marketRates,
    bookedHedges,
    preparedByCcy,
  ]);

  const perspectiveTabStats = useMemo((): Partial<
    Record<RiskPerspective, RiskPerspectiveTabStat>
  > => {
    return {
      fxRisk: {
        value: fmtTabResidVar(summary.totalVarAfterUsdM),
        label: 'Resid VaR',
      },
      cashCarry: {
        value: fmtTabCarryK(cashCarryTotalUsdM),
        label: 'Total carry',
      },
    };
  }, [summary.totalVarAfterUsdM, cashCarryTotalUsdM]);

  const growthMoM = forecastProfile.growthRateMoM ?? 0;
  const analyticsMetaLine = useMemo(() => {
    if (perspective === 'cashCarry') {
      return [
        'Cash carry · all currencies',
        customSchedule ? 'custom schedule' : null,
        Math.abs(growthMoM) > 1e-12
          ? `MoM ${(growthMoM * 100).toFixed(1)}%`
          : null,
        'click a currency row to set the carry chart',
      ]
        .filter(Boolean)
        .join(' · ');
    }
    if (perspective === 'fxRisk') {
      return [
        'Group VaR · all currencies',
        customSchedule ? 'custom schedule' : null,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    return undefined;
  }, [perspective, customSchedule, growthMoM]);

  return (
    <div className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200">
      <RiskPerspectiveSelector
        value={perspective}
        onChange={setPerspective}
        moduleLabel="Analytics"
        tabStats={perspectiveTabStats}
        tfMonths={setup.forecastMonths}
        metaLine={analyticsMetaLine}
        onOpenSettings={
          onOpenForecastProfile
            ? () => onOpenForecastProfile()
            : undefined
        }
        settingsDisabled={
          !onOpenForecastProfile || setup.forecastMonths === 0
        }
        settingsTitle={
          setup.forecastMonths === 0
            ? 'No forecast period — pick 1 month+ to edit cash inflow / outflow profile'
            : 'Forecast profile — flat / MoM / custom cash inflows & outflows'
        }
      />

      {perspective === 'cashCarry' ? (
        <CashCarryAnalyticsView
          risk={risk}
          setup={setup}
          bookedHedges={bookedHedges}
          preparedByCcy={preparedByCcy}
          onPreparedByCcyChange={onPreparedByCcyChange}
          bookRows={bookRows}
          forecastProfile={forecastProfile}
          ratesScopeId={ratesScopeId}
          onHorizonChange={horizon =>
            onSetupChange({ ...setup, horizon })
          }
        />
      ) : perspective !== 'fxRisk' ? (
        <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-10 text-center text-xs text-slate-500">
          {riskPerspectiveMeta(perspective).label} view is coming soon on Analytics.
        </div>
      ) : (
      <>
      {/* ── Input exposure metrics ── */}
      <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
              Input exposure metrics
            </div>
            <p className="mt-0.5 text-[10px] text-slate-500">
              Forecast period (Tf) and optional 1m forecast uncertainty — shape Exp and VaR
              curvature vs tenure.
              {customSchedule ? ' Profile: custom.' : ''}
            </p>
          </div>
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
              : `σ_E = |F|×${(u1m * 100).toFixed(2).replace(/\.?0+$/, '')}%×√g · g=min(Th,Tf=${setup.forecastMonths}m) — global default. Per-CCY line σ in Forecast profile (click Revenue / line name) overrides when set.`}
          </p>
        </div>
      </section>

      {/* ── VaR setup: profile chips + gear modal (avg + σ) ── */}
      <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
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
            <div className="flex items-center gap-2">
              <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
                VaR evolution · select horizon
              </div>
              <ChartInfoButton label="How to read VaR evolution">
                <ul className="list-disc space-y-1.5 pl-3.5">
                  <li>
                    Click a column ≤ Tf to set the active VaR horizon for hedging
                    / Analytics setup.
                  </li>
                  <li>
                    Numbers above each bar: open VaR (slate) and residual VaR after
                    hedge (amber).
                  </li>
                  <li>
                    Stacked bar: green = VaR reduction from the hedge; yellow =
                    remaining residual VaR.
                  </li>
                  <li>
                    Resid VaR = V(t)·|e−H|/|E(Tf)| — same formula as the path
                    modal.
                  </li>
                  <li>
                    Post-Tf columns (beyond forecast) are display-only — they do
                    not change the hedging profile horizon. Only periods ≤ Tf
                    apply.
                  </li>
                  {!showEvoHedge && (
                    <li>
                      No hedge on the book yet — bars show open VaR only. Apply a
                      regime in Decision or the path modal to see reduction.
                    </li>
                  )}
                </ul>
              </ChartInfoButton>
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
            {evoCcy} · {profile?.label ?? setup.exposureBasis}
            {' · '}
            Tf ={' '}
            {setup.forecastMonths === 0 ? '0 (stock)' : `${setup.forecastMonths}m`}
            {customSchedule ? ' · custom schedule' : ''}
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
                          beyondForecast
                            ? `${t.label}: beyond forecast — display only. Hedging setup uses horizons ≤ Tf (${setup.forecastMonths}m).`
                            : t.residualVarUsdM != null
                              ? `${evoCcy} ${t.label}: open ${fmtVarK(t.varUsdM)} · resid ${fmtVarK(t.residualVarUsdM)} · |e−H| ${t.absResidualM != null ? fmtSignedM(t.absResidualM) : '—'}`
                              : `${evoCcy} ${t.label}: ${fmtVarK(t.varUsdM)}`
                        }
                        onClick={() => {
                          if (beyondForecast) {
                            setPostTfNotice(
                              `${t.label} is beyond forecast (Tf = ${setup.forecastMonths}m) — not applied to hedging setup. Use a horizon ≤ Tf.`,
                            );
                            return;
                          }
                          setPostTfNotice(null);
                          patch({ horizon: t.id });
                        }}
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
                            view only
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {postTfNotice && (
                  <p
                    role="status"
                    className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-center text-[10px] text-amber-100"
                  >
                    {postTfNotice}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
                  <span>
                    Active setup:{' '}
                    <span className="font-medium text-emerald-300">
                      {evoTerm.find(t => t.id === setup.horizon)?.label ??
                        setup.horizon}
                    </span>
                    <span className="text-slate-600"> (≤ Tf)</span>
                  </span>
                  {showEvoHedge && (
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400/80" />
                        reduction
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-sm bg-amber-300/90" />
                        remaining
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-sm bg-slate-600/80" />
                        post-Tf (view only)
                      </span>
                    </span>
                  )}
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
                      <span className="inline-flex items-center gap-1.5 font-mono text-amber-300/90">
                        <span title="Residual VaR at forecast end">
                          resid@Tf {fmtVarK(atTf.hedgedVarUsdM)}
                        </span>
                        {pastTf && (
                          <span
                            title="Residual VaR at chart end — e flat after Tf; VN gap can keep resid growing"
                          >
                            · resid@
                            {Number.isInteger(atEnd.t)
                              ? `${atEnd.t}m`
                              : `${atEnd.t.toFixed(1)}m`}{' '}
                            {fmtVarK(atEnd.hedgedVarUsdM)}
                          </span>
                        )}
                      </span>
                    );
                  })()}
                </div>
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
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          Live VaR · {setupLabel(setup)}
          {hedged ? ' · after Hedging Decision' : ' · Δ = 1 (unhedged)'}
          {stripBooked
            ? ' · strip: each forward from M0 (own size + tenure VaR)'
            : effectiveStructure === 'strip'
              ? ' · strip sizing (Th windows)'
              : ''}
          {customSchedule ? ' · custom schedule' : ''}
          <span className="ml-2 font-normal normal-case tracking-normal text-slate-600">
            — click a currency row to select · open bullet/strip profile
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
                  title="VaR-neutral at Tf: growth = path CoG e(∫t e²/∫e²); simple/TW = Ē. Strip: per-window same rule."
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
                  title="Trade-signed hedge (offsets exposure): opposite of Stock / Target / path cover. Long book → negative Hedge N."
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
                  title="Path e(Tf) − H — residual at forecast end (100% Target → 0). Same |e−H| as path modal at Tf."
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
              {liveRows.map(r => {
                const selected = chartCcy === r.ccy;
                const prep = preparedByCcy[r.ccy];
                const struct = structureTagFor(r.ccy, r.hedgeNotionalLocalM);
                const legs = stripMetaByCcy[r.ccy]?.legs;
                const isHedged =
                  Math.abs(r.hedgeNotionalLocalM) > 1e-9 ||
                  (prep != null && Math.abs(prep.coverLocalM) >= 1e-12) ||
                  hasRollingStripForCcy(bookedHedges, r.ccy);
                return (
                <tr
                  key={r.ccy}
                  role="button"
                  tabIndex={0}
                  className={`cursor-pointer border-b border-slate-800/80 hover:bg-violet-500/10 ${
                    selected ? 'bg-violet-500/10' : ''
                  }`}
                  onClick={() => {
                    // Prefer last applied chip; else infer from Live VaR Hedge N.
                    const inferred =
                      regimeByCcy[r.ccy] ??
                      (Math.abs(r.hedgeNotionalLocalM) > 1e-9
                        ? inferHedgePathBasis(
                            r.hedgeNotionalLocalM,
                            r.stockHedgeLocalM,
                            r.targetHedgeLocalM,
                            r.equalVarHedgeLocalM,
                          )
                        : prep?.basis === 'cash'
                          ? 'cash'
                          : prep?.basis === 'totalExpected'
                            ? 'totalExpected'
                            : 'varNeutral');
                    const nextStruct =
                      struct ??
                      (prep?.structure === 'strip' ? 'strip' : 'bullet');
                    setPathBasis(inferred);
                    setHedgeStructure(nextStruct);
                    setChartCcy(r.ccy);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      (e.currentTarget as HTMLTableRowElement).click();
                    }
                  }}
                  title={`Select ${r.ccy} · open hedge profile (bullet / strip · regime)`}
                >
                  <td className="py-2 pr-3 font-semibold text-violet-200">
                    <span className="inline-flex flex-col gap-0.5">
                      <span className="inline-flex items-baseline gap-1.5">
                        {r.ccy}
                        {struct ? (
                          <span
                            className="text-[9px] font-semibold uppercase tracking-wide text-violet-300/90"
                            title="Hedge structure from Cash Carry Prebook / FX Risk Book / Decision"
                          >
                            {hedgeStructureShortLabel(struct, legs)}
                          </span>
                        ) : null}
                        {prep?.preparedFor === 'carry' ? (
                          <span
                            className="text-[9px] font-semibold uppercase tracking-wide text-amber-300/90"
                            title="Staged from Cash Carry — sized for carry / Enhancement"
                          >
                            Carry
                          </span>
                        ) : null}
                      </span>
                      {isHedged ? (
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wide text-emerald-400/90"
                          title={
                            prep
                              ? `Prepared ${prep.preparedFor === 'carry' ? 'Carry' : 'VaR'} package · Σ ${fmtSignedM(prep.coverLocalM)}`
                              : 'Hedging regime: Stock (Cash) · VaR-neutral · Total (Target)'
                          }
                        >
                          {prep && !hasRollingStripForCcy(bookedHedges, r.ccy)
                            ? 'Hedged'
                            : hedgeRegimeShortLabel(
                                regimeByCcy[r.ccy] ??
                                  inferHedgePathBasis(
                                    r.hedgeNotionalLocalM,
                                    r.stockHedgeLocalM,
                                    r.targetHedgeLocalM,
                                    r.equalVarHedgeLocalM,
                                  ),
                              )}
                        </span>
                      ) : (
                        <span className="text-[9px] font-normal text-slate-600">
                          —
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-300">
                    {fmtSignedM(r.stockHedgeLocalM)}
                  </td>
                  <td
                    className="py-2 pr-3 font-mono text-sky-300/90"
                    title={
                      struct === 'strip'
                        ? 'Strip VaR-neutral = last-window Equal-VaR cover (same as path modal VN chip)'
                        : r.hedgeCapped
                          ? 'Equal-VaR on open book — capped by accrued position at Th'
                          : 'Equal-VaR bullet matching open-book VaR @ Δ1 (Decision mid)'
                    }
                  >
                    {fmtSignedM(r.equalVarHedgeLocalM)}
                    {r.hedgeCapped && struct !== 'strip' ? (
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
                    {fmtSignedM(-r.hedgeNotionalLocalM)}
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
                );
              })}
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
            <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
              <div className="sticky top-0 z-30 shrink-0 border-b border-slate-800 bg-slate-900 px-4 pb-3 pt-4 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.75)]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4
                      id="exposure-path-title"
                      className="text-sm font-semibold text-white"
                    >
                      {chartCcy} — hedge profile
                    </h4>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      Structure:{' '}
                      <span className="font-semibold text-violet-200">
                        {effectiveStructure === 'strip' ? 'Strip' : 'Bullet'}
                      </span>
                      {' · '}
                      Regime:{' '}
                      <span className="font-semibold text-violet-200">
                        {pathBasis === 'cash'
                          ? 'Cash (stock)'
                          : pathBasis === 'varNeutral'
                            ? 'VaR-neutral'
                            : 'Target (Total)'}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    {pathPrepareAction && (
                      <button
                        type="button"
                        disabled={pathPrepareAction.disabled}
                        onClick={() => pathPrepareAction.run()}
                        title={pathPrepareAction.title}
                        className="rounded border border-violet-500/50 bg-violet-500/20 px-2.5 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {pathPrepareAction.label}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={closePathChart}
                      className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800"
                    >
                      Close
                    </button>
                  </div>
                </div>
                {pathSummaryMetrics && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {(
                      [
                        [
                          'Cover',
                          pathSummaryMetrics.coverValue,
                          pathSummaryMetrics.coverPct,
                          pathSummaryMetrics.coverSub,
                          'text-emerald-200',
                        ],
                        [
                          'Legs',
                          pathSummaryMetrics.legsValue,
                          null,
                          pathSummaryMetrics.legsSub,
                          'text-sky-200',
                        ],
                        [
                          'Resid',
                          pathSummaryMetrics.residVarValue,
                          pathSummaryMetrics.residVarPct,
                          pathSummaryMetrics.residVarSub,
                          'text-rose-300',
                        ],
                        [
                          'BE',
                          pathSummaryMetrics.breakevenValue,
                          null,
                          pathSummaryMetrics.breakevenSub,
                          'text-amber-200/90',
                        ],
                      ] as const
                    ).map(([label, value, pct, title, tone]) => (
                      <span
                        key={label}
                        title={title ?? undefined}
                        className="inline-flex items-center gap-1 rounded border border-slate-700/80 bg-slate-950/90 px-1.5 py-0.5 text-[10px] text-slate-500"
                      >
                        {label}{' '}
                        <span
                          className={`font-mono font-semibold tabular-nums ${tone}`}
                        >
                          {value}
                        </span>
                        {pct != null && (
                          <span className="font-mono font-semibold tabular-nums text-slate-400">
                            {pct}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
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
                setup={varSetupWithLineUncertainty(
                  setup,
                  chartRow.ccy,
                  forecastProfile,
                )}
                appliedHedgeLocalM={chartRow.hedgeNotionalLocalM}
                hedgeRatio={chartRow.hedgeRatio}
                equalVarHedgeLocalM={chartRow.equalVarHedgeLocalM}
                endExposureM={chartRow.openExposureLocalM}
                selectedBasis={pathBasis}
                onSelectedBasisChange={setPathBasis}
                onApplyBasis={applyPathBasis}
                onBookHedgeProfile={
                  onPreparedByCcyChange ? bookHedgeProfile : undefined
                }
                summaryMetricsPlacement="none"
                onSummaryMetricsChange={setPathSummaryMetrics}
                prepareCtaPlacement="external"
                onPrepareActionChange={setPathPrepareAction}
                stripAlreadyBooked={
                  chartRow
                    ? hasRollingStripForCcy(bookedHedges, chartRow.ccy)
                    : false
                }
                hedgeStructure={hedgeStructure}
                onHedgeStructureChange={s => {
                  setHedgeStructure(s);
                  if (chartRow) {
                    setStructureByCcy(prev => ({
                      ...prev,
                      [chartRow.ccy]: s,
                    }));
                  }
                }}
                stripLegCount={
                  chartRow
                    ? (stripLegCountByCcy[chartRow.ccy] ?? null)
                    : null
                }
                onStripLegCountChange={n => {
                  if (!chartRow) return;
                  setStripLegCountByCcy(prev => ({
                    ...prev,
                    [chartRow.ccy]: n,
                  }));
                }}
              />
              </div>
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
