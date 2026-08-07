'use client';

import {
  useState,
  useMemo,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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
} from '@/lib/fx-buffer';
import type { FcyComputedRow, UsdComputedRow, PortfolioSummary } from '@/lib/dashboard-model';
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
  type ForecastMonthFlow,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
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
function dclr(v: number){ return v > 0 ? 'text-red-600' : 'text-green-600'; }
/** Explicit "$M/yr" carry formatting so USD-denominated P&L cells never read
 *  as bare/ambiguous numbers (e.g. "16.58" vs "+$16.58"). */
function usdCarry(v: number, dust = 0.005): string {
  if (isNaN(v) || Math.abs(v) < dust) return '—';
  return v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `+$${v.toFixed(2)}`;
}

function swapNearUsd(ccy: string, swapNear: number): number {
  return swapNear * (CURRENCY_PARAMS[ccy]?.spot ?? 1);
}

function fmtSwapUsd(v: number): string {
  if (Math.abs(v) < 0.005) return '—';
  return `${v >= 0 ? '+' : ''}${f2(v)}`;
}

/** Always show USD amount for Target NP Cash column (including zero). */
function fmtThresholdUsd(v: number): string {
  if (isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${f2(v)}`;
}

function fmtZeroSumUsd(v: number): string {
  if (Math.abs(v) < 0.005) return '✓ 0.00';
  return `${v >= 0 ? '+' : ''}${f2(v)}`;
}

function zeroSumCls(v: number): string {
  return Math.abs(v) < 0.01 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700';
}

function CarryBadge({ dir }: { dir: 'earn' | 'pay' | 'neutral' }) {
  if (dir === 'earn') return <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">EARN</span>;
  if (dir === 'pay')  return <span className="rounded-full bg-red-100  px-1.5 py-0.5 text-xs font-medium text-red-700">PAY</span>;
  return <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">NEUT</span>;
}

// ─── Global param input ───────────────────────────────────────────────────────

function GParam({ label, value, min, max, step, unit, onChange, title }: {
  label: string;
  value: number; min: number; max: number; step: number; unit: string;
  onChange: (v: number) => void;
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-[96px]" title={title}>
      <label className="text-xs font-medium text-gray-700">{label}</label>
      <div className="flex items-center gap-1 mt-0.5">
        <input
          type="number" step={step} min={min} max={max} value={roundMoney(value)}
          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(roundMoney(v)); }}
          className="w-20 rounded border border-gray-300 px-2 py-1 text-xs text-right font-mono"
        />
        <span className="text-xs text-gray-400 whitespace-nowrap">{unit}</span>
      </div>
    </div>
  );
}

// ─── Style constants ──────────────────────────────────────────────────────────

const POLICY_VAR_LIMITS = [
  { usd: 5, label: '$5M', who: 'Treasury' },
  { usd: 10, label: '$10M', who: 'Director' },
  { usd: 20, label: '$20M', who: 'CFO' },
] as const;
const thBase = 'px-1.5 py-1 text-[11px] leading-tight font-semibold text-gray-600 whitespace-nowrap align-bottom text-right';
const tdBase = 'px-1.5 py-0.5 text-right text-[11px] whitespace-nowrap tabular-nums';
const inBase = 'text-right text-xs border-0 bg-transparent focus:bg-white focus:ring-1 focus:ring-blue-400 rounded px-0.5 outline-none';
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
  usdNonNpCash, setUsdNonNpCash,
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
  /** Hide FX Hedge column group + hedging-strategy/Portfolio VAR toolbar (Liquidity view). */
  hideFxHedge = false,
  /** 'carryOnly': P&L shows only Cash Carry + Swap Carry (drops Net Delta / Hedge Carry / Total Carry). */
  pnlColumns = 'full',
}: {
  shared: SharedGlobals;
  onSharedChange: (key: keyof SharedGlobals, value: number) => void;
  rows: RowState[];
  setRows: React.Dispatch<React.SetStateAction<RowState[]>>;
  usdCash: number;
  setUsdCash: React.Dispatch<React.SetStateAction<number>>;
  usdNonNpCash: number;
  setUsdNonNpCash: React.Dispatch<React.SetStateAction<number>>;
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
}) {
  // IR / fixed-rate book section: shown when any of its inputs are selected.
  const irCols = (showBonds ? 2 : 0) + (showInvestments ? 2 : 0) + (showLiabilities ? 2 : 0);
  const showIrBook = showAdvancedBook && irCols > 0;
  const showCarry = showAdvancedBook;
  const showSwap = showAdvancedBook;
  const showFxHedge = showAdvancedBook && !hideFxHedge;
  const showPnl = showAdvancedBook;
  const pnlCarryOnly = pnlColumns === 'carryOnly';
  // Rates / IR only apply in the full book (Task Mode simplified view omits them).
  const ratesOn = showAdvancedBook && showRates;
  /** Task Mode: Debt + Investments live in FX POSITION; every FX cell is editable. */
  const simplifiedFx = !showAdvancedBook;
  const fxPosColSpan = simplifiedFx ? 16 : 12;
  /** Exp · Booked H · Residual · VaR (after booked hedges; no Decision-% staging) */
  const riskMetricCols = 4;
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
    },
    [
      onForecastProfileChange,
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
      const u = lineUncertainty1m(forecastProfile, ccy, field);
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
    [onForecastProfileChange, forecastProfile],
  );

  const offsetFor = useCallback(
    (ccy: string): BookedPositionOffset =>
      bookedPositionByCcy[ccy] ?? { spotLocalM: 0, fwdLocalM: 0 },
    [bookedPositionByCcy],
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

  const resetRows = useCallback(() => {
    if (onResetTable) {
      onResetTable();
    } else {
      setRows(INITIAL_ROWS.map(r => ({ ...r })));
      setUsdParams({ ...INITIAL_USD_PARAMS });
    setUsdCash(303.9);
    setUsdNonNpCash(154.1);
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
    setUsdNonNpCash,
    onForecastProfileChange,
  ]);

  const computed = fcyComputed;

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
    cashPos: totals.cashPosUSD + usdComputed.cashPosUSD,
  }), [totals, usdComputed]);

  const usdComputedRow = usdComputed;

  const swapNearUsdTotal = useMemo(
    () => sumFcySwapNearUsd(computed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear }))) + usdComputedRow.swapNear,
    [computed, usdComputedRow.swapNear],
  );

  const npCashUsdTotal = useMemo(
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

  const floatNimUsdTotal = useMemo(
    () => computed.reduce((s, r) => s + r.floatNim, 0) + usdComputedRow.floatNim,
    [computed, usdComputedRow.floatNim],
  );

  const swapCarryTotal = useMemo(
    () => computed.reduce((s, r) => s + r.swapCarryUsdYr, 0),
    [computed],
  );

  // ── FX Hedge — strategy applied per row on top of the swap book ─────────────
  //   Basis: Net FX Forecast = current net FX book (spot + fwd + non-cash) PLUS
  //   the expected cycle flows (payins + payouts) — the full cycle-end exposure.
  const computedWithHedge = useMemo(() =>
    computed.map(r => {
      // Option notional is always matched to the forward; δ is the option's own
      // delta (ATM ≈ 0.5) = fraction of the open exposure the option covers.
      const optDelta = hedgeDeltas[r.id] ?? 0.5;
      const hedge = resolveStrategyHedge(strategy, {
        ccy: r.ccy,
        currentFx: r.netFxFCY,
        forecastFx: r.netFxForecast,
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
        cash: r.cash, payout: r.payout, collections: r.collections, nonNpCash: r.nonNpCash,
        fcastFX: r.fcastFX, spot: r.spot, fwd: r.fwd, nonCash: r.nonCash, nonCashAsset: r.nonCashAsset ?? 0,
        rFCY: r.r_FCY, rOD: r.r_OD, rUSD: shared.r_USD, spotRate,
        netFxFCY: r.netFxFCY, netFxForecast: r.netFxForecast,
        fwdNotional: r.fwdNotional, optNotional: r.optNotional, optDelta: r.optDelta,
        swapNear: r.swapNear,
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
        residualFx = r.netFxForecast + fwdNotionalRes + optEffectiveRes;
        hedgeCarryUsdYr = fwdHedgeCarryUsdYr(fwdNotionalRes, r.ccy, r.r_FCY, shared.r_USD)
          + fwdHedgeCarryUsdYr(optEffectiveRes, r.ccy, r.r_FCY, shared.r_USD);
      }
      map[r.ccy] = { values: resolved.values, errors: resolved.errors, residualFx, hedgeCarryUsdYr };
    }
    return map;
  }, [computedWithHedge, formulas, shared.r_USD]);

  // Total annual USD carry = natural cash float + swap interest overlay + FX hedge carry.
  const totalCarryUsd = floatNimUsdTotal + swapCarryTotal + hedgeTotals.hedgeCarryUsdYr;

  return (
    <div className="space-y-4">

      {/* ── Global parameters ── */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <GParam
            label="USD deposit rate r_USD"
            value={shared.r_USD} min={0} max={10} step={0.05} unit="% p.a."
            onChange={v => onSharedChange('r_USD', v)}
          />
          <GParam
            label="Incremental forecast uncertainty"
            value={shared.σ_P * 100} min={0} max={40} step={1} unit="%"
            onChange={v => onSharedChange('σ_P', v / 100)}
            title="σ used for forecast-uncertainty analysis (payout buffer / stress layers)"
          />
          <div className="flex flex-col gap-0.5 min-w-[140px]">
            <label className="text-xs font-medium text-gray-700">Exposure period</label>
            <div className="mt-0.5 flex flex-wrap items-center gap-1">
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
                    className={`rounded border px-2 py-1 text-xs font-medium transition-colors ${
                      on
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-end gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setForecastProfileOpen(true)}
              disabled={forecastMonths === 0}
              className="rounded border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
              title={
                forecastMonths === 0
                  ? 'No forecast period — pick 1 month+ to edit cash inflow / outflow profile'
                  : 'Edit flat or custom per-period cash inflows / outflows'
              }
            >
              Forecast profile…
              {forecastProfile.mode === 'custom' && (
                <span className="ml-1 text-[10px] font-semibold text-violet-600">custom</span>
              )}
            </button>
            <button
              onClick={resetRows}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
            >
              Reset table
            </button>
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
                      Forecast profile — Balance-sheet cash
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
                  </div>
                  {forecastFormulaHelpOpen && (
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
                <div className={fpu.footer}>
                  <div className={`space-y-1 text-[10px] ${fpu.textMuted}`}>
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Formula layer toggles — same state as Layer Setup tab */}
          <span className="text-xs font-medium text-gray-500">Layers:</span>
          {[
            { id: 'floorH' as LayerId, label: 'Min floor', hint: 'Hard minimum cash per currency' },
            { id: 'sigmaP' as LayerId, label: 'Payout σ buffer', hint: 'Safety margin on uncovered payout deficit (prefunded payout → σ = 0)' },
            { id: 'carryOptim' as LayerId, label: 'Carry target', hint: 'Rate-driven buffer shift (PAY sell / EARN buy)' },
            ...(hideFxHedge ? [] : [{ id: 'portfolioDiv' as LayerId, label: 'Portfolio VAR', hint: 'Cross-currency rebalance with VAR / USD budget limits' }]),
          ].map(l => {
            const on = activeLayers.has(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onLayerToggle(l.id)}
                title={l.hint}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  on
                    ? 'bg-blue-50 text-blue-800 border-blue-300 hover:bg-blue-100'
                    : 'bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${on ? 'bg-blue-600' : 'bg-gray-300'}`} />
                {l.label}
              </button>
            );
          })}

          {!hideFxHedge && (
            <>
              <span className="ml-4 text-xs font-medium text-gray-500">Hedging strategy:</span>
              {HEDGE_STRATEGIES.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStrategy(s.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    strategy === s.id
                      ? 'bg-rose-50 text-rose-800 border-rose-300 hover:bg-rose-100'
                      : 'bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${strategy === s.id ? 'bg-rose-600' : 'bg-gray-300'}`} />
                  {s.label}
                </button>
              ))}
            </>
          )}
        </div>

        )}

        {showAdvancedBook && !hideFxHedge && activeLayers.has('portfolioDiv') && portfolioSummary && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
            <span
              className="text-xs font-semibold text-violet-800"
              title="Notional sensitivity limit — caps the portfolio's position sensitivity (net notional × FX volatility σ, with cross-currency diversification). This is NOT a P&L limit: a true P&L limit would be a stochastic VAR on the mark-to-market FX exposure value, revalued daily."
            >
              Portfolio notional sensitivity limit
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-violet-600">Sensitivity limit:</span>
              {POLICY_VAR_LIMITS.map(pl => (
                <button
                  key={pl.usd}
                  type="button"
                  onClick={() => onPolicyVARChange(pl.usd)}
                  className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                    policyVAR === pl.usd
                      ? 'bg-violet-700 text-white border-violet-700'
                      : 'bg-white text-violet-600 border-violet-300 hover:bg-violet-100'
                  }`}
                  title={`${pl.label} (${pl.who} approval)`}
                >
                  {pl.label}
                </button>
              ))}
              <input
                type="range"
                min={0.5}
                max={25}
                step={0.5}
                value={policyVAR}
                onChange={e => onPolicyVARChange(Number(e.target.value))}
                className="w-36 accent-violet-700"
                title="Drag to set any intermediate notional sensitivity limit ($0.5M–$25M, $0.5M steps)"
              />
              <input
                type="number"
                min={0.5}
                max={25}
                step={0.5}
                value={policyVAR}
                onChange={e => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) onPolicyVARChange(Math.min(25, Math.max(0.5, v)));
                }}
                className="w-16 rounded border border-violet-300 bg-white px-1.5 py-0.5 text-right text-xs font-mono text-violet-800 focus:ring-1 focus:ring-violet-400 outline-none"
                title="Type an exact notional sensitivity limit in $M"
              />
              <span className="text-xs text-violet-600">$M</span>
            </div>
            <span
              className={`text-xs font-mono ${
                portfolioSummary.portfolio_VAR_USD > portfolioSummary.policyVAR
                  ? 'text-red-700 font-semibold'
                  : 'text-green-700'
              }`}
              title="Notional sensitivity of the carry overlay (deviation from hold-the-book), measured as net notional × FX volatility σ with diversification — existing NP holdings are not charged against the sensitivity budget. Not a daily-revalued P&L VAR."
            >
              Overlay sensitivity ${f2(portfolioSummary.portfolio_VAR_USD)}M / ${f2(portfolioSummary.policyVAR)}M limit
            </span>
            <span
              className={`text-xs font-mono font-semibold ${
                portfolioSummary.overlay_carry_USD >= 0 ? 'text-emerald-700' : 'text-red-700'
              }`}
              title="Incremental annual USD carry from the discretionary overlay vs hold-the-book: Σ (target − base) × spot × (r_FCY − r_USD)/100. Already embedded in Cash Carry (post-swap economic P&L) — shown here as the VAR-budget attribution, not an add-on."
            >
              Overlay carry {portfolioSummary.overlay_carry_USD >= 0 ? '+' : ''}${f2(portfolioSummary.overlay_carry_USD)}M/yr
            </span>
            {portfolioSummary.var_binding && !portfolioSummary.budget_binding && (
              <span className="text-xs font-medium text-green-700">✓ Carry maximized</span>
            )}
            {portfolioSummary.budget_binding && (
              <span className="text-xs font-medium text-orange-700">⚠ USD budget binding</span>
            )}
            {portfolioSummary.stress_trim && (
              <span className="text-xs font-medium text-orange-700">⚠ USD stress trim</span>
            )}
            {portfolioSummary.var_trim && (
              <span className="text-xs font-medium text-amber-700">⚠ Overlay trimmed</span>
            )}
            {!portfolioSummary.var_binding && !portfolioSummary.budget_binding && !portfolioSummary.stress_trim
              && portfolioSummary.portfolio_VAR_USD <= portfolioSummary.policyVAR && (
              <span className="text-xs text-green-700">✓ Within limit</span>
            )}
          </div>
        )}
      </div>

      {/* ── Main table ── */}
      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-10rem)] rounded-lg border border-gray-200">
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
              <th className="border-l border-gray-300 bg-gray-50 px-2 py-1 text-center text-xs font-semibold text-gray-600 tracking-wide" colSpan={3}>
                RATES
              </th>
              )}

              {showFxPosition && (
                <th className="border-l border-gray-300 bg-white px-2 py-1 text-center text-xs font-semibold text-gray-600 tracking-wide" colSpan={fxPosColSpan}>
                FX POSITION
              </th>
              )}

              {showLiquidity && (
              <th className="border-l border-gray-300 bg-sky-50 px-2 py-1 text-center text-xs font-semibold text-sky-700 tracking-wide" colSpan={9}>
                LIQUIDITY BOOK
              </th>
              )}

              {showIrBook && (
                <th className="border-l border-gray-300 bg-rose-50 px-2 py-1 text-center text-xs font-semibold text-rose-700 tracking-wide" colSpan={irCols}>
                  IR / FIXED-RATE BOOK
                </th>
              )}

              {showCarry && (
              <th className="border-l border-gray-300 bg-amber-50 px-2 py-1 text-center text-xs font-semibold text-amber-700 tracking-wide" colSpan={3}>
                CARRY / BUFFER
              </th>
              )}

              {showSwap && (
              <th className="border-l border-gray-300 bg-emerald-50 px-2 py-1 text-center text-xs font-semibold text-emerald-700 tracking-wide" colSpan={6}>
                SWAP
              </th>
              )}

              {showFxHedge && (
              <th className="border-l-2 border-rose-400 bg-rose-50 px-2 py-1 text-center text-xs font-semibold text-rose-700 tracking-wide" colSpan={5}>
                FX HEDGE

                {strategy === 'SWAP_ONLY' && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800 normal-case">
                    Swap only — no fwd/option placed; select Swap + Fwd (± Option) above to hedge the forecast
                  </span>
                )}
              </th>
              )}

              {showRiskMetrics && (
                <th
                  className="border-l border-violet-400 bg-violet-50 px-2 py-1 text-center text-xs font-semibold text-violet-800 tracking-wide"
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
              <th className="border-l border-gray-300 bg-purple-50 px-2 py-1 text-center text-xs font-semibold text-purple-700 tracking-wide" colSpan={pnlCarryOnly ? 2 : 5}>
                P&L
              </th>
              )}
            </tr>

            {/* ── Column name row ── */}
            <tr className="border-b-2 border-gray-300 bg-white">

              {/* RATES ×3 */}
              {ratesOn && (<>
              <th className={`${thBase} bg-gray-50 border-l border-gray-300 min-w-[64px]`}>Credit Rate</th>
              <th className={`${thBase} bg-gray-50 min-w-[64px]`}>Debit Rate</th>
              <th className={`${thBase} bg-gray-50 min-w-[68px]`}>Rate Spread</th>
              </>)}

              {/* FX POSITION */}
              {showFxPosition && (<>
              <th
                className={`${thBase} bg-white border-l border-gray-300 min-w-[68px]`}
                title="Cash FX book (M FCY), including booked Decision-layer spot hedges"
              >
                Cash FX
              </th>
              <th className={`${thBase} bg-white min-w-[68px]`}>Cash FX $USD</th>
              <th
                className={`${thBase} bg-white min-w-[68px]`}
                title="Outstanding forward (M FCY), including booked Decision-layer forward hedges"
              >
                Fwd (FCY)
              </th>
              <th
                className={`${thBase} bg-white min-w-[68px]`}
                title="Outstanding forward settlement (M USD), including booked Decision-layer forward hedges"
              >
                Fwd $USD
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
              <th className={`${thBase} bg-sky-50 border-l border-sky-200 min-w-[64px]`}>NP Cash</th>
              <th className={`${thBase} bg-sky-100 min-w-[68px]`}>NP Cash $USD</th>
              <th className={`${thBase} bg-sky-50 min-w-[68px]`}>Gross Payouts</th>
              <th className={`${thBase} bg-sky-50 min-w-[64px]`}>Gross Payins</th>
              <th className={`${thBase} bg-sky-50 min-w-[72px]`}>Non-NP Cash</th>
              <th className={`${thBase} bg-sky-100 min-w-[76px]`}>Trough Cash</th>
              <th className={`${thBase} bg-sky-100 min-w-[80px]`}>Cycle Net Flow</th>
              <th className={`${thBase} bg-sky-50 min-w-[72px]`}>Total Cash</th>
              <th className={`${thBase} bg-sky-100 min-w-[68px]`}>Total Cash $USD</th>
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
              <th className={`${thBase} bg-amber-50 border-l border-gray-300 min-w-[52px] text-center`}>Carry</th>
              <th className={`${thBase} bg-amber-50 min-w-[72px]`}>Target NP Cash</th>
              <th className={`${thBase} bg-amber-100 min-w-[72px]`}>Target NP Cash $USD</th>
              </>)}

              {showSwap && (<>
              {/* SWAP ×6 */}
              <th className={`${thBase} bg-emerald-50 border-l border-gray-300 min-w-[64px]`}>Swap Near</th>
              <th className={`${thBase} bg-emerald-100 min-w-[64px]`}>Swap $USD</th>
              <th className={`${thBase} bg-emerald-50 min-w-[68px]`}>NP+Swap</th>
              <th className={`${thBase} bg-emerald-100 min-w-[68px]`}>NP+Swap $USD</th>
              <th className={`${thBase} bg-emerald-50 min-w-[72px]`}>Cycle End</th>
              <th className={`${thBase} bg-emerald-100 min-w-[72px]`}>Cycle End $USD</th>
              </>)}

              {showFxHedge && (<>
              {/* FX HEDGE ×5 — all figures in $USD M */}
              <th className={`${thBase} bg-rose-50 border-l-2 border-rose-400 min-w-[72px]`} title="Outright forward notional in $USD M (− = sell FCY fwd)">Fwd Hedge $USD</th>
              <th className={`${thBase} bg-rose-50 min-w-[84px]`} title="SHORT option — delta-effective option hedge = δ × written notional; the written notional is matched 1:1 to the forward at all deltas, so the displayed amount = δ × Fwd Hedge $USD (δ 1 = full forward, δ 0.5 = half, δ → 0 = nothing). PAY carry: sell CALL (exercise: sell USD, buy LCY); EARN carry: sell PUT (exercise: buy USD, sell LCY). Amount in $USD M">Option Hedge $USD</th>
              <th className={`${thBase} bg-rose-50 min-w-[44px] text-center`} title="Option delta — ATM ≈ 0.5. The written notional stays matched 1:1 to the forward at all deltas; δ scales only the delta-effective hedge shown in the Option column (= δ × notional), linear from the full forward at δ = 1 down to zero at δ = 0">Δ</th>
              <th className={`${thBase} bg-rose-100 min-w-[76px]`} title="Fwd points + option δ-leg delivery points, $M/yr USD. Gross premium harvested is shown in the cell tooltip for reference only — at fair value it offsets the expected exercise cost, so it is EXCLUDED from carry">Hedge Carry $USD</th>
              <th className={`${thBase} bg-rose-100 min-w-[76px]`} title="Net FX Forecast + total hedge (Fwd + δ × Option) — what stays open, in $USD M">Residual FX $USD</th>
              </>)}

              {showRiskMetrics && (<>
              <th
                className={`${thBase} bg-violet-50 border-l border-violet-300 min-w-[72px]`}
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
              {/* P&L — all USD-denominated, $M/yr for carry columns */}
              {!pnlCarryOnly && (
              <th className={`${thBase} bg-purple-50 border-l border-gray-300 min-w-[76px]`}>Net Delta $USD</th>
              )}
              <th className={`${thBase} bg-purple-50 min-w-[76px] ${pnlCarryOnly ? 'border-l border-gray-300' : ''}`}>Cash Carry $USD</th>
              <th className={`${thBase} bg-purple-50 min-w-[76px]`}>Swap Carry $USD</th>
              {!pnlCarryOnly && (<>
              <th className={`${thBase} bg-purple-50 min-w-[76px]`}>Hedge Carry $USD</th>
              <th className={`${thBase} bg-purple-100 min-w-[80px]`}>Total Carry $USD</th>
              </>)}
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
              const hedgeCarry = R?.hedgeCarryUsdYr ?? r.hedgeCarryUsdYr;
              const residual = R?.residualFx ?? r.residualFx;
              return (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50/50">

                {/* CCY */}
                <td className="sticky left-0 z-20 bg-white hover:bg-gray-50 px-1.5 py-0.5 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]">
                  <input
                    type="text" value={r.ccy} maxLength={6}
                    onChange={e => editCcy(r.id, e.target.value)}
                    className="w-[52px] text-left text-xs font-bold text-gray-900 border-0 bg-transparent focus:bg-white focus:ring-1 focus:ring-blue-400 rounded px-0.5 outline-none uppercase"
                  />
                </td>

                {/* RATES */}
                {ratesOn && (<>
                <td className={`${tdBase} bg-gray-50 border-l border-gray-300`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.r_FCY`] ?? n(r.r_FCY)}
                    onChange={e => editRow(r.id, 'r_FCY', e.target.value)}
                    onBlur={() => blurRow(r.id, 'r_FCY')}
                    className={`${inBase} w-[52px]`} />
                </td>
                <td className={`${tdBase} bg-gray-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.r_OD`] ?? n(r.r_OD)}
                    onChange={e => editRow(r.id, 'r_OD', e.target.value)}
                    onBlur={() => blurRow(r.id, 'r_OD')}
                    className={`${inBase} w-[52px]`} />
                </td>
                <td className={`${tdBase} bg-gray-50 font-medium ${dclr(r.delta_r)}`}>
                  {r.delta_r > 0 ? '+' : ''}{f2(r.delta_r)}%
                </td>
                </>)}

                {/* FX POSITION — spot/fwd/non-cash in FCY + USD */}
                {showFxPosition && (<>
                <td className={`${tdBase} bg-white border-l border-gray-300`}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={drafts[`${r.id}.spot`] ?? n(r.spot)}
                    onChange={e => editRow(r.id, 'spot', e.target.value, r.ccy)}
                    onBlur={() => blurRow(r.id, 'spot')}
                    title={
                      Math.abs(offsetFor(r.ccy).spotLocalM) > 1e-9
                        ? `Includes booked spot hedge ${offsetFor(r.ccy).spotLocalM.toFixed(2)} M`
                        : undefined
                    }
                    className={`${inBase} w-[62px] ${r.spot < 0 ? 'text-red-600' : ''}`}
                  />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.spotUsd`] ?? n(r.fxSpotUSD)}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'spot', 'spotUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'spotUsd')}
                      className={`${inBase} w-[62px] font-medium ${r.fxSpotUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxSpotUSD)}`}>{f2(r.fxSpotUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={drafts[`${r.id}.fwdFcy`] ?? n(r.fxFwdFCY)}
                    onChange={e => editFwdFcy(r.id, r.ccy, e.target.value)}
                    onBlur={() => blurRow(r.id, 'fwdFcy')}
                    title={
                      Math.abs(offsetFor(r.ccy).fwdLocalM) > 1e-9
                        ? `Includes booked forward ${offsetFor(r.ccy).fwdLocalM.toFixed(2)} M FCY`
                        : undefined
                    }
                    className={`${inBase} w-[62px] font-medium ${r.fxFwdFCY < 0 ? 'text-red-600' : ''}`}
                  />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={drafts[`${r.id}.fwd`] ?? n(r.fwd)}
                    onChange={e => editRow(r.id, 'fwd', e.target.value, r.ccy)}
                    onBlur={() => blurRow(r.id, 'fwd')}
                    title={
                      Math.abs(offsetFor(r.ccy).fwdLocalM) > 1e-9
                        ? `Includes booked forward ${fcyToUsdM(offsetFor(r.ccy).fwdLocalM, r.ccy).toFixed(2)} M USD`
                        : undefined
                    }
                    className={`${inBase} w-[62px] ${r.fwd < 0 ? 'text-red-600' : ''}`}
                  />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashAsset`] ?? n((r.nonCashAsset ?? 0))}
                    onChange={e => editRow(r.id, 'nonCashAsset', e.target.value)}
                    onBlur={() => blurRow(r.id, 'nonCashAsset')}
                    className={`${inBase} w-[58px] ${(r.nonCashAsset ?? 0) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashAssetUsd`] ?? n(r.fxNonCashAssetUSD)}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'nonCashAsset', 'nonCashAssetUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'nonCashAssetUsd')}
                      className={`${inBase} w-[62px] font-medium ${r.fxNonCashAssetUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxNonCashAssetUSD)}`}>{f2(r.fxNonCashAssetUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonCash`] ?? n(r.nonCash)}
                    onChange={e => editRow(r.id, 'nonCash', e.target.value)}
                    onBlur={() => blurRow(r.id, 'nonCash')}
                    className={`${inBase} w-[58px] ${r.nonCash < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonCashUsd`] ?? n(r.fxNonCashUSD)}
                      onChange={e => editFcyViaUsd(r.id, r.ccy, 'nonCash', 'nonCashUsd', e.target.value)}
                      onBlur={() => blurRow(r.id, 'nonCashUsd')}
                      className={`${inBase} w-[62px] font-medium ${r.fxNonCashUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.fxNonCashUSD)}`}>{f2(r.fxNonCashUSD)}</span>
                  )}
                </td>
                {simplifiedFx && (<>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_notional`] ?? n(r.ir_liab_notional)}
                    onChange={e => editRow(r.id, 'ir_liab_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_notional')}
                    className={`${inBase} w-[58px] ${r.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.debtUsd`] ?? n(fcyToUsdM(r.ir_liab_notional, r.ccy))}
                    onChange={e => editFcyViaUsd(r.id, r.ccy, 'ir_liab_notional', 'debtUsd', e.target.value)}
                    onBlur={() => blurRow(r.id, 'debtUsd')}
                    className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.ir_liab_notional, r.ccy) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_notional`] ?? n((r.ir_invest_notional ?? 0))}
                    onChange={e => editRow(r.id, 'ir_invest_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_notional')}
                    className={`${inBase} w-[58px] ${(r.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-white`}>
                  <input type="text" inputMode="decimal"
                    value={drafts[`${r.id}.investUsd`] ?? n(fcyToUsdM(r.ir_invest_notional ?? 0, r.ccy))}
                    onChange={e => editFcyViaUsd(r.id, r.ccy, 'ir_invest_notional', 'investUsd', e.target.value)}
                    onBlur={() => blurRow(r.id, 'investUsd')}
                    className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.ir_invest_notional ?? 0, r.ccy) < 0 ? 'text-red-600' : ''}`} />
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
                      ? `(Cash/Fwd include booked hedges: spot ${f2(offsetFor(r.ccy).spotLocalM)}, fwd ${f2(offsetFor(r.ccy).fwdLocalM)})`
                      : '',
                  ].filter(Boolean).join(' ')}
                >
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.netFxFCY`] ?? n(r.netFxFCY)}
                      onChange={e => editNetFxFcy(r.id, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxFCY')}
                      className={`${inBase} w-[62px] font-medium ${r.netFxFCY < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.netFxFCY)}`}>{f2(r.netFxFCY)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.netFxUSD`] ?? n(r.netFxUSD)}
                      onChange={e => editNetFxUsd(r.id, r.ccy, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxUSD')}
                      className={`${inBase} w-[62px] font-medium ${r.netFxUSD < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(r.netFxUSD)}`}>{f2(r.netFxUSD)}</span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}
                  title={
                    forecastProfile.mode === 'custom'
                      ? `Net FX (${f2(r.netFxFCY)}) + custom period Σ (${f2(periodFlowSumLocalM(r, forecastMonths, forecastProfile))}) = ${f2(r.netFxForecast)} M FCY`
                      : `Net FX (${f2(r.netFxFCY)}) + (Rev ${f2(r.collections)} + Exp ${f2(r.payout)} + Fcast ${f2(r.fcastFX)}) × ${forecastMonths} = ${f2(r.netFxForecast)} M FCY`
                  }>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal" value={drafts[`${r.id}.netFxForecast`] ?? n(r.netFxForecast)}
                      onChange={e => editNetFxForecast(r.id, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxForecast')}
                      className={`${inBase} w-[62px] font-medium ${r.netFxForecast < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${Math.abs(r.netFxForecast) < 0.005 ? 'text-gray-300' : clr(r.netFxForecast)}`}>
                  {Math.abs(r.netFxForecast) < 0.005 ? '—' : f2(r.netFxForecast)}
                    </span>
                  )}
                </td>
                <td className={`${tdBase} bg-white`}>
                  {simplifiedFx ? (
                    <input type="text" inputMode="decimal"
                      value={drafts[`${r.id}.netFxForecastUSD`] ?? n(fcyToUsdM(r.netFxForecast, r.ccy))}
                      onChange={e => editNetFxForecastUsd(r.id, r.ccy, e.target.value)}
                      onBlur={() => blurRow(r.id, 'netFxForecastUSD')}
                      className={`${inBase} w-[62px] font-medium ${fcyToUsdM(r.netFxForecast, r.ccy) < 0 ? 'text-red-600' : ''}`} />
                  ) : (
                    <span className={`font-medium ${clr(fcyToUsdM(r.netFxForecast, r.ccy))}`}>
                      {f2(fcyToUsdM(r.netFxForecast, r.ccy))}
                    </span>
                  )}
                </td>
                </>)}

                {/* LIQUIDITY */}
                {showLiquidity && (<>
                <td className={`${tdBase} bg-sky-50 border-l border-sky-200`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.cash`] ?? n(r.cash)}
                    onChange={e => editRow(r.id, 'cash', e.target.value)}
                    onBlur={() => blurRow(r.id, 'cash')}
                    className={`${inBase} w-[58px] ${r.cash < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-sky-100 font-medium ${clr(swapNearUsd(r.ccy, r.cash))}`}
                  title={`${f2(r.cash)} M FCY × spot ${(CURRENCY_PARAMS[r.ccy]?.spot ?? 1).toFixed(4)}`}>
                  {f2(swapNearUsd(r.ccy, r.cash))}
                </td>
                <td className={`${tdBase} bg-sky-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.payout`] ?? n(r.payout)}
                    onChange={e => editRow(r.id, 'payout', e.target.value)}
                    onBlur={() => blurRow(r.id, 'payout')}
                    className={`${inBase} w-[62px] ${r.payout < 0 ? 'text-red-600' : ''}`} />
                </td>
                <td className={`${tdBase} bg-sky-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.collections`] ?? n(r.collections)}
                    onChange={e => editRow(r.id, 'collections', e.target.value)}
                    onBlur={() => blurRow(r.id, 'collections')}
                    className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-sky-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.nonNpCash`] ?? n(r.nonNpCash)}
                    onChange={e => editRow(r.id, 'nonNpCash', e.target.value)}
                    onBlur={() => blurRow(r.id, 'nonNpCash')}
                    className={`${inBase} w-[58px] ${r.nonNpCash < 0 ? 'text-red-600' : ''}`} />
                </td>
                <FormulaCell
                  tdClass={`${tdBase} bg-sky-100 font-semibold ${
                    fv('troughCash') >= fv('targetNpCash') ? 'text-green-700'
                    : fv('troughCash') >= 0 ? 'text-amber-700' : 'text-red-600'}`}
                  display={f2(fv('troughCash'))}
                  formula={fFormula('troughCash')} defaultFormula={SIM_FIELD_BY_KEY.troughCash.defaultFormula}
                  onCommit={fCommit('troughCash')} error={fErr('troughCash')} title="Trough Cash"
                  columnKey="troughCash" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-sky-100 font-medium ${fv('cycleNetFlow') >= 0 ? 'text-green-700' : 'text-red-600'}`}
                  display={f2(fv('cycleNetFlow'))}
                  formula={fFormula('cycleNetFlow')} defaultFormula={SIM_FIELD_BY_KEY.cycleNetFlow.defaultFormula}
                  onCommit={fCommit('cycleNetFlow')} error={fErr('cycleNetFlow')} title="Cycle Net Flow"
                  columnKey="cycleNetFlow" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-sky-50 font-medium ${clr(fv('totalCash'))}`}
                  display={f2(fv('totalCash'))}
                  formula={fFormula('totalCash')} defaultFormula={SIM_FIELD_BY_KEY.totalCash.defaultFormula}
                  onCommit={fCommit('totalCash')} error={fErr('totalCash')} title="Total Cash"
                  columnKey="totalCash" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-sky-100 font-medium ${clr(fv('totalCashUSD'))}`}
                  display={f2(fv('totalCashUSD'))}
                  formula={fFormula('totalCashUSD')} defaultFormula={SIM_FIELD_BY_KEY.totalCashUSD.defaultFormula}
                  onCommit={fCommit('totalCashUSD')} error={fErr('totalCashUSD')} title="Total Cash $USD"
                  columnKey="totalCashUSD" rowKey={r.ccy} />
                </>)}

                {/* IR / FIXED-RATE BOOK */}
                {showBonds && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_asset_notional`] ?? n(r.ir_asset_notional)}
                    onChange={e => editRow(r.id, 'ir_asset_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_asset_notional')}
                    className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_asset_rate`] ?? n(r.ir_asset_rate)}
                    onChange={e => editRow(r.id, 'ir_asset_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_asset_rate')}
                    className={`${inBase} w-[46px]`} />
                </td>
                </>)}
                {showInvestments && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_notional`] ?? n((r.ir_invest_notional ?? 0))}
                    onChange={e => editRow(r.id, 'ir_invest_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_notional')}
                    className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_invest_rate`] ?? n((r.ir_invest_rate ?? 0))}
                    onChange={e => editRow(r.id, 'ir_invest_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_invest_rate')}
                    className={`${inBase} w-[46px]`} />
                </td>
                </>)}
                {showLiabilities && (<>
                <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_notional`] ?? n(r.ir_liab_notional)}
                    onChange={e => editRow(r.id, 'ir_liab_notional', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_notional')}
                    className={`${inBase} w-[58px]`} />
                </td>
                <td className={`${tdBase} bg-rose-50`}>
                  <input type="text" inputMode="decimal" value={drafts[`${r.id}.ir_liab_rate`] ?? n(r.ir_liab_rate)}
                    onChange={e => editRow(r.id, 'ir_liab_rate', e.target.value)}
                    onBlur={() => blurRow(r.id, 'ir_liab_rate')}
                    className={`${inBase} w-[46px]`} />
                </td>
                </>)}

