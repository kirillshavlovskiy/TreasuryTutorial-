'use client';

/**
 * Workbench FX desk — curriculum tab shell (FX Risk · Liquidity · Analytics ·
 * Hedging · Live Ladder · Market data) with Task01 calculation panels.
 * FX Risk = simplified curriculum book; Liquidity = editable liquidity book
 * (no FX position / hedge table).
 */

import { useEffect, useMemo, useState } from 'react';
import { persistWorkbench } from '@/lib/desk/desk-client';
import { Simulator } from '@/app/dashboard/Simulator';
import { AgentDock } from '@/components/workbench/AgentPanel';
import { buildDeskContextSnapshot } from '@/lib/agent/desk-context';
import { HedgingDecisionLayer } from '@/components/test-mode/HedgingDecisionLayer';
import { WORKSPACE_SANDBOX_TASK_ID } from '@/lib/workspace-client';
import { ConsolidatedLiveLadder } from '@/components/test-mode/ConsolidatedLiveLadder';
import { VarAnalyticsPanel } from '@/components/test-mode/VarAnalyticsPanel';
import { DataUploadPanel } from '@/components/test-mode/DataUploadPanel';
import {
  CURRICULUM_TAB_LABELS,
  hiddenTabsForLayers,
  sanitizeCurriculumAnalytical,
} from '@/lib/desk-tabs';
import { computeConsolidatedRisk } from '@/lib/test-mode/consolidate';
import {
  TASK01_REQUIRED_ANALYTICAL_LAYERS,
  TASK01_REQUIRED_DECISION_LAYERS,
  TASK01_REQUIRED_FX_INPUTS,
  rowsForSelectedCurrencies,
  simSeedForEntity,
} from '@/lib/test-mode/nordtech-sim-seed';
import type {
  EntityHedgeBook,
  HedgeTicket,
  HedgeTicketsPatch,
  PreparedHedgeProfile,
  PreparedHedgesPatch,
} from '@/lib/test-mode/hedge-var';
import {
  applyHedgeTicketsPatch,
  applyPreparedHedgesPatch,
} from '@/lib/test-mode/hedge-var';
import type { ForecastHedgeStructure } from '@/lib/test-mode/rolling-hedge';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import type { VarSetup } from '@/lib/test-mode/var-setup';
import type { RowState, UsdParams } from '@/lib/fx-buffer';
import type { TreasurySnapshot } from '@/lib/treasury/snapshot';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import {
  resolveTimingFractions,
  type Dashboard,
  type Entity,
  type RiskProfile,
  type TimingProfile,
} from '@/lib/workspace-store';

/**
 * Live Treasury props for the embedded <Simulator>, or {} when not connected
 * / not live. Mirrors Simulator's own currency-filter fallback so a risk
 * profile scoped to specific currencies keeps showing only those currencies
 * once Treasury data is live — passing `initialRows` unfiltered would
 * otherwise silently ignore that setting (Simulator prefers `initialRows`
 * over `currencyFilter` whenever both are given).
 */
function liveBookProps(
  treasury: TreasurySnapshot | null | undefined,
  currencyFilter: string[] | undefined,
): {
  initialRows?: RowState[];
  initialUsdCash?: number;
  initialUsdNonLpCash?: number;
  initialUsdParams?: UsdParams;
} {
  if (!treasury || treasury.status !== 'live') return {};
  const rows = currencyFilter && currencyFilter.length > 0
    ? treasury.rows.filter(r => currencyFilter.includes(r.ccy))
    : treasury.rows;
  return {
    initialRows: rows,
    initialUsdCash: treasury.usdCash,
    initialUsdNonLpCash: treasury.usdNonNpCash,
    initialUsdParams: treasury.usdParams,
  };
}

