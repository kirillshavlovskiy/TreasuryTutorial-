/**
 * Curriculum VaR inputs for Sigma Task 01 (episode var.json semantics).
 *
 * Exposure basis for scoring: STOCK net (EUR €4.9M), not the 3-month average.
 * Using avg (€6.7M) would land ~$275K at 95% — the guide flags that as a common mistake.
 *
 * EUR spot is reporting-normalized (~1.0):
 *   95%: |4.9| × spot × 2.5% × 1.645 ≈ $202K
 *   99%: |4.9| × spot × 2.5% × 2.326 ≈ $285K  ← Task 01 Analytics target
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
