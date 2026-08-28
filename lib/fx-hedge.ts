/**
 * FX hedging decision engine — carry-aware spot sells, forwards, and options.
 *
 * PAY carry + long FCY above target → sell spot into USD cash for carry uplift.
 * If invoice / pipeline FCY need remains → buy back exposure via option (delta < 1).
 * Otherwise square off fully on spot or forward.
 */

import {
  bothSidesPayVsUsd,
  CURRENCY_PARAMS,
  ccySpotRate,
  fcyToUsdM,
  fundingSwapCipPointsUsdYr,
} from './fx-buffer';
import {
  fwdCarryFromSwapPointsUsdM,
  fundingSwapFarLegCipUsdM,
  type FxMarketRatesBundle,
} from './fx-market-rates';

export type HedgeMode = 'AUTO' | 'SPOT' | 'FWD' | 'OPTION' | 'NONE';
export type ActiveHedgeMode = Exclude<HedgeMode, 'AUTO'>;

export interface HedgeSuggestionInput {
  ccy: string;
  lpNetFX: number;
  lpCash: number;
  cashThreshold: number;
  postSwapCash: number;
  fcastFX: number;
  cashFloor: number;
  carryDir: 'earn' | 'pay' | 'neutral';
  r_FCY: number;
  r_USD: number;
  σ_daily: number;
}

export interface HedgeSuggestion {
  mode: ActiveHedgeMode;
  /** Primary hedge notional M FCY (negative = sell FCY). */
  size: number;
  /** Immediate spot sell for carry harvest (≤ 0). */
  spotSell: number;
  /** Option notional to retain FCY exposure (≥ 0, delta-weighted in effective hedge). */
  optionRetain: number;
  optionDelta: number;
  reason: string;
  /** Annual USD carry uplift from moving sold FCY into USD vs holding FCY. */
  carryBenefitUsdYr: number;
}

const DERIV_CORRIDORS = new Set(['CAD', 'GBP', 'EUR', 'AUD', 'CHF']);
const PEGGED_CCY = new Set(['AED', 'HKD']);

/** FCY stock above target LP cash available to sell for USD carry. */
export function excessLongLpCash(
  lpCash: number,
  postSwapCash: number,
  cashThreshold: number,
): number {
  const troughExcess = Math.max(0, postSwapCash - cashThreshold);
  const stockExcess = Math.max(0, lpCash - cashThreshold);
  return Math.max(troughExcess, stockExcess);
}

/** Annual USD benefit from selling `sellFcyM` on spot (sellFcyM negative). */
export function spotCarryBenefitUsdYr(
  sellFcyM: number,
  ccy: string,
  r_FCY: number,
  r_USD: number,
): number {
  if (sellFcyM >= -0.001) return 0;
  const usdMoved = Math.abs(sellFcyM) * fcyToUsdM(1, ccy);
  const spread = r_USD - r_FCY;
  return usdMoved * spread / 100;
}

/**
 * Carry-aware hedge suggestion.
 * PAY + long above target → SPOT sell excess; OPTION if pipeline needs FCY; else FWD square.
 */
export function suggestCarryHedge(inp: HedgeSuggestionInput): HedgeSuggestion {
  const none = (reason: string): HedgeSuggestion => ({
    mode: 'NONE', size: 0, spotSell: 0, optionRetain: 0, optionDelta: 0,
    reason, carryBenefitUsdYr: 0,
  });

  if (PEGGED_CCY.has(inp.ccy)) {
    return none('Pegged — FX risk negligible');
  }

  const excessLong = excessLongLpCash(inp.lpCash, inp.postSwapCash, inp.cashThreshold);
  const longLpFx = inp.lpNetFX > 0.001 ? inp.lpNetFX : 0;
  const σ_ann = inp.σ_daily * Math.sqrt(252);
  const fcastNeed = inp.fcastFX < -0.001 ? Math.abs(inp.fcastFX) : 0;

  if (inp.carryDir === 'earn') {
    if (Math.abs(inp.lpNetFX) < inp.cashFloor + 0.001) {
      return none('EARN carry — hold FCY; exposure within floor');
    }
    return none('EARN carry — hold FCY position for income');
  }

  // ── PAY / neutral: harvest carry on excess long stock ─────────────────────
  if (excessLong > 0.1) {
    const spotSell = -excessLong;
    const carryBenefitUsdYr = spotCarryBenefitUsdYr(spotSell, inp.ccy, inp.r_FCY, inp.r_USD);

    if (fcastNeed > 0.001) {
      const retain = Math.min(fcastNeed, excessLong);
      const optionDelta = DERIV_CORRIDORS.has(inp.ccy) ? 0.35 : 0.45;
      return {
        mode: 'OPTION',
        size: spotSell,
        spotSell,
        optionRetain: retain,
        optionDelta,
        reason: `PAY carry — sell ${excessLong.toFixed(1)}M spot → USD; buy ${retain.toFixed(1)}M option (δ=${optionDelta}) for invoice pipeline`,
        carryBenefitUsdYr,
      };
    }

    return {
      mode: 'SPOT',
      size: spotSell,
      spotSell,
      optionRetain: 0,
      optionDelta: 1,
      reason: `PAY carry — sell ${excessLong.toFixed(1)}M spot → USD cash (square excess above target)`,
      carryBenefitUsdYr,
    };
  }

  // ── Long LP FX residual (book exposure) — forward square if no excess cash ─
  if (longLpFx > inp.cashFloor + 0.001) {
    const sz = -longLpFx;
    if (DERIV_CORRIDORS.has(inp.ccy) && σ_ann > 0.08 && fcastNeed > 0.001) {
      return {
        mode: 'OPTION',
        size: sz,
        spotSell: 0,
        optionRetain: Math.min(fcastNeed, longLpFx),
        optionDelta: 0.35,
        reason: `Long LP FX — fwd hedge + option retain for pipeline (σ=${(σ_ann * 100).toFixed(0)}%)`,
        carryBenefitUsdYr: 0,
      };
    }
    return {
      mode: 'FWD',
      size: sz,
      spotSell: 0,
      optionRetain: 0,
      optionDelta: 1,
      reason: 'Long LP FX — EOM outright fwd square-off',
      carryBenefitUsdYr: 0,
    };
  }

  // ── Short LP FX — buy FCY via forward ─────────────────────────────────────
  if (inp.lpNetFX < -inp.cashFloor - 0.001) {
    return {
      mode: 'FWD',
      size: -inp.lpNetFX,
      spotSell: 0,
      optionRetain: 0,
      optionDelta: 1,
      reason: 'Short LP FX — buy FCY via forward',
      carryBenefitUsdYr: 0,
    };
  }

  return none('Net LP FX within floor — no hedge needed');
}

