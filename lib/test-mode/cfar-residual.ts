import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import { CURRENCY_PARAMS } from '@/lib/fx-buffer';
import type { ForecastProfileState } from '@/lib/forecast-profile';
import {
  buildGrowingKnots,
  computeCfarBands,
  exposureAtKnots,
  type CfarBandPoint,
  type CfarBandsResult,
  type ExposureKnot,
} from '@/lib/test-mode/cfar-drawdown';
import { fundingSwapKnotsFromOutstanding } from '@/lib/test-mode/cfar-funding-swap';
import {
  buildHedgedVarProfileWithCoverAt,
  buildStripHedgedVarProfile,
  stripTicketsForCcy,
  varSetupWithLineUncertainty,
  type HedgeTicket,
  type PreparedHedgeLeg,
  type PreparedHedgeProfile,
  type StripHedgedVarLeg,
} from '@/lib/test-mode/hedge-var';
import {
  clampRateVolBpYr,
  forecastErrorStdForSetupM,
  horizonMonths,
  monthlyVolForSetup,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

/**
 * Synthetic strip/bullet built from just (total notional, leg count, tenure) —
 * for "what-if" scenario testing, independent of whatever is actually
 * booked/prepared. `legCount` equally-sized forwards, dealt today (trade date
 * recognition, matching how real strip legs are treated for FX-rate risk),
 * maturing at k·T/legCount for k=1..legCount (legCount=1 → a single bullet
 * at T). Feed the result into {@link residualKnotsForHedge},
 * {@link settlementFundingGapForHedge}, or the Cash Carry pipeline
 * (`buildCashForecastCarryComparison` + `resolvedHedgedTotalCarryUsdM`) in
 * place of a real prepared profile to see the CFaR / funding-gap / carry
 * impact of changing hedge amount and frequency before booking anything.
 */
export function buildSyntheticHedgeProfile(input: {
  totalNotionalLocalM: number;
  legCount: number;
  tenureMonths: number;
}): PreparedHedgeProfile {
  const n = Math.max(1, Math.round(input.legCount));
  const T = input.tenureMonths > 0 ? input.tenureMonths : 1;
  const per = input.totalNotionalLocalM / n;
  if (n < 2) {
    return {
      structure: 'bullet',
      basis: 'varNeutral',
      ticketBasis: 'stock',
      legs: [],
      coverLocalM: input.totalNotionalLocalM,
      hedgeRatio: 0,
      settleMonths: T,
    };
  }
  const legs: PreparedHedgeLeg[] = Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    // Continuous (not floored to whole months): as legCount grows, the first
    // leg's settle → 0, so the flow/buildup component of the funding gap can
    // actually converge toward zero (finer matching = cash lands sooner).
    // Pre-existing stock at T0 is a separate floor — no forward, however
    // early it settles, delivers cash before its own settle date, so only a
    // spot/T0 conversion (not more forward legs) zeroes that component out.
    const settle = k === n ? T : (k * T) / n;
    return {
      index: i,
      startMonth: 0, // dealt today — FX delta hedged from trade date
      endMonth: settle,
      settleMonths: settle,
      hedgeLocalM: per * k,
      tradeNotionalLocalM: per,
      label: `M${settle.toFixed(settle < 1 ? 2 : 1)}`,
    };
  });
  return {
    structure: 'strip',
    basis: 'varNeutral',
    ticketBasis: 'stock',
    legs,
    coverLocalM: input.totalNotionalLocalM,
    hedgeRatio: 0,
  };
}

export interface ResidualHedgeInput {
  stockM: number;
  monthlyFlows: readonly number[];
  ccy: string;
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  prepared?: PreparedHedgeProfile | null;
  tenureMonths: number;
}

export interface ResidualKnots {
  /** Signed residual r(t)=e(t)−H(t) (hedged) or open e(t) (unhedged). */
  knots: ExposureKnot[];
  /** True when a real hedge (booked strip or prepared) shaped the path. */
  hedged: boolean;
}

/**
 * Residual exposure path r(t)=e(t)−H(t) for the real hedge chosen in Cash Carry
 * (booked strip → prepared strip → prepared bullet), else the open growth path.
 * Cover counts from each leg's TRADE date (recognizeFromMonths=0) — dealing a
 * forward removes FX delta risk immediately regardless of when it settles.
 * This is the right convention for FX-rate / MTM VaR reporting (how much
 * notional is still unhedged), and by construction it's insensitive to strip
 * leg count/spacing — splitting the same total across more legs doesn't
 * change how much of it is rate-locked from T0.
 *
 * NOT used for CFaR — a cash question needs the SETTLEMENT residual (cover
 * counted only once a leg delivers), see {@link settlementResidualKnotsForHedge}.
 */
