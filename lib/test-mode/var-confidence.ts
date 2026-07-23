/** Parametric VaR confidence levels used in Analytics / Hedging Decision. */

export type VarConfidencePct = 90 | 95 | 99;

/** One-tailed normal z for common confidence levels. */
export const VAR_Z_BY_CONFIDENCE: Record<VarConfidencePct, number> = {
  90: 1.282,
  95: 1.645,
  99: 2.326,
};

export const VAR_CONFIDENCE_OPTIONS: {
  pct: VarConfidencePct;
  label: string;
  z: number;
}[] = [
  { pct: 90, label: '90%', z: VAR_Z_BY_CONFIDENCE[90] },
  { pct: 95, label: '95%', z: VAR_Z_BY_CONFIDENCE[95] },
  { pct: 99, label: '99%', z: VAR_Z_BY_CONFIDENCE[99] },
];

export function isVarConfidencePct(v: unknown): v is VarConfidencePct {
  return v === 90 || v === 95 || v === 99;
}

export function parseVarConfidencePct(raw: string | number | undefined | null): VarConfidencePct | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/%/g, '').trim());
  return isVarConfidencePct(n) ? n : null;
}

export function zForConfidence(pct: VarConfidencePct): number {
  return VAR_Z_BY_CONFIDENCE[pct];
}