// ─── Hedge overlay carry measures (on top of the swap book) ─────────────────

/**
 * Outright forward carry: prefer uploaded Market data swap points for the
 * settle tenor; fall back to deposit-rate CIP annualised over that tenor.
 *
 * `notional` is the hedge trade (sell FCY = negative), same as
 * {@link fwdHedgeCarryUsdYr}. Market points are booked-signed (+ = sell FCY
 * far) — pass −notional into {@link fwdCarryFromSwapPointsUsdM}. Feeding the
 * hedge trade straight in prices a *buy* and flips USDPLN CIP to a cost.
 */
export function fwdHedgeCarryFromMarketUsd(
  notional: number,
  ccy: string,
  r_FCY: number,
  r_USD: number,
  settleMonths: number,
  bundle?: FxMarketRatesBundle | null,
): number {
  if (Math.abs(notional) < 0.001) return 0;
  const months = Math.max(1e-9, settleMonths);
  if (bundle) {
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: -notional,
      settleMonths: months,
      bundle,
    });
    if (pts) return pts.fwdCarryUsdM;
  }
  return fwdHedgeCarryUsdYr(notional, ccy, r_FCY, r_USD) * (months / 12);
}

/**
 * Annual USD carry impact of squaring the same-maturity FX exposure with an
 * outright FORWARD. Covered interest parity: F = S(1+r_USD)/(1+r_FCY), so
 * selling a PAY FCY forward (notional < 0, r_FCY < r_USD) locks F > S and
 * EARNS the differential; selling an EARN FCY forward locks F < S and gives
 * its yield up.
 *   carry = −notional × spot × (r_USD − r_FCY)/100   ($M/yr)
 *
 * Prefer {@link fwdHedgeCarryFromMarketUsd} whenever a swap-points curve is
 * available — this is the deposit-rate fallback only.
 */
export function fwdHedgeCarryUsdYr(
  notional: number,
  ccy: string,
  r_FCY: number,
  r_USD: number,
): number {
  if (Math.abs(notional) < 0.001) return 0;
  return -notional * fcyToUsdM(1, ccy) * (r_USD - r_FCY) / 100;
}

/**
 * FWD / CIP on an exposure-cover (signed with the book: long +).
 *
 * Market points use +cover (sell FCY far). Deposit fallback uses the hedge
 * trade −cover, because {@link fwdHedgeCarryUsdYr} is sell-negative. Passing
 * +cover into the fallback prices a *buy* and flips PLN M12 CIP to a cost
 * whenever r_FCY < r_USD.
 */
export function fwdCarryForExposureCoverUsdM(input: {
  coverLocalM: number;
  ccy: string;
  settleMonths: number;
  bundle?: FxMarketRatesBundle | null;
  r_FCY: number;
  r_USD: number;
}): { fwdCarryUsdM: number; points?: number; side?: 'bid' | 'ask' | 'mid' } {
  const cover = input.coverLocalM;
  const settle = input.settleMonths;
  if (Math.abs(cover) < 0.001 || settle < 1 - 1e-12) {
    return { fwdCarryUsdM: 0 };
  }
  if (input.bundle) {
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: cover,
      settleMonths: settle,
      bundle: input.bundle,
    });
    if (pts) {
      return {
        fwdCarryUsdM: pts.fwdCarryUsdM,
        points: pts.points,
        side: pts.side,
      };
    }
  }
  return {
    fwdCarryUsdM:
      fwdHedgeCarryUsdYr(-cover, input.ccy, input.r_FCY, input.r_USD)
      * (settle / 12),
  };
}

/** Period carry breakdown for one strip/bullet forward (USD M over the path). */
export interface StripHedgeCarryBreakdown {
  /**
   * Forward points carry over [0, settle] — from EURUSD Swap Points when
   * provided, else deposit-rate CIP fallback.
   */
  fwdCarryUsdM: number;
  /** Exposure-ccy interest from recognize → settle (USD-equivalent). */
  fcyInterestUsdM: number;
  /** Reporting-ccy (USD) interest from settle → forecast end. */
  usdInterestUsdM: number;
  totalUsdM: number;
  /** Effective FCY overnight rate used (credit or debit by position sign). */
  r_FCY_used?: number;
  /** Effective USD overnight rate used (credit or debit by position sign). */
  r_USD_used?: number;
  r_FCY_side?: 'credit' | 'debit';
  r_USD_side?: 'credit' | 'debit';
  /** Swap points used for FWD carry (when from market curve). */
  swapPoints?: number;
  swapPointsSide?: 'bid' | 'ask' | 'mid';
}

export interface StripHedgeCarryRatesInput {
  /** Long-cash earn rate % p.a. */
  creditPct: number;
  /** Short / OD pay rate % p.a. */
  debitPct: number;
}

function pickSideRate(
  signedAmount: number,
  creditPct: number,
  debitPct: number,
): { ratePct: number; side: 'credit' | 'debit' } {
  if (signedAmount >= 0) return { ratePct: creditPct, side: 'credit' };
  return { ratePct: debitPct, side: 'debit' };
}

