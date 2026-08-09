'use client';

import type { CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';

function fmtK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
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
  yMin = Math.min(yMin, -bands.netCriticalCashUsdM);
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
  const yFloor = y(-bands.netCriticalCashUsdM);

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
  // Peak draw = deepest point of the plotted net-p05 adverse floor (argmin),
  // so the marker sits on the curve trough rather than the mean-peak time.
  let troughIdx = 0;
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i]!.netP05 < pts[troughIdx]!.netP05) troughIdx = i;
  }
  const trough = pts[troughIdx]!;
  const xPeak = x(trough.t);
  const yPeak = y(trough.netP05);
  const peakNearRight = trough.t > T * 0.82;
  // Gross peak = deepest point of the pre-carry p05 floor. Tracked separately
  // from the net trough above — carry only offsets the net line, so the gross
  // adverse floor can (and typically does) bottom out deeper and/or earlier,
  // before enough carry has accrued to cushion it.
  let grossTroughIdx = 0;
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i]!.p05 < pts[grossTroughIdx]!.p05) grossTroughIdx = i;
  }
  const grossTrough = pts[grossTroughIdx]!;
  const xGrossPeak = x(grossTrough.t);
  const yGrossPeak = y(grossTrough.p05);
  const grossPeakNearRight = grossTrough.t > T * 0.82;
  // Avoid stacking both peak labels on top of each other when they land at
  // (near) the same time — nudge the gross label down a touch in that case.
  const peaksOverlap = Math.abs(xGrossPeak - xPeak) < 26;
  const hasCarry = Math.abs(pts[pts.length - 1]!.carryUsdM) > 1e-9;
  const tailPct =
    confidencePct % 1 !== 0
      ? (100 - confidencePct).toFixed(1)
      : String(100 - confidencePct).padStart(2, '0');
  return (
    <div className={className}>
      {showHeader && (
        <>
          <div className="mb-0.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
              CFaR drawdown profile
            </span>
            <span className="text-[9px] text-slate-500">
              net M{trough.t.toFixed(trough.t < 10 ? 1 : 0)} · {fmtK(-trough.netP05)}
              {' · '}
              <span className="text-amber-400/80">
                gross M{grossTrough.t.toFixed(grossTrough.t < 10 ? 1 : 0)} ·{' '}
                {fmtK(-grossTrough.p05)}
              </span>
            </span>
          </div>
          <p className="mb-2 text-[9px] leading-relaxed text-slate-500">
            CriticalCash = maxₜ z·S₀·σ·√t·|g(t)| at {confidencePct}% — the cost
            of bridge-funding the settlement gap via spot+swap at whichever
            point in time is worst, closed form (no simulation). Yellow floor
            = net CFaR; amber marker = gross (before carry offset) — gross
            bottoms out deeper (and often earlier) since carry hasn't accrued
            yet to cushion it.
            {fundingGapLine &&
              ' Fuchsia dashed = the same gap g(t) with zero FX volatility (deterministic floor).'}
          </p>
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
        {/* gross peak marker: vertical guide + dot on the pre-carry p05 trough */}
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
          gross M{grossTrough.t.toFixed(grossTrough.t < 10 ? 1 : 0)} · {fmtK(-grossTrough.p05)}
        </text>
        {/* peak-draw marker: vertical guide + dot on the net-p05 trough */}
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
          net M{trough.t.toFixed(trough.t < 10 ? 1 : 0)} · {fmtK(-trough.netP05)}
        </text>
        <text x={padL - 4} y={y0 + 3} textAnchor="end" fontSize={8} fill="#64748b">$0</text>
        <text x={padL - 4} y={yFloor + 3} textAnchor="end" fontSize={8} fill="#fde047">
          {fmtK(-bands.netCriticalCashUsdM)}
        </text>
      </svg>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[9px] text-slate-500">
        <span><span className="mr-1 inline-block h-2 w-3.5 rounded-sm bg-yellow-400/25 align-middle" />p25–p75 · p05–p95 fan</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-yellow-400 align-middle" />net cash path · p{tailPct} (dashed = gross)</span>
        {hasCarry && (
          <span><span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-emerald-400 align-middle" />carry accrual</span>
        )}
        <span><span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-slate-400 align-middle" />median path</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 border-t-2 border-dotted border-yellow-500 align-middle" />net critical cash floor</span>
        <span className="text-amber-400/80"><span className="mr-1 inline-block h-2 w-2 rounded-full border-2 border-amber-500 align-middle" />gross peak (pre-carry)</span>
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
