'use client';

import { ReactNode } from 'react';
import {
  AnalyticsSection,
  AnalyticsLayout,
  ScenarioCard,
  FilterButtonGroup,
  ActionBar,
  MetricCard,
} from '@/components/AnalyticsSystemComponents';

/** Standardized scenarios + detail view layout for analytics */
export function AnalyticsScenariosPanel({
  title,
  description,
  scenarios,
  selectedScenarioId,
  onSelectScenario,
  detailContent,
  filterItems,
  selectedFilter,
  onFilterChange,
  actions,
}: {
  title: string;
  description?: string;
  scenarios: Array<{
    id: string;
    name: string;
    description?: string;
    badge?: { label: string; color: 'amber' | 'emerald' | 'blue' };
    metrics?: Array<{ label: string; value: string | number }>;
  }>;
  selectedScenarioId?: string;
  onSelectScenario?: (id: string) => void;
  detailContent: ReactNode;
  filterItems?: Array<{ id: string; label: string }>;
  selectedFilter?: string;
  onFilterChange?: (id: string) => void;
  actions?: Array<{
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'secondary' | 'ghost';
  }>;
}) {
  return (
    <AnalyticsSection title={title} description={description}>
      {/* Filter controls if provided */}
      {filterItems && selectedFilter && onFilterChange && (
        <div className="space-y-2">
          <FilterButtonGroup
            items={filterItems}
            selected={selectedFilter}
            onSelect={onFilterChange}
          />
        </div>
      )}

      {/* Main layout: scenarios left, detail right */}
      <AnalyticsLayout
        leftPanel={
          <div className="space-y-3">
            {scenarios.map(scenario => (
              <ScenarioCard
                key={scenario.id}
                title={scenario.name}
                description={scenario.description}
                badge={scenario.badge}
                metrics={scenario.metrics}
                isSelected={scenario.id === selectedScenarioId}
                onClick={() => onSelectScenario?.(scenario.id)}
              />
            ))}
          </div>
        }
        rightContent={
          <>
            {/* Detail content area */}
            <div className="min-h-[400px] rounded-lg border border-slate-800 bg-slate-950/40 p-5">
              {detailContent}
            </div>

            {/* Actions bar if provided */}
            {actions && actions.length > 0 && (
              <ActionBar actions={actions} align="right" />
            )}
          </>
        }
      />
    </AnalyticsSection>
  );
}

/** Simplified metrics row for displaying 3-4 key values */
export function MetricsRow({
  metrics,
}: {
  metrics: Array<{ label: string; value: string | number; unit?: string; highlight?: boolean }>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {metrics.map((m, i) => (
        <MetricCard
          key={i}
          label={m.label}
          value={m.value}
          unit={m.unit}
          highlight={m.highlight}
        />
      ))}
    </div>
  );
}
