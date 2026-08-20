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
  applyNoNegativeLpFloor,
  applyHardMinFloor,
  assessUsdLiquidityPriority,
  deriveUsdLiquidity,
  enforceUsdLiquidityStress,
  enforcePortfolioVarCap,
  usdActiveLayers,
  sumFcySwapNearUsd,
  optimizePortfolioCarry,
  sweepPortfolioCarryFrontier,
  computePortfolioVAR,
  var95_1m_factor,
  combinedMultiplier,
  ccySpotRate,
  fcyToUsdM,
  usdToFcyM,
  roundMoney,
  fxBookNetLocalM,
  fundingSwapOverlayUsdYr,
  fundingSwapCarryUsdYr,
  liquidityFormulaLayersActive,
  type LayerId,
  type LayerResult,
  type LayeredBufferResult,
  type PortfolioCarryInput,
  type PortfolioCarryResult,
  type PortfolioCarryFrontier,
  type RowState,
  type SharedGlobals,
  type UsdParams,
} from './fx-buffer';
import {
  periodFxFlowSumLocalM,
  projectLiquidityCycles,
  type ForecastProfileState,
  type LiquidityCycleProjection,
} from './forecast-profile';
import {
  buildLiquidityLadder,
  cycleCarrySplit,
  DEFAULT_LIQUIDITY_TIMING,
  resolveLiquidityTiming,
  type HedgeSettleByCcy,
  type LadderCycle,
  type LiquidityBookingMode,
  type LiquidityLadderResult,
  type LiquiditySizingBasis,
} from './liquidity-ladder';
import {
  impliedCarryRatePct,
  resolveMarketRatesForCcy,
  type FxMarketRatesBundle,
} from './fx-market-rates';
import { fwdHedgeCarryFromMarketUsd } from './fx-hedge';
import { rateVolBpYrFor } from './test-mode/cfar-residual';

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
  lpNetFX: number;
  varFactor: number;
  irMult: number;
  varBuffer: number;
  /**
   * Target LP Cash — the layer / carry-target H* (what the buffer must hold).
   * Not Opening + today's M1 swap: that identity only holds when H* is the near
   * cycle. LP+Swap (`postSwapCash`) is Opening + the trade booked today.
   */
  cash_threshold: number;
  /** Trough cushion H* from layer model (what must remain AFTER payout) — sizes the swap. */
  cash_threshold_pre_swap: number;
  /** Target LP cash in USD (M USD) = Target × spot. */
  cashThresholdUSD: number;
  /** LP+Swap in USD (M USD) = (opening LP + swap) × spot. */
  postSwapUSD: number;
  H_pct: number;
  delta_r: number;
  carryDir: 'earn' | 'pay' | 'neutral';
  shortfallPct: number;
  /**
   * Operating trough on the selected sizing basis (M FCY). Dated path including
   * FX hedge settlement, with no funding swap in it. A buffer layer cannot move
   * this number; changing the hedge book can, because settlement is cash.
   */
  lp_peak_cash: number;
  /** Day offset of the trough — only set when forecast liquidity timing is on. */
  troughDay?: number;
  /**
   * Cash the cycle drains at its deepest: opening balance − the cycle low. What
   * the closing balance cannot tell you, and what the swap has to bridge.
   */
  cycleDrawdown?: number;
  /**
   * Which forecast cycle the displayed Trough Cash came from (0 = the nearest).
   * Picked on the unfunded path, so a buffer layer cannot retarget it.
   */
  troughCycleIndex?: number;
  /**
   * Which cycle of the funded plan H* and the near leg size against. May differ
   * from `troughCycleIndex` when leftover cover from earlier legs moves the
   * funded argmin.
   */
  sizingCycleIndex?: number;
  /** Low of the nearest cycle, kept beside the sizing trough for comparison. */
  nearCycleTrough?: number;
  /**
   * Funded cycle-by-cycle plan behind the trough: per cycle the near leg to book,
   * the tranche that can be pre-booked today, and where the balance lands. Only
   * set when forecast liquidity timing is on.
   */
  liquidityPlan?: LiquidityCycleProjection[];
  /** Dated shape of the same cycles — gross out / in and the day the low lands. */
  liquidityCycles?: LadderCycle[];
  /**
   * Deepest operating low on the selected sizing basis. Equal to `lp_peak_cash`
   * whenever the dated path is on.
   */
  troughPath?: number;
  /** First payout day of cycle 1 (−1 when the cycle has no outflow). */
  cycleStartDay?: number;
  /** Last payin day of cycle 1 (−1 when the cycle has no inflow). */
  cycleEndDay?: number;
  /** Days the dated path spends below the per-CCY cash floor. */
  daysBelowFloor?: number;
  /** Cycle Net Flow: LP + Non-LP + payouts + payins — before swap. */
  cash_after_payins: number;
  lp_month_end: number;
  swapNear: number;
  swapFar: number;
  /** LP+Swap = Opening LP Cash + Swap Near — the funded LP position right after the swap,
   *  before the payout leaves (positive when opening LP and swap are positive). */
  postSwapCash: number;
  /** H* at trough = trough + swap = post-payout cushion (used for hedging / VAR). */
  lp_after_swap_trough?: number;
  /**
   * Close after every dated line on the path, including FX hedge settlement and
   * — under term booking — the far leg that pays the cover back on the last date.
   * Without a dated plan this is the near-cycle close: LP+Swap − payout + payins
   * + invoice fcast + Non-LP swept back.
   */
  cycleEndCash: number;
  postSwapVar: number;
  varChange: number;
  swap_carry: number;
  /** FCY overnight on the funding-swap notional ($M/yr). Sell FCY → pay/forgo r_FCY. */
  swapOnUsdYr: number;
  /** Opposite USD overnight on the funding-swap notional ($M/yr). */
  usdOnUsdYr: number;
  /** CIP mid swap points on the funding-swap notional ($M/yr). */
  swapPointsUsdYr: number;
  /** Rate-diff carry ($M/yr) = FCY O/N + USD O/N (points excluded). */
  swapInterestUsdYr: number;
  /** Annual USD swap overlay ($M/yr). CIP net when no carry target (0 on a
   *  surplus deploy); cash Δr vs USD when a carry target is steering the book. */
  swapCarryUsdYr: number;
  usd_consumed: number;
  carry: number;
  netDelta: number;
  /** Annual USD cash carry on the UNFUNDED path ($M/yr) — FX book only, no
   *  funding swap. The swap overlay sits on top in `swapCarryUsdYr`. */
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
  /** The portfolio VAR cap scaled this row's overlay back toward hold-the-book. */
  var_trim?: boolean;
  /** Overlay leg vs hold-the-book base (M FCY). 0 when the portfolio VAR layer is off. */
  overlayLeg: number;
  /** Annual USD carry P&L earned by this row's overlay leg ($M/yr): leg × spot × (r_FCY − r_USD)/100. */
  overlayCarryUSD: number;
  /** Single "why is this number capped" answer — see PortfolioCarryResult. Only set with portfolioDiv on. */
  binding_reason?: 'floor' | 'usdBudget' | 'varCap' | null;
  /** This currency's share of total portfolio VAR ($M) — negative = diversifying. Only set with portfolioDiv on. */
  component_var_usd?: number;
  /** True when this row's target came from a desk-typed Target LP Cash, not the optimizer. */
  manual_target?: boolean;
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

