// Multi-period FX forecast profile — flat monthly×T (workspace formula) or
// custom cash inflow / outflow lines per month within the forecasting period.

import { roundMoney, type RowState } from '@/lib/fx-buffer';
import { safeEval, type Scope } from '@/lib/formula';

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

/**
 * Per-month net flows for VaR path / average / cash book (length = T).
 */
export function monthlyFlowSeriesLocalM(
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
    return months.map(m => roundMoney(monthNet(m)));
  }
  const extras = normalizeExtras(profile?.extrasByCcy?.[row.ccy]);
  return Array.from({ length: T }, (_, k) =>
    roundMoney(monthNet(flatMonthFlowAt(row, extras, profile, k))),
  );
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
