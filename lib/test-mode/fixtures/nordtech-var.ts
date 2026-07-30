/**
 * Curriculum VaR inputs for Sigma Task 01 (episode var.json semantics).
 *
 * Exposure basis for scoring: STOCK net after debt
 *   EUR = cash + receivables − venture debt = 4.9 − 3.0 = €1.9M
 * Forecast: Net FX + monthly flow × T (e.g. 1.9 + 1.2 at 1m).
 *
 * EUR spot is reporting-normalized (~1.0):
 *   95%: |1.9| × spot × 2.5% × 1.645 ≈ $78K
 *   99%: |1.9| × spot × 2.5% × 2.326 ≈ $110K  ← Task 01 Analytics target
 */
export const NORDTECH_VAR = {
  monthlyVol: 0.025,
  z90: 1.282,
  z95: 1.645,
  z99: 2.326,
  horizonLabel: '1 month',
  /** Default display confidence before student sets Analytics. */
  confidenceLabel: '95%',
  /** Which ladder exposure feeds the scored VaR figure. */
  exposureBasis: 'stock' as const,
  /** USD per 1 local unit — curriculum spots for Task 01 VaR (not live TMS). */
  spotUsd: {
    EUR: 1.0,
    PLN: 0.6214,
    USD: 1.0,
    GBP: 1.26,
  } as Record<string, number>,
} as const;
