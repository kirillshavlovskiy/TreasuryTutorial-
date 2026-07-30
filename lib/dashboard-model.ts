/**
 * Unified dashboard model — single background calculation feeding FX Simulator
 * and Layer Setup. Targets (layers + portfolio + stress) run on every FCY row
 * in `rows`, then simulator row math applies those thresholds.
 */

import {
  CURRENCY_PARAMS,
  calcOptimalBuffer,
  computeLayeredBuffer,
  netPayoutDeficit,
  computeUsdBuffer,
  computeFcySwapNear,
  applyNoNegativeNpFloor,
  applyHardMinFloor,
  assessUsdLiquidityPriority,
  deriveUsdLiquidity,
  enforceUsdLiquidityStress,
  enforcePortfolioVarCap,
  usdActiveLayers,
  sumFcySwapNearUsd,
  optimizePortfolioCarry,
  computePortfolioVAR,
  var95_1m_factor,
  combinedMultiplier,
  ccySpotRate,
  fcyToUsdM,
  usdToFcyM,
  roundMoney,
  fxBookNetLocalM,
  type LayerId,
  type LayerResult,
  type LayeredBufferResult,
  type PortfolioCarryResult,
  type RowState,
  type SharedGlobals,
  type UsdParams,
} from './fx-buffer';
import {
  periodFlowSumLocalM,
  type ForecastProfileState,
} from './forecast-profile';

// ─── Simulator row math (lifted from UnifiedSimulator) ───────────────────────

export interface SimRowComputed {
  cashPos: number;
  cashPosUSD: number;
  /** TMS spot FX exposure (M FCY). */
  fxSpotFCY: number;
  fxSpotUSD: number;
  /** Forward settlement — stored USD, derived FCY. */
  fxFwdFCY: number;
  fxFwdUSD: number;
  fxNonCashUSD: number;
  /** Non-cash ASSET FX exposure converted to $USD M (accruals/receivables/NDF assets). */
  fxNonCashAssetUSD: number;
  /** Deliverable FX book: spot + fwd + non-cash liability + non-cash asset in one unit. */
  netFxFCY: number;
  netFxUSD: number;
  /** Forecast net FX exposure at cycle end = current net FX book (spot + fwd +
   *  non-cash) + expected payins + payouts (M FCY) — the hedging basis. */
  netFxForecast: number;
  /** @deprecated use netFxFCY — kept for existing UI bindings */
  netFX: number;
  npNetFX: number;
  varFactor: number;
  irMult: number;
  varBuffer: number;
  /** Target NP Cash = Opening NP + Swap — the cash target the swap funds to (before payout).
   *  Equals NP+Swap by construction (swap is sized to reach this target). The cushion that
   *  survives the payout is `np_after_swap_trough` (= cash_threshold − payout). */
  cash_threshold: number;
  /** Trough cushion H* from layer model (what must remain AFTER payout) — sizes the swap. */
  cash_threshold_pre_swap: number;
  /** Target NP cash in USD (M USD) = Target × spot. */
  cashThresholdUSD: number;
  /** NP+Swap in USD (M USD) = (opening NP + swap) × spot. */
  postSwapUSD: number;
  H_pct: number;
  delta_r: number;
  carryDir: 'earn' | 'pay' | 'neutral';
  shortfallPct: number;
  np_peak_cash: number;
  /** Cycle Net Flow: NP + Non-NP + payouts + payins — before swap. */
  cash_after_payins: number;
  np_month_end: number;
  swapNear: number;
  swapFar: number;
  /** NP+Swap = Opening NP Cash + Swap Near — the funded NP position right after the swap,
   *  before the payout leaves (positive when opening NP and swap are positive). */
  postSwapCash: number;
  /** H* at trough = trough + swap = post-payout cushion (used for hedging / VAR). */
  np_after_swap_trough?: number;
  /** Pre-far-leg NP at cycle end: NP+Swap − payout + payins + invoice fcast + Non-NP swept back. */
  cycleEndCash: number;
  postSwapVar: number;
  varChange: number;
  swap_carry: number;
  /** Annual USD swap P&L ($M/yr). Under CIP the FX swap is carry-neutral at mid,
   *  so this is 0 — any earn/pay on FCY cash is already in `floatNim` on the
   *  post-swap balance (the swap cancels the differential on the moved notional). */
  swapCarryUsdYr: number;
  usd_consumed: number;
  carry: number;
  netDelta: number;
  /** Annual USD economic carry on the post-swap NP cash balance ($M/yr):
   *  cashTwa(postSwap) × spot × (r_actual − r_USD)/100, where r_actual is the
   *  NP credit rate when the balance is ≥ 0 and the debit rate when overdrawn.
   *  Opening-cash carry that was swapped away is NOT counted — CIP cancels it. */
  floatNim: number;
  /** True when USD funding envelope / stress prevents reaching pre-swap H*. */
  funding_binding?: boolean;
}