{showCarry && (<>
                {/* CARRY / BUFFER */}
                <td className={`${tdBase} bg-amber-50 border-l border-gray-300 text-center`}>
                  <CarryBadge dir={r.carryDir} />
                </td>
                <FormulaCell
                  tdClass={`${tdBase} bg-amber-50 font-semibold text-amber-900`}
                  display={<>{f2(fv('targetNpCash'))}{r.funding_binding && <span className="ml-0.5 text-xs text-red-600" title="USD funding bind — target trimmed">⛓</span>}</>}
                  formula={fFormula('targetNpCash')} defaultFormula={SIM_FIELD_BY_KEY.targetNpCash.defaultFormula}
                  onCommit={fCommit('targetNpCash')} error={fErr('targetNpCash')} title="Target NP Cash = Opening NP + Swap"
                  columnKey="targetNpCash" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-amber-100 font-semibold ${clr(fv('targetNpCashUSD'))}`}
                  display={<>{fmtThresholdUsd(fv('targetNpCashUSD'))}{r.debit_floor_binding && <span className="ml-0.5 text-xs text-amber-600" title="Expensive OD floor">⌊</span>}</>}
                  formula={fFormula('targetNpCashUSD')} defaultFormula={SIM_FIELD_BY_KEY.targetNpCashUSD.defaultFormula}
                  onCommit={fCommit('targetNpCashUSD')} error={fErr('targetNpCashUSD')} title="Target NP Cash $USD"
                  columnKey="targetNpCashUSD" rowKey={r.ccy} />
</>)}

                {showSwap && (<>
                {/* SWAP */}
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-50 border-l border-gray-300 font-semibold ${clr(fv('swapNear'))}`}
                  display={f2(fv('swapNear'))}
                  formula={fFormula('swapNear')} defaultFormula={SIM_FIELD_BY_KEY.swapNear.defaultFormula}
                  onCommit={fCommit('swapNear')} error={fErr('swapNear')} title="Swap near leg (model-optimised; override to force a value)"
                  columnKey="swapNear" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-100 font-semibold ${clr(fv('swapUSD'))}`}
                  display={fmtSwapUsd(fv('swapUSD'))}
                  formula={fFormula('swapUSD')} defaultFormula={SIM_FIELD_BY_KEY.swapUSD.defaultFormula}
                  onCommit={fCommit('swapUSD')} error={fErr('swapUSD')} title="Swap $USD"
                  columnKey="swapUSD" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-50 font-medium ${clr(fv('npSwap'))}`}
                  display={f2(fv('npSwap'))}
                  formula={fFormula('npSwap')} defaultFormula={SIM_FIELD_BY_KEY.npSwap.defaultFormula}
                  onCommit={fCommit('npSwap')} error={fErr('npSwap')} title="NP+Swap = Opening NP + Swap"
                  columnKey="npSwap" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-100 font-medium ${clr(fv('npSwapUSD'))}`}
                  display={fmtSwapUsd(fv('npSwapUSD'))}
                  formula={fFormula('npSwapUSD')} defaultFormula={SIM_FIELD_BY_KEY.npSwapUSD.defaultFormula}
                  onCommit={fCommit('npSwapUSD')} error={fErr('npSwapUSD')} title="NP+Swap $USD"
                  columnKey="npSwapUSD" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-50 font-medium ${clr(fv('cycleEnd'))}`}
                  display={f2(fv('cycleEnd'))}
                  formula={fFormula('cycleEnd')} defaultFormula={SIM_FIELD_BY_KEY.cycleEnd.defaultFormula}
                  onCommit={fCommit('cycleEnd')} error={fErr('cycleEnd')} title="Cycle End cash"
                  columnKey="cycleEnd" rowKey={r.ccy} />
                <FormulaCell
                  tdClass={`${tdBase} bg-emerald-100 font-medium ${clr(fv('cycleEndUSD'))}`}
                  display={fmtSwapUsd(fv('cycleEndUSD'))}
                  formula={fFormula('cycleEndUSD')} defaultFormula={SIM_FIELD_BY_KEY.cycleEndUSD.defaultFormula}
                  onCommit={fCommit('cycleEndUSD')} error={fErr('cycleEndUSD')} title="Cycle End $USD"
                  columnKey="cycleEndUSD" rowKey={r.ccy} />
                </>)}

                {showFxHedge && (<>
                {/* FX HEDGE — strategy-driven fwd / option legs (editable) */}
                <FormulaCell
                  tdClass={`${tdBase} bg-rose-50 border-l-2 border-rose-400 font-semibold ${
                    Math.abs(fv('fwdHedgeUSD')) < 0.005 ? 'text-gray-300' : fv('fwdHedgeUSD') < 0 ? 'text-red-600' : 'text-green-700'}`}
                  display={Math.abs(fv('fwdHedgeUSD')) < 0.005 ? '—' : f2(fv('fwdHedgeUSD'))}
                  formula={fFormula('fwdHedgeUSD')} defaultFormula={SIM_FIELD_BY_KEY.fwdHedgeUSD.defaultFormula}
                  onCommit={fCommit('fwdHedgeUSD')} error={fErr('fwdHedgeUSD')}
                  title="Fwd Hedge $USD — forward notional × spot"
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
                  title={strategy !== 'SWAP_FWD_OPT'
                    ? 'Option delta — select "Swap + Fwd + Option" strategy above to activate the written option'
                    : 'Option delta (ATM ≈ 0.5) — editable regardless of current forward size; takes effect once this row has a non-zero forecast to hedge'}>
                    <input
                      type="text" inputMode="decimal"
                    disabled={strategy !== 'SWAP_FWD_OPT'}
                    value={drafts[`${r.id}.hedgeDelta`] ?? n((hedgeDeltas[r.id] ?? 0.5))}
                      onChange={e => {
                        setDrafts(prev => ({ ...prev, [`${r.id}.hedgeDelta`]: e.target.value }));
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v >= 0 && v <= 1) setHedgeDeltas(prev => ({ ...prev, [r.id]: v }));
                      }}
                      onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next[`${r.id}.hedgeDelta`]; return next; })}
                    className={`${inBase} w-[36px] font-medium ${
                      strategy !== 'SWAP_FWD_OPT' ? 'text-gray-300 cursor-not-allowed' : 'text-rose-700'
                    }`}
                    />
                </td>
                <td className={`${tdBase} bg-rose-100 font-medium ${
                  Math.abs(hedgeCarry) < 0.005 ? 'text-gray-300'
                    : hedgeCarry >= 0 ? 'text-green-700' : 'text-red-600'
                }`}
                  title={`Fwd points $${f2(r.fwdCarryUsdYr)} + option δ-leg points $${f2(r.optCarryUsdYr)} = $${f2(hedgeCarry)}M/yr USD. Gross premium harvested $${f2(r.optPremiumUsdYr)}M/yr shown for reference — excluded from carry (offsets expected exercise cost at fair value)`}>
                  {usdCarry(hedgeCarry)}
                </td>
                <td className={`${tdBase} bg-rose-100 font-medium ${
                  Math.abs(residual) < 0.005 ? 'text-green-700' : clr(residual)
                }`}
                  title={`Net FX Forecast (${f2(r.netFxForecast)} M ${r.ccy}, incl. current book) + hedge legs = ${f2(residual)} M ${r.ccy} unhedged × spot = $${f2(swapNearUsd(r.ccy, residual))} USD M`}>
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
                        className={`${tdBase} bg-violet-50 border-l border-violet-300 font-mono ${
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
                {/* P&L — USD-denominated ($M/yr) */}
                {!pnlCarryOnly && (
                <td className={`${tdBase} bg-purple-50 border-l border-gray-300 font-semibold ${clr(swapNearUsd(r.ccy, r.netDelta))}`}
                  title={`Net FX delta ${f2(r.netDelta)} M ${r.ccy} × spot ${(CURRENCY_PARAMS[r.ccy]?.spot ?? 1).toFixed(4)} = $${f2(swapNearUsd(r.ccy, r.netDelta))} USD M`}>
                  ${f2(swapNearUsd(r.ccy, r.netDelta))}
                </td>
                )}
                <td className={`${tdBase} bg-purple-50 font-medium ${pnlCarryOnly ? 'border-l border-gray-300' : ''} ${r.floatNim >= 0 ? 'text-green-700' : 'text-red-600'}`}
                  title={`Post-swap economic cash carry (USD): NP+Swap ${f2(r.postSwapCash)}M ${r.ccy} × spot × (${r.postSwapCash >= 0 ? `credit ${r.r_FCY.toFixed(2)}%` : `debit ${r.r_OD.toFixed(2)}%`} − r_USD ${shared.r_USD.toFixed(2)}%) / 100 = $${f2(r.floatNim)}M/yr. Opening cash swapped away is not counted — CIP cancels that differential through the swap points.`}>
                  {usdCarry(r.floatNim, 0)}
                </td>
                <td className={`${tdBase} bg-purple-50 font-medium ${
                  Math.abs(r.swapCarryUsdYr) < 0.005 ? 'text-gray-300'
                    : r.swapCarryUsdYr >= 0 ? 'text-green-700' : 'text-red-600'
                }`}
                  title="FX swap at mid vs term SOFR is CIP carry-neutral: earn/pay on the moved FCY notional is cancelled by the opposite swap points P&L. Economic carry sits entirely in Cash Carry on the post-swap balance.">
                  {usdCarry(r.swapCarryUsdYr)}
                </td>
                {!pnlCarryOnly && (<>
                <td className={`${tdBase} bg-purple-50 font-medium ${
                  Math.abs(hedgeCarry) < 0.005 ? 'text-gray-300'
                    : hedgeCarry >= 0 ? 'text-green-700' : 'text-red-600'
                }`}
                  title="FX hedge carry (USD) — same value as Hedge Carry in the FX HEDGE section">
                  {usdCarry(hedgeCarry)}
                </td>
                <td className={`${tdBase} bg-purple-100 font-semibold ${
                  (r.floatNim + r.swapCarryUsdYr + (R?.hedgeCarryUsdYr ?? r.hedgeCarryUsdYr)) >= 0 ? 'text-emerald-700' : 'text-red-600'
                }`}
                  title="Total annual USD carry = post-swap Cash Carry (CIP-neutral swap → Swap Carry 0) + Hedge Carry">
                  {usdCarry(r.floatNim + r.swapCarryUsdYr + (R?.hedgeCarryUsdYr ?? r.hedgeCarryUsdYr), 0)}
                </td>
                </>)}
                </>)}
              </tr>
              );
            })}

            {/* ── USD row ── */}
            <tr className="border-t-2 border-blue-400 bg-blue-50/40 font-medium">
              <td className="sticky left-0 z-20 bg-blue-100 px-1.5 py-0.5 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]">
                <span className="text-xs font-bold text-blue-800 px-0.5">USD</span>
              </td>

              {/* RATES */}
              {ratesOn && (<>
              <td className={`${tdBase} bg-gray-50 border-l border-gray-300`}>
                <input type="text" inputMode="decimal" value={drafts['usd.r_FCY'] ?? n(usdParams.r_FCY)}
                  onChange={e => editUsd('r_FCY', e.target.value)}
                  onBlur={() => blurUsd('r_FCY')}
                  className={`${inBase} w-[52px]`} />
              </td>
              <td className={`${tdBase} bg-gray-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.r_OD'] ?? n(usdParams.r_OD)}
                  onChange={e => editUsd('r_OD', e.target.value)}
                  onBlur={() => blurUsd('r_OD')}
                  className={`${inBase} w-[52px]`} />
              </td>
              <td className={`${tdBase} bg-gray-50 font-medium ${dclr(usdComputed.delta_r)}`}>
                {usdComputed.delta_r > 0 ? '+' : ''}{f2(usdComputed.delta_r)}%
              </td>
              </>)}

              {/* FX POSITION — USD balancing leg */}
              {showFxPosition && (<>
              <td className={`${tdBase} bg-white border-l border-gray-300 text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxSpotUSD)}`}>{f2(usdComputed.fxSpotUSD)}</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxFwdUSD)}`}>{f2(usdComputed.fxFwdUSD)}</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxNonCashAssetUSD)}`}
                title="USD is the balancing leg — nets the Σ non-cash asset FX across all FCY rows">{f2(usdComputed.fxNonCashAssetUSD)}</td>
              <td className={`${tdBase} bg-white text-gray-400`}>—</td>
              <td className={`${tdBase} bg-white font-medium ${clr(usdComputed.fxNonCashUSD)}`}>{f2(usdComputed.fxNonCashUSD)}</td>
              {simplifiedFx && (<>
              <td className={`${tdBase} bg-white`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? n(usdParams.ir_liab_notional)}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  className={`${inBase} w-[58px] ${usdParams.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? n(usdParams.ir_liab_notional)}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  className={`${inBase} w-[62px] font-medium ${usdParams.ir_liab_notional < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? n((usdParams.ir_invest_notional ?? 0))}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  className={`${inBase} w-[58px] ${(usdParams.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-white`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? n((usdParams.ir_invest_notional ?? 0))}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  className={`${inBase} w-[62px] font-medium ${(usdParams.ir_invest_notional ?? 0) < 0 ? 'text-red-600' : ''}`} />
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
              <td className={`${tdBase} bg-sky-50 border-l border-sky-200`}>
                <input type="text" inputMode="decimal" value={drafts['usd.cash'] ?? n(usdCash)}
                  onChange={e => {
                    setDrafts(prev => ({ ...prev, 'usd.cash': e.target.value }));
                    const v = roundMoney(parseFloat(e.target.value));
                    if (!isNaN(v)) setUsdCash(v);
                  }}
                  onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next['usd.cash']; return next; })}
                  className={`${inBase} w-[58px] ${usdCash < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-sky-100 font-medium ${clr(usdComputed.cash)}`}>{f2(usdComputed.cash)}</td>
              <td className={`${tdBase} bg-sky-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.payout'] ?? n(usdParams.payout)}
                  onChange={e => editUsd('payout', e.target.value)}
                  onBlur={() => blurUsd('payout')}
                  className={`${inBase} w-[62px] ${usdParams.payout < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-sky-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.collections'] ?? n(usdParams.collections)}
                  onChange={e => editUsd('collections', e.target.value)}
                  onBlur={() => blurUsd('collections')}
                  className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-sky-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.nonNpCash'] ?? n(usdNonNpCash)}
                  onChange={e => {
                    setDrafts(prev => ({ ...prev, 'usd.nonNpCash': e.target.value }));
                    const v = roundMoney(parseFloat(e.target.value));
                    if (!isNaN(v)) setUsdNonNpCash(v);
                  }}
                  onBlur={() => setDrafts(prev => { const next = { ...prev }; delete next['usd.nonNpCash']; return next; })}
                  className={`${inBase} w-[58px] ${usdNonNpCash < 0 ? 'text-red-600' : ''}`} />
              </td>
              <td className={`${tdBase} bg-sky-100 font-semibold ${
                usdComputed.np_peak_cash >= usdComputed.cash_threshold ? 'text-green-700'
                : usdComputed.np_peak_cash >= 0               ? 'text-amber-700'
                : 'text-red-600'
              }`}>{f2(usdComputed.np_peak_cash)}</td>
              <td className={`${tdBase} bg-sky-100 font-medium ${
                usdComputed.cash_after_payins >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
                title={`NP (${f2(usdComputed.cash)}) + Non-NP (${f2(usdComputed.nonNpCash)}) + Payouts (${f2(usdComputed.payout)}) + Payins (${f2(usdComputed.collections)}) = ${f2(usdComputed.cash_after_payins)} M USD — before swap`}>
                {f2(usdComputed.cash_after_payins)}
              </td>
              <td className={`${tdBase} bg-sky-50 font-medium ${clr(usdComputed.cashPos)}`}>{f2(usdComputed.cashPos)}</td>
              <td className={`${tdBase} bg-sky-100 font-medium ${clr(usdComputed.cashPosUSD)}`}>{f2(usdComputed.cashPosUSD)}</td>
              </>)}

              {/* IR / FIXED-RATE BOOK — USD */}
              {showBonds && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_asset_notional'] ?? n(usdParams.ir_asset_notional)}
                  onChange={e => editUsd('ir_asset_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_asset_notional')}
                  className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_asset_rate'] ?? n(usdParams.ir_asset_rate)}
                  onChange={e => editUsd('ir_asset_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_asset_rate')}
                  className={`${inBase} w-[46px]`} />
              </td>
              </>)}
              {showInvestments && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_invest_notional'] ?? n((usdParams.ir_invest_notional ?? 0))}
                  onChange={e => editUsd('ir_invest_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_notional')}
                  className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_invest_rate'] ?? n((usdParams.ir_invest_rate ?? 0))}
                  onChange={e => editUsd('ir_invest_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_invest_rate')}
                  className={`${inBase} w-[46px]`} />
              </td>
              </>)}
              {showLiabilities && (<>
              <td className={`${tdBase} bg-rose-50 border-l border-rose-200`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_liab_notional'] ?? n(usdParams.ir_liab_notional)}
                  onChange={e => editUsd('ir_liab_notional', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_notional')}
                  className={`${inBase} w-[58px]`} />
              </td>
              <td className={`${tdBase} bg-rose-50`}>
                <input type="text" inputMode="decimal" value={drafts['usd.ir_liab_rate'] ?? n(usdParams.ir_liab_rate)}
                  onChange={e => editUsd('ir_liab_rate', e.target.value)}
                  onBlur={() => blurUsd('ir_liab_rate')}
                  className={`${inBase} w-[46px]`} />
              </td>
              </>)}

              {/* CARRY / BUFFER */}
{showCarry && (<>
              <td className={`${tdBase} bg-amber-50 border-l border-gray-300 text-center`}>
                <CarryBadge dir={usdComputed.carryDir} />
              </td>
              <td className={`${tdBase} bg-amber-50 font-semibold text-amber-900`}
                title={`Opening NP ($${f2(usdComputed.cash)}) + Swap ($${f2(usdComputed.swapNear)}) = $${f2(usdComputed.cash_threshold)}M · payout reserve H* $${f2(usdComputed.cash_threshold_pre_swap)}M${usdComputed.funding_binding ? ' — USD funding bind' : ''}`}>
                {f2(usdComputed.cash_threshold)}
                {usdComputed.funding_binding && (
                  <span className="ml-0.5 text-xs text-red-600" title="USD funding bind">⛓</span>
                )}
              </td>
              <td className={`${tdBase} bg-amber-100 font-semibold text-amber-900`}
                title={`USD Target = opening NP + swap = ${fmtThresholdUsd(usdComputed.cashThresholdUSD)}`}>
                {fmtThresholdUsd(usdComputed.cashThresholdUSD)}
                {usdComputed.funding_binding && (
                  <span className="ml-0.5 text-xs text-red-600" title="USD funding bind">⛓</span>
                )}
              </td>
              </>)}

              {showSwap && (<>
              {/* SWAP */}
              <td className={`${tdBase} bg-emerald-50 border-l border-gray-300 font-semibold ${clr(usdComputed.swapNear)}`}
                title="USD funding leg (already in $M)">
                {f2(usdComputed.swapNear)}
              </td>
              <td className={`${tdBase} bg-emerald-100 font-semibold ${clr(usdComputed.swapNear)}`}
                title="USD funding leg — offsets Σ(FCY swap × spot)">
                {fmtSwapUsd(usdComputed.swapNear)}
              </td>
              <td className={`${tdBase} bg-emerald-50 font-medium ${clr(usdComputed.postSwapCash)}`}
                title={`Opening NP ($${f2(usdComputed.cash)}) + Swap ($${f2(usdComputed.swapNear)}) = $${f2(usdComputed.postSwapCash)}M — funded position before payout`}>
                {f2(usdComputed.postSwapCash)}
              </td>
              <td className={`${tdBase} bg-emerald-100 font-medium ${clr(usdComputed.postSwapUSD)}`}
                title="Opening NP $USD + Swap $USD at near leg">
                {fmtSwapUsd(usdComputed.postSwapUSD)}
              </td>
              <td className={`${tdBase} bg-emerald-50 font-medium ${clr(usdComputed.cycleEndCash)}`}
                title={`NP+Swap ($${f2(usdComputed.postSwapCash)}) + Payout ($${f2(usdComputed.payout)}) + Payins ($${f2(usdComputed.collections)}) + Non-NP sweep ($${f2(usdComputed.nonNpCash)}) = $${f2(usdComputed.cycleEndCash)}M`}>
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
              <td className={`${tdBase} bg-rose-100 font-bold ${
                Math.abs(hedgeTotals.hedgeCarryUsdYr) < 0.005 ? 'text-gray-400'
                  : hedgeTotals.hedgeCarryUsdYr >= 0 ? 'text-green-700' : 'text-red-600'
              }`}>
                {usdCarry(hedgeTotals.hedgeCarryUsdYr)}
              </td>
              <td className={`${tdBase} bg-rose-100 text-gray-400 text-xs`}>USD offset</td>
</>)}

              {showRiskMetrics && (
                <>
                  <td className={`${tdBase} bg-violet-50 border-l border-violet-300 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-violet-50 text-gray-400 text-xs`}>—</td>
                  <td className={`${tdBase} bg-violet-100 text-gray-400 text-xs`} title="Reporting CCY — no FX mismatch VaR">—</td>
                </>
              )}

              {showPnl && (<>
              {/* P&L */}
              {!pnlCarryOnly && (
              <td className={`${tdBase} bg-purple-50 border-l border-gray-300 font-semibold ${clr(usdComputed.netDelta)}`}>${f2(usdComputed.netDelta)}</td>
              )}
              <td className={`${tdBase} bg-purple-50 font-medium ${pnlCarryOnly ? 'border-l border-gray-300' : ''} ${usdComputed.floatNim >= 0 ? 'text-green-700' : 'text-red-600'}`} title="USD is the base currency — Δr = 0, no carry vs itself">{usdCarry(usdComputed.floatNim, 0)}</td>
              <td className={`${tdBase} bg-purple-50 text-gray-400 text-xs`} title="USD is the funding leg — its interest effect is inside each FCY swap carry">—</td>
              {!pnlCarryOnly && (<>
              <td className={`${tdBase} bg-purple-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-purple-100 text-gray-400 text-xs`}>—</td>
              </>)}
              </>)}
            </tr>

            {/* ── Totals row ── */}
            <tr className="border-t-2 border-gray-400 bg-gray-100 font-semibold">
              <td className="sticky left-0 z-20 bg-gray-100 px-2 py-1 text-xs font-bold text-gray-700 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.12)]">TOTAL</td>

              {/* RATES — blank */}
              {ratesOn && (
              <td className="bg-gray-50 border-l border-gray-300" colSpan={3} />
              )}

              {/* FX POSITION — FCY not additive; validate $USD columns */}
              {showFxPosition && (<>
              <td className={`${tdBase} bg-white border-l border-gray-300 text-gray-400 text-xs`}>—</td>
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
              <td className={`${tdBase} bg-sky-50 border-l border-sky-200 text-gray-400 text-xs`} title="M FCY balances are not additive across currencies">—</td>
              <td className={`${tdBase} bg-sky-100 font-bold ${clr(npCashUsdTotal)}`}
                title="Σ NP Cash $USD across all CCY + USD">
                {f2(npCashUsdTotal)}
              </td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-sky-100 font-bold border border-sky-300 ${zeroSumCls(fxUsdTotals.cashPos)}`}
                title="Σ Total Cash $USD (NP + Non-NP) across all CCY + USD">
                {fmtZeroSumUsd(fxUsdTotals.cashPos)}
              </td>
              </>)}

              {/* IR / FIXED-RATE BOOK — M FCY not additive across currencies */}
              {showIrBook && (
                <td className="bg-rose-50 border-l border-rose-200 text-gray-400 text-xs text-center" colSpan={irCols}>—</td>
              )}