export function residualKnotsForHedge(input: ResidualHedgeInput): ResidualKnots {
  const { stockM, monthlyFlows, ccy, setup, bookedHedges, prepared } = input;
  const T = input.tenureMonths > 0 ? input.tenureMonths : horizonMonths(setup.horizon);
  const flowM =
    monthlyFlows.length > 0
      ? monthlyFlows.reduce((a, b) => a + b, 0) / monthlyFlows.length
      : 0;

  const toKnots = (
    profile: { t: number; exposureLocalM: number; cumulCoverLocalM: number }[],
  ): ExposureKnot[] =>
    profile.map(p => ({ t: p.t, e: p.exposureLocalM - p.cumulCoverLocalM }));

  const booked = stripTicketsForCcy(bookedHedges, ccy)
    .slice()
    .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
  if (booked.length > 0) {
    const legs: StripHedgedVarLeg[] = booked.map(t => ({
      amountLocalM: t.amountLocalM,
      tenureMonths: horizonMonths(t.maturity ?? setup.horizon),
      recognizeFromMonths: 0,
    }));
    const profile = buildStripHedgedVarProfile(
      stockM,
      flowM,
      ccy,
      setup,
      legs,
      monthlyFlows,
      1,
    );
    if (profile.length > 1) return { knots: toKnots(profile), hedged: true };
  }

  if (prepared && Math.abs(prepared.coverLocalM) > 1e-9) {
    if (prepared.structure === 'strip' && prepared.legs.length > 0) {
      const legs: StripHedgedVarLeg[] = prepared.legs.map(l => ({
        amountLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
        tenureMonths: l.endMonth > 0 ? l.endMonth : T,
        recognizeFromMonths: l.startMonth ?? 0,
      }));
      const profile = buildStripHedgedVarProfile(
        stockM,
        flowM,
        ccy,
        setup,
        legs,
        monthlyFlows,
        1,
      );
      if (profile.length > 1) return { knots: toKnots(profile), hedged: true };
    }
    const H = prepared.coverLocalM;
    const profile = buildHedgedVarProfileWithCoverAt(
      stockM,
      flowM,
      ccy,
      setup,
      () => H,
      monthlyFlows,
      1,
    );
    if (profile.length > 1) return { knots: toKnots(profile), hedged: true };
  }

  return { knots: buildGrowingKnots(stockM, monthlyFlows, T), hedged: false };
}

/**
 * Residual exposure path r_settle(t) = e(t) − H_settled(t) — cover counts
 * only once each leg actually SETTLES (delivers cash), not from trade date.
 *
 * This is the residual that should drive CFaR. Dealing a forward locks the
 * RATE immediately (that's what {@link residualKnotsForHedge} measures, and
 * it's the right thing for FX-rate/VaR reporting) — but CFaR is a CASH
 * question: no cash moves until settlement, so the desk's funding exposure
 * between T0 and each leg's settle date is still open regardless of when the
 * rate was locked. A residual built on trade-date recognition is provably
 * insensitive to leg count/spacing (H(t) is the same constant total no
 * matter how it's split); this one is not — more, better-spaced legs
 * genuinely shrink the sawtooth between settlements, converging toward zero
 * stochastic variance (pure carry) in the limit of continuous matching.
 *
 * Samples finer than 1 month once legs are spaced closer than that, so the
 * simulated path can actually see the sawtooth shrinking as leg count grows
 * instead of being masked by a coarse monthly grid (same fix applied to
 * {@link settlementFundingGapForHedge}).
 */
