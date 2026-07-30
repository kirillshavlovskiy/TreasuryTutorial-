import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  type VarConfidencePct,
  isVarConfidencePct,
  zForConfidence,
} from '@/lib/test-mode/var-confidence';

/** Which exposure feeds parametric VaR. */
export type VarExposureBasis =
  | 'stock'
  | 'simpleAvg'
  | 'avgBuildup'
  | 'totalBuildup';

/** VaR analysis horizon — vol scales with √T from the 1-month curriculum σ only. */
export type VarHorizonId = '1w' | '1m' | '3m' | '6m' | '9m' | '1y';

/**
 * Forecast period on FX Risk — scales Net FX Forecast and totalBuildup exposure.
 * Independent of VaR analysis horizon (vol √T).
 * `0m` = no forecast (stock only; F×T = 0).
 */
export type ForecastPeriodId = '0m' | '1m' | '3m' | '6m' | '9m' | '1y';

export interface VarSetup {
  confidencePct: VarConfidencePct;
  exposureBasis: VarExposureBasis;
  /** VaR vol horizon (√T) — Task Q / pure analysis only. */
  horizon: VarHorizonId;
  /** FX Risk forecast months — Net FX Forecast + totalBuildup exposure. */
  forecastMonths: number;
  /**
   * Incremental forecast uncertainty for a 1-month flow (relative to |F|).
   * Independent monthly errors compound as √g over accrued forecast months
   * g = min(Th, Tf). 0 = off (FX path only).
   */
  forecastUncertainty1m: number;
}

export const VAR_EXPOSURE_OPTIONS: {
  id: VarExposureBasis;
  label: string;
  description: string;
  /** How VaR evolves vs tenure on the Analytics chart. */
  varProfile: 'sqrtT' | 'path';
}[] = [
  {
    id: 'stock',
    label: 'Stock now',
    description:
      'Current Net FX only. VaR ∝ |S|×√T — pure square-root tenure curvature.',
    varProfile: 'sqrtT',
  },
  {
    id: 'simpleAvg',
    label: 'Simple average',
    description:
      'Mid-point of start and end: Ē=(S+E_end)/2 = S+½×ΣF over g=min(Th,Tf). Classic √T average — same as flat F half-buildup.',
    varProfile: 'sqrtT',
  },
  {
    id: 'avgBuildup',
    label: 'Weighted average',
    description:
      'Time-weighted path average Ē=(1/T)∫e dt over g=min(Th,Tf). Differs from simple mid-point when the monthly schedule is uneven.',
    varProfile: 'sqrtT',
  },
  {
    id: 'totalBuildup',
    label: 'Growth path',
    description:
      'Actual cumulative path e(t)=S+F·min(t,Tf). VaR ∝ √∫e²dt — curvature differs from √T.',
    varProfile: 'path',
  },
];

export const VAR_HORIZON_OPTIONS: {
  id: VarHorizonId;
  label: string;
  /** Horizon length in months (for √T vol scaling only). */
  months: number;
}[] = [
  { id: '1w', label: '1 week', months: 0.25 },
  { id: '1m', label: '1 month', months: 1 },
  { id: '3m', label: '3 months', months: 3 },
  { id: '6m', label: '6 months', months: 6 },
  { id: '9m', label: '9 months', months: 9 },
  { id: '1y', label: '1 year', months: 12 },
];

/** FX Risk forecast period options (0 = no forecast; then monthly steps). */
export const FORECAST_PERIOD_OPTIONS: {
  id: ForecastPeriodId;
  label: string;
  months: number;
  /** Matching VaR analysis horizon id (default pick). */
  horizonId: VarHorizonId;
}[] = [
  { id: '0m', label: '0 month', months: 0, horizonId: '1m' },
  { id: '1m', label: '1 month', months: 1, horizonId: '1m' },
  { id: '3m', label: '3 months', months: 3, horizonId: '3m' },
  { id: '6m', label: '6 months', months: 6, horizonId: '6m' },
  { id: '9m', label: '9 months', months: 9, horizonId: '9m' },
  { id: '1y', label: '1 year', months: 12, horizonId: '1y' },
];

