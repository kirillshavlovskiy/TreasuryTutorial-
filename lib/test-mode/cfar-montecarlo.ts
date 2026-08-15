import type { CfarBandPoint, CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';

/**
 * Monte Carlo cash-ledger CFaR.
 *
 * Supersedes the parametric mismatch model (which applied FX as a closed-form
 * z·S₀·σ·√t shock on an open gap). That approach measured a MARK on a
 * mismatch; it could not express any event where cash actually moves, because
 * no rate was ever realized and no balance was ever kept. This engine
 * simulates a spot PATH and runs an actual two-account ledger (FCY + USD) on
 * it, so every real cash effect falls out of the accounting instead of
 * needing its own bolt-on term:
 *
 *   - forward settlement delivers notional FCY against notional·K USD, so
 *     settlement P&L CRYSTALLIZES (permanent) rather than being a mark that
 *     reverses on the next grid point;
 *   - an over-hedge forces a spot purchase to honour delivery, which is a
 *     different cash event from an under-hedge leaving FCY unconverted — the
 *     old |mismatch| treated the two as identical;
 *   - a negative balance accrues at a BORROW rate, not the deposit rate, so
 *     the drawdown side is priced at the rate you actually pay there;
 *   - flow dates jitter (a customer paying late), not just settlement dates.
 *
 * Because the spot path supplies the FX randomness, the confidence level is
 * applied exactly ONCE — as the cross-path percentile. The old engine scaled
 * every path by z AND then took the p95 across paths, reporting a joint
 * tail far beyond its stated confidence.
 *
 * HEADLINE METRIC. CFaR is the worst cumulative USD shortfall versus plan:
 *
 *   shortfall(t) = usdEquity_plan(t) − usdEquity_path(t)
 *                    − (deliveredOp_plan(t) − deliveredOp_path(t))·S(t)
 *   CFaR         = percentile_pConf( max over t of shortfall(t) )
 *
 * where usdEquity(t) = usdBalance(t) + fcyBalance(t)·S(t) — the total
 * USD-terms value of the treasury position — and the PLAN is the same ledger
 * with forecast flows on forecast dates, planned settlement dates, and spot
 * on the forward curve E[S(t)]. Running-max per path, then percentiled, so
 * the headline is the distribution of each path's own worst moment.
 *
 * THIS IS A COST, NOT A BALANCE. The deliveredOp term is what makes that
 * true. Comparing two ledgers at the same instant would otherwise score a
 * receivable that has not landed yet as a total loss of its face value: a
 * customer paying one day late on a 1.2M EUR invoice came out as ~$1.3M of
 * CFaR, and 1, 5 and 10 days of jitter all returned the same number because
 * what mattered was only whether the flow had crossed a grid point. Netting
 * off the principal each ledger is still owed leaves exactly what a
 * displacement actually costs — the FX move over the gap, the forced unwind,
 * and the financing — which is the "bridge-cost VaR, not the funding gap
 * notional" the panel reports. The same applies to a flow that lands light
 * against a hedge: the charge is the unwind, not the missing revenue.
 *
 * GROSS vs NET. Gross is the drawdown above, with interest accrual switched
 * off on both plan and path — pure FX, flow-size and settlement-timing
 * effects. NET IS THE USD CASH TO RESERVE against it:
 *
 *   buffer_k(t)  = max(0, carry_k(t))               ← carry only ever helps
 *   net_k(t)     = buffer_k(t) − gross_k(t)         ← plotted, signed
 *   reserve_k(t) = max over s ≤ t of max(0, −net_k(s))
 *   NET CFaR     = percentile_pConf( reserve_k(t) )
 *
 * — the amount that, set aside up front, would have carried this book through
 * every moment to date at the chosen confidence. Zero means carry has stayed
 * ahead of the drawdown throughout and nothing needs setting aside.
 *
 * The plotted line nets against the RUNNING MAX drawdown, the same series the
 * gross band shows, so net is literally gross plus carry. Netting the
 * point-in-time drawdown instead gives a sawtooth: gross is monotone by
 * construction while the live shortfall swings with every flow, so the two
 * would be different objects sharing an axis and the gap between them would
 * mean nothing.
 *
 * Two things still make this rather than the tempting shortcut of subtracting
 * the two totals.
 *
 * PAIRED IN TIME. Both terms are read at the same s. Carry accrues gradually
 * while a drawdown can land at any moment, so a book three months in may hold
 * $8K of carry against a $309K excursion. Netting totals would fund that
 * excursion out of money that only arrives in month eleven.
 *
 * PAIRED PER PATH. carry_k is this path's OWN accrual — its balances, its
 * random-walked rate differential, its borrow spread wherever an account went
 * overdrawn — so the percentile lands on paths where the drawdown and the
 * carry both went badly, which is the whole point of asking for a reserve at
 * a confidence level. Averaging carry across paths first would quietly assume
 * the buffer shows up on schedule in exactly the scenarios it does not. Only
 * {@link McCfarInput.hedgeCarryScheduleUsdM} is deterministic, and correctly
 * so: a booked forward's points are contractual.
 *
 * CARRY IS FLOORED AT ZERO, and the asymmetry is deliberate. Carry the book
 * earns is cash that turns up to absorb a drawdown, so it is credited in
 * full. Carry the book PAYS — short a higher-rate currency — is known at
 * trade time and has zero variance, so charging it here would report a
 * budgeted cost as a confidence-level reserve, and a book with no FX vol, no
 * forecast error and no rate vol at all would still demand cash. It is P&L,
 * not risk; it shows up in carryMeanUsdM and on the carry curve instead. The
 * flooring is also what guarantees NET ≤ GROSS.
 *
 * Note what this deliberately excludes. The cost of financing a gap is
 * managed as liquidity rather than charged here — a book that is short USD
 * and long EUR, or long USD and short PLN, is funded from the buffer, not
 * penalised in CFaR.
 *
 * THE STRUCTURAL GAP IS NOT A CFaR INPUT. The settlement schedule not lining
 * up with the forecast accrual pattern is a planned, fully known cash-timing
 * fact — its SIZE is a decision, not a random variable. Revaluing that known
 * balance at a simulated spot (plan − ledger A) is FX VaR by another name:
 * it uses the core funding gap as a proxy for market vols. Headline CFaR
 * does not do that. Gross is ledger A − ledger C with operating principal
 * netted — size and timing mismatches only, both marked on the SAME spot
 * path, so the planned gap cancels. A squared delivery shortfall keeps
 * amt·(S−K), the unwind, not the open-book FX mark. Ledger A is still run:
 * it is the counterfactual the other two nest on, and plan − A is kept as a
 * diagnostic (structuralFxRisk) so the excluded FX-vol proxy stays visible.
 * A purely structural book (no forecast error, no date jitter) therefore has
 * zero Gross and Net CFaR at any σ. See the "structural gap is a planned
 * SIZE" block in the tests.
 *
 * ATTRIBUTION is sequential, not RSS. Three ledgers per path, each adding one
 * stochastic driver on top of the last:
 *   A  plan flows, planned settlement, STOCHASTIC spot  → structural
 *   B  realized flow AMOUNTS on forecast dates          → size     = B − A
 *   C  realized amounts on jittered dates, jittered settlement → timing = C − B
 * so size + timing = headline CFaR exactly. Structural (plan − A) is
 * diagnostic only — not in the headline. The old RSS combination
 * assumed the three legs were independent risk factors when in fact they
 * share a single underlying factor (spot), and it needed different √t
 * conventions per leg to stay plausible. Nesting the counterfactuals removes
 * both problems: there is no independence assumption and no time exponent to
 * choose, because elapsed-time exposure is whatever the simulated path did.
 *
 * NOT YET MODELLED (each needs an input the book does not currently store):
 * variation margin on the hedge MTM, roll cost when exposure outlives the
 * hedge, bid-ask on conversions, and discrete receivable default.
 */

export interface McHedgeSettleLeg {
  /** Month this leg's notional is contracted to settle (deliver cash). */
  settleMonths: number;
  /** Signed notional delivered at settlement (local M; matches exposure sign). */
  notionalLocalM: number;
  /**
   * Contracted forward rate, USD per 1 unit of FCY. Booked tickets do not
   * carry a strike yet ({@link HedgeTicket} stores notional and tenor only),
   * so when omitted this falls back to the CIP-implied forward
   * S₀·exp(Δr·settleMonths/12) — the fair rate given today's spot and rate
   * differential. Pass the real traded rate once it is captured at book time;
   * the difference is a pure level shift in settlement proceeds.
   */
  strikeUsd?: number;
}

export interface McCfarInput {
  stockM: number;
  /** Gross monthly inflows (≥0, local M), length = tenureMonths. */
  monthlyInflows: readonly number[];
  /** Gross monthly outflows (≥0, local M), length = tenureMonths. */
  monthlyOutflows: readonly number[];
  tenureMonths: number;
  /** Spot at T0, USD per 1 unit of FCY. */
  spotUsd: number;
  /** Fractional monthly FX vol (e.g. 0.025 = 2.5%/mo) — the GBM σ. */
  sigmaFxMonthly: number;
  /** 90 / 95 / 99 — the cross-path percentile. Applied once (see file header). */
  confidencePct: number;
  /** Relative 1m forecast uncertainty on flow AMOUNTS (0..1), applied independently to each month's in/out draw. */
  forecastUncertainty1m: number;
  /** PLANNED hedge settlement schedule — empty for an open/unhedged book. */
  hedgeSettleSchedule: readonly McHedgeSettleLeg[];
  /** Std dev of ACTUAL vs PLANNED hedge settlement date, calendar days.
   * Default 2 (a T+2-style operational spread). 0 = settle exactly on plan. */
  settlementJitterDays?: number;
  /** Std dev of ACTUAL vs FORECAST operating flow date, calendar days —
   * customers paying late, payment runs slipping. Default 5. 0 = flows land
   * exactly on their forecast date. Usually a larger cash-timing driver than
   * settlementJitterDays, which only moves the bank's leg. */
  flowJitterDays?: number;
  /** USD deposit rate, % p.a. */
  usdRatePctPa: number;
  /** FCY deposit rate, % p.a. */
  fcyRatePctPa: number;
  /** Spread added to the deposit rate when an account is overdrawn, % p.a.
   * Default 2.5. This is the asymmetry the drawdown side actually pays. */
  borrowSpreadPctPa?: number;
  /** Annualized rate vol (%/yr), random-walked across the horizon
   * (persistent), not redrawn i.i.d. each month. Drives two independent
   * shocks at this same size: one on the USD−FCY DIFFERENTIAL, which prices
   * the carry on the open mismatch, and one on the LEVEL of both curves
   * together, which prices the interest on whatever overdraft or deposit the
   * book is actually running. Neither touches gross CFaR, which is measured
   * with interest accrual off — they move carry, and so the reserve net of it. */
  rateVolPctPa: number;
  /** USD cash on hand at T0 (USD M). Default 0. */
  openingUsdCashM?: number;
  /**
   * Real hedge carry on the FULL notional — forward points plus cash — as a
   * CUMULATIVE USD M schedule indexed by month (element k = carry banked by
   * month k+1). Optional; omitted means the ledger's own interest is the only
   * carry.
   *
   * This is the buffer the net line is measured against. It has to come from
   * the caller because it is priced off the traded market rates, which the
   * simulation does not see: the model strikes its forwards at the CIP rate,
   * so it reproduces the shape of the carry but not the desk's actual traded
   * level.
   */
  hedgeCarryScheduleUsdM?: readonly number[];
  /** Monte Carlo path count. Default 1000 — the p95 headline moves under 1%
   * between 600 and 1500 paths, so this trades a negligible amount of
   * stability for a view that renders several currencies at once. */
  paths?: number;
  /** Seed for reproducibility (same inputs → same output on every render). */
  seed?: number;
}

/**
 * One time-slice of the decomposed drivers — each computed independently per
 * point (not running-maxed), so the actual per-point behaviour of each driver
 * is visible on its own. The main chart's curve is the running max of
 * rawGrossUsdM / rawNetUsdM.
 */
export interface McCfarComponentPoint {
  t: number;
  /** Mean TOTAL FCY balance across paths (local M, signed) — what is actually
   * sitting in the currency account after flows and hedge deliveries. Equals
   * structuralGapLocalM + sizeMismatchLocalM + timingMismatchLocalM exactly
   * (means are additive and the attribution is nested, not RSS). */
  mismatchLocalM: number;
  mismatchP05: number;
  mismatchP95: number;
  /** STRUCTURAL gap — ledger A's FCY balance, i.e. e_forecast(t) −
   * H_settled_PLANNED(t): the settlement schedule not lining up with the
   * forecast accrual pattern, including the intra-month outflow-before-inflow
   * sawtooth. Reported as a single value with no band, because its SIZE is
   * planned and known. (It is the mean of ledger A rather than of the plan
   * ledger so the three parts stay exactly additive — the two differ only by
   * interest accrued at the path's random-walked rate, which is immaterial in
 * level but would otherwise leave a residual.) Its USD cash impact
 * (structuralFxRiskUsdM) is the excluded FX-vol proxy — not in headline CFaR. */
  structuralGapLocalM: number;
  /** TIMING — the incremental FCY balance from jittered flow and settlement
   * DATES (ledger C − ledger B), mean and p05/p95 across paths. */
  timingMismatchLocalM: number;
  timingMismatchP05: number;
  timingMismatchP95: number;
  /** SIZE — the incremental FCY balance from realized flow AMOUNTS differing
   * from forecast (ledger B − ledger A), mean and p05/p95 across paths. */
  sizeMismatchLocalM: number;
  sizeMismatchP05: number;
  sizeMismatchP95: number;
  /** Raw (non-running-max) point-in-time gross USD shortfall of ledger C
   * vs ledger A at the setup confidence — size + timing only. Equals
   * sizeFxRiskUsdM + timingFxRiskUsdM in the mean; the percentiles of the
   * parts do not sum, since each is percentiled separately. */
  rawGrossUsdM: number;
  /** USD cash impact of holding the STRUCTURAL gap through a realized spot
   * path (ledger A vs plan). Diagnostic only — the FX-vol proxy on a known
   * funding gap. Not in headline Gross / Net CFaR. Identically 0 when
   * sigmaFxMonthly is 0; rises with FX vol. Computed on GROSS equity. */
  structuralFxRiskUsdM: number;
  /** Incremental conversion P&L of flow AMOUNTS differing from forecast
   * (ledger B − ledger A) — unwind of a delivery shortfall, not an FX mark. */
  sizeFxRiskUsdM: number;
  /** Incremental USD cash impact of flow and settlement DATES differing from
   * plan (ledger C − ledger B). Unlike the previous engine's √jitterMonths
   * proxy this is the ledger's own answer: cash converted at the rate
   * prevailing on the day it actually moved. */
  timingFxRiskUsdM: number;
  /** Carry less the running-max drawdown at the setup confidence, netted PER
   * PATH before percentiling. Positive means carry covers the worst drawdown
   * so far even on an adverse path. Same quantity the main chart's net curve
   * plots, which is why it is gross plus carry rather than a separate shape. */
  rawNetUsdM: number;
  /** Running max of the uncovered part of the above, floored at zero — the
   * USD reserve this point implies. Ratchets by construction; the last
   * element is {@link McCfarDiagnostics.netCriticalCashUsdM}. */
  reserveUsdM: number;
  /** MEAN across paths of everything banked to this point (USD M, + earn) —
   * each path's own FCY and USD interest, at the borrow rate wherever an
   * account is overdrawn, plus the traded hedge carry from
   * {@link McCfarInput.hedgeCarryScheduleUsdM}. Shown as a mean with
   * carryStdUsdM as its spread; the reserve itself uses each path's own
   * draw rather than this average. */
  carryMeanUsdM: number;
  /** Std dev of cumulative interest across paths to this point (USD M). */
  carryStdUsdM: number;
  /** Mean cumulative cost of FORCED spot purchases to honour delivery when
   * the FCY account was short at a settlement (USD M, ≥0). This is the
   * over-hedge crystallization the parametric engine could not express: a
   * permanent, realized cash cost, not a mark. */
  squaringCostUsdM: number;
  /** p95 of the same — the tail of forced-purchase cost. */
  squaringCostP95UsdM: number;
  /** Cash injection needed to hold every account non-negative to this point,
   * at the setup confidence (USD M, ≥0, running max along each path). The
   * liquidity view: unlike the cost lines above it DOES carry the full
   * principal of a flow that has not arrived yet, because that is exactly the
   * hole you have to fund while you wait. */
  bridgeNeedUsdM: number;
  /** Unplanned USD moved to hold fact on plan to this point, at the setup
   * confidence (USD M, ≥0, running max along each path). Carries the full
   * principal of the gap, and unlike the cost lines it survives σ=0. */
  unplannedUsdFundingUsdM: number;
  /** The plan ledger's own funding need at this point — the deterministic
   * baseline the confidence band is measured above. */
  planBridgeNeedUsdM: number;
}

/** Diagnostics beyond the shared CfarBandsResult shape. */
export interface McCfarDiagnostics {
  carryMeanUsdM: number;
  carryStdUsdM: number;
  paths: number;
  gridPoints: number;
  /** Mean total cost over the horizon of forced FCY purchases at settlement. */
  squaringCostMeanUsdM: number;
  /**
   * Largest cash injection the book ever needs, USD M, at the setup
   * confidence — the LIQUIDITY companion to CFaR rather than a cost.
   *
   * CFaR deliberately answers ~0 for a receivable that is merely late, because
   * nothing is lost by waiting. But you still have to fund the wait, and that
   * is a different and equally real question. This is the peak of
   * max(0, −usdBalance) + max(0, −fcyBalance)·S(t) along each path, taken at
   * pConf across paths: the biggest overdraft you should be sized to carry,
   * principal included.
   */
  peakBridgeFundingUsdM: number;
  /** The PLAN's own peak funding need — deterministic, so the difference
   * against peakBridgeFundingUsdM is the part that is actually at risk. */
  planPeakBridgeFundingUsdM: number;
  /**
   * Peak UNPLANNED USD the desk has to move to keep fact on plan, USD M, at
   * the setup confidence — the stochastic funding requirement.
   *
   * Measured against plan rather than against zero, so a payer book's planned
   * overdraft is excluded and only the deviation counts. This is the number
   * that stays alive when FX vol is switched off: a forecast miss still leaves
   * currency to buy, and zero vol only means you know the price of it up
   * front. CFaR and this are complements on the same gap — CFaR is what the
   * mismatch costs, this is what it takes to carry.
   */
  peakUnplannedUsdFundingUsdM: number;
  components: McCfarComponentPoint[];
}

/** Deterministic PRNG (mulberry32) — reproducible across renders for the same seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Standard normal draw via Box-Muller, consuming two uniforms from rng. */
function nextGaussian(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Quantile of an ALREADY-SORTED sequence via linear interpolation. */
function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * In-place Hoare selection: partially orders buf[0..n) so buf[k] holds the
 * k-th smallest value. O(n) average against O(n log n) for a full sort, which
 * matters because most series here are read at a single quantile and the
 * percentile pass runs once per grid point per series.
 */
function selectKth(buf: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = buf[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (buf[i]! < pivot) i += 1;
      while (buf[j]! > pivot) j -= 1;
      if (i <= j) {
        const tmp = buf[i]!;
        buf[i] = buf[j]!;
        buf[j] = tmp;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return buf[k]!;
  }
  return buf[k]!;
}

/** Single interpolated quantile via selection, destroying buf's order. */
function quantileSelect(buf: Float64Array, n: number, p: number): number {
  if (n === 0) return 0;
  if (n === 1) return buf[0]!;
  const idx = Math.min(1, Math.max(0, p)) * (n - 1);
  const lo = Math.floor(idx);
  const frac = idx - lo;
  const a = selectKth(buf, n, lo);
  if (frac <= 1e-12) return a;
  // Everything above index lo is ≥ a after selection, so the next order
  // statistic is just the smallest of that tail.
  let b = Infinity;
  for (let i = lo + 1; i < n; i += 1) {
    if (buf[i]! < b) b = buf[i]!;
  }
  return a * (1 - frac) + b * frac;
}

/** Sub-steps inserted between each pair of consecutive event checkpoints, for
 * chart resolution and so the simulated spot path has somewhere to move
 * between cash events. */
const CHART_SUBSTEPS_PER_SEGMENT = 3;

/** Sorted, deduplicated grid of every point-in-time worth checking. */
function buildTimeGrid(tenureMonths: number, hedgeSettleSchedule: readonly McHedgeSettleLeg[]): number[] {
  const T = Math.max(1, Math.round(tenureMonths));
  const events = new Set<number>([0]);
  for (let m = 1; m <= T; m += 1) {
    // Intra-month checkpoints. Operating flows accrue continuously across the
    // month (see spreadFlow), so these no longer carry a bullet; they keep the
    // grid dense enough to resolve the ramps and to give spot somewhere to
    // move between hedge settlements.
    events.add(m - OUTFLOW_TAIL_MONTHS);
    events.add(m);
  }
  for (const leg of hedgeSettleSchedule) {
    if (leg.settleMonths > 0 && leg.settleMonths <= T) events.add(leg.settleMonths);
  }
  const sortedEvents = Array.from(events).sort((a, b) => a - b);
  const points = new Set<number>(sortedEvents);
  for (let i = 0; i < sortedEvents.length - 1; i += 1) {
    const a = sortedEvents[i]!;
    const b = sortedEvents[i + 1]!;
    const span = b - a;
    if (span <= 1e-9) continue;
    for (let s = 1; s < CHART_SUBSTEPS_PER_SEGMENT; s += 1) {
      points.add(a + (span * s) / CHART_SUBSTEPS_PER_SEGMENT);
    }
  }
  return Array.from(points).sort((a, b) => a - b);
}

/** First grid index at or after t — events are applied on the next checkpoint,
 * which is at most one sub-step (~0.15 months) late. */
function gridIndexAtOrAfter(grid: readonly number[], t: number): number {
  let lo = 0;
  let hi = grid.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid]! >= t - 1e-9) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Output buffers for one ledger walk. Reused across paths — a 1500-path run
 * would otherwise allocate tens of thousands of short-lived typed arrays and
 * spend most of its time in GC.
 */
interface LedgerRun {
  /** usdBalance + fcyBalance·S(t) with interest accrual OFF (USD M). */
  grossEquity: Float64Array;
  /** usdBalance + fcyBalance·S(t) with interest accrual ON (USD M). */
  netEquity: Float64Array;
  /** FCY account balance with interest ON (local M). */
  fcyBalance: Float64Array;
  /** Cumulative interest earned/paid to t (USD M, + earn) = net − gross. */
  interest: Float64Array;
  /** Cumulative USD cost of forced spot purchases at settlement (USD M, ≥0). */
  squaringCost: Float64Array;
  /**
   * Cumulative OPERATING FCY flows landed by t (local M, signed) — hedge
   * deliveries excluded, since those are conversions rather than external
   * cash. Used to net the principal of a merely-displaced flow out of the
   * drawdown: a receivable that is four days late has not been lost, so the
   * comparison against plan has to credit the path with the amount it is
   * still owed. See the deliveredGap term in the aggregation loop.
   */
  deliveredOp: Float64Array;
  /**
   * Cumulative FCY amount squared on the GROSS ledger by t (local M, ≥0) —
   * forced spot purchases that honoured a delivery. Incremental squares
   * add amt·(S−K) back onto the principal-netted drawdown so a shortfall
   * keeps its unwind.
   */
  squaredLocal: Float64Array;
  /**
   * Cash injection required at t to hold both accounts non-negative (USD M,
   * ≥0), from the interest-bearing balances. Not a running max — the
   * aggregation loop takes that per path.
   */
  bridgeNeed: Float64Array;
}

function makeLedgerRun(G: number): LedgerRun {
  return {
    grossEquity: new Float64Array(G),
    netEquity: new Float64Array(G),
    fcyBalance: new Float64Array(G),
    interest: new Float64Array(G),
    squaringCost: new Float64Array(G),
    deliveredOp: new Float64Array(G),
    squaredLocal: new Float64Array(G),
    bridgeNeed: new Float64Array(G),
  };
}

/**
 * Walk the two-account ledger across the grid.
 *
 * FCY account holds operating balances and delivers into forwards; USD
 * account receives settlement proceeds. Whenever the FCY account ends up on
 * the wrong side of zero relative to the book's natural direction — you
 * cannot be short the currency you are supposed to be long — it is squared at
 * the prevailing spot, which is exactly the forced purchase an over-hedge
 * causes and the moment settlement P&L becomes real cash.
 */
function runLedger(
  out: LedgerRun,
  params: {
    grid: readonly number[];
    /** Net FCY change landing on each grid point (local M). */
    fcyDeltaAt: Float64Array;
    /** Net USD change landing on each grid point (USD M) — settlements only. */
    usdDeltaAt: Float64Array;
    /** Operating-flow share of fcyDeltaAt (local M) — no hedge deliveries. */
    opDeltaAt: Float64Array;
    spotPath: Float64Array;
    /** FCY deposit rate at each grid point, % p.a. */
    fcyRatePath: Float64Array;
    /** USD deposit rate at each grid point, % p.a. */
    usdRatePath: Float64Array;
    borrowSpreadPctPa: number;
    openingUsdCashM: number;
    openingFcyM: number;
    /** +1 for a net-receiver book, −1 for a net-payer book. */
    expSign: number;
  },
): void {
  const {
    grid, fcyDeltaAt, usdDeltaAt, opDeltaAt, spotPath, fcyRatePath,
    usdRatePath, borrowSpreadPctPa, openingUsdCashM, openingFcyM, expSign,
  } = params;
  const G = grid.length;
  const {
    grossEquity, netEquity, fcyBalance, interest, squaringCost, deliveredOp,
    squaredLocal, bridgeNeed,
  } = out;

  let fcyNet = openingFcyM;
  let usdNet = openingUsdCashM;
  let fcyGross = openingFcyM;
  let usdGross = openingUsdCashM;
  let squaring = 0;
  let delivered = 0;
  let squaredAmt = 0;
  let tPrev = grid[0] ?? 0;

  for (let gi = 0; gi < G; gi += 1) {
    const t = grid[gi]!;
    const dt = t - tPrev;
    const spot = spotPath[gi]!;

    // Interest accrues on whatever was on the books over the elapsed step,
    // at the borrow rate on an overdrawn account (net ledger only).
    if (dt > 0) {
      const fcyRate = fcyRatePath[gi]!;
      const usdRate = usdRatePath[gi]!;
      const fcyEff = fcyNet >= 0 ? fcyRate : fcyRate + borrowSpreadPctPa;
      const usdEff = usdNet >= 0 ? usdRate : usdRate + borrowSpreadPctPa;
      fcyNet += (fcyNet * (fcyEff / 100) * dt) / 12;
      usdNet += (usdNet * (usdEff / 100) * dt) / 12;
    }

    const fcyDelta = fcyDeltaAt[gi]!;
    const usdDelta = usdDeltaAt[gi]!;
    fcyNet += fcyDelta;
    usdNet += usdDelta;
    fcyGross += fcyDelta;
    usdGross += usdDelta;
    delivered += opDeltaAt[gi]!;

    // Square a wrong-signed FCY balance at spot — the forced purchase that
    // honours delivery when the currency account is short. Equity-neutral at
    // the instant it happens; what makes it matter is that the position is
    // now realized in USD and no longer moves with the rate.
    if (fcyNet * expSign < 0) {
      squaring += Math.abs(fcyNet) * spot;
      usdNet += fcyNet * spot;
      fcyNet = 0;
    }
    if (fcyGross * expSign < 0) {
      squaredAmt += Math.abs(fcyGross);
      usdGross += fcyGross * spot;
      fcyGross = 0;
    }

    const g = usdGross + fcyGross * spot;
    const n = usdNet + fcyNet * spot;
    grossEquity[gi] = g;
    netEquity[gi] = n;
    fcyBalance[gi] = fcyNet;
    interest[gi] = n - g;
    squaringCost[gi] = squaring;
    deliveredOp[gi] = delivered;
    squaredLocal[gi] = squaredAmt;
    // Either account can be the one short of cash: a payer book is meant to
    // run its FCY account negative, and squaring only ever clears a
    // wrong-signed balance, so both sides have to be checked.
    bridgeNeed[gi] =
      Math.max(0, -usdNet) + Math.max(0, -fcyNet) * spot;
    tPrev = t;
  }
}

/**
 * Accumulate one realization's cash events onto the grid. Deltas are bucketed
 * per grid point rather than kept as a sorted event list — the ledger only
 * ever reads them in grid order, so bucketing removes both the per-event
 * object and the sort from the inner loop.
 */
/** A month's outflows finish accruing this far before month-end, so payments
 * still lead receipts and the book funds them before collection completes. */
const OUTFLOW_TAIL_MONTHS = 0.6;

/**
 * Accrue `amount` continuously across (t0, t1], splitting it over the grid
 * segments it spans in proportion to the time each covers. Operating cash
 * arrives through a month rather than in one lump at month-end, so the balance
 * ramps instead of stepping. Mass is conserved exactly: callers must clamp the
 * window inside the grid, which guarantees the segments tile it completely.
 */
function spreadFlow(
  fcyDeltaAt: Float64Array,
  opDeltaAt: Float64Array,
  grid: readonly number[],
  t0: number,
  t1: number,
  amount: number,
): void {
  const span = t1 - t0;
  if (span <= 1e-9) {
    const gi = gridIndexAtOrAfter(grid, t1);
    fcyDeltaAt[gi]! += amount;
    opDeltaAt[gi]! += amount;
    return;
  }
  for (
    let gi = Math.max(1, gridIndexAtOrAfter(grid, t0));
    gi < grid.length && grid[gi - 1]! < t1;
    gi += 1
  ) {
    const a = Math.max(t0, grid[gi - 1]!);
    const b = Math.min(t1, grid[gi]!);
    if (b <= a) continue;
    const part = (amount * (b - a)) / span;
    fcyDeltaAt[gi]! += part;
    opDeltaAt[gi]! += part;
  }
}

function accumulateEvents(params: {
  fcyDeltaAt: Float64Array;
  usdDeltaAt: Float64Array;
  /** Operating flows only, so the ledger can tell external cash from hedge
   * conversions when netting displaced principal out of the drawdown. */
  opDeltaAt: Float64Array;
  grid: readonly number[];
  tenureMonths: number;
  inflows: ArrayLike<number>;
  outflows: ArrayLike<number>;
  /** Per-month date offsets in months; index 0 unused. */
  inflowShift: ArrayLike<number>;
  outflowShift: ArrayLike<number>;
  schedule: readonly McHedgeSettleLeg[];
  settleShift: ArrayLike<number>;
  strikes: readonly number[];
}): void {
  const {
    fcyDeltaAt, usdDeltaAt, opDeltaAt, grid, tenureMonths: T,
    inflows, outflows, inflowShift, outflowShift, schedule, settleShift, strikes,
  } = params;
  fcyDeltaAt.fill(0);
  usdDeltaAt.fill(0);
  opDeltaAt.fill(0);
  const clamp = (t: number) => Math.min(T, Math.max(0, t));
  for (let m = 1; m <= T; m += 1) {
    const outAmt = outflows[m - 1] ?? 0;
    if (Math.abs(outAmt) > 1e-12) {
      const shift = outflowShift[m] ?? 0;
      spreadFlow(
        fcyDeltaAt, opDeltaAt, grid,
        clamp(m - 1 + shift), clamp(m - OUTFLOW_TAIL_MONTHS + shift), -outAmt,
      );
    }
    const inAmt = inflows[m - 1] ?? 0;
    if (Math.abs(inAmt) > 1e-12) {
      const shift = inflowShift[m] ?? 0;
      spreadFlow(
        fcyDeltaAt, opDeltaAt, grid,
        clamp(m - 1 + shift), clamp(m + shift), inAmt,
      );
    }
  }
  for (let i = 0; i < schedule.length; i += 1) {
    const leg = schedule[i]!;
    const gi = gridIndexAtOrAfter(grid, clamp(leg.settleMonths + (settleShift[i] ?? 0)));
    fcyDeltaAt[gi]! -= leg.notionalLocalM;
    usdDeltaAt[gi]! += leg.notionalLocalM * strikes[i]!;
  }
}

/**
 * Monte Carlo cash-ledger CFaR — simulates a spot path plus stochastic flow
 * amounts, flow dates, settlement dates and rate differential, runs a real
 * two-account ledger on each path, and returns the distribution of the worst
 * USD shortfall versus plan. Drop-in {@link CfarBandsResult}.
 */
export function computeMonteCarloMismatchCfar(
  input: McCfarInput,
): CfarBandsResult & McCfarDiagnostics {
  const T = Math.max(1, Math.round(input.tenureMonths));
  const grid = buildTimeGrid(T, input.hedgeSettleSchedule);
  const G = grid.length;
  const paths = Math.max(200, Math.min(4000, Math.round(input.paths ?? 1000)));
  const rng = mulberry32(input.seed ?? 0x5f3759df);
  const u = Math.max(0, input.forecastUncertainty1m);
  const pConf = input.confidencePct / 100;
  const borrowSpread = input.borrowSpreadPctPa ?? 2.5;
  const openingUsd = input.openingUsdCashM ?? 0;
  const settleJitterMonths = (input.settlementJitterDays ?? 2) / 30;
  const flowJitterMonths = (input.flowJitterDays ?? 5) / 30;
  const sigma = Math.max(0, input.sigmaFxMonthly);
  // Monthly CIP drift: the forward curve implied by the rate differential, so
  // a forward struck at the CIP rate has zero expected P&L and the model
  // never manufactures a free gain from being hedged or unhedged.
  const driftMonthly = (input.usdRatePctPa - input.fcyRatePctPa) / 100 / 12;
  // Random-walk step for the rate differential, scaled so the cumulative
  // shock over 12 months has std rateVolPctPa.
  const rateStepVol = Math.max(0, input.rateVolPctPa) / Math.sqrt(12);

  const noShift = new Array(T + 1).fill(0) as number[];
  const noLegShift = new Array(input.hedgeSettleSchedule.length).fill(0) as number[];
  // CIP-implied forward per leg, used whenever the ticket has no traded rate.
  const strikes = input.hedgeSettleSchedule.map(
    leg => leg.strikeUsd ?? input.spotUsd * Math.exp(driftMonthly * leg.settleMonths),
  );
  // Notional-weighted strike: the residual after netting a squared amount is
  // amt·(S−K), the unwind, not amt·S (the purchase principal).
  let strikeW = 0;
  let strikeN = 0;
  for (let i = 0; i < strikes.length; i += 1) {
    const n = Math.abs(input.hedgeSettleSchedule[i]!.notionalLocalM);
    strikeW += n * strikes[i]!;
    strikeN += n;
  }
  const avgStrike = strikeN > 0 ? strikeW / strikeN : input.spotUsd;
  /** Size + timing of `worse` vs `better` on the same spot path. Op principal
   * is netted at live spot (a late/light flow is still owed). Incremental
   * squares add back amt·(S−K) so a delivery shortfall keeps its unwind
   * instead of netting to zero. */
  const mismatchDraw = (
    better: LedgerRun,
    worse: LedgerRun,
    gi: number,
    spot: number,
  ): number => {
    const dOp = better.deliveredOp[gi]! - worse.deliveredOp[gi]!;
    const dSq = worse.squaredLocal[gi]! - better.squaredLocal[gi]!;
    return (
      better.grossEquity[gi]! - worse.grossEquity[gi]!
      - dOp * spot
      + dSq * (spot - avgStrike)
    );
  };

  // Book direction — the side the FCY account is supposed to be on. Taken
  // from the largest-magnitude planned exposure so a book that briefly
  // crosses zero doesn't flip the squaring rule point to point.
  let planRunning = input.stockM;
  let peakAbs = Math.abs(input.stockM);
  let expSign = input.stockM >= 0 ? 1 : -1;
  for (let m = 1; m <= T; m += 1) {
    planRunning -= input.monthlyOutflows[m - 1] ?? 0;
    planRunning += input.monthlyInflows[m - 1] ?? 0;
    if (Math.abs(planRunning) > peakAbs) {
      peakAbs = Math.abs(planRunning);
      expSign = planRunning >= 0 ? 1 : -1;
    }
  }

  // PLAN: forecast flows on forecast dates, planned settlement, spot on the
  // forward curve E[S(t)], base rates. The reference every path is measured
  // against.
  const planSpot = Float64Array.from(grid, t => input.spotUsd * Math.exp(driftMonthly * t));
  const planRates = new Float64Array(G).fill(input.fcyRatePctPa);
  const planUsdRates = new Float64Array(G).fill(input.usdRatePctPa);
  const planFcyDelta = new Float64Array(G);
  const planUsdDelta = new Float64Array(G);
  const planOpDelta = new Float64Array(G);
  accumulateEvents({
    fcyDeltaAt: planFcyDelta,
    usdDeltaAt: planUsdDelta,
    opDeltaAt: planOpDelta,
    grid,
    tenureMonths: T,
    inflows: input.monthlyInflows,
    outflows: input.monthlyOutflows,
    inflowShift: noShift,
    outflowShift: noShift,
    schedule: input.hedgeSettleSchedule,
    settleShift: noLegShift,
    strikes,
  });
  const ledgerCommon = {
    grid,
    borrowSpreadPctPa: borrowSpread,
    openingUsdCashM: openingUsd,
    openingFcyM: input.stockM,
    expSign,
  };
  const plan = makeLedgerRun(G);
  runLedger(plan, {
    ...ledgerCommon,
    fcyDeltaAt: planFcyDelta,
    usdDeltaAt: planUsdDelta,
    opDeltaAt: planOpDelta,
    spotPath: planSpot,
    fcyRatePath: planRates,
    usdRatePath: planUsdRates,
  });
  // Deterministic funding baseline: what the book needs even if nothing goes
  // wrong. Running max for the same reason the path series is.
  const planBridgeRunningMax = new Float64Array(G);
  {
    let worst = 0;
    for (let gi = 0; gi < G; gi += 1) {
      if (plan.bridgeNeed[gi]! > worst) worst = plan.bridgeNeed[gi]!;
      planBridgeRunningMax[gi] = worst;
    }
  }

  // Traded hedge carry interpolated onto the grid. The caller's schedule is
  // cumulative and monthly (element k = carry banked by month k+1), so this
  // reads off a piecewise-linear accrual between month ends.
  const hedgeCarryAt = new Float64Array(G);
  {
    const sched = input.hedgeCarryScheduleUsdM;
    if (sched && sched.length > 0) {
      for (let gi = 0; gi < G; gi += 1) {
        const t = grid[gi]!;
        if (t <= 0) continue;
        if (t >= sched.length) {
          hedgeCarryAt[gi] = sched[sched.length - 1]!;
          continue;
        }
        const k = Math.floor(t);
        const lo = k === 0 ? 0 : sched[k - 1]!;
        const hi = sched[k]!;
        hedgeCarryAt[gi] = lo + (hi - lo) * (t - k);
      }
    }
  }

  // Per-path series stored flat as [gridIndex * paths + pathIndex] — one
  // allocation per series instead of one per path, and grid-point-major so
  // the aggregation pass reads each column as a contiguous block. The
  // percentile pass touches every series at every grid point, so that
  // ordering is what keeps it cache-friendly.
  const series = () => new Float64Array(paths * G);
  const sGross = series();
  const sNet = series();
  const sNetRaw = series();
  const sGrossRaw = series();
  const sFcy = series();
  const sStructLocal = series();
  const sSize = series();
  const sTiming = series();
  const sStructUsd = series();
  const sSizeUsd = series();
  const sTimingUsd = series();
  const sCarry = series();
  const sSquaring = series();
  const sBridge = series();
  const sFunding = series();
  const totalCarry = new Float64Array(paths);
  const totalSquaring = new Float64Array(paths);
  const peakBridge = new Float64Array(paths);
  const peakFunding = new Float64Array(paths);

  // Scratch reused across paths.
  const inflows = new Float64Array(T);
  const outflows = new Float64Array(T);
  const inflowShift = new Float64Array(T + 1);
  const outflowShift = new Float64Array(T + 1);
  const settleShift = new Float64Array(input.hedgeSettleSchedule.length);
  const spotPath = new Float64Array(G);
  const fcyRatePath = new Float64Array(G);
  const usdRatePath = new Float64Array(G);
  const fcyDeltaAt = new Float64Array(G);
  const usdDeltaAt = new Float64Array(G);
  const opDeltaAt = new Float64Array(G);
  const ledgerA = makeLedgerRun(G);
  const ledgerB = makeLedgerRun(G);
  const ledgerC = makeLedgerRun(G);

  for (let k = 0; k < paths; k += 1) {
    // ── stochastic inputs for this path ──────────────────────────────────
    for (let m = 1; m <= T; m += 1) {
      const fIn = input.monthlyInflows[m - 1] ?? 0;
      const fOut = input.monthlyOutflows[m - 1] ?? 0;
      inflows[m - 1] = Math.max(0, fIn * (1 + u * nextGaussian(rng)));
      outflows[m - 1] = Math.max(0, fOut * (1 + u * nextGaussian(rng)));
      inflowShift[m] = flowJitterMonths * nextGaussian(rng);
      outflowShift[m] = flowJitterMonths * nextGaussian(rng);
    }
    for (let i = 0; i < settleShift.length; i += 1) {
      settleShift[i] = settleJitterMonths * nextGaussian(rng);
    }

    // Spot path: GBM on the CIP drift, so forwards are fair and only the
    // deviation around them is risk.
    let s = input.spotUsd;
    spotPath[0] = s;
    for (let gi = 1; gi < G; gi += 1) {
      const dt = grid[gi]! - grid[gi - 1]!;
      s *= Math.exp((driftMonthly - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * nextGaussian(rng));
      spotPath[gi] = s;
    }
    // Rates as persistent random walks, not i.i.d. redraws each month — a real
    // curve is highly autocorrelated, and i.i.d. draws would let carry
    // uncertainty diversify away over the horizon.
    //
    // Two orthogonal shocks, because they do different jobs. DIFF moves the FCY
    // leg alone and so moves the differential: that is the carry ON THE
    // MISMATCH, the reason a hedged book still has uncertain cost. LEVEL moves
    // both legs together and leaves the differential untouched: it does nothing
    // to the mismatch but everything to a book running a large overdraft or
    // deposit, whose interest is real cash regardless of which currency it is
    // in. Modelling only DIFF, as this did, froze the USD leg and silently made
    // the USD account's interest deterministic — the larger of the two on a
    // book funding itself in dollars.
    let diffShock = 0;
    let levelShock = 0;
    let lastMonth = 0;
    for (let gi = 0; gi < G; gi += 1) {
      const m = Math.ceil(grid[gi]! - 1e-9);
      if (m > lastMonth) {
        diffShock += rateStepVol * nextGaussian(rng);
        levelShock += rateStepVol * nextGaussian(rng);
        lastMonth = m;
      }
      fcyRatePath[gi] = input.fcyRatePctPa + diffShock + levelShock;
      usdRatePath[gi] = input.usdRatePctPa + levelShock;
    }

    // ── three nested ledgers: structural → +size → +timing ───────────────
    runLedger(ledgerA, {
      ...ledgerCommon,
      fcyDeltaAt: planFcyDelta,
      usdDeltaAt: planUsdDelta,
      opDeltaAt: planOpDelta,
      spotPath,
      fcyRatePath,
      usdRatePath,
    });
    accumulateEvents({
      fcyDeltaAt, usdDeltaAt, opDeltaAt, grid, tenureMonths: T, inflows, outflows,
      inflowShift: noShift, outflowShift: noShift,
      schedule: input.hedgeSettleSchedule, settleShift: noLegShift, strikes,
    });
    runLedger(ledgerB, { ...ledgerCommon, fcyDeltaAt, usdDeltaAt, opDeltaAt, spotPath, fcyRatePath, usdRatePath });
    accumulateEvents({
      fcyDeltaAt, usdDeltaAt, opDeltaAt, grid, tenureMonths: T, inflows, outflows,
      inflowShift, outflowShift,
      schedule: input.hedgeSettleSchedule, settleShift, strikes,
    });
    runLedger(ledgerC, { ...ledgerCommon, fcyDeltaAt, usdDeltaAt, opDeltaAt, spotPath, fcyRatePath, usdRatePath });

    let worstGross = 0;
    let worstBridge = 0;
    let worstFunding = 0;
    // Reserve floors at zero: carry running ahead of the drawdown is not a
    // negative reserve, it just means nothing has to be set aside yet.
    let worstNet = 0;
    for (let gi = 0; gi < G; gi += 1) {
      const i = gi * paths + k;
      const spot = spotPath[gi]!;
      /**
       * Headline CFaR is size + timing of C vs A on the same spot path.
       * Revaluing the planned structural gap at simulated spot (plan − A) is
       * FX VaR on a known funding fact — kept as a diagnostic, not charged.
       * Op principal is netted; a squared delivery shortfall adds back
       * amt·(S−K) so the unwind survives.
       */
      const dPlan = plan.deliveredOp[gi]!;
      const dA = ledgerA.deliveredOp[gi]!;
      const grossDraw = mismatchDraw(ledgerA, ledgerC, gi, spot);
      /**
       * UNPLANNED USD FUNDING — the cash the desk has to move that it never
       * budgeted for, to bring fact back onto plan at this instant.
       *
       * Topping up both accounts costs (usdPlan − usdFact) + (fcyPlan −
       * fcyFact)·S — plan equity minus realized equity, including principal.
       * CFaR (grossDraw) is the size+timing COST of that deviation; this is
       * the CASH to carry it. The planned structural gap's FX reval sits in
       * funding, not in CFaR.
       *
       * Unlike CFaR this is non-zero at σ=0 — a shortfall still has to be
       * bought at whatever the rate happens to be, and zero vol only means
       * that rate is known in advance, not that the cash is free. Unlike
       * bridgeNeed it is measured against plan rather than against zero, so a
       * payer book's PLANNED overdraft does not count; only the deviation
       * does.
       */
      const funding = plan.grossEquity[gi]! - ledgerC.grossEquity[gi]!;
      if (grossDraw > worstGross) worstGross = grossDraw;
      if (funding > worstFunding) worstFunding = funding;
      sGross[i] = worstGross;
      sGrossRaw[i] = grossDraw;
      sFunding[i] = worstFunding;
      sFcy[i] = ledgerC.fcyBalance[gi]!;
      sStructLocal[i] = ledgerA.fcyBalance[gi]!;
      sSize[i] = ledgerB.fcyBalance[gi]! - ledgerA.fcyBalance[gi]!;
      sTiming[i] = ledgerC.fcyBalance[gi]! - ledgerB.fcyBalance[gi]!;
      // Size + timing telescope to headline grossDraw. Structural (plan − A)
      // is the excluded FX-vol proxy — diagnostic only.
      sStructUsd[i] =
        plan.grossEquity[gi]! - ledgerA.grossEquity[gi]! - (dPlan - dA) * spot;
      sSizeUsd[i] = mismatchDraw(ledgerA, ledgerB, gi, spot);
      sTimingUsd[i] = mismatchDraw(ledgerB, ledgerC, gi, spot);
      /**
       * CARRY IS A RANDOM VARIABLE HERE, not a mean laid over the top.
       *
       * ledgerC.interest is this path's own accrual — its balances, its
       * random-walked rate differential, its borrow spread wherever an
       * account went overdrawn — so it differs path to path and, crucially,
       * is CORRELATED with the drawdown that shares those balances. Only the
       * traded strip's forward points are deterministic, and rightly so: once
       * a forward is booked its points are contractual.
       */
      const carryHere = ledgerC.interest[gi]! + hedgeCarryAt[gi]!;
      sCarry[i] = carryHere;
      /**
       * CARRY CAN ONLY HELP. A book short a higher-rate currency pays to hold
       * the position, and that cost is known at trade time — it has a
       * standard deviation of zero. Letting it through would report it as a
       * reserve "at 95% confidence", so a book with no FX vol, no forecast
       * error and no rate vol at all still asked for cash it could have
       * budgeted on day one. That is a category error: you do not hold a risk
       * reserve against a number you already know.
       *
       * Planned carry you EARN is different — it is cash that genuinely turns
       * up to absorb a drawdown, so it is credited in full. The asymmetry is
       * the point, and it is what keeps net ≤ gross.
       *
       * The bleed is not lost from the model: it is P&L, and it is reported
       * as such in carryMeanUsdM and on the carry curve.
       */
      const carryBuffer = carryHere > 0 ? carryHere : 0;
      /**
       * Netted against this path's RUNNING MAX drawdown, the same series the
       * gross band plots — so net is gross plus carry and the two lines stay
       * readable against each other.
       *
       * Netting the point-in-time drawdown instead makes the line saw: gross
       * is monotone by construction while the live shortfall swings with
       * every flow, so the two would be different objects sharing an axis and
       * their gap would mean nothing.
       *
       * Carry is still read at the SAME instant, which is the part that has
       * to be paired — a peak drawdown in month three cannot be funded out of
       * carry that only shows up in month eleven.
       */
      const shortfall = worstGross - carryBuffer;
      sNetRaw[i] = shortfall;
      if (shortfall > worstNet) worstNet = shortfall;
      sNet[i] = worstNet;
      sSquaring[i] = ledgerC.squaringCost[gi]!;
      // Funding is sized to the worst moment, not the current one — once you
      // have drawn a facility you keep it available.
      const need = ledgerC.bridgeNeed[gi]!;
      if (need > worstBridge) worstBridge = need;
      sBridge[i] = worstBridge;
    }
    totalCarry[k] = (ledgerC.interest[G - 1] ?? 0) + (hedgeCarryAt[G - 1] ?? 0);
    totalSquaring[k] = ledgerC.squaringCost[G - 1] ?? 0;
    peakBridge[k] = worstBridge;
    peakFunding[k] = worstFunding;
  }

  // Column extraction into a reused buffer, sorted with the typed array's own
  // numeric sort (no comparator closure). The buffer is overwritten on every
  // call, so all quantiles from one column must be read before the next.
  const scratch = new Float64Array(paths);
  /** Sorted copy of one grid point's column — for series read at several
   * quantiles, where a single full sort beats repeated selections. */
  const col = (buf: Float64Array, gi: number): Float64Array => {
    scratch.set(buf.subarray(gi * paths, gi * paths + paths));
    scratch.sort();
    return scratch;
  };
  /** One quantile of one grid point's column, via selection rather than sort. */
  const q1 = (buf: Float64Array, gi: number, p: number): number => {
    scratch.set(buf.subarray(gi * paths, gi * paths + paths));
    return quantileSelect(scratch, paths, p);
  };
  const meanAt = (buf: Float64Array, gi: number): number => {
    const base = gi * paths;
    let sum = 0;
    for (let k = 0; k < paths; k += 1) sum += buf[base + k]!;
    return sum / paths;
  };

  const points: CfarBandPoint[] = new Array(G);
  const components: McCfarComponentPoint[] = new Array(G);
  let criticalCashUsdM = 0;
  let netCriticalCashUsdM = 0;
  let grossPeakMonth = 0;
  let peakMonth = 0;

  for (let gi = 0; gi < G; gi += 1) {
    // `col` returns a shared buffer, so every quantile of a column must be
    // read before the next column is extracted.
    const grossSorted = col(sGross, gi);
    const gConf = quantileSorted(grossSorted, pConf); // worst
    const g05 = quantileSorted(grossSorted, 0.05); // mildest
    const g75 = quantileSorted(grossSorted, 0.75);
    const g25 = quantileSorted(grossSorted, 0.25);
    const g50 = quantileSorted(grossSorted, 0.5);
    // nRaw is the plotted line: carry less the high-water drawdown, so it is
    // gross plus carry and moves as smoothly as those two do. nConf floors it
    // at zero and running-maxes it, which is the reserve headline — the worst
    // the plotted line ever dips below the axis.
    const nConf = q1(sNet, gi, pConf);
    const nRaw = q1(sNetRaw, gi, pConf);
    const carryAtGi = meanAt(sCarry, gi);
    const fcyMeanAtGi = meanAt(sFcy, gi);
    points[gi] = {
      t: grid[gi]!,
      exposureLocalM: fcyMeanAtGi,
      carryUsdM: carryAtGi,
      p05: -gConf,
      p25: -g75,
      p50: -g50,
      p75: -g25,
      p95: -g05,
      // Signed: carry banked less the worst drawdown reached so far. Above
      // zero the carry covers it; with no risk at all the drawdown is zero
      // and the line is simply the carry P&L.
      netP05: -nRaw,
      netP50: carryAtGi,
    };
    // Running-max curves are monotonic, so this scan lands on the FIRST point
    // each curve reaches its final plateau — the marker sits where risk
    // stopped growing, not always at maturity.
    if (gConf > criticalCashUsdM) {
      criticalCashUsdM = gConf;
      grossPeakMonth = grid[gi]!;
    }
    if (nConf > netCriticalCashUsdM) {
      netCriticalCashUsdM = nConf;
      peakMonth = grid[gi]!;
    }

    const fcySorted = col(sFcy, gi);
    const mismatchP05 = quantileSorted(fcySorted, 0.05);
    const mismatchP95 = quantileSorted(fcySorted, 0.95);
    const timingSorted = col(sTiming, gi);
    const timingP05 = quantileSorted(timingSorted, 0.05);
    const timingP95 = quantileSorted(timingSorted, 0.95);
    const sizeSorted = col(sSize, gi);
    const sizeP05 = quantileSorted(sizeSorted, 0.05);
    const sizeP95 = quantileSorted(sizeSorted, 0.95);
    let carrySq = 0;
    for (let k = 0; k < paths; k += 1) {
      const d = sCarry[gi * paths + k]! - carryAtGi;
      carrySq += d * d;
    }
    components[gi] = {
      t: grid[gi]!,
      mismatchLocalM: fcyMeanAtGi,
      mismatchP05,
      mismatchP95,
      structuralGapLocalM: meanAt(sStructLocal, gi),
      timingMismatchLocalM: meanAt(sTiming, gi),
      timingMismatchP05: timingP05,
      timingMismatchP95: timingP95,
      sizeMismatchLocalM: meanAt(sSize, gi),
      sizeMismatchP05: sizeP05,
      sizeMismatchP95: sizeP95,
      rawGrossUsdM: q1(sGrossRaw, gi, pConf),
      reserveUsdM: nConf,
      structuralFxRiskUsdM: q1(sStructUsd, gi, pConf),
      sizeFxRiskUsdM: q1(sSizeUsd, gi, pConf),
      timingFxRiskUsdM: q1(sTimingUsd, gi, pConf),
      rawNetUsdM: -q1(sNetRaw, gi, pConf),
      carryMeanUsdM: carryAtGi,
      carryStdUsdM: Math.sqrt(Math.max(0, carrySq / paths)),
      squaringCostUsdM: meanAt(sSquaring, gi),
      squaringCostP95UsdM: q1(sSquaring, gi, 0.95),
      bridgeNeedUsdM: q1(sBridge, gi, pConf),
      unplannedUsdFundingUsdM: q1(sFunding, gi, pConf),
      planBridgeNeedUsdM: planBridgeRunningMax[gi]!,
    };
  }

  let carrySum = 0;
  let squaringSum = 0;
  for (let k = 0; k < paths; k += 1) {
    carrySum += totalCarry[k]!;
    squaringSum += totalSquaring[k]!;
  }
  const carryMean = carrySum / paths;
  let carrySqSum = 0;
  for (let k = 0; k < paths; k += 1) {
    const d = totalCarry[k]! - carryMean;
    carrySqSum += d * d;
  }
  const carryVar = carrySqSum / paths;
  const squaringMean = squaringSum / paths;

  return {
    points,
    openPathVarUsdM: criticalCashUsdM,
    criticalCashUsdM,
    netCriticalCashUsdM,
    peakMonth,
    grossPeakMonth,
    kEmpirical: 1,
    carryMeanUsdM: carryMean,
    carryStdUsdM: Math.sqrt(carryVar),
    paths,
    gridPoints: G,
    squaringCostMeanUsdM: squaringMean,
    peakBridgeFundingUsdM: quantileSelect(peakBridge, paths, pConf),
    planPeakBridgeFundingUsdM: planBridgeRunningMax[G - 1] ?? 0,
    peakUnplannedUsdFundingUsdM: quantileSelect(peakFunding, paths, pConf),
    components,
  };
}