/**
 * Funded per-cycle plan: the dated cycle shapes run through the multi-cycle
 * projection, so every cycle opens where its own near leg left it. Without this
 * the later cycles free-fall — nothing funds them — and on any structurally
 * negative book the deepest low is simply the last cycle of the horizon.
 */
export function fundedPlanFor(
  r: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  ladder: LiquidityLadderResult,
  forecastProfile?: ForecastProfileState | null,
  hedgeSettle?: readonly number[],
  /**
   * Target LP cash the book settled on for this currency, where the required carry
   * and the portfolio VaR / USD budget are decided across every currency at once.
   * The plan's own layer stack cannot see any of that, so the cycle the plan sizes
   * on is anchored to this number and the rest of the horizon moves with it.
   */
  bookTarget?: number,
  /**
   * Overrides the profile's booking convention. `rolling` — a leg per cycle — is
   * the requirement chain: what each cycle needs funded by the time it arrives.
   * Sizing reads it on either convention, so the trough states what the book does
   * rather than how the cover happens to be traded.
   */
  bookingMode?: LiquidityBookingMode,
  /** Net CFaR in FCY — FX-hedge residual only; does not read this plan's swap. */
  cfarCoverFcy = 0,
): LiquidityCycleProjection[] {
  const timing = resolveLiquidityTiming(forecastProfile);
  const shape = ladder.cycles.map(c => ({ drawdown: c.drawdown, net: c.net }));
  const run = (targetShift: number) => projectLiquidityCycles(
    r,
    shared,
    activeLayers,
    ladder.cycles.length,
    forecastProfile,
    hedgeSettle,
    shape,
    bookingMode ?? timing?.bookingMode ?? 'rolling',
    targetShift,
    cfarCoverFcy,
  );
  const raw = run(0);
  if (bookTarget === undefined) return raw;
  const basis = timing?.sizingBasis ?? 'horizon';
  let anchor = sizingFromPlan(raw, basis).index;
  let plan = raw;
  // Shifting the level moves the funded path, which can hand the sizing role to
  // another cycle — re-anchor until the cycle being funded stops changing.
  for (let pass = 0; pass < 3; pass += 1) {
    const shift = roundMoney(bookTarget - raw[anchor]!.cash_threshold);
    plan = Math.abs(shift) < 0.001 ? raw : run(shift);
    const next = sizingFromPlan(plan, basis).index;
    if (next === anchor) break;
    anchor = next;
  }
  return plan;
}

/**
 * Today's funding-swap near: cycle-0 `swap_needed`.
 * Do not skip a quiet M1 to a later cycle's incremental — that is the H* leg,
 * and putting it on the collapsed SWAP row hides the trade booked today.
 */
export function swapNearBookNow(
  plan: readonly { swap_needed: number }[] | null | undefined,
  fallback: number,
): number {
  if (!plan?.length) return fallback;
  return plan[0]!.swap_needed;
}

/** The low H* and the swap size against, and which cycle it came from. */
export function sizingFromPlan(
  plan: readonly LiquidityCycleProjection[],
  basis: LiquiditySizingBasis,
): { trough: number; index: number } {
  const first = plan[0];
  if (!first) return { trough: 0, index: 0 };
  if (basis === 'cycle') return { trough: first.forecasted_cash, index: 0 };
  let index = 0;
  for (let k = 1; k < plan.length; k += 1) {
    if (plan[k]!.forecasted_cash < plan[index]!.forecasted_cash) index = k;
  }
  return { trough: plan[index]!.forecasted_cash, index };
}

/**
 * Low of the dated path itself, with no swap applied — the nearest cycle's low,
 * or the deepest of the horizon on that basis. Unlike `sizingFromPlan` this reads
 * the ladder, so no funding or sweep is folded into the answer.
 */
function pathLow(
  ladder: LiquidityLadderResult | null,
  basis: LiquiditySizingBasis,
): { low: number; index: number } | undefined {
  const cycles = ladder?.cycles;
  if (!cycles || cycles.length === 0) return undefined;
  if (basis === 'cycle') return { low: cycles[0]!.low, index: 0 };
  let index = 0;
  for (let k = 1; k < cycles.length; k += 1) {
    if (cycles[k]!.low < cycles[index]!.low) index = k;
  }
  return { low: cycles[index]!.low, index };
}

