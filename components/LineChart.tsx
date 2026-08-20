'use client';

import { useId } from 'react';

export interface SensPoint { x: number; y: number; }
export interface ChartSeries {
  name: string;
  color: string;
  data: SensPoint[];
  width?: number;
  dashed?: boolean;
}
export interface ChartMarker {
  x: number;
  y: number;
  label?: string;
  color?: string;
  /** Hollow ring instead of a filled dot — for a "current setting" style marker. */
  ring?: boolean;
  onClick?: () => void;
}

interface LineChartProps {
  series: ChartSeries[];
  xLabel?: string;
  yLabel?: string;
  xUnit?: string;
  yUnit?: string;
  xDecimals?: number;
  yDecimals?: number;
  width?: number;
  height?: number;
  /** Draw a dashed horizontal reference line at this Y value */
  hRefLine?: number;
  hRefLabel?: string;
  /** Point markers (e.g. an auto-detected optimum, or the current setting). */
  markers?: ChartMarker[];
  /** Pin the x-axis instead of fitting every point (zoom around a sweet spot). */
  xDomain?: readonly [number, number];
  showLegend?: boolean;
  /**
   * Signed asinh Y-scale — same mechanism the per-currency frontier's
   * carryFwd uses. Compresses large values while staying near-linear close
   * to $0, so a curve that bends across a wide Y range still reads as a
   * smooth bend instead of a near-straight line dwarfed by its own tail.
   */
  yLog?: boolean;
}

/** asinh(y/s) — linear near 0, log-like for |y| >> s. Same shape as carryFwd. */
function asinhScale(v: number, s: number): number {
  const x = v / Math.max(s, 1e-9);
  return Math.log(x + Math.sqrt(x * x + 1));
}