{showCarry && (<>
              {/* CARRY / BUFFER */}
              <td className="bg-amber-50 border-l border-gray-300" />
              <td className={`${tdBase} bg-amber-50 text-gray-400 text-xs`} title="M FCY thresholds are not additive across currencies">—</td>
              <td className={`${tdBase} bg-amber-100 font-bold ${clr(thresholdUsdTotal)}`}>{fmtThresholdUsd(thresholdUsdTotal)}</td>
              </>)}

              {showSwap && (<>
              {/* SWAP — FCY units not additive; validate in $USD column */}
              <td className={`${tdBase} bg-emerald-50 border-l border-gray-300 text-gray-400 text-xs`} title="M FCY swap legs are not additive across currencies">—</td>
              <td className={`${tdBase} font-bold border border-emerald-300 ${
                Math.abs(swapNearUsdTotal) < 0.01 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
              }`}
                title="Σ (swap × spot) across all CCY + USD — must equal 0">
                {Math.abs(swapNearUsdTotal) < 0.01
                  ? <><span className="mr-1">✓</span>{f2(0)}<span className="ml-1 text-xs font-normal">zero-sum</span></>
                  : <><span className="mr-1">⚠</span>{fmtSwapUsd(swapNearUsdTotal)}</>}
              </td>
              <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`} title="M FCY NP after swap is not additive across currencies">—</td>
              <td className={`${tdBase} bg-emerald-100 font-bold border border-emerald-200 ${clr(postSwapUsdTotal)}`}
                title={`Σ (Opening NP + Swap) $USD — swap zero-sum, so = Σ opening NP $USD`}>
                {fmtSwapUsd(postSwapUsdTotal)}
              </td>
              <td className={`${tdBase} bg-emerald-50 text-gray-400 text-xs`} title="M FCY cycle end is not additive across currencies">—</td>
              <td className={`${tdBase} bg-emerald-100 font-bold border border-emerald-200 ${clr(cycleEndUsdTotal)}`}
                title={`Σ Cycle End $USD (NP+Swap − payout + payins + Non-NP sweep) — before far leg`}>
                {fmtSwapUsd(cycleEndUsdTotal)}
              </td>
              </>)}

              {showFxHedge && (<>
              {/* FX HEDGE totals — 5 cols: fwd, option, δ, hedge carry, residual */}
              <td className={`${tdBase} bg-rose-50 border-l-2 border-rose-400 font-bold ${Math.abs(hedgeTotals.fwdUSD) < 0.005 ? 'text-gray-400 text-xs font-normal' : clr(hedgeTotals.fwdUSD)}`}
                title="Σ forward notionals in $USD across all FCY rows">
                {Math.abs(hedgeTotals.fwdUSD) < 0.005 ? '—' : fmtSwapUsd(hedgeTotals.fwdUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 font-bold ${Math.abs(hedgeTotals.optUSD) < 0.005 ? 'text-gray-400 text-xs font-normal' : clr(hedgeTotals.optUSD)}`}
                title="Σ delta-effective option hedges (δ × written notional) in $USD across all FCY rows">
                {Math.abs(hedgeTotals.optUSD) < 0.005 ? '—' : fmtSwapUsd(hedgeTotals.optUSD)}
              </td>
              <td className={`${tdBase} bg-rose-50 text-gray-400 text-xs`}>—</td>
              <td className={`${tdBase} bg-rose-100 font-bold ${
                Math.abs(hedgeTotals.hedgeCarryUsdYr) < 0.005 ? 'text-gray-400 text-xs font-normal'
                  : hedgeTotals.hedgeCarryUsdYr >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
                title="Σ FX hedge carry across all rows ($M/yr USD): fwd points + option δ-leg delivery points; gross option premium excluded (offsets expected exercise cost at fair value)">
                {hedgeTotals.hedgeCarryUsdYr === 0 ? '—' : `${usdCarry(hedgeTotals.hedgeCarryUsdYr)}/yr`}
              </td>
              <td className={`${tdBase} bg-rose-100 font-bold ${Math.abs(hedgeTotals.residUSD) < 0.005 ? 'text-green-700' : clr(hedgeTotals.residUSD)}`}
                title="Σ residual (unhedged) FX exposure across all FCY rows, $USD M">
                {Math.abs(hedgeTotals.residUSD) < 0.005 ? '✓ 0.00' : fmtSwapUsd(hedgeTotals.residUSD)}
              </td>
</>)}

              {showRiskMetrics && (
                <>
                  <td
                    className={`${tdBase} bg-violet-50 border-l border-violet-300 font-bold ${
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
              {/* P&L totals — USD-denominated ($M/yr); Net Delta $USD is additive across currencies */}
              {!pnlCarryOnly && (
              <td className={`${tdBase} bg-purple-50 border-l border-gray-300 font-bold ${clr(netDeltaUsdTotal)}`}
                title="Σ net FX delta across all rows, converted to $USD at spot">
                ${f2(netDeltaUsdTotal)}
              </td>
              )}
              <td className={`${tdBase} bg-purple-50 font-bold ${pnlCarryOnly ? 'border-l border-gray-300' : ''} ${floatNimUsdTotal >= 0 ? 'text-green-700' : 'text-red-600'}`}
                title="Σ post-swap economic cash carry across all rows, $M/yr USD — O/N earn/pay on the funded NP balance after CIP-neutral swaps">
                {usdCarry(floatNimUsdTotal, 0)}
              </td>
              <td className={`${tdBase} bg-purple-50 font-bold ${swapCarryTotal >= 0 ? 'text-green-700' : 'text-red-600'}`}
                title="Σ swap P&L — identically 0 under CIP (cancelled into Cash Carry on the post-swap balance)">
                {usdCarry(swapCarryTotal, 0)}
              </td>
              {!pnlCarryOnly && (<>
              <td className={`${tdBase} bg-purple-50 font-bold ${
                Math.abs(hedgeTotals.hedgeCarryUsdYr) < 0.005 ? 'text-gray-400 text-xs font-normal'
                  : hedgeTotals.hedgeCarryUsdYr >= 0 ? 'text-green-700' : 'text-red-600'
              }`}
                title="Σ FX hedge carry across all rows, $M/yr USD — counted separately">
                {usdCarry(hedgeTotals.hedgeCarryUsdYr)}
              </td>
              <td className={`${tdBase} bg-purple-100 font-bold border border-purple-200 ${totalCarryUsd >= 0 ? 'text-emerald-700' : 'text-red-600'}`}
                title="Total annual USD carry = cash float + swap interest + FX hedge uplift">
                {usdCarry(totalCarryUsd, 0)}
                <span className="text-gray-400 ml-0.5 text-xs">M/yr</span>
              </td>
              </>)}
              </>)}
            </tr>
          </tbody>
        </table>
        </FormulaGridProvider>
      </div>
    </div>
  );
}