export function computeSimdRow(
  r: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  syncedThreshold?: number,
  syncedSwap?: number,
  timing?: TimingInput,
  forecastProfile?: ForecastProfileState | null,
  hedgeSettleByCcy?: HedgeSettleByCcy,
  /** See `fundedPlanFor` — must match the target the layer pass sized this row on. */
  bookTarget?: number,
  /** Net CFaR in FCY — sizes the CFaR cover layer; never derived from this swap. */
  cfarCoverFcy = 0,
): SimRowComputed {
  const cashPos = r.cash + r.nonLpCash;
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
  const T = forecastHorizonMonths(shared);
  const periodFlow = periodFxFlowSumLocalM(r, T, forecastProfile);
  const netFxForecast = roundMoney(netFxFCY + periodFlow);

  const varFactor = var95_1m_factor(r.σ_daily);
  const irMult = combinedMultiplier(r.r_FCY, r.β_IR);

  const payoutDeficit = netPayoutDeficit(r.payout, r.cash);
  const grossPayout = Math.abs(r.payout);

  // Liquidity path = forecast cash + FX hedge settlement. The funding swap is
  // not in it — that is the SWAP band. Binding cycle is picked on the funded
  // requirement chain so a repeating drain is not sized on the free-fall last
  // cycle; Trough Cash still reads this unfunded path.
  // Booked and staged settle both belong on this path: a staged delivery is
  // cash the buffer layers have to fund, and SWAP has to show that leg.
  const ladder = liquidityLadderFor(r, shared, forecastProfile, hedgeSettleByCcy);
  const hedgeSettle = hedgeSettleByCcy?.[r.ccy];
  const hedgeCycle1 = hedgeSettle?.[0] ?? 0;
  const liquidityPlan = ladder
    ? fundedPlanFor(
        r, shared, activeLayers, ladder, forecastProfile,
        hedgeSettle, bookTarget, undefined, cfarCoverFcy,
      )
    : null;
  const liqTiming = resolveLiquidityTiming(forecastProfile);
  const sizingBasis = liqTiming?.sizingBasis ?? 'horizon';
  // Term booking commits the horizon's cover today, which lifts every later cycle
  // and would report a shallower low than the same book funded a leg at a time.
  // Swap sizing still reads the requirement chain; Trough Cash does not.
  const sizingPlan = ladder && liqTiming?.bookingMode === 'term'
    ? fundedPlanFor(
        r, shared, activeLayers, ladder, forecastProfile,
        hedgeSettle, bookTarget, 'rolling', cfarCoverFcy,
      )
    : liquidityPlan;
  const sizing = sizingPlan
    ? sizingFromPlan(sizingPlan, sizingBasis)
    : null;
  const operating = pathLow(ladder, sizingBasis);
  const troughPath = operating?.low;
  const lp_peak_cash = operating?.low
    ?? (r.cash + r.payout + Math.min(0, hedgeCycle1));
  // H* and the near leg size against the funded low so a repeating drain is not
  // booked as one swap the size of the whole horizon. Displayed trough stays
  // the operating number above — a buffer layer cannot move it.
  const swapAnchor = sizing?.trough ?? lp_peak_cash;
  const peak_cash = cashPos + r.payout;
  const cash_after_payins = ladder
    ? roundMoney(ladder.cycleClosing + r.nonLpCash)
    : cashPos + r.payout + r.collections + hedgeCycle1;
  const lp_month_end = cash_after_payins;

  const layered = computeLayeredBuffer(
    grossPayout, swapAnchor, shared.σ_P, shared.r_USD, r.r_FCY, r.r_OD, r.cash_floor, activeLayers, r.cash,
    r.carry_target, cfarCoverFcy,
  );
  const cash_threshold_pre_swap = syncedThreshold ?? layered.cash_threshold;

  const opt = calcOptimalBuffer({
    P: payoutDeficit || 0.001, σ_P: shared.σ_P, r_USD: shared.r_USD,
    r_FCY: r.r_FCY, r_OD: r.r_OD, days: shared.days, cash_floor: r.cash_floor,
  });

  const varBuffer = Math.max(r.cash_floor, Math.abs(peak_cash) * varFactor * irMult);

  const formulaLayersActive = liquidityFormulaLayersActive(activeLayers);

  const hStarLeg = syncedSwap ?? computeFcySwapNear(
    cash_threshold_pre_swap, cashPos, r.fcastFX, r.r_OD, shared.r_USD, formulaLayersActive, swapAnchor,
  );
  // SWAP band = the trade booked today (M1 near). The H* cycle's increment stays
  // on `hStarLeg` so trough + that leg still equals the cushion. Mixing the two
  // (M1 opening + M2 increment) is what zeroed Target LP Cash on a carry ask.
  const swapNear = swapNearBookNow(liquidityPlan, hStarLeg);
  // Post-payout cushion (funded trough + H* increment = H*) — hedging / VAR.
  const lp_after_swap_trough = swapAnchor + hStarLeg;
  // LP+Swap = Opening LP + today's swap — funded position before payout.
  const postSwapCash = r.cash + swapNear;
  // Target LP Cash is the policy H* quoted pre-payout: trough cushion + |payout|.
  // That is the carry-target number. Do not use Opening + M1 swap (LP+Swap) and
  // do not mix M1 opening with the H* increment (that printed 0 against a 462k ask).
  const hStarPayout = sizingPlan?.[sizing?.index ?? 0]?.payout ?? r.payout;
  const payoutScaleH = Math.abs(hStarPayout) > 0.001 ? Math.abs(hStarPayout) : 0;
  const cash_threshold = cash_threshold_pre_swap + payoutScaleH;
  // Cycle End on a dated plan is the last close the path actually reaches —
  // hedge settlement included, and the term far-leg repaid — not the near cycle
  // with the cover still sitting in it. Without a plan the near-cycle close is
  // all that exists: LP+Swap − payout + payins + invoice fcast + Non-LP sweep.
  const cycleEndCash = liquidityPlan?.length
    ? liquidityPlan[liquidityPlan.length - 1]!.cycle_end_cash
    : postSwapCash + r.payout + r.collections + r.fcastFX + r.nonLpCash;
  const postSwapVar = Math.max(r.cash_floor, Math.abs(lp_after_swap_trough) * varFactor * irMult);
  const varChange = postSwapVar - varBuffer;
  // Unfunded cash carry (FX book only) + funding-swap overlay. The overlay is
  // FCY O/N on the moved notional + opposite USD O/N + CIP mid points — additive
  // to the unfunded path, no loop back into CFaR / Cash Carry.
  const overlay = fundingSwapOverlayUsdYr(
    swapNear, spot_rate, r.r_FCY, shared.r_USD, r.r_OD,
  );
  const swap_carry = overlay.fcyOnUsdYr;
  const swapOnUsdYr = overlay.fcyOnUsdYr;
  const usdOnUsdYr = overlay.usdOnUsdYr;
  const swapPointsUsdYr = overlay.pointsUsdYr;
  const swapInterestUsdYr = overlay.fcyOnUsdYr + overlay.usdOnUsdYr;
  // CIP points live in FX hedge carry (δ-scaled). Swap Carry is cash Δr only.
  const swapCarryUsdYr = fundingSwapCarryUsdYr(
    swapNear, spot_rate, r.r_FCY, shared.r_USD, r.r_OD, 'cashDelta',
  );

  const usd_consumed = Math.abs(swapNear) * spot_rate;

  const carry = netFxFCY * r.r_FCY / 100 / 12;
  const netDelta = netFxFCY + carry;
  // Time-weighted average LP cash WITHOUT the funding swap. Payout / payins
  // apply only for the remaining (1 − timing) of the cycle.
  const payoutWeight = timing ? (1 - timing.fPayout) : 0;
  const payinWeight = timing ? (1 - timing.fPayin) : 0;
  const cashTwa = r.cash + r.payout * payoutWeight + r.collections * payinWeight;
  const r_actual = cashTwa >= 0 ? r.r_FCY : r.r_OD;
  // A dated path prices each day on its own side of zero. One average balance
  // cannot: a cycle that spends 20 days overdrawn and 10 in credit averages
  // positive and would earn the credit rate throughout. The ladder's shapes
  // supersede the coarse payout / payin fractions when both are configured.
  const carrySplit = ladder ? cycleCarrySplit(ladder, 0) : null;
  const floatNim = carrySplit
    ? (carrySplit.avgCredit * (r.r_FCY - shared.r_USD)
      + carrySplit.avgDebit * (r.r_OD - shared.r_USD)) / 100 * spot_rate
    : cashTwa * (r_actual - shared.r_USD) / 100 * spot_rate;
  const lpNetFX = r.cash + fxFwdFCY;

  return {
    cashPos, cashPosUSD: cashPos * spot_rate,
    fxSpotFCY, fxSpotUSD, fxFwdFCY, fxFwdUSD, fxNonCashUSD, fxNonCashAssetUSD, netFxFCY, netFxUSD, netFxForecast,
    netFX: netFxFCY, lpNetFX, varFactor, irMult, varBuffer,
    cash_threshold, cash_threshold_pre_swap,
    H_pct: payoutDeficit > 0 ? (cash_threshold_pre_swap / payoutDeficit) * 100 : 0,
    cashThresholdUSD: fcyToUsdM(cash_threshold, r.ccy),
    postSwapUSD: fcyToUsdM(postSwapCash, r.ccy),
    delta_r: opt.delta_r, carryDir: opt.carry_direction, shortfallPct: opt.shortfall_prob_pct,
    lp_peak_cash, cash_after_payins, lp_month_end,
    troughDay: operating && ladder ? ladder.cycles[operating.index]?.lowDay : undefined,
    cycleDrawdown: operating && ladder
      ? ladder.cycles[operating.index]!.drawdown
      : Math.max(0, -(r.payout + Math.min(0, hedgeCycle1))),
    troughCycleIndex: operating?.index,
    sizingCycleIndex: sizing?.index,
    nearCycleTrough: ladder?.cycles[0]?.low ?? liquidityPlan?.[0]?.forecasted_cash,
    liquidityPlan: liquidityPlan ?? undefined,
    liquidityCycles: ladder?.cycles,
    troughPath,
    cycleStartDay: ladder?.cycleStartDay,
    cycleEndDay: ladder?.cycleEndDay,
    daysBelowFloor: operating && ladder
      ? ladder.cycles[operating.index]?.daysBelowFloor
      : undefined,
    swapNear, swapFar: -swapNear,
    postSwapCash, lp_after_swap_trough, cycleEndCash, postSwapVar, varChange,
    swap_carry, swapOnUsdYr, usdOnUsdYr, swapPointsUsdYr, swapInterestUsdYr, swapCarryUsdYr, usd_consumed,
    carry, netDelta, floatNim,
  };
}

