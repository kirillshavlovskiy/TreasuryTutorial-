import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  type VarConfidencePct,
  isVarConfidencePct,
  zForConfidence,
} from '@/lib/test-mode/var-confidence';

/** Which exposure feeds parametric VaR. */
export type VarExposureBasis = 'stock' | 'avgBuildup';

/** VaR horizon — vol scales with √T from the 1-month curriculum σ. */
export type VarHorizonId = '1w' | '1m' | '3m' | '6m' | '1y';

export interface VarSetup {
  confidencePct: VarConfidencePct;
  exposureBasis: VarExposureBasis;
  horizon: VarHorizonId;
}

export const VAR_EXPOSURE_OPTIONS: {
  id: VarExposureBasis;
  label: string;
  description: string;
}[] = [
  {
    id: 'stock',
    label: 'Stock now',
    description: 'Cash FX + rReceivables + Liability (spot book).',
  },
  {
    id: 'avgBuildup',
    label: 'Avg monthly buildup',
    description: 'S + 1.5×F — stock plus forecast / flow buildup over the month.',
  },
];

export const VAR_HORIZON_OPTIONS: {
  id: VarHorizonId;
  label: string;
  /** Horizon length in months (for √T vol scaling). */
  months: number;
}[] = [
  { id: '1w', label: '1 week', months: 0.25 },
  { id: '1m', label: '1 month', months: 1 },
  { id: '3m', label: '3 months', months: 3 },
  { id: '6m', label: '6 months', months: 6 },
  { id: '1y', label: '1 year', months: 12 },
];

export const DEFAULT_VAR_SETUP: VarSetup = {
  confidencePct: 95,
  exposureBasis: 'stock',
  horizon: '1m',
};

export function isVarExposureBasis(v: unknown): v is VarExposureBasis {
  return v === 'stock' || v === 'avgBuildup';
}

export function isVarHorizonId(v: unknown): v is VarHorizonId {
  return v === '1w' || v === '1m' || v === '3m' || v === '6m' || v === '1y';
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

export function horizonMonths(horizon: VarHorizonId): number {
  return VAR_HORIZON_OPTIONS.find(h => h.id === horizon)?.months ?? 1;
}

/** σ_T = σ_1m × √(T / 1m). */
export function volForHorizon(horizon: VarHorizonId): number {
  return NORDTECH_VAR.monthlyVol * Math.sqrt(horizonMonths(horizon));
}

export function parseVarSetup(partial: {
  varConfidencePct?: string;
  varExposureBasis?: string;
  varHorizon?: string;
}): VarSetup | null {
  const confidencePct = (() => {
    const n = Number(String(partial.varConfidencePct ?? '').replace(/%/g, '').trim());
    return isVarConfidencePct(n) ? n : null;
  })();
  const exposureBasis = parseVarExposureBasis(partial.varExposureBasis);
  const horizon = parseVarHorizonId(partial.varHorizon);
  if (!confidencePct || !exposureBasis || !horizon) return null;
  return { confidencePct, exposureBasis, horizon };
}

/**
 * Parametric VaR in USD millions:
 *   |E| × spot × σ_1m × √T_months × z
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

/** EUR reference exposures for scoring (curriculum NordTech book). */
export const EUR_REF_EXPOSURE_M: Record<VarExposureBasis, number> = {
  stock: 4.9,
  /** 4.9 + 1.5 × 1.2 revenue flow. */
  avgBuildup: 4.9 + 1.5 * 1.2, // 6.7
};

/** Expected EUR VaR ($M) for a full Analytics setup. */
export function expectedEurVarUsdM(setup: VarSetup): number {
  return computeParametricVarUsdM(
    EUR_REF_EXPOSURE_M[setup.exposureBasis],
    'EUR',
    setup,
  );
}

export function setupLabel(setup: VarSetup): string {
  const h = VAR_HORIZON_OPTIONS.find(x => x.id === setup.horizon)?.label ?? setup.horizon;
  const b = VAR_EXPOSURE_OPTIONS.find(x => x.id === setup.exposureBasis)?.label ?? setup.exposureBasis;
  return `${setup.confidencePct}% · ${h} · ${b}`;
}