/** Preset 1m incremental forecast uncertainty (relative to monthly flow F). */
export const FORECAST_UNCERTAINTY_OPTIONS: {
  id: string;
  label: string;
  /** Relative 1m vol of monthly flow (0 = off). */
  value: number;
}[] = [
  { id: 'off', label: 'Off', value: 0 },
  { id: '5', label: '5%', value: 0.05 },
  { id: '10', label: '10%', value: 0.1 },
  { id: '20', label: '20%', value: 0.2 },
  { id: '30', label: '30%', value: 0.3 },
];

export const DEFAULT_VAR_SETUP: VarSetup = {
  confidencePct: 95,
  exposureBasis: 'stock',
  horizon: '1m',
  forecastMonths: 1,
  forecastUncertainty1m: 0,
};

/** Curriculum EUR stock / monthly flow for reference scoring (Net FX = S − debt). */
export const EUR_REF_STOCK_M = 1.9; // 4.9 cash+receivables − 3.0 venture debt
export const EUR_REF_FLOW_M = 1.2;

export function isVarExposureBasis(v: unknown): v is VarExposureBasis {
  return (
    v === 'stock' ||
    v === 'simpleAvg' ||
    v === 'avgBuildup' ||
    v === 'totalBuildup'
  );
}

export function isVarHorizonId(v: unknown): v is VarHorizonId {
  return (
    v === '1w' ||
    v === '1m' ||
    v === '3m' ||
    v === '6m' ||
    v === '9m' ||
    v === '1y'
  );
}

export function isForecastPeriodId(v: unknown): v is ForecastPeriodId {
  return (
    v === '0m' ||
    v === '1m' ||
    v === '3m' ||
    v === '6m' ||
    v === '9m' ||
    v === '1y'
  );
}

export function parseVarExposureBasis(raw: string | undefined | null): VarExposureBasis | null {
  if (!raw) return null;
  const v = raw.trim();
  return isVarExposureBasis(v) ? v : null;
}

export function parseVarHorizonId(raw: string | undefined | null): VarHorizonId | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return isVarHorizonId(v) ? v : null;
}

export function parseForecastMonths(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  // 0 = no forecast (allowed); reject negatives / non-finite.
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function horizonMonths(horizon: VarHorizonId): number {
  return VAR_HORIZON_OPTIONS.find(h => h.id === horizon)?.months ?? 1;
}

/** Map forecast months → default VaR analysis horizon id. */
export function horizonIdForForecastMonths(months: number): VarHorizonId {
  const hit = FORECAST_PERIOD_OPTIONS.find(o => o.months === months);
  if (hit) return hit.horizonId;
  if (months <= 0.25) return '1w';
  if (months <= 1) return '1m';
  if (months <= 3) return '3m';
  if (months <= 6) return '6m';
  if (months <= 9) return '9m';
  return '1y';
}

export function forecastPeriodIdForMonths(months: number): ForecastPeriodId {
  const hit = FORECAST_PERIOD_OPTIONS.find(o => o.months === months);
  return hit?.id ?? '1m';
}

/** σ_T = σ_1m × √(T / 1m). */
export function volForHorizon(horizon: VarHorizonId): number {
  return NORDTECH_VAR.monthlyVol * Math.sqrt(horizonMonths(horizon));
}

/**
 * Exposure for an Analytics basis.
 * - stock: S
 * - simpleAvg / avgBuildup (flat F): S + ½×F×T (mid-point / half-buildup)
 * - totalBuildup: S + F×T where T is the FX Risk forecast period in months
 */
function roundExposure(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.round(v * 1e8) / 1e8;
}

export function exposureLocalMForBasis(
  stockM: number,
  flowM: number,
  basis: VarExposureBasis,
  forecastMonths: number = 1,
): number {
  // T = 0 → no forecast buildup (stock only). Do not coerce 0 → 1.
  const T = Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1;
  if (basis === 'stock') return roundExposure(stockM);
  if (basis === 'simpleAvg' || basis === 'avgBuildup') {
    return roundExposure(stockM + 0.5 * T * flowM);
  }
  return roundExposure(stockM + T * flowM);
}

/** Buildup leg only (exposure − stock) for ladder / tables. */
export function buildupLocalMForBasis(
  flowM: number,
  basis: VarExposureBasis,
  forecastMonths: number = 1,
): number {
  const T = Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1;
  if (basis === 'stock') return 0;
  if (basis === 'simpleAvg' || basis === 'avgBuildup') {
    return roundExposure(0.5 * T * flowM);
  }
  return roundExposure(T * flowM);
}

/** Parse relative 1m forecast uncertainty (accepts 0.1 or "10%"). */
export function parseForecastUncertainty1m(
  raw: string | number | undefined | null,
): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'off' || s === 'none') return 0;
  const pctHint = s.includes('%');
  const n = Number(s.replace(/%/g, '').trim());
  if (!Number.isFinite(n) || n < 0) return null;
  // "10" or "10%" → 0.10; "0.1" stays 0.1
  const v = pctHint || n > 1 ? n / 100 : n;
  if (v > 2) return null; // reject absurd >200%
  return v;
}

