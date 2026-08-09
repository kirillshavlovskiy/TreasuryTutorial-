import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  buildGrowingKnots,
  computeCfarBands,
  exposureAtKnots,
  type CfarBandPoint,
  type CfarBandsResult,
  type ExposureKnot,
} from '@/lib/test-mode/cfar-drawdown';
import {
  buildHedgedVarProfileWithCoverAt,
  buildStripHedgedVarProfile,
  stripTicketsForCcy,
  type HedgeTicket,
  type PreparedHedgeLeg,
  type PreparedHedgeProfile,
  type StripHedgedVarLeg,
} from '@/lib/test-mode/hedge-var';
import {
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
const DEFAULT_RATE_DIFF_VOL_BP_YR = 80;

/** Rate-differential vol converted to the same monthly-decimal convention as
 * monthlyVolForSetup, so it drops into the identical z·S·σ·√t formula. */
function rateDiffVolMonthly(ccy: string): number {
  const bpYr = RATE_DIFF_VOL_BP_YR[ccy] ?? DEFAULT_RATE_DIFF_VOL_BP_YR;
  return bpYr / 10000 / Math.sqrt(12);
}

/** Breakdown of where a combined CFaR figure came from, for transparency. */
export interface CfarRiskBreakdown {
  /** Peak spot-risk component alone (not-yet-dealt exposure + forecast uncertainty), USD M. */
  spotPeakUsdM: number;
  /** Peak swap-bridge risk component alone (dealt-but-not-settled), USD M. */
  swapPeakUsdM: number;
}

/**
 * Full CFaR bands combining THREE risk sources, replacing a single spot-vol
 * pass over the settlement gap:
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
 * The two dollar-risk components are computed independently (different vols
 * on different notionals) then combined in quadrature (RSS) at every point
 * in time — they're different risk factors, not perfectly correlated.
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
}): CfarBandsResult & { breakdown: CfarRiskBreakdown; hedged: boolean } {
  const { ccy, setup } = input;
  const T = input.tenureMonths > 0 ? input.tenureMonths : horizonMonths(setup.horizon);
  const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
  const sigmaFx = monthlyVolForSetup(setup);
  const monthlyFlowM =
    input.monthlyFlows.length > 0
      ? input.monthlyFlows.reduce((a, b) => a + b, 0) / input.monthlyFlows.length
      : 0;

  const { knots: tradeKnots } = residualKnotsForHedge(input);
  const { knots: settleKnots, hedged } = settlementResidualKnotsForHedge(input);

  const steps = Math.max(48, Math.min(192, Math.ceil(T * 8)));
  const dt = T > 0 ? T / steps : 0;
  const spotKnots: ExposureKnot[] = [];
  const swapKnots: ExposureKnot[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i * dt;
    const rTrade = exposureAtKnots(tradeKnots, t);
    const gSettle = exposureAtKnots(settleKnots, t);
    const dealtNotSettled = gSettle - rTrade;
    const sigmaE = forecastErrorStdForSetupM(monthlyFlowM, setup, input.monthlyFlows, t);
    // Only the UNDER-hedged direction (r_trade > 0, genuinely more exposure
    // than notional dealt) is real spot risk — a real, uncovered trade with
    // nothing to net against. The over-hedged direction (r_trade < 0, more
    // dealt than has accrued yet) is not: that notional is rate-locked, and
    // any mismatch between it and reality is a forecast question (already in
    // σ_E), not a spot-rate one. |r_trade| double-counted the over-hedge case
    // as if it were open spot exposure — it isn't.
    const underHedged = Math.max(0, rTrade);
    spotKnots.push({ t, e: Math.sqrt(underHedged * underHedged + sigmaE * sigmaE) });
    swapKnots.push({ t, e: Math.abs(dealtNotSettled) });
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
  const swapBands = computeCfarBands({
    knots: swapKnots,
    spotUsd,
    sigmaMonthly: rateDiffVolMonthly(ccy),
    confidencePct: setup.confidencePct,
    // Carry is already netted once in spotBands — don't double-count it here.
    steps,
  });

  const rss = (a: number, b: number) => Math.sqrt(a * a + b * b);
  const points: CfarBandPoint[] = spotBands.points.map((sp, i) => {
    const sw = swapBands.points[i]!;
    const p05 = -rss(sp.p05, sw.p05);
    const netP05 = p05 + sp.carryUsdM;
    return {
      t: sp.t,
      exposureLocalM: sp.exposureLocalM,
      carryUsdM: sp.carryUsdM,
      p05,
      p25: -rss(sp.p25, sw.p25),
      p50: 0,
      p75: rss(sp.p75, sw.p75),
      p95: rss(sp.p95, sw.p95),
      netP05,
      netP50: sp.carryUsdM,
    };
  });
  let criticalCashUsdM = 0;
  let netCriticalCashUsdM = 0;
  let peakMonth = 0;
  for (const p of points) {
    if (-p.p05 > criticalCashUsdM) criticalCashUsdM = -p.p05;
    if (-p.netP05 > netCriticalCashUsdM) {
      netCriticalCashUsdM = -p.netP05;
      peakMonth = p.t;
    }
  }
  return {
    points,
    openPathVarUsdM: criticalCashUsdM,
    criticalCashUsdM,
    netCriticalCashUsdM,
    peakMonth,
    kEmpirical: 1,
    hedged,
    breakdown: {
      spotPeakUsdM: spotBands.criticalCashUsdM,
      swapPeakUsdM: swapBands.criticalCashUsdM,
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
 * Net CFaR for tab headlines — delegates straight to
 * {@link computeHedgeCfarBands} (the same spot + swap-bridge + forecast-
 * uncertainty combination the tab body uses), so the tab-rail preview and
 * the tab body are the SAME calculation, not two parallel implementations
 * that can drift. "Cheap" only in the sense that it discards the per-t
 * fan and keeps just the peak.
 */
export function residualCfarClosedFormUsdM(
  input: ResidualHedgeInput & { carryUsdM?: number },
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
