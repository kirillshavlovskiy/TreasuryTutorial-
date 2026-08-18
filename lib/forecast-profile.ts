// Multi-period FX forecast profile — flat monthly×T (workspace formula) or
// custom cash inflow / outflow lines per month within the forecasting period.

import {
  roundMoney,
  computeLayeredBuffer,
  computeFcySwapNear,
  liquidityFormulaLayersActive,
  type RowState,
  type SharedGlobals,
  type LayerId,
  type LayeredBufferResult,
} from '@/lib/fx-buffer';
import { safeEval, type Scope } from '@/lib/formula';
// Type-only: the ladder engine imports this module at runtime, not the reverse.
import type { LiquidityBookingMode, LiquidityTiming } from '@/lib/liquidity-ladder';

export type ForecastFlowMode = 'flat' | 'custom';

/** Signed monthly cash legs beyond workspace Revenue / Expenses / invoice fcast. */
export interface ForecastCashExtras {
  /** Receivables / NWC collections planned (M FCY, ≥ 0). */
  nwcIn: number;
  /** Payables / NWC settlements (M FCY, ≤ 0). */
  nwcOut: number;
  /** Debt drawdown (M FCY, ≥ 0). */
  debtIn: number;
  /** Debt repayment (M FCY, ≤ 0). */
  debtOut: number;
  /** Investment maturity / sale proceeds (M FCY, ≥ 0). */
  investIn: number;
  /** New investment / placement (M FCY, ≤ 0). */
  investOut: number;
  /** Other inflows (M FCY, ≥ 0). */
  otherIn: number;
  /** Other outflows (M FCY, ≤ 0). */
  otherOut: number;
}

export const EMPTY_FORECAST_EXTRAS: ForecastCashExtras = {
  nwcIn: 0,
  nwcOut: 0,
  debtIn: 0,
  debtOut: 0,
  investIn: 0,
  investOut: 0,
  otherIn: 0,
  otherOut: 0,
};

/** Default company cash / FX / liquidity forecast horizon (months). */
export const DEFAULT_FORECAST_MONTHS = 12;

/**
 * Default store-receivables collection per month (M FCY) over the 12-month
 * projection. Debt repayment is not in this window — it lands after Tf.
 */
export const DEFAULT_STORE_RECEIVABLES_MONTHLY_M = 0.2;

/** Working-capital extras: collect store AR monthly; do not repay debt inside Tf. */
export function defaultCompanyCashExtras(): ForecastCashExtras {
  return {
    ...EMPTY_FORECAST_EXTRAS,
    nwcIn: DEFAULT_STORE_RECEIVABLES_MONTHLY_M,
    debtOut: 0,
  };
}

/**
 * One month of cash inflows / outflows. Signs match RowState:
 * inflows ≥ 0, outflows ≤ 0.
 */
export interface ForecastMonthFlow extends ForecastCashExtras {
  /** Operating collections / payins (M FCY, ≥ 0). */
  collections: number;
  /** Operating payouts / expenses (M FCY, ≤ 0). */
  payout: number;
  /**
   * Invoice / AR forecast inflow (M FCY, ≥ 0).
   * Flat mode seeds from `row.fcastFX`; older profiles may fold this into collections.
   */
  invoiceFcast: number;
}

/** Editable cash-flow line ids in the Forecast profile modal. */
export type ForecastFlowField =
  | 'collections'
  | 'invoiceFcast'
  | 'nwcIn'
  | 'debtIn'
  | 'investIn'
  | 'otherIn'
  | 'payout'
  | 'nwcOut'
  | 'debtOut'
  | 'investOut'
  | 'otherOut';

export type ForecastFlowSide = 'in' | 'out';

export const FORECAST_FLOW_LINES: {
  key: ForecastFlowField;
  label: string;
  side: ForecastFlowSide;
  title: string;
}[] = [
  {
    key: 'collections',
    label: 'Revenue',
    side: 'in',
    title: 'Operating collections / payins (M FCY)',
  },
  {
    key: 'invoiceFcast',
    label: 'Invoice fcast',
    side: 'in',
    title: 'Invoice / AR forecast inflow (M FCY)',
  },
  {
    key: 'nwcIn',
    label: 'NWC in',
    side: 'in',
    title: 'Receivables / NWC collections planned (M FCY)',
  },
  {
    key: 'debtIn',
    label: 'Debt draw',
    side: 'in',
    title: 'Debt drawdown / new borrowing (M FCY)',
  },
  {
    key: 'investIn',
    label: 'Invest in',
    side: 'in',
    title: 'Investment maturity / sale proceeds (M FCY)',
  },
  {
    key: 'otherIn',
    label: 'Other in',
    side: 'in',
    title: 'Other cash inflows (M FCY)',
  },
  {
    key: 'payout',
    label: 'Expenses',
    side: 'out',
    title: 'Operating expenses / payouts (M FCY)',
  },
  {
    key: 'nwcOut',
    label: 'NWC out',
    side: 'out',
    title: 'Payables / NWC settlements (M FCY)',
  },
  {
    key: 'debtOut',
    label: 'Debt repay',
    side: 'out',
    title: 'Debt repayment / amortization (M FCY)',
  },
  {
    key: 'investOut',
    label: 'Invest out',
    side: 'out',
    title: 'New investment / placement (M FCY)',
  },
  {
    key: 'otherOut',
    label: 'Other out',
    side: 'out',
    title: 'Other cash outflows (M FCY)',
  },
];

/** Balance-sheet families for Forecast profile modal section rows. */
export const FORECAST_FLOW_GROUPS: {
  id: string;
  label: string;
  keys: readonly ForecastFlowField[];
}[] = [
  { id: 'operating', label: 'Operating', keys: ['collections', 'payout'] },
  { id: 'nwc', label: 'Working capital', keys: ['nwcIn', 'nwcOut'] },
  { id: 'financing', label: 'Financing', keys: ['debtIn', 'debtOut'] },
  { id: 'investing', label: 'Investing', keys: ['investIn', 'investOut'] },
  { id: 'receivables', label: 'Receivables', keys: ['invoiceFcast'] },
  { id: 'other', label: 'Other', keys: ['otherIn', 'otherOut'] },
];

const FLOW_LINE_BY_KEY = Object.fromEntries(
  FORECAST_FLOW_LINES.map(l => [l.key, l]),
) as Record<ForecastFlowField, (typeof FORECAST_FLOW_LINES)[number]>;

/** Lines in BS-family order (Operating → … → Other). */
export function forecastFlowLinesGrouped(): (typeof FORECAST_FLOW_LINES)[number][] {
  const out: (typeof FORECAST_FLOW_LINES)[number][] = [];
  for (const g of FORECAST_FLOW_GROUPS) {
    for (const key of g.keys) {
      const line = FLOW_LINE_BY_KEY[key];
      if (line) out.push(line);
    }
  }
  return out;
}

/**
 * Temporary calculation row (custom mode) — not part of Net / cash sources.
 * Referenced in formulas as `idx1`, `idx1m3`, etc.
 */
