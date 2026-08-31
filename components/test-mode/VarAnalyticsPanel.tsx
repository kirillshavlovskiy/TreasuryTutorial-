'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Activity, BadgeCheck, Coins, Shield, Sparkles, Target } from 'lucide-react';
import {
  AnalyticsWizardShell,
  useAnalyticsWizard,
  type AnalyticsWizardStep,
} from '@/components/test-mode/AnalyticsWizardShell';
import { HedgeApprovalStep } from '@/components/test-mode/HedgeApprovalStep';
import {
  ExposureHedgePathChart,
  type HedgePathPrepareAction,
  type HedgePathSummaryMetrics,
} from '@/components/test-mode/ExposureHedgePathChart';
import {
  chipsFromPathSummary,
  HedgeStagingHeader,
  pathChartDraftDirty,
} from '@/components/test-mode/HedgeStagingHeader';
import {
  DEFAULT_FORECAST_PROFILE,
  clearLineUncertainties,
  monthlyFxFlowSeriesLocalM,
  type ForecastProfileState,
  type LiquidityCycleProjection,
} from '@/lib/forecast-profile';
import {
  type BufferChipKey,
  type LayerId,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import {
  analyticsForwardsFromOverlays,
  retainedFundingPlanByCcy,
  type SwapForwardOverlay,
} from '@/lib/fx-hedge';
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
  clearPreparedHedgeForCcy,
  stageAtlasMixPrepared,
  stagedFxHedgeCarryByCcyUsdM,
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
import { CfarAnalysisView } from '@/components/test-mode/CfarAnalysisView';
import { ForecastParametersForm } from '@/components/test-mode/ForecastParametersForm';
import { LiquidityAnalyticsView } from '@/components/test-mode/LiquidityAnalyticsView';
import type { OptimizerOverlayDesk } from '@/lib/test-mode/solution-pick';
import {
  assignImpliedCarryFromSwapPoints,
  cashForecastCarrySplitByCcyUsdM,
  sumCashCarryTotalUsdM,
} from '@/lib/test-mode/cash-carry-analytics';
import type { FxAtlasJobRequest } from '@/lib/test-mode/fx-atlas-job';
import { useFxAtlas } from '@/components/test-mode/use-fx-atlas';
import { atlasRiskCorrFor } from '@/lib/fx-market-risk';
import {
  applyAtlasMixToHedgeRows,
  atlasMixLockedCarryUsdM,
  formatHedgePct,
  fxAtlasMarginalEffects,
  fxAtlasPointAtCcyWeights,
  fxAtlasTenorFrontier,
  fxCarryVarFrontier,
  fxLiveMixWeights,
  fxMixSignedContribs,
  type FxCarryVarPoint,
} from '@/lib/test-mode/fx-var-frontier';
import { diversifiedUsdRisk } from '@/lib/test-mode/portfolio-liquidity-frontier';
import { ChartViewFrame } from '@/components/ChartViewToggle';
import { FxCarryVarFrontierChart } from '@/components/test-mode/FxCarryVarFrontierChart';
import { FxAtlasMarginalEffectsChart } from '@/components/test-mode/FxAtlasMarginalEffectsChart';
import {
  ContributionBar,
  MixStrip,
  ParetoScenarioCard,
  ccyBarTone,
  stackFromRisk,
  VarCurrencyStackChart,
  type FrontierSolutionCard,
} from '@/components/test-mode/LiquidityWizardPanels';
import {
  fxHedgeNetCfarByCcyUsdM,
  sumNetCfarUsdM,
} from '@/lib/test-mode/cfar-net-by-ccy';
import {
  evaluateLiquidityStrategies,
  liquidityStrategyInputFrom,
  strategyForRegime,
} from '@/lib/test-mode/liquidity-strategies';
import {
  DEFAULT_LIQUIDITY_TIMING,
  resolveLiquidityTiming,
} from '@/lib/liquidity-ladder';
import {
  resolveMarketRatesBook,
  resolveMarketRatesForCcy,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
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
  volForSource,
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
  onBookedHedgesChange?: (
    next: HedgeTicket[] | ((prev: HedgeTicket[]) => HedgeTicket[]),
  ) => void;
  /** Staged packages for Hedging Decision (Send books them). */
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  onPreparedByCcyChange?: (
    next:
      | Record<string, PreparedHedgeProfile>
      | ((
          prev: Record<string, PreparedHedgeProfile>,
        ) => Record<string, PreparedHedgeProfile>),
  ) => void;
  /** Shared with Hedging Decision — bullet vs rolling strip. */
  hedgeStructure?: ForecastHedgeStructure;
  onHedgeStructureChange?: (s: ForecastHedgeStructure) => void;
  title?: string;
  /** Live FX book rows — used with forecastProfile for custom month schedules. */
  bookRows?: RowState[];
  /** Patch Revenue / Expenses / Invoice on the live book from Forecast step. */
  onRowFieldChange?: (
    ccy: string,
    field: 'collections' | 'payout' | 'fcastFX',
    value: number,
  ) => void;
  /** Flat or custom Revenue/Expenses schedule from FX Risk. */
  forecastProfile?: ForecastProfileState;
  /** Sync Forecast-profile line σ when Analytics / CFaR u₁ₘ chips change. */
  onForecastProfileChange?: (profile: ForecastProfileState) => void;
  /** Opens the same Forecast profile modal as FX Risk. */
  onOpenForecastProfile?: () => void;
  /** Closes the Forecast profile modal (leave wizard step 1). */
  onCloseForecastProfile?: () => void;
  /** Entity/group scope for overnight cash + swap-points curves (Market data). */
  ratesScopeId?: string;
  /** DB-persisted market data per currency (Market data tab uploads). */
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  onMarketRatesByCcyChange?: (
    next: Record<string, FxMarketRatesBundle>,
  ) => void;
  /** Desk layers — Liquidity Analytics sizes counterfactuals on the same stack. */
  activeLayers?: Set<LayerId>;
  /** Toggle the same buffer-layer stack from Liquidity Analytics. */
  onLayerToggle?: (id: LayerId) => void;
  /** Same desk layer-settings dialog the Liquidity tab gears open. */
  layerPanel?: BufferChipKey | null;
  onLayerPanelChange?: (id: BufferChipKey | null) => void;
  /** Desk-computed funded plan per CCY. Live strategy uses this strip as-is. */
  livePlanByCcy?: Readonly<Record<string, readonly LiquidityCycleProjection[]>>;
  /** FX-hedge Net CFaR per CCY — sizes the CFaR cover layer on Liquidity Analytics. */
  cfarNetByCcyUsd?: Record<string, number>;
  /** Desk Swap+Fwd replacement overlays (Analytics / CFaR / Cash Carry). */
  swapForwardOverlayByCcy?: Record<string, SwapForwardOverlay>;
  /** Desk globals — Liquidity Analytics prices the swap book on r_USD / σ_P. */
  deskShared?: SharedGlobals;
  /** Desk Hedge carry per CCY ($M p.a.) — reused rather than recomputed. */
  deskHedgeCarryByCcyUsdM?: Record<string, number>;
  /** Desk Cash Carry per CCY ($M) — staged dual-book cash when a hedge is on. */
  deskCashCarryByCcyUsdM?: Record<string, number>;
  /** Desk FX HEDGE CIP per CCY ($M) — already Δ-scaled. */
  deskCipByCcyUsdM?: Record<string, number>;
  /** Policy VAR overlay cap — Portfolio level on Liquidity Analytics. */
  policyVAR?: number;
  onPolicyVARChange?: (usdM: number) => void;
  portfolioCarryK?: number;
  onPortfolioCarryKChange?: (k: number | undefined) => void;
  residualByCcy?: Record<string, number>;
  onResidualByCcyChange?: (next: Record<string, number>) => void;
  portfolioScenarioId?: string | null;
  onPortfolioScenarioIdChange?: (id: string | null) => void;
  usdCash?: number;
  onUsdCashChange?: (usdM: number) => void;
  usdPayout?: number;
  onStrategyCfarByCcyChange?: (byCcy: Record<string, number>) => void;
  onOptimizerOverlayByCcyChange?: (next: Record<string, OptimizerOverlayDesk>) => void;
}

function fmtVarK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 1e-12) return '$0K';
  if (Math.abs(usdM) >= 0.1) return `$${usdM.toFixed(2)}M`;
  return `$${(usdM * 1000).toFixed(0)}K`;
}

/** Stable default — a `= {}` literal would be a fresh object every render, and
 * the CFaR panel keys its Monte Carlo memos on this map. */
const EMPTY_MARKET_RATES_BY_CCY: Record<string, FxMarketRatesBundle> = {};

const FX_RISK_WIZARD_STEPS: readonly AnalyticsWizardStep[] = [
  { id: 'forecast', n: 1, label: 'Forecast', Icon: Target },
  { id: 'setup', n: 2, label: 'VaR setup', Icon: Shield },
  { id: 'horizon', n: 3, label: 'Horizon', Icon: Activity },
  { id: 'optimize', n: 4, label: 'Optimize', Icon: Sparkles },
  { id: 'book', n: 5, label: 'Book', Icon: Coins },
  { id: 'approve', n: 6, label: 'Approve', Icon: BadgeCheck },
];

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