export function settlementResidualKnotsForHedge(input: ResidualHedgeInput): ResidualKnots {
  const { stockM, monthlyFlows, ccy, setup, bookedHedges, prepared } = input;
  const T = input.tenureMonths > 0 ? input.tenureMonths : horizonMonths(setup.horizon);
  const flowM =
    monthlyFlows.length > 0
      ? monthlyFlows.reduce((a, b) => a + b, 0) / monthlyFlows.length
      : 0;

  const toKnots = (
    profile: { t: number; exposureLocalM: number; cumulCoverLocalM: number }[],
  ): ExposureKnot[] =>
    profile.map(p => ({ t: p.t, e: p.exposureLocalM - p.cumulCoverLocalM }));
  const fineStep = (legCount: number) =>
    Math.max(0.05, Math.min(1, T / (legCount * 6)));

  const booked = stripTicketsForCcy(bookedHedges, ccy)
    .slice()
    .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
  if (booked.length > 0) {
    const legs: StripHedgedVarLeg[] = booked.map(t => {
      const settle = horizonMonths(t.maturity ?? setup.horizon);
      return { amountLocalM: t.amountLocalM, tenureMonths: settle, recognizeFromMonths: settle };
    });
    const profile = buildStripHedgedVarProfile(
      stockM,
      flowM,
      ccy,
      setup,
      legs,
      monthlyFlows,
      fineStep(booked.length),
    );
    if (profile.length > 1) return { knots: toKnots(profile), hedged: true };
  }

  if (prepared && Math.abs(prepared.coverLocalM) > 1e-9) {
    if (prepared.structure === 'strip' && prepared.legs.length > 0) {
      const legs: StripHedgedVarLeg[] = prepared.legs.map(l => {
        const settle = l.settleMonths ?? (l.endMonth > 0 ? l.endMonth : T);
        return {
          amountLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
          tenureMonths: settle,
          recognizeFromMonths: settle,
        };
      });
      const profile = buildStripHedgedVarProfile(
        stockM,
        flowM,
        ccy,
        setup,
        legs,
        monthlyFlows,
        fineStep(prepared.legs.length),
      );
      if (profile.length > 1) return { knots: toKnots(profile), hedged: true };
    }
    const settle = prepared.settleMonths ?? T;
    const profile = buildHedgedVarProfileWithCoverAt(
      stockM,
      flowM,
      ccy,
      setup,
      t => (t + 1e-9 >= settle ? prepared.coverLocalM : 0),
      monthlyFlows,
      1,
    );
    if (profile.length > 1) return { knots: toKnots(profile), hedged: true };
  }

  return { knots: buildGrowingKnots(stockM, monthlyFlows, T), hedged: false };
}

/**
 * Flat assumed annualized rate-differential volatility (bp/year) per
 * currency — sizes the uncertainty in swap points for a bridge-funding swap
 * (dealt-but-not-yet-settled notional). Approximate, pending real
 * calibration from the historical forward-points curve (same caveat as the
 * σ_daily/carry/β_IR table in fx-buffer.ts — recalibrate when the monetary
 * regime shifts, especially for EM). Rough ordering follows β_IR there:
 * stable DM low, EM high, TRY highest.
 */
export const RATE_DIFF_VOL_BP_YR: Record<string, number> = {
  USD: 0,
  AED: 20, DKK: 20,
  CHF: 30, HKD: 30, JPY: 35,
  CNY: 40, EUR: 45, SGD: 45, THB: 45,
  CAD: 55, SEK: 55,
  AUD: 60, NOK: 60,
  GBP: 65,
  NZD: 70, ILS: 75,
  CZK: 90,
  MXN: 120, PLN: 100, RON: 100,
  HUF: 130, ZAR: 130,
  RSD: 180,
  TRY: 450,
};
/** Fallback for currencies not in the table above. */
export const DEFAULT_RATE_DIFF_VOL_BP_YR = 80;

/** Desk-table rate-differential vol for a currency, before any override. */
export function presetRateVolBpYr(ccy: string): number {
  return RATE_DIFF_VOL_BP_YR[ccy] ?? DEFAULT_RATE_DIFF_VOL_BP_YR;
}

/**
 * Rate-differential vol in bp/year for a currency — the setup's override when
 * one is set, otherwise the desk table. The override deliberately replaces the
 * table for every currency rather than shifting it, so a single field cannot
 * leave USD at 0 and TRY at 450 while claiming to have set the rate vol.
 */
export function rateVolBpYrFor(
  ccy: string,
  setup?: Pick<VarSetup, 'rateVolOverrideBpYr'> | null,
): number {
  const override = setup?.rateVolOverrideBpYr;
  return typeof override === 'number' && Number.isFinite(override)
    ? clampRateVolBpYr(override)
    : presetRateVolBpYr(ccy);
}

/** Rate-differential vol converted to the same monthly-decimal convention as
 * monthlyVolForSetup, so it drops into the identical z·S·σ·√t formula. */
function rateDiffVolMonthly(
  ccy: string,
  setup?: Pick<VarSetup, 'rateVolOverrideBpYr'> | null,
): number {
  return rateVolBpYrFor(ccy, setup) / 10000 / Math.sqrt(12);
}