export interface UsdRowComputed extends SimRowComputed {
  usd_reserved: number;
  usd_available_for_fcy: number;
  usd_fcy_shortfall: number;
  usd_envelope_shortfall: number;
  usd_budget_binding: boolean;
}

export type FcyComputedRow = RowState & SimRowComputed & {
  cash_threshold_raw?: number;
  debit_floor_binding?: boolean;
  usd_stress_trim?: boolean;
  /** Overlay leg vs hold-the-book base (M FCY). 0 when the portfolio VAR layer is off. */
  overlayLeg: number;
  /** Annual USD carry P&L earned by this row's overlay leg ($M/yr): leg × spot × (r_FCY − r_USD)/100. */
  overlayCarryUSD: number;
};
export type UsdComputedRow = RowState & UsdRowComputed;

/**
 * Timing of intra-cycle flows, as the fraction of the cycle elapsed BEFORE the
 * flow lands (0 = start, 1 = end). Carry weight for a flow is (1 − fraction):
 * a payout mid-cycle sheds cash for the back half; a payin at EOM earns nothing.
 * Omitting timing (fraction = 1) reproduces the opening-balance carry.
 */
export interface TimingInput {
  fPayout: number;
  fPayin: number;
}

export function computeSimdRow(
  r: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  syncedThreshold?: number,
  syncedSwap?: number,
  timing?: TimingInput,
  forecastProfile?: ForecastProfileState | null,
): SimRowComputed {
  const cashPos = r.cash + r.nonNpCash;
  const spot_rate = ccySpotRate(r.ccy);

  const fxSpotFCY = r.spot;
  const fxSpotUSD = fcyToUsdM(r.spot, r.ccy);
  const fxFwdUSD = r.fwd;
  const fxFwdFCY = usdToFcyM(r.fwd, r.ccy);
  const fxNonCashUSD = fcyToUsdM(r.nonCash, r.ccy);
  const fxNonCashAssetUSD = fcyToUsdM(r.nonCashAsset ?? 0, r.ccy);
  // Long book − FCY debt (+investments). Debt notional is a short → deducted.
  const netFxFCY = fxBookNetLocalM(r);
  const netFxUSD = roundMoney(
    fxSpotUSD
      + fxFwdUSD
      + fxNonCashUSD
      + fxNonCashAssetUSD
      + fcyToUsdM(r.ir_invest_notional ?? 0, r.ccy)
      - fcyToUsdM(r.ir_liab_notional, r.ccy),
  );
  // Forecast net FX over the FX Risk period: book + flat (F×T) or custom Σ months.
  // T = 0 → no forecast (Net FX Forecast = Net FX book only).
  const T =
    typeof shared.forecastMonths === 'number' && shared.forecastMonths >= 0
      ? shared.forecastMonths
      : 1;
  const periodFlow = periodFlowSumLocalM(r, T, forecastProfile);
  const netFxForecast = roundMoney(netFxFCY + periodFlow);

  const varFactor = var95_1m_factor(r.σ_daily);
  const irMult = combinedMultiplier(r.r_FCY, r.β_IR);

  const payoutDeficit = netPayoutDeficit(r.payout, r.cash);
  const grossPayout = Math.abs(r.payout);

  const np_peak_cash = r.cash + r.payout;
  const peak_cash = cashPos + r.payout;
  const cash_after_payins = cashPos + r.payout + r.collections;
  const np_month_end = cash_after_payins;

  const layered = computeLayeredBuffer(
    grossPayout, np_peak_cash, shared.σ_P, shared.r_USD, r.r_FCY, r.r_OD, r.cash_floor, activeLayers, r.cash,
  );
  const cash_threshold_pre_swap = syncedThreshold ?? layered.cash_threshold;

  const opt = calcOptimalBuffer({
    P: payoutDeficit || 0.001, σ_P: shared.σ_P, r_USD: shared.r_USD,
    r_FCY: r.r_FCY, r_OD: r.r_OD, days: shared.days, cash_floor: r.cash_floor,
  });

  const varBuffer = Math.max(r.cash_floor, Math.abs(peak_cash) * varFactor * irMult);

  const formulaLayersActive = activeLayers.has('floorH') || activeLayers.has('sigmaP')
    || activeLayers.has('carryOptim') || activeLayers.has('portfolioDiv');

  const swapNear = syncedSwap ?? computeFcySwapNear(
    cash_threshold_pre_swap, cashPos, r.fcastFX, r.r_OD, shared.r_USD, formulaLayersActive, np_peak_cash,
  );
  // Post-payout cushion (trough + swap = H*) — used for hedging / VAR, not shown as NP+Swap.
  const np_after_swap_trough = np_peak_cash + swapNear;
  // NP+Swap = Opening NP + Swap — the funded NP position right after the swap, before payout.
  const postSwapCash = r.cash + swapNear;
  // Target NP Cash = Opening NP + Swap — the cash target the swap funds to (before payout).
  const cash_threshold = r.cash + swapNear;
  // Cycle End = NP+Swap − payout leaves + payins + invoice fcast + Non-NP swept back to NP pool.
  const cycleEndCash = postSwapCash + r.payout + r.collections + r.fcastFX + r.nonNpCash;
  const postSwapVar = Math.max(r.cash_floor, Math.abs(np_after_swap_trough) * varFactor * irMult);
  const varChange = postSwapVar - varBuffer;
  // CIP: FX swap far leg at mid vs term SOFR is carry-neutral on the moved
  // notional — earn/pay on FCY cash is cancelled by the opposite swap points
  // P&L. Economic carry therefore lives entirely on the POST-SWAP balance
  // (see floatNim); swapCarryUsdYr is identically 0.
  const swap_carry = 0;
  const swapCarryUsdYr = 0;

  const usd_consumed = Math.abs(swapNear) * spot_rate;

  const carry = netFxFCY * r.r_FCY / 100 / 12;
  const netDelta = netFxFCY + carry;
  // Time-weighted average NP cash AFTER the funding swap: post-swap opening
  // balance is held for the full period; payout / payins apply only for the
  // remaining (1 − timing) of the cycle. Default (no timing) → postSwapCash.
  // r_actual = NP credit when the TWA balance is ≥ 0, debit when overdrawn.
  const payoutWeight = timing ? (1 - timing.fPayout) : 0;
  const payinWeight = timing ? (1 - timing.fPayin) : 0;
  const cashTwa = postSwapCash + r.payout * payoutWeight + r.collections * payinWeight;
  const r_actual = cashTwa >= 0 ? r.r_FCY : r.r_OD;
  const floatNim = cashTwa * (r_actual - shared.r_USD) / 100 * spot_rate;
  const npNetFX = r.cash + fxFwdFCY;

  return {
    cashPos, cashPosUSD: cashPos * spot_rate,
    fxSpotFCY, fxSpotUSD, fxFwdFCY, fxFwdUSD, fxNonCashUSD, fxNonCashAssetUSD, netFxFCY, netFxUSD, netFxForecast,
    netFX: netFxFCY, npNetFX, varFactor, irMult, varBuffer,
    cash_threshold, cash_threshold_pre_swap,
    H_pct: payoutDeficit > 0 ? (cash_threshold_pre_swap / payoutDeficit) * 100 : 0,
    cashThresholdUSD: fcyToUsdM(cash_threshold, r.ccy),
    postSwapUSD: fcyToUsdM(postSwapCash, r.ccy),
    delta_r: opt.delta_r, carryDir: opt.carry_direction, shortfallPct: opt.shortfall_prob_pct,
    np_peak_cash, cash_after_payins, np_month_end,
    swapNear, swapFar: -swapNear,
    postSwapCash, np_after_swap_trough, cycleEndCash, postSwapVar, varChange,
    swap_carry, swapCarryUsdYr, usd_consumed,
    carry, netDelta, floatNim,
  };
}

