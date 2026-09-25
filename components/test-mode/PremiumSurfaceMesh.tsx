'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OptionPremiumSurface } from '@/lib/test-mode/sim-ticket-price';

const BG = '#020617';
const GRID = '#1e293b';
const AXIS = '#475569';
const TEXT = '#94a3b8';
const MUTED = '#64748b';
const HAIR = '#e2e8f0';
const PICK = '#38bdf8';
const PREM = '#38bdf8';
const RAMP = [
  { t: 0, r: 15, g: 118, b: 110 },
  { t: 0.18, r: 14, g: 165, b: 233 },
  { t: 0.38, r: 45, g: 212, b: 191 },
  { t: 0.55, r: 250, g: 204, b: 21 },
  { t: 0.74, r: 251, g: 146, b: 60 },
  { t: 0.88, r: 251, g: 113, b: 133 },
  { t: 1, r: 244, g: 63, b: 94 },
] as const;

export type SurfaceMetric = 'premium' | 'vol';
export type SurfaceViewMode = 'mesh' | 'grid';

export function SurfaceChipGroup<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { id: T; label: string }[];
  ariaLabel: string;
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

export function PremiumSurfaceToolbar({
  metric,
  onMetric,
  mode,
  onMode,
}: {
  metric: SurfaceMetric;
  onMetric: (next: SurfaceMetric) => void;
  mode: SurfaceViewMode;
  onMode: (next: SurfaceViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <SurfaceChipGroup
        value={metric}
        onChange={onMetric}
        ariaLabel="Surface height"
        options={[
          { id: 'premium', label: 'Prem' },
          { id: 'vol', label: 'Vol' },
        ]}
      />
      <SurfaceChipGroup
        value={mode}
        onChange={onMode}
        ariaLabel="Surface view"
        options={[
          { id: 'mesh', label: '3D' },
          { id: 'grid', label: 'Grid' },
        ]}
      />
    </div>
  );
}

type Knot = {
  yi: number;
  ti: number;
  x: number;
  y: number;
  z: number;
  t: number;
  label: string;
  title: string;
};

type Quad = {
  a: Knot;
  b: Knot;
  c: Knot;
  d: Knot;
  t: number;
  selected: boolean;
};

type Cam = { yaw: number; zoom: number; panY: number };

const DEFAULT_CAM: Cam = { yaw: 0, zoom: 1, panY: 0 };

function fmtPx(px: number): string {
  if (!(px > 0) || !Number.isFinite(px)) return '—';
  if (px >= 20) return px.toFixed(2);
  if (px >= 1) return px.toFixed(4);
  return px.toFixed(5);
}

function fmtVol(pct: number): string {
  return `${pct.toFixed(2)}%`;
}

function fmtUsd(v: number): string {
  return `$${Math.round(v).toLocaleString()}`;
}

function fmtPrem(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 10_000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v).toLocaleString()}`;
}

function labelChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  align: 'center' | 'left' | 'right',
  cssW: number,
  cssH: number,
) {
  if (!text) return;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const tw = ctx.measureText(text).width;
  const padX = 5;
  const bh = 16;
  const bw = tw + padX * 2;
  let lx = align === 'right' ? x - bw : align === 'left' ? x : x - bw / 2;
  let ly = y - bh / 2;
  lx = Math.max(3, Math.min(cssW - bw - 3, lx));
  ly = Math.max(3, Math.min(cssH - bh - 3, ly));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(lx, ly, bw, bh, 3);
  else ctx.rect(lx, ly, bw, bh);
  ctx.fillStyle = 'rgba(2, 6, 23, 0.94)';
  ctx.fill();
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = PICK;
  ctx.fillText(text, lx + padX, ly + 12);
}

function pickDot(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = PICK;
  ctx.fill();
}

function nearestIndex(values: number[], target: number): number {
  if (values.length === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  values.forEach((v, i) => {
    const d = Math.abs(v - target);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

function log01(v: number, lo: number, hi: number): number {
  const a = Math.log(Math.max(v, 1e-9));
  const b = Math.log(Math.max(lo, 1e-9));
  const c = Math.log(Math.max(hi, lo * 1.0001, 1e-9));
  return Math.min(1, Math.max(0, (a - b) / (c - b)));
}

function rgba(
  r: number,
  g: number,
  b: number,
  a = 1,
): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}

function sampleRamp(t: number) {
  const u = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < RAMP.length - 2 && u > RAMP[i + 1]!.t) i += 1;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  const s = (u - a.t) / Math.max(b.t - a.t, 1e-6);
  return {
    r: a.r + (b.r - a.r) * s,
    g: a.g + (b.g - a.g) * s,
    b: a.b + (b.b - a.b) * s,
  };
}

function mixRgb(t: number, lit: number) {
  const c = sampleRamp(t);
  const k = 0.78 + 0.22 * Math.min(1, Math.max(0.25, lit));
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

function rotate(p: { x: number; y: number; z: number }, cam: Cam) {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const x = p.x + 1;
  const z = p.z + 1;
  return {
    x: x * cy - z * sy,
    y: p.y,
    z: x * sy + z * cy,
  };
}

function project(
  p: { x: number; y: number; z: number },
  cam: Cam,
  w: number,
  h: number,
) {
  const r = rotate(p, cam);
  const s = Math.min(w, h) * 0.3 * cam.zoom;
  const isoX = Math.cos(Math.PI / 6);
  const isoY = 0.28;
  return {
    x: w * 0.5 + (r.x - r.z) * isoX * s,
    y: h * 0.84 - r.y * s - (r.x + r.z) * isoY * s + (cam.panY || 0),
    depth: r.x + r.z,
    rx: r.x,
    ry: r.y,
    rz: r.z,
  };
}

function buildKnots(
  surface: OptionPremiumSurface,
  metric: SurfaceMetric,
): { knots: Knot[][]; selY: number; selT: number } {
  const selT = nearestIndex(
    surface.tenors.map(t => t.months),
    surface.selectedTenorMonths,
  );
  const selY = nearestIndex(
    surface.rows.map(r => r.value),
    surface.selectedY,
  );
  const months = surface.tenors.map(t => Math.max(t.months, 1 / 30));
  const minM = Math.min(...months);
  const maxM = Math.max(...months);
  const heights: number[] = [];
  surface.cells.forEach(row => {
    row.forEach(c => {
      if (!c) return;
      const h = metric === 'vol' ? c.volPercent : Math.max(c.premiumUsd, 1);
      if (h > 0) heights.push(h);
    });
  });
  const lo = heights.length ? Math.min(...heights) : 1;
  const hi = heights.length ? Math.max(...heights) : 2;
  const ny = surface.rows.length;
  const nx = surface.tenors.length;
  const knots: Knot[][] = surface.rows.map((row, yi) =>
    surface.tenors.map((tenor, ti) => {
      const cell = surface.cells[yi]?.[ti] ?? null;
      const raw = cell
        ? metric === 'vol'
          ? cell.volPercent
          : Math.max(cell.premiumUsd, 1)
        : lo;
      const t =
        metric === 'vol'
          ? (raw - lo) / Math.max(hi - lo, 1e-6)
          : log01(raw, lo, hi);
      const title = cell
        ? `${row.label} · ${tenor.label} · K ${fmtPx(cell.strike)} · σ ${fmtVol(cell.volPercent)} · ${fmtUsd(cell.premiumUsd)}`
        : `${row.label} · ${tenor.label}`;
      return {
        yi,
        ti,
        x: nx <= 1 ? 0 : (ti / (nx - 1)) * 2 - 1,
        z: ny <= 1 ? 0 : (yi / (ny - 1)) * 2 - 1,
        y: t * 1.15,
        t: cell ? t : -1,
        label: `${row.label} ${tenor.label}`,
        title,
      };
    }),
  );
  void minM;
  void maxM;
  // Prefer log tenor so ON vs 10Y does not squash the short end.
  surface.tenors.forEach((tenor, ti) => {
    const x = nx <= 1 ? 0 : log01(Math.max(tenor.months, 1 / 30), minM, maxM) * 2 - 1;
    knots.forEach(row => {
      row[ti]!.x = x;
    });
  });
  return { knots, selY, selT };
}

function buildQuads(knots: Knot[][]): Quad[] {
  const quads: Quad[] = [];
  for (let yi = 0; yi < knots.length - 1; yi++) {
    const row = knots[yi]!;
    const next = knots[yi + 1]!;
    for (let ti = 0; ti < row.length - 1; ti++) {
      const a = row[ti]!;
      const b = row[ti + 1]!;
      const c = next[ti + 1]!;
      const d = next[ti]!;
      if (a.t < 0 || b.t < 0 || c.t < 0 || d.t < 0) continue;
      quads.push({
        a,
        b,
        c,
        d,
        t: (a.t + b.t + c.t + d.t) / 4,
        selected: false,
      });
    }
  }
  return quads;
}

function faceLit(quad: Quad, cam: Cam): number {
  const a = rotate(quad.a, cam);
  const b = rotate(quad.b, cam);
  const d = rotate(quad.d, cam);
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = d.x - a.x;
  const vy = d.y - a.y;
  const vz = d.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  const lx = 0.35;
  const ly = 0.82;
  const lz = 0.45;
  return Math.max(0, (nx * lx + ny * ly + nz * lz) / len);
}

function paint(
  ctx: CanvasRenderingContext2D,
  surface: OptionPremiumSurface,
  metric: SurfaceMetric,
  cam: Cam,
  focus: { yi: number; ti: number },
  dpr: number,
  cssW: number,
  cssH: number,
): { yi: number; ti: number; sx: number; sy: number }[] {
  const w = cssW;
  const h = cssH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  const { knots } = buildKnots(surface, metric);
  const focusYi = focus.yi;
  const focusTi = focus.ti;
  const camUse = cam;
  const proj = (p: { x: number; y: number; z: number }) =>
    project(p, camUse, w, h);

  const floor = [
    { x: -1, y: 0, z: -1 },
    { x: 1, y: 0, z: -1 },
    { x: 1, y: 0, z: 1 },
    { x: -1, y: 0, z: 1 },
  ].map(proj);
  ctx.beginPath();
  floor.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(15,23,42,0.9)';
  ctx.fill();
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.stroke();

  const nx = surface.tenors.length;
  const ny = surface.rows.length;
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 0.6;
  for (let i = 0; i < nx; i++) {
    const x = knots[0]![i]!.x;
    const a = proj({ x, y: 0, z: -1 });
    const b = proj({ x, y: 0, z: 1 });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = i === focusTi ? 'rgba(203,213,225,0.45)' : GRID;
    ctx.lineWidth = i === focusTi ? 1.15 : 0.6;
    ctx.stroke();
  }
  for (let j = 0; j < ny; j++) {
    const z = knots[j]![0]!.z;
    const a = proj({ x: -1, y: 0, z });
    const b = proj({ x: 1, y: 0, z });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = j === focusYi ? 'rgba(203,213,225,0.45)' : GRID;
    ctx.lineWidth = j === focusYi ? 1.15 : 0.6;
    ctx.stroke();
  }

  const axis = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => {
    const a = proj(from);
    const b = proj(to);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    return b;
  };
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1.2;
  const xEnd = axis({ x: -1, y: 0, z: -1 }, { x: 1.08, y: 0, z: -1 });
  const zEnd = axis({ x: -1, y: 0, z: -1 }, { x: -1, y: 0, z: 1.08 });
  ctx.fillStyle = MUTED;
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('tenor', xEnd.x + 4, xEnd.y + 3);
  ctx.fillText(surface.axisY === 'strike' ? 'K' : 'Δ', zEnd.x - 10, zEnd.y - 6);

  const labelTenors = [0, Math.floor((nx - 1) / 2), nx - 1];
  ctx.fillStyle = TEXT;
  labelTenors.forEach(i => {
    if (i === focusTi) return;
    const k = knots[0]?.[i];
    if (!k) return;
    const p = proj({ x: k.x, y: 0, z: -1.08 });
    const lab = surface.tenors[i]?.label ?? '';
    ctx.fillText(lab, p.x - 8, p.y + 12);
  });
  const labelRows = [0, Math.floor((ny - 1) / 2), ny - 1];
  labelRows.forEach(j => {
    if (j === focusYi) return;
    const k = knots[j]?.[0];
    if (!k) return;
    const p = proj({ x: -1.08, y: 0, z: k.z });
    const lab = surface.rows[j]?.label ?? '';
    ctx.fillText(lab, p.x - 18, p.y + 3);
  });

  const quads = buildQuads(knots).map(q => ({
    ...q,
    selected:
      (q.a.yi === focusYi && q.a.ti === focusTi)
      || (q.b.yi === focusYi && q.b.ti === focusTi)
      || (q.c.yi === focusYi && q.c.ti === focusTi)
      || (q.d.yi === focusYi && q.d.ti === focusTi),
  }));
  const drawn = quads.map(q => {
    const pa = proj(q.a);
    const pb = proj(q.b);
    const pc = proj(q.c);
    const pd = proj(q.d);
    return {
      q,
      pts: [pa, pb, pc, pd],
      depth: (pa.depth + pb.depth + pc.depth + pd.depth) / 4,
      lit: faceLit(q, camUse),
    };
  });
  drawn.sort((a, b) => b.depth - a.depth);
  drawn.forEach(item => {
    const { pts, q, lit } = item;
    const col = mixRgb(q.t, lit);
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = rgba(col.r, col.g, col.b, 0.96);
    ctx.fill();
    ctx.strokeStyle = q.selected ? PICK : rgba(col.r * 0.55, col.g * 0.55, col.b * 0.55, 0.55);
    ctx.lineWidth = q.selected ? 1.2 : 0.6;
    ctx.stroke();
  });

  const pin = knots[focusYi]?.[focusTi];
  if (pin && pin.t >= 0) {
    const top = proj(pin);
    const base = proj({ x: pin.x, y: 0, z: pin.z });
    const tenorTick = proj({ x: pin.x, y: 0, z: -1.12 });
    const rowTick = proj({ x: -1.12, y: 0, z: pin.z });
    const tenorFloorA = proj({ x: pin.x, y: 0, z: -1 });
    const tenorFloorB = proj({ x: pin.x, y: 0, z: 1 });
    const rowFloorA = proj({ x: -1, y: 0, z: pin.z });
    const rowFloorB = proj({ x: 1, y: 0, z: pin.z });
    const tenorLab = surface.tenors[focusTi]?.label ?? '';
    const rowLab = surface.rows[focusYi]?.label ?? '';

    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = HAIR;
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    ctx.moveTo(tenorFloorA.x, tenorFloorA.y);
    ctx.lineTo(tenorFloorB.x, tenorFloorB.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rowFloorA.x, rowFloorA.y);
    ctx.lineTo(rowFloorB.x, rowFloorB.y);
    ctx.stroke();

    ctx.beginPath();
    let started = false;
    for (let j = 0; j < ny; j++) {
      const k = knots[j]?.[focusTi];
      if (!k || k.t < 0) continue;
      const p = proj(k);
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else ctx.lineTo(p.x, p.y);
    }
    if (started) ctx.stroke();
    ctx.beginPath();
    started = false;
    for (let i = 0; i < nx; i++) {
      const k = knots[focusYi]?.[i];
      if (!k || k.t < 0) continue;
      const p = proj(k);
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else ctx.lineTo(p.x, p.y);
    }
    if (started) ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();
    ctx.restore();

    pickDot(ctx, top.x, top.y);
    labelChip(ctx, tenorLab, tenorTick.x, tenorTick.y + 12, 'center', w, h);
    labelChip(ctx, rowLab, rowTick.x - 6, rowTick.y, 'right', w, h);
  }

  const yBase = proj({ x: -1, y: 0, z: -1 });
  const yTop = proj({ x: -1, y: 1.28, z: -1 });
  const ax = yBase.x;
  const legendW = 5;
  const legendX = ax - 12;
  const legendH = yBase.y - yTop.y;
  if (legendH > 8) {
    const steps = 28;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const col = sampleRamp(1 - t);
      ctx.fillStyle = rgba(col.r, col.g, col.b, 0.95);
      ctx.fillRect(
        legendX,
        yTop.y + (legendH * i) / steps,
        legendW,
        legendH / steps + 0.6,
      );
    }
  }
  ctx.beginPath();
  ctx.moveTo(ax, yBase.y);
  ctx.lineTo(ax, yTop.y);
  ctx.strokeStyle = PREM;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.fillStyle = PREM;
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(metric === 'vol' ? 'σ' : 'prem', ax - 28, yTop.y - 4);

  const picks: { yi: number; ti: number; sx: number; sy: number }[] = [];
  knots.forEach(row => {
    row.forEach(k => {
      if (k.t < 0) return;
      const p = proj(k);
      picks.push({ yi: k.yi, ti: k.ti, sx: p.x, sy: p.y });
      const floor = proj({ x: k.x, y: 0, z: k.z });
      picks.push({ yi: k.yi, ti: k.ti, sx: floor.x, sy: floor.y });
    });
  });
  return picks;
}

export function PremiumSurfaceMesh({
  surface,
  metric,
  hover,
  focus,
  onHover,
  onPick,
  tall = false,
}: {
  surface: OptionPremiumSurface;
  metric: SurfaceMetric;
  hover: { yi: number; ti: number } | null;
  focus: { yi: number; ti: number };
  onHover: (next: { yi: number; ti: number } | null) => void;
  onPick: (next: { yi: number; ti: number }) => void;
  tall?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<Cam>({ ...DEFAULT_CAM });
  const dragRef = useRef<{ x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null);
  const picksRef = useRef<{ yi: number; ti: number; sx: number; sy: number }[]>([]);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const metricRef = useRef(metric);
  metricRef.current = metric;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const cssW = Math.max(1, host.clientWidth);
    const cssH = Math.max(1, host.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    picksRef.current = paint(
      ctx,
      surfaceRef.current,
      metricRef.current,
      camRef.current,
      focusRef.current,
      dpr,
      cssW,
      cssH,
    );
  }, []);

  useEffect(() => {
    draw();
  }, [draw, surface, metric, hover, focus]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(host);
    return () => ro.disconnect();
  }, [draw]);

  const hit = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    let best: { yi: number; ti: number; d: number } | null = null;
    for (const p of picksRef.current) {
      const d = Math.hypot(p.sx - x, p.sy - y);
      if (!best || d < best.d) best = { yi: p.yi, ti: p.ti, d };
    }
    return best ? { yi: best.yi, ti: best.ti } : null;
  };

  return (
    <div
      ref={hostRef}
      className={`relative h-full min-h-0 w-full cursor-grab active:cursor-grabbing ${
        tall ? 'min-h-[min(70vh,40rem)]' : ''
      }`}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full cursor-crosshair"
        role="img"
        aria-label="IPA premium surface. Click a tenor × strike knot to price it on the ticket. Drag left/right to spin, drag up/down to slide the canvas, scroll to zoom, double-click to reset."
        onPointerDown={e => {
          (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
          dragRef.current = {
            x: e.clientX,
            y: e.clientY,
            sx: e.clientX,
            sy: e.clientY,
            moved: false,
          };
        }}
        onPointerMove={e => {
          if (dragRef.current) {
            const dx = e.clientX - dragRef.current.x;
            const dy = e.clientY - dragRef.current.y;
            const dist = Math.hypot(
              e.clientX - dragRef.current.sx,
              e.clientY - dragRef.current.sy,
            );
            if (!dragRef.current.moved && dist < 16) return;
            dragRef.current = {
              x: e.clientX,
              y: e.clientY,
              sx: dragRef.current.sx,
              sy: dragRef.current.sy,
              moved: true,
            };
            const hostH = hostRef.current?.clientHeight ?? 264;
            const panMax = hostH * 0.48;
            camRef.current = {
              yaw: camRef.current.yaw - dx * 0.008,
              zoom: camRef.current.zoom,
              panY: Math.max(
                -panMax,
                Math.min(panMax, (camRef.current.panY || 0) + dy),
              ),
            };
            draw();
            return;
          }
          const next = hit(e.clientX, e.clientY);
          const prev = hoverRef.current;
          if (prev?.yi === next?.yi && prev?.ti === next?.ti) return;
          onHover(next);
        }}
        onPointerUp={e => {
          const drag = dragRef.current;
          dragRef.current = null;
          try {
            (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId);
          } catch {
            /* already released */
          }
          if (drag && !drag.moved) {
            const next = hit(e.clientX, e.clientY);
            if (next) onPick(next);
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          if (!dragRef.current && hoverRef.current) onHover(null);
        }}
        onWheel={e => {
          e.preventDefault();
          const next = camRef.current.zoom * (e.deltaY > 0 ? 0.94 : 1.06);
          camRef.current = {
            ...camRef.current,
            zoom: Math.min(2.2, Math.max(0.55, next)),
          };
          draw();
        }}
        onDoubleClick={() => {
          camRef.current = { ...DEFAULT_CAM };
          draw();
        }}
      />
    </div>
  );
}

export function PremiumSurfaceView({
  surface,
  metric,
  mode,
  tall = false,
  onPickKnot,
}: {
  surface: OptionPremiumSurface;
  metric: SurfaceMetric;
  mode: SurfaceViewMode;
  tall?: boolean;
  onPickKnot?: (next: { yi: number; ti: number }) => void;
}) {
  const [hover, setHover] = useState<{ yi: number; ti: number } | null>(null);
  const [pin, setPin] = useState<{ yi: number; ti: number } | null>(null);
  const pendingRef = useRef<{ yi: number; ti: number } | null>(null);
  const selT = nearestIndex(
    surface.tenors.map(t => t.months),
    surface.selectedTenorMonths,
  );
  const selY = nearestIndex(
    surface.rows.map(r => r.value),
    surface.selectedY,
  );

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending) {
      if (pending.yi === selY && pending.ti === selT) pendingRef.current = null;
      return;
    }
    if (pin && (pin.yi !== selY || pin.ti !== selT)) setPin(null);
  }, [selY, selT, pin]);

  const focus = pin ?? { yi: selY, ti: selT };
  const caption = hover ?? focus;
  const cell = surface.cells[caption.yi]?.[caption.ti] ?? null;
  const row = surface.rows[caption.yi];
  const tenor = surface.tenors[caption.ti];

  const commit = (next: { yi: number; ti: number }) => {
    pendingRef.current = next;
    setPin(next);
    onPickKnot?.(next);
  };

  return (
    <div className="relative h-full min-h-0">
      {mode === 'mesh' ? (
        <PremiumSurfaceMesh
          surface={surface}
          metric={metric}
          hover={hover}
          focus={focus}
          onHover={setHover}
          onPick={commit}
          tall={tall}
        />
      ) : (
        <PremiumSurfaceGrid
          surface={surface}
          hover={hover}
          focus={focus}
          onHover={setHover}
          onPick={commit}
          tall={tall}
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] bg-gradient-to-t from-slate-950/80 to-transparent px-2 pb-1.5 pt-4 font-mono text-[9px] text-slate-500">
        {cell && row && tenor
          ? `${row.label} × ${tenor.label} · K ${fmtPx(cell.strike)} · σ ${fmtVol(cell.volPercent)} · ${fmtUsd(cell.premiumUsd)}`
          : mode === 'mesh'
            ? 'Click a knot to price that tenor × Δ · drag ↔ spin · drag ↕ slide · scroll zoom'
            : 'IPA smile · premium at ticket size'}
        {mode === 'mesh' && metric === 'vol' ? ' · height σ' : mode === 'mesh' ? ' · height prem (log)' : ''}
      </div>
    </div>
  );
}

function PremiumSurfaceGrid({
  surface,
  hover,
  focus,
  onHover,
  onPick,
  tall = false,
}: {
  surface: OptionPremiumSurface;
  hover: { yi: number; ti: number } | null;
  focus: { yi: number; ti: number };
  onHover: (next: { yi: number; ti: number } | null) => void;
  onPick: (next: { yi: number; ti: number }) => void;
  tall?: boolean;
}) {
  const selT = nearestIndex(
    surface.tenors.map(t => t.months),
    surface.selectedTenorMonths,
  );
  const selY = nearestIndex(
    surface.rows.map(r => r.value),
    surface.selectedY,
  );

  return (
    <div
      className={`h-full overflow-auto px-1 pb-6 pt-9 ${
        tall ? 'min-h-[min(70vh,40rem)]' : ''
      }`}
    >
      <table className="w-max min-w-full border-collapse text-left">
        <thead className="sticky top-0 z-[2]">
          <tr>
            <th className="sticky left-0 z-[3] bg-slate-950 px-1.5 py-1 font-mono text-[8px] font-medium text-slate-500">
              {surface.axisY === 'strike' ? 'K' : 'Δ'}
            </th>
            {surface.tenors.map((t, ti) => (
              <th
                key={`${t.label}-${ti}`}
                className={`bg-slate-950 px-1 py-1 text-center font-mono text-[8px] font-medium ${
                  ti === focus.ti
                    ? 'text-amber-200'
                    : ti === selT
                      ? 'text-sky-200'
                      : 'text-slate-500'
                }`}
              >
                <button
                  type="button"
                  title={`Price ${t.label} on the ticket`}
                  onClick={() => onPick({ yi: focus.yi, ti })}
                  className="w-full hover:text-sky-100"
                >
                  {t.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {surface.rows.map((r, yi) => (
            <tr key={`${r.label}-${yi}`}>
              <th
                className={`sticky left-0 z-[1] bg-slate-950 px-1.5 py-0.5 text-left font-mono text-[8px] font-semibold ${
                  yi === focus.yi
                    ? 'text-amber-200'
                    : yi === selY
                      ? 'text-sky-200'
                      : 'text-slate-400'
                }`}
              >
                {r.label}
              </th>
              {surface.tenors.map((t, ti) => {
                const c = surface.cells[yi]?.[ti] ?? null;
                const on = yi === focus.yi && ti === focus.ti;
                const hot = hover?.yi === yi && hover?.ti === ti;
                return (
                  <td key={`${yi}-${ti}`} className="p-px">
                    <button
                      type="button"
                      disabled={!c}
                      title={
                        c
                          ? `${r.label} · ${t.label} · K ${fmtPx(c.strike)} · σ ${fmtVol(c.volPercent)} · ${fmtUsd(c.premiumUsd)}`
                          : `${r.label} · ${t.label}`
                      }
                      onMouseEnter={() => onHover({ yi, ti })}
                      onMouseLeave={() => onHover(null)}
                      onClick={() => onPick({ yi, ti })}
                      className={`flex w-full min-w-[3.1rem] flex-col items-end rounded-sm px-1 py-0.5 font-mono leading-tight ${
                        on || hot
                          ? 'bg-sky-500/20 text-sky-100'
                          : c
                            ? 'text-slate-200 hover:bg-slate-800'
                            : 'text-slate-700'
                      }`}
                    >
                      {c ? (
                        <>
                          <span className="text-[8px] text-slate-500">{fmtPx(c.strike)}</span>
                          <span className="text-[9px] tabular-nums">{fmtPrem(c.premiumUsd)}</span>
                        </>
                      ) : (
                        <span className="text-[9px]">—</span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
