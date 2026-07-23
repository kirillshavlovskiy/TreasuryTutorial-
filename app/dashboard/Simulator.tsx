'use client';

import { useState, useMemo, type ReactNode } from 'react';
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
  | 'monteCarlo';

const ALL_TABS: { id: SimulatorTab; label: string }[] = [
  { id: 'simulator',   label: 'FX Simulator' },
  { id: 'sensitivity', label: 'Sensitivity Analysis' },
  { id: 'layers',      label: 'Layer Setup' },
  { id: 'irprofile',   label: 'IR Profile' },
  { id: 'hedging',     label: 'Hedging Decision' },
  { id: 'liveLadder',  label: 'Consolidated Live Ladder' },
  { id: 'analytics',   label: 'Analytics' },
  { id: 'monteCarlo',  label: 'Monte Carlo' },
];

const SHARED_DEFAULTS: SharedGlobals = {
  r_USD: 3.50,
  σ_P:   0.10,
  days:  3,
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
  /** Analytics VaR setup for Risk Metrics columns. */
  varSetup?: VarSetup;
  /** Decision-layer booked spot/forward hedges — drive FX table VaR. */
  bookedHedges?: HedgeTicket[];
  /** Incremental hedge % on remaining net book (synced with Hedging Decision). */
  hedgeRatios?: Record<string, number>;
  tabLabels?: Partial<Record<SimulatorTab, string>>;
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
  embedded = false,
  hiddenTabs = [],
  simplifiedBook = false,
  showRiskMetrics = false,
  hedgingPanel,
  liveLadderPanel,
  analyticsPanel,
  varSetup = DEFAULT_VAR_SETUP,
  bookedHedges = [],
  hedgeRatios = {},
  tabLabels,
}: SimulatorProps) {
  // Task Mode simplified book: never expose Sensitivity / Layer Setup / IR Profile.
  // Live Ladder + Analytics are Task Mode only — hide in the full book unless shown.
  const effectiveHiddenTabs = simplifiedBook
    ? Array.from(new Set<SimulatorTab>([...hiddenTabs, 'sensitivity', 'layers', 'irprofile']))
    : Array.from(new Set<SimulatorTab>([...hiddenTabs, 'liveLadder', 'analytics']));
  const tabs = ALL_TABS.filter(t => !effectiveHiddenTabs.includes(t.id)).map(t => ({
    ...t,
    label: tabLabels?.[t.id] ?? t.label,
  }));
  const [tab, setTab] = useState<SimulatorTab>('simulator');
  const [shared, setShared] = useState<SharedGlobals>(SHARED_DEFAULTS);

  const activeTab = tabs.some(t => t.id === tab) ? tab : (tabs[0]?.id ?? 'simulator');

  const [rows,      setRows]      = useState<RowState[]>(() => {
    if (initialRows) return initialRows.map(r => ({ ...r }));
    if (currencyFilter && currencyFilter.length > 0) {
      return INITIAL_ROWS.filter(r => currencyFilter.includes(r.ccy));
    }
    return INITIAL_ROWS;
  });
  const [usdCash,      setUsdCash]      = useState(initialUsdCash ?? 303.9);
  const [usdNonNpCash, setUsdNonNpCash] = useState(initialUsdNonNpCash ?? 154.1);
  const [usdParams, setUsdParams] = useState<UsdParams>({
    ...INITIAL_USD_PARAMS,
    ...initialUsdParams,
  });

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

  const dashboard = useMemo(
    () => computeDashboardModel({
      rows, usdCash, usdNonNpCash, usdParams, shared, activeLayers, policyVAR, timing,
    }),
    [rows, usdCash, usdNonNpCash, usdParams, shared, activeLayers, policyVAR, timing],
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
    for (const m of fxTableRiskMetrics(rows, varSetup, bookedHedges, hedgeRatios)) {
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
  }, [rows, showRiskMetrics, varSetup, bookedHedges, hedgeRatios]);

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
              varSetup={varSetup}
              formulas={formulas}
              onFormulaChange={onFormulaChange}
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
            {hedgingPanel ?? <HedgingDecisionPanel r_USD={shared.r_USD} />}
          </div>
        )}
        {!effectiveHiddenTabs.includes('liveLadder') && (
          <div className={activeTab === 'liveLadder' ? '' : 'hidden'}>
            {liveLadderPanel ?? (
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
                <h3 className="text-sm font-semibold text-gray-800">Consolidated Live Ladder</h3>
                <p className="mt-2 text-xs text-gray-500">
                  Stacked exposure vs hedges — available in Test Mode Group / entity FX dashboards.
                </p>
              </div>
            )}
          </div>
        )}
        {!effectiveHiddenTabs.includes('analytics') && (
          <div className={activeTab === 'analytics' ? '' : 'hidden'}>
            {analyticsPanel ?? (
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-10 text-center">
                <h3 className="text-sm font-semibold text-gray-800">Analytics</h3>
                <p className="mt-2 text-xs text-gray-500">
                  VaR confidence setup — available in Test Mode Group / entity FX dashboards.
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
