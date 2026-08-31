'use client';

import { useState } from 'react';
import { SimRow } from '@/lib/sim-types';

export type ViewMode = 'table' | 'bars' | 'compact';

interface ViewToggleProps {
  currentMode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export function ViewModeToggle({ currentMode, onChange }: ViewToggleProps) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-gray-300 bg-white p-1">
      <button
        onClick={() => onChange('table')}
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
          currentMode === 'table'
            ? 'bg-blue-500 text-white'
            : 'bg-white text-gray-700 hover:bg-gray-100'
        }`}
        title="Numeric table view with all columns"
      >
        📊 Table
      </button>
      <button
        onClick={() => onChange('bars')}
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
          currentMode === 'bars'
            ? 'bg-blue-500 text-white'
            : 'bg-white text-gray-700 hover:bg-gray-100'
        }`}
        title="Inline bar charts within table cells"
      >
        📈 Inline Bars
      </button>
      <button
        onClick={() => onChange('compact')}
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
          currentMode === 'compact'
            ? 'bg-blue-500 text-white'
            : 'bg-white text-gray-700 hover:bg-gray-100'
        }`}
        title="Compact dashboard view with bar charts only"
      >
        🎯 Compact
      </button>
    </div>
  );
}

/**
 * Inline bar cell replacement for table view (Level C).
 * Replaces numeric value with a mini bar + value overlay.
 */
export function InlineBarCell({
  value,
  max,
  color = 'bg-sky-400',
  label,
  unitSuffix = '',
}: {
  value: number;
  max: number;
  color?: string;
  label?: string;
  unitSuffix?: string;
}) {
  const pct = Math.min(100, Math.max(0, (Math.abs(value) / Math.abs(max)) * 100));
  const isNegative = value < 0;

  return (
    <div className="relative w-full h-6 rounded overflow-hidden bg-gray-100">
      <div
        className={`${color} h-full transition-all duration-200`}
        style={{ width: `${pct}%` }}
      />
      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-semibold text-gray-700">
        {isNegative ? '−' : ''}{Math.abs(value).toFixed(1)}{unitSuffix}
      </div>
    </div>
  );
}

/**
 * Inline directional bar for buy/sell positions.
 */
export function InlineDirectionalCell({
  value,
  max,
  isBuy = true,
}: {
  value: number;
  max: number;
  isBuy?: boolean;
}) {
  const pct = Math.min(100, (Math.abs(value) / Math.abs(max)) * 100);
  const color = value >= 0 ? 'bg-emerald-500' : 'bg-red-500';

  return (
    <div className="relative w-full h-6 rounded overflow-hidden bg-gray-100">
      <div
        className={`${color} h-full transition-all duration-200`}
        style={{ width: `${pct}%` }}
      />
      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-semibold text-gray-700">
        {value >= 0 ? '+' : '−'}{Math.abs(value).toFixed(1)}
      </div>
    </div>
  );
}

/**
 * Stacked bar cell for multi-component metrics (carry breakdown).
 */
export function InlineStackedCell({
  segments,
}: {
  segments: Array<{ value: number; color: string }>;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const max = Math.max(...segments.map(s => Math.abs(s.value)), 1);

  return (
    <div>
      <div className="flex w-full h-6 rounded overflow-hidden shadow-sm mb-1">
        {segments.map((seg, i) => {
          const pct = max > 0 ? (seg.value / max) * 100 : 0;
          return (
            <div
              key={i}
              className={`${seg.color} h-full transition-all duration-200 flex-shrink-0`}
              style={{ width: `${pct}%` }}
            />
          );
        })}
      </div>
      <div className="text-[10px] font-mono font-semibold text-gray-700 text-center">
        {total.toFixed(1)}$k
      </div>
    </div>
  );
}