/**
 * Expected (level, not vol) benefit of BRIDGING — Δr = r_USD − r_FCY, same
 * sign convention as fx-buffer.ts's delta_r_pct, from the JPM NP rate table
 * CURRENCY_PARAMS already uses for the main hedge's carry. Bridging means
 * temporarily holding USD instead of FCY during the swap window: for an EARN
 * currency (r_FCY>r_USD, Δr<0) that gives up FCY's premium — a real cost
 * (negative here, matching computeCfarBands' "positive carryUsdM = +earn,
 * reduces loss" convention). For a PAY currency (r_FCY<r_USD, Δr>0) holding
 * USD instead nets a small gain (positive here).
 */
function expectedRateDiffPctPa(ccy: string): number {
  const fcy = CURRENCY_PARAMS[ccy]?.carry;
  const usd = CURRENCY_PARAMS.USD?.carry;
  if (fcy === undefined || usd === undefined) return 0;
  return usd - fcy;
}

/**
 * Cumulative expected swap-points cost through each month boundary, for the
 * capped swap-bridge notional path — the deterministic base the stochastic
 * swap band sits on top of (same role carryScheduleUsdM plays for the spot
 * side). Integrates notional(t) · (Δr/100)/12 over each month via a short
 * trapezoidal pass on the knot-interpolated path, since the notional itself
 * moves within a month (the settlement sawtooth), not just between months.
 */
function expectedSwapCostScheduleUsdM(
  swapKnots: readonly ExposureKnot[],
  ccy: string,
  spotUsd: number,
  T: number,
): number[] {
  const ratePctPa = expectedRateDiffPctPa(ccy);
  const months = Math.max(1, Math.ceil(T));
  const schedule: number[] = [];
  let cum = 0;
  const subSteps = 8;
  for (let m = 1; m <= months; m += 1) {
    const tLo = m - 1;
    const tHi = Math.min(m, T);
    const dt = (tHi - tLo) / subSteps;
    let area = 0;
    for (let s = 0; s < subSteps; s += 1) {
      const ta = tLo + s * dt;
      const tb = ta + dt;
      const va = exposureAtKnots(swapKnots, ta);
      const vb = exposureAtKnots(swapKnots, tb);
      area += ((va + vb) / 2) * dt;
    }
    cum += (area * spotUsd * (ratePctPa / 100)) / 12;
    schedule.push(cum);
  }
  return schedule;
}

/** Breakdown of where a combined CFaR figure came from, for transparency. */
export interface CfarRiskBreakdown {
  /** Peak spot-risk component alone (not-yet-dealt exposure + forecast uncertainty), USD M. */
  spotPeakUsdM: number;
  /** Peak swap-bridge risk component alone (dealt-but-not-settled, capped at
   * the real unsettled exposure), USD M — gross, before the expected swap
   * cost below is netted in. */
  swapPeakUsdM: number;
  /** Expected (deterministic) swap-points cost/gain accrued by T, from the
   * JPM NP rate differential applied to the swap-bridge notional path. */
  swapExpectedCostUsdM: number;
  /** Peak funding-swap bridge (outstanding liquidity swap × rate-diff vol). */
  fundingPeakUsdM: number;
}

/**
 * Full CFaR bands combining the FX-book risk sources, replacing a single
 * spot-vol pass over the settlement gap:
 *
 * 1. Spot risk — the piece of the gap with NO forward dealt at all
 *    (r_trade(t) = e(t) − H_traded(t), from {@link residualKnotsForHedge}).
 *    Converting this needs an outright, uncovered spot trade — genuinely
 *    exposed to spot level, so it gets full FX vol.
 * 2. Forecast/quantity uncertainty — e(t) is a forecast, not a fact; any
 *    shortfall or excess beyond what's hedged gets covered on the real spot
 *    market too, so it's folded into the spot-risk magnitude (RSS, same
 *    convention as the Analytics VaR engine's σ_E — see
 *    forecastErrorStdForSetupM in var-setup.ts).
 * 3. Swap-bridge risk — the piece that's already been DEALT (a forward
 *    exists) but hasn't SETTLED yet (H_traded(t) − H_settled(t) =
 *    g(t) − r_trade(t)). Bridging this via spot+swap-back has ~zero net
 *    spot exposure (the eventual forward delivery cancels the swap's far
 *    leg) — the only uncertainty is the swap points you'll get at the
 *    future moment you're forced to bridge, i.e. rate-differential vol
 *    over the SAME √t horizon, not spot vol.
 *
 * The dollar-risk components are computed independently (different vols
 * on different notionals) then combined in quadrature (RSS) at every point
 * in time — they're different risk factors, not perfectly correlated.
 *
 * 4. Funding-swap bridge (optional) — outstanding liquidity funding swap,
 *    same rate-diff vol as (3). Displayed CFaR only; cover sizing must omit
 *    this input so the swap cannot feed back into its own size.
 */
