// Multi-period FX forecast profile — flat monthly×T (workspace formula) or
// custom Revenue/Expenses per month within the selected forecasting period.

import { roundMoney, type RowState } from '@/lib/fx-buffer';
import { safeEval, type Scope } from '@/lib/formula';

export type ForecastFlowMode = 'flat' | 'custom';

/** One month of Revenue (in) / Expenses (out). Signs match RowState. */
export interface ForecastMonthFlow {
  /** Collections / payins (M FCY, ≥ 0). */
  collections: number;
  /** Payouts (M FCY, ≤ 0). */
  payout: number;
}

export interface ForecastProfileState {
  mode: ForecastFlowMode;
  /** Per-CCY month series; length should equal forecastMonths when mode = custom. */
  byCcy: Record<string, ForecastMonthFlow[]>;
  /**
   * Optional Excel-like overrides for period cells.
   * Keys: `${ccy}::collections::${monthIndex}` | `${ccy}::payout::${monthIndex}`
   * (payout formulas are entered as positive outflows, same as the modal).
   */
  formulas: Record<string, string>;
  /**
   * Default month-on-month growth (0.05 = +5% MoM).
   * Flat: compounds the monthly net path. Custom: seeds M_k = M₀×(1+g)^k.
   */
  growthRateMoM: number;
}

export const DEFAULT_FORECAST_PROFILE: ForecastProfileState = {
  mode: 'flat',
  byCcy: {},
  formulas: {},
  growthRateMoM: 0,
};

export function monthNet(m: ForecastMonthFlow): number {
  return m.collections + m.payout;
}

export function sumPeriodFlow(months: readonly ForecastMonthFlow[]): number {
  return roundMoney(months.reduce((s, m) => s + monthNet(m), 0));
}

/**
 * Seed T months from the row’s flat monthly Revenue / Expenses (+ invoice fcast).
 * Optional MoM growth compounds both legs: M_k = M_0 × (1+g)^k.
 */
export function seedMonthsFromRow(
  row: RowState,
  months: number,
  growthRateMoM: number = 0,
): ForecastMonthFlow[] {
  const T = Math.max(0, Math.floor(months));
  if (T === 0) return [];
  const fcast = row.fcastFX ?? 0;
  const baseCollections = roundMoney(row.collections + fcast);
  const basePayout = roundMoney(row.payout);
  const g =
    typeof growthRateMoM === 'number' && Number.isFinite(growthRateMoM)
      ? growthRateMoM
      : 0;
  if (Math.abs(g) < 1e-15) {
    return Array.from({ length: T }, () => ({
      collections: baseCollections,
      payout: basePayout,
    }));
  }
  return Array.from({ length: T }, (_, k) => {
    const factor = Math.pow(1 + g, k);
    return {
      collections: roundMoney(baseCollections * factor),
      payout: roundMoney(basePayout * factor),
    };
  });
}

/** Resize a series when the forecasting period changes. */
export function resizeMonthSeries(
  prev: ForecastMonthFlow[] | undefined,
  months: number,
  fallback: RowState,
): ForecastMonthFlow[] {
  const T = Math.max(0, Math.floor(months));
  if (T === 0) return [];
  const base = prev && prev.length > 0 ? prev : seedMonthsFromRow(fallback, T);
  if (base.length === T) return base.map(m => ({ ...m }));
  if (base.length > T) return base.slice(0, T).map(m => ({ ...m }));
  const last = base[base.length - 1] ?? seedMonthsFromRow(fallback, 1)[0]!;
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
  for (const r of rows) {
    if (r.ccy === 'USD') continue;
    byCcy[r.ccy] = resizeMonthSeries(byCcy[r.ccy], months, r);
  }
  return {
    ...profile,
    byCcy,
    growthRateMoM:
      typeof profile.growthRateMoM === 'number' && Number.isFinite(profile.growthRateMoM)
        ? profile.growthRateMoM
        : 0,
    formulas: profile.formulas ?? {},
  };
}