export function WorkbenchFxDesk({
  entity,
  dashboard,
  profile,
  varSetup,
  onVarSetupChange,
  hedgeBook,
  onHedgeBookChange,
  treasury,
  onFormulaChange,
  onFormulaChanges,
  onForecastProfileChange,
}: {
  entity: Entity;
  dashboard: Dashboard;
  profile: RiskProfile;
  varSetup: VarSetup;
  onVarSetupChange: (setup: VarSetup) => void;
  hedgeBook: EntityHedgeBook;
  onHedgeBookChange: (updater: (prev: EntityHedgeBook) => EntityHedgeBook) => void;
  /** Live Treasury snapshot for the signed-in user, or null/undefined if not connected. */
  treasury?: TreasurySnapshot | null;
  onFormulaChange: (cellKey: string, formula: string) => void;
  onFormulaChanges: (updates: Record<string, string>) => void;
  onForecastProfileChange?: (profile: ForecastProfileState) => void;
}) {
  const seed = useMemo(() => simSeedForEntity(entity), [entity]);
  const entityRisk = useMemo(
    () => computeConsolidatedRisk([entity], varSetup),
    [entity, varSetup],
  );

  const [analyticsBook, setAnalyticsBook] = useState<{
    rows: RowState[];
    forecastProfile: ForecastProfileState;
  }>({
    rows: [],
    forecastProfile:
      dashboard.forecastProfile ??
      seed.forecastProfile ??
      DEFAULT_FORECAST_PROFILE,
  });
  const [hedgeStructure, setHedgeStructure] =
    useState<ForecastHedgeStructure>('bullet');

  useEffect(() => {
    if (analyticsBook.rows.length === 0) return;
    const liq = analyticsBook.forecastProfile.liquidity;
    persistWorkbench({
      key: `fx:${dashboard.id}`,
      fxBook: {
        dashboardId: dashboard.id,
        entityId: entity.id,
        rows: analyticsBook.rows,
        formulas: dashboard.formulas ?? null,
      },
      liquidity: {
        dashboardId: dashboard.id,
        entityId: entity.id,
        forecastProfile: analyticsBook.forecastProfile,
        timing: dashboard.timing ?? null,
        sizingBasis: liq?.sizingBasis ?? null,
        bookingMode: liq?.bookingMode ?? null,
      },
      action: {
        module: 'fx',
        action: 'fx.book',
        dashboardId: dashboard.id,
        scopeId: entity.id,
        payload: { rows: analyticsBook.rows.length },
      },
    });
  }, [analyticsBook, dashboard.id, dashboard.formulas, dashboard.timing, entity.id]);

  const hedgeRatios = hedgeBook.hedgeRatios;
  const bookedHedges = hedgeBook.bookedHedges;
  const preparedByCcy = hedgeBook.preparedByCcy ?? {};
  const marketRatesByCcy = hedgeBook.marketRatesByCcy ?? {};

  const setHedgeRatios = (ratios: Record<string, number>) => {
    onHedgeBookChange(prev => ({
      ...prev,
      hedgeRatios: ratios,
      preparedByCcy: prev.preparedByCcy ?? {},
      carrySessionsByCcy: prev.carrySessionsByCcy ?? {},
    }));
  };
  const setBookedHedges = (tickets: HedgeTicketsPatch) => {
    onHedgeBookChange(prev => ({
      ...prev,
      bookedHedges: applyHedgeTicketsPatch(prev.bookedHedges, tickets).map(t => ({
        ...t,
        entityId: entity.id,
        entityName: entity.name,
      })),
      preparedByCcy: prev.preparedByCcy ?? {},
      carrySessionsByCcy: prev.carrySessionsByCcy ?? {},
    }));
  };
  const setPreparedByCcy = (next: PreparedHedgesPatch) => {
    onHedgeBookChange(prev => ({
      ...prev,
      preparedByCcy: applyPreparedHedgesPatch(prev.preparedByCcy, next),
      carrySessionsByCcy: prev.carrySessionsByCcy ?? {},
    }));
  };
  const setMarketRatesByCcy = (next: Record<string, FxMarketRatesBundle>) => {
    onHedgeBookChange(prev => ({
      ...prev,
      marketRatesByCcy: next,
    }));
  };
  const handleBookHedge = (ticket: HedgeTicket) => {
    onHedgeBookChange(prev => ({
      ...prev,
      hedgeRatios: { ...prev.hedgeRatios, [ticket.ccy]: 0 },
      preparedByCcy: prev.preparedByCcy ?? {},
      carrySessionsByCcy: prev.carrySessionsByCcy ?? {},
    }));
  };

  const timing: TimingProfile = dashboard.timing ?? {
    mode: 'preset',
    payout: 'mid',
    payin: 'end',
    payoutCustom: 50,
    payinCustom: 100,
  };
  const fractions = useMemo(() => resolveTimingFractions(timing), [timing]);

  const fxConfig = profile.fxConfig;
  const decisionLayers = fxConfig?.decisionLayers?.length
    ? fxConfig.decisionLayers
    : [...TASK01_REQUIRED_DECISION_LAYERS];
  const analyticalLayers = sanitizeCurriculumAnalytical(
    fxConfig?.analyticalLayers?.length
      ? fxConfig.analyticalLayers
      : [...TASK01_REQUIRED_ANALYTICAL_LAYERS],
  );

  const initialRows = useMemo(() => {
    if (
      fxConfig?.currencyMode === 'selected'
      && fxConfig.currencies.length > 0
    ) {
      return rowsForSelectedCurrencies(seed.rows, fxConfig.currencies);
    }
    return seed.rows;
  }, [fxConfig, seed.rows]);

  const currencyFilter =
    fxConfig?.currencyMode === 'selected' && fxConfig.currencies.length > 0
      ? fxConfig.currencies
      : seed.currencyFilter.length > 0
        ? seed.currencyFilter
        : undefined;
  const liveBook = liveBookProps(treasury, currencyFilter);

  useEffect(() => {
    // Keep desk scoped when switching profiles / entities.
    setAnalyticsBook({
      rows: [],
      forecastProfile: dashboard.forecastProfile ?? seed.forecastProfile ?? DEFAULT_FORECAST_PROFILE,
    });
  }, [entity.id, profile.id, dashboard.forecastProfile, seed.forecastProfile]);

  const agentDeskContext = useMemo(
    () =>
      buildDeskContextSnapshot({
        entityName: entity.name,
        dashboardName: dashboard.name,
        risk: entityRisk,
        varSetup,
        hedgeBook,
        bookRows: analyticsBook.rows.length > 0 ? analyticsBook.rows : initialRows,
        forecastProfile:
          analyticsBook.forecastProfile
          ?? dashboard.forecastProfile
          ?? seed.forecastProfile
          ?? null,
        ratesScopeId: entity.id,
      }),
    [
      entity.id,
      entity.name,
      dashboard.name,
      dashboard.forecastProfile,
      entityRisk,
      varSetup,
      hedgeBook,
      analyticsBook,
      initialRows,
      seed.forecastProfile,
    ],
  );

  return (
    <>
    <Simulator
      key={`${entity.id}-${profile.id}`}
      embedded
      initialRows={initialRows}
      initialUsdCash={seed.usdCash}
      initialUsdNonLpCash={seed.usdNonLpCash}
      initialUsdParams={seed.usdParams}
      {...liveBook}
      currencyFilter={currencyFilter}
      initialActiveLayers={[]}
      simplifiedBook
      liquidityMode="fullSimulator"
      varSetup={varSetup}
      onVarSetupChange={onVarSetupChange}
      bookedHedges={bookedHedges}
      preparedByCcy={preparedByCcy}
      hedgeRatios={hedgeRatios}
      marketRatesByCcy={marketRatesByCcy}
      ratesScopeId={entity.id}
      onAnalyticsBookChange={setAnalyticsBook}
      showRiskMetrics={analyticalLayers.includes('riskMetrics')}
      fxInputs={fxConfig?.inputs ?? [...TASK01_REQUIRED_FX_INPUTS]}
      timing={fractions}
      formulas={dashboard.formulas}
      forecastProfile={
        dashboard.forecastProfile ?? seed.forecastProfile ?? DEFAULT_FORECAST_PROFILE
      }
      onForecastProfileChange={onForecastProfileChange}
      onFormulaChange={onFormulaChange}
      onFormulaChanges={onFormulaChanges}
      hiddenTabs={hiddenTabsForLayers(decisionLayers, analyticalLayers)}
      tabLabels={CURRICULUM_TAB_LABELS}
      hedgingPanel={
        <HedgingDecisionLayer
          sandboxTaskId={WORKSPACE_SANDBOX_TASK_ID}
          risk={entityRisk}
          title={`Decision layer — ${entity.name}`}
          hedgeRatios={hedgeRatios}
          onHedgeRatiosChange={setHedgeRatios}
          bookedHedges={bookedHedges}
          onBookedHedgesChange={setBookedHedges}
          preparedByCcy={preparedByCcy}
          onPreparedByCcyChange={setPreparedByCcy}
          marketRatesByCcy={marketRatesByCcy}
          ratesScopeId={entity.id}
          hedgeStructure={hedgeStructure}
          onHedgeStructureChange={setHedgeStructure}
          onBookHedge={handleBookHedge}
          varSetup={varSetup}
          bookRows={analyticsBook.rows}
          forecastProfile={analyticsBook.forecastProfile}
        />
      }
      liveLadderPanel={
        <ConsolidatedLiveLadder
          rows={
            analyticsBook.rows.length > 0 ? analyticsBook.rows : initialRows
          }
          risk={entityRisk}
          hedgeRatios={hedgeRatios}
          onHedgeRatiosChange={setHedgeRatios}
          bookedHedges={bookedHedges}
          varSetup={varSetup}
          forecastProfile={analyticsBook.forecastProfile}
          title={`Live Ladder — ${entity.name}`}
        />
      }
      analyticsPanel={
        <VarAnalyticsPanel
          risk={entityRisk}
          setup={varSetup}
          onSetupChange={onVarSetupChange}
          hedgeRatios={hedgeRatios}
          onHedgeRatiosChange={setHedgeRatios}
          bookedHedges={bookedHedges}
          onBookedHedgesChange={setBookedHedges}
          preparedByCcy={preparedByCcy}
          onPreparedByCcyChange={setPreparedByCcy}
          marketRatesByCcy={marketRatesByCcy}
          onMarketRatesByCcyChange={setMarketRatesByCcy}
          hedgeStructure={hedgeStructure}
          onHedgeStructureChange={setHedgeStructure}
          title={`Analytics — ${entity.name} VaR setup`}
          bookRows={analyticsBook.rows}
          forecastProfile={analyticsBook.forecastProfile}
          ratesScopeId={entity.id}
        />
      }
      dataUploadPanel={
        <DataUploadPanel
          scopeId={entity.id}
          scopeLabel={entity.name}
          currencies={
            entityRisk.length > 0
              ? entityRisk.map(r => r.bar.ccy)
              : initialRows.map(r => r.ccy)
          }
          title={`Market data — ${entity.name}`}
          marketRatesByCcy={marketRatesByCcy}
          onMarketRatesByCcyChange={setMarketRatesByCcy}
        />
      }
    />
    <AgentDock deskContext={agentDeskContext} />
    </>
  );
}