export interface ForecastCalcRow {
  id: string;
  label: string;
  /** Formula identifier, e.g. idx1 — must match /^[A-Za-z_][A-Za-z0-9_]*$/. */
  ref: string;
}

export interface ForecastProfileState {
  mode: ForecastFlowMode;
  /** Per-CCY month series; length should equal forecastMonths when mode = custom. */
  byCcy: Record<string, ForecastMonthFlow[]>;
  /**
   * Flat-mode monthly extras beyond row Revenue / Expenses / invoice fcast.
   * Applied every month (with MoM growth when set).
   */
  extrasByCcy: Record<string, ForecastCashExtras>;
  /**
   * Optional Excel-like overrides for period cells.
   * Keys: `${ccy}::${field}::${monthIndex}`
   * (outflow formulas are entered as positive outflows, same as the modal).
   * Calc rows use field `calc_${id}`.
   */
  formulas: Record<string, string>;
  /**
   * Default month-on-month growth (0.05 = +5% MoM).
   * Flat: fallback when a line has no entry in flatGrowthByCcy.
   * Custom: seeds M_k = M₀×(1+g)^k when switching from flat.
   */
  growthRateMoM: number;
  /**
   * Flat-mode MoM growth per CCY × cash line (0.05 = +5% MoM).
   * Missing lines inherit growthRateMoM.
   */
  flatGrowthByCcy?: Record<string, Partial<Record<ForecastFlowField, number>>>;
  /**
   * 1m relative forecast uncertainty per CCY × cash line (0.10 = ±10% of that
   * month’s projection). Independent month errors compound as √g over the path.
   * Revenue (`collections`) feeds Analytics u₁ₘ when set.
   */
  uncertainty1mByCcy?: Record<
    string,
    Partial<Record<ForecastFlowField, number>>
  >;
  /** Temporary calc / index rows above cash sources (custom mode). */
  calcRowsByCcy?: Record<string, ForecastCalcRow[]>;
  /** Values for calc rows: calcByCcy[ccy][calcId][monthIndex]. */
  calcByCcy?: Record<string, Record<string, number[]>>;
  /**
   * Intra-cycle settlement timing for the liquidity book — when inside its
   * month each line lands. Monthly amounts above are unchanged, so FX exposure
   * and CFaR are unaffected; only the liquidity trough becomes dated.
   * Undefined takes the default (dated, worst-case shapes); `enabled: false`
   * keeps the lump-sum trough (cash + payout).
   */
  liquidity?: LiquidityTiming;
}

export const DEFAULT_FORECAST_PROFILE: ForecastProfileState = {
  mode: 'flat',
  byCcy: {},
  extrasByCcy: {},
  formulas: {},
  growthRateMoM: 0,
  flatGrowthByCcy: {},
  uncertainty1mByCcy: {},
  calcRowsByCcy: {},
  calcByCcy: {},
};

/** Flat forecast profile with store-receivables collections on the given FCYs. */
export function forecastProfileWithStoreReceivables(
  currencies: readonly string[],
): ForecastProfileState {
  const extrasByCcy: Record<string, ForecastCashExtras> = {};
  for (const ccy of currencies) {
    if (!ccy || ccy === 'USD') continue;
    extrasByCcy[ccy] = defaultCompanyCashExtras();
  }
  return { ...DEFAULT_FORECAST_PROFILE, extrasByCcy };
}

export function calcFieldKey(calcId: string): string {
  return `calc_${calcId}`;
}

export function isCalcFieldKey(field: string): boolean {
  return field.startsWith('calc_');
}

export function calcIdFromFieldKey(field: string): string | null {
  return isCalcFieldKey(field) ? field.slice('calc_'.length) : null;
}

/** Next free idxN ref for a CCY's calc rows. */
export function nextCalcRef(existing: readonly ForecastCalcRow[]): string {
  let n = 1;
  const used = new Set(existing.map(r => r.ref.toLowerCase()));
  while (used.has(`idx${n}`)) n += 1;
  return `idx${n}`;
}

export function newCalcRow(existing: readonly ForecastCalcRow[]): ForecastCalcRow {
  const ref = nextCalcRef(existing);
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : `c${Date.now().toString(36)}`;
  return {
    id,
    label: `Index ${ref.replace(/^idx/i, '')}`,
    ref,
  };
}

export function resizeCalcSeries(
  values: number[] | undefined,
  months: number,
): number[] {
  const T = Math.max(0, Math.round(months));
  if (T === 0) return [];
  const src = values ?? [];
  if (src.length === T) return src.map(v => (Number.isFinite(v) ? v : 0));
  if (src.length > T) return src.slice(0, T).map(v => (Number.isFinite(v) ? v : 0));
  return [
    ...src.map(v => (Number.isFinite(v) ? v : 0)),
    ...Array.from({ length: T - src.length }, () => 0),
  ];
}

/** 1m relative σ for one cash line (0 if unset). */
export function lineUncertainty1m(
  profile: ForecastProfileState | null | undefined,
  ccy: string,
  field: ForecastFlowField,
): number {
  const u = profile?.uncertainty1mByCcy?.[ccy]?.[field];
  return typeof u === 'number' && Number.isFinite(u) && u > 0 ? u : 0;
}