/** USD row — swap = −Σ(FCY swap); Target = opening NP + swap (post-swap NP). */
export function computeSimdUsdRow(
  r: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  fcySwapNearUsd: number,
  syncedThreshold?: number,
  syncedSwap?: number,
): UsdRowComputed {
  const cashPos = r.cash + r.nonNpCash;
  const peak_cash = cashPos + r.payout;
  const np_peak_cash = r.cash + r.payout;
  const cash_after_payins = cashPos + r.payout + r.collections;
  const np_month_end = cash_after_payins;

  const formulaLayersActive = activeLayers.has('floorH') || activeLayers.has('sigmaP')
    || activeLayers.has('carryOptim') || activeLayers.has('portfolioDiv');
  const payoutDeficit = netPayoutDeficit(r.payout, r.cash);
  const payoutBuffer = computeUsdBuffer(
    r.payout, r.cash_floor, shared.σ_P, usdActiveLayers(activeLayers),
  ).cash_threshold;
  const derived = deriveUsdLiquidity(
    payoutBuffer, fcySwapNearUsd, r.cash, r.payout, formulaLayersActive,
  );

  const cash_threshold_pre_swap = syncedThreshold ?? derived.cash_threshold;
  const swapNear = syncedSwap ?? (formulaLayersActive ? derived.swapNear : -fcySwapNearUsd);
  const np_after_swap_trough = np_peak_cash + swapNear;
  // NP+Swap = Opening NP + Swap (funded position after swap, before payout).
  const postSwapCash = r.cash + swapNear;
  // Target = Opening NP + Swap — the cash target the swap funds to (before payout).
  const cash_threshold = r.cash + swapNear;
  // Cycle End = NP+Swap − payout + payins + Non-NP swept back.
  const cycleEndCash = postSwapCash + r.payout + r.collections + r.fcastFX + r.nonNpCash;
  const envelopeGap = formulaLayersActive
    ? Math.abs(np_after_swap_trough - cash_threshold_pre_swap)
    : 0;
  const funding_binding = formulaLayersActive
    && (derived.budget_binding || envelopeGap > 0.01);
  const opt = calcOptimalBuffer({
    P: payoutDeficit || 0.001, σ_P: shared.σ_P, r_USD: shared.r_USD,
    r_FCY: r.r_FCY, r_OD: r.r_OD, days: shared.days, cash_floor: r.cash_floor,
  });

  return {
    cashPos, cashPosUSD: cashPos,
    fxSpotFCY: 0,
    fxSpotUSD: r.spot,
    fxFwdFCY: 0,
    fxFwdUSD: r.fwd,
    fxNonCashUSD: r.nonCash,
    fxNonCashAssetUSD: r.nonCashAsset ?? 0,
    netFxFCY: 0,
    netFxUSD: r.spot + r.fwd + r.nonCash + (r.nonCashAsset ?? 0),
    netFxForecast: (() => {
      const T =
        typeof shared.forecastMonths === 'number' && shared.forecastMonths >= 0
          ? shared.forecastMonths
          : 1;
      // USD stays on the flat workspace formula (no custom FCY profile).
      return roundMoney((r.collections + r.payout + r.fcastFX) * T);
    })(),
    netFX: 0,
    npNetFX: r.cash + r.fwd,
    varFactor: 0, irMult: 1, varBuffer: 0,
    cash_threshold, cash_threshold_pre_swap,
    H_pct: payoutDeficit > 0 ? (cash_threshold_pre_swap / payoutDeficit) * 100 : 0,
    cashThresholdUSD: cash_threshold,
    postSwapUSD: postSwapCash,
    delta_r: opt.delta_r, carryDir: 'neutral', shortfallPct: opt.shortfall_prob_pct,
    np_peak_cash, cash_after_payins, np_month_end,
    swapNear, swapFar: -swapNear,
    postSwapCash, np_after_swap_trough, cycleEndCash, postSwapVar: 0, varChange: 0,
    swap_carry: 0, swapCarryUsdYr: 0, usd_consumed: 0,
    carry: (r.spot + r.fwd + r.nonCash + (r.nonCashAsset ?? 0)) * r.r_FCY / 100 / 12,
    netDelta: (r.spot + r.fwd + r.nonCash + (r.nonCashAsset ?? 0)) * (1 + r.r_FCY / 100 / 12),
    floatNim: 0,
    funding_binding,
    usd_reserved: derived.reserved_for_payout,
    usd_available_for_fcy: derived.available_for_fcy,
    usd_fcy_shortfall: derived.fcy_funding_shortfall,
    usd_envelope_shortfall: derived.fcy_envelope_shortfall,
    usd_budget_binding: derived.budget_binding,
  };
}