export function parseVarSetup(partial: {
  varConfidencePct?: string;
  varExposureBasis?: string;
  varHorizon?: string;
  varForecastMonths?: string;
  varForecastUncertainty?: string;
}): VarSetup | null {
  const confidencePct = (() => {
    const n = Number(String(partial.varConfidencePct ?? '').replace(/%/g, '').trim());
    return isVarConfidencePct(n) ? n : null;
  })();
  const exposureBasis = parseVarExposureBasis(partial.varExposureBasis);
  const horizon = parseVarHorizonId(partial.varHorizon);
  if (!confidencePct || !exposureBasis || !horizon) return null;
  // Forecast period is independent of VaR analysis horizon (defaults to 1 month).
  const forecastMonths = parseForecastMonths(partial.varForecastMonths) ?? 1;
  const forecastUncertainty1m =
    parseForecastUncertainty1m(partial.varForecastUncertainty) ?? 0;
  return {
    confidencePct,
    exposureBasis,
    horizon,
    forecastMonths,
    forecastUncertainty1m,
  };
}

/**
 * Snapshot parametric VaR in USD millions (constant exposure E over the horizon):
 *   |E| × spot × σ_1m × √T_horizon × z
 *
 * Correct for stock / flat books. For a linearly growing book use
 * `computeGrowingExposureVarUsdM` instead — applying |E_end| here overstates risk.
 */
export function computeParametricVarUsdM(
  exposureLocalM: number,
  ccy: string,
  setup: Pick<VarSetup, 'confidencePct' | 'horizon'>,
): number {
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  const z = zForConfidence(setup.confidencePct);
  const vol = volForHorizon(setup.horizon);
  return Math.abs(exposureLocalM) * spotUsd * vol * z;
}

/**
 * Invert linear bullet VaR → |N| (local M).
 *   VaR = |N| × spot × σ_1m × √Th × z
 * Used to size a flat instrument that matches a target VaR at the active horizon.
 */
export function linearBulletNotionalFromVarUsdM(
  varUsdM: number,
  ccy: string,
  setup: Pick<VarSetup, 'confidencePct' | 'horizon'>,
): number {
  if (!(varUsdM > 0) || !Number.isFinite(varUsdM)) return 0;
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  const unit =
    spotUsd * NORDTECH_VAR.monthlyVol * Math.sqrt(horizonMonths(setup.horizon)) *
    zForConfidence(setup.confidencePct);
  if (unit < 1e-15) return 0;
  return varUsdM / unit;
}

/**
 * Path factor √∫₀^{T_h} e(t)² dt for piecewise-linear monthly schedule:
 *   during month k: e = E_{k-1} + F_k · u,  u ∈ [0, dt]
 * After the schedule ends, exposure is held flat.
 * Units: exposure × √months.
 */
export function growingExposurePathFactorFromSchedule(
  stockM: number,
  monthlyFlows: readonly number[],
  horizonMonthsT: number,
): number {
  const T = horizonMonthsT > 0 && Number.isFinite(horizonMonthsT) ? horizonMonthsT : 0;
  if (T <= 0) return 0;
  let e = Number.isFinite(stockM) ? stockM : 0;
  let integ = 0;
  let tLeft = T;
  let i = 0;
  while (tLeft > 1e-12) {
    if (i >= monthlyFlows.length) {
      integ += e * e * tLeft;
      break;
    }
    const F = Number.isFinite(monthlyFlows[i]!) ? monthlyFlows[i]! : 0;
    const dt = Math.min(1, tLeft);
    integ += e * e * dt + e * F * dt * dt + (F * F * dt * dt * dt) / 3;
    e += F * dt;
    tLeft -= dt;
    i += 1;
  }
  return Math.sqrt(Math.max(0, integ));
}

