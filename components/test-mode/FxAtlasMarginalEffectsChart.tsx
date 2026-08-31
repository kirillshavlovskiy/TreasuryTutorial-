'use client';

import { useMemo, useState, type MouseEvent } from 'react';
import type { FxAtlasMarginalPoint } from '@/lib/test-mode/fx-var-frontier';

const CCY_FILL: Record<string, string> = {
  EUR: '#b91c1c',
  MXN: '#ea580c',
  GBP: '#eab308',
  PLN: '#38bdf8',
  JPY: '#94a3b8',
};

const FALLBACK = ['#c084fc', '#2dd4bf', '#f472b6', '#a3e635'];

function colorFor(ccy: string, used: readonly string[]): string {
  if (CCY_FILL[ccy]) return CCY_FILL[ccy];
  const i = used.indexOf(ccy);
  return FALLBACK[((i >= 0 ? i : used.length) ) % FALLBACK.length]!;
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = Math.max(max - min, 1e-6);
  const raw = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.01; v += step) {
    ticks.push(Number(v.toFixed(6)));
    if (ticks.length > 16) break;
  }
  return ticks;
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 5e-4) return '0.00';
  return v.toFixed(2);
}

export function FxAtlasMarginalEffectsChart({
  points,
  onSelectCcy,
}: {
  points: readonly FxAtlasMarginalPoint[];
  onSelectCcy?: (ccy: string) => void;
}) {
  const [hover, setHover] = useState<FxAtlasMarginalPoint | null>(null);
  const ccys = useMemo(
    () => [...new Set(points.map(p => p.ccy))],
    [points],
  );
  if (points.length === 0) return null;

  const xs = points.map(p => p.marginalCarryCostPct);
  const ys = points.map(p => p.marginalRiskReductionPct);
  const xSpan = Math.max(Math.max(...xs) - Math.min(...xs), 1);
  const ySpan = Math.max(Math.max(...ys) - Math.min(...ys), 1);
  const xMin = Math.min(0, ...xs) - xSpan * 0.14;
  const xMax = Math.max(0, ...xs) + xSpan * 0.16;
  const yMin = Math.min(0, ...ys) - ySpan * 0.16;
  const yMax = Math.max(0, ...ys) + ySpan * 0.18;
  const xTicks = niceTicks(xMin, xMax, 8).filter(v => v >= xMin - 1e-9 && v <= xMax + 1e-9);
  const yTicks = niceTicks(yMin, yMax, 6).filter(v => v >= yMin - 1e-9 && v <= yMax + 1e-9);

  const notionals = points.map(p => p.hedgeNotionalUsdM);
  const nMax = Math.max(...notionals, 1e-6);

  const W = 680;
  const H = 348;
  const L = 64;
  const R = 40;
  const T = 30;
  const B = 50;
  const xOf = (v: number) => L + ((v - xMin) / (xMax - xMin || 1)) * (W - L - R);
  const yOf = (v: number) => T + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - T - B);
  const rOf = (n: number) => 3.2 + Math.sqrt(n / nMax) * 10;

  const pickFromEvent = (e: MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * H;
    let best: FxAtlasMarginalPoint | null = null;
    let bestD = Infinity;
    for (const p of points) {
      const dx = xOf(p.marginalCarryCostPct) - px;
      const dy = yOf(p.marginalRiskReductionPct) - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  const ordered = [...points].sort((a, b) => a.hedgeNotionalUsdM - b.hedgeNotionalUsdM);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={`h-[348px] w-full ${onSelectCcy ? 'cursor-crosshair' : ''}`}
        role="img"
        aria-label="Marginal carry cost versus risk reduction by currency"
        onClick={e => {
          if (!onSelectCcy) return;
          const p = pickFromEvent(e);
          if (p) onSelectCcy(p.ccy);
        }}
        onMouseMove={e => {
          const p = pickFromEvent(e);
          if (p) setHover(p);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="atlas-marg-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#14532d" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#052e16" stopOpacity="0.08" />
          </linearGradient>
        </defs>
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="url(#atlas-marg-bg)" />
        {yTicks.map(v => (
          <g key={`y-${v}`}>
            <line x1={L} y1={yOf(v)} x2={W - R} y2={yOf(v)} stroke="#1e293b" strokeWidth="1" />
            <text x={L - 6} y={yOf(v) + 3} textAnchor="end" fill="#94a3b8" fontSize="9">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        {xTicks.map(v => (
          <text key={`x-${v}`} x={xOf(v)} y={H - 22} textAnchor="middle" fill="#94a3b8" fontSize="9">
            {v.toFixed(1)}
          </text>
        ))}
        <line x1={xOf(0)} y1={T} x2={xOf(0)} y2={H - B} stroke="#e2e8f0" strokeWidth="1.5" />
        <line
          x1={xOf(0)}
          y1={yOf(0)}
          x2={xOf(0)}
          y2={T}
          stroke="#e879f9"
          strokeWidth="1.2"
          strokeDasharray="4 3"
        />
        <line x1={L} y1={yOf(0)} x2={W - R} y2={yOf(0)} stroke="#e2e8f0" strokeWidth="1.5" />
        {ordered.map(p => {
          const active = hover?.id === p.id;
          return (
            <circle
              key={p.id}
              cx={xOf(p.marginalCarryCostPct)}
              cy={yOf(p.marginalRiskReductionPct)}
              r={rOf(p.hedgeNotionalUsdM) + (active ? 1.4 : 0)}
              fill={colorFor(p.ccy, ccys)}
              fillOpacity={active ? 0.95 : 0.82}
              stroke={active ? '#f8fafc' : '#0f172a'}
              strokeWidth={active ? 1.6 : 0.8}
            />
          );
        })}
        <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fill="#94a3b8" fontSize="10">
          Marginal Carry Cost (%)
        </text>
        <text
          x="12"
          y={(T + H - B) / 2}
          textAnchor="middle"
          fill="#94a3b8"
          fontSize="10"
          transform={`rotate(-90 12 ${(T + H - B) / 2})`}
        >
          Marginal Risk Reduction (%)
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500">
        {ccys.map(ccy => (
          <span key={ccy} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: colorFor(ccy, ccys) }}
            />
            {ccy}
          </span>
        ))}
        <span className="text-slate-600">Bubble = tenor USD notional · left of 0 = earn to hedge</span>
      </div>
      {hover && (
        <div className="mt-2 inline-flex flex-col gap-0.5 rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 font-mono text-[11px] text-slate-200">
          <span className="text-slate-100">{hover.ccy} · {hover.tenorMonths}m</span>
          <span>Carry cost {fmtPct(hover.marginalCarryCostPct)}%</span>
          <span>Risk reduction {fmtPct(hover.marginalRiskReductionPct)}%</span>
          {hover.isFreeHedge ? (
            <span className="text-emerald-300">Free hedge — earn and cut VaR</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