/** USD row — swap = −Σ(FCY swap); Target = opening LP + swap (post-swap LP). */
export function computeSimdUsdRow(
  r: RowState,
  shared: SharedGlobals,
  activeLayers: Set<LayerId>,
  fcySwapNearUsd: number,
  syncedThreshold?: number,
  syncedSwap?: number,
): UsdRowComputed {
  const cashPos = r.cash + r.nonLpCash;
  const peak_cash = cashPos + r.payout;
  const lp_peak_cash = r.cash + r.payout;
  const cash_after_payins = cashPos + r.payout + r.collections;
  const lp_month_end = cash_after_payins;

  const formulaLayersActive = liquidityFormulaLayersActive(activeLayers);
  const payoutDeficit = netPayoutDeficit(r.payout, r.cash);
  const payoutBuffer = computeUsdBuffer(
    r.payout, r.cash_floor, shared.σ_P, usdActiveLayers(activeLayers),
  ).cash_threshold;
  const derived = deriveUsdLiquidity(
    payoutBuffer, fcySwapNearUsd, r.cash, r.payout, formulaLayersActive,
  );

  const cash_threshold_pre_swap = syncedThreshold ?? derived.cash_threshold;
  const swapNear = syncedSwap ?? (formulaLayersActive ? derived.swapNear : -fcySwapNearUsd);
  const lp_after_swap_trough = lp_peak_cash + swapNear;
  // LP+Swap = Opening LP + Swap (funded position after swap, before payout).
  const postSwapCash = r.cash + swapNear;
  // Target = Opening LP + Swap — the cash target the swap funds to (before payout).
  const cash_threshold = r.cash + swapNear;
  // Cycle End = LP+Swap − payout + payins + Non-LP swept back.
  const cycleEndCash = postSwapCash + r.payout + r.collections + r.fcastFX + r.nonLpCash;
  const envelopeGap = formulaLayersActive
    ? Math.abs(lp_after_swap_trough - cash_threshold_pre_swap)
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
    lpNetFX: r.cash + r.fwd,
    varFactor: 0, irMult: 1, varBuffer: 0,
    cash_threshold, cash_threshold_pre_swap,
    H_pct: payoutDeficit > 0 ? (cash_threshold_pre_swap / payoutDeficit) * 100 : 0,
    cashThresholdUSD: cash_threshold,
    postSwapUSD: postSwapCash,
    delta_r: opt.delta_r, carryDir: 'neutral', shortfallPct: opt.shortfall_prob_pct,
    lp_peak_cash, cash_after_payins, lp_month_end,
    swapNear, swapFar: -swapNear,
    postSwapCash, lp_after_swap_trough, cycleEndCash, postSwapVar: 0, varChange: 0,
    swap_carry: 0, swapOnUsdYr: 0, usdOnUsdYr: 0, swapPointsUsdYr: 0, swapInterestUsdYr: 0, swapCarryUsdYr: 0, usd_consumed: 0,
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
  nonLpCash: number;
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
  /**
   * Near leg the funded plan books today when the desk buys cover as one term
   * swap: the whole horizon's requirement, not this cycle's shortfall. Undefined
   * under rolling booking, where each cycle's own shortfall is the leg.
   */
  planned_near_leg?: number;
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
  /** Single "why is this number capped" answer — see PortfolioCarryResult. Only set with portfolioDiv on. */
  binding_reason?: 'floor' | 'usdBudget' | 'varCap' | null;
  /** This currency's share of total portfolio VAR ($M) — negative = diversifying. Only set with portfolioDiv on. */
  component_var_usd?: number;
  /** True when this row's target came from a desk-typed Target LP Cash, not the optimizer. */
  manual_target?: boolean;
}

