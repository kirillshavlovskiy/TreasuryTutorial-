'use client';

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ccySpotRate, type RowState } from '@/lib/fx-buffer';
import type { OverlaySide } from '@/lib/portfolio-alloc';
import {
  clampCarryVarPlotView,
  inPlotRect,
  svgLocalXY,
  type CarryVarPlotView,
} from '@/lib/test-mode/carry-var-plot-nav';
import {
  applyPortfolioFrontierTargets,
  bookCashCarryK,
  buildLiquidityLeftEndFrontier,
  carryAxisFromArms,
  carryFwd,
  constraintTwinFromHits,
  frontierCarryDotsK,
  interpAlong,
  isoSSlicePoints,
  liquidityFrontierDial,
  liquidityFrontierDialLabel,
  priceIsoSSlice,
  snapFrontierStandKey,
  tangencyOnLiquidityArm,
  type LiquidityFrontierConstraint,
  type LiquidityFrontierInput,
  type LiquidityFrontierPoint,
} from '@/lib/test-mode/liquidity-frontier';
import {
  probabilityWeightedReturnUsdM,
  type LiquidityStrategy,
} from '@/lib/test-mode/liquidity-strategies';
import { VAR_CONFIDENCE_OPTIONS } from '@/lib/test-mode/var-confidence';
import type { VarSetup } from '@/lib/test-mode/var-setup';
import type { AskFillMode } from '@/lib/test-mode/solution-pick';
import {
  walkStandingFromSetpoints,
  type CcyScenarioSetpoint,
} from '@/lib/test-mode/efficient-frontier-job';
import {
  alignLeftEndToCcyTicket,
  bookStandingChipLabel,
  ccyModalAlignTicket,
  modalCcyTicketTargets,
} from '@/lib/test-mode/portfolio-modal-align';

function fmtK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-5) return '$0K';
  if (Math.abs(usdM) >= 1 - 1e-9) {
    return `${usdM >= 0 ? '' : '−'}$${Math.abs(usdM).toFixed(1)}M`;
  }
  const k = usdM * 1000;
  const dec = Math.abs(k) < 10 ? 1 : 0;
  return `${k >= 0 ? '' : '−'}$${Math.abs(k).toFixed(dec)}K`;
}

function fmtSignedK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-5) return '$0K';
  if (Math.abs(usdM) >= 1 - 1e-9) {
    const sign = usdM > 0 ? '+' : usdM < 0 ? '−' : '';
    return `${sign}$${Math.abs(usdM).toFixed(1)}M`;
  }
  const k = usdM * 1000;
  const dec = Math.abs(k) < 10 ? 1 : 0;
  const sign = k > 0 ? '+' : k < 0 ? '−' : '';
  return `${sign}$${Math.abs(k).toFixed(dec)}K`;
}

function fmtAbsK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-5) return '$0K';
  if (Math.abs(usdM) >= 1 - 1e-9) {
    return `$${Math.abs(usdM).toFixed(1)}M`;
  }
  const k = Math.abs(usdM * 1000);
  return `$${k.toFixed(k < 10 ? 1 : 0)}K`;
}

function HeaderChip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`shrink-0 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold ${className ?? 'text-slate-300'}`}>
      {children}
    </span>
  );
}

function Legend({
  swatch,
  border,
  label,
}: {
  swatch: 'solid' | 'dashed' | 'dot';
  border: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[9px] text-slate-400">
      {swatch === 'dot' ? (
        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
      ) : (
        <span
          className={`h-0 w-3.5 border-t-2 ${border} ${
            swatch === 'dashed' ? 'border-dashed' : ''
          }`}
        />
      )}
      {label}
    </span>
  );
}

