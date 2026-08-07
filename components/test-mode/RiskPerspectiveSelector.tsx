'use client';

import type { ReactNode } from 'react';

export type RiskPerspective = 'fxRisk' | 'cashCarry' | 'dv01' | 'greeks';

export type RiskPerspectiveTabStat = {
  /** Mono headline under the tab label (e.g. `$1.24M`, `+1.73K`, `—`). */
  value: string;
  /** Uppercase caption under the figure (e.g. `Resid VaR`). */
  label: string;
};

export const RISK_PERSPECTIVES: {
  id: RiskPerspective;
  label: string;
  /** Panel H2 suffix after the module name. */
  title: string;
  active: boolean;
  description: string;
  yLabel: string;
  /** Default figure caption when no live stat is passed. */
  defaultStatLabel: string;
}[] = [
  {
    id: 'fxRisk',
    label: 'FX Risk',
    title: 'Group FX VaR setup',
    active: true,
    description:
      'Exposure inputs set the hedge target and VaR profile. Pick the active tenure on the evolution chart — it drives Hedging Decision, Live Ladder and Risk Metrics.',
    yLabel: 'Exposure (M)',
    defaultStatLabel: 'Resid VaR',
  },
  {
    id: 'cashCarry',
    label: 'Cash Carry',
    title: 'Planned Consolidated Hedged Cash forecast',
    active: true,
    description:
      'Cash in/out plus hedge CF with all carry layers — residual FCY interest, FWD points at each strip or bullet settle, and USD interest on post-settle balances.',
    yLabel: 'Carry $K',
    defaultStatLabel: 'Total carry',
  },
  {
    id: 'dv01',
    label: 'DV01',
    title: 'DV01',
    active: false,
    description: 'Rate sensitivity stack on debt / investments (preview).',
    yLabel: 'DV01 / bp (M)',
    defaultStatLabel: 'Not enabled',
  },
  {
    id: 'greeks',
    label: 'Greeks',
    title: 'Greeks',
    active: false,
    description: 'δ-effective stack vs hedge overlay (preview).',
    yLabel: 'δ-notional (M)',
    defaultStatLabel: 'Not enabled',
  },
];

export function riskPerspectiveMeta(id: RiskPerspective) {
  return RISK_PERSPECTIVES.find(p => p.id === id) ?? RISK_PERSPECTIVES[0]!;
}

interface RiskPerspectiveSelectorProps {
  value: RiskPerspective;
  onChange: (id: RiskPerspective) => void;
  /**
   * `rail` = design 1c (per-tab figures, top sky rail).
   * `chips` = legacy detached pills (kept for one-off callers).
   */
  variant?: 'rail' | 'chips';
  /** Module name prefix for the H2 (`Analytics — …`). */
  moduleLabel?: string;
  /** Optional live figures per tab. Missing / inactive tabs show `—`. */
  tabStats?: Partial<Record<RiskPerspective, RiskPerspectiveTabStat>>;
  /** Forecast period months for the Tf chip (omit to hide). */
  tfMonths?: number | null;
  /** Gear / settings control on the context row. */
  onOpenSettings?: () => void;
  settingsDisabled?: boolean;
  settingsTitle?: string;
  /** Override the mono meta line under the rail. */
  metaLine?: string;
  /** Extra controls on the right of the context row (e.g. Unhedged). */
  trailing?: ReactNode;
  className?: string;
  /** Chips variant only — show description under the row. */
  showDescription?: boolean;
}

/** Context meta under the tab rail. Tf lives on the chip — do not repeat it here. */
function defaultMetaLine(id: RiskPerspective): string {
  if (id === 'fxRisk') {
    return 'Group VaR · all currencies';
  }
  if (id === 'cashCarry') {
    return 'Cash carry · all currencies · click a currency row to set the carry chart';
  }
  const meta = riskPerspectiveMeta(id);
  return meta.active ? meta.label : `${meta.label} · not enabled`;
}

/**
 * Module tab menu — shared across Analytics / Hedging Decision / Live Ladder.
 * Default `rail` = guideline 1c (top sky rail + per-tab headline figures).
 */