/**
 * Time-weighted average exposure over [0, T] for a monthly schedule:
 *   Ē = (1/T) ∫₀ᵀ e(t) dt
 * During month k: e grows linearly at rate F_k. Flat F ⇒ Ē = S+½·F·T;
 * uneven F_k ⇒ Ē ≠ (S+E_end)/2 (front-loaded higher, back-loaded lower).
 */
export function averageExposureFromScheduleM(
  stockM: number,
  monthlyFlows: readonly number[],
  horizonMonthsT: number,
): number {
  const T = horizonMonthsT > 0 && Number.isFinite(horizonMonthsT) ? horizonMonthsT : 0;
  if (T <= 0) return Number.isFinite(stockM) ? stockM : 0;
  let e = Number.isFinite(stockM) ? stockM : 0;
  let area = 0;
  let tLeft = T;
  let i = 0;
  while (tLeft > 1e-12) {
    if (i >= monthlyFlows.length) {
      area += e * tLeft;
      break;
    }
    const F = Number.isFinite(monthlyFlows[i]!) ? monthlyFlows[i]! : 0;
    const dt = Math.min(1, tLeft);
    area += e * dt + (F * dt * dt) / 2;
    e += F * dt;
    tLeft -= dt;
    i += 1;
  }
  return area / T;
}

/** End-of-window accrued position after min(Th, schedule) months of flows. */
export function accruedPositionFromScheduleM(
  stockM: number,
  monthlyFlows: readonly number[],
  horizonMonthsT: number,
): number {
  const T = horizonMonthsT > 0 && Number.isFinite(horizonMonthsT) ? horizonMonthsT : 0;
  let e = Number.isFinite(stockM) ? stockM : 0;
  if (T <= 0) return e;
  let tLeft = T;
  let i = 0;
  while (tLeft > 1e-12 && i < monthlyFlows.length) {
    const F = Number.isFinite(monthlyFlows[i]!) ? monthlyFlows[i]! : 0;
    const dt = Math.min(1, tLeft);
    e += F * dt;
    tLeft -= dt;
    i += 1;
  }
  return e;
}

/**
 * Path factor √∫₀^{T_h} e(t)² dt for cumulative exposure:
 *   e(t) = S + F·min(t, T_f)   (grows over the forecast period, then flat)
 *
 * T_h = VaR calculation horizon (months). T_f = forecast buildup months.
 * Units: exposure × √months. T_f = 0 or F = 0 → |S|·√T_h.
 */
export function growingExposurePathFactor(
  stockM: number,
  monthlyFlowM: number,
  horizonMonthsT: number,
  forecastMonths: number = Number.POSITIVE_INFINITY,
): number {
  const T = horizonMonthsT > 0 && Number.isFinite(horizonMonthsT) ? horizonMonthsT : 0;
  if (T <= 0) return 0;
  const S = Number.isFinite(stockM) ? stockM : 0;
  const Fraw = Number.isFinite(monthlyFlowM) ? monthlyFlowM : 0;
  const TfCap =
    Number.isFinite(forecastMonths) && forecastMonths >= 0
      ? forecastMonths
      : Number.POSITIVE_INFINITY;
  const F = TfCap > 0 ? Fraw : 0;
  const Tf = Math.max(0, Math.min(TfCap, T));

  if (Tf <= 1e-12 || Math.abs(F) < 1e-15) {
    return Math.abs(S) * Math.sqrt(T);
  }
  // Grow for entire horizon
  if (Tf >= T - 1e-12) {
    const integ = S * S * T + S * F * T * T + (F * F * T * T * T) / 3;
    return Math.sqrt(Math.max(0, integ));
  }
  // Grow to T_f then hold E* = S + F·T_f until T_h
  const growInteg = S * S * Tf + S * F * Tf * Tf + (F * F * Tf * Tf * Tf) / 3;
  const eEnd = S + F * Tf;
  const flatInteg = eEnd * eEnd * (T - Tf);
  return Math.sqrt(Math.max(0, growInteg + flatInteg));
}

/**
 * Path-integrated parametric VaR (growth-path mode):
 *   spot × σ_1m × z × √∫₀^{T_h} [S + F·min(t,T_f)]² dt
 */