/**
 * Carry on a hedge forward over the forecast path:
 * - FWD: EURUSD Swap Points column (preferred) or deposit-rate CIP fallback
 * - FCY cash interest on the hedge Δ (long → credit; short / OD → debit)
 * - USD cash interest on the conversion opposite (−Δ): sell FCY earns USD;
 *   buy FCY pays USD (debit if the USD side goes short)
 */
export function stripHedgeLegCarryUsdM(input: {
  notionalLocalM: number;
  ccy: string;
  /** Months when this incremental exposure is recognized (window start). */
  recognizeMonths: number;
  /** Forward settlement months from M0. */
  settleMonths: number;
  /** Forecast / reporting horizon end (months). */
  forecastEndMonths: number;
  /** @deprecated use fcyFwdRates / fcyCashRates */
  r_FCY?: number;
  /** @deprecated use usdFwdRates / usdCashRates */
  r_USD?: number;
  /**
   * @deprecated Prefer fcyFwdRates + fcyCashRates.
   * If only this is set, used for both CIP and cash interest.
   */
  fcyRates?: StripHedgeCarryRatesInput;
  /** @deprecated Prefer usdFwdRates + usdCashRates. */
  usdRates?: StripHedgeCarryRatesInput;
  /** Term rates — CIP fallback only when swap points missing. */
  fcyFwdRates?: StripHedgeCarryRatesInput;
  usdFwdRates?: StripHedgeCarryRatesInput;
  /** Overnight cash rates for FCY/USD interest legs. */
  fcyCashRates?: StripHedgeCarryRatesInput;
  usdCashRates?: StripHedgeCarryRatesInput;
  /**
   * Pre-computed FWD carry from market swap points ($M).
   * When set, replaces deposit-rate CIP for the forward leg.
   */
  swapPointsCarryUsdM?: number;
  swapPoints?: number;
  swapPointsSide?: 'bid' | 'ask' | 'mid';
}): StripHedgeCarryBreakdown {
  const N = input.notionalLocalM;
  const zero: StripHedgeCarryBreakdown = {
    fwdCarryUsdM: 0,
    fcyInterestUsdM: 0,
    usdInterestUsdM: 0,
    totalUsdM: 0,
  };
  if (Math.abs(N) < 1e-9) return zero;
  const settle = Math.max(0, input.settleMonths);
  const recog = Math.max(0, Math.min(input.recognizeMonths, settle));
  const Tf = Math.max(settle, input.forecastEndMonths);
  const usdNotional = N * fcyToUsdM(1, input.ccy);
  const settleYr = settle / 12;
  const fcyYr = Math.max(0, settle - recog) / 12;
  const usdYr = Math.max(0, Tf - settle) / 12;

  const fcyFwd = input.fcyFwdRates ?? input.fcyRates;
  const usdFwd = input.usdFwdRates ?? input.usdRates;
  const fcyCash = input.fcyCashRates ?? input.fcyRates;
  const usdCash = input.usdCashRates ?? input.usdRates;

  const fcyFwdCredit = fcyFwd?.creditPct ?? input.r_FCY ?? 0;
  const usdFwdCredit = usdFwd?.creditPct ?? input.r_USD ?? 0;

  const fcyCashCredit = fcyCash?.creditPct ?? input.r_FCY ?? fcyFwdCredit;
  const fcyCashDebit =
    fcyCash?.debitPct ?? input.r_FCY ?? fcyCashCredit;
  const usdCashCredit = usdCash?.creditPct ?? input.r_USD ?? usdFwdCredit;
  const usdCashDebit =
    usdCash?.debitPct ?? input.r_USD ?? usdCashCredit;

  const fcyCashPick = pickSideRate(N, fcyCashCredit, fcyCashDebit);
  const usdBal = -usdNotional;
  const usdCashPick = pickSideRate(usdBal, usdCashCredit, usdCashDebit);

  const useSwapPoints =
    typeof input.swapPointsCarryUsdM === 'number' &&
    Number.isFinite(input.swapPointsCarryUsdM);
  const fwdCarryUsdM = useSwapPoints
    ? input.swapPointsCarryUsdM!
    : fwdHedgeCarryUsdYr(
        N,
        input.ccy,
        fcyFwdCredit,
        usdFwdCredit,
      ) * settleYr;
  const cashInterest = (
    signedUsdM: number,
    ratePct: number,
    years: number,
  ): number => {
    if (Math.abs(signedUsdM) < 1e-15 || years < 1e-15) return 0;
    if (signedUsdM >= 0) return signedUsdM * (ratePct / 100) * years;
    return -Math.abs(signedUsdM) * (ratePct / 100) * years;
  };
  const fcyInterestUsdM = cashInterest(usdNotional, fcyCashPick.ratePct, fcyYr);
  const usdInterestUsdM = cashInterest(usdBal, usdCashPick.ratePct, usdYr);
  return {
    fwdCarryUsdM,
    fcyInterestUsdM,
    usdInterestUsdM,
    totalUsdM: fwdCarryUsdM + fcyInterestUsdM + usdInterestUsdM,
    r_FCY_used: fcyCashPick.ratePct,
    r_USD_used: usdCashPick.ratePct,
    r_FCY_side: fcyCashPick.side,
    r_USD_side: usdCashPick.side,
    swapPoints: input.swapPoints,
    swapPointsSide: input.swapPointsSide,
  };
}

export interface GammaCarryResult {
  /** Carry on the forward delta-hedge leg (δ × notional hedged forward), $M/yr. */
  fwdLegCarryUsdYr: number;
  /** Annualized ATM premium bleed (theta) of the gamma position, $M/yr (≥ 0). */
  thetaBleedUsdYr: number;
  /** Net carry impact = fwd delta-leg carry − theta bleed, $M/yr. */
  totalUsdYr: number;
}

