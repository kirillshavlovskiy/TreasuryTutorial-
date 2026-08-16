'use client';

import {
  Fragment,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { DeskProgressTrack, DeskStepper } from '@/components/DeskStepper';
import {
  CURRENCY_PARAMS,
  INITIAL_ROWS,
  INITIAL_USD_PARAMS,
  sumFcySwapNearUsd,
  fcyToUsdM,
  usdToFcyM,
  roundMoney,
  fxBookNetLocalM,
  type RowState,
  type UsdParams,
  type SharedGlobals,
  type LayerId,
  fundingSwapMonthCarryUsdM,
  fundingSwapPathCarryUsdM,
  fundingSwapCashDeltaUsdYr,
  fundingSwapCipPointsUsdYr,
  swapFarLegNotional,
} from '@/lib/fx-buffer';
import {
  fundedPlanFor,
  sizingFromPlan,
  type FcyComputedRow,
  type UsdComputedRow,
  type PortfolioSummary,
} from '@/lib/dashboard-model';
import {
  canEarnPositiveCarry,
  carryBasisLabel,
  projectCarryLifecycle,
  targetForCarry,
  type CarryPeriod,
} from '@/lib/carry-accrual';
import {
  resolveStrategyHedge,
  fwdHedgeCarryUsdYr,
  HEDGE_STRATEGIES,
  type HedgeStrategy,
} from '@/lib/fx-hedge';
import { FormulaCell } from '@/components/FormulaCell';
import { FormulaGridProvider } from '@/components/FormulaGrid';
import {
  resolveSimRow,
  SIM_FIELDS,
  SIM_FIELD_BY_KEY,
  type SimFieldKey,
} from '@/lib/sim-formulas';
import type { Scope } from '@/lib/formula';
import type { BookedPositionOffset } from '@/lib/test-mode/hedge-var';
import {
  DEFAULT_FORECAST_PROFILE,
  copyMonth1ToAll,
  ensureProfileForRows,
  EMPTY_FORECAST_EXTRAS,
  FORECAST_FLOW_GROUPS,
  FORECAST_FLOW_LINES,
  evalPeriodFormula,
  flatLinePeriodSum,
  flowFieldDisplay,
  flowFieldFromDisplay,
  forecastFlowLinesGrouped,
  calcFieldKey,
  calcIdFromFieldKey,
  forecastFormulaKey,
  forecastFormulaPickToken,
  hasFlatGrowthOverride,
  isCalcFieldKey,
  lineGrowthMoM,
  lineUncertainty1m,
  monthNet,
  newCalcRow,
  normalizeExtras,
  normalizeMonthFlow,
  periodFlowSumLocalM,
  periodFxFlowSumLocalM,
  periodFormulaScope,
  resizeCalcSeries,
  seedMonthsFromRow,
  seedMonthsFromRowWithLineGrowth,
  shiftForecastFormulaMonths,
  sumPeriodFlow,
  withFlowField,
  withLineUncertainty1m,
  type ForecastCalcRow,
  type ForecastCashExtras,
  type ForecastFlowField,
  type ForecastFlowMode,
  type ForecastFlowSide,
  type ForecastMonthFlow,
  type ForecastProfileState,
  type LiquidityCycleProjection,
} from '@/lib/forecast-profile';
import {
  buildLiquidityLadder,
  dayOfMonthForFraction,
  DEFAULT_LIQUIDITY_TIMING,
  resolveLiquidityTiming,
  HEDGE_SETTLE_LINE,
  hedgeSettleSide,
  LADDER_DAYS_PER_MONTH,
  resolveFlowShape,
  shapeCycleWindow,
  type FlowCurve,
  type FlowShape,
  type HedgeSettleByCcy,
  type LadderCycle,
  type LiquidityGranularity,
  type LiquidityLadderResult,
  type LiquidityLineKey,
  type LiquidityBookingMode,
  type LiquidityTiming,
  SIZING_BASIS_OPTIONS,
  BOOKING_MODE_OPTIONS,
} from '@/lib/liquidity-ladder';
import { FORECAST_UNCERTAINTY_OPTIONS } from '@/lib/test-mode/var-setup';
import {
  DEFAULT_VAR_SETUP,
  FORECAST_PERIOD_OPTIONS,
  forecastPeriodIdForMonths,
  monthlyVolForSetup,
  VAR_EXPOSURE_OPTIONS,
  VAR_HORIZON_OPTIONS,
  VAR_VOL_SOURCE_OPTIONS,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

export type FxRiskMetricCell = {
  exposureLocalM: number;
  residualLocalM?: number;
  varUsdM: number;
  varBeforeUsdM?: number;
  spotHedgeLocalM?: number;
  forwardHedgeLocalM?: number;
};

// ─── Formatting helpers ───────────────────────────────────────────────────────

function f2(v: number)  { return isNaN(v) ? '—' : v.toFixed(2); }
/** Input display — strip binary float garbage (3.400000000000002 → "3.4"). */
function n(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(roundMoney(v));
}
function clr(v: number) { return v < 0 ? 'text-red-600' : 'text-gray-900'; }
/** Derived hedge cells stay quiet as a dash on currencies with no hedge. */
function fmtHedgeCell(v: number): string {
  return Math.abs(v) < 0.005 ? '—' : f2(v);
}

/** Trough Cash tooltip — which cycle the low came from, and how deep it sat. */
function troughCellTitle(r: {
  troughDay?: number;
  troughCycleIndex?: number;
  nearCycleTrough?: number;
  daysBelowFloor?: number;
  cash_floor: number;
  cycleStartDay?: number;
  cycleEndDay?: number;
}): string {
  if (r.troughDay === undefined) return 'Trough Cash';
  const cycle = r.troughCycleIndex ?? 0;
  const dayInCycle = r.troughDay - cycle * LADDER_DAYS_PER_MONTH + 1;
  const parts = [
    cycle === 0
      ? `Trough Cash · nearest cycle operating low on D${dayInCycle}`
      : `Trough Cash · worst cycle M${cycle + 1}, operating low on its D${dayInCycle} (no funding swap)`,
    `cycle D${(r.cycleStartDay ?? 0) + 1}→D${(r.cycleEndDay ?? 0) + 1}`,
  ];
  if ((r.daysBelowFloor ?? 0) > 0) {
    parts.push(`${r.daysBelowFloor}d below floor ${f2(r.cash_floor)}`);
  }
  if (cycle > 0 && r.nearCycleTrough !== undefined) {
    parts.push(
      `nearest cycle would trough at ${f2(r.nearCycleTrough)}`
      + ' — sizing on the worst cycle in the horizon',
    );
  }
  return parts.join(' · ');
}

/**
 * Swap Near tooltip — the collapsed row is the trade booked today (M1 near).
 * H* may sit on a later cycle; that increment is not this cell.
 */
function swapCellTitle(r: {
  swapNear: number;
  swapPointsUsdYr?: number;
  troughCycleIndex?: number;
  sizingCycleIndex?: number;
  liquidityPlan?: { cycleIndex: number; swap_needed: number }[];
}): string {
  const base = 'Swap near leg booked today — cycle 0 of the funded path';
  const plan = r.liquidityPlan;
  if (!plan?.length) {
    const pts = r.swapPointsUsdYr;
    return typeof pts === 'number' && Math.abs(pts) > 5e-8
      ? `Swap near leg — sized by the buffer layer · CIP points ${usdCarry(pts)} (in FX Hedge Carry)`
      : 'Swap near leg — sized by the buffer layer, not a formula cell';
  }
  const sized = r.sizingCycleIndex ?? r.troughCycleIndex ?? 0;
  const hStar = plan[sized]?.swap_needed ?? 0;
  const parts = [base];
  if (sized > 0 && Math.abs(hStar - r.swapNear) > 0.001) {
    parts.push(`H* is M${sized + 1} (incremental ${f2(hStar)})`);
  }
  if (typeof r.swapPointsUsdYr === 'number' && Math.abs(r.swapPointsUsdYr) > 5e-8) {
    parts.push(`CIP points ${usdCarry(r.swapPointsUsdYr)} (in FX Hedge Carry)`);
  }
  return parts.join(' · ');
}

/**
 * Horizon flow totals behind a collapsed currency row. The cycle rows show one
 * month each and count every line that settles in it, so the collapsed row sums
 * the same cycles rather than reporting the single-cycle payout/payin input.
 */
/**
 * LIQUIDITY POOL BOOK cells for one expanded cycle. The funded plan chains
 * Swap Near into later openings — that cash belongs in SWAP, never here.
 * Prefer the unfunded ladder; if it is missing, strip every swap already on.
 */
function liquidityBookCycle(
  p: LiquidityCycleProjection,
  shape?: LadderCycle,
): { opening: number; close: number; trough: number; drawdown: number } {
  if (shape) {
    return {
      opening: shape.opening,
      close: shape.closing,
      trough: shape.low,
      drawdown: shape.drawdown,
    };
  }
  const priorSwap = p.standing_swap - p.swap_needed;
  const opening = roundMoney(p.opening_cash - priorSwap);
  return {
    opening,
    close: roundMoney(p.cycle_end_cash - p.swap_needed - priorSwap - p.far_leg),
    trough: roundMoney(p.forecasted_cash - priorSwap),
    drawdown: p.drawdown,
  };
}

function horizonFlows(cycles?: LadderCycle[]): {
  outflow: number;
  inflow: number;
  months: number;
} | null {
  if (!cycles?.length) return null;
  return {
    outflow: cycles.reduce((s, c) => s + c.outflow, 0),
    inflow: cycles.reduce((s, c) => s + c.inflow, 0),
    months: cycles.length,
  };
}

function dclr(v: number){ return v > 0 ? 'text-red-600' : 'text-green-600'; }
/** P&L carry in $k (internal values stay $M). */
function usdCarry(v: number, dust = 5e-8): string {
  if (isNaN(v) || Math.abs(v) < dust) return '—';
  const k = v * 1000;
  const sign = k < 0 ? '-' : '+';
  const abs = Math.abs(k);
  return `${sign}$${abs < 10 ? abs.toFixed(1) : abs.toFixed(0)}k`;
}

/** Period interest accrual is small next to $M notionals — quote it in $k. */
function usdK(v: number, dust = 0.0005): string {
  if (isNaN(v) || Math.abs(v) < dust) return '—';
  return `${v < 0 ? '-' : '+'}$${Math.abs(v * 1000).toFixed(0)}k`;
}

function carryTone(v: number, mutedBelow = 5e-8): string {
  if (Math.abs(v) < mutedBelow) return 'text-gray-300';
  return v >= 0 ? 'text-green-700' : 'text-red-600';
}

function swapNearUsd(ccy: string, swapNear: number): number {
  return swapNear * (CURRENCY_PARAMS[ccy]?.spot ?? 1);
}

function fmtSwapUsd(v: number): string {
  if (Math.abs(v) < 0.005) return '—';
  return `${v >= 0 ? '+' : ''}${f2(v)}`;
}

/** P&L Hedge Cash: predetermined cash impact of booked/staged forwards.
 *  CIP and option expected delivery live in FX HEDGE — not here. */
function pnlHedgeCarryUsdM(
  ccy: string,
  staged: Record<string, number>,
): number {
  const v = staged[ccy];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** P&L Cash Carry: Cash Carry forecast dual-book interest when hedged, else LP NIM. */
function pnlCashCarryUsdM(
  ccy: string,
  floatNim: number,
  staged: Record<string, number>,
): number {
  const v = staged[ccy];
  return typeof v === 'number' && Number.isFinite(v) ? v : floatNim;
}

/** P&L Swap Carry: path Σ of cash Δr on the standing book. CIP points sit in FX hedge carry. */
function pnlSwapCarryUsdM(
  r: {
    liquidityPlan?: { standing_swap: number }[];
    swapCarryUsdYr: number;
    ccy: string;
    r_FCY: number;
    r_OD: number;
  },
  r_USD: number,
): number {
  const spot = CURRENCY_PARAMS[r.ccy]?.spot ?? 1;
  return fundingSwapPathCarryUsdM(
    r.liquidityPlan, spot, r.r_FCY, r_USD, r.r_OD, 'cashDelta',
  ) ?? r.swapCarryUsdYr;
}

/** Always show USD amount for Target LP Cash column (including zero). */
function fmtThresholdUsd(v: number): string {
  if (isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${f2(v)}`;
}

function fmtZeroSumUsd(v: number): string {
  if (Math.abs(v) < 0.005) return '0.00 ✓';
  return `${v >= 0 ? '+' : ''}${f2(v)} ✗`;
}

function zeroSumCls(v: number): string {
  return Math.abs(v) < 0.005 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700';
}

function CarryBadge({ dir }: { dir: 'earn' | 'pay' | 'neutral' }) {
  if (dir === 'earn') return <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">EARN</span>;
  if (dir === 'pay')  return <span className="rounded-full bg-red-100  px-1.5 py-0.5 text-xs font-medium text-red-700">PAY</span>;
  return <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">NEUT</span>;
}

// ─── Global param input ───────────────────────────────────────────────────────

/** Cluster caption in the desk toolbar / layers rail. */
const toolCaption = 'font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-gray-500';

/**
 * Column groups of the book table. Each band owns a hue that runs from the
 * In-view rail through its group header rule into the header of its first
 * column, so a horizontally scrolled reader always knows where they are.
 */
type BandId = 'rates' | 'pos' | 'liq' | 'ir' | 'buf' | 'swap' | 'hedge' | 'risk' | 'pnl';

const BAND_STYLE: Record<
  BandId,
  { label: string; short: string; rule: string; bg: string; bgOn: string; text: string; chipOn: string }
> = {
  rates: { label: 'RATES', short: 'RATES', rule: 'border-gray-300', bg: 'bg-gray-50',
    bgOn: 'bg-gray-100', text: 'text-gray-600', chipOn: 'border-gray-400 bg-gray-100 text-gray-700' },
  pos: { label: 'FX POSITION', short: 'FX', rule: 'border-gray-300', bg: 'bg-white',
    bgOn: 'bg-gray-50', text: 'text-gray-600', chipOn: 'border-gray-400 bg-gray-100 text-gray-700' },
  liq: { label: 'LIQUIDITY POOL BOOK', short: 'LP BOOK', rule: 'border-sky-300', bg: 'bg-sky-50',
    bgOn: 'bg-sky-100', text: 'text-sky-700', chipOn: 'border-sky-300 bg-sky-100 text-sky-700' },
  ir: { label: 'IR / FIXED-RATE BOOK', short: 'IR', rule: 'border-rose-300', bg: 'bg-rose-50',
    bgOn: 'bg-rose-100', text: 'text-rose-700', chipOn: 'border-rose-300 bg-rose-100 text-rose-700' },
  buf: { label: 'CARRY / BUFFER', short: 'BUFFER', rule: 'border-amber-300', bg: 'bg-amber-50',
    bgOn: 'bg-amber-100', text: 'text-amber-700', chipOn: 'border-amber-300 bg-amber-100 text-amber-700' },
  swap: { label: 'SWAP', short: 'SWAP', rule: 'border-emerald-300', bg: 'bg-emerald-50',
    bgOn: 'bg-emerald-100', text: 'text-emerald-700', chipOn: 'border-emerald-300 bg-emerald-100 text-emerald-700' },
  hedge: { label: 'FX HEDGE', short: 'HEDGE', rule: 'border-rose-400', bg: 'bg-rose-50',
    bgOn: 'bg-rose-100', text: 'text-rose-700', chipOn: 'border-rose-400 bg-rose-100 text-rose-700' },
  risk: { label: 'RISK METRICS', short: 'RISK', rule: 'border-violet-400', bg: 'bg-violet-50',
    bgOn: 'bg-violet-100', text: 'text-violet-800', chipOn: 'border-violet-400 bg-violet-100 text-violet-800' },
  pnl: { label: 'P&L', short: 'P&L', rule: 'border-purple-300', bg: 'bg-purple-50',
    bgOn: 'bg-purple-100', text: 'text-purple-700', chipOn: 'border-purple-300 bg-purple-100 text-purple-700' },
};

const groupThBase = 'px-2 py-1 text-center text-xs font-semibold tracking-wide';

/**
 * Buffer layers are multi-select chips carrying the band they move, so the rail
 * reads as "this control writes that column group". Hedging strategy stays a
 * segmented track — the two families must never read alike.
 */
const BUFFER_LAYER_CHIPS: {
  id: LayerId;
  label: string;
  band: string;
  hue: 'amber' | 'emerald' | 'violet' | 'sky';
  hint: string;
  /** Gear tooltip — what the layer's own settings dialog controls. */
  settingsLabel: string;
}[] = [
  { id: 'floorH', label: 'Min floor', band: '→ BUFFER', hue: 'amber',
    hint: 'Hard minimum cash per currency',
    settingsLabel: 'Minimum liquidity buffer per currency — hard cash floor (M FCY)' },
  { id: 'sigmaP', label: 'Payout σ buffer', band: '→ BUFFER', hue: 'amber',
    hint: 'Safety margin on uncovered payout deficit (prefunded payout → σ = 0)',
    settingsLabel: 'Forecast uncertainty σ — default and per-currency payout overrides' },
  { id: 'cfarCover', label: 'CFaR cover', band: '→ BUFFER · SWAP', hue: 'sky',
    hint: 'Fund a liquidity swap from FX-only Net CFaR (size + timing). Displayed CFaR then includes this swap\'s rate-diff bridge.',
    settingsLabel: 'Net CFaR cover — FX-hedge cash-at-risk per currency, converted to FCY' },
  { id: 'carryOptim', label: 'Carry target', band: '→ BUFFER · SWAP', hue: 'emerald',
    hint: 'Rate-driven buffer shift (PAY sell / EARN buy)',
    settingsLabel: 'Carry target inputs — overdraft rate r_OD and Δr per currency' },
  { id: 'portfolioDiv', label: 'Portfolio VAR', band: '→ RISK', hue: 'violet',
    hint: 'Cross-currency rebalance with VAR / USD budget limits',
    settingsLabel: 'Portfolio VAR — notional sensitivity limit' },
];

type LayerChipHue = 'amber' | 'emerald' | 'violet' | 'sky';

const CHIP_ON: Record<LayerChipHue, string> = {
  amber: 'border-amber-200 bg-amber-50',
  emerald: 'border-emerald-200 bg-emerald-50',
  violet: 'border-violet-200 bg-violet-50',
  sky: 'border-sky-200 bg-sky-50',
};
const CHIP_BOX_ON: Record<LayerChipHue, string> = {
  amber: 'border-amber-500 bg-amber-500',
  emerald: 'border-emerald-500 bg-emerald-500',
  violet: 'border-violet-500 bg-violet-500',
  sky: 'border-sky-500 bg-sky-500',
};
const CHIP_TAG_ON: Record<LayerChipHue, string> = {
  amber: 'border-amber-200 text-amber-700',
  emerald: 'border-emerald-200 text-emerald-700',
  violet: 'border-violet-200 text-violet-700',
  sky: 'border-sky-200 text-sky-700',
};
const CHIP_GEAR_ON: Record<LayerChipHue, string> = {
  amber: 'bg-amber-100 text-amber-700',
  emerald: 'bg-emerald-100 text-emerald-700',
  violet: 'bg-violet-100 text-violet-700',
  sky: 'bg-sky-100 text-sky-700',
};
const MODAL_HEAD_BG: Record<LayerChipHue, string> = {
  amber: 'bg-amber-50',
  emerald: 'bg-emerald-50',
  violet: 'bg-violet-50',
  sky: 'bg-sky-50',
};
const MODAL_TITLE_FG: Record<LayerChipHue, string> = {
  amber: 'text-amber-700',
  emerald: 'text-emerald-700',
  violet: 'text-violet-700',
  sky: 'text-sky-700',
};

/** Settings dialog for one buffer layer, opened from that layer's gear. */
function LayerModal({
  hue,
  title,
  subtitle,
  readout,
  footnote,
  simDark,
  size = 'md',
  onClose,
  children,
}: {
  hue: LayerChipHue;
  title: string;
  subtitle: string;
  readout?: string;
  footnote: string;
  simDark: boolean;
  /** 'lg' widens to a table-width dialog and scrolls the body. */
  size?: 'md' | 'lg';
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[12vh] backdrop-blur-sm${
        simDark ? ' sim-dark' : ''
      }`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl ${
          size === 'lg' ? 'max-w-5xl' : 'max-w-3xl'
        }`}
      >
        <div
          className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-100 px-4 py-3 ${MODAL_HEAD_BG[hue]}`}
        >
          <span className={`${toolCaption} ${MODAL_TITLE_FG[hue]}`}>{title}</span>
          <span className="text-[10px] text-gray-500">{subtitle}</span>
          {readout && (
            <span className="ml-auto font-mono text-[10px] tabular-nums text-gray-500">
              {readout}
            </span>
          )}
        </div>
        <div className={`px-4 py-3${size === 'lg' ? ' max-h-[68vh] overflow-y-auto' : ''}`}>
          {children}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-gray-100 bg-gray-50 px-4 py-2.5">
          <span className="font-mono text-[9px] leading-snug text-gray-500">{footnote}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md border border-gray-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Book cell entry. On a locked view (the liquidity book is model-driven) the
 * value is plain text — no field, no caret — so only formulas can change it.
 */
function CellInput({
  locked,
  className,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & { locked?: boolean }) {
  if (!locked) return <input {...input} className={className} />;
  return (
    <span className={`inline-block ${className ?? ''}`}>
      {input.value === undefined || input.value === null ? '' : String(input.value)}
    </span>
  );
}

/** Row-expand clicks skip editors, formula cells, and the ▸ control itself. */
function isLiquidityRowToggleTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    'input, textarea, select, button, a, [contenteditable="true"], [data-formula-col]',
  );
}

// ─── Style constants ──────────────────────────────────────────────────────────

const POLICY_VAR_LIMITS = [
  { usd: 5, label: '$5M', who: 'Treasury' },
  { usd: 10, label: '$10M', who: 'Director' },
  { usd: 20, label: '$20M', who: 'CFO' },
] as const;
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

const thBase = 'px-1.5 py-1 text-[11px] leading-tight font-semibold text-gray-600 whitespace-nowrap align-bottom text-right';
const tdBase = 'px-1.5 py-0.5 text-right text-[11px] whitespace-nowrap tabular-nums';
const inBase = 'text-right text-xs border-0 bg-transparent focus:bg-white focus:ring-1 focus:ring-blue-400 rounded px-0.5 outline-none';
/** Per-cycle breakout row under a currency — same columns, lighter weight. */
const cycleTd = 'px-1.5 py-0.5 text-right font-mono text-[10px] whitespace-nowrap tabular-nums';

// ─── Carry desk tokens (carryOptim modal) ────────────────────────────────────
const carryTh = 'px-1.5 py-1 text-right text-[9px] font-semibold uppercase tracking-[0.06em] text-gray-500 whitespace-nowrap';
const carryTd = 'px-1.5 py-1 text-right font-mono text-[10px] tabular-nums whitespace-nowrap';
const carryIn = 'w-full rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-right font-mono text-[10px] tabular-nums text-gray-800 outline-none focus:ring-1 focus:ring-emerald-400';
const carryPnl = (v: number) => (v >= 0 ? 'text-emerald-700' : 'text-red-600');
const carrySeg = (on: boolean) =>
  `rounded px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors ${
    on ? 'bg-emerald-100 text-emerald-800' : 'text-gray-500 hover:text-gray-700'
  }`;

// ─── Desk segmented control ──────────────────────────────────────────────────
// One track, one lit segment in the hue of the band the control moves: forecast
// → LIQUIDITY sky, funding → SWAP emerald, strategy → FX HEDGE rose. Disabled
// dims rather than greying, so a conditional control cannot read as broken.
// The track recesses on the white toolbar card and lifts on the gray layers rail,
// so it reads as a control on either surface instead of melting into it.
const segTrack = (surface: 'card' | 'rail'): string =>
  `inline-flex rounded-md border border-gray-200 p-0.5 ${
    surface === 'rail' ? 'bg-white' : 'bg-gray-50'
  }`;
const SEG_ON: Record<'sky' | 'emerald' | 'rose', string> = {
  sky: 'bg-sky-100 text-sky-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  rose: 'bg-rose-100 text-rose-800',
};
const deskSeg = (on: boolean, hue: keyof typeof SEG_ON) =>
  `rounded px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
    on ? SEG_ON[hue] : 'text-gray-500 hover:text-gray-700'
  }`;
function forecastProfileUi(dark: boolean) {
  if (!dark) {
    return {
      panel:
        'flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white p-5 shadow-2xl',
      title: 'text-sm font-semibold text-gray-900',
      desc: 'mt-0.5 font-mono text-[11px] text-gray-500',
      close:
        'rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50',
      tfChip:
        'inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-sky-800',
      chrome:
        'mt-3 flex shrink-0 flex-wrap items-center gap-2 border-y border-gray-200 bg-gray-50 px-1 py-2',
      modeWrap: 'flex rounded-lg border border-gray-200 bg-gray-50 p-0.5',
      modeOn: 'rounded-md px-2.5 py-1 text-xs font-medium bg-blue-600 text-white',
      modeOff:
        'rounded-md px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-white',
      growthLabel:
        'inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-700',
      growthInput:
        'w-14 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-400',
      growthInherited:
        'w-full max-w-[72px] border-0 bg-transparent px-1.5 py-0.5 text-right font-mono text-[11px] italic tabular-nums text-gray-400 outline-none focus:rounded focus:border focus:border-blue-500 focus:bg-white focus:not-italic focus:text-gray-900 focus:ring-1 focus:ring-blue-400',
      actionBtn:
        'rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50',
      hint: 'text-[10px] text-gray-500',
      sectionRow:
        'sticky top-[29px] z-[5] border-t border-gray-200 bg-gray-50 px-2 py-1 text-left text-[9px] font-semibold uppercase tracking-[0.09em] text-gray-500',
      groupHead:
        'text-[9px] font-semibold uppercase tracking-[0.09em] text-gray-400',
      tableWrap:
        'mt-0 min-h-0 flex-1 overflow-auto rounded-b-lg border border-t-0 border-gray-300 bg-white',
      th: 'border-l border-gray-200 bg-gray-50 px-2 py-1.5 text-right text-[11px] font-semibold text-gray-600 whitespace-nowrap',
      td: 'border-l border-gray-200 border-t border-gray-100 bg-white px-1.5 py-0.5 text-right align-middle font-mono text-[11px] tabular-nums',
      input:
        'w-full min-w-0 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-400',
    colAmt: 'w-[88px] max-w-[88px]',
    colGrowth: 'w-[72px] max-w-[72px]',
    colSum: 'w-[96px] max-w-[112px]',
      rowIn: '',
      rowOut: '',
      signIn: 'border-l-2 border-emerald-600',
      signOut: 'border-l-2 border-rose-500',
      sideTagIn:
        'ml-1 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-700',
      sideTagOut:
        'ml-1 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-rose-700',
      formulaOverride: 'bg-sky-50 ring-1 ring-inset ring-sky-300 text-sky-800',
      formulaCell: 'cursor-pointer hover:bg-gray-50',
      editableTd: '',
      footer:
        'mt-0 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-3',
      done:
        'rounded border border-blue-500 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-100',
      textPrimary: 'text-gray-900',
      textSecondary: 'text-gray-600',
      textMuted: 'text-gray-400',
      textNegative: 'text-red-600',
      textValue: 'text-gray-800',
      textNet: 'font-semibold text-emerald-700',
      sigmaSet:
        'ml-1 rounded border border-amber-400 px-1 py-px text-[9px] font-semibold text-amber-800',
      sigmaUnset:
        'ml-1 rounded px-1 py-px text-[9px] font-semibold text-gray-400',
      lineClickable:
        'cursor-pointer underline decoration-dotted decoration-gray-400 underline-offset-2 hover:bg-sky-50 hover:decoration-sky-500',
      gBadge:
        'ml-1 rounded border border-gray-300 px-1 py-px text-[9px] font-semibold italic text-gray-500',
      netRow: 'border-t-2 border-gray-400',
    };
  }
  return {
    panel:
      'sim-dark flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl text-slate-100',
    title: 'text-sm font-semibold text-slate-100',
    desc: 'mt-0.5 font-mono text-[11px] text-slate-400',
    close:
      'rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800',
    tfChip:
      'inline-flex items-center gap-1 rounded-md border border-sky-700/50 bg-sky-950/50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-sky-200',
    chrome:
      'mt-3 flex shrink-0 flex-wrap items-center gap-2 border-y border-slate-700 bg-slate-950/40 px-1 py-2',
    modeWrap:
      'flex rounded-lg border border-slate-600 bg-slate-950/60 p-0.5',
    modeOn:
      'rounded-md px-2.5 py-1 text-xs font-medium bg-sky-600 text-white shadow-sm',
    modeOff:
      'rounded-md px-2.5 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200',
    growthLabel:
      'inline-flex items-center gap-1.5 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-[11px] text-slate-300',
    growthInput:
      'w-14 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-sky-100 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20',
    /** Inherited growth: bare italic — no box (design handoff). */
    growthInherited:
      'w-full max-w-[72px] border-0 bg-transparent px-1.5 py-0.5 text-right font-mono text-[11px] italic tabular-nums text-slate-500 outline-none placeholder:text-slate-600 focus:rounded focus:border focus:border-sky-500 focus:bg-slate-950 focus:not-italic focus:text-sky-100 focus:ring-2 focus:ring-sky-500/20',
    actionBtn:
      'rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700',
    hint: 'text-[10px] text-slate-500',
    sectionRow:
      'sticky top-[29px] z-[5] border-t border-slate-800 bg-slate-900/95 px-2 py-1 text-left text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-500',
    groupHead:
      'text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-600',
    tableWrap:
      'mt-0 min-h-0 flex-1 overflow-auto rounded-b-lg border border-t-0 border-slate-700 bg-slate-950',
    th: 'border-l border-slate-800 bg-slate-950 px-2 py-1.5 text-right text-[11px] font-semibold text-slate-400 whitespace-nowrap',
    td: 'border-l border-slate-800 border-t border-slate-800 bg-transparent px-1.5 py-0.5 text-right align-middle font-mono text-[11px] tabular-nums text-slate-200',
    input:
      'w-full min-w-0 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-sky-100 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20',
    colAmt: 'w-[88px] max-w-[88px]',
    colGrowth: 'w-[72px] max-w-[72px]',
    colSum: 'w-[96px] max-w-[112px]',
    /** Direction is the Line-cell sign rail — not a full-row wash. */
    rowIn: '',
    rowOut: '',
    signIn: 'border-l-2 border-emerald-600',
    signOut: 'border-l-2 border-rose-600',
    sideTagIn:
      'ml-1 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-400/90',
    sideTagOut:
      'ml-1 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-rose-400/90',
    formulaOverride:
      'bg-sky-950/60 ring-1 ring-inset ring-sky-500/45 text-sky-200',
    formulaCell:
      'cursor-pointer hover:bg-slate-800/60 active:bg-slate-700/60',
    editableTd: '',
    footer:
      'mt-0 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-700 bg-slate-900 px-0.5 pt-3',
    done:
      'rounded border border-sky-500 bg-sky-600/20 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-600/35',
    textPrimary: 'text-slate-100',
    textSecondary: 'text-slate-400',
    textMuted: 'text-slate-500',
    textNegative: 'text-rose-400',
    textValue: 'text-slate-300',
    textNet: 'font-semibold text-emerald-300',
    sigmaSet:
      'ml-1 rounded border border-amber-500/35 px-1 py-px text-[9px] font-semibold text-amber-300',
    sigmaUnset:
      'ml-1 rounded px-1 py-px text-[9px] font-semibold text-slate-600',
    lineClickable:
      'cursor-pointer underline decoration-dotted decoration-slate-500 underline-offset-2 hover:decoration-sky-400',
    gBadge:
      'ml-1 rounded border border-slate-600 px-1 py-px text-[9px] font-semibold italic text-slate-400',
    netRow: 'border-t-2 border-slate-600',
  };
}
type ForecastUi = ReturnType<typeof forecastProfileUi>;

const SHAPE_PRESETS: {
  id: string;
  label: string;
  title: string;
  shape: FlowShape;
}[] = [
  {
    id: 'start',
    label: 'Start',
    title: 'Settles on the first day of the month',
    shape: { from: 0, to: 0, curve: 'lump' },
  },
  {
    id: 'even',
    label: 'Even',
    title: 'Spread evenly across the month',
    shape: { from: 0, to: 1, curve: 'even' },
  },
  {
    id: 'mid',
    label: 'Mid',
    title: 'Clustered around mid-month',
    shape: { from: 0.4, to: 0.6, curve: 'even' },
  },
  {
    id: 'end',
    label: 'End',
    title: 'Settles on the last day of the month',
    shape: { from: 1, to: 1, curve: 'lump' },
  },
];

const CURVE_OPTIONS: { id: FlowCurve; label: string }[] = [
  { id: 'lump', label: 'Lump' },
  { id: 'even', label: 'Even' },
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
];

const GRANULARITY_OPTIONS: { id: LiquidityGranularity; label: string }[] = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' },
];

const sameShape = (a: FlowShape, b: FlowShape): boolean =>
  a.curve === b.curve &&
  Math.abs(a.from - b.from) < 1e-9 &&
  Math.abs(a.to - b.to) < 1e-9;

/** Shape window as 1-based day-of-month numbers for the editor. */
const shapeDayFrom = (s: FlowShape): number => dayOfMonthForFraction(s.from) + 1;
const shapeDayTo = (s: FlowShape): number =>
  s.curve === 'lump' ? shapeDayFrom(s) : dayOfMonthForFraction(s.to) + 1;
const dayToFraction = (d: number): number =>
  Math.min(
    LADDER_DAYS_PER_MONTH - 1,
    Math.max(0, Math.round(Number.isFinite(d) ? d : 1) - 1),
  ) / LADDER_DAYS_PER_MONTH;

function shapeLandsLabel(s: FlowShape): string {
  const from = shapeDayFrom(s);
  const to = shapeDayTo(s);
  return from === to ? `D${from}` : `D${from}–D${to}`;
}

/**
 * Liquidity view of the Forecast profile modal — when inside the cycle each
 * monthly line settles. Monthly amounts stay in the Flows view; here only the
 * timing is edited, which is what turns the trough into a dated minimum.
 */
function LiquidityTimingPanel({
  fpu,
  simDark,
  rows,
  forecastMonths,
  timing,
  profile,
  hedgeSettleByCcy,
  shared,
  activeLayers,
  bookTargetByCcy,
  cfarNetByCcyUsd,
  onTimingChange,
}: {
  fpu: ForecastUi;
  simDark: boolean;
  rows: RowState[];
  forecastMonths: number;
  timing: LiquidityTiming;
  profile: ForecastProfileState;
  hedgeSettleByCcy?: HedgeSettleByCcy;
  shared: SharedGlobals;
  activeLayers: Set<LayerId>;
  /** Target the book settled per currency — anchors the preview to the desk's grid. */
  bookTargetByCcy?: Record<string, number>;
  cfarNetByCcyUsd?: Record<string, number>;
  onTimingChange?: (patch: Partial<LiquidityTiming>) => void;
}) {
  const fcyRows = rows.filter(r => r.ccy !== 'USD');
  const [scope, setScope] = useState<string>('all');
  const scopeCcy = scope === 'all' ? '' : scope;
  const previewRow =
    fcyRows.find(r => r.ccy === scope) ?? fcyRows[0] ?? null;

  const chip = (on: boolean): string =>
    `rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
      on
        ? simDark
          ? 'bg-sky-600/30 text-sky-100'
          : 'bg-blue-100 text-blue-900'
        : simDark
          ? 'text-slate-400 hover:bg-slate-800'
          : 'text-gray-500 hover:bg-gray-100'
    }`;

  const writeShape = (field: LiquidityLineKey, shape: FlowShape | null) => {
    if (!onTimingChange) return;
    if (scope === 'all') {
      const byField = { ...(timing.byField ?? {}) };
      if (shape) byField[field] = shape;
      else delete byField[field];
      onTimingChange({ byField });
      return;
    }
    const byCcy = { ...(timing.byCcy ?? {}) };
    const forCcy = { ...(byCcy[scope] ?? {}) };
    if (shape) forCcy[field] = shape;
    else delete forCcy[field];
    if (Object.keys(forCcy).length > 0) byCcy[scope] = forCcy;
    else delete byCcy[scope];
    onTimingChange({ byCcy });
  };

  const hasOverride = (field: LiquidityLineKey): boolean =>
    scope === 'all'
      ? timing.byField?.[field] !== undefined
      : timing.byCcy?.[scope]?.[field] !== undefined;

  // Hedge settlement is not a forecast input — the amounts come from the hedge
  // book, so this line exposes only its timing plus the schedule behind it.
  const hedgeSettle = previewRow ? hedgeSettleByCcy?.[previewRow.ccy] : undefined;
  const hedgeMonths = (hedgeSettle ?? [])
    .map((amount, index) => ({ month: index + 1, amount }))
    .filter(h => Math.abs(h.amount) > 1e-9);
  const hedgeNet = hedgeMonths.reduce((s, h) => s + h.amount, 0);
  const anyHedges = Object.values(hedgeSettleByCcy ?? {}).some(series =>
    series.some(v => Math.abs(v) > 1e-9),
  );

  const timingLines: {
    key: LiquidityLineKey;
    label: string;
    side: ForecastFlowSide;
    note?: string;
    noteTitle?: string;
  }[] = [
    ...forecastFlowLinesGrouped().map(l => ({
      key: l.key as LiquidityLineKey,
      label: l.label,
      side: l.side,
    })),
    ...(anyHedges
      ? [{
          key: HEDGE_SETTLE_LINE as LiquidityLineKey,
          label: 'Hedge settle',
          side: hedgeSettleSide(hedgeNet),
          note: hedgeMonths.length > 0
            ? hedgeMonths.map(h => `M${h.month} ${f2(h.amount)}`).join(' · ')
            : `none in ${previewRow?.ccy ?? 'this CCY'}`,
          noteTitle:
            'FCY leg of booked and staged hedges. Lands on the cash path and sizes Swap near / book once a buffer layer is on.',
        }]
      : []),
  ];

  const cycleWindow = shapeCycleWindow(timing, scopeCcy);
  const livePlanProfile = { ...profile, liquidity: { ...timing, enabled: true } };
  const ladder = previewRow
    ? buildLiquidityLadder(previewRow, livePlanProfile, {
        months: forecastMonths,
        hedgeSettle,
      })
    : null;
  // The funded plan, not the bare path: each cycle opens where its own near leg
  // left it, which is what keeps a repeating drain from compounding into a swap
  // the size of the whole horizon.
  const previewCfarFcy = previewRow
    ? usdToFcyM(cfarNetByCcyUsd?.[previewRow.ccy] ?? 0, previewRow.ccy)
    : 0;
  const plan = ladder && previewRow
    ? fundedPlanFor(
        previewRow, shared, activeLayers, ladder, livePlanProfile, hedgeSettle,
        bookTargetByCcy?.[previewRow.ccy], undefined, previewCfarFcy,
      )
    : [];
  // Sizing reads the requirement chain — a leg per cycle — whichever way the cover
  // is booked. Trough Cash is this path's operating low, including FX settlement.
  const sizingPlan = ladder && previewRow && (timing.bookingMode ?? 'rolling') === 'term'
    ? fundedPlanFor(
        previewRow, shared, activeLayers, ladder, livePlanProfile, hedgeSettle,
        bookTargetByCcy?.[previewRow.ccy], 'rolling', previewCfarFcy,
      )
    : plan;
  const sizing = sizingPlan.length > 0
    ? sizingFromPlan(sizingPlan, timing.sizingBasis ?? 'horizon')
    : null;
  const bucketsPerCycle =
    LADDER_DAYS_PER_MONTH /
    (timing.granularity === 'day' ? 1 : timing.granularity === 'week' ? 7 : 30);

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label
          className={fpu.growthLabel}
          title="Off keeps the lump-sum trough — every payout before any payin, and NWC, debt, investing and hedge settlement out of it entirely"
        >
          <input
            type="checkbox"
            checked={timing.enabled}
            onChange={e => onTimingChange?.({ enabled: e.target.checked })}
            className="h-3 w-3 accent-sky-600"
          />
          <span className="whitespace-nowrap">Drive trough from timing</span>
        </label>
        <div className={fpu.modeWrap} role="group" aria-label="Ladder granularity">
          {GRANULARITY_OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              onClick={() => onTimingChange?.({ granularity: o.id })}
              className={`transition-colors ${
                timing.granularity === o.id ? fpu.modeOn : fpu.modeOff
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className={`font-mono text-[11px] ${fpu.textSecondary}`}>
          {Math.max(1, forecastMonths)}m ×{' '}
          {GRANULARITY_OPTIONS.find(o => o.id === timing.granularity)?.label.toLowerCase()} ={' '}
          {Math.round(Math.max(1, forecastMonths) * bucketsPerCycle)} buckets
        </span>
        <span className={`font-mono text-[11px] ${fpu.textSecondary}`}>
          cycle window{' '}
          <span className={fpu.textPrimary}>
            D{cycleWindow.startDay + 1} → D{cycleWindow.endDay + 1}
          </span>{' '}
          ({cycleWindow.lengthDays}d)
        </span>
      </div>

      {/* Basis and convention are set on the desk rail, where their effect on the
          swap band is visible. Here they only read out against the preview CCY. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={`text-[10px] uppercase tracking-wide ${fpu.textMuted}`}>
          Funding
        </span>
        <span
          className={`font-mono text-[11px] ${fpu.textSecondary}`}
          title="Set on the desk toolbar under Swap funding"
        >
          sized on{' '}
          <span className={fpu.textPrimary}>
            {SIZING_BASIS_OPTIONS.find(o => o.id === (timing.sizingBasis ?? 'horizon'))?.label}
          </span>
          {' · booked as '}
          <span className={fpu.textPrimary}>
            {BOOKING_MODE_OPTIONS.find(o => o.id === (timing.bookingMode ?? 'rolling'))?.label}
          </span>
        </span>
        {sizing && plan.length > 1 && (
          <span
            className={`font-mono text-[11px] ${fpu.textSecondary}`}
            title={`The cycle whose operating low sizes H* in ${previewRow?.ccy ?? 'this CCY'}, and`
              + ' the cover it needs. Trough Cash is that cycle’s dated low with no'
              + ' funding swap in it; the near leg is the separate Swap column.'}
          >
            binding{' '}
            <span className={fpu.textPrimary}>
              M{sizing.index + 1} @ {f2(ladder?.cycles[sizing.index]?.low ?? sizing.trough)}
            </span>
            {' · cover '}
            <span className={fpu.textPrimary}>
              {f2(sizingPlan[sizing.index]?.swap_needed ?? 0)}
            </span>
          </span>
        )}
        {plan.length > 0 && (
          <span
            className={`font-mono text-[11px] ${fpu.textSecondary}`}
            title={(timing.bookingMode ?? 'rolling') === 'term'
              ? `One leg today, held to M${plan.length}`
              : `${f2(plan[0]?.swap_needed ?? 0)} today, then a leg every cycle — the legs roll, so the book adds up`}
          >
            {(timing.bookingMode ?? 'rolling') === 'term' ? 'term leg ' : 'book now '}
            <span className={fpu.textPrimary}>{f2(plan[0]?.swap_needed ?? 0)}</span>
            {' · outstanding M'}
            {plan.length}{' '}
            <span className={fpu.textPrimary}>
              {f2(plan[plan.length - 1]?.standing_swap ?? 0)}
            </span>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`text-[10px] uppercase tracking-wide ${fpu.textMuted}`}>
          Applies to
        </span>
        <button type="button" onClick={() => setScope('all')} className={chip(scope === 'all')}>
          All CCY
        </button>
        {fcyRows.map(r => (
          <button
            key={r.ccy}
            type="button"
            onClick={() => setScope(r.ccy)}
            className={chip(scope === r.ccy)}
          >
            {r.ccy}
            {timing.byCcy?.[r.ccy] && Object.keys(timing.byCcy[r.ccy]!).length > 0 ? ' •' : ''}
          </button>
        ))}
      </div>

      <div className={`overflow-x-auto rounded-lg border ${simDark ? 'border-slate-700' : 'border-gray-200'}`}>
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className={`${fpu.th} border-l-0 text-left`}>Line</th>
              <th className={fpu.th}>Preset</th>
              <th className={fpu.th} title="First day of the settlement window">
                From
              </th>
              <th className={fpu.th} title="Last day of the settlement window">
                To
              </th>
              <th className={fpu.th}>Curve</th>
              <th className={fpu.th}>Lands</th>
              <th className={fpu.th} />
            </tr>
          </thead>
          <tbody>
            {timingLines.map(line => {
              const shape = resolveFlowShape(timing, scopeCcy, line.key, line.side);
              const out = line.side === 'out';
              return (
                <tr key={line.key}>
                  <td className={`${fpu.td} border-l-0 text-left ${out ? fpu.signOut : fpu.signIn}`}>
                    {line.label}
                    <span className={out ? fpu.sideTagOut : fpu.sideTagIn}>
                      {out ? 'out' : 'in'}
                    </span>
                    {line.note && (
                      <span
                        className={`ml-1.5 font-normal ${fpu.textMuted}`}
                        title={line.noteTitle}
                      >
                        {line.note}
                      </span>
                    )}
                  </td>
                  <td className={fpu.td}>
                    <div className="flex justify-end gap-1">
                      {SHAPE_PRESETS.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          title={p.title}
                          onClick={() => writeShape(line.key, p.shape)}
                          className={chip(sameShape(shape, p.shape))}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className={fpu.td}>
                    <input
                      type="number"
                      min={1}
                      max={LADDER_DAYS_PER_MONTH}
                      value={shapeDayFrom(shape)}
                      onChange={e =>
                        writeShape(line.key, {
                          ...shape,
                          from: dayToFraction(Number(e.target.value)),
                        })
                      }
                      className={`${fpu.input} w-14`}
                    />
                  </td>
                  <td className={fpu.td}>
                    <input
                      type="number"
                      min={1}
                      max={LADDER_DAYS_PER_MONTH}
                      value={shapeDayTo(shape)}
                      disabled={shape.curve === 'lump'}
                      onChange={e =>
                        writeShape(line.key, {
                          ...shape,
                          to: dayToFraction(Number(e.target.value)),
                        })
                      }
                      className={`${fpu.input} w-14 disabled:opacity-40`}
                    />
                  </td>
                  <td className={fpu.td}>
                    <select
                      value={shape.curve}
                      onChange={e =>
                        writeShape(line.key, {
                          ...shape,
                          curve: e.target.value as FlowCurve,
                        })
                      }
                      className={`${fpu.input} w-20 text-left`}
                    >
                      {CURVE_OPTIONS.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={`${fpu.td} ${fpu.textValue}`}>{shapeLandsLabel(shape)}</td>
                  <td className={fpu.td}>
                    {hasOverride(line.key) ? (
                      <button
                        type="button"
                        onClick={() => writeShape(line.key, null)}
                        className={chip(false)}
                        title={
                          scope === 'all'
                            ? 'Drop this line override — inherit the side default'
                            : `Drop the ${scope} override — inherit the all-CCY shape`
                        }
                      >
                        reset
                      </button>
                    ) : (
                      <span className={fpu.textMuted}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {ladder && previewRow && (
        <LadderPreview
          fpu={fpu}
          simDark={simDark}
          ccy={previewRow.ccy}
          ladder={ladder}
          plan={plan}
          bindingCycle={sizing?.index ?? 0}
          bookingMode={timing.bookingMode ?? 'rolling'}
        />
      )}
    </div>
  );
}

/** Bucketed cash path for one currency, with the trough and floor marked. */
function LadderPreview({
  fpu,
  simDark,
  ccy,
  ladder,
  plan,
  bindingCycle,
  bookingMode,
}: {
  fpu: ForecastUi;
  simDark: boolean;
  ccy: string;
  ladder: LiquidityLadderResult;
  /** Funded per-cycle plan — same cycles as the ladder, each one funded. */
  plan: readonly LiquidityCycleProjection[];
  bindingCycle: number;
  bookingMode: LiquidityBookingMode;
}) {
  const lows = ladder.buckets.map(b => b.low);
  const min = Math.min(0, ladder.floor, ...lows);
  const max = Math.max(0, ladder.opening, ...lows);
  const span = max - min || 1;
  const pos = (v: number): number => ((v - min) / span) * 100;

  return (
    <div className={`rounded-lg border p-3 ${simDark ? 'border-slate-700 bg-slate-950/40' : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[11px]">
        <span className={fpu.textPrimary}>{ccy}</span>
        <span className={fpu.textSecondary}>
          opening <span className={fpu.textValue}>{f2(ladder.opening)}</span>
        </span>
        <span
          className={fpu.textSecondary}
          title={
            bindingCycle === 0
              ? 'Low inside cycle 1 — this is what sizes H* and the swap'
              : `Low inside cycle 1 — H* and the swap size against cycle M${bindingCycle + 1} instead`
          }
        >
          cycle trough{' '}
          <span className={ladder.cycleTrough < ladder.floor ? fpu.textNegative : fpu.textValue}>
            {f2(ladder.cycleTrough)}
          </span>{' '}
          <span className={fpu.textMuted}>D{ladder.cycleTroughDay + 1}</span>
        </span>
        <span className={fpu.textSecondary} title="Cycle 1 closing — every month-1 line settled">
          cycle end <span className={fpu.textValue}>{f2(ladder.cycleClosing)}</span>
        </span>
        {ladder.months > 1 && (
          <span
            className={fpu.textSecondary}
            title="Lowest point of the unfunded path — a forecast signal, not a funding need: sizing runs on the funded cycles below"
          >
            horizon low{' '}
            <span className={ladder.trough < ladder.floor ? fpu.textNegative : fpu.textValue}>
              {f2(ladder.trough)}
            </span>{' '}
            <span className={fpu.textMuted}>D{ladder.troughDay + 1}</span>
          </span>
        )}
        <span className={fpu.textSecondary}>
          closing <span className={fpu.textValue}>{f2(ladder.closing)}</span>
        </span>
        <span className={fpu.textSecondary}>
          floor <span className={fpu.textValue}>{f2(ladder.floor)}</span>
        </span>
        {ladder.daysBelowFloor > 0 && (
          <span className={fpu.textNegative}>
            {ladder.daysBelowFloor}d below floor
            {ladder.months > 1 ? ` (${ladder.cycleDaysBelowFloor}d in cycle 1)` : ''}
          </span>
        )}
      </div>
      <div className="mt-2 overflow-x-auto">
        <div className="flex min-w-max items-end gap-[3px]">
          {ladder.buckets.map(b => {
            const bottom = Math.min(b.low, 0);
            const top = Math.max(b.low, 0);
            const isTrough = b.index === ladder.troughBucket;
            return (
              <div key={b.index} className="flex w-[26px] shrink-0 flex-col items-center gap-1">
                <div
                  className={`relative h-16 w-full rounded-sm ${simDark ? 'bg-slate-900' : 'bg-white'}`}
                  title={`${b.label} · low ${f2(b.low)} · in ${f2(b.inflow)} · out ${f2(b.outflow)} · close ${f2(b.closing)}`}
                >
                  <div
                    className={`absolute inset-x-0 border-t border-dashed ${simDark ? 'border-slate-700' : 'border-gray-300'}`}
                    style={{ bottom: `${pos(0)}%` }}
                  />
                  <div
                    className={`absolute inset-x-0 border-t border-dashed ${simDark ? 'border-amber-500/50' : 'border-amber-400'}`}
                    style={{ bottom: `${pos(ladder.floor)}%` }}
                  />
                  <div
                    className={`absolute inset-x-[3px] rounded-sm ${
                      b.belowFloor
                        ? simDark ? 'bg-rose-500/70' : 'bg-rose-400'
                        : simDark ? 'bg-sky-500/60' : 'bg-sky-400'
                    } ${isTrough ? 'ring-1 ring-amber-400' : ''}`}
                    style={{
                      bottom: `${pos(bottom)}%`,
                      height: `${Math.max(2, ((top - bottom) / span) * 100)}%`,
                    }}
                  />
                </div>
                <span className={`font-mono text-[9px] ${isTrough ? fpu.textPrimary : fpu.textMuted}`}>
                  {b.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className={`mt-1.5 text-[10px] ${fpu.textMuted}`}>
        Bar = worst balance inside the bucket (outflows settle before inflows) ·
        amber dashes = cash floor · ringed bar holds the trough
      </div>

      <LiquidityCyclePlanTable
        fpu={fpu}
        simDark={simDark}
        plan={plan}
        cycles={ladder.cycles}
        floor={ladder.floor}
        bindingCycle={bindingCycle}
        bookingMode={bookingMode}
      />
    </div>
  );
}

/**
 * Funded per-cycle plan: what each cycle drains, the low it reaches, and the
 * near leg it needs. Shared by the Liquidity view of the forecast profile and
 * the expandable liquidity row in the grid.
 */
function LiquidityCyclePlanTable({
  fpu,
  simDark,
  plan,
  cycles,
  floor,
  bindingCycle,
  bookingMode,
}: {
  fpu: ForecastUi;
  simDark: boolean;
  plan: readonly LiquidityCycleProjection[];
  /** Dated shape of the same cycles — gross out / in and the day the low lands. */
  cycles: readonly LadderCycle[];
  floor: number;
  bindingCycle: number;
  bookingMode: LiquidityBookingMode;
}) {
  const term = bookingMode === 'term';
  return (
    <>
      <div className={`mt-3 overflow-x-auto rounded-md border ${simDark ? 'border-slate-700' : 'border-gray-200'}`}>
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className={`${fpu.th} border-l-0 text-left`}>Cycle</th>
              <th className={fpu.th} title="Opening balance on the funded path — the prior cycle's close, its near leg included">
                Open Balance
              </th>
              <th className={fpu.th} title="Everything leaving in the cycle, including NWC, debt, investing and hedge settlement">
                Out
              </th>
              <th className={fpu.th}>In</th>
              <th className={fpu.th} title="In − out inside the cycle — a flow, not a balance">
                Net Flow
              </th>
              <th className={fpu.th} title="Open balance − low: the cash this cycle drains at its deepest">
                Drawdown
              </th>
              <th className={fpu.th} title="Operating low this cycle reaches — dated path, no funding swap in it. The near leg is the next column.">
                Trough
              </th>
              <th className={fpu.th} title="Cushion this cycle has to hold at its trough">
                H*
              </th>
              <th className={fpu.th} title="New leg to add for this cycle, sized on the funded path so earlier cover is not double-counted">
                Near leg
              </th>
              <th className={fpu.th} title="Swap notional outstanding once this cycle's leg is on — every earlier leg is rolled, not run off, so the legs add up. Shown as Swap Book on the desk.">
                Swap Book
              </th>
              {!term && (
                <th className={fpu.th} title="How much of this cycle's leg exceeds the one booked today — bookable now as a forward-dated tranche. Term booking has nothing to pre-book: its single leg already covers the path.">
                  Tranche
                </th>
              )}
              <th className={fpu.th} title="Where the cycle closes with its own near leg on — the Cycle End column on the desk. The desk's Close Balance is the same cycle before the swap.">
                Cycle End
              </th>
            </tr>
          </thead>
          <tbody>
            {plan.map(p => {
              const shape = cycles[p.cycleIndex];
              const binds = p.cycleIndex === bindingCycle;
              return (
                <tr
                  key={p.cycleIndex}
                  className={binds ? (simDark ? 'bg-sky-900/30' : 'bg-sky-50') : undefined}
                >
                  <td className={`${fpu.td} border-l-0 text-left`}>
                    <span className={binds ? fpu.textPrimary : fpu.textSecondary}>
                      M{p.cycleIndex + 1}
                    </span>
                    {binds && (
                      <span
                        className={`ml-1.5 text-[9px] ${fpu.textMuted}`}
                        title="This is the low H* and the swap size against"
                      >
                        sizes H*
                      </span>
                    )}
                  </td>
                  <td className={fpu.td}>{f2(p.opening_cash)}</td>
                  <td className={`${fpu.td} ${(shape?.outflow ?? 0) > 0 ? fpu.textNegative : fpu.textMuted}`}>
                    {(shape?.outflow ?? 0) > 0 ? `−${f2(shape!.outflow)}` : '—'}
                  </td>
                  <td className={fpu.td}>
                    {(shape?.inflow ?? 0) > 0 ? f2(shape!.inflow) : '—'}
                  </td>
                  <td className={`${fpu.td} ${
                    !shape ? fpu.textMuted : shape.net < 0 ? fpu.textNegative : fpu.textValue
                  }`}>
                    {shape ? f2(shape.net) : '—'}
                  </td>
                  <td className={`${fpu.td} ${p.drawdown > 0 ? fpu.textNegative : fpu.textMuted}`}>
                    {p.drawdown > 0 ? f2(p.drawdown) : '—'}
                  </td>
                  <td
                    className={`${fpu.td} ${(shape?.low ?? p.forecasted_cash) < floor ? fpu.textNegative : fpu.textValue}`}
                    title={shape ? `operating low on D${shape.lowDay - shape.startDay + 1} of the cycle — no funding swap in it` : undefined}
                  >
                    {f2(shape?.low ?? p.forecasted_cash)}
                  </td>
                  <td className={fpu.td}>{f2(p.cash_threshold)}</td>
                  <td className={`${fpu.td} ${Math.abs(p.swap_needed) > 0.001 ? fpu.textPrimary : fpu.textMuted}`}>
                    {Math.abs(p.swap_needed) > 0.001 ? f2(p.swap_needed) : '—'}
                  </td>
                  <td className={`${fpu.td} ${Math.abs(p.standing_swap) > 0.001 ? fpu.textNegative : fpu.textMuted}`}>
                    {Math.abs(p.standing_swap) > 0.001 ? f2(p.standing_swap) : '—'}
                  </td>
                  {!term && (
                    <td className={`${fpu.td} ${p.incremental_swap > 0.001 ? fpu.textValue : fpu.textMuted}`}>
                      {p.incremental_swap > 0.001 ? f2(p.incremental_swap) : '—'}
                    </td>
                  )}
                  <td className={`${fpu.td} ${p.cycle_end_cash < floor ? fpu.textNegative : fpu.textValue}`}>
                    {f2(p.cycle_end_cash)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={`mt-1.5 text-[10px] ${fpu.textMuted}`}>
        {term
          ? `One term swap funds the whole path: the leg lands at M1 and the cash
             runs down cycle by cycle, so the Swap Book is flat while the closes
             fall. Every cycle still clears its own H* — the cover above it is
             what the term convention pays carry for.`
          : `Every cycle here is funded: its near leg is in place, so the next
             cycle opens where this one left it. Rolling a leg keeps its cash, it
             does not repay the drain — so when the drawdown repeats, the near leg
             stays flat while the Swap Book climbs by that leg every cycle. The
             Swap Book at the last cycle is the funding the horizon needs.`}
      </div>
    </>
  );
}

const FORECAST_FORMULA_SUGGESTIONS = [
  'prev',
  'k',
  'i',
  't',
  'rev',
  'revenue',
  'collections',
  'exp',
  'expense',
  'payout',
  'fcast',
  'fcastFX',
  'invoice',
  ...Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return [`m${n}`, `rev${n}`, `exp${n}`, `fcast${n}`, `$m${n}`];
  }).flat(),
  'abs',
  'min',
  'max',
  'round',
  'sqrt',
  'pow',
  'exp',
  'ln',
  'log',
];

function forecastSuggestionsFor(
  calcRows: readonly ForecastCalcRow[] | undefined,
): string[] {
  const refs = (calcRows ?? []).flatMap(c => [
    c.ref,
    ...Array.from({ length: 6 }, (_, i) => `${c.ref}m${i + 1}`),
  ]);
  return [...refs, ...FORECAST_FORMULA_SUGGESTIONS];
}

// ─── Component ────────────────────────────────────────────────────────────────

export function UnifiedSimulator({
  shared, onSharedChange,
  rows, setRows,
  usdCash, setUsdCash,
  usdNonLpCash, setUsdNonLpCash,
  usdParams, setUsdParams,
  onResetTable,
  activeLayers,
  onLayerToggle,
  policyVAR,
  onPolicyVARChange,
  portfolioSummary,
  fcyComputed,
  usdComputed,
  showRates = true,
  showFxPosition = true,
  showLiquidity = true,
  showBonds = false,
  showInvestments = false,
  showLiabilities = false,
  /** When false: hide rates toolbar layers, swap, hedge cols, carry (Task Mode simplified book). */
  showAdvancedBook = true,
  /** Risk Metrics / VaR column group — rendered immediately before P&L. */
  showRiskMetrics = false,
  /** Per-CCY VaR metrics for the Risk Metrics columns (keyed by currency). */
  riskMetricsByCcy = {},
  /**
   * Decision-layer booked spot/forward already included in fcyComputed.
   * Used when editing so write-back strips the overlay from the seed book.
   */
  bookedPositionByCcy = {},
  /**
   * FCY leg of booked and prepared hedges per currency and month — the dated
   * hedge line on the liquidity path (see the Liquidity view of the profile).
   */
  hedgeSettleByCcy = {},
  stagedHedgeCarryByCcyUsdM = {},
  stagedCashCarryByCcyUsdM = {},
  stagedCarryByMonthByCcyUsdM = {},
  cfarNetByCcyUsd = {},
  /** Analytics regime — labels VaR columns (confidence · horizon · basis). */
  varSetup,
  /** Sync FX Risk forecast period into Analytics / answers. */
  onVarSetupChange,
  forecastProfile = DEFAULT_FORECAST_PROFILE,
  onForecastProfileChange,
  forecastProfileOpen: forecastProfileOpenControlled,
  onForecastProfileOpenChange,
  /** When true, portaled modals keep the `.sim-dark` skin (body portal escapes the tree). */
  simDark = false,
  formulas,
  onFormulaChange,
  onFormulaChanges,
  /** Hide FX Hedge column group + hedging-strategy toolbar (Liquidity view). */
  hideFxHedge = false,
  /** 'carryOnly': P&L drops Net Delta; Cash + Swap + staged Hedge + Total stay. */
  pnlColumns = 'full',
  /** Read-only book: values come from the model and its formulas, not from typing. */
  lockValues = false,
}: {
  shared: SharedGlobals;
  onSharedChange: (key: keyof SharedGlobals, value: number) => void;
  rows: RowState[];
  setRows: React.Dispatch<React.SetStateAction<RowState[]>>;
  usdCash: number;
  setUsdCash: React.Dispatch<React.SetStateAction<number>>;
  usdNonLpCash: number;
  setUsdNonLpCash: React.Dispatch<React.SetStateAction<number>>;
  usdParams: UsdParams;
  setUsdParams: React.Dispatch<React.SetStateAction<UsdParams>>;
  /** Restore the dashboard seed book (not the full workbench currency catalog). */
  onResetTable?: () => void;
  activeLayers: Set<LayerId>;
  onLayerToggle: (id: LayerId) => void;
  policyVAR: number;
  onPolicyVARChange: (v: number) => void;
  portfolioSummary: PortfolioSummary | null;
  /** Precomputed FCY rows from unified background calculation (page.tsx). */
  fcyComputed: FcyComputedRow[];
  usdComputed: UsdComputedRow;
  /** Input-driven column-group visibility (from the FX risk-profile config). */
  showRates?: boolean;
  showFxPosition?: boolean;
  showLiquidity?: boolean;
  showBonds?: boolean;
  showInvestments?: boolean;
  showLiabilities?: boolean;
  showAdvancedBook?: boolean;
  showRiskMetrics?: boolean;
  riskMetricsByCcy?: Record<string, FxRiskMetricCell>;
  bookedPositionByCcy?: Record<string, BookedPositionOffset>;
  hedgeSettleByCcy?: HedgeSettleByCcy;
  /**
   * Staged Decision-layer FX-hedge FWD-points carry ($M) — same number as
   * Hedging Decision Carry / Cash Carry FWD pts. When set, P&L Hedge Carry
   * uses this instead of the table strategy overlay.
   */
  stagedHedgeCarryByCcyUsdM?: Record<string, number>;
  /**
   * Staged / booked dual-book cash interest ($M) — residual FCY int + USD int
   * from the Cash Carry forecast (same as table Total − FWD pts). When set,
   * P&L Cash Carry uses this instead of first-cycle LP NIM.
   */
  stagedCashCarryByCcyUsdM?: Record<string, number>;
  /**
   * M1…MT incremental Cash / Hedge Carry from the Cash Carry forecast.
   * Expanded cycle rows use this instead of dumping the path total on M1.
   */
  stagedCarryByMonthByCcyUsdM?: Record<string, { cashUsdM: number; fwdUsdM: number }[]>;
  /** FX-hedge Net CFaR per CCY (USD M) — sizes the CFaR cover layer. */
  cfarNetByCcyUsd?: Record<string, number>;
  varSetup?: VarSetup;
  onVarSetupChange?: (setup: VarSetup) => void;
  /** Flat monthly×T or custom per-period Revenue/Expenses. */
  forecastProfile?: ForecastProfileState;
  onForecastProfileChange?: (profile: ForecastProfileState) => void;
  /** Controlled open state for the Forecast profile modal (e.g. from Analytics). */
  forecastProfileOpen?: boolean;
  onForecastProfileOpenChange?: (open: boolean) => void;
  /** Apply `.sim-dark` to body-portaled modals (Task Mode / embedded). */
  simDark?: boolean;
  /** Per-cell formula overrides keyed `${ccy}::${fieldKey}`. */
  formulas?: Record<string, string>;
  onFormulaChange?: (cellKey: string, formula: string) => void;
  /** Batch formula writes (column fill-down) — prefer this over N× onFormulaChange. */
  onFormulaChanges?: (updates: Record<string, string>) => void;
  hideFxHedge?: boolean;
  pnlColumns?: 'full' | 'carryOnly';
  lockValues?: boolean;
}) {
  // IR / fixed-rate book section: shown when any of its inputs are selected.
  const irCols = (showBonds ? 2 : 0) + (showInvestments ? 2 : 0) + (showLiabilities ? 2 : 0);
  const showIrBook = showAdvancedBook && irCols > 0;
  const showCarry = showAdvancedBook;
  const showSwap = showAdvancedBook;
  const showFxHedge = showAdvancedBook && !hideFxHedge;
  const showPnl = showAdvancedBook;
  const pnlCarryOnly = pnlColumns === 'carryOnly';
  const pnlColCount = pnlCarryOnly ? 5 : 6;
  // Rates / IR only apply in the full book (Task Mode simplified view omits them).
  const ratesOn = showAdvancedBook && showRates;
  /** Task Mode: Debt + Investments live in FX POSITION; every FX cell is editable. */
  const simplifiedFx = !showAdvancedBook;
  /** … plus Hedge (FCY) / Hedge $USD broken out of Cash FX and Fwd. */
  const fxPosColSpan = (simplifiedFx ? 16 : 12) + 2;
  /** Exp · Booked H · Residual · VaR (after booked hedges; no Decision-% staging) */
  const riskMetricCols = 4;
  /**
   * The target each currency's layer stack settled on, carry requirement and
   * portfolio VaR budget included. The forecast-profile preview prices its plan
   * against it so the panel and this grid fund the same level.
   */
  const bookTargetByCcy = useMemo(
    () => Object.fromEntries(
      fcyComputed
        .filter(r => r.ccy !== 'USD')
        .map(r => [r.ccy, r.cash_threshold_pre_swap]),
    ),
    [fcyComputed],
  );
  /**
   * Non-LP cash is a book input, not part of the cycle path: it stays on the
   * editable book and off the read-only liquidity desk, which mirrors the
   * per-cycle plan (open → out → in → net → drawdown → trough → close).
   */
  const showNonLp = !lockValues;
  const liquidityCols = 9 + (showNonLp ? 1 : 0);
  const swapCols = 7;
  /** Width of the whole grid — full-width detail rows span it. Mirrors the band header. */
  const gridCols =
    1
    + (ratesOn ? 3 : 0)
    + (showFxPosition ? fxPosColSpan : 0)
    + (showLiquidity ? liquidityCols : 0)
    + (showIrBook ? irCols : 0)
    + (showCarry ? 3 : 0)
    + (showSwap ? swapCols : 0)
    + (showFxHedge ? 6 : 0)
    + (showRiskMetrics ? riskMetricCols : 0)
    + (showPnl ? pnlColCount : 0);
  /** Currency whose funded per-cycle liquidity plan is expanded under its row. */
  const [liqPlanCcy, setLiqPlanCcy] = useState<string | null>(null);
  const riskUsdTotals = useMemo(() => {
    let exp = 0;
    let fwd = 0;
    let resid = 0;
    let varUsdM = 0;
    for (const [ccy, m] of Object.entries(riskMetricsByCcy)) {
      exp += fcyToUsdM(m.exposureLocalM, ccy);
      fwd += fcyToUsdM(m.forwardHedgeLocalM ?? 0, ccy);
      resid += fcyToUsdM(m.residualLocalM ?? m.exposureLocalM, ccy);
      // Residual VaR after booked hedges (Decision % not applied here).
      varUsdM += m.varUsdM;
    }
    return { exp, fwd, resid, varUsdM };
  }, [riskMetricsByCcy]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [forecastProfileOpenLocal, setForecastProfileOpenLocal] = useState(false);
  const forecastProfileOpen =
    forecastProfileOpenControlled ?? forecastProfileOpenLocal;
  const setForecastProfileOpen = (open: boolean) => {
    onForecastProfileOpenChange?.(open);
    if (forecastProfileOpenControlled === undefined) {
      setForecastProfileOpenLocal(open);
    }
  };
  /** Collapsed Formula help disclosure in Forecast profile chrome. */
  const [forecastFormulaHelpOpen, setForecastFormulaHelpOpen] = useState(false);
  // Liquidity desk (no FX position columns) opens the profile on timing;
  // the FX Simulator opens it on the monthly amounts.
  const liquidityDesk = showLiquidity && !showFxPosition;
  const [forecastView, setForecastView] = useState<'flows' | 'liquidity'>(
    liquidityDesk ? 'liquidity' : 'flows',
  );
  useEffect(() => {
    if (forecastProfileOpen) setForecastView(liquidityDesk ? 'liquidity' : 'flows');
  }, [forecastProfileOpen, liquidityDesk]);
  /** Click line name → assign 1m projection uncertainty for that cash line. */
  const [lineUncertaintyEdit, setLineUncertaintyEdit] = useState<{
    ccy: string;
    field: ForecastFlowField;
    label: string;
    top: number;
    left: number;
  } | null>(null);
  const [lineUncertaintyDraft, setLineUncertaintyDraft] = useState('');
  const fpu = forecastProfileUi(simDark);

  // Explicit 0 = no forecast — do not coerce to 1.
  const forecastMonths =
    typeof shared.forecastMonths === 'number' && shared.forecastMonths >= 0
      ? shared.forecastMonths
      : typeof varSetup?.forecastMonths === 'number' && varSetup.forecastMonths >= 0
        ? varSetup.forecastMonths
        : 1;

  const liquidityTiming =
    resolveLiquidityTiming(forecastProfile) ?? DEFAULT_LIQUIDITY_TIMING;

  const updateLiquidityTiming = useCallback(
    (patch: Partial<LiquidityTiming>) => {
      if (!onForecastProfileChange) return;
      onForecastProfileChange({
        ...forecastProfile,
        liquidity: { ...liquidityTiming, ...patch },
      });
    },
    [onForecastProfileChange, forecastProfile, liquidityTiming],
  );

  // Sizing / booking write the forecast profile. They only *price* the book
  // once the dated path is on and Tf > 0 — the readout says so; the toggles
  // stay clickable so the convention can be set before that.
  const liquidityFundingWritable = Boolean(onForecastProfileChange);
  const liquidityFundingLive =
    liquidityFundingWritable && liquidityTiming.enabled && forecastMonths > 0;

  const setLineUncertainty = useCallback(
    (ccy: string, field: ForecastFlowField, u1m: number) => {
      if (!onForecastProfileChange) return;
      onForecastProfileChange(
        withLineUncertainty1m(
          ensureProfileForRows(forecastProfile, rows, forecastMonths),
          ccy,
          field,
          u1m,
        ),
      );
      // Keep Analytics / CFaR top-section u₁ₘ chips in sync with the line
      // editor (Revenue is the quantity-risk driver; other lines still bump
      // the shared control so Gross/Net CFaR visibly track the modal).
      if (onVarSetupChange) {
        const base = varSetup ?? DEFAULT_VAR_SETUP;
        if (Math.abs((base.forecastUncertainty1m ?? 0) - u1m) > 1e-12) {
          onVarSetupChange({ ...base, forecastUncertainty1m: u1m });
        }
      }
    },
    [
      onForecastProfileChange,
      onVarSetupChange,
      varSetup,
      forecastProfile,
      rows,
      forecastMonths,
    ],
  );

  const openLineUncertainty = useCallback(
    (
      e: ReactMouseEvent<HTMLElement>,
      ccy: string,
      field: ForecastFlowField,
      label: string,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onForecastProfileChange) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const lineU = lineUncertainty1m(forecastProfile, ccy, field);
      const globalU = varSetup?.forecastUncertainty1m ?? 0;
      // Prefer line override; else seed the editor from the shared top-section u₁ₘ.
      const u = lineU > 0 ? lineU : globalU > 0 ? globalU : 0;
      setLineUncertaintyDraft(
        u > 0 ? Number((u * 100).toFixed(2)).toString() : '',
      );
      setLineUncertaintyEdit({
        ccy,
        field,
        label,
        top: Math.min(rect.bottom + 4, window.innerHeight - 200),
        left: Math.max(8, rect.left),
      });
    },
    [onForecastProfileChange, forecastProfile, varSetup],
  );

  const offsetFor = useCallback(
    (ccy: string): BookedPositionOffset =>
      bookedPositionByCcy[ccy] ?? { spotLocalM: 0, fwdLocalM: 0 },
    [bookedPositionByCcy],
  );

  /** Booked + staged hedge sitting inside the FX book, broken out for its own column. */
  const hedgeFcyFor = useCallback(
    (ccy: string): number => {
      const o = offsetFor(ccy);
      return o.spotLocalM + o.fwdLocalM;
    },
    [offsetFor],
  );

  const hedgeCellTitle = useCallback(
    (ccy: string): string | undefined => {
      const o = offsetFor(ccy);
      const settle = (hedgeSettleByCcy[ccy] ?? [])
        .map((amount, i) => ({ month: i + 1, amount }))
        .filter(s => Math.abs(s.amount) > 1e-9);
      if (Math.abs(o.spotLocalM) < 1e-9 && Math.abs(o.fwdLocalM) < 1e-9
        && settle.length === 0) return undefined;
      const legs = `Booked/staged: spot ${f2(o.spotLocalM)} + forward ${f2(o.fwdLocalM)} M FCY`
        + ' — already inside Cash FX and Fwd, shown here so the overlay is visible.';
      if (settle.length === 0) return legs;
      return `${legs}\nSettles (booked + staged): `
        + settle.map(s => `M${s.month} ${f2(s.amount)}`).join(' · ')
        + ' — dated on the liquidity path and sized into Swap near / book once a buffer layer is on.';
    },
    [offsetFor, hedgeSettleByCcy],
  );

  const editRow = useCallback((
    id: string,
    field: keyof Omit<RowState, 'id' | 'ccy'>,
    raw: string,
    ccy?: string,
  ) => {
    setDrafts(prev => ({ ...prev, [`${id}.${field}`]: raw }));
    const val = roundMoney(parseFloat(raw));
    if (isNaN(val)) return;
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      if (field === 'spot' && ccy) {
        return { ...r, spot: roundMoney(val - offsetFor(ccy).spotLocalM) };
      }
      if (field === 'fwd' && ccy) {
        const seedFwdFcy = roundMoney(usdToFcyM(val, ccy) - offsetFor(ccy).fwdLocalM);
        return { ...r, fwd: fcyToUsdM(seedFwdFcy, ccy) };
      }
      return { ...r, [field]: val };
    }));
  }, [setRows, offsetFor]);

  const blurRow = useCallback((id: string, field: string) => {
    setDrafts(prev => { const next = { ...prev }; delete next[`${id}.${field}`]; return next; });
  }, []);

  // `fwd` is stored in USD (source of truth from TMS); this lets the FCY
  // column be edited directly too, converting back into the USD field so
  // both columns stay in sync — same two-way pattern as Cash FX / Cash FX $USD.
  // Display may include booked Decision-layer forwards — strip before write-back.
  const editFwdFcy = useCallback((id: string, ccy: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.fwdFcy`]: raw }));
    const val = roundMoney(parseFloat(raw));
    if (isNaN(val)) return;
    const seedFcy = roundMoney(val - offsetFor(ccy).fwdLocalM);
    setRows(prev => prev.map(r => (r.id === id ? { ...r, fwd: fcyToUsdM(seedFcy, ccy) } : r)));
  }, [setRows, offsetFor]);

  /** Edit a FCY-stored field via its $USD companion. */
  const editFcyViaUsd = useCallback((
    id: string,
    ccy: string,
    field: 'spot' | 'nonCash' | 'nonCashAsset' | 'ir_liab_notional' | 'ir_invest_notional',
    draftKey: string,
    raw: string,
  ) => {
    setDrafts(prev => ({ ...prev, [`${id}.${draftKey}`]: raw }));
    const val = roundMoney(parseFloat(raw));
    if (!isNaN(val)) {
      let fcy = usdToFcyM(val, ccy);
      if (field === 'spot') fcy = roundMoney(fcy - offsetFor(ccy).spotLocalM);
      setRows(prev => prev.map(r => (r.id === id ? { ...r, [field]: fcy } : r)));
    }
  }, [setRows, offsetFor]);

  /** Edit Net FX (FCY) by solving for Cash FX (spot). */
  const editNetFxFcy = useCallback((id: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.netFxFCY`]: raw }));
    const val = roundMoney(parseFloat(raw));
    if (isNaN(val)) return;
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const o = offsetFor(r.ccy);
      const displayFwdFcy = usdToFcyM(r.fwd, r.ccy) + o.fwdLocalM;
      // Net FX = spot + fwd + nonCash + NCA + invest − debt
      const displaySpot =
        val
        - displayFwdFcy
        - r.nonCash
        - (r.nonCashAsset ?? 0)
        - (r.ir_invest_notional ?? 0)
        + r.ir_liab_notional;
      return { ...r, spot: roundMoney(displaySpot - o.spotLocalM) };
    }));
  }, [setRows, offsetFor]);

  const editNetFxUsd = useCallback((id: string, ccy: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.netFxUSD`]: raw }));
    const val = roundMoney(parseFloat(raw));
    if (isNaN(val)) return;
    const targetFcy = usdToFcyM(val, ccy);
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const o = offsetFor(r.ccy);
      const displayFwdFcy = usdToFcyM(r.fwd, r.ccy) + o.fwdLocalM;
      const displaySpot =
        targetFcy
        - displayFwdFcy
        - r.nonCash
        - (r.nonCashAsset ?? 0)
        - (r.ir_invest_notional ?? 0)
        + r.ir_liab_notional;
      return { ...r, spot: roundMoney(displaySpot - o.spotLocalM) };
    }));
  }, [setRows, offsetFor]);

  /**
   * Risk Metrics Exp = Net FX Forecast (F×T). VaR uses Analytics
   * `varSetup.horizon` — never synced from forecast chips.
   */
  const exposureRegimeLabel =
    forecastMonths === 0
      ? 'F×0 stock only'
      : `F×${forecastMonths}m`;
  const varHorizonLabel = varSetup
    ? (VAR_HORIZON_OPTIONS.find(h => h.id === varSetup.horizon)?.label ?? varSetup.horizon)
    : '1m';
  const analyticsSetupSummary = useMemo(() => {
    const setup = varSetup ?? DEFAULT_VAR_SETUP;
    const profile =
      VAR_EXPOSURE_OPTIONS.find(o => o.id === setup.exposureBasis)?.label ??
      setup.exposureBasis;
    const vol =
      VAR_VOL_SOURCE_OPTIONS.find(o => o.id === setup.volSource)?.label ??
      setup.volSource;
    const σPct = (monthlyVolForSetup(setup) * 100).toFixed(1);
    return {
      profile,
      confidencePct: setup.confidencePct,
      vol,
      σPct,
      forecastLabel: exposureRegimeLabel,
      horizonLabel: varHorizonLabel,
    };
  }, [varSetup, exposureRegimeLabel, varHorizonLabel]);

  const setForecastMonths = useCallback(
    (months: number) => {
      onSharedChange('forecastMonths', months);
      // Updates Risk Metrics Exp (buildup) + Net FX Forecast only — never VaR horizon.
      const base = varSetup ?? DEFAULT_VAR_SETUP;
      onVarSetupChange?.({
        ...base,
        forecastMonths: months,
      });
      if (onForecastProfileChange) {
        onForecastProfileChange(
          ensureProfileForRows(forecastProfile, rows, months),
        );
      }
    },
    [
      onSharedChange,
      onVarSetupChange,
      varSetup,
      onForecastProfileChange,
      forecastProfile,
      rows,
    ],
  );

  const setAnalysisHorizon = useCallback(
    (horizon: VarHorizonId) => {
      const base = varSetup ?? DEFAULT_VAR_SETUP;
      onVarSetupChange?.({ ...base, horizon });
    },
    [onVarSetupChange, varSetup],
  );

  const setForecastMode = useCallback(
    (mode: ForecastFlowMode) => {
      if (!onForecastProfileChange) return;
      if (mode === 'custom') {
        const g = Number.isFinite(forecastProfile.growthRateMoM)
          ? forecastProfile.growthRateMoM
          : 0;
        const extrasByCcy = { ...(forecastProfile.extrasByCcy ?? {}) };
        const byCcy: Record<string, ForecastMonthFlow[]> = {};
        for (const r of rows) {
          if (r.ccy === 'USD') continue;
          byCcy[r.ccy] = seedMonthsFromRowWithLineGrowth(
            r,
            forecastMonths,
            forecastProfile,
            extrasByCcy[r.ccy],
          );
        }
        onForecastProfileChange({
          ...forecastProfile,
          mode: 'custom',
          byCcy,
          extrasByCcy,
          formulas: {},
          growthRateMoM: g,
        });
        return;
      }
      onForecastProfileChange({
        ...forecastProfile,
        mode: 'flat',
        extrasByCcy: forecastProfile.extrasByCcy ?? {},
      });
    },
    [onForecastProfileChange, forecastProfile, rows, forecastMonths],
  );

  const commitFlatExtra = useCallback(
    (ccy: string, field: keyof ForecastCashExtras, raw: string) => {
      const draftKey = `fp.flat.${ccy}.${field}`;
      setDrafts(prev => {
        const next = { ...prev };
        delete next[draftKey];
        return next;
      });
      if (!onForecastProfileChange) return;
      const line = FORECAST_FLOW_LINES.find(l => l.key === field);
      if (!line) return;
      const numeric = roundMoney(parseFloat(raw));
      if (isNaN(numeric)) return;
      const signed = flowFieldFromDisplay(numeric, line.side);
      const prev = normalizeExtras(forecastProfile.extrasByCcy?.[ccy]);
      onForecastProfileChange({
        ...forecastProfile,
        extrasByCcy: {
          ...(forecastProfile.extrasByCcy ?? {}),
          [ccy]: { ...prev, [field]: signed },
        },
      });
    },
    [onForecastProfileChange, forecastProfile],
  );

  const commitFlatGrowth = useCallback(
    (ccy: string, field: ForecastFlowField, raw: string) => {
      const draftKey = `fp.growth.${ccy}.${field}`;
      setDrafts(prev => {
        const next = { ...prev };
        delete next[draftKey];
        return next;
      });
      if (!onForecastProfileChange) return;
      const prevLine = {
        ...(forecastProfile.flatGrowthByCcy?.[ccy] ?? {}),
      };
      const trimmed = raw.trim();
      // Blank → inherit Default g MoM; explicit 0 → hard zero override.
      if (trimmed === '') {
        delete prevLine[field];
      } else {
        const pct = parseFloat(trimmed);
        if (!Number.isFinite(pct)) {
          delete prevLine[field];
        } else {
          prevLine[field] = pct / 100;
        }
      }
      const nextByCcy = {
        ...(forecastProfile.flatGrowthByCcy ?? {}),
        [ccy]: prevLine,
      };
      if (Object.keys(prevLine).length === 0) {
        delete nextByCcy[ccy];
      }
      onForecastProfileChange({
        ...forecastProfile,
        flatGrowthByCcy: nextByCcy,
      });
    },
    [onForecastProfileChange, forecastProfile],
  );

  const commitPeriodCell = useCallback(
    (ccy: string, monthIndex: number, field: string, raw: string) => {
      const draftKey = `fp.${ccy}.${field}.${monthIndex}`;
      setDrafts(prev => {
        const next = { ...prev };
        delete next[draftKey];
        return next;
      });
      if (!onForecastProfileChange) return;
      const ensured = ensureProfileForRows(forecastProfile, rows, forecastMonths);
      const row = rows.find(r => r.ccy === ccy);
      if (!row) return;
      const months = [
        ...(ensured.byCcy[ccy] ??
          seedMonthsFromRow(
            row,
            forecastMonths,
            0,
            ensured.extrasByCcy[ccy],
          )),
      ].map(normalizeMonthFlow);
      const calcRows = ensured.calcRowsByCcy?.[ccy] ?? [];
      const calcValues = { ...(ensured.calcByCcy?.[ccy] ?? {}) };
      const scopeOpts = { calcRows, calcValues };
      const trimmed = raw.trim();
      const formulas = { ...ensured.formulas };
      const fKey = forecastFormulaKey(ccy, field, monthIndex);

      if (isCalcFieldKey(field)) {
        const calcId = calcIdFromFieldKey(field);
        if (!calcId || !calcRows.some(c => c.id === calcId)) return;
        const series = resizeCalcSeries(calcValues[calcId], forecastMonths);
        if (trimmed === '') {
          delete formulas[fKey];
          series[monthIndex] = 0;
          calcValues[calcId] = series;
          onForecastProfileChange({
            ...ensured,
            mode: 'custom',
            formulas,
            calcByCcy: { ...(ensured.calcByCcy ?? {}), [ccy]: calcValues },
          });
          return;
        }
        let numeric: number;
        if (trimmed.startsWith('=')) {
          const scope = periodFormulaScope(
            row,
            months,
            field,
            monthIndex,
            scopeOpts,
          );
          const { value, error } = evalPeriodFormula(trimmed, scope);
          if (error || !Number.isFinite(value)) return;
          formulas[fKey] = trimmed;
          numeric = value;
        } else {
          delete formulas[fKey];
          numeric = roundMoney(parseFloat(trimmed));
          if (isNaN(numeric)) return;
        }
        series[monthIndex] = numeric;
        calcValues[calcId] = series;
        onForecastProfileChange({
          ...ensured,
          mode: 'custom',
          formulas,
          calcByCcy: { ...(ensured.calcByCcy ?? {}), [ccy]: calcValues },
        });
        return;
      }

      const cashField = field as ForecastFlowField;
      const line = FORECAST_FLOW_LINES.find(l => l.key === cashField);
      if (!line) return;
      const cur = months[monthIndex] ?? normalizeMonthFlow(undefined);
      let numeric: number;
      if (trimmed === '') {
        delete formulas[fKey];
        onForecastProfileChange({ ...ensured, formulas });
        return;
      }
      if (trimmed.startsWith('=')) {
        const scope = periodFormulaScope(
          row,
          months,
          cashField,
          monthIndex,
          scopeOpts,
        );
        const { value, error } = evalPeriodFormula(trimmed, scope);
        if (error || !Number.isFinite(value)) return;
        formulas[fKey] = trimmed;
        numeric = value;
      } else {
        delete formulas[fKey];
        numeric = roundMoney(parseFloat(trimmed));
        if (isNaN(numeric)) return;
      }
      months[monthIndex] = withFlowField(
        cur,
        cashField,
        flowFieldFromDisplay(numeric, line.side),
      );
      if (monthIndex === 0) {
        setRows(prev =>
          prev.map(r =>
            r.ccy === ccy
              ? {
                  ...r,
                  collections: months[0]!.collections,
                  payout: months[0]!.payout,
                  fcastFX: months[0]!.invoiceFcast,
                }
              : r,
          ),
        );
      }
      onForecastProfileChange({
        ...ensured,
        mode: 'custom',
        byCcy: { ...ensured.byCcy, [ccy]: months },
        formulas,
      });
    },
    [onForecastProfileChange, forecastProfile, rows, forecastMonths, setRows],
  );

  const commitPeriodFormula = useCallback(
    (
      ccy: string,
      monthIndex: number,
      field: string,
      formulaText: string,
    ) => {
      const trimmed = formulaText.trim();
      if (trimmed === '') {
        commitPeriodCell(ccy, monthIndex, field, '');
        return;
      }
      const isPlainNumber =
        /^-?\d*\.?\d+$/.test(trimmed) && !/[a-zA-Z_]/.test(trimmed);
      commitPeriodCell(
        ccy,
        monthIndex,
        field,
        isPlainNumber ? trimmed : `=${trimmed}`,
      );
    },
    [commitPeriodCell],
  );

  const addCalcRow = useCallback(
    (ccy: string) => {
      if (!onForecastProfileChange) return;
      const ensured = ensureProfileForRows(forecastProfile, rows, forecastMonths);
      const existing = ensured.calcRowsByCcy?.[ccy] ?? [];
      const row = newCalcRow(existing);
      const series = Array.from({ length: forecastMonths }, (_, i) =>
        i === 0 ? 1 : 0,
      );
      onForecastProfileChange({
        ...ensured,
        mode: 'custom',
        calcRowsByCcy: {
          ...(ensured.calcRowsByCcy ?? {}),
          [ccy]: [...existing, row],
        },
        calcByCcy: {
          ...(ensured.calcByCcy ?? {}),
          [ccy]: {
            ...(ensured.calcByCcy?.[ccy] ?? {}),
            [row.id]: series,
          },
        },
      });
    },
    [onForecastProfileChange, forecastProfile, rows, forecastMonths],
  );

  const removeCalcRow = useCallback(
    (ccy: string, calcId: string) => {
      if (!onForecastProfileChange) return;
      const ensured = ensureProfileForRows(forecastProfile, rows, forecastMonths);
      const field = calcFieldKey(calcId);
      const formulas = { ...ensured.formulas };
      for (const key of Object.keys(formulas)) {
        if (key.startsWith(`${ccy}::${field}::`)) delete formulas[key];
      }
      const nextRows = (ensured.calcRowsByCcy?.[ccy] ?? []).filter(
        c => c.id !== calcId,
      );
      const nextVals = { ...(ensured.calcByCcy?.[ccy] ?? {}) };
      delete nextVals[calcId];
      const calcRowsByCcy = { ...(ensured.calcRowsByCcy ?? {}) };
      const calcByCcy = { ...(ensured.calcByCcy ?? {}) };
      if (nextRows.length === 0) delete calcRowsByCcy[ccy];
      else calcRowsByCcy[ccy] = nextRows;
      if (Object.keys(nextVals).length === 0) delete calcByCcy[ccy];
      else calcByCcy[ccy] = nextVals;
      onForecastProfileChange({
        ...ensured,
        formulas,
        calcRowsByCcy,
        calcByCcy,
      });
    },
    [onForecastProfileChange, forecastProfile, rows, forecastMonths],
  );

  const renameCalcRow = useCallback(
    (
      ccy: string,
      calcId: string,
      patch: Partial<Pick<ForecastCalcRow, 'label' | 'ref'>>,
      opts?: { trimLabel?: boolean },
    ) => {
      if (!onForecastProfileChange) return;
      const ensured = ensureProfileForRows(forecastProfile, rows, forecastMonths);
      const list = [...(ensured.calcRowsByCcy?.[ccy] ?? [])];
      const idx = list.findIndex(c => c.id === calcId);
      if (idx < 0) return;
      const cur = list[idx]!;
      let nextRef = cur.ref;
      if (patch.ref !== undefined) {
        const candidate = patch.ref.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) return;
        const taken = list.some(
          (c, i) =>
            i !== idx && c.ref.toLowerCase() === candidate.toLowerCase(),
        );
        if (taken) return;
        nextRef = candidate;
      }
      let nextLabel = cur.label;
      if (patch.label !== undefined) {
        nextLabel =
          opts?.trimLabel !== false
            ? patch.label.trim() || cur.label
            : patch.label;
      }
      list[idx] = { ...cur, label: nextLabel, ref: nextRef };
      onForecastProfileChange({
        ...ensured,
        calcRowsByCcy: {
          ...(ensured.calcRowsByCcy ?? {}),
          [ccy]: list,
        },
      });
    },
    [onForecastProfileChange, forecastProfile, rows, forecastMonths],
  );

  /** Month indices as fill-axis keys — drag across M1…MT on the same line. */
  const forecastMonthRowOrder = useMemo(
    () => Array.from({ length: Math.max(0, forecastMonths) }, (_, i) => String(i)),
    [forecastMonths],
  );

  /** Batch fill formulas across months with relative mN / revN shifts. */
  const fillForecastFormulasAcrossMonths = useCallback(
    (
      lineKey: string,
      monthKeys: string[],
      formulaText: string,
      sourceMonthIndex: number,
    ) => {
      if (!onForecastProfileChange) return;
      const sep = lineKey.indexOf('::');
      if (sep < 0) return;
      const ccy = lineKey.slice(0, sep);
      const field = lineKey.slice(sep + 2);
      const row = rows.find(r => r.ccy === ccy);
      if (!row) return;

      const ensured = ensureProfileForRows(forecastProfile, rows, forecastMonths);
      const months = [
        ...(ensured.byCcy[ccy] ??
          seedMonthsFromRow(row, forecastMonths, 0, ensured.extrasByCcy[ccy])),
      ].map(normalizeMonthFlow);
      const calcRows = ensured.calcRowsByCcy?.[ccy] ?? [];
      const calcValues = { ...(ensured.calcByCcy?.[ccy] ?? {}) };
      const formulas = { ...ensured.formulas };
      const src = formulaText.trim().replace(/^=/, '').trim();
      const scopeOpts = () => ({ calcRows, calcValues });

      if (isCalcFieldKey(field)) {
        const calcId = calcIdFromFieldKey(field);
        if (!calcId || !calcRows.some(c => c.id === calcId)) return;
        const series = resizeCalcSeries(calcValues[calcId], forecastMonths);

        for (const mk of monthKeys) {
          const mi = Number(mk);
          if (!Number.isFinite(mi) || mi < 0 || mi >= series.length) continue;
          const shifted = shiftForecastFormulaMonths(src, sourceMonthIndex, mi);
          const expr = shifted.startsWith('=') ? shifted : `=${shifted}`;
          calcValues[calcId] = series;
          const scope = periodFormulaScope(
            row,
            months,
            field,
            mi,
            scopeOpts(),
          );
          const { value, error } = evalPeriodFormula(expr, scope);
          if (error || !Number.isFinite(value)) continue;
          formulas[forecastFormulaKey(ccy, field, mi)] = expr;
          series[mi] = value;
        }

        for (let mi = 0; mi < series.length; mi++) {
          const fKey = forecastFormulaKey(ccy, field, mi);
          const stored = formulas[fKey];
          if (!stored) continue;
          calcValues[calcId] = series;
          const scope = periodFormulaScope(
            row,
            months,
            field,
            mi,
            scopeOpts(),
          );
          const { value, error } = evalPeriodFormula(stored, scope);
          if (error || !Number.isFinite(value)) continue;
          series[mi] = value;
        }
        calcValues[calcId] = series;
        onForecastProfileChange({
          ...ensured,
          mode: 'custom',
          formulas,
          calcByCcy: { ...(ensured.calcByCcy ?? {}), [ccy]: calcValues },
        });
        return;
      }

      const cashField = field as ForecastFlowField;
      const line = FORECAST_FLOW_LINES.find(l => l.key === cashField);
      if (!line) return;

      for (const mk of monthKeys) {
        const mi = Number(mk);
        if (!Number.isFinite(mi) || mi < 0 || mi >= months.length) continue;
        const shifted = shiftForecastFormulaMonths(src, sourceMonthIndex, mi);
        const expr = shifted.startsWith('=') ? shifted : `=${shifted}`;
        const scope = periodFormulaScope(
          row,
          months,
          cashField,
          mi,
          scopeOpts(),
        );
        const { value, error } = evalPeriodFormula(expr, scope);
        if (error || !Number.isFinite(value)) continue;
        const fKey = forecastFormulaKey(ccy, cashField, mi);
        formulas[fKey] = expr;
        months[mi] = withFlowField(
          months[mi] ?? normalizeMonthFlow(undefined),
          cashField,
          flowFieldFromDisplay(value, line.side),
        );
      }

      // Re-eval in month order so later cells see updated prev / mN.
      for (let mi = 0; mi < months.length; mi++) {
        const fKey = forecastFormulaKey(ccy, cashField, mi);
        const stored = formulas[fKey];
        if (!stored) continue;
        const scope = periodFormulaScope(
          row,
          months,
          cashField,
          mi,
          scopeOpts(),
        );
        const { value, error } = evalPeriodFormula(stored, scope);
        if (error || !Number.isFinite(value)) continue;
        months[mi] = withFlowField(
          months[mi]!,
          cashField,
          flowFieldFromDisplay(value, line.side),
        );
      }

      if (months[0]) {
        setRows(prev =>
          prev.map(r =>
            r.ccy === ccy
              ? {
                  ...r,
                  collections: months[0]!.collections,
                  payout: months[0]!.payout,
                  fcastFX: months[0]!.invoiceFcast,
                }
              : r,
          ),
        );
      }
      onForecastProfileChange({
        ...ensured,
        mode: 'custom',
        byCcy: { ...ensured.byCcy, [ccy]: months },
        formulas,
      });
    },
    [
      onForecastProfileChange,
      forecastProfile,
      rows,
      forecastMonths,
      setRows,
    ],
  );

  const fillCustomFromFlat = useCallback(() => {
    if (!onForecastProfileChange) return;
    const g = Number.isFinite(forecastProfile.growthRateMoM)
      ? forecastProfile.growthRateMoM
      : 0;
    const extrasByCcy = { ...(forecastProfile.extrasByCcy ?? {}) };
    const byCcy: Record<string, ForecastMonthFlow[]> = {};
    for (const r of rows) {
      if (r.ccy === 'USD') continue;
      byCcy[r.ccy] = seedMonthsFromRowWithLineGrowth(
        r,
        forecastMonths,
        forecastProfile,
        extrasByCcy[r.ccy],
      );
    }
    onForecastProfileChange({
      ...forecastProfile,
      mode: 'custom',
      byCcy,
      extrasByCcy,
      formulas: {},
      growthRateMoM: g,
    });
  }, [onForecastProfileChange, forecastProfile, rows, forecastMonths]);

  const copyM1Across = useCallback(() => {
    if (!onForecastProfileChange) return;
    const ensured = ensureProfileForRows(forecastProfile, rows, forecastMonths);
    const byCcy: Record<string, ForecastMonthFlow[]> = { ...ensured.byCcy };
    for (const r of rows) {
      if (r.ccy === 'USD') continue;
      byCcy[r.ccy] = copyMonth1ToAll(byCcy[r.ccy] ?? seedMonthsFromRow(r, forecastMonths));
    }
    onForecastProfileChange({ ...ensured, mode: 'custom', byCcy });
  }, [onForecastProfileChange, forecastProfile, rows, forecastMonths]);

  /** Edit Net FX Forecast by writing the residual into fcastFX (period-scaled). */
  const editNetFxForecast = useCallback((id: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.netFxForecast`]: raw }));
    const val = roundMoney(parseFloat(raw));
    if (isNaN(val)) return;
    const T = forecastMonths;
    const row = rows.find(r => r.id === id);
    if (!row) return;
    const netFx = fxBookNetLocalM(row);
    if (forecastProfile.mode === 'custom' && onForecastProfileChange) {
      // Adjust the last custom month so Σ period flow matches the typed forecast.
      const targetPeriod = val - netFx;
      const ensured = ensureProfileForRows(forecastProfile, rows, T);
      const months = [...(ensured.byCcy[row.ccy] ?? seedMonthsFromRow(row, T))];
      const headSum = sumPeriodFlow(months.slice(0, -1));
      const lastNeed = roundMoney(targetPeriod - headSum);
      const lastIdx = months.length - 1;
      if (lastIdx >= 0) {
        months[lastIdx] = normalizeMonthFlow({
          collections: roundMoney(Math.max(0, lastNeed)),
          payout: roundMoney(Math.min(0, lastNeed)),
        });
      }
      onForecastProfileChange({
        ...ensured,
        mode: 'custom',
        byCcy: { ...ensured.byCcy, [row.ccy]: months },
      });
      return;
    }
    const monthlyFlow = (val - netFx) / T;
    setRows(prev =>
      prev.map(r =>
        r.id === id
          ? { ...r, fcastFX: roundMoney(monthlyFlow - r.collections - r.payout) }
          : r,
      ),
    );
  }, [setRows, forecastMonths, forecastProfile, onForecastProfileChange, rows]);

  const editNetFxForecastUsd = useCallback((id: string, ccy: string, raw: string) => {
    setDrafts(prev => ({ ...prev, [`${id}.netFxForecastUSD`]: raw }));
    const val = roundMoney(parseFloat(raw));
    if (isNaN(val)) return;
    const targetFcy = usdToFcyM(val, ccy);
    editNetFxForecast(id, String(targetFcy));
  }, [editNetFxForecast]);

  const editCcy = useCallback((id: string, raw: string) => {
    const ccy = raw.toUpperCase();
    setDrafts({});
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const p = CURRENCY_PARAMS[ccy];
      return p
        ? { ...r, ccy, σ_daily: p.σ_daily, r_FCY: p.carry, r_OD: p.r_OD, β_IR: p.β_IR }
        : { ...r, ccy };
    }));
  }, [setRows]);

  const editUsd = useCallback((field: keyof UsdParams, raw: string) => {
    setDrafts(prev => ({ ...prev, [`usd.${field}`]: raw }));
    const val = roundMoney(parseFloat(raw));
    if (!isNaN(val)) setUsdParams(prev => ({ ...prev, [field]: val }));
  }, [setUsdParams]);

  const blurUsd = useCallback((field: string) => {
    setDrafts(prev => { const next = { ...prev }; delete next[`usd.${field}`]; return next; });
  }, []);

  /** Book-wide hedging strategy: swap only / + forwards on forecast / + options. */
  const [strategy, setStrategy] = useState<HedgeStrategy>('SWAP_ONLY');
  /** Option δ override per row (default 0.5). */
  const [hedgeDeltas, setHedgeDeltas] = useState<Record<string, number>>({});
  /** Gear next to the Min floor layer: per-currency minimum cash thresholds. */
  /** Which buffer layer's settings strip is open (one at a time). */
  const [layerPanel, setLayerPanel] = useState<LayerId | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [activeBand, setActiveBand] = useState<BandId>('rates');
  const [colCount, setColCount] = useState(0);
  /** FCY rows only — the USD row carries no per-currency floor in the buffer model. */
  const floorRows = useMemo(() => rows.filter(r => r.ccy !== 'USD'), [rows]);
  const floorsSetCount = floorRows.filter(r => r.cash_floor > 0.0001).length;
  const floorTotalUsd = floorRows.reduce(
    (sum, r) => sum + fcyToUsdM(r.cash_floor, r.ccy),
    0,
  );

  /** Per-currency payout σ lives on the forecast profile, not on the row. */
  const [sigmaDrafts, setSigmaDrafts] = useState<Record<string, string>>({});
  const sigmaOverrideCount = floorRows.filter(
    r => lineUncertainty1m(forecastProfile, r.ccy, 'payout') > 0,
  ).length;
  const commitSigma = (ccy: string, raw: string) => {
    setSigmaDrafts(d => {
      const next = { ...d };
      delete next[ccy];
      return next;
    });
    if (raw.trim() === '') {
      setLineUncertainty(ccy, 'payout', 0);
      return;
    }
    const pct = parseFloat(raw);
    if (!Number.isFinite(pct)) return;
    setLineUncertainty(ccy, 'payout', Math.max(0, Math.min(1, pct / 100)));
  };

  // ── Carry desk (carryOptim gear) ───────────────────────────────────────────
  /** Which column the desk steers on: the rate, the cash target, or the P&L target. */
  const [carryDrive, setCarryDrive] = useState<'rate' | 'cash' | 'pnl'>('rate');
  /** Months of forecast lifecycle to project the target and its accrual over. */
  const [carryHorizon, setCarryHorizon] = useState(() =>
    Math.min(12, Math.max(1, forecastMonths || 1)),
  );
  /** Currency whose per-period projection is expanded (one at a time). */
  const [carryExpanded, setCarryExpanded] = useState<string | null>(null);
  /** Per-row note when a typed carry ask has no reachable target, keyed by row id. */
  const [carryNotes, setCarryNotes] = useState<Record<string, string>>({});

  const carryRows = useMemo(
    () => fcyComputed.filter(r => r.ccy !== 'USD'),
    [fcyComputed],
  );
  const carryTargetCount = carryRows.filter(
    r => typeof r.carry_target === 'number' && Number.isFinite(r.carry_target),
  ).length;

  const setCarryTarget = useCallback((id: string, value: number | undefined) => {
    setRows(prev => prev.map(r => (
      r.id === id
        ? { ...r, carry_target: value === undefined ? undefined : roundMoney(value) }
        : r
    )));
  }, [setRows]);

  /** A committed cash / P&L target is live setup — turn the layer on so the book takes it. */
  const ensureCarryLayer = useCallback(() => {
    if (!activeLayers.has('carryOptim')) onLayerToggle('carryOptim');
  }, [activeLayers, onLayerToggle]);

  const clearCarryDrafts = useCallback((id: string) => {
    setDrafts(prev => {
      const next = { ...prev };
      delete next[`${id}.carry_target`];
      delete next[`${id}.carry_pnl`];
      return next;
    });
  }, []);

  /** Blank clears the override and hands the leg back to z_opt. */
  const commitCarryCash = useCallback((id: string, raw: string) => {
    clearCarryDrafts(id);
    if (raw.trim() === '') return setCarryTarget(id, undefined);
    const v = parseFloat(raw);
    if (Number.isFinite(v)) {
      ensureCarryLayer();
      setCarryTarget(id, v);
    }
  }, [clearCarryDrafts, setCarryTarget, ensureCarryLayer]);

  /**
   * Typed carry ($k for the near period) inverts into the cash target that earns
   * it. Flows come from the projected near period, not the row, so a custom
   * forecast profile inverts against the same numbers the projection shows.
   */
  const commitCarryPnl = useCallback((
    row: FcyComputedRow,
    near: CarryPeriod | undefined,
    raw: string,
  ) => {
    setCarryNotes(prev => {
      if (!prev[row.id]) return prev;
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    if (raw.trim() === '') {
      clearCarryDrafts(row.id);
      return setCarryTarget(row.id, undefined);
    }
    const k = parseFloat(raw);
    if (!Number.isFinite(k)) return clearCarryDrafts(row.id);
    const solve = {
      ccy: row.ccy,
      r_FCY: row.r_FCY,
      r_OD: row.r_OD,
      r_USD: shared.r_USD,
      payout: near?.payout ?? row.payout,
      collections: near?.collections ?? row.collections,
      invoiceFcast: row.fcastFX,
      hedgeSettle: hedgeSettleByCcy[row.ccy]?.[0] ?? 0,
      liquidity: liquidityTiming,
    };
    const target = targetForCarry(k / 1000, solve);
    if (target === null) {
      // Keep what was typed on screen — clearing it is what made the field look
      // like it was ignoring the entry rather than unable to reach it.
      setCarryNotes(prev => ({
        ...prev,
        [row.id]: k > 0 && !canEarnPositiveCarry(solve)
          ? `${row.ccy} cannot earn against USD — ${f2(row.r_FCY)}% long, ${f2(row.r_OD)}% short, both losing vs ${f2(shared.r_USD)}%. Ask for a loss, or steer on cash.`
          : `No target reaches ${usdK(k / 1000)} on ${row.ccy} — steer on cash instead.`,
      }));
      return;
    }
    clearCarryDrafts(row.id);
    ensureCarryLayer();
    setCarryTarget(row.id, target);
  }, [
    clearCarryDrafts, setCarryTarget, ensureCarryLayer, shared.r_USD, liquidityTiming,
    hedgeSettleByCcy,
  ]);

  /**
   * Target cash and interest accrual per period over the forecast lifecycle.
   * Each period reruns the same layer stack on that cycle's opening balance, so
   * the path is the buffer model rolled forward rather than a parallel model.
   */
  const carryLive = activeLayers.has('carryOptim');
  /**
   * This panel is the layer's setup, so it always reads as if the layer were on.
   * Otherwise every figure you dial in would show the plain trough back at you
   * until the layer is switched on, and nothing here could be tuned.
   */
  const carryPreviewLayers = useMemo(() => {
    if (carryLive) return activeLayers;
    const next = new Set(activeLayers);
    next.add('carryOptim');
    return next;
  }, [activeLayers, carryLive]);

  const carryProjection = useMemo(() => {
    if (layerPanel !== 'carryOptim') return [];
    const from = new Date();
    return carryRows.map(row => {
      const periods = projectCarryLifecycle(
        row, shared, carryPreviewLayers, carryHorizon, forecastProfile,
        { from, hedgeSettle: hedgeSettleByCcy[row.ccy] },
      );
      const target = periods[0]?.targetCash ?? row.cash_threshold;
      return {
        row,
        periods,
        target,
        nearCarry: periods[0]?.carryVsUsd ?? 0,
        horizonCarry: periods.reduce((s, p) => s + p.carryVsUsd, 0),
        // The projection runs the per-currency stack; once live, the book target can
        // still be trimmed by the portfolio VAR cap or the USD stress rebalance.
        offBook: carryLive && Math.abs(target - row.cash_threshold) > 0.01,
      };
    });
  }, [
    layerPanel, carryRows, shared, carryPreviewLayers, carryLive, carryHorizon,
    forecastProfile, hedgeSettleByCcy,
  ]);

  /**
   * Why a requested target did not land, in the desk's own words. Measured against
   * what the setup itself can hold, so it reports real clamps rather than simply
   * restating that the layer is off.
   */
  const carryBindReason = (r: FcyComputedRow, target: number): string | null => {
    if (typeof r.carry_target !== 'number' || !Number.isFinite(r.carry_target)) return null;
    if (Math.abs(r.carry_target - target) <= 0.01) return null;
    if (carryLive && r.var_trim) return 'VAR cap';
    if (carryLive && r.usd_stress_trim) return 'USD stress';
    // r_OD above r_USD makes an overdraft dearer than holding USD, so the model
    // refuses to run the balance negative however the target was arrived at.
    if (r.debit_floor_binding || r.r_OD > shared.r_USD) return 'no overdraft';
    if (r.cash_floor > 0.0001) return 'floor';
    return 'clamped';
  };

  const carryTotals = useMemo(() => carryProjection.reduce(
    (acc, c) => ({
      targetUsd: acc.targetUsd + fcyToUsdM(c.target, c.row.ccy),
      near: acc.near + c.nearCarry,
      horizon: acc.horizon + c.horizonCarry,
    }),
    { targetUsd: 0, near: 0, horizon: 0 },
  ), [carryProjection]);

  /** Gear badge: how much of the layer is configured, at a glance. */
  const layerBadge = (id: LayerId): string => {
    if (id === 'floorH') return floorsSetCount > 0 ? String(floorsSetCount) : '';
    if (id === 'sigmaP') return sigmaOverrideCount > 0 ? String(sigmaOverrideCount) : '';
    if (id === 'carryOptim') return carryTargetCount > 0 ? String(carryTargetCount) : '';
    if (id === 'portfolioDiv') return `$${n(policyVAR)}M`;
    if (id === 'cfarCover') {
      const total = Object.values(cfarNetByCcyUsd).reduce((s, v) => s + v, 0);
      return total > 0.001 ? `$${n(total)}M` : '';
    }
    return '';
  };

  const resetRows = useCallback(() => {
    if (onResetTable) {
      onResetTable();
    } else {
      setRows(INITIAL_ROWS.map(r => ({ ...r })));
      setUsdParams({ ...INITIAL_USD_PARAMS });
    setUsdCash(303.9);
    setUsdNonLpCash(154.1);
    }
    setStrategy('SWAP_ONLY');
    setHedgeDeltas({});
    setDrafts({});
    setForecastProfileOpen(false);
    onForecastProfileChange?.({
      ...DEFAULT_FORECAST_PROFILE,
      byCcy: {},
      formulas: {},
    });
  }, [
    onResetTable,
    setRows,
    setUsdParams,
    setUsdCash,
    setUsdNonLpCash,
    onForecastProfileChange,
  ]);

  const computed = fcyComputed;

  /**
   * Cycles behind the collapsed rows. Only the read-only view totals the flows —
   * where the cells are editable they have to keep showing the single-cycle
   * input being edited.
   */
  const horizonMonths = lockValues
    ? (computed.find(r => r.liquidityCycles?.length)?.liquidityCycles?.length ?? 0)
    : 0;
  const horizonSuffix = horizonMonths ? ` Σ${horizonMonths}m` : '';
  const usdFlowTitle = horizonMonths
    ? 'One cycle — the USD leg carries no dated forecast path, so it is not totalled over the horizon'
    : undefined;
  /**
   * FX hedging and liquidity hedging are separate books. Forward settlement is
   * operating cash, so it stays in the liquidity band and is what the funding
   * decision is taken on; only the funding swap sits apart, in the SWAP band.
   */
  const liquidityBookNote = ' FX hedge settlement is counted in — it is cash the'
    + ' account delivers or receives. The funding swap is not: that is the SWAP band.';

  const totals = useMemo(() => computed.reduce(
    (a, r) => ({
      cashPosUSD:   a.cashPosUSD   + r.cashPosUSD,
      fxSpotUSD:    a.fxSpotUSD    + r.fxSpotUSD,
      fxFwdUSD:     a.fxFwdUSD     + r.fxFwdUSD,
      fxNonCashUSD: a.fxNonCashUSD + r.fxNonCashUSD,
      fxNonCashAssetUSD: a.fxNonCashAssetUSD + r.fxNonCashAssetUSD,
      netFxUSD:     a.netFxUSD     + r.netFxUSD,
    }),
    { cashPosUSD:0, fxSpotUSD:0, fxFwdUSD:0, fxNonCashUSD:0, fxNonCashAssetUSD:0, netFxUSD:0 }
  ), [computed]);

  const fxUsdTotals = useMemo(() => ({
    spot: totals.fxSpotUSD + usdComputed.fxSpotUSD,
    fwd: totals.fxFwdUSD + usdComputed.fxFwdUSD,
    nonCash: totals.fxNonCashUSD + usdComputed.fxNonCashUSD,
    nonCashAsset: totals.fxNonCashAssetUSD + usdComputed.fxNonCashAssetUSD,
    netFx: totals.netFxUSD + usdComputed.netFxUSD,
  }), [totals, usdComputed]);

  const hedgeUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + fcyToUsdM(hedgeFcyFor(r.ccy), r.ccy), 0),
    [computed, hedgeFcyFor],
  );

  const usdComputedRow = usdComputed;

  const swapNearUsdTotal = useMemo(
    () => sumFcySwapNearUsd(computed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear }))) + usdComputedRow.swapNear,
    [computed, usdComputedRow.swapNear],
  );

  /**
   * What the funding convention costs the book, in USD: the leg to trade today
   * against the notional every rolled leg leaves outstanding at the horizon.
   * Sits next to the toggles so switching basis or convention shows its price.
   */
  const liquidityBookUsd = useMemo(() => {
    let bookNow = 0;
    let outstanding = 0;
    for (const r of computed) {
      const plan = r.liquidityPlan;
      if (!plan || plan.length === 0) continue;
      bookNow += fcyToUsdM(plan[0]!.swap_needed, r.ccy);
      outstanding += fcyToUsdM(plan[plan.length - 1]!.standing_swap, r.ccy);
    }
    return { bookNow, outstanding };
  }, [computed]);

  const lpCashUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + swapNearUsd(r.ccy, r.cash), 0) + usdComputedRow.cash,
    [computed, usdComputedRow.cash],
  );

  const thresholdUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + r.cashThresholdUSD, 0) + usdComputedRow.cashThresholdUSD,
    [computed, usdComputedRow.cashThresholdUSD],
  );

  const postSwapUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + r.postSwapUSD, 0) + usdComputedRow.postSwapUSD,
    [computed, usdComputedRow.postSwapUSD],
  );

  const cycleNetFlowUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + swapNearUsd(r.ccy, r.cash_after_payins), 0) + usdComputedRow.cash_after_payins,
    [computed, usdComputedRow.cash_after_payins],
  );

  const cycleEndUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + swapNearUsd(r.ccy, r.cycleEndCash), 0) + usdComputedRow.cycleEndCash,
    [computed, usdComputedRow.cycleEndCash],
  );

  const netDeltaUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + swapNearUsd(r.ccy, r.netDelta), 0) + usdComputedRow.netDelta,
    [computed, usdComputedRow.netDelta],
  );

  const swapCarryTotal = useMemo(
    () => computed.reduce((s, r) => s + pnlSwapCarryUsdM(r, shared.r_USD), 0),
    [computed, shared.r_USD],
  );

  // ── FX Hedge — strategy applied per row on the hedging/funding layer ────────
  //   Basis: Net FX Forecast (spot + fwd + non-cash + cycle FX flows) PLUS the
  //   funding-swap near. Table Fwd/Option do not write settle, so this cannot
  //   loop back into Swap Near.
  const computedWithHedge = useMemo(() =>
    computed.map(r => {
      // Option notional is always matched to the forward; δ is the option's own
      // delta (ATM ≈ 0.5) = fraction of the open exposure the option covers.
      const optDelta = hedgeDeltas[r.id] ?? 0.5;
      const standing = swapFarLegNotional(r.liquidityPlan, r.swapNear);
      const hedge = resolveStrategyHedge(strategy, {
        ccy: r.ccy,
        currentFx: r.netFxFCY,
        forecastFx: r.netFxForecast,
        swapNear: r.swapNear,
        swapStanding: standing,
        optDelta,
        horizonDays: 30,
        r_FCY: r.r_FCY,
        r_USD: shared.r_USD,
        σ_daily: r.σ_daily,
      });
      return { ...r, ...hedge };
    }),
    [computed, strategy, hedgeDeltas, shared.r_USD]
  );

  const hedgeTotals = useMemo(() => ({
    fwdUSD: computedWithHedge.reduce((s, r) => s + swapNearUsd(r.ccy, r.fwdNotional), 0),
    // Delta-effective option amounts (δ × written notional) — matches the per-row display.
    optUSD: computedWithHedge.reduce((s, r) => s + swapNearUsd(r.ccy, r.optNotional * r.optDelta), 0),
    residUSD: computedWithHedge.reduce((s, r) => s + swapNearUsd(r.ccy, r.residualFx), 0),
    hedgeCarryUsdYr: computedWithHedge.reduce((s, r) => s + r.hedgeCarryUsdYr, 0),
    cipUsdYr: computedWithHedge.reduce((s, r) => s + r.cipCarryUsdYr, 0),
  }), [computedWithHedge]);

  // ── Per-cell formula resolution (Excel-like overrides) ────────────────────
  // Each editable field resolves against a named-reference scope built from the
  // row; defaults reproduce the current model. Hedge overrides also re-derive
  // that row's Residual FX and Hedge Carry so dependents stay consistent.
  const resolvedRows = useMemo(() => {
    const map: Record<string, {
      values: Record<SimFieldKey, number>;
      errors: Partial<Record<SimFieldKey, string>>;
      residualFx: number;
      hedgeCarryUsdYr: number;
    }> = {};
    for (const r of computedWithHedge) {
      const spotRate = CURRENCY_PARAMS[r.ccy]?.spot ?? 1;
      const base: Scope = {
        cash: r.cash, payout: r.payout, collections: r.collections, nonLpCash: r.nonLpCash,
        fcastFX: r.fcastFX, spot: r.spot, fwd: r.fwd, nonCash: r.nonCash, nonCashAsset: r.nonCashAsset ?? 0,
        rFCY: r.r_FCY, rOD: r.r_OD, rUSD: shared.r_USD, spotRate,
        netFxFCY: r.netFxFCY, netFxForecast: r.netFxForecast,
        fwdNotional: r.fwdNotional, optNotional: r.optNotional, optDelta: r.optDelta,
        swapNear: r.swapNear,
        modelTarget: r.cash_threshold,
        modelTrough: r.lp_peak_cash,
        modelCycleNet: r.cash_after_payins,
        modelCycleEnd: r.cycleEndCash,
        // Flow, not balance: the dated net of cycle 1 when the path is on, else
        // the row's own payouts and payins.
        modelCycleFlow: r.liquidityCycles?.[0]?.net ?? (r.payout + r.collections),
      };
      const overrides: Partial<Record<SimFieldKey, string>> = {};
      if (formulas) {
        for (const f of SIM_FIELDS) {
          const v = formulas[`${r.ccy}::${f.key}`];
          if (v) overrides[f.key] = v;
        }
      }
      const resolved = resolveSimRow(base, overrides);

      // Recompute residual + hedge carry only when a hedge leg is overridden,
      // so the untouched (model) case matches exactly.
      let residualFx = r.residualFx;
      let hedgeCarryUsdYr = r.hedgeCarryUsdYr;
      if (overrides.fwdHedgeUSD || overrides.optionHedgeUSD) {
        const fwdNotionalRes = spotRate ? resolved.values.fwdHedgeUSD / spotRate : 0;
        const optEffectiveRes = spotRate ? resolved.values.optionHedgeUSD / spotRate : 0;
        residualFx = r.netFxForecast + r.swapNear + fwdNotionalRes + optEffectiveRes;
        const cipDelta = r.optDelta;
        const standing = swapFarLegNotional(r.liquidityPlan, r.swapNear);
        hedgeCarryUsdYr = fwdHedgeCarryUsdYr(fwdNotionalRes === 0 ? 0 : fwdNotionalRes + r.swapNear, r.ccy, r.r_FCY, shared.r_USD)
          + fundingSwapCipPointsUsdYr(standing, spotRate, r.r_FCY, shared.r_USD) * cipDelta;
      }
      map[r.ccy] = { values: resolved.values, errors: resolved.errors, residualFx, hedgeCarryUsdYr };
    }
    return map;
  }, [computedWithHedge, formulas, shared.r_USD, strategy]);

  // Total annual USD carry = unfunded cash + funding-swap O/N + staged (or strategy) hedge.
  const pnlCashCarryTotal = useMemo(
    () => computedWithHedge.reduce((s, r) => (
      s + pnlCashCarryUsdM(r.ccy, r.floatNim, stagedCashCarryByCcyUsdM)
    ), 0) + usdComputedRow.floatNim,
    [computedWithHedge, stagedCashCarryByCcyUsdM, usdComputedRow.floatNim],
  );
  const pnlHedgeCarryTotal = useMemo(
    () => computedWithHedge.reduce((s, r) => (
      s + pnlHedgeCarryUsdM(r.ccy, stagedHedgeCarryByCcyUsdM)
    ), 0),
    [computedWithHedge, stagedHedgeCarryByCcyUsdM],
  );
  const totalCarryUsd = pnlCashCarryTotal + swapCarryTotal + pnlHedgeCarryTotal;

  const forecastPeriodLabel =
    FORECAST_PERIOD_OPTIONS.find(o => o.months === forecastMonths)?.label ?? `${forecastMonths}m`;

  const visibleBands = (
    [
      ratesOn && 'rates',
      showFxPosition && 'pos',
      showLiquidity && 'liq',
      showIrBook && 'ir',
      showCarry && 'buf',
      showSwap && 'swap',
      showFxHedge && 'hedge',
      showRiskMetrics && 'risk',
      showPnl && 'pnl',
    ] as (BandId | false)[]
  ).filter((b): b is BandId => Boolean(b));
  const visibleBandsKey = visibleBands.join(',');

  /** Name the band the reader is scrolled into; the CCY column is ~108px wide. */
  const syncActiveBand = useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const heads = el.querySelectorAll<HTMLElement>('th[data-band]');
    let next: BandId | null = null;
    heads.forEach(h => {
      if (h.offsetLeft - el.scrollLeft <= 130) next = h.dataset.band as BandId;
    });
    const first = heads[0]?.dataset.band as BandId | undefined;
    const resolved = next ?? first;
    if (resolved) setActiveBand(prev => (prev === resolved ? prev : resolved));
  }, []);

  const scrollToBand = (id: BandId) => {
    const el = tableScrollRef.current;
    if (!el) return;
    const head = el.querySelector<HTMLElement>(`th[data-band="${id}"]`);
    if (head) el.scrollLeft = Math.max(0, head.offsetLeft - 108);
    setActiveBand(id);
  };

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    setColCount(el.querySelectorAll('thead tr:nth-child(2) th').length + 1);
    syncActiveBand();
  }, [visibleBandsKey, syncActiveBand]);

  const bandHeadCls = (id: BandId) => {
    const s = BAND_STYLE[id];
    return `${groupThBase} border-l-2 border-t-2 ${s.rule} ${activeBand === id ? s.bgOn : s.bg} ${s.text}`;
  };

  return (
    <div className="space-y-4">

      {/* ── Desk toolbar: forecast · actions, layers rail as its footer ── */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="flex flex-wrap items-stretch">
          <div className="min-w-0 flex-1 border-r border-gray-100 px-3.5 py-2.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className={toolCaption}>Forecast</span>
              <span className="basis-full font-mono text-[9px] leading-snug text-gray-500">
                exposure period = buildup F×T · not the VaR horizon
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <div className={segTrack('card')}>
                {FORECAST_PERIOD_OPTIONS.map(opt => {
                  const on = forecastPeriodIdForMonths(forecastMonths) === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      title={
                        opt.months === 0
                          ? 'No forecast — Net FX Forecast / Exp buildup = stock only (F×0).'
                          : 'Risk Metrics Exp / Net FX Forecast buildup (F×T). Does not change VaR calculation horizon.'
                      }
                      onClick={() => setForecastMonths(opt.months)}
                      className={deskSeg(on, 'sky')}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <span className="font-mono text-[9px] leading-snug text-gray-500">
                {forecastMonths === 0
                  ? 'spot book only — no forecast buildup'
                  : `F×T over ${forecastPeriodLabel} at u₁ₘ ${Math.round(shared.σ_P * 100)}%`}
              </span>
            </div>
          </div>

          <div className="ml-auto flex min-w-0 flex-col gap-1.5 px-3.5 py-2.5">
            <div className={toolCaption}>Actions</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setForecastProfileOpen(true)}
                disabled={forecastMonths === 0}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                  forecastMonths === 0
                    ? 'cursor-not-allowed border-gray-200 bg-white text-gray-400'
                    : forecastProfile.mode === 'custom'
                      ? 'border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100'
                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
                title={
                  forecastMonths === 0
                    ? 'No forecast period — pick 1 month+ to edit cash inflow / outflow profile'
                    : 'Edit flat or custom per-period cash inflows / outflows'
                }
              >
                Forecast profile…
                {forecastProfile.mode === 'custom' && (
                  <span className="rounded border border-violet-300 bg-violet-100 px-1 py-px font-mono text-[8px] font-semibold tracking-wide text-violet-700">
                    custom
                  </span>
                )}
                {liquidityTiming.enabled && (
                  <span
                    className="rounded border border-sky-300 bg-sky-100 px-1 py-px font-mono text-[8px] font-semibold tracking-wide text-sky-700"
                    title={
                      (liquidityTiming.sizingBasis ?? 'horizon') === 'cycle'
                        ? 'Trough is the min of the dated cash path, sized on the nearest cycle'
                        : 'Trough is the min of the dated cash path, sized on the worst cycle of the horizon'
                    }
                  >
                    timed
                    {(liquidityTiming.sizingBasis ?? 'horizon') === 'horizon' && forecastMonths > 1
                      ? ' · worst'
                      : ''}
                    {(liquidityTiming.bookingMode ?? 'rolling') === 'term' ? ' · term' : ''}
                  </span>
                )}
              </button>
              <button
                onClick={resetRows}
                className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
              >
                Reset table
              </button>
            </div>
            {forecastMonths === 0 && (
              <span className="text-[10px] leading-snug text-gray-500">
                Needs an exposure period — pick 1m or longer
              </span>
            )}
          </div>
        </div>

        {forecastProfileOpen &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              className={`fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm${
                simDark ? ' sim-dark' : ''
              }`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="forecast-profile-title"
              onClick={e => {
                if (e.target === e.currentTarget) setForecastProfileOpen(false);
              }}
            >
              <div className={fpu.panel}>
                <div className="flex shrink-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 id="forecast-profile-title" className={fpu.title}>
                      Forecast profile —{' '}
                      {forecastView === 'liquidity'
                        ? 'Cycle timing'
                        : 'Balance-sheet cash'}
                    </h4>
                    <p className={fpu.desc}>
                      {rows
                        .filter(r => r.ccy !== 'USD')
                        .map(r => r.ccy)
                        .join(' · ') || '—'}{' '}
                      book · as of{' '}
                      {new Date().toLocaleDateString('en-GB', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}{' '}
                      · Tf {forecastMonths}m from FX Risk · amounts in M FCY
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setForecastProfileOpen(false)}
                    className={fpu.close}
                  >
                    Close
                  </button>
                </div>

                <div className="shrink-0 space-y-0">
                  <div className={fpu.chrome}>
                    <div className={fpu.modeWrap} role="group" aria-label="Profile view">
                      {(
                        [
                          {
                            id: 'flows' as const,
                            label: 'Flows',
                            title: 'Monthly amounts per cash line',
                          },
                          {
                            id: 'liquidity' as const,
                            label: 'Liquidity',
                            title:
                              'When inside the cycle each line settles — drives the trough',
                          },
                        ] as const
                      ).map(opt => (
                        <button
                          key={opt.id}
                          type="button"
                          title={opt.title}
                          onClick={() => setForecastView(opt.id)}
                          className={`transition-colors ${
                            forecastView === opt.id ? fpu.modeOn : fpu.modeOff
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {forecastView === 'liquidity' ? (
                      <span className={`text-[10px] ${fpu.textMuted}`}>
                        Monthly amounts stay in Flows · timing only moves the
                        liquidity trough, not FX exposure or CFaR
                      </span>
                    ) : (
                    <>
                    <div className={fpu.modeWrap} role="group" aria-label="Edit mode">
                      {(
                        [
                          {
                            id: 'flat' as const,
                            label: 'Flat formula',
                            title:
                              'Monthly amount × Tf with per-line Growth % MoM',
                          },
                          {
                            id: 'custom' as const,
                            label: 'Custom by period',
                            title:
                              'Edit M1…MTf with Excel-like formulas and fill-handle',
                          },
                        ] as const
                      ).map(opt => {
                        const on = forecastProfile.mode === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            title={opt.title}
                            onClick={() => setForecastMode(opt.id)}
                            className={`transition-colors ${
                              on ? fpu.modeOn : fpu.modeOff
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                    {onForecastProfileChange && (
                      <label
                        className={fpu.growthLabel}
                        title="Used by lines without their own Growth cell · also seeds Fill from flat"
                      >
                        <span className={`whitespace-nowrap ${fpu.textMuted}`}>
                          Default g MoM
                        </span>
                        <input
                          type="number"
                          step={0.1}
                          className={fpu.growthInput}
                          value={Number(
                            (
                              (Number.isFinite(forecastProfile.growthRateMoM)
                                ? forecastProfile.growthRateMoM
                                : 0) * 100
                            ).toFixed(2),
                          )}
                          onChange={e => {
                            const pct = Number(e.target.value);
                            const g = Number.isFinite(pct) ? pct / 100 : 0;
                            if (forecastProfile.mode === 'custom') {
                              const extrasByCcy = {
                                ...(forecastProfile.extrasByCcy ?? {}),
                              };
                              const byCcy: Record<string, ForecastMonthFlow[]> =
                                {};
                              for (const r of rows) {
                                if (r.ccy === 'USD') continue;
                                byCcy[r.ccy] = seedMonthsFromRowWithLineGrowth(
                                  r,
                                  forecastMonths,
                                  { ...forecastProfile, growthRateMoM: g },
                                  extrasByCcy[r.ccy],
                                );
                              }
                              onForecastProfileChange({
                                ...forecastProfile,
                                growthRateMoM: g,
                                byCcy,
                                extrasByCcy,
                                formulas: {},
                              });
                              return;
                            }
                            onForecastProfileChange({
                              ...forecastProfile,
                              growthRateMoM: g,
                            });
                          }}
                        />
                        <span className={fpu.textMuted}>%</span>
                      </label>
                    )}
                    {forecastProfile.mode === 'custom' && (
                      <>
                        <button
                          type="button"
                          onClick={fillCustomFromFlat}
                          className={fpu.actionBtn}
                          title="Refill every month from flat cash sources using Default g MoM + per-line flat growth"
                        >
                          Fill from flat
                        </button>
                        <button
                          type="button"
                          onClick={copyM1Across}
                          className={fpu.actionBtn}
                          title="Copy M1 cash sources across all months"
                        >
                          Copy M1 → all
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setForecastFormulaHelpOpen(v => !v)
                      }
                      className={fpu.actionBtn}
                      aria-expanded={forecastFormulaHelpOpen}
                    >
                      Formula help
                    </button>
                    </>
                    )}
                  </div>
                  {forecastView === 'flows' && forecastFormulaHelpOpen && (
                    <div
                      className={`rounded-md border px-2.5 py-2 ${
                        simDark
                          ? 'border-slate-700 bg-slate-950/60 text-slate-400'
                          : 'border-gray-200 bg-gray-50 text-gray-600'
                      } text-[10px] leading-relaxed`}
                    >
                      {forecastProfile.mode === 'flat' ? (
                        <>
                          Flat: Monthly × path with Growth % MoM · blank Growth
                          inherits Default g · <span className="font-mono">0</span>{' '}
                          = no growth for that line · Period Σ is the geometric
                          path sum · click a line name for 1m projection σ
                        </>
                      ) : (
                        <>
                          Custom: + Calc row for indexes ·{' '}
                          <span className="font-mono">=pow(1.01,k-1)</span> ·{' '}
                          <span className="font-mono">=3.5*idx1</span> ·{' '}
                          <span className="font-mono">F4</span> /{' '}
                          <span className="font-mono">$m1</span> locks absolute
                          (no shift on fill) · drag corner across months
                        </>
                      )}
                    </div>
                  )}
                </div>

                {forecastView === 'liquidity' ? (
                  <LiquidityTimingPanel
                    fpu={fpu}
                    simDark={simDark}
                    rows={rows}
                    forecastMonths={forecastMonths}
                    timing={liquidityTiming}
                    profile={forecastProfile}
                    hedgeSettleByCcy={hedgeSettleByCcy}
                    shared={shared}
                    activeLayers={activeLayers}
                    bookTargetByCcy={bookTargetByCcy}
                    cfarNetByCcyUsd={cfarNetByCcyUsd}
                    onTimingChange={
                      onForecastProfileChange ? updateLiquidityTiming : undefined
                    }
                  />
                ) : (
                <div className={fpu.tableWrap}>
                  {forecastProfile.mode === 'flat' ? (
                    <table className="w-full table-fixed border-collapse font-mono text-[11px] tabular-nums">
                      <colgroup>
                        <col className="w-[52px]" />
                        <col />
                        <col className={fpu.colAmt} />
                        <col className={fpu.colGrowth} />
                        <col className={fpu.colSum} />
                      </colgroup>
                      <thead className="sticky top-0 z-20 bg-slate-950">
                        <tr>
                          <th
                            colSpan={2}
                            className={`${fpu.th} sticky left-0 z-30 border-l-0 bg-slate-950 text-left`}
                          />
                          <th
                            colSpan={2}
                            className={`${fpu.th} ${fpu.groupHead} text-center`}
                          >
                            Input
                          </th>
                          <th className={`${fpu.th} ${fpu.groupHead} text-center`}>
                            Derived
                          </th>
                        </tr>
                        <tr>
                          <th
                            className={`${fpu.th} sticky left-0 z-30 border-l-0 bg-slate-950 text-left`}
                          >
                            CCY
                          </th>
                          <th
                            className={`${fpu.th} sticky left-[52px] z-30 bg-slate-950 text-left`}
                          >
                            Line
                          </th>
                          <th
                            className={`${fpu.th} ${fpu.colAmt}`}
                            title="Monthly amount (M FCY). Outflows entered positive."
                          >
                            Monthly
                          </th>
                          <th
                            className={`${fpu.th} ${fpu.colGrowth}`}
                            title="MoM growth for this line · blank inherits Default g MoM · 0 = no growth"
                          >
                            Growth %
                          </th>
                          <th
                            className={`${fpu.th} ${fpu.colSum}`}
                            title="Σ monthly path for this line over the forecast period"
                          >
                            Period Σ ×{forecastMonths}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows
                          .filter(r => r.ccy !== 'USD')
                          .flatMap(r => {
                            const periodNet = periodFlowSumLocalM(
                              r,
                              forecastMonths,
                              forecastProfile,
                            );
                            const extras = normalizeExtras(
                              forecastProfile.extrasByCcy?.[r.ccy] ??
                                EMPTY_FORECAST_EXTRAS,
                            );
                            const flatMonth = normalizeMonthFlow({
                              collections: r.collections,
                              payout: r.payout,
                              invoiceFcast: r.fcastFX ?? 0,
                              ...extras,
                            });
                            const defaultGrowthPct = Number(
                              (
                                (Number.isFinite(forecastProfile.growthRateMoM)
                                  ? forecastProfile.growthRateMoM
                                  : 0) * 100
                              ).toFixed(2),
                            );
                            const grouped = forecastFlowLinesGrouped();
                            const nodes: ReactNode[] = [];
                            let dataIdx = 0;

                            for (const group of FORECAST_FLOW_GROUPS) {
                              nodes.push(
                                <tr key={`${r.id}.sec.${group.id}`}>
                                  <td
                                    colSpan={5}
                                    className={`${fpu.sectionRow} sticky left-0`}
                                  >
                                    {group.label}
                                  </td>
                                </tr>,
                              );
                              for (const key of group.keys) {
                                const line = grouped.find(l => l.key === key);
                                if (!line) continue;
                                const li = dataIdx++;
                                const isExtra =
                                  line.key !== 'collections' &&
                                  line.key !== 'payout' &&
                                  line.key !== 'invoiceFcast';
                                const displayNum = flowFieldDisplay(
                                  flatMonth,
                                  line.key,
                                  line.side,
                                );
                                const draftKey = isExtra
                                  ? `fp.flat.${r.ccy}.${line.key}`
                                  : line.key === 'collections'
                                    ? `${r.id}.collections`
                                    : line.key === 'invoiceFcast'
                                      ? `${r.id}.fcastFX`
                                      : line.key === 'payout'
                                        ? `${r.id}.expenseOut`
                                        : '';
                                const growthDraftKey = `fp.growth.${r.ccy}.${line.key}`;
                                const growthOverride = hasFlatGrowthOverride(
                                  forecastProfile,
                                  r.ccy,
                                  line.key,
                                );
                                const lineGrowthPct =
                                  lineGrowthMoM(
                                    forecastProfile,
                                    r.ccy,
                                    line.key,
                                  ) * 100;
                                const linePeriodSum = flatLinePeriodSum(
                                  r,
                                  extras,
                                  forecastProfile,
                                  line.key,
                                  forecastMonths,
                                );
                                const sigma =
                                  lineUncertainty1m(
                                    forecastProfile,
                                    r.ccy,
                                    line.key,
                                  );
                                const signRail =
                                  line.side === 'out' ? fpu.signOut : fpu.signIn;
                                const sideTag =
                                  line.side === 'out'
                                    ? fpu.sideTagOut
                                    : fpu.sideTagIn;
                                nodes.push(
                                  <tr key={`${r.id}.${line.key}`}>
                                    <td
                                      className={`${fpu.td} sticky left-0 z-[1] border-l-0 bg-slate-950 font-semibold ${fpu.textPrimary}`}
                                    >
                                      {li === 0 ? r.ccy : ''}
                                    </td>
                                    <td
                                      className={`${fpu.td} sticky left-[52px] z-[1] bg-slate-950 text-left ${signRail}${
                                        onForecastProfileChange
                                          ? ` ${fpu.lineClickable}`
                                          : ''
                                      }`}
                                      title={`${line.title} · click to set 1m projection uncertainty (σ)`}
                                      onClick={
                                        onForecastProfileChange
                                          ? e =>
                                              openLineUncertainty(
                                                e,
                                                r.ccy,
                                                line.key,
                                                line.label,
                                              )
                                          : undefined
                                      }
                                    >
                                      <span className={fpu.textPrimary}>
                                        {line.label}
                                      </span>
                                      <span className={sideTag}>
                                        {line.side === 'out' ? 'OUT' : 'IN'}
                                      </span>
                                      {onForecastProfileChange && (
                                        <span
                                          className={
                                            sigma > 0
                                              ? fpu.sigmaSet
                                              : fpu.sigmaUnset
                                          }
                                          title="Set 1m projection σ"
                                        >
                                          {sigma > 0
                                            ? `σ ${(sigma * 100).toFixed(0)}%`
                                            : 'σ'}
                                        </span>
                                      )}
                                    </td>
                                    <td
                                      className={`${fpu.td} ${fpu.editableTd} ${fpu.colAmt}`}
                                    >
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        title={line.title}
                                        value={
                                          drafts[draftKey] ?? n(displayNum)
                                        }
                                        onChange={e => {
                                          const raw = e.target.value;
                                          setDrafts(prev => ({
                                            ...prev,
                                            [draftKey]: raw,
                                          }));
                                          if (isExtra) return;
                                          const v = roundMoney(parseFloat(raw));
                                          if (isNaN(v)) return;
                                          if (line.key === 'collections') {
                                            editRow(
                                              r.id,
                                              'collections',
                                              raw,
                                            );
                                          } else if (
                                            line.key === 'invoiceFcast'
                                          ) {
                                            editRow(r.id, 'fcastFX', raw);
                                          } else if (line.key === 'payout') {
                                            setRows(prev =>
                                              prev.map(row =>
                                                row.id === r.id
                                                  ? {
                                                      ...row,
                                                      payout: -Math.abs(v),
                                                    }
                                                  : row,
                                              ),
                                            );
                                          }
                                        }}
                                        onBlur={e => {
                                          if (isExtra) {
                                            commitFlatExtra(
                                              r.ccy,
                                              line.key as keyof ForecastCashExtras,
                                              e.target.value,
                                            );
                                            return;
                                          }
                                          if (line.key === 'collections') {
                                            blurRow(r.id, 'collections');
                                          } else if (
                                            line.key === 'invoiceFcast'
                                          ) {
                                            blurRow(r.id, 'fcastFX');
                                          } else {
                                            setDrafts(prev => {
                                              const next = { ...prev };
                                              delete next[draftKey];
                                              return next;
                                            });
                                          }
                                        }}
                                        className={fpu.input}
                                      />
                                    </td>
                                    <td className={`${fpu.td} ${fpu.colGrowth}`}>
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        title="MoM growth · blank inherits Default g MoM · 0 = no growth"
                                        placeholder={String(defaultGrowthPct)}
                                        value={
                                          drafts[growthDraftKey] !== undefined
                                            ? drafts[growthDraftKey]!
                                            : String(
                                                Number(
                                                  lineGrowthPct.toFixed(2),
                                                ),
                                              )
                                        }
                                        onChange={e => {
                                          setDrafts(prev => ({
                                            ...prev,
                                            [growthDraftKey]: e.target.value,
                                          }));
                                        }}
                                        onFocus={e => {
                                          if (!growthOverride) e.target.select();
                                        }}
                                        onBlur={e => {
                                          const raw = e.target.value.trim();
                                          const shown = String(
                                            Number(lineGrowthPct.toFixed(2)),
                                          );
                                          // Unchanged inherit display → stay inherit.
                                          if (
                                            !growthOverride &&
                                            drafts[growthDraftKey] ===
                                              undefined
                                          ) {
                                            return;
                                          }
                                          if (
                                            !growthOverride &&
                                            (raw === '' || raw === shown)
                                          ) {
                                            commitFlatGrowth(
                                              r.ccy,
                                              line.key,
                                              '',
                                            );
                                            return;
                                          }
                                          commitFlatGrowth(
                                            r.ccy,
                                            line.key,
                                            e.target.value,
                                          );
                                        }}
                                        className={
                                          growthOverride ||
                                          drafts[growthDraftKey] !== undefined
                                            ? fpu.input
                                            : fpu.growthInherited
                                        }
                                      />
                                    </td>
                                    <td
                                      className={`${fpu.td} ${fpu.colSum} ${fpu.textValue}`}
                                    >
                                      {f2(linePeriodSum)}
                                    </td>
                                  </tr>,
                                );
                              }
                            }

                            nodes.push(
                              <tr key={`${r.id}.net`} className={fpu.netRow}>
                                <td
                                  className={`${fpu.td} sticky left-0 z-[1] border-l-0 bg-slate-950 font-semibold ${fpu.textPrimary}`}
                                />
                                <td
                                  className={`${fpu.td} sticky left-[52px] z-[1] bg-slate-950 text-left ${fpu.textSecondary}`}
                                  title="Monthly net of all sources"
                                >
                                  Period net
                                </td>
                                <td className={`${fpu.td} ${fpu.textNet}`}>
                                  {f2(monthNet(flatMonth))}
                                </td>
                                <td className={fpu.td}>
                                  <span className={`text-[10px] ${fpu.textMuted}`}>
                                    —
                                  </span>
                                </td>
                                <td className={`${fpu.td} ${fpu.textNet}`}>
                                  {f2(periodNet)}
                                </td>
                              </tr>,
                            );
                            return nodes;
                          })}
                      </tbody>
                    </table>
                  ) : (
                    <FormulaGridProvider
                      rowOrder={forecastMonthRowOrder}
                      onFill={(
                        columnKey,
                        monthKeys,
                        formulaText,
                        sourceRowKey,
                      ) => {
                        const sourceMi = Number(sourceRowKey);
                        fillForecastFormulasAcrossMonths(
                          columnKey,
                          monthKeys,
                          formulaText,
                          Number.isFinite(sourceMi) ? sourceMi : 0,
                        );
                      }}
                    >
                    <table className="min-w-full border-collapse font-mono text-[10px] tabular-nums">
                      <thead className="sticky top-0 z-20 bg-slate-950">
                        <tr>
                          <th
                            colSpan={2}
                            className={`${fpu.th} sticky left-0 z-30 border-l-0 bg-slate-950 text-left`}
                          />
                          <th
                            colSpan={Math.max(1, forecastMonths)}
                            className={`${fpu.th} ${fpu.groupHead} text-center`}
                          >
                            Input · month cells
                          </th>
                          <th className={`${fpu.th} ${fpu.groupHead} text-center`}>
                            Derived
                          </th>
                        </tr>
                        <tr>
                          <th
                            className={`${fpu.th} sticky left-0 z-30 border-l-0 bg-slate-950 text-left`}
                          >
                            CCY
                          </th>
                          <th
                            className={`${fpu.th} sticky left-[52px] z-30 bg-slate-950 text-left`}
                          >
                            Line
                          </th>
                          {Array.from({ length: forecastMonths }, (_, i) => (
                            <th
                              key={i}
                              className={`${fpu.th} min-w-[64px] ${
                                i % 3 === 0 ? 'border-l border-slate-700' : ''
                              } ${
                                Math.floor(i / 3) % 2 === 1
                                  ? 'bg-slate-900/80'
                                  : 'bg-slate-950'
                              }`}
                              title="Click to edit · =prev*exp(0.05) · =m1 · drag corner across months"
                            >
                              M{i + 1}
                            </th>
                          ))}
                          <th className={fpu.th}>Period Σ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows
                          .filter(r => r.ccy !== 'USD')
                          .flatMap(r => {
                            const ensured = ensureProfileForRows(
                              forecastProfile,
                              rows,
                              forecastMonths,
                            );
                            const months = (
                              ensured.byCcy[r.ccy] ??
                              seedMonthsFromRow(
                                r,
                                forecastMonths,
                                0,
                                ensured.extrasByCcy[r.ccy],
                              )
                            ).map(normalizeMonthFlow);
                            const periodNet = sumPeriodFlow(months);
                            const grouped = forecastFlowLinesGrouped();
                            const calcRows =
                              ensured.calcRowsByCcy?.[r.ccy] ?? [];
                            const calcValues =
                              ensured.calcByCcy?.[r.ccy] ?? {};
                            const scopeOpts = {
                              calcRows,
                              calcValues,
                            };
                            const suggestions =
                              forecastSuggestionsFor(calcRows);
                            const nodes: ReactNode[] = [];
                            let dataIdx = 0;
                            const monthColSpan = 2 + forecastMonths + 1;

                            nodes.push(
                              <tr key={`${r.id}.sec.calc`}>
                                <td
                                  colSpan={monthColSpan}
                                  className={`${fpu.sectionRow} sticky left-0`}
                                >
                                  <span className="inline-flex items-center gap-2">
                                    Calculations
                                    {onForecastProfileChange && (
                                      <button
                                        type="button"
                                        className={`${fpu.actionBtn} normal-case tracking-normal`}
                                        title="Temporary index / helper row (not in Net)"
                                        onClick={() => addCalcRow(r.ccy)}
                                      >
                                        + Calc row
                                      </button>
                                    )}
                                  </span>
                                </td>
                              </tr>,
                            );

                            if (calcRows.length === 0) {
                              nodes.push(
                                <tr key={`${r.id}.calc.empty`}>
                                  <td
                                    colSpan={monthColSpan}
                                    className={`${fpu.td} border-l-0 text-left ${fpu.textMuted}`}
                                  >
                                    Optional · e.g. idx1 ={' '}
                                    <span className="font-mono">
                                      pow(1.01, k-1)
                                    </span>
                                    , then Revenue ={' '}
                                    <span className="font-mono">3.5*idx1</span>
                                  </td>
                                </tr>,
                              );
                            }

                            for (const calc of calcRows) {
                              const field = calcFieldKey(calc.id);
                              const series = resizeCalcSeries(
                                calcValues[calc.id],
                                forecastMonths,
                              );
                              const lineSum = series.reduce((s, v) => s + v, 0);
                              const li = dataIdx++;
                              nodes.push(
                                <tr key={`${r.id}.calc.${calc.id}`}>
                                  <td
                                    className={`${fpu.td} sticky left-0 z-[1] border-l-0 bg-slate-950 font-semibold ${fpu.textPrimary}`}
                                  >
                                    {li === 0 ? r.ccy : ''}
                                  </td>
                                  <td
                                    className={`${fpu.td} sticky left-[52px] z-[1] bg-slate-950 text-left border-l-2 border-violet-500`}
                                  >
                                    <div className="flex min-w-0 items-center gap-1">
                                      <input
                                        type="text"
                                        className={`min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-left font-mono text-[11px] ${fpu.textPrimary} outline-none focus:underline`}
                                        title="Formula ref (idx1, growth, …) — commit on blur"
                                        defaultValue={calc.ref}
                                        key={`${calc.id}.ref.${calc.ref}`}
                                        disabled={!onForecastProfileChange}
                                        onBlur={e =>
                                          renameCalcRow(r.ccy, calc.id, {
                                            ref: e.target.value,
                                          })
                                        }
                                      />
                                      {onForecastProfileChange && (
                                        <button
                                          type="button"
                                          className={`shrink-0 px-1 text-[11px] ${fpu.textMuted} hover:text-rose-400`}
                                          title="Delete calc row"
                                          onClick={() =>
                                            removeCalcRow(r.ccy, calc.id)
                                          }
                                        >
                                          ×
                                        </button>
                                      )}
                                    </div>
                                    <input
                                      type="text"
                                      className={`mt-0.5 w-full border-0 bg-transparent px-0 py-0 text-left text-[9px] ${fpu.textMuted} outline-none`}
                                      title="Label"
                                      value={calc.label}
                                      disabled={!onForecastProfileChange}
                                      onChange={e =>
                                        renameCalcRow(
                                          r.ccy,
                                          calc.id,
                                          { label: e.target.value },
                                          { trimLabel: false },
                                        )
                                      }
                                      onBlur={e =>
                                        renameCalcRow(r.ccy, calc.id, {
                                          label: e.target.value,
                                        })
                                      }
                                    />
                                  </td>
                                  {series.map((val, mi) => {
                                    const fKey = forecastFormulaKey(
                                      r.ccy,
                                      field,
                                      mi,
                                    );
                                    const storedFormula =
                                      forecastProfile.formulas[fKey];
                                    const scope = periodFormulaScope(
                                      r,
                                      months,
                                      field,
                                      mi,
                                      scopeOpts,
                                    );
                                    const cellError = storedFormula
                                      ? evalPeriodFormula(
                                          storedFormula,
                                          scope,
                                        ).error
                                      : undefined;
                                    const cellColumnKey = `${r.ccy}::${field}`;
                                    return (
                                      <FormulaCell
                                        key={mi}
                                        tdClass={`${fpu.td} ${fpu.formulaCell} ${
                                          storedFormula
                                            ? fpu.formulaOverride
                                            : ''
                                        } ${
                                          mi % 3 === 0
                                            ? 'border-l border-slate-700'
                                            : ''
                                        } ${fpu.textValue}`}
                                        display={f2(val)}
                                        formula={storedFormula?.replace(
                                          /^=/,
                                          '',
                                        )}
                                        defaultFormula=""
                                        onCommit={text =>
                                          commitPeriodFormula(
                                            r.ccy,
                                            mi,
                                            field,
                                            text,
                                          )
                                        }
                                        error={cellError}
                                        cellAddress={`${calc.ref} · M${mi + 1}`}
                                        evaluateLive={text => {
                                          const t = text.trim();
                                          if (!t) {
                                            return {
                                              valid: true,
                                              resultLabel: f2(val),
                                            };
                                          }
                                          const ev = evalPeriodFormula(
                                            t.startsWith('=') ? t : `=${t}`,
                                            scope,
                                          );
                                          if (
                                            ev.error ||
                                            ev.value == null
                                          ) {
                                            return {
                                              valid: false,
                                              resultLabel: '—',
                                            };
                                          }
                                          return {
                                            valid: true,
                                            resultLabel: f2(ev.value),
                                          };
                                        }}
                                        title={`${calc.ref} · =pow(1.01,k-1) · =prev*1.01 · drag across months`}
                                        suggestions={suggestions}
                                        columnKey={cellColumnKey}
                                        rowKey={String(mi)}
                                        pickTokenResolver={active =>
                                          forecastFormulaPickToken(
                                            active.columnKey,
                                            active.rowKey,
                                            cellColumnKey,
                                            String(mi),
                                            calcRows,
                                          )
                                        }
                                        theme={simDark ? 'dark' : 'light'}
                                      />
                                    );
                                  })}
                                  <td className={`${fpu.td} ${fpu.textValue}`}>
                                    {f2(lineSum)}
                                  </td>
                                </tr>,
                              );
                            }

                            for (const group of FORECAST_FLOW_GROUPS) {
                              nodes.push(
                                <tr key={`${r.id}.sec.${group.id}`}>
                                  <td
                                    colSpan={monthColSpan}
                                    className={`${fpu.sectionRow} sticky left-0`}
                                  >
                                    {group.label}
                                  </td>
                                </tr>,
                              );
                              for (const key of group.keys) {
                                const line = grouped.find(l => l.key === key);
                                if (!line) continue;
                                const li = dataIdx++;
                                const sigma = lineUncertainty1m(
                                  forecastProfile,
                                  r.ccy,
                                  line.key,
                                );
                                const growthOverride = hasFlatGrowthOverride(
                                  forecastProfile,
                                  r.ccy,
                                  line.key,
                                );
                                const signRail =
                                  line.side === 'out' ? fpu.signOut : fpu.signIn;
                                const sideTag =
                                  line.side === 'out'
                                    ? fpu.sideTagOut
                                    : fpu.sideTagIn;
                                const linePeriodSum = months.reduce(
                                  (s, m) =>
                                    s +
                                    flowFieldDisplay(m, line.key, line.side),
                                  0,
                                );
                                nodes.push(
                                  <tr key={`${r.id}.${line.key}`}>
                                    <td
                                      className={`${fpu.td} sticky left-0 z-[1] border-l-0 bg-slate-950 font-semibold ${fpu.textPrimary}`}
                                    >
                                      {li === 0 ? r.ccy : ''}
                                    </td>
                                    <td
                                      className={`${fpu.td} sticky left-[52px] z-[1] bg-slate-950 text-left ${signRail}${
                                        onForecastProfileChange
                                          ? ` ${fpu.lineClickable}`
                                          : ''
                                      }`}
                                      title={`${line.title} · click to set 1m projection uncertainty (σ)`}
                                      onClick={
                                        onForecastProfileChange
                                          ? e =>
                                              openLineUncertainty(
                                                e,
                                                r.ccy,
                                                line.key,
                                                line.label,
                                              )
                                          : undefined
                                      }
                                    >
                                      <span className={fpu.textPrimary}>
                                        {line.label}
                                      </span>
                                      <span className={sideTag}>
                                        {line.side === 'out' ? 'OUT' : 'IN'}
                                      </span>
                                      {growthOverride && (
                                        <span
                                          className={fpu.gBadge}
                                          title="Flat Growth % MoM override still set for this line"
                                        >
                                          g
                                        </span>
                                      )}
                                      {onForecastProfileChange && (
                                        <span
                                          className={
                                            sigma > 0
                                              ? fpu.sigmaSet
                                              : fpu.sigmaUnset
                                          }
                                          title="Set 1m projection σ"
                                        >
                                          {sigma > 0
                                            ? `σ ${(sigma * 100).toFixed(0)}%`
                                            : 'σ'}
                                        </span>
                                      )}
                                    </td>
                                    {months.map((m, mi) => {
                                      const field = line.key;
                                      const fKey = forecastFormulaKey(
                                        r.ccy,
                                        field,
                                        mi,
                                      );
                                      const storedFormula =
                                        forecastProfile.formulas[fKey];
                                      const displayNum = flowFieldDisplay(
                                        m,
                                        field,
                                        line.side,
                                      );
                                      const scope = periodFormulaScope(
                                        r,
                                        months,
                                        field,
                                        mi,
                                        scopeOpts,
                                      );
                                      const cellError = storedFormula
                                        ? evalPeriodFormula(
                                            storedFormula,
                                            scope,
                                          ).error
                                        : undefined;
                                      const cellColumnKey = `${r.ccy}::${field}`;
                                      return (
                                        <FormulaCell
                                          key={mi}
                                          tdClass={`${fpu.td} ${fpu.formulaCell} ${
                                            storedFormula
                                              ? fpu.formulaOverride
                                              : ''
                                          } ${
                                            mi % 3 === 0
                                              ? 'border-l border-slate-700'
                                              : ''
                                          } ${fpu.textValue}`}
                                          display={f2(displayNum)}
                                          formula={storedFormula?.replace(
                                            /^=/,
                                            '',
                                          )}
                                          defaultFormula=""
                                          onCommit={text =>
                                            commitPeriodFormula(
                                              r.ccy,
                                              mi,
                                              field,
                                              text,
                                            )
                                          }
                                          error={cellError}
                                          cellAddress={`${line.label} · M${mi + 1}`}
                                          evaluateLive={text => {
                                            const t = text.trim();
                                            if (!t) {
                                              return {
                                                valid: true,
                                                resultLabel: f2(displayNum),
                                              };
                                            }
                                            const ev = evalPeriodFormula(
                                              t.startsWith('=') ? t : `=${t}`,
                                              scope,
                                            );
                                            if (ev.error || ev.value == null) {
                                              return {
                                                valid: false,
                                                resultLabel: '—',
                                              };
                                            }
                                            const shown =
                                              line.side === 'out'
                                                ? Math.abs(ev.value)
                                                : ev.value;
                                            return {
                                              valid: true,
                                              resultLabel: f2(shown),
                                            };
                                          }}
                                          title={`${line.title} · =3.5*idx1 · =prev*exp(0.05) · =m1 / $m1 · drag across months`}
                                          suggestions={suggestions}
                                          columnKey={cellColumnKey}
                                          rowKey={String(mi)}
                                          pickTokenResolver={active =>
                                            forecastFormulaPickToken(
                                              active.columnKey,
                                              active.rowKey,
                                              cellColumnKey,
                                              String(mi),
                                              calcRows,
                                            )
                                          }
                                          theme={simDark ? 'dark' : 'light'}
                                        />
                                      );
                                    })}
                                    <td className={`${fpu.td} ${fpu.textValue}`}>
                                      {f2(linePeriodSum)}
                                    </td>
                                  </tr>,
                                );
                              }
                            }

                            nodes.push(
                              <tr key={`${r.id}.net`} className={fpu.netRow}>
                                <td
                                  className={`${fpu.td} sticky left-0 z-[1] border-l-0 bg-slate-950 font-semibold ${fpu.textPrimary}`}
                                />
                                <td
                                  className={`${fpu.td} sticky left-[52px] z-[1] bg-slate-950 text-left ${fpu.textSecondary}`}
                                  title="Month net of all sources"
                                >
                                  Period net
                                </td>
                                {months.map((m, mi) => {
                                  const net = monthNet(m);
                                  return (
                                    <td
                                      key={mi}
                                      className={`${fpu.td} ${fpu.textNet} ${
                                        mi % 3 === 0
                                          ? 'border-l border-slate-700'
                                          : ''
                                      }`}
                                    >
                                      {f2(net)}
                                    </td>
                                  );
                                })}
                                <td className={`${fpu.td} ${fpu.textNet}`}>
                                  {f2(periodNet)}
                                </td>
                              </tr>,
                            );
                            return nodes;
                          })}
                      </tbody>
                    </table>
                    </FormulaGridProvider>
                  )}
                </div>
                )}
                <div className={fpu.footer}>
                  <div className={`space-y-1 text-[10px] ${fpu.textMuted}`}>
                    {forecastView === 'liquidity' ? (
                      <div>
                        {liquidityTiming.enabled
                          ? 'Trough = min of the dated path · every out-line counts, not just Revenue payout'
                          : 'Timing off — trough stays at cash + payout (every payout before any payin)'}
                        {' · '}
                        Window days are days of the month · presets write the
                        selected scope
                      </div>
                    ) : (
                      <>
                    <div>
                      {forecastProfile.mode === 'flat'
                        ? 'Blank growth inherits Default · boxed Growth = override · 0 = flat path'
                        : 'Calc rows above cash · k = month # · Growth in formulas · g badge = flat override'}
                      {' · '}
                      IN/OUT sign rail · σ on line name
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
                      {rows
                        .filter(r => r.ccy !== 'USD')
                        .map(r => {
                          const net = periodFlowSumLocalM(
                            r,
                            forecastMonths,
                            forecastProfile,
                          );
                          return (
                            <span key={r.ccy}>
                              {r.ccy}{' '}
                              <span className={fpu.textNet}>Σ {f2(net)}</span>
                            </span>
                          );
                        })}
                    </div>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setForecastProfileOpen(false)}
                    className={fpu.done}
                  >
                    Done
                  </button>
                </div>

                {lineUncertaintyEdit &&
                  typeof document !== 'undefined' &&
                  createPortal(
                    <div
                      className="fixed inset-0 z-[310]"
                      role="dialog"
                      aria-label="Line projection uncertainty"
                      onMouseDown={e => {
                        if (e.target === e.currentTarget) {
                          setLineUncertaintyEdit(null);
                        }
                      }}
                    >
                      <div
                        className={`absolute min-w-[260px] max-w-[320px] rounded-lg border p-3 shadow-2xl ${
                          simDark
                            ? 'sim-dark border-slate-600 bg-slate-900 text-slate-100 ring-1 ring-amber-500/25'
                            : 'border-gray-200 bg-white text-gray-900'
                        }`}
                        style={{
                          top: lineUncertaintyEdit.top,
                          left: lineUncertaintyEdit.left,
                        }}
                        onMouseDown={e => e.stopPropagation()}
                      >
                        <div
                          className={`text-[11px] font-semibold ${
                            simDark ? 'text-amber-200' : 'text-amber-800'
                          }`}
                        >
                          {lineUncertaintyEdit.ccy} ·{' '}
                          {lineUncertaintyEdit.label} · projection σ
                        </div>
                        <p
                          className={`mt-1 text-[10px] leading-relaxed ${
                            simDark ? 'text-slate-400' : 'text-gray-500'
                          }`}
                        >
                          1m relative σ on this line over Tf · compounds √g ·
                          Revenue feeds Analytics u₁ₘ
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {FORECAST_UNCERTAINTY_OPTIONS.map(opt => {
                            const cur = lineUncertainty1m(
                              forecastProfile,
                              lineUncertaintyEdit.ccy,
                              lineUncertaintyEdit.field,
                            );
                            const on = Math.abs(cur - opt.value) < 1e-12;
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => {
                                  setLineUncertainty(
                                    lineUncertaintyEdit.ccy,
                                    lineUncertaintyEdit.field,
                                    opt.value,
                                  );
                                  setLineUncertaintyDraft(
                                    opt.value > 0
                                      ? Number(
                                          (opt.value * 100).toFixed(2),
                                        ).toString()
                                      : '',
                                  );
                                  if (opt.value === 0) {
                                    setLineUncertaintyEdit(null);
                                  }
                                }}
                                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                                  on
                                    ? simDark
                                      ? 'bg-amber-500/25 text-amber-100'
                                      : 'bg-amber-100 text-amber-900'
                                    : simDark
                                      ? 'text-slate-400 hover:bg-slate-800'
                                      : 'text-gray-600 hover:bg-gray-100'
                                }`}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                        <label
                          className={`mt-2 flex items-center gap-2 text-[10px] ${
                            simDark ? 'text-slate-400' : 'text-gray-500'
                          }`}
                        >
                          Custom %
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.5}
                            value={lineUncertaintyDraft}
                            onChange={e =>
                              setLineUncertaintyDraft(e.target.value)
                            }
                            onBlur={() => {
                              const pct = Number(lineUncertaintyDraft);
                              if (!Number.isFinite(pct) || pct <= 0) {
                                setLineUncertainty(
                                  lineUncertaintyEdit.ccy,
                                  lineUncertaintyEdit.field,
                                  0,
                                );
                                return;
                              }
                              setLineUncertainty(
                                lineUncertaintyEdit.ccy,
                                lineUncertaintyEdit.field,
                                Math.min(1, pct / 100),
                              );
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                (e.target as HTMLInputElement).blur();
                                setLineUncertaintyEdit(null);
                              } else if (e.key === 'Escape') {
                                setLineUncertaintyEdit(null);
                              }
                            }}
                            className={`w-16 rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                              simDark
                                ? 'border-slate-600 bg-slate-950 text-slate-100'
                                : 'border-gray-300 bg-white text-gray-900'
                            }`}
                          />
                        </label>
                        <div className="mt-2 flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setLineUncertaintyEdit(null)}
                            className={`rounded px-2 py-0.5 text-[10px] ${
                              simDark
                                ? 'text-slate-300 hover:bg-slate-800'
                                : 'text-gray-600 hover:bg-gray-100'
                            }`}
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    </div>,
                    document.body,
                  )}
              </div>
            </div>,
            document.body,
          )}

        {showAdvancedBook && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-100 bg-gray-50 px-4 py-2">
          {/* Formula layer toggles — same state as Layer Setup tab */}
          <span className={toolCaption}>Buffer layers</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {BUFFER_LAYER_CHIPS.map(l => {
              const on = activeLayers.has(l.id);
              const panelOpen = layerPanel === l.id;
              const badge = layerBadge(l.id);
              return (
                <span
                  key={l.id}
                  className={`inline-flex items-stretch overflow-hidden rounded-md border transition-colors ${
                    on ? CHIP_ON[l.hue] : 'border-gray-200 bg-white'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onLayerToggle(l.id);
                      // Switching a layer off takes its settings dialog with it.
                      if (on && panelOpen) setLayerPanel(null);
                    }}
                    title={l.hint}
                    aria-pressed={on}
                    className="inline-flex items-center gap-1.5 px-2 py-1"
                  >
                    <span
                      className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border text-[8px] font-bold leading-none text-white ${
                        on ? CHIP_BOX_ON[l.hue] : 'border-gray-300 bg-white'
                      }`}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <span className={`text-[11px] font-semibold ${on ? 'text-gray-900' : 'text-gray-500'}`}>
                      {l.label}
                    </span>
                    <span
                      className={`border-l pl-1.5 font-mono text-[8px] tracking-wide ${
                        on ? CHIP_TAG_ON[l.hue] : 'border-gray-200 text-gray-400'
                      }`}
                    >
                      {l.band}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLayerPanel(p => (p === l.id ? null : l.id))}
                    aria-pressed={panelOpen}
                    aria-label={l.settingsLabel}
                    title={l.settingsLabel}
                    className={`inline-flex items-center gap-1 border-l px-1.5 transition-colors ${
                      on ? CHIP_TAG_ON[l.hue].split(' ')[0] : 'border-gray-200'
                    } ${
                      panelOpen ? CHIP_GEAR_ON[l.hue] : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    <GearIcon className="h-3.5 w-3.5" />
                    {badge && (
                      <span className="font-mono text-[9px] font-semibold tabular-nums">
                        {badge}
                      </span>
                    )}
                  </button>
                </span>
              );
            })}
          </div>

          {/* The funding convention decides the whole liquidity band, so it belongs
              on the desk next to the layers — not buried in the Forecast profile. */}
          {showLiquidity && (
            <>
              <span className={`${toolCaption} border-l border-gray-200 pl-4`}>Swap funding</span>
              <div className="inline-flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[9px] tracking-wide text-gray-400">Size on</span>
                <div className={segTrack('rail')} role="group" aria-label="Sizing basis">
                  {SIZING_BASIS_OPTIONS.map(o => (
                    <button
                      key={o.id}
                      type="button"
                      title={o.hint}
                      disabled={!liquidityFundingWritable}
                      onClick={() => updateLiquidityTiming({ sizingBasis: o.id })}
                      className={deskSeg(
                        (liquidityTiming.sizingBasis ?? 'horizon') === o.id,
                        'emerald',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <span className="font-mono text-[9px] tracking-wide text-gray-400">Book as</span>
                <div className={segTrack('rail')} role="group" aria-label="Swap booking mode">
                  {BOOKING_MODE_OPTIONS.map(o => (
                    <button
                      key={o.id}
                      type="button"
                      title={o.hint}
                      disabled={!liquidityFundingWritable}
                      onClick={() => updateLiquidityTiming({ bookingMode: o.id })}
                      className={deskSeg(
                        (liquidityTiming.bookingMode ?? 'rolling') === o.id,
                        'emerald',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                {liquidityFundingLive ? (
                  <span
                    className="font-mono text-[9px] tracking-wide text-gray-500"
                    title={(liquidityTiming.bookingMode ?? 'rolling') === 'term'
                      ? `One leg today, held to M${horizonMonths || forecastMonths}. Net across currencies at spot — a sweep of excess FCY nets against a currency being funded`
                      : 'The leg to trade today, then one per cycle — each rolls, so the book adds up. Net across currencies at spot, so a sweep of excess FCY nets against a currency being funded'}
                  >
                    {(liquidityTiming.bookingMode ?? 'rolling') === 'term' ? 'term leg ' : 'book now '}
                    <span className="text-gray-700">${f2(liquidityBookUsd.bookNow)}M</span>
                    {' · outstanding M'}
                    {horizonMonths || forecastMonths}{' '}
                    <span className="text-gray-700">${f2(liquidityBookUsd.outstanding)}M</span>
                  </span>
                ) : (
                  <span
                    className="font-mono text-[9px] tracking-wide text-gray-400"
                    title="These decide how the dated cash path is funded, so they only bite once the trough is driven from timing — turn that on in the Liquidity view of the Forecast profile"
                  >
                    dated path off
                  </span>
                )}
                <span className="font-mono text-[8px] tracking-wide text-gray-400">→ SWAP</span>
              </div>
            </>
          )}

          {showFxHedge && (
            <>
              <span className={`${toolCaption} border-l border-gray-200 pl-4`}>Hedging strategy</span>
              <div className="inline-flex items-center gap-1.5">
                <div className={segTrack('rail')}>
                  {HEDGE_STRATEGIES.map(s => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setStrategy(s.id)}
                      className={deskSeg(strategy === s.id, 'rose')}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <span className="font-mono text-[8px] tracking-wide text-gray-400">→ FX HEDGE</span>
              </div>
            </>
          )}

          {/* The VAR limit lives in its dialog; its binding state has to stay on
              the surface, or an active budget constraint goes unseen. */}
          {activeLayers.has('portfolioDiv') && portfolioSummary && (
            <span className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] text-gray-500">
              <span
                className={
                  portfolioSummary.portfolio_VAR_USD > portfolioSummary.policyVAR
                    ? 'font-semibold text-red-700'
                    : ''
                }
              >
                VAR ${f2(portfolioSummary.portfolio_VAR_USD)}M / ${f2(portfolioSummary.policyVAR)}M
              </span>
              <span
                className={
                  portfolioSummary.overlay_carry_USD >= 0 ? 'text-emerald-700' : 'text-red-700'
                }
              >
                carry {portfolioSummary.overlay_carry_USD >= 0 ? '+' : ''}
                ${f2(portfolioSummary.overlay_carry_USD)}M/yr
              </span>
              {portfolioSummary.budget_binding && (
                <span className="font-semibold text-orange-700">⚠ budget binding</span>
              )}
              {portfolioSummary.stress_trim && (
                <span className="font-semibold text-orange-700">⚠ stress trim</span>
              )}
              {portfolioSummary.var_trim && (
                <span className="font-semibold text-amber-700">⚠ trimmed</span>
              )}
            </span>
          )}
        </div>

        )}

        {showAdvancedBook && layerPanel === 'floorH' && (
          <LayerModal
            hue="amber"
            title="Minimum liquidity buffer"
            subtitle={`hard cash floor per currency (M FCY)${
              activeLayers.has('floorH') ? '' : ' — turn the Min floor layer on to apply these'
            }`}
            readout={`Σ ${f2(floorTotalUsd)} $USD`}
            footnote="M FCY · $USD equivalent at spot · floors feed the H* target, not the swap sizing directly"
            simDark={simDark}
            onClose={() => setLayerPanel(null)}
          >
            <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {floorRows.map(r => (
                <label
                  key={r.id}
                  className="grid grid-cols-[34px_minmax(0,1fr)_76px] items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1"
                >
                  <span className="font-mono text-[11px] font-semibold text-gray-700">{r.ccy}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={drafts[`${r.id}.cash_floor`] ?? n(r.cash_floor)}
                    onChange={e => editRow(r.id, 'cash_floor', e.target.value)}
                    onBlur={() => blurRow(r.id, 'cash_floor')}
                    className={`w-full rounded border px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-gray-700 outline-none focus:ring-1 focus:ring-amber-400 ${
                      r.cash_floor ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'
                    }`}
                  />
                  <span className="text-right font-mono text-[10px] tabular-nums text-gray-400">
                    {r.cash_floor ? `${f2(fcyToUsdM(r.cash_floor, r.ccy))} $USD` : '—'}
                  </span>
                </label>
              ))}
            </div>
          </LayerModal>
        )}

        {showAdvancedBook && layerPanel === 'sigmaP' && (
          <LayerModal
            hue="amber"
            title="Forecast uncertainty σ"
            subtitle={`δσ = σ × z₉₅ × |payout| — a prefunded payout carries no σ${
              activeLayers.has('sigmaP')
                ? ''
                : ' — turn the Payout σ buffer layer on to apply these'
            }`}
            readout="z₉₅ 1.645"
            footnote="% of the payout line · blank = default · overrides write the payout σ on the forecast profile"
            simDark={simDark}
            onClose={() => setLayerPanel(null)}
          >
            <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
              <label className="grid grid-cols-[minmax(0,1fr)_60px_16px] items-center gap-2 rounded-md border border-amber-300 bg-white px-2 py-1">
                <span className="text-[10px] font-semibold text-gray-700">Default · all CCY</span>
                <input
                  type="number"
                  min={0}
                  max={40}
                  step={1}
                  value={roundMoney(shared.σ_P * 100)}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v)) onSharedChange('σ_P', Math.max(0, v) / 100);
                  }}
                  className="w-full rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-gray-700 outline-none focus:ring-1 focus:ring-amber-400"
                />
                <span className="font-mono text-[10px] text-gray-400">%</span>
              </label>
              {onForecastProfileChange &&
                floorRows.map(r => {
                  const override = lineUncertainty1m(forecastProfile, r.ccy, 'payout');
                  const effective = override > 0 ? override : shared.σ_P;
                  return (
                    <label
                      key={r.id}
                      className="grid grid-cols-[34px_minmax(0,1fr)_76px] items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1"
                    >
                      <span className="font-mono text-[11px] font-semibold text-gray-700">
                        {r.ccy}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="default"
                        value={
                          sigmaDrafts[r.ccy] ??
                          (override > 0 ? n(roundMoney(override * 100)) : '')
                        }
                        onChange={e =>
                          setSigmaDrafts(d => ({ ...d, [r.ccy]: e.target.value }))
                        }
                        onBlur={e => commitSigma(r.ccy, e.target.value)}
                        className={`w-full rounded border px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-gray-700 outline-none focus:ring-1 focus:ring-amber-400 ${
                          override > 0 ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'
                        }`}
                      />
                      <span className="text-right font-mono text-[10px] tabular-nums text-gray-400">
                        eff {Math.round(effective * 100)}%
                      </span>
                    </label>
                  );
                })}
            </div>
          </LayerModal>
        )}

        {showAdvancedBook && layerPanel === 'cfarCover' && (
          <LayerModal
            hue="sky"
            title="CFaR cover — Net CFaR only"
            subtitle={`Liquidity swap sized from FX-only Net CFaR — size and timing, not gap × σ (no loop). Displayed CFaR then adds this swap's rate-diff bridge in parallel with the FX hedge${
              activeLayers.has('cfarCover') ? '' : ' — turn the CFaR cover layer on to apply'
            }`}
            readout={`Σ ${f2(Object.values(cfarNetByCcyUsd).reduce((s, v) => s + v, 0))} $USD`}
            footnote="USD Net CFaR → FCY at spot · additive to other buffers · funding-swap O/N + points sit on top of unfunded cash carry"
            simDark={simDark}
            onClose={() => setLayerPanel(null)}
          >
            <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {floorRows.map(r => {
                const netUsd = cfarNetByCcyUsd[r.ccy] ?? 0;
                const coverFcy = netUsd > 0.001 ? usdToFcyM(netUsd, r.ccy) : 0;
                return (
                  <div
                    key={r.id}
                    className="grid grid-cols-[34px_minmax(0,1fr)_76px] items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1"
                  >
                    <span className="font-mono text-[11px] font-semibold text-gray-700">{r.ccy}</span>
                    <span className="text-right font-mono text-[11px] tabular-nums text-gray-700">
                      {netUsd > 0.001 ? `${f2(coverFcy)} FCY` : '—'}
                    </span>
                    <span className="text-right font-mono text-[10px] tabular-nums text-gray-400">
                      {netUsd > 0.001 ? `${f2(netUsd)} $USD` : 'no Net CFaR'}
                    </span>
                  </div>
                );
              })}
            </div>
          </LayerModal>
        )}

        {showAdvancedBook && layerPanel === 'carryOptim' && (
          <LayerModal
            hue="emerald"
            title="Carry target inputs"
            subtitle="steer the carry leg on the rate, the cash target, or the P&L target"
            readout={`r_USD ${f2(shared.r_USD)}% · ${carryHorizon}m ${usdK(carryTotals.horizon)}`}
            footnote={carryLive
              ? 'Setup for the carry layer — a positive P&L ask on a PAY currency shorts FCY (sell near), which prints negative CIP points in FX Hedge Carry. Accrual on the time-weighted post-swap balance with flows mid-cycle · ACT/360 or ACT/365 per currency · carry vs USD = (r_FCY − r_USD). Targets still clamp to floors and the portfolio VAR cap'
              : 'Preview only until you commit a cash or P&L target — that turns this layer on so Target LP Cash, Swap Near and CIP points land in the main table. A positive P&L ask on a PAY currency shorts FCY and prints negative CIP in FX Hedge Carry'}
            simDark={simDark}
            size="lg"
            onClose={() => setLayerPanel(null)}
          >
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className={toolCaption}>Steer on</span>
                <div className="inline-flex rounded-md border border-emerald-300 bg-white p-0.5">
                  {([
                    ['rate', 'Rate r_OD', 'Size the leg from z_opt = Φ⁻¹(1 − Δr / r_OD)'],
                    ['cash', 'Cash target', 'Type the Target LP Cash you want to hold (M FCY)'],
                    ['pnl', 'Carry P&L', 'Type the near-period carry you want to earn ($k) — solves back to the cash target'],
                  ] as const).map(([id, label, hint]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setCarryDrive(id)}
                      title={hint}
                      className={carrySeg(carryDrive === id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className={toolCaption}>Lifecycle</span>
                <div className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5">
                  {[1, 3, 6, 12].map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setCarryHorizon(m)}
                      title={`Project targets and accrual ${m} month${m > 1 ? 's' : ''} out`}
                      className={carrySeg(carryHorizon === m)}
                    >
                      {m}m
                    </button>
                  ))}
                </div>
                {carryTargetCount > 0 && (
                  <button
                    type="button"
                    onClick={() => carryRows.forEach(r => setCarryTarget(r.id, undefined))}
                    className="ml-auto rounded border border-gray-300 bg-white px-2 py-0.5 font-mono text-[10px] font-semibold text-gray-600 hover:bg-gray-50"
                  >
                    Clear {carryTargetCount} manual
                  </button>
                )}
              </div>

              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className={`${carryTh} text-left`}>CCY</th>
                    <th className={carryTh} title="LP debit / overdraft rate — the cost of running the cushion too thin">r_OD %</th>
                    <th className={carryTh} title="Δr = r_USD − r_FCY">Δr</th>
                    <th className={`${carryTh} text-center`}>Dir</th>
                    <th className={carryTh} title="Money-market day count used for the accrual">Basis</th>
                    <th className={carryTh} title="Target LP Cash = opening LP + swap (M FCY) — the cash exposure the carry leg holds">Target M FCY</th>
                    <th className={carryTh}>Target $USD</th>
                    <th className={carryTh} title="Carry vs USD accrued over the near period">M1 carry</th>
                    <th className={carryTh} title={`Cumulative carry vs USD over ${carryHorizon} month${carryHorizon > 1 ? 's' : ''}`}>{carryHorizon}m carry</th>
                    <th className={carryTh} aria-label="Expand" />
                  </tr>
                </thead>
                <tbody>
                  {carryProjection.map(c => {
                    const r = c.row;
                    const manual =
                      typeof r.carry_target === 'number' && Number.isFinite(r.carry_target);
                    const reason = carryBindReason(r, c.target);
                    const note = carryNotes[r.id];
                    const reqVsHeld = manual
                      ? `Requested ${f2(r.carry_target!)} M ${r.ccy} — holds ${f2(c.target)}`
                      : undefined;
                    const open = carryExpanded === r.ccy;
                    const peakTarget = Math.max(
                      ...c.periods.map(p => Math.abs(p.targetCash)),
                      0.001,
                    );
                    return (
                      <Fragment key={r.id}>
                        <tr className={`border-b border-gray-100 ${open ? 'bg-emerald-50' : ''}`}>
                          <td className="px-1.5 py-1 text-left font-mono text-[11px] font-semibold text-gray-700">
                            {r.ccy}
                          </td>
                          <td className={carryTd}>
                            {carryDrive === 'rate' ? (
                              <input
                                type="text"
                                inputMode="decimal"
                                value={drafts[`${r.id}.r_OD`] ?? n(r.r_OD)}
                                onChange={e => editRow(r.id, 'r_OD', e.target.value)}
                                onBlur={() => blurRow(r.id, 'r_OD')}
                                className={carryIn}
                              />
                            ) : (
                              <span className="text-gray-500">{f2(r.r_OD)}</span>
                            )}
                          </td>
                          <td className={`${carryTd} ${dclr(r.delta_r)}`}>
                            {r.delta_r > 0 ? '+' : ''}
                            {f2(r.delta_r)}%
                          </td>
                          <td className="px-1.5 py-1 text-center">
                            <CarryBadge dir={r.carryDir} />
                          </td>
                          <td className={`${carryTd} text-gray-400`}>{carryBasisLabel(r.ccy)}</td>
                          <td className={carryTd}>
                            {carryDrive === 'cash' ? (
                              <div className="flex flex-col items-stretch gap-0.5">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  placeholder={n(c.target)}
                                  value={
                                    drafts[`${r.id}.carry_target`] ??
                                    (manual ? n(r.carry_target!) : '')
                                  }
                                  onChange={e =>
                                    setDrafts(d => ({
                                      ...d,
                                      [`${r.id}.carry_target`]: e.target.value,
                                    }))
                                  }
                                  onBlur={e => commitCarryCash(r.id, e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                  title="Target LP Cash to hold (M FCY) — blank hands the leg back to z_opt"
                                  className={carryIn}
                                />
                                {reason && (
                                  <span className="text-[9px] text-amber-700" title={reqVsHeld}>
                                    holds {f2(c.target)}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className={manual ? 'font-semibold text-emerald-700' : clr(c.target)}>
                                {f2(c.target)}
                              </span>
                            )}
                          </td>
                          <td className={`${carryTd} ${clr(fcyToUsdM(c.target, r.ccy))}`}>
                            {f2(fcyToUsdM(c.target, r.ccy))}
                            {reason && (
                              <span
                                className="ml-1 rounded bg-amber-100 px-1 text-[9px] font-semibold text-amber-800"
                                title={reqVsHeld}
                              >
                                {reason}
                              </span>
                            )}
                          </td>
                          <td className={carryTd}>
                            {carryDrive === 'pnl' ? (
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder={(c.nearCarry * 1000).toFixed(0)}
                                value={
                                  drafts[`${r.id}.carry_pnl`] ??
                                  (manual ? (c.nearCarry * 1000).toFixed(0) : '')
                                }
                                onChange={e =>
                                  setDrafts(d => ({
                                    ...d,
                                    [`${r.id}.carry_pnl`]: e.target.value,
                                  }))
                                }
                                onBlur={e => commitCarryPnl(r, c.periods[0], e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                title="Carry vs USD to earn over the near period ($k) — solves back to the cash target"
                                className={`${carryIn} ${note ? 'border-amber-400 bg-amber-50' : ''}`}
                              />
                            ) : (
                              <span className={carryPnl(c.nearCarry)}>{usdK(c.nearCarry)}</span>
                            )}
                          </td>
                          <td className={`${carryTd} font-semibold ${carryPnl(c.horizonCarry)}`}>
                            {usdK(c.horizonCarry)}
                          </td>
                          <td className="px-1 py-1 text-right">
                            <button
                              type="button"
                              onClick={() => setCarryExpanded(open ? null : r.ccy)}
                              title={`${open ? 'Hide' : 'Show'} the ${carryHorizon}-month projection`}
                              className="rounded px-1 font-mono text-[10px] text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                            >
                              {open ? '▾' : '▸'}
                            </button>
                          </td>
                        </tr>
                        {note && (
                          <tr>
                            <td colSpan={10} className="px-1.5 pb-1 pt-0 text-left">
                              <span className="font-mono text-[9px] leading-snug text-amber-700">
                                {note}
                              </span>
                            </td>
                          </tr>
                        )}
                        {open && (
                          <tr>
                            <td colSpan={10} className="px-0 pb-2 pt-1">
                              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2">
                                <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <span className={toolCaption}>
                                    {r.ccy} lifecycle · {carryBasisLabel(r.ccy)}
                                  </span>
                                  {c.offBook && (
                                    <span className="font-mono text-[9px] text-amber-700">
                                      book target differs — portfolio VAR cap / USD stress trim applies
                                    </span>
                                  )}
                                </div>
                                <table className="w-full border-collapse">
                                  <thead>
                                    <tr className="border-b border-emerald-200">
                                      <th className={`${carryTh} text-left`}>Period</th>
                                      <th className={carryTh}>Days</th>
                                      <th className={carryTh}>Opening</th>
                                      <th className={carryTh}>Payout</th>
                                      <th className={carryTh}>Collect</th>
                                      <th className={carryTh}>Swap</th>
                                      <th className={carryTh} title="Target LP Cash for this cycle (M FCY)">Target</th>
                                      <th className={carryTh} title="Time-weighted balance the interest accrues on">TWA bal</th>
                                      <th className={carryTh} title="LP credit rate when long, debit rate when overdrawn">Rate</th>
                                      <th className={carryTh} title="Interest earned on the balance at the applied rate">Accrual</th>
                                      <th className={carryTh} title="Accrual net of the USD opportunity cost">vs USD</th>
                                      <th className={carryTh}>Cum</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {c.periods.map(p => (
                                      <tr
                                        key={p.monthIndex}
                                        className="border-b border-emerald-100 last:border-0"
                                      >
                                        <td className="px-1.5 py-0.5 text-left font-mono text-[10px] font-semibold text-gray-600">
                                          {p.label}
                                        </td>
                                        <td className={`${carryTd} text-gray-400`}>{p.days}</td>
                                        <td className={`${carryTd} ${clr(p.openingCash)}`}>{f2(p.openingCash)}</td>
                                        <td className={`${carryTd} ${clr(p.payout)}`}>{f2(p.payout)}</td>
                                        <td className={carryTd}>{f2(p.collections)}</td>
                                        <td className={`${carryTd} ${clr(p.swap)}`}>{fmtSwapUsd(p.swap)}</td>
                                        <td className="px-1.5 py-0.5">
                                          <div className="flex items-center justify-end gap-1.5">
                                            <DeskProgressTrack
                                              pct={Math.min(100, (Math.abs(p.targetCash) / peakTarget) * 100)}
                                              className="w-8"
                                            />
                                            <span className={`font-mono text-[10px] tabular-nums ${clr(p.targetCash)}`}>
                                              {f2(p.targetCash)}
                                            </span>
                                          </div>
                                        </td>
                                        <td className={`${carryTd} ${clr(p.twaCash)}`}>{f2(p.twaCash)}</td>
                                        <td
                                          className={`${carryTd} text-gray-500`}
                                          title={p.debitDays === undefined
                                            ? undefined
                                            : `${p.creditDays}d credit at ${f2(r.r_FCY)}%`
                                              + ` · ${p.debitDays}d overdrawn at ${f2(r.r_OD)}%`
                                              + ' — shown as the effective rate on the TWA balance'}
                                        >
                                          {f2(p.rateApplied)}%
                                          {(p.debitDays ?? 0) > 0 && (p.creditDays ?? 0) > 0 && (
                                            <span className="ml-0.5 text-[9px] text-amber-600">⇅</span>
                                          )}
                                        </td>
                                        <td className={carryTd}>{usdK(p.grossAccrualUsd)}</td>
                                        <td className={`${carryTd} ${carryPnl(p.carryVsUsd)}`}>
                                          {usdK(p.carryVsUsd)}
                                        </td>
                                        <td className={`${carryTd} font-semibold ${carryPnl(p.cumCarryVsUsd)}`}>
                                          {usdK(p.cumCarryVsUsd)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-300 bg-gray-50">
                    <td className="px-1.5 py-1 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-gray-500">
                      Total
                    </td>
                    <td colSpan={4} />
                    {/* M FCY columns never sum across currencies — only $USD does. */}
                    <td className={`${carryTd} text-gray-400`}>—</td>
                    <td className={`${carryTd} font-semibold ${clr(carryTotals.targetUsd)}`}>
                      {f2(carryTotals.targetUsd)}
                    </td>
                    <td className={`${carryTd} font-semibold ${carryPnl(carryTotals.near)}`}>
                      {usdK(carryTotals.near)}
                    </td>
                    <td className={`${carryTd} font-semibold ${carryPnl(carryTotals.horizon)}`}>
                      {usdK(carryTotals.horizon)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </LayerModal>
        )}

        {showAdvancedBook && layerPanel === 'portfolioDiv' && (
          <LayerModal
            hue="violet"
            title="Portfolio VAR · sensitivity limit"
            subtitle={`caps net notional × FX σ with cross-currency diversification — not a daily-revalued P&L VAR${
              activeLayers.has('portfolioDiv')
                ? ''
                : ' — turn the Portfolio VAR layer on to apply this limit'
            }`}
            footnote="existing LP holdings are not charged against the budget · the overlay is the deviation from hold-the-book"
            simDark={simDark}
            onClose={() => setLayerPanel(null)}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="inline-flex rounded-md border border-violet-300 bg-white p-0.5">
                {POLICY_VAR_LIMITS.map(pl => (
                  <button
                    key={pl.usd}
                    type="button"
                    onClick={() => onPolicyVARChange(pl.usd)}
                    className={`rounded px-2 py-0.5 font-mono text-[11px] font-semibold transition-colors ${
                      policyVAR === pl.usd
                        ? 'bg-violet-100 text-violet-800'
                        : 'text-violet-600 hover:text-violet-800'
                    }`}
                    title={`${pl.label} (${pl.who} approval)`}
                  >
                    {pl.label}
                  </button>
                ))}
              </div>
              <DeskStepper
                label="Policy VAR"
                value={policyVAR}
                min={0.5}
                max={25}
                step={0.5}
                onChange={onPolicyVARChange}
                formatValue={v => `$${v.toFixed(1)}M`}
                editable
                accent="violet"
                tickValues={[0.5, 5, 10, 20, 25]}
                className="min-w-[220px] flex-1"
                editClassName="w-14"
                title="Drag or type any intermediate notional sensitivity limit ($0.5M–$25M, $0.5M steps)"
                ariaLabel="Policy VAR notional sensitivity limit"
              />
            </div>

            {portfolioSummary && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px]">
              <span
                className={
                  portfolioSummary.portfolio_VAR_USD > portfolioSummary.policyVAR
                    ? 'font-semibold text-red-700'
                    : 'text-gray-500'
                }
                title="Notional sensitivity of the carry overlay (deviation from hold-the-book), measured as net notional × FX volatility σ with diversification — existing LP holdings are not charged against the sensitivity budget. Not a daily-revalued P&L VAR."
              >
                overlay sens{' '}
                <span className="font-semibold text-gray-900">
                  ${f2(portfolioSummary.portfolio_VAR_USD)}M
                </span>{' '}
                / ${f2(portfolioSummary.policyVAR)}M
              </span>
              <span
                className="text-gray-500"
                title="Incremental annual USD carry from the discretionary overlay vs hold-the-book: Σ (target − base) × spot × (r_FCY − r_USD)/100. Already embedded in Cash Carry (post-swap economic P&L) — shown here as the VAR-budget attribution, not an add-on."
              >
                overlay carry{' '}
                <span
                  className={`font-semibold ${
                    portfolioSummary.overlay_carry_USD >= 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {portfolioSummary.overlay_carry_USD >= 0 ? '+' : ''}
                  ${f2(portfolioSummary.overlay_carry_USD)}M/yr
                </span>
              </span>
              {portfolioSummary.var_binding && !portfolioSummary.budget_binding && (
                <span className="font-semibold text-green-700">✓ carry maximized</span>
              )}
              {portfolioSummary.budget_binding && (
                <span className="font-semibold text-orange-700">⚠ USD budget binding</span>
              )}
              {portfolioSummary.stress_trim && (
                <span className="font-semibold text-orange-700">⚠ USD stress trim</span>
              )}
              {portfolioSummary.var_trim && (
                <span className="font-semibold text-amber-700">⚠ overlay trimmed</span>
              )}
              {!portfolioSummary.var_binding && !portfolioSummary.budget_binding && !portfolioSummary.stress_trim
                && portfolioSummary.portfolio_VAR_USD <= portfolioSummary.policyVAR && (
                <span className="text-green-700">✓ within limit</span>
              )}
            </div>
            )}
            </div>
          </LayerModal>
        )}
      </div>

      {/* ── Band orientation rail: names the band in view, doubles as jump control ── */}
      {visibleBands.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-0.5">
          <span className={toolCaption}>In view</span>
          <span
            className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${BAND_STYLE[activeBand].chipOn}`}
          >
            {BAND_STYLE[activeBand].label}
          </span>
          <div className="flex flex-wrap gap-1">
            {visibleBands.map(id => (
              <button
                key={id}
                type="button"
                onClick={() => scrollToBand(id)}
                className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide transition-colors ${
                  activeBand === id
                    ? BAND_STYLE[id].chipOn
                    : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:text-gray-700'
                }`}
              >
                {BAND_STYLE[id].short}
              </button>
            ))}
          </div>
          <span className="ml-auto font-mono text-[9px] text-gray-400">
            {colCount > 0 ? `${colCount} columns · ` : ''}
            {visibleBands.length} bands
          </span>
        </div>
      )}

      {/* ── Main table ── */}
      <div
        ref={tableScrollRef}
        onScroll={syncActiveBand}
        className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-10rem)] rounded-lg border border-gray-200"
      >
        <FormulaGridProvider
          rowOrder={computedWithHedge.map(r => r.ccy)}
          onFill={(columnKey, rowKeys, formulaText, _sourceRowKey) => {
            const norm = formulaText.trim().replace(/^=/, '').trim();
            const def =
              SIM_FIELD_BY_KEY[columnKey as SimFieldKey]?.defaultFormula ?? '';
            // Empty / default → clear overrides so targets stay on model formula.
            const value = norm === '' || norm === def ? '' : norm;
            const updates: Record<string, string> = {};
            for (const ccy of rowKeys) updates[`${ccy}::${columnKey}`] = value;
            if (onFormulaChanges) {
              onFormulaChanges(updates);
              return;
            }
            for (const [cellKey, formula] of Object.entries(updates)) {
              onFormulaChange?.(cellKey, formula);
            }
          }}
        >
        <table className="w-max min-w-full text-xs border-collapse">
          <thead className="sticky top-0 z-30">

            {/* ── Group header row ── */}
            <tr className="border-b border-gray-200">
              <th className="sticky left-0 top-0 z-50 bg-gray-100 px-2 py-1 text-left text-xs font-bold text-gray-700 align-middle shadow-[2px_0_4px_-2px_rgba(0,0,0,0.12)]" rowSpan={2}>
                CCY
              </th>

              {ratesOn && (
              <th className={bandHeadCls('rates')} data-band="rates" colSpan={3}>
                RATES
              </th>
              )}

              {showFxPosition && (
                <th className={bandHeadCls('pos')} data-band="pos" colSpan={fxPosColSpan}>
                FX POSITION
              </th>
              )}

              {showLiquidity && (
              <th className={bandHeadCls('liq')} data-band="liq" colSpan={liquidityCols}>
                LIQUIDITY POOL BOOK
              </th>
              )}

              {showIrBook && (
                <th className={bandHeadCls('ir')} data-band="ir" colSpan={irCols}>
                  IR / FIXED-RATE BOOK
                </th>
              )}

              {showCarry && (
              <th className={bandHeadCls('buf')} data-band="buf" colSpan={3}>
                CARRY / BUFFER
              </th>
              )}

              {showSwap && (
              <th className={bandHeadCls('swap')} data-band="swap" colSpan={swapCols}>
                SWAP
              </th>
              )}

              {showFxHedge && (
              <th className={bandHeadCls('hedge')} data-band="hedge" colSpan={6}>
                FX HEDGE

                {strategy === 'SWAP_ONLY' && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800 normal-case">
                    Swap only — Residual is Net FX Forecast + Swap Near; select Swap + Fwd (± Option) to square the funded layer
                  </span>
                )}
              </th>
              )}

              {showRiskMetrics && (
                <th
                  className={bandHeadCls('risk')}
                  data-band="risk"
                  colSpan={riskMetricCols}
                  title="Per-CCY Analytics: Exp, booked hedges, residual, and VaR after booked hedges (Decision-% staging excluded)."
                >
                  <div className="flex flex-col items-center gap-0.5 normal-case tracking-normal">
                    <div>RISK METRICS</div>
                    <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-[10px] font-normal text-violet-600">
                      <span title="VaR exposure profile from Analytics setup">
                        {analyticsSetupSummary.profile}
                      </span>
                      <span className="text-violet-300">·</span>
                      <span title="Confidence level">
                        {analyticsSetupSummary.confidencePct}%
                      </span>
                      <span className="text-violet-300">·</span>
                      <span title={`σ₁ₘ source · ${analyticsSetupSummary.vol}`}>
                        σ {analyticsSetupSummary.σPct}%
                      </span>
                      <span className="text-violet-300">·</span>
                      <span title="Forecast / Exp buildup period">
                        {analyticsSetupSummary.forecastLabel}
                      </span>
                    </div>
                    {varSetup && onVarSetupChange && (
                      <span className="inline-flex flex-wrap items-center justify-center gap-0.5">
                        <span className="text-[10px] font-normal text-violet-500">
                          VaR tenure
                        </span>
                        {VAR_HORIZON_OPTIONS.map(opt => {
                          const on = varSetup.horizon === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              title={`VaR calculation horizon · ${opt.label}. Independent of forecast / Exp period.`}
                              onClick={e => {
                                e.stopPropagation();
                                setAnalysisHorizon(opt.id);
                              }}
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                                on
                                  ? 'border-violet-600 bg-violet-600 text-white'
                                  : 'border-violet-300 bg-white text-violet-700 hover:bg-violet-100'
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </span>
                    )}
                  </div>
                </th>
              )}

              {showPnl && (
              <th className={bandHeadCls('pnl')} data-band="pnl" colSpan={pnlColCount}>
                {pnlCarryOnly ? 'CARRY' : 'P&L'}
              </th>
              )}
            </tr>

            {/* ── Column name row ── */}
            <tr className="border-b-2 border-gray-300 bg-white">

              {/* RATES ×3 */}
              {ratesOn && (<>
              <th className={`${thBase} bg-gray-50 border-l-2 border-gray-300 min-w-[64px]`}>Credit Rate</th>
              <th className={`${thBase} bg-gray-50 min-w-[64px]`}>Debit Rate</th>
              <th className={`${thBase} bg-gray-50 min-w-[68px]`}>Rate Spread</th>
              </>)}

              {/* FX POSITION */}
              {showFxPosition && (<>
              <th
                className={`${thBase} bg-white border-l-2 border-gray-300 min-w-[68px]`}
                title="Cash FX book (M FCY), including booked or staged Decision-layer spot hedges"
              >
                Cash FX
              </th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Cash FX $USD</th>
              <th
                className={`${thBase} bg-white min-w-[68px]`}
                title="Outstanding forward (M FCY), including booked or staged Decision-layer forward hedges"
              >
                Fwd (FCY)
              </th>
              <th
                className={`${thBase} bg-white min-w-[68px]`}
                title="Outstanding forward settlement (M USD), including booked or staged Decision-layer forward hedges"
              >
                Fwd $USD
              </th>
              <th
                className={`${thBase} bg-white min-w-[68px]`}
                title="Booked or staged Decision-layer hedge (M FCY) — spot + forward legs. Already inside Cash FX and Fwd; broken out here so the overlay is visible. FCY settlement of the same package sizes Swap near once a buffer layer is on."
              >
                Hedge (FCY)
              </th>
              <th
                className={`${thBase} bg-white min-w-[68px]`}
                title="Booked or staged Decision-layer hedge (M USD) at spot"
              >
                Hedge $USD
              </th>
              <th className={`${thBase} bg-white min-w-[76px]`} title="Receivables — accruals/receivables/NDF assets (M FCY, positive increases exposure)">Receivables</th>
              <th className={`${thBase} bg-white min-w-[80px]`}>Receivables $USD</th>
              <th className={`${thBase} bg-white min-w-[72px]`} title="Non-cash LIABILITY FX exposure — payables/accruals (M FCY, enter negative to reduce exposure)">Liability (FCY)</th>
              <th className={`${thBase} bg-white min-w-[72px]`}>liability $USD</th>
              {simplifiedFx && (<>
              <th className={`${thBase} bg-white min-w-[68px]`} title="Debt / borrowings notional (M FCY)">Debt (FCY)</th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Debt $USD</th>
              <th className={`${thBase} bg-white min-w-[76px]`} title="Investment notional (M FCY)">Investments (FCY)</th>
              <th className={`${thBase} bg-white min-w-[76px]`}>Investments $USD</th>
              </>)}
              <th
                className={`${thBase} bg-white min-w-[68px]`}
                title="Cash FX + Fwd(FCY) + Liability + Non-cash Asset + Investments − Debt"
              >
                Net FX (FCY)
              </th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Net FX $USD</th>
              <th className={`${thBase} bg-white min-w-[76px]`} title="Current net FX book + (Revenue + Expenses + invoice fcast) × forecasting period (M FCY) — hedging basis">Net FX Forecast</th>
              <th className={`${thBase} bg-white min-w-[80px]`}>Net FX Forecast $USD</th>
              </>)}

              {/* LIQUIDITY ×9 */}
              {showLiquidity && (<>
              <th
                className={`${thBase} bg-sky-50 border-l-2 border-sky-300 min-w-[72px]`}
                title="Opening LP cash today — a balance, so the currency row and cycle M1 carry the same number"
              >
                Open Balance
              </th>
              <th className={`${thBase} bg-sky-100 min-w-[76px]`}>Open Balance $USD</th>
              <th
                className={`${thBase} bg-sky-50 min-w-[68px]`}
                title={horizonMonths
                  ? `Σ outflow over the ${horizonMonths}-cycle forecast on the currency row;`
                    + " each cycle's own outflow when expanded. Counts every operating"
                    + ' outflow line — payout, NWC, debt, investing.' + liquidityBookNote
                  : 'Payout leaving the cycle (M FCY)'}
              >
                Gross Payouts{horizonSuffix}
              </th>
              <th
                className={`${thBase} bg-sky-50 min-w-[64px]`}
                title={horizonMonths
                  ? `Σ inflow over the ${horizonMonths}-cycle forecast on the currency row;`
                    + " each cycle's own inflow when expanded. Counts every operating"
                    + ' inflow line — collections, NWC, debt draw, investing.' + liquidityBookNote
                  : 'Collections landing in the cycle (M FCY)'}
              >
                Gross Payins{horizonSuffix}
              </th>
              <th
                className={`${thBase} bg-sky-100 min-w-[80px]`}
                title={horizonMonths
                  ? `Payins − payouts inside the cycles: Σ over the ${horizonMonths}-cycle`
                    + " forecast on the currency row, each cycle's own net when expanded."
                    + ' A flow, not a balance.' + liquidityBookNote
                  : 'Payins − payouts inside one cycle — a flow, not a balance'}
              >
                Cycle Net Flow{horizonSuffix}
              </th>
              <th
                className={`${thBase} bg-sky-50 min-w-[80px]`}
                title={'Cash the cycle drains at its deepest: its opening balance − the cycle'
                  + ' low. Counts every line that settles inside the cycle, NWC, debt and'
                  + ' investing included.' + liquidityBookNote}
              >
                Cycle Drawdown
              </th>
              <th
                className={`${thBase} bg-sky-100 min-w-[76px]`}
                title={"Lowest point of the dated operating path — no funding swap in it."
                  + ' A buffer layer cannot move this number; the swap is the Swap Near column.'
                  + liquidityBookNote}
              >
                Trough Cash
              </th>
              {showNonLp && <th className={`${thBase} bg-sky-50 min-w-[72px]`}>Non-LP Cash</th>}
              <th
                className={`${thBase} bg-sky-50 min-w-[80px]`}
                title={'Where cycle 1 closes across every dated line, before the swap — the'
                  + ' same number M1 carries when the row is expanded.' + liquidityBookNote}
              >
                Close Balance
              </th>
              <th className={`${thBase} bg-sky-100 min-w-[76px]`}>Close Balance $USD</th>
              </>)}

              {/* IR / FIXED-RATE BOOK — gated per input */}
              {showBonds && (<>
              <th className={`${thBase} bg-rose-50 border-l border-rose-200 min-w-[68px]`}>Bonds (FCY)</th>
              <th className={`${thBase} bg-rose-50 min-w-[56px]`}>Bond %</th>
              </>)}
              {showInvestments && (<>
              <th className={`${thBase} bg-rose-50 border-l border-rose-200 min-w-[72px]`}>Investm. (FCY)</th>
              <th className={`${thBase} bg-rose-50 min-w-[56px]`}>Invest %</th>
              </>)}
              {showLiabilities && (<>
              <th className={`${thBase} bg-rose-50 border-l border-rose-200 min-w-[72px]`}>Liabs (FCY)</th>
              <th className={`${thBase} bg-rose-50 min-w-[56px]`}>Liab %</th>
              </>)}

              {showCarry && (<>
              {/* CARRY / BUFFER ×3 */}
              <th className={`${thBase} bg-amber-50 border-l-2 border-amber-300 min-w-[52px] text-center`}>Carry</th>
              <th className={`${thBase} bg-amber-50 min-w-[72px]`}>Target LP Cash</th>
              <th className={`${thBase} bg-amber-100 min-w-[72px]`}>Target LP Cash $USD</th>
              </>)}

              {showSwap && (<>
              {/* SWAP — the liquidity hedge: the leg that funds the trough */}
              <th className={`${thBase} bg-emerald-50 border-l-2 border-emerald-300 min-w-[64px]`}>Swap Near</th>
              <th className={`${thBase} bg-emerald-100 min-w-[64px]`}>Swap $USD</th>
              <th
                className={`${thBase} bg-emerald-50 min-w-[76px]`}
                title={horizonMonths
                  ? `Swap outstanding at the end of the ${horizonMonths}-cycle forecast — every near leg on the funded path, since the legs roll rather than run off. The column beside Swap Near is one cycle's leg; this is the book it builds.`
                  : 'Swap outstanding at the end of the forecast — the whole booked book, not one cycle'}
              >
                Swap Book{horizonSuffix}
              </th>
              <th className={`${thBase} bg-emerald-50 min-w-[68px]`}>LP+Swap</th>
              <th className={`${thBase} bg-emerald-100 min-w-[68px]`}>LP+Swap $USD</th>
              <th className={`${thBase} bg-emerald-50 min-w-[72px]`}
                title="Last close on the dated path: hedge settlement in, term cover repaid on the last date. Without a dated plan this is the near cycle (LP+Swap + flows + Non-LP sweep).">
                Cycle End
              </th>
              <th className={`${thBase} bg-emerald-100 min-w-[72px]`}>Cycle End $USD</th>
              </>)}

              {showFxHedge && (<>
              {/* FX HEDGE ×6 — notionals in $USD M; CIP / hedge carry in $k */}
              <th className={`${thBase} bg-rose-50 border-l-2 border-rose-400 min-w-[72px]`} title="Outright forward notional in $USD M (− = sell FCY fwd). Sized on Net FX Forecast + funding-swap near (hedging/funding layer).">Fwd Hedge $USD</th>
              <th className={`${thBase} bg-rose-50 min-w-[84px]`} title="SHORT option — delta-effective option hedge = δ × written notional; the written notional is matched 1:1 to the forward at all deltas, so the displayed amount = δ × Fwd Hedge $USD (δ 1 = full forward, δ 0.5 = half, δ → 0 = nothing). PAY carry: sell CALL (exercise: sell USD, buy LCY); EARN carry: sell PUT (exercise: buy USD, sell LCY). Amount in $USD M">Option Hedge $USD</th>
              <th className={`${thBase} bg-rose-50 min-w-[44px] text-center`} title="δ (0–1) scales CIP P&L. δ = 0: no CIP harvest. δ ≠ 0: CIP × δ (carry-efficient). On Swap+Fwd+Option the same δ also opens residual FX / greeks.">Δ</th>
              <th className={`${thBase} bg-rose-100 min-w-[72px]`} title="CIP P&L = funding-swap far-leg points × δ ($k/yr). Sell PAY FCY (EUR) → negative. Sweep Δ to see the carry vs residual trade-off.">CIP $k</th>
              <th className={`${thBase} bg-rose-100 min-w-[76px]`} title="Locked FX-structure carry: CIP far-leg + outright fwd points ($k). A short option is not assumed exercised — its delivery-leg carry is contingent (tooltip), not in this number.">Hedge Carry $k</th>
              <th className={`${thBase} bg-rose-100 min-w-[76px]`} title="Net FX Forecast + funding-swap near + total hedge (Fwd + δ × Option) — what stays open, in $USD M">Residual FX $USD</th>
              </>)}

              {showRiskMetrics && (<>
              <th
                className={`${thBase} bg-violet-50 border-l-2 border-violet-400 min-w-[72px]`}
                title={`Per-CCY Analytics position Exp $USD M = Net FX Forecast (${analyticsSetupSummary.forecastLabel}). Hedge-target exposure from open book + forecast — not Decision % staging.`}
              >
                Exp
              </th>
              <th
                className={`${thBase} bg-emerald-50 min-w-[72px]`}
                title="Booked spot/fwd/option hedge position only ($USD M). Potential / Decision-% hedges are excluded."
              >
                Booked H
              </th>
              <th
                className={`${thBase} bg-violet-50 min-w-[72px]`}
                title="Residual $USD M = Exp + booked hedges. Empty until trades are booked."
              >
                Residual
              </th>
              <th
                className={`${thBase} bg-violet-100 min-w-[80px]`}
                title={`VaR after booked hedges · ${analyticsSetupSummary.profile} · ${analyticsSetupSummary.confidencePct}% · σ₁ₘ ${analyticsSetupSummary.σPct}% · tenure ${varHorizonLabel}. Decision-% staging excluded.`}
              >
                VaR
              </th>
              </>)}

              {showPnl && (<>
              {/* P&L — carry columns in $k */}
              {!pnlCarryOnly && (
              <th className={`${thBase} bg-purple-50 border-l-2 border-purple-300 min-w-[76px]`}>Net Delta $USD</th>
              )}
              <th
                className={`${thBase} bg-purple-50 min-w-[76px] ${pnlCarryOnly ? 'border-l-2 border-purple-300' : ''}`}
                title="Cash interest on the Cash Carry forecast book when a strip/bullet is staged (FCY residual + USD after conversion). Expand the CCY row for the month path. Unhedged rows: first-cycle LP NIM vs USD. $k."
              >
                Cash Carry $k
              </th>
              <th
                className={`${thBase} bg-purple-50 min-w-[76px]`}
                title="Funding-swap cash Δr vs USD on the standing book (FCY O/N vs USD O/N). CIP far-leg points sit in FX HEDGE CIP / Hedge Carry, scaled by δ. $k."
              >
                Swap Carry $k
              </th>
              <th
                className={`${thBase} bg-purple-50 min-w-[76px]`}
                title="Predetermined cash impact of booked/staged forwards (Decision FWD pts). CIP and option expected delivery sit in FX HEDGE — a short option does not lock that carry."
              >
                Hedge Cash $k
              </th>
              <th
                className={`${thBase} bg-purple-100 min-w-[80px]`}
                title="Cash Carry + Swap Carry + Hedge Cash (staged FWD pts only) ($k)"
              >
                Total Carry $k
              </th>
              </>)}

            </tr>
          </thead>

          <tbody>
            {computedWithHedge.map(r => {
              const R = resolvedRows[r.ccy];
              const fv = (k: SimFieldKey) => R?.values[k] ?? NaN;
              const fErr = (k: SimFieldKey) => R?.errors[k];
              const fFormula = (k: SimFieldKey) => formulas?.[`${r.ccy}::${k}`];
              const fCommit = (k: SimFieldKey) => (text: string) => {
                const norm = text.trim().replace(/^=/, '').trim();
                const def = SIM_FIELD_BY_KEY[k].defaultFormula;
                onFormulaChange?.(`${r.ccy}::${k}`, norm === '' || norm === def ? '' : norm);
              };
              const cashCarry = pnlCashCarryUsdM(
                r.ccy,
                r.floatNim,
                stagedCashCarryByCcyUsdM,
              );
              const hedgeCarry = pnlHedgeCarryUsdM(r.ccy, stagedHedgeCarryByCcyUsdM);
              const fxHedgeCarry = R?.hedgeCarryUsdYr ?? r.hedgeCarryUsdYr;
              const swapCarry = pnlSwapCarryUsdM(r, shared.r_USD);
              const pnlTotalCarry = cashCarry + swapCarry + hedgeCarry;
              const residual = R?.residualFx ?? r.residualFx;
              const planOpen = liqPlanCcy === r.ccy;
              const liqCycles = r.liquidityCycles;
              const flows = horizonMonths ? horizonFlows(liqCycles) : null;
              /** Swap outstanding once every leg on the funded path is on. */
              const plan = r.liquidityPlan;
              const swapBook = plan?.length ? plan[plan.length - 1]!.standing_swap : null;
              return (
              <Fragment key={r.id}>
              <tr
                className={`border-b border-gray-100 hover:bg-gray-50${
                  showLiquidity ? ' cursor-pointer' : ''
                }`}
                aria-expanded={showLiquidity ? planOpen : undefined}
                onClick={
                  showLiquidity
                    ? e => {
                        if (!isLiquidityRowToggleTarget(e.target)) return;
                        setLiqPlanCcy(planOpen ? null : r.ccy);
                      }
                    : undefined
                }
              >

                {/* CCY */}
                <td className="sticky left-0 z-20 bg-white hover:bg-gray-50 px-1.5 py-0.5 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]">
                  <div className="flex items-center gap-0.5">
                    {showLiquidity && (
                      <button
                        type="button"
                        onClick={() => setLiqPlanCcy(planOpen ? null : r.ccy)}
                        title={`${planOpen ? 'Hide' : 'Show'} the ${r.ccy} cash path cycle by cycle over the forecast`}
                        aria-label={`${planOpen ? 'Hide' : 'Show'} the ${r.ccy} cash path`}
                        className="rounded px-0.5 font-mono text-[10px] text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                      >
                        {planOpen ? '▾' : '▸'}
                      </button>
                    )}
                    <CellInput
                      type="text" value={r.ccy} maxLength={6}
                      onChange={e => editCcy(r.id, e.target.value)}
                      locked={lockValues}
                      className="w-[46px] text-left text-xs font-bold text-gray-900 border-0 bg-transparent focus:bg-white focus:ring-1 focus:ring-blue-400 rounded px-0.5 outline-none uppercase"
                    />
                  </div>
                </td>

                {/* RATES */}
                {ratesOn && (<>
                <td className={`${tdBase} bg-gray-50 border-l-2 border-gray-300`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.r_FCY`] ?? n(r.r_FCY)}
                    onChange={e => editRow(r.id, 'r_FCY', e.target.value)}
                    onBlur={() => blurRow(r.id, 'r_FCY')}
                    locked={lockValues} className={`${inBase} w-[52px]`} />
                </td>
                <td className={`${tdBase} bg-gray-50`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.r_OD`] ?? n(r.r_OD)}
                    onChange={e => editRow(r.id, 'r_OD', e.target.value)}
                    onBlur={() => blurRow(r.id, 'r_OD')}
                    locked={lockValues} className={`${inBase} w-[52px]`} />
                </td>
                <td className={`${tdBase} bg-gray-50 font-medium ${dclr(r.delta_r)}`}>
                  {r.delta_r > 0 ? '+' : ''}{f2(r.delta_r)}%
                </td>
                </>)}

                {/* FX POSITION — spot/fwd/non-cash in FCY + USD */}
                {showFxPosition && (<>
                <td className={`${tdBase} bg-white border-l-2 border-gray-300`}>
                  <CellInput
                    type="text"
                    inputMode="decimal"
                    value={drafts[`${r.id}.spot`] ?? n(r.spot)}
                    onChange={e => editRow(r.id, 'spot', e.target.value, r.ccy)}
                    onBlur={() => blurRow(r.id, 'spot')}
                    title={
                      Math.abs(offsetFor(r.ccy).spotLocalM) > 1e-9
                        ? `Includes booked/staged spot hedge ${offsetFor(r.ccy).spotLocalM.toFixed(2)} M`
                        : undefined
                    }
                    locked={lockValues} className={`${inBase} w-[62px] ${r.spot < 0 ? 'text-red-600' : ''}`}
                  />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.spotUsd`] ?? n(r.fxSpotUSD)}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'spot', 'spotUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'spotUsd')}
                      locked={lockValues} className={`${inBase} w-[62px] font-medium ${r.fxSpotUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxSpotUSD)}`}>{f2(r.fxSpotUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  <CellInput
                    type="text"
                    inputMode="decimal"
                    value={drafts[`${r.id}.fwdFcy`] ?? n(r.fxFwdFCY)}
                    onChange={e => editFwdFcy(r.id, r.ccy, e.target.value)}
                    onBlur={() => blurRow(r.id, 'fwdFcy')}
                    title={
                      Math.abs(offsetFor(r.ccy).fwdLocalM) > 1e-9
                        ? `Includes booked/staged forward ${offsetFor(r.ccy).fwdLocalM.toFixed(2)} M FCY`
                        : undefined
                    }
                    locked={lockValues} className={`${inBase} w-[62px] font-medium ${r.fxFwdFCY < 0 ? 'text-red-600' : ''}`}
                  />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <CellInput
                    type="text"
                    inputMode="decimal"
                    value={drafts[`${r.id}.fwd`] ?? n(r.fwd)}
                    onChange={e => editRow(r.id, 'fwd', e.target.value, r.ccy)}
                    onBlur={() => blurRow(r.id, 'fwd')}
                    title={
                      Math.abs(offsetFor(r.ccy).fwdLocalM) > 1e-9
                        ? `Includes booked/staged forward ${fcyToUsdM(offsetFor(r.ccy).fwdLocalM, r.ccy).toFixed(2)} M USD`
                        : undefined
                    }
                    locked={lockValues} className={`${inBase} w-[62px] ${r.fwd < 0 ? 'text-red-600' : ''}`}
                  />
                </td>
                <td className={`${tdBase} bg-white`} title={hedgeCellTitle(r.ccy)}>
                  <span className={`font-medium ${clr(hedgeFcyFor(r.ccy))}`}>
                    {fmtHedgeCell(hedgeFcyFor(r.ccy))}
                  </span>
                </td>
                <td className={`${tdBase} bg-white`} title={hedgeCellTitle(r.ccy)}>
                  <span className={`font-medium ${clr(fcyToUsdM(hedgeFcyFor(r.ccy), r.ccy))}`}>
                    {fmtHedgeCell(fcyToUsdM(hedgeFcyFor(r.ccy), r.ccy))}
                  </span>
                </td>
                <td className={`${tdBase} bg-white`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashAsset`] ?? n((r.nonCashAsset ?? 0))}
                    onChange={e => editRow(r.id, 'nonCashAsset', e.target.value)}
                    onBlur={() => blurRow(r.id, 'nonCashAsset')}
                    locked={lockValues} className={`${inBase} w-[58px] ${(r.nonCashAsset ?? 0) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashAssetUsd`] ?? n(r.fxNonCashAssetUSD)}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'nonCashAsset', 'nonCashAssetUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'nonCashAssetUsd')}
                      locked={lockValues} className={`${inBase} w-[62px] font-medium ${r.fxNonCashAssetUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxNonCashAssetUSD)}`}>{f2(r.fxNonCashAssetUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.nonCash`] ?? n(r.nonCash)}
                    onChange={e => editRow(r.id, 'nonCash', e.target.value)}
                    onBlur={() => blurRow(r.id, 'nonCash')}
                    locked={lockValues} className={`${inBase} w-[58px] ${r.nonCash < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashUsd`] ?? n(r.fxNonCashUSD)}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'nonCash', 'nonCashUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'nonCashUsd')}
                      locked={lockValues} className={`${inBase} w-[62px] font-medium ${r.fxNonCashUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxNonCashUSD)}`}>{f2(r.fxNonCashUSD)}</span>
                  )}
                </td>
                {simplifiedFx && (<>
                <td className={`${tdBase} bg-white`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_notional`] ?? n(r.ir_liab_notional)}
                    onChange={e => editRow(r.id, 'ir_liab_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_notional')}
                    locked={lockValues} className={`${inBase} w-[58px] ${r.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <CellInput type="text" inputMode="decimal"
                    value={drafts[`${r.id}.debtUsd`] ?? n(fcyToUsdM(r.ir_liab_notional, r.ccy))}
                    onChange={e => editFcyViaUsd(r.id, r.ccy, 'ir_liab_notional', 'debtUsd', e.target.value)}
                    onBlur={() => blurRow(r.id, 'debtUsd')}
                    locked={lockValues} className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.ir_liab_notional, r.ccy) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_notional`] ?? n((r.ir_invest_notional ?? 0))}
                    onChange={e => editRow(r.id, 'ir_invest_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_notional')}
                    locked={lockValues} className={`${inBase} w-[58px] ${(r.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <CellInput type="text" inputMode="decimal"
                    value={drafts[`${r.id}.investUsd`] ?? n(fcyToUsdM(r.ir_invest_notional ?? 0, r.ccy))}
                    onChange={e => editFcyViaUsd(r.id, r.ccy, 'ir_invest_notional', 'investUsd', e.target.value)}
                    onBlur={() => blurRow(r.id, 'investUsd')}
                    locked={lockValues} className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.ir_invest_notional ?? 0, r.ccy) < 0 ? 'text-red-600' : ''}`} />
                </td>
                </>)}
                <td
                  className={`${tdBase} bg-white`}
                  title={[
                    `Cash FX ${f2(r.spot)}`,
                    `+ Fwd ${f2(r.fxFwdFCY)}`,
                    `+ Liability ${f2(r.nonCash)}`,
                    `+ Receivables ${f2(r.nonCashAsset ?? 0)}`,
                    `+ Investments ${f2(r.ir_invest_notional ?? 0)}`,
                    `− Debt ${f2(r.ir_liab_notional)}`,
                    `= Net FX ${f2(r.netFxFCY)}`,
                    Math.abs(offsetFor(r.ccy).spotLocalM) > 1e-9
                      || Math.abs(offsetFor(r.ccy).fwdLocalM) > 1e-9
                      ? `(Cash/Fwd include booked/staged hedges: spot ${f2(offsetFor(r.ccy).spotLocalM)}, fwd ${f2(offsetFor(r.ccy).fwdLocalM)})`
                      : '',
                  ].filter(Boolean).join(' ')}
                >
                  {simplifiedFx ? (
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.netFxFCY`] ?? n(r.netFxFCY)}
                      onChange={e => editNetFxFcy(r.id, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxFCY')}
                      locked={lockValues} className={`${inBase} w-[62px] font-medium ${r.netFxFCY < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.netFxFCY)}`}>{f2(r.netFxFCY)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.netFxUSD`] ?? n(r.netFxUSD)}
                      onChange={e => editNetFxUsd(r.id, r.ccy, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxUSD')}
                      locked={lockValues} className={`${inBase} w-[62px] font-medium ${r.netFxUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.netFxUSD)}`}>{f2(r.netFxUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}
                  title={
                    forecastProfile.mode === 'custom'
                      ? `Net FX (${f2(r.netFxFCY)}) + FX-changing period Σ (${f2(periodFxFlowSumLocalM(r, forecastMonths, forecastProfile))}) = ${f2(r.netFxForecast)} M FCY`
                      : `Net FX (${f2(r.netFxFCY)}) + (Rev ${f2(r.collections)} + Exp ${f2(r.payout)} + Fcast ${f2(r.fcastFX)}) × ${forecastMonths} = ${f2(r.netFxForecast)} M FCY`
                  }>
                  {simplifiedFx ? (
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.netFxForecast`] ?? n(r.netFxForecast)}
                      onChange={e => editNetFxForecast(r.id, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxForecast')}
                      locked={lockValues} className={`${inBase} w-[62px] font-medium ${r.netFxForecast < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${Math.abs(r.netFxForecast) < 0.005 ? 'text-gray-300' : clr(r.netFxForecast)}`}>
                  {Math.abs(r.netFxForecast) < 0.005 ? '—' : f2(r.netFxForecast)}
                    </span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <CellInput type="text" inputMode="decimal"
                      value={drafts[`${r.id}.netFxForecastUSD`] ?? n(fcyToUsdM(r.netFxForecast, r.ccy))}
                      onChange={e => editNetFxForecastUsd(r.id, r.ccy, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxForecastUSD')}
                      locked={lockValues} className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.netFxForecast, r.ccy) < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(fcyToUsdM(r.netFxForecast, r.ccy))}`}>
                      {f2(fcyToUsdM(r.netFxForecast, r.ccy))}
                    </span>
                  )}
                </td>
                </>)}

                {/* LIQUIDITY */}
                {showLiquidity && (<>
                <td className={`${tdBase} bg-sky-50 border-l-2 border-sky-300`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.cash`] ?? n(r.cash)}
                    onChange={e => editRow(r.id, 'cash', e.target.value)}
                    onBlur={() => blurRow(r.id, 'cash')}
                    locked={lockValues} className={`${inBase} w-[58px] ${r.cash < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-sky-100 font-medium ${clr(swapNearUsd(r.ccy, r.cash))}`}
                  title={`${f2(r.cash)} M FCY × spot ${(CURRENCY_PARAMS[r.ccy]?.spot ?? 1).toFixed(4)}`}>
                  {f2(swapNearUsd(r.ccy, r.cash))}
                </td>
                <td className={`${tdBase} bg-sky-50 ${
                  !flows ? '' : flows.outflow > 0.001 ? 'text-red-600' : 'text-gray-300'
                }`}
                  title={flows
                    ? `Σ ${flows.months} cycles · payout ${f2(r.payout)} a cycle plus every other`
                      + ' outflow line that settles inside the cycles'
                    : undefined}>
                  {flows ? (flows.outflow > 0.001 ? f2(-flows.outflow) : '—') : (
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.payout`] ?? n(r.payout)}
                      onChange={e => editRow(r.id, 'payout', e.target.value)}
                      onBlur={() => blurRow(r.id, 'payout')}
                      locked={lockValues} className={`${inBase} w-[62px] ${r.payout < 0 ? 'text-red-600' : ''}`} />
                  )}
                </td>
                <td className={`${tdBase} bg-sky-50 ${
                  !flows ? '' : flows.inflow > 0.001 ? 'text-green-700' : 'text-gray-300'
                }`}
                  title={flows
                    ? `Σ ${flows.months} cycles · collections ${f2(r.collections)} a cycle plus every other`
                      + ' inflow line that settles inside the cycles'
                    : undefined}>
                  {flows ? (flows.inflow > 0.001 ? f2(flows.inflow) : '—') : (
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.collections`] ?? n(r.collections)}
                      onChange={e => editRow(r.id, 'collections', e.target.value)}
                      onBlur={() => blurRow(r.id, 'collections')}
                      locked={lockValues} className={`${inBase} w-[58px]`} />
                  )}
                </td>
                {(() => {
                  const cycleNet = flows
                    ? flows.inflow - flows.outflow
                    : (r.liquidityCycles?.[0]?.net ?? (r.payout + r.collections));
                  return (
                  <td className={`${tdBase} bg-sky-100 font-medium ${clr(cycleNet)}`}
                    title={flows
                      ? `Σ ${flows.months} cycles · payins ${f2(flows.inflow)} − payouts ${f2(flows.outflow)}`
                        + ' — what the book earns or drains over the horizon, before any funding'
                      : 'Cycle Net Flow — payins − payouts inside the cycle'}>
                    {f2(cycleNet)}
                  </td>
                  );
                })()}
                {(() => {
                  const drawdown = r.cycleDrawdown;
                  const cycle = r.troughCycleIndex ?? 0;
                  const low = r.lp_peak_cash;
                  return (
                    <td
                      className={`${tdBase} bg-sky-50 font-medium ${
                        (drawdown ?? 0) > 0 ? 'text-red-600' : 'text-gray-400'
                      }`}
                      title={
                        drawdown === undefined
                          ? undefined
                          : cycle === 0
                            ? `${f2(r.cash)} opening − ${f2(low)} low`
                              + ` = ${f2(drawdown)} drained inside the cycle`
                            : `Cycle M${cycle + 1} drains ${f2(drawdown)} from its own opening`
                              + ' — the deepest cycle in the horizon'
                      }
                    >
                      {drawdown === undefined ? '—' : f2(drawdown)}
                    </td>
                  );
                })()}
                {(() => {
                  const troughDay = r.troughDay;
                  const below = r.daysBelowFloor ?? 0;
                  const trough = r.lp_peak_cash;
                  return (
                    <td
                      className={`${tdBase} bg-sky-100 font-semibold ${
                        trough >= r.cash_threshold ? 'text-green-700'
                        : trough >= 0 ? 'text-amber-700' : 'text-red-600'}`}
                      title={troughCellTitle(r) + liquidityBookNote}
                    >
                      {troughDay === undefined ? f2(trough) : (
                        <span className="inline-flex items-baseline gap-1">
                          {f2(trough)}
                          <span className={`font-mono text-[9px] font-medium ${
                            below > 0 ? 'text-red-600' : 'text-gray-400'
                          }`}>
                            D{troughDay + 1}
                            {below > 0 ? '⚠' : ''}
                          </span>
                        </span>
                      )}
                    </td>
                  );
                })()}
                {showNonLp && (
                  <td className={`${tdBase} bg-sky-50`}>
                    <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.nonLpCash`] ?? n(r.nonLpCash)}
                      onChange={e => editRow(r.id, 'nonLpCash', e.target.value)}
                      onBlur={() => blurRow(r.id, 'nonLpCash')}
                      locked={lockValues} className={`${inBase} w-[58px] ${r.nonLpCash < 0 ? 'text-red-600' : ''}`} />
                  </td>
                )}
                <td
                  className={`${tdBase} bg-sky-50 font-medium ${clr(r.cash_after_payins)}`}
                  title={`Close Balance — where cycle 1 lands before its swap: ${f2(r.cash)} opening`
                    + ` ${r.cash_after_payins - r.cash >= 0 ? '+' : '−'}`
                    + ` ${f2(Math.abs(r.cash_after_payins - r.cash))}`
                    + ' of dated flow' + liquidityBookNote}
                >
                  {f2(r.cash_after_payins)}
                </td>
                <td
                  className={`${tdBase} bg-sky-100 font-medium ${clr(swapNearUsd(r.ccy, r.cash_after_payins))}`}
                  title="Close Balance $USD"
                >
                  {f2(swapNearUsd(r.ccy, r.cash_after_payins))}
                </td>
                </>)}

                {/* IR / FIXED-RATE BOOK */}
                {showBonds && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.ir_asset_notional`] ?? n(r.ir_asset_notional)}
                    onChange={e => editRow(r.id, 'ir_asset_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_asset_notional')}
                    locked={lockValues} className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.ir_asset_rate`] ?? n(r.ir_asset_rate)}
                    onChange={e => editRow(r.id, 'ir_asset_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_asset_rate')}
                    locked={lockValues} className={`${inBase} w-[46px]`} />
                </td>
                </>)}
                {showInvestments && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_notional`] ?? n((r.ir_invest_notional ?? 0))}
                    onChange={e => editRow(r.id, 'ir_invest_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_notional')}
                    locked={lockValues} className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_rate`] ?? n((r.ir_invest_rate ?? 0))}
                    onChange={e => editRow(r.id, 'ir_invest_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_rate')}
                    locked={lockValues} className={`${inBase} w-[46px]`} />
                </td>
                </>)}
                {showLiabilities && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_notional`] ?? n(r.ir_liab_notional)}
                    onChange={e => editRow(r.id, 'ir_liab_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_notional')}
                    locked={lockValues} className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <CellInput type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_rate`] ?? n(r.ir_liab_rate)}
                    onChange={e => editRow(r.id, 'ir_liab_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_rate')}
                    locked={lockValues} className={`${inBase} w-[46px]`} />
                </td>
                </>)}

{showCarry && (<>
                {/* CARRY / BUFFER */}
                <td className={`${tdBase} bg-amber-50 border-l-2 border-amber-300 text-center`}>
                  <CarryBadge dir={r.carryDir} />
                </td>
                <FormulaCell
                  tdClass={`${tdBase} bg-amber-50 font-semibold text-amber-900`}
                  display={<>{f2(fv('targetLpCash'))}{r.funding_binding && <span className="ml-0.5 text-xs text-red-600" title="USD funding bind — target trimmed">⛓</span>}</>}
                  formula={fFormula('targetLpCash')} defaultFormula={SIM_FIELD_BY_KEY.targetLpCash.defaultFormula}
                  onCommit={fCommit('targetLpCash')} error={fErr('targetLpCash')} title="Target LP Cash — layer / carry-target H* (not Opening + today's M1 swap)"
                  columnKey="targetLpCash" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-amber-100 font-semibold ${clr(fv('targetLpCashUSD'))}`}
                  display={<>{fmtThresholdUsd(fv('targetLpCashUSD'))}{r.debit_floor_binding && <span className="ml-0.5 text-xs text-amber-600" title="Expensive OD floor">⌊</span>}</>}
                  formula={fFormula('targetLpCashUSD')} defaultFormula={SIM_FIELD_BY_KEY.targetLpCashUSD.defaultFormula}
                  onCommit={fCommit('targetLpCashUSD')} error={fErr('targetLpCashUSD')} title="Target LP Cash $USD"
                  columnKey="targetLpCashUSD" rowKey={r.ccy} />
</>)}

                {showSwap && (<>
                {/* SWAP — model-sized from the buffer layer; not a formula override */}
                <td
                  className={`${tdBase} bg-emerald-50 border-l-2 border-emerald-300 font-semibold ${clr(r.swapNear)}`}
                  title={swapCellTitle(r)}
                >
                  {f2(r.swapNear)}
                </td>
                <td
                  className={`${tdBase} bg-emerald-100 font-semibold ${clr(swapNearUsd(r.ccy, r.swapNear))}`}
                  title="Swap $USD"
                >
                  {fmtSwapUsd(swapNearUsd(r.ccy, r.swapNear))}
                </td>
                <td className={`${tdBase} bg-emerald-50 font-semibold ${
                  swapBook === null ? 'text-gray-300' : clr(swapBook)
                }`}
                  title={swapBook === null
                    ? 'No dated path — turn on the liquidity forecast to see the swap book the cycles build'
                    : `${f2(swapBook)} outstanding after ${r.liquidityPlan!.length} cycles`
                      + ` · this cycle's leg ${f2(r.swapNear)}`}>
                  {swapBook === null ? '—'
                    : Math.abs(swapBook) > 0.001 ? f2(swapBook) : '—'}
                </td>
                <td
                  className={`${tdBase} bg-emerald-50 font-medium ${clr(r.postSwapCash)}`}
                  title="LP+Swap = Opening LP + Swap"
                >
                  {f2(r.postSwapCash)}
                </td>
                <td
                  className={`${tdBase} bg-emerald-100 font-medium ${clr(r.postSwapUSD)}`}
                  title="LP+Swap $USD"
                >
                  {fmtSwapUsd(r.postSwapUSD)}
                </td>
                <td
                  className={`${tdBase} bg-emerald-50 font-medium ${clr(r.cycleEndCash)}`}
                  title="Cycle End — last close after hedge settlement and the term far-leg repayment"
                >
                  {f2(r.cycleEndCash)}
                </td>
                <td
                  className={`${tdBase} bg-emerald-100 font-medium ${clr(swapNearUsd(r.ccy, r.cycleEndCash))}`}
                  title="Cycle End $USD"
                >
                  {fmtSwapUsd(swapNearUsd(r.ccy, r.cycleEndCash))}
                </td>
                </>)}

                {showFxHedge && (<>
                {/* FX HEDGE — strategy-driven fwd / option legs (editable) */}
                <FormulaCell
                  tdClass={`${tdBase} bg-rose-50 border-l-2 border-rose-400 font-semibold ${
                    Math.abs(fv('fwdHedgeUSD')) < 0.005 ? 'text-gray-300' : fv('fwdHedgeUSD') < 0 ? 'text-red-600' : 'text-green-700'}`}
                  display={Math.abs(fv('fwdHedgeUSD')) < 0.005 ? '—' : f2(fv('fwdHedgeUSD'))}
                  formula={fFormula('fwdHedgeUSD')} defaultFormula={SIM_FIELD_BY_KEY.fwdHedgeUSD.defaultFormula}
                  onCommit={fCommit('fwdHedgeUSD')} error={fErr('fwdHedgeUSD')}
                  title="Fwd Hedge $USD — squares Net FX Forecast + Swap Near"
                  columnKey="fwdHedgeUSD" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-rose-50 font-semibold ${
                    Math.abs(fv('optionHedgeUSD')) < 0.005 ? 'text-gray-300' : fv('optionHedgeUSD') < 0 ? 'text-red-600' : 'text-green-700'}`}
                  display={Math.abs(fv('optionHedgeUSD')) < 0.005 ? '—' : (
                    <>
                      {r.optType && (
                      <span className={`mr-1 rounded px-1 text-[10px] font-bold ${r.optType === 'SELL_CALL' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}`}>
                        {r.optType === 'SELL_CALL' ? 'sC' : 'sP'}
                      </span>
                      )}
                      {f2(fv('optionHedgeUSD'))}
                    </>
                  )}
                  formula={fFormula('optionHedgeUSD')} defaultFormula={SIM_FIELD_BY_KEY.optionHedgeUSD.defaultFormula}
                  onCommit={fCommit('optionHedgeUSD')} error={fErr('optionHedgeUSD')}
                  title="Option Hedge $USD — δ × option notional × spot"
                  columnKey="optionHedgeUSD" rowKey={r.ccy} />
                <td className={`${tdBase} bg-rose-50 text-center`}
                  title="δ (0–1) scales CIP P&L in this band. δ = 0 → no CIP harvest. δ ≠ 0 → CIP × δ (carry-efficient) and, on Swap+Fwd+Option, residual FX / greeks open.">
                    <CellInput
                      type="text" inputMode="decimal"
                    value={drafts[`${r.id}.hedgeDelta`] ?? n((hedgeDeltas[r.id] ?? 0.5))}
                      onChange={e => {
                        setDrafts(prev => ({ ...prev, [`${r.id}.hedgeDelta`]: e.target.value }));
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v >= 0 && v <= 1) setHedgeDeltas(prev => ({ ...prev, [r.id]: v }));
                      }}
                      onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next[`${r.id}.hedgeDelta`]; return next; })}
                    locked={lockValues} className={`${inBase} w-[36px] font-medium text-rose-700`}
                    />
                </td>
                <td
                  className={`${tdBase} bg-rose-100 font-semibold ${carryTone(r.cipCarryUsdYr)}`}
                  title={`CIP P&L = far-leg points × δ ${n((hedgeDeltas[r.id] ?? 0.5))}. Standing ${f2(swapFarLegNotional(r.liquidityPlan, r.swapNear))} M ${r.ccy}. Sell PAY FCY (EUR) → negative. ${usdCarry(r.cipCarryUsdYr)}.`}
                >
                  {usdCarry(r.cipCarryUsdYr)}
                </td>
                <td className={`${tdBase} bg-rose-100 font-medium ${carryTone(fxHedgeCarry)}`}
                  title={`Locked structure: fwd points ${usdCarry(r.fwdCarryUsdYr)} + CIP ${usdCarry(r.cipCarryUsdYr)} = ${usdCarry(fxHedgeCarry)}. Option delivery ${usdCarry(r.optCarryUsdYr)} is contingent (strike may not print) — not in this number. Gross premium ${usdCarry(r.optPremiumUsdYr)} is tooltip-only.`}>
                  {usdCarry(fxHedgeCarry)}
                </td>
                <td className={`${tdBase} bg-rose-100 font-medium ${
                  Math.abs(residual) < 0.005 ? 'text-green-700' : clr(residual)
                }`}
                  title={`Net FX Forecast (${f2(r.netFxForecast)}) + Swap Near (${f2(r.swapNear)}) + hedge legs = ${f2(residual)} M ${r.ccy} unhedged × spot = $${f2(swapNearUsd(r.ccy, residual))} USD M`}>
                  {Math.abs(residual) < 0.005 ? '✓ 0.00' : f2(swapNearUsd(r.ccy, residual))}
                </td>
</>)}

                {showRiskMetrics && (() => {
                  const rm = riskMetricsByCcy[r.ccy];
                  const expUsd = fcyToUsdM(rm?.exposureLocalM ?? 0, r.ccy);
                  const fwdUsd = fcyToUsdM(rm?.forwardHedgeLocalM ?? 0, r.ccy);
                  const residUsd = fcyToUsdM(rm?.residualLocalM ?? rm?.exposureLocalM ?? 0, r.ccy);
                  const varAfter = rm?.varUsdM ?? 0;
                  const fmtUsdM = (n: number) => `${n >= 0 ? '+' : '−'}$${f2(Math.abs(n))}`;
                  return (
                    <>
                      <td
                        className={`${tdBase} bg-violet-50 border-l-2 border-violet-400 font-mono ${
                          expUsd >= 0 ? 'text-emerald-700' : 'text-rose-600'
                        }`}
                        title={`Analytics position Exp $USD M · ${analyticsSetupSummary.forecastLabel} · ${analyticsSetupSummary.profile}`}
                      >
                        {fmtUsdM(expUsd)}
                      </td>
                      <td
                        className={`${tdBase} bg-emerald-50 font-mono ${
                          Math.abs(fwdUsd) < 1e-9
                            ? 'text-gray-300'
                            : fwdUsd >= 0
                              ? 'text-emerald-700'
                              : 'text-rose-600'
                        }`}
                        title="Booked hedge only $USD M — Decision % staging excluded"
                      >
                        {Math.abs(fwdUsd) < 1e-9 ? '—' : fmtUsdM(fwdUsd)}
                      </td>
                      <td
                        className={`${tdBase} bg-violet-50 font-mono ${
                          Math.abs(residUsd) < 1e-9
                            ? 'text-emerald-700'
                            : residUsd >= 0
                              ? 'text-emerald-700'
                              : 'text-rose-600'
                        }`}
                        title="Residual $USD M = Exp + booked hedges"
                      >
                        {Math.abs(residUsd) < 1e-9 ? '✓ $0.00' : fmtUsdM(residUsd)}
                      </td>
                      <td
                        className={`${tdBase} bg-violet-100 font-semibold font-mono text-violet-900`}
                        title={`VaR after booked hedges · ${analyticsSetupSummary.profile} · ${analyticsSetupSummary.confidencePct}% · σ ${analyticsSetupSummary.σPct}% · ${varHorizonLabel}`}
                      >
                        ${(varAfter * 1000).toFixed(0)}K
                      </td>
                    </>
                  );
                })()}

                {showPnl && (<>
                {/* P&L — carry in $k */}
                {!pnlCarryOnly && (
                <td className={`${tdBase} bg-purple-50 border-l-2 border-purple-300 font-semibold ${clr(swapNearUsd(r.ccy, r.netDelta))}`}
                  title={`Net FX delta ${f2(r.netDelta)} M ${r.ccy} × spot ${(CURRENCY_PARAMS[r.ccy]?.spot ?? 1).toFixed(4)} = $${f2(swapNearUsd(r.ccy, r.netDelta))} USD M`}>
                  ${f2(swapNearUsd(r.ccy, r.netDelta))}
                </td>
                )}
                <td className={`${tdBase} bg-purple-50 font-medium ${pnlCarryOnly ? 'border-l-2 border-purple-300' : ''} ${carryTone(cashCarry)}`}
                  title={
                    stagedCashCarryByCcyUsdM[r.ccy] !== undefined
                      ? `Cash Carry forecast dual-book interest for ${r.ccy} (FCY residual + USD after strip/bullet conversion) — same $k as Cash Carry table Total − FWD pts`
                      : `Unfunded cash carry (no funding swap): opening LP ${f2(r.cash)}M ${r.ccy} path × spot × (r_actual − r_USD ${shared.r_USD.toFixed(2)}%) / 100 = ${usdCarry(r.floatNim)}.`
                  }>
                  {usdCarry(cashCarry)}
                </td>
                <td className={`${tdBase} bg-purple-50 font-medium ${carryTone(swapCarry)}`}
                  title={`Cash Δr vs USD on the standing swap (no CIP points). Path Σ of monthly. ${usdCarry(swapCarry)}.`}>
                  {usdCarry(swapCarry)}
                </td>
                <td
                  className={`${tdBase} bg-purple-50 font-medium ${carryTone(hedgeCarry)}`}
                  title={
                    stagedHedgeCarryByCcyUsdM[r.ccy] !== undefined
                      ? `Predetermined cash impact of staged/booked forwards for ${r.ccy} — Decision FWD pts. CIP and option expected delivery are in FX HEDGE.`
                      : 'No staged forward — predetermined hedge cash is 0. FX structure carry (CIP + locked fwd) is in FX HEDGE.'
                  }
                >
                  {usdCarry(hedgeCarry)}
                </td>
                <td
                  className={`${tdBase} bg-purple-100 font-semibold ${
                    Math.abs(pnlTotalCarry) < 5e-8
                      ? 'text-gray-300'
                      : pnlTotalCarry >= 0 ? 'text-emerald-700' : 'text-red-600'
                  }`}
                  title="Cash Carry + Swap Carry + Hedge Cash (staged FWD pts only)"
                >
                  {usdCarry(pnlTotalCarry)}
                </td>
                </>)}
              </tr>
              {planOpen && !r.liquidityPlan && (
                <tr className="border-b border-gray-100">
                  <td colSpan={gridCols} className="px-2 py-1 text-left font-mono text-[10px] text-amber-700">
                    No dated path for {r.ccy} — turn on “Drive trough from timing”
                    in the Liquidity view of the Forecast profile.
                  </td>
                </tr>
              )}
              {planOpen && r.liquidityPlan?.map(p => {
                const shape = liqCycles?.[p.cycleIndex];
                const book = liquidityBookCycle(p, shape);
                const binds = p.cycleIndex === (r.sizingCycleIndex ?? r.troughCycleIndex ?? 0);
                const cycleHedge = p.hedgeSettle ?? 0;
                const cycleCip = fundingSwapCipPointsUsdYr(
                  p.standing_swap,
                  CURRENCY_PARAMS[r.ccy]?.spot ?? 1,
                  r.r_FCY,
                  shared.r_USD,
                ) / 12 * (hedgeDeltas[r.id] ?? 0.5);
                return (
                  <tr key={`${r.id}·M${p.cycleIndex + 1}`} className="border-b border-gray-100">
                    <td className="sticky left-0 z-20 bg-white px-1.5 py-0.5 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]">
                      <span className="pl-3 font-mono text-[10px] text-gray-500">
                        M{p.cycleIndex + 1}
                      </span>
                      {binds && (
                        <span
                          className="ml-1 font-mono text-[9px] text-sky-700"
                          title="The cycle H* and the swap size against"
                        >
                          H*
                        </span>
                      )}
                    </td>

                    {ratesOn && <td colSpan={3} className="bg-gray-50 border-l-2 border-gray-300" />}
                    {showFxPosition && (
                      <td colSpan={fxPosColSpan} className="bg-white border-l-2 border-gray-300" />
                    )}

                    {showLiquidity && (<>
                    <td className={`${cycleTd} bg-sky-50 border-l-2 border-sky-300`}
                      title={(p.cycleIndex === 0
                        ? "Cash on hand today — the currency row's own opening balance"
                        : `Where M${p.cycleIndex} closed on the operating path — no funding swap in it`)
                        + liquidityBookNote}>
                      {f2(book.opening)}
                    </td>
                    <td className={`${cycleTd} bg-sky-100`}>
                      {f2(swapNearUsd(r.ccy, book.opening))}
                    </td>
                    <td className={`${cycleTd} bg-sky-50 ${(shape?.outflow ?? 0) > 0 ? 'text-red-600' : 'text-gray-300'}`}>
                      {(shape?.outflow ?? 0) > 0 ? `−${f2(shape!.outflow)}` : '—'}
                    </td>
                    <td className={`${cycleTd} bg-sky-50 ${(shape?.inflow ?? 0) > 0 ? 'text-green-700' : 'text-gray-300'}`}>
                      {(shape?.inflow ?? 0) > 0 ? f2(shape!.inflow) : '—'}
                    </td>
                    <td className={`${cycleTd} bg-sky-100 ${clr(shape?.net ?? 0)}`}
                      title={shape
                        ? `${f2(shape.inflow)} in − ${f2(shape.outflow)} out inside M${p.cycleIndex + 1}`
                        : undefined}>
                      {shape ? f2(shape.net) : '—'}
                    </td>
                    <td className={`${cycleTd} bg-sky-50 ${book.drawdown > 0 ? 'text-red-600' : 'text-gray-300'}`}>
                      {book.drawdown > 0 ? f2(book.drawdown) : '—'}
                    </td>
                    <td
                      className={`${cycleTd} bg-sky-100 font-semibold ${
                        book.trough < r.cash_floor ? 'text-red-600' : 'text-gray-700'
                      }`}
                      title={(shape ? `operating low on D${shape.lowDay - shape.startDay + 1} of the cycle — no funding swap in it.` : '')
                        + (Math.abs(cycleHedge) > 0.005
                          ? ` ${f2(cycleHedge)} FCY FX hedge ${
                              cycleHedge < 0 ? 'delivered' : 'received'
                            } in this cycle is in it.`
                          : '')
                        + liquidityBookNote}
                    >
                      {f2(book.trough)}
                    </td>
                    {showNonLp && <td className={`${cycleTd} bg-sky-50`} />}
                    <td
                      className={`${cycleTd} bg-sky-50 font-semibold ${
                        book.close >= 0 ? 'text-green-700' : 'text-red-600'
                      }`}
                      title={`Where M${p.cycleIndex + 1} closes on the operating path: ${f2(book.opening)} opening ${
                        (shape?.net ?? 0) >= 0 ? '+' : '−'
                      } ${f2(Math.abs(shape?.net ?? 0))} net flow.` + liquidityBookNote}
                    >
                      {f2(book.close)}
                    </td>
                    <td className={`${cycleTd} bg-sky-100 ${
                      book.close < 0 ? 'text-red-600' : 'text-gray-700'
                    }`}>
                      {f2(swapNearUsd(r.ccy, book.close))}
                    </td>
                    </>)}

                    {showIrBook && <td colSpan={irCols} className="bg-rose-50 border-l border-rose-200" />}
                    {showCarry && (<>
                    <td className={`${cycleTd} bg-amber-50 border-l-2 border-amber-300 text-center`}>
                      <CarryBadge dir={p.layered.carry_dir} />
                    </td>
                    <td className={`${cycleTd} bg-amber-50 font-semibold text-amber-900`}
                      title={`Target LP cash entering M${p.cycleIndex + 1}:`
                        + ` ${f2(p.opening_cash)} opening + ${f2(p.swap_needed)} near leg,`
                        + ` funding this cycle's requirement of ${f2(p.cash_threshold)}`
                        + (p.layered.carry_target_applied
                          ? ` — the carry target drives it${p.layered.carry_target_binding
                            ? ', trimmed by a floor clamp' : ''}.`
                          : `. Carry shift ${f2(p.layered.delta_carry)} at`
                            + ` Δr ${p.layered.delta_r.toFixed(2)}%,`
                            + ` σ cushion ${f2(p.layered.delta_sigma)},`
                            + ` floor ${f2(p.layered.floor_contrib)}.`)
                        + (r.var_trim || r.usd_stress_trim
                          ? ` The book pass trimmed this currency's target to ${f2(r.cash_threshold_pre_swap)}`
                            + ` on ${r.var_trim ? 'the portfolio VaR budget' : 'USD funding stress'} —`
                            + ' that verdict is priced on the near cycle only, so later cycles here'
                            + ' still show their own layer requirement.'
                          : '')}>
                      {f2(p.post_swap_cash)}
                    </td>
                    <td className={`${cycleTd} bg-amber-100 font-semibold ${clr(swapNearUsd(r.ccy, p.post_swap_cash))}`}>
                      {f2(swapNearUsd(r.ccy, p.post_swap_cash))}
                    </td>
                    </>)}

                    {showSwap && (<>
                    <td
                      className={`${cycleTd} bg-emerald-50 border-l-2 border-emerald-300 ${
                        Math.abs(p.swap_needed) > 0.001 ? 'font-semibold text-gray-700' : 'text-gray-300'
                      }`}
                      title={
                        `This cycle's own leg ${f2(p.swap_needed)} · swap outstanding after it`
                        + ` ${f2(p.standing_swap)} (legs roll, they do not run off).`
                        + (binds ? '' : ` The row above books today's M1 near ${f2(r.swapNear)}.`)
                      }
                    >
                      {Math.abs(p.swap_needed) > 0.001 ? f2(p.swap_needed) : '—'}
                    </td>
                    <td className={`${cycleTd} bg-emerald-100`} />
                    <td className={`${cycleTd} bg-emerald-50 font-semibold ${clr(p.standing_swap)}`}
                      title={`Swap outstanding once M${p.cycleIndex + 1}'s leg is on`
                        + (Math.abs(p.far_leg) > 0.001
                          ? `, repaid in full at this cycle's close — the far leg`
                            + ` delivers ${f2(p.far_leg)} back on the last date.`
                          : '')}>
                      {Math.abs(p.standing_swap) > 0.001 ? f2(p.standing_swap) : '—'}
                    </td>
                    <td className={`${cycleTd} bg-emerald-50 text-gray-700`}>
                      {f2(p.post_swap_cash)}
                    </td>
                    <td className={`${cycleTd} bg-emerald-100`} />
                    <td className={`${cycleTd} bg-emerald-50 ${
                      p.cycle_end_cash < r.cash_floor ? 'text-red-600' : 'text-gray-700'
                    }`}
                      title={Math.abs(p.far_leg) > 0.001
                        ? `After the far leg repays ${f2(p.far_leg)} at maturity —`
                          + ` ${f2(p.cycle_end_cash - p.far_leg)} before it`
                        : undefined}>
                      {f2(p.cycle_end_cash)}
                    </td>
                    <td className={`${cycleTd} bg-emerald-100`} />
                    </>)}

                    {showFxHedge && (<>
                    <td className="bg-rose-50 border-l-2 border-rose-400" />
                    <td className="bg-rose-50" />
                    <td className="bg-rose-50" />
                    <td
                      className={`${cycleTd} bg-rose-100 font-medium ${carryTone(cycleCip)}`}
                      title={`M${p.cycleIndex + 1} CIP P&L on standing ${f2(p.standing_swap)} × δ ${n((hedgeDeltas[r.id] ?? 0.5))} = ${usdCarry(cycleCip)}.`}
                    >
                      {usdCarry(cycleCip)}
                    </td>
                    <td className="bg-rose-100" />
                    <td className="bg-rose-100" />
                    </>)}
                    {showRiskMetrics && (
                      <td colSpan={riskMetricCols} className="bg-violet-50 border-l-2 border-violet-400" />
                    )}
                    {showPnl && (() => {
                      const spot = CURRENCY_PARAMS[r.ccy]?.spot ?? 1;
                      const swapNet = fundingSwapMonthCarryUsdM(
                        p.standing_swap, spot, r.r_FCY, shared.r_USD, r.r_OD, 'cashDelta',
                      );
                      const monthCarry = stagedCarryByMonthByCcyUsdM[r.ccy]?.[p.cycleIndex];
                      const hasMonth = monthCarry != null;
                      const m1 = p.cycleIndex === 0;
                      const monthCash = hasMonth ? monthCarry.cashUsdM : (m1 ? cashCarry : null);
                      const monthHedge = hasMonth ? monthCarry.fwdUsdM : (m1 ? hedgeCarry : null);
                      const monthTotal = (monthCash ?? 0) + swapNet + (monthHedge ?? 0);
                      const cashDeltaYr = fundingSwapCashDeltaUsdYr(
                        p.standing_swap, spot, r.r_FCY, shared.r_USD, r.r_OD,
                      );
                      return (
                        <>
                          {!pnlCarryOnly && (
                            <td className={`${cycleTd} bg-purple-50 border-l-2 border-purple-300 text-gray-300`}>
                              —
                            </td>
                          )}
                          <td
                            className={`${cycleTd} bg-purple-50 ${pnlCarryOnly ? 'border-l-2 border-purple-300' : ''} ${
                              monthCash == null ? 'text-gray-300' : carryTone(monthCash)
                            }`}
                            title={
                              hasMonth
                                ? `M${p.cycleIndex + 1} dual-book cash interest (FCY residual + USD) — Cash Carry forecast`
                                : m1
                                  ? stagedCashCarryByCcyUsdM[r.ccy] !== undefined
                                    ? `Cash Carry forecast dual-book interest — path total, shown on M1. ${usdCarry(cashCarry)}.`
                                    : `Unfunded cash carry for the ${r.ccy} path — no funding swap. ${usdCarry(r.floatNim)}.`
                                  : 'Cash Carry is a path total, shown on M1'
                            }
                          >
                            {monthCash == null ? '—' : usdCarry(monthCash)}
                          </td>
                          <td
                            className={`${cycleTd} bg-purple-50 ${carryTone(swapNet)}`}
                            title={`M${p.cycleIndex + 1} cash Δr vs USD on standing ${f2(p.standing_swap)} = ${usdCarry(cashDeltaYr / 12)} (CIP points are in FX Hedge Carry × δ).`}
                          >
                            {usdCarry(swapNet)}
                          </td>
                          <td
                            className={`${cycleTd} bg-purple-50 ${
                              monthHedge == null ? 'text-gray-300' : carryTone(monthHedge)
                            }`}
                            title={
                              hasMonth
                                ? `M${p.cycleIndex + 1} predetermined FWD-points cash — Cash Carry forecast`
                                : m1
                                  ? 'Hedge Cash is staged FWD pts — path total, shown on M1'
                                  : 'Hedge Cash is a path total, shown on M1'
                            }
                          >
                            {monthHedge == null ? '—' : usdCarry(monthHedge)}
                          </td>
                          <td
                            className={`${cycleTd} bg-purple-100 ${
                              Math.abs(monthTotal) < 5e-8
                                ? 'text-gray-300'
                                : monthTotal >= 0 ? 'text-emerald-700' : 'text-red-600'
                            }`}
                            title={
                              hasMonth
                                ? `M${p.cycleIndex + 1} Cash + Swap + Hedge Cash`
                                : m1
                                  ? 'Cash + Swap + Hedge Cash — path total on M1 plus this month’s swap overlay'
                                  : 'This month’s Swap Carry (Cash / Hedge Cash are path totals on M1)'
                            }
                          >
                            {usdCarry(monthTotal)}
                          </td>
                        </>
                      );
                    })()}
                  </tr>
                );
              })}
              </Fragment>
              );
            })}

            {/* ── USD row ── */}
            <tr className="border-t-2 border-blue-400 bg-blue-50 font-medium">
              <td className="sticky left-0 z-20 bg-blue-100 px-1.5 py-0.5 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]">
                <span className="text-xs font-bold text-blue-800 px-0.5">USD</span>
              </td>

              {/* RATES */}
              {ratesOn && (<>
              <td className={`${tdBase} bg-gray-50 border-l-2 border-gray-300`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.r_FCY'] ?? n(usdParams.r_FCY)}
                  onChange={e => editUsd('r_FCY', e.target.value)}
                  onBlur={() => blurUsd('r_FCY')}
                  locked={lockValues} className={`${inBase} w-[52px]`} />
              </td>
              <td className={`${tdBase} bg-gray-50`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.r_OD'] ?? n(usdParams.r_OD)}
                  onChange={e => editUsd('r_OD', e.target.value)}
                  onBlur={() => blurUsd('r_OD')}
                  locked={lockValues} className={`${inBase} w-[52px]`} />
              </td>
              <td className={`${tdBase} bg-gray-50 font-medium ${dclr(usdComputed.delta_r)}`}>
                {usdComputed.delta_r > 0 ? '+' : ''}{f2(usdComputed.delta_r)}%
              </td>
              </>)}

              {/* FX POSITION — USD balancing leg */}
              {showFxPosition && (<>
              <td className={`${tdBase} bg-white border-l-2 border-gray-300 text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxSpotUSD)}`}>{f2(usdComputed.fxSpotUSD)}</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxFwdUSD)}`}>{f2(usdComputed.fxFwdUSD)}</td>
              {/* Hedge — the FCY legs sit on their own rows, USD is the balancing leg. */}
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxNonCashAssetUSD)}`}
                title="USD is the balancing leg — nets the Σ non-cash asset FX across all FCY rows">{f2(usdComputed.fxNonCashAssetUSD)}</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxNonCashUSD)}`}>{f2(usdComputed.fxNonCashUSD)}</td>
              {simplifiedFx && (<>
              <td className={`${tdBase} bg-white`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? n(usdParams.ir_liab_notional)}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  locked={lockValues} className={`${inBase} w-[58px] ${usdParams.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? n(usdParams.ir_liab_notional)}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  locked={lockValues} className={`${inBase} w-[62px] font-medium ${usdParams.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? n((usdParams.ir_invest_notional ?? 0))}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  locked={lockValues} className={`${inBase} w-[58px] ${(usdParams.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? n((usdParams.ir_invest_notional ?? 0))}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  locked={lockValues} className={`${inBase} w-[62px] font-medium ${(usdParams.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
              </td>
              </>)}
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.netFxUSD)}`}>{f2(usdComputed.netFxUSD)}</td>
              <td className={`${tdBase} bg-white font-medium ${Math.abs(usdComputed.netFxForecast) < 0.005 ? 'text-gray-400' : clr(usdComputed.netFxForecast)}`}
                title={`USD Payins (${f2(usdComputed.collections)}) + Payouts (${f2(usdComputed.payout)}) = ${f2(usdComputed.netFxForecast)} M USD`}>
                {Math.abs(usdComputed.netFxForecast) < 0.005 ? '—' : f2(usdComputed.netFxForecast)}
              </td>
              <td className={`${tdBase} bg-white font-medium ${Math.abs(usdComputed.netFxForecast) < 0.005 ? 'text-gray-400' : clr(usdComputed.netFxForecast)}`}>
                {Math.abs(usdComputed.netFxForecast) < 0.005 ? '—' : f2(usdComputed.netFxForecast)}
              </td>
              </>)}

              {/* LIQUIDITY */}
              {showLiquidity && (<>
              <td className={`${tdBase} bg-sky-50 border-l-2 border-sky-300`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.cash'] ?? n(usdCash)}
                  onChange={e => {
                    setDrafts(prev => ({ ...prev, 'usd.cash': e.target.value }));
                    const v = roundMoney(parseFloat(e.target.value));
                    if (!isNaN(v)) setUsdCash(v);
                  }}
                  onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next['usd.cash']; return next; })}
                  locked={lockValues} className={`${inBase} w-[58px] ${usdCash < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-sky-100 font-medium ${clr(usdComputed.cash)}`}>{f2(usdComputed.cash)}</td>
              <td className={`${tdBase} bg-sky-50`} title={usdFlowTitle}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.payout'] ?? n(usdParams.payout)}
                  onChange={e => editUsd('payout', e.target.value)}
                  onBlur={() => blurUsd('payout')}
                  locked={lockValues} className={`${inBase} w-[62px] ${usdParams.payout < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-sky-50`} title={usdFlowTitle}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.collections'] ?? n(usdParams.collections)}
                  onChange={e => editUsd('collections', e.target.value)}
                  onBlur={() => blurUsd('collections')}
                  locked={lockValues} className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-sky-100 font-medium ${
                clr(usdComputed.payout + usdComputed.collections)
              }`}
                title={`Payins (${f2(usdComputed.collections)}) + Payouts (${f2(usdComputed.payout)}) inside the cycle`}>
                {f2(usdComputed.payout + usdComputed.collections)}
              </td>
              <td className={`${tdBase} bg-sky-50 font-medium ${
                Math.max(0, -usdComputed.payout) > 0 ? 'text-red-600' : 'text-gray-400'
              }`}
                title="Cash the USD cycle drains at its deepest — the USD leg carries no dated forecast path, so this is the payout"
              >
                {f2(Math.max(0, -usdComputed.payout))}
              </td>
              <td className={`${tdBase} bg-sky-100 font-semibold ${
                usdComputed.lp_peak_cash >= usdComputed.cash_threshold ? 'text-green-700'
                : usdComputed.lp_peak_cash >= 0               ? 'text-amber-700'
                : 'text-red-600'
              }`}>{f2(usdComputed.lp_peak_cash)}</td>
              {showNonLp && (
                <td className={`${tdBase} bg-sky-50`}>
                  <CellInput type="text" inputMode="decimal" value={drafts['usd.nonLpCash'] ?? n(usdNonLpCash)}
                    onChange={e => {
                      setDrafts(prev => ({ ...prev, 'usd.nonLpCash': e.target.value }));
                      const v = roundMoney(parseFloat(e.target.value));
                      if (!isNaN(v)) setUsdNonLpCash(v);
                    }}
                    onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next['usd.nonLpCash']; return next; })}
                    locked={lockValues} className={`${inBase} w-[58px] ${usdNonLpCash < 0 ? 'text-red-600' : ''}`} />
                </td>
              )}
              <td className={`${tdBase} bg-sky-50 font-medium ${
                usdComputed.cash_after_payins >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
                title={`LP (${f2(usdComputed.cash)}) + Non-LP (${f2(usdComputed.nonLpCash)}) + Payouts (${f2(usdComputed.payout)}) + Payins (${f2(usdComputed.collections)}) = ${f2(usdComputed.cash_after_payins)} M USD — before swap`}>
                {f2(usdComputed.cash_after_payins)}
              </td>
              <td className={`${tdBase} bg-sky-100 font-medium ${clr(usdComputed.cash_after_payins)}`}>
                {f2(usdComputed.cash_after_payins)}
              </td>
              </>)}

              {/* IR / FIXED-RATE BOOK — USD */}
              {showBonds && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_asset_notional'] ?? n(usdParams.ir_asset_notional)}
                  onChange={e => editUsd('ir_asset_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_asset_notional')}
                  locked={lockValues} className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_asset_rate'] ?? n(usdParams.ir_asset_rate)}
                  onChange={e => editUsd('ir_asset_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_asset_rate')}
                  locked={lockValues} className={`${inBase} w-[46px]`} />
              </td>
              </>)}
              {showInvestments && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? n((usdParams.ir_invest_notional ?? 0))}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  locked={lockValues} className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_invest_rate'] ?? n((usdParams.ir_invest_rate ?? 0))}
                  onChange={e => editUsd('ir_invest_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_rate')}
                  locked={lockValues} className={`${inBase} w-[46px]`} />
              </td>
              </>)}
              {showLiabilities && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? n(usdParams.ir_liab_notional)}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  locked={lockValues} className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <CellInput type="text" inputMode="decimal" value={drafts['usd.ir_liab_rate'] ?? n(usdParams.ir_liab_rate)}
                  onChange={e => editUsd('ir_liab_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_rate')}
                  locked={lockValues} className={`${inBase} w-[46px]`} />
              </td>
              </>)}

              {/* CARRY / BUFFER */}
{showCarry && (<>
              <td className={`${tdBase} bg-amber-50 border-l-2 border-amber-300 text-center`}>
                <CarryBadge dir={usdComputed.carryDir} />
              </td>
              <td className={`${tdBase} bg-amber-50 font-semibold text-amber-900`}
                title={`Opening LP ($${f2(usdComputed.cash)}) + Swap ($${f2(usdComputed.swapNear)}) = $${f2(usdComputed.cash_threshold)}M · payout reserve H* $${f2(usdComputed.cash_threshold_pre_swap)}M${usdComputed.funding_binding ? ' — USD funding bind' : ''}`}>
                {f2(usdComputed.cash_threshold)}
                {usdComputed.funding_binding && (
                  <span className="ml-0.5 text-xs text-red-600" title="USD funding bind">⛓</span>
                )}
              </td>
              <td className={`${tdBase} bg-amber-100 font-semibold text-amber-900`}
                title={`USD Target = opening LP + swap = ${fmtThresholdUsd(usdComputed.cashThresholdUSD)}`}>
                {fmtThresholdUsd(usdComputed.cashThresholdUSD)}
                {usdComputed.funding_binding && (
                  <span className="ml-0.5 text-xs text-red-600" title="USD funding bind">⛓</span>
                )}
              </td>
              </>)}

              {showSwap && (<>
              {/* SWAP */}
              <td className={`${tdBase} bg-emerald-50 border-l-2 border-emerald-300 font-semibold ${clr(usdComputed.swapNear)}`}
                title="USD funding leg (already in $M)">
                {f2(usdComputed.swapNear)}
              </td>
              <td className={`${tdBase} bg-emerald-100 font-semibold ${clr(usdComputed.swapNear)}`}
                title="USD funding leg — offsets Σ(FCY swap × spot)">
                {fmtSwapUsd(usdComputed.swapNear)}
              </td>
              <td className={`${tdBase} bg-emerald-50 text-gray-300`}
                title="The USD leg carries no dated path, so it rolls no swap book of its own">—</td>
              <td className={`${tdBase} bg-emerald-50 font-medium ${clr(usdComputed.postSwapCash)}`}
                title={`Opening LP ($${f2(usdComputed.cash)}) + Swap ($${f2(usdComputed.swapNear)}) = $${f2(usdComputed.postSwapCash)}M — funded position before payout`}>
                {f2(usdComputed.postSwapCash)}
              </td>
              <td className={`${tdBase} bg-emerald-100 font-medium ${clr(usdComputed.postSwapUSD)}`}
                title="Opening LP $USD + Swap $USD at near leg">
                {fmtSwapUsd(usdComputed.postSwapUSD)}
              </td>
              <td className={`${tdBase} bg-emerald-50 font-medium ${clr(usdComputed.cycleEndCash)}`}
                title={`LP+Swap ($${f2(usdComputed.postSwapCash)}) + Payout ($${f2(usdComputed.payout)}) + Payins ($${f2(usdComputed.collections)}) + Non-LP sweep ($${f2(usdComputed.nonLpCash)}) = $${f2(usdComputed.cycleEndCash)}M`}>
                {f2(usdComputed.cycleEndCash)}
              </td>
              <td className={`${tdBase} bg-emerald-100 font-medium ${clr(usdComputed.cycleEndCash)}`}
                title="Cycle Net Flow $USD + Swap $USD — before far leg">
                {fmtSwapUsd(usdComputed.cycleEndCash)}
              </td>
              </>)}

              {showFxHedge && (<>
              {/* FX HEDGE — USD is the settlement leg of all FCY hedges */}
              <td className={`${tdBase} bg-rose-50 border-l-2 border-rose-400 font-semibold ${Math.abs(hedgeTotals.fwdUSD) < 0.005 ? 'text-gray-400' : clr(-hedgeTotals.fwdUSD)}`}
                title="USD settlement leg of all FCY forwards = −Σ(fwd × spot)">
                {Math.abs(hedgeTotals.fwdUSD) < 0.005 ? '—' : fmtSwapUsd(-hedgeTotals.fwdUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 font-semibold ${Math.abs(hedgeTotals.optUSD) < 0.005 ? 'text-gray-400' : clr(-hedgeTotals.optUSD)}`}
                title="USD settlement leg of all FCY options, delta-effective = −Σ(δ × written notional × spot)">
                {Math.abs(hedgeTotals.optUSD) < 0.005 ? '—' : fmtSwapUsd(-hedgeTotals.optUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 text-center text-gray-400`}>—</td>
              <td className={`${tdBase} bg-rose-100 text-gray-400 text-xs`}
                title="CIP P&L sits on each FCY far leg — USD is the funding offset">—</td>
              <td className={`${tdBase} bg-rose-100 font-bold ${carryTone(hedgeTotals.hedgeCarryUsdYr)}`}>
                {usdCarry(hedgeTotals.hedgeCarryUsdYr)}
              </td>
              <td className={`${tdBase} bg-rose-100 text-gray-400 text-xs`}>USD offset</td>
</>)}

              {showRiskMetrics && (
                <>
                  <td className={`${tdBase} bg-violet-50 border-l-2 border-violet-400 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-violet-50 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-violet-100 text-gray-400 text-xs`} title="Reporting CCY — no FX mismatch VaR">—</td>
                </>
              )}

              {showPnl && (<>
              {/* P&L */}
              {!pnlCarryOnly && (
              <td className={`${tdBase} bg-purple-50 border-l-2 border-purple-300 font-semibold ${clr(usdComputed.netDelta)}`}>${f2(usdComputed.netDelta)}</td>
              )}
              <td className={`${tdBase} bg-purple-50 font-medium ${pnlCarryOnly ? 'border-l-2 border-purple-300' : ''} ${carryTone(usdComputed.floatNim)}`} title="USD is the base currency — Δr = 0, no carry vs itself">{usdCarry(usdComputed.floatNim)}</td>
              <td className={`${tdBase} bg-purple-50 text-gray-400 text-xs`} title="USD is the funding leg — its interest effect is inside each FCY swap carry">—</td>
              <td className={`${tdBase} bg-purple-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-purple-100 text-gray-400 text-xs`}>—</td>
              </>)}
            </tr>

            {/* ── Totals row ── */}
            <tr className="border-t-2 border-gray-400 bg-gray-100 font-semibold">
              <td className="sticky left-0 z-20 bg-gray-100 px-2 py-1 text-xs font-bold text-gray-700 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.12)]">TOTAL</td>

              {/* RATES — blank */}
              {ratesOn && (
              <td className="bg-gray-50 border-l-2 border-gray-300" colSpan={3} />
              )}

              {/* FX POSITION — FCY not additive; validate $USD columns */}
              {showFxPosition && (<>
              <td className={`${tdBase} bg-white border-l-2 border-gray-300 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.spot)}`}
                title="Σ Spot $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.spot)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.fwd)}`}
                title="Σ Fwd $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.fwd)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-white font-bold ${clr(hedgeUsdTotal)}`}
                title="Σ booked hedge $USD across all CCY — an overlay on the book, so it need not net to 0">
                {fmtHedgeCell(hedgeUsdTotal)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.nonCashAsset)}`}
                title="Σ Non-Cash Asset $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.nonCashAsset)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.nonCash)}`}
                title="Σ Non-Cash $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.nonCash)}
              </td>
              {simplifiedFx && (<>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              </>)}
              <td className={`${tdBase} bg-white text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} font-bold border border-gray-300 ${zeroSumCls(fxUsdTotals.netFx)}`}
                title="Σ Net FX $USD across all CCY + USD — must equal 0">
                {fmtZeroSumUsd(fxUsdTotals.netFx)}
              </td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`} title="M FCY forecasts are not additive across currencies">—</td>
              <td className={`${tdBase} bg-white text-gray-400 text-xs`} title="M FCY forecasts are not additive across currencies">—</td>
              </>)}

              {/* LIQUIDITY — M FCY not additive; $USD columns summed */}
              {showLiquidity && (<>
              <td className={`${tdBase} bg-sky-50 border-l-2 border-sky-300 text-gray-400 text-xs`} title="M FCY balances are not additive across currencies">—</td>
              <td className={`${tdBase} bg-sky-100 font-bold ${clr(lpCashUsdTotal)}`}
                title="Σ LP Cash $USD across all CCY + USD">
                {f2(lpCashUsdTotal)}
              </td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 text-gray-400 text-xs`}>—</td>
              {showNonLp && <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>}
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 font-bold border border-sky-300 ${clr(cycleNetFlowUsdTotal)}`}
                title="Σ Close Balance $USD across all CCY + USD — where the book closes cycle 1 before any swap">
                {f2(cycleNetFlowUsdTotal)}
              </td>
              </>)}

              {/* IR / FIXED-RATE BOOK — M FCY not additive across currencies */}
              {showIrBook && (
                <td className="bg-rose-50 border-l border-rose-200 text-gray-400 text-xs text-center" colSpan={irCols}>—</td>
              )}

{showCarry && (<>
              {/* CARRY / BUFFER */}
              <td className="bg-amber-50 border-l-2 border-amber-300" />
              <td className={`${tdBase} bg-amber-50 text-gray-400 text-xs`} title="M FCY thresholds are not additive across currencies">—</td>
              <td className={`${tdBase} bg-amber-100 font-bold ${clr(thresholdUsdTotal)}`}>{fmtThresholdUsd(thresholdUsdTotal)}</td>
              </>)}

              {showSwap && (<>
              {/* SWAP — FCY units not additive; validate in $USD column */}
              <td className={`${tdBase} bg-emerald-50 border-l-2 border-emerald-300 text-gray-400 text-xs`} title="M FCY swap legs are not additive across currencies">—</td>
              <td className={`${tdBase} font-bold border border-emerald-300 ${
                Math.abs(swapNearUsdTotal) < 0.01 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
              }`}
                title="Σ (swap × spot) across all CCY + USD — must equal 0">
                {Math.abs(swapNearUsdTotal) < 0.01
                  ? <><span className="mr-1">✓</span>{f2(0)}<span className="ml-1 text-xs font-normal">zero-sum</span></>
                  : <><span className="mr-1">⚠</span>{fmtSwapUsd(swapNearUsdTotal)}</>}
              </td>
              <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`} title="M FCY swap books are not additive across currencies">—</td>
              <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`} title="M FCY LP after swap is not additive across currencies">—</td>
              <td className={`${tdBase} bg-emerald-100 font-bold border border-emerald-200 ${clr(postSwapUsdTotal)}`}
                title={`Σ (Opening LP + Swap) $USD — swap zero-sum, so = Σ opening LP $USD`}>
                {fmtSwapUsd(postSwapUsdTotal)}
              </td>
              <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`} title="M FCY cycle end is not additive across currencies">—</td>
              <td className={`${tdBase} bg-emerald-100 font-bold border border-emerald-200 ${clr(cycleEndUsdTotal)}`}
                title={`Σ Cycle End $USD — last close on each currency's path after hedge settlement and the term far-leg repayment`}>
                {fmtSwapUsd(cycleEndUsdTotal)}
              </td>
              </>)}

              {showFxHedge && (<>
              {/* FX HEDGE totals — 6 cols: fwd, option, δ, CIP, hedge carry, residual */}
              <td className={`${tdBase} bg-rose-50 border-l-2 border-rose-400 font-bold ${Math.abs(hedgeTotals.fwdUSD) < 0.005 ? 'text-gray-400 text-xs font-normal' : clr(hedgeTotals.fwdUSD)}`}
                title="Σ forward notionals in $USD across all FCY rows">
                {Math.abs(hedgeTotals.fwdUSD) < 0.005 ? '—' : fmtSwapUsd(hedgeTotals.fwdUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 font-bold ${Math.abs(hedgeTotals.optUSD) < 0.005 ? 'text-gray-400 text-xs font-normal' : clr(hedgeTotals.optUSD)}`}
                title="Σ delta-effective option hedges (δ × written notional) in $USD across all FCY rows">
                {Math.abs(hedgeTotals.optUSD) < 0.005 ? '—' : fmtSwapUsd(hedgeTotals.optUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 text-center text-gray-400`}>—</td>
              <td className={`${tdBase} bg-rose-100 font-bold ${carryTone(hedgeTotals.cipUsdYr)}`}
                title="Σ CIP P&L across FCY rows ($k) — far-leg points × δ">
                {usdCarry(hedgeTotals.cipUsdYr)}
              </td>
              <td className={`${tdBase} bg-rose-100 font-bold ${carryTone(hedgeTotals.hedgeCarryUsdYr)}`}
                title="Σ FX structure carry ($k): locked CIP + outright fwd points. Option delivery is contingent — not in this number.">
                {usdCarry(hedgeTotals.hedgeCarryUsdYr)}
              </td>
              <td className={`${tdBase} bg-rose-100 font-bold ${Math.abs(hedgeTotals.residUSD) < 0.005 ? 'text-green-700' : clr(hedgeTotals.residUSD)}`}
                title="Σ residual (unhedged) FX exposure across all FCY rows, $USD M">
                {Math.abs(hedgeTotals.residUSD) < 0.005 ? '✓ 0.00' : fmtSwapUsd(hedgeTotals.residUSD)}
              </td>
</>)}

              {showRiskMetrics && (
                <>
                  <td
                    className={`${tdBase} bg-violet-50 border-l-2 border-violet-400 font-bold ${
                      riskUsdTotals.exp >= 0 ? 'text-emerald-800' : 'text-rose-700'
                    }`}
                    title="Σ Exp $USD M across FCY"
                  >
                    {`${riskUsdTotals.exp >= 0 ? '+' : '−'}$${f2(Math.abs(riskUsdTotals.exp))}`}
                  </td>
                  <td
                    className={`${tdBase} bg-emerald-50 font-bold text-emerald-800`}
                    title="Σ Fwd / option hedge $USD M across FCY"
                  >
                    {Math.abs(riskUsdTotals.fwd) < 1e-9
                      ? '—'
                      : `${riskUsdTotals.fwd >= 0 ? '+' : '−'}$${f2(Math.abs(riskUsdTotals.fwd))}`}
                  </td>
                  <td
                    className={`${tdBase} bg-violet-50 font-bold ${
                      Math.abs(riskUsdTotals.resid) < 1e-9
                        ? 'text-emerald-700'
                        : riskUsdTotals.resid >= 0
                          ? 'text-emerald-800'
                          : 'text-rose-700'
                    }`}
                    title="Σ Residual $USD M across FCY"
                  >
                    {Math.abs(riskUsdTotals.resid) < 1e-9
                      ? '✓ $0.00'
                      : `${riskUsdTotals.resid >= 0 ? '+' : '−'}$${f2(Math.abs(riskUsdTotals.resid))}`}
                  </td>
                  <td
                    className={`${tdBase} bg-violet-100 font-bold text-violet-900`}
                    title={`Σ undiversified VaR after booked hedges · ${analyticsSetupSummary.profile} · tenure ${varHorizonLabel}`}
                  >
                    ${(riskUsdTotals.varUsdM * 1000).toFixed(0)}K
                  </td>
                </>
              )}

              {showPnl && (<>
              {/* P&L totals — carry in $k; Net Delta $USD is additive across currencies */}
              {!pnlCarryOnly && (
              <td className={`${tdBase} bg-purple-50 border-l-2 border-purple-300 font-bold ${clr(netDeltaUsdTotal)}`}
                title="Σ net FX delta across all rows, converted to $USD at spot">
                ${f2(netDeltaUsdTotal)}
              </td>
              )}
              <td className={`${tdBase} bg-purple-50 font-bold ${pnlCarryOnly ? 'border-l-2 border-purple-300' : ''} ${carryTone(pnlCashCarryTotal)}`}
                title="Σ Cash Carry: dual-book interest where a strip/bullet is staged, else unfunded LP NIM">
                {usdCarry(pnlCashCarryTotal)}
              </td>
              <td className={`${tdBase} bg-purple-50 font-bold ${carryTone(swapCarryTotal)}`}
                title="Σ Swap Carry: cash Δr vs USD on the standing book. CIP far-leg points sit in FX HEDGE, scaled by δ."
              >
                {usdCarry(swapCarryTotal)}
              </td>
              <td className={`${tdBase} bg-purple-50 font-bold ${carryTone(pnlHedgeCarryTotal)}`}
                title="Σ predetermined hedge cash — staged Decision FWD pts only. CIP / option expected delivery are in FX HEDGE.">
                {usdCarry(pnlHedgeCarryTotal)}
              </td>
              <td className={`${tdBase} bg-purple-100 font-bold border border-purple-200 ${
                Math.abs(totalCarryUsd) < 5e-8
                  ? 'text-gray-300'
                  : totalCarryUsd >= 0 ? 'text-emerald-700' : 'text-red-600'
              }`}
                title="Cash Carry + Swap Carry + Hedge Cash (staged FWD pts only)">
                {usdCarry(totalCarryUsd)}
              </td>
              </>)}
            </tr>
          </tbody>
        </table>
        </FormulaGridProvider>
      </div>

      {/* How to read the TOTAL row */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-0.5 font-mono text-[9px] leading-snug text-gray-400">
        <span>
          <span className="font-semibold text-gray-700">1,234</span> real sum ($USD)
        </span>
        <span>
          <span className="text-gray-400">—</span> not additive (M FCY · per-CCY only)
        </span>
        <span>
          <span className="font-semibold text-green-700">0.00 ✓</span> zero-sum invariant holds
        </span>
        <span>
          <span className="font-semibold text-red-700">0.04 ✗</span> invariant broken — model out of balance
        </span>
      </div>
    </div>
  );
}
