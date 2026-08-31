'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, RotateCcw, ZoomIn } from 'lucide-react';
import {
  fxAtlasMixWorseThanFrontier,
  type FxCarryVarPoint,
} from '@/lib/test-mode/fx-var-frontier';

const LIVE_YELLOW = '#facc15';

type ChartPrefs = {
  showGrid: boolean;
  showUnhedged: boolean;
  showCrosshairs: boolean;
  showHoverTip: boolean;
};

const DEFAULT_PREFS: ChartPrefs = {
  showGrid: true,
  showUnhedged: true,
  showCrosshairs: true,
  showHoverTip: true,
};

const TOOL_BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-600 bg-slate-950/90 text-slate-300 shadow-lg shadow-slate-950/50 backdrop-blur-sm hover:border-slate-400 hover:text-slate-100';

function fmtM(usdM: number): string {
  if (!Number.isFinite(usdM)) return '0.00';
  const abs = Math.abs(usdM);
  if (abs < 5e-7) return '0.00';
  if (abs < 0.001) return usdM.toFixed(5);
  if (abs < 0.01) return usdM.toFixed(4);
  if (abs < 0.1) return usdM.toFixed(3);
  return usdM.toFixed(2);
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

function mixEntries(point: FxCarryVarPoint): { ccy: string; pct: number }[] {
  return Object.entries(point.hedgeByCcy ?? {})
    .map(([ccy, w]) => ({ ccy, pct: Math.round(Math.min(1, Math.max(0, w)) * 100) }))
    .sort((a, b) => a.ccy.localeCompare(b.ccy));
}

type PlotView = { xMin: number; xMax: number; yMin: number; yMax: number };

function svgClientToLocal(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const loc = pt.matrixTransform(ctm.inverse());
  return { x: loc.x, y: loc.y };
}

function nearestPoint(
  series: readonly FxCarryVarPoint[],
  xOf: (v: number) => number,
  yOf: (v: number) => number,
  px: number,
  py: number,
): { point: FxCarryVarPoint; d2: number } | null {
  let best: FxCarryVarPoint | null = null;
  let bestD = Infinity;
  for (const p of series) {
    const dx = xOf(p.divVarUsdM) - px;
    const dy = yOf(p.carryUsdYrM) - py;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ? { point: best, d2: bestD } : null;
}

function clampView(next: PlotView, world: PlotView): PlotView {
  const worldX = Math.max(world.xMax - world.xMin, 1e-6);
  const worldY = Math.max(world.yMax - world.yMin, 1e-6);
  const minX = worldX * 0.05;
  const minY = worldY * 0.05;
  const xLo = world.xMin - worldX * 0.2;
  const xHi = world.xMax + worldX * 0.2;
  const yLo = world.yMin - worldY * 0.2;
  const yHi = world.yMax + worldY * 0.2;
  let xSpan = Math.min(Math.max(next.xMax - next.xMin, minX), xHi - xLo);
  let ySpan = Math.min(Math.max(next.yMax - next.yMin, minY), yHi - yLo);
  let xMin = next.xMin;
  if (xMin < xLo) xMin = xLo;
  if (xMin + xSpan > xHi) xMin = xHi - xSpan;
  let yMin = next.yMin;
  if (yMin < yLo) yMin = yLo;
  if (yMin + ySpan > yHi) yMin = yHi - ySpan;
  return { xMin, xMax: xMin + xSpan, yMin, yMax: yMin + ySpan };
}

function inPlotRect(
  x: number,
  y: number,
  L: number,
  T: number,
  plotW: number,
  plotH: number,
): boolean {
  return x >= L && x <= L + plotW && y >= T && y <= T + plotH;
}

function fmtSignedM(usdM: number): string {
  const abs = fmtM(Math.abs(usdM));
  if (Math.abs(usdM) < 5e-4) return '0.00';
  return usdM < 0 ? `−${abs}` : `+${abs}`;
}

function MixLines({ point }: { point: FxCarryVarPoint }) {
  const rows = mixEntries(point);
  if (rows.length === 0) return null;
  const hedged = rows.filter(r => r.pct > 0);
  const open = rows.filter(r => r.pct <= 0);
  const carryBits = rows
    .filter(r => r.pct > 0)
    .map(r => {
      const hx = point.carryByCcy?.[r.ccy];
      if (hx == null || !Number.isFinite(hx)) return null;
      return { ccy: r.ccy, hx };
    })
    .filter((x): x is { ccy: string; hx: number } => x != null);
  return (
    <>
      <span className="text-emerald-300">
        Hedged {hedged.length ? hedged.map(r => `${r.ccy} ${r.pct}%`).join(' · ') : '—'}
      </span>
      <span className="text-orange-300">
        Open {open.length ? open.map(r => r.ccy).join(' · ') : '—'}
      </span>
      {carryBits.length > 0 ? (
        <span>
          {carryBits.map((r, i) => (
            <span key={r.ccy}>
              {i > 0 ? ' · ' : ''}
              <span className={r.hx < 0 ? 'text-rose-300' : 'text-emerald-300'}>
                {r.ccy} {fmtSignedM(r.hx)}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

function markerStroke(p: FxCarryVarPoint, sweetId?: string | null, openId?: string | null): string {
  if (p.id === sweetId) return '#16a34a';
  if (p.id === openId) return '#f97316';
  return '#7dd3fc';
}

function ChartChrome({
  onExpand,
  prefs,
  onPrefsChange,
  onResetZoom,
  onRestoreTune,
}: {
  onExpand?: () => void;
  prefs: ChartPrefs;
  onPrefsChange: (next: ChartPrefs) => void;
  onResetZoom: () => void;
  onRestoreTune?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menu]);

  const rows: { key: keyof ChartPrefs; label: string }[] = [
    { key: 'showGrid', label: 'Grid lines' },
    { key: 'showUnhedged', label: 'Unhedged point' },
    { key: 'showCrosshairs', label: 'Axis crosshairs' },
    { key: 'showHoverTip', label: 'Hover mix tip' },
  ];

  return (
    <div ref={boxRef} className="absolute right-2.5 top-2 z-20 flex items-center gap-1">
      {onRestoreTune ? (
        <button
          type="button"
          onClick={onRestoreTune}
          title="Restore the selected mix"
          aria-label="Restore the selected mix"
          className={`${TOOL_BTN} text-amber-200 hover:border-amber-400/70 hover:text-amber-100`}
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.85} />
        </button>
      ) : null}
      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          title="Zoom chart"
          aria-label="Zoom chart"
          className={TOOL_BTN}
        >
          <ZoomIn className="h-3.5 w-3.5" strokeWidth={1.85} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setMenu(v => !v)}
        title="Chart setup"
        aria-label="Chart setup"
        aria-expanded={menu}
        aria-haspopup="menu"
        className={TOOL_BTN}
      >
        <MoreVertical className="h-3.5 w-3.5" strokeWidth={1.85} />
      </button>
      {menu ? (
        <div
          role="menu"
          className="absolute right-0 top-8 w-48 overflow-hidden rounded-md border border-slate-700 bg-slate-900 py-1 shadow-xl shadow-slate-950/70"
        >
          <div className="px-2.5 pb-1 pt-1 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            Chart setup
          </div>
          {rows.map(row => (
            <button
              key={row.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={prefs[row.key]}
              onClick={() => onPrefsChange({ ...prefs, [row.key]: !prefs[row.key] })}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-slate-200 hover:bg-slate-800"
            >
              <span
                className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
                  prefs[row.key]
                    ? 'border-sky-400 bg-sky-400 text-slate-950'
                    : 'border-slate-600 bg-slate-950'
                }`}
              >
                {prefs[row.key] ? '✓' : ''}
              </span>
              {row.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onResetZoom();
              setMenu(false);
            }}
            className="mt-0.5 w-full border-t border-slate-800 px-2.5 py-1.5 text-left font-mono text-[11px] text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          >
            Reset zoom
          </button>
        </div>
      ) : null}
    </div>
  );
}

type PlotProps = {
  curve?: readonly FxCarryVarPoint[];
  unhedged?: FxCarryVarPoint | null;
  walk?: readonly FxCarryVarPoint[];
  pareto?: readonly FxCarryVarPoint[];
  confidencePct: number;
  selectedId?: string | null;
  sweetId?: string | null;
  onSelect?: (point: FxCarryVarPoint) => void;
  size: 'compact' | 'modal';
  onExpand?: () => void;
  prefs: ChartPrefs;
  onPrefsChange: (next: ChartPrefs) => void;
  livePoint?: FxCarryVarPoint | null;
  fillHeight?: boolean;
  onRestoreTune?: () => void;
};

function FrontierPlot({
  curve,
  unhedged,
  walk,
  pareto,
  confidencePct,
  selectedId,
  sweetId,
  onSelect,
  size,
  onExpand,
  prefs,
  onPrefsChange,
  livePoint,
  fillHeight,
  onRestoreTune,
}: PlotProps) {
  const [hover, setHover] = useState<FxCarryVarPoint | null>(null);
  const [view, setView] = useState<PlotView | null>(null);
  const [panning, setPanning] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipRaw = useId();
  const clipId = `fx-frontier-clip-${clipRaw.replace(/:/g, '')}`;
  const dragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const viewRef = useRef<{
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    world: PlotView;
    L: number;
    T: number;
    plotW: number;
    plotH: number;
    setView: (next: PlotView) => void;
  } | null>(null);

  const raw = (curve && curve.length >= 1
    ? curve
    : pareto && pareto.length >= 2
      ? pareto
      : walk) ?? [];
  const sweetIdx = sweetId ? raw.findIndex(p => p.id === sweetId) : -1;
  const efficient = sweetIdx >= 0 ? raw.slice(0, sweetIdx + 1) : raw;
  const open = unhedged
    && !efficient.some(p => p.id === unhedged.id)
    ? unhedged
    : null;

  const xs = [
    ...efficient.map(p => p.divVarUsdM),
    open?.divVarUsdM ?? 0,
    livePoint?.divVarUsdM ?? 0,
  ];
  const ys = [
    ...efficient.map(p => p.carryUsdYrM),
    open?.carryUsdYrM ?? 0,
    livePoint?.carryUsdYrM ?? 0,
  ];
  const dataXMax = Math.max(...xs, 0.05);
  const dataYMin = Math.min(0, ...ys);
  const dataYMax = Math.max(0, ...ys);
  const yScale = Math.max(Math.abs(dataYMax), Math.abs(dataYMin), 1e-6);
  const ySpan = Math.max(dataYMax - dataYMin, yScale * 0.05, 1e-6);
  const yPad = fillHeight ? 0.07 : 0.16;
  const auto: PlotView = {
    xMin: 0,
    xMax: dataXMax * 1.18,
    yMin: dataYMin - ySpan * yPad,
    yMax: dataYMax + ySpan * (fillHeight ? 0.08 : 0.18),
  };
  const world: PlotView = {
    xMin: 0,
    xMax: Math.max(auto.xMax, dataXMax) * 1.25,
    yMin: auto.yMin - ySpan * 0.35,
    yMax: auto.yMax + ySpan * 0.35,
  };

  useEffect(() => {
    setView(null);
  }, [raw.length, unhedged?.id, sweetId]);

  const xMin = view?.xMin ?? auto.xMin;
  const xMax = view?.xMax ?? auto.xMax;
  const yMin = view?.yMin ?? auto.yMin;
  const yMax = view?.yMax ?? auto.yMax;
  const modal = size === 'modal';
  const W = modal ? 1100 : 720;
  const H = modal ? 620 : fillHeight ? 560 : 360;
  const L = modal ? 78 : 64;
  const R = modal ? 56 : 48;
  const T = modal ? 36 : fillHeight ? 18 : 32;
  const B = modal ? 56 : fillHeight ? 34 : 44;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const xOf = (v: number) => L + ((v - xMin) / (xMax - xMin || 1)) * plotW;
  const yOf = (v: number) => T + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;
  const xTicks = niceTicks(xMin, xMax, modal ? 10 : 8)
    .filter(v => v >= xMin - 1e-9 && v <= xMax + 1e-9);
  const yTicks = niceTicks(yMin, yMax, modal ? 8 : 6)
    .filter(v => v >= yMin - 1e-9 && v <= yMax + 1e-9);
  const yDecimals = (yMax - yMin) >= 10 ? 0
    : (yMax - yMin) < 0.001 ? 5
      : (yMax - yMin) < 0.01 ? 4
        : (yMax - yMin) < 0.1 ? 3
          : 2;

  const pathD = efficient
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.divVarUsdM).toFixed(1)},${yOf(p.carryUsdYrM).toFixed(1)}`)
    .join(' ');
  const visibleOpen = prefs.showUnhedged ? open : null;
  const liveWorse = Boolean(
    livePoint && fxAtlasMixWorseThanFrontier(livePoint, efficient),
  );
  const markers = [...efficient, ...(visibleOpen ? [visibleOpen] : [])];
  const pickSeries = livePoint ? [...markers, livePoint] : markers;
  const selected = livePoint
    ?? markers.find(p => p.id === selectedId)
    ?? null;
  const tail = Math.max(1, Math.round(100 - confidencePct));
  const pickable = Boolean(onSelect);
  const hitR = modal ? 26 : 22;

  viewRef.current = {
    xMin, xMax, yMin, yMax, world, L, T, plotW, plotH, setView,
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const z = viewRef.current;
      const loc = svgClientToLocal(el, e.clientX, e.clientY);
      if (!z || !loc || !inPlotRect(loc.x, loc.y, z.L, z.T, z.plotW, z.plotH)) return;
      e.preventDefault();
      const rawDelta = e.deltaMode === 1
        ? e.deltaY * 16
        : e.deltaMode === 2
          ? Math.sign(e.deltaY) * z.plotH
          : e.deltaY;
      if (rawDelta === 0) return;
      const factor = Math.exp(Math.max(-12, Math.min(12, rawDelta)) * (e.ctrlKey ? 0.0035 : 0.002));
      if (Math.abs(factor - 1) < 0.001) return;
      const ax = z.xMin + ((loc.x - z.L) / z.plotW) * (z.xMax - z.xMin);
      const ay = z.yMax - ((loc.y - z.T) / z.plotH) * (z.yMax - z.yMin);
      z.setView(clampView({
        xMin: ax - (ax - z.xMin) * factor,
        xMax: ax + (z.xMax - ax) * factor,
        yMin: ay - (ay - z.yMin) * factor,
        yMax: ay + (z.yMax - ay) * factor,
      }, z.world));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pickFromClient = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const loc = svgClientToLocal(svg, clientX, clientY);
    if (!loc) return null;
    return nearestPoint(pickSeries, xOf, yOf, loc.x, loc.y);
  };

  const endPan = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.moved) {
      suppressClickRef.current = true;
      queueMicrotask(() => { suppressClickRef.current = false; });
    }
    dragRef.current = null;
    setPanning(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  const zeroY = yOf(0);
  const hoverCx = hover ? xOf(hover.divVarUsdM) : 0;
  const hoverCy = hover ? yOf(hover.carryUsdYrM) : 0;
  const floatRight = hoverCx < W * 0.62;
  const floatBelow = hoverCy < T + 72;
  const sweetPt = markers.find(p => p.id === sweetId) ?? null;
  const liveOnSweet = Boolean(
    livePoint
    && sweetPt
    && Math.hypot(
      xOf(livePoint.divVarUsdM) - xOf(sweetPt.divVarUsdM),
      yOf(livePoint.carryUsdYrM) - yOf(sweetPt.carryUsdYrM),
    ) < 8,
  );
  const showLive = Boolean(livePoint && !(liveOnSweet && !liveWorse));
  const selFill = liveWorse ? LIVE_YELLOW : '#7dd3fc';
  const selStroke = selFill;
  const selCx = selected ? xOf(selected.divVarUsdM) : 0;
  const selCy = selected ? yOf(selected.carryUsdYrM) : 0;
  const axisY = H - B;

  if (efficient.length === 0 && !unhedged) return null;

  return (
    <div className={`relative rounded-xl border border-slate-800 bg-slate-950/50 ${
      fillHeight ? 'flex h-full min-h-[360px] flex-col px-2.5 pb-1.5 pt-1.5' : 'p-4'
    }`}>
      <ChartChrome
        onExpand={onExpand}
        prefs={prefs}
        onPrefsChange={onPrefsChange}
        onResetZoom={() => setView(null)}
        onRestoreTune={onRestoreTune}
      />
      <div className={`relative ${fillHeight ? 'min-h-0 flex-1' : ''}`}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          className={`${
            modal
              ? 'h-[min(70vh,640px)]'
              : fillHeight
                ? 'h-full min-h-0'
                : 'h-[360px]'
          } w-full ${
            panning ? 'cursor-grabbing' : pickable ? 'cursor-pointer' : 'cursor-crosshair'
          }`}
          role="img"
          aria-label={`${tail}%-ile VaR versus carry benefit. Scroll to zoom, drag to pan.`}
          onDoubleClick={() => setView(null)}
          onPointerDown={e => {
            if (e.button !== 0) return;
            const loc = svgClientToLocal(e.currentTarget, e.clientX, e.clientY);
            if (!loc || !inPlotRect(loc.x, loc.y, L, T, plotW, plotH)) return;
            const hit = nearestPoint(pickSeries, xOf, yOf, loc.x, loc.y);
            if (hit && hit.d2 <= hitR * hitR) return;
            dragRef.current = {
              pointerId: e.pointerId,
              lastX: loc.x,
              lastY: loc.y,
              moved: false,
            };
          }}
          onPointerMove={e => {
            const drag = dragRef.current;
            if (drag && drag.pointerId === e.pointerId) {
              const loc = svgClientToLocal(e.currentTarget, e.clientX, e.clientY);
              if (!loc) return;
              const dx = loc.x - drag.lastX;
              const dy = loc.y - drag.lastY;
              if (!drag.moved && Math.hypot(dx, dy) < 3) return;
              if (!drag.moved) {
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* already captured */ }
              }
              drag.moved = true;
              drag.lastX = loc.x;
              drag.lastY = loc.y;
              if (!panning) setPanning(true);
              const z = viewRef.current;
              if (!z) return;
              const xSpan = z.xMax - z.xMin;
              const ySpan = z.yMax - z.yMin;
              z.setView(clampView({
                xMin: z.xMin - (dx / z.plotW) * xSpan,
                xMax: z.xMax - (dx / z.plotW) * xSpan,
                yMin: z.yMin + (dy / z.plotH) * ySpan,
                yMax: z.yMax + (dy / z.plotH) * ySpan,
              }, z.world));
              return;
            }
            const hit = pickFromClient(e.clientX, e.clientY);
            setHover(hit && hit.d2 <= hitR * hitR ? hit.point : null);
          }}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onClick={e => {
            if (!onSelect || suppressClickRef.current) return;
            const hit = pickFromClient(e.clientX, e.clientY);
            if (hit && hit.d2 <= hitR * hitR && hit.point.id !== 'live-mix') {
              onSelect(hit.point);
            }
          }}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={L} y={T} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          {yTicks.map(v => {
            const hide = Boolean(
              selected
              && prefs.showCrosshairs
              && Math.abs(yOf(v) - selCy) < 11,
            );
            return (
              <g key={`y-${v}`}>
                {prefs.showGrid ? (
                  <line x1={L} y1={yOf(v)} x2={W - R} y2={yOf(v)} stroke="#1e293b" strokeWidth="1" />
                ) : null}
                {hide ? null : (
                  <text x={L - 6} y={yOf(v) + 3} textAnchor="end" fill="#94a3b8" fontSize={modal ? 11 : 9}>
                    {v.toFixed(yDecimals)}
                  </text>
                )}
              </g>
            );
          })}
          {xTicks.map(v => {
            const hide = Boolean(
              selected
              && prefs.showCrosshairs
              && Math.abs(xOf(v) - selCx) < 18,
            );
            return hide ? null : (
              <text
                key={`x-${v}`}
                x={xOf(v)}
                y={H - 22}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize={modal ? 11 : 9}
              >
                {v >= 10 ? v.toFixed(0) : v.toFixed(1)}
              </text>
            );
          })}
          <g clipPath={`url(#${clipId})`}>
            <line
              x1={L}
              y1={zeroY}
              x2={W - R}
              y2={zeroY}
          stroke="#e2e8f0"
          strokeWidth="0.8"
            />
            {pathD && (
              <path
                d={pathD}
                fill="none"
                stroke="#7dd3fc"
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {selected && prefs.showCrosshairs && (
              <g pointerEvents="none">
                <line
                  x1={L}
                  y1={selCy}
                  x2={selCx}
                  y2={selCy}
                  stroke={selStroke}
                  strokeWidth="1.2"
                  strokeDasharray="4 3"
                  opacity="0.85"
                />
                <line
                  x1={selCx}
                  y1={selCy}
                  x2={selCx}
                  y2={axisY}
                  stroke={selStroke}
                  strokeWidth="1.2"
                  strokeDasharray="4 3"
                  opacity="0.85"
                />
              </g>
            )}
            {markers.map(p => {
              const on = !livePoint && p.id === selectedId;
              const sweet = p.id === sweetId;
              const isOpen = open?.id === p.id;
              const lit = hover?.id === p.id;
              const stroke = markerStroke(p, sweetId, open?.id);
              const r = sweet || isOpen ? (on || lit ? 8.5 : 7) : on || lit ? 6 : 3.6;
              return (
                <g key={p.id}>
                  <circle
                    cx={xOf(p.divVarUsdM)}
                    cy={yOf(p.carryUsdYrM)}
                    r={hitR}
                    fill="transparent"
                    onClick={e => {
                      e.stopPropagation();
                      if (suppressClickRef.current) return;
                      onSelect?.(p);
                    }}
                  />
                  <circle
                    cx={xOf(p.divVarUsdM)}
                    cy={yOf(p.carryUsdYrM)}
                    r={r}
                    fill={on ? selFill : '#0f172a'}
                    stroke={stroke}
                    strokeWidth={on || sweet || isOpen || lit ? 2.6 : 1.3}
                    pointerEvents="none"
                  />
                </g>
              );
            })}
            {showLive && livePoint ? (
              <g>
                <circle
                  cx={xOf(livePoint.divVarUsdM)}
                  cy={yOf(livePoint.carryUsdYrM)}
                  r={hitR}
                  fill="transparent"
                />
                <circle
                  cx={xOf(livePoint.divVarUsdM)}
                  cy={yOf(livePoint.carryUsdYrM)}
                  r={hover?.id === livePoint.id ? 8.5 : 7.5}
                  fill={selFill}
                  stroke={liveOnSweet ? '#16a34a' : selStroke}
                  strokeWidth="2.6"
                  pointerEvents="none"
                />
              </g>
            ) : null}
            {sweetPt && !(showLive && liveOnSweet) ? (
              <circle
                cx={xOf(sweetPt.divVarUsdM)}
                cy={yOf(sweetPt.carryUsdYrM)}
                r={
                  selected?.id === sweetId || hover?.id === sweetId ? 8.5 : 7
                }
                fill={selected?.id === sweetId && !showLive ? selFill : '#0f172a'}
                stroke="#16a34a"
                strokeWidth="2.6"
                pointerEvents="none"
              />
            ) : null}
          </g>
          {selected && prefs.showCrosshairs && (
            <g pointerEvents="none">
              <rect
                x={L - 46}
                y={selCy - 8}
                width="40"
                height="14"
                rx="2"
                fill="#0f172a"
                stroke={selStroke}
                strokeWidth="1"
              />
              <text
                x={L - 6}
                y={selCy + 3}
                textAnchor="end"
                fill={selStroke}
                fontSize={modal ? 11 : 9}
              >
                {selected.carryUsdYrM.toFixed(yDecimals)}
              </text>
              <rect
                x={selCx - 18}
                y={H - 22 - 10}
                width="36"
                height="14"
                rx="2"
                fill="#0f172a"
                stroke={selStroke}
                strokeWidth="1"
              />
              <text
                x={selCx}
                y={H - 22}
                textAnchor="middle"
                fill={selStroke}
                fontSize={modal ? 11 : 9}
              >
                {selected.divVarUsdM >= 10
                  ? selected.divVarUsdM.toFixed(0)
                  : selected.divVarUsdM.toFixed(1)}
              </text>
            </g>
          )}
          <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fill="#94a3b8" fontSize={modal ? 12 : 10}>
            {tail}%-ile VaR (USDmm)
          </text>
          <text
            x="12"
            y={(T + H - B) / 2}
            textAnchor="middle"
            fill="#94a3b8"
            fontSize={modal ? 12 : 10}
            transform={`rotate(-90 12 ${(T + H - B) / 2})`}
          >
            Carry Benefit (Cost) (USDmm)
          </text>
        </svg>
        {hover && prefs.showHoverTip && (
          <div
            className="pointer-events-none absolute z-20 inline-flex max-w-[min(100%,22rem)] flex-col gap-0.5 rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 shadow-lg shadow-slate-950/50"
            style={{
              left: `${(hoverCx / W) * 100}%`,
              top: `${(hoverCy / H) * 100}%`,
              transform: floatBelow
                ? (floatRight ? 'translate(12px, 10px)' : 'translate(calc(-100% - 12px), 10px)')
                : (floatRight ? 'translate(12px, calc(-100% - 10px))' : 'translate(calc(-100% - 12px), calc(-100% - 10px))'),
            }}
          >
            <span>{tail}%-ile VaR {fmtM(hover.divVarUsdM)}</span>
            <span>Carry {fmtM(hover.carryUsdYrM)}</span>
            <MixLines point={hover} />
            {hover.id === 'live-mix' ? (
              <span className={liveWorse ? 'text-yellow-300' : 'text-sky-300'}>
                {liveWorse
                  ? 'Tweaked mix · worse than the set (lower carry / higher VaR)'
                  : 'Tweaked mix'}
              </span>
            ) : hover.id === sweetId ? (
              <span className="text-emerald-300">Recommended mix</span>
            ) : hover.id === open?.id ? (
              <span className="text-orange-300">Unhedged · not on the efficient set</span>
            ) : null}
            {pickable && hover.id !== 'live-mix' ? (
              <span className="text-slate-500">Click to apply this hedge mix</span>
            ) : null}
          </div>
        )}
      </div>
      <div className={`${fillHeight ? 'mt-1' : 'mt-2'} flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-500`}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-6 rounded-sm bg-sky-300/80" />
          Efficient set (stops at max carry)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-green-600 bg-slate-950" />
          Recommended
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-orange-500 bg-slate-950" />
          Unhedged · Basic carry = 0
        </span>
        {livePoint ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: liveWorse ? LIVE_YELLOW : '#7dd3fc' }}
            />
            {liveWorse ? 'Tweaked · worse than the set' : 'Tweaked mix'}
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[9px] text-slate-600">
          Scroll to zoom · drag to pan · double-click to reset
        </span>
      </div>
    </div>
  );
}

/** Atlas Basic plot: blue efficient set stops at max carry; unhedged is off the line at Y=0. */
export function FxCarryVarFrontierChart({
  curve,
  unhedged,
  walk,
  pareto,
  confidencePct,
  selectedId,
  sweetId,
  livePoint,
  onSelect,
  fillHeight,
  onRestoreTune,
}: {
  curve?: readonly FxCarryVarPoint[];
  unhedged?: FxCarryVarPoint | null;
  walk?: readonly FxCarryVarPoint[];
  pareto?: readonly FxCarryVarPoint[];
  confidencePct: number;
  selectedId?: string | null;
  sweetId?: string | null;
  livePoint?: FxCarryVarPoint | null;
  onSelect?: (point: FxCarryVarPoint) => void;
  fillHeight?: boolean;
  onRestoreTune?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [prefs, setPrefs] = useState<ChartPrefs>(DEFAULT_PREFS);
  const plot = {
    curve,
    unhedged,
    walk,
    pareto,
    confidencePct,
    selectedId,
    sweetId,
    livePoint,
    onSelect,
    onRestoreTune,
    prefs,
    onPrefsChange: setPrefs,
  } as const;

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  return (
    <>
      <div className={fillHeight ? 'h-full min-h-0' : undefined}>
      <FrontierPlot
        {...plot}
        fillHeight={fillHeight}
        size="compact"
        onExpand={() => setExpanded(true)}
      />
      </div>
      {expanded && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[220] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="frontier-enlarge-title"
              onClick={e => {
                if (e.target === e.currentTarget) setExpanded(false);
              }}
            >
              <div className="flex max-h-[94vh] w-full max-w-[1180px] flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
                  <div>
                    <h2 id="frontier-enlarge-title" className="text-sm font-medium text-slate-100">
                      Carry vs VaR
                    </h2>
                    <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                      Enlarged efficient set · scroll to zoom · drag to pan · double-click to reset
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="rounded-md border border-slate-600 px-2.5 py-1 font-mono text-[11px] text-slate-300 hover:border-slate-400 hover:text-slate-100"
                  >
                    Close
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <FrontierPlot {...plot} size="modal" />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
