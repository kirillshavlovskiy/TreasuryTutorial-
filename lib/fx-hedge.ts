/**
 * FX hedging decision engine — carry-aware spot sells, forwards, and options.
 *
 * PAY carry + long FCY above target → sell spot into USD cash for carry uplift.
 * If invoice / pipeline FCY need remains → buy back exposure via option (delta < 1).
 * Otherwise square off fully on spot or forward.
 */

import { fcyToUsdM } from './fx-buffer';

export type HedgeMode = 'AUTO' | 'SPOT' | 'FWD' | 'OPTION' | 'NONE';
export type ActiveHedgeMode = Exclude<HedgeMode, 'AUTO'>;

export interface HedgeSuggestionInput {
  ccy: string;
  npNetFX: number;
  npCash: number;
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

/** FCY stock above target NP cash available to sell for USD carry. */
export function excessLongNpCash(
  npCash: number,
  postSwapCash: number,
  cashThreshold: number,
): number {
  const troughExcess = Math.max(0, postSwapCash - cashThreshold);
  const stockExcess = Math.max(0, npCash - cashThreshold);
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

  const excessLong = excessLongNpCash(inp.npCash, inp.postSwapCash, inp.cashThreshold);
  const longNpFx = inp.npNetFX > 0.001 ? inp.npNetFX : 0;
  const σ_ann = inp.σ_daily * Math.sqrt(252);
  const fcastNeed = inp.fcastFX < -0.001 ? Math.abs(inp.fcastFX) : 0;

  if (inp.carryDir === 'earn') {
    if (Math.abs(inp.npNetFX) < inp.cashFloor + 0.001) {
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

  // ── Long NP FX residual (book exposure) — forward square if no excess cash ─
  if (longNpFx > inp.cashFloor + 0.001) {
    const sz = -longNpFx;
    if (DERIV_CORRIDORS.has(inp.ccy) && σ_ann > 0.08 && fcastNeed > 0.001) {
      return {
        mode: 'OPTION',
        size: sz,
        spotSell: 0,
        optionRetain: Math.min(fcastNeed, longNpFx),
        optionDelta: 0.35,
        reason: `Long NP FX — fwd hedge + option retain for pipeline (σ=${(σ_ann * 100).toFixed(0)}%)`,
        carryBenefitUsdYr: 0,
      };
    }
    return {
      mode: 'FWD',
      size: sz,
      spotSell: 0,
      optionRetain: 0,
      optionDelta: 1,
      reason: 'Long NP FX — EOM outright fwd square-off',
      carryBenefitUsdYr: 0,
    };
  }

  // ── Short NP FX — buy FCY via forward ─────────────────────────────────────
  if (inp.npNetFX < -inp.cashFloor - 0.001) {
    return {
      mode: 'FWD',
      size: -inp.npNetFX,
      spotSell: 0,
      optionRetain: 0,
      optionDelta: 1,
      reason: 'Short NP FX — buy FCY via forward',
      carryBenefitUsdYr: 0,
    };
  }

  return none('Net NP FX within floor — no hedge needed');
}

// ─── Hedge overlay carry measures (on top of the swap book) ─────────────────

/**
 * Annual USD carry impact of squaring the same-maturity FX exposure with an
 * outright FORWARD. Covered interest parity: F = S(1+r_USD)/(1+r_FCY), so
 * selling a PAY FCY forward (notional < 0, r_FCY < r_USD) locks F > S and
 * EARNS the differential; selling an EARN FCY forward locks F < S and gives
 * its yield up.
 *   carry = −notional × spot × (r_USD − r_FCY)/100   ($M/yr)
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
 * - FCY / USD cash interest: overnight cash rates (separate input)
 *
 * Long → credit; short / OD → debit on overnight rates.
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
  const fcyFwdDebit = fcyFwd?.debitPct ?? input.r_FCY ?? fcyFwdCredit;
  const usdFwdCredit = usdFwd?.creditPct ?? input.r_USD ?? 0;
  const usdFwdDebit = usdFwd?.debitPct ?? input.r_USD ?? usdFwdCredit;

  const fcyCashCredit = fcyCash?.creditPct ?? input.r_FCY ?? fcyFwdCredit;
  const fcyCashDebit =
    fcyCash?.debitPct ?? input.r_FCY ?? fcyCashCredit;
  const usdCashCredit = usdCash?.creditPct ?? input.r_USD ?? usdFwdCredit;
  const usdCashDebit =
    usdCash?.debitPct ?? input.r_USD ?? usdCashCredit;

  const fcyFwdPick = pickSideRate(N, fcyFwdCredit, fcyFwdDebit);
  const usdFwdPick = pickSideRate(usdNotional, usdFwdCredit, usdFwdDebit);
  const fcyCashPick = pickSideRate(N, fcyCashCredit, fcyCashDebit);
  const usdCashPick = pickSideRate(
    usdNotional,
    usdCashCredit,
    usdCashDebit,
  );

  const useSwapPoints =
    typeof input.swapPointsCarryUsdM === 'number' &&
    Number.isFinite(input.swapPointsCarryUsdM);
  const fwdCarryUsdM = useSwapPoints
    ? input.swapPointsCarryUsdM!
    : fwdHedgeCarryUsdYr(
        N,
        input.ccy,
        fcyFwdPick.ratePct,
        usdFwdPick.ratePct,
      ) * settleYr;
  const fcyInterestUsdM =
    usdNotional * (fcyCashPick.ratePct / 100) * fcyYr;
  const usdInterestUsdM =
    usdNotional * (usdCashPick.ratePct / 100) * usdYr;
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
// SWAP_ONLY    — FX swaps only; current + forecasted FX exposure stays open.
// SWAP_FWD     — swaps + outright forwards sized on the forecasted net flow
//                (expected payins − payouts over the cycle).
// SWAP_FWD_OPT — swaps + forwards + SHORT options: the forward squares the FULL
//                cycle-end forecast (Fwd = −Net FX Forecast, same as SWAP_FWD);
//                the option is written as a premium overlay that never resizes
//                the forward. Sizing: the written notional is MATCHED 1:1 to
//                the forward at ALL deltas — |optNotional| = |fwdNotional|.
//                δ scales only the EFFECTIVE hedge (δ × notional), which is
//                therefore linear in δ down to zero: δ = 1 offsets the full
//                forward, δ = 0.5 half of it, δ → 0 nothing.
//                Direction is keyed to the carry side of the currency:
//                  PAY LCY (r_FCY < r_USD)  → SELL CALLS (exercise: sell USD, buy LCY)
//                  EARN LCY (r_FCY > r_USD) → SELL PUTS  (exercise: buy USD, sell LCY)
//                Premium is EARNED (short gamma); exercise delivers the trade the
//                book wants anyway (PAY re-acquires LCY for payouts, EARN disposes
//                the long into USD).

export type HedgeStrategy = 'SWAP_ONLY' | 'SWAP_FWD' | 'SWAP_FWD_OPT';

export type ShortOptionType = 'SELL_CALL' | 'SELL_PUT';

export const HEDGE_STRATEGIES: { id: HedgeStrategy; label: string }[] = [
  { id: 'SWAP_ONLY',    label: 'Swap only' },
  { id: 'SWAP_FWD',     label: 'Swap + Fwd' },
  { id: 'SWAP_FWD_OPT', label: 'Swap + Fwd + Option' },
];

export interface StrategyHedgeInput {
  ccy: string;
  /** Current net FX book position (spot + fwd + non-cash, M FCY). */
  currentFx: number;
  /** Forecast net FX exposure at cycle end = current book + expected payins +
   *  payouts (M FCY) — the TOTAL hedging basis, not just the flows. */
  forecastFx: number;
  optDelta: number;
  horizonDays: number;
  r_FCY: number;
  r_USD: number;
  σ_daily: number;
}

export interface StrategyHedgeResult {
  /** Outright forward notional (M FCY, negative = sell FCY forward). */
  fwdNotional: number;
  /** Short-option DELIVERY notional (M FCY): + = we buy LCY on exercise (sold call),
   *  − = we sell LCY on exercise (sold put). */
  optNotional: number;
  /** Which option we WRITE — SELL_CALL on PAY carry, SELL_PUT on EARN carry. */
  optType: ShortOptionType | null;
  optDelta: number;
  /** fwd + δ × option delivery — the delta-effective hedge. */
  effectiveHedge: number;
  /** cycle-end forecast exposure (incl. current book) + effective hedge — what stays open. */
  residualFx: number;
  fwdCarryUsdYr: number;
  /** Short option carry at FAIR VALUE = δ-weighted delivery-leg fwd points only.
   *  Premium harvested ≈ expected exercise cost, so it is EXCLUDED from carry. */
  optCarryUsdYr: number;
  /** Annualized GROSS premium income of the written option (≥ 0) — informational
   *  only; at fair value it offsets the expected exercise cost, so it is NOT
   *  part of hedgeCarryUsdYr. */
  optPremiumUsdYr: number;
  hedgeCarryUsdYr: number;
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

  // The forward ALWAYS squares the full cycle-end forecast (book + flows):
  // Fwd = −Net FX Forecast in both hedging strategies. The written option is a
  // PREMIUM OVERLAY on top — its δ-weighted delivery is NOT folded into the
  // forward sizing; its exercise delivers the trade the book wants anyway.
  const fwdNotional =
    strategy === 'SWAP_FWD' || strategy === 'SWAP_FWD_OPT'
      ? dust(-inp.forecastFx)
      : 0;

  // Option direction is keyed to the CARRY side, not the flow sign:
  //   PAY LCY  → SELL CALL: on exercise we sell USD / buy LCY (delivery +).
  //   EARN LCY → SELL PUT:  on exercise we buy USD / sell LCY (delivery −).
  // Neutral carry → no option; the forward squares the full forecast alone.
  const payCarry = inp.r_USD - inp.r_FCY > 0.05;
  const earnCarry = inp.r_FCY - inp.r_USD > 0.05;
  let optType: ShortOptionType | null =
    strategy === 'SWAP_FWD_OPT' && fwdNotional !== 0
      ? (payCarry ? 'SELL_CALL' : earnCarry ? 'SELL_PUT' : null)
      : null;
  // Written notional MATCHED 1:1 to the forward at ALL deltas (ATM strike =
  // spot): |optNotional| = |fwdNotional|. δ scales only the delta-EFFECTIVE
  // hedge (δ × notional), so coverage is linear in δ all the way to 0.
  const optNotional = optType === 'SELL_CALL' ? dust(Math.abs(fwdNotional))
    : optType === 'SELL_PUT' ? dust(-Math.abs(fwdNotional))
    : 0;
  if (optNotional === 0) optType = null;

  // Raw δ (clamped to [0, 1]) drives the effective hedge and residual, so
  // δ → 0 → effective option coverage → 0. The premium/carry math keeps a
  // floor of 0.05 to avoid degenerate pricing on the written notional.
  const optionDelta = Math.min(1, Math.max(inp.optDelta, 0));
  const carryDelta = Math.min(1, Math.max(inp.optDelta, 0.05));

  const fwdCarryUsdYr = fwdHedgeCarryUsdYr(fwdNotional, inp.ccy, inp.r_FCY, inp.r_USD);
  // Fair-value option carry: ONLY the δ-weighted delivery-leg forward points.
  // The premium harvested ≈ expected exercise cost (a fairly-priced short
  // option has expected P&L ≈ 0), so premium is reported separately as gross
  // income and NEVER added to carry.
  const shortOpt = shortOptionCarryUsdYr(
    optNotional, carryDelta, inp.horizonDays, inp.ccy, inp.r_FCY, inp.r_USD, inp.σ_daily,
  );
  const optCarryUsdYr = shortOpt.deliveryLegCarryUsdYr;

  // Total hedge coverage = fwd + δ × option delivery (notional matched to
  // |Fwd|; δ alone scales the option's contribution).
  const effectiveHedge = fwdNotional + optNotional * optionDelta;

  return {
    fwdNotional,
    optNotional,
    optType,
    optDelta: optionDelta,
    effectiveHedge,
    // Residual = forecast + TOTAL delta-weighted hedge (fwd + δ × option):
    // both legs count toward coverage, the option at its delta weight.
    residualFx: inp.forecastFx + effectiveHedge,
    fwdCarryUsdYr,
    optCarryUsdYr,
    optPremiumUsdYr: shortOpt.premiumEarnedUsdYr,
    hedgeCarryUsdYr: fwdCarryUsdYr + optCarryUsdYr,
  };
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