/**
 * Annual USD carry impact of hedging the same-maturity exposure with a FWD
 * delta-hedged OPTION over a chosen horizon (long gamma position):
 *   • fwd delta leg (δ × notional) earns/pays the rate differential like an
 *     outright forward scaled by δ;
 *   • the option premium bleeds away over the horizon (theta) — priced ATM via
 *     Brenner–Subrahmanyam: premium ≈ 0.4 × σ_ann × √(T/365) × spot × |N|,
 *     annualized by ×365/T. Gamma P&L offsets theta only if realized vol ≥ implied,
 *     so the bleed is shown as the carry cost of holding the gamma.
 */
export function optionGammaCarryUsdYr(
  notional: number,
  delta: number,
  horizonDays: number,
  ccy: string,
  r_FCY: number,
  r_USD: number,
  σ_daily: number,
): GammaCarryResult {
  if (Math.abs(notional) < 0.001 || horizonDays <= 0) {
    return { fwdLegCarryUsdYr: 0, thetaBleedUsdYr: 0, totalUsdYr: 0 };
  }
  const spotUsd = fcyToUsdM(1, ccy);
  // δ-scaled outright forward — same forward-points convention as fwdHedgeCarryUsdYr.
  const fwdLegCarryUsdYr = -(notional * delta) * spotUsd * (r_USD - r_FCY) / 100;
  const σ_ann = σ_daily * Math.sqrt(252);
  const tYr = horizonDays / 365;
  const premiumUsd = 0.4 * σ_ann * Math.sqrt(tYr) * Math.abs(notional) * spotUsd;
  const thetaBleedUsdYr = premiumUsd / tYr;
  return {
    fwdLegCarryUsdYr,
    thetaBleedUsdYr,
    totalUsdYr: fwdLegCarryUsdYr - thetaBleedUsdYr,
  };
}

// ─── Strategy-level hedging (book-wide selection) ────────────────────────────
//
// SWAP_ONLY    — Swap Strip. Funding swap both legs + CIP carry on the far.
//                Fwd Hedge shows the buffer far (−standing). Residual = E+S.
// SWAP_FWD     — Fwd Strip. Only the near is an outright strip:
//                  Forward = −Δ × standing. No remaining swap far / CIP.
//                Unreplaced near stays in Residual. Naked spot → Fwd = 0.
// SWAP_FWD_OPT — Option Strip. Near strip + option strip (no far leftover):
//                  Forward = −standing (full near). Option Hedge = buffer far.
//                PAY → SELL CALL; EARN → SELL PUT. Naked spot → both 0.

export type HedgeStrategy = 'SWAP_ONLY' | 'SWAP_FWD' | 'SWAP_FWD_OPT';

export type ShortOptionType = 'SELL_CALL' | 'SELL_PUT';

export const HEDGE_STRATEGIES: { id: HedgeStrategy; label: string }[] = [
  { id: 'SWAP_ONLY',    label: 'Swap Strip' },
  { id: 'SWAP_FWD',     label: 'Fwd Strip' },
  { id: 'SWAP_FWD_OPT', label: 'Option Strip' },
];

/** Clamp replacement / option delta into [0, 1]. */
export function clampHedgeDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  return Math.min(1, Math.max(0, delta));
}

/**
 * Invert buffer-hedge sizing: F = −Δ × S ⇒ Δ = −F / S.
 * Exposure is not in this column — naked spot (S ≈ 0) cannot imply a Δ.
 */
export function swapForwardDeltaFromForward(input: {
  forwardLocalM: number;
  swapNearLocalM: number;
  /** Ignored — kept so existing call sites compile. */
  exposureLocalM?: number;
}): number {
  const S = input.swapNearLocalM;
  if (!Number.isFinite(S) || Math.abs(S) < 1e-9) return 0;
  const F = input.forwardLocalM;
  if (!Number.isFinite(F)) return 0;
  return clampHedgeDelta(-F / S);
}

/** Buffer hedge = swap far leg (opposite the near). 0 when the buffer is naked spot. */
export function bufferHedgeFarLocalM(standingLocalM: number): number {
  if (!Number.isFinite(standingLocalM) || Math.abs(standingLocalM) < 0.005) return 0;
  return -standingLocalM;
}

/**
 * Monthly locked hedge carry = this month's CIP + this month's outright fwd
 * points. Term: accrue the tenor total evenly (same walk as CIP). Rolling:
 * 1/12 of the fwd-points book plus this month's CIP.
 *
 * Decision / staged FWD pts are Hedge Cash — never added here.
 */
export function monthlyHedgeCarryUsdM(input: {
  cycleCipUsdM: number;
  fwdCarryUsdM: number;
  cycleIndex: number;
  farMonths: number;
  termFar: boolean;
}): number {
  const cip = Number.isFinite(input.cycleCipUsdM) ? input.cycleCipUsdM : 0;
  const fwd = Number.isFinite(input.fwdCarryUsdM) ? input.fwdCarryUsdM : 0;
  const month = input.cycleIndex + 1;
  if (input.termFar) {
    const n = Math.max(1, input.farMonths);
    if (month < 1 || month > n + 1e-12) return cip;
    return cip + fwd / n;
  }
  return cip + fwd / 12;
}

const overlayDust = (v: number) => (Math.abs(v) < 0.005 ? 0 : v);

/**
 * Hedge trade (sell FCY = −) → book cover (long +).
 * Overlay extras / `forwardLocalM` are trades. Market CIP and CFaR settle
 * are cover-signed — pass this, never the raw sell-negative notional.
 */
export function coverFromTradeLocalM(tradeLocalM: number): number {
  return -tradeLocalM;
}

/** Book cover (long +) → hedge trade (sell FCY = −). */
export function tradeFromCoverLocalM(coverLocalM: number): number {
  return -coverLocalM;
}

/**
 * Both-pay vs USD (PLN): coverage is always a long / sell-far.
 * Cash can stay OD; a short cover would buy and flip CIP to a cost.
 * Other CCYs keep the exposure sign (short → buy).
 */
