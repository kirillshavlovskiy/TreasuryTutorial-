'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ccySpotRate, type RowState } from '@/lib/fx-buffer';
import {
  bookCashCarryK,
  buildLiquidityLeftEndFrontier,
  carryAxisFromArms,
  carryFwd,
  constraintTwinFromHits,
  frontierCarryDotsK,
  isoSSlicePoints,
  liquidityFrontierDial,
  liquidityFrontierDialLabel,
  priceIsoSSlice,
  snapFrontierStandKey,
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

function fmtK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.05) return '$0K';
  const dec = Math.abs(k) < 10 ? 1 : 0;
  return `${k >= 0 ? '' : '−'}$${Math.abs(k).toFixed(dec)}K`;
}

function fmtSignedK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.05) return '$0K';
  const dec = Math.abs(k) < 10 ? 1 : 0;
  const sign = k > 0 ? '+' : k < 0 ? '−' : '';
  return `${sign}$${Math.abs(k).toFixed(dec)}K`;
}

function fmtAbsK(usdM: number): string {
  const k = Math.abs(usdM * 1000);
  if (k < 0.05) return '$0K';
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
}: {
  row: RowState;
  strategy: LiquidityStrategy;
  constraintDetail: string;
  engineInput: Omit<LiquidityFrontierInput, 'row' | 'strategy'>;
  bookStanding?: number;
  onSetupChange?: (setup: VarSetup) => void;
  onClose: () => void;
}) {
  const liveS = Math.abs(bookStanding) > 0.01
    ? bookStanding
    : (typeof row.carry_target === 'number' && Math.abs(row.carry_target) > 0.01
      ? row.carry_target
      : 0);
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
  /** Carry/VAR cut: keep a tail past the gold ring so the cut is not the roof. */
  const plotCapK = searching && bookK > 0.5
    ? Math.max(maxCarryK, bookK * 1.7)
    : maxCarryK;

  const carryUsdK = useMemo(() => frontierCarryDotsK(bookK, {
    targetCashK: searching ? bookK : 0,
    tail: plotCapK > bookK + 0.5,
    maxK: plotCapK,
  }), [bookK, searching, plotCapK]);

  const result = useMemo(
    () => buildLiquidityLeftEndFrontier({
      ...engineInput,
      row,
      strategy,
      bookStanding: liveS,
      carryUsdK,
    }),
    [engineInput, row, strategy, liveS, carryUsdK],
  );

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
  ].join(':');
  const autoKey = snapFrontierStandKey(
    result.dial,
    result.constraint.openHit,
    twins.map(t => ({ key: t.key, standing: t.open.peakBook })),
  );
  const autoIdx = indexOfTwinKey(twins, autoKey, result.constraint.openHit?.standing);
  const [pick, setPick] = useState<{ epoch: string; idx: number; cover: number } | null>(null);
  const livePick = pick?.epoch === snapEpoch ? pick : null;
  const armIdx = livePick != null
    ? Math.min(twins.length - 1, Math.max(0, livePick.idx))
    : autoIdx;
  const twin = twins[armIdx] ?? twins[0]!;
  const isOrigin = twin.key === 'origin';
  const cover = isOrigin ? 0 : (livePick?.cover ?? 0);
  const commit = (next: { idx?: number; cover?: number }) => {
    const idx = next.idx ?? armIdx;
    const at = twins[idx] ?? twins[0]!;
    setPick({
      epoch: snapEpoch,
      idx,
      cover: at.key === 'origin' ? 0 : (next.cover ?? cover),
    });
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
  const stepArm = (dir: number) => {
    const idx = armIdx + dir;
    if (idx < 0 || idx >= twins.length) return;
    commit({ idx, cover: heldCover(idx) });
  };

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
  const hedgeHit = result.constraint.hedgeHit;
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
                Book S {result.bookStanding.toFixed(1)} M · cash {fmtK(result.bookCashK / 1000)}
              </HeaderChip>
              <HeaderChip className="text-slate-400">
                {constraintDetail || 'No layer'}
              </HeaderChip>
              <HeaderChip className={
                selected.totalCarryUsdYrM >= 0 ? 'text-emerald-300' : 'text-rose-300'
              }>
                Return {fmtSignedK(selected.totalCarryUsdYrM)}
              </HeaderChip>
              <HeaderChip className="text-amber-300">
                CFaR {fmtAbsK(selected.finalCfarUsdM)}
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
          <button
            type="button"
            onClick={onClose}
            className="ml-auto shrink-0 rounded-md border border-slate-600 px-2.5 py-1.5 text-[10px] font-semibold text-slate-300 hover:bg-slate-800"
          >
            Esc
          </button>
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
            <div className="mb-2 flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
                Carry vs CFaR
              </span>
              <span className="font-mono text-[9px] text-slate-500">
                Y = mild log carry · X from $0 · section at {fmtK(result.cfarOriginUsdM)}
              </span>
              <span className="ml-auto flex flex-wrap gap-2.5">
                <Legend swatch="solid" border="border-emerald-400" label="open · cash" />
                <Legend swatch="solid" border="border-rose-400" label="far · cash + points" />
                <Legend swatch="dashed" border="border-slate-400" label="leveraged" />
                <Legend swatch="solid" border="border-yellow-400" label="Δ mix at S" />
                <Legend swatch="dot" border="border-sky-400" label="sweet spot" />
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
              maxCarryK={plotCapK}
              confidencePct={confidencePct}
            />
            <p className="mt-1.5 font-mono text-[9px] leading-snug text-slate-500">
              Solid arms are the live book · dashed arms are leveraged S past it. Yellow is the Δ curve at the picked S — RSS mix, not a straight chord.
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
              label="Walk the frontier"
              hint={arm === 'mix' ? 'same S · Δ held' : arm === 'far' ? 'far arm' : 'open arm'}
            >
              <button
                type="button"
                disabled={armIdx <= 0}
                onClick={() => stepArm(-1)}
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
                className="h-[22px] w-6 shrink-0 rounded border border-slate-700 bg-slate-900 font-mono text-[11px] font-semibold text-slate-300 hover:border-slate-500 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                ›
              </button>
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
              hint={`book ${fmtK(result.bookCashK / 1000)} · max ${fmtK(maxCarryK / 1000)}`}
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
  maxCarryK,
  confidencePct,
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
  maxCarryK: number;
  confidencePct: number;
}) {
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
  const capM = Number.isFinite(maxCarryK) && maxCarryK > 0 ? maxCarryK / 1000 : Infinity;
  const inCap = (p: LiquidityFrontierPoint) =>
    Math.abs(p.cashCarryUsdYrM) <= capM + 6e-4;
  const drawn = [origin, ...upper, ...lower, ...isoSlice].filter(
    p => Math.abs(p.peakBook) < 1e-6 || inCap(p),
  );
  const constraintCarry = zoomOut
    ? [
        constraint.hCarryUsdYrM ?? 0,
        constraint.openHit?.carryUsdYrM ?? 0,
        constraint.hedgeHit?.carryUsdYrM ?? 0,
      ]
    : [];
  const openCash = [
    0,
    ...open.filter(p => inCap(p) || Math.abs(p.peakBook) < 1e-6).map(p => p.cashCarryUsdYrM),
    ...(zoomOut ? [constraint.openHit?.carryUsdYrM ?? 0, constraint.hCarryUsdYrM ?? 0] : []),
  ].filter(v => Number.isFinite(v));
  const farCarry = [
    ...hedged.filter(p => inCap(p) || Math.abs(p.peakBook) < 1e-6).map(p => p.totalCarryUsdYrM),
    ...(zoomOut ? [constraint.hedgeHit?.carryUsdYrM ?? 0] : []),
  ].filter(v => Number.isFinite(v));
  const cfars = [
    ...drawn.map(p => p.finalCfarUsdM),
    cfarOriginUsdM,
    ...(zoomOut ? [
      constraint.vCfarUsdM ?? 0,
      constraint.openHit?.cfarUsdM ?? 0,
      constraint.hedgeHit?.cfarUsdM ?? 0,
    ] : []),
  ].filter(v => Number.isFinite(v) && v >= 0);
  const x0 = Math.max(0, cfarOriginUsdM);
  const cfarMax = Math.max(x0, ...cfars);
  const xMin = 0;
  const vCut = zoomOut ? (constraint.vCfarUsdM ?? 0) : 0;
  const xMax = Math.max(
    cfarMax * 1.16,
    x0 * 2.05,
    x0 + 0.04,
    vCut > 1e-9 ? vCut * 1.28 : 0,
  );
  const yMaxData = Math.max(0, ...openCash, 0.012);
  const yMinOpen = Math.min(0, ...openCash);
  const yMinFar = Math.min(0, ...farCarry);
  const { s: carryS, zPos, zNeg } = carryAxisFromArms(yMinOpen, yMaxData, yMinFar);
  const zDen = zPos - zNeg;
  const xDen = xMax - xMin;
  const x = (v: number) => padL + (xDen > 1e-12 ? ((v - xMin) / xDen) * plotW : 0);
  const y = (v: number) => padT + (1 - (carryFwd(v, carryS) - zNeg) / zDen) * plotH;
  const y0 = y(0);
  const yTickMin = carryS * Math.sinh(zNeg);
  const yTickMax = carryS * Math.sinh(zPos);
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
  const bookPt = openSolid[openSolid.length - 1] ?? null;
  const bookFar = hedgeSolid[hedgeSolid.length - 1] ?? null;
  const xTickRaw = cfarKTicks(xMin, xMax);
  if (!xTickRaw.some(v => Math.abs(v) < 1e-9)) xTickRaw.unshift(0);
  if (x0 > 0 && !xTickRaw.some(v => Math.abs(v * 1000 - x0 * 1000) < 0.51)) {
    xTickRaw.push(x0);
  }
  xTickRaw.sort((a, b) => a - b);
  const xTicks: number[] = [];
  for (const v of xTickRaw) {
    if (xTicks.every(u => Math.abs(x(u) - x(v)) >= 36)) xTicks.push(v);
  }
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
  const hoverKindLabel = hover == null ? ''
    : hover.kind === 'origin' ? 'origin'
    : hover.kind === 'mix' ? `mix Δ ${(1 - hover.p.delta).toFixed(2)}`
    : hover.kind;
  const hoverTip = hover
    ? `${hoverKindLabel} · S ${
        hover.kind === 'origin' ? '—' : `${hover.p.peakBook.toFixed(1)} M`
      } · carry ${fmtSignedK(hover.p.totalCarryUsdYrM)} · CFaR ${fmtAbsK(hover.p.finalCfarUsdM)} · E[return] ${fmtSignedK(weightedReturnUsdM(hover.p, confidencePct, cfarOriginUsdM))}`
    : null;

  return (
    <div className="relative">
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full overflow-hidden rounded-md border border-slate-800 bg-slate-950/50">
      <defs>
        <clipPath id="liq-frontier-clip">
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
          <text x={x(v)} y={H - padB + 15} textAnchor="middle" fontSize={8} fill="#cbd5e1">
            {fmtK(v)}
          </text>
        </g>
      ))}
      {yTicks.filter(v => Math.abs(v) > 1e-9).map(v => (
        <g key={`yt-${v}`}>
          <line x1={padL - 4} y1={y(v)} x2={padL} y2={y(v)} stroke="#64748b" />
          <text x={padL - 7} y={y(v) + 3} textAnchor="end" fontSize={8} fill="#cbd5e1">
            {fmtK(v)}
          </text>
        </g>
      ))}
      <line
        x1={x(x0)}
        y1={padT}
        x2={x(x0)}
        y2={H - padB}
        stroke="#334155"
        strokeWidth={1}
      />
      <line
        x1={padL}
        y1={y0}
        x2={W - padR}
        y2={y0}
        stroke="#94a3b8"
        strokeWidth={1.2}
      />
      <text x={x(x0) + 4} y={y0 - 6} fontSize={8} fill="#94a3b8">
        CFaR section {fmtK(x0)} · carry 0
      </text>
      <g clipPath="url(#liq-frontier-clip)">
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
          <text x={W - padR - 4} y={y(constraint.hCarryUsdYrM) - 4} textAnchor="end" fontSize={8} fill="#fbbf24">
            Target Carry {fmtSignedK(constraint.hCarryUsdYrM)}
          </text>
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
          <text x={x(constraint.vCfarUsdM) + 4} y={padT + 10} fontSize={8} fill="#38bdf8">
            Target VAR {fmtAbsK(constraint.vCfarUsdM)}
          </text>
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
          <text
            x={x(constraint.openHit.cfarUsdM) + 7}
            y={y(constraint.openHit.carryUsdYrM) - 6}
            fontSize={8}
            fill="#e2e8f0"
          >
            open S {constraint.openHit.standing.toFixed(1)} · {fmtK(constraint.openHit.carryUsdYrM)}
          </text>
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
          <text
            x={x(constraint.hedgeHit.cfarUsdM) + 7}
            y={y(constraint.hedgeHit.carryUsdYrM) + 12}
            fontSize={8}
            fill="#e2e8f0"
          >
            far S {constraint.hedgeHit.standing.toFixed(1)} · {fmtK(constraint.hedgeHit.carryUsdYrM)}
          </text>
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
      {hitCircle(origin, '#f8fafc', 5, 'origin', 'origin')}
      {selected && Math.abs(selected.peakBook) > 1e-6 && (
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
          <text
            x={x((bookFar ?? bookPt).finalCfarUsdM)}
            y={y((bookFar ?? bookPt).totalCarryUsdYrM) + 18}
            textAnchor="middle"
            fontSize={8}
            fill="#e2e8f0"
          >
            book S {bookStanding.toFixed(1)}
          </text>
        </g>
      )}
      {zoomOut && tip && !constraint.openHit && (
        <text x={x(tip.finalCfarUsdM) + 8} y={y(tip.totalCarryUsdYrM) - 6} fontSize={8} fill="#34d399">
          open S {tip.peakBook.toFixed(1)}
        </text>
      )}
      {zoomOut && tipLo && !constraint.hedgeHit && (
        <text x={x(tipLo.finalCfarUsdM) + 8} y={y(tipLo.totalCarryUsdYrM) + 12} fontSize={8} fill="#fb7185">
          far S {tipLo.peakBook.toFixed(1)}
        </text>
      )}
      </g>
    </svg>
      {hoverTip && (
        <div className="pointer-events-none absolute right-2 top-2 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-200">
          {hoverTip}
        </div>
      )}
    </div>
  );
}
