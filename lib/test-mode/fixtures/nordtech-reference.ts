/** Hidden reference book for Sigma Task 01 scoring (±5%). */

import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import type { VarConfidencePct } from '@/lib/test-mode/var-confidence';

export const SCORE_TOLERANCE = 0.05;

/** EUR stock × monthly vol × z99 (curriculum spots). */
const EUR_VAR_99_USD_M =
  4.9 * NORDTECH_VAR.monthlyVol * NORDTECH_VAR.z99; // ≈ 0.285

export const NORDTECH_REFERENCE = {
  requiredEntityCodes: ['US', 'DE', 'PL'] as const,
  /** EUR stock net (local M) — cash Frankfurt + receivables. */
  eurStockNetM: 4.9,
  /** PLN stock net (local M) — payroll accrual short. */
  plnStockNetM: -1.8,
  /** Analytics step: student must set this confidence. */
  requiredVarConfidencePct: 99 as VarConfidencePct,
  /** EUR 1-month 99% VaR in USD millions (~$285K) — scored answer. */
  eurVarUsdM: EUR_VAR_99_USD_M,
  /** Legacy 95% figure (~$202K) — curriculum compare only. */
  eurVarUsdM95: 0.202,
  /** PLN VaR context at 95% (~$46K) — not a hard pass gate. */
  plnVarUsdM: 0.046,
  handEstimateUsdM: 0.285,
} as const;

export function withinTolerance(
  actual: number,
  expected: number,
  tol = SCORE_TOLERANCE,
): boolean {
  if (expected === 0) return Math.abs(actual) <= tol;
  return Math.abs(actual - expected) / Math.abs(expected) <= tol;
}

export function toleranceBand(expected: number, tol = SCORE_TOLERANCE): { lo: number; hi: number } {
  return { lo: expected * (1 - tol), hi: expected * (1 + tol) };
}