export function computeHedgeCfarBands(input: {
  stockM: number;
  monthlyFlows: readonly number[];
  ccy: string;
  setup: VarSetup;
  bookedHedges: readonly HedgeTicket[];
  prepared?: PreparedHedgeProfile | null;
  tenureMonths: number;
  carryUsdM?: number;
  carryScheduleUsdM?: readonly number[];
  /** When set, Revenue / line σ overrides global Analytics u₁ₘ for this CCY. */
  forecastProfile?: ForecastProfileState | null;
  /** Outstanding liquidity funding swap (FCY M) by month — displayed CFaR. */
  fundingSwapOutstandingM?: readonly number[];
  /** Term cover: outstanding goes to 0 at T when the far leg settles. */
  fundingSwapTermSettles?: boolean;
}): CfarBandsResult & { breakdown: CfarRiskBreakdown; hedged: boolean } {
  const { ccy } = input;
  // Line-level projection σ (Forecast profile) → effective u₁ₘ for quantity risk.
  const setup = varSetupWithLineUncertainty(
    input.setup,
    ccy,
    input.forecastProfile,
  );
  // Cash quantity risk applies even when the VaR profile is Cash/stock —
  // forecastErrorStdForSetupM otherwise returns 0 for exposureBasis==='stock'.
  const qtySetup: VarSetup =
    setup.exposureBasis === 'stock'
      ? { ...setup, exposureBasis: 'avgBuildup' }
      : setup;
  const T = input.tenureMonths > 0 ? input.tenureMonths : horizonMonths(setup.horizon);
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  const sigmaFx = monthlyVolForSetup(setup);
  const monthlyFlowM =
    input.monthlyFlows.length > 0
      ? input.monthlyFlows.reduce((a, b) => a + b, 0) / input.monthlyFlows.length
      : 0;

  const hedgeInput = { ...input, setup };
  const { knots: tradeKnots } = residualKnotsForHedge(hedgeInput);
  const { knots: settleKnots, hedged } = settlementResidualKnotsForHedge(hedgeInput);
  // Raw exposure e(t) alone (no hedge subtracted) — needed to test under- vs
  // over-hedged by MAGNITUDE rather than by the sign of e(t)−H(t), which only
  // means "under-hedged when positive" for a positive (long) exposure. For a
  // negative (short) exposure — e.g. a currency being net sold, growing more
  // negative over time — a full bullet dealt today has H_traded(t) more
  // negative than e(t) early on (bigger short than currently accrued), which
  // is economically OVER-hedged (ahead, same as the long case) but e(t)−H(t)
  // is POSITIVE there, the same sign the long case uses for under-hedged.
  const rawExposureKnots = buildGrowingKnots(input.stockM, input.monthlyFlows, T);

  const steps = Math.max(48, Math.min(192, Math.ceil(T * 8)));
  const dt = T > 0 ? T / steps : 0;
  const spotKnots: ExposureKnot[] = [];
  const swapKnots: ExposureKnot[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i * dt;
    const rTrade = exposureAtKnots(tradeKnots, t);
    const gSettle = exposureAtKnots(settleKnots, t);
    const dealtNotSettled = gSettle - rTrade;
    const sigmaE = forecastErrorStdForSetupM(
      monthlyFlowM,
      qtySetup,
      input.monthlyFlows,
      t,
    );
    // Only the UNDER-hedged direction is real spot risk — a real, uncovered
    // amount with nothing to net against. Over-hedged (dealt more than has
    // accrued yet, in the SAME direction) is not: that notional is
    // rate-locked, and any mismatch is a forecast question (already in σ_E),
    // not a spot-rate one. Test by MAGNITUDE and direction, not by the raw
    // sign of rTrade=e−H — that sign only reads as "under-hedged" for a
    // positive exposure; for a negative one it's inverted (see comment
    // above rawExposureKnots).
    const eRaw = exposureAtKnots(rawExposureKnots, t);
    const hTraded = eRaw - rTrade;
    const sameDirection = eRaw === 0 || hTraded === 0 || (eRaw > 0) === (hTraded > 0);
    const underHedged = sameDirection
      ? Math.max(0, Math.abs(eRaw) - Math.abs(hTraded))
      : Math.abs(eRaw);
    // sigmaE is a QUANTITY uncertainty (local-M) — "I might actually receive
    // more/less than forecast" — and already carries its own horizon
    // dependence (cumulative forecast error over t). It converts to USD at
    // the CURRENT spot level, full stop; it should NOT be additionally
    // scaled down by FX volatility the way underHedged (a fixed notional
    // facing an uncertain future price) correctly is. computeCfarBands below
    // applies z·spotUsd·sigmaMonthly·√t uniformly to whatever notional it's
    // given, so pre-divide sigmaE by (sigmaMonthly·√t) here — the
    // reapplication downstream exactly cancels back to sigmaE·spotUsd with no
    // extra vol/time discount. (Previously sigmaE was RSS'd in raw alongside
    // underHedged, so the shared ×sigmaMonthly×√t factor silently shrank the
    // quantity-uncertainty contribution by ~1/sigmaMonthly — roughly 40x too
    // small for a realistic monthly FX vol.)
    const priceVolFactor = sigmaFx * Math.sqrt(t);
    const qtyNotionalEquiv = priceVolFactor > 1e-9 ? sigmaE / priceVolFactor : 0;
    spotKnots.push({ t, e: Math.sqrt(underHedged * underHedged + qtyNotionalEquiv * qtyNotionalEquiv) });
    // Cap at the real unsettled exposure |gSettle| — when over-hedged
    // (rTrade<0), dealtNotSettled = gSettle - rTrade overshoots gSettle by
    // exactly the over-hedge amount. That excess is dealt notional beyond
    // what's actually needed to cover e(t); it still eventually settles, but
    // bridging it isn't driven by a real cash need, so it shouldn't be priced
    // as swap-bridge risk. The swap can never need to bridge more than the
    // exposure that's genuinely still outstanding.
    const swapNotional = Math.min(Math.abs(dealtNotSettled), Math.abs(gSettle));
    swapKnots.push({ t, e: swapNotional });
  }

  const spotBands = computeCfarBands({
    knots: spotKnots,
    spotUsd,
    sigmaMonthly: sigmaFx,
    confidencePct: setup.confidencePct,
    carryUsdM: input.carryUsdM,
    carryScheduleUsdM: input.carryScheduleUsdM,
    steps,
  });
  // Expected bridge swap-points (diagnostic only). Do NOT net them into
  // Net CFaR: that earn scales with unsettled notional, so a 1-leg bullet
  // looked *better* on Net than a fine strip whenever σ_E dominates Gross —
  // the opposite of the settlement-matching incentive. Real FWD hedge carry
  // still offsets via spotBands' carryScheduleUsdM; swapExpected stays in
  // the breakdown for transparency.
  const swapCostSchedule = expectedSwapCostScheduleUsdM(swapKnots, ccy, spotUsd, T);
  const swapBands = computeCfarBands({
    knots: swapKnots,
    spotUsd,
    sigmaMonthly: rateDiffVolMonthly(ccy, setup),
    confidencePct: setup.confidencePct,
    steps,
  });
  const fundingKnots = fundingSwapKnotsFromOutstanding(
    input.fundingSwapOutstandingM ?? [],
    T,
    input.fundingSwapTermSettles,
  );
  const fundingBands = fundingKnots.length > 0
    ? computeCfarBands({
        knots: fundingKnots,
        spotUsd,
        sigmaMonthly: rateDiffVolMonthly(ccy, setup),
        confidencePct: setup.confidencePct,
        steps,
      })
    : null;

  const rss = (a: number, b: number) => Math.sqrt(a * a + b * b);
  const rss3 = (a: number, b: number, c: number) => Math.sqrt(a * a + b * b + c * c);
  // Fan percentiles stay at fixed ±1.6449 (visual p05/p95) — the plotted
  // shape only, not the headline figure (see criticalCashUsdM below).
  const points: CfarBandPoint[] = spotBands.points.map((sp, i) => {
    const sw = swapBands.points[i]!;
    const fw = fundingBands?.points[i];
    const p05 = fw ? -rss3(sp.p05, sw.p05, fw.p05) : -rss(sp.p05, sw.p05);
    const carryUsdM = sp.carryUsdM + sw.carryUsdM + (fw?.carryUsdM ?? 0);
    const netP05 = p05 + carryUsdM;
    return {
      t: sp.t,
      exposureLocalM: sp.exposureLocalM,
      carryUsdM,
      p05,
      p25: fw ? -rss3(sp.p25, sw.p25, fw.p25) : -rss(sp.p25, sw.p25),
      p50: 0,
      p75: fw ? rss3(sp.p75, sw.p75, fw.p75) : rss(sp.p75, sw.p75),
      p95: fw ? rss3(sp.p95, sw.p95, fw.p95) : rss(sp.p95, sw.p95),
      netP05,
      netP50: carryUsdM,
    };
  });
  // Headline peaks: RSS-combine each risk's OWN worst-case peak, rather than
  // requiring both to hit their worst point at the same instant (a per-t
  // joint scan). Spot risk (forecast uncertainty) structurally peaks at
  // maturity — cumulative forecast error is largest with the most elapsed
  // time, regardless of hedge structure — while swap-bridge risk peaks
  // mid-horizon and is exactly zero by maturity once a strip has fully
  // settled. A per-t joint scan therefore always lands on maturity for any
  // strip with 2+ legs (where swap contributes nothing), silently discarding
  // swap's entire leg-driven improvement from the headline number even
  // though it's real and visible in the isolated breakdown. RSS-combining
  // each factor's own independent peak — the standard way unrelated risk
  // factors are combined when they need not co-occur — keeps strip
  // count/spacing visible in Gross and Net CFaR across the whole range, not
  // only bullet-vs-any-strip.
  const fundingPeak = fundingBands?.criticalCashUsdM ?? 0;
  const criticalCashUsdM = rss3(
    spotBands.criticalCashUsdM, swapBands.criticalCashUsdM, fundingPeak,
  );
  const grossLead = [
    { v: spotBands.criticalCashUsdM, m: spotBands.grossPeakMonth },
    { v: swapBands.criticalCashUsdM, m: swapBands.grossPeakMonth },
    { v: fundingPeak, m: fundingBands?.grossPeakMonth ?? 0 },
  ].reduce((a, b) => (b.v > a.v ? b : a));
  const grossPeakMonth = grossLead.m;
  // Net: spot nets against the real hedge carry it was given, at its own
  // peak timeline. Swap-bridge's expected swap-points value stays
  // informational only (swapExpectedCostUsdM below) — netting it here would
  // let a slower, bigger bullet look "safer" than a fine strip purely by
  // earning more carry on more unsettled notional, the opposite of the
  // settlement-matching incentive this metric exists to encourage.
  const netCriticalCashUsdM = rss3(
    spotBands.netCriticalCashUsdM, swapBands.criticalCashUsdM, fundingPeak,
  );
  const netLead = [
    { v: spotBands.netCriticalCashUsdM, m: spotBands.peakMonth },
    { v: swapBands.criticalCashUsdM, m: swapBands.grossPeakMonth },
    { v: fundingPeak, m: fundingBands?.grossPeakMonth ?? 0 },
  ].reduce((a, b) => (b.v > a.v ? b : a));
  const peakMonth = netLead.m;
  return {
    points,
    openPathVarUsdM: criticalCashUsdM,
    criticalCashUsdM,
    netCriticalCashUsdM,
    peakMonth,
    grossPeakMonth,
    kEmpirical: 1,
    hedged,
    breakdown: {
      spotPeakUsdM: spotBands.criticalCashUsdM,
      swapPeakUsdM: swapBands.criticalCashUsdM,
      swapExpectedCostUsdM: swapCostSchedule[swapCostSchedule.length - 1] ?? 0,
      fundingPeakUsdM: fundingPeak,
    },
  };
}

