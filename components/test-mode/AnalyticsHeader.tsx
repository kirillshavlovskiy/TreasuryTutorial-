'use client';

import { ReactNode } from 'react';
import { AnalyticsTabs } from '@/components/AnalyticsSystemComponents';

/** Unified header for analytics sections with tabs and controls */
export function AnalyticsHeader({
  tabs,
  activeTab,
  onTabChange,
  controls,
  description,
}: {
  tabs?: Array<{ id: string; label: string }>;
  activeTab?: string;
  onTabChange?: (id: string) => void;
  controls?: ReactNode;
  description?: string;
}) {
  return (
    <div className="space-y-4">
      {/* Tab navigation */}
      {tabs && activeTab && onTabChange && (
        <AnalyticsTabs tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />
      )}

      {/* Description text */}
      {description && (
        <p className="text-sm text-slate-400">{description}</p>
      )}

      {/* Additional controls (filters, buttons, etc.) */}
      {controls && (
        <div className="flex flex-wrap items-center gap-3">
          {controls}
        </div>
      )}
    </div>
  );
}

/** Container for a full analytics view with header, tabs, and content */
export function AnalyticsView({
  title,
  tabs,
  activeTab,
  onTabChange,
  headerControls,
  description,
  children,
}: {
  title: string;
  tabs?: Array<{ id: string; label: string }>;
  activeTab?: string;
  onTabChange?: (id: string) => void;
  headerControls?: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-slate-50">{title}</h1>
      </div>

      {/* Header with tabs and controls */}
      <AnalyticsHeader
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={onTabChange}
        controls={headerControls}
        description={description}
      />

      {/* Content */}
      <div className="space-y-6">
        {children}
      </div>
    </div>
  );
}