export function computeGrowingExposureVarUsdM(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: Pick<VarSetup, 'confidencePct' | 'horizon' | 'forecastMonths'>,
): number {
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  const z = zForConfidence(setup.confidencePct);
  const path = growingExposurePathFactor(
    stockM,
    monthlyFlowM,
    horizonMonths(setup.horizon),
    setup.forecastMonths,
  );
  return path * spotUsd * NORDTECH_VAR.monthlyVol * z;
}

/**
 * Constant-exposure equivalent with the same area as linear buildup over window G:
 *   Ē = S + ½×F×G   (G = 0 → S)
 * For VaR at tenure Th use G = min(Th, Tf) — not the full forecast when Tf > Th.
 */
export function areaEquivalentAverageExposureM(
  stockM: number,
  monthlyFlowM: number,
  forecastMonths: number,
): number {
  const G =
    typeof forecastMonths === 'number' && forecastMonths > 0 ? forecastMonths : 0;
  const F = G > 0 && Number.isFinite(monthlyFlowM) ? monthlyFlowM : 0;
  const S = Number.isFinite(stockM) ? stockM : 0;
  return S + 0.5 * F * G;
}

/**
 * Simple / mid-point average at VaR horizon (flat F):
 *   Ē(Th) = S + ½×F×min(Th, Tf) = (S + E_end)/2
 */
export function averageExposureAtHorizonM(
  stockM: number,
  monthlyFlowM: number,
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'>,
): number {
  const g = accruedForecastMonths(horizonMonths(setup.horizon), setup.forecastMonths);
  return areaEquivalentAverageExposureM(stockM, monthlyFlowM, g);
}

/**
 * Simple mid-point from a monthly schedule: (S + E_end)/2 over min(Th, schedule).
 */
export function simpleAverageFromScheduleM(
  stockM: number,
  monthlyFlows: readonly number[],
  horizonMonthsT: number,
): number {
  const end = accruedPositionFromScheduleM(stockM, monthlyFlows, horizonMonthsT);
  const S = Number.isFinite(stockM) ? stockM : 0;
  return (S + end) / 2;
}

/**
 * Months of forecast accrual relevant at VaR horizon Th:
 *   g = min(Th, Tf)  (0 when no forecast).
 */
export function accruedForecastMonths(
  horizonMonthsT: number,
  forecastMonths: number,
): number {
  const Th = horizonMonthsT > 0 && Number.isFinite(horizonMonthsT) ? horizonMonthsT : 0;
  const Tf =
    typeof forecastMonths === 'number' && forecastMonths > 0 ? forecastMonths : 0;
  if (Th <= 0 || Tf <= 0) return 0;
  return Math.min(Th, Tf);
}

/**
 * Std of cumulative flow error (local M) after g months of independent
 * 1m incremental relative forecast uncertainty u:
 *   σ_E = |F| · u · √g
 *
 * Independent monthly errors → variance adds linearly → √g compounding
 * (non-linear in tenure), which steepens VaR curvature vs horizon.
 */
export function cumulativeForecastErrorStdM(
  monthlyFlowM: number,
  uncertainty1m: number,
  accruedMonths: number,
): number {
  const u = Number.isFinite(uncertainty1m) && uncertainty1m > 0 ? uncertainty1m : 0;
  const g = Number.isFinite(accruedMonths) && accruedMonths > 0 ? accruedMonths : 0;
  if (u <= 0 || g <= 0 || !Number.isFinite(monthlyFlowM)) return 0;
  return Math.abs(monthlyFlowM) * u * Math.sqrt(g);
}

/**
 * Accrued cumulative flow-error std (local M) for the active setup:
 *   flat F:  σ_E = |F| · u₁ₘ · √g
 *   schedule: σ_E = u₁ₘ · √(Σ F_k²) over accrued months (independent month errors)
 * Zero for stock / Tf=0 / u=0.
 */