export interface ResidualCfarClosedForm {
  hedged: boolean;
  /** Point-in-time peak month when hedged, or Tf for the open accrued path. */
  peakMonth: number;
  /** Net-of-carry critical cash (USD M). */
  netCashUsdM: number;
  /** Gross critical cash (USD M). */
  grossCashUsdM: number;
}

/**
 * Legacy closed-form peak (under-hedged residual × FX vol). Do not use for
 * cover sizing or displayed headlines — those go through
 * {@link fxHedgeNetCfarByCcyUsdM} (Monte Carlo size + timing).
 */
export function residualCfarClosedFormUsdM(
  input: ResidualHedgeInput & {
    carryUsdM?: number;
    forecastProfile?: ForecastProfileState | null;
    fundingSwapOutstandingM?: readonly number[];
    fundingSwapTermSettles?: boolean;
  },
): ResidualCfarClosedForm {
  const bands = computeHedgeCfarBands(input);
  return {
    hedged: bands.hedged,
    peakMonth: bands.peakMonth,
    grossCashUsdM: bands.criticalCashUsdM,
    netCashUsdM: bands.netCriticalCashUsdM,
  };
}

/** One time-slice of the settlement funding-gap path. */
export interface FundingGapPoint {
  t: number;
  /** Signed gap e(t)−H_settled(t) (local FCY M) — forecast not yet delivered. */
  gapLocalM: number;
}