export function bothPaySellCoverLocalM(
  signedLocalM: number,
  ccy: string,
  r_USD?: number,
): number {
  const p = CURRENCY_PARAMS[ccy];
  if (!p || !Number.isFinite(signedLocalM)) return signedLocalM;
  const usd = r_USD ?? CURRENCY_PARAMS.USD?.carry ?? 0;
  if (!bothSidesPayVsUsd(ccySpotRate(ccy), p.carry, usd, p.r_OD)) {
    return signedLocalM;
  }
  return Math.abs(signedLocalM);
}

/**
 * Both-pay vs USD (PLN): a buy-forward is rewritten as a sell of
 * `sellWeight × |Swap Near|`. Cash can stay OD; CIP must earn.
 */
export function clampBothPayBuyToSell(input: {
  forwardLocalM: number;
  sellWeight: number;
  swapNearLocalM: number;
  r_FCY?: number;
  r_USD?: number;
  r_OD?: number;
  spot?: number;
}): number {
  const fwd = input.forwardLocalM;
  if (
    input.r_FCY == null
    || input.r_USD == null
    || !bothSidesPayVsUsd(
      input.spot ?? 1,
      input.r_FCY,
      input.r_USD,
      input.r_OD,
    )
    || fwd <= 0
  ) {
    return fwd;
  }
  return overlayDust(
    -clampHedgeDelta(input.sellWeight) * Math.abs(input.swapNearLocalM),
  );
}

/**
 * Swap + Forward — buffer-hedge allocation (swap far / outright).
 * Forward = −Δ × standing. Forecast exposure is not squared into this column.
 */
export interface SwapForwardOverlay {
  /** Replacement fraction of the buffer far moved into the outright forward. */
  delta: number;
  exposureLocalM: number;
  swapNearLocalM: number;
  /** Outstanding standing book CIP accrues on (defaults to swap near). */
  swapStandingLocalM: number;
  /** Outright buffer hedge = −Δ × standing. 0 if naked spot. */
  forwardLocalM: number;
  /** Remaining swap far = −(1−Δ) × standing. */
  remainingFarLocalM: number;
  /** Unreplaced near = (1−Δ) × standing (= −remainingFar). */
  residualNearLocalM: number;
  /** Forecast E plus unreplaced near — no longer forced to 0. */
  finalNetLocalM: number;
}

export function allocateSwapForwardOverlay(input: {
  exposureLocalM: number;
  swapNearLocalM: number;
  swapStandingLocalM?: number;
  delta: number;
  /**
   * When both cash sides pay vs USD (PLN), a buy-forward (−ΔS > 0) is
   * rewritten as a sell of |standing|. Cash can stay OD; CIP must earn.
   */
  r_FCY?: number;
  r_USD?: number;
  r_OD?: number;
  spot?: number;
}): SwapForwardOverlay {
  const dust = (v: number) => (Math.abs(v) < 0.005 ? 0 : v);
  const delta = clampHedgeDelta(input.delta);
  const E = input.exposureLocalM;
  const S = input.swapNearLocalM;
  const standing =
    typeof input.swapStandingLocalM === 'number' && Number.isFinite(input.swapStandingLocalM)
      ? input.swapStandingLocalM
      : S;
  // Buffer hedge only — naked spot (standing ≈ 0) prints 0, not −E.
  let forwardLocalM = dust(-delta * standing);
  forwardLocalM = clampBothPayBuyToSell({
    forwardLocalM,
    sellWeight: delta,
    swapNearLocalM: standing,
    r_FCY: input.r_FCY,
    r_USD: input.r_USD,
    r_OD: input.r_OD,
    spot: input.spot,
  });
  const remainingFarLocalM = dust(-(1 - delta) * standing);
  const residualNearLocalM = dust((1 - delta) * standing);
  return {
    delta,
    exposureLocalM: E,
    swapNearLocalM: S,
    swapStandingLocalM: standing,
    forwardLocalM,
    remainingFarLocalM,
    residualNearLocalM,
    finalNetLocalM: dust(E + residualNearLocalM),
  };
}

/**
 * Frontier / strategy residual overlay.
 * `residual` = 1 open (no forward), 0 fully hedged (F = −(E+S)).
 * Stored `delta` is hedge coverage (1 − residual) for CIP retention.
 */
export function allocateResidualSwapForwardOverlay(input: {
  exposureLocalM: number;
  swapNearLocalM: number;
  swapStandingLocalM?: number;
  residual: number;
  r_FCY?: number;
  r_USD?: number;
  r_OD?: number;
  spot?: number;
}): SwapForwardOverlay {
  const residual = clampHedgeDelta(input.residual);
  const E = input.exposureLocalM;
  const S = input.swapNearLocalM;
  const standing =
    typeof input.swapStandingLocalM === 'number' && Number.isFinite(input.swapStandingLocalM)
      ? input.swapStandingLocalM
      : S;
  const net = E + S;
  let forwardLocalM = overlayDust(-(1 - residual) * net);
  forwardLocalM = clampBothPayBuyToSell({
    forwardLocalM,
    sellWeight: 1 - residual,
    swapNearLocalM: S,
    r_FCY: input.r_FCY,
    r_USD: input.r_USD,
    r_OD: input.r_OD,
    spot: input.spot,
  });
  return {
    delta: 1 - residual,
    exposureLocalM: E,
    swapNearLocalM: S,
    swapStandingLocalM: standing,
    forwardLocalM,
    remainingFarLocalM: overlayDust(-residual * S),
    residualNearLocalM: overlayDust(residual * S),
    finalNetLocalM: overlayDust(residual * net),
  };
}

