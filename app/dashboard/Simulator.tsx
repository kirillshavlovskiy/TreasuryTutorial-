'use client';

import {
  cloneElement,
  isValidElement,
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
import { IRProfilePanel } from '@/components/IRProfilePanel';
import { computeDashboardModel } from '@/lib/dashboard-model';
import {
  INITIAL_ROWS,
  INITIAL_USD_PARAMS,
  type SharedGlobals,
  type RowState,
  type UsdParams,
  type LayerId,
} from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import {
  applyBookedHedgePositions,
  bookedPositionOffsetsByCcy,
  fxTableRiskMetrics,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import { DEFAULT_VAR_SETUP, type VarSetup } from '@/lib/test-mode/var-setup';
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
  forecastMonths: 1,
};

interface SimulatorProps {
  accountMenu?: ReactNode;
  title?: string;
  subtitle?: string;
  currencyFilter?: string[];
  initialRows?: RowState[];
  initialUsdCash?: number;
  initialUsdNonNpCash?: number;
  initialUsdParams?: Partial<UsdParams>;
  initialActiveLayers?: LayerId[];
  fxInputs?: FxInput[];
  timing?: { fPayout: number; fPayin: number };
  formulas?: Record<string, string>;
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
}

const ALL_LAYERS: LayerId[] = ['sigmaP', 'carryOptim', 'floorH', 'portfolioDiv'];

export function Simulator({
  accountMenu,
  title,
  subtitle,
  currencyFilter,
  initialRows,
  initialUsdCash,
  initialUsdNonNpCash,
  initialUsdParams,
  initialActiveLayers,
  fxInputs,
  timing,
  formulas,
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
  tabLabels,
  onAnalyticsBookChange,
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
      usdNonNpCash: initialUsdNonNpCash ?? 154.1,
      usdParams: { ...INITIAL_USD_PARAMS, ...initialUsdParams } as UsdParams,
    };
  });
  const [rows,      setRows]      = useState<RowState[]>(() => seed.rows.map(r => ({ ...r })));
  const [usdCash,      setUsdCash]      = useState(seed.usdCash);
  const [usdNonNpCash, setUsdNonNpCash] = useState(seed.usdNonNpCash);
  const [usdParams, setUsdParams] = useState<UsdParams>(() => ({ ...seed.usdParams }));
  const [forecastProfile, setForecastProfile] = useState<ForecastProfileState>(
    () => ({
      ...DEFAULT_FORECAST_PROFILE,
      byCcy: {},
      extrasByCcy: {},
      formulas: {},
    }),
  );
  const [forecastProfileOpen, setForecastProfileOpen] = useState(false);

  useEffect(() => {
    onAnalyticsBookChange?.({ rows, forecastProfile });
  }, [rows, forecastProfile, onAnalyticsBookChange]);

  const onResetTable = () => {
    setRows(seed.rows.map(r => ({ ...r })));
    setUsdCash(seed.usdCash);
    setUsdNonNpCash(seed.usdNonNpCash);
    setUsdParams({ ...seed.usdParams });
    setForecastProfile({ ...DEFAULT_FORECAST_PROFILE, byCcy: {}, formulas: {} });
  };

  const [policyVAR, setPolicyVAR] = useState(5.0);

  const [activeLayers, setActiveLayers] = useState<Set<LayerId>>(
    () => new Set((initialActiveLayers ?? ALL_LAYERS) as LayerId[])
  );
  const onLayerToggle = (id: LayerId) =>
    setActiveLayers(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const onSharedChange = (key: keyof SharedGlobals, value: number) =>
    setShared(s => ({ ...s, [key]: value }));

  const onRowFieldChange = (
    ccy: string,
    field: keyof Omit<RowState, 'id' | 'ccy'>,
    value: number,
  ) => setRows(prev => prev.map(r => r.ccy === ccy ? { ...r, [field]: value } : r));

  // Overlay booked Decision-layer spot/forward into FX POSITION (FWD CCY / FWD USD).
  // Risk Metrics still uses the unadjusted book + tickets separately (no double-count).
  const displayRows = useMemo(
    () => applyBookedHedgePositions(rows, bookedHedges),
    [rows, bookedHedges],
  );
  const bookedPositionByCcy = useMemo(
    () => bookedPositionOffsetsByCcy(bookedHedges),
    [bookedHedges],
  );

  const dashboard = useMemo(
    () => computeDashboardModel({
      rows: displayRows,
      usdCash,
      usdNonNpCash,
      usdParams,
      shared,
      activeLayers,
      policyVAR,
      timing,
      forecastProfile,
    }),
    [
      displayRows,
      usdCash,
      usdNonNpCash,
      usdParams,
      shared,
      activeLayers,
      policyVAR,
      timing,
      forecastProfile,
    ],
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
    return map;
  }, [rows, showRiskMetrics, varSetup, bookedHedges, forecastProfile]);

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
              usdNonNpCash={usdNonNpCash} setUsdNonNpCash={setUsdNonNpCash}
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
              varSetup={varSetup}
              onVarSetupChange={onVarSetupChange}
              forecastProfile={forecastProfile}
              onForecastProfileChange={setForecastProfile}
              forecastProfileOpen={forecastProfileOpen}
              onForecastProfileOpenChange={setForecastProfileOpen}
              simDark={embedded}
              formulas={formulas}
              onFormulaChange={onFormulaChange}
              onFormulaChanges={onFormulaChanges}
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
              usdNonNpCash={usdNonNpCash}
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
          <div className={activeTab === 'hedging' ? '' : 'hidden'}>
            {hedgingPanel && isValidElement(hedgingPanel)
              ? cloneElement(
                  hedgingPanel as ReactElement<{
                    bookRows?: RowState[];
                    forecastProfile?: ForecastProfileState;
                  }>,
                  {
                    // Same live-injection pattern as Analytics/Liquidity tabs
                    // below — without it this tab was stuck on whatever
                    // bookRows/forecastProfile Task01App had at its last
                    // render, lagging the Cash/Analytics/Liquidity tabs
                    // which read Simulator's `rows` state directly.
                    bookRows: rows,
                    forecastProfile,
                  },
                )
              : (hedgingPanel ?? <HedgingDecisionPanel r_USD={shared.r_USD} />)}
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
                    onOpenForecastProfile?: () => void;
                  }>,
                  {
                    bookRows: rows,
                    forecastProfile,
                    onOpenForecastProfile: () => setForecastProfileOpen(true),
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
              Liquidity gap forecast and its management: Liquidity Book + Carry/Buffer (H*) +
              Swap restructuring + Cash/Swap Carry, on the same live book as the FX Risk tab.
              FX-hedge-specific content (Fwd/Option hedge, Hedge Carry, Portfolio VAR, hedging
              strategy) is excluded — that lives in the FX Risk tab.
            */}
            <UnifiedSimulator
              shared={shared}           onSharedChange={onSharedChange}
              rows={rows}               setRows={setRows}
              usdCash={usdCash}         setUsdCash={setUsdCash}
              usdNonNpCash={usdNonNpCash} setUsdNonNpCash={setUsdNonNpCash}
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
              showFxPosition
              showLiquidity
              showAdvancedBook
              hideFxHedge
              pnlColumns="carryOnly"
              varSetup={varSetup}
              onVarSetupChange={onVarSetupChange}
              forecastProfile={forecastProfile}
              onForecastProfileChange={setForecastProfile}
              forecastProfileOpen={forecastProfileOpen}
              onForecastProfileOpenChange={setForecastProfileOpen}
              simDark={embedded}
              formulas={formulas}
              onFormulaChange={onFormulaChange}
              onFormulaChanges={onFormulaChanges}
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
