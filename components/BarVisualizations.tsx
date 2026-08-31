'use client';

import { ReactNode } from 'react';

export function MiniBar({
  value,
  max,
  label,
  color = 'bg-sky-400',
  height = 'h-5',
  showValue = true,
}: {
  value: number;
  max: number;
  label?: string;
  color?: string;
  height?: string;
  showValue?: boolean;
}) {
  const pct = Math.min(100, Math.max(0, (Math.abs(value) / Math.abs(max)) * 100));
  const isNegative = value < 0;

  return (
    <div className="flex flex-col gap-1">
      <div className={`relative w-full bg-gray-100 rounded ${height} overflow-hidden`}>
        <div
          className={`${color} h-full transition-all duration-200`}
          style={{ width: `${pct}%` }}
        />
        {showValue && (
          <div className="absolute inset-0 flex items-center px-1.5 text-[10px] font-mono text-gray-700">
            {isNegative ? '−' : ''}{Math.abs(value).toFixed(1)}
          </div>
        )}
      </div>
      {label && <div className="text-[10px] text-gray-600">{label}</div>}
    </div>
  );
}

export function StackedBar({
  segments,
  height = 'h-6',
  showTotal = true,
}: {
  segments: Array<{ value: number; color: string; label: string }>;
  height?: string;
  showTotal?: boolean;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const max = Math.max(...segments.map(s => Math.abs(s.value)));

  return (
    <div className="flex flex-col gap-2">
      <div className={`flex w-full ${height} rounded overflow-hidden shadow-sm`}>
        {segments.map((seg, i) => {
          const pct = max > 0 ? (seg.value / max) * 100 : 0;
          return (
            <div
              key={i}
              className={`${seg.color} transition-all duration-200 flex-shrink-0`}
              style={{ width: `${pct}%` }}
              title={`${seg.label}: ${seg.value.toFixed(1)}`}
            />
          );
        })}
      </div>
      {showTotal && (
        <div className="flex items-center justify-between text-[10px]">
          <div className="flex gap-2">
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className={`w-2 h-2 ${seg.color} rounded-full`} />
                <span className="text-gray-600">{seg.label}</span>
              </span>
            ))}
          </div>
          <span className="font-mono font-semibold text-gray-700">{total.toFixed(1)}$k</span>
        </div>
      )}
    </div>
  );
}

export function DirectionalBar({
  value,
  label,
  maxAbsolute,
  buyColor = 'bg-emerald-500',
  sellColor = 'bg-red-500',
  height = 'h-6',
  showValue = true,
}: {
  value: number;
  label: string;
  maxAbsolute: number;
  buyColor?: string;
  sellColor?: string;
  height?: string;
  showValue?: boolean;
}) {
  const isBuy = value >= 0;
  const pct = Math.min(100, (Math.abs(value) / maxAbsolute) * 100);
  const color = isBuy ? buyColor : sellColor;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-gray-700">{label}</span>
        {showValue && (
          <span className="text-[10px] font-mono font-semibold text-gray-700">
            {isBuy ? '+' : '−'}{Math.abs(value).toFixed(1)}M
          </span>
        )}
      </div>
      <div className={`relative w-full bg-gray-100 rounded ${height} overflow-hidden`}>
        <div
          className={`${color} h-full transition-all duration-200`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function BandSummaryCard({
  title,
  bgColor,
  textColor,
  children,
}: {
  title: string;
  bgColor: string;
  textColor: string;
  children: ReactNode;
}) {
  return (
    <div className={`${bgColor} rounded-lg border border-gray-200 p-3 space-y-2`}>
      <h3 className={`text-xs font-semibold ${textColor} uppercase tracking-wide`}>{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

export function BarLegend({
  items,
}: {
  items: Array<{ color: string; label: string }>;
}) {
  return (
    <div className="flex flex-wrap gap-3 text-[10px]">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <span className={`w-3 h-3 ${item.color} rounded`} />
          <span className="text-gray-700">{item.label}</span>
        </span>
      ))}
    </div>
  );
}
