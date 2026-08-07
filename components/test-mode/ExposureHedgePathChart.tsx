'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { stripHedgeLegCarryUsdM } from '@/lib/fx-hedge';
import {
  fwdCarryFromSwapPointsUsdM,
  getActiveMarketRates,
  resolveForwardDepositRates,
  resolveOvernightCashRates,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import {
  HEDGE_PATH_BASIS_OPTIONS,
  buildExposurePathPoints,
  hedgeBasisNotionalLocalM,
  hedgeBreakevenMonths,
  overhedgeGapM,
  resolveChartMonthlyFlows,
  resolveBulletCashSettleMonths,
  resolveStripCashSettleMonths,
  type HedgePathBasisId,
  type StripCashDeliveryAt,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  buildStripHedgedVarProfile,
  equalVarLinearHedgeNotionalLocalM,
} from '@/lib/test-mode/hedge-var';
import {
  buildRollingHedgeEdges,
  stripForwardLegsFromEdges,
  needsRollingHedges,
  normalizeStripEndMonths,
  normalizeStripScheduleWeights,
  equalStripScheduleWeights,
  rampStripScheduleWeights,
  pinStripScheduleWeightAt,
  endMonthsFromScheduleWeights,
  scheduleWeightsFromEndMonths,
  notionalWeightsFromAmounts,
  applyStripHedgeShareWeights,
  packSelectedStripEdges,
  varSetupForPathHedgeRegime,
  type ForecastHedgeStructure,
  type RollingHedgeEdge,
  type StripForwardLeg,
  type StripScheduleWeightPreset,
} from '@/lib/test-mode/rolling-hedge';
import { horizonMonths, type VarSetup } from '@/lib/test-mode/var-setup';

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.9 1.01 1.55 1.01H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}

function snapCoverPct(v: number, min: number, max: number, step: number): number {
  const snapped = Math.round((v - min) / step) * step + min;
  return Math.min(max, Math.max(min, Math.round(snapped)));
}

