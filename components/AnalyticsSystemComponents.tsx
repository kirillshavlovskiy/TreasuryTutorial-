'use client';

import { ReactNode } from 'react';

/** Wrapper for an analytics section with title and description */
export function AnalyticsSection({
  title,
  description,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-4 ${className}`}>
      <div>
        <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-slate-400">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

/** Consistent tab navigation */
export function AnalyticsTabs({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: { id: string; label: string }[];
  activeTab: string;
  onTabChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-6 border-b border-slate-700 px-1">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`pb-3 text-sm font-medium transition-colors ${
            activeTab === tab.id
              ? 'border-b-2 border-sky-400 text-sky-100'
              : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Filter/control button group */
export function FilterButtonGroup({
  items,
  selected,
  onSelect,
  variant = 'secondary',
}: {
  items: { id: string; label: string }[];
  selected: string;
  onSelect: (id: string) => void;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(item => {
        const isSelected = selected === item.id;
        const baseClass = 'h-8 rounded-full border px-3.5 text-xs font-medium transition-colors';
        const selectedClass =
          variant === 'primary'
            ? 'border-sky-400/70 bg-sky-500/20 text-sky-100'
            : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-100';
        const unselectedClass = 'border-slate-700 bg-slate-950/70 text-slate-400 hover:border-slate-500';

        return (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            className={`${baseClass} ${isSelected ? selectedClass : unselectedClass}`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** Consistent metric display card */
export function MetricCard({
  label,
  value,
  unit,
  highlight = false,
}: {
  label: string;
  value: string | number;
  unit?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex flex-col rounded-lg border px-3 py-2.5 ${
        highlight
          ? 'border-sky-500/40 bg-sky-500/10'
          : 'border-slate-700 bg-slate-950/40'
      }`}
    >
      <span className={`text-xs font-medium ${highlight ? 'text-sky-300' : 'text-slate-400'}`}>
        {label}
      </span>
      <span className={`mt-1 text-base font-semibold ${highlight ? 'text-sky-100' : 'text-slate-100'}`}>
        {value}
        {unit && <span className="ml-1 text-xs text-slate-500">{unit}</span>}
      </span>
    </div>
  );
}

/** Scenario/item card with status badge */
export function ScenarioCard({
  title,
  description,
  isSelected,
  badge,
  metrics,
  onClick,
}: {
  title: string;
  description?: string;
  isSelected?: boolean;
  badge?: { label: string; color: 'amber' | 'emerald' | 'blue' };
  metrics?: Array<{ label: string; value: string | number }>;
  onClick?: () => void;
}) {
  const badgeColorMap = {
    amber: 'bg-amber-500/20 text-amber-200',
    emerald: 'bg-emerald-500/20 text-emerald-200',
    blue: 'bg-sky-500/20 text-sky-200',
  };

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-xl border p-4 text-left transition-all ${
        isSelected
          ? 'border-sky-500/50 bg-sky-500/10'
          : 'border-slate-700 bg-slate-950/40 hover:border-slate-600'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <h3 className="font-semibold text-slate-100">{title}</h3>
          {description && <p className="mt-1 text-xs text-slate-400">{description}</p>}
        </div>
        {badge && (
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badgeColorMap[badge.color]}`}>
            {badge.label}
          </span>
        )}
      </div>

      {metrics && metrics.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-700/50 pt-3">
          {metrics.map((m, i) => (
            <div key={i}>
              <div className="text-xs text-slate-500">{m.label}</div>
              <div className="text-sm font-medium text-slate-100">{m.value}</div>
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

/** Consistent action button bar */
export function ActionBar({
  actions,
  align = 'left',
}: {
  actions: Array<{
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'secondary' | 'ghost';
  }>;
  align?: 'left' | 'right' | 'center';
}) {
  const alignMap = {
    left: 'justify-start',
    right: 'justify-end',
    center: 'justify-center',
  };

  return (
    <div className={`flex flex-wrap gap-2.5 ${alignMap[align]}`}>
      {actions.map((action, i) => {
        const baseClass = 'h-9 rounded-lg border px-4 text-sm font-medium transition-colors';
        const variantClass = {
          primary: 'border-sky-500 bg-sky-600 text-white hover:bg-sky-700',
          secondary: 'border-slate-600 bg-slate-700 text-slate-100 hover:bg-slate-600',
          ghost: 'border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800',
        }[action.variant || 'secondary'];

        return (
          <button
            key={i}
            onClick={action.onClick}
            className={`${baseClass} ${variantClass}`}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}

/** Two-column layout: left panel + right content */
export function AnalyticsLayout({
  leftPanel,
  rightContent,
  leftWidth = 'lg:w-80',
}: {
  leftPanel: ReactNode;
  rightContent: ReactNode;
  leftWidth?: string;
}) {
  return (
    <div className={`grid gap-6 lg:grid-cols-[${leftWidth}_1fr]`}>
      <div className="space-y-3">{leftPanel}</div>
      <div>{rightContent}</div>
    </div>
  );
}

/** Info banner for status or guidance */
export function InfoBanner({
  type = 'info',
  title,
  message,
}: {
  type?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: string;
}) {
  const typeMap = {
    info: { bg: 'bg-sky-500/10', border: 'border-sky-500/30', text: 'text-sky-100', icon: '○' },
    success: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-100', icon: '✓' },
    warning: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-100', icon: '!' },
    error: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-100', icon: '✕' },
  };
  const style = typeMap[type];

  return (
    <div className={`rounded-lg border ${style.bg} ${style.border} px-4 py-3`}>
      {title && <div className={`text-sm font-semibold ${style.text}`}>{title}</div>}
      <div className={`${title ? 'mt-1' : ''} text-sm ${style.text}`}>{message}</div>
    </div>
  );
}
