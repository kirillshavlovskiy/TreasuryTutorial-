'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';

function fmtK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

function ChartInfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(v => !v)}
        className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold leading-none transition-colors ${
          open
            ? 'border-sky-500/60 bg-sky-500/20 text-sky-100'
            : 'border-slate-600 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200'
        }`}
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="absolute right-0 top-full z-30 mt-1.5 w-72 rounded-lg border border-slate-600 bg-slate-900 p-3 text-left text-[10px] leading-relaxed text-slate-300 shadow-xl"
        >
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {label}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

interface CfarDrawdownChartProps {
  bands: CfarBandsResult;
  confidencePct: number;
  /** SVG design height (viewBox); width is fluid. Default 188 (modal mini). */
  height?: number;
  /** Show the header caption row. Default true. */
  showHeader?: boolean;
  className?: string;
  /**
   * Settlement funding gap g(t)=e−H_settled (local FCY M) — a deterministic
   * volume/timing measure, independent of the stochastic CFaR fan. Plotted on
   * its own secondary axis (local FCY M) when supplied.
   */
  fundingGapPoints?: readonly { t: number; gapLocalM: number }[];
}

/**
 * CFaR drawdown fan — per-point-in-time bridge-funding VaR percentiles
 * (p05–p95 outer fan, p25–p75 inner band), the net-of-carry adverse floor,
 * carry accrual, and the peak critical-cash line. Closed form, not
 * simulated — each t is an independent point-in-time draw, not a
 * compounding path. Presentational only; feed it a {@link CfarBandsResult}.
 *
 * Design: Claude Design project "Design hierarchy refinement",
 * `CFaR Analysis.dc.html` (fed877ea-3c81-4edd-87ac-c5c0f287f659). The main
 * net/gross metric uses yellow (not the design's red) per review feedback;
 * the residual r(t)=e−H line from the pre-design implementation is dropped
 * (matches the design, which never had it — FX-rate residual duplicated the
 * Resid VaR profile chart elsewhere without adding information here).
 */
export function CfarDrawdownChart({
  bands,
  confidencePct,
  height = 188,
  showHeader = true,
  className,
  fundingGapPoints,
}: CfarDrawdownChartProps) {
  const pts = bands.points;
  if (pts.length < 2) return null;
  const W = 560;
  const H = height;
  const padL = 48;
  const padR = 12;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const T = pts[pts.length - 1]!.t || 1;
  let yMax = 0;
  let yMin = 0;
  for (const p of pts) {
    yMax = Math.max(yMax, p.p95, p.carryUsdM);
    yMin = Math.min(yMin, p.p05, p.netP05);
  }
  // Headline peaks use setup confidence (criticalCash / netCriticalCash).
  // Fan paths stay at fixed visual p05/p95 — do not label peaks from p05 or
  // 90% conf reads as ~$2.0M while the table shows ~$1.6M (z₉₅/z₉₀).
  const grossPeakUsdM = bands.criticalCashUsdM;
  const netPeakUsdM = bands.netCriticalCashUsdM;
  const grossPeakT =
    typeof bands.grossPeakMonth === 'number' && bands.grossPeakMonth > 0
      ? bands.grossPeakMonth
      : bands.peakMonth;
  const netPeakT = bands.peakMonth;
  yMin = Math.min(yMin, -netPeakUsdM, -grossPeakUsdM);
  const spanRaw = yMax - yMin || 1;
  const pad = spanRaw * 0.08;
  yMax += pad;
  yMin -= pad;
  const x = (t: number) => padL + (t / T) * plotW;
  const y = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * plotH;
  const line = (sel: (p: (typeof pts)[number]) => number) =>
    pts.map(p => `${x(p.t).toFixed(1)},${y(sel(p)).toFixed(1)}`).join(' ');
  const band = (lo: (p: (typeof pts)[number]) => number, hi: (p: (typeof pts)[number]) => number) =>
    `M ${pts.map(p => `${x(p.t).toFixed(1)},${y(hi(p)).toFixed(1)}`).join(' L ')} L ${[...pts]
      .reverse()
      .map(p => `${x(p.t).toFixed(1)},${y(lo(p)).toFixed(1)}`)
      .join(' L ')} Z`;
  const spreadOuter = band(p => p.p05, p => p.p95);
  const spreadInner = band(p => p.p25, p => p.p75);
  const y0 = y(0);
  const yFloor = y(-netPeakUsdM);

  // Settlement funding gap g(t) — its own secondary axis (local FCY M), only
  // set up when the caller actually supplies it.
  const gapPts = fundingGapPoints ?? [];
  let gMax = 0;
  let gMin = 0;
  for (const g of gapPts) {
    gMax = Math.max(gMax, g.gapLocalM);
    gMin = Math.min(gMin, g.gapLocalM);
  }
  const gSpan = gMax - gMin || 1;
  const gPad = gSpan * 0.12;
  const gHi = gMax + gPad;
  const gLo = gMin - gPad;
  const yG = (v: number) => padT + ((gHi - v) / (gHi - gLo)) * plotH;
  const fundingGapLine = gapPts
    .map(g => `${x(g.t).toFixed(1)},${yG(g.gapLocalM).toFixed(1)}`)
    .join(' ');

  // Month gridline ticks M0…M{round(T)} — matches the Resid VaR profile axis.
  const lastM = Math.max(1, Math.round(T));
  const monthTicks: number[] = [];
  for (let m = 0; m <= lastM; m += 1) monthTicks.push(m);
  const xPeak = x(netPeakT);
  const yPeak = y(-netPeakUsdM);
  const peakNearRight = netPeakT > T * 0.82;
  const xGrossPeak = x(grossPeakT);
  const yGrossPeak = y(-grossPeakUsdM);
  const grossPeakNearRight = grossPeakT > T * 0.82;
  const peaksOverlap = Math.abs(xGrossPeak - xPeak) < 26;
  const hasCarry = Math.abs(pts[pts.length - 1]!.carryUsdM) > 1e-9;
  const fmtM = (t: number) => t.toFixed(t < 10 ? 1 : 0);
  return (
    <div className={className}>
      {showHeader && (
        <>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                CFaR drawdown profile
              </span>
              <ChartInfoTip label="How to read the fan">
                <p>
                  Markers = CriticalCash at {confidencePct}% (same as the
                  table). Shaded fan is a fixed visual p05–p95 band (not the
                  confidence chip). Yellow floor = net; amber = gross before
                  carry.
                  {fundingGapLine
                    ? ' Fuchsia dashed = funding gap g(t) (zero vol, local M).'
                    : ''}
                </p>
              </ChartInfoTip>
            </div>
            <span className="text-[9px] text-slate-500">
              net M{fmtM(netPeakT)} · {fmtK(netPeakUsdM)}
              {' · '}
              <span className="text-amber-400/80">
                gross M{fmtM(grossPeakT)} · {fmtK(grossPeakUsdM)}
              </span>
              <span className="text-slate-600"> · {confidencePct}%</span>
            </span>
          </div>
        </>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-full rounded border border-slate-800 bg-slate-950"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Month gridlines + labels (Resid VaR profile axis style) */}
        {monthTicks.map(m => (
          <g key={`m-${m}`}>
            <line
              x1={x(m)}
              x2={x(m)}
              y1={padT}
              y2={H - padB}
              stroke={m === 0 || m === lastM ? '#475569' : '#1e293b'}
            />
            <text
              x={x(m)}
              y={H - padB + 14}
              textAnchor="middle"
              className="fill-slate-400"
              style={{ fontSize: 9 }}
            >
              M{m}
            </text>
          </g>
        ))}
        <line x1={padL} y1={y0} x2={W - padR} y2={y0} stroke="#475569" strokeWidth={1} />
        <path d={spreadOuter} fill="rgba(250,204,21,0.10)" />
        <path d={spreadInner} fill="rgba(250,204,21,0.20)" />
        <polyline points={line(p => p.p50)} fill="none" stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />
        <polyline
          points={line(p => p.p05)}
          fill="none"
          stroke="rgba(250,204,21,0.55)"
          strokeWidth={1.25}
          strokeDasharray="4 3"
        />
        <polyline points={line(p => p.netP05)} fill="none" stroke="#facc15" strokeWidth={2} />
        {hasCarry && (
          <polyline points={line(p => p.carryUsdM)} fill="none" stroke="#34d399" strokeWidth={1.25} strokeDasharray="4 2" />
        )}
        <line x1={padL} y1={yFloor} x2={W - padR} y2={yFloor} stroke="rgba(234,179,8,0.8)" strokeWidth={1} strokeDasharray="2 3" />
        {/* settlement funding gap g(t)=e−H_settled — own secondary axis */}
        {fundingGapLine && (
          <polyline
            points={fundingGapLine}
            fill="none"
            stroke="#e879f9"
            strokeWidth={1.5}
            strokeDasharray="5 2"
            opacity={0.9}
          />
        )}
        {/* Confidence-calibrated peaks (match table / Net·Gross cards) */}
        <line x1={xGrossPeak} y1={padT} x2={xGrossPeak} y2={H - padB} stroke="rgba(245,158,11,0.35)" strokeWidth={1} strokeDasharray="2 2" />
        <circle cx={xGrossPeak} cy={yGrossPeak} r={3} fill="#0b1220" stroke="#f59e0b" strokeWidth={2} />
        <text
          x={grossPeakNearRight ? xGrossPeak - 5 : xGrossPeak + 5}
          y={peaksOverlap ? yGrossPeak + 12 : yGrossPeak - 5}
          textAnchor={grossPeakNearRight ? 'end' : 'start'}
          fontSize={8}
          fontWeight={600}
          fill="#fbbf24"
        >
          gross M{fmtM(grossPeakT)} · {fmtK(grossPeakUsdM)}
        </text>
        <line x1={xPeak} y1={padT} x2={xPeak} y2={H - padB} stroke="rgba(234,179,8,0.4)" strokeWidth={1} />
        <circle cx={xPeak} cy={yPeak} r={3.5} fill="#0b1220" stroke="#facc15" strokeWidth={2} />
        <text
          x={peakNearRight ? xPeak - 5 : xPeak + 5}
          y={peaksOverlap ? yPeak - 12 : yPeak - 5}
          textAnchor={peakNearRight ? 'end' : 'start'}
          fontSize={8.5}
          fontWeight={600}
          fill="#fde047"
        >
          net M{fmtM(netPeakT)} · {fmtK(netPeakUsdM)}
        </text>
        <text x={padL - 4} y={y0 + 3} textAnchor="end" fontSize={8} fill="#64748b">$0</text>
        <text x={padL - 4} y={yFloor + 3} textAnchor="end" fontSize={8} fill="#fde047">
          {fmtK(netPeakUsdM)}
        </text>
      </svg>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[9px] text-slate-500">
        <span><span className="mr-1 inline-block h-2 w-3.5 rounded-sm bg-yellow-400/25 align-middle" />visual p05–p95 fan</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-yellow-400 align-middle" />net path (fan p05; dashed = gross)</span>
        {hasCarry && (
          <span><span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-emerald-400 align-middle" />carry accrual</span>
        )}
        <span><span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-slate-400 align-middle" />median path</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 border-t-2 border-dotted border-yellow-500 align-middle" />net critical cash @ {confidencePct}%</span>
        <span className="text-amber-400/80"><span className="mr-1 inline-block h-2 w-2 rounded-full border-2 border-amber-500 align-middle" />gross peak @ {confidencePct}%</span>
        {fundingGapLine && (
          <span className="text-fuchsia-300/90">
            <span className="mr-1 inline-block h-0.5 w-3 border-t-2 border-dashed border-fuchsia-400 align-middle" />
            funding gap g(t)=e−H_settled
          </span>
        )}
      </div>
    </div>
  );
}