export interface StrategyHedgeInput {
  ccy: string;
  /** Current net FX book position (spot + fwd + non-cash, M FCY). */
  currentFx: number;
  /** Forecast net FX exposure at cycle end = current book + expected payins +
   *  payouts (M FCY) — the TOTAL hedging basis, not just the flows. */
  forecastFx: number;
  /**
   * Funding-swap near leg (M FCY). This is FX cash the funding layer just
   * swapped in or out — it is not in `forecastFx` (spot book ≠ LP cash).
   * Residual may add the unreplaced near; Fwd Hedge is the buffer far only
   * (−Δ × standing), never −E − ΔS. The far/tenor leg stays in the SWAP band
   * so a matched FX swap does not cancel the near out of this basis.
   */
  swapNear?: number;
  /**
   * Outstanding book the far leg is on (M FCY). CIP points accrue here.
   * Defaults to `swapNear` when the path has not split M1 from later legs.
   */
  swapStanding?: number;
  /** Market swap-points curve — far-leg CIP. Missing → deposit-rate CIP fallback. */
  marketRates?: FxMarketRatesBundle | null;
  /** Far-leg tenor in months (term = horizon; rolling = 1). */
  farSettleMonths?: number;
  /**
   * Fwd Strip Δ — fraction of the near converted into the outright strip.
   * Ignored by Swap Strip; Option Strip uses option δ instead.
   */
  swapForwardDelta?: number;
  /**
   * Option δ for Option Strip only — scales option coverage and
   * delivery-leg carry. Distinct from {@link swapForwardDelta}.
   */
  optDelta: number;
  horizonDays: number;
  r_FCY: number;
  r_USD: number;
  σ_daily: number;
}

export interface StrategyHedgeResult {
  /** Buffer / outright far (M FCY, − = sell FCY). 0 if naked spot. */
  fwdNotional: number;
  /** Short-option DELIVERY notional (M FCY): + = we buy LCY on exercise (sold call),
   *  − = we sell LCY on exercise (sold put). */
  optNotional: number;
  /** Which option we WRITE — SELL_CALL on PAY carry, SELL_PUT on EARN carry. */
  optType: ShortOptionType | null;
  /** Option δ (Option Strip); 0 on other strategies. */
  optDelta: number;
  /** Fwd Strip Δ (0 on Swap Strip / when unused). */
  swapForwardDelta: number;
  /** Retained funding far after Swap Strip: −SwapNear. 0 on Fwd / Option Strip. */
  remainingFarLocalM: number;
  /** fwd + δ_opt × option delivery — the delta-effective hedge. */
  effectiveHedge: number;
  /**
   * Residual near FX after the strip (pre far-leg settle).
   * Fwd Strip = E + (1−Δ)×near. Option Strip = E + δ×option (near is in Fwd Hedge).
   */
  residualFx: number;
  fwdCarryUsdYr: number;
  /** Short option carry at FAIR VALUE = δ-weighted delivery-leg fwd points only.
   *  Premium harvested ≈ expected exercise cost, so it is EXCLUDED from carry. */
  optCarryUsdYr: number;
  /** Annualized GROSS premium income of the written option (≥ 0) — informational
   *  only; at fair value it offsets the expected exercise cost, so it is NOT
   *  part of hedgeCarryUsdYr. */
  optPremiumUsdYr: number;
  /**
   * Retained funding-swap CIP on the remaining far-leg book.
   * Swap Strip: full CIP(standing). Fwd / Option Strip: 0 (no far).
   */
  cipCarryUsdYr: number;
  /**
   * Locked FX-structure carry: CIP + outright fwd points.
   * Option delivery-leg points stay in `optCarryUsdYr` — a short option is
   * not assumed exercised at strike, so that leg is contingent, not P&L.
   */
  hedgeCarryUsdYr: number;
  /** Derived allocation (Fwd Strip); null on other strategies. */
  overlay: SwapForwardOverlay | null;
}

/**
 * Cash-flow components of a WRITTEN (short) option overlay:
 *   • deliveryLegCarryUsdYr — δ-weighted delivery-leg forward points (the only
 *     component that is CARRY at fair value);
 *   • premiumEarnedUsdYr — gross ATM premium harvested (Brenner–Subrahmanyam
 *     ≈ 0.4 σ_ann √T, annualized ×365/T). At fair value this premium ≈ the
 *     expected exercise cost, so a fairly-priced short option has expected
 *     P&L ≈ 0 — the premium is INCOME GROSS of exercise, not carry;
 *   • totalUsdYr — gross premium + delivery leg (legacy aggregate; NOT used by
 *     resolveStrategyHedge, which books only the delivery leg as carry).
 */
export function shortOptionCarryUsdYr(
  deliveryNotional: number,
  delta: number,
  horizonDays: number,
  ccy: string,
  r_FCY: number,
  r_USD: number,
  σ_daily: number,
): { deliveryLegCarryUsdYr: number; premiumEarnedUsdYr: number; totalUsdYr: number } {
  if (Math.abs(deliveryNotional) < 0.001 || horizonDays <= 0) {
    return { deliveryLegCarryUsdYr: 0, premiumEarnedUsdYr: 0, totalUsdYr: 0 };
  }
  const spotUsd = fcyToUsdM(1, ccy);
  const deliveryLegCarryUsdYr = fwdHedgeCarryUsdYr(deliveryNotional * delta, ccy, r_FCY, r_USD);
  const σ_ann = σ_daily * Math.sqrt(252);
  const tYr = horizonDays / 365;
  const premiumEarnedUsdYr = 0.4 * σ_ann * Math.sqrt(tYr) * Math.abs(deliveryNotional) * spotUsd / tYr;
  return {
    deliveryLegCarryUsdYr,
    premiumEarnedUsdYr,
    totalUsdYr: premiumEarnedUsdYr + deliveryLegCarryUsdYr,
  };
}