export function RiskPerspectiveSelector({
  value,
  onChange,
  variant = 'rail',
  moduleLabel = 'Analytics',
  tabStats,
  tfMonths,
  onOpenSettings,
  settingsDisabled = false,
  settingsTitle = 'Forecast profile',
  metaLine,
  trailing,
  className = '',
  showDescription = true,
}: RiskPerspectiveSelectorProps) {
  const meta = riskPerspectiveMeta(value);

  if (variant === 'chips') {
    const inactive = !meta.active;
    return (
      <div className={className || undefined}>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Risk perspective"
        >
          {RISK_PERSPECTIVES.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                value === p.id
                  ? 'border-sky-500 bg-sky-500/15 text-sky-100'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
              } ${!p.active ? 'opacity-70' : ''}`}
            >
              {p.label}
              {!p.active && (
                <span className="ml-1 text-[9px] uppercase text-slate-600">
                  soon
                </span>
              )}
            </button>
          ))}
        </div>
        {showDescription && (
          <p className="mt-2 text-[11px] text-slate-500">
            {meta.description}
            {inactive
              ? ' Values are illustrative until the metric is activated on the risk profile.'
              : ''}
          </p>
        )}
      </div>
    );
  }

  const resolvedMeta = metaLine ?? defaultMetaLine(value);
  const showTf = tfMonths != null;
  const tfText = tfMonths === 0 ? '0m' : `${tfMonths}m`;
  /** Analytics keeps the long per-tab titles from guideline 1c; other modules use the short label. */
  const headingTitle =
    moduleLabel === 'Analytics' ? meta.title : meta.label;
  const headingDesc =
    moduleLabel === 'Analytics' && meta.active ? meta.description : null;

  return (
    <div className={className || undefined}>
      <div className="px-0 pb-3">
        <h3 className="text-base font-semibold tracking-tight text-slate-50">
          {moduleLabel} — {headingTitle}
        </h3>
        {headingDesc ? (
          <p className="mt-1 max-w-[52rem] text-xs leading-relaxed text-slate-500">
            {headingDesc}
          </p>
        ) : null}
      </div>

      <div
        className="-mx-5 flex flex-wrap border-y border-slate-800"
        role="tablist"
        aria-label={`${moduleLabel} modules`}
      >
        {RISK_PERSPECTIVES.map(p => {
          const on = value === p.id;
          const soon = !p.active;
          const stat = tabStats?.[p.id];
          const statValue = soon ? '—' : (stat?.value ?? '—');
          const statLabel = soon
            ? 'Not enabled'
            : (stat?.label ?? p.defaultStatLabel);
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={on}
              disabled={soon}
              onClick={() => {
                if (!soon) onChange(p.id);
              }}
              className={`flex min-w-[9.5rem] flex-1 flex-col gap-0.5 border-l border-l-slate-800 border-t-2 px-4 py-2.5 text-left transition-colors ${
                on
                  ? 'border-t-sky-500 bg-slate-950/85'
                  : 'border-t-transparent bg-transparent hover:bg-slate-500/[0.05]'
              } ${
                soon
                  ? 'cursor-not-allowed'
                  : 'cursor-pointer'
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`text-xs ${
                    on
                      ? 'font-semibold text-slate-50'
                      : soon
                        ? 'font-normal text-slate-600'
                        : 'font-normal text-slate-400'
                  }`}
                >
                  {p.label}
                </span>
                {soon ? (
                  <span className="text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-600">
                    Soon
                  </span>
                ) : null}
              </span>
              <span
                className={`font-mono text-[13px] font-semibold tabular-nums ${
                  on
                    ? 'text-slate-100'
                    : soon
                      ? 'text-slate-700'
                      : 'text-slate-500'
                }`}
              >
                {statValue}
              </span>
              <span className="text-[9px] uppercase tracking-[0.09em] text-slate-600">
                {statLabel}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-0 py-2.5">
        <div className="min-w-0 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          {resolvedMeta}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {trailing}
          {showTf ? (
            <span className="inline-flex items-baseline gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-0.5 text-[11px] text-slate-500">
              Tf
              <span className="font-mono font-semibold tabular-nums text-sky-200">
                {tfText}
              </span>
            </span>
          ) : null}
          {onOpenSettings ? (
            <button
              type="button"
              aria-label={settingsTitle}
              title={settingsTitle}
              disabled={settingsDisabled}
              onClick={onOpenSettings}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <GearIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

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