export function LineChart({
  series,
  xLabel = '', yLabel = '',
  xUnit = '', yUnit = '',
  xDecimals = 1, yDecimals = 0,
  width = 500, height = 280,
  hRefLine,
  hRefLabel,
  markers = [],
  xDomain,
  showLegend = true,
  yLog = false,
}: LineChartProps) {
  const clipRaw = useId();
  const clipId = `lc-clip-${clipRaw.replace(/:/g, '')}`;
  const mg = { top: 16, right: showLegend ? 110 : 18, bottom: 48, left: 58 };
  const w = width - mg.left - mg.right;
  const h = height - mg.top - mg.bottom;

  const allPts = series.flatMap(s => s.data).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (allPts.length === 0) return null;

  const rangePts = [...allPts, ...markers].filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  const dataXMin = Math.min(...rangePts.map(p => p.x));
  const dataXMax = Math.max(...rangePts.map(p => p.x));
  const xMin = xDomain?.[0] ?? dataXMin;
  const xMax = xDomain?.[1] ?? dataXMax;
  const inX = (p: { x: number }) => p.x >= xMin && p.x <= xMax;
  const ySrc = rangePts.filter(inX);
  const yPts = ySrc.length > 0 ? ySrc : rangePts;
  let yMin = Math.min(...yPts.map(p => p.y));
  let yMax = Math.max(...yPts.map(p => p.y));
  if (hRefLine !== undefined) { yMin = Math.min(yMin, hRefLine); yMax = Math.max(yMax, hRefLine); }
  const yPad = (yMax - yMin) * 0.08 || 1;
  yMin -= yPad; yMax += yPad;

  // Scale so the asinh knee sits at ~1/4 of the raw span — linear-looking
  // near 0, compressing (curving) as values grow past it. Same shape as
  // the per-currency frontier's carryFwd, just self-sized from this
  // chart's own data instead of a shared constant.
  const yLogS = Math.max(Math.abs(yMin), Math.abs(yMax), 1e-6) / 4;
  const yFwd = (y: number) => (yLog ? asinhScale(y, yLogS) : y);
  const zMin = yFwd(yMin);
  const zMax = yFwd(yMax);

  const xs = (x: number) => ((x - xMin) / (xMax - xMin || 1)) * w;
  const ys = (y: number) => h - ((yFwd(y) - zMin) / (zMax - zMin || 1)) * h;

  const xTicks = 7;
  const yTicks = 6;
  const xTickVals = Array.from({ length: xTicks }, (_, i) => xMin + (xMax - xMin) * i / (xTicks - 1));
  const yTickVals = Array.from({ length: yTicks }, (_, i) => yMin + (yMax - yMin) * i / (yTicks - 1));

  const path = (data: SensPoint[]) =>
    data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`).join(' ');

  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={w} height={h} />
        </clipPath>
      </defs>
      <g transform={`translate(${mg.left},${mg.top})`}>
        {yTickVals.map((t, i) => (
          <line key={i} x1={0} y1={ys(t)} x2={w} y2={ys(t)} stroke="#f3f4f6" strokeWidth={1.5} />
        ))}
        {xTickVals.map((t, i) => (
          <line key={i} x1={xs(t)} y1={0} x2={xs(t)} y2={h} stroke="#f3f4f6" strokeWidth={1.5} />
        ))}

        {xMin < 0 && xMax > 0 && (
          <line x1={xs(0)} y1={0} x2={xs(0)} y2={h} stroke="#9ca3af" strokeWidth={1} strokeDasharray="5,3" />
        )}
        {hRefLine !== undefined && yMin < hRefLine && hRefLine < yMax && (
          <>
            <line x1={0} y1={ys(hRefLine)} x2={w} y2={ys(hRefLine)} stroke="#9ca3af" strokeWidth={1} strokeDasharray="5,3" />
            {hRefLabel && (
              <text x={w + 4} y={ys(hRefLine) + 4} fontSize={9} fill="#6b7280">{hRefLabel}</text>
            )}
          </>
        )}

        <g clipPath={`url(#${clipId})`}>
          {series.map((s, si) => (
            <path
              key={si}
              d={path(s.data)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width ?? 2}
              strokeDasharray={s.dashed ? '6 4' : undefined}
              strokeLinejoin="round"
            />
          ))}
        </g>

        {markers.filter(inX).map((m, mi) => (
          <g
            key={mi}
            transform={`translate(${xs(m.x).toFixed(1)},${ys(m.y).toFixed(1)})`}
            onClick={m.onClick}
            style={m.onClick ? { cursor: 'pointer' } : undefined}
            role={m.onClick ? 'button' : undefined}
          >
            {m.ring ? (
              <circle r={5} fill="none" stroke={m.color ?? '#374151'} strokeWidth={2} />
            ) : (
              <circle r={4} fill={m.color ?? '#374151'} stroke="#fff" strokeWidth={1.5} />
            )}
            {m.label && (
              <text y={-9} textAnchor="middle" fontSize={9} fontWeight={600} fill={m.color ?? '#374151'}>
                {m.label}
              </text>
            )}
          </g>
        ))}

        <line x1={0} y1={h} x2={w} y2={h} stroke="#374151" strokeWidth={1.5} />
        <line x1={0} y1={0} x2={0} y2={h} stroke="#374151" strokeWidth={1.5} />

        {xTickVals.map((t, i) => (
          <g key={i} transform={`translate(${xs(t)},${h})`}>
            <line y2={4} stroke="#374151" />
            <text y={16} textAnchor="middle" fontSize={10} fill="#6b7280">
              {t.toFixed(xDecimals)}{xUnit}
            </text>
          </g>
        ))}

        {yTickVals.map((t, i) => (
          <g key={i} transform={`translate(0,${ys(t)})`}>
            <line x2={-4} stroke="#374151" />
            <text x={-8} dy="0.35em" textAnchor="end" fontSize={10} fill="#6b7280">
              {t.toFixed(yDecimals)}{yUnit}
            </text>
          </g>
        ))}

        <text x={w / 2} y={h + 40} textAnchor="middle" fontSize={11} fill="#374151">{xLabel}</text>
        <text
          transform={`translate(-44,${h / 2}) rotate(-90)`}
          textAnchor="middle" fontSize={11} fill="#374151"
        >{yLabel}</text>

        {showLegend && series.map((s, i) => (
          <g key={i} transform={`translate(${w + 8},${i * 20 + 4})`}>
            <line x2={14} y1={7} y2={7} stroke={s.color} strokeWidth={2.5} />
            <text x={18} y={10} fontSize={10} fill="#374151">{s.name}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