export interface FundingGapResult {
  points: FundingGapPoint[];
  /** Worst |gap| over the horizon (local FCY M). */
  maxGapLocalM: number;
  /** Worst |gap| converted to USD at the CCY's reference spot. */
  maxGapUsdM: number;
  /** Month of the worst funding gap. */
  peakMonth: number;
  /** Number of distinct settlement dates feeding the schedule. */
  legCount: number;
}

/**
 * Settlement funding gap g(t) = e(t) − H_settled(t): forecast exposure not yet
 * DELIVERED by a settled forward. Unlike {@link residualKnotsForHedge} (which
 * counts a leg's cover from its trade date, correct for FX-rate risk since
 * dealing a forward fixes the rate immediately), this counts cover only once
 * each leg actually settles — the volume/timing gap that drives real
 * liquidity/funding need, independent of FX volatility.
 *
 * This is the number that actually depends on strip leg count and spacing: a
 * coarse 1–2 leg strip leaves g(t) open (undelivered) for most of the horizon
 * even though FX delta is fully hedged from day 0; a fine strip matched to the
 * flow schedule closes it continuously. Returns null when there is no real
 * hedge to compare the forecast against (nothing to be "not yet delivered").
 */
export function settlementFundingGapForHedge(
  input: ResidualHedgeInput,
): FundingGapResult | null {
  const { stockM, monthlyFlows, ccy, setup, bookedHedges, prepared } = input;
  const T = input.tenureMonths > 0 ? input.tenureMonths : horizonMonths(setup.horizon);
  const flowM =
    monthlyFlows.length > 0
      ? monthlyFlows.reduce((a, b) => a + b, 0) / monthlyFlows.length
      : 0;
  const spot = NORDTECH_VAR.spotUsd[ccy] ?? 1;

  const fromProfile = (
    profile: { t: number; exposureLocalM: number; cumulCoverLocalM: number }[],
  ): Omit<FundingGapResult, 'legCount'> | null => {
    if (profile.length < 2) return null;
    const points = profile.map(p => ({
      t: p.t,
      gapLocalM: p.exposureLocalM - p.cumulCoverLocalM,
    }));
    let maxAbs = 0;
    let tPeak = 0;
    for (const pt of points) {
      if (Math.abs(pt.gapLocalM) > maxAbs) {
        maxAbs = Math.abs(pt.gapLocalM);
        tPeak = pt.t;
      }
    }
    return { points, maxGapLocalM: maxAbs, maxGapUsdM: maxAbs * spot, peakMonth: tPeak };
  };

  // Sample finer than 1 month once legs are spaced closer than that — a
  // coarse monthly grid can't "see" the gap shrinking once legCount exceeds
  // the horizon in months, which would mask exactly the improvement this
  // metric exists to show. Floored at 0.05m (~1.5 days) to bound cost.
  const fineStep = (legCount: number) =>
    Math.max(0.05, Math.min(1, T / (legCount * 6)));

  const booked = stripTicketsForCcy(bookedHedges, ccy)
    .slice()
    .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
  if (booked.length > 0) {
    const legs: StripHedgedVarLeg[] = booked.map(t => {
      const settle = horizonMonths(t.maturity ?? setup.horizon);
      return { amountLocalM: t.amountLocalM, tenureMonths: settle, recognizeFromMonths: settle };
    });
    const profile = buildStripHedgedVarProfile(
      stockM,
      flowM,
      ccy,
      setup,
      legs,
      monthlyFlows,
      fineStep(booked.length),
    );
    const res = fromProfile(profile);
    if (res) return { ...res, legCount: booked.length };
  }

  if (prepared && prepared.structure === 'strip' && prepared.legs.length > 0) {
    const legs: StripHedgedVarLeg[] = prepared.legs.map(l => {
      const settle = l.settleMonths ?? (l.endMonth > 0 ? l.endMonth : T);
      return {
        amountLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
        tenureMonths: settle,
        recognizeFromMonths: settle,
      };
    });
    const profile = buildStripHedgedVarProfile(
      stockM,
      flowM,
      ccy,
      setup,
      legs,
      monthlyFlows,
      fineStep(prepared.legs.length),
    );
    const res = fromProfile(profile);
    if (res) return { ...res, legCount: prepared.legs.length };
  }

  if (prepared && prepared.structure === 'bullet' && Math.abs(prepared.coverLocalM) > 1e-9) {
    const settle = prepared.settleMonths ?? T;
    const profile = buildHedgedVarProfileWithCoverAt(
      stockM,
      flowM,
      ccy,
      setup,
      t => (t + 1e-9 >= settle ? prepared.coverLocalM : 0),
      monthlyFlows,
      1,
    );
    const res = fromProfile(profile);
    if (res) return { ...res, legCount: 1 };
  }

  return null;
}