export function resolveStrategyHedge(
  strategy: HedgeStrategy,
  inp: StrategyHedgeInput,
): StrategyHedgeResult {
  const dust = (v: number) => (Math.abs(v) < 0.005 ? 0 : v);
  const swapNear = inp.swapNear ?? 0;
  const swapStanding = inp.swapStanding ?? swapNear;
  const spot = fcyToUsdM(1, inp.ccy);
  const settleMonths = Math.max(1, inp.farSettleMonths ?? 12);
  const cipOn = (standing: number) =>
    fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths,
      bundle: inp.marketRates,
      fallbackUsdM:
        fundingSwapCipPointsUsdYr(standing, spot, inp.r_FCY, inp.r_USD)
        * (settleMonths / 12),
    });
  const fullCip = cipOn(swapStanding);

  // ── Fwd Strip: only the near is an outright strip. No swap far / CIP. ──
  if (strategy === 'SWAP_FWD') {
    const delta = clampHedgeDelta(
      typeof inp.swapForwardDelta === 'number' ? inp.swapForwardDelta : inp.optDelta,
    );
    const overlay = allocateSwapForwardOverlay({
      exposureLocalM: inp.forecastFx,
      swapNearLocalM: swapNear,
      swapStandingLocalM: swapStanding,
      delta,
      r_FCY: inp.r_FCY,
      r_USD: inp.r_USD,
      r_OD: CURRENCY_PARAMS[inp.ccy]?.r_OD,
      spot,
    });
    const fwdNotional = overlay.forwardLocalM;
    const stripOverlay: SwapForwardOverlay = {
      ...overlay,
      remainingFarLocalM: 0,
    };
    const fwdCarryUsdYr = fwdHedgeCarryFromMarketUsd(
      fwdNotional, inp.ccy, inp.r_FCY, inp.r_USD, settleMonths, inp.marketRates,
    );
    return {
      fwdNotional,
      optNotional: 0,
      optType: null,
      optDelta: 0,
      swapForwardDelta: delta,
      remainingFarLocalM: 0,
      effectiveHedge: fwdNotional,
      residualFx: dust(inp.forecastFx + overlay.residualNearLocalM),
      fwdCarryUsdYr,
      optCarryUsdYr: 0,
      optPremiumUsdYr: 0,
      cipCarryUsdYr: 0,
      hedgeCarryUsdYr: fwdCarryUsdYr,
      overlay: stripOverlay,
    };
  }

  // ── Option Strip: full near as outright + option on the far. No leftover far. ──
  if (strategy === 'SWAP_FWD_OPT') {
    const optionDelta = clampHedgeDelta(inp.optDelta);
    const overlay = allocateSwapForwardOverlay({
      exposureLocalM: inp.forecastFx,
      swapNearLocalM: swapNear,
      swapStandingLocalM: swapStanding,
      delta: 1,
      r_FCY: inp.r_FCY,
      r_USD: inp.r_USD,
      r_OD: CURRENCY_PARAMS[inp.ccy]?.r_OD,
      spot,
    });
    const bufferFar = bufferHedgeFarLocalM(swapStanding);
    const payCarry = inp.r_USD - inp.r_FCY > 0.05;
    const earnCarry = inp.r_FCY - inp.r_USD > 0.05;
    const replaceWithOpt = Math.abs(bufferFar) >= 0.005;
    let optType: ShortOptionType | null =
      replaceWithOpt
        ? (payCarry ? 'SELL_CALL' : earnCarry ? 'SELL_PUT' : null)
        : null;
    const fwdNotional = overlay.forwardLocalM;
    const optNotional = optType ? dust(bufferFar) : 0;
    if (optNotional === 0) optType = null;
    const carryDelta = Math.min(1, Math.max(optionDelta, 0.05));
    const fwdCarryUsdYr = fwdHedgeCarryFromMarketUsd(
      fwdNotional, inp.ccy, inp.r_FCY, inp.r_USD, settleMonths, inp.marketRates,
    );
    const shortOpt = shortOptionCarryUsdYr(
      optNotional, carryDelta, inp.horizonDays, inp.ccy, inp.r_FCY, inp.r_USD, inp.σ_daily,
    );
    const effectiveHedge = fwdNotional + optNotional * optionDelta;
    return {
      fwdNotional,
      optNotional,
      optType,
      optDelta: optionDelta,
      swapForwardDelta: 1,
      remainingFarLocalM: 0,
      effectiveHedge,
      residualFx: dust(inp.forecastFx + overlay.residualNearLocalM + optNotional * optionDelta),
      fwdCarryUsdYr,
      optCarryUsdYr: shortOpt.deliveryLegCarryUsdYr,
      optPremiumUsdYr: shortOpt.premiumEarnedUsdYr,
      cipCarryUsdYr: 0,
      hedgeCarryUsdYr: fwdCarryUsdYr,
      overlay: { ...overlay, remainingFarLocalM: 0 },
    };
  }

  // ── Swap Strip: both funding-swap legs + CIP on the far. No outright. ──
  return {
    fwdNotional: 0,
    optNotional: 0,
    optType: null,
    optDelta: 0,
    swapForwardDelta: 0,
    remainingFarLocalM: dust(-swapNear),
    effectiveHedge: 0,
    residualFx: dust(inp.forecastFx + swapNear),
    fwdCarryUsdYr: 0,
    optCarryUsdYr: 0,
    optPremiumUsdYr: 0,
    cipCarryUsdYr: fullCip,
    hedgeCarryUsdYr: fullCip,
    overlay: null,
  };
}

/**
 * Settle month for a Swap+Fwd replacement forward — prefer the term far-leg
 * cycle on the funded plan, else the forecast horizon.
 */
export function settleMonthsForSwapForward(
  forecastMonths: number,
  plan?: readonly { cycleIndex?: number; far_leg?: number }[] | null,
): number {
  const Tf = Math.max(1, Math.floor(forecastMonths > 0 ? forecastMonths : 1));
  if (plan?.length) {
    for (let i = plan.length - 1; i >= 0; i -= 1) {
      const p = plan[i]!;
      if (Math.abs(p.far_leg ?? 0) > 1e-9) {
        return Math.max(1, (p.cycleIndex ?? i) + 1);
      }
    }
    return Math.max(1, plan.length);
  }
  return Tf;
}

/**
 * Scale a funded plan's standing / far-leg book by retention = (1−Δ).
 * Analytics / CFaR only — never write back into liquidityCycles.
 */