export interface DashboardInputs {
  rows: RowState[];
  usdCash: number;
  usdNonLpCash: number;
  usdParams: UsdParams;
  shared: SharedGlobals;
  activeLayers: Set<LayerId>;
  policyVAR: number;
  /** Optional payin/payout timing that re-weights natural LP cash carry. */
  timing?: TimingInput;
  /** Flat monthly×T or custom per-period Revenue/Expenses profile. */
  forecastProfile?: ForecastProfileState | null;
  /**
   * FCY leg of booked and staged hedges per currency and month. Lands on the
   * cash path and sizes the funding swap — a staged delivery is cash the
   * buffer layers have to fund, same as a booked one.
   */
  hedgeSettleByCcy?: HedgeSettleByCcy;
  /**
   * Per-CCY Net CFaR in USD M — FX-hedge residual only. The CFaR cover layer
   * converts this to FCY and sizes the funding swap. Must not include liquidity
   * buffer funding or this swap, or the two modules loop.
   */
  cfarNetByCcyUsd?: Record<string, number>;
  /**
   * Live market swap-points curves per currency — when present, the
   * portfolioDiv carry allocator prices its μ direction off the CIP-implied
   * rate for the desk's chosen booking regime instead of the flat NP rate.
   * See `computeLayerTargets`.
   */
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  ratesScopeId?: string | null;
  /**
   * Shared overlay earn ask ($M/yr). Hit it at min VAR when feasible;
   * blank / omitted fills the Policy VAR cap on the same Σ⁻¹μ ray.
   */
  carryTargetUsdYrM?: number;
}

/**
 * FCY rate (% p.a.) for the portfolio μ tilt. A live uploaded curve
 * replaces the flat NP rate; missing curves keep `fallbackRFcy`.
 */
export function impliedPortfolioRFcyPct(
  ccy: string,
  fallbackRFcy: number,
  rUsd: number,
  marketRatesByCcy: Record<string, FxMarketRatesBundle> | undefined,
  tenorMonths: number,
): number {
  const bundle = marketRatesByCcy?.[ccy];
  if (!bundle) return fallbackRFcy;
  const implied = impliedCarryRatePct(bundle, tenorMonths, 0, rUsd);
  return implied != null ? implied : fallbackRFcy;
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

/** Forecast horizon in months, defaulting to one cycle. */
function forecastHorizonMonths(shared: SharedGlobals): number {
  return typeof shared.forecastMonths === 'number' && shared.forecastMonths >= 0
    ? shared.forecastMonths
    : 1;
}

/**
 * Dated cash path for the liquidity book — null unless the forecast profile
 * carries intra-cycle timing. Hedge settlement rides on this path: a forward
 * delivering FCY is cash the account must fund, so it shows in the trough.
 * The funding swap does not — that is applied after, in the SWAP band.
 */
/** Net CFaR (USD M) → FCY cover. 0 when missing or not a reserve. */
function cfarCoverFcyFor(ccy: string, netByCcy?: Record<string, number>): number {
  const usd = netByCcy?.[ccy];
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0.001) return 0;
  return usdToFcyM(usd, ccy);
}

function liquidityLadderFor(
  r: RowState,
  shared: SharedGlobals,
  forecastProfile?: ForecastProfileState | null,
  hedgeSettleByCcy?: HedgeSettleByCcy,
): LiquidityLadderResult | null {
  if (!resolveLiquidityTiming(forecastProfile)?.enabled) return null;
  return buildLiquidityLadder(r, forecastProfile, {
    months: forecastHorizonMonths(shared),
    hedgeSettle: hedgeSettleByCcy?.[r.ccy],
  });
}

function buildPass1Fcy(
  sr: RowState,
  shared: SharedGlobals,
  layersForPass1: Set<LayerId>,
  activeLayers: Set<LayerId>,
  forecastProfile?: ForecastProfileState | null,
  hedgeSettleByCcy?: HedgeSettleByCcy,
  bookTarget?: number,
  cfarCoverFcy = 0,
): Pass1Row {
  const p = CURRENCY_PARAMS[sr.ccy];
  const payout = sr.payout;
  const cash = sr.cash;
  const nonLpCash = sr.nonLpCash;
  const total_cash = cash + nonLpCash;
  const h_min_per_ccy = sr.cash_floor;
  const h_min = h_min_per_ccy;
  const r_FCY = sr.r_FCY;
  const r_OD = sr.r_OD;
  const collections = sr.collections;
  const ladder = liquidityLadderFor(sr, shared, forecastProfile, hedgeSettleByCcy);
  const hedgeSettle = hedgeSettleByCcy?.[sr.ccy];
  const hedgeCycle1 = hedgeSettle?.[0] ?? 0;
  const timing = resolveLiquidityTiming(forecastProfile);
  // Sized on the requirement chain whichever way the cover is booked — see
  // `computeSimdRow`, which has to reach the same low for the leg to reconcile.
  const sizingPlan = ladder
    ? fundedPlanFor(
        sr, shared, layersForPass1, ladder, forecastProfile,
        hedgeSettle, bookTarget, 'rolling', cfarCoverFcy,
      )
    : null;
  const planSizing = sizingPlan
    ? sizingFromPlan(sizingPlan, timing?.sizingBasis ?? 'horizon')
    : null;
  const peak_cash = planSizing
    ? planSizing.trough
    : cash + payout + Math.min(0, hedgeCycle1);
  // Term booking commits the horizon's cover in one leg today, so the row's near
  // leg is that leg — otherwise the row would advertise one cycle's shortfall
  // while the plan behind it books the whole term. Priced on the layers the desk
  // has on and the target the book settled last pass, which is the plan the row
  // expands into: pass 1's own reduced layer set would name a different trade.
  const planned_near_leg = ladder && timing?.bookingMode === 'term'
    ? fundedPlanFor(
        sr, shared, activeLayers, ladder, forecastProfile,
        hedgeSettle, bookTarget, undefined, cfarCoverFcy,
      )[0]?.swap_needed
    : undefined;
  const forecasted_cash = ladder
    ? ladder.cycleClosing
    : peak_cash + collections + Math.max(0, hedgeCycle1);
  const l = computeLayeredBuffer(
    Math.abs(payout), peak_cash, shared.σ_P, shared.r_USD, r_FCY, r_OD, h_min, layersForPass1, cash,
    sr.carry_target, cfarCoverFcy,
  );
  const spot_raw = sr.spot;
  const fwd_raw = sr.fwd;
  const fwd_fcy = usdToFcyM(fwd_raw, sr.ccy);
  return {
    ccy: sr.ccy, payout, collections, cash, nonLpCash, total_cash, h_min, h_min_per_ccy, peak_cash, forecasted_cash,
    spot_pos: spot_raw + fwd_fcy, spot_raw, fwd_raw, r_FCY, r_OD,
    spot: p?.spot ?? 1, planned_near_leg, ...l,
  };
}