/** Max 1m σ across lines for a CCY (0 if none). */
export function maxLineUncertainty1m(
  profile: ForecastProfileState | null | undefined,
  ccy: string,
): number {
  const row = profile?.uncertainty1mByCcy?.[ccy];
  if (!row) return 0;
  let max = 0;
  for (const v of Object.values(row)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

/**
 * Quantity-risk u₁ₘ for Analytics / CFaR: max of global setup fallback and
 * any per-line σ on this CCY (Revenue preferred when present among lines).
 * Raising either the top-section chips or a Forecast-profile line raises risk;
 * previously a sticky line override ignored the global control entirely.
 */
export function effectiveForecastUncertainty1m(
  profile: ForecastProfileState | null | undefined,
  ccy: string,
  fallback = 0,
): number {
  const global =
    typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0
      ? fallback
      : 0;
  const rev = lineUncertainty1m(profile, ccy, 'collections');
  const line = rev > 0 ? rev : maxLineUncertainty1m(profile, ccy);
  return Math.max(global, line);
}

/** Drop all per-line projection σ so global Analytics / CFaR u₁ₘ applies. */
export function clearLineUncertainties(
  profile: ForecastProfileState,
): ForecastProfileState {
  if (
    !profile.uncertainty1mByCcy ||
    Object.keys(profile.uncertainty1mByCcy).length === 0
  ) {
    return profile;
  }
  return { ...profile, uncertainty1mByCcy: {} };
}

export function withLineUncertainty1m(
  profile: ForecastProfileState,
  ccy: string,
  field: ForecastFlowField,
  uncertainty1m: number,
): ForecastProfileState {
  const u =
    typeof uncertainty1m === 'number' &&
    Number.isFinite(uncertainty1m) &&
    uncertainty1m > 0
      ? uncertainty1m
      : 0;
  const byCcy = { ...(profile.uncertainty1mByCcy ?? {}) };
  const line = { ...(byCcy[ccy] ?? {}) };
  if (u > 0) line[field] = u;
  else delete line[field];
  if (Object.keys(line).length === 0) delete byCcy[ccy];
  else byCcy[ccy] = line;
  return { ...profile, uncertainty1mByCcy: byCcy };
}

export function emptyMonthFlow(): ForecastMonthFlow {
  return {
    collections: 0,
    payout: 0,
    invoiceFcast: 0,
    ...EMPTY_FORECAST_EXTRAS,
  };
}

export function normalizeMonthFlow(
  m: Partial<ForecastMonthFlow> | null | undefined,
): ForecastMonthFlow {
  const base = emptyMonthFlow();
  if (!m) return base;
  return {
    collections: Number.isFinite(m.collections) ? m.collections! : 0,
    payout: Number.isFinite(m.payout) ? m.payout! : 0,
    invoiceFcast: Number.isFinite(m.invoiceFcast) ? m.invoiceFcast! : 0,
    nwcIn: Number.isFinite(m.nwcIn) ? m.nwcIn! : 0,
    nwcOut: Number.isFinite(m.nwcOut) ? m.nwcOut! : 0,
    debtIn: Number.isFinite(m.debtIn) ? m.debtIn! : 0,
    debtOut: Number.isFinite(m.debtOut) ? m.debtOut! : 0,
    investIn: Number.isFinite(m.investIn) ? m.investIn! : 0,
    investOut: Number.isFinite(m.investOut) ? m.investOut! : 0,
    otherIn: Number.isFinite(m.otherIn) ? m.otherIn! : 0,
    otherOut: Number.isFinite(m.otherOut) ? m.otherOut! : 0,
  };
}

export function normalizeExtras(
  e: Partial<ForecastCashExtras> | null | undefined,
): ForecastCashExtras {
  const m = normalizeMonthFlow({ ...EMPTY_FORECAST_EXTRAS, ...e });
  return {
    nwcIn: m.nwcIn,
    nwcOut: m.nwcOut,
    debtIn: m.debtIn,
    debtOut: m.debtOut,
    investIn: m.investIn,
    investOut: m.investOut,
    otherIn: m.otherIn,
    otherOut: m.otherOut,
  };
}

export function extrasNet(e: ForecastCashExtras): number {
  return (
    e.nwcIn +
    e.debtIn +
    e.investIn +
    e.otherIn +
    e.nwcOut +
    e.debtOut +
    e.investOut +
    e.otherOut
  );
}

export function monthInflows(m: ForecastMonthFlow): number {
  const n = normalizeMonthFlow(m);
  return (
    n.collections +
    n.invoiceFcast +
    n.nwcIn +
    n.debtIn +
    n.investIn +
    n.otherIn
  );
}

export function monthOutflowsAbs(m: ForecastMonthFlow): number {
  const n = normalizeMonthFlow(m);
  return (
    Math.abs(Math.min(0, n.payout)) +
    Math.abs(Math.min(0, n.nwcOut)) +
    Math.abs(Math.min(0, n.debtOut)) +
    Math.abs(Math.min(0, n.investOut)) +
    Math.abs(Math.min(0, n.otherOut))
  );
}

export function monthNet(m: ForecastMonthFlow | Partial<ForecastMonthFlow>): number {
  const n = normalizeMonthFlow(m);
  return (
    n.collections +
    n.invoiceFcast +
    n.nwcIn +
    n.debtIn +
    n.investIn +
    n.otherIn +
    n.payout +
    n.nwcOut +
    n.debtOut +
    n.investOut +
    n.otherOut
  );
}

export function sumPeriodFlow(months: readonly ForecastMonthFlow[]): number {
  return roundMoney(months.reduce((s, m) => s + monthNet(m), 0));
}

export function flowFieldValue(m: ForecastMonthFlow, field: ForecastFlowField): number {
  const n = normalizeMonthFlow(m);
  return n[field];
}

/** UI displays outflows as positive magnitudes. */
export function flowFieldDisplay(
  m: ForecastMonthFlow,
  field: ForecastFlowField,
  side: ForecastFlowSide,
): number {
  const v = flowFieldValue(m, field);
  return side === 'out' ? Math.abs(Math.min(0, v)) : v;
}

export function flowFieldFromDisplay(
  display: number,
  side: ForecastFlowSide,
): number {
  const v = roundMoney(display);
  if (!Number.isFinite(v)) return 0;
  return side === 'out' ? -Math.abs(v) : v;
}

export function withFlowField(
  m: ForecastMonthFlow,
  field: ForecastFlowField,
  value: number,
): ForecastMonthFlow {
  return normalizeMonthFlow({ ...m, [field]: value });
}

/** True when the line has an explicit Growth % MoM override (including 0). */
export function hasFlatGrowthOverride(
  profile: ForecastProfileState | null | undefined,
  ccy: string,
  field: ForecastFlowField,
): boolean {
  const g = profile?.flatGrowthByCcy?.[ccy]?.[field];
  return typeof g === 'number' && Number.isFinite(g);
}

/** MoM growth for one flat cash line (explicit override or profile default). */
export function lineGrowthMoM(
  profile: ForecastProfileState | null | undefined,
  ccy: string,
  field: ForecastFlowField,
): number {
  if (hasFlatGrowthOverride(profile, ccy, field)) {
    return profile!.flatGrowthByCcy![ccy]![field]!;
  }
  const d = profile?.growthRateMoM;
  return typeof d === 'number' && Number.isFinite(d) ? d : 0;
}

function flatLineBaseM(
  row: RowState,
  extras: ForecastCashExtras,
  field: ForecastFlowField,
): number {
  if (field === 'collections') return roundMoney(row.collections);
  if (field === 'payout') return roundMoney(row.payout);
  if (field === 'invoiceFcast') return roundMoney(row.fcastFX ?? 0);
  return roundMoney(extras[field as keyof ForecastCashExtras] ?? 0);
}

/** One flat line at month index k: M₀×(1+g)^k. */
export function flatLineAtMonth(
  row: RowState,
  extras: ForecastCashExtras,
  profile: ForecastProfileState | null | undefined,
  field: ForecastFlowField,
  monthIndex: number,
): number {
  const M0 = flatLineBaseM(row, extras, field);
  const g = lineGrowthMoM(profile, row.ccy, field);
  if (monthIndex <= 0 || Math.abs(g) < 1e-15) return M0;
  return roundMoney(M0 * Math.pow(1 + g, monthIndex));
}

/** Σ_k M₀×(1+g)^k over the forecast period for one flat line. */
export function flatLinePeriodSum(
  row: RowState,
  extras: ForecastCashExtras,
  profile: ForecastProfileState | null | undefined,
  field: ForecastFlowField,
  forecastMonths: number,
): number {
  const T = Math.max(0, Math.floor(forecastMonths));
  if (T === 0) return 0;
  const M0 = flatLineBaseM(row, extras, field);
  const g = lineGrowthMoM(profile, row.ccy, field);
  if (Math.abs(g) < 1e-15) return roundMoney(M0 * T);
  return roundMoney((M0 * (Math.pow(1 + g, T) - 1)) / g);
}

/** Full month flow in flat mode with per-line MoM growth. */
export function flatMonthFlowAt(
  row: RowState,
  extras: ForecastCashExtras,
  profile: ForecastProfileState | null | undefined,
  monthIndex: number,
): ForecastMonthFlow {
  const flow = emptyMonthFlow();
  for (const line of FORECAST_FLOW_LINES) {
    flow[line.key] = flatLineAtMonth(
      row,
      extras,
      profile,
      line.key,
      monthIndex,
    );
  }
  return normalizeMonthFlow(flow);
}

/**
 * Seed T months from the row’s flat monthly Revenue / Expenses / invoice fcast
 * plus optional profile extras. Optional MoM growth compounds all legs.
 */
export function seedMonthsFromRow(
  row: RowState,
  months: number,
  growthRateMoM: number = 0,
  extras?: Partial<ForecastCashExtras> | null,
): ForecastMonthFlow[] {
  const T = Math.max(0, Math.floor(months));
  if (T === 0) return [];
  const ex = normalizeExtras(extras);
  const base = normalizeMonthFlow({
    collections: roundMoney(row.collections),
    payout: roundMoney(row.payout),
    invoiceFcast: roundMoney(row.fcastFX ?? 0),
    ...ex,
  });
  const g =
    typeof growthRateMoM === 'number' && Number.isFinite(growthRateMoM)
      ? growthRateMoM
      : 0;
  if (Math.abs(g) < 1e-15) {
    return Array.from({ length: T }, () => ({ ...base }));
  }
  return Array.from({ length: T }, (_, k) => {
    const factor = Math.pow(1 + g, k);
    return normalizeMonthFlow({
      collections: roundMoney(base.collections * factor),
      payout: roundMoney(base.payout * factor),
      invoiceFcast: roundMoney(base.invoiceFcast * factor),
      nwcIn: roundMoney(base.nwcIn * factor),
      nwcOut: roundMoney(base.nwcOut * factor),
      debtIn: roundMoney(base.debtIn * factor),
      debtOut: roundMoney(base.debtOut * factor),
      investIn: roundMoney(base.investIn * factor),
      investOut: roundMoney(base.investOut * factor),
      otherIn: roundMoney(base.otherIn * factor),
      otherOut: roundMoney(base.otherOut * factor),
    });
  });
}

/** Seed custom months from flat inputs with per-line MoM from the profile. */
export function seedMonthsFromRowWithLineGrowth(
  row: RowState,
  months: number,
  profile: ForecastProfileState | null | undefined,
  extras?: Partial<ForecastCashExtras> | null,
): ForecastMonthFlow[] {
  const T = Math.max(0, Math.floor(months));
  if (T === 0) return [];
  const ex = normalizeExtras(extras);
  return Array.from({ length: T }, (_, k) =>
    flatMonthFlowAt(row, ex, profile, k),
  );
}

/** Resize a series when the forecasting period changes. */
export function resizeMonthSeries(
  prev: ForecastMonthFlow[] | undefined,
  months: number,
  fallback: RowState,
  extras?: Partial<ForecastCashExtras> | null,
): ForecastMonthFlow[] {
  const T = Math.max(0, Math.floor(months));
  if (T === 0) return [];
  const base =
    prev && prev.length > 0
      ? prev.map(normalizeMonthFlow)
      : seedMonthsFromRow(fallback, T, 0, extras);
  if (base.length === T) return base.map(m => ({ ...m }));
  if (base.length > T) return base.slice(0, T).map(m => ({ ...m }));
  const last =
    base[base.length - 1] ?? seedMonthsFromRow(fallback, 1, 0, extras)[0]!;
  return [
    ...base.map(m => ({ ...m })),
    ...Array.from({ length: T - base.length }, () => ({ ...last })),
  ];
}

export function ensureProfileForRows(
  profile: ForecastProfileState,
  rows: readonly RowState[],
  months: number,
): ForecastProfileState {
  const byCcy: Record<string, ForecastMonthFlow[]> = { ...profile.byCcy };
  const extrasByCcy: Record<string, ForecastCashExtras> = {
    ...(profile.extrasByCcy ?? {}),
  };
  for (const r of rows) {
    if (r.ccy === 'USD') continue;
    const extras = normalizeExtras(extrasByCcy[r.ccy]);
    extrasByCcy[r.ccy] = extras;
    byCcy[r.ccy] = resizeMonthSeries(byCcy[r.ccy], months, r, extras);
  }
  const calcRowsByCcy: Record<string, ForecastCalcRow[]> = {
    ...(profile.calcRowsByCcy ?? {}),
  };
  const calcByCcy: Record<string, Record<string, number[]>> = {
    ...(profile.calcByCcy ?? {}),
  };
  for (const r of rows) {
    if (r.ccy === 'USD') continue;
    const rowsFor = calcRowsByCcy[r.ccy] ?? [];
    calcRowsByCcy[r.ccy] = rowsFor;
    const vals = { ...(calcByCcy[r.ccy] ?? {}) };
    for (const c of rowsFor) {
      vals[c.id] = resizeCalcSeries(vals[c.id], months);
    }
    calcByCcy[r.ccy] = vals;
  }
  return {
    ...profile,
    byCcy,
    extrasByCcy,
    growthRateMoM:
      typeof profile.growthRateMoM === 'number' &&
      Number.isFinite(profile.growthRateMoM)
        ? profile.growthRateMoM
        : 0,
    formulas: profile.formulas ?? {},
    flatGrowthByCcy: profile.flatGrowthByCcy ?? {},
    uncertainty1mByCcy: profile.uncertainty1mByCcy ?? {},
    calcRowsByCcy,
    calcByCcy,
  };
}

/**
 * Period flow sum used by Net FX Forecast / VaR buildup.
 * Flat (workspace): (collections + payout + fcastFX + extras) × T (or MoM path)
 * Custom: Σ month nets
 */
export function periodFlowSumLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number {
  const T =
    Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1;
  if (T === 0) return 0;
  if (profile?.mode === 'custom') {
    const months = resizeMonthSeries(
      profile.byCcy[row.ccy],
      T,
      row,
      profile.extrasByCcy?.[row.ccy],
    );
    return sumPeriodFlow(months);
  }
  const series = monthlyFlowSeriesLocalM(row, T, profile);
  return roundMoney(series.reduce((s, f) => s + f, 0));
}

/** Effective monthly flow for APIs that still multiply by T (VaR basis helpers). */
export function effectiveMonthlyFlowLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number {
  const T =
    Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1;
  if (T === 0) return 0;
  return roundMoney(periodFlowSumLocalM(row, T, profile) / T);
}

function forecastHorizonMonths(forecastMonths: number): number {
  return Math.max(
    0,
    Math.floor(
      Number.isFinite(forecastMonths) && forecastMonths >= 0
        ? forecastMonths
        : 1,
    ),
  );
}

/** Per-month cash-line objects (custom schedule or flat + extras). */
export function forecastMonthFlowSeries(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): ForecastMonthFlow[] {
  const T = forecastHorizonMonths(forecastMonths);
  if (T === 0) return [];
  if (profile?.mode === 'custom') {
    return resizeMonthSeries(
      profile.byCcy[row.ccy],
      T,
      row,
      profile.extrasByCcy?.[row.ccy],
    );
  }
  const extras = normalizeExtras(profile?.extrasByCcy?.[row.ccy]);
  return Array.from({ length: T }, (_, k) =>
    normalizeMonthFlow(flatMonthFlowAt(row, extras, profile, k)),
  );
}

/**
 * Per-month net flows for the cash / liquidity book (length = T).
 * Includes NWC collection and debt draw/repay — those are real cash.
 */
export function monthlyFlowSeriesLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number[] {
  return forecastMonthFlowSeries(row, forecastMonths, profile).map(m =>
    roundMoney(monthNet(m)),
  );
}

/**
 * Collecting AR already on the book (nwcIn vs nonCashAsset) or drawing/repaying
 * debt already in Stock does not change net FX — cash and the BS item swap.
 * Those legs stay on the cash path; stripping them here stops a 2.4 receivable
 * from sitting in Stock and again as 0.2×12 in the hedge flow.
 */
export function monthlyFxFlowSeriesLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number[] {
  const months = forecastMonthFlowSeries(row, forecastMonths, profile);
  let nwcLeft = Math.max(0, row.nonCashAsset ?? 0);
  let debtLeft = Math.max(0, row.ir_liab_notional);
  return months.map(m => {
    const n = normalizeMonthFlow(m);
    const convNwc = Math.min(Math.max(0, n.nwcIn), nwcLeft);
    nwcLeft = roundMoney(Math.max(0, nwcLeft - convNwc));
    const repay = Math.min(Math.max(0, -n.debtOut), debtLeft);
    debtLeft = roundMoney(Math.max(0, debtLeft - repay));
    return roundMoney(monthNet(n) - convNwc - n.debtIn + repay);
  });
}

/** Horizon Σ of FX-changing flow (cash Σ minus book conversions). */
export function periodFxFlowSumLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number {
  return roundMoney(
    monthlyFxFlowSeriesLocalM(row, forecastMonths, profile).reduce(
      (s, f) => s + f,
      0,
    ),
  );
}

/** Monthly equivalent of {@link periodFxFlowSumLocalM} for S+F×T helpers. */
export function effectiveMonthlyFxFlowLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number {
  const T = forecastHorizonMonths(forecastMonths);
  if (T === 0) return 0;
  return roundMoney(periodFxFlowSumLocalM(row, T, profile) / T);
}

/**
 * Per-month gross inflows (for cash-book income attribution).
 * Flat: collections + invoice fcast + extras inflows.
 * Custom: monthInflows per month.
 */
export function monthlyInflowSeriesLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number[] {
  const T = Math.max(
    0,
    Math.floor(
      Number.isFinite(forecastMonths) && forecastMonths >= 0
        ? forecastMonths
        : 1,
    ),
  );
  if (T === 0) return [];
  if (profile?.mode === 'custom') {
    const months = resizeMonthSeries(
      profile.byCcy[row.ccy],
      T,
      row,
      profile.extrasByCcy?.[row.ccy],
    );
    return months.map(m => roundMoney(monthInflows(m)));
  }
  const extras = normalizeExtras(profile?.extrasByCcy?.[row.ccy]);
  return Array.from({ length: T }, (_, k) =>
    roundMoney(monthInflows(flatMonthFlowAt(row, extras, profile, k))),
  );
}

/**
 * Per-month gross outflows (magnitude, ≥0) — mirrors
 * {@link monthlyInflowSeriesLocalM} using monthOutflowsAbs instead of
 * monthInflows. Needed alongside the inflow series wherever gross in/out
 * timing (not just their net) matters — e.g. Monte Carlo cash-mismatch CFaR,
 * where an outflow due before its offsetting inflow lands creates a real,
 * separate, intra-month gap even when the two roughly net out over the month.
 */
export function monthlyOutflowSeriesLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number[] {
  const T = Math.max(
    0,
    Math.floor(
      Number.isFinite(forecastMonths) && forecastMonths >= 0
        ? forecastMonths
        : 1,
    ),
  );
  if (T === 0) return [];
  if (profile?.mode === 'custom') {
    const months = resizeMonthSeries(
      profile.byCcy[row.ccy],
      T,
      row,
      profile.extrasByCcy?.[row.ccy],
    );
    return months.map(m => roundMoney(monthOutflowsAbs(m)));
  }
  const extras = normalizeExtras(profile?.extrasByCcy?.[row.ccy]);
  return Array.from({ length: T }, (_, k) =>
    roundMoney(monthOutflowsAbs(flatMonthFlowAt(row, extras, profile, k))),
  );
}

/** Same series from a bare flat monthly rate (consolidate / tests without RowState). */
export function flatMonthlyFlowSeries(
  monthlyFlowM: number,
  forecastMonths: number,
): number[] {
  const T = Math.max(
    0,
    Math.floor(
      Number.isFinite(forecastMonths) && forecastMonths >= 0
        ? forecastMonths
        : 0,
    ),
  );
  if (T === 0) return [];
  const F = Number.isFinite(monthlyFlowM) ? monthlyFlowM : 0;
  return Array.from({ length: T }, () => F);
}

export function forecastFormulaKey(
  ccy: string,
  field: string,
  monthIndex: number,
): string {
  return `${ccy}::${field}::${monthIndex}`;
}

/**
 * Token to insert when the user clicks another forecast cell while editing a
 * formula (Excel-like). Returns null when the target is not in scope.
 */
export function forecastFormulaPickToken(
  activeColumnKey: string,
  activeRowKey: string,
  targetColumnKey: string,
  targetRowKey: string,
  calcRows?: readonly ForecastCalcRow[],
): string | null {
  const activeCcy = activeColumnKey.split('::')[0] ?? '';
  const targetCcy = targetColumnKey.split('::')[0] ?? '';
  if (!activeCcy || activeCcy !== targetCcy) return null;

  const activeField = activeColumnKey.slice(activeCcy.length + 2);
  const targetField = targetColumnKey.slice(targetCcy.length + 2);
  const targetMi = Number(targetRowKey);
  if (!Number.isFinite(targetMi) || targetMi < 0) return null;
  const n = targetMi + 1;

  if (targetField === activeField) return `m${n}`;
  if (targetField === 'collections') return `rev${n}`;
  if (targetField === 'payout') return `exp${n}`;
  if (targetField === 'invoiceFcast') return `fcast${n}`;

  const calcId = calcIdFromFieldKey(targetField);
  if (calcId && calcRows) {
    const row = calcRows.find(c => c.id === calcId);
    if (row) return `${row.ref}m${n}`;
  }
  return null;
}

function isOutflowField(field: ForecastFlowField): boolean {
  return (
    field === 'payout' ||
    field === 'nwcOut' ||
    field === 'debtOut' ||
    field === 'investOut' ||
    field === 'otherOut'
  );
}

/** Scope for period-cell formulas (`rev`, `exp`, `m1`, `idx1`, `k`…). */
export function periodFormulaScope(
  row: RowState,
  months: readonly ForecastMonthFlow[],
  field: string,
  monthIndex: number,
  opts?: {
    calcRows?: readonly ForecastCalcRow[];
    calcValues?: Record<string, number[]>;
  },
): Scope {
  const cashField = isCalcFieldKey(field)
    ? null
    : (field as ForecastFlowField);
  const scope: Scope = {
    rev: row.collections,
    revenue: row.collections,
    collections: row.collections,
    exp: Math.abs(Math.min(0, row.payout)),
    expense: Math.abs(Math.min(0, row.payout)),
    payout: row.payout,
    fcast: row.fcastFX ?? 0,
    fcastFX: row.fcastFX ?? 0,
    invoice: row.fcastFX ?? 0,
    /** 1-based month index — use with pow(1.01, k-1) for exp growth. */
    k: monthIndex + 1,
    i: monthIndex + 1,
    t: monthIndex + 1,
  };
  months.forEach((raw, i) => {
    const m = normalizeMonthFlow(raw);
    const n = i + 1;
    if (cashField) {
      const display = isOutflowField(cashField)
        ? flowFieldDisplay(m, cashField, 'out')
        : flowFieldValue(m, cashField);
      scope[`m${n}`] = display;
    }
    scope[`rev${n}`] = m.collections;
    scope[`exp${n}`] = Math.abs(Math.min(0, m.payout));
    scope[`fcast${n}`] = m.invoiceFcast;
  });

  const calcRows = opts?.calcRows ?? [];
  const calcValues = opts?.calcValues ?? {};
  for (const c of calcRows) {
    const series = resizeCalcSeries(calcValues[c.id], months.length);
    const cur = series[monthIndex] ?? 0;
    scope[c.ref] = cur;
    series.forEach((v, i) => {
      scope[`${c.ref}m${i + 1}`] = v;
    });
  }

  if (monthIndex > 0) {
    if (cashField) {
      const prev = normalizeMonthFlow(months[monthIndex - 1]);
      scope.prev = isOutflowField(cashField)
        ? flowFieldDisplay(prev, cashField, 'out')
        : flowFieldValue(prev, cashField);
    } else {
      const calcId = calcIdFromFieldKey(field);
      if (calcId) {
        const series = resizeCalcSeries(calcValues[calcId], months.length);
        scope.prev = series[monthIndex - 1] ?? 0;
        if (cashField == null) {
          // Same-row mN aliases for the calc series being edited.
          series.forEach((v, i) => {
            scope[`m${i + 1}`] = v;
          });
        }
      }
    }
  } else if (!cashField) {
    const calcId = calcIdFromFieldKey(field);
    if (calcId) {
      const series = resizeCalcSeries(calcValues[calcId], months.length);
      series.forEach((v, i) => {
        scope[`m${i + 1}`] = v;
      });
    }
  }
  return scope;
}

export function evalPeriodFormula(
  expr: string,
  scope: Scope,
): { value: number; error?: string } {
  return safeEval(expr, scope);
}

/**
 * Excel-like relative month refs when fill-dragging across M1…MT.
 * Shifts `mN` / `revN` / `expN` / `fcastN` by (to − from) month indices (0-based).
 * Prefix `$` locks absolute (`$m1` stays M1). `prev` is already relative — unchanged.
 */
export function shiftForecastFormulaMonths(
  formula: string,
  fromMonthIndex: number,
  toMonthIndex: number,
): string {
  const delta = Math.round(toMonthIndex) - Math.round(fromMonthIndex);
  if (delta === 0) return formula;
  const raw = formula.trim().replace(/^=/, '').trim();
  if (!raw) return formula;

  // 1) Calc month refs: idx1m3 → idx1m4 (prefix $ locks).
  // 2) Cash month refs: mN / revN / expN / fcastN.
  const shiftCalc = raw.replace(
    /(\$?)\b([A-Za-z_][A-Za-z0-9]*)m(\d+)\b/gi,
    (full, lock: string, ref: string, num: string) => {
      if (lock === '$') return full;
      const n = Number(num);
      if (!Number.isFinite(n) || n < 1) return full;
      return `${ref}m${Math.max(1, n + delta)}`;
    },
  );
  return shiftCalc.replace(
    /(\$?)\b(m|rev|exp|fcast)(\d+)\b/gi,
    (_full, lock: string, kind: string, num: string) => {
      if (lock === '$') return `${lock}${kind}${num}`;
      const n = Number(num);
      if (!Number.isFinite(n) || n < 1) return `${kind}${num}`;
      return `${kind}${Math.max(1, n + delta)}`;
    },
  );
}

export function copyMonth1ToAll(
  months: ForecastMonthFlow[],
): ForecastMonthFlow[] {
  if (months.length === 0) return months;
  const m0 = normalizeMonthFlow(months[0]);
  return months.map(() => ({ ...m0 }));
}

// ── Multi-cycle liquidity projection ────────────────────────────────────────
//
// computeLayeredBuffer / computeFcySwapNear (fx-buffer.ts) size the buffer and
// near-leg swap for ONE cycle only, from the row's live cash/payout. They have
// no visibility into the MoM growth already configured on the Forecast profile
// (growthRateMoM / flatGrowthByCcy), so a currency whose payout run-rate is
// growing shows its true buffer need only after the fact, one cycle late.
//
// projectLiquidityCycles chains the same per-cycle formula forward: cycle k's
// closing cash becomes cycle k+1's opening cash, and payout/collections/invoice
// fcast are read from the grown (or custom) month series instead of the flat
// row value. This mirrors the rolling-hedge.ts pattern (successive forward
// edges when Tf > Th) but applied to the liquidity buffer instead of the VaR
// hedge notional.

function cycleFlowAt(
  row: RowState,
  forecastProfile: ForecastProfileState | null | undefined,
  monthIndex: number,
): { payout: number; collections: number; invoiceFcast: number } {
  if (forecastProfile?.mode === 'custom') {
    const months = resizeMonthSeries(
      forecastProfile.byCcy[row.ccy],
      monthIndex + 1,
      row,
      forecastProfile.extrasByCcy?.[row.ccy],
    );
    const m = normalizeMonthFlow(months[monthIndex]);
    return { payout: m.payout, collections: m.collections, invoiceFcast: m.invoiceFcast };
  }
  const extras = normalizeExtras(forecastProfile?.extrasByCcy?.[row.ccy]);
  const m = flatMonthFlowAt(row, extras, forecastProfile, monthIndex);
  return { payout: m.payout, collections: m.collections, invoiceFcast: m.invoiceFcast };
}

export interface LiquidityCycleProjection {
  /** 0-based cycle index; 0 = the current/near cycle. */
  cycleIndex: number;
  /** Opening LP cash entering this cycle (M FCY) — chained from the prior cycle's close. */
  opening_cash: number;
  /** This cycle's net payout (M FCY, ≤0 = outflow), grown per the Forecast profile. */
  payout: number;
  collections: number;
  invoiceFcast: number;
  /**
   * FCY leg of hedges settling in this cycle (signed, + = received). Only the
   * delivery side enters `forecasted_cash`, matching the outflows-before-inflows
   * convention the undated trough encodes.
   */
  hedgeSettle: number;
  /**
   * Trough this cycle protects against: the dated path's low when a cycle shape
   * is supplied, otherwise opening_cash + payout + hedge delivery.
   */
  forecasted_cash: number;
  /** opening_cash − forecasted_cash: the cash this cycle drains at its deepest. */
  drawdown: number;
  /** H* for this cycle, from the same active layers run on this cycle's numbers. */
  cash_threshold: number;
  layered: LayeredBufferResult;
  /** Near-leg swap required THIS cycle to bring opening_cash to cash_threshold. */
  swap_needed: number;
  /**
   * Funding beyond what cycle 0 already commits (0 for cycle 0 itself) — the
   * tranche that can be pre-booked today, value-dated at this cycle, instead of
   * waiting for the shortfall to show up when the cycle arrives. Read off the
   * near-leg need on the dated path, off threshold growth otherwise.
   */
  incremental_swap: number;
  /**
   * Swap notional outstanding once this cycle's leg is on: the running sum of
   * every leg booked so far.
   *
   * The near leg's cash stays in the account — the far leg is rolled, not let
   * run off — so a drain that repeats does NOT settle at one cycle's leg size.
   * Each cycle adds another leg on top, and the outstanding book grows to the
   * whole horizon's burn. This is the funding position; `swap_needed` is only
   * the trade to add this cycle.
   */
  standing_swap: number;
  post_swap_cash: number;
  /**
   * Far leg settling at the end of this cycle (≤ 0: the cover is repaid). Term
   * cover matures with the horizon, so its far leg lands on the last date and
   * `cycle_end_cash` states the balance after repayment. Rolling legs are rolled
   * rather than let run off, so this is 0 on every cycle of that convention.
   */
  far_leg: number;
  /** Becomes next cycle's opening_cash. Net of `far_leg` where one settles. */
  cycle_end_cash: number;
}

/**
 * Per-cycle shape of the dated liquidity path, handed in by a caller that owns
 * the ladder (this module cannot import it without a cycle).
 *
 * Both fields are invariant to funding: a near leg landing at the start of the
 * cycle lifts the whole path, leaving the drain from the cycle's own opening and
 * the cycle's net change untouched. That is what lets the projection chain a
 * funded path out of an unfunded one.
 */
export interface DatedCycleShape {
  /** opening − low: the cash the cycle drains at its deepest. */
  drawdown: number;
  /** Inflow − outflow across the cycle, counting every dated line. */
  net: number;
}

/**
 * The near leg a cycle gets, given the cycle's own numbers. Rolling booking
 * answers "whatever this cycle is short"; term booking answers "the whole
 * horizon's cover, at cycle 0, nothing after".
 */
type NearLegPolicy = (
  k: number,
  ctx: { opening: number; forecasted_cash: number; cash_threshold: number },
) => number;

function runLiquidityCycles(
  row: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  T: number,
  forecastProfile: ForecastProfileState | null | undefined,
  hedgeSettle: readonly number[] | undefined,
  datedCycles: readonly DatedCycleShape[] | undefined,
  nearLeg: NearLegPolicy,
  /** Term booking has nothing left to pre-book: the one leg is already on. */
  preBookable: boolean,
  targetShift: number,
  cfarCoverFcy: number,
): LiquidityCycleProjection[] {
  const out: LiquidityCycleProjection[] = [];
  let opening = row.cash;
  let cycle0Threshold = 0;
  let cycle0Swap = 0;
  let standing = 0;

  for (let k = 0; k < T; k++) {
    const flow = cycleFlowAt(row, forecastProfile, k);
    const hedge = hedgeSettle?.[k] ?? 0;
    const dated = datedCycles?.[k];
    // With the dated path on, the trough is the low the shape actually reaches —
    // every line at its own settlement day, not every payout before every payin.
    const forecasted_cash = dated
      ? roundMoney(opening - dated.drawdown)
      : roundMoney(opening + flow.payout + Math.min(0, hedge));
    const grossPayout = Math.abs(flow.payout);

    const layered = computeLayeredBuffer(
      grossPayout,
      forecasted_cash,
      shared.σ_P,
      shared.r_USD,
      row.r_FCY,
      row.r_OD,
      row.cash_floor,
      activeLayers,
      opening,
      row.carry_target,
      cfarCoverFcy,
    );
    // A budget verdict can take away the carry overlay and the stock hold; the
    // floor, σ cushion and CFaR cover are not discretionary, so the shift never
    // funds a cycle below them.
    const cash_threshold = targetShift === 0
      ? layered.cash_threshold
      : roundMoney(Math.max(
        layered.cash_threshold + targetShift,
        layered.floor_contrib + layered.delta_sigma,
      ));

    const swap_needed = nearLeg(k, { opening, forecasted_cash, cash_threshold });
    if (k === 0) {
      cycle0Threshold = cash_threshold;
      cycle0Swap = swap_needed;
    }
    // Growth in the REQUIRED buffer level vs. what cycle 0 already established —
    // not the raw swap_needed delta, which also moves with cycle 0's one-off
    // "get from today's actual cash to target" transient (cycle 1+ instead funds
    // the steady-state "replace what left"), a swing that has nothing to do with
    // the structural gap actually growing.
    // On the dated funded path the openings are already chained, so the honest
    // statement is how much larger this cycle's near leg has to be than the one
    // booked today — the undated path keeps the threshold-growth reading, which
    // strips cycle 0's "get from today's cash to target" transient.
    const incremental_swap = k === 0 || !preBookable
      ? 0
      : roundMoney(Math.max(0, dated
        ? swap_needed - cycle0Swap
        : cash_threshold - cycle0Threshold));

    const post_swap_cash = roundMoney(opening + swap_needed);
    // The leg's cash is chained into the next opening, so it is still funded when
    // the next leg goes on: the book adds up rather than resetting each cycle.
    standing = roundMoney(standing + swap_needed);
    // nonLpCash is a static one-time balance swept into LP (see RowState doc), not a
    // recurring monthly flow — only sweep it in at cycle 0, or it compounds every cycle.
    const nonLpSweep = k === 0 ? row.nonLpCash : 0;
    // The dated net already carries NWC, debt, investing and hedge settlement, so
    // taking it whole keeps the projection's close equal to the ladder's.
    const cycle_end_cash = roundMoney(
      dated
        ? post_swap_cash + dated.net + nonLpSweep
        : post_swap_cash + flow.payout + flow.collections + flow.invoiceFcast
          + hedge + nonLpSweep,
    );

    out.push({
      cycleIndex: k,
      opening_cash: opening,
      payout: flow.payout,
      collections: flow.collections,
      invoiceFcast: flow.invoiceFcast,
      hedgeSettle: hedge,
      forecasted_cash,
      drawdown: roundMoney(Math.max(0, opening - forecasted_cash)),
      cash_threshold,
      layered,
      swap_needed,
      incremental_swap,
      standing_swap: standing,
      post_swap_cash,
      far_leg: 0,
      cycle_end_cash,
    });

    opening = cycle_end_cash;
  }

  return out;
}

export function projectLiquidityCycles(
  row: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  cycles: number,
  forecastProfile?: ForecastProfileState | null,
  hedgeSettle?: readonly number[],
  datedCycles?: readonly DatedCycleShape[],
  bookingMode: LiquidityBookingMode = 'rolling',
  /**
   * Level shift (M FCY) on every cycle's target, floored at cash_floor while the
   * floor layer is on. The book's layer pass settles the carry requirement and the
   * portfolio VaR / USD budget across all currencies at once, on one cycle's
   * numbers; this carries that verdict onto the whole horizon so each period's
   * starting target is the policy the book reached, not the raw layer sum.
   */
  targetShift = 0,
  cfarCoverFcy = 0,
): LiquidityCycleProjection[] {
  const T = Math.max(1, Math.floor(cycles));
  const formulaLayersActive = liquidityFormulaLayersActive(activeLayers);

  const run = (nearLeg: NearLegPolicy, preBookable: boolean) => runLiquidityCycles(
    row, shared, activeLayers, T, forecastProfile, hedgeSettle, datedCycles,
    nearLeg, preBookable, targetShift, cfarCoverFcy,
  );

  const rolling = run((_k, ctx) => computeFcySwapNear(
    ctx.cash_threshold,
    ctx.opening,
    row.fcastFX,
    row.r_OD,
    shared.r_USD,
    formulaLayersActive,
    ctx.forecasted_cash,
  ), true);
  // No layer selected is no funding policy: the desk is reading the book as it
  // stands, so neither convention may book a leg. The term solve answers a
  // shortfall against H*, which without a layer would still fund the path to
  // zero — so it has to be gated here, not inside the solve.
  if (bookingMode === 'rolling' || !formulaLayersActive) return rolling;

  // Term booking: one leg today, big enough that every cycle on the path still
  // clears its own H*. The rolling pass already prices that — its outstanding
  // book at cycle k is exactly what cycle k needs funded by then — so its peak
  // |standing| is the opening size (PAY shorts are negative; do not floor at 0).
  // H* moves a little once the cover is on (the layer formula reads opening
  // cash), so re-solve against any residual shortfall.
  let leg = rolling.reduce(
    (best, p) =>
      (Math.abs(p.standing_swap) > Math.abs(best) ? p.standing_swap : best),
    0,
  );
  let projection = rolling;
  for (let pass = 0; pass < 4; pass++) {
    const booked = leg;
    projection = run(k => (k === 0 ? booked : 0), false);
    // `forecasted_cash` is the low BEFORE this cycle's own leg lands, so cycle 0
    // clears H* on trough + leg. Later cycles open on the chained close, which
    // already carries the leg's cash, and clear H* on the trough as reported.
    const shortfall = projection.reduce(
      (worst, p) => Math.min(
        worst,
        p.forecasted_cash + p.swap_needed - p.cash_threshold,
      ),
      0,
    );
    if (shortfall >= -0.0001) break;
    leg = roundMoney(leg - shortfall);
  }
  return settleFarLegAtMaturity(projection);
}

/**
 * Term cover matures with the horizon: the far leg delivers the notional back on
 * the last date, so the last cycle closes on the balance after repayment rather
 * than carrying cover that never runs off. The repayment lands at the close, so
 * it leaves that cycle's trough — and every H* on the path — untouched.
 */
function settleFarLegAtMaturity(
  projection: LiquidityCycleProjection[],
): LiquidityCycleProjection[] {
  const last = projection[projection.length - 1];
  if (!last || Math.abs(last.standing_swap) < 0.001) return projection;
  const far_leg = roundMoney(-last.standing_swap);
  return [
    ...projection.slice(0, -1),
    { ...last, far_leg, cycle_end_cash: roundMoney(last.cycle_end_cash + far_leg) },
  ];
}

/** One forward-dated near-leg tranche to book today for a future cycle's incremental need. */
export interface ForwardSwapTranche {
  /** Which future cycle this tranche funds (1 = next cycle, …). */
  cycleIndex: number;
  /** Months from today the near leg should be value-dated. */
  valueDateMonths: number;
  /** Incremental buffer (M FCY) to fund near, beyond what cycle 0's threshold already covers. */
  amount_fcy: number;
}

/** Cycles after the first whose threshold outgrows cycle 0's — the pre-funding schedule. */
export function forwardSwapSchedule(
  projection: readonly LiquidityCycleProjection[],
): ForwardSwapTranche[] {
  return projection
    .filter(p => p.cycleIndex > 0 && p.incremental_swap > 0.001)
    .map(p => ({
      cycleIndex: p.cycleIndex,
      valueDateMonths: p.cycleIndex,
      amount_fcy: p.incremental_swap,
    }));
}

/** One line of the funding programme: the trade a cycle adds, and the book it leaves behind. */
export interface SwapLegScheduleRow {
  cycleIndex: number;
  /** Months from today the near leg is value-dated — 0 is spot, the trade in front of us. */
  valueDateMonths: number;
  /** Notional this cycle adds: + buys FCY to fund the trough, − sells excess back. */
  newLeg: number;
  /** Notional carried in from earlier cycles — rolled at its far date instead of settled. */
  rolledForward: number;
  /** Notional outstanding once this cycle's leg is on. */
  outstanding: number;
  /**
   * The size is already known from the projection, so the leg can be traded today
   * as a forward-starting swap value-dated at this cycle rather than waiting for
   * the shortfall to arrive. Cycle 0 is spot, so it is a trade, not a pre-booking.
   */
  preBookable: boolean;
}

/**
 * Every leg the funded path asks for, in order, with what it rolls on top of.
 *
 * `forwardSwapSchedule` answers a narrower question — where the requirement
 * OUTGROWS today's leg — so a drain that repeats at a constant size schedules
 * nothing even though another leg is due every cycle. This is the whole
 * programme: what to trade, when it is value-dated, and the book it builds into.
 */
export function swapLegSchedule(
  projection: readonly LiquidityCycleProjection[],
): SwapLegScheduleRow[] {
  return projection
    .filter(p => Math.abs(p.swap_needed) > 0.001)
    .map(p => ({
      cycleIndex: p.cycleIndex,
      valueDateMonths: p.cycleIndex,
      newLeg: p.swap_needed,
      rolledForward: roundMoney(p.standing_swap - p.swap_needed),
      outstanding: p.standing_swap,
      preBookable: p.cycleIndex > 0,
    }));
}
