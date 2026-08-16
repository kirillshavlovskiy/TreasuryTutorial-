'use client';

import {
  cloneElement,
  isValidElement,
  useCallback,
  useState,
  useMemo,
  useEffect,
  type ReactElement,
  type ReactNode,
} from 'react';
import { BrandMark } from '@/components/BrandMark';
import { UnifiedSimulator } from '@/components/UnifiedSimulator';
import { BufferOptimizer } from '@/components/BufferOptimizer';
import { LayeredBufferAnalysis } from '@/components/LayeredBufferAnalysis';
import { HedgingDecisionPanel } from '@/components/HedgingDecisionPanel';
import { LiquiditySwapDecision } from '@/components/LiquiditySwapDecision';
import {
  resolveLiquidityTiming,
  DEFAULT_LIQUIDITY_TIMING,
  type LiquidityBookingMode,
  type LiquiditySizingBasis,
  type LiquidityTiming,
} from '@/lib/liquidity-ladder';
import { IRProfilePanel } from '@/components/IRProfilePanel';
import { computeDashboardModel, type FcyComputedRow } from '@/lib/dashboard-model';
import { livePlanByCcyFrom } from '@/lib/test-mode/liquidity-strategies';
import {
  INITIAL_ROWS,
  INITIAL_USD_PARAMS,
  type SharedGlobals,
  type RowState,
  type UsdParams,
  type LayerId,
} from '@/lib/fx-buffer';
import type {
  HedgeStrategy,
  SwapForwardOverlay,
} from '@/lib/fx-hedge';
import { analyticsForwardsFromOverlays } from '@/lib/fx-hedge';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
  type LiquidityCycleProjection,
} from '@/lib/forecast-profile';
import {
  applyBookedHedgePositions,
  hedgePositionOffsetsByCcy,
  fxTableRiskMetrics,
  stagedFxHedgeCarryByCcyUsdM,
  type HedgeTicket,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import {
  hedgeCashFlowsByMonth,
  cashForecastCarrySplitByCcyUsdM,
  withNonCashFxConversion,
} from '@/lib/test-mode/cash-carry-analytics';
import { fxHedgeNetCfarByCcyUsdM } from '@/lib/test-mode/cfar-net-by-ccy';
import {
  DEFAULT_VAR_SETUP,
  computeAnalyticsVarUsdM,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import type { FxInput } from '@/lib/workspace-store';

export type SimulatorTab =
  | 'simulator'
  | 'sensitivity'
  | 'layers'
  | 'irprofile'
  | 'hedging'
  | 'liveLadder'
  | 'analytics'
  | 'liquidity'
  | 'dataUpload'
  | 'monteCarlo';

const ALL_TABS: { id: SimulatorTab; label: string }[] = [
  { id: 'simulator',   label: 'FX Simulator' },
  { id: 'liquidity',   label: 'Liquidity' },
  { id: 'analytics',   label: 'Analytics' },
  { id: 'hedging',     label: 'Hedging Decision' },
  { id: 'liveLadder',  label: 'Consolidated Live Ladder' },
  { id: 'dataUpload',  label: 'Market data' },
  { id: 'sensitivity', label: 'Sensitivity Analysis' },
  { id: 'layers',      label: 'Layer Setup' },
  { id: 'irprofile',   label: 'IR Profile' },
  { id: 'monteCarlo',  label: 'Monte Carlo' },
];

const SHARED_DEFAULTS: SharedGlobals = {
  r_USD: 3.50,
  σ_P:   0.10,
  days:  3,
  forecastMonths: 12,
};

interface SimulatorProps {
  accountMenu?: ReactNode;
  title?: string;
  subtitle?: string;
  currencyFilter?: string[];
  initialRows?: RowState[];
  initialUsdCash?: number;
  initialUsdNonLpCash?: number;
  initialUsdParams?: Partial<UsdParams>;
  initialActiveLayers?: LayerId[];
  fxInputs?: FxInput[];
  timing?: { fPayout: number; fPayin: number };
  formulas?: Record<string, string>;
  /** Persisted forecast profile (flows, extras, growth, liquidity path). */
  forecastProfile?: ForecastProfileState;
  onForecastProfileChange?: (profile: ForecastProfileState) => void;
  onFormulaChange?: (cellKey: string, formula: string) => void;
  /** Batch formula writes for Excel-like column fill-down. */
  onFormulaChanges?: (updates: Record<string, string>) => void;
  embedded?: boolean;
  hiddenTabs?: SimulatorTab[];
  /**
   * Hide rates toolbar layers, swap, FX hedge cols, carry, and P&L
   * (Sigma Task simplified FX book).
   */
  simplifiedBook?: boolean;
  /** Show Risk Metrics (VaR) columns before P&L. */
  showRiskMetrics?: boolean;
  hedgingPanel?: ReactNode;
  /** Consolidated Live Ladder tab (stacked exposure vs hedges). */
  liveLadderPanel?: ReactNode;
  /** Analytics tab — VaR confidence setup. */
  analyticsPanel?: ReactNode;
  /** Market data tab — overnight cash, term deposits, EURUSD swap points. */
  dataUploadPanel?: ReactNode;
  /** Analytics VaR setup for Risk Metrics columns. */
  varSetup?: VarSetup;
  /** Sync FX Risk forecast period (and default VaR month) into parent answers. */
  onVarSetupChange?: (setup: VarSetup) => void;
  /** Decision-layer booked spot/forward hedges — drive FX table VaR. */
  bookedHedges?: HedgeTicket[];
  /** Staged hedge packages — settle in the liquidity path alongside booked legs. */
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  /** Per-CCY JPM / uploaded curves — Cash Carry P&L on the liquidity table. */
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  ratesScopeId?: string | null;
  /** Incremental hedge % on remaining net book (synced with Hedging Decision). */
  hedgeRatios?: Record<string, number>;
  tabLabels?: Partial<Record<SimulatorTab, string>>;
  /**
   * Publish live FX book + forecast schedule so Analytics / Decision can
   * recompute VaR on custom uneven month paths.
   */
  onAnalyticsBookChange?: (book: {
    rows: RowState[];
    forecastProfile: ForecastProfileState;
  }) => void;
  /**
   * Liquidity tab book mode for Workbench desks:
   * - curriculum — locked carry/liquidity book (hedges stay on FX Risk)
   * - fullSimulator — editable liquidity book (no FX position / hedge columns)
   */
  liquidityMode?: 'curriculum' | 'fullSimulator';
}

function hedgeSettleByCcyFrom(input: {
  rows: readonly RowState[];
  forecastMonths: number;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  varSetup: VarSetup;
  forecastProfile?: ForecastProfileState | null;
}): Record<string, number[]> {
  const months = input.forecastMonths;
  if (!(months > 0)) return {};
  const map: Record<string, number[]> = {};
  for (const r of input.rows) {
    const flows = withNonCashFxConversion(
      r,
      hedgeCashFlowsByMonth({
        ccy: r.ccy,
        forecastMonths: months,
        bookedHedges: input.bookedHedges,
        preparedByCcy: input.preparedByCcy,
        setup: input.varSetup,
      }),
      months,
      input.forecastProfile,
    );
    if (flows.some(f => Math.abs(f) > 1e-9)) map[r.ccy] = flows;
  }
  return map;
}

export function Simulator({
  accountMenu,
  title,
  subtitle,
  currencyFilter,
  initialRows,
  initialUsdCash,
  initialUsdNonLpCash,
  initialUsdParams,
  initialActiveLayers,
  fxInputs,
  timing,
  formulas,
  forecastProfile: forecastProfileProp,
  onForecastProfileChange,
  onFormulaChange,
  onFormulaChanges,
  embedded = false,
  hiddenTabs = [],
  simplifiedBook = false,
  showRiskMetrics = false,
  hedgingPanel,
  liveLadderPanel,
  analyticsPanel,
  dataUploadPanel,
  varSetup = DEFAULT_VAR_SETUP,
  onVarSetupChange,
  bookedHedges = [],
  preparedByCcy,
  marketRatesByCcy,
  ratesScopeId,
  tabLabels,
  onAnalyticsBookChange,
  liquidityMode = 'curriculum',
}: SimulatorProps) {
  // Task Mode simplified book: never expose Sensitivity / Layer Setup / IR Profile.
  // Live Ladder + Analytics + Liquidity + Market data are Task Mode only — hide in the full book unless shown.
  const effectiveHiddenTabs = simplifiedBook
    ? Array.from(new Set<SimulatorTab>([...hiddenTabs, 'sensitivity', 'layers', 'irprofile']))
    : Array.from(
        new Set<SimulatorTab>([
          ...hiddenTabs,
          'liveLadder',
          'analytics',
          'liquidity',
          'dataUpload',
        ]),
      );
  const tabs = ALL_TABS.filter(t => !effectiveHiddenTabs.includes(t.id)).map(t => ({
    ...t,
    label: tabLabels?.[t.id] ?? t.label,
  }));
  const [tab, setTab] = useState<SimulatorTab>('simulator');
  const [shared, setShared] = useState<SharedGlobals>(() => ({
    ...SHARED_DEFAULTS,
    forecastMonths: varSetup.forecastMonths ?? 1,
  }));

  // Keep Net FX Forecast period aligned with Analytics / answers forecast months.
  useEffect(() => {
    const m =
      typeof varSetup.forecastMonths === 'number' && varSetup.forecastMonths >= 0
        ? varSetup.forecastMonths
        : 1;
    setShared(s => (s.forecastMonths === m ? s : { ...s, forecastMonths: m }));
  }, [varSetup.forecastMonths]);

  const activeTab = tabs.some(t => t.id === tab) ? tab : (tabs[0]?.id ?? 'simulator');

  /** Snapshot at mount — Reset table restores this book, not the full workbench catalog. */
  const [seed] = useState(() => {
    const rows = initialRows
      ? initialRows.map(r => ({ ...r }))
      : currencyFilter && currencyFilter.length > 0
        ? INITIAL_ROWS.filter(r => currencyFilter.includes(r.ccy)).map(r => ({ ...r }))
        : INITIAL_ROWS.map(r => ({ ...r }));
    return {
      rows,
      usdCash: initialUsdCash ?? 303.9,
      usdNonLpCash: initialUsdNonLpCash ?? 154.1,
      usdParams: { ...INITIAL_USD_PARAMS, ...initialUsdParams } as UsdParams,
    };
  });
  const [rows,      setRows]      = useState<RowState[]>(() => seed.rows.map(r => ({ ...r })));
  const [usdCash,      setUsdCash]      = useState(seed.usdCash);
  const [usdNonLpCash, setUsdNonLpCash] = useState(seed.usdNonLpCash);
  const [usdParams, setUsdParams] = useState<UsdParams>(() => ({ ...seed.usdParams }));
  // Persisted when the host supplies a writer. Group consolidated passes a
  // merged profile with no writer — treat that as uncontrolled so Swap funding
  // toggles (One term swap / sizing) still stick instead of writing into a
  // local copy the render never reads.
  const [localForecastProfile, setLocalForecastProfile] =
    useState<ForecastProfileState>(() => ({
      ...(forecastProfileProp ?? {
        ...DEFAULT_FORECAST_PROFILE,
        byCcy: {},
        extrasByCcy: {},
        formulas: {},
      }),
    }));
  const forecastProfile =
    onForecastProfileChange && forecastProfileProp
      ? forecastProfileProp
      : localForecastProfile;
  const setForecastProfile = useCallback(
    (next: ForecastProfileState) => {
      setLocalForecastProfile(next);
      onForecastProfileChange?.(next);
    },
    [onForecastProfileChange],
  );
  const [forecastProfileOpen, setForecastProfileOpen] = useState(false);
  const [hedgeStrategy, setHedgeStrategy] = useState<HedgeStrategy>('SWAP_ONLY');
  /** Replacement Δ keyed by row id — default 1 when missing. */
  const [swapForwardDeltaByRowId, setSwapForwardDeltaByRowId] = useState<
    Record<string, number>
  >({});
  const [optionDeltaByRowId, setOptionDeltaByRowId] = useState<
    Record<string, number>
  >({});
  const [swapForwardOverlayByCcy, setSwapForwardOverlayByCcy] = useState<
    Record<string, SwapForwardOverlay>
  >({});

  const liquidityTiming =
    resolveLiquidityTiming(forecastProfile) ?? DEFAULT_LIQUIDITY_TIMING;
  const updateLiquidityTiming = useCallback(
    (patch: Partial<LiquidityTiming>) => {
      setForecastProfile({
        ...forecastProfile,
        liquidity: { ...liquidityTiming, ...patch },
      });
    },
    [setForecastProfile, forecastProfile, liquidityTiming],
  );

  useEffect(() => {
    onAnalyticsBookChange?.({ rows, forecastProfile });
  }, [rows, forecastProfile, onAnalyticsBookChange]);

  const onResetTable = () => {
    setRows(seed.rows.map(r => ({ ...r })));
    setUsdCash(seed.usdCash);
    setUsdNonLpCash(seed.usdNonLpCash);
    setUsdParams({ ...seed.usdParams });
    setForecastProfile({ ...DEFAULT_FORECAST_PROFILE, byCcy: {}, formulas: {} });
  };

  const [policyVAR, setPolicyVAR] = useState(5.0);

  // No layer until one is chosen: with no liquidity rule on the desk holds the
  // book, so a structural gap is priced through carry instead of being funded by
  // a swap the policy never asked for.
  const [activeLayers, setActiveLayers] = useState<Set<LayerId>>(
    () => new Set((initialActiveLayers ?? []) as LayerId[])
  );
  const onLayerToggle = (id: LayerId) =>
    setActiveLayers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onSharedChange = (key: keyof SharedGlobals, value: number) =>
    setShared(s => ({ ...s, [key]: value }));

  const onRowFieldChange = (
    ccy: string,
    field: keyof Omit<RowState, 'id' | 'ccy'>,
    value: number,
  ) => setRows(prev => prev.map(r => r.ccy === ccy ? { ...r, [field]: value } : r));

  // Overlay booked + staged Decision-layer spot/forward into FX POSITION
  // (FWD / Hedge columns). Risk Metrics still uses the unadjusted book +
  // live tickets separately (no double-count). Staged FCY settlement lands
  // on the liquidity path and sizes the funding swap with the buffer layers.
  const displayRows = useMemo(
    () => applyBookedHedgePositions(rows, bookedHedges, preparedByCcy),
    [rows, bookedHedges, preparedByCcy],
  );
  const bookedPositionByCcy = useMemo(
    () => hedgePositionOffsetsByCcy(bookedHedges, preparedByCcy),
    [bookedHedges, preparedByCcy],
  );
  const analyticsExtraForwards = useMemo(
    () =>
      analyticsForwardsFromOverlays({
        overlayByCcy: swapForwardOverlayByCcy,
        forecastMonths: shared.forecastMonths ?? varSetup.forecastMonths ?? 12,
      }),
    [
      swapForwardOverlayByCcy,
      shared.forecastMonths,
      varSetup.forecastMonths,
    ],
  );

  const cashForecastCarryByCcy = useMemo(
    () =>
      cashForecastCarrySplitByCcyUsdM({
        rows,
        forecastProfile,
        forecastMonths: shared.forecastMonths ?? varSetup.forecastMonths ?? 12,
        bookedHedges,
        preparedByCcy,
        setup: varSetup,
        marketRatesByCcy,
        ratesScopeId,
        extraForwards: analyticsExtraForwards,
      }),
    [
      rows,
      forecastProfile,
      shared.forecastMonths,
      varSetup,
      bookedHedges,
      preparedByCcy,
      marketRatesByCcy,
      ratesScopeId,
      analyticsExtraForwards,
    ],
  );
  const stagedCashCarryByCcyUsdM = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [ccy, split] of Object.entries(cashForecastCarryByCcy)) {
      map[ccy] = split.cashUsdM;
    }
    return map;
  }, [cashForecastCarryByCcy]);
  const stagedHedgeCarryByCcyUsdM = useMemo(() => {
    const map = stagedFxHedgeCarryByCcyUsdM(preparedByCcy);
    for (const [ccy, split] of Object.entries(cashForecastCarryByCcy)) {
      map[ccy] = split.fwdUsdM;
    }
    return map;
  }, [preparedByCcy, cashForecastCarryByCcy]);
  const stagedCarryByMonthByCcyUsdM = useMemo(() => {
    const map: Record<string, { cashUsdM: number; fwdUsdM: number }[]> = {};
    for (const [ccy, split] of Object.entries(cashForecastCarryByCcy)) {
      map[ccy] = split.byMonth;
    }
    return map;
  }, [cashForecastCarryByCcy]);

  // Booked + staged FCY legs — the same schedule the cash path and SWAP
  // band answer. Buffer layers size H* / Swap near against this path.
  const hedgeSettleByCcy = useMemo(
    () =>
      hedgeSettleByCcyFrom({
        rows,
        forecastMonths: shared.forecastMonths ?? 1,
        bookedHedges,
        preparedByCcy,
        varSetup,
        forecastProfile,
      }),
    [rows, shared.forecastMonths, bookedHedges, preparedByCcy, varSetup, forecastProfile],
  );

  // FX-hedge Net CFaR (MC size+timing) including staged packages — CFaR cover
  // sizes off this number. The funding swap is not an input (no loop).
  const cfarNetByCcyUsd = useMemo(
    () => fxHedgeNetCfarByCcyUsdM({
      rows,
      setup: varSetup,
      forecastProfile,
      bookedHedges,
      preparedByCcy,
    }),
    [rows, varSetup, forecastProfile, bookedHedges, preparedByCcy],
  );

  const dashboard = useMemo(
    () => computeDashboardModel({
      rows: displayRows,
      usdCash,
      usdNonLpCash,
      usdParams,
      shared,
      activeLayers,
      policyVAR,
      timing,
      forecastProfile,
      hedgeSettleByCcy,
      cfarNetByCcyUsd,
    }),
    [
      displayRows,
      usdCash,
      usdNonLpCash,
      usdParams,
      shared,
      activeLayers,
      policyVAR,
      timing,
      forecastProfile,
      hedgeSettleByCcy,
      cfarNetByCcyUsd,
    ],
  );

  const livePlanByCcy = useMemo(
    () => livePlanByCcyFrom(dashboard.fcyComputed),
    [dashboard.fcyComputed],
  );

  const riskMetricsByCcy = useMemo(() => {
    if (!showRiskMetrics) return {};
    const map: Record<
      string,
      {
        exposureLocalM: number;
        residualLocalM: number;
        varUsdM: number;
        varBeforeUsdM: number;
        spotHedgeLocalM: number;
        forwardHedgeLocalM: number;
        /** Gross VaR of the Swap+Fwd outright forward alone (when strategy applies). */
        grossForwardVarUsdM?: number;
      }
    > = {};
    // Booked tickets only — Decision-layer Hedge-add % must not zero Residual/VaR
    // while Spot/Fwd columns stay empty (staging belongs on Hedging Decision).
    for (const m of fxTableRiskMetrics(rows, varSetup, bookedHedges, {}, forecastProfile)) {
      map[m.ccy] = {
        exposureLocalM: m.exposureLocalM,
        residualLocalM: m.residualLocalM,
        varUsdM: m.varUsdM,
        varBeforeUsdM: m.varBeforeUsdM,
        spotHedgeLocalM: m.spotHedgeLocalM,
        forwardHedgeLocalM: m.forwardHedgeLocalM,
      };
    }
    // Swap+Fwd desk overlay: gross forward VaR + economically net residual/VaR.
    if (hedgeStrategy === 'SWAP_FWD') {
      for (const row of rows) {
        if (row.ccy === 'USD') continue;
        const overlay = swapForwardOverlayByCcy[row.ccy];
        if (!overlay) continue;
        const cell = map[row.ccy];
        if (!cell) continue;
        const F = overlay.forwardLocalM;
        // Strategy fwd is already hedge-signed (negative when selling long FCY).
        cell.forwardHedgeLocalM = F;
        // Complete structure nets to 0 directional FX (E + S + F + RemainingFar = 0).
        cell.residualLocalM = overlay.finalNetLocalM;
        cell.grossForwardVarUsdM = computeAnalyticsVarUsdM(
          Math.abs(F),
          0,
          row.ccy,
          varSetup,
        );
        cell.varUsdM = computeAnalyticsVarUsdM(
          Math.abs(overlay.finalNetLocalM),
          0,
          row.ccy,
          varSetup,
        );
      }
    }
    return map;
  }, [
    rows,
    showRiskMetrics,
    varSetup,
    bookedHedges,
    forecastProfile,
    hedgeStrategy,
    swapForwardOverlayByCcy,
  ]);

  const showRates       = !simplifiedBook && (!fxInputs || fxInputs.includes('rates'));
  const showFxPosition  = !fxInputs || fxInputs.includes('fxExposure');
  const showLiquidity   = !simplifiedBook && (!fxInputs || fxInputs.includes('liquidity'));
  const showBonds       = !simplifiedBook && !!fxInputs && fxInputs.includes('bonds');
  const showInvestments = !simplifiedBook && !!fxInputs && fxInputs.includes('investments');
  const showLiabilities = !simplifiedBook && !!fxInputs && fxInputs.includes('liabilities');

  return (
    <div className={embedded ? 'sim-dark' : 'min-h-screen bg-gray-50'}>
      {!embedded && (
        <header className="border-b border-gray-200 bg-white shadow-sm">
          <div className="mx-auto max-w-screen-2xl px-6 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <BrandMark
                  tone="light"
                  label={subtitle ?? title ?? 'Treasury Workbench'}
                />
              </div>
              {accountMenu}
            </div>
          </div>
        </header>
      )}

      {tabs.length > 1 && (
        <nav className="border-b border-gray-200 bg-white">
          <div className="mx-auto max-w-screen-2xl px-6">
            <div className="flex gap-0">
              {tabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`
                    relative border-b-2 px-5 py-3 text-sm font-medium transition-colors
                    ${activeTab === t.id
                      ? 'border-blue-600 text-blue-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
                  `}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </nav>
      )}

      <main className="mx-auto max-w-screen-2xl px-6 py-6">
        {!effectiveHiddenTabs.includes('simulator') && (
          <div className={activeTab === 'simulator' ? '' : 'hidden'}>
            <UnifiedSimulator
              shared={shared}           onSharedChange={onSharedChange}
              rows={rows}               setRows={setRows}
              usdCash={usdCash}         setUsdCash={setUsdCash}
              usdNonLpCash={usdNonLpCash} setUsdNonLpCash={setUsdNonLpCash}
              usdParams={usdParams}     setUsdParams={setUsdParams}
              onResetTable={onResetTable}
              activeLayers={activeLayers}
              onLayerToggle={onLayerToggle}
              policyVAR={policyVAR}
              onPolicyVARChange={setPolicyVAR}
              portfolioSummary={dashboard.portfolioSummary}
              fcyComputed={dashboard.fcyComputed}
              usdComputed={dashboard.usdComputed}
              showRates={showRates}
              showFxPosition={showFxPosition}
              showLiquidity={showLiquidity}
              showBonds={showBonds}
              showInvestments={showInvestments}
              showLiabilities={showLiabilities}
              showAdvancedBook={!simplifiedBook}
              showRiskMetrics={showRiskMetrics}
              riskMetricsByCcy={riskMetricsByCcy}
              bookedPositionByCcy={bookedPositionByCcy}
              hedgeSettleByCcy={hedgeSettleByCcy}
              stagedHedgeCarryByCcyUsdM={stagedHedgeCarryByCcyUsdM}
              stagedCashCarryByCcyUsdM={stagedCashCarryByCcyUsdM}
              stagedCarryByMonthByCcyUsdM={stagedCarryByMonthByCcyUsdM}
              cfarNetByCcyUsd={cfarNetByCcyUsd}
              varSetup={varSetup}
              onVarSetupChange={onVarSetupChange}
              forecastProfile={forecastProfile}
              onForecastProfileChange={setForecastProfile}
              // Both tabs stay mounted — only the active one owns the modal.
              forecastProfileOpen={forecastProfileOpen && activeTab === 'simulator'}
              onForecastProfileOpenChange={setForecastProfileOpen}
              simDark={embedded}
              formulas={formulas}
              onFormulaChange={onFormulaChange}
              onFormulaChanges={onFormulaChanges}
              hedgeStrategy={hedgeStrategy}
              onHedgeStrategyChange={setHedgeStrategy}
              swapForwardDeltaByCcy={swapForwardDeltaByRowId}
              onSwapForwardDeltaByCcyChange={setSwapForwardDeltaByRowId}
              optionDeltaByCcy={optionDeltaByRowId}
              onOptionDeltaByCcyChange={setOptionDeltaByRowId}
              onSwapForwardOverlayByCcyChange={setSwapForwardOverlayByCcy}
              marketRatesByCcy={marketRatesByCcy}
              ratesScopeId={ratesScopeId}
            />
          </div>
        )}
        {!effectiveHiddenTabs.includes('sensitivity') && (
          <div className={activeTab === 'sensitivity' ? '' : 'hidden'}>
            <BufferOptimizer shared={shared} onSharedChange={onSharedChange} />
          </div>
        )}
        {!effectiveHiddenTabs.includes('layers') && (
          <div className={activeTab === 'layers' ? '' : 'hidden'}>
            <LayeredBufferAnalysis
              shared={shared}             onSharedChange={onSharedChange}
              simRows={rows}              onRowFieldChange={onRowFieldChange}
              activeLayers={activeLayers} onLayerToggle={onLayerToggle}
              layerRows={dashboard.layerRows}
              policyVAR={policyVAR}       onPolicyVARChange={setPolicyVAR}
              usdCash={usdCash}           onUsdCashChange={setUsdCash}
              usdPayout={usdParams.payout} onUsdPayoutChange={v => setUsdParams(p => ({ ...p, payout: v }))}
              usdNonLpCash={usdNonLpCash}
            />
          </div>
        )}
        {!effectiveHiddenTabs.includes('irprofile') && (
          <div className={activeTab === 'irprofile' ? '' : 'hidden'}>
            <IRProfilePanel
              rows={rows}           setRows={setRows}
              usdParams={usdParams} setUsdParams={setUsdParams}
              usdCash={usdCash}     shared={shared}
            />
          </div>
        )}
        {!effectiveHiddenTabs.includes('hedging') && (
          <div className={activeTab === 'hedging' ? 'space-y-4' : 'hidden'}>
            {hedgingPanel && isValidElement(hedgingPanel)
              ? cloneElement(
                  hedgingPanel as ReactElement<{
                    bookRows?: RowState[];
                    forecastProfile?: ForecastProfileState;
                    fcyComputed?: FcyComputedRow[];
                    r_USD?: number;
                    sizingBasis?: LiquiditySizingBasis;
                    bookingMode?: LiquidityBookingMode;
                    forecastMonths?: number;
                    onSizingBasisChange?: (v: LiquiditySizingBasis) => void;
                    onBookingModeChange?: (v: LiquidityBookingMode) => void;
                  }>,
                  {
                    // Same live-injection pattern as Analytics/Liquidity tabs
                    // below — without it this tab was stuck on whatever
                    // bookRows/forecastProfile Task01App had at its last
                    // render, lagging the Cash/Analytics/Liquidity tabs
                    // which read Simulator's `rows` state directly.
                    bookRows: rows,
                    forecastProfile,
                    fcyComputed: dashboard.fcyComputed,
                    r_USD: shared.r_USD,
                    sizingBasis: liquidityTiming.sizingBasis ?? 'horizon',
                    bookingMode: liquidityTiming.bookingMode ?? 'rolling',
                    forecastMonths: shared.forecastMonths ?? 1,
                    onSizingBasisChange: v => updateLiquidityTiming({ sizingBasis: v }),
                    onBookingModeChange: v => updateLiquidityTiming({ bookingMode: v }),
                  },
                )
              : (
                <>
                  {hedgingPanel ?? <HedgingDecisionPanel r_USD={shared.r_USD} />}
                  <LiquiditySwapDecision
                    rows={dashboard.fcyComputed}
                    r_USD={shared.r_USD}
                    sizingBasis={liquidityTiming.sizingBasis ?? 'horizon'}
                    bookingMode={liquidityTiming.bookingMode ?? 'rolling'}
                    forecastMonths={shared.forecastMonths ?? 1}
                    onSizingBasisChange={v => updateLiquidityTiming({ sizingBasis: v })}
                    onBookingModeChange={v => updateLiquidityTiming({ bookingMode: v })}
                    embedded={embedded}
                  />
                </>
              )}
          </div>
        )}
        {!effectiveHiddenTabs.includes('liveLadder') && (
          <div className={activeTab === 'liveLadder' ? '' : 'hidden'}>
            {liveLadderPanel && isValidElement(liveLadderPanel)
              ? cloneElement(
                  liveLadderPanel as ReactElement<{
                    rows?: RowState[];
                    forecastProfile?: ForecastProfileState;
                  }>,
                  {
                    // Same live-injection pattern as Analytics/Liquidity —
                    // this tab was also stuck on Task01App's last-rendered
                    // rows/forecastProfile instead of Simulator's live state.
                    rows,
                    forecastProfile,
                  },
                )
              : (liveLadderPanel ?? (
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
                <h3 className="text-sm font-semibold text-gray-800">Consolidated Live Ladder</h3>
                <p className="mt-2 text-xs text-gray-500">
                  Stacked exposure vs hedges — available in Test Mode Group / entity FX dashboards.
                </p>
              </div>
            ))}
          </div>
        )}
        {!effectiveHiddenTabs.includes('analytics') && (
          <div className={activeTab === 'analytics' ? '' : 'hidden'}>
            {analyticsPanel && isValidElement(analyticsPanel)
              ? cloneElement(
                  analyticsPanel as ReactElement<{
                    bookRows?: RowState[];
                    forecastProfile?: ForecastProfileState;
                    onForecastProfileChange?: (
                      profile: ForecastProfileState,
                    ) => void;
                    onOpenForecastProfile?: () => void;
                    activeLayers?: Set<LayerId>;
                    livePlanByCcy?: Readonly<
                      Record<string, readonly LiquidityCycleProjection[]>
                    >;
                    cfarNetByCcyUsd?: Record<string, number>;
                    swapForwardOverlayByCcy?: Record<string, SwapForwardOverlay>;
                  }>,
                  {
                    bookRows: rows,
                    forecastProfile,
                    onForecastProfileChange: setForecastProfile,
                    onOpenForecastProfile: () => setForecastProfileOpen(true),
                    activeLayers,
                    livePlanByCcy,
                    cfarNetByCcyUsd,
                    swapForwardOverlayByCcy,
                  },
                )
              : (analyticsPanel ?? (
                  <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
                    <h3 className="text-sm font-semibold text-gray-800">Analytics</h3>
                    <p className="mt-2 text-xs text-gray-500">
                      VaR confidence setup — available in Test Mode Group / entity FX dashboards.
                    </p>
                  </div>
                ))}
          </div>
        )}
        {!effectiveHiddenTabs.includes('liquidity') && (
          <div className={activeTab === 'liquidity' ? '' : 'hidden'}>
            {/*
              Liquidity book: path + Carry/Buffer + FX HEDGE.
              FX POSITION and IR / FIXED-RATE BOOK stay on FX Risk / IR Profile.
              fullSimulator keeps the book editable (Workbench); curriculum locks it.
            */}
            <UnifiedSimulator
              shared={shared}           onSharedChange={onSharedChange}
              rows={rows}               setRows={setRows}
              usdCash={usdCash}         setUsdCash={setUsdCash}
              usdNonLpCash={usdNonLpCash} setUsdNonLpCash={setUsdNonLpCash}
              usdParams={usdParams}     setUsdParams={setUsdParams}
              onResetTable={onResetTable}
              activeLayers={activeLayers}
              onLayerToggle={onLayerToggle}
              policyVAR={policyVAR}
              onPolicyVARChange={setPolicyVAR}
              portfolioSummary={dashboard.portfolioSummary}
              fcyComputed={dashboard.fcyComputed}
              usdComputed={dashboard.usdComputed}
              showRates
              showFxPosition={false}
              showLiquidity
              showBonds={false}
              showInvestments={false}
              showLiabilities={false}
              showAdvancedBook
              lockValues={liquidityMode !== 'fullSimulator'}
              pnlColumns="carryOnly"
              bookedPositionByCcy={bookedPositionByCcy}
              hedgeSettleByCcy={hedgeSettleByCcy}
              stagedHedgeCarryByCcyUsdM={stagedHedgeCarryByCcyUsdM}
              stagedCashCarryByCcyUsdM={stagedCashCarryByCcyUsdM}
              stagedCarryByMonthByCcyUsdM={stagedCarryByMonthByCcyUsdM}
              cfarNetByCcyUsd={cfarNetByCcyUsd}
              varSetup={varSetup}
              onVarSetupChange={onVarSetupChange}
              forecastProfile={forecastProfile}
              onForecastProfileChange={setForecastProfile}
              forecastProfileOpen={forecastProfileOpen && activeTab === 'liquidity'}
              onForecastProfileOpenChange={setForecastProfileOpen}
              simDark={embedded}
              formulas={formulas}
              onFormulaChange={onFormulaChange}
              onFormulaChanges={onFormulaChanges}
              hedgeStrategy={hedgeStrategy}
              onHedgeStrategyChange={setHedgeStrategy}
              swapForwardDeltaByCcy={swapForwardDeltaByRowId}
              onSwapForwardDeltaByCcyChange={setSwapForwardDeltaByRowId}
              optionDeltaByCcy={optionDeltaByRowId}
              onOptionDeltaByCcyChange={setOptionDeltaByRowId}
              onSwapForwardOverlayByCcyChange={setSwapForwardOverlayByCcy}
              marketRatesByCcy={marketRatesByCcy}
              ratesScopeId={ratesScopeId}
            />
          </div>
        )}
        {!effectiveHiddenTabs.includes('dataUpload') && (
          <div className={activeTab === 'dataUpload' ? '' : 'hidden'}>
            {dataUploadPanel ?? (
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
                <h3 className="text-sm font-semibold text-gray-800">Market data</h3>
                <p className="mt-2 text-xs text-gray-500">
                  Overnight cash, term deposits, and EURUSD swap points — available in Test Mode Group / entity FX dashboards.
                </p>
              </div>
            )}
          </div>
        )}
        {!effectiveHiddenTabs.includes('monteCarlo') && (
          <div className={activeTab === 'monteCarlo' ? '' : 'hidden'}>
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
              <h3 className="text-sm font-semibold text-gray-800">Monte Carlo analysis</h3>
              <p className="mt-2 text-xs text-gray-500">
                Stochastic path simulation for FX exposure — coming soon as an Analytical layer.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
