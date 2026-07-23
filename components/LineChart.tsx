'use client';

export interface SensPoint { x: number; y: number; }
export interface ChartSeries { name: string; color: string; data: SensPoint[]; }

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
}

export function LineChart({
  series,
  xLabel = '', yLabel = '',
  xUnit = '', yUnit = '',
  xDecimals = 1, yDecimals = 0,
  width = 500, height = 280,
  hRefLine,
  hRefLabel,
}: LineChartProps) {
  const mg = { top: 16, right: 110, bottom: 48, left: 58 };
  const w = width - mg.left - mg.right;
  const h = height - mg.top - mg.bottom;

  const allPts = series.flatMap(s => s.data);
  if (allPts.length === 0) return null;

  const xMin = Math.min(...allPts.map(p => p.x));
  const xMax = Math.max(...allPts.map(p => p.x));
  let yMin = Math.min(...allPts.map(p => p.y));
  let yMax = Math.max(...allPts.map(p => p.y));
  if (hRefLine !== undefined) { yMin = Math.min(yMin, hRefLine); yMax = Math.max(yMax, hRefLine); }
  const yPad = (yMax - yMin) * 0.06 || 1;
  yMin -= yPad; yMax += yPad;

  const xs = (x: number) => ((x - xMin) / (xMax - xMin || 1)) * w;
  const ys = (y: number) => h - ((y - yMin) / (yMax - yMin || 1)) * h;

  const xTicks = 7;
  const yTicks = 6;
  const xTickVals = Array.from({ length: xTicks }, (_, i) => xMin + (xMax - xMin) * i / (xTicks - 1));
  const yTickVals = Array.from({ length: yTicks }, (_, i) => yMin + (yMax - yMin) * i / (yTicks - 1));

  const path = (data: SensPoint[]) =>
    data.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`).join(' ');

  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      <g transform={`translate(${mg.left},${mg.top})`}>
        {/* Grid */}
        {yTickVals.map((t, i) => (
          <line key={i} x1={0} y1={ys(t)} x2={w} y2={ys(t)} stroke="#f3f4f6" strokeWidth={1.5} />
        ))}
        {xTickVals.map((t, i) => (
          <line key={i} x1={xs(t)} y1={0} x2={xs(t)} y2={h} stroke="#f3f4f6" strokeWidth={1.5} />
        ))}

        {/* Reference lines */}
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

        {/* Series */}
        {series.map((s, si) => (
          <path key={si} d={path(s.data)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
        ))}

        {/* Axes */}
        <line x1={0} y1={h} x2={w} y2={h} stroke="#374151" strokeWidth={1.5} />
        <line x1={0} y1={0} x2={0} y2={h} stroke="#374151" strokeWidth={1.5} />

        {/* X ticks */}
        {xTickVals.map((t, i) => (
          <g key={i} transform={`translate(${xs(t)},${h})`}>
            <line y2={4} stroke="#374151" />
            <text y={16} textAnchor="middle" fontSize={10} fill="#6b7280">
              {t.toFixed(xDecimals)}{xUnit}
            </text>
          </g>
        ))}

        {/* Y ticks */}
        {yTickVals.map((t, i) => (
          <g key={i} transform={`translate(0,${ys(t)})`}>
            <line x2={-4} stroke="#374151" />
            <text x={-8} dy="0.35em" textAnchor="end" fontSize={10} fill="#6b7280">
              {t.toFixed(yDecimals)}{yUnit}
            </text>
          </g>
        ))}

        {/* Axis labels */}
        <text x={w / 2} y={h + 40} textAnchor="middle" fontSize={11} fill="#374151">{xLabel}</text>
        <text
          transform={`translate(-44,${h / 2}) rotate(-90)`}
          textAnchor="middle" fontSize={11} fill="#374151"
        >{yLabel}</text>

        {/* Legend */}
        {series.map((s, i) => (
          <g key={i} transform={`translate(${w + 8},${i * 20 + 4})`}>
            <line x2={14} y1={7} y2={7} stroke={s.color} strokeWidth={2.5} />
            <text x={18} y={10} fontSize={10} fill="#374151">{s.name}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