function atlasScenarioLabel(
  point: FxCarryVarPoint | null | undefined,
  sweetId?: string | null,
  hedgedId?: string | null,
  openId?: string | null,
): string {
  if (!point) return '—';
  if (openId && point.id === openId) return 'Leave open';
  if (sweetId && point.id === sweetId) return 'Recommended';
  if (hedgedId && point.id === hedgedId) return 'Fully hedge';
  return 'Custom';
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
    nonLpCash: 0,
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
  onRowFieldChange,
  forecastProfile = DEFAULT_FORECAST_PROFILE,
  onForecastProfileChange,
  onOpenForecastProfile,
  onCloseForecastProfile,
  ratesScopeId,
  marketRatesByCcy = EMPTY_MARKET_RATES_BY_CCY,
  onMarketRatesByCcyChange,
  activeLayers,
  onLayerToggle,
  layerPanel,
  onLayerPanelChange,
  livePlanByCcy,
  cfarNetByCcyUsd,
  swapForwardOverlayByCcy,
  deskShared,
  deskHedgeCarryByCcyUsdM,
  deskCashCarryByCcyUsdM,
  deskCipByCcyUsdM,
  policyVAR,
  onPolicyVARChange,
  portfolioCarryK,
  onPortfolioCarryKChange,
  residualByCcy,
  onResidualByCcyChange,
  portfolioScenarioId,
  onPortfolioScenarioIdChange,
  usdCash,
  onUsdCashChange,
  usdPayout,
  onStrategyCfarByCcyChange,
  onOptimizerOverlayByCcyChange,
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
  const fxWizard = useAnalyticsWizard(FX_RISK_WIZARD_STEPS.length);
  useEffect(() => {
    if (perspective !== 'fxRisk' || fxWizard.step !== 1) {
      onCloseForecastProfile?.();
    }
    // Keep the full grid modal closed on Forecast step — detailed inputs
    // render inline under FX cash flows / Liquidity trough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perspective, fxWizard.step]);
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
  const [pathBasis, setPathBasis] = useState<HedgePathBasisId>('totalExpected');
  const mixSnapshotRef = useRef<Record<string, number> | null>(null);
  const stagedDuringModalRef = useRef(false);
  const [atlasSelectedId, setAtlasSelectedId] = useState<string | null>(null);
  const [mixResetNonce, setMixResetNonce] = useState(0);
  const [atlasChartView, setAtlasChartView] = useState<'frontier' | 'marginal'>('frontier');
  /** Names pinned open — Optimize re-solves the mix without hedging them. */
  const [forceOpenCcys, setForceOpenCcys] = useState<string[]>([]);
  /**
   * Names removed from the book entirely — no leg, no VaR/correlation
   * contribution, as if the row never existed. Different from
   * forceOpenCcys: "leave open" still counts the exposure in the
   * diversified risk pool (just pins its own hedge ratio at 0); this
   * drops the exposure altogether, to test a genuinely smaller portfolio
   * (e.g. a vendor reference report scoped to a currency subset).
   */
  const [excludeCcys, setExcludeCcys] = useState<string[]>([]);
  const [mixTuneMode, setMixTuneMode] = useState<'var' | 'carry'>('var');
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
      out[bar.ccy] = monthlyFxFlowSeriesLocalM(row, T, forecastProfile);
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
   * Live VaR rows. Optimize mix (hedgeRatios) is % of Target and wins over
   * Cash Carry / Liquidity packages and leftover strips — otherwise Book
   * keeps MXN 100% strip / PLN carry N while the header shows 20% / 100%.
   */
  const liveRows = useMemo((): HedgeVarRow[] => {
    return summary.rows.map(r => {
      const meta = stripMetaByCcy[r.ccy];
      const prep = preparedByCcy[r.ccy];
      const hasStrip = hasRollingStripForCcy(bookedHedges, r.ccy);
      const struct = structureTagFor(r.ccy, r.hedgeNotionalLocalM);
      const mixW = hedgeRatios[r.ccy];
      const mixDriven = typeof mixW === 'number' && Number.isFinite(mixW);

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

      if (mixDriven) {
        const Eref =
          Math.abs(r.targetHedgeLocalM) > 1e-12
            ? r.targetHedgeLocalM
            : r.residualLocalM + r.hedgeNotionalLocalM;
        return applyCover(mixW * Eref, r.equalVarHedgeLocalM);
      }

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
    hedgeRatios,
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
    // Effective σ₁ₘ, not just the source id — an edited override changes the
    // vol without changing which source is selected.
    monthlyVolForSetup(setup),
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
  const chartStructure: ForecastHedgeStructure =
    chartCcy
      ? (structureByCcy[chartCcy]
        ?? (preparedByCcy[chartCcy]?.structure === 'strip' ? 'strip' : undefined)
        ?? hedgeStructure)
      : hedgeStructure;
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

  const closePathChart = () => {
    if (
      !stagedDuringModalRef.current
      && mixSnapshotRef.current
      && onHedgeRatiosChange
    ) {
      onHedgeRatiosChange(mixSnapshotRef.current);
    }
    mixSnapshotRef.current = null;
    stagedDuringModalRef.current = false;
    setChartCcy(null);
    setPathPrepareAction(null);
    setPathSummaryMetrics(null);
  };

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
    stagedDuringModalRef.current = true;
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
          marketRates: resolveMarketRatesForCcy(
            marketRatesByCcy,
            chartRow.ccy,
            ratesScopeId,
          ),
          bulletSettleMonths: defaultTf,
          ccy: chartRow.ccy,
          bookRows,
          forecastProfile,
          forecastMonths: setup.forecastMonths,
        },
      );
      onPreparedByCcyChange(
        setPreparedHedgeForCcy(preparedByCcy, chartRow.ccy, {
          ...profile,
          preparedFor: 'var',
          approvalStatus: 'draft',
        }),
      );
      // Stay open — Stage keeps the modal up with a live "Staged" badge.
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
          marketRates: resolveMarketRatesForCcy(
            marketRatesByCcy,
            chartRow.ccy,
            ratesScopeId,
          ),
          bulletSettleMonths: bulletSettle,
          ccy: chartRow.ccy,
          bookRows,
          forecastProfile,
          forecastMonths: setup.forecastMonths,
        },
    );
    onPreparedByCcyChange(
      setPreparedHedgeForCcy(preparedByCcy, chartRow.ccy, {
        ...profile,
        preparedFor: 'var',
        approvalStatus: 'draft',
      }),
    );
    // Stay open — same as Cash Carry / Decision: stage, don't dismiss.
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
  /** Top-section u₁ₘ: write global setup and clear sticky Forecast-profile line overrides. */
  const patchUncertainty1m = (value: number) => {
    onSetupChange({ ...setup, forecastUncertainty1m: value });
    if (onForecastProfileChange) {
      const cleared = clearLineUncertainties(forecastProfile);
      if (cleared !== forecastProfile) onForecastProfileChange(cleared);
    }
  };

  /** Same Σ as Cash Carry “All CCY” Total — risk CCYs only (matches the table). */
  const analyticsExtraForwards = useMemo(
    () =>
      analyticsForwardsFromOverlays({
        overlayByCcy: swapForwardOverlayByCcy,
        planByCcy: livePlanByCcy,
        forecastMonths: setup.forecastMonths,
      }),
    [swapForwardOverlayByCcy, livePlanByCcy, setup.forecastMonths],
  );

  const fxVarFrontier = useMemo(() => {
    const split = cashForecastCarrySplitByCcyUsdM({
      rows: bookRows ?? [],
      forecastProfile,
      forecastMonths: setup.forecastMonths,
      bookedHedges,
      preparedByCcy,
      setup,
      marketRatesByCcy,
      ratesScopeId,
      extraForwards: analyticsExtraForwards,
    });
    const staged = stagedFxHedgeCarryByCcyUsdM(preparedByCcy);
    const cashByCcy: Record<string, number> = {};
    const hedgeCarryByCcy: Record<string, number> = {};
    for (const r of liveRows) {
      cashByCcy[r.ccy] =
        deskCashCarryByCcyUsdM?.[r.ccy] ?? split[r.ccy]?.cashUsdM ?? 0;
      hedgeCarryByCcy[r.ccy] =
        deskHedgeCarryByCcyUsdM?.[r.ccy] ?? staged[r.ccy] ?? split[r.ccy]?.fwdUsdM ?? 0;
    }
    return fxCarryVarFrontier({ rows: liveRows, cashByCcy, hedgeCarryByCcy });
  }, [
    liveRows,
    bookRows,
    forecastProfile,
    setup,
    bookedHedges,
    preparedByCcy,
    marketRatesByCcy,
    ratesScopeId,
    analyticsExtraForwards,
    deskCashCarryByCcyUsdM,
    deskHedgeCarryByCcyUsdM,
  ]);

  const atlasRequest = useMemo((): FxAtlasJobRequest | null => {
    if (!bookRows?.length) return null;
    return {
      rows: bookRows,
      forecastMonths: setup.forecastMonths,
      forecastProfile,
      confidencePct: setup.confidencePct,
      rUsd: deskShared?.r_USD ?? 4,
      marketRatesByCcy: resolveMarketRatesBook(
        marketRatesByCcy,
        bookRows.map(r => r.ccy),
        ratesScopeId,
      ),
      ratesScopeId,
      forceOpenCcys: forceOpenCcys.length ? forceOpenCcys : undefined,
      excludeCcys: excludeCcys.length ? excludeCcys : undefined,
    };
  }, [
    bookRows,
    setup.forecastMonths,
    setup.confidencePct,
    forecastProfile,
    deskShared?.r_USD,
    marketRatesByCcy,
    ratesScopeId,
    forceOpenCcys,
    excludeCcys,
  ]);
  const {
    result: atlasJob,
    pending: atlasPending,
    error: atlasError,
  } = useFxAtlas(atlasRequest);
  const atlasFrontier = useMemo(() => {
    if (forceOpenCcys.length === 0 || atlasJob.legs.length === 0) return atlasJob;
    const corr = atlasRiskCorrFor(marketRatesByCcy);
    const solved = fxAtlasTenorFrontier(atlasJob.legs, corr, {
      forceOpenCcys: new Set(forceOpenCcys),
    });
    return {
      ...atlasJob,
      curve: solved.curve,
      sweet: solved.sweet,
      fullyHedged: solved.fullyHedged,
      unhedged: solved.unhedged,
    };
  }, [atlasJob, forceOpenCcys, marketRatesByCcy]);
  const atlasByCcy = atlasFrontier.byCcy;
  const atlasWalk = useMemo(() => {
    const pts = [...atlasFrontier.curve];
    const open = atlasFrontier.unhedged;
    if (open && !pts.some(p => p.id === open.id)) pts.push(open);
    return pts;
  }, [atlasFrontier.curve, atlasFrontier.unhedged]);
  const atlasSelected =
    atlasWalk.find(p => p.id === atlasSelectedId)
    ?? atlasFrontier.sweet
    ?? atlasWalk[0]
    ?? null;
  const mixWeightByCcy = useMemo(
    () => fxLiveMixWeights(atlasSelected?.hedgeByCcy, hedgeRatios, forceOpenCcys),
    [atlasSelected?.hedgeByCcy, forceOpenCcys, hedgeRatios],
  );
  const openOptimizeCcy = useCallback(
    (ccy: string) => {
      mixSnapshotRef.current = { ...mixWeightByCcy };
      stagedDuringModalRef.current = false;
      setPathBasis('totalExpected');
      const staged = preparedByCcy[ccy];
      const struct: ForecastHedgeStructure =
        staged?.preparedFor === 'var' && staged.structure === 'strip'
          ? 'strip'
          : 'bullet';
      setHedgeStructure(struct);
      setStructureByCcy(prev => ({ ...prev, [ccy]: struct }));
      setRegimeByCcy(prev => ({ ...prev, [ccy]: 'totalExpected' }));
      setChartCcy(ccy);
    },
    [mixWeightByCcy, preparedByCcy, setHedgeStructure],
  );
  const mixPoint = useMemo((): FxCarryVarPoint | null => {
    if (!atlasSelected) {
      const hasWeights = Object.values(mixWeightByCcy).some(w => w > 1e-9);
      if (!hasWeights) return null;
      return {
        id: 'live-mix',
        t: 0,
        carryUsdYrM: 0,
        divVarUsdM: 0,
        standaloneVarUsdM: 0,
        kind: 'mix',
        hedgeByCcy: mixWeightByCcy,
      };
    }
    return {
      ...atlasSelected,
      hedgeByCcy: mixWeightByCcy,
    };
  }, [atlasSelected, mixWeightByCcy]);
  const mixTuned = useMemo(() => {
    if (!atlasSelected?.hedgeByCcy) return Object.values(hedgeRatios).some(w => w > 1e-9);
    if (forceOpenCcys.some(ccy => (atlasSelected.hedgeByCcy?.[ccy] ?? 0) > 0.008)) {
      return true;
    }
    return Object.entries(hedgeRatios).some(([ccy, w]) => {
      if (typeof w !== 'number' || !Number.isFinite(w)) return false;
      return Math.abs((atlasSelected.hedgeByCcy?.[ccy] ?? 0) - w) > 0.008;
    });
  }, [atlasSelected, forceOpenCcys, hedgeRatios]);
  const liveMixPoint = useMemo(() => {
    if (!mixTuned || atlasFrontier.legs.length === 0) return null;
    return fxAtlasPointAtCcyWeights(
      atlasFrontier.legs,
      mixWeightByCcy,
      atlasRiskCorrFor(marketRatesByCcy),
      'live-mix',
    );
  }, [atlasFrontier.legs, marketRatesByCcy, mixTuned, mixWeightByCcy]);
  // A previously-applied scenario freezes its weights into `hedgeRatios`
  // (applyAtlasPoint), and fxLiveMixWeights lets that frozen snapshot win
  // over ANY later backend recompute for the same currency keys — so
  // navigating between points, or toggling which names are left open,
  // kept showing stale numbers even after the backend recomputed a
  // different (correct) mix for the same point id. Resync hedgeRatios to
  // the freshly-selected point's own weights whenever what's being VIEWED
  // changes; a manual per-bar drag afterward still overrides normally,
  // since it fires its own onHedgeRatiosChange call and doesn't touch
  // atlasSelected. onHedgeRatiosChange is deliberately left out of the
  // deps — depending on it would refire this on every parent re-render
  // triggered by the very update it makes, an infinite loop; the intent
  // is "resync when the viewed point's data changes", not "resync
  // whenever the setter identity changes".
  useEffect(() => {
    if (!atlasSelected?.hedgeByCcy || !onHedgeRatiosChange) return;
    onHedgeRatiosChange(atlasSelected.hedgeByCcy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlasSelected?.hedgeByCcy]);
  const unhedgedBookSelected =
    !mixTuned && atlasSelected?.id === atlasFrontier.unhedged?.id;
  const atlasWalkIdx = atlasSelected
    ? atlasWalk.findIndex(p => p.id === atlasSelected.id)
    : -1;
  const atlasMarginal = useMemo(
    () => fxAtlasMarginalEffects(
      atlasFrontier.legs,
      atlasSelected?.hedgeByCcy,
      atlasRiskCorrFor(marketRatesByCcy),
    ),
    [atlasFrontier.legs, atlasSelected?.hedgeByCcy, marketRatesByCcy],
  );

  const applyAtlasPoint = useCallback(
    (point: FxCarryVarPoint, opts?: { forceBullets?: boolean; stage?: boolean }) => {
      setAtlasSelectedId(point.id);
      const weights = point.hedgeByCcy;
      if (!weights) return;
      const forceBullets = opts?.forceBullets === true;
      // Default mix ticket is Target × w bullets. A strip staged in the
      // currency modal is kept unless Reset to mix / forceBullets.
      // Scenario pick on Optimize only writes hedge % — Stage / Book stages.
      if (forceBullets && onBookedHedgesChange) {
        let next = bookedHedges;
        for (const ccy of Object.keys(weights)) {
          if (hasRollingStripForCcy(next, ccy)) {
            next = clearRollingStripForCcy(next, ccy);
          }
        }
        if (next !== bookedHedges) onBookedHedgesChange(next);
      }
      if (opts?.stage && onPreparedByCcyChange) {
        const settle = setup.forecastMonths || 12;
        onPreparedByCcyChange(prev =>
          stageAtlasMixPrepared(
            prev ?? preparedByCcy,
            Object.entries(weights).map(([ccy, raw]) => {
              const w = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
              const target =
                atlasByCcy.local[ccy]
                ?? liveRows.find(r => r.ccy === ccy)?.targetHedgeLocalM
                ?? 0;
              return {
                ccy,
                weight: w,
                coverLocalM: w * target,
                lockedCarryUsdM: atlasMixLockedCarryUsdM(
                  point,
                  ccy,
                  atlasByCcy.carry[ccy] ?? 0,
                  w,
                ),
              };
            }),
            settle,
            { preserveStrips: !forceBullets },
          ),
        );
      }
      setStructureByCcy(prev => {
        const next = { ...prev };
        let changed = false;
        for (const ccy of Object.keys(weights)) {
          if (!forceBullets) {
            const staged = preparedByCcy[ccy];
            if (staged?.structure === 'strip' && staged.preparedFor === 'var') {
              if (next[ccy] !== 'strip') {
                next[ccy] = 'strip';
                changed = true;
              }
              continue;
            }
            if (next[ccy] === 'strip') continue;
          }
          if (next[ccy] && next[ccy] !== 'bullet') {
            next[ccy] = 'bullet';
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      if (onHedgeRatiosChange) {
        onHedgeRatiosChange({ ...hedgeRatios, ...weights });
      }
    },
    [
      atlasByCcy.carry,
      atlasByCcy.local,
      bookedHedges,
      hedgeRatios,
      liveRows,
      onBookedHedgesChange,
      onHedgeRatiosChange,
      onPreparedByCcyChange,
      preparedByCcy,
      setup.forecastMonths,
    ],
  );

  const commitAtlasMixToBook = useCallback(() => {
    if (atlasSelected) applyAtlasPoint(atlasSelected, { stage: true });
  }, [atlasSelected, applyAtlasPoint]);

  const restoreSelectedMix = useCallback(() => {
    setForceOpenCcys([]);
    if (atlasSelected) applyAtlasPoint(atlasSelected);
  }, [atlasSelected, applyAtlasPoint]);

  /** Restore this CCY to the selected Optimize scenario — does not stage. */
  const resetCcyToSelectedMix = useCallback(() => {
    if (!chartCcy || !atlasSelected) return;
    const mixW = forceOpenCcys.includes(chartCcy)
      ? 0
      : (atlasSelected.hedgeByCcy?.[chartCcy] ?? 0);
    setPathBasis('totalExpected');
    setHedgeStructure('bullet');
    setStructureByCcy(prev => ({ ...prev, [chartCcy]: 'bullet' }));
    setRegimeByCcy(prev => ({ ...prev, [chartCcy]: 'totalExpected' }));
    if (onHedgeRatiosChange) {
      onHedgeRatiosChange({ ...hedgeRatios, [chartCcy]: mixW });
    }
    if (mixSnapshotRef.current) {
      mixSnapshotRef.current = { ...mixSnapshotRef.current, [chartCcy]: mixW };
    }
    setMixResetNonce(n => n + 1);
  }, [
    atlasSelected,
    chartCcy,
    forceOpenCcys,
    hedgeRatios,
    onHedgeRatiosChange,
  ]);

  const atlasStageKeyRef = useRef('');
  // Older sessions copied hedge % only and cleared packages. Re-stage when
  // Book / Approve is open and the mix has no FX Risk ticket yet.
  useEffect(() => {
    if (fxWizard.step < 5 || !atlasSelected?.hedgeByCcy || !onPreparedByCcyChange) {
      return;
    }
    const mixKey = Object.entries(atlasSelected.hedgeByCcy)
      .filter(([ccy]) => ccy !== 'USD')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ccy, raw]) => {
        const w = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        return `${ccy}:${w.toFixed(6)}:${atlasMixLockedCarryUsdM(atlasSelected, ccy, atlasByCcy.carry[ccy] ?? 0, w).toFixed(6)}`;
      })
      .join('|');
    const missing = Object.entries(atlasSelected.hedgeByCcy).some(([ccy, raw]) => {
      if (ccy === 'USD') return false;
      const w = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      const p = preparedByCcy[ccy];
      if (!(w > 1e-6)) return Boolean(p && p.preparedFor === 'var');
      if (p?.structure === 'strip' && p.preparedFor === 'var') return false;
      if (!p || p.preparedFor !== 'var') return true;
      const target = atlasByCcy.local[ccy] ?? 0;
      const locked = atlasMixLockedCarryUsdM(
        atlasSelected,
        ccy,
        atlasByCcy.carry[ccy] ?? 0,
        w,
      );
      if (Math.abs((p.coverLocalM ?? 0) - w * target) > 1e-6) return true;
      if (Math.abs((p.impliedCarryUsdM ?? NaN) - locked) > 1e-6) return true;
      return false;
    });
    const key = `${atlasSelected.id}|${fxWizard.step}|${mixKey}`;
    if (!missing) {
      atlasStageKeyRef.current = key;
      return;
    }
    if (atlasStageKeyRef.current === key) return;
    atlasStageKeyRef.current = key;
    applyAtlasPoint(atlasSelected, { stage: true });
  }, [
    applyAtlasPoint,
    atlasByCcy.carry,
    atlasByCcy.local,
    atlasSelected,
    fxWizard.step,
    onPreparedByCcyChange,
    preparedByCcy,
  ]);

  const walkAtlasBy = useCallback(
    (delta: number) => {
      if (atlasWalk.length === 0) return;
      const from = atlasWalkIdx >= 0 ? atlasWalkIdx : 0;
      const next = atlasWalk[Math.min(atlasWalk.length - 1, Math.max(0, from + delta))];
      if (next) applyAtlasPoint(next);
    },
    [atlasWalk, atlasWalkIdx, applyAtlasPoint],
  );

  const setMixCcyIncluded = useCallback((ccy: string, included: boolean) => {
    setForceOpenCcys(prev => {
      const next = new Set(prev);
      if (included) next.delete(ccy);
      else next.add(ccy);
      return [...next].sort();
    });
    setAtlasSelectedId(null);
  }, []);

  /** True removal from the book — distinct from "leave open" (setMixCcyIncluded). */
  const setMixCcyExcluded = useCallback((ccy: string, excluded: boolean) => {
    setExcludeCcys(prev => {
      const next = new Set(prev);
      if (excluded) next.add(ccy);
      else next.delete(ccy);
      return [...next].sort();
    });
    // A removed name can no longer be "left open" — clear that pin too so
    // the two controls don't fight (leave-open on a nonexistent leg is a
    // no-op the backend already ignores, but keeping the UI checkbox
    // stale/checked for a removed name would be confusing).
    if (excluded) {
      setForceOpenCcys(prev => prev.filter(c => c !== ccy));
    }
    setAtlasSelectedId(null);
  }, []);

  const setMixWeight = useCallback(
    (ccy: string, pct: number) => {
      const w = Math.min(1, Math.max(0, pct / 100));
      if (!onHedgeRatiosChange) return;
      const nextRatios = { ...hedgeRatios, [ccy]: w };
      onHedgeRatiosChange(nextRatios);
      if (fxWizard.step < 5 || !onPreparedByCcyChange) return;
      const weights = {
        ...(atlasSelected?.hedgeByCcy ?? {}),
        ...nextRatios,
      };
      const settle = setup.forecastMonths || 12;
      onPreparedByCcyChange(prev =>
        stageAtlasMixPrepared(
          prev ?? preparedByCcy,
          Object.entries(weights).map(([name, raw]) => {
            const ww = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
            const target =
              atlasByCcy.local[name]
              ?? liveRows.find(r => r.ccy === name)?.targetHedgeLocalM
              ?? 0;
            return {
              ccy: name,
              weight: ww,
              coverLocalM: ww * target,
              lockedCarryUsdM: atlasMixLockedCarryUsdM(
                atlasSelected,
                name,
                atlasByCcy.carry[name] ?? 0,
                ww,
              ),
            };
          }),
          settle,
          { preserveStrips: true },
        ),
      );
    },
    [
      atlasByCcy.carry,
      atlasByCcy.local,
      atlasSelected,
      fxWizard.step,
      hedgeRatios,
      liveRows,
      onHedgeRatiosChange,
      onPreparedByCcyChange,
      preparedByCcy,
      setup.forecastMonths,
    ],
  );

  const atlasScenarioCards = useMemo((): {
    point: FxCarryVarPoint | null;
    card: FrontierSolutionCard;
  }[] => {
    const unhedgedVar = atlasFrontier.unhedged?.divVarUsdM ?? 0;
    const toCard = (
      point: FxCarryVarPoint | null | undefined,
      id: string,
      name: string,
      short: string,
      rationale: string,
    ): { point: FxCarryVarPoint | null; card: FrontierSolutionCard } => {
      const p = point ?? null;
      const risk = p?.divVarUsdM ?? 0;
      const carry = p?.carryUsdYrM ?? 0;
      return {
        point: p,
        card: {
          id,
          name,
          short,
          rationale,
          carryUsdYrM: carry,
          riskUsdM: risk,
          usedPct: unhedgedVar > 1e-9 ? (risk / unhedgedVar) * 100 : 0,
          efficiency: Math.abs(risk) > 1e-9 ? carry / risk : 0,
          approved: false,
          disabled: p == null,
        },
      };
    };
    return [
      toCard(
        atlasFrontier.unhedged,
        'leave-open',
        'Leave open',
        'No hedge — full residual VaR, no locked carry',
        'Walk away from the book. Every name stays at Δ = 1.',
      ),
      toCard(
        atlasFrontier.sweet,
        'recommended',
        'Recommended',
        'Sweet spot — dump costly carry, keep flat names',
        'Recommended mix. Keep GBP-like flats; hedge names that pay carry.',
      ),
      toCard(
        atlasFrontier.fullyHedged,
        'fully-hedge',
        'Fully hedge',
        'All Target — lowest VaR, lock the full carry book',
        '100% of Target on every name. Residual VaR goes to the floor.',
      ),
    ];
  }, [atlasFrontier.fullyHedged, atlasFrontier.sweet, atlasFrontier.unhedged]);

  const bookLiveRows = useMemo(
    () =>
      applyAtlasMixToHedgeRows(liveRows, mixPoint, {
        indiv: atlasByCcy.indiv,
        local: atlasByCcy.local,
      }),
    [liveRows, mixPoint, atlasByCcy.indiv, atlasByCcy.local],
  );
  const atlasCorr = useMemo(
    () => atlasRiskCorrFor(marketRatesByCcy),
    [marketRatesByCcy],
  );
  const beforeUsdByCcy = useMemo(() => {
    const next: Record<string, number> = {};
    for (const r of liveRows) {
      if (r.ccy === 'USD') continue;
      next[r.ccy] = atlasByCcy.indiv[r.ccy] ?? r.varBeforeUsdM;
    }
    return next;
  }, [atlasByCcy.indiv, liveRows]);
  const unhedgedVarStack = useMemo(
    () =>
      stackFromRisk(
        'unhedged',
        'Unhedged',
        'VaR before mix',
        diversifiedUsdRisk(
          fxMixSignedContribs(liveRows, atlasByCcy, mixWeightByCcy, 'before'),
          atlasCorr,
        ),
      ),
    [atlasByCcy, atlasCorr, liveRows, mixWeightByCcy],
  );
  const hedgedVarStack = useMemo(() => {
    const mixStatus = mixTuned
      ? 'TUNED'
      : atlasSelected?.id === atlasFrontier.fullyHedged?.id
        ? 'FULL'
        : atlasSelected?.id === atlasFrontier.unhedged?.id
          ? 'OPEN'
          : 'MIX';
    return stackFromRisk(
      'hedged',
      'After mix',
      mixStatus,
      diversifiedUsdRisk(
        fxMixSignedContribs(liveRows, atlasByCcy, mixWeightByCcy, 'after'),
        atlasCorr,
      ),
    );
  }, [
    atlasByCcy,
    atlasCorr,
    atlasFrontier.fullyHedged?.id,
    atlasFrontier.unhedged?.id,
    atlasSelected?.id,
    liveRows,
    mixTuned,
    mixWeightByCcy,
  ]);

  const mixTuneRows = useMemo(() => {
    return bookLiveRows
      .filter(r => r.ccy !== 'USD')
      .map(r => {
        const included = !forceOpenCcys.includes(r.ccy);
        const w = mixWeightByCcy[r.ccy] ?? 0;
        const locked = atlasMixLockedCarryUsdM(
          mixPoint,
          r.ccy,
          atlasByCcy.carry[r.ccy] ?? 0,
          w,
        );
        return {
          ccy: r.ccy,
          included,
          hedgePct: Math.round(Math.min(1, Math.max(0, w)) * 100),
          residVarUsdM: (atlasByCcy.indiv[r.ccy] ?? r.varBeforeUsdM) * (1 - w),
          lockedCarryUsdM: locked,
        };
      });
  }, [
    atlasByCcy.carry,
    atlasByCcy.indiv,
    bookLiveRows,
    forceOpenCcys,
    mixPoint,
    mixWeightByCcy,
  ]);

  const retainedLivePlanByCcy = useMemo(
    () => retainedFundingPlanByCcy(livePlanByCcy, swapForwardOverlayByCcy),
    [livePlanByCcy, swapForwardOverlayByCcy],
  );

  const cashCarryTotalUsdM = useMemo(() => {
    const ccys = risk
      .map(r => r.bar.ccy)
      .filter(ccy => ccy !== 'USD' && ccy.length > 0);
    return sumCashCarryTotalUsdM({
      ccys,
      bookRows,
      forecastProfile,
      forecastMonths: setup.forecastMonths,
      marketRatesFor: ccy =>
        resolveMarketRatesForCcy(marketRatesByCcy, ccy, ratesScopeId),
      bookedHedges,
      preparedByCcy,
      setup,
      extraForwards: analyticsExtraForwards,
    });
  }, [
    risk,
    bookRows,
    forecastProfile,
    setup,
    marketRatesByCcy,
    ratesScopeId,
    bookedHedges,
    preparedByCcy,
    analyticsExtraForwards,
  ]);

  /**
   * When Cash Carry is open, prefer the table footer total so the tab rail
   * cannot drift from All CCY · Total (old hedged-only Σ was e.g. +508.2K).
   */
  const [cashCarryTableTotalUsdM, setCashCarryTableTotalUsdM] = useState<
    number | null
  >(null);
  const cashCarryTabUsdM =
    cashCarryTableTotalUsdM != null
      ? cashCarryTableTotalUsdM
      : cashCarryTotalUsdM;

  /** Aggregate Net CFaR — same Monte Carlo size+timing number as cover, plus
   * the funding-swap residual when a live plan is on (scaled by (1−Δ)). */
  const cfarNetTotalUsdM = useMemo(
    () =>
      sumNetCfarUsdM(
        fxHedgeNetCfarByCcyUsdM({
          rows: bookRows ?? [],
          setup,
          forecastProfile,
          bookedHedges,
          preparedByCcy,
          marketRatesByCcy,
          ratesScopeId,
          fundingPlanByCcy: livePlanByCcy,
          swapForwardOverlayByCcy,
        }),
      ),
    [
      bookRows,
      forecastProfile,
      setup,
      marketRatesByCcy,
      ratesScopeId,
      bookedHedges,
      preparedByCcy,
      livePlanByCcy,
      swapForwardOverlayByCcy,
    ],
  );

  /**
   * Live funding programme — same evaluator as the Liquidity tab, so the
   * tab-rail cost and regime table cannot drift.
   */
  const liveFunding = useMemo(() => {
    const timing =
      resolveLiquidityTiming(forecastProfile) ?? DEFAULT_LIQUIDITY_TIMING;
    const live = strategyForRegime(
      timing.sizingBasis ?? 'horizon',
      timing.bookingMode ?? 'rolling',
    );
    const results = evaluateLiquidityStrategies(
      liquidityStrategyInputFrom({
        setup,
        bookRows,
        forecastProfile,
        bookedHedges,
        preparedByCcy,
        ratesScopeId,
        marketRatesByCcy,
        activeLayers,
        livePlanByCcy,
        swapForwardOverlayByCcy,
        cfarNetByCcyUsd,
        deskShared,
        deskHedgeCarryByCcyUsdM,
        deskCashCarryByCcyUsdM,
        deskCipByCcyUsdM,
      }),
    );
    return results.find(r => r.strategy.id === live.id) ?? results[0] ?? null;
  }, [
    setup,
    bookRows,
    forecastProfile,
    bookedHedges,
    preparedByCcy,
    ratesScopeId,
    marketRatesByCcy,
    activeLayers,
    livePlanByCcy,
    swapForwardOverlayByCcy,
    cfarNetByCcyUsd,
    deskShared,
    deskHedgeCarryByCcyUsdM,
    deskCashCarryByCcyUsdM,
    deskCipByCcyUsdM,
  ]);
  const liquidityCostUsdYrM = liveFunding?.netCostUsdYrM ?? 0;

  const perspectiveTabStats = useMemo((): Partial<
    Record<RiskPerspective, RiskPerspectiveTabStat>
  > => {
    return {
      fxRisk: {
        value: fmtTabResidVar(summary.totalVarAfterUsdM),
        label: 'Resid VaR',
      },
      cashCarry: {
        value: fmtTabCarryK(cashCarryTabUsdM),
        label: 'Total carry',
      },
      cfar: {
        value: fmtTabResidVar(cfarNetTotalUsdM),
        label: 'Net CFaR',
      },
      liquidity: {
        value: fmtTabCarryK(-liquidityCostUsdYrM),
        label: 'Funding cost',
      },
    };
  }, [
    summary.totalVarAfterUsdM,
    cashCarryTabUsdM,
    cfarNetTotalUsdM,
    liquidityCostUsdYrM,
  ]);

  const growthMoM = forecastProfile.growthRateMoM ?? 0;

  return (
    <div className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200">
      <RiskPerspectiveSelector
        value={perspective}
        onChange={setPerspective}
        moduleLabel="Analytics"
        tabStats={perspectiveTabStats}
        tfMonths={setup.forecastMonths}
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
          onSetupChange={onSetupChange}
          bookedHedges={bookedHedges}
          preparedByCcy={preparedByCcy}
          onPreparedByCcyChange={onPreparedByCcyChange}
          bookRows={bookRows}
          forecastProfile={forecastProfile}
          ratesScopeId={ratesScopeId}
          marketRatesByCcy={marketRatesByCcy}
          onMarketRatesByCcyChange={onMarketRatesByCcyChange}
          onAllCcyTotalCarryUsdMChange={setCashCarryTableTotalUsdM}
          extraForwards={analyticsExtraForwards}
        />
      ) : perspective === 'cfar' ? (
        <CfarAnalysisView
          risk={risk}
          setup={setup}
          onSetupChange={onSetupChange}
          onForecastProfileChange={onForecastProfileChange}
          bookedHedges={bookedHedges}
          preparedByCcy={preparedByCcy}
          bookRows={bookRows}
          forecastProfile={forecastProfile}
          ratesScopeId={ratesScopeId}
          marketRatesByCcy={marketRatesByCcy}
          livePlanByCcy={retainedLivePlanByCcy ?? livePlanByCcy}
          extraForwards={analyticsExtraForwards}
        />
      ) : perspective === 'liquidity' ? (
        <LiquidityAnalyticsView
          setup={setup}
          bookRows={bookRows}
          forecastProfile={forecastProfile}
          bookedHedges={bookedHedges}
          preparedByCcy={preparedByCcy}
          ratesScopeId={ratesScopeId}
          marketRatesByCcy={marketRatesByCcy}
          activeLayers={activeLayers}
          onLayerToggle={onLayerToggle}
          layerPanel={layerPanel}
          onLayerPanelChange={onLayerPanelChange}
          livePlanByCcy={livePlanByCcy}
          swapForwardOverlayByCcy={swapForwardOverlayByCcy}
          cfarNetByCcyUsd={cfarNetByCcyUsd}
          extraForwards={analyticsExtraForwards}
          stockNetByCcy={Object.fromEntries(
            risk.map(r => [r.bar.ccy, r.bar.stockNetM] as const),
          )}
          deskShared={deskShared}
          deskHedgeCarryByCcyUsdM={deskHedgeCarryByCcyUsdM}
          deskCashCarryByCcyUsdM={deskCashCarryByCcyUsdM}
          deskCipByCcyUsdM={deskCipByCcyUsdM}
          onSetupChange={onSetupChange}
          policyVAR={policyVAR}
          onPolicyVARChange={onPolicyVARChange}
          portfolioCarryK={portfolioCarryK}
          onPortfolioCarryKChange={onPortfolioCarryKChange}
          onPreparedByCcyChange={
            onPreparedByCcyChange
              ? next =>
                  onPreparedByCcyChange(
                    typeof next === 'function'
                      ? next(preparedByCcy ?? {})
                      : next,
                  )
              : undefined
          }
          residualByCcy={residualByCcy}
          onResidualByCcyChange={onResidualByCcyChange}
          portfolioScenarioId={portfolioScenarioId}
          onPortfolioScenarioIdChange={onPortfolioScenarioIdChange}
          usdCash={usdCash}
          onUsdCashChange={onUsdCashChange}
          usdPayout={usdPayout}
          onStrategyCfarByCcyChange={onStrategyCfarByCcyChange}
          onOptimizerOverlayByCcyChange={onOptimizerOverlayByCcyChange}
          cashCarryTabUsdM={cashCarryTabUsdM}
        />
      ) : perspective !== 'fxRisk' ? (
        <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-10 text-center text-xs text-slate-500">
          {riskPerspectiveMeta(perspective).label} view is coming soon on Analytics.
        </div>
      ) : (
      <AnalyticsWizardShell
        title="Group FX VaR"
        steps={FX_RISK_WIZARD_STEPS}
        step={fxWizard.step}
        maxReached={fxWizard.maxReached}
        onGoToStep={n => {
          if (fxWizard.step === 4 && n > 4) commitAtlasMixToBook();
          fxWizard.goToStep(n);
        }}
        onNext={() => {
          if (fxWizard.step === 4) commitAtlasMixToBook();
          fxWizard.nextStep();
        }}
        onPrev={fxWizard.prevStep}
      >
      {fxWizard.step === 1 && (
      <ForecastParametersForm
        setup={setup}
        onSetupChange={onSetupChange}
        forecastProfile={forecastProfile}
        onForecastProfileChange={onForecastProfileChange}
        bookRows={bookRows}
        onRowFieldChange={onRowFieldChange}
        u1m={u1m}
        uncertaintyCustom={uncertaintyCustom}
        uCustomDraft={uCustomDraft}
        onUCustomDraftChange={setUCustomDraft}
        onUCustomOpenChange={setUCustomOpen}
        onUncertainty1m={patchUncertainty1m}
        onOpenFullProfile={onOpenForecastProfile}
      />
      )}

      {fxWizard.step === 2 && (
      <>
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
                      const eff = volForSource(setup, opt.id);
                      const edited = Math.abs(eff - opt.monthlyVol) > 1e-12;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          title={
                            edited
                              ? `${opt.description}\nOverridden on the CFaR tab — desk preset is ${(opt.monthlyVol * 100).toFixed(1)}%.`
                              : opt.description
                          }
                          onClick={() => patch({ volSource: opt.id })}
                          className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                            on
                              ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                              : 'text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          {opt.label}
                          <span
                            className={`ml-1 font-mono text-[10px] font-normal ${
                              edited ? 'text-emerald-300' : 'opacity-80'
                            }`}
                          >
                            {(eff * 100).toFixed(1)}%
                            {edited ? '*' : ''}
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
      </>
      )}

      {fxWizard.step === 3 && (
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
      )}

      {fxWizard.step === 4 && (
      <>
      <div className="space-y-6">
      <section className="rounded-xl border border-slate-800 bg-slate-950/40 px-5 py-3">
        <div className="grid items-stretch gap-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="flex h-full flex-col gap-3.5 lg:border-r lg:border-slate-800 lg:pr-5">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-medium text-slate-100">Scenarios</h2>
              <span className="font-mono text-[11px] text-slate-500">
                Leave open · Recommended · Fully hedge
              </span>
            </div>
            <div className="flex flex-col gap-3">
              {atlasScenarioCards.map(({ point, card }) => {
                const selectedId = mixTuned
                  ? null
                  : atlasSelected?.id === atlasFrontier.unhedged?.id
                    ? 'leave-open'
                    : atlasSelected?.id === atlasFrontier.sweet?.id
                      ? 'recommended'
                      : atlasSelected?.id === atlasFrontier.fullyHedged?.id
                        ? 'fully-hedge'
                        : null;
                return (
                  <ParetoScenarioCard
                    key={card.id}
                    scenario={card}
                    shareLabel="% unhedged"
                    maxAbsCarryUsdYrM={Math.max(
                      ...atlasScenarioCards.map(s => Math.abs(s.card.carryUsdYrM)),
                      1e-9,
                    )}
                    isSelected={selectedId === card.id}
                    onSelect={() => {
                      if (point) applyAtlasPoint(point);
                    }}
                  />
                );
              })}
            </div>
            {atlasPending ? (
              <span className="font-mono text-[10px] text-slate-500">Computing…</span>
            ) : null}
            {atlasError ? (
              <span className="font-mono text-[10px] text-rose-400">{atlasError}</span>
            ) : null}
            <span className="mt-auto inline-flex items-center overflow-hidden rounded-lg border border-slate-800">
              <button
                type="button"
                disabled={atlasWalk.length < 2 || atlasWalkIdx <= 0}
                title="Previous frontier point"
                onClick={() => walkAtlasBy(-1)}
                className="h-9 px-2.5 font-mono text-[12px] text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                ◀
              </button>
              <span className="min-w-[148px] flex-1 border-x border-slate-800 px-2.5 text-center font-mono text-[11px] text-slate-300">
                {atlasWalkIdx >= 0
                  ? `${atlasWalkIdx + 1} / ${atlasWalk.length} · ${
                      mixTuned
                        ? 'Custom'
                        : atlasScenarioLabel(
                            atlasSelected,
                            atlasFrontier.sweet?.id,
                            atlasFrontier.fullyHedged?.id,
                            atlasFrontier.unhedged?.id,
                          )
                    }`
                  : '—'}
              </span>
              <button
                type="button"
                disabled={atlasWalk.length < 2 || atlasWalkIdx >= atlasWalk.length - 1}
                title="Next frontier point"
                onClick={() => walkAtlasBy(1)}
                className="h-9 px-2.5 font-mono text-[12px] text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                ▶
              </button>
            </span>
          </div>

          <div className="flex h-full min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-slate-100">
                  {mixTuned
                    ? 'Custom mix'
                    : atlasScenarioLabel(
                        atlasSelected,
                        atlasFrontier.sweet?.id,
                        atlasFrontier.fullyHedged?.id,
                        atlasFrontier.unhedged?.id,
                      )}
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  Carry vs VaR on the selected mix. Pick a scenario, walk the curve, then
                  drag names below to fine-tune the program before Book / Approve.
                </p>
              </div>
              <div
                className={`rounded-xl border px-3 py-2 ${
                  mixTuned
                    ? 'border-amber-500/40 bg-amber-500/10'
                    : 'border-emerald-500/30 bg-emerald-500/10'
                }`}
              >
                <div className={`text-[12px] font-medium ${mixTuned ? 'text-amber-200' : 'text-emerald-200'}`}>
                  {mixTuned ? 'Edited off the frontier point' : 'Frontier mix selected'}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                  Div VaR {fmtVarK(mixTuned ? hedgedVarStack.diversifiedTotal : (atlasSelected?.divVarUsdM ?? 0))}
                  {' · '}Carry {fmtVarK(atlasSelected?.carryUsdYrM ?? 0)}
                </div>
              </div>
            </div>
            <ChartViewFrame
              className="flex h-full min-h-0 flex-1 flex-col"
              ariaLabel="Chart view"
              value={atlasChartView}
              onChange={setAtlasChartView}
              options={[
                { id: 'frontier', label: 'Frontier' },
                { id: 'marginal', label: 'Marginal' },
              ]}
            >
              {atlasChartView === 'frontier' ? (
                <FxCarryVarFrontierChart
                  fillHeight
                  curve={atlasFrontier.curve}
                  unhedged={atlasFrontier.unhedged}
                  confidencePct={setup.confidencePct}
                  selectedId={atlasSelected?.id}
                  sweetId={atlasFrontier.sweet?.id}
                  livePoint={liveMixPoint}
                  onSelect={applyAtlasPoint}
                  onRestoreTune={mixTuned ? restoreSelectedMix : undefined}
                />
              ) : atlasMarginal.length > 0 ? (
                <FxAtlasMarginalEffectsChart points={atlasMarginal} />
              ) : (
                <div className="flex h-full min-h-[360px] items-center justify-center rounded-xl border border-slate-800 bg-slate-950/50 px-4 text-center font-mono text-[12px] text-slate-500">
                  No residual risk at this mix — every name is on Target.
                </div>
              )}
            </ChartViewFrame>
          </div>
        </div>
      </section>

      <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
            Hedging parameters · selected mix
          </div>
          <div className="flex flex-wrap items-baseline gap-3 font-mono text-[11px] text-slate-300">
            <span>
              {mixTuned
                ? 'Custom'
                : atlasScenarioLabel(
                    atlasSelected,
                    atlasFrontier.sweet?.id,
                    atlasFrontier.fullyHedged?.id,
                    atlasFrontier.unhedged?.id,
                  )}
              {atlasSelected
                ? ` · VaR ${fmtVarK(mixTuned ? hedgedVarStack.diversifiedTotal : atlasSelected.divVarUsdM)} · carry ${fmtVarK(atlasSelected.carryUsdYrM)}`
                : ''}
            </span>
            {excludeCcys.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setExcludeCcys([]);
                  setAtlasSelectedId(null);
                }}
                className="text-[10px] font-semibold uppercase tracking-wide text-rose-300 hover:text-rose-200"
              >
                Restore all
              </button>
            ) : null}
          </div>
        </div>
        <p className="font-mono text-[10px] text-slate-500">
          Uncheck a name to remove it from the book entirely (no VaR/correlation contribution) and re-solve the rest.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th
                  className="py-2 pr-3 font-medium"
                  title="Include in Optimize calibration. Off = forced open, mix re-solves."
                >
                  In
                </th>
                <th className="py-2 pr-3 font-medium">CCY</th>
                <th className="py-2 pr-3 font-medium">Hedge %</th>
                <th className="py-2 pr-3 font-medium" title="Selected weight × Target (local mm)">
                  Cover local
                </th>
                <th className="py-2 pr-3 font-medium" title="Selected weight × Target (USD mm)">
                  Cover USD
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Tf swap points / CIP on the cover (w × 12M bullet on Target)"
                >
                  Locked carry
                </th>
                <th className="py-2 pr-3 font-medium" title="Individual VaR left open at this weight">
                  Resid VaR
                </th>
                <th className="py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {liveRows
                .filter(r => r.ccy !== 'USD')
                .map(r => {
                  const included = !excludeCcys.includes(r.ccy);
                  const w = included
                    ? (hedgeRatios[r.ccy] ?? atlasSelected?.hedgeByCcy?.[r.ccy] ?? 0)
                    : 0;
                  const fullHx = atlasByCcy.carry[r.ccy] ?? 0;
                  const locked = atlasMixLockedCarryUsdM(mixPoint, r.ccy, fullHx, w);
                  const local = (atlasByCcy.local[r.ccy] ?? r.targetHedgeLocalM) * w;
                  const usd = (atlasByCcy.usd[r.ccy] ?? 0) * w;
                  const resid = (atlasByCcy.indiv[r.ccy] ?? r.varBeforeUsdM) * (1 - w);
                  const keep = w > 0.5;
                  return (
                    <tr
                      key={r.ccy}
                      className={`border-b border-slate-800/80 ${
                        included ? '' : 'opacity-50'
                      }`}
                    >
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={e => setMixCcyExcluded(r.ccy, !e.target.checked)}
                          aria-label={
                            included
                              ? `Remove ${r.ccy} from the book — no VaR/correlation contribution, re-solve the rest`
                              : `Bring ${r.ccy} back into the book`
                          }
                          className="h-3.5 w-3.5 cursor-pointer accent-emerald-500"
                        />
                      </td>
                      <td className="py-2 pr-3 font-semibold text-violet-200">{r.ccy}</td>
                      <td className="py-2 pr-3 font-mono text-emerald-300/90">
                        {formatHedgePct(w)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-slate-300">
                        {fmtSignedM(local)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-slate-300">
                        {fmtVarK(usd)}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono ${
                          locked >= 0 ? 'text-emerald-300/90' : 'text-rose-300/90'
                        }`}
                      >
                        {fmtVarK(locked)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-slate-400">
                        {fmtVarK(resid)}
                      </td>
                      <td
                        className={`py-2 font-medium ${
                          !included
                            ? 'text-slate-500'
                            : w <= 1e-6
                              ? 'text-orange-300'
                              : keep
                                ? 'text-emerald-300'
                                : 'text-sky-300'
                        }`}
                      >
                        {!included
                          ? 'Removed from book'
                          : w <= 1e-6
                            ? 'Leave open'
                            : keep
                              ? 'Keep hedge'
                              : `${formatHedgePct(w)} hedge`}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      <VarCurrencyStackChart
        unhedged={unhedgedVarStack}
        selected={{
          ...hedgedVarStack,
          label: mixTuned ? 'After mix' : hedgedVarStack.label,
          status: mixTuned ? 'TUNED' : hedgedVarStack.status,
        }}
        confidencePct={setup.confidencePct}
        horizon={shortHorizonLabel(
          VAR_HORIZON_OPTIONS.find(h => h.id === setup.horizon)?.label ?? setup.horizon,
        )}
        openCcy={chartCcy}
        onOpenCcy={openOptimizeCcy}
        selectedBook={unhedgedBookSelected ? 'unhedged' : 'selected'}
        onSelectUnhedged={() => {
          const point = atlasFrontier.unhedged;
          if (point) applyAtlasPoint(point);
        }}
        onSelectMix={() => {
          if (!unhedgedBookSelected) return;
          const point = atlasFrontier.sweet ?? atlasFrontier.fullyHedged;
          if (point) applyAtlasPoint(point);
        }}
        onSetAfterRatio={setMixWeight}
        beforeUsdByCcy={beforeUsdByCcy}
        onRestoreTune={restoreSelectedMix}
      />

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h3 className="text-base font-medium text-slate-100">
              {mixTuneMode === 'var' ? 'VaR contribution' : 'Carry contribution'}
            </h3>
            <span className="text-[11px] text-slate-500">
              Drag pins hedge % of Target · click the name to open the trade · uncheck to leave open and re-solve
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {forceOpenCcys.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setForceOpenCcys([]);
                  setAtlasSelectedId(null);
                }}
                className="text-[10px] font-semibold uppercase tracking-wide text-sky-300 hover:text-sky-200"
              >
                Include all
              </button>
            ) : null}
            <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-0.5">
              {(['var', 'carry'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setMixTuneMode(mode)}
                  className={`rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide ${
                    mixTuneMode === mode
                      ? 'bg-slate-700 text-slate-100'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {mode === 'var' ? 'VaR' : 'Carry'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {mixTuneMode === 'carry' ? (
          <MixStrip
            title="Carry mix"
            total={fmtVarK(
              mixTuneRows.reduce((s, r) => s + r.lockedCarryUsdM, 0),
            )}
            hint="Locked Tf swap points / CIP · right of 0 earns · left of 0 pays"
            rows={mixTuneRows.map(r => ({ ccy: r.ccy, usdM: r.lockedCarryUsdM }))}
            portAbs={mixTuneRows.reduce((s, r) => s + Math.abs(r.lockedCarryUsdM), 0)}
            signed
          />
        ) : null}

        <div className="mt-3 flex flex-col gap-1.5">
          {mixTuneRows.map(r => {
            const usdM =
              mixTuneMode === 'var' ? r.residVarUsdM : r.lockedCarryUsdM;
            const open = chartCcy === r.ccy;
            return (
              <div
                key={r.ccy}
                className={`flex items-center gap-2 rounded-lg px-1.5 py-0.5 ${
                  open ? 'bg-sky-500/10 ring-1 ring-inset ring-sky-400/30' : ''
                } ${r.included ? '' : 'opacity-50'}`}
              >
                <input
                  type="checkbox"
                  checked={r.included}
                  onChange={e => setMixCcyIncluded(r.ccy, e.target.checked)}
                  aria-label={
                    r.included
                      ? `Exclude ${r.ccy} from mix calibration`
                      : `Include ${r.ccy} in mix calibration`
                  }
                  className="h-3.5 w-3.5 flex-none cursor-pointer accent-emerald-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    const row = bookLiveRows.find(x => x.ccy === r.ccy);
                    if (!row) return;
                    openOptimizeCcy(r.ccy);
                  }}
                  className="w-11 flex-none text-left font-mono text-sm font-medium text-slate-100 hover:text-sky-200"
                >
                  {r.ccy}
                </button>
                <ContributionBar
                  usdM={usdM}
                  widthPct={r.hedgePct}
                  fullWidthPct={100}
                  tone={mixTuneMode === 'carry' ? 'bg-amber-300/90' : ccyBarTone(r.ccy)}
                  signed={mixTuneMode === 'carry'}
                  sign={usdM >= 0 ? 1 : -1}
                  onRatio={r.included ? pct => setMixWeight(r.ccy, pct) : undefined}
                />
                <span className="relative z-10 w-[4.5rem] flex-none text-right font-mono text-[11px] tabular-nums text-slate-200">
                  {fmtVarK(usdM)}
                </span>
                <span className="relative z-10 w-10 flex-none text-right font-mono text-[10px] text-slate-500">
                  {r.hedgePct}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-[12px] text-slate-500">
        Book tickets and send for approval are on the next steps — Optimize stays
        design-only (chart, scenarios, per-name VaR / carry).
      </p>
      </div>
      </>
      )}

      {fxWizard.step === 5 && (
      <>
      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
            Optimize mix · Book ticket
          </div>
          <div className="font-mono text-[11px] text-slate-300">
            {atlasScenarioLabel(
              atlasSelected,
              atlasFrontier.sweet?.id,
              atlasFrontier.fullyHedged?.id,
              atlasFrontier.unhedged?.id,
            )}
            {atlasSelected
              ? ` · VaR ${fmtVarK(atlasSelected.divVarUsdM)} · carry ${fmtVarK(atlasSelected.carryUsdYrM)}`
              : ''}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-slate-400">
          {liveRows
            .filter(r => r.ccy !== 'USD')
            .map(r => {
              const w = atlasSelected?.hedgeByCcy?.[r.ccy] ?? hedgeRatios[r.ccy] ?? 0;
              return (
                <span key={r.ccy}>
                  <span className="text-violet-200">{r.ccy}</span>
                  {' '}
                  <span className="text-emerald-300/90">{formatHedgePct(w)}</span>
                </span>
              );
            })}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Unhedged Div VaR"
          value={fmtVarK(atlasFrontier.unhedged?.divVarUsdM ?? fxVarFrontier.before.portfolioUsdM)}
          hint="Same as Optimize"
        />
        <Stat
          label="Mix Div VaR"
          value={fmtVarK(atlasSelected?.divVarUsdM ?? fxVarFrontier.after.portfolioUsdM)}
          hint={
            atlasSelected
              ? `Optimize point · same Div VaR`
              : 'No mix yet — same as open book'
          }
          accent
        />
        <Stat
          label="Mix carry"
          value={fmtVarK(atlasSelected?.carryUsdYrM ?? 0)}
          hint="Tf swap points / CIP locked at this mix"
        />
        <Stat
          label="VaR reduction"
          value={fmtVarK(
            (atlasFrontier.unhedged?.divVarUsdM ?? fxVarFrontier.before.portfolioUsdM)
              - (atlasSelected?.divVarUsdM ?? fxVarFrontier.after.portfolioUsdM),
          )}
          hint={
            (atlasFrontier.unhedged?.divVarUsdM ?? 0) > 1e-12
              ? `${(
                  (((atlasFrontier.unhedged?.divVarUsdM ?? 0)
                    - (atlasSelected?.divVarUsdM ?? 0))
                    / (atlasFrontier.unhedged?.divVarUsdM ?? 1))
                  * 100
                ).toFixed(0)}% cut vs unhedged`
              : '—'
          }
        />
      </div>

      <div className="space-y-3">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          Live VaR · implied σ · selected mix
          {atlasSelected
            ? ` · Resid VaR = Optimize Resid · Δ = 1−w`
            : hedged
              ? ' · after Hedging Decision'
              : ' · Δ = 1 (unhedged)'}
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
                  title="100% hedge base — same Target Optimize Cover is scaled from"
                >
                  Target N
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Exact Optimize weight of Target (not rounded)"
                >
                  Hedge %
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="w × Target — same as Optimize Cover local (exposure-signed)"
                >
                  Cover local
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Trade you buy (+) / sell (−). Opposite of Cover. JPY short book → buy yen."
                >
                  Hedge amount
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="CIP locked at this mix — same as Optimize Locked carry"
                >
                  Locked carry
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Resid / unhedged individual — 0 = fully offset, 1 = unhedged"
                >
                  Δ
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Target − Cover — residual local (100% Target → 0)"
                >
                  Residual
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Individual VaR of the open name (implied vol × tenor legs)"
                >
                  VaR @ Δ1
                </th>
                <th
                  className="py-2 font-medium"
                  title="Resid VaR = individual × (1−w) — same as Optimize Resid VaR"
                >
                  VaR after
                </th>
              </tr>
            </thead>
            <tbody>
              {bookLiveRows.map(r => {
                const selected = chartCcy === r.ccy;
                const mixDriven =
                  typeof hedgeRatios[r.ccy] === 'number'
                  && Number.isFinite(hedgeRatios[r.ccy]);
                const prep = preparedByCcy[r.ccy];
                const struct = structureTagFor(r.ccy, r.hedgeNotionalLocalM)
                  ?? (mixDriven ? 'bullet' : null);
                const legs = struct === 'strip' ? stripMetaByCcy[r.ccy]?.legs : undefined;
                const lockedCarry = atlasMixLockedCarryUsdM(
                  mixPoint,
                  r.ccy,
                  atlasByCcy.carry[r.ccy] ?? 0,
                  r.hedgeRatio,
                );
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
                  onClick={() => openOptimizeCcy(r.ccy)}
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
                            title="Hedge structure from staged Cash Carry / FX Risk / Decision package"
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
                        ) : prep?.preparedFor === 'liquidity' ? (
                          <span
                            className="text-[9px] font-semibold uppercase tracking-wide text-violet-300/90"
                            title="Staged from Liquidity Book — residual-Δ funding strip"
                          >
                            Liq
                          </span>
                        ) : null}
                      </span>
                      {isHedged ? (
                        <span
                          className="text-[9px] font-semibold uppercase tracking-wide text-emerald-400/90"
                          title={
                            prep
                              ? `Prepared ${
                                  prep.preparedFor === 'carry'
                                    ? 'Carry'
                                    : prep.preparedFor === 'liquidity'
                                      ? 'Liquidity'
                                      : 'VaR'
                                } package · Σ ${fmtSignedM(prep.coverLocalM)}`
                              : mixDriven
                                ? `Optimize mix · ${formatHedgePct(r.hedgeRatio)} of Target`
                                : 'Hedging regime: Stock (Cash) · VaR-neutral · Total (Target)'
                          }
                        >
                          {mixDriven
                            ? `${formatHedgePct(r.hedgeRatio)} mix`
                            : prep && !hasRollingStripForCcy(bookedHedges, r.ccy)
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
                  <td className="py-2 pr-3 font-mono text-violet-200/90">
                    {fmtSignedM(r.targetHedgeLocalM)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-emerald-300/90">
                    {formatHedgePct(r.hedgeRatio)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-300">
                    {fmtSignedM(r.hedgeNotionalLocalM)}
                  </td>
                  <td
                    className="py-2 pr-3 font-mono text-emerald-200"
                    title="Buy (+) / sell (−) local notional"
                  >
                    {fmtSignedM(-r.hedgeNotionalLocalM)}
                  </td>
                  <td
                    className={`py-2 pr-3 font-mono ${
                      lockedCarry >= 0 ? 'text-emerald-300/90' : 'text-rose-300/90'
                    }`}
                  >
                    {fmtVarK(lockedCarry)}
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

      <VarCurrencyStackChart
        unhedged={unhedgedVarStack}
        selected={hedgedVarStack}
        confidencePct={setup.confidencePct}
        horizon={shortHorizonLabel(
          VAR_HORIZON_OPTIONS.find(h => h.id === setup.horizon)?.label ?? setup.horizon,
        )}
        openCcy={chartCcy}
        onOpenCcy={openOptimizeCcy}
        selectedBook={unhedgedBookSelected ? 'unhedged' : 'selected'}
        onSetAfterRatio={setMixWeight}
        beforeUsdByCcy={beforeUsdByCcy}
        onRestoreTune={restoreSelectedMix}
      />
      </>
      )}

      {fxWizard.step === 6 && (
        <HedgeApprovalStep
          preparedByCcy={preparedByCcy}
          onPreparedByCcyChange={onPreparedByCcyChange}
          varUsdM={atlasSelected?.divVarUsdM ?? summary.totalVarAfterUsdM}
          emptyHint="The Optimize mix is staged as FX Risk tickets on Book. Send them for approval here."
        />
      )}

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
                {(() => {
                  const stagedPkg = preparedByCcy[chartCcy];
                  const selectedMixW = atlasSelected
                    ? (forceOpenCcys.includes(chartCcy)
                      ? 0
                      : (atlasSelected.hedgeByCcy?.[chartCcy] ?? 0))
                    : (mixWeightByCcy[chartCcy] ?? chartRow.hedgeRatio);
                  const offSelectedMix = Boolean(
                    atlasSelected && (
                      pathBasis !== 'totalExpected'
                      || chartStructure !== 'bullet'
                      || Math.abs((chartRow.hedgeRatio ?? 0) - selectedMixW) > 0.008
                    ),
                  );
                  const stagedDirty = Boolean(
                    stagedPkg
                    && pathSummaryMetrics
                    && pathChartDraftDirty(stagedPkg, pathSummaryMetrics),
                  );
                  const mixDraftChanged = offSelectedMix || stagedDirty;
                  const stageAction =
                    onPreparedByCcyChange
                      ? (pathPrepareAction
                        ?? {
                            label: 'Stage hedging strategy',
                            title:
                              'Stage this path — then Book under this CCY',
                            disabled: false,
                            run: () =>
                              bookHedgeProfile({
                                structure: chartStructure,
                                basis: pathBasis,
                                edges: [],
                                bulletSettleMonths:
                                  pathSummaryMetrics?.settleMonths,
                                coverPct: chartRow.hedgeRatio,
                              }),
                          })
                      : null;
                  return (
                <HedgeStagingHeader
                  titleId="exposure-path-title"
                  title={`${chartCcy} — hedge profile`}
                  subtitle={
                    <>
                      Structure:{' '}
                      <span className="font-semibold text-violet-200">
                        {chartStructure === 'strip' ? 'Strip' : 'Bullet'}
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
                    </>
                  }
                  chips={
                    pathSummaryMetrics
                      ? chipsFromPathSummary(pathSummaryMetrics)
                      : undefined
                  }
                  isPrebooked={Boolean(stagedPkg)}
                  draftDirty={mixDraftChanged && Boolean(stagedPkg)}
                  prepareAction={stageAction}
                  onReset={
                    atlasSelected && mixDraftChanged
                      ? resetCcyToSelectedMix
                      : !atlasSelected && stagedPkg && onPreparedByCcyChange
                        ? () =>
                            onPreparedByCcyChange(
                              clearPreparedHedgeForCcy(preparedByCcy, chartCcy),
                            )
                        : undefined
                  }
                  resetLabel={atlasSelected ? 'Reset to mix' : 'Reset'}
                  resetTitle={
                    atlasSelected
                      ? 'Restore the selected Optimize scenario (Target × mix %)'
                      : 'Clear staged package — Decision and Liquidity drop this CCY'
                  }
                  onClose={closePathChart}
                />
                  );
                })()}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
              <ExposureHedgePathChart
                key={`${chartRow.ccy}-${atlasSelected?.id ?? 'open'}-${mixResetNonce}-${setup.horizon}-${chartSizingSetup.horizon}-${setup.forecastMonths}-${setup.exposureBasis}-${hasRollingStripForCcy(bookedHedges, chartRow.ccy) ? 'strip' : 'open'}`}
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
                marketRates={resolveMarketRatesForCcy(
                  marketRatesByCcy,
                  chartRow.ccy,
                  ratesScopeId,
                )}
                appliedHedgeLocalM={chartRow.hedgeNotionalLocalM}
                hedgeRatio={chartRow.hedgeRatio}
                equalVarHedgeLocalM={chartRow.equalVarHedgeLocalM}
                endExposureM={chartRow.openExposureLocalM}
                selectedBasis={pathBasis}
                onSelectedBasisChange={setPathBasis}
                onApplyBasis={() => {}}
                onBookHedgeProfile={bookHedgeProfile}
                summaryMetricsPlacement="none"
                onSummaryMetricsChange={setPathSummaryMetrics}
                prepareCtaPlacement="external"
                onPrepareActionChange={setPathPrepareAction}
                lockOptimizeMix
                stripAlreadyBooked={
                  chartRow
                    ? hasRollingStripForCcy(bookedHedges, chartRow.ccy)
                    : false
                }
                hedgeStructure={chartStructure}
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
      </AnalyticsWizardShell>
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