function buildPass1Usd(
  usdCash: number,
  usdNonLpCash: number,
  usdParams: UsdParams,
  shared: SharedGlobals,
  layersForPass1: Set<LayerId>,
): Pass1Row {
  const payout = usdParams.payout;
  const collections = usdParams.collections;
  const cash = usdCash;
  const nonLpCash = usdNonLpCash;
  const total_cash = cash + nonLpCash;
  const h_min = 0;
  const peak_cash = cash + payout;
  const forecasted_cash = peak_cash + collections;
  const l = computeUsdBuffer(payout, h_min, shared.σ_P, usdActiveLayers(layersForPass1));
  return {
    ccy: 'USD', payout, collections, cash, nonLpCash, total_cash, h_min, h_min_per_ccy: h_min, peak_cash, forecasted_cash,
    spot_pos: 0, spot_raw: 0, fwd_raw: 0,
    r_FCY: usdParams.r_FCY, r_OD: usdParams.r_OD, spot: 1, ...l,
  };
}

/**
 * Layer targets + stress trim for every FCY row in `rows` and USD.
 *
 * `bookTargetByCcy` re-prices the funded plans this pass sizes on against the target
 * an earlier pass settled — see `computeDashboardModel`, which iterates so the carry
 * requirement and the VaR verdict reach every period of the horizon.
 */