// ─── Layer target pipeline (all FCY rows + USD) ─────────────────────────────

interface Pass1Row extends LayeredBufferResult {
  ccy: string;
  payout: number;
  collections: number;
  cash: number;
  nonNpCash: number;
  total_cash: number;
  h_min: number;
  h_min_per_ccy: number;
  peak_cash: number;
  forecasted_cash: number;
  spot_pos: number;
  spot_raw: number;
  fwd_raw: number;
  r_FCY: number;
  r_OD: number;
  spot: number;
}

export interface LayerTargetRow extends Pass1Row {
  cash_threshold: number;
  delta_portfolio: number;
  /** Hold-the-book neutral position — Policy VAR is charged on deviations from this. */
  base_hold?: number;
  /** Portfolio target before expensive-OD floor (when floored to 0). */
  cash_threshold_raw?: number;
  debit_floor_binding?: boolean;
  swap_needed: number;
  post_swap_cash: number;
  cycle_end_cash: number;
  lambda_val: number;
  lambda_usd_val: number;
  constrained: boolean;
  var_binding: boolean;
  budget_binding: boolean;
  usd_stress_trim?: boolean;
  stress_trim_from?: number;
  var_trim?: boolean;
  var_trim_from?: number;
  usd_available_for_fcy?: number;
  usd_fcy_shortfall?: number;
  usd_stress_binding?: boolean;
  usd_payout_gap?: number;
  usd_liquidity_mode?: 'normal' | 'stress';
  usd_implied_fcy_swap_usd?: number;
  usd_envelope_shortfall?: number;
}

export interface DashboardInputs {
  rows: RowState[];
  usdCash: number;
  usdNonNpCash: number;
  usdParams: UsdParams;
  shared: SharedGlobals;
  activeLayers: Set<LayerId>;
  policyVAR: number;
  /** Optional payin/payout timing that re-weights natural NP cash carry. */
  timing?: TimingInput;
  /** Flat monthly×T or custom per-period Revenue/Expenses profile. */
  forecastProfile?: ForecastProfileState | null;
}

