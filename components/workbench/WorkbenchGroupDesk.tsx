'use client';

/**
 * Workbench consolidated Group FX desk — same curriculum calculation stack as
 * Task01 GroupConsolidatedView (FX Risk · Liquidity · Analytics · Hedging…).
 */

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Simulator } from '@/app/dashboard/Simulator';
import { HedgingDecisionLayer } from '@/components/test-mode/HedgingDecisionLayer';
import { ConsolidatedLiveLadder } from '@/components/test-mode/ConsolidatedLiveLadder';
import { VarAnalyticsPanel } from '@/components/test-mode/VarAnalyticsPanel';
import { DataUploadPanel } from '@/components/test-mode/DataUploadPanel';
import { CURRICULUM_TAB_LABELS, hiddenTabsForLayers } from '@/lib/desk-tabs';
import {
  aggregateBookedHedges,
  applyConsolidatedBookedChange,
  computeConsolidatedRisk,
  consolidateEntityBooks,
  emptyHedgeBook,
  GROUP_HEDGE_SCOPE,
  TASK01_REQUIRED_ANALYTICAL_LAYERS,
  TASK01_REQUIRED_DECISION_LAYERS,
  TASK01_REQUIRED_FX_INPUTS,
  mergedEntityForecastProfile,
  type EntityHedgeBook,
  type HedgeTicket,
  type PreparedHedgeProfile,
  type ForecastHedgeStructure,
  type VarSetup,
} from '@/lib/test-mode';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import type { RowState } from '@/lib/fx-buffer';
import type { Entity, WorkspaceGroup } from '@/lib/workspace-store';

