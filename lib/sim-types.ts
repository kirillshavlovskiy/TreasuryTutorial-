// Simulator row type exports for UI components
// Combines RowState, computed metrics, and resolved field values

import type { RowState } from './fx-buffer';
import type { SimFieldKey } from './sim-formulas';

/** Resolved simulator field values per row */
export interface SimRowResolved {
  troughCash?: number;
  cycleNetFlow?: number;
  totalCash?: number;
  totalCashUSD?: number;
  targetCash?: number;
  targetCashUSD?: number;
  swapNear?: number;
  swapUSD?: number;
  lpSwap?: number;
  lpSwapUSD?: number;
  cycleEnd?: number;
  cycleEndUSD?: number;
  fwdHedgeFCY?: number;
  hedgeDelta?: number;
  fwdHedgeUsd?: number;  // Alias for fwdHedgeUSD
  fwdHedgeUSD?: number;
  optionHedgeUSD?: number;
  optionHedgeUsd?: number;  // Alias for consistency
  cipCarry?: number;
  hedgeCarry?: number;
  hedgeCash?: number;
  bufferCarry?: number;
}

/** Complete simulator row for UI display */
export type SimRow = RowState & SimRowResolved & {
  // Additional computed metrics
  cashPos?: number;
  cashPosUSD?: number;
  fxSpotFCY?: number;
  fxSpotUSD?: number;
  fxFwdFCY?: number;
  fxFwdUSD?: number;
  fxNonCashUSD?: number;
  fxNonCashAssetUSD?: number;
  netFxFCY?: number;
  netFxUSD?: number;
  netFxForecast?: number;
  varFactor?: number;
  irMult?: number;
  varBuffer?: number;
  cash_threshold?: number;
  cash_threshold_pre_swap?: number;
  cashThresholdUSD?: number;
  postSwapUSD?: number;
  H_pct?: number;
  delta_r?: number;
  carryDir?: 'earn' | 'pay' | 'neutral';
  shortfallPct?: number;
  lp_peak_cash?: number;
  troughDay?: number;
  cycleDrawdown?: number;
  troughCycleIndex?: number;
  sizingCycleIndex?: number;
  nearCycleTrough?: number;
  // Carry fields
  cashCarryUsdM?: number;
  bufferCarryUsdM?: number;
  hedgeCarryUsdM?: number;
  // UI display fields
  closeBalance?: number;
  carryRate?: number;
  swapBook?: number;
};