export function computeLayerTargets(
  input: DashboardInputs,
  bookTargetByCcy?: Record<string, number>,
): LayerTargetRow[] {
  const { rows, usdCash, usdNonLpCash, usdParams, shared, activeLayers, policyVAR } = input;
  const portfolioActive = activeLayers.has('portfolioDiv');
  const carryActive = activeLayers.has('carryOptim');

  const layersForPass1 = portfolioActive
    ? new Set([...activeLayers].filter(l => l !== 'carryOptim' && l !== 'portfolioDiv') as LayerId[])
    : activeLayers;

  const pass1Fcy = rows.map(sr =>
    buildPass1Fcy(
      sr, shared, layersForPass1, activeLayers, input.forecastProfile,
      input.hedgeSettleByCcy, bookTargetByCcy?.[sr.ccy],
      cfarCoverFcyFor(sr.ccy, input.cfarNetByCcyUsd),
    ),
  );
  const pass1Usd = buildPass1Usd(usdCash, usdNonLpCash, usdParams, shared, layersForPass1);
  const carryTargetByCcy: Record<string, number | undefined> = Object.fromEntries(
    rows.map(sr => [sr.ccy, sr.carry_target]),
  );

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
      lp_cash: r.cash,
      P_contrib: r.P_contrib,
      forecasted_cash: r.peak_cash,
      floor_contrib: r.floor_contrib,
      delta_sigma: r.delta_sigma,
      delta_cfar: r.delta_cfar,
      r_FCY: r.r_FCY,
      r_OD: r.r_OD,
      carry_target: carryTargetByCcy[r.ccy],
    }));
    // The portfolio μ direction is realised by trading the actual funding
    // swap, so it reads that swap's CIP-implied rate for the desk's chosen
    // regime — rolling reprices the near 1M window every cycle, term/stripTerm
    // lock the whole horizon in today. Only currencies with a live, desk-
    // uploaded curve get the override (never the baked-in EURUSD seed or the
    // empty fallback `resolveMarketRatesForCcy` hands back otherwise) — those
    // defaults are not a live view and must not silently move the EARN/PAY
    // carry classification the rest of the model reads off the flat NP rate.
    const bookingMode = resolveLiquidityTiming(input.forecastProfile)?.bookingMode ?? 'rolling';
    const impliedTenorMonths = bookingMode === 'rolling' ? 1 : Math.max(1, forecastHorizonMonths(shared));
    const impliedRFcyByCcy: Record<string, number> = {};
    pass1Fcy.forEach((r) => {
      const implied = impliedPortfolioRFcyPct(
        r.ccy, r.r_FCY, shared.r_USD, input.marketRatesByCcy, impliedTenorMonths,
      );
      if (implied !== r.r_FCY) impliedRFcyByCcy[r.ccy] = implied;
    });
    const optResult = optimizePortfolioCarry(
      optInputs, shared.σ_P, shared.r_USD, policyVAR,
      fcyCollateralBudget, carryActive, input.carryTargetUsdYrM, impliedRFcyByCcy,
    );
    optResult.forEach(r => {
      portOptResults[r.ccy] = r;
      portOptCarryAdj[r.ccy] = r.delta_carry;
      deltaPortfolio[r.ccy] = r.delta_portfolio;
    });
  }

  const formulaLayersActive = liquidityFormulaLayersActive(activeLayers);

  const fcyRowsPreStress = pass1Fcy.map(r => {
    const delta_portfolio = deltaPortfolio[r.ccy] ?? 0;
    const opt = portOptResults[r.ccy];
    // The portfolio carry overlay may only reposition EXISTING cash — moving
    // money the desk already holds — never fabricate a funding swap purely
    // to create a position where none exists. A currency with zero existing
    // cash (r.cash) has nothing to reposition: opt.cash_threshold there is a
    // pure Σ⁻¹μ target with no connection to any real holding (e.g. GBP in
    // the Task 01 seed — cash=0, its only "position" is a non-cash equity
    // stake, ir_invest_notional — not liquid FX at all), and sizing a real
    // swap to it (computeFcySwapNear below) invents risk and CFaR that
    // shouldn't exist. Distinct from raw_sum (a currency's own native
    // buffer/carry target) — a currency can hold real cash with raw_sum≈0
    // (zero payout, no floor set), and the overlay repositioning THAT cash
    // is legitimate (see the CAD PAY sell-down test: lp_cash=95.1, payout=0
    // — real money, zero flow — the overlay selling it down for carry is a
    // real trade, not a fabricated one).
    const hasExistingCash = Math.abs(r.cash) > 0.001;
    let cash_threshold = formulaLayersActive
      ? (portfolioActive
        ? (hasExistingCash ? (opt?.cash_threshold ?? r.raw_sum) : r.raw_sum)
        : r.raw_sum + delta_portfolio + (portOptCarryAdj[r.ccy] ?? 0))
      : r.peak_cash;
    const cash_threshold_raw = opt?.cash_threshold_raw ?? cash_threshold;
    if (!portfolioActive && formulaLayersActive) {
      ({ cash_threshold } = applyNoNegativeLpFloor(cash_threshold, r.r_OD, shared.r_USD));
    }
    // Hard minimum: with the floor layer on, the target never drops below cash_floor.
    if (formulaLayersActive) {
      cash_threshold = applyHardMinFloor(cash_threshold, r.floor_contrib);
    }
    const debit_floor_binding = opt?.debit_floor_binding
      ?? (cash_threshold_raw < -0.001 && cash_threshold >= -0.001);
    const swap_needed = r.planned_near_leg ?? computeFcySwapNear(
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
      binding_reason: opt?.binding_reason ?? null,
      component_var_usd: opt?.component_var_usd,
      manual_target: opt?.manual,
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
        trough_lp: r.peak_cash,
        planned_near_leg: r.planned_near_leg,
        P_contrib: r.P_contrib,
        floor_contrib: r.floor_contrib,
        delta_sigma: r.delta_sigma,
        delta_cfar: r.delta_cfar,
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
        trough_lp: r.peak_cash,
        planned_near_leg: r.planned_near_leg,
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

/** FCY targets this pass settled on, ready to anchor the next pass's plans. */
function bookTargetsFrom(layerRows: readonly LayerTargetRow[]): Record<string, number> {
  return Object.fromEntries(
    layerRows.filter(r => r.ccy !== 'USD').map(r => [r.ccy, r.cash_threshold]),
  );
}

/** Two target maps agree to the cent — the iteration below has nothing left to move. */
function targetsSettled(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(k => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 0.001);
}

/**
 * Full dashboard: layer targets → simulator rows for every currency in `rows` + USD.
 *
 * The layer pass and the funded plan are mutually dependent: the plan's trough sizes
 * the target, and the target sizes the legs that shape the plan. Iterating closes
 * that loop — each pass anchors every plan on the target the last one settled, so
 * each period of the horizon starts on the book's policy while the row keeps its
 * identity (trough + near leg = target), which only holds while the layer pass and
 * the row read the same plan.
 */
export function computeDashboardModel(input: DashboardInputs): DashboardModel {
  let layerRows = computeLayerTargets(input);
  let bookTargetByCcy: Record<string, number> = {};
  for (let pass = 0; pass < 4; pass += 1) {
    const next = bookTargetsFrom(layerRows);
    if (targetsSettled(next, bookTargetByCcy)) break;
    bookTargetByCcy = next;
    layerRows = computeLayerTargets(input, bookTargetByCcy);
  }
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
    // Incremental overlay P&L vs hold-the-book (banner metric only). Do NOT add
    // overlayCarryUSD into Cash/Swap/Total Carry — Cash is unfunded, Swap is
    // the funding-swap overlay.
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
        input.hedgeSettleByCcy,
        bookTargetByCcy[r.ccy],
        cfarCoverFcyFor(r.ccy, input.cfarNetByCcyUsd),
      ),
      cash_threshold_raw: layer?.cash_threshold_raw,
      debit_floor_binding: layer?.debit_floor_binding,
      usd_stress_trim: layer?.usd_stress_trim,
      var_trim: layer?.var_trim,
      funding_binding: !!(layer?.usd_stress_trim || layer?.budget_binding),
      overlayLeg,
      overlayCarryUSD,
      binding_reason: layer?.binding_reason ?? null,
      component_var_usd: layer?.component_var_usd,
      manual_target: layer?.manual_target,
    };
    return row;
  });

  const fcySwapNearUsd = sumFcySwapNearUsd(
    fcyComputed.map(r => ({
      ccy: r.ccy,
      swapNear: r.liquidityPlan?.[0]?.swap_needed ?? r.swapNear,
    })),
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
    nonLpCash: input.usdNonLpCash,
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

export interface BookingModeComparisonRow {
  ccy: string;
  cashThresholdA: number;
  cashThresholdB: number;
  swapNeededA: number;
  swapNeededB: number;
  /** Expected annual USD swap-overlay carry under each regime ($M/yr). */
  swapCarryUsdYrA: number;
  swapCarryUsdYrB: number;
  deltaCarryUsdYr: number;
  carryDirA: 'earn' | 'pay' | 'neutral';
  carryDirB: 'earn' | 'pay' | 'neutral';
  /** True when the regime switch itself moves this currency between EARN and PAY. */
  flipped: boolean;
}

export interface BookingModeComparison {
  modeA: LiquidityBookingMode;
  modeB: LiquidityBookingMode;
  rows: BookingModeComparisonRow[];
  totalDeltaCarryUsdYr: number;
  flippedCount: number;
}

/**
 * Regime preview: runs the full model under two booking modes and diffs the
 * result per currency — so a desk switching `bookingMode` sees the impact
 * before committing (expected carry Δ, any EARN/PAY flips) instead of only
 * the new absolute numbers after the fact. When `input.forecastProfile` is
 * absent there is no `liquidity.bookingMode` to override, so both sides
 * compute identically — a harmless no-op comparison, not an error.
 */
export function compareBookingModes(
  input: DashboardInputs,
  modeA: LiquidityBookingMode,
  modeB: LiquidityBookingMode,
): BookingModeComparison {
  const withMode = (mode: LiquidityBookingMode): ForecastProfileState | null | undefined => {
    if (!input.forecastProfile) return input.forecastProfile;
    const timing = resolveLiquidityTiming(input.forecastProfile) ?? DEFAULT_LIQUIDITY_TIMING;
    return { ...input.forecastProfile, liquidity: { ...timing, bookingMode: mode } };
  };
  const a = computeDashboardModel({ ...input, forecastProfile: withMode(modeA) });
  const b = computeDashboardModel({ ...input, forecastProfile: withMode(modeB) });
  const byB = Object.fromEntries(b.fcyComputed.map(r => [r.ccy, r]));

  const rows: BookingModeComparisonRow[] = a.fcyComputed.map((ra) => {
    const rb = byB[ra.ccy];
    const swapCarryUsdYrA = ra.swapCarryUsdYr ?? 0;
    const swapCarryUsdYrB = rb?.swapCarryUsdYr ?? swapCarryUsdYrA;
    return {
      ccy: ra.ccy,
      cashThresholdA: ra.cash_threshold,
      cashThresholdB: rb?.cash_threshold ?? ra.cash_threshold,
      swapNeededA: ra.swapNear,
      swapNeededB: rb?.swapNear ?? ra.swapNear,
      swapCarryUsdYrA,
      swapCarryUsdYrB,
      deltaCarryUsdYr: swapCarryUsdYrB - swapCarryUsdYrA,
      carryDirA: ra.carryDir,
      carryDirB: rb?.carryDir ?? ra.carryDir,
      flipped: !!rb
        && rb.carryDir !== ra.carryDir
        && rb.carryDir !== 'neutral'
        && ra.carryDir !== 'neutral',
    };
  });

  return {
    modeA,
    modeB,
    rows,
    totalDeltaCarryUsdYr: rows.reduce((s, r) => s + r.deltaCarryUsdYr, 0),
    flippedCount: rows.filter(r => r.flipped).length,
  };
}

/**
 * Portfolio carry/VAR frontier for the current book — see
 * `sweepPortfolioCarryFrontier`. Builds the same hold-the-book base
 * `computeLayerTargets` uses for its portfolioDiv pass (carryOptim and
 * portfolioDiv themselves excluded from the layer set, since the frontier's
 * job is to show what the carry tilt WOULD do, not read back a state it
 * already applied) and sweeps it — the simplest case only: pure VAR cap, no
 * manual pins, no USD funding budget.
 */
/**
 * Everything `computePortfolioCarryFrontier` actually reads — a strict
 * subset of `DashboardInputs` (any `DashboardInputs` already satisfies this
 * shape) so callers that don't have a USD row / policy params handy, like
 * the Analytics Liquidity view, don't have to fabricate them.
 */
export interface PortfolioCarryFrontierInput {
  rows: RowState[];
  shared: SharedGlobals;
  activeLayers: Set<LayerId>;
  policyVAR: number;
  forecastProfile?: ForecastProfileState | null;
  hedgeSettleByCcy?: HedgeSettleByCcy;
  cfarNetByCcyUsd?: Record<string, number>;
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  /**
   * Unhedged portfolio CFaR ($M) — CFaR-tab FX-only Net total / Overdraft
   * Sum at the live confidence. Pins the frontier origin. Do not invent a
   * second CFaR for the plot.
   */
  unhedgedCfarUsdM?: number;
}

export function computePortfolioCarryFrontier(
  input: PortfolioCarryFrontierInput,
  steps = 24,
  rangeMultiple = 3,
  /**
   * Far-leg CIP pricing roughly doubles the per-call cost (a second full
   * evalFarAt pass alongside evalAt for every k). Skip it for probe passes
   * and diagnostics that never read farPoints — only the one final render
   * that actually plots the far arm needs this true.
   */
  includeFar = false,
): PortfolioCarryFrontier {
  const layersForPass1 = new Set(
    [...input.activeLayers].filter(l => l !== 'carryOptim' && l !== 'portfolioDiv') as LayerId[],
  );
  const pass1Fcy = input.rows.map(sr =>
    buildPass1Fcy(
      sr, input.shared, layersForPass1, input.activeLayers, input.forecastProfile,
      input.hedgeSettleByCcy, undefined, cfarCoverFcyFor(sr.ccy, input.cfarNetByCcyUsd),
    ),
  );
  const optInputs: PortfolioCarryInput[] = pass1Fcy.map(r => ({
    ccy: r.ccy,
    P: Math.abs(r.payout),
    lp_cash: r.cash,
    P_contrib: r.P_contrib,
    forecasted_cash: r.peak_cash,
    floor_contrib: r.floor_contrib,
    delta_sigma: r.delta_sigma,
    delta_cfar: r.delta_cfar,
    r_FCY: r.r_FCY,
    r_OD: r.r_OD,
  }));
  // Near-leg μ deliberately stays on raw r_FCY (the JPM NP deposit rate) —
  // NOT the CIP-implied rate — so it matches unfundedCashCarryUsdYr exactly,
  // the same rate source the per-currency frontier's own open/cash-carry arm
  // uses. Isolating a single currency to this book must converge onto that
  // currency's own per-currency curve; a CIP-implied override here (as
  // optimizePortfolioCarry uses for its own, separate purpose) would price
  // the same currency off a different rate than its per-currency counterpart
  // and break that convergence.
  // Far/hedge tenor for the far arm — always the full forecast horizon (a
  // forward locking in the whole overlay), independent of bookingMode. Prices
  // via fwdHedgeCarryFromMarketUsd — the SAME function and uploaded swap
  // points the per-currency frontier's own far/hedged arm uses — rather than
  // an annualized-rate approximation, so the sign matches the real model.
  // legFcy is position-signed; the pricer takes the hedge trade (−legFcy).
  const farTenorMonths = Math.max(1, forecastHorizonMonths(input.shared));
  const rFcyByCcy = new Map(pass1Fcy.map(r => [r.ccy, r.r_FCY] as const));
  const farLegCarryUsdYr = includeFar
    ? (ccy: string, legFcy: number): number => {
        const rFcy = rFcyByCcy.get(ccy);
        if (rFcy == null) return 0;
        const bundle = resolveMarketRatesForCcy(input.marketRatesByCcy, ccy);
        return fwdHedgeCarryFromMarketUsd(
          -legFcy, ccy, rFcy, input.shared.r_USD, farTenorMonths, bundle,
        );
      }
    : undefined;
  // Far arm's VAR — rate-differential vol on the funding notional, not FX
  // spot vol (a forward hedge cancels spot via CIP near+far; see
  // portfolioRateVarUsd). Same desk table rateVolBpYrFor uses for the real
  // per-currency model's funding-swap CFaR.
  const rateVolBpYrByCcy: Record<string, number> | undefined = includeFar
    ? Object.fromEntries(pass1Fcy.map(r => [r.ccy, rateVolBpYrFor(r.ccy)]))
    : undefined;
  return sweepPortfolioCarryFrontier(
    optInputs, input.shared.σ_P, input.shared.r_USD, input.policyVAR,
    steps, rangeMultiple, undefined, farLegCarryUsdYr, rateVolBpYrByCcy,
    farTenorMonths, input.unhedgedCfarUsdM,
  );
}