export function WorkbenchGroupDesk({
  group,
  entities,
  varSetup,
  onVarSetupChange,
  hedgesByEntityId,
  onHedgesByEntityIdChange,
}: {
  group: WorkspaceGroup;
  /** Entities included in consolidation (already filtered). */
  entities: Entity[];
  varSetup: VarSetup;
  onVarSetupChange: (setup: VarSetup) => void;
  hedgesByEntityId: Record<string, EntityHedgeBook>;
  onHedgesByEntityIdChange: Dispatch<
    SetStateAction<Record<string, EntityHedgeBook>>
  >;
}) {
  const book = useMemo(() => consolidateEntityBooks(entities), [entities]);
  const groupForecast = useMemo(
    () => mergedEntityForecastProfile(entities),
    [entities],
  );
  const risk = useMemo(
    () => computeConsolidatedRisk(entities, varSetup),
    [entities, varSetup],
  );
  const decision = [...TASK01_REQUIRED_DECISION_LAYERS];
  const analytical = [...TASK01_REQUIRED_ANALYTICAL_LAYERS];

  const [analyticsBook, setAnalyticsBook] = useState<{
    rows: RowState[];
    forecastProfile: ForecastProfileState;
  }>({ rows: [], forecastProfile: DEFAULT_FORECAST_PROFILE });
  const [hedgeStructure, setHedgeStructure] =
    useState<ForecastHedgeStructure>('bullet');

  const includedNames = entities.map(e => e.name).join(' · ') || 'none';
  const entityIds = useMemo(() => entities.map(e => e.id), [entities]);

  const bookedHedges = useMemo(
    () => aggregateBookedHedges(hedgesByEntityId, entityIds, true),
    [hedgesByEntityId, entityIds],
  );
  const groupBook = hedgesByEntityId[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
  const hedgeRatios = groupBook.hedgeRatios;
  const preparedByCcy = groupBook.preparedByCcy ?? {};
  const marketRatesByCcy = groupBook.marketRatesByCcy ?? {};

  const setHedgeRatios = (ratios: Record<string, number>) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          hedgeRatios: ratios,
          preparedByCcy: g.preparedByCcy ?? {},
          carrySessionsByCcy: g.carrySessionsByCcy ?? {},
          marketRatesByCcy: g.marketRatesByCcy ?? {},
        },
      };
    });
  };

  const setBookedHedges = (tickets: HedgeTicket[]) => {
    const stamped = tickets.map(t =>
      t.entityId
        ? t
        : {
            ...t,
            entityId: GROUP_HEDGE_SCOPE,
            entityName: group.dashboardName,
          },
    );
    onHedgesByEntityIdChange(prev =>
      applyConsolidatedBookedChange(stamped, entityIds, prev),
    );
  };

  const setPreparedByCcy = (next: Record<string, PreparedHedgeProfile>) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          preparedByCcy: next,
          carrySessionsByCcy: g.carrySessionsByCcy ?? {},
          marketRatesByCcy: g.marketRatesByCcy ?? {},
        },
      };
    });
  };

  const setMarketRatesByCcy = (next: Record<string, FxMarketRatesBundle>) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          preparedByCcy: g.preparedByCcy ?? {},
          carrySessionsByCcy: g.carrySessionsByCcy ?? {},
          marketRatesByCcy: next,
        },
      };
    });
  };

  const handleBookHedge = (ticket: HedgeTicket) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          hedgeRatios: { ...g.hedgeRatios, [ticket.ccy]: 0 },
          preparedByCcy: g.preparedByCcy ?? {},
          carrySessionsByCcy: g.carrySessionsByCcy ?? {},
          marketRatesByCcy: g.marketRatesByCcy ?? {},
        },
      };
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          {group.dashboardName}
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {group.name} · {group.reportingCurrency} consolidated
        </p>
        <p className="mt-1 text-[11px] text-slate-500">Included: {includedNames}</p>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-800">
        <Simulator
          key={`group-consol-${entityIds.slice().sort().join(',')}`}
          embedded
          simplifiedBook
          liquidityMode="fullSimulator"
          showRiskMetrics
          varSetup={varSetup}
          onVarSetupChange={onVarSetupChange}
          bookedHedges={bookedHedges}
          preparedByCcy={preparedByCcy}
          hedgeRatios={hedgeRatios}
          marketRatesByCcy={marketRatesByCcy}
          ratesScopeId={GROUP_HEDGE_SCOPE}
          initialRows={book.rows}
          initialUsdCash={book.usdCash}
          initialUsdNonLpCash={book.usdNonLpCash}
          initialUsdParams={book.usdParams}
          initialActiveLayers={[]}
          fxInputs={[...TASK01_REQUIRED_FX_INPUTS]}
          forecastProfile={groupForecast}
          hiddenTabs={hiddenTabsForLayers(decision, analytical)}
          tabLabels={CURRICULUM_TAB_LABELS}
          onAnalyticsBookChange={setAnalyticsBook}
          hedgingPanel={
            <HedgingDecisionLayer
              risk={risk}
              title="Decision layer — consolidated hedge & VaR"
              hedgeRatios={hedgeRatios}
              onHedgeRatiosChange={setHedgeRatios}
              bookedHedges={bookedHedges}
              onBookedHedgesChange={setBookedHedges}
              preparedByCcy={preparedByCcy}
              onPreparedByCcyChange={setPreparedByCcy}
              marketRatesByCcy={marketRatesByCcy}
              ratesScopeId={GROUP_HEDGE_SCOPE}
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
                analyticsBook.rows.length > 0 ? analyticsBook.rows : book.rows
              }
              risk={risk}
              hedgeRatios={hedgeRatios}
              onHedgeRatiosChange={setHedgeRatios}
              bookedHedges={bookedHedges}
              varSetup={varSetup}
              forecastProfile={analyticsBook.forecastProfile}
              title="Consolidated Live Ladder — Group FX"
            />
          }
          analyticsPanel={
            <VarAnalyticsPanel
              risk={risk}
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
              title="Analytics — Group FX VaR setup"
              bookRows={analyticsBook.rows}
              forecastProfile={analyticsBook.forecastProfile}
              ratesScopeId={GROUP_HEDGE_SCOPE}
            />
          }
          dataUploadPanel={
            <DataUploadPanel
              scopeId={GROUP_HEDGE_SCOPE}
              scopeLabel={group.dashboardName}
              currencies={risk.map(r => r.bar.ccy)}
              title={`Market data — ${group.dashboardName}`}
              marketRatesByCcy={marketRatesByCcy}
              onMarketRatesByCcyChange={setMarketRatesByCcy}
            />
          }
        />
      </div>
    </div>
  );
}