export function forecastErrorStdForSetupM(
  monthlyFlowM: number,
  setup: Pick<
    VarSetup,
    'horizon' | 'forecastMonths' | 'forecastUncertainty1m' | 'exposureBasis'
  >,
  monthlyFlows?: readonly number[],
): number {
  if (setup.exposureBasis === 'stock') return 0;
  const u =
    typeof setup.forecastUncertainty1m === 'number' && setup.forecastUncertainty1m > 0
      ? setup.forecastUncertainty1m
      : 0;
  if (u <= 0) return 0;
  const g = accruedForecastMonths(horizonMonths(setup.horizon), setup.forecastMonths);
  if (g <= 0) return 0;
  if (monthlyFlows && monthlyFlows.length > 0) {
    let sumSq = 0;
    let tLeft = g;
    let i = 0;
    while (tLeft > 1e-12 && i < monthlyFlows.length) {
      const F = Number.isFinite(monthlyFlows[i]!) ? monthlyFlows[i]! : 0;
      const dt = Math.min(1, tLeft);
      sumSq += F * F * dt; // partial last month scales variance by dt
      tLeft -= dt;
      i += 1;
    }
    return u * Math.sqrt(Math.max(0, sumSq));
  }
  const flow =
    setup.forecastMonths > 0 && Number.isFinite(monthlyFlowM) ? monthlyFlowM : 0;
  if (Math.abs(flow) < 1e-15) return 0;
  return cumulativeForecastErrorStdM(flow, u, g);
}

/**
 * Quantity-risk contribution inside the FX √T factor (USD M), for diagnostics:
 *   σ_E · spot · σ_fx · √Th · z
 * (same units as FX VaR; not added linearly — see computeAnalyticsVarUsdM).
 */
export function computeForecastUncertaintyVarUsdM(
  monthlyFlowM: number,
  ccy: string,
  setup: Pick<
    VarSetup,
    | 'confidencePct'
    | 'horizon'
    | 'forecastMonths'
    | 'forecastUncertainty1m'
    | 'exposureBasis'
  >,
): number {
  const σE = forecastErrorStdForSetupM(monthlyFlowM, setup);
  if (σE <= 0) return 0;
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  const z = zForConfidence(setup.confidencePct);
  const Th = horizonMonths(setup.horizon);
  return σE * spotUsd * NORDTECH_VAR.monthlyVol * Math.sqrt(Th) * z;
}

/**
 * Analytics VaR engine (shared across tabs) — four profiles + optional forecast u:
 * - stock:        |S| × σ × √T × z                (√T; forecast u ignored)
 * - simpleAvg:    √(Ē² + σ_E²) × σ × √T × z       (Ē = (S+E_end)/2 mid-point)
 * - avgBuildup:   √(Ē² + σ_E²) × σ × √T × z       (Ē = time-weighted ∫e/T)
 * - totalBuildup: σ × z × √(∫e²dt + σ_E²·T)       (path + quantity variance)
 *
 * u₁ₘ = incremental relative forecast uncertainty (1m). Independent monthly
 * errors compound as √g with g = min(Th,Tf); σ_E²·T grows ~T² when g=T, so
 * higher u adds non-√T curvature on the evolution chart.
 *
 * Simple / weighted averages use the same accrued window g as path/uncertainty —
 * extending Tf past Th must not change VaR at that tenure.
 */
export function computeAnalyticsVarUsdM(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: Pick<
    VarSetup,
    | 'confidencePct'
    | 'horizon'
    | 'forecastMonths'
    | 'exposureBasis'
    | 'forecastUncertainty1m'
  >,
  /** Uneven custom month nets; when set, path/avg use the schedule (not flat F). */
  monthlyFlows?: readonly number[],
): number {
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  const z = zForConfidence(setup.confidencePct);
  const Th = horizonMonths(setup.horizon);
  const σ = NORDTECH_VAR.monthlyVol;
  const schedule =
    monthlyFlows && monthlyFlows.length > 0 ? monthlyFlows : undefined;
  const σE = forecastErrorStdForSetupM(monthlyFlowM, setup, schedule);

  if (setup.exposureBasis === 'totalBuildup') {
    const path = schedule
      ? growingExposurePathFactorFromSchedule(stockM, schedule, Th)
      : growingExposurePathFactor(
          stockM,
          monthlyFlowM,
          Th,
          setup.forecastMonths,
        );
    // √(∫e² dt + σ_E² · Th) — quantity variance accrues over the horizon window
    return Math.sqrt(path * path + σE * σE * Th) * spotUsd * σ * z;
  }
  if (setup.exposureBasis === 'simpleAvg') {
    const eSimple = schedule
      ? simpleAverageFromScheduleM(stockM, schedule, Th)
      : averageExposureAtHorizonM(stockM, monthlyFlowM, setup);
    return (
      Math.sqrt(eSimple * eSimple + σE * σE) * spotUsd * σ * Math.sqrt(Th) * z
    );
  }
  if (setup.exposureBasis === 'avgBuildup') {
    const eAvg = schedule
      ? averageExposureFromScheduleM(stockM, schedule, Th)
      : averageExposureAtHorizonM(stockM, monthlyFlowM, setup);
    // √(Ē² + σ_E²) × σ × √Th × z  →  σ z √(Ē² Th + σ_E² Th)
    return Math.sqrt(eAvg * eAvg + σE * σE) * spotUsd * σ * Math.sqrt(Th) * z;
  }
  // stock — forecast uncertainty does not apply
  return Math.abs(stockM) * spotUsd * σ * Math.sqrt(Th) * z;
}

