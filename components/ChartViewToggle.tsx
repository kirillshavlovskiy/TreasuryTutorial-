'use client';

import type { ReactNode } from 'react';
import { Maximize2 } from 'lucide-react';

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
  onExpand,
  overlay = true,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly ChartViewOption<T>[];
  ariaLabel?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  onExpand?: () => void;
  /**
   * Overlay floats Path/Tape on the plot. Off docks it as a toolbar so a
   * candle interval bar can sit underneath without covering the toggle.
   */
  overlay?: boolean;
}) {
  const tools = (
    <div className="flex items-center gap-2">
      <ChartViewToggle
        value={value}
        onChange={onChange}
        options={options}
        ariaLabel={ariaLabel}
      />
      {extra}
      {onExpand ? (
        <button
          type="button"
          title="Full screen"
          aria-label="Open chart full screen"
          onClick={onExpand}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-600/80 bg-slate-950/90 text-slate-400 shadow-lg shadow-slate-950/50 backdrop-blur-sm hover:border-slate-400 hover:text-slate-100"
        >
          <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.85} />
        </button>
      ) : null}
    </div>
  );
  if (!overlay) {
    return (
      <div className={`flex flex-col ${className ?? 'min-h-0'}`}>
        <div className="flex h-9 shrink-0 items-center justify-center border-b border-slate-700 bg-slate-900 px-2">
          {tools}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className={`relative ${className ?? ''}`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center bg-gradient-to-b from-slate-950/80 to-transparent px-2 pb-8 pt-2">
        <div className="pointer-events-auto">{tools}</div>
      </div>
      {children}
    </div>
  );
}