export function scaleFundingPlanByRetention<
  T extends { standing_swap: number; far_leg?: number },
>(plan: readonly T[], retention: number): T[] {
  const r = clampHedgeDelta(retention);
  return plan.map(p => ({
    ...p,
    standing_swap: p.standing_swap * r,
    ...(typeof p.far_leg === 'number' ? { far_leg: p.far_leg * r } : {}),
  }));
}

/**
 * Extra Cash Carry / settle forward from a Swap+Fwd overlay (analytics only).
 * Remaining far leg is NOT converted — it stays funding-swap metadata.
 * `amountLocalM` is the hedge trade (sell FCY = −). Convert with
 * {@link coverFromTradeLocalM} before CIP or CFaR settle.
 */
export function extraForwardFromSwapOverlay(
  ccy: string,
  overlay: SwapForwardOverlay,
  settleMonths: number,
): { ccy: string; amountLocalM: number; settleMonths: number } | null {
  if (Math.abs(overlay.forwardLocalM) < 1e-12) return null;
  return {
    ccy,
    amountLocalM: overlay.forwardLocalM,
    settleMonths: Math.max(1e-9, settleMonths),
  };
}

/**
 * Scale each CCY's funded plan by (1−Δ) from its Swap+Fwd overlay.
 * Analytics / CFaR bridge only — never write back into liquidityCycles.
 */
export function retainedFundingPlanByCcy<
  T extends { standing_swap: number; far_leg?: number },
>(
  planByCcy: Readonly<Record<string, readonly T[]>> | undefined,
  overlayByCcy: Readonly<Record<string, SwapForwardOverlay>> | undefined,
): Record<string, T[]> | undefined {
  if (!planByCcy) return undefined;
  const out: Record<string, T[]> = {};
  for (const [ccy, plan] of Object.entries(planByCcy)) {
    const overlay = overlayByCcy?.[ccy];
    const retention = overlay ? 1 - clampHedgeDelta(overlay.delta) : 1;
    out[ccy] = scaleFundingPlanByRetention(plan, retention);
  }
  return out;
}

/** Analytics-only forwards derived from desk Swap+Fwd overlays. */
export function analyticsForwardsFromOverlays(input: {
  overlayByCcy?: Readonly<Record<string, SwapForwardOverlay>>;
  planByCcy?: Readonly<
    Record<string, readonly {
      cycleIndex?: number;
      far_leg?: number;
      standing_swap?: number;
      swap_needed?: number;
    }[]>
  >;
  forecastMonths: number;
}): { ccy: string; amountLocalM: number; settleMonths: number }[] {
  const out: { ccy: string; amountLocalM: number; settleMonths: number }[] = [];
  for (const [ccy, overlay] of Object.entries(input.overlayByCcy ?? {})) {
    const plan = input.planByCcy?.[ccy];
    const delta = clampHedgeDelta(overlay.delta);
    if (Math.abs(delta) < 1e-12) continue;
    const term = plan?.some(p => Math.abs(p.far_leg ?? 0) > 1e-9) ?? false;
    if (plan?.length && !term) {
      // Rolling: one far per cycle, sign = −near (buffer hedge direction).
      for (const p of plan) {
        const inc = p.swap_needed ?? 0;
        const amount = -delta * inc;
        if (Math.abs(amount) < 1e-12) continue;
        out.push({
          ccy,
          amountLocalM: amount,
          settleMonths: 1,
        });
      }
      continue;
    }
    const settle = settleMonthsForSwapForward(input.forecastMonths, plan);
    const leg = extraForwardFromSwapOverlay(ccy, overlay, settle);
    if (leg) out.push(leg);
  }
  return out;
}

/** Resolved hedge legs after user mode / notional / delta overrides. */
export function resolveHedgeLegs(
  suggestion: HedgeSuggestion,
  activeMode: ActiveHedgeMode,
  ccy: string,
  r_FCY: number,
  r_USD: number,
  notionalOverride: number | undefined,
  deltaOverride: number | undefined,
): {
  spotSell: number;
  hedgeNotional: number;
  hedgeDelta: number;
  optionRetain: number;
  effectiveHedge: number;
  carryBenefitUsdYr: number;
} {
  if (activeMode === 'NONE') {
    return {
      spotSell: 0, hedgeNotional: 0, hedgeDelta: 0, optionRetain: 0,
      effectiveHedge: 0, carryBenefitUsdYr: 0,
    };
  }

  const hedgeNotional = notionalOverride ?? suggestion.size;
  const hedgeDelta = activeMode === 'FWD' || activeMode === 'SPOT'
    ? 1.0
    : (deltaOverride ?? suggestion.optionDelta);

  let spotSell = 0;
  let optionRetain = 0;

  if (activeMode === 'SPOT') {
    spotSell = hedgeNotional;
  } else if (activeMode === 'OPTION') {
    spotSell = suggestion.spotSell !== 0
      ? (notionalOverride !== undefined ? hedgeNotional : suggestion.spotSell)
      : 0;
    optionRetain = suggestion.optionRetain;
  }

  const effectiveHedge = activeMode === 'SPOT'
    ? spotSell
    : activeMode === 'OPTION'
      ? spotSell + optionRetain * hedgeDelta
      : hedgeNotional * hedgeDelta;

  const scale = Math.abs(suggestion.spotSell) > 0.001
    ? Math.abs(spotSell) / Math.abs(suggestion.spotSell)
    : 1;
  const carryBenefitUsdYr = spotSell < -0.001
    ? (suggestion.carryBenefitUsdYr > 0
      ? suggestion.carryBenefitUsdYr * scale
      : spotCarryBenefitUsdYr(spotSell, ccy, r_FCY, r_USD))
    : 0;

  return {
    spotSell,
    hedgeNotional,
    hedgeDelta,
    optionRetain,
    effectiveHedge,
    carryBenefitUsdYr,
  };
}