/** VaR term structure 1w…1y under the active Analytics profile. */
export function growingVarByHorizonUsdM(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: Pick<
    VarSetup,
    'confidencePct' | 'forecastMonths' | 'exposureBasis' | 'forecastUncertainty1m'
  >,
  monthlyFlows?: readonly number[],
): { id: VarHorizonId; label: string; months: number; varUsdM: number }[] {
  return VAR_HORIZON_OPTIONS.map(h => ({
    id: h.id,
    label: h.label,
    months: h.months,
    varUsdM: computeAnalyticsVarUsdM(
      stockM,
      monthlyFlowM,
      ccy,
      { ...setup, horizon: h.id },
      monthlyFlows,
    ),
  }));
}

/** EUR reference exposure for scoring (avg/path use accrued g=min(Th,Tf)). */
export function eurRefExposureM(
  setup: Pick<VarSetup, 'exposureBasis' | 'forecastMonths'> &
    Partial<Pick<VarSetup, 'horizon'>>,
): number {
  // Explicit 0 = no forecast — do not fall back to horizon months.
  const months =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths >= 0
      ? setup.forecastMonths
      : setup.horizon
        ? horizonMonths(setup.horizon)
        : 1;
  if (
    setup.exposureBasis === 'simpleAvg' ||
    setup.exposureBasis === 'avgBuildup' ||
    setup.exposureBasis === 'totalBuildup'
  ) {
    const Th = setup.horizon ? horizonMonths(setup.horizon) : months;
    const g = accruedForecastMonths(Th, months);
    return exposureLocalMForBasis(
      EUR_REF_STOCK_M,
      EUR_REF_FLOW_M,
      setup.exposureBasis,
      g,
    );
  }
  return exposureLocalMForBasis(
    EUR_REF_STOCK_M,
    EUR_REF_FLOW_M,
    setup.exposureBasis,
    months,
  );
}

/**
 * @deprecated Prefer eurRefExposureM(setup) — avg/total depend on forecast months.
 * Kept for stock / simpleAvg / avgBuildup static lookups at 1m (avg = S + ½F).
 */
export const EUR_REF_EXPOSURE_M: Record<
  'stock' | 'simpleAvg' | 'avgBuildup',
  number
> = {
  stock: EUR_REF_STOCK_M,
  simpleAvg: EUR_REF_STOCK_M + 0.5 * EUR_REF_FLOW_M, // 2.5 at 1m
  avgBuildup: EUR_REF_STOCK_M + 0.5 * EUR_REF_FLOW_M, // 2.5 at 1m (flat)
};

/** Expected EUR VaR ($M) for a full Analytics setup. */
export function expectedEurVarUsdM(setup: VarSetup): number {
  return computeAnalyticsVarUsdM(EUR_REF_STOCK_M, EUR_REF_FLOW_M, 'EUR', setup);
}

export function setupLabel(setup: VarSetup): string {
  const h = VAR_HORIZON_OPTIONS.find(x => x.id === setup.horizon)?.label ?? setup.horizon;
  const b = VAR_EXPOSURE_OPTIONS.find(x => x.id === setup.exposureBasis)?.label ?? setup.exposureBasis;
  const T =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths >= 0
      ? setup.forecastMonths
      : 1;
  const f =
    T === 0
      ? 'F×0 (no forecast)'
      : T === 1
        ? 'F×1m'
        : `F×${T}m`;
  const u =
    typeof setup.forecastUncertainty1m === 'number' && setup.forecastUncertainty1m > 0
      ? ` · u₁ₘ ${(setup.forecastUncertainty1m * 100).toFixed(0)}%`
      : '';
  // Vol horizon ≠ FX Risk forecast period — always show both.
  return `${setup.confidencePct}% · vol ${h} · ${f} · ${b}${u}`;
}