/**
 * Period flow sum used by Net FX Forecast / VaR buildup.
 * Flat (workspace): (collections + payout + fcastFX) × T
 * Custom: Σ month nets (invoice fcast is folded into month Revenue when seeded)
 */
export function periodFlowSumLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number {
  const T = Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1;
  if (T === 0) return 0;
  if (profile?.mode === 'custom') {
    const months = resizeMonthSeries(profile.byCcy[row.ccy], T, row);
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
  const T = Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1;
  if (T === 0) return 0;
  return roundMoney(periodFlowSumLocalM(row, T, profile) / T);
}

/**
 * Per-month net flows for VaR path / average (length = T).
 * Custom: month nets from the profile. Flat: constant (collections+payout+fcast)×1 each month.
 */
export function monthlyFlowSeriesLocalM(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number[] {
  const T = Math.max(0, Math.floor(
    Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1,
  ));
  if (T === 0) return [];
  if (profile?.mode === 'custom') {
    const months = resizeMonthSeries(profile.byCcy[row.ccy], T, row);
    return months.map(m => roundMoney(monthNet(m)));
  }
  const flat = roundMoney(row.collections + row.payout + (row.fcastFX ?? 0));
  const g =
    typeof profile?.growthRateMoM === 'number' && Number.isFinite(profile.growthRateMoM)
      ? profile.growthRateMoM
      : 0;
  if (Math.abs(g) < 1e-15) {
    return Array.from({ length: T }, () => flat);
  }
  return Array.from({ length: T }, (_, k) =>
    roundMoney(flat * Math.pow(1 + g, k)),
  );
}

/** Same series from a bare flat monthly rate (consolidate / tests without RowState). */
export function flatMonthlyFlowSeries(monthlyFlowM: number, forecastMonths: number): number[] {
  const T = Math.max(0, Math.floor(
    Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 0,
  ));
  if (T === 0) return [];
  const F = Number.isFinite(monthlyFlowM) ? monthlyFlowM : 0;
  return Array.from({ length: T }, () => F);
}

export function forecastFormulaKey(
  ccy: string,
  field: 'collections' | 'payout',
  monthIndex: number,
): string {
  return `${ccy}::${field}::${monthIndex}`;
}

/** Scope for period-cell formulas (`rev`, `exp`, `m1`…). */
export function periodFormulaScope(
  row: RowState,
  months: readonly ForecastMonthFlow[],
  field: 'collections' | 'payout',
  monthIndex: number,
): Scope {
  const scope: Scope = {
    rev: row.collections,
    revenue: row.collections,
    collections: row.collections,
    exp: Math.abs(Math.min(0, row.payout)),
    expense: Math.abs(Math.min(0, row.payout)),
    payout: row.payout,
    fcast: row.fcastFX ?? 0,
    fcastFX: row.fcastFX ?? 0,
  };
  months.forEach((m, i) => {
    const n = i + 1;
    scope[`m${n}`] = field === 'collections' ? m.collections : Math.abs(Math.min(0, m.payout));
    scope[`rev${n}`] = m.collections;
    scope[`exp${n}`] = Math.abs(Math.min(0, m.payout));
  });
  // Prior month shortcut
  if (monthIndex > 0) {
    const prev = months[monthIndex - 1]!;
    scope.prev = field === 'collections' ? prev.collections : Math.abs(Math.min(0, prev.payout));
  }
  return scope;
}

export function evalPeriodFormula(
  expr: string,
  scope: Scope,
): { value: number; error?: string } {
  return safeEval(expr, scope);
}

export function copyMonth1ToAll(months: ForecastMonthFlow[]): ForecastMonthFlow[] {
  if (months.length === 0) return months;
  const m0 = months[0]!;
  return months.map(() => ({ collections: m0.collections, payout: m0.payout }));
}