export interface PortfolioSummary {
  portfolio_VAR_USD: number;
  standalone_sum_USD: number;
  div_benefit_USD: number;
  /** Annual USD carry P&L earned by the overlay (EARN buys + PAY sells vs hold-the-book), $M/yr. */
  overlay_carry_USD: number;
  policyVAR: number;
  var_binding: boolean;
  budget_binding: boolean;
  stress_trim: boolean;
  var_trim: boolean;
  lambda_var: number;
  lambda_usd: number;
}

export interface DashboardModel {
  layerRows: LayerTargetRow[];
  layerResults: LayerResult[];
  fcyComputed: FcyComputedRow[];
  usdComputed: UsdComputedRow;
  portfolioSummary: PortfolioSummary | null;
}

function buildPass1Fcy(sr: RowState, shared: SharedGlobals, layersForPass1: Set<LayerId>): Pass1Row {
  const p = CURRENCY_PARAMS[sr.ccy];
  const payout = sr.payout;
  const cash = sr.cash;
  const nonNpCash = sr.nonNpCash;
  const total_cash = cash + nonNpCash;
  const h_min_per_ccy = sr.cash_floor;
  const h_min = h_min_per_ccy;
  const r_FCY = sr.r_FCY;
  const r_OD = sr.r_OD;
  const collections = sr.collections;
  const peak_cash = cash + payout;
  const forecasted_cash = peak_cash + collections;
  const l = computeLayeredBuffer(
    Math.abs(payout), peak_cash, shared.σ_P, shared.r_USD, r_FCY, r_OD, h_min, layersForPass1, cash,
  );
  const spot_raw = sr.spot;
  const fwd_raw = sr.fwd;
  const fwd_fcy = usdToFcyM(fwd_raw, sr.ccy);
  return {
    ccy: sr.ccy, payout, collections, cash, nonNpCash, total_cash, h_min, h_min_per_ccy, peak_cash, forecasted_cash,
    spot_pos: spot_raw + fwd_fcy, spot_raw, fwd_raw, r_FCY, r_OD,
    spot: p?.spot ?? 1, ...l,
  };
}

function buildPass1Usd(
  usdCash: number,
  usdNonNpCash: number,
  usdParams: UsdParams,
  shared: SharedGlobals,
  layersForPass1: Set<LayerId>,
): Pass1Row {
  const payout = usdParams.payout;
  const collections = usdParams.collections;
  const cash = usdCash;
  const nonNpCash = usdNonNpCash;
  const total_cash = cash + nonNpCash;
  const h_min = 0;
  const peak_cash = cash + payout;
  const forecasted_cash = peak_cash + collections;
  const l = computeUsdBuffer(payout, h_min, shared.σ_P, usdActiveLayers(layersForPass1));
  return {
    ccy: 'USD', payout, collections, cash, nonNpCash, total_cash, h_min, h_min_per_ccy: h_min, peak_cash, forecasted_cash,
    spot_pos: 0, spot_raw: 0, fwd_raw: 0,
    r_FCY: usdParams.r_FCY, r_OD: usdParams.r_OD, spot: 1, ...l,
  };
}