function ControlField({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className ?? ''}`}>
      <div className="mb-1.5 flex h-3.5 items-baseline gap-1.5">
        <span className="shrink-0 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-400">
          {label}
        </span>
        {hint ? (
          <span className="min-w-0 truncate font-mono text-[9px] text-slate-500">
            {hint}
          </span>
        ) : null}
      </div>
      <div className="flex h-[22px] items-center gap-2">{children}</div>
    </div>
  );
}

function carryLogTicks(yMin: number, yMax: number): number[] {
  const span = Math.max(Math.abs(yMin), Math.abs(yMax), 0.01);
  const mag = span > 0.08
    ? [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5]
    : span > 0.03
      ? [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2]
      : [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
  const out = [0];
  for (const m of mag) {
    if (m <= yMax * 1.02 + 1e-12) out.push(m);
    if (-m >= yMin * 1.02 - 1e-12) out.push(-m);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function pickDotsAlongPolyline(
  pts: readonly { x: number; y: number }[],
  maxDots: number,
  minGap: number,
): Set<number> {
  const n = pts.length;
  if (n === 0) return new Set();
  if (n <= maxDots) {
    const all = new Set<number>();
    let last = 0;
    all.add(0);
    for (let i = 1; i < n; i += 1) {
      const near = i / n < 0.4;
      const gap = near ? minGap * 0.5 : minGap;
      if (Math.hypot(pts[i]!.x - pts[last]!.x, pts[i]!.y - pts[last]!.y) >= gap) {
        all.add(i);
        last = i;
      }
    }
    all.add(n - 1);
    return all;
  }
  const out = new Set<number>([0]);
  let last = 0;
  for (let i = 1; i < n - 1; i += 1) {
    const near = i / n < 0.4;
    const gap = near ? minGap * 0.5 : minGap;
    if (Math.hypot(pts[i]!.x - pts[last]!.x, pts[i]!.y - pts[last]!.y) >= gap) {
      out.add(i);
      last = i;
      if (out.size >= maxDots - 1) break;
    }
  }
  out.add(n - 1);
  return out;
}

function thinTicks(
  values: readonly number[],
  pos: (v: number) => number,
  minGap: number,
): number[] {
  const preferred = [...values].sort((a, b) => {
    const az = Math.abs(a) < 1e-12 ? -1 : 0;
    const bz = Math.abs(b) < 1e-12 ? -1 : 0;
    if (az !== bz) return az - bz;
    return Math.abs(b) - Math.abs(a);
  });
  const kept: number[] = [];
  for (const v of preferred) {
    const py = pos(v);
    if (kept.some(u => Math.abs(pos(u) - py) < minGap)) continue;
    kept.push(v);
  }
  return kept.sort((a, b) => a - b);
}

/**
 * Insert mid-cover RSS points until consecutive screen chords are short.
 * Keeps the yellow mix on the calculated Δ curve (not a Catmull-Rom in asinh).
 */
function densifyIsoSliceScreen(
  open: LiquidityFrontierPoint,
  far: LiquidityFrontierPoint,
  sectionUsdM: number,
  slice: readonly LiquidityFrontierPoint[],
  xFn: (v: number) => number,
  yFn: (v: number) => number,
): LiquidityFrontierPoint[] {
  if (slice.length < 2) return [...slice];
  const pts = [...slice];
  let i = 0;
  let guard = 0;
  while (i < pts.length - 1 && guard < 800) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = xFn(b.finalCfarUsdM) - xFn(a.finalCfarUsdM);
    const dy = yFn(b.totalCarryUsdYrM) - yFn(a.totalCarryUsdYrM);
    if (Math.hypot(dx, dy) > 2.6 && Math.abs(b.delta - a.delta) > 1e-4) {
      pts.splice(i + 1, 0, priceIsoSSlice(open, far, sectionUsdM, (a.delta + b.delta) / 2));
      guard += 1;
      continue;
    }
    i += 1;
  }
  return pts;
}

const ISO_MIX_DOT_COVERS = [0.2, 0.4, 0.6, 0.8] as const;

function isoMixDotPoints(
  slice: readonly LiquidityFrontierPoint[],
): LiquidityFrontierPoint[] {
  const interiors = slice.filter(p => p.delta > 1e-9 && p.delta < 1 - 1e-9);
  if (interiors.length === 0) return [];
  const out: LiquidityFrontierPoint[] = [];
  const takeNearest = (target: number, minSep: number) => {
    const hit = interiors.reduce<LiquidityFrontierPoint | null>((best, p) => {
      if (!best) return p;
      return Math.abs(p.delta - target) < Math.abs(best.delta - target) ? p : best;
    }, null);
    if (!hit) return;
    if (out.some(q => Math.abs(q.delta - hit.delta) < minSep)) return;
    out.push(hit);
  };
  for (const t of ISO_MIX_DOT_COVERS) takeNearest(t, 0.08);
  const zeroCarry = interiors.reduce<LiquidityFrontierPoint | null>((best, p) => {
    if (!best) return p;
    return Math.abs(p.totalCarryUsdYrM) < Math.abs(best.totalCarryUsdYrM) ? p : best;
  }, null);
  if (zeroCarry && Math.abs(zeroCarry.totalCarryUsdYrM) < 8e-4) {
    takeNearest(zeroCarry.delta, 0.05);
  }
  return out.sort((a, b) => a.delta - b.delta);
}

type PlotLabelDraft = {
  id: string;
  text: string;
  ax: number;
  ay: number;
  fill: string;
  lines?: 1 | 2;
  sub?: string;
  prefer?: 'right' | 'below' | 'above' | 'left';
};

type PlacedPlotLabel = {
  id: string;
  text: string;
  sub?: string;
  x: number;
  y: number;
  anchor: 'start' | 'end' | 'middle';
  fill: string;
};

function estimateLabelW(text: string): number {
  return Math.max(28, text.length * 4.55);
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 4,
): boolean {
  return !(
    a.x + a.w + pad < b.x
    || b.x + b.w + pad < a.x
    || a.y + a.h + pad < b.y
    || b.y + b.h + pad < a.y
  );
}

function placePlotLabels(
  items: readonly PlotLabelDraft[],
  plot: { l: number; t: number; r: number; b: number },
): PlacedPlotLabel[] {
  const placedBoxes: { x: number; y: number; w: number; h: number }[] = [];
  const out: PlacedPlotLabel[] = [];
  for (const item of items) {
    const w = Math.max(estimateLabelW(item.text), item.sub ? estimateLabelW(item.sub) : 0);
    const h = (item.lines ?? (item.sub ? 2 : 1)) * 11;
    const opts: { x: number; y: number; anchor: 'start' | 'end' | 'middle' }[] = [
      { x: item.ax + 8, y: item.ay - 6, anchor: 'start' },
      { x: item.ax + 8, y: item.ay + 12, anchor: 'start' },
      { x: item.ax - 8, y: item.ay - 6, anchor: 'end' },
      { x: item.ax - 8, y: item.ay + 12, anchor: 'end' },
      { x: item.ax, y: item.ay - 14, anchor: 'middle' },
      { x: item.ax, y: item.ay + 16, anchor: 'middle' },
    ];
    const order = item.prefer === 'below' ? [1, 5, 0, 2, 3, 4]
      : item.prefer === 'above' ? [0, 4, 2, 1, 3, 5]
        : item.prefer === 'left' ? [2, 3, 0, 1, 4, 5]
          : [0, 1, 2, 3, 4, 5];
    const ranked = order.map(i => opts[i]!);
    const boxOf = (o: (typeof opts)[number]) => ({
      x: o.anchor === 'end' ? o.x - w : o.anchor === 'middle' ? o.x - w / 2 : o.x,
      y: o.y - 8,
      w,
      h,
    });
    const inPlot = (box: { x: number; y: number; w: number; h: number }) => (
      box.x >= plot.l - 2
      && box.x + box.w <= plot.r + 6
      && box.y >= plot.t - 2
      && box.y + box.h <= plot.b + 6
    );
    const pick = ranked.find(o => {
      const box = boxOf(o);
      return inPlot(box) && placedBoxes.every(p => !boxesOverlap(box, p));
    })
      ?? ranked.find(o => inPlot(boxOf(o)))
      ?? ranked[0]!;
    placedBoxes.push(boxOf(pick));
    out.push({
      id: item.id,
      text: item.text,
      sub: item.sub,
      x: pick.x,
      y: pick.y,
      anchor: pick.anchor,
      fill: item.fill,
    });
  }
  return out;
}

function nearScreen(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px = 16,
): boolean {
  return Math.hypot(ax - bx, ay - by) < px;
}

function cfarKTicks(minM: number, maxM: number): number[] {
  const lo = Math.floor(minM * 1000);
  const hi = Math.ceil(maxM * 1000);
  if (hi <= lo) return [minM];
  const span = hi - lo;
  const step = span <= 8 ? 1
    : span <= 40 ? 5
    : span <= 120 ? 10
    : span <= 400 ? 25
    : span <= 1000 ? 50
    : span <= 2500 ? 100
    : span <= 6000 ? 250
    : 500;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let k = start; k <= hi + 1e-9; k += step) {
    if (k + 1e-9 >= lo) out.push(k / 1000);
  }
  return out.length > 0 ? out : [minM];
}

type FrontierTwin = {
  key: string;
  open: LiquidityFrontierPoint;
  far: LiquidityFrontierPoint;
};

function indexOfTwinKey(
  twins: readonly FrontierTwin[],
  key: string,
  standing?: number,
): number {
  if (key === 'origin' || twins.length === 0) return 0;
  if (typeof standing === 'number' && Number.isFinite(standing) && Math.abs(standing) > 1e-6) {
    const byStand = indexOfTwinStanding(twins, standing);
    return byStand >= 0 ? byStand : 0;
  }
  const i = twins.findIndex(t => t.key === key);
  return i >= 0 ? i : 0;
}

function indexOfTwinStanding(
  twins: readonly FrontierTwin[],
  standing: number,
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < twins.length; i += 1) {
    const t = twins[i]!;
    if (t.key === 'origin') continue;
    const d = Math.min(
      Math.abs(t.open.peakBook - standing),
      Math.abs(t.far.peakBook - standing),
    );
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function pointKey(p: LiquidityFrontierPoint): string {
  const origin =
    Math.abs(p.peakBook) < 1e-6
    && Math.abs(p.delta) < 1e-9
    && Math.abs(p.totalCarryUsdYrM) < 1e-9;
  if (origin) return 'origin';
  return `${p.delta >= 1 - 1e-9 ? 'far' : 'open'}:${p.peakBook.toFixed(4)}`;
}

type CcyScenarioId = 'unhedged' | 'carryTarget' | 'balanced' | 'swapHedged' | 'custom';

const CCY_SCENARIO_COLORS: Record<CcyScenarioId, string> = {
  unhedged: '#94a3b8',
  carryTarget: '#60a5fa',
  balanced: '#f59e0b',
  swapHedged: '#fb7185',
  custom: '#38bdf8',
};

const SCENARIO_CHIP_TONE: Record<CcyScenarioId, { on: string; off: string }> = {
  unhedged: {
    on: 'border-slate-400 bg-slate-500/25 text-slate-100',
    off: 'border-slate-600 bg-slate-800/70 text-slate-200 hover:border-slate-400 hover:bg-slate-700/80',
  },
  carryTarget: {
    on: 'border-sky-400 bg-sky-500/25 text-sky-100',
    off: 'border-sky-500/45 bg-sky-500/10 text-sky-200 hover:border-sky-400 hover:bg-sky-500/20',
  },
  balanced: {
    on: 'border-amber-400 bg-amber-500/25 text-amber-100',
    off: 'border-amber-500/45 bg-amber-500/10 text-amber-200 hover:border-amber-400 hover:bg-amber-500/20',
  },
  swapHedged: {
    on: 'border-rose-400 bg-rose-500/25 text-rose-100',
    off: 'border-rose-500/45 bg-rose-500/10 text-rose-200 hover:border-rose-400 hover:bg-rose-500/20',
  },
  custom: {
    on: 'border-sky-400 bg-sky-500/25 text-sky-100',
    off: 'border-sky-500/45 bg-sky-500/10 text-sky-200 hover:border-sky-400 hover:bg-sky-500/20',
  },
};

interface CcyScenarioDef {
  id: CcyScenarioId;
  label: string;
  point: LiquidityFrontierPoint | null;
  disabledHint?: string;
  displayCfarUsdM?: number;
  displayCarryUsdYrM?: number;
  source?: 'portfolio' | 'local';
  plotOnLocalArm?: boolean;
}

function nearestOpenByStanding(
  opens: readonly LiquidityFrontierPoint[],
  standing: number,
): LiquidityFrontierPoint | null {
  let best: LiquidityFrontierPoint | null = null;
  let bestD = Infinity;
  for (const p of opens) {
    const d = Math.abs(p.peakBook - standing);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function nearestComboOnTwins(
  twins: readonly FrontierTwin[],
  sectionUsdM: number,
  target: { cfarUsdM: number; carryUsdYrM: number },
  carryS: number,
): { idx: number; cover: number } | null {
  if (twins.length === 0) return null;
  if (!Number.isFinite(target.cfarUsdM) || !Number.isFinite(target.carryUsdYrM)) {
    return null;
  }
  const tx = target.cfarUsdM;
  const tz = carryFwd(target.carryUsdYrM, carryS);
  const xs = twins.flatMap(t => [t.open.finalCfarUsdM, t.far.finalCfarUsdM]);
  const zs = twins.flatMap(t => [
    carryFwd(t.open.totalCarryUsdYrM, carryS),
    carryFwd(t.far.totalCarryUsdYrM, carryS),
  ]);
  const xSpan = Math.max(0.02, Math.max(...xs) - Math.min(...xs));
  const zSpan = Math.max(0.2, Math.max(...zs) - Math.min(...zs));
  const dist = (p: LiquidityFrontierPoint) => Math.hypot(
    (p.finalCfarUsdM - tx) / xSpan,
    (carryFwd(p.totalCarryUsdYrM, carryS) - tz) / zSpan,
  );
  let best = { idx: 0, cover: 0, d: Infinity };
  twins.forEach((t, idx) => {
    const covers = t.key === 'origin' ? [0] : [0, 0.25, 0.5, 0.75, 1];
    const ySpan = t.far.totalCarryUsdYrM - t.open.totalCarryUsdYrM;
    if (t.key !== 'origin' && Math.abs(ySpan) > 1e-9) {
      const u = (target.carryUsdYrM - t.open.totalCarryUsdYrM) / ySpan;
      if (u > 1e-6 && u < 1 - 1e-6) covers.push(u);
    }
    for (const cover of covers) {
      const p = t.key === 'origin'
        ? t.open
        : priceIsoSSlice(t.open, t.far, sectionUsdM, cover);
      const d = dist(p);
      if (d < best.d) best = { idx, cover, d };
    }
  });
  return { idx: best.idx, cover: best.cover };
}

function pointFromCarryHit(
  origin: LiquidityFrontierPoint,
  opens: readonly LiquidityFrontierPoint[],
  hit: { cfarUsdM: number; carryUsdYrM: number; standing: number },
): LiquidityFrontierPoint {
  const near = nearestOpenByStanding(opens, hit.standing) ?? origin;
  return {
    ...near,
    peakBook: hit.standing,
    finalCfarUsdM: hit.cfarUsdM,
    totalCarryUsdYrM: hit.carryUsdYrM,
    cashCarryUsdYrM: hit.carryUsdYrM,
    levered: false,
  };
}

function samePt(a: LiquidityFrontierPoint | null, b: LiquidityFrontierPoint | null): boolean {
  if (!a || !b) return false;
  return Math.abs(a.peakBook - b.peakBook) < 1e-4
    && Math.abs(a.delta - b.delta) < 1e-6
    && Math.abs(a.totalCarryUsdYrM - b.totalCarryUsdYrM) < 1e-8;
}

function weightedReturnUsdM(
  p: Pick<LiquidityFrontierPoint, 'totalCarryUsdYrM' | 'finalCfarUsdM'>,
  confidencePct: number,
  floorCfarUsdM: number,
): number {
  return probabilityWeightedReturnUsdM(
    p.totalCarryUsdYrM,
    p.finalCfarUsdM,
    confidencePct,
    floorCfarUsdM,
  );
}

export function LiquidityFrontierModal({
  row,
  strategy,
  constraintDetail,
  engineInput,
  bookStanding = 0,
  onSetupChange,
  onClose,
  onPickResidual,
  onStage,
  staged = false,
  portfolioSuggestion = null,
  askFillMode,
  scenarioSetpoints = {},
}: {
  row: RowState;
  strategy: LiquidityStrategy;
  constraintDetail: string;
  engineInput: Omit<LiquidityFrontierInput, 'row' | 'strategy'>;
  bookStanding?: number;
  onSetupChange?: (setup: VarSetup) => void;
  onClose: () => void;
  /** User picked a mix Δ (1 = open, 0 = far) — write it onto the Book strip. */
  onPickResidual?: (residual: number) => void;
  /** Stage the residual-Δ FX strip for FX Risk / Carry / Decision. */
  onStage?: (residual: number) => void;
  staged?: boolean;
  /**
   * Portfolio efficient-frontier pick for this CCY. Prefer `cfarUsdM` +
   * `carryUsdYrM` (the chart combo). `fcyM` is the overlay standing fallback.
   */
  portfolioSuggestion?: {
    fcyM: number;
    usdM: number;
    side: OverlaySide;
    scenarioLabel: string;
    scenarioId?: string | null;
    cfarUsdM?: number;
    carryUsdYrM?: number;
  } | null;
  askFillMode?: AskFillMode;
  /** Named portfolio scenario setpoints for this CCY (same payload as Sweet). */
  scenarioSetpoints?: Record<string, CcyScenarioSetpoint>;
}) {
  const overlayFill = askFillMode === 'overlay'
    || scenarioSetpoints.carryTarget?.askFillMode === 'overlay'
    || (
      portfolioSuggestion?.scenarioId != null
      && scenarioSetpoints[portfolioSuggestion.scenarioId]?.askFillMode === 'overlay'
    );
  const liveS = overlayFill
    ? 0
    : (() => {
      const walkS = walkStandingFromSetpoints(
        bookStanding,
        scenarioSetpoints,
        portfolioSuggestion?.scenarioId,
      );
      if (Math.abs(walkS) > 0.01) return walkS;
      return typeof row.carry_target === 'number' && Math.abs(row.carry_target) > 0.01
        ? row.carry_target
        : 0;
    })();
  const bookK = bookCashCarryK(
    liveS, ccySpotRate(row.ccy), row.r_FCY, engineInput.shared.r_USD, row.r_OD,
  );
  const dial = liquidityFrontierDial(engineInput.activeLayers);
  const searching = dial !== 'cash_floor';
  const levMin = Math.max(10, Math.ceil(Math.max(bookK, 0) / 5) * 5);
  const sliderMax = Math.max(500, levMin + 400);
  const [maxCarryK, setMaxCarryK] = useState(levMin);
  useEffect(() => {
    setMaxCarryK(m => Math.max(levMin, m));
  }, [levMin]);
  const plotCapK = maxCarryK;

  const carryUsdK = useMemo(() => frontierCarryDotsK(bookK, {
    targetCashK: searching ? bookK : 0,
    tail: plotCapK > bookK + 0.5,
    maxK: plotCapK,
  }), [bookK, searching, plotCapK]);

  const result = useMemo(() => {
    const built = buildLiquidityLeftEndFrontier({
      ...engineInput,
      row,
      strategy,
      bookStanding: liveS,
      carryUsdK,
    });
    const ask = scenarioSetpoints.carryTarget;
    const overlayPins = askFillMode === 'overlay'
      || ask?.askFillMode === 'overlay';
    const ticket = overlayPins ? null : ccyModalAlignTicket(ask);
    const aligned = alignLeftEndToCcyTicket(built, ticket);
    // Overlay fill: chips only. Swap / Both: pin this CCY’s Total
    // (Book+Overlay) — same Y as the chip. Never Policy VAR.
    return {
      ...aligned,
      constraint: applyPortfolioFrontierTargets(
        aligned.constraint,
        {
          origin: aligned.origin,
          open: aligned.upper.filter(p => p.delta < 1e-9),
          far: aligned.lower,
        },
        modalCcyTicketTargets({ overlayFill: overlayPins, ticket: ask }),
      ),
    };
  }, [
    engineInput,
    row,
    strategy,
    liveS,
    carryUsdK,
    scenarioSetpoints.carryTarget?.bookUsdYrM,
    scenarioSetpoints.carryTarget?.carryUsdYrM,
    scenarioSetpoints.carryTarget?.cfarUsdM,
    scenarioSetpoints.carryTarget?.overlayUsdYrM,
    scenarioSetpoints.carryTarget?.bookStandingFcyM,
    scenarioSetpoints.carryTarget?.askFillMode,
    askFillMode,
  ]);

  const twins = useMemo(() => {
    const originPair = {
      key: 'origin',
      open: result.origin,
      far: result.origin,
    };
    const opens = result.upper.filter(p => p.delta < 1e-9);
    const pairs = opens.map(open => {
      const far = result.lower.find(p => Math.abs(p.peakBook - open.peakBook) < 1e-4);
      return {
        key: open.peakBook.toFixed(4),
        open,
        far: far ?? open,
      };
    });
    const list = [originPair, ...pairs];
    const openHit = result.constraint.openHit;
    const hedgeHit = result.constraint.hedgeHit;
    if (
      result.dial !== 'cash_floor'
      && openHit
      && hedgeHit
      && Math.abs(openHit.standing) > 1e-6
      && !list.some(t => t.key !== 'origin' && Math.abs(t.open.peakBook - openHit.standing) < 1e-3)
    ) {
      const nearOpen = opens.reduce<LiquidityFrontierPoint | null>((best, p) => {
        if (!best) return p;
        return Math.abs(p.peakBook - openHit.standing) < Math.abs(best.peakBook - openHit.standing)
          ? p
          : best;
      }, null) ?? result.origin;
      const nearFar = result.lower.reduce<LiquidityFrontierPoint | null>((best, p) => {
        if (!best) return p;
        return Math.abs(p.peakBook - hedgeHit.standing) < Math.abs(best.peakBook - hedgeHit.standing)
          ? p
          : best;
      }, null) ?? nearOpen;
      const syn = constraintTwinFromHits(openHit, hedgeHit, nearOpen, nearFar);
      const rest = [...pairs, syn].sort(
        (a, b) => Math.abs(a.open.peakBook) - Math.abs(b.open.peakBook),
      );
      return [originPair, ...rest];
    }
    return list;
  }, [result]);

  const snapEpoch = [
    row.ccy,
    strategy.id,
    result.dial,
    result.constraint.openHit?.standing.toFixed(4) ?? 'none',
    result.constraint.hCarryUsdYrM?.toFixed(6) ?? '',
    result.constraint.vCfarUsdM?.toFixed(6) ?? '',
    portfolioSuggestion?.scenarioId ?? '',
    portfolioSuggestion?.cfarUsdM?.toFixed(6) ?? '',
    portfolioSuggestion?.carryUsdYrM?.toFixed(6) ?? '',
  ].join(':');
  const autoKey = snapFrontierStandKey(
    result.dial,
    result.constraint.openHit,
    twins.map(t => ({ key: t.key, standing: t.open.peakBook })),
  );
  const dialAutoIdx = indexOfTwinKey(twins, autoKey, result.constraint.openHit?.standing);
  const suggestedStanding = !overlayFill && Math.abs(liveS) > 0.01
    ? liveS
    : null;
  const suggestedIdx = suggestedStanding != null
    ? indexOfTwinStanding(twins, suggestedStanding)
    : -1;
  // Do not snap portfolio ($9.8M, +$1.6M) onto the local CCY walk —
  // that picks a far Δ=1 standing (S −91) that is not the Book strip.
  const comboTarget = !overlayFill
    && Math.abs(liveS) < 0.01
    && portfolioSuggestion
    && typeof portfolioSuggestion.cfarUsdM === 'number'
    && Number.isFinite(portfolioSuggestion.cfarUsdM)
    && typeof portfolioSuggestion.carryUsdYrM === 'number'
    && Number.isFinite(portfolioSuggestion.carryUsdYrM)
    ? {
        cfarUsdM: portfolioSuggestion.cfarUsdM,
        carryUsdYrM: portfolioSuggestion.carryUsdYrM,
      }
    : null;
  const comboCarryS = (() => {
    const openY = result.upper.filter(p => p.delta < 1e-9).map(p => p.cashCarryUsdYrM);
    const farY = result.lower.map(p => p.totalCarryUsdYrM);
    return carryAxisFromArms(
      Math.min(0, ...openY, 0),
      Math.max(0.012, ...openY, 0),
      Math.min(0, ...farY, 0),
    ).s;
  })();
  const comboSnap = comboTarget
    ? nearestComboOnTwins(twins, result.cfarOriginUsdM, comboTarget, comboCarryS)
    : null;
  const autoIdx = comboSnap != null
    ? comboSnap.idx
    : (suggestedIdx >= 0 ? suggestedIdx : dialAutoIdx);
  const autoCover = comboSnap != null ? comboSnap.cover : 0;
  const [pick, setPick] = useState<{ epoch: string; idx: number; cover: number } | null>(null);
  const [pinnedScenario, setPinnedScenario] = useState<CcyScenarioId | null>(null);
  useEffect(() => {
    setPinnedScenario(null);
  }, [portfolioSuggestion?.scenarioId, row.ccy, askFillMode]);
  const livePick = pick?.epoch === snapEpoch ? pick : null;
  const armIdx = livePick != null
    ? Math.min(twins.length - 1, Math.max(0, livePick.idx))
    : autoIdx;
  const twin = twins[armIdx] ?? twins[0]!;
  const isOrigin = twin.key === 'origin';
  const cover = isOrigin ? 0 : (livePick?.cover ?? autoCover);
  const commit = (next: { idx?: number; cover?: number }) => {
    const idx = next.idx ?? armIdx;
    const at = twins[idx] ?? twins[0]!;
    const nextCover = at.key === 'origin' ? 0 : (next.cover ?? cover);
    setPick({
      epoch: snapEpoch,
      idx,
      cover: nextCover,
    });
    onPickResidual?.(at.key === 'origin' ? 1 : 1 - nextCover);
  };

  const selected = isOrigin
    ? result.origin
    : priceIsoSSlice(twin.open, twin.far, result.cfarOriginUsdM, cover);
  const isoSlice = !isOrigin
    ? isoSSlicePoints(twin.open, twin.far, result.cfarOriginUsdM)
    : [];
  const residual = isOrigin ? 1 : 1 - cover;
  const arm: 'open' | 'far' | 'mix' = isOrigin || cover < 1e-9
    ? 'open'
    : cover >= 1 - 1e-9 ? 'far' : 'mix';
  const heldCover = (idx: number) => {
    const at = twins[idx];
    if (!at || at.key === 'origin') return 0;
    if (arm === 'far') return 1;
    if (arm === 'open') return 0;
    return cover;
  };
  const confidencePct = engineInput.setup?.confidencePct ?? 95;
  const originCfar = result.origin.finalCfarUsdM;
  const selectedWeighted = weightedReturnUsdM(selected, confidencePct, originCfar);
  const select = (p: LiquidityFrontierPoint) => {
    if (pointKey(p) === 'origin' || Math.abs(p.peakBook) < 1e-6) {
      commit({ idx: 0, cover: 0 });
      return;
    }
    const idx = indexOfTwinStanding(twins, p.peakBook);
    commit({
      idx: idx >= 0 ? idx : armIdx,
      cover: p.delta >= 1 - 1e-9 ? 1 : p.delta < 1e-9 ? 0 : p.delta,
    });
  };

  const opens = result.upper.filter(p => p.delta < 1e-9);
  const askCarryY = result.constraint.hCarryUsdYrM;
  const carryHit = askCarryY != null
    ? interpAlong([result.origin, ...opens], askCarryY, 'carry')
    : (result.dial === 'carry_target' ? result.constraint.openHit : null);
  const carryTargetPoint = carryHit && Math.abs(carryHit.standing) > 1e-6
    ? pointFromCarryHit(result.origin, opens, carryHit)
    : (typeof row.carry_target === 'number'
      && Number.isFinite(row.carry_target)
      && Math.abs(row.carry_target) > 0.01
      ? nearestOpenByStanding(opens, row.carry_target)
      : null);
  const balancedPoint = tangencyOnLiquidityArm([result.origin, ...opens]);
  const fars = result.lower;
  const hedgeHit = result.constraint.hedgeHit;
  const swapStand = Math.abs(liveS) > 0.01
    ? liveS
    : (carryTargetPoint && Math.abs(carryTargetPoint.peakBook) > 1e-6
      ? carryTargetPoint.peakBook
      : (Math.abs(result.bookStanding) > 0.01 ? result.bookStanding : null));
  const swapHedgedPoint = swapStand != null
    ? nearestOpenByStanding(fars, swapStand)
    : (result.dial === 'carry_target' && hedgeHit && Math.abs(hedgeHit.standing) > 1e-6
      ? { ...pointFromCarryHit(result.origin, fars, hedgeHit), delta: 1, phase: 'hedged' as const }
      : (fars.filter(p => !p.levered).at(-1) ?? null));
  const stampPortfolio = (
    id: CcyScenarioId,
    local: LiquidityFrontierPoint | null,
    fallbackHint?: string,
  ): Pick<CcyScenarioDef, 'point' | 'disabledHint' | 'displayCfarUsdM' | 'displayCarryUsdYrM' | 'source' | 'plotOnLocalArm'> => {
    const sp = scenarioSetpoints[id];
    if (sp) {
      return {
        point: local ?? result.origin,
        displayCfarUsdM: sp.cfarUsdM,
        displayCarryUsdYrM: sp.carryUsdYrM,
        source: 'portfolio',
        plotOnLocalArm: !overlayFill,
      };
    }
    return {
      point: local,
      source: 'local',
      plotOnLocalArm: true,
      disabledHint: local ? undefined : fallbackHint,
    };
  };
  const ccyScenarios: CcyScenarioDef[] = [
    {
      id: 'unhedged',
      label: 'Unhedged',
      ...stampPortfolio('unhedged', result.origin),
    },
    {
      id: 'carryTarget',
      label: 'Carry Target',
      ...stampPortfolio(
        'carryTarget',
        carryTargetPoint,
        'this currency has no Target Carry / H* standing on the open arm',
      ),
    },
    {
      id: 'balanced',
      label: 'Balanced',
      ...stampPortfolio(
        'balanced',
        balancedPoint,
        'no (0,0) tangent on this currency open arm yet',
      ),
    },
    {
      id: 'swapHedged',
      label: 'Swap hedged',
      point: swapHedgedPoint,
      source: 'local',
      plotOnLocalArm: true,
      disabledHint: swapHedgedPoint
        ? undefined
        : 'no far / CIP twin on the pink tail yet',
    },
  ];
  const customPoint = !overlayFill && comboSnap != null
    ? (twins[comboSnap.idx]?.key === 'origin'
      ? result.origin
      : priceIsoSSlice(
          twins[comboSnap.idx]!.open,
          twins[comboSnap.idx]!.far,
          result.cfarOriginUsdM,
          comboSnap.cover,
        ))
    : null;
  const namedHit = (id: CcyScenarioId) => {
    if (id === 'unhedged') return isOrigin;
    if (!customPoint && !selected) return false;
    const p = id === 'carryTarget' ? carryTargetPoint
      : id === 'balanced' ? balancedPoint
        : id === 'swapHedged' ? swapHedgedPoint
          : null;
    if (!p) return false;
    return Math.abs(selected.peakBook - p.peakBook) < 1e-3
      && (
        (id === 'swapHedged' && arm === 'far')
        || (id !== 'swapHedged' && arm === 'open')
      );
  };
  const comboIsNamed = customPoint != null && (
    (Math.abs(customPoint.peakBook) < 1e-6 && comboSnap!.cover < 1e-9)
    || (carryTargetPoint != null
      && Math.abs(customPoint.peakBook - carryTargetPoint.peakBook) < 1e-3
      && comboSnap!.cover < 1e-9)
    || (balancedPoint != null
      && Math.abs(customPoint.peakBook - balancedPoint.peakBook) < 1e-3
      && comboSnap!.cover < 1e-9)
    || (swapHedgedPoint != null
      && Math.abs(customPoint.peakBook - swapHedgedPoint.peakBook) < 1e-3
      && comboSnap!.cover > 1 - 1e-9)
  );
  const preferCustomChip = portfolioSuggestion?.scenarioId === 'custom'
    && (customPoint != null || scenarioSetpoints.custom != null);
  if (preferCustomChip) {
    const sp = scenarioSetpoints.custom;
    ccyScenarios.push({
      id: 'custom',
      label: 'Custom',
      point: customPoint ?? result.origin,
      displayCfarUsdM: portfolioSuggestion?.cfarUsdM ?? sp?.cfarUsdM,
      displayCarryUsdYrM: portfolioSuggestion?.carryUsdYrM ?? sp?.carryUsdYrM,
      source: 'portfolio',
      plotOnLocalArm: !overlayFill,
    });
  }
  const atCustomSnap = customPoint != null
    && comboSnap != null
    && Math.abs(selected.peakBook - customPoint.peakBook) < 1e-3
    && Math.abs(cover - comboSnap.cover) < 1e-3;
  const portfolioChipId: CcyScenarioId | null = (
    portfolioSuggestion?.scenarioId === 'unhedged'
    || portfolioSuggestion?.scenarioId === 'carryTarget'
    || portfolioSuggestion?.scenarioId === 'balanced'
    || portfolioSuggestion?.scenarioId === 'custom'
  ) ? portfolioSuggestion.scenarioId : null;
  const selectedScenarioId: CcyScenarioId | null = (() => {
    if (overlayFill) {
      if (pinnedScenario) return pinnedScenario;
      if (portfolioChipId && scenarioSetpoints[portfolioChipId]) return portfolioChipId;
    }
    if (preferCustomChip && atCustomSnap) return 'custom';
    if (namedHit('unhedged')) return 'unhedged';
    if (namedHit('swapHedged')) return 'swapHedged';
    if (namedHit('carryTarget')) return 'carryTarget';
    if (namedHit('balanced')) return 'balanced';
    return portfolioChipId;
  })();
  const applyCcyScenario = (id: CcyScenarioId, point: LiquidityFrontierPoint) => {
    if (overlayFill && (id === 'unhedged' || id === 'carryTarget' || id === 'balanced' || id === 'custom')) {
      setPinnedScenario(id);
      commit({ idx: 0, cover: 0 });
      return;
    }
    setPinnedScenario(null);
    if (id === 'unhedged') {
      commit({ idx: 0, cover: 0 });
      return;
    }
    if (id === 'custom' && comboSnap != null) {
      commit({ idx: comboSnap.idx, cover: comboSnap.cover });
      return;
    }
    select(point);
  };
  const stepArm = (dir: number) => {
    const idx = armIdx + dir;
    if (idx < 0 || idx >= twins.length) return;
    commit({ idx, cover: heldCover(idx) });
  };
  /** Snap back to the portfolio optimizer's own point, undoing any manual walk/drag. */
  const matchPortfolio = () => {
    if (overlayFill && portfolioChipId) {
      setPinnedScenario(portfolioChipId);
      commit({ idx: 0, cover: 0 });
      return;
    }
    if (comboSnap != null) {
      commit({ idx: comboSnap.idx, cover: comboSnap.cover });
      return;
    }
    if (suggestedIdx < 0) return;
    commit({ idx: suggestedIdx, cover: 0 });
  };
  const atSuggestion = overlayFill
    ? selectedScenarioId === portfolioChipId
    : comboSnap != null
      ? armIdx === comboSnap.idx && Math.abs(cover - comboSnap.cover) < 1e-3
      : suggestedIdx >= 0 && armIdx === suggestedIdx && cover < 1e-9;
  const deltaVsSuggestionM = suggestedStanding != null
    ? (isOrigin ? 0 : selected.peakBook) - suggestedStanding
    : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const walk = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
        || e.key === 'ArrowDown' || e.key === 'ArrowUp';
      if (!walk) return;
      const el = e.target;
      if (
        el instanceof HTMLInputElement
        && (el.type === 'text' || el.type === 'number')
      ) return;
      e.preventDefault();
      e.stopPropagation();
      stepArm(e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [armIdx, twins, cover, arm, onClose]);

  if (typeof document === 'undefined') return null;

  const dialLabel = liquidityFrontierDialLabel(result.dial);
  const openHit = result.constraint.openHit;
  const cut =
    result.dial === 'carry_target' && result.constraint.hCarryUsdYrM != null
      ? {
          label: 'Target Carry',
          text: `${fmtSignedK(result.constraint.hCarryUsdYrM)} → open ${
            openHit ? fmtSignedK(openHit.carryUsdYrM) : '—'
          } / far ${hedgeHit ? fmtSignedK(hedgeHit.carryUsdYrM) : '—'} @ ${
            openHit ? fmtAbsK(openHit.cfarUsdM) : '—'
          } · same S ${openHit ? openHit.standing.toFixed(1) : '—'} M, two returns`,
          tone: 'amber' as const,
        }
      : result.dial === 'var_target' && result.constraint.vCfarUsdM != null
        ? {
            label: 'Target VAR',
            text: `${fmtAbsK(result.constraint.vCfarUsdM)} → open ${
              openHit ? fmtSignedK(openHit.carryUsdYrM) : '—'
            } / far ${hedgeHit ? fmtSignedK(hedgeHit.carryUsdYrM) : '—'} · VaR layers win over carry`,
            tone: 'sky' as const,
          }
        : {
            label: 'Min floor',
            text: 'binds at the steep left end — no extra cut on the surface, the view zooms small S',
            tone: 'slate' as const,
          };
  const setup = engineInput.setup;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="liq-frontier-title"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-[14px] border border-slate-700 bg-slate-900 shadow-2xl">
        <header className="flex shrink-0 items-start gap-3 border-b border-slate-800 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div
              id="liq-frontier-title"
              className="mb-1.5 text-[15px] font-semibold leading-tight text-slate-50"
            >
              {row.ccy} — liquidity frontier
            </div>
            <div className="flex flex-nowrap gap-1.5 overflow-x-auto">
              <span className="shrink-0 rounded border border-violet-400/40 bg-violet-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-violet-300">
                {strategy.label}
              </span>
              <HeaderChip className={
                result.dial === 'carry_target' ? 'text-amber-300'
                  : result.dial === 'var_target' ? 'text-sky-300'
                    : 'text-slate-300'
              }>
                Dial · {dialLabel}
              </HeaderChip>
              <HeaderChip>
                {bookStandingChipLabel(
                  result.bookStanding,
                  scenarioSetpoints.carryTarget?.bookStandingUsdM
                    ?? result.bookStanding * ccySpotRate(row.ccy),
                )} · cash {fmtK(result.bookCashK / 1000)}
              </HeaderChip>
              <HeaderChip className="text-slate-400">
                {constraintDetail || 'No layer'}
              </HeaderChip>
              {portfolioSuggestion && (
                comboSnap != null
                || suggestedStanding != null
                || overlayFill
              ) && (
                <HeaderChip
                  className={atSuggestion ? 'text-violet-300' : 'text-violet-400/70'}
                >
                  Portfolio · {portfolioSuggestion.scenarioLabel}
                  {portfolioSuggestion.cfarUsdM != null
                    && portfolioSuggestion.carryUsdYrM != null
                    ? ` → ${fmtAbsK(portfolioSuggestion.cfarUsdM)} / ${fmtSignedK(portfolioSuggestion.carryUsdYrM)}`
                    : comboTarget
                      ? ` → ${fmtAbsK(comboTarget.cfarUsdM)} / ${fmtSignedK(comboTarget.carryUsdYrM)}`
                      : suggestedStanding != null
                        ? ` → S ${suggestedStanding.toFixed(1)} M`
                        : ''}
                  {!atSuggestion && deltaVsSuggestionM != null && comboSnap == null
                    ? ` (${deltaVsSuggestionM >= 0 ? '+' : '−'}${Math.abs(deltaVsSuggestionM).toFixed(1)} vs pick)`
                    : ''}
                </HeaderChip>
              )}
              <HeaderChip className={
                (selectedScenarioId && scenarioSetpoints[selectedScenarioId]
                  ? scenarioSetpoints[selectedScenarioId]!.carryUsdYrM
                  : selected.totalCarryUsdYrM) >= 0
                  ? 'text-emerald-300' : 'text-rose-300'
              }>
                Return {fmtSignedK(
                  selectedScenarioId && scenarioSetpoints[selectedScenarioId]
                    ? scenarioSetpoints[selectedScenarioId]!.carryUsdYrM
                    : selected.totalCarryUsdYrM,
                )}
              </HeaderChip>
              <HeaderChip className="text-amber-300">
                CFaR {fmtAbsK(
                  selectedScenarioId && scenarioSetpoints[selectedScenarioId]
                    ? scenarioSetpoints[selectedScenarioId]!.cfarUsdM
                    : selected.finalCfarUsdM,
                )}
              </HeaderChip>
              <HeaderChip className={
                selectedWeighted >= 0 ? 'text-sky-300' : 'text-rose-300'
              }>
                E[return] {fmtSignedK(selectedWeighted)}
              </HeaderChip>
              <HeaderChip className={
                isOrigin ? 'text-slate-300'
                  : arm === 'far' ? 'text-rose-300'
                    : arm === 'mix' ? 'text-yellow-300'
                      : 'text-emerald-300'
              }>
                {isOrigin
                  ? 'S —'
                  : `S ${selected.peakBook.toFixed(1)} M · Δ ${residual.toFixed(2)}`}
              </HeaderChip>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {staged ? (
              <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold text-emerald-200">
                ✓ Staged
              </span>
            ) : null}
            {onStage && livePick != null && residual > 1e-6 ? (
              <button
                type="button"
                onClick={() => onStage(residual)}
                title={
                  staged
                    ? 'Restage this Δ strip into FX Risk / Carry / Decision'
                    : 'Stage this Δ>0 strip for FX Risk / Carry / Decision'
                }
                className="rounded border border-violet-500/50 bg-violet-500/20 px-2.5 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30"
              >
                {staged ? 'Restage' : 'Stage'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-600 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300 hover:bg-slate-800"
            >
              Esc
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          <div className={`mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
            cut.tone === 'amber'
              ? 'border-amber-400/35 bg-amber-500/[0.07]'
              : cut.tone === 'sky'
                ? 'border-sky-400/35 bg-sky-500/[0.07]'
                : 'border-slate-700 bg-slate-950/60'
          }`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              cut.tone === 'amber' ? 'bg-amber-400'
                : cut.tone === 'sky' ? 'bg-sky-400'
                  : 'bg-slate-400'
            }`} />
            <span className={`font-mono text-[9px] font-semibold uppercase tracking-[0.08em] ${
              cut.tone === 'amber' ? 'text-amber-300'
                : cut.tone === 'sky' ? 'text-sky-300'
                  : 'text-slate-300'
            }`}>
              {cut.label}
            </span>
            <span className="font-mono text-[10px] leading-snug text-slate-300">{cut.text}</span>
          </div>

          <div className="mb-3 rounded-[10px] border border-slate-700 bg-slate-950 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="mr-1 font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
                Carry vs CFaR
              </span>
              {ccyScenarios.map(s => {
                const on = selectedScenarioId === s.id;
                const tone = SCENARIO_CHIP_TONE[s.id];
                const chipCfar = s.displayCfarUsdM ?? s.point?.finalCfarUsdM;
                const chipCarry = s.displayCarryUsdYrM ?? s.point?.totalCarryUsdYrM;
                const hasChip = chipCfar != null && chipCarry != null;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={!hasChip}
                    onClick={() => {
                      if (!s.point && s.source !== 'portfolio') return;
                      applyCcyScenario(s.id, s.point ?? result.origin);
                    }}
                    className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 font-mono text-[10px] font-semibold ${
                      !hasChip
                        ? 'cursor-not-allowed border-slate-800 bg-slate-950/40 text-slate-600'
                        : on
                          ? tone.on
                          : tone.off
                    }`}
                    title={hasChip
                      ? `${s.label} — ${fmtAbsK(chipCfar)} CFaR, ${fmtSignedK(chipCarry)}/yr${s.source === 'portfolio' ? ` (${row.ccy} row)` : ''}`
                      : (s.disabledHint ?? `${s.label} is not on this arm`)}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: hasChip ? CCY_SCENARIO_COLORS[s.id] : '#475569' }}
                    />
                    <span>{s.label}</span>
                    {hasChip ? (
                      <span className={`font-medium tabular-nums ${on ? 'opacity-90' : 'text-slate-500'}`}>
                        {fmtAbsK(chipCfar)} · {fmtSignedK(chipCarry)}
                      </span>
                    ) : (
                      <span className="text-slate-600">n/a</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mb-2 flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-[9px] text-slate-500">
                Origin: carry $0 @ section {fmtAbsK(result.cfarOriginUsdM)}
                · scroll in plot to zoom · drag to pan · double-click to reset
              </span>
              <span className="ml-auto flex flex-wrap gap-2.5">
                <Legend swatch="solid" border="border-emerald-400" label="open · cash" />
                <Legend swatch="solid" border="border-rose-400" label="far · cash + points" />
                <Legend swatch="dashed" border="border-slate-400" label="leveraged" />
                <Legend swatch="solid" border="border-yellow-400" label="Δ mix at S" />
                <Legend swatch="dashed" border="border-amber-400" label="tangent from (0,0)" />
                <Legend swatch="dot" border="border-sky-400" label="selected" />
              </span>
            </div>
            <FrontierPlot
              origin={result.origin}
              upper={result.upper}
              lower={result.lower}
              selected={selected}
              isoSlice={isoSlice}
              onSelect={select}
              cfarOriginUsdM={result.cfarOriginUsdM}
              constraint={result.constraint}
              bookStanding={result.bookStanding}
              zoomOut={searching}
              confidencePct={confidencePct}
              scenarios={ccyScenarios}
              selectedScenarioId={selectedScenarioId}
            />
            <p className="mt-1.5 font-mono text-[9px] leading-snug text-slate-500">
              Frame is the live book and the $0-carry origin. Scroll inside the plot to zoom,
              drag to pan, double-click to reset. Drag Leverage to add a dashed tail — it
              clips, it does not zoom the plot out.
            </p>
          </div>

          <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)_auto] items-start gap-x-4 overflow-x-auto rounded-[10px] border border-slate-700 bg-slate-950/60 px-3 py-2.5">
            <ControlField label="Arm" className="w-max">
              <div className="inline-flex h-[22px] items-stretch rounded-md border border-slate-700 bg-slate-950/60 p-0.5">
                <button
                  type="button"
                  className={`rounded px-2.5 text-[10px] font-semibold ${
                    arm === 'open'
                      ? 'bg-emerald-500/20 text-emerald-200'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                  onClick={() => commit({ cover: 0 })}
                >
                  Open
                </button>
                <button
                  type="button"
                  className={`rounded px-2.5 text-[10px] font-semibold ${
                    arm === 'far'
                      ? 'bg-rose-500/20 text-rose-200'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                  onClick={() => {
                    if (isOrigin) {
                      const first = twins.findIndex(t => t.key !== 'origin');
                      if (first >= 0) commit({ idx: first, cover: 1 });
                      else commit({ cover: 1 });
                      return;
                    }
                    commit({ cover: 1 });
                  }}
                >
                  Far
                </button>
              </div>
            </ControlField>

            <ControlField label="Δ residual" hint="1 open · 0 far">
              <span className="font-mono text-[9px] text-rose-300">0</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                disabled={isOrigin}
                value={Math.round(residual * 100)}
                onChange={e => {
                  if (isOrigin) return;
                  commit({ cover: 1 - Number(e.target.value) / 100 });
                }}
                className="h-1.5 min-w-0 flex-1 accent-yellow-400 disabled:opacity-40"
              />
              <span className="font-mono text-[9px] text-emerald-300">1</span>
              <span className="inline-flex h-[22px] shrink-0 items-center rounded border border-slate-700 bg-slate-950 px-1.5">
                <span className="font-mono text-[11px] font-semibold text-yellow-300">
                  {isOrigin ? '—' : residual.toFixed(2)}
                </span>
              </span>
            </ControlField>

            <ControlField
              label={portfolioSuggestion ? 'Portfolio Δ · walk' : 'Walk the frontier'}
              hint={
                comboSnap != null
                  ? (atSuggestion
                    ? `at ${portfolioSuggestion!.scenarioLabel} CFaR/carry`
                    : `off ${portfolioSuggestion!.scenarioLabel} CFaR/carry`)
                  : suggestedStanding != null
                    ? (atSuggestion
                      ? 'at portfolio pick'
                      : `${deltaVsSuggestionM! >= 0 ? '+' : '−'}${Math.abs(deltaVsSuggestionM!).toFixed(1)} M vs ${portfolioSuggestion!.scenarioLabel}`)
                    : (arm === 'mix' ? 'same S · Δ held' : arm === 'far' ? 'far arm' : 'open arm')
              }
            >
              <button
                type="button"
                disabled={armIdx <= 0}
                onClick={() => stepArm(-1)}
                title="Decrease S — step to the next lower standing"
                className="h-[22px] w-6 shrink-0 rounded border border-slate-700 bg-slate-900 font-mono text-[11px] font-semibold text-slate-300 hover:border-slate-500 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                ‹
              </button>
              <span className="w-10 shrink-0 text-center font-mono text-[10px] font-semibold tabular-nums text-slate-200">
                {armIdx + 1}/{twins.length}
              </span>
              <button
                type="button"
                disabled={armIdx >= twins.length - 1}
                onClick={() => stepArm(1)}
                title="Increase S — step to the next higher standing"
                className="h-[22px] w-6 shrink-0 rounded border border-slate-700 bg-slate-900 font-mono text-[11px] font-semibold text-slate-300 hover:border-slate-500 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                ›
              </button>
              {(comboSnap != null || suggestedIdx >= 0) && (
                <button
                  type="button"
                  disabled={atSuggestion}
                  onClick={matchPortfolio}
                  title={`Snap back to the ${portfolioSuggestion?.scenarioLabel ?? 'portfolio'} CFaR/carry pick`}
                  className="h-[22px] shrink-0 rounded border border-violet-500/50 bg-violet-500/10 px-1.5 font-mono text-[9px] font-semibold text-violet-200 hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Match
                </button>
              )}
              <input
                type="range"
                min={0}
                max={Math.max(0, twins.length - 1)}
                step={1}
                value={armIdx}
                onChange={e => {
                  const idx = Number(e.target.value);
                  commit({ idx, cover: heldCover(idx) });
                }}
                className={`h-1.5 min-w-0 flex-1 ${
                  arm === 'far' ? 'accent-rose-400'
                    : arm === 'mix' ? 'accent-yellow-400'
                      : 'accent-emerald-400'
                }`}
              />
            </ControlField>

            <ControlField
              label="Leverage"
              hint={`book ${fmtK(result.bookCashK / 1000)} solid · drag for dashed tail`}
            >
              <input
                type="range"
                min={levMin}
                max={sliderMax}
                step={5}
                value={Math.min(sliderMax, Math.max(levMin, maxCarryK))}
                onChange={e => setMaxCarryK(Number(e.target.value))}
                className="h-1.5 min-w-0 flex-1 accent-emerald-400"
              />
              <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded border border-slate-700 bg-slate-950 px-1.5">
                <span className="font-mono text-[11px] font-semibold tabular-nums text-emerald-300">{maxCarryK}</span>
                <span className="font-mono text-[9px] text-slate-500">$K</span>
              </span>
            </ControlField>

            <ControlField label="Confidence" hint="E[return]" className="w-max">
              <div className="inline-flex h-[22px] items-stretch rounded-md border border-slate-700 bg-slate-950/60 p-0.5">
                {VAR_CONFIDENCE_OPTIONS.map(opt => {
                  const on = confidencePct === opt.pct;
                  return (
                    <button
                      key={opt.pct}
                      type="button"
                      disabled={!onSetupChange || !setup}
                      onClick={() => {
                        if (!setup || !onSetupChange) return;
                        onSetupChange({ ...setup, confidencePct: opt.pct });
                      }}
                      className={`rounded px-2 text-[10px] font-semibold ${
                        on
                          ? 'bg-sky-500/20 text-sky-200'
                          : 'text-slate-500 hover:text-slate-300'
                      } ${onSetupChange && setup ? '' : 'cursor-default opacity-80'}`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </ControlField>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FrontierPlot({
  origin,
  upper,
  lower,
  selected,
  isoSlice = [],
  onSelect,
  cfarOriginUsdM,
  constraint,
  bookStanding,
  zoomOut,
  confidencePct,
  scenarios = [],
  selectedScenarioId = null,
}: {
  origin: LiquidityFrontierPoint;
  upper: readonly LiquidityFrontierPoint[];
  lower: readonly LiquidityFrontierPoint[];
  selected: LiquidityFrontierPoint | null;
  isoSlice?: readonly LiquidityFrontierPoint[];
  onSelect: (p: LiquidityFrontierPoint) => void;
  cfarOriginUsdM: number;
  constraint: LiquidityFrontierConstraint;
  bookStanding: number;
  zoomOut: boolean;
  confidencePct: number;
  scenarios?: readonly CcyScenarioDef[];
  selectedScenarioId?: CcyScenarioId | null;
}) {
  const clipRaw = useId();
  const clipId = `liq-frontier-clip-${clipRaw.replace(/:/g, '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<{
    W: number;
    H: number;
    padL: number;
    padT: number;
    plotW: number;
    plotH: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    carryS: number;
    dataFrame: CarryVarPlotView;
    preferAspect: number;
    setView: (next: CarryVarPlotView) => void;
  } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    lastSx: number;
    lastSy: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [view, setView] = useState<CarryVarPlotView | null>(null);
  const [panning, setPanning] = useState(false);
  const W = 680;
  const H = 340;
  const padL = 72;
  const padR = 40;
  const padT = 32;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const [hover, setHover] = useState<{
    p: LiquidityFrontierPoint;
    kind: 'open' | 'far' | 'origin' | 'mix';
  } | null>(null);
  const open = [...upper]
    .filter(p => p.delta < 1e-9)
    .sort((a, b) => a.finalCfarUsdM - b.finalCfarUsdM);
  const hedged = [...lower].sort((a, b) => a.finalCfarUsdM - b.finalCfarUsdM);
  const openSolid = open.filter(p => !p.levered);
  const openLev = open.filter(p => p.levered);
  const hedgeSolid = hedged.filter(p => !p.levered);
  const hedgeLev = hedged.filter(p => p.levered);
  const framePts = [
    origin,
    ...openSolid,
    ...hedgeSolid,
    ...(selected ? [selected] : []),
    ...isoSlice,
    ...scenarios.flatMap(s => (s.point ? [s.point] : [])),
  ];
  const portfolioCarry = scenarios.flatMap(s => (
    s.displayCarryUsdYrM != null ? [s.displayCarryUsdYrM] : []
  ));
  const portfolioCfar = scenarios.flatMap(s => (
    s.displayCfarUsdM != null ? [s.displayCfarUsdM] : []
  ));
  const openCash = [
    0,
    ...openSolid.map(p => p.cashCarryUsdYrM),
    ...(selected ? [selected.totalCarryUsdYrM] : []),
    ...scenarios.flatMap(s => (s.point ? [s.point.totalCarryUsdYrM] : [])),
    ...portfolioCarry,
    ...(zoomOut ? [constraint.openHit?.carryUsdYrM ?? 0, constraint.hCarryUsdYrM ?? 0] : []),
  ].filter(v => Number.isFinite(v));
  const farCarry = [
    0,
    ...hedgeSolid.map(p => p.totalCarryUsdYrM),
    ...(selected ? [selected.totalCarryUsdYrM] : []),
    ...scenarios.flatMap(s => (
      s.point && s.point.delta >= 1 - 1e-9 ? [s.point.totalCarryUsdYrM] : []
    )),
    constraint.hedgeHit?.carryUsdYrM ?? 0,
  ].filter(v => Number.isFinite(v));
  const cfars = [
    ...framePts.map(p => p.finalCfarUsdM),
    cfarOriginUsdM,
    ...portfolioCfar,
    ...(zoomOut ? [
      constraint.vCfarUsdM ?? 0,
      constraint.openHit?.cfarUsdM ?? 0,
      constraint.hedgeHit?.cfarUsdM ?? 0,
    ] : []),
  ].filter(v => Number.isFinite(v) && v >= 0);
  const x0 = Math.max(0, cfarOriginUsdM);
  const cfarHi = Math.max(x0, ...cfars);
  const autoXMax = Math.max(cfarHi * 1.08, x0 + 0.025);
  const autoXMin = Math.max(0, x0 - (autoXMax - x0) * 0.28);
  const yMaxData = Math.max(0, ...openCash, 0.012);
  const yMinOpen = Math.min(0, ...openCash);
  const yMinFar = Math.min(0, ...farCarry);
  const { s: carryS, zPos, zNeg } = carryAxisFromArms(yMinOpen, yMaxData, yMinFar);
  let autoYMin = carryS * Math.sinh(zNeg);
  const autoYMax = carryS * Math.sinh(zPos);
  const farTipY = Math.min(
    0,
    ...farCarry.filter(v => v < -1e-6),
    ...scenarios.flatMap(s => (
      s.point && s.point.totalCarryUsdYrM < -1e-6 ? [s.point.totalCarryUsdYrM] : []
    )),
  );
  if (farTipY < autoYMin - 1e-9) {
    autoYMin = farTipY - Math.max(Math.abs(farTipY) * 0.12, 0.006);
  }
  const autoFrame: CarryVarPlotView = {
    xMin: autoXMin,
    xMax: autoXMax,
    yMin: autoYMin,
    yMax: autoYMax,
  };
  const worldPts = [origin, ...open, ...hedged, ...isoSlice, ...(selected ? [selected] : [])];
  const allCfar = [
    ...worldPts.map(p => p.finalCfarUsdM),
    cfarOriginUsdM,
    constraint.vCfarUsdM ?? 0,
    constraint.openHit?.cfarUsdM ?? 0,
    constraint.hedgeHit?.cfarUsdM ?? 0,
  ].filter(v => Number.isFinite(v) && v >= 0);
  const allCarry = [
    ...worldPts.map(p => p.totalCarryUsdYrM),
    0,
    constraint.openHit?.carryUsdYrM ?? 0,
    constraint.hedgeHit?.carryUsdYrM ?? 0,
    constraint.hCarryUsdYrM ?? 0,
  ].filter(Number.isFinite);
  const yCoreMin = Math.min(autoFrame.yMin, ...allCarry, 0);
  const yCoreMax = Math.max(autoFrame.yMax, ...allCarry, 0.012);
  const zCore0 = carryFwd(yCoreMin, carryS);
  const zCore1 = carryFwd(yCoreMax, carryS);
  const zCorePad = Math.max(zCore1 - zCore0, 0.55);
  const dataFrame: CarryVarPlotView = {
    xMin: 0,
    xMax: Math.max(autoFrame.xMax, ...allCfar, 0.05) * 1.2,
    yMin: carryS * Math.sinh(zCore0 - zCorePad),
    yMax: carryS * Math.sinh(zCore1 + zCorePad),
  };

  useEffect(() => {
    setView(null);
  }, [cfarOriginUsdM, bookStanding, confidencePct]);

  const xMin = view?.xMin ?? autoFrame.xMin;
  const xMax = view?.xMax ?? autoFrame.xMax;
  const yMin = view?.yMin ?? autoFrame.yMin;
  const yMax = view?.yMax ?? autoFrame.yMax;
  const zMin = carryFwd(yMin, carryS);
  const zMax = carryFwd(yMax, carryS);
  const zDen = zMax - zMin;
  const xDen = xMax - xMin;
  const x = (v: number) => padL + (xDen > 1e-12 ? ((v - xMin) / xDen) * plotW : 0);
  const y = (v: number) => padT + (1 - (carryFwd(v, carryS) - zMin) / (zDen || 1)) * plotH;
  const y0 = y(0);
  const yTickMin = yMin;
  const yTickMax = yMax;
  const originInX = x0 >= xMin - 1e-9 && x0 <= xMax + 1e-9;
  const zeroInY = yMin <= 1e-12 && yMax >= -1e-12;
  const autoZ0 = carryFwd(autoFrame.yMin, carryS);
  const autoZ1 = carryFwd(autoFrame.yMax, carryS);
  const preferAspect = (autoFrame.xMax - autoFrame.xMin)
    / Math.max(autoZ1 - autoZ0, 1e-9);

  zoomRef.current = {
    W, H, padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, carryS, dataFrame,
    preferAspect, setView,
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const z = zoomRef.current;
      if (!z) return;
      const pt = svgLocalXY(el, e.clientX, e.clientY, z.W, z.H);
      if (!pt || !inPlotRect(pt.sx, pt.sy, z.padL, z.padT, z.plotW, z.plotH)) {
        return;
      }
      e.preventDefault();
      const raw = e.deltaMode === 1
        ? e.deltaY * 16
        : e.deltaMode === 2
          ? Math.sign(e.deltaY) * z.plotH
          : e.deltaY;
      if (raw === 0) return;
      const factor = Math.exp(Math.max(-12, Math.min(12, raw)) * (e.ctrlKey ? 0.0035 : 0.002));
      if (Math.abs(factor - 1) < 0.001) return;
      const xSpan = z.xMax - z.xMin;
      const ax = z.xMin + ((pt.sx - z.padL) / z.plotW) * xSpan;
      const zLo = carryFwd(z.yMin, z.carryS);
      const zHi = carryFwd(z.yMax, z.carryS);
      const az = zHi - ((pt.sy - z.padT) / z.plotH) * (zHi - zLo);
      z.setView(clampCarryVarPlotView(
        {
          xMin: ax - (ax - z.xMin) * factor,
          xMax: ax + (z.xMax - ax) * factor,
          yMin: z.carryS * Math.sinh(az - (az - zLo) * factor),
          yMax: z.carryS * Math.sinh(az + (zHi - az) * factor),
        },
        z.dataFrame,
        z.carryS,
        { x: ax, z: az },
        z.preferAspect,
      ));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const endPan = (e: PointerEvent<SVGSVGElement>) => {
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

  const onPlotPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const z = zoomRef.current;
    const el = svgRef.current;
    if (!z || !el) return;
    const pt = svgLocalXY(el, e.clientX, e.clientY, z.W, z.H);
    if (!pt || !inPlotRect(pt.sx, pt.sy, z.padL, z.padT, z.plotW, z.plotH)) return;
    if (snapPointNear(pt.sx, pt.sy)) return;
    dragRef.current = { pointerId: e.pointerId, lastSx: pt.sx, lastSy: pt.sy, moved: false };
  };

  const onPlotPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const z = zoomRef.current;
    const el = svgRef.current;
    if (!drag || !z || !el || drag.pointerId !== e.pointerId) return;
    const pt = svgLocalXY(el, e.clientX, e.clientY, z.W, z.H);
    if (!pt) return;
    const dSx = pt.sx - drag.lastSx;
    const dSy = pt.sy - drag.lastSy;
    if (!drag.moved && Math.hypot(dSx, dSy) < 3) return;
    if (!drag.moved) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* already captured */ }
    }
    drag.moved = true;
    drag.lastSx = pt.sx;
    drag.lastSy = pt.sy;
    if (!panning) setPanning(true);
    const xSpan = z.xMax - z.xMin;
    const zLo = carryFwd(z.yMin, z.carryS);
    const zHi = carryFwd(z.yMax, z.carryS);
    const zSpan = zHi - zLo;
    z.setView(clampCarryVarPlotView(
      {
        xMin: z.xMin - (dSx / z.plotW) * xSpan,
        xMax: z.xMax - (dSx / z.plotW) * xSpan,
        yMin: z.carryS * Math.sinh(zLo + (dSy / z.plotH) * zSpan),
        yMax: z.carryS * Math.sinh(zHi + (dSy / z.plotH) * zSpan),
      },
      z.dataFrame,
      z.carryS,
    ));
  };
  const toPath = (pts: readonly LiquidityFrontierPoint[]) =>
    pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.finalCfarUsdM).toFixed(1)},${y(p.totalCarryUsdYrM).toFixed(1)}`)
      .join(' ');
  const openLevPath = openSolid.length > 0
    ? [openSolid[openSolid.length - 1]!, ...openLev]
    : [origin, ...openLev];
  const hedgeLevPath = hedgeSolid.length > 0
    ? [hedgeSolid[hedgeSolid.length - 1]!, ...hedgeLev]
    : [origin, ...hedgeLev];
  const nearBookS = (pts: readonly LiquidityFrontierPoint[]) => {
    if (pts.length === 0) return null;
    if (!(Math.abs(bookStanding) > 0.01)) return pts[pts.length - 1] ?? null;
    return pts.reduce((best, p) => (
      Math.abs(p.peakBook - bookStanding) < Math.abs(best.peakBook - bookStanding)
        ? p : best
    ));
  };
  const bookPt = nearBookS(openSolid);
  const bookFar = nearBookS(hedgeSolid);
  const xTickRaw = cfarKTicks(xMin, xMax);
  if (xMin <= 1e-9 && !xTickRaw.some(v => Math.abs(v) < 1e-9)) xTickRaw.unshift(0);
  if (x0 > 0 && !xTickRaw.some(v => Math.abs(v * 1000 - x0 * 1000) < 0.51)) {
    xTickRaw.push(x0);
  }
  xTickRaw.sort((a, b) => a - b);
  const xTicks: number[] = [];
  const xPriority = [x0, ...(xMin <= 1e-9 ? [0] : [])];
  for (const v of xPriority) {
    if (v >= xMin - 1e-9 && v <= xMax + 1e-9 && xTicks.every(u => Math.abs(x(u) - x(v)) >= 22)) {
      xTicks.push(v);
    }
  }
  for (const v of xTickRaw) {
    if (xTicks.every(u => Math.abs(x(u) - x(v)) >= 36)) xTicks.push(v);
  }
  xTicks.sort((a, b) => a - b);
  const yTicks = thinTicks(
    carryLogTicks(yTickMin, yTickMax).filter(v => {
      const py = y(v);
      return py >= padT - 2 && py <= padT + plotH + 2;
    }),
    y,
    14,
  );
  const onPt = (p: LiquidityFrontierPoint) => samePt(p, selected);
  const tip = open[open.length - 1] ?? null;
  const tipLo = hedged[hedged.length - 1] ?? null;
  const inView = (p: LiquidityFrontierPoint) => {
    const py = y(p.totalCarryUsdYrM);
    return p.finalCfarUsdM >= xMin - 1e-6
      && p.finalCfarUsdM <= xMax + 1e-6
      && py >= padT - 8
      && py <= padT + plotH + 8;
  };
  const openInView = open.filter(inView);
  const hedgeInView = hedged.filter(inView);
  const xy = (p: LiquidityFrontierPoint) => ({ x: x(p.finalCfarUsdM), y: y(p.totalCarryUsdYrM) });
  const openDotAt = pickDotsAlongPolyline(openInView.map(xy), 24, 7);
  const hedgeDotAt = pickDotsAlongPolyline(hedgeInView.map(xy), 22, 7);
  const isoPath = isoSlice.length > 1
    ? densifyIsoSliceScreen(
        isoSlice[0]!,
        isoSlice[isoSlice.length - 1]!,
        cfarOriginUsdM,
        isoSlice,
        x,
        y,
      )
    : [];
  const isoDots = isoMixDotPoints(isoSlice).filter(inView);
  const plotBox = { l: padL, t: padT, r: W - padR, b: H - padB };
  const labelDrafts: PlotLabelDraft[] = [];
  const labelAnchors: { ax: number; ay: number }[] = [];
  const takeLabel = (draft: PlotLabelDraft) => {
    if (labelAnchors.some(a => nearScreen(a.ax, a.ay, draft.ax, draft.ay, 16))) return;
    labelAnchors.push({ ax: draft.ax, ay: draft.ay });
    labelDrafts.push(draft);
  };
  if (originInX && zeroInY) {
    takeLabel({
      id: 'origin',
      text: 'carry $0',
      sub: `section ${fmtAbsK(x0)}`,
      ax: x(x0),
      ay: y0,
      fill: '#e2e8f0',
      prefer: 'below',
    });
  }
  const swapSc = scenarios.find(s => s.id === 'swapHedged');
  if (swapSc?.point && inView(swapSc.point)) {
    takeLabel({
      id: 'swapHedged',
      text: `swap hedged ${fmtSignedK(swapSc.point.totalCarryUsdYrM)}`,
      ax: x(swapSc.point.finalCfarUsdM),
      ay: y(swapSc.point.totalCarryUsdYrM),
      fill: '#fb7185',
      prefer: 'below',
    });
  }
  const scenarioPlotXy = (s: CcyScenarioDef): { x: number; y: number } | null => {
    if (
      typeof s.displayCfarUsdM === 'number' && Number.isFinite(s.displayCfarUsdM)
      && typeof s.displayCarryUsdYrM === 'number' && Number.isFinite(s.displayCarryUsdYrM)
    ) {
      return { x: s.displayCfarUsdM, y: s.displayCarryUsdYrM };
    }
    if (!s.point) return null;
    return { x: s.point.finalCfarUsdM, y: s.point.totalCarryUsdYrM };
  };
  const askXy = (() => {
    const s = scenarios.find(sc => sc.id === 'carryTarget');
    return s ? scenarioPlotXy(s) : null;
  })();
  if (askXy && !(zoomOut && constraint.hCarryUsdYrM != null)) {
    takeLabel({
      id: 'carryTargetLine',
      text: `Carry Target ${fmtSignedK(askXy.y)}`,
      ax: W - padR - 4,
      ay: y(askXy.y),
      fill: '#60a5fa',
      prefer: 'left',
    });
  } else if (zoomOut && constraint.hCarryUsdYrM != null) {
    takeLabel({
      id: 'targetCarryLine',
      text: `Target Carry ${fmtSignedK(constraint.hCarryUsdYrM)}`,
      ax: W - padR - 4,
      ay: y(constraint.hCarryUsdYrM),
      fill: '#fbbf24',
      prefer: 'left',
    });
  }
  if (zoomOut && constraint.vCfarUsdM != null) {
    takeLabel({
      id: 'targetVar',
      text: `Target VAR ${fmtAbsK(constraint.vCfarUsdM)}`,
      ax: x(constraint.vCfarUsdM),
      ay: padT + 10,
      fill: '#38bdf8',
      prefer: 'right',
    });
  }
  const selSc = scenarios.find(s => s.id === selectedScenarioId);
  const selXy = selSc ? scenarioPlotXy(selSc) : null;
  if (
    selSc
    && selXy
    && selXy.x >= xMin - 1e-6
    && selXy.x <= xMax + 1e-6
    && selSc.id !== 'unhedged'
    && selSc.id !== 'swapHedged'
  ) {
    takeLabel({
      id: `sel-${selSc.id}`,
      text: selSc.label,
      ax: x(selXy.x),
      ay: y(selXy.y),
      fill: CCY_SCENARIO_COLORS[selSc.id],
      prefer: 'above',
    });
  }
  const bookLabelPt = bookPt;
  if (
    bookPt
    && Math.abs(bookStanding) > 0.01
    && inView(bookPt)
    && bookLabelPt
  ) {
    takeLabel({
      id: 'bookS',
      text: `book S ${bookStanding.toFixed(1)}`,
      ax: x(bookLabelPt.finalCfarUsdM),
      ay: y(bookLabelPt.totalCarryUsdYrM),
      fill: '#e2e8f0',
      prefer: 'below',
    });
  }
  if (zoomOut && constraint.openHit) {
    takeLabel({
      id: 'openHit',
      text: `open S ${constraint.openHit.standing.toFixed(1)} · ${fmtK(constraint.openHit.carryUsdYrM)}`,
      ax: x(constraint.openHit.cfarUsdM),
      ay: y(constraint.openHit.carryUsdYrM),
      fill: '#e2e8f0',
      prefer: 'above',
    });
  }
  if (zoomOut && constraint.hedgeHit) {
    takeLabel({
      id: 'farHit',
      text: `far S ${constraint.hedgeHit.standing.toFixed(1)} · ${fmtK(constraint.hedgeHit.carryUsdYrM)}`,
      ax: x(constraint.hedgeHit.cfarUsdM),
      ay: y(constraint.hedgeHit.carryUsdYrM),
      fill: '#e2e8f0',
      prefer: 'below',
    });
  }
  if (zoomOut && tip && !constraint.openHit) {
    takeLabel({
      id: 'openTip',
      text: `open S ${tip.peakBook.toFixed(1)}`,
      ax: x(tip.finalCfarUsdM),
      ay: y(tip.totalCarryUsdYrM),
      fill: '#34d399',
      prefer: 'above',
    });
  }
  if (zoomOut && tipLo && !constraint.hedgeHit) {
    takeLabel({
      id: 'farTip',
      text: `far S ${tipLo.peakBook.toFixed(1)}`,
      ax: x(tipLo.finalCfarUsdM),
      ay: y(tipLo.totalCarryUsdYrM),
      fill: '#fb7185',
      prefer: 'below',
    });
  }
  const plotLabels = placePlotLabels(labelDrafts, plotBox);
  const snapPointNear = (sx: number, sy: number) => {
    let best: LiquidityFrontierPoint | null = null;
    let bestD = 12;
    for (const s of scenarios) {
      if (!s.point) continue;
      const d = Math.hypot(x(s.point.finalCfarUsdM) - sx, y(s.point.totalCarryUsdYrM) - sy);
      if (d <= bestD) {
        bestD = d;
        best = s.point;
      }
    }
    if (best) return best;
    const candidates: LiquidityFrontierPoint[] = [
      origin,
      ...openInView,
      ...hedgeInView,
      ...isoDots,
    ];
    for (const p of candidates) {
      const d = Math.hypot(x(p.finalCfarUsdM) - sx, y(p.totalCarryUsdYrM) - sy);
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };
  const pickNearestAt = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    const z = zoomRef.current;
    if (!el || !z) return null;
    const loc = svgLocalXY(el, clientX, clientY, z.W, z.H);
    if (!loc) return null;
    const named = snapPointNear(loc.sx, loc.sy);
    if (named) return named;
    const walk = [
      origin,
      ...open,
      ...hedged,
      ...isoSlice,
    ];
    let best: LiquidityFrontierPoint | null = null;
    let bestD = 22;
    for (const p of walk) {
      const d = Math.hypot(x(p.finalCfarUsdM) - loc.sx, y(p.totalCarryUsdYrM) - loc.sy);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  const hitCircle = (
    p: LiquidityFrontierPoint,
    fill: string,
    r: number,
    key: string,
    kind: 'open' | 'far' | 'origin' | 'mix',
  ) => {
    const hovered = hover != null && samePt(hover.p, p) && hover.kind === kind;
    return (
      <g key={key}>
        <circle
          cx={x(p.finalCfarUsdM)}
          cy={y(p.totalCarryUsdYrM)}
          r={10}
          fill="transparent"
          className="cursor-pointer"
          onClick={e => {
            e.stopPropagation();
            if (suppressClickRef.current) return;
            onSelect(p);
          }}
          onMouseEnter={() => setHover({ p, kind })}
          onMouseLeave={() => setHover(null)}
        />
        <circle
          cx={x(p.finalCfarUsdM)}
          cy={y(p.totalCarryUsdYrM)}
          r={onPt(p) ? 6.5 : hovered ? 5 : r}
          fill={onPt(p) ? '#38bdf8' : fill}
          stroke={onPt(p) ? '#e0f2fe' : hovered ? '#cbd5e1' : '#0b1220'}
          strokeWidth={onPt(p) || hovered ? 1.5 : 1}
          className="pointer-events-none"
        />
      </g>
    );
  };
  const hoverScenario = hover
    ? scenarios.find(s => s.point && samePt(s.point, hover.p))
    : null;
  const hoverKindLabel = hover == null ? ''
    : hoverScenario ? hoverScenario.label
    : hover.kind === 'origin' ? 'origin'
    : hover.kind === 'mix' ? `mix Δ ${(1 - hover.p.delta).toFixed(2)}`
    : hover.kind;
  const hoverTip = hover
    ? `${hoverKindLabel} · S ${
        hover.kind === 'origin' ? '—' : `${hover.p.peakBook.toFixed(1)} M`
      } · carry ${fmtSignedK(hover.p.totalCarryUsdYrM)} · CFaR ${fmtAbsK(hover.p.finalCfarUsdM)} · E[return] ${fmtSignedK(weightedReturnUsdM(hover.p, confidencePct, cfarOriginUsdM))}`
    : null;

  return (
    <div className="relative" style={{ overscrollBehavior: 'contain' }}>
      {view && (
        <button
          type="button"
          onClick={() => setView(null)}
          className="absolute left-2 top-2 z-10 font-mono text-[9px] text-sky-400 hover:text-sky-300"
        >
          reset zoom
        </button>
      )}
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full touch-none select-none overflow-hidden rounded-md border border-slate-800 bg-slate-950/50 outline-none focus:outline-none"
      tabIndex={0}
      role="img"
      aria-label="Carry versus CFaR. Scroll to zoom, drag to pan, double-click to reset."
      onDoubleClick={() => setView(null)}
      onPointerDown={onPlotPointerDown}
      onPointerMove={onPlotPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onClick={e => {
        if (suppressClickRef.current) return;
        const nearest = pickNearestAt(e.clientX, e.clientY);
        if (nearest) onSelect(nearest);
      }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={padL} y={padT} width={plotW} height={plotH} />
        </clipPath>
      </defs>
      <text x={padL + plotW / 2} y={H - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">
        CFaR ($K) — risk
      </text>
      <text
        x={13}
        y={padT + plotH / 2}
        textAnchor="middle"
        fontSize={9}
        fill="#94a3b8"
        transform={`rotate(-90 13 ${padT + plotH / 2})`}
      >
        Carry ($K/yr) — log
      </text>
      <line x1={padL} y1={padT} x2={W - padR} y2={padT} stroke="#334155" strokeWidth={1} />
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#475569" strokeWidth={1} />
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#334155" strokeWidth={1} />
      {xTicks.map(v => (
        <g key={`xt-${v}`}>
          <line x1={x(v)} y1={H - padB} x2={x(v)} y2={H - padB + 4} stroke="#64748b" />
          <text
            x={x(v)}
            y={H - padB + 15}
            textAnchor="middle"
            fontSize={8}
            fill={Math.abs(v - x0) < 1e-6 ? '#e2e8f0' : '#cbd5e1'}
          >
            {fmtK(v)}
          </text>
        </g>
      ))}
      {yTicks.map(v => (
        <g key={`yt-${v}`}>
          <line x1={padL - 4} y1={y(v)} x2={padL} y2={y(v)} stroke="#64748b" />
          <text
            x={padL - 7}
            y={y(v) + 3}
            textAnchor="end"
            fontSize={8}
            fill={Math.abs(v) < 1e-9 ? '#e2e8f0' : '#cbd5e1'}
          >
            {Math.abs(v) < 1e-9 ? '$0' : fmtK(v)}
          </text>
        </g>
      ))}
      {originInX && (
        <line
          x1={x(x0)}
          y1={padT}
          x2={x(x0)}
          y2={H - padB}
          stroke="#334155"
          strokeWidth={1}
        />
      )}
      {zeroInY && (
        <line
          x1={padL}
          y1={y0}
          x2={W - padR}
          y2={y0}
          stroke="#94a3b8"
          strokeWidth={1.2}
        />
      )}
      <rect
        x={padL}
        y={padT}
        width={plotW}
        height={plotH}
        fill="transparent"
        className={panning ? 'cursor-grabbing' : 'cursor-grab'}
      />
      <g clipPath={`url(#${clipId})`}>
      {openSolid.length > 0 && (
        <path d={toPath([origin, ...openSolid])} fill="none" stroke="#34d399" strokeWidth={1.8} />
      )}
      {openLevPath.length > 1 && (
        <path d={toPath(openLevPath)} fill="none" stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 4" />
      )}
      {isoPath.length > 1 && (
        <path
          d={isoPath
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.finalCfarUsdM).toFixed(2)},${y(p.totalCarryUsdYrM).toFixed(2)}`)
            .join(' ')}
          fill="none"
          stroke="#facc15"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {hedgeSolid.length > 0 && (
        <path d={toPath([origin, ...hedgeSolid])} fill="none" stroke="#fb7185" strokeWidth={1.6} />
      )}
      {hedgeLevPath.length > 1 && (
        <path d={toPath(hedgeLevPath)} fill="none" stroke="#fb7185" strokeWidth={1.4} strokeDasharray="5 4" />
      )}
      {(() => {
        const balanced = scenarios.find(s => s.id === 'balanced');
        const bxy = balanced ? scenarioPlotXy(balanced) : null;
        if (!bxy) return null;
        const ox0 = x(0);
        const oy0 = y(0);
        const tx = x(bxy.x);
        const ty = y(bxy.y);
        const den = tx - ox0;
        if (!(Math.abs(den) > 1e-6)) return null;
        const slope = (ty - oy0) / den;
        const xL = padL;
        const xR = padL + plotW;
        return (
          <path
            d={`M${xL.toFixed(1)},${(oy0 + slope * (xL - ox0)).toFixed(1)} L${xR.toFixed(1)},${(oy0 + slope * (xR - ox0)).toFixed(1)}`}
            fill="none"
            stroke="#f59e0b"
            strokeWidth={1.15}
            strokeDasharray="5 4"
            opacity={0.85}
          />
        );
      })()}
      {(() => {
        if (!askXy || (zoomOut && constraint.hCarryUsdYrM != null)) return null;
        return (
          <g>
            <line
              x1={padL}
              y1={y(askXy.y)}
              x2={W - padR}
              y2={y(askXy.y)}
              stroke="#60a5fa"
              strokeWidth={1.1}
              strokeDasharray="5 4"
              opacity={0.9}
            />
          </g>
        );
      })()}
      {zoomOut && constraint.openHit && constraint.hedgeHit && (
        <line
          x1={x(constraint.openHit.cfarUsdM)}
          y1={y(constraint.openHit.carryUsdYrM)}
          x2={x(constraint.hedgeHit.cfarUsdM)}
          y2={y(constraint.hedgeHit.carryUsdYrM)}
          stroke="#fbbf24"
          strokeWidth={1}
          strokeDasharray="2 3"
          opacity={0.7}
        />
      )}
      {zoomOut && constraint.hCarryUsdYrM != null && (
        <g>
          <line
            x1={padL}
            y1={y(constraint.hCarryUsdYrM)}
            x2={W - padR}
            y2={y(constraint.hCarryUsdYrM)}
            stroke="#fbbf24"
            strokeWidth={1.2}
            strokeDasharray="4 3"
          />
        </g>
      )}
      {zoomOut && constraint.vCfarUsdM != null && (
        <g>
          <line
            x1={x(constraint.vCfarUsdM)}
            y1={padT}
            x2={x(constraint.vCfarUsdM)}
            y2={H - padB}
            stroke="#38bdf8"
            strokeWidth={1.2}
            strokeDasharray="4 3"
          />
        </g>
      )}
      {zoomOut && constraint.openHit && (
        <g>
          <circle
            cx={x(constraint.openHit.cfarUsdM)}
            cy={y(constraint.openHit.carryUsdYrM)}
            r={7}
            fill="none"
            stroke="#fbbf24"
            strokeWidth={2}
          />
        </g>
      )}
      {zoomOut && constraint.hedgeHit && (
        <g>
          <circle
            cx={x(constraint.hedgeHit.cfarUsdM)}
            cy={y(constraint.hedgeHit.carryUsdYrM)}
            r={7}
            fill="none"
            stroke="#fbbf24"
            strokeWidth={2}
          />
        </g>
      )}
      {hedgeInView.map((p, i) => (
        hedgeDotAt.has(i) || onPt(p)
          ? hitCircle(p, '#fb7185', 3.5, `l-${p.peakBook}:${i}`, 'far')
          : null
      ))}
      {openInView.map((p, i) => (
        openDotAt.has(i) || onPt(p)
          ? hitCircle(p, '#34d399', 3.5, `u-${p.delta}:${p.peakBook}:${i}`, 'open')
          : null
      ))}
      {isoDots.map((p, i) => (
        hitCircle(p, '#facc15', 3, `m-${p.delta.toFixed(4)}:${i}`, 'mix')
      ))}
      {hitCircle(origin, '#f8fafc', 6.5, 'origin', 'origin')}
      {scenarios.map(s => {
        const xy = scenarioPlotXy(s);
        if (!xy) return null;
        const fill = CCY_SCENARIO_COLORS[s.id];
        const on = selectedScenarioId === s.id;
        const p = s.point;
        return (
          <g key={`sc-${s.id}`}>
            <circle
              cx={x(xy.x)}
              cy={y(xy.y)}
              r={11}
              fill="transparent"
              className={p ? 'cursor-pointer' : undefined}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation();
                if (suppressClickRef.current || !p) return;
                onSelect(p);
              }}
              onMouseEnter={() => {
                if (!p) return;
                setHover({
                  p,
                  kind: s.id === 'unhedged' ? 'origin' : s.id === 'swapHedged' ? 'far' : 'open',
                });
              }}
              onMouseLeave={() => setHover(null)}
            />
            <circle
              cx={x(xy.x)}
              cy={y(xy.y)}
              r={on ? 6.5 : 5}
              fill={on ? '#38bdf8' : fill}
              stroke={on ? '#e0f2fe' : '#0b1220'}
              strokeWidth={on ? 1.5 : 1}
              className="pointer-events-none"
            />
          </g>
        );
      })}
      {selected && Math.abs(selected.peakBook) > 1e-6 && !(
        selXy
        && Math.abs(selected.finalCfarUsdM - selXy.x) < 1e-4
        && Math.abs(selected.totalCarryUsdYrM - selXy.y) < 1e-4
      ) && (
        <circle
          cx={x(selected.finalCfarUsdM)}
          cy={y(selected.totalCarryUsdYrM)}
          r={6.5}
          fill="#38bdf8"
          stroke="#e0f2fe"
          strokeWidth={1.5}
          className="pointer-events-none"
        />
      )}
      {bookPt && Math.abs(bookStanding) > 0.01 && inView(bookPt) && (
        <g className="pointer-events-none">
          <circle
            cx={x(bookPt.finalCfarUsdM)}
            cy={y(bookPt.totalCarryUsdYrM)}
            r={5}
            fill="#0b1220"
            stroke="#f8fafc"
            strokeWidth={1.5}
          />
          {bookFar && inView(bookFar) && (
            <circle
              cx={x(bookFar.finalCfarUsdM)}
              cy={y(bookFar.totalCarryUsdYrM)}
              r={5}
              fill="#0b1220"
              stroke="#f8fafc"
              strokeWidth={1.5}
            />
          )}
        </g>
      )}
      </g>
      {plotLabels.map(lab => (
        <g key={lab.id} className="pointer-events-none">
          <text
            x={lab.x}
            y={lab.y}
            textAnchor={lab.anchor}
            fontSize={8}
            fill={lab.fill}
          >
            {lab.text}
          </text>
          {lab.sub && (
            <text
              x={lab.x}
              y={lab.y + 11}
              textAnchor={lab.anchor}
              fontSize={8}
              fill="#94a3b8"
            >
              {lab.sub}
            </text>
          )}
        </g>
      ))}
    </svg>
      {hoverTip && (
        <div className="pointer-events-none absolute right-2 top-2 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-200">
          {hoverTip}
        </div>
      )}
    </div>
  );
}
