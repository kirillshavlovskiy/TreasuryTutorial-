'use client';

import type { ReactNode } from 'react';

export type ChartViewOption<T extends string> = {
  id: T;
  label: string;
  title?: string;
};

/** Segmented chart-mode control — same chrome on every Analytics plot. */
export function ChartViewToggle<T extends string>({
  value,
  onChange,
  options,
  ariaLabel = 'Chart view',
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly ChartViewOption<T>[];
  ariaLabel?: string;
}) {
  return (
    <div
      className="inline-flex items-center rounded-md border border-slate-600/80 bg-slate-950/90 p-0.5 shadow-lg shadow-slate-950/50 backdrop-blur-sm"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map(opt => {
        const on = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            title={opt.title}
            aria-pressed={on}
            onClick={() => onChange(opt.id)}
            className={`h-6 rounded px-2.5 font-mono text-[10px] font-semibold tracking-wide transition-colors ${
              on
                ? 'bg-slate-100 text-slate-900'
                : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-200'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Floats the view toggle on the plot — TradingView-style overlay,
 * not a separate toolbar row.
 */
export function ChartViewFrame<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  extra,
  children,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly ChartViewOption<T>[];
  ariaLabel?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative ${className ?? ''}`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center bg-gradient-to-b from-slate-950/80 to-transparent px-2 pb-8 pt-2">
        <div className="pointer-events-auto flex items-center gap-2">
          <ChartViewToggle
            value={value}
            onChange={onChange}
            options={options}
            ariaLabel={ariaLabel}
          />
          {extra}
        </div>
      </div>
      {children}
    </div>
  );
}