/** Layer targets + stress trim for every FCY row in `rows` and USD. */
export function computeLayerTargets(input: DashboardInputs): LayerTargetRow[] {
  const { rows, usdCash, usdNonNpCash, usdParams, shared, activeLayers, policyVAR } = input;
  const portfolioActive = activeLayers.has('portfolioDiv');
  const carryActive = activeLayers.has('carryOptim');

  const layersForPass1 = portfolioActive
    ? new Set([...activeLayers].filter(l => l !== 'carryOptim' && l !== 'portfolioDiv') as LayerId[])
    : activeLayers;

  const pass1Fcy = rows.map(sr => buildPass1Fcy(sr, shared, layersForPass1));
  const pass1Usd = buildPass1Usd(usdCash, usdNonNpCash, usdParams, shared, layersForPass1);

  const deltaPortfolio: Record<string, number> = {};
  const portOptResults: Record<string, PortfolioCarryResult> = {};
  const portOptCarryAdj: Record<string, number> = {};

  const usdPayoutBuffer = pass1Usd.raw_sum;
  const usdPriority = assessUsdLiquidityPriority(usdCash, usdPayoutBuffer);
  const fcyCollateralBudget = usdPriority.available_for_fcy;

  if (portfolioActive) {
    const optInputs = pass1Fcy.map(r => ({
      ccy: r.ccy,
      P: Math.abs(r.payout),
      np_cash: r.cash,
      P_contrib: r.P_contrib,
      forecasted_cash: r.peak_cash,
      floor_contrib: r.floor_contrib,
      delta_sigma: r.delta_sigma,
      r_FCY: r.r_FCY,
      r_OD: r.r_OD,
    }));
    const optResult = optimizePortfolioCarry(
      optInputs, shared.σ_P, shared.r_USD, policyVAR,
      fcyCollateralBudget, carryActive,
    );
    optResult.forEach(r => {
      portOptResults[r.ccy] = r;
      portOptCarryAdj[r.ccy] = r.delta_carry;
      deltaPortfolio[r.ccy] = r.delta_portfolio;
    });
  }

  const formulaLayersActive = activeLayers.has('floorH') || activeLayers.has('sigmaP')
    || activeLayers.has('carryOptim') || activeLayers.has('portfolioDiv');

  const fcyRowsPreStress = pass1Fcy.map(r => {
    const delta_portfolio = deltaPortfolio[r.ccy] ?? 0;
    const opt = portOptResults[r.ccy];
    let cash_threshold = formulaLayersActive
      ? (portfolioActive
        ? (opt?.cash_threshold ?? r.raw_sum)
        : r.raw_sum + delta_portfolio + (portOptCarryAdj[r.ccy] ?? 0))
      : r.peak_cash;
    const cash_threshold_raw = opt?.cash_threshold_raw ?? cash_threshold;
    if (!portfolioActive && formulaLayersActive) {
      ({ cash_threshold } = applyNoNegativeNpFloor(cash_threshold, r.r_OD, shared.r_USD));
    }
    // Hard minimum: with the floor layer on, the target never drops below cash_floor.
    if (formulaLayersActive) {
      cash_threshold = applyHardMinFloor(cash_threshold, r.floor_contrib);
    }
    const debit_floor_binding = opt?.debit_floor_binding
      ?? (cash_threshold_raw < -0.001 && cash_threshold >= -0.001);
    const swap_needed = computeFcySwapNear(
      cash_threshold, r.total_cash, 0, r.r_OD, shared.r_USD, formulaLayersActive, r.peak_cash,
    );
    const delta_carry_final = portfolioActive
      ? (portOptCarryAdj[r.ccy] ?? 0)
      : (portOptResults[r.ccy]?.delta_carry ?? r.delta_carry);
    const post_swap_cash = r.peak_cash + swap_needed;
    const cycle_end_cash = post_swap_cash + r.collections;
    return {
      ...r, cash_threshold, cash_threshold_raw, debit_floor_binding,
      delta_portfolio, swap_needed, post_swap_cash, cycle_end_cash,
      base_hold: opt?.base_hold ?? cash_threshold,
      delta_carry: delta_carry_final,
      lambda_val: opt?.lambda ?? 0,
      lambda_usd_val: opt?.lambda_usd ?? 0,
      constrained: opt?.constrained ?? false,
      var_binding: opt?.var_binding ?? false,
      budget_binding: opt?.budget_binding ?? false,
    };
  });

  const preStressSwapUsd = sumFcySwapNearUsd(
    fcyRowsPreStress.map(r => ({ ccy: r.ccy, swapNear: r.swap_needed })),
  );
  const preStressLiquidity = deriveUsdLiquidity(
    usdPayoutBuffer, preStressSwapUsd, usdCash, usdParams.payout, formulaLayersActive,
  );
  const needsStressRebalance = preStressLiquidity.budget_binding;

  const stress = formulaLayersActive && needsStressRebalance
    ? enforceUsdLiquidityStress(
      fcyRowsPreStress.map(r => ({
        ccy: r.ccy,
        cash_threshold: r.cash_threshold,
        total_cash: r.total_cash,
        cash: r.cash,
        payout: r.payout,
        P_contrib: r.P_contrib,
        floor_contrib: r.floor_contrib,
        delta_sigma: r.delta_sigma,
        r_FCY: r.r_FCY,
        r_OD: r.r_OD,
      })),
      usdCash,
      usdPayoutBuffer,
      shared.r_USD,
      formulaLayersActive,
      usdParams.payout,
    )
    : null;

  const pass1BaseByCcy = Object.fromEntries(pass1Fcy.map(r => [r.ccy, r.cash_threshold]));

  const fcyRowsAfterStress = fcyRowsPreStress.map(r => {
    const s = stress?.rows.find(sr => sr.ccy === r.ccy);
    if (!s) return r;
    return {
      ...r,
      cash_threshold: s.cash_threshold,
      swap_needed: s.swap_needed,
      post_swap_cash: r.peak_cash + s.swap_needed,
      cycle_end_cash: r.peak_cash + s.swap_needed + r.collections,
      usd_stress_trim: s.usd_stress_trim,
      stress_trim_from: s.stress_trim_from,
      budget_binding: r.budget_binding || s.usd_stress_trim || stress!.stress_binding,
      constrained: r.constrained || s.usd_stress_trim,
    };
  });

  let fcyRows = fcyRowsAfterStress as LayerTargetRow[];
  if (portfolioActive) {
    const cap = enforcePortfolioVarCap(
      fcyRows.map(r => ({
        ccy: r.ccy,
        cash_threshold: r.cash_threshold,
        // Stress-trimmed rows are funding-forced, not discretionary — the cap
        // must not scale them back up toward the hold-the-book base.
        liquidity_base: r.usd_stress_trim
          ? r.cash_threshold
          : (r.base_hold ?? pass1BaseByCcy[r.ccy] ?? r.cash_threshold),
        trough_np: r.peak_cash,
        total_cash: r.total_cash,
        cash: r.cash,
        payout: r.payout,
        r_OD: r.r_OD,
      })),
      policyVAR,
      shared.r_USD,
      formulaLayersActive,
    );
    fcyRows = fcyRows.map(r => {
      const capped = cap.rows.find(c => c.ccy === r.ccy)!;
      return {
        ...r,
        cash_threshold: capped.cash_threshold,
        swap_needed: capped.swap_needed,
        post_swap_cash: r.peak_cash + capped.swap_needed,
        cycle_end_cash: r.peak_cash + capped.swap_needed + r.collections,
        var_trim: capped.var_trim,
        var_trim_from: capped.var_trim_from,
        var_binding: r.var_binding || cap.var_binding,
        constrained: r.constrained || capped.var_trim,
      };
    });
  }

  const fcySwapNearUsd = sumFcySwapNearUsd(
    fcyRows.map(r => ({ ccy: r.ccy, swapNear: r.swap_needed })),
  );

  const usdDerived = deriveUsdLiquidity(
    pass1Usd.raw_sum, fcySwapNearUsd, usdCash, usdParams.payout, formulaLayersActive,
  );
  const usdCash_threshold = formulaLayersActive ? usdDerived.cash_threshold : pass1Usd.peak_cash;
  const usdSwap_needed = formulaLayersActive ? usdDerived.swapNear : -fcySwapNearUsd;
  const anyStressTrim = fcyRows.some(fr => (fr as LayerTargetRow).usd_stress_trim);

  const usdRow: LayerTargetRow = {
    ...pass1Usd,
    cash_threshold: usdCash_threshold,
    cash_threshold_raw: usdCash_threshold,
    delta_portfolio: 0,
    swap_needed: usdSwap_needed,
    post_swap_cash: pass1Usd.peak_cash + usdSwap_needed,
    cycle_end_cash: pass1Usd.peak_cash + usdSwap_needed + pass1Usd.collections,
    delta_carry: 0,
    lambda_val: 0,
    lambda_usd_val: 0,
    constrained: usdDerived.budget_binding || anyStressTrim,
    var_binding: false,
    budget_binding: usdDerived.budget_binding,
    usd_available_for_fcy: usdDerived.available_for_fcy,
    usd_fcy_shortfall: usdDerived.fcy_funding_shortfall,
    usd_stress_binding: stress?.stress_binding ?? false,
    usd_payout_gap: usdPriority.usd_payout_gap,
    usd_liquidity_mode: needsStressRebalance ? 'stress' : 'normal',
    usd_implied_fcy_swap_usd: usdDerived.implied_fcy_swap_usd,
    usd_envelope_shortfall: usdDerived.fcy_envelope_shortfall,
  };

  return [...fcyRows as LayerTargetRow[], usdRow];
}