/** Compact cover-% stepper (inline or inside Cover modal). */
function CoverOfTargetStepper({
  value,
  onChange,
  scaledLabel,
  disabled = false,
  className = 'w-[220px]',
}: {
  value: number;
  onChange: (v: number) => void;
  scaledLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [draft, setDraft] = useState<string | null>(null);
  const min = 0;
  const max = 100;
  const step = 5;
  const pct = ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100;

  const valueFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1e-6) return value;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snapCoverPct(min + t * (max - min), min, max, step);
  };

  const nudge = (dir: -1 | 1) => {
    if (disabled) return;
    onChange(snapCoverPct(value + dir * step, min, max, step));
  };

  const commitDraft = () => {
    if (draft == null) return;
    const n = Number(draft.replace(/%/g, '').trim());
    if (Number.isFinite(n)) {
      onChange(Math.min(max, Math.max(min, Math.round(n))));
    }
    setDraft(null);
  };

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    onChangeRef.current(valueFromClientX(e.clientX));
    const onMove = (ev: PointerEvent) => {
      onChangeRef.current(valueFromClientX(ev.clientX));
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const stepBtn =
    'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-950 text-[11px] font-semibold text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40';

  const majorTicks = [0, 25, 50, 75, 100] as const;

  return (
    <div
      className={`shrink-0 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1.5${
        disabled ? ' opacity-50' : ''
      } ${className}`}
      title="Scale hedge cover as % of the selected regime target"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
          Cover
        </span>
        <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
          {draft != null ? (
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              value={draft}
              disabled={disabled}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={e => {
                if (e.key === 'Enter') commitDraft();
                if (e.key === 'Escape') setDraft(null);
              }}
              className="w-10 rounded border border-emerald-600/50 bg-slate-950 px-1 py-0.5 text-right text-[11px] font-semibold text-emerald-100 outline-none"
              aria-label="Cover percent"
            />
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setDraft(String(value))}
              className="text-[11px] font-semibold text-slate-100 hover:text-emerald-100 disabled:cursor-not-allowed"
              title="Click to type %"
            >
              {value}%
            </button>
          )}
          <span
            className={`text-[10px] ${
              disabled ? 'text-slate-600' : 'text-slate-400'
            }`}
            title="Scaled cover notional"
          >
            → {scaledLabel}
          </span>
        </div>
      </div>

      <div className="flex h-6 items-center gap-1.5">
        <button
          type="button"
          className={stepBtn}
          disabled={disabled || value <= min}
          aria-label="Decrease cover"
          onClick={() => nudge(-1)}
        >
          −
        </button>

        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Cover percent of target hedge"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={`${value}% → ${scaledLabel}`}
          aria-disabled={disabled}
          onKeyDown={e => {
            if (disabled) return;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault();
              nudge(-1);
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault();
              nudge(1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              onChange(min);
            } else if (e.key === 'End') {
              e.preventDefault();
              onChange(max);
            }
          }}
          onPointerDown={beginDrag}
          className={`relative h-6 min-w-0 flex-1 select-none touch-none ${
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          }`}
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-slate-800 ring-1 ring-slate-700/80">
            <div
              className="h-full rounded-full bg-emerald-500/70"
              style={{ width: `${pct}%` }}
            />
          </div>
          {majorTicks.map(t => (
            <span
              key={t}
              className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-500"
              style={{ left: `${t}%` }}
            />
          ))}
          <span
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-300/80 bg-slate-950 shadow-md"
            style={{ left: `${pct}%` }}
          />
        </div>

        <button
          type="button"
          className={stepBtn}
          disabled={disabled || value >= max}
          aria-label="Increase cover"
          onClick={() => nudge(1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** Compact “i” control — click opens a short explanation popover. */
function InfoTip({
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
        onClick={() => setOpen(v => !v)}
        className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold leading-none ${
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
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-slate-600 bg-slate-900 p-2.5 text-[10px] leading-relaxed text-slate-300 shadow-xl"
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface ExposureHedgePathChartProps {
  ccy: string;
  stockM: number;
  monthlyFlowM: number;
  monthlyFlows?: readonly number[];
  setup: VarSetup;
  /** Applied Decision hedge notional (local M). */
  appliedHedgeLocalM: number;
  hedgeRatio: number;
  equalVarHedgeLocalM: number;
  /** Table Exposure @ Δ1 (may be stock-only) — chart uses path end for E_end. */
  endExposureM: number;
  selectedBasis: HedgePathBasisId;
  onSelectedBasisChange: (b: HedgePathBasisId) => void;
  /**
   * Apply Cash / VN / Target. Pass the chart's structure so strip booking does
   * not race parent's hedgeStructure state (stale 'bullet' → Cash % only).
   */
  onApplyBasis: (
    b: HedgePathBasisId,
    structure?: ForecastHedgeStructure,
  ) => void;
  /**
   * Wire the chosen regime + structure into Hedging Decision.
   * Strip → rolling tickets; bullet → Decision % (no strip).
   */
  onBookHedgeProfile?: (args: {
    structure: ForecastHedgeStructure;
    basis: HedgePathBasisId;
    edges: RollingHedgeEdge[];
    /** Economic cash settle months from M0, keyed by edge index. */
    cashSettleByEdgeIndex?: Record<number, number>;
    /** Bullet: settle tenure in months from cash-delivery mode. */
    bulletSettleMonths?: number;
    cashDeliveryAt?: StripCashDeliveryAt;
    /** Fraction of regime target cover (0–1). Strip edges are already scaled. */
    coverPct?: number;
  }) => void;
  /** @deprecated use onBookHedgeProfile */
  onBookRollingStrip?: (edges: RollingHedgeEdge[]) => void;
  /** Disable strip book when a strip for this CCY is already on the book. */
  stripAlreadyBooked?: boolean;
  /** bullet = one Tf forward; strip = rolling Th windows (enabled when Tf &gt; Th). */
  hedgeStructure?: ForecastHedgeStructure;
  onHedgeStructureChange?: (s: ForecastHedgeStructure) => void;
  /** Controlled strip leg count (null = default ceil(Tf/Th)). */
  stripLegCount?: number | null;
  onStripLegCountChange?: (n: number | null) => void;
  /**
   * When true, restage via onBookHedgeProfile whenever the active ladder
   * changes (leg ticks, structure, basis, settle mode) — used by Cash Carry
   * so Prepare is not required for analytics to update.
   */
  autoStagePrepared?: boolean;
  /** Where to render the cover / legs / resid VaR / breakeven cards. */
  summaryMetricsPlacement?: 'inline' | 'none';
  /** Live snapshot of the summary cards (for hosting outside this chart). */
  onSummaryMetricsChange?: (m: HedgePathSummaryMetrics | null) => void;
  /**
   * Where Prepare CTA renders. `external` hides in-chart buttons and reports
   * via onPrepareActionChange (sticky modal header on VaR / Decision path).
   */
  prepareCtaPlacement?: 'footer' | 'external' | 'both';
  /** Live Prepare action for an external sticky header. */
  onPrepareActionChange?: (action: HedgePathPrepareAction | null) => void;
  /**
   * Performance · tick-trades table placement.
   * `external` portals into `performancePanelHost` (Cash Carry modal top).
   */
  performancePanelPlacement?: 'inline' | 'external';
  performancePanelHost?: HTMLElement | null;
  /**
   * Strip schedule editor placement. `external` portals into
   * `schedulePanelHost` (Cash Carry Optimal strip · Preview legs slot) and
   * keeps Performance as tick-trades only.
   */
  schedulePanelPlacement?: 'inline' | 'external';
  schedulePanelHost?: HTMLElement | null;
  /**
   * Controlled strip settle months (Cash Carry Settle-WAM → schedule table).
   * When set, gear Schedule setup switches to custom dates matching this ladder.
   */
  scheduleEndMonths?: readonly number[] | null;
  onScheduleEndMonthsChange?: (months: number[] | null) => void;
  /**
   * Controlled Hedge-% notional shares (sum→1), e.g. shape-search optimizer
   * weights. Applied with scheduleEndMonths so Δ matches optimal strip.
   */
  scheduleHedgeWeights?: readonly number[] | null;
  /** Persist Hedge % edits when schedule is parent-controlled (Cash Carry). */
  onScheduleHedgeWeightsChange?: (weights: number[] | null) => void;
}

/** Read-only strip / bullet summary cards (cover, legs, resid VaR, breakeven). */
export type HedgePathSummaryMetrics = {
  coverTitle: string;
  coverValue: string;
  coverPct: string | null;
  coverSub: string;
  legsTitle: string;
  legsValue: string;
  legsSub: string;
  residVarValue: string;
  residVarPct: string | null;
  residVarSub: string;
  breakevenValue: string;
  breakevenSub: string | null;
};

/** One row in the exposure-profile chart's forward-ladder lane (zone C). */
type ForwardLadderRow = {
  key: string;
  label: string;
  settleT: number;
  deltaLocalM: number;
  cumulLocalM: number | null;
  pctOfCover: number | null;
  ticked: boolean;
};

/**
 * Primary series strokes — screen pixels via `vectorEffect: non-scaling-stroke`
 * so weight stays bold at any modal width (viewBox is design 1136).
 * Matches Exposure Profile Chart.dc.html, nudged +0.25–0.5 for desk readability.
 */
const EXP_PROFILE_STROKE = {
  exposure: 2.75,
  cover: 2,
  cashLadder: 2.5,
  cashStepDot: 2,
  netExposure: 3.25,
  netCash: 2.75,
  netStepDot: 2,
  wedgeEdge: 1,
  expEndpoint: 5,
  netEndpoint: 4.5,
  tfRule: 1.5,
  settleGuide: 1,
} as const;

/** Design-handoff plot width (Exposure Profile Chart.dc.html viewBox). */
const EXP_PROFILE_W = 1136;

const EMPTY_LADDER_EDGES: RollingHedgeEdge[] = [];

/** Prepare CTA snapshot for sticky headers outside the chart scroll body. */
export type HedgePathPrepareAction = {
  label: string;
  title: string;
  disabled: boolean;
  run: () => void;
};

function fmtM(v: number): string {
  const sign = v >= 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(2)}M`;
}

/** Average days per month — maps Sched % × Tf → calendar settle from today. */
const DAYS_PER_MONTH = 365.25 / 12;

function startOfLocalDay(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

/** Settle calendar date = today + (months from M0) × days/month. */
function settleDateFromMonths(monthsFromM0: number, from = new Date()): Date {
  const base = startOfLocalDay(from);
  const days = Math.max(0, monthsFromM0) * DAYS_PER_MONTH;
  return new Date(base.getTime() + days * 86_400_000);
}

function monthsFromSettleDate(isoDate: string, from = new Date()): number {
  const parts = isoDate.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const day = parts[2];
  if (
    y == null ||
    m == null ||
    day == null ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(day)
  ) {
    return 0;
  }
  const target = new Date(y, m - 1, day, 12, 0, 0, 0);
  const base = startOfLocalDay(from);
  const days = (target.getTime() - base.getTime()) / 86_400_000;
  return Math.max(0.01, days / DAYS_PER_MONTH);
}

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtMonths(t: number): string {
  if (t + 1e-9 < 1) return `${Math.max(0, t * 4).toFixed(1)}w`;
  return `${t.toFixed(2)}m`;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

/** Signed USD carry in $K (from $M). */
function fmtCarryK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.5) return '$0K';
  const sign = k >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(k).toFixed(0)}K`;
}

function fmtPct(pct: number): string {
  if (!Number.isFinite(pct)) return '—';
  const abs = Math.abs(pct);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 0 : 1;
  return `${pct.toFixed(digits)}%`;
}

function fmtPathN(n: number): string {
  return n.toFixed(2);
}

/**
 * Contiguous fill polygons for the region where a series dips below a flat
 * `zeroY` boundary (pixel space) — used for both the net-exposure over-hedge
 * wedge and the net-cash negative bands. Linear-interpolates the exact
 * crossing so each polygon closes precisely at the zero line.
 */
function buildZeroBandPolys(
  pts: readonly { x: number; y: number }[],
  zeroY: number,
): string[] {
  const below = (p: { y: number }) => p.y > zeroY + 1e-6;
  const crossing = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => {
    if (Math.abs(b.y - a.y) < 1e-9) return null;
    const w = (zeroY - a.y) / (b.y - a.y);
    if (w <= 0 || w >= 1) return null;
    return { x: a.x + w * (b.x - a.x), y: zeroY };
  };
  const runs: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (below(p)) {
      if (current.length === 0 && i > 0 && !below(pts[i - 1]!)) {
        const c = crossing(pts[i - 1]!, p);
        if (c) current.push(c);
      }
      current.push(p);
    } else if (current.length > 0) {
      const c = crossing(pts[i - 1]!, p);
      if (c) current.push(c);
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs
    .filter(r => r.length > 0)
    .map(r => {
      const first = r[0]!;
      const last = r[r.length - 1]!;
      return [{ x: first.x, y: zeroY }, ...r, { x: last.x, y: zeroY }]
        .map(p => `${p.x},${p.y}`)
        .join(' ');
    });
}

/** Linear interpolate open / resid VaR on a profile at time t. */
function interpolateVarProfileAt(
  profile: readonly {
    t: number;
    openVarUsdM: number;
    hedgedVarUsdM: number;
  }[],
  t: number,
): { t: number; openVarUsdM: number; hedgedVarUsdM: number } {
  if (profile.length === 0) {
    return { t, openVarUsdM: 0, hedgedVarUsdM: 0 };
  }
  if (t <= profile[0]!.t) {
    return {
      t,
      openVarUsdM: profile[0]!.openVarUsdM,
      hedgedVarUsdM: profile[0]!.hedgedVarUsdM,
    };
  }
  const last = profile[profile.length - 1]!;
  if (t >= last.t) {
    return {
      t,
      openVarUsdM: last.openVarUsdM,
      hedgedVarUsdM: last.hedgedVarUsdM,
    };
  }
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i]!;
    const b = profile[i + 1]!;
    if (t + 1e-12 >= a.t && t <= b.t + 1e-12) {
      const span = b.t - a.t;
      const u = span <= 1e-12 ? 1 : (t - a.t) / span;
      return {
        t,
        openVarUsdM: a.openVarUsdM + u * (b.openVarUsdM - a.openVarUsdM),
        hedgedVarUsdM:
          a.hedgedVarUsdM + u * (b.hedgedVarUsdM - a.hedgedVarUsdM),
      };
    }
  }
  return {
    t,
    openVarUsdM: last.openVarUsdM,
    hedgedVarUsdM: last.hedgedVarUsdM,
  };
}

/**
 * Profile samples plus exact knots (forward maturities, BE) so the resid
 * stroke and dots share the same (t, resid) points.
 */
function mergeVarProfileKnots(
  profile: readonly {
    t: number;
    openVarUsdM: number;
    hedgedVarUsdM: number;
  }[],
  knotMonths: readonly number[],
): { t: number; openVarUsdM: number; hedgedVarUsdM: number }[] {
  if (profile.length === 0) return [];
  const endT = profile[profile.length - 1]!.t;
  const byT = new Map<number, { t: number; openVarUsdM: number; hedgedVarUsdM: number }>();
  const key = (t: number) => Math.round(t * 1e6) / 1e6;
  for (const p of profile) {
    byT.set(key(p.t), {
      t: p.t,
      openVarUsdM: p.openVarUsdM,
      hedgedVarUsdM: Math.min(p.hedgedVarUsdM, p.openVarUsdM),
    });
  }
  for (const raw of knotMonths) {
    if (!Number.isFinite(raw)) continue;
    const t = Math.max(0, Math.min(endT, raw));
    const hit = interpolateVarProfileAt(profile, t);
    byT.set(key(t), {
      t,
      openVarUsdM: hit.openVarUsdM,
      hedgedVarUsdM: Math.min(hit.hedgedVarUsdM, hit.openVarUsdM),
    });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * Centripetal Catmull–Rom (α = 0.5) → cubic Bézier SVG path.
 * Sparse anchors + centripetal parameterization → visible curves between dots
 * (uniform CR on dense near-colinear samples reads as a polyline).
 */
function smoothSplinePath(
  pts: readonly { x: number; y: number }[],
  tension = 1,
): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) {
    return `M${fmtPathN(pts[0]!.x)},${fmtPathN(pts[0]!.y)}`;
  }
  if (pts.length === 2) {
    // No invented mid bulge — that drew Cash resid above open VaR.
    return `M${fmtPathN(pts[0]!.x)},${fmtPathN(pts[0]!.y)} L${fmtPathN(pts[1]!.x)},${fmtPathN(pts[1]!.y)}`;
  }

  const alpha = 0.5;
  const dist = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  let d = `M${fmtPathN(pts[0]!.x)},${fmtPathN(pts[0]!.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1]!;

    const d01 = Math.max(1e-6, dist(p0, p1));
    const d12 = Math.max(1e-6, dist(p1, p2));
    const d23 = Math.max(1e-6, dist(p2, p3));
    const t01 = Math.pow(d01, alpha);
    const t12 = Math.pow(d12, alpha);
    const t23 = Math.pow(d23, alpha);

    // Tangents (centripetal CR) → cubic Bézier control points.
    const m1x =
      (p1.x - p0.x) / t01 -
      (p2.x - p0.x) / (t01 + t12) +
      (p2.x - p1.x) / t12;
    const m1y =
      (p1.y - p0.y) / t01 -
      (p2.y - p0.y) / (t01 + t12) +
      (p2.y - p1.y) / t12;
    const m2x =
      (p2.x - p1.x) / t12 -
      (p3.x - p1.x) / (t12 + t23) +
      (p3.x - p2.x) / t23;
    const m2y =
      (p2.y - p1.y) / t12 -
      (p3.y - p1.y) / (t12 + t23) +
      (p3.y - p2.y) / t23;

    const c1x = p1.x + ((m1x * t12) / 3) * tension;
    const c1y = p1.y + ((m1y * t12) / 3) * tension;
    const c2x = p2.x - ((m2x * t12) / 3) * tension;
    const c2y = p2.y - ((m2y * t12) / 3) * tension;
    d += ` C${fmtPathN(c1x)},${fmtPathN(c1y)} ${fmtPathN(c2x)},${fmtPathN(c2y)} ${fmtPathN(p2.x)},${fmtPathN(p2.y)}`;
  }
  return d;
}

/**
 * Exposure growth path vs flat applied hedge — month grid, start/end labels,
 * over/under zones + breakeven.
 */
export function ExposureHedgePathChart({
  ccy,
  stockM,
  monthlyFlowM,
  monthlyFlows,
  setup,
  appliedHedgeLocalM,
  hedgeRatio,
  equalVarHedgeLocalM,
  selectedBasis,
  onSelectedBasisChange,
  onApplyBasis,
  onBookHedgeProfile,
  onBookRollingStrip,
  stripAlreadyBooked = false,
  hedgeStructure: hedgeStructureProp,
  onHedgeStructureChange,
  stripLegCount: stripLegCountProp,
  onStripLegCountChange,
  autoStagePrepared = false,
  summaryMetricsPlacement = 'inline',
  onSummaryMetricsChange,
  prepareCtaPlacement = 'footer',
  onPrepareActionChange,
  performancePanelPlacement = 'inline',
  performancePanelHost = null,
  schedulePanelPlacement = 'inline',
  schedulePanelHost = null,
  scheduleEndMonths: scheduleEndMonthsProp,
  onScheduleEndMonthsChange,
  scheduleHedgeWeights: scheduleHedgeWeightsProp,
  onScheduleHedgeWeightsChange,
}: ExposureHedgePathChartProps) {
  const schedulePanelExternal = schedulePanelPlacement === 'external';
  const [localStructure, setLocalStructure] =
    useState<ForecastHedgeStructure>('bullet');
  /** Manual strip leg count (min 2 when strip). null = default ceil(Tf/Th). */
  const [localStripLegCount, setLocalStripLegCount] = useState<number | null>(
    null,
  );
  const stripLegControlled = stripLegCountProp !== undefined;
  const stripLegCount = stripLegControlled
    ? stripLegCountProp
    : localStripLegCount;
  const setStripLegCount = (
    n: number | null,
    opts?: { /** Do not echo to parent (prop → local sync). */ silent?: boolean },
  ) => {
    if (!stripLegControlled) setLocalStripLegCount(n);
    if (!opts?.silent) onStripLegCountChange?.(n);
  };
  /** Which forward legs contribute to the resid VaR profile (checkbox). */
  const [enabledLegIds, setEnabledLegIds] = useState<Record<number, boolean>>(
    {},
  );
  /** Gear panel: equal spacing vs custom maturity dates. */
  const [stripScheduleOpen, setStripScheduleOpen] = useState(false);
  /** Custom cover % modal (gear next to Target regime chip). */
  const [coverModalOpen, setCoverModalOpen] = useState(false);
  useEffect(() => {
    if (!coverModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCoverModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [coverModalOpen]);
  /**
   * Cash Carry external schedule host: collapsed review (ticks) vs full
   * settle / Sched % / Hedge % editing.
   */
  const [scheduleExternalEditing, setScheduleExternalEditing] = useState(false);
  const [stripScheduleMode, setStripScheduleMode] = useState<
    'equal' | 'custom'
  >('equal');
  /** Custom settle months in (0, Tf]; null until user opens Custom. */
  const [customEndMonths, setCustomEndMonths] = useState<number[] | null>(
    null,
  );
  const scheduleEndsSig = (scheduleEndMonthsProp ?? [])
    .map(m => m.toFixed(4))
    .join(',');
  const lastScheduleEndsSigRef = useRef('');
  /** Push custom schedule out (Cash Carry keeps Settle-WAM ↔ gear in sync). */
  const commitCustomEnds = (ends: number[] | null) => {
    setCustomEndMonths(ends);
    lastScheduleEndsSigRef.current = (ends ?? [])
      .map(m => m.toFixed(4))
      .join(',');
    onScheduleEndMonthsChange?.(ends);
  };
  /**
   * Window-duration weights (sum→1). Drive Custom settles; Equal uses
   * equalStripScheduleWeights(n). Front/Back use rampStripScheduleWeights(n).
   */
  const [scheduleWeights, setScheduleWeights] = useState<number[] | null>(null);
  const [weightPreset, setWeightPreset] = useState<
    StripScheduleWeightPreset | 'equal' | 'custom'
  >('equal');
  /** Cash settlement for carry / Prepare: window end / start / e∩H match. */
  const [stripCashDeliveryAt, setStripCashDeliveryAt] =
    useState<StripCashDeliveryAt>('periodEnd');
  /** Local draft while typing Sched % (avoids renormalize fighting keystrokes). */
  const [schedPctDraft, setSchedPctDraft] = useState<{
    index: number;
    value: string;
  } | null>(null);
  /**
   * Optional hedge notional shares (sum→1). null = regime-sized Δ mix.
   * Edit “Hedge %” to skew cover front/back independently of Sched %.
   */
  const [hedgeShareWeights, setHedgeShareWeights] = useState<number[] | null>(
    null,
  );
  const [hedgeShareDraft, setHedgeShareDraft] = useState<{
    index: number;
    value: string;
  } | null>(null);
  /**
   * Cover as % of the selected regime target (Cash / VN / Target), 0–100.
   * Scales strip Δ and bullet notional before Prepare / auto-stage.
   */
  const [targetCoverPct, setTargetCoverPct] = useState(100);
  /** EURUSD deposit credit/debit curves (seed or uploaded FXOCalculator xlsx). */
  const [marketRates, setMarketRates] = useState<FxMarketRatesBundle>(() =>
    getActiveMarketRates(),
  );
  useEffect(() => {
    setMarketRates(getActiveMarketRates());
  }, []);
  const controlled = hedgeStructureProp != null;
  const hedgeStructure = controlled ? hedgeStructureProp : localStructure;
  useEffect(() => {
    if (controlled) setLocalStructure(hedgeStructureProp);
  }, [controlled, hedgeStructureProp]);
  const setStructure = (s: ForecastHedgeStructure) => {
    if (!controlled) setLocalStructure(s);
    onHedgeStructureChange?.(s);
    // Wire Cash/VN/Target into Live VaR under the new structure immediately.
    onApplyBasis(selectedBasis, s);
  };
  const Th = horizonMonths(setup.horizon);
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  /**
   * Cash Carry (external performance panel): strip whenever Tf ≥ 2.
   * FX Risk: strip only when VaR tenor &lt; forecast (rolling windows).
   */
  const rollingAvailable =
    performancePanelPlacement === 'external'
      ? Tf >= 2
      : needsRollingHedges(setup);
  /** Structure + regime live in the gear panel (Cash Carry modal top). */
  const pathControlsInGear = performancePanelPlacement === 'external';
  const showStructurePicker = Tf > 0;
  const effectiveStructure: ForecastHedgeStructure =
    hedgeStructure === 'strip' && rollingAvailable ? 'strip' : 'bullet';
  useEffect(() => {
    if (!rollingAvailable && hedgeStructure === 'strip') {
      if (!controlled) setLocalStructure('bullet');
      onHedgeStructureChange?.('bullet');
    }
  }, [
    rollingAvailable,
    hedgeStructure,
    controlled,
    onHedgeStructureChange,
  ]);
  const rolling = effectiveStructure === 'strip';
  /** When switching strip → bullet, drop Target default so residual P&L uses VN. */
  const prevStructureRef = useRef(effectiveStructure);
  useEffect(() => {
    const prev = prevStructureRef.current;
    prevStructureRef.current = effectiveStructure;
    if (prev === 'strip' && effectiveStructure === 'bullet') {
      onSelectedBasisChange('varNeutral');
    }
  }, [effectiveStructure, onSelectedBasisChange]);
  /** Bullet Th=Tf; stock profile → path totalBuildup so VN ≠ Cash. */
  const sizingSetup = useMemo(
    () => varSetupForPathHedgeRegime(setup, effectiveStructure),
    [setup, effectiveStructure],
  );

  const { flows, windowMonths, startM, endM: pathEndM } = useMemo(
    () => resolveChartMonthlyFlows(stockM, monthlyFlowM, setup, monthlyFlows),
    [stockM, monthlyFlowM, setup, monthlyFlows],
  );

  const path = useMemo(
    () => buildExposurePathPoints(startM, flows, windowMonths),
    [startM, flows, windowMonths],
  );

  /**
   * Path-VaR CoG H for bullet chips / Decision %. Strip: per-window CoG
   * (leg count matters) — chip label shows last-edge cover when strip.
   */
  const matchedEqualVarLocalM = useMemo(() => {
    const local = equalVarLinearHedgeNotionalLocalM(
      stockM,
      monthlyFlowM,
      ccy,
      sizingSetup,
      undefined,
      flows,
    ).amountLocalM;
    if (Math.abs(local) > 1e-12) return local;
    return equalVarHedgeLocalM;
  }, [
    equalVarHedgeLocalM,
    stockM,
    monthlyFlowM,
    ccy,
    sizingSetup,
    flows,
  ]);

  const coverScale = Math.min(1, Math.max(0, targetCoverPct / 100));

  /** Full (100%) regime target before custom cover %. */
  const regimeTargetLocalM = useMemo(
    () =>
      hedgeBasisNotionalLocalM(
        selectedBasis,
        startM,
        pathEndM,
        matchedEqualVarLocalM,
      ),
    [selectedBasis, startM, pathEndM, matchedEqualVarLocalM],
  );

  /** Bullet cover under the selected regime × cover %. */
  const bulletCoverLocalM = regimeTargetLocalM * coverScale;

  // Restore cover % from prepared package when CCY changes (or ratio
  // meaningfully drifts). Never setState when the rounded % is unchanged —
  // coverScale → ladder → autoStage → hedgeRatio would otherwise loop.
  const coverSyncCcyRef = useRef<string | null>(null);
  useEffect(() => {
    const ccyChanged = coverSyncCcyRef.current !== ccy;
    coverSyncCcyRef.current = ccy;
    if (hedgeRatio > 1e-9 && hedgeRatio <= 1 + 1e-9) {
      const next = Math.min(100, Math.max(0, Math.round(hedgeRatio * 100)));
      setTargetCoverPct(prev => (prev === next ? prev : next));
      return;
    }
    if (ccyChanged) setTargetCoverPct(100);
  }, [ccy, hedgeRatio]);

  /** Bullet cash settle from M0 under Period end / start / e∩H. */
  const bulletSettleMonths = useMemo(
    () =>
      resolveBulletCashSettleMonths(
        bulletCoverLocalM,
        path,
        stripCashDeliveryAt,
        Tf,
      ),
    [bulletCoverLocalM, path, stripCashDeliveryAt, Tf],
  );

  const bookProfile =
    onBookHedgeProfile || onBookRollingStrip
      ? (structure: ForecastHedgeStructure, edges: RollingHedgeEdge[]) => {
          if (onBookHedgeProfile) {
            const cashSettleByEdgeIndex: Record<number, number> = {};
            if (structure === 'strip') {
              for (const e of edges) {
                cashSettleByEdgeIndex[e.index] = resolveStripCashSettleMonths(
                  e,
                  path,
                  stripCashDeliveryAt,
                  windowMonths,
                );
              }
            }
            onBookHedgeProfile({
              structure,
              basis: selectedBasis,
              edges,
              cashSettleByEdgeIndex:
                structure === 'strip' ? cashSettleByEdgeIndex : undefined,
              bulletSettleMonths:
                structure === 'bullet' ? bulletSettleMonths : undefined,
              cashDeliveryAt: stripCashDeliveryAt,
              coverPct: coverScale,
            });
            return;
          }
          if (structure === 'strip') onBookRollingStrip?.(edges);
        }
      : undefined;

  const defaultStripLegs = useMemo(() => {
    if (!(Tf > 0) || !(Th > 0)) return 2;
    return Math.max(2, Math.ceil(Tf / Th - 1e-12));
  }, [Tf, Th]);
  const maxStripLegs = useMemo(
    () => Math.max(2, Math.min(24, Math.ceil(Tf) || 2)),
    [Tf],
  );
  const effectiveStripLegs = Math.min(
    maxStripLegs,
    Math.max(2, stripLegCount ?? defaultStripLegs),
  );
  const equalEndMonths = useMemo(() => {
    if (!(Tf > 0) || effectiveStripLegs < 1) return [] as number[];
    return Array.from({ length: effectiveStripLegs }, (_, k) =>
      Math.round(((k + 1) * Tf) / effectiveStripLegs),
    ).map((m, i, arr) => (i === arr.length - 1 ? Tf : Math.max(1, m)));
  }, [Tf, effectiveStripLegs]);
  const activeEndMonths = useMemo(() => {
    if (stripScheduleMode === 'custom' && customEndMonths != null) {
      // Preserve custom final settle — do not re-lock last row to Tf.
      return normalizeStripEndMonths(customEndMonths, Tf, {
        forceThroughTf: false,
      });
    }
    return equalEndMonths;
  }, [stripScheduleMode, customEndMonths, Tf, equalEndMonths]);

  const scheduleHedgeWeightsSig = (scheduleHedgeWeightsProp ?? [])
    .map(w => w.toFixed(6))
    .join(',');
  const lastScheduleHedgeWeightsSigRef = useRef('');

  const commitHedgeShares = (weights: number[] | null) => {
    setHedgeShareWeights(weights);
    lastScheduleHedgeWeightsSigRef.current = (weights ?? [])
      .map(w => w.toFixed(6))
      .join(',');
    onScheduleHedgeWeightsChange?.(weights);
    // Optimal-strip scoring pairs customWeights with customSettleMonths.
    // If the parent never received settle ends (pre-Apply local custom),
    // push them so Hedge % edits actually re-score Enhancement.
    if (
      weights != null &&
      weights.length >= 2 &&
      (scheduleEndMonthsProp == null || scheduleEndMonthsProp.length === 0) &&
      stripScheduleMode === 'custom' &&
      customEndMonths != null &&
      customEndMonths.length === weights.length
    ) {
      onScheduleEndMonthsChange?.([...customEndMonths]);
    }
  };

  // Parent schedule ends ↔ gear Custom dates. Clearing the prop exits custom
  // so Strip legs −/+ can drive equal spacing again (shape fine-tune).
  useEffect(() => {
    if (scheduleEndMonthsProp == null || scheduleEndMonthsProp.length === 0) {
      if (lastScheduleEndsSigRef.current === '') return;
      lastScheduleEndsSigRef.current = '';
      lastScheduleHedgeWeightsSigRef.current = '';
      setCustomEndMonths(null);
      setScheduleWeights(null);
      setHedgeShareWeights(null);
      setStripScheduleMode('equal');
      setWeightPreset(prev => (prev === 'custom' ? 'equal' : prev));
      return;
    }
    const endsChanged = scheduleEndsSig !== lastScheduleEndsSigRef.current;
    const weightsChanged =
      scheduleHedgeWeightsSig !== lastScheduleHedgeWeightsSigRef.current;
    if (!endsChanged && !weightsChanged) return;
    const norm = normalizeStripEndMonths([...scheduleEndMonthsProp], Tf, {
      forceThroughTf: false,
    });
    if (norm.length < 1) return;

    const endsAlready =
      stripScheduleMode === 'custom' &&
      customEndMonths != null &&
      customEndMonths.length === norm.length &&
      customEndMonths.every((m, i) => Math.abs(m - norm[i]!) < 1e-6);
    const nextHedgeShares =
      scheduleHedgeWeightsProp != null &&
      scheduleHedgeWeightsProp.length === norm.length
        ? normalizeStripScheduleWeights([...scheduleHedgeWeightsProp])
        : null;
    const weightsAlready =
      nextHedgeShares == null
        ? hedgeShareWeights == null
        : hedgeShareWeights != null &&
          hedgeShareWeights.length === nextHedgeShares.length &&
          hedgeShareWeights.every(
            (w, i) => Math.abs(w - nextHedgeShares[i]!) < 1e-6,
          );

    // Parent auto-stage often echoes the same ladder with a new array
    // identity — skip setState or we loop with Maximum update depth.
    lastScheduleEndsSigRef.current = scheduleEndsSig;
    lastScheduleHedgeWeightsSigRef.current = scheduleHedgeWeightsSig;
    if (endsAlready && weightsAlready) return;

    if (!endsAlready) {
      setCustomEndMonths(norm);
      setScheduleWeights(scheduleWeightsFromEndMonths(norm, Tf));
      setStripScheduleMode('custom');
      setWeightPreset('custom');
      // Silent — parent already owns schedule ends; echoing legs cleared them.
      setStripLegCount(Math.max(2, norm.length), { silent: true });
    }
    if (!weightsAlready && nextHedgeShares != null) {
      setHedgeShareWeights(nextHedgeShares);
    }
    setStripScheduleOpen(true);
  }, [
    scheduleEndsSig,
    scheduleEndMonthsProp,
    scheduleHedgeWeightsSig,
    scheduleHedgeWeightsProp,
    Tf,
    stripScheduleMode,
    customEndMonths,
    hedgeShareWeights,
  ]);

  /**
   * Parent Apply often sets scheduleEndMonths before local custom mode
   * commits (effect). Use the prop synchronously so edges / auto-stage
   * never stage an equal M1/M4/M7 ladder over the applied M3/M5/M7.
   */
  const parentScheduleEnds = useMemo(() => {
    if (scheduleEndMonthsProp == null || scheduleEndMonthsProp.length === 0) {
      return null;
    }
    const norm = normalizeStripEndMonths([...scheduleEndMonthsProp], Tf, {
      forceThroughTf: false,
    });
    return norm.length > 0 ? norm : null;
  }, [scheduleEndMonthsProp, Tf]);

  const parentHedgeShares = useMemo(() => {
    if (
      parentScheduleEnds == null ||
      scheduleHedgeWeightsProp == null ||
      scheduleHedgeWeightsProp.length !== parentScheduleEnds.length
    ) {
      return null;
    }
    return normalizeStripScheduleWeights([...scheduleHedgeWeightsProp]);
  }, [parentScheduleEnds, scheduleHedgeWeightsProp]);

  const stripEdgeOpts = useMemo(() => {
    if (!rolling) return undefined;
    if (parentScheduleEnds != null) {
      return { endMonths: parentScheduleEnds, ccy, varSetup: setup };
    }
    if (stripScheduleMode === 'custom' && activeEndMonths.length > 0) {
      return { endMonths: activeEndMonths, ccy, varSetup: setup };
    }
    return { legCount: effectiveStripLegs, ccy, varSetup: setup };
  }, [
    rolling,
    parentScheduleEnds,
    stripScheduleMode,
    activeEndMonths,
    effectiveStripLegs,
    ccy,
    setup,
  ]);

  const rollingEdgesCash = useMemo(
    () =>
      rolling
        ? buildRollingHedgeEdges(startM, flows, setup, 'stockStart', stripEdgeOpts)
        : [],
    [rolling, startM, flows, setup, stripEdgeOpts],
  );
  const rollingEdgesVarNeutral = useMemo(
    () =>
      rolling
        ? buildRollingHedgeEdges(
            startM,
            flows,
            setup,
            'varNeutral',
            stripEdgeOpts,
          )
        : [],
    [rolling, startM, flows, setup, stripEdgeOpts],
  );
  const rollingEdgesTotal = useMemo(
    () =>
      rolling
        ? buildRollingHedgeEdges(startM, flows, setup, 'windowEnd', stripEdgeOpts)
        : [],
    [rolling, startM, flows, setup, stripEdgeOpts],
  );
  const rollingEdges =
    selectedBasis === 'cash'
      ? rollingEdgesCash
      : selectedBasis === 'totalExpected'
        ? rollingEdgesTotal
        : rollingEdgesVarNeutral;

  const showRollingStrip =
    rolling &&
    rollingEdges.length > 1 &&
    (selectedBasis === 'cash' ||
      selectedBasis === 'totalExpected' ||
      selectedBasis === 'varNeutral');

  /**
   * Regime-sized forwards (before optional Hedge % redistribute):
   * - Strip → incremental M0 legs (all live from day 0)
   * - Bullet → one M0–Tf forward (same instantaneous cover model)
   */
  const naturalHedgeLegs = useMemo((): StripForwardLeg[] => {
    const scale = coverScale;
    if (showRollingStrip) {
      const legs = stripForwardLegsFromEdges(rollingEdges);
      if (Math.abs(scale - 1) < 1e-12) return legs;
      return legs.map(l => ({
        ...l,
        amountLocalM: l.amountLocalM * scale,
        cumulCoverLocalM: l.cumulCoverLocalM * scale,
      }));
    }
    if (!(Tf > 0)) return [];
    const amount =
      hedgeBasisNotionalLocalM(
        selectedBasis,
        startM,
        pathEndM,
        matchedEqualVarLocalM,
      ) * scale;
    if (Math.abs(amount) < 1e-12) return [];
    return [
      {
        index: 0,
        label: `M0–M${Math.round(Tf)}`,
        tenureMonths: Tf,
        amountLocalM: amount,
        cumulCoverLocalM: amount,
        endExposureM: pathEndM,
        stockStartM: startM,
      },
    ];
  }, [
    showRollingStrip,
    rollingEdges,
    Tf,
    selectedBasis,
    startM,
    pathEndM,
    matchedEqualVarLocalM,
    coverScale,
  ]);

  /** Drop custom Hedge % when leg count / regime ladder shape changes. */
  useEffect(() => {
    setHedgeShareWeights(prev => {
      if (prev == null) return null;
      if (prev.length === naturalHedgeLegs.length) return prev;
      return null;
    });
  }, [naturalHedgeLegs.length, selectedBasis]);

  /** Local gear shares, else parent Apply weights before sync effect runs. */
  const effectiveHedgeShares =
    hedgeShareWeights != null &&
    hedgeShareWeights.length === naturalHedgeLegs.length
      ? hedgeShareWeights
      : parentHedgeShares != null &&
          parentHedgeShares.length === naturalHedgeLegs.length
        ? parentHedgeShares
        : null;

  /**
   * Forwards after optional Hedge % tilt (Σ cover unchanged).
   */
  const hedgeLegs = useMemo((): StripForwardLeg[] => {
    if (
      showRollingStrip &&
      effectiveHedgeShares != null &&
      effectiveHedgeShares.length === naturalHedgeLegs.length &&
      naturalHedgeLegs.length > 0
    ) {
      return applyStripHedgeShareWeights(naturalHedgeLegs, effectiveHedgeShares);
    }
    return naturalHedgeLegs;
  }, [showRollingStrip, naturalHedgeLegs, effectiveHedgeShares]);

  /** Σ all strip legs (full program). */
  const stripTotalCoverM = showRollingStrip
    ? hedgeLegs.reduce((s, l) => s + l.amountLocalM, 0)
    : 0;

  const showHedgePerf = hedgeLegs.length > 0 && Tf > 0;

  // Regime / structure change → rebuild tick map (don't keep VN ticks on Target).
  useEffect(() => {
    setEnabledLegIds({});
  }, [selectedBasis, effectiveStructure]);

  // Keep checkbox map in sync when legs change (default: all on).
  useEffect(() => {
    setEnabledLegIds(prev => {
      const next: Record<number, boolean> = {};
      let changed = false;
      for (const l of hedgeLegs) {
        const on = prev[l.index] !== false;
        next[l.index] = on;
        if (prev[l.index] === undefined) changed = true;
      }
      for (const k of Object.keys(prev)) {
        if (!(Number(k) in next)) changed = true;
      }
      return changed || Object.keys(prev).length !== Object.keys(next).length
        ? next
        : prev;
    });
  }, [hedgeLegs]);

  /** Active ladder — unticked Δ folds into the next ticked maturity. */
  const activeLadderEdges = useMemo((): RollingHedgeEdge[] => {
    if (!showRollingStrip) return [];
    return packSelectedStripEdges(
      rollingEdges,
      hedgeLegs,
      enabledLegIds,
      Tf,
    );
  }, [showRollingStrip, rollingEdges, hedgeLegs, enabledLegIds, Tf]);

  /**
   * Folded active forwards for Resid VaR / table.
   * Strip → packSelectedStripEdges; bullet → the single M0–Tf leg (if ticked).
   */
  const activeHedgeLegs = useMemo((): StripForwardLeg[] => {
    if (!showRollingStrip) {
      return hedgeLegs.filter(l => enabledLegIds[l.index] !== false);
    }
    let prev = 0;
    return activeLadderEdges.map(e => {
      const amountLocalM = e.hedgeLocalM - prev;
      prev = e.hedgeLocalM;
      const base = hedgeLegs.find(l => l.index === e.index);
      return {
        index: e.index,
        label: e.label.startsWith('M0–')
          ? e.label
          : `M0–M${Math.round(e.endMonth)}`,
        tenureMonths: e.endMonth,
        amountLocalM,
        cumulCoverLocalM: e.hedgeLocalM,
        endExposureM: base?.endExposureM ?? e.endExposureM,
        stockStartM: base?.stockStartM ?? e.stockStartM,
      };
    });
  }, [
    showRollingStrip,
    activeLadderEdges,
    hedgeLegs,
    enabledLegIds,
  ]);

  /**
   * Resid VaR = V(t)·|e−H|/E with H = Σ ticked M0 forwards from day 0
   * (Cash / VN / Target). Target strip only changes tenors + Δe split —
   * not a path-track H — so M6 resid ≠ 0 when e < E_end. Table = chart.
   */
  const hedgedVarProfile = useMemo(() => {
    if (!showHedgePerf) return [];
    const Eref = Math.abs(pathEndM);
    const through = Math.max(Tf, windowMonths);
    if (activeHedgeLegs.length === 0) {
      const bare = buildStripHedgedVarProfile(
        startM,
        monthlyFlowM,
        ccy,
        setup,
        [
          {
            amountLocalM: Eref > 1e-12 ? Eref : 1,
            tenureMonths: Tf,
            recognizeFromMonths: 0,
          },
        ],
        flows,
        1,
        Eref > 1e-12 ? Eref : undefined,
        through,
      );
      return bare.map(p => ({
        ...p,
        hedgedVarUsdM: p.openVarUsdM,
        cumulCoverLocalM: 0,
        residualCoverLocalM: Math.abs(p.exposureLocalM),
      }));
    }
    return buildStripHedgedVarProfile(
      startM,
      monthlyFlowM,
      ccy,
      setup,
      activeHedgeLegs.map(l => ({
        amountLocalM: l.amountLocalM,
        tenureMonths: l.tenureMonths,
        recognizeFromMonths: 0,
      })),
      flows,
      1,
      Eref > 1e-12 ? Eref : undefined,
      through,
    );
  }, [
    showHedgePerf,
    activeHedgeLegs,
    startM,
    monthlyFlowM,
    ccy,
    setup,
    flows,
    pathEndM,
    Tf,
    windowMonths,
  ]);

  /** Full-program resid VaR (all legs on) — locks VaR chart Y scale vs checkboxes. */
  const hedgedVarProfileFull = useMemo(() => {
    if (!showHedgePerf || hedgeLegs.length === 0) return [];
    const Eref = Math.abs(pathEndM);
    const through = Math.max(Tf, windowMonths);
    return buildStripHedgedVarProfile(
      startM,
      monthlyFlowM,
      ccy,
      setup,
      hedgeLegs.map(l => ({
        amountLocalM: l.amountLocalM,
        tenureMonths: l.tenureMonths,
        recognizeFromMonths: 0,
      })),
      flows,
      1,
      Eref > 1e-12 ? Eref : undefined,
      through,
    );
  }, [
    showHedgePerf,
    hedgeLegs,
    pathEndM,
    Tf,
    windowMonths,
    startM,
    monthlyFlowM,
    ccy,
    setup,
    flows,
  ]);

  const hedgedVarProfileGeom = useMemo(() => {
    const W = 640;
    const H = 160;
    const padL = 48;
    const padR = 56;
    const padT = 22;
    const padB = 34;
    if (hedgedVarProfile.length === 0) {
      return {
        W,
        H,
        padL,
        padR,
        padT,
        padB,
        openLine: '',
        residLine: '',
        reductionArea: '',
        maxVar: 1,
        endResidVarUsdM: 0,
        maxResidVarUsdM: 0,
        maxResidT: 0,
        xScale: (_t: number) => padL,
        yScale: (_v: number) => padT,
        monthTicks: [] as number[],
        legMarks: [] as { t: number; hedgedVarUsdM: number; label: string }[],
        beMark: null as { t: number; hedgedVarUsdM: number } | null,
      };
    }
    const TfChart = hedgedVarProfile[hedgedVarProfile.length - 1]!.t;
    const endResidVarUsdM =
      hedgedVarProfile[hedgedVarProfile.length - 1]!.hedgedVarUsdM;
    let maxResidVarUsdM = 0;
    let maxResidT = 0;
    for (const p of hedgedVarProfile) {
      if (p.hedgedVarUsdM > maxResidVarUsdM) {
        maxResidVarUsdM = p.hedgedVarUsdM;
        maxResidT = p.t;
      }
    }
    // Y max from open VaR + full-program resid (not the ticked subset).
    const scaleSrc =
      hedgedVarProfileFull.length > 0 ? hedgedVarProfileFull : hedgedVarProfile;
    const maxVar =
      Math.max(
        0.01,
        ...scaleSrc.map(p => Math.max(p.openVarUsdM, p.hedgedVarUsdM)),
        ...hedgedVarProfile.map(p => Math.max(p.openVarUsdM, p.hedgedVarUsdM)),
      ) * 1.12;
    const xScale = (t: number) =>
      padL + (TfChart <= 0 ? 0 : (t / TfChart) * (W - padL - padR));
    const yScale = (v: number) =>
      padT + (1 - v / maxVar) * (H - padT - padB);

    // Exact knots for every forward mark + BE so stroke and dots share points.
    const coverForBe = showRollingStrip
      ? activeHedgeLegs.reduce((s, l) => s + l.amountLocalM, 0)
      : hedgeBasisNotionalLocalM(
          selectedBasis,
          startM,
          pathEndM,
          matchedEqualVarLocalM,
        );
    const beT =
      Math.abs(coverForBe) > 1e-9
        ? hedgeBreakevenMonths(path, coverForBe)
        : null;
    const markTs = [
      0,
      ...activeHedgeLegs.map(l => l.tenureMonths),
      ...(beT != null ? [beT] : []),
      TfChart,
    ];
    const residSeries = mergeVarProfileKnots(hedgedVarProfile, markTs);

    const openPts = residSeries.map(p => ({
      x: xScale(p.t),
      y: yScale(p.openVarUsdM),
    }));
    const residPts = residSeries.map(p => ({
      x: xScale(p.t),
      y: yScale(p.hedgedVarUsdM),
    }));
    const openLine = smoothSplinePath(openPts);
    const residLine = smoothSplinePath(residPts);
    const residBack = smoothSplinePath([...residPts].reverse()).replace(
      /^M/,
      'L',
    );
    const reductionArea =
      openLine && residBack ? `${openLine} ${residBack} Z` : '';
    const monthTicks: number[] = [];
    for (let m = 0; m <= Math.ceil(TfChart); m++) {
      if (m <= TfChart + 1e-9) monthTicks.push(m);
    }
    if (
      monthTicks.length === 0 ||
      Math.abs(monthTicks[monthTicks.length - 1]! - TfChart) > 1e-9
    ) {
      monthTicks.push(TfChart);
    }
    const atSeries = (t: number) => {
      const hit = residSeries.find(p => Math.abs(p.t - t) < 1e-6);
      if (hit) return hit;
      return residSeries.reduce((best, p) =>
        Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best,
      );
    };
    const legMarks = activeHedgeLegs.map(leg => {
      const pt = atSeries(leg.tenureMonths);
      return {
        // Use series knot t so the circle sits on the stroke sample.
        t: pt.t,
        hedgedVarUsdM: pt.hedgedVarUsdM,
        label: leg.label,
      };
    });
    const beMark =
      beT != null
        ? (() => {
            const pt = atSeries(beT);
            return { t: pt.t, hedgedVarUsdM: pt.hedgedVarUsdM };
          })()
        : null;
    return {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      openLine,
      residLine,
      reductionArea,
      maxVar,
      endResidVarUsdM,
      maxResidVarUsdM,
      maxResidT,
      xScale,
      yScale,
      monthTicks,
      legMarks,
      beMark,
    };
  }, [
    hedgedVarProfile,
    hedgedVarProfileFull,
    activeHedgeLegs,
    showRollingStrip,
    selectedBasis,
    startM,
    pathEndM,
    matchedEqualVarLocalM,
    path,
  ]);

  const resetStripToDefault = () => {
    setStripLegCount(null);
    setEnabledLegIds({});
    setStripScheduleMode('equal');
    commitCustomEnds(null);
    setScheduleWeights(null);
    setWeightPreset('equal');
    setStripCashDeliveryAt('periodEnd');
    commitHedgeShares(null);
    setHedgeShareDraft(null);
    setSchedPctDraft(null);
  };

  /** Shared Reset | Legs − n + | ⚙ control (Performance header and/or schedule host). */
  const renderStripLegsToolbar = (opts?: {
    showGear?: boolean;
    trailing?: ReactNode;
    /** Override gear toggle (Cash Carry external schedule host). */
    onGearClick?: () => void;
    gearPressed?: boolean;
    gearTitle?: string;
  }) => {
    const showGear = opts?.showGear !== false;
    const gearPressed =
      opts?.gearPressed ??
      (stripScheduleOpen ||
        stripScheduleMode === 'custom' ||
        stripCashDeliveryAt !== 'periodEnd');
    const bumpLegs = (next: number) => {
      if (stripScheduleMode === 'custom') {
        setStripScheduleMode('equal');
        commitCustomEnds(null);
        setScheduleWeights(null);
        setWeightPreset('equal');
      }
      setStripLegCount(next);
    };
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-1.5 py-0.5">
        <button
          type="button"
          onClick={resetStripToDefault}
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          title={`Reset to equal ${defaultStripLegs}-leg strip (ceil(Tf/Th)), all trades on`}
        >
          Reset
        </button>
        <span className="text-[9px] text-slate-600">|</span>
        <span className="text-[9px] text-slate-500">
          {weightPreset === 'front'
            ? 'Front-loaded'
            : weightPreset === 'back'
              ? 'Back-loaded'
              : stripScheduleMode === 'custom'
                ? 'Custom · legs'
                : 'Strip legs'}
        </span>
        <button
          type="button"
          disabled={effectiveStripLegs <= 2}
          onClick={() => bumpLegs(Math.max(2, effectiveStripLegs - 1))}
          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-30"
          title="Fewer strip forwards (min 2) — equal spacing"
        >
          −
        </button>
        <span className="min-w-[1.25rem] text-center font-mono text-[11px] text-amber-200">
          {stripScheduleMode === 'custom'
            ? activeEndMonths.length || effectiveStripLegs
            : effectiveStripLegs}
        </span>
        <button
          type="button"
          disabled={effectiveStripLegs >= maxStripLegs}
          onClick={() =>
            bumpLegs(Math.min(maxStripLegs, effectiveStripLegs + 1))
          }
          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-30"
          title={`More strip forwards (max ${maxStripLegs}) — equal spacing`}
        >
          +
        </button>
        {showGear && (
          <>
            <span className="text-[9px] text-slate-600">|</span>
            <button
              type="button"
              title={
                opts?.gearTitle ??
                (pathControlsInGear
                  ? 'Hedge setup — structure, regime, strip schedule'
                  : 'Strip schedule — equal or custom maturity dates')
              }
              aria-label={
                pathControlsInGear
                  ? 'Hedge setup settings'
                  : 'Strip schedule settings'
              }
              aria-pressed={gearPressed}
              onClick={() => {
                if (opts?.onGearClick) {
                  opts.onGearClick();
                  return;
                }
                setStripScheduleOpen(o => !o);
              }}
              className={`inline-flex h-6 w-6 items-center justify-center rounded ${
                gearPressed
                  ? 'bg-amber-500/20 text-amber-200'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <GearIcon className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {opts?.trailing}
      </div>
    );
  };

  /** Equal Sched % windows for current leg count (keeps n; clears custom settles). */
  const resetSchedulePct = () => {
    setStripScheduleMode('equal');
    commitCustomEnds(null);
    setScheduleWeights(null);
    setWeightPreset('equal');
    setSchedPctDraft(null);
  };

  const applyScheduleWeights = (
    rawWeights: readonly number[],
    preset: StripScheduleWeightPreset | 'equal' | 'custom',
  ) => {
    const w = normalizeStripScheduleWeights(rawWeights);
    if (w.length < 2) return;
    const ends = endMonthsFromScheduleWeights(w, Tf);
    setScheduleWeights(w);
    commitCustomEnds(ends);
    setStripScheduleMode('custom');
    setStripLegCount(Math.max(2, ends.length));
    setWeightPreset(preset);
  };

  const openCustomSchedule = () => {
    const seed =
      customEndMonths != null && customEndMonths.length > 0
        ? normalizeStripEndMonths(customEndMonths, Tf, {
            forceThroughTf: false,
          })
        : equalEndMonths;
    const w = scheduleWeightsFromEndMonths(seed, Tf);
    commitCustomEnds(seed);
    setScheduleWeights(w);
    setStripScheduleMode('custom');
    setStripLegCount(Math.max(2, seed.length));
    setWeightPreset('custom');
  };

  const updateCustomEndAt = (index: number, raw: number) => {
    const base =
      customEndMonths != null && customEndMonths.length > 0
        ? customEndMonths
        : endMonthsFromScheduleWeights(
            scheduleWeights ??
              equalStripScheduleWeights(effectiveStripLegs),
            Tf,
          );
    if (base.length === 0) return;
    const next = [...base];
    next[index] = raw;
    // Keep edited final settle — equal/front/back presets still end at Tf.
    const norm = normalizeStripEndMonths(next, Tf, { forceThroughTf: false });
    if (norm.length === 0) return;
    commitCustomEnds(norm);
    setScheduleWeights(scheduleWeightsFromEndMonths(norm, Tf));
    setStripScheduleMode('custom');
    setStripLegCount(Math.max(2, norm.length));
    setWeightPreset('custom');
  };

  const updateCustomEndFromDate = (index: number, isoDate: string) => {
    const months = monthsFromSettleDate(isoDate);
    const base =
      customEndMonths != null && customEndMonths.length > 0
        ? customEndMonths
        : activeEndMonths;
    if (base.length === 0) return;
    const isLast = index >= base.length - 1;
    const prev = index > 0 ? (base[index - 1] ?? 0) : 0;
    const following =
      index < base.length - 1 ? (base[index + 1] ?? Tf) : Tf;
    const lo = Math.max(0.05, prev + 0.05);
    const hi = isLast
      ? Tf
      : Math.min(Tf, Math.max(lo + 0.05, following - 0.05));
    const capped = Math.min(Math.max(months, lo), Math.max(lo, hi));
    updateCustomEndAt(index, capped);
  };

  const removeCustomEndAt = (index: number) => {
    const base =
      customEndMonths != null && customEndMonths.length > 0
        ? customEndMonths
        : equalEndMonths;
    if (base.length <= 2) return;
    const next = base.filter((_, i) => i !== index);
    const norm = normalizeStripEndMonths(next, Tf, { forceThroughTf: false });
    commitCustomEnds(norm);
    setScheduleWeights(scheduleWeightsFromEndMonths(norm, Tf));
    setStripScheduleMode('custom');
    setStripLegCount(Math.max(2, norm.length));
    setWeightPreset('custom');
  };

  const addCustomEnd = () => {
    const base =
      customEndMonths != null && customEndMonths.length > 0
        ? customEndMonths
        : equalEndMonths;
    if (base.length >= maxStripLegs) return;
    const prev = base.length >= 2 ? base[base.length - 2]! : Tf / 2;
    const mid = Math.round((prev + Tf) / 2);
    const candidate = mid > prev + 1e-9 && mid < Tf - 1e-9 ? mid : prev + 1;
    const norm = normalizeStripEndMonths([...base, candidate], Tf);
    commitCustomEnds(norm);
    setScheduleWeights(scheduleWeightsFromEndMonths(norm, Tf));
    setStripScheduleMode('custom');
    setStripLegCount(Math.max(2, norm.length));
    setWeightPreset('custom');
  };

  const updateScheduleWeightAt = (index: number, pct: number) => {
    const n = Math.max(2, hedgeLegs.length || effectiveStripLegs);
    let base =
      scheduleWeights != null && scheduleWeights.length === n
        ? [...scheduleWeights]
        : scheduleWeights != null && scheduleWeights.length > 0
          ? normalizeStripScheduleWeights(scheduleWeights)
          : stripScheduleMode === 'equal'
            ? equalStripScheduleWeights(n)
            : scheduleWeightsFromEndMonths(
                customEndMonths ?? equalEndMonths,
                Tf,
              );
    // Align weight vector to current leg count (Front/Back ramps, Equal, Custom).
    if (base.length !== n) {
      base = rampStripScheduleWeights(
        n,
        weightPreset === 'front' || weightPreset === 'back'
          ? weightPreset
          : 'equal',
      );
    }
    if (base.length === 0 || index < 0 || index >= base.length) return;
    // Keep the typed % on this row; rescale only the other legs to 100%.
    const next = pinStripScheduleWeightAt(base, index, pct / 100);
    applyScheduleWeights(next, 'custom');
  };

  const displayScheduleWeights = useMemo(() => {
    if (stripScheduleMode === 'equal') {
      return equalStripScheduleWeights(effectiveStripLegs);
    }
    if (scheduleWeights != null && scheduleWeights.length > 0) {
      return normalizeStripScheduleWeights(scheduleWeights);
    }
    return scheduleWeightsFromEndMonths(activeEndMonths, Tf);
  }, [
    stripScheduleMode,
    scheduleWeights,
    effectiveStripLegs,
    activeEndMonths,
    Tf,
  ]);

  const naturalNotionalWeights = useMemo(
    () => notionalWeightsFromAmounts(naturalHedgeLegs.map(l => l.amountLocalM)),
    [naturalHedgeLegs],
  );

  /** Displayed Hedge % — custom tilt or regime-sized mix. */
  const notionalWeights = useMemo(() => {
    if (
      effectiveHedgeShares != null &&
      effectiveHedgeShares.length === hedgeLegs.length
    ) {
      return normalizeStripScheduleWeights(effectiveHedgeShares);
    }
    return naturalNotionalWeights;
  }, [effectiveHedgeShares, hedgeLegs.length, naturalNotionalWeights]);

  const updateHedgeShareAt = (index: number, pct: number) => {
    const n = hedgeLegs.length;
    if (n < 1 || index < 0 || index >= n) return;
    const base =
      hedgeShareWeights != null && hedgeShareWeights.length === n
        ? hedgeShareWeights
        : naturalNotionalWeights.length === n
          ? naturalNotionalWeights
          : equalStripScheduleWeights(n);
    const next = pinStripScheduleWeightAt(base, index, pct / 100);
    commitHedgeShares(next);
  };

  /** Detail rows under the chart: each FWD (checkbox) + Tf. */
  const hedgePerfRows = useMemo(() => {
    if (performancePanelPlacement === 'external') return [];
    if (hedgeLegs.length === 0) return [];
    type Row = {
      key: string;
      label: string;
      kind: 'leg' | 'end';
      legIndex: number | null;
      /** Incremental forward size (this trade). */
      hedgeDeltaM: number | null;
      /** Cumulative cover H(t) from ticked legs at this tenure. */
      cumulCoverLocalM: number;
      endExposureM: number | null;
      /** |e(t) − H(t)| absolute path mismatch. */
      residualLocalM: number;
      openVarUsdM: number;
      hedgedVarUsdM: number;
      /** Δ = Resid VaR / Open VaR (1 = unhedged, 0 = matched). */
      delta: number;
      enabled: boolean;
                      carryTotalUsdM: number | null;
      carryFwdUsdM: number | null;
      carryFcyIntUsdM: number | null;
      carryUsdIntUsdM: number | null;
      carryFcyRatePct: number | null;
      carryUsdRatePct: number | null;
      carryFcySide: 'credit' | 'debit' | null;
      carryUsdSide: 'credit' | 'debit' | null;
      carrySwapPoints: number | null;
      carrySwapPointsSide: 'bid' | 'ask' | 'mid' | null;
    };
    const at = (t: number) =>
      hedgedVarProfile.find(p => Math.abs(p.t - t) < 1e-6) ??
      (hedgedVarProfile.length
        ? hedgedVarProfile.reduce((best, p) =>
            Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best,
          )
        : null);
    const deltaOf = (openVarUsdM: number, hedgedVarUsdM: number) =>
      openVarUsdM < 1e-12
        ? 0
        : Math.min(1, Math.max(0, hedgedVarUsdM / openVarUsdM));
    const carryOf = (notional: number, recognizeMonths: number, settle: number) => {
      const fwd = resolveForwardDepositRates(marketRates, ccy, settle);
      const cash = resolveOvernightCashRates(marketRates, ccy);
      const pts = fwdCarryFromSwapPointsUsdM({
        notionalLocalM: notional,
        settleMonths: settle,
        bundle: marketRates,
      });
      return stripHedgeLegCarryUsdM({
        notionalLocalM: notional,
        ccy,
        recognizeMonths,
        settleMonths: settle,
        forecastEndMonths: Tf,
        fcyFwdRates: fwd.fcy,
        usdFwdRates: fwd.usd,
        fcyCashRates: cash.fcy,
        usdCashRates: cash.usd,
        swapPointsCarryUsdM: pts?.fwdCarryUsdM,
        swapPoints: pts?.points,
        swapPointsSide: pts?.side,
      });
    };
    const rows: Row[] = [];
    for (const leg of hedgeLegs) {
      const p = at(leg.tenureMonths);
      const enabled = enabledLegIds[leg.index] !== false;
      const openVarUsdM = p?.openVarUsdM ?? 0;
      const hedgedVarUsdM = p?.hedgedVarUsdM ?? 0;
      // H = Σ live M0 cover from profile (same as Resid VaR) — not path e.
      const hAt =
        p != null
          ? p.cumulCoverLocalM
          : enabled
            ? leg.cumulCoverLocalM
            : 0;
      const eAt = p?.exposureLocalM ?? leg.endExposureM;
      const edge = rollingEdges.find(e => e.index === leg.index);
      const recog = edge?.startMonth ?? 0;
      // Carry on forward curve to the cash-delivery settle (not only window end).
      const settle =
        edge != null
          ? resolveStripCashSettleMonths(
              edge,
              path,
              stripCashDeliveryAt,
              windowMonths,
            )
          : bulletSettleMonths;
      const carry = carryOf(leg.amountLocalM, recog, settle);
      rows.push({
        key: `leg-${leg.index}`,
        label: leg.label,
        kind: 'leg',
        legIndex: leg.index,
        hedgeDeltaM: leg.amountLocalM,
        cumulCoverLocalM: hAt,
        endExposureM: eAt,
        residualLocalM:
          p?.residualCoverLocalM ?? Math.abs(eAt - hAt),
        openVarUsdM,
        hedgedVarUsdM,
        delta: deltaOf(openVarUsdM, hedgedVarUsdM),
        enabled,
        carryTotalUsdM: carry.totalUsdM,
        carryFwdUsdM: carry.fwdCarryUsdM,
        carryFcyIntUsdM: carry.fcyInterestUsdM,
        carryUsdIntUsdM: carry.usdInterestUsdM,
        carryFcyRatePct: carry.r_FCY_used ?? null,
        carryUsdRatePct: carry.r_USD_used ?? null,
        carryFcySide: carry.r_FCY_side ?? null,
        carryUsdSide: carry.r_USD_side ?? null,
        carrySwapPoints: carry.swapPoints ?? null,
        carrySwapPointsSide: carry.swapPointsSide ?? null,
      });
    }
    const endT = hedgedVarProfile[hedgedVarProfile.length - 1]?.t;
    if (
      endT != null &&
      !hedgeLegs.some(l => Math.abs(l.tenureMonths - endT) < 1e-6)
    ) {
      const pEnd = at(endT);
      const openVarUsdM = pEnd?.openVarUsdM ?? 0;
      const hedgedVarUsdM = pEnd?.hedgedVarUsdM ?? 0;
      rows.push({
        key: 'tf',
        label: `M${Math.round(endT)}`,
        kind: 'end',
        legIndex: null,
        hedgeDeltaM: null,
        cumulCoverLocalM: pEnd?.cumulCoverLocalM ?? 0,
        endExposureM: pEnd?.exposureLocalM ?? pathEndM,
        residualLocalM: pEnd?.residualCoverLocalM ?? 0,
        openVarUsdM,
        hedgedVarUsdM,
        delta: deltaOf(openVarUsdM, hedgedVarUsdM),
        enabled: true,
        carryTotalUsdM: null,
        carryFwdUsdM: null,
        carryFcyIntUsdM: null,
        carryUsdIntUsdM: null,
        carryFcyRatePct: null,
        carryUsdRatePct: null,
        carryFcySide: null,
        carryUsdSide: null,
        carrySwapPoints: null,
        carrySwapPointsSide: null,
      });
    }
    return rows;
  }, [
    hedgeLegs,
    hedgedVarProfile,
    pathEndM,
    enabledLegIds,
    ccy,
    Tf,
    rollingEdges,
    path,
    stripCashDeliveryAt,
    windowMonths,
    marketRates,
    bulletSettleMonths,
    performancePanelPlacement,
  ]);

  /** Cover from ticked legs only (unticked legs excluded from green H & resid). */
  const activeStripCoverM = showRollingStrip
    ? activeHedgeLegs.reduce((s, l) => s + l.amountLocalM, 0)
    : 0;

  const anyStripLegOff =
    showRollingStrip &&
    hedgeLegs.some(l => enabledLegIds[l.index] === false);

  const basisTarget = showRollingStrip
    ? activeStripCoverM
    : hedgeBasisNotionalLocalM(
        selectedBasis,
        startM,
        pathEndM,
        matchedEqualVarLocalM,
      );

  // Bullet only: sync Decision % when Cash/VN/Target or structure changes.
  // Strip must not auto-apply here — booking is explicit via "Book … forwards".
  const onApplyBasisRef = useRef(onApplyBasis);
  onApplyBasisRef.current = onApplyBasis;
  const applySigRef = useRef('');
  useEffect(() => {
    if (effectiveStructure === 'strip') return;
    const sig = `${effectiveStructure}|${selectedBasis}|${matchedEqualVarLocalM.toFixed(6)}|${pathEndM.toFixed(6)}`;
    if (applySigRef.current === sig) return;
    applySigRef.current = sig;
    onApplyBasisRef.current(selectedBasis, effectiveStructure);
  }, [
    effectiveStructure,
    selectedBasis,
    matchedEqualVarLocalM,
    pathEndM,
  ]);

  /**
   * Flat H = Σ ticked strip cover (all live from M0) or bullet level.
   * One breakeven: where |e| crosses that flat H (strip ladder still stepped).
   */
  const hedgeLevel = showRollingStrip
    ? Math.abs(activeStripCoverM) > 1e-12
      ? activeStripCoverM
      : 0
    : Math.abs(basisTarget) > 1e-12
      ? basisTarget
      : Math.abs(appliedHedgeLocalM) < 1e-12
        ? 0
        : Math.sign(pathEndM || startM || 1) * Math.abs(appliedHedgeLocalM);

  const hasFlatHedge = Math.abs(hedgeLevel) > 1e-9;

  /** Single BE vs flat cover H (Σ strip or bullet). */
  const breakevenT = useMemo(
    () => (hasFlatHedge ? hedgeBreakevenMonths(path, hedgeLevel) : null),
    [hasFlatHedge, path, hedgeLevel],
  );

  /** Preview residual when bullet H set or any strip leg ticked. */
  const hasHedge = showRollingStrip
    ? activeHedgeLegs.length > 0
    : hasFlatHedge;

  const geom = useMemo(() => {
    // Geometry mirrors design_handoff_exposure_profile_chart (viewBox 1136×…).
    const W = EXP_PROFILE_W;
    const H = 300;
    const padL = 56;
    const padR = 56;
    const padT = 24;
    const padB = 28;
    // Stable Y domain from exposure path + full strip program (not ticked subset).
    const fullProgramCover = showRollingStrip
      ? stripTotalCoverM
      : Math.abs(appliedHedgeLocalM) > 1e-12
        ? Math.sign(pathEndM || startM || 1) * Math.abs(appliedHedgeLocalM)
        : hedgeBasisNotionalLocalM(
            selectedBasis,
            startM,
            pathEndM,
            matchedEqualVarLocalM,
          );
    const values = [
      ...path.map(p => p.exposureM),
      startM,
      pathEndM,
      fullProgramCover,
      ...rollingEdges.map(e => e.hedgeLocalM),
      ...rollingEdges.map(e => e.endExposureM),
      ...hedgeLegs.map(l => l.cumulCoverLocalM),
    ];
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    const span0 = Math.max(0.5, dataMax - dataMin);
    const pad = span0 * 0.12;
    const minY = dataMin - pad;
    const maxY = dataMax + pad;
    const xScale = (t: number) =>
      padL + (windowMonths <= 0 ? 0 : (t / windowMonths) * (W - padL - padR));
    const yScale = (v: number) => {
      const span = maxY - minY || 1;
      return padT + (1 - (v - minY) / span) * (H - padT - padB);
    };
    const expLine = smoothSplinePath(
      path.map(p => ({ x: xScale(p.t), y: yScale(p.exposureM) })),
    );

    const monthTicks: number[] = [];
    for (let m = 0; m <= Math.ceil(windowMonths); m++) {
      if (m <= windowMonths + 1e-9) monthTicks.push(m);
    }
    if (monthTicks[monthTicks.length - 1] !== windowMonths) {
      monthTicks.push(windowMonths);
    }

    const yTicks = 4;
    const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) =>
      minY + ((maxY - minY) * i) / yTicks,
    );

    return {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      minY,
      maxY,
      xScale,
      yScale,
      expLine,
      monthTicks,
      yTickVals,
    };
  }, [
    path,
    windowMonths,
    startM,
    pathEndM,
    showRollingStrip,
    stripTotalCoverM,
    appliedHedgeLocalM,
    selectedBasis,
    matchedEqualVarLocalM,
    rollingEdges,
    hedgeLegs,
  ]);

  const {
    W,
    H,
    padL,
    padR,
    padT,
    padB,
    xScale,
    yScale,
    expLine,
    monthTicks,
    yTickVals,
  } = geom;

  const startGap = overhedgeGapM(startM, hedgeLevel);
  const endGap = overhedgeGapM(pathEndM, hedgeLevel);

  /**
   * Forward ladder (chapter 5 chart, zone C): one row per leg, ticked +
   * planned, sorted by settle time and numbered L1, L2… in that order.
   * Ticked rows carry cumulative cash / % of cover; planned rows are
   * dashed-outline placeholders excluded from cover (design handoff
   * "Exposure profile · forward ladder").
   */
  const forwardLadderRows = useMemo(() => {
    if (!hasHedge) return [] as ForwardLadderRow[];
    if (!showRollingStrip) {
      const t = Math.min(windowMonths, Math.max(0, bulletSettleMonths));
      return [
        {
          key: 'bullet',
          label: 'L1',
          settleT: t,
          deltaLocalM: hedgeLevel,
          cumulLocalM: hedgeLevel,
          pctOfCover: 100,
          ticked: true,
        },
      ];
    }
    let prevCum = 0;
    const ticked = activeLadderEdges.map(e => {
      const delta = e.hedgeLocalM - prevCum;
      prevCum = e.hedgeLocalM;
      const t = resolveStripCashSettleMonths(
        e,
        path,
        stripCashDeliveryAt,
        windowMonths,
      );
      return {
        key: `t-${e.index}`,
        label: '',
        settleT: t,
        deltaLocalM: delta,
        cumulLocalM: e.hedgeLocalM,
        pctOfCover:
          Math.abs(hedgeLevel) > 1e-9
            ? (Math.abs(e.hedgeLocalM) / Math.abs(hedgeLevel)) * 100
            : null,
        ticked: true,
      };
    });
    const planned = hedgeLegs
      .filter(l => enabledLegIds[l.index] === false)
      .map(l => ({
        key: `p-${l.index}`,
        label: '',
        settleT: Math.min(windowMonths, Math.max(0, l.tenureMonths)),
        deltaLocalM: l.amountLocalM,
        cumulLocalM: null as number | null,
        pctOfCover: null as number | null,
        ticked: false,
      }));
    return [...ticked, ...planned]
      .sort((a, b) => a.settleT - b.settleT)
      .map((row, i) => ({ ...row, label: `L${i + 1}` }));
  }, [
    hasHedge,
    showRollingStrip,
    windowMonths,
    bulletSettleMonths,
    hedgeLevel,
    activeLadderEdges,
    path,
    stripCashDeliveryAt,
    hedgeLegs,
    enabledLegIds,
  ]);

  /**
   * Over-hedge wedge (zone A): one polygon per contiguous run where
   * |cover| > |e(t)|, built from the real monthly path (not a straight-line
   * approximation) so it closes exactly at breakeven. Neutral slate fill +
   * hairline stroke along the e(t) boundary per design handoff.
   */
  const overhedgeWedge = useMemo(() => {
    if (!hasHedge || path.length < 2 || Math.abs(hedgeLevel) < 1e-9)
      return null;
    const Hlvl = Math.abs(hedgeLevel);
    const coverY = yScale(hedgeLevel);
    const isOver = (p: { exposureM: number }) =>
      Hlvl > Math.abs(p.exposureM) + 1e-9;
    const crossing = (
      a: { t: number; exposureM: number },
      b: { t: number; exposureM: number },
    ) => {
      const ea = Math.abs(a.exposureM);
      const eb = Math.abs(b.exposureM);
      if (Math.abs(eb - ea) < 1e-12) return null;
      const w = (Hlvl - ea) / (eb - ea);
      if (w <= 0 || w >= 1) return null;
      const t = a.t + w * (b.t - a.t);
      const exposureM = a.exposureM + w * (b.exposureM - a.exposureM);
      return { t, exposureM };
    };
    const runs: { x: number; y: number }[][] = [];
    let current: { x: number; y: number }[] = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i]!;
      const over = isOver(p);
      if (over) {
        if (current.length === 0 && i > 0 && !isOver(path[i - 1]!)) {
          const c = crossing(path[i - 1]!, p);
          if (c) current.push({ x: xScale(c.t), y: yScale(c.exposureM) });
        }
        current.push({ x: xScale(p.t), y: yScale(p.exposureM) });
      } else if (current.length > 0) {
        const c = crossing(path[i - 1]!, p);
        if (c) current.push({ x: xScale(c.t), y: yScale(c.exposureM) });
        runs.push(current);
        current = [];
      }
    }
    if (current.length > 0) runs.push(current);
    const polys = runs
      .filter(r => r.length >= 2)
      .map(r => {
        const first = r[0]!;
        const last = r[r.length - 1]!;
        const fillPoints = [
          ...r,
          { x: last.x, y: coverY },
          { x: first.x, y: coverY },
        ]
          .map(pt => `${pt.x},${pt.y}`)
          .join(' ');
        const strokeD = r
          .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x},${pt.y}`)
          .join(' ');
        return { fillPoints, strokeD };
      });
    return polys.length > 0 ? polys : null;
  }, [hasHedge, path, hedgeLevel, xScale, yScale]);

  const overhedgeReadoutLabel = (v: number): string => {
    if (Math.abs(v) < 5e-3) return 'on 0.00M';
    const mag = Math.abs(v).toFixed(2);
    return v > 0 ? `over +${mag}M` : `under ${mag}M`;
  };
  const overhedgeReadouts = useMemo(() => {
    if (!hasHedge || !overhedgeWedge) return [] as { t: number; v: number }[];
    /** Linear-interpolated e(t) — readout band under the cover line. */
    const valueAtT = (t: number) => {
      if (path.length === 0) return 0;
      if (t <= path[0]!.t) return path[0]!.exposureM;
      for (let i = 1; i < path.length; i++) {
        if (t <= path[i]!.t) {
          const a = path[i - 1]!;
          const b = path[i]!;
          const span = b.t - a.t;
          const w = span > 1e-9 ? (t - a.t) / span : 0;
          return a.exposureM + w * (b.exposureM - a.exposureM);
        }
      }
      return path[path.length - 1]!.exposureM;
    };
    const tEnd =
      breakevenT != null
        ? Math.min(windowMonths, breakevenT)
        : windowMonths;
    const tMid = tEnd > 1e-6 ? tEnd / 2 : windowMonths / 2;
    const pts = [0, tMid, tEnd];
    const seen = new Set<number>();
    return pts
      .filter(t => {
        const key = Math.round(t * 100);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(t => ({
        t,
        v: overhedgeGapM(valueAtT(t), hedgeLevel),
      }));
  }, [hasHedge, overhedgeWedge, breakevenT, windowMonths, hedgeLevel, path]);

  /** Zone C geometry — grows with leg count; 0 rows collapses the lane. */
  const ladderRowH = 20;
  const ladderBarH = 10;
  const ladderDividerY = H + 4;
  const ladderHeaderY = H + 17;
  const ladderRowTopY = H + 25;
  const svgTotalH =
    forwardLadderRows.length > 0
      ? ladderRowTopY + forwardLadderRows.length * ladderRowH + 6
      : H + 6;

  /**
   * Net cash position (companion chart, "Lower chart — net cash position"):
   * net(t) = e(t) − cumulative cash delivered by t. Same x geometry as the
   * main chart (reuses xScale/windowMonths) so settle guides share one x
   * across both. Steps down at each ticked settle; closes to 0 at Tf when
   * cover = cash delivered = E.
   */
  const netCashSeries = useMemo(() => {
    if (!hasHedge || path.length < 2) return [] as { t: number; net: number }[];
    const ticked = forwardLadderRows
      .filter(r => r.ticked)
      .slice()
      .sort((a, b) => a.settleT - b.settleT);
    const valueAtT = (t: number) => {
      if (t <= path[0]!.t) return path[0]!.exposureM;
      for (let i = 1; i < path.length; i++) {
        if (t <= path[i]!.t) {
          const a = path[i - 1]!;
          const b = path[i]!;
          const span = b.t - a.t;
          const w = span > 1e-9 ? (t - a.t) / span : 0;
          return a.exposureM + w * (b.exposureM - a.exposureM);
        }
      }
      return path[path.length - 1]!.exposureM;
    };
    const cumBefore = (t: number) =>
      ticked.reduce(
        (s, r) => s + (r.settleT < t - 1e-9 ? r.deltaLocalM : 0),
        0,
      );
    const cumThrough = (t: number) =>
      ticked.reduce(
        (s, r) => s + (r.settleT <= t + 1e-9 ? r.deltaLocalM : 0),
        0,
      );
    const tSet = new Set<number>([0, windowMonths]);
    for (const p of path) {
      if (p.t >= -1e-9 && p.t <= windowMonths + 1e-9) tSet.add(p.t);
    }
    for (const r of ticked) tSet.add(r.settleT);
    const ts = Array.from(tSet).sort((a, b) => a - b);
    const pts: { t: number; net: number }[] = [];
    for (const t of ts) {
      const isSettle = ticked.some(r => Math.abs(r.settleT - t) < 1e-6);
      if (isSettle) {
        pts.push({ t, net: valueAtT(t) - cumBefore(t) });
        pts.push({ t, net: valueAtT(t) - cumThrough(t) });
      } else {
        pts.push({ t, net: valueAtT(t) - cumThrough(t) });
      }
    }
    return pts;
  }, [hasHedge, path, forwardLadderRows, windowMonths]);

  /**
   * Net exposure = e(t) − cover, sampled at every real path point (not
   * stepped — cover is a flat constant, so this follows e(t)'s own shape,
   * offset down). Below zero = cover ahead of exposure = over-hedged,
   * the same fact the main chart's wedge states with the opposite sign.
   */
  const netExposureSeries = useMemo(() => {
    if (!hasHedge || path.length === 0)
      return [] as { t: number; v: number }[];
    return path
      .filter(p => p.t >= -1e-9 && p.t <= windowMonths + 1e-9)
      .map(p => ({ t: p.t, v: p.exposureM - hedgeLevel }));
  }, [hasHedge, path, windowMonths, hedgeLevel]);

  /**
   * Net-exposure-vs-hedge-cash plot geometry — shares xScale/W with the
   * main chart so a settle guide, a ladder bar end, a staircase step and a
   * net-cash drop all land on the same x. Fixed pixel layout mirroring the
   * design handoff's 0 0 1136 232 viewBox, scaled to the real data range.
   */
  const netGeom = useMemo(() => {
    const plotT = 16;
    const zeroY = 105;
    const halfH = 85;
    const plotBGuide = 194;
    const tfRuleBottom = 198;
    const monthLabelY = 216;
    const H = 232;
    if (netCashSeries.length === 0 && netExposureSeries.length === 0) {
      return {
        H,
        plotT,
        zeroY,
        plotBGuide,
        tfRuleBottom,
        monthLabelY,
        yScale: (_v: number) => zeroY,
        maxAbs: 1,
        maxShort: null as { t: number; net: number } | null,
        yTickVals: [] as number[],
      };
    }
    const allVals = [
      ...netCashSeries.map(p => p.net),
      ...netExposureSeries.map(p => p.v),
      0,
    ];
    const maxAbs = Math.max(0.5, ...allVals.map(v => Math.abs(v))) * 1.12;
    const yScale = (v: number) => zeroY - (v / maxAbs) * halfH;
    let maxShort: { t: number; net: number } | null = null;
    for (const p of netCashSeries) {
      if (maxShort == null || p.net < maxShort.net) maxShort = p;
    }
    const yTickVals = [maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs];
    return {
      H,
      plotT,
      zeroY,
      plotBGuide,
      tfRuleBottom,
      monthLabelY,
      yScale,
      maxAbs,
      maxShort,
      yTickVals,
    };
  }, [netCashSeries, netExposureSeries]);

  /** Slate over-hedge wedge: where net exposure (teal) dips below zero. */
  const netExposureWedgePolys = useMemo(
    () =>
      buildZeroBandPolys(
        netExposureSeries.map(p => ({
          x: xScale(p.t),
          y: netGeom.yScale(p.v),
        })),
        netGeom.zeroY,
      ),
    [netExposureSeries, xScale, netGeom],
  );

  /** Red tint: where net cash (amber) is negative — cash delivered ahead. */
  const netCashNegativePolys = useMemo(
    () =>
      buildZeroBandPolys(
        netCashSeries.map(p => ({ x: xScale(p.t), y: netGeom.yScale(p.net) })),
        netGeom.zeroY,
      ),
    [netCashSeries, xScale, netGeom],
  );

  /** |H| / |E_end| — share of forecast (Target) exposure that is hedged. */
  const coverAbs = Math.abs(
    showRollingStrip ? activeStripCoverM : hedgeLevel,
  );
  const forecastAbs = Math.abs(pathEndM);
  const hedgedExposurePct =
    hasHedge && forecastAbs > 1e-12 ? (coverAbs / forecastAbs) * 100 : null;
  const unhedgedExposurePct =
    hedgedExposurePct != null ? Math.max(0, 100 - hedgedExposurePct) : null;

  const endOpenVarUsdM =
    hedgedVarProfile.length > 0
      ? hedgedVarProfile[hedgedVarProfile.length - 1]!.openVarUsdM
      : 0;
  /** Resid / open VaR at chart end — share of original VaR still unhedged. */
  const unhedgedVarPct =
    hasHedge && endOpenVarUsdM > 1e-12
      ? (Math.min(
          hedgedVarProfileGeom.endResidVarUsdM,
          endOpenVarUsdM,
        ) /
          endOpenVarUsdM) *
        100
      : null;

  const summaryMetrics = useMemo((): HedgePathSummaryMetrics => {
    const basisLabel =
      selectedBasis === 'cash'
        ? 'Expected stock'
        : selectedBasis === 'varNeutral'
          ? 'VaR-neutral'
          : 'Target';
    return {
      coverTitle: showRollingStrip
        ? `Strip cover · ${basisLabel}${stripAlreadyBooked ? ' · booked' : ''}`
        : `Hedge · ${basisLabel}`,
      coverValue: showRollingStrip
        ? Math.abs(activeStripCoverM) > 1e-9
          ? fmtM(activeStripCoverM)
          : '—'
        : hasHedge
          ? fmtM(hedgeLevel)
          : '—',
      coverPct: hedgedExposurePct != null ? fmtPct(hedgedExposurePct) : null,
      coverSub:
        hedgedExposurePct != null
          ? `of forecast E_end · ${fmtPct(unhedgedExposurePct!)} unhedged`
          : showRollingStrip && activeHedgeLegs.length > 0
            ? `M0 ${fmtM(activeHedgeLegs[0]!.amountLocalM)}${
                activeHedgeLegs.length > 1
                  ? ` · Σ ${fmtM(activeStripCoverM)}`
                  : ''
              }`
            : 'vs Target exposure',
      legsTitle: showRollingStrip ? 'Strip legs' : 'Forwards',
      legsValue: showRollingStrip
        ? `${activeHedgeLegs.length || rollingEdges.length}`
        : hasHedge
          ? '1'
          : '—',
      legsSub: showRollingStrip
        ? anyStripLegOff
          ? `${activeHedgeLegs.length} ticked · ${rollingEdges.length} program`
          : 'from M0'
        : 'bullet',
      residVarValue:
        hasHedge && hedgedVarProfile.length > 0
          ? fmtVarK(hedgedVarProfileGeom.endResidVarUsdM)
          : '—',
      residVarPct: unhedgedVarPct != null ? fmtPct(unhedgedVarPct) : null,
      residVarSub:
        hasHedge && hedgedVarProfile.length > 0
          ? `@ M${Math.round(hedgedVarProfile[hedgedVarProfile.length - 1]!.t)} · max ${fmtVarK(hedgedVarProfileGeom.maxResidVarUsdM)} @ M${Math.round(hedgedVarProfileGeom.maxResidT)}`
          : 'after hedge',
      breakevenValue: !hasHedge
        ? '—'
        : breakevenT != null
          ? fmtMonths(breakevenT)
          : startGap > 0
            ? 'always over'
            : 'always under',
      breakevenSub:
        showRollingStrip && hasHedge ? `vs Σ cover ${fmtM(hedgeLevel)}` : null,
    };
  }, [
    selectedBasis,
    showRollingStrip,
    stripAlreadyBooked,
    activeStripCoverM,
    hasHedge,
    hedgeLevel,
    hedgedExposurePct,
    unhedgedExposurePct,
    activeHedgeLegs,
    rollingEdges.length,
    anyStripLegOff,
    hedgedVarProfile,
    hedgedVarProfileGeom,
    unhedgedVarPct,
    breakevenT,
    startGap,
  ]);

  const onSummaryMetricsChangeRef = useRef(onSummaryMetricsChange);
  onSummaryMetricsChangeRef.current = onSummaryMetricsChange;
  const lastSummaryMetricsSigRef = useRef<string | null>(null);
  useEffect(() => {
    const sig = [
      summaryMetrics.coverTitle,
      summaryMetrics.coverValue,
      summaryMetrics.coverPct ?? '',
      summaryMetrics.coverSub,
      summaryMetrics.legsTitle,
      summaryMetrics.legsValue,
      summaryMetrics.legsSub,
      summaryMetrics.residVarValue,
      summaryMetrics.residVarPct ?? '',
      summaryMetrics.residVarSub,
      summaryMetrics.breakevenValue,
      summaryMetrics.breakevenSub ?? '',
    ].join('\0');
    // Parent setState on every paint (new object identity) → Maximum update depth.
    if (lastSummaryMetricsSigRef.current === sig) return;
    lastSummaryMetricsSigRef.current = sig;
    onSummaryMetricsChangeRef.current?.(summaryMetrics);
  }, [summaryMetrics]);
  useEffect(() => {
    return () => {
      lastSummaryMetricsSigRef.current = null;
      onSummaryMetricsChangeRef.current?.(null);
    };
  }, []);

  const showPrepareFooter =
    prepareCtaPlacement === 'footer' || prepareCtaPlacement === 'both';

  /** Restage prepared package when ticks / ladder / structure change. */
  const bookProfileRef = useRef(bookProfile);
  bookProfileRef.current = bookProfile;
  const canBookProfile = Boolean(onBookHedgeProfile || onBookRollingStrip);

  const prepareMeta = useMemo(() => {
    if (!canBookProfile) return null;
    const stripBooked = showRollingStrip && stripAlreadyBooked;
    const regimeLabel =
      selectedBasis === 'cash'
        ? 'Expected stock'
        : selectedBasis === 'totalExpected'
          ? 'Total'
          : 'VaR-neutral';
    const structureLabel = showRollingStrip
      ? `${activeLadderEdges.length}-leg strip`
      : 'bullet';
    return {
      label: stripBooked
        ? 'Strip booked (change regime / cancel to rebook)'
        : `Prebook ${regimeLabel} ${structureLabel}`,
      title: stripBooked
        ? 'Strip already on the book — cancel it to rebook'
        : showRollingStrip
          ? `Prebook ${activeLadderEdges.length}-leg strip (Hedge % applied) for Hedging Decision — Send under this CCY to book`
          : 'Prebook bullet for Hedging Decision — Send under this CCY to book',
      disabled: stripBooked,
      structure: effectiveStructure,
      edges: showRollingStrip ? activeLadderEdges : EMPTY_LADDER_EDGES,
    };
  }, [
    canBookProfile,
    showRollingStrip,
    stripAlreadyBooked,
    selectedBasis,
    activeLadderEdges,
    effectiveStructure,
  ]);

  const prepareActionKey = useMemo(() => {
    if (!prepareMeta) return '';
    const edgeKey = prepareMeta.edges
      .map(
        e =>
          `${e.index}:${e.endMonth.toFixed(4)}:${e.hedgeLocalM.toFixed(6)}`,
      )
      .join('|');
    return `${prepareMeta.label}\0${prepareMeta.title}\0${prepareMeta.disabled}\0${prepareMeta.structure}\0${edgeKey}`;
  }, [prepareMeta]);

  const onPrepareActionChangeRef = useRef(onPrepareActionChange);
  onPrepareActionChangeRef.current = onPrepareActionChange;
  const lastPrepareActionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!prepareMeta || !bookProfileRef.current) {
      if (lastPrepareActionKeyRef.current !== null) {
        lastPrepareActionKeyRef.current = null;
        onPrepareActionChangeRef.current?.(null);
      }
      return;
    }
    if (lastPrepareActionKeyRef.current === prepareActionKey) return;
    lastPrepareActionKeyRef.current = prepareActionKey;
    const { label, title, disabled, structure, edges } = prepareMeta;
    onPrepareActionChangeRef.current?.({
      label,
      title,
      disabled,
      run: () => bookProfileRef.current?.(structure, edges),
    });
  }, [prepareMeta, prepareActionKey]);
  useEffect(() => {
    return () => onPrepareActionChangeRef.current?.(null);
  }, []);
  const autoStageSig = useMemo(() => {
    if (!autoStagePrepared || !canBookProfile) return '';
    if (showRollingStrip) {
      const ladder = activeLadderEdges
        .map(
          e =>
            `${e.index}:${e.endMonth.toFixed(4)}:${e.hedgeLocalM.toFixed(6)}`,
        )
        .join(',');
      return `strip|${selectedBasis}|${stripCashDeliveryAt}|${ladder}`;
    }
    return `bullet|${selectedBasis}|${stripCashDeliveryAt}|${bulletSettleMonths.toFixed(4)}|${bulletCoverLocalM.toFixed(6)}`;
  }, [
    autoStagePrepared,
    canBookProfile,
    showRollingStrip,
    activeLadderEdges,
    selectedBasis,
    stripCashDeliveryAt,
    bulletSettleMonths,
    bulletCoverLocalM,
  ]);
  const lastAutoStageSigRef = useRef('');
  useEffect(() => {
    if (!autoStagePrepared || !bookProfileRef.current || !autoStageSig) return;
    // Parent sent a custom strip schedule but edges are still equal-spaced
    // (should not happen once parentScheduleEnds drives stripEdgeOpts).
    if (
      parentScheduleEnds != null &&
      parentScheduleEnds.length >= 2 &&
      showRollingStrip &&
      activeLadderEdges.length === parentScheduleEnds.length
    ) {
      const endsMatch = activeLadderEdges.every(
        (e, i) => Math.abs(e.endMonth - parentScheduleEnds[i]!) < 1e-3,
      );
      if (!endsMatch) return;
    } else if (
      parentScheduleEnds != null &&
      parentScheduleEnds.length >= 2 &&
      showRollingStrip &&
      activeLadderEdges.length !== parentScheduleEnds.length
    ) {
      return;
    }
    if (lastAutoStageSigRef.current === autoStageSig) return;
    lastAutoStageSigRef.current = autoStageSig;
    bookProfileRef.current(
      effectiveStructure,
      showRollingStrip ? activeLadderEdges : [],
    );
  }, [
    autoStageSig,
    autoStagePrepared,
    effectiveStructure,
    showRollingStrip,
    activeLadderEdges,
    parentScheduleEnds,
  ]);

  const coverControlDisabled =
    Math.abs(regimeTargetLocalM) < 1e-12 &&
    Math.abs(matchedEqualVarLocalM) < 1e-12 &&
    Math.abs(startM) < 1e-12;

  /** Custom chip — right of Target inside the regime segment group. */
  const renderCoverCustomButton = () => {
    const customOn = targetCoverPct !== 100 || coverModalOpen;
    return (
      <button
        type="button"
        title="Custom cover of target — open cover % settings"
        aria-label="Custom cover of target"
        aria-haspopup="dialog"
        aria-expanded={coverModalOpen}
        disabled={coverControlDisabled}
        onClick={() => setCoverModalOpen(true)}
        className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          customOn
            ? 'bg-amber-500/20 text-amber-100 shadow-sm'
            : 'text-slate-500 hover:text-slate-300'
        }`}
      >
        <GearIcon className="h-3.5 w-3.5" />
        Custom
        <span
          className={`font-mono text-[10px] font-normal tabular-nums ${
            customOn ? 'text-amber-200/80' : 'text-slate-500'
          }`}
        >
          {targetCoverPct}%
        </span>
      </button>
    );
  };

  /** Cover of target popup (above hedge-carry modal). */
  const renderCoverModal = () => {
    if (!coverModalOpen || typeof document === 'undefined') return null;
    const scaled = regimeTargetLocalM * coverScale;
    return createPortal(
      <div
        className="fixed inset-0 z-[310] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
        role="presentation"
        onMouseDown={e => {
          if (e.target === e.currentTarget) setCoverModalOpen(false);
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cover-of-target-title"
          className="sim-dark w-full max-w-sm rounded-xl border border-slate-600 bg-slate-900 p-4 shadow-2xl"
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h4
                id="cover-of-target-title"
                className="text-sm font-semibold text-slate-100"
              >
                Cover of target
              </h4>
              <p className="mt-0.5 text-[11px] text-slate-400">
                Scale hedge as % of the selected regime target
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCoverModalOpen(false)}
              className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
            >
              Close
            </button>
          </div>
          <CoverOfTargetStepper
            value={targetCoverPct}
            onChange={setTargetCoverPct}
            scaledLabel={fmtM(scaled)}
            disabled={coverControlDisabled}
            className="w-full"
          />
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setCoverModalOpen(false)}
              className="rounded border border-sky-500 bg-sky-600/20 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-600/35"
            >
              Done
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  };

  /** Bullet/Strip + Cash/VN/Target — inline (FX Risk) or gear panel (Cash Carry). */
  const renderPathStructureControls = () => (
    <div className="space-y-2">
      <div className="text-[10px] font-medium text-slate-400">
        Hedge structure · VaR {Th}m · forecast {Tf}m
      </div>
      <div
        className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
        role="group"
        aria-label="Hedge structure"
      >
        {(
          [
            {
              id: 'bullet' as const,
              label: 'Bullet',
              hint: 'One forward at t=0 for Cash / VaR-neutral / Target over full Tf',
              enabled: true,
            },
            {
              id: 'strip' as const,
              label: 'Forward strip',
              hint: rollingAvailable
                ? 'Set of M0 forwards — each expires at its tenor and delivers cash'
                : pathControlsInGear
                  ? 'Needs forecast ≥ 2 months'
                  : `Needs VaR tenor < forecast (now ${Th}m ≥ ${Tf}m)`,
              enabled: rollingAvailable,
            },
          ] as const
        ).map(opt => {
          const on = effectiveStructure === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              title={opt.hint}
              aria-pressed={on}
              disabled={!opt.enabled}
              onClick={() => setStructure(opt.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                on
                  ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {effectiveStructure === 'bullet' ? (
        <p className="text-[10px] leading-relaxed text-slate-400">
          <span className="text-slate-200">Bullet</span> — one M0 forward.
          Target = E_end; VN = Ē / CoG; Cash = stock.
        </p>
      ) : (
        <p className="text-[10px] leading-relaxed text-slate-400">
          <span className="text-slate-200">Forward strip</span> — set of M0
          forwards; each expires and delivers cash at its tenor.
        </p>
      )}
      <div className="border-t border-slate-800 pt-2">
        <div className="mb-1 text-[10px] text-slate-500">Apply hedge regime</div>
        <div
          className="inline-flex max-w-full min-w-0 flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
          role="group"
          aria-label="Apply hedge regime"
        >
          {HEDGE_PATH_BASIS_OPTIONS.map(opt => {
            const on = selectedBasis === opt.id;
            const stripEdges =
              opt.id === 'cash'
                ? rollingEdgesCash
                : opt.id === 'totalExpected'
                  ? rollingEdgesTotal
                  : opt.id === 'varNeutral'
                    ? rollingEdgesVarNeutral
                    : [];
            const useStrip = rolling && stripEdges.length > 1;
            const n = useStrip
              ? stripEdges[stripEdges.length - 1]!.hedgeLocalM
              : hedgeBasisNotionalLocalM(
                  opt.id,
                  startM,
                  pathEndM,
                  matchedEqualVarLocalM,
                );
            const n0 = useStrip ? stripEdges[0]!.hedgeLocalM : n;
            return (
              <button
                key={opt.id}
                type="button"
                title={
                  useStrip
                    ? `${opt.description} → preview ${stripEdges.length}-leg strip from M0 (cover ${fmtM(n)}, M0 ${fmtM(n0)}); use Book to commit`
                    : `${opt.description} → set Hedge N = ${fmtM(n)}`
                }
                disabled={
                  Math.abs(matchedEqualVarLocalM) < 1e-9 &&
                  Math.abs(startM) < 1e-9
                }
                onClick={() => {
                  onSelectedBasisChange(opt.id);
                  onApplyBasis(opt.id, effectiveStructure);
                }}
                aria-pressed={on}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  on
                    ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {opt.id === 'cash'
                  ? 'Expected stock'
                  : opt.id === 'varNeutral'
                    ? useStrip
                      ? 'VaR-neutral → strip'
                      : 'VaR-neutral'
                    : useStrip
                      ? 'Target → strip'
                      : 'Target (Total)'}
                <span
                  className={`ml-1 font-mono text-[10px] font-normal ${
                    on ? 'text-emerald-200/80' : 'text-slate-500'
                  }`}
                >
                  {fmtM(n)}
                </span>
              </button>
            );
          })}
          {renderCoverCustomButton()}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={
        pathControlsInGear
          ? 'space-y-3'
          : 'rounded-lg border border-slate-700 bg-slate-950/50 p-3'
      }
    >
      {renderCoverModal()}
      {summaryMetricsPlacement === 'inline' && (
      <div className="mb-2 grid gap-2 sm:grid-cols-4">
        <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-emerald-400/80">
            {summaryMetrics.coverTitle}
          </div>
          <div className="font-mono text-sm font-semibold text-emerald-200">
            {summaryMetrics.coverValue}
            {summaryMetrics.coverPct != null && (
              <span className="ml-1.5 text-[11px] font-semibold text-emerald-300/90">
                {summaryMetrics.coverPct}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[9px] text-emerald-200/60">
            {summaryMetrics.coverSub}
          </div>
        </div>
        <div className="rounded border border-blue-700/40 bg-blue-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-blue-400/80">
            {summaryMetrics.legsTitle}
          </div>
          <div className="font-mono text-sm font-semibold text-blue-200">
            {summaryMetrics.legsValue}
          </div>
          <div className="mt-0.5 text-[9px] text-blue-200/60">
            {summaryMetrics.legsSub}
          </div>
        </div>
        <div className="rounded border border-red-700/40 bg-red-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-red-400/80">
            Resid VaR
          </div>
          <div className="font-mono text-sm font-semibold text-red-200">
            {summaryMetrics.residVarValue}
            {summaryMetrics.residVarPct != null && (
              <span className="ml-1.5 text-[11px] font-semibold text-red-300/90">
                {summaryMetrics.residVarPct}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[9px] text-red-200/70">
            {summaryMetrics.residVarSub}
          </div>
        </div>
        <div className="rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-amber-400/80">
            Breakeven
          </div>
          <div className="font-mono text-sm font-semibold text-amber-200">
            {summaryMetrics.breakevenValue}
          </div>
          {summaryMetrics.breakevenSub != null && (
            <div className="mt-0.5 text-[9px] text-amber-200/70">
              {summaryMetrics.breakevenSub}
            </div>
          )}
        </div>
      </div>
      )}

      {showStructurePicker && (
        <div
          className={
            pathControlsInGear
              ? 'space-y-3'
              : 'mb-2 space-y-2 rounded-md border border-slate-700 bg-slate-950/40 px-2.5 py-2'
          }
        >
          {!pathControlsInGear && renderPathStructureControls()}

          {showHedgePerf && (
            <>
              <div
                className={
                  pathControlsInGear
                    ? 'rounded-md border border-slate-700/80 bg-slate-950/50 p-2'
                    : 'mb-2 rounded-md border border-slate-700/80 bg-slate-950/50 p-2'
                }
              >
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                  Resid VaR profile
                </div>
                {!pathControlsInGear && (
                <p className="mb-2 text-[9px] leading-relaxed text-slate-500">
                  Resid = V(t)·|e−H|/E with H = Σ ticked M0 forwards (from
                  day 0). Target mid-path resid ≠ 0 when e is below E_end.
                  Dots = table.
                </p>
                )}

                {hedgedVarProfile.length > 0 && (
                  <>
                    <svg
                      viewBox={`0 0 ${hedgedVarProfileGeom.W} ${hedgedVarProfileGeom.H}`}
                      className="mb-1 h-auto w-full max-w-full rounded border border-slate-800 bg-slate-950"
                      role="img"
                      aria-label={`${ccy} open VaR before hedge vs residual VaR`}
                    >
                      {hedgedVarProfileGeom.monthTicks.map(m => (
                        <g key={`hv-m-${m}`}>
                          <line
                            x1={hedgedVarProfileGeom.xScale(m)}
                            x2={hedgedVarProfileGeom.xScale(m)}
                            y1={hedgedVarProfileGeom.padT}
                            y2={
                              hedgedVarProfileGeom.H - hedgedVarProfileGeom.padB
                            }
                            stroke={
                              m === 0 ||
                              Math.abs(
                                m -
                                  (hedgedVarProfile[hedgedVarProfile.length - 1]
                                    ?.t ?? 0),
                              ) < 1e-9
                                ? '#475569'
                                : '#1e293b'
                            }
                          />
                          <text
                            x={hedgedVarProfileGeom.xScale(m)}
                            y={
                              hedgedVarProfileGeom.H -
                              hedgedVarProfileGeom.padB +
                              14
                            }
                            textAnchor="middle"
                            className="fill-slate-400"
                            style={{ fontSize: 9 }}
                          >
                            {Number.isInteger(m) ? `M${m}` : `${m.toFixed(1)}m`}
                          </text>
                        </g>
                      ))}
                      {/* Forecast vs beyond-forecast regions */}
                      {Tf > 0 &&
                        hedgedVarProfile[hedgedVarProfile.length - 1]!.t >
                          Tf + 1e-9 && (
                          <g>
                            <rect
                              x={hedgedVarProfileGeom.xScale(Tf)}
                              y={hedgedVarProfileGeom.padT}
                              width={Math.max(
                                0,
                                hedgedVarProfileGeom.xScale(
                                  hedgedVarProfile[
                                    hedgedVarProfile.length - 1
                                  ]!.t,
                                ) - hedgedVarProfileGeom.xScale(Tf),
                              )}
                              height={
                                hedgedVarProfileGeom.H -
                                hedgedVarProfileGeom.padT -
                                hedgedVarProfileGeom.padB
                              }
                              fill="rgba(148, 163, 184, 0.1)"
                              stroke="none"
                            />
                            <line
                              x1={hedgedVarProfileGeom.xScale(Tf)}
                              x2={hedgedVarProfileGeom.xScale(Tf)}
                              y1={hedgedVarProfileGeom.padT}
                              y2={
                                hedgedVarProfileGeom.H -
                                hedgedVarProfileGeom.padB
                              }
                              stroke="#94a3b8"
                              strokeWidth={1.25}
                              strokeDasharray="3 3"
                            />
                            <text
                              x={
                                (hedgedVarProfileGeom.padL +
                                  hedgedVarProfileGeom.xScale(Tf)) /
                                2
                              }
                              y={hedgedVarProfileGeom.padT - 4}
                              textAnchor="middle"
                              className="fill-slate-500"
                              style={{ fontSize: 8 }}
                            >
                              forecast
                            </text>
                            <text
                              x={
                                (hedgedVarProfileGeom.xScale(Tf) +
                                  hedgedVarProfileGeom.W -
                                  hedgedVarProfileGeom.padR) /
                                2
                              }
                              y={hedgedVarProfileGeom.padT - 4}
                              textAnchor="middle"
                              className="fill-slate-400"
                              style={{ fontSize: 8, fontWeight: 600 }}
                            >
                              beyond Tf · resid evolves
                            </text>
                          </g>
                        )}
                      {/* End resid level — light horizontal guide */}
                      <line
                        x1={hedgedVarProfileGeom.padL}
                        x2={
                          hedgedVarProfileGeom.W - hedgedVarProfileGeom.padR
                        }
                        y1={hedgedVarProfileGeom.yScale(
                          hedgedVarProfileGeom.endResidVarUsdM,
                        )}
                        y2={hedgedVarProfileGeom.yScale(
                          hedgedVarProfileGeom.endResidVarUsdM,
                        )}
                        stroke="#e2e8f0"
                        strokeWidth={1}
                        strokeDasharray="4 3"
                        opacity={0.4}
                      />
                      {/* Reduction band: open VaR − resid */}
                      {hedgedVarProfileGeom.reductionArea && (
                        <path
                          d={hedgedVarProfileGeom.reductionArea}
                          fill="rgba(52, 211, 153, 0.22)"
                          stroke="none"
                        />
                      )}
                      {/* Original open VaR before hedge (dashed) */}
                      <path
                        d={hedgedVarProfileGeom.openLine}
                        fill="none"
                        stroke="#94a3b8"
                        strokeWidth={1.75}
                        strokeDasharray="4 3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={0.95}
                      />
                      <path
                        d={hedgedVarProfileGeom.residLine}
                        fill="none"
                        stroke="#fcd34d"
                        strokeWidth={2.25}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={0.95}
                      />
                      {/* Forward maturity marks on yellow resid (strip legs / bullet) */}
                      {hedgedVarProfileGeom.legMarks.map(mark => (
                        <g key={`fwd-${mark.label}-${mark.t}`}>
                          <line
                            x1={hedgedVarProfileGeom.xScale(mark.t)}
                            x2={hedgedVarProfileGeom.xScale(mark.t)}
                            y1={hedgedVarProfileGeom.padT}
                            y2={
                              hedgedVarProfileGeom.H -
                              hedgedVarProfileGeom.padB
                            }
                            stroke="#fcd34d"
                            strokeWidth={1}
                            strokeDasharray="2 3"
                            opacity={0.55}
                          />
                          <circle
                            cx={hedgedVarProfileGeom.xScale(mark.t)}
                            cy={hedgedVarProfileGeom.yScale(mark.hedgedVarUsdM)}
                            r={4.5}
                            fill="#fbbf24"
                            stroke="#0f172a"
                            strokeWidth={1.25}
                          />
                          <text
                            x={hedgedVarProfileGeom.xScale(mark.t)}
                            y={
                              hedgedVarProfileGeom.yScale(mark.hedgedVarUsdM) -
                              8
                            }
                            textAnchor="middle"
                            className="fill-amber-200"
                            style={{ fontSize: 8, fontWeight: 600 }}
                          >
                            {mark.label}
                          </text>
                        </g>
                      ))}
                      {/* BE mark — same (t, resid) knot as the yellow stroke */}
                      {hedgedVarProfileGeom.beMark != null && (
                        <g key={`var-be-${hedgedVarProfileGeom.beMark.t}`}>
                          <line
                            x1={hedgedVarProfileGeom.xScale(
                              hedgedVarProfileGeom.beMark.t,
                            )}
                            x2={hedgedVarProfileGeom.xScale(
                              hedgedVarProfileGeom.beMark.t,
                            )}
                            y1={hedgedVarProfileGeom.padT}
                            y2={
                              hedgedVarProfileGeom.H -
                              hedgedVarProfileGeom.padB
                            }
                            stroke="#fbbf24"
                            strokeWidth={1.25}
                            strokeDasharray="4 3"
                          />
                          <circle
                            cx={hedgedVarProfileGeom.xScale(
                              hedgedVarProfileGeom.beMark.t,
                            )}
                            cy={hedgedVarProfileGeom.yScale(
                              hedgedVarProfileGeom.beMark.hedgedVarUsdM,
                            )}
                            r={4}
                            fill="#fbbf24"
                            stroke="#0f172a"
                            strokeWidth={1}
                          />
                          <text
                            x={hedgedVarProfileGeom.xScale(
                              hedgedVarProfileGeom.beMark.t,
                            )}
                            y={hedgedVarProfileGeom.padT - 4}
                            textAnchor="middle"
                            className="fill-amber-300"
                            style={{ fontSize: 8, fontWeight: 600 }}
                          >
                            BE {fmtMonths(hedgedVarProfileGeom.beMark.t)}
                          </text>
                        </g>
                      )}
                      <text
                        x={hedgedVarProfileGeom.padL}
                        y={hedgedVarProfileGeom.padT + 8}
                        className="fill-slate-500"
                        style={{ fontSize: 8 }}
                      >
                        {fmtVarK(hedgedVarProfileGeom.maxVar)}
                      </text>
                      <text
                        x={hedgedVarProfileGeom.padL + 4}
                        y={
                          hedgedVarProfileGeom.yScale(
                            hedgedVarProfileGeom.endResidVarUsdM,
                          ) - 4
                        }
                        textAnchor="start"
                        className="fill-slate-300"
                        style={{ fontSize: 8 }}
                      >
                        resid @ M
                        {Math.round(
                          hedgedVarProfile[hedgedVarProfile.length - 1]?.t ??
                            Tf,
                        )}{' '}
                        {fmtVarK(hedgedVarProfileGeom.endResidVarUsdM)}
                      </text>
                    </svg>
                    <div className="mt-1.5 flex flex-wrap gap-3 text-[9px] text-slate-500">
                      <span>
                        <span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-slate-400 align-middle" />
                        Open VaR (before hedge)
                      </span>
                      <span>
                        <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-emerald-400/30 align-middle" />
                        Reduction
                      </span>
                      <span>
                        <span className="mr-1 inline-block h-0.5 w-3 bg-amber-300 align-middle" />
                        Remaining resid
                      </span>
                      <span className="text-amber-200/90">
                        · dots = forward maturity
                      </span>
                      <span className="text-amber-300/80">· BE</span>
                      <span className="text-slate-400">
                        · light line = resid @ window end
                      </span>
                    </div>
                  </>
                )}

                {(() => {
                  const stripScheduleEditor = showRollingStrip ? (
                    <div
                      className={
                        schedulePanelExternal
                          ? 'space-y-2'
                          : 'mb-2 rounded-md border border-slate-700/80 bg-slate-950/70 p-2'
                      }
                    >
                      {schedulePanelExternal && (
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-[9px] font-medium uppercase tracking-wide text-slate-500">
                            {scheduleExternalEditing
                              ? 'Schedule setup · gear'
                              : 'Strip schedule · tick trades · review'}
                          </div>
                          {renderStripLegsToolbar({
                            showGear: true,
                            gearPressed:
                              scheduleExternalEditing ||
                              stripScheduleMode === 'custom',
                            gearTitle: scheduleExternalEditing
                              ? 'Close schedule setup'
                              : 'Schedule setup — settle dates · Sched % · Hedge %',
                            onGearClick: () =>
                              setScheduleExternalEditing(v => !v),
                          })}
                        </div>
                      )}

                      {pathControlsInGear && !schedulePanelExternal && (
                        <div className="mb-3 border-b border-slate-800 pb-3">
                          {renderPathStructureControls()}
                        </div>
                      )}
                      {!schedulePanelExternal && (
                      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                        Strip schedule
                      </div>
                      )}
                      {!schedulePanelExternal && (
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <div className="inline-flex items-center gap-1">
                          <div
                            className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
                            role="group"
                            aria-label="Strip schedule mode"
                          >
                            <button
                              type="button"
                              aria-pressed={
                                stripScheduleMode === 'equal' &&
                                weightPreset === 'equal'
                              }
                              onClick={() => {
                                setStripScheduleMode('equal');
                                commitCustomEnds(null);
                                setScheduleWeights(null);
                                setWeightPreset('equal');
                              }}
                              className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                                stripScheduleMode === 'equal' &&
                                weightPreset === 'equal'
                                  ? 'bg-emerald-500/20 text-emerald-100'
                                  : 'text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              Equal spacing
                            </button>
                            <button
                              type="button"
                              aria-pressed={weightPreset === 'front'}
                              onClick={() => {
                                applyScheduleWeights(
                                  rampStripScheduleWeights(
                                    effectiveStripLegs,
                                    'front',
                                  ),
                                  'front',
                                );
                              }}
                              title="More Sched % / hedge on the front (near) — e.g. when short rates are more attractive"
                              className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                                weightPreset === 'front'
                                  ? 'bg-sky-500/20 text-sky-100'
                                  : 'text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              Front-loaded
                            </button>
                            <button
                              type="button"
                              aria-pressed={weightPreset === 'back'}
                              onClick={() => {
                                applyScheduleWeights(
                                  rampStripScheduleWeights(
                                    effectiveStripLegs,
                                    'back',
                                  ),
                                  'back',
                                );
                              }}
                              title="More Sched % / hedge on the back (far) — e.g. to pick up higher long-end rates / carry"
                              className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                                weightPreset === 'back'
                                  ? 'bg-sky-500/20 text-sky-100'
                                  : 'text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              Back-loaded
                            </button>
                            <button
                              type="button"
                              aria-pressed={
                                stripScheduleMode === 'custom' &&
                                weightPreset === 'custom'
                              }
                              onClick={openCustomSchedule}
                              className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                                stripScheduleMode === 'custom' &&
                                weightPreset === 'custom'
                                  ? 'bg-amber-500/20 text-amber-100'
                                  : 'text-slate-500 hover:text-slate-300'
                              }`}
                            >
                              Custom dates
                            </button>
                          </div>
                          <InfoTip label="Strip schedule mode help">
                            <p>
                              Equal = even windows Tf/n. Front / Back skew Sched
                              %. Type any Sched % in a row — that row keeps your
                              value; others rescale to 100%.
                            </p>
                          </InfoTip>
                        </div>
                        <div className="inline-flex items-center gap-1">
                          <div
                            className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
                            role="group"
                            aria-label="Cash delivery timing"
                          >
                            {(
                              [
                                {
                                  id: 'periodEnd' as const,
                                  label: 'Period end',
                                  title:
                                    'Settle at window end — FWD CIP + carry to that tenor on the curve',
                                },
                                {
                                  id: 'periodStart' as const,
                                  label: 'Period start',
                                  title:
                                    'Settle at window open — short/zero FWD tenor; USD carry from then to Tf',
                                },
                                {
                                  id: 'matchExposure' as const,
                                  label: 'e ∩ H match',
                                  title:
                                    'Settle when e(t) first matches that cumul H — carry uses that exact curve point',
                                },
                              ] as const
                            ).map(opt => {
                              const on = stripCashDeliveryAt === opt.id;
                              return (
                                <button
                                  key={opt.id}
                                  type="button"
                                  title={opt.title}
                                  aria-pressed={on}
                                  onClick={() => setStripCashDeliveryAt(opt.id)}
                                  className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                                    on
                                      ? 'bg-amber-500/20 text-amber-100'
                                      : 'text-slate-500 hover:text-slate-300'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                          <InfoTip label="Cash settlement help">
                            <p className="mb-1.5 font-semibold text-slate-200">
                              Cash settlement (forward curve)
                            </p>
                            <p>
                              Real settlement moment per leg — Carry uses CIP /
                              interest to these points; Prebook stamps ticket
                              maturity from them. Amber dots mark the same
                              settle.
                            </p>
                            <ul className="mt-1.5 list-disc space-y-0.5 pl-3 text-slate-400">
                              <li>
                                Period end — settle at window end (CIP + carry
                                to that tenor)
                              </li>
                              <li>
                                Period start — settle at window open; USD carry
                                from then to Tf
                              </li>
                              <li>
                                e ∩ H match — settle when e(t) first matches
                                cumul H
                              </li>
                            </ul>
                          </InfoTip>
                        </div>
                      </div>
                      )}
                      {/* External review: tick-trades table (Performance model) */}
                      {schedulePanelExternal && !scheduleExternalEditing && (
                        <table className="w-full min-w-[560px] text-left text-[10px]">
                          <thead>
                            <tr className="text-slate-500">
                              <th
                                className="py-1 pr-1 font-medium"
                                title="Include in resid VaR / green H"
                              >
                                On
                              </th>
                              <th className="py-1 pr-2 font-medium">Forward</th>
                              <th className="py-1 pr-2 font-medium text-amber-200/80">
                                Settle
                              </th>
                              <th className="py-1 pr-2 text-right font-medium text-amber-200/80">
                                Sched %
                              </th>
                              <th className="py-1 pr-2 text-right font-medium text-sky-300/90">
                                Hedge %
                              </th>
                              <th className="py-1 pr-2 text-right font-medium">
                                Δ
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {hedgeLegs.map((leg, i) => {
                              const on = enabledLegIds[leg.index] !== false;
                              const sw = displayScheduleWeights[i] ?? 0;
                              const nw = notionalWeights[i] ?? 0;
                              const settleMonths =
                                (customEndMonths ?? activeEndMonths)[i] ??
                                leg.tenureMonths;
                              return (
                                <tr
                                  key={`rev-${leg.index}`}
                                  className={`border-t border-slate-800/80 font-mono text-slate-300 ${
                                    on ? '' : 'opacity-40'
                                  }`}
                                >
                                  <td className="py-1 pr-1">
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      onChange={() =>
                                        setEnabledLegIds(prev => ({
                                          ...prev,
                                          [leg.index]: !on,
                                        }))
                                      }
                                      className="h-3.5 w-3.5 cursor-pointer rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500/40"
                                      title={
                                        on
                                          ? 'Exclude trade from resid VaR profile'
                                          : 'Include trade in resid VaR profile'
                                      }
                                    />
                                  </td>
                                  <td className="py-1 pr-2 text-slate-300">
                                    {leg.label}
                                  </td>
                                  <td className="py-1 pr-2 text-amber-200/90">
                                    M
                                    {settleMonths.toFixed(
                                      settleMonths % 1 === 0 ? 0 : 1,
                                    )}
                                  </td>
                                  <td className="py-1 pr-2 text-right text-slate-400">
                                    {(sw * 100).toFixed(1)}%
                                  </td>
                                  <td className="py-1 pr-2 text-right text-sky-200/90">
                                    {(nw * 100).toFixed(1)}%
                                  </td>
                                  <td className="py-1 pr-2 text-right text-emerald-300/90">
                                    {fmtM(leg.amountLocalM)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                      {/* Schedule setup — settle + Sched % in one editable table */}
                      {(!schedulePanelExternal || scheduleExternalEditing) && (
                      <div className="mt-2 rounded border border-amber-500/30 bg-slate-950/50 p-1.5">
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                          <div className="text-[9px] font-semibold uppercase tracking-wide text-amber-200/90">
                            Schedule setup
                            <span className="ml-1 font-normal normal-case tracking-normal text-slate-500">
                              ·{' '}
                              {weightPreset === 'front'
                                ? 'front-loaded'
                                : weightPreset === 'back'
                                  ? 'back-loaded'
                                  : weightPreset === 'equal' ||
                                      stripScheduleMode === 'equal'
                                    ? 'equal'
                                    : 'custom'}
                              {stripScheduleMode === 'custom'
                                ? ' · M0 → each settle'
                                : ''}
                            </span>
                          </div>
                          <div className="text-[8px] text-slate-500">
                            Settle = today + Sched% × Tf days · all dates
                            editable (≤ Tf)
                          </div>
                        </div>
                        <table className="w-full text-left text-[9px]">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="py-0.5 pr-1 font-medium">Leg</th>
                              <th
                                className="py-0.5 pr-1 font-medium text-amber-200/80"
                                title={`Calendar settle = today + cumulative days from Sched % × Tf (${Tf}m ≈ ${Math.round(Tf * DAYS_PER_MONTH)}d). Final leg date is editable (defaults to Tf).`}
                              >
                                Settle date
                              </th>
                              <th
                                className="py-0.5 pr-1 font-medium text-amber-200/80"
                                title="Share of forecast Tf for this leg’s window (and hedge Δ). Edit any row — that % sticks; other legs rescale to 100%. Front/Back presets skew near vs far for carry."
                              >
                                Sched % of Tf
                              </th>
                              <th
                                className="py-0.5 pr-1 font-medium text-sky-300/90"
                                title="Hedge notional share of Σ strip cover. Editable — pin any row; others fill to 100%. Blank/Auto = regime-sized mix."
                              >
                                Hedge %
                              </th>
                              <th className="py-0.5 pr-1 font-medium">Δ (out)</th>
                              <th className="py-0.5 w-6 font-medium" />
                            </tr>
                          </thead>
                          <tbody>
                            {hedgeLegs.map((leg, i) => {
                              const sw = displayScheduleWeights[i] ?? 0;
                              const nw = notionalWeights[i] ?? 0;
                              const settleMonths =
                                (customEndMonths ?? activeEndMonths)[i] ??
                                leg.tenureMonths;
                              const settleDays = Math.round(
                                settleMonths * DAYS_PER_MONTH,
                              );
                              const settleIso = toDateInputValue(
                                settleDateFromMonths(settleMonths),
                              );
                              const isLast = i === hedgeLegs.length - 1;
                              const draft =
                                schedPctDraft?.index === i
                                  ? schedPctDraft.value
                                  : String(Math.round(sw * 100));
                              return (
                                <tr
                                  key={`w-${leg.index}`}
                                  className="border-t border-slate-800/80 font-mono text-slate-300"
                                >
                                  <td className="py-0.5 pr-1 text-slate-400">
                                    {i + 1}
                                  </td>
                                  <td className="py-0.5 pr-1">
                                    <span className="inline-flex flex-col gap-0.5">
                                      <input
                                        type="date"
                                        value={settleIso}
                                        min={toDateInputValue(
                                          i > 0
                                            ? settleDateFromMonths(
                                                Math.max(
                                                  0.05,
                                                  ((customEndMonths ??
                                                    activeEndMonths)[i - 1] ??
                                                    0) + 0.05,
                                                ),
                                              )
                                            : startOfLocalDay(),
                                        )}
                                        max={toDateInputValue(
                                          settleDateFromMonths(
                                            i < hedgeLegs.length - 1
                                              ? Math.max(
                                                  0.1,
                                                  ((customEndMonths ??
                                                    activeEndMonths)[i + 1] ??
                                                    Tf) - 0.05,
                                                )
                                              : Tf,
                                          ),
                                        )}
                                        onChange={ev =>
                                          updateCustomEndFromDate(
                                            i,
                                            ev.target.value,
                                          )
                                        }
                                        className="rounded border border-amber-500/40 bg-slate-900 px-1 py-0.5 text-[10px] text-amber-200 focus:border-amber-400 focus:outline-none"
                                        title={
                                          isLast
                                            ? `Final settle (editable, ≤ Tf=${Tf}m). Today + ${settleDays}d · M${settleMonths.toFixed(settleMonths % 1 === 0 ? 0 : 1)}`
                                            : `Default: today + ${settleDays}d (Sched share of Tf=${Tf}m ≈ ${Math.round(Tf * DAYS_PER_MONTH)}d)`
                                        }
                                      />
                                      <span className="text-[8px] font-sans text-slate-500">
                                        +{settleDays}d · M
                                        {settleMonths.toFixed(
                                          settleMonths % 1 === 0 ? 0 : 1,
                                        )}
                                        {isLast ? ' · final' : ''}
                                      </span>
                                    </span>
                                  </td>
                                  <td className="py-0.5 pr-1">
                                    <span className="inline-flex items-center gap-0.5">
                                      <input
                                        type="number"
                                        min={1}
                                        max={99}
                                        step="any"
                                        value={draft}
                                        onFocus={() =>
                                          setSchedPctDraft({
                                            index: i,
                                            value: String(
                                              Math.round(sw * 1000) / 10,
                                            ),
                                          })
                                        }
                                        onChange={ev =>
                                          setSchedPctDraft({
                                            index: i,
                                            value: ev.target.value,
                                          })
                                        }
                                        onBlur={() => {
                                          if (schedPctDraft?.index !== i) {
                                            setSchedPctDraft(null);
                                            return;
                                          }
                                          const n = Number(schedPctDraft.value);
                                          setSchedPctDraft(null);
                                          if (Number.isFinite(n) && n > 0) {
                                            updateScheduleWeightAt(i, n);
                                          }
                                        }}
                                        onKeyDown={ev => {
                                          if (ev.key === 'Enter') {
                                            (
                                              ev.target as HTMLInputElement
                                            ).blur();
                                          }
                                        }}
                                        className="w-14 rounded border border-amber-500/40 bg-slate-900 px-1 py-0.5 text-amber-200 focus:border-amber-400 focus:outline-none"
                                        title={`Type any % for this leg (1–99). It keeps that value; other legs share the rest. Tf=${Tf}m ≈ ${Math.round(Tf * DAYS_PER_MONTH)}d.`}
                                      />
                                      <span className="text-slate-500">%</span>
                                    </span>
                                  </td>
                                  <td className="py-0.5 pr-1">
                                    <span className="inline-flex items-center gap-0.5">
                                      <input
                                        type="number"
                                        min={1}
                                        max={99}
                                        step="any"
                                        value={
                                          hedgeShareDraft?.index === i
                                            ? hedgeShareDraft.value
                                            : String(
                                                Math.round(nw * 1000) / 10,
                                              )
                                        }
                                        onFocus={() =>
                                          setHedgeShareDraft({
                                            index: i,
                                            value: String(
                                              Math.round(nw * 1000) / 10,
                                            ),
                                          })
                                        }
                                        onChange={ev =>
                                          setHedgeShareDraft({
                                            index: i,
                                            value: ev.target.value,
                                          })
                                        }
                                        onBlur={() => {
                                          if (hedgeShareDraft?.index !== i) {
                                            setHedgeShareDraft(null);
                                            return;
                                          }
                                          const n = Number(
                                            hedgeShareDraft.value,
                                          );
                                          setHedgeShareDraft(null);
                                          if (Number.isFinite(n) && n > 0) {
                                            updateHedgeShareAt(i, n);
                                          }
                                        }}
                                        onKeyDown={ev => {
                                          if (ev.key === 'Enter') {
                                            (
                                              ev.target as HTMLInputElement
                                            ).blur();
                                          }
                                        }}
                                        className="w-14 rounded border border-sky-500/40 bg-slate-900 px-1 py-0.5 text-sky-200 focus:border-sky-400 focus:outline-none"
                                        title="Share of total strip hedge notional on this leg. Keeps your %; other legs rescale."
                                      />
                                      <span className="text-slate-500">%</span>
                                    </span>
                                  </td>
                                  <td className="py-0.5 pr-1 text-emerald-300/90">
                                    {fmtM(leg.amountLocalM)}
                                  </td>
                                  <td className="py-0.5">
                                    {!isLast && hedgeLegs.length > 2 ? (
                                      <button
                                        type="button"
                                        onClick={() => removeCustomEndAt(i)}
                                        className="rounded px-1 text-[9px] text-slate-500 hover:text-rose-300"
                                        title="Remove this maturity"
                                      >
                                        ✕
                                      </button>
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={hedgeLegs.length >= maxStripLegs}
                            onClick={addCustomEnd}
                            className="rounded border border-slate-700 px-2 py-0.5 text-[10px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                          >
                            + Add maturity
                          </button>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[8px] text-slate-600">
                              Sched % = timing windows. Hedge % = notional mix
                              (carry tilt). Settle defaults from today + Sched
                              share of Tf.
                            </span>
                            {(stripScheduleMode !== 'equal' ||
                              weightPreset !== 'equal' ||
                              scheduleWeights != null) && (
                              <button
                                type="button"
                                onClick={resetSchedulePct}
                                className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] font-medium text-amber-200/90 hover:bg-slate-800"
                                title="Reset Sched % to equal windows for the current leg count"
                              >
                                Reset Sched %
                              </button>
                            )}
                            {hedgeShareWeights != null && (
                              <button
                                type="button"
                                onClick={() => {
                                  commitHedgeShares(null);
                                  setHedgeShareDraft(null);
                                }}
                                className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] font-medium text-sky-300/90 hover:bg-slate-800"
                                title="Clear custom Hedge % — back to regime-sized mix"
                              >
                                Reset Hedge %
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      )}
                      {schedulePanelExternal && scheduleExternalEditing && (
                        <div className="flex justify-end border-t border-slate-800 pt-2">
                          <button
                            type="button"
                            onClick={() => setScheduleExternalEditing(false)}
                            className="rounded-md border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/25"
                            title="Return to review · tick trades"
                          >
                            Done
                          </button>
                        </div>
                      )}
                      {!schedulePanelExternal && (
                      <div className="mt-3 flex justify-end border-t border-slate-800 pt-2">
                        <button
                          type="button"
                          onClick={() => setStripScheduleOpen(false)}
                          className="rounded-md border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/25"
                          title="Apply schedule settings and return to Performance table"
                        >
                          Apply & close
                        </button>
                      </div>
                      )}
                    
                    </div>
                  ) : null;

                  const performancePanel =
                    performancePanelPlacement === 'external' ? (
                      <div className="overflow-x-auto rounded-md border border-slate-700 bg-slate-950/50 p-2">
                        {renderPathStructureControls()}
                      </div>
                    ) : (
                <div className="mt-2 overflow-x-auto">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[9px] font-medium uppercase tracking-wide text-slate-500">
                      {stripScheduleOpen && !schedulePanelExternal
                          ? showRollingStrip
                            ? 'Schedule setup · edit Sched % of Tf (gear)'
                            : 'Bullet setup · cash delivery (gear)'
                          : 'Performance · tick trades to show/hide green hedge'}
                    </div>
                    {showRollingStrip ? (
                      schedulePanelExternal ? (
                        <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-1.5 py-0.5">
                          <span className="text-[9px] text-slate-600">
                            Legs → Optimal strip
                          </span>
                          <span className="text-[9px] text-slate-600">|</span>
                          <button
                            type="button"
                            title={
                              scheduleExternalEditing
                                ? 'Close schedule setup'
                                : 'Schedule setup — settle · Sched % · Hedge %'
                            }
                            aria-label="Schedule setup settings"
                            aria-pressed={
                              scheduleExternalEditing ||
                              stripScheduleMode === 'custom'
                            }
                            onClick={() =>
                              setScheduleExternalEditing(v => !v)
                            }
                            className={`inline-flex h-6 w-6 items-center justify-center rounded ${
                              scheduleExternalEditing ||
                              stripScheduleMode === 'custom'
                                ? 'bg-amber-500/20 text-amber-200'
                                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                            }`}
                          >
                            <GearIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        renderStripLegsToolbar({ showGear: true })
                      )
                    ) : (
                      <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-1.5 py-0.5">
                        <span className="text-[9px] text-slate-500">
                          {stripCashDeliveryAt === 'periodStart'
                            ? 'Settle @ period start'
                            : stripCashDeliveryAt === 'matchExposure'
                              ? 'Settle @ e ∩ H'
                              : 'Settle @ period end'}
                          <span className="ml-1 font-mono text-amber-200/90">
                            M{Math.round(bulletSettleMonths)}
                          </span>
                        </span>
                        <span className="text-[9px] text-slate-600">|</span>
                        <button
                          type="button"
                          title={
                            pathControlsInGear
                              ? 'Hedge setup — structure, regime, cash delivery'
                              : 'Bullet cash delivery — Period end / start / e ∩ H'
                          }
                          aria-label={
                            pathControlsInGear
                              ? 'Hedge setup settings'
                              : 'Bullet cash delivery settings'
                          }
                          aria-pressed={stripScheduleOpen}
                          onClick={() => setStripScheduleOpen(o => !o)}
                          className={`inline-flex h-6 w-6 items-center justify-center rounded ${
                            stripScheduleOpen ||
                            stripCashDeliveryAt !== 'periodEnd'
                              ? 'bg-amber-500/20 text-amber-200'
                              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                          }`}
                        >
                          <GearIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                  {!showRollingStrip && stripScheduleOpen && !schedulePanelExternal && (
                    <div className="mb-2 rounded-md border border-slate-700/80 bg-slate-950/70 p-2">
                      {pathControlsInGear && (
                        <div className="mb-3 border-b border-slate-800 pb-3">
                          {renderPathStructureControls()}
                        </div>
                      )}
                      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                        Bullet cash delivery
                        <span className="font-mono text-[10px] font-normal normal-case tracking-normal text-amber-200/90">
                          · settle M{Math.round(bulletSettleMonths)} · cover{' '}
                          {fmtM(bulletCoverLocalM)}
                        </span>
                      </div>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <div className="inline-flex items-center gap-1">
                          <div
                            className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
                            role="group"
                            aria-label="Bullet cash delivery timing"
                          >
                            {(
                              [
                                {
                                  id: 'periodEnd' as const,
                                  label: 'Period end',
                                  title:
                                    'Settle at Tf — FWD CIP + carry to forecast end',
                                },
                                {
                                  id: 'periodStart' as const,
                                  label: 'Period start',
                                  title:
                                    'Settle at M0 — short/zero FWD tenor; USD carry from then to Tf',
                                },
                                {
                                  id: 'matchExposure' as const,
                                  label: 'e ∩ H match',
                                  title:
                                    'Settle when e(t) first matches bullet H — carry uses that curve point',
                                },
                              ] as const
                            ).map(opt => {
                              const on = stripCashDeliveryAt === opt.id;
                              return (
                                <button
                                  key={opt.id}
                                  type="button"
                                  title={opt.title}
                                  aria-pressed={on}
                                  onClick={() => setStripCashDeliveryAt(opt.id)}
                                  className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                                    on
                                      ? 'bg-amber-500/20 text-amber-100'
                                      : 'text-slate-500 hover:text-slate-300'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                          <InfoTip label="Bullet cash settlement help">
                            <p className="mb-1.5 font-semibold text-slate-200">
                              Cash settlement (forward curve)
                            </p>
                            <p>
                              Real settlement for the single bullet forward —
                              Carry uses CIP / interest to this point; Prebook
                              stamps ticket maturity from it. Amber marker on
                              the path chart marks the same settle.
                            </p>
                            <ul className="mt-1.5 list-disc space-y-0.5 pl-3 text-slate-400">
                              <li>
                                Period end — settle at Tf (default)
                              </li>
                              <li>
                                Period start — settle at M0; USD carry M0→Tf
                              </li>
                              <li>
                                e ∩ H match — settle when e(t) first matches H
                              </li>
                            </ul>
                          </InfoTip>
                        </div>
                      </div>
                      <div className="mt-3 flex justify-end border-t border-slate-800 pt-2">
                        <button
                          type="button"
                          onClick={() => setStripScheduleOpen(false)}
                          className="rounded-md border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/25"
                          title="Apply cash delivery and return to Performance table"
                        >
                          Apply & close
                        </button>
                      </div>
                    </div>
                  )}
                  {stripScheduleEditor != null
                    && stripScheduleOpen
                    && !schedulePanelExternal
                    && stripScheduleEditor}
                  {/* Performance metrics — hidden while inline schedule / bullet setup is open */}
                  {(!stripScheduleOpen || schedulePanelExternal) && (
                  <>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-700/80 bg-slate-950/60 px-2 py-1.5 text-[10px]">
                    <span className="text-slate-400">
                      Carry rates ·{' '}
                      <span className="font-mono text-slate-300">
                        {marketRates.sourceFile}
                      </span>
                      {' · '}
                      {(() => {
                        const on = resolveOvernightCashRates(marketRates, ccy);
                        const fwd = resolveForwardDepositRates(
                          marketRates,
                          ccy,
                          1,
                        );
                        return (
                          <span className="font-mono text-amber-200/90">
                            ON {ccy} {on.fcy.creditPct.toFixed(2)}%/
                            {on.fcy.debitPct.toFixed(2)}% · fwd 1M{' '}
                            {fwd.fcy.creditPct.toFixed(2)}%/
                            {fwd.fcy.debitPct.toFixed(2)}%
                          </span>
                        );
                      })()}
                    </span>
                    <button
                      type="button"
                      onClick={() => setMarketRates(getActiveMarketRates())}
                      className="rounded border border-slate-600 px-1.5 py-0.5 text-[9px] text-sky-300/90 hover:bg-slate-800"
                      title="Reload rates from Market data tab"
                    >
                      Refresh from Market data
                    </button>
                  </div>
                  <table className="w-full min-w-[720px] text-left text-[10px]">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="py-1 pr-1 font-medium" title="Include in resid VaR profile">
                          On
                        </th>
                        <th className="py-1 pr-2 font-medium">
                          {showRollingStrip ? 'Forward / t' : 'Forward'}
                        </th>
                        <th
                          className="py-1 pr-2 font-medium"
                          title="Incremental size of this forward (Δ notional)"
                        >
                          Hedge Δ
                        </th>
                        <th
                          className="py-1 pr-2 font-medium"
                          title="Booked cover H = Σ ticked M0 forwards (all live from day 0)"
                        >
                          H @ t
                        </th>
                        <th
                          className="py-1 pr-2 font-medium"
                          title="Accrued exposure path e(t) at this tenure"
                        >
                          e @ t
                        </th>
                        <th
                          className="py-1 pr-2 font-medium"
                          title="Absolute mismatch |e(t) − H(t)| — drives resid VaR scale"
                        >
                          |e−H|
                        </th>
                        <th className="py-1 pr-2 font-medium">Open VaR</th>
                        <th className="py-1 pr-2 font-medium">Resid VaR</th>
                        <th
                          className="py-1 pr-2 font-medium"
                          title="Total path carry ($K): FWD CIP + FCY int (recognize→settle) + USD int (settle→Tf). Credit/debit from uploaded deposit curve (Bid/Ask); long→credit, short→debit."
                        >
                          Carry
                        </th>
                        <th
                          className="py-1 font-medium"
                          title="Δ = Resid VaR / Open VaR — 1 = unhedged, 0 = fully offset"
                        >
                          Δ
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {hedgePerfRows.map(row => (
                        <tr
                          key={row.key}
                          className={`border-t border-slate-800/80 font-mono text-slate-300 ${
                            row.kind === 'leg' && !row.enabled
                              ? 'opacity-40'
                              : ''
                          }`}
                        >
                          <td className="py-1 pr-1">
                            {row.legIndex != null ? (
                              <input
                                type="checkbox"
                                checked={row.enabled}
                                onChange={() =>
                                  setEnabledLegIds(prev => ({
                                    ...prev,
                                    [row.legIndex!]: !row.enabled,
                                  }))
                                }
                                className="h-3.5 w-3.5 cursor-pointer rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500/40"
                                title={
                                  row.enabled
                                    ? 'Exclude trade from resid VaR profile'
                                    : 'Include trade in resid VaR profile'
                                }
                              />
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                          <td className="py-1 pr-2 text-slate-300">
                            {row.label}
                            {row.kind === 'end' ? (
                              <span className="ml-1 text-[8px] text-slate-500">
                                Tf
                              </span>
                            ) : null}
                          </td>
                          <td className="py-1 pr-2 text-emerald-300/90">
                            {row.hedgeDeltaM != null
                              ? fmtM(row.hedgeDeltaM)
                              : '—'}
                          </td>
                          <td className="py-1 pr-2 text-emerald-200/90">
                            {fmtM(row.cumulCoverLocalM)}
                          </td>
                          <td className="py-1 pr-2 text-slate-400">
                            {row.endExposureM != null
                              ? fmtM(row.endExposureM)
                              : '—'}
                          </td>
                          <td className="py-1 pr-2 text-amber-300/90">
                            {fmtM(row.residualLocalM)}
                          </td>
                          <td className="py-1 pr-2 text-slate-400">
                            {fmtVarK(row.openVarUsdM)}
                          </td>
                          <td
                            className={`py-1 pr-2 font-semibold ${
                              row.hedgedVarUsdM < 1e-6
                                ? 'text-emerald-300'
                                : 'text-amber-200'
                            }`}
                          >
                            {fmtVarK(row.hedgedVarUsdM)}
                          </td>
                          <td
                            className={`py-1 pr-2 ${
                              row.carryTotalUsdM == null
                                ? 'text-slate-600'
                                : (row.carryTotalUsdM ?? 0) >= 0
                                  ? 'text-sky-300'
                                  : 'text-rose-300/90'
                            }`}
                            title={
                              row.carryTotalUsdM == null
                                ? undefined
                                : [
                                    `Total ${fmtCarryK(row.carryTotalUsdM)}`,
                                    `Settle = cash delivery (${
                                      stripCashDeliveryAt === 'periodStart'
                                        ? 'period start'
                                        : stripCashDeliveryAt === 'matchExposure'
                                          ? 'e ∩ H'
                                          : 'period end'
                                    })`,
                                    row.carrySwapPoints != null
                                      ? `FWD points ${fmtCarryK(row.carryFwdUsdM ?? 0)} (swap ${row.carrySwapPoints.toFixed(2)} ${row.carrySwapPointsSide ?? ''} from Market data)`
                                      : `FWD CIP ${fmtCarryK(row.carryFwdUsdM ?? 0)} (deposit-rate fallback)`,
                                    `FCY int ${fmtCarryK(row.carryFcyIntUsdM ?? 0)} (recognize→settle @ overnight ${ccy} ${row.carryFcySide ?? ''} ${row.carryFcyRatePct?.toFixed(3) ?? '—'}%)`,
                                    `USD int ${fmtCarryK(row.carryUsdIntUsdM ?? 0)} (settle→Tf @ overnight USD ${row.carryUsdSide ?? ''} ${row.carryUsdRatePct?.toFixed(3) ?? '—'}%)`,
                                    `Source: ${marketRates.sourceFile}`,
                                  ].join('\n')
                            }
                          >
                            {row.carryTotalUsdM == null ? (
                              '—'
                            ) : (
                              <span className="inline-flex flex-col leading-tight">
                                <span className="font-semibold">
                                  {fmtCarryK(row.carryTotalUsdM)}
                                </span>
                                <span className="text-[8px] font-normal text-slate-500">
                                  fwd {fmtCarryK(row.carryFwdUsdM ?? 0)} · cash{' '}
                                  {fmtCarryK(
                                    (row.carryFcyIntUsdM ?? 0) +
                                      (row.carryUsdIntUsdM ?? 0),
                                  )}
                                </span>
                              </span>
                            )}
                          </td>
                          <td
                            className={`py-1 font-semibold ${
                              row.delta < 1e-6
                                ? 'text-emerald-300'
                                : 'text-amber-200'
                            }`}
                          >
                            {row.delta.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </>
                  )}
                  {stripScheduleOpen && !schedulePanelExternal && (
                    <p className="mt-1 text-[9px] text-slate-500">
                      Click Apply & close to return to the Performance · Resid
                      VaR table.
                    </p>
                  )}
                </div>
                    );
                  const schedulePortal =
                    schedulePanelExternal
                    && stripScheduleEditor
                    && schedulePanelHost
                      ? createPortal(stripScheduleEditor, schedulePanelHost)
                      : null;
                  const perfNode =
                    performancePanelPlacement === 'external'
                      ? performancePanelHost
                        ? createPortal(performancePanel, performancePanelHost)
                        : null
                      : performancePanel;
                  return (
                    <>
                      {perfNode}
                      {schedulePortal}
                    </>
                  );
                })()}
              </div>

              {showPrepareFooter && bookProfile && !pathControlsInGear && (
                <button
                  type="button"
                  disabled={showRollingStrip && stripAlreadyBooked}
                  onClick={() =>
                    bookProfile(
                      effectiveStructure,
                      showRollingStrip ? activeLadderEdges : [],
                    )
                  }
                  className="rounded-md border border-violet-500/50 bg-violet-500/20 px-2.5 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    showRollingStrip && stripAlreadyBooked
                      ? 'Strip already on the book — cancel it to rebook'
                      : showRollingStrip
                        ? `Prebook ${activeLadderEdges.length}-leg strip (Hedge % applied) for Hedging Decision — Send under this CCY to book`
                        : 'Prebook bullet for Hedging Decision — Send under this CCY to book'
                  }
                >
                  {showRollingStrip && stripAlreadyBooked
                    ? 'Strip booked (change regime / cancel to rebook)'
                    : `Prebook ${
                        selectedBasis === 'cash'
                          ? 'Expected stock'
                          : selectedBasis === 'totalExpected'
                            ? 'Total'
                            : 'VaR-neutral'
                      } ${
                        showRollingStrip
                          ? `${activeLadderEdges.length}-leg strip`
                          : 'bullet'
                      }`}
                </button>
              )}
            </>
          )}

          {showPrepareFooter &&
            !showHedgePerf &&
            bookProfile &&
            !pathControlsInGear && (
            <button
              type="button"
              onClick={() => bookProfile(effectiveStructure, [])}
              className="mt-2 rounded-md border border-violet-500/50 bg-violet-500/20 px-2.5 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30"
              title="Prebook selected regime + structure for Hedging Decision — Send under this CCY to book"
            >
              {`Prebook ${
                selectedBasis === 'cash'
                  ? 'Expected stock'
                  : selectedBasis === 'totalExpected'
                    ? 'Total'
                    : 'VaR-neutral'
              } ${effectiveStructure === 'strip' ? 'strip' : 'bullet'}`}
            </button>
          )}
        </div>
      )}

      {!showStructurePicker && !pathControlsInGear && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-slate-500">Apply hedge regime</div>
          <div
            className="inline-flex max-w-full min-w-0 flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
            role="group"
            aria-label="Apply hedge path"
          >
            {HEDGE_PATH_BASIS_OPTIONS.map(opt => {
              const on = selectedBasis === opt.id;
              const n = hedgeBasisNotionalLocalM(
                opt.id,
                startM,
                pathEndM,
                matchedEqualVarLocalM,
              );
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={`${opt.description} → set Hedge N = ${fmtM(n)}`}
                  disabled={
                    Math.abs(matchedEqualVarLocalM) < 1e-9 &&
                    Math.abs(startM) < 1e-9
                  }
                  onClick={() => {
                    onSelectedBasisChange(opt.id);
                    onApplyBasis(opt.id, effectiveStructure);
                  }}
                  aria-pressed={on}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    on
                      ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {opt.id === 'cash'
                    ? 'Expected stock'
                    : opt.id === 'varNeutral'
                      ? 'VaR-neutral'
                      : 'Target (Total)'}
                  <span
                    className={`ml-1 font-mono text-[10px] font-normal ${
                      on ? 'text-emerald-200/80' : 'text-slate-500'
                    }`}
                  >
                    {fmtM(n)}
                  </span>
                </button>
              );
            })}
            {renderCoverCustomButton()}
          </div>
        </div>
      )}

      <div
        className={
          pathControlsInGear
            ? 'rounded-lg border border-slate-700 bg-slate-950/40 p-2.5'
            : undefined
        }
      >
        <div className="mb-1.5 flex flex-wrap items-start justify-between gap-2">
          {pathControlsInGear ? (
            <div className="text-[11px] font-semibold text-sky-300/90">
              Exposure profile · forward ladder
            </div>
          ) : (
            <p className="text-[10px] text-slate-500">
              Blue = e(t) over {windowMonths}m (forecast to Tf={Tf}m
              {windowMonths > Tf + 1e-9 ? ', then flat beyond forecast' : ''}
              ). Strip = set of M0 forwards, ladder below = M0 → settle.
              Tick → solid green; untick → dashed violet planned.
            </p>
          )}
          {hasHedge && (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 font-mono text-[10px] text-slate-500">
              <span>
                Cover{' '}
                <span className="font-semibold text-emerald-200">
                  {fmtM(hedgeLevel)}
                </span>
              </span>
              <span>
                Legs{' '}
                <span className="font-semibold text-violet-200">
                  {forwardLadderRows.length}
                </span>
              </span>
              <span>
                Over-hedge @ t=0{' '}
                <span className="font-semibold text-amber-200/90">
                  {overhedgeReadoutLabel(startGap).replace(/^(over|under|on) /, '')}
                </span>
              </span>
              <span>
                Breakeven{' '}
                <span className="font-semibold text-amber-200/90">
                  {breakevenT != null ? `M${breakevenT.toFixed(2)}` : '—'}
                </span>
              </span>
            </div>
          )}
        </div>

      <svg
        viewBox={`0 0 ${W} ${svgTotalH}`}
        className="h-auto w-full max-w-full rounded-lg border border-slate-700 bg-slate-950"
        style={{ display: 'block' }}
        role="img"
        aria-label={`${ccy} exposure profile`}
      >
        {/* Month grid */}
        {monthTicks.map(m => (
          <g key={`mx-${m}`}>
            <line
              x1={xScale(m)}
              x2={xScale(m)}
              y1={padT}
              y2={H - padB}
              stroke={m === 0 || Math.abs(m - windowMonths) < 1e-9 ? '#475569' : '#1e293b'}
              strokeWidth={m === 0 || Math.abs(m - windowMonths) < 1e-9 ? 1.25 : 1}
            />
            <text
              x={xScale(m)}
              y={
                forwardLadderRows.length > 0 ? ladderDividerY - 4 : H - 10
              }
              textAnchor="middle"
              fill={
                Math.abs(m - windowMonths) < 1e-9
                  ? 'rgba(253, 230, 138, 0.9)'
                  : '#64748b'
              }
              fontWeight={
                Math.abs(m - windowMonths) < 1e-9 ? 600 : 400
              }
              fontSize={10}
              fontFamily="ui-monospace, monospace"
            >
              {Number.isInteger(m) ? `M${m}` : `${m.toFixed(1)}m`}
            </text>
          </g>
        ))}

        {/* Y grid */}
        {yTickVals.map((v, i) => (
          <g key={`my-${i}`}>
            <line
              x1={padL}
              x2={W - padR}
              y1={yScale(v)}
              y2={yScale(v)}
              stroke="#1e293b"
              strokeWidth={1}
            />
            <text
              x={padL - 6}
              y={yScale(v) + 3}
              textAnchor="end"
              fill="#94a3b8"
              fontSize={9}
            >
              {v.toFixed(1)}
            </text>
          </g>
        ))}

        {/* Post-forecast band: e flat, resid VaR still evolves (same as Evolution) */}
        {Tf > 0 && windowMonths > Tf + 1e-9 && (
          <g>
            <rect
              x={xScale(Tf)}
              y={padT}
              width={Math.max(0, xScale(windowMonths) - xScale(Tf))}
              height={H - padT - padB}
              fill="rgba(148, 163, 184, 0.08)"
              stroke="none"
            />
            <line
              x1={xScale(Tf)}
              x2={xScale(Tf)}
              y1={padT}
              y2={H - padB}
              stroke="#94a3b8"
              strokeWidth={1.25}
              strokeDasharray="4 3"
            />
            <text
              x={(xScale(Tf) + xScale(windowMonths)) / 2}
              y={padT + 12}
              textAnchor="middle"
              fill="#94a3b8"
              fontSize={9}
              fontWeight={600}
            >
              beyond forecast
            </text>
            <text
              x={(xScale(0) + xScale(Tf)) / 2}
              y={padT + 12}
              textAnchor="middle"
              fill="#64748b"
              fontSize={9}
            >
              forecast
            </text>
          </g>
        )}

        {/* Over-hedge wedge: neutral slate fill + hairline e(t) boundary,
            closes exactly at breakeven (real path, not a straight line). */}
        {overhedgeWedge?.map((run, i) => (
          <g key={`wedge-${i}`}>
            <polygon
              points={run.fillPoints}
              fill="rgba(148, 163, 184, 0.16)"
              stroke="none"
            />
            <path
              d={run.strokeD}
              fill="none"
              stroke="rgba(100, 116, 139, 0.45)"
              strokeWidth={EXP_PROFILE_STROKE.wedgeEdge}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
        {overhedgeReadouts.map((r, i) => (
          <text
            key={`wedge-ro-${i}`}
            x={xScale(r.t)}
            y={yScale(hedgeLevel) + 20}
            textAnchor="middle"
            fill="#94a3b8"
            fontSize={10}
          >
            {overhedgeReadoutLabel(r.v)}
          </text>
        ))}

        {/* Cover Σ H — one flat line for both bullet and ticked-strip cover. */}
        {hasHedge && (
          <>
            <line
              x1={padL}
              x2={W - padR}
              y1={yScale(hedgeLevel)}
              y2={yScale(hedgeLevel)}
              stroke="#34d399"
              strokeWidth={EXP_PROFILE_STROKE.cover}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={W - padR - 6}
              y={yScale(hedgeLevel) - 8}
              textAnchor="end"
              fill="#a7f3d0"
              fontSize={11}
              fontWeight={600}
              fontFamily="ui-monospace, monospace"
            >
              Σ H {fmtM(hedgeLevel)} — cover
            </text>
          </>
        )}

        {/* Purple dashed = regime target when it differs from applied cover. */}
        {Math.abs(basisTarget - hedgeLevel) > 0.05 && (
          <>
            <line
              x1={padL}
              x2={W - padR}
              y1={yScale(basisTarget)}
              y2={yScale(basisTarget)}
              stroke="#a78bfa"
              strokeWidth={1.5}
              strokeDasharray="6 3"
              strokeLinecap="round"
            />
            <text
              x={W - padR - 6}
              y={
                yScale(basisTarget) +
                (basisTarget > hedgeLevel ? -8 : 14)
              }
              textAnchor="end"
              fill="#c4b5fd"
              fontSize={10}
              fontWeight={600}
            >
              Target {fmtM(basisTarget)}
            </text>
          </>
        )}

        {/* Cash ladder — cumulative delivered, dashed amber staircase.
            Steps only at each ticked leg's settle x (never before it). */}
        {forwardLadderRows.filter(r => r.ticked).length > 0 &&
          (() => {
            const ticked = forwardLadderRows.filter(r => r.ticked);
            const stairPts: { x: number; y: number }[] = [
              { x: xScale(0), y: yScale(0) },
            ];
            for (const row of ticked) {
              const x = xScale(row.settleT);
              const yLevel = yScale(row.cumulLocalM ?? 0);
              const yPrev = stairPts[stairPts.length - 1]!.y;
              stairPts.push({ x, y: yPrev });
              stairPts.push({ x, y: yLevel });
            }
            stairPts.push({
              x: xScale(windowMonths),
              y: stairPts[stairPts.length - 1]!.y,
            });
            return (
              <>
                <polyline
                  points={stairPts.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="#fbbf24"
                  strokeWidth={EXP_PROFILE_STROKE.cashLadder}
                  strokeDasharray="8 5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {ticked.map(row => (
                  <g key={`step-${row.key}`}>
                    <circle
                      cx={xScale(row.settleT)}
                      cy={yScale(row.cumulLocalM ?? 0)}
                      r={4.5}
                      fill="#0b1220"
                      stroke="#fbbf24"
                      strokeWidth={EXP_PROFILE_STROKE.cashStepDot}
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      x={xScale(row.settleT) + 10}
                      y={yScale(row.cumulLocalM ?? 0) - 7}
                      fill="rgba(253, 230, 138, 0.9)"
                      fontSize={10}
                      fontFamily="ui-monospace, monospace"
                    >
                      {fmtM(row.cumulLocalM ?? 0).replace('+', '')}
                      {row.pctOfCover != null
                        ? ` · ${fmtPct(row.pctOfCover)}${
                            Math.abs(
                              (row.cumulLocalM ?? 0) - hedgeLevel,
                            ) < 0.05
                              ? ' delivered'
                              : ''
                          }`
                        : ''}
                    </text>
                  </g>
                ))}
              </>
            );
          })()}

        {/* Exposure path */}
        <path
          d={expLine}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={EXP_PROFILE_STROKE.exposure}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {/* Start / end markers */}
        <circle
          cx={xScale(0)}
          cy={yScale(startM)}
          r={EXP_PROFILE_STROKE.expEndpoint}
          fill="#38bdf8"
        />
        <text
          x={xScale(0) + 10}
          y={yScale(startM) + 18}
          textAnchor="start"
          fill="#7dd3fc"
          fontSize={11}
          fontWeight={600}
          fontFamily="ui-monospace, monospace"
        >
          S {fmtM(startM)}
        </text>
        <circle
          cx={xScale(Tf > 0 && windowMonths > Tf + 1e-9 ? Tf : windowMonths)}
          cy={yScale(pathEndM)}
          r={EXP_PROFILE_STROKE.expEndpoint}
          fill="#38bdf8"
        />

        {/* Tf terminal rule — solid amber through curve + ladder (design M12). */}
        {hasHedge && (
          <line
            x1={xScale(windowMonths)}
            x2={xScale(windowMonths)}
            y1={padT}
            y2={
              forwardLadderRows.length > 0
                ? ladderRowTopY +
                  forwardLadderRows.length * ladderRowH -
                  ladderRowH +
                  ladderBarH
                : H - padB
            }
            stroke="rgba(245, 158, 11, 0.8)"
            strokeWidth={EXP_PROFILE_STROKE.tfRule}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* Breakeven when it falls before Tf. */}
        {breakevenT != null &&
          hasHedge &&
          Math.abs(breakevenT - windowMonths) > 0.05 && (
            <line
              x1={xScale(breakevenT)}
              x2={xScale(breakevenT)}
              y1={padT}
              y2={
                forwardLadderRows.length > 0
                  ? ladderRowTopY +
                    forwardLadderRows.length * ladderRowH -
                    ladderRowH +
                    ladderBarH
                  : H - padB
              }
              stroke="rgba(245, 158, 11, 0.55)"
              strokeWidth={1.25}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}

        {/* Zone B → C divider + forward ladder lane (M0 → settle bars). */}
        {forwardLadderRows.length > 0 && (
          <>
            <line
              x1={padL}
              x2={W - padR}
              y1={ladderDividerY}
              y2={ladderDividerY}
              stroke="#1e293b"
            />
            <text
              x={padL}
              y={ladderHeaderY}
              fill="#475569"
              fontSize={9}
              fontWeight={600}
              letterSpacing={0.5}
            >
              FORWARD LADDER · M0 → SETTLE
            </text>
            {forwardLadderRows.map((row, i) => {
              const rowY = ladderRowTopY + i * ladderRowH;
              const x0 = xScale(0);
              const x1 = Math.max(x0, xScale(row.settleT));
              return (
                <g key={row.key}>
                  {row.ticked && (
                    <line
                      x1={x1}
                      x2={x1}
                      y1={padT}
                      y2={rowY + ladderBarH}
                      stroke="rgba(148, 163, 184, 0.35)"
                      strokeWidth={EXP_PROFILE_STROKE.settleGuide}
                      strokeDasharray="4 5"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {row.ticked ? (
                    <rect
                      x={x0}
                      y={rowY}
                      width={Math.max(0, x1 - x0)}
                      height={ladderBarH}
                      rx={3}
                      fill="rgba(16, 185, 129, 0.55)"
                    />
                  ) : (
                    <rect
                      x={x0}
                      y={rowY}
                      width={Math.max(0, x1 - x0)}
                      height={ladderBarH}
                      rx={3}
                      fill="none"
                      stroke="rgba(139, 92, 246, 0.7)"
                      strokeWidth={1}
                      strokeDasharray="5 4"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {row.ticked && (
                    <circle
                      cx={x1}
                      cy={rowY + ladderBarH / 2}
                      r={4.5}
                      fill="#fbbf24"
                    />
                  )}
                  <text
                    x={x1 + 16}
                    y={rowY + ladderBarH / 2 + 4}
                    fill="#cbd5e1"
                    fontSize={10}
                    fontFamily="ui-monospace, monospace"
                  >
                    {row.ticked ? (
                      <>
                        {row.label} · t={row.settleT.toFixed(1)} ·{' '}
                        <tspan fill="#a7f3d0">
                          {fmtM(row.deltaLocalM)}
                        </tspan>{' '}
                        <tspan fill="#64748b">
                          cash at settle
                          {row.pctOfCover != null
                            ? ` · ${fmtPct(row.pctOfCover)} of cover`
                            : ''}
                        </tspan>
                      </>
                    ) : (
                      <>
                        {row.label} ·{' '}
                        <tspan fill="#ddd6fe">planned</tspan>
                        <tspan fill="#64748b">
                          {' '}
                          · unticked — not in cover
                        </tspan>
                      </>
                    )}
                  </text>
                </g>
              );
            })}
          </>
        )}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-2 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-4 rounded-sm bg-sky-400" />{' '}
          Exposure e(t)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4 rounded-sm bg-emerald-400" />{' '}
          Cover Σ H
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-3.5 border-t-2 border-dashed border-amber-400 bg-amber-400/10" />{' '}
          Cash ladder · cumulative delivered
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-3.5 border border-slate-500/45 bg-slate-400/16" />{' '}
          Over-hedge wedge
        </span>
        <span className="h-3 w-px bg-slate-700" />
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 rounded-sm bg-emerald-500/55" />{' '}
          Ticked forward · M0 → settle
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />{' '}
          Settle{' '}
          {stripCashDeliveryAt === 'periodStart'
            ? '@ period start'
            : stripCashDeliveryAt === 'matchExposure'
              ? '@ e ∩ H'
              : '@ period end'}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 rounded-sm border border-dashed border-violet-400/70" />{' '}
          Unticked / planned
        </span>
        {hasHedge && (
          <span className="ml-auto font-mono tabular-nums text-slate-400">
            t=0 {overhedgeReadoutLabel(startGap)} · t={windowMonths}m{' '}
            {overhedgeReadoutLabel(endGap)}
          </span>
        )}
      </div>

      {hasHedge && netExposureSeries.length > 0 && netCashSeries.length > 0 && (
        <div className="mt-2 rounded-lg border border-slate-700 bg-slate-950/40 p-2.5">
          <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                Net exposure vs hedge cash
              </span>
              <span className="ml-2 text-[10px] text-slate-500">
                Net exposure runs against the full strip sold at t=0 — below
                zero means cover is ahead of exposure, the same{' '}
                {fmtM(Math.abs(startGap))} over-hedge the chart above states
                at t=0. Net cash steps only when a leg actually settles.
              </span>
            </div>
            <span className="font-mono text-[10px] text-slate-500">
              over-hedge @ t=0{' '}
              <span className="text-teal-200">
                {fmtM(netExposureSeries[0]!.v)}
              </span>
              {netGeom.maxShort != null && netGeom.maxShort.net < -1e-6 && (
                <>
                  {' '}
                  · net cash low{' '}
                  <span className="text-amber-200/90">
                    {fmtM(netGeom.maxShort.net)}
                  </span>{' '}
                  @ t={netGeom.maxShort.t.toFixed(1)}
                </>
              )}
              {' '}
              · both{' '}
              <span className="text-teal-200">
                {fmtM(
                  netExposureSeries[netExposureSeries.length - 1]!.v,
                )}
              </span>{' '}
              @ Tf
            </span>
          </div>
          <svg
            viewBox={`0 0 ${W} ${netGeom.H}`}
            className="h-auto w-full max-w-full"
            style={{ display: 'block' }}
            role="img"
            aria-label={`${ccy} net exposure vs hedge cash`}
          >
            {netGeom.yTickVals.map((v, i) => (
              <g key={`ny-${i}`}>
                <line
                  x1={padL}
                  x2={W - padR}
                  y1={netGeom.yScale(v)}
                  y2={netGeom.yScale(v)}
                  stroke="#1e293b"
                  strokeWidth={1}
                  strokeDasharray="3 5"
                />
                <text
                  x={padL - 6}
                  y={netGeom.yScale(v) + 3}
                  textAnchor="end"
                  fill="#475569"
                  fontSize={9}
                >
                  {v.toFixed(1)}
                </text>
              </g>
            ))}

            {/* Slate over-hedge wedge — net exposure (teal) below zero. */}
            {netExposureWedgePolys.map((pts, i) => (
              <polygon
                key={`nw-${i}`}
                points={pts}
                fill="rgba(148, 163, 184, 0.16)"
                stroke="rgba(100, 116, 139, 0.45)"
                strokeWidth={1}
              />
            ))}
            {/* Red tint — net cash (amber) negative. */}
            {netCashNegativePolys.map((pts, i) => (
              <polygon
                key={`nr-${i}`}
                points={pts}
                fill="rgba(244, 63, 94, 0.14)"
              />
            ))}

            {forwardLadderRows
              .filter(r => r.ticked)
              .map(row => (
                <line
                  key={`ng-${row.key}`}
                  x1={xScale(row.settleT)}
                  x2={xScale(row.settleT)}
                  y1={netGeom.plotT}
                  y2={netGeom.plotBGuide}
                  stroke="rgba(245, 158, 11, 0.4)"
                  strokeWidth={EXP_PROFILE_STROKE.settleGuide}
                  strokeDasharray="4 5"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            <line
              x1={xScale(windowMonths)}
              x2={xScale(windowMonths)}
              y1={netGeom.plotT}
              y2={netGeom.tfRuleBottom}
              stroke="rgba(245, 158, 11, 0.8)"
              strokeWidth={EXP_PROFILE_STROKE.tfRule}
              vectorEffect="non-scaling-stroke"
            />
            {breakevenT != null &&
              Math.abs(breakevenT - windowMonths) > 0.05 && (
                <line
                  x1={xScale(breakevenT)}
                  x2={xScale(breakevenT)}
                  y1={netGeom.plotT}
                  y2={netGeom.tfRuleBottom}
                  stroke="rgba(245, 158, 11, 0.55)"
                  strokeWidth={1.25}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}

            <line
              x1={padL}
              x2={W - padR}
              y1={netGeom.zeroY}
              y2={netGeom.zeroY}
              stroke="#64748b"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />

            {/* Net cash — e(t) − cash delivered, stepping at each settle. */}
            <polyline
              points={netCashSeries
                .map(p => `${xScale(p.t)},${netGeom.yScale(p.net)}`)
                .join(' ')}
              fill="none"
              stroke="#fbbf24"
              strokeWidth={EXP_PROFILE_STROKE.netCash}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {(() => {
              const tickedRows = forwardLadderRows.filter(r => r.ticked);
              return tickedRows.map(row => {
                // Two knots share this t (pre-jump, post-jump) — the last
                // match in chronological order is the post-jump value.
                const pt = [...netCashSeries]
                  .reverse()
                  .find(p => Math.abs(p.t - row.settleT) < 1e-6);
                if (!pt) return null;
                return (
                  <circle
                    key={`nstep-${row.key}`}
                    cx={xScale(row.settleT)}
                    cy={netGeom.yScale(pt.net)}
                    r={3.5}
                    fill="#0b1220"
                    stroke="#fbbf24"
                    strokeWidth={EXP_PROFILE_STROKE.netStepDot}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              });
            })()}
            <circle
              cx={xScale(windowMonths)}
              cy={netGeom.yScale(netCashSeries[netCashSeries.length - 1]!.net)}
              r={3.5}
              fill="#0b1220"
              stroke="#fbbf24"
              strokeWidth={EXP_PROFILE_STROKE.netStepDot}
              vectorEffect="non-scaling-stroke"
            />

            {/* Net exposure — e(t) − cover, smooth (cover is a flat constant). */}
            <polyline
              points={netExposureSeries
                .map(p => `${xScale(p.t)},${netGeom.yScale(p.v)}`)
                .join(' ')}
              fill="none"
              stroke="#5eead4"
              strokeWidth={EXP_PROFILE_STROKE.netExposure}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={xScale(0)}
              cy={netGeom.yScale(netExposureSeries[0]!.v)}
              r={EXP_PROFILE_STROKE.netEndpoint}
              fill="#5eead4"
            />
            <circle
              cx={xScale(windowMonths)}
              cy={netGeom.yScale(
                netExposureSeries[netExposureSeries.length - 1]!.v,
              )}
              r={EXP_PROFILE_STROKE.netEndpoint}
              fill="#5eead4"
            />

            <g fontSize={10} fontFamily="ui-monospace, monospace">
              <text
                x={padL + 10}
                y={netGeom.plotBGuide + 2}
                fill="#99f6e4"
              >
                over-hedged {fmtM(Math.abs(startGap)).replace('+', '')} at
                t=0
              </text>
              <text
                x={padL + 10}
                y={netGeom.yScale(netCashSeries[0]!.net) - 9}
                fill="rgba(253, 230, 138, 0.9)"
              >
                net cash {fmtM(netCashSeries[0]!.net)}
              </text>
              {netGeom.maxShort != null && netGeom.maxShort.net < -1e-6 && (
                <text
                  x={xScale(netGeom.maxShort.t) + 10}
                  y={netGeom.yScale(netGeom.maxShort.net) + 16}
                  fill="rgba(253, 230, 138, 0.9)"
                >
                  {fmtM(netGeom.maxShort.net)}
                </text>
              )}
              <text
                x={W - padR - 10}
                y={netGeom.yScale(
                  netExposureSeries[netExposureSeries.length - 1]!.v,
                ) - 10}
                textAnchor="end"
                fill="#99f6e4"
              >
                both{' '}
                {fmtM(
                  netExposureSeries[netExposureSeries.length - 1]!.v,
                ).replace('+', '')}{' '}
                @ Tf
              </text>
            </g>

            {monthTicks.map(m => (
              <text
                key={`nm-${m}`}
                x={xScale(m)}
                y={netGeom.monthLabelY}
                textAnchor="middle"
                fill={Math.abs(m - windowMonths) < 1e-9 ? 'rgba(253, 230, 138, 0.9)' : '#64748b'}
                fontWeight={Math.abs(m - windowMonths) < 1e-9 ? 600 : 400}
                fontSize={10}
                fontFamily="ui-monospace, monospace"
              >
                {Number.isInteger(m) ? `M${m}` : `${m.toFixed(1)}m`}
              </text>
            ))}
          </svg>
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-2 text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-[3px] w-4 rounded-sm bg-teal-300" />{' '}
              Net exposure · accrued − {fmtM(hedgeLevel).replace('+', '')}{' '}
              sold at t=0 · below zero = over-hedged
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-[2.5px] w-4 rounded-sm bg-amber-400" />{' '}
              Net cash · exposure received − hedge cash settled
            </span>
            <span className="h-3 w-px bg-slate-700" />
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-3.5 border border-slate-500/45 bg-slate-400/16" />{' '}
              Over-hedge · cover ahead of exposure
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-3.5 bg-rose-500/[0.14]" />{' '}
              Net cash negative
            </span>
            <span className="h-3 w-px bg-slate-700" />
            <span>
              Net cash steps at each settle; net exposure closes smoothly as
              exposure accrues
            </span>
          </div>
        </div>
      )}
      </div>

    </div>
  );
}