/** Full dashboard: layer targets → simulator rows for every currency in `rows` + USD. */
export function computeDashboardModel(input: DashboardInputs): DashboardModel {
  const layerRows = computeLayerTargets(input);
  const thresholdByCcy = Object.fromEntries(layerRows.map(r => [r.ccy, r.cash_threshold]));
  const swapByCcy = Object.fromEntries(layerRows.map(r => [r.ccy, r.swap_needed]));

  const layerByCcy = Object.fromEntries(layerRows.map(r => [r.ccy, r]));

  const fcyComputed = input.rows.map(r => {
    const layer = layerByCcy[r.ccy] as LayerTargetRow | undefined;
    // Overlay leg = deviation of the layer target from hold-the-book base (0 when the
    // VAR layer is off or the row is stress-trimmed) — the discretionary disposition.
    const overlayLeg = (layer && !layer.usd_stress_trim)
      ? layer.cash_threshold - (layer.base_hold ?? layer.cash_threshold)
      : 0;
    // Incremental overlay P&L vs hold-the-book (banner metric only). Total row
    // P&L already includes this via floatNim on the post-swap target balance —
    // do NOT add overlayCarryUSD into Cash/Swap/Total Carry columns.
    const overlayCarryUSD = overlayLeg * (CURRENCY_PARAMS[r.ccy]?.spot ?? 0)
      * (r.r_FCY - input.shared.r_USD) / 100;
    const row = {
      ...r,
      ...computeSimdRow(
        r,
        input.shared,
        input.activeLayers,
        thresholdByCcy[r.ccy],
        swapByCcy[r.ccy],
        input.timing,
        input.forecastProfile,
      ),
      cash_threshold_raw: layer?.cash_threshold_raw,
      debit_floor_binding: layer?.debit_floor_binding,
      usd_stress_trim: layer?.usd_stress_trim,
      funding_binding: !!(layer?.usd_stress_trim || layer?.budget_binding),
      overlayLeg,
      overlayCarryUSD,
    };
    return row;
  });

  const fcySwapNearUsd = sumFcySwapNearUsd(
    fcyComputed.map(r => ({ ccy: r.ccy, swapNear: r.swapNear })),
  );

  const fxTotals = fcyComputed.reduce(
    (a, r) => ({
      fxSpotUSD: a.fxSpotUSD + r.fxSpotUSD,
      fxFwdUSD: a.fxFwdUSD + r.fxFwdUSD,
      fxNonCashUSD: a.fxNonCashUSD + r.fxNonCashUSD,
      fxNonCashAssetUSD: a.fxNonCashAssetUSD + r.fxNonCashAssetUSD,
      cashPosUSD: a.cashPosUSD + r.cashPosUSD,
    }),
    { fxSpotUSD: 0, fxFwdUSD: 0, fxNonCashUSD: 0, fxNonCashAssetUSD: 0, cashPosUSD: 0 },
  );

  const usdState: RowState = {
    id: 'USD', ccy: 'USD',
    σ_daily: input.usdParams.σ_daily,
    r_FCY: input.usdParams.r_FCY,
    r_OD: input.usdParams.r_OD,
    β_IR: input.usdParams.β_IR,
    spot: -fxTotals.fxSpotUSD,
    fwd: -fxTotals.fxFwdUSD,
    nonCash: -fxTotals.fxNonCashUSD,
    nonCashAsset: -fxTotals.fxNonCashAssetUSD,
    cash: input.usdCash,
    payout: input.usdParams.payout,
    collections: input.usdParams.collections,
    fcastFX: 0,
    nonNpCash: input.usdNonNpCash,
    cash_floor: 0,
    ir_asset_notional: input.usdParams.ir_asset_notional,
    ir_asset_rate: input.usdParams.ir_asset_rate,
    ir_liab_notional: input.usdParams.ir_liab_notional,
    ir_liab_rate: input.usdParams.ir_liab_rate,
    ir_net_dur: input.usdParams.ir_net_dur,
  };

  const usdLayer = layerByCcy['USD'] as LayerTargetRow | undefined;

  const usdComputed: UsdComputedRow = {
    ...usdState,
    ...computeSimdUsdRow(
      usdState, input.shared, input.activeLayers, fcySwapNearUsd,
      usdLayer?.cash_threshold_raw, swapByCcy['USD'],
    ),
  };

  const layerResults: LayerResult[] = layerRows.map(r => ({
    ccy: r.ccy,
    cash_threshold: r.cash_threshold,
    swap_needed: r.swap_needed,
    carry_dir: r.carry_dir,
    delta_r: r.delta_r,
  }));

  const portfolioActive = input.activeLayers.has('portfolioDiv');
  let portfolioSummary: PortfolioSummary | null = null;
  if (portfolioActive) {
    const varInputs = layerRows
      .filter(r => r.ccy !== 'USD')
      // Policy VAR is charged on the overlay legs (deviation from hold-the-book),
      // matching the optimizer and the cap — not on pre-existing holdings.
      // Stress-trimmed rows are funding-forced, not discretionary → deviation 0.
      .map(r => ({
        ccy: r.ccy,
        cashFCY: r.usd_stress_trim ? 0 : r.cash_threshold - (r.base_hold ?? r.cash_threshold),
      }));
    const varResult = computePortfolioVAR(varInputs);
    const firstFcy = layerRows.find(r => r.ccy !== 'USD');
    // Incremental overlay attribution vs hold-the-book (banner only — already
    // embedded in per-row floatNim on the post-swap target). PAY sells and EARN
    // buys both yield positive incremental P&L at (r_FCY − r_USD).
    const overlay_carry_USD = layerRows
      .filter(r => r.ccy !== 'USD' && !r.usd_stress_trim)
      .reduce((sum, r) => {
        const leg = r.cash_threshold - (r.base_hold ?? r.cash_threshold);
        return sum + leg * (CURRENCY_PARAMS[r.ccy]?.spot ?? 0) * (r.r_FCY - input.shared.r_USD) / 100;
      }, 0);
    portfolioSummary = {
      portfolio_VAR_USD: varResult.portfolio_VAR_USD,
      standalone_sum_USD: varResult.standalone_sum_USD,
      div_benefit_USD: varResult.div_benefit_USD,
      overlay_carry_USD,
      policyVAR: input.policyVAR,
      var_binding: layerRows.some(r => r.var_binding),
      budget_binding: layerRows.some(r => r.budget_binding),
      stress_trim: layerRows.some(r => r.usd_stress_trim),
      var_trim: layerRows.some(r => r.var_trim),
      lambda_var: firstFcy?.lambda_val ?? 0,
      lambda_usd: firstFcy?.lambda_usd_val ?? 0,
    };
  }

  return { layerRows, layerResults, fcyComputed, usdComputed, portfolioSummary };
}
