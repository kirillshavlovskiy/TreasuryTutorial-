/**
 * Per-currency efficient frontier for the liquidity funding book.
 *
 * The KKT table gives one verdict per name from the shadow prices; this sweeps
 * the dial behind that verdict so the desk can see the whole exchange rather
 * than the single point complementary slackness landed on.
 *
 * One currency moves at a time — every other name is held at its live strip —
 * so the curve is that name's own trade and not a portfolio blend. The slope
 * is signed by the shadow prices, which is why the names disagree:
 *
 *   μ = r_USD − r_FCY          PAY when positive, EARN when negative
 *   λ = max(0, r_OD − r_USD)   what a $1 H* shortfall costs over USD
 *
 * EARN names (μ < 0) earn on the way up — funding the trough holds a
 * higher-yielding currency, so carry climbs with cover and the frontier runs
 * up-and-right. PAY names on a cheap facility (μ > 0, λ ≈ 0) earn on the way
 * down — the overdraft is cheaper than the USD the strip consumes, so carry
 * climbs as cover falls. A binding name sits between: cover pays until H* is
 * met and costs after.
 *
 * Deterministic, like the regime table: each point is repriced through
 * `scaleFundingPlan` + the strategy evaluator on the same interest ledger. No
 * Monte Carlo, so a modal can sweep on open without blocking.
 */

import type { LiquidityCycleProjection } from '@/lib/forecast-profile';
import { resolveLiquidityTiming } from '@/lib/liquidity-ladder';
import { roundMoney } from '@/lib/fx-buffer';
import {
  evaluateLiquidityStrategies,
  strategyForRegime,
  type LiquidityStrategyInput,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import { scaleFundingPlan } from '@/lib/test-mode/funding-optimizer';

/** Cover points swept per name. 1 is that name's strip as the regime sizes it. */
export const CCY_COVER_RATIOS: readonly number[] = [
  0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
];

export interface CcyFrontierPoint {
  /** Funding cover on this name's strip. 0 leaves the trough on the facility. */
  coverRatio: number;
  /** What this name earns, $M/yr — negated net funding cost. */
  carryUsdYrM: number;
  cashCarryUsdYrM: number;
  swapCarryUsdYrM: number;
  /** Depth of the worst H* shortfall, M FCY (≥ 0). The risk being carried. */
  shortfallM: number;
  floorBreaches: number;
  bookNowM: number;
  peakBookM: number;
  troughM: number;
}

export interface CcyFrontier {
  ccy: string;
  points: CcyFrontierPoint[];
  /** Non-dominated subset, ordered by rising risk. */
  frontier: CcyFrontierPoint[];
  /** True when the sweep does not trade — nothing to plot. */
  degenerate: boolean;
  /** Most carry among points that breach no cycle. Null when none clears. */
  bestCompliant: CcyFrontierPoint | null;
  /** Sign of the exchange: does carry rise or fall as cover rises? */
  slope: 'earnsOnCover' | 'earnsOnRelease' | 'flat';
}

/**
 * Which regime the sweep runs on. Defaults to the live desk regime so callers
 * that do not care keep the old behaviour, but the Analytics panel passes the
 * regime the user actually selected — otherwise every chart stays pinned to
 * live and selecting a scenario appears to do nothing.
 */
function resolveRegime(
  input: LiquidityStrategyInput,
  results: readonly LiquidityStrategyResult[],
  strategyId?: string,
): LiquidityStrategyResult {
  const timing = resolveLiquidityTiming(input.forecastProfile);
  const liveMeta = strategyForRegime(
    timing?.sizingBasis ?? 'horizon',
    timing?.bookingMode ?? 'rolling',
  );
  const live = results.find(r => r.strategy.id === liveMeta.id) ?? results[0]!;
  if (!strategyId) return live;
  return results.find(r => r.strategy.id === strategyId) ?? live;
}

/**
 * Sweep one name's cover, holding every other name at its live strip.
 *
 * Returns null when the live regime books no strip for this name — an unfunded
 * baseline has no dial, so there is no frontier to draw.
 */
export function ccyFundingFrontier(
  input: LiquidityStrategyInput,
  ccy: string,
  coverRatios: readonly number[] = CCY_COVER_RATIOS,
  /** Regime to sweep. Defaults to the live desk regime. */
  strategyId?: string,
): CcyFrontier | null {
  const results = evaluateLiquidityStrategies(input);
  if (results.length === 0) return null;

  const base = resolveRegime(input, results, strategyId);
  if (base.strategy.regime == null) return null;

  const target = base.byCcy.find(c => c.ccy === ccy);
  if (!target || target.plan.length === 0) return null;

  const points: CcyFrontierPoint[] = [];
  for (const coverRatio of coverRatios) {
    const scaled: Record<string, LiquidityCycleProjection[]> = {
      [ccy]: scaleFundingPlan(
        target.plan,
        target.plan.map(() => coverRatio),
      ),
    };

    const priced = evaluateLiquidityStrategies({
      ...input,
      livePlanByCcy: { ...input.livePlanByCcy, ...scaled },
    }).find(r => r.strategy.id === base.strategy.id);

    const row = priced?.byCcy.find(c => c.ccy === ccy) ?? target;
    points.push({
      coverRatio,
      carryUsdYrM: roundMoney(-row.netCostUsdYrM),
      cashCarryUsdYrM: row.cashCarryUsdYrM,
      swapCarryUsdYrM: row.swapCarryUsdYrM,
      shortfallM: Math.max(0, -row.gapToThreshold),
      floorBreaches: row.floorBreaches,
      bookNowM: row.bookNow,
      peakBookM: row.peakBook,
      troughM: row.trough,
    });
  }

  const carrySpread =
    Math.max(...points.map(p => p.carryUsdYrM))
    - Math.min(...points.map(p => p.carryUsdYrM));
  const riskSpread =
    Math.max(...points.map(p => p.shortfallM))
    - Math.min(...points.map(p => p.shortfallM));
  const degenerate =
    points.length < 2 || (carrySpread < 1e-6 && riskSpread < 1e-6);

  const at0 = points.find(p => p.coverRatio === 0) ?? points[0]!;
  const at1 = points.find(p => p.coverRatio === 1) ?? points[points.length - 1]!;
  const slope =
    Math.abs(at1.carryUsdYrM - at0.carryUsdYrM) < 1e-6
      ? 'flat'
      : at1.carryUsdYrM > at0.carryUsdYrM
        ? 'earnsOnCover'
        : 'earnsOnRelease';

  const clean = points.filter(p => p.floorBreaches === 0);

  return {
    ccy,
    points,
    frontier: ccyEfficientFrontier(points),
    degenerate,
    bestCompliant:
      clean.length > 0
        ? clean.reduce((a, b) => (b.carryUsdYrM > a.carryUsdYrM ? b : a))
        : null,
    slope,
  };
}

/**
 * One name's hedge priced as a rate: what full cover costs in carry, and what
 * it buys in risk, both as a percentage of the notional that does the work.
 *
 * Absolute $ figures cannot be compared across a 3-name book — GBP 117M and
 * PLN 1.8M are not the same trade. Dividing each leg by the hedge notional
 * turns both into % p.a., so every name lands on one scatter and the slope
 * through a point is its efficiency: risk removed per unit of carry paid.
 */
export interface CcyMarginalHedge {
  ccy: string;
  /**
   * Carry given up by going 0% → 100% cover, as % p.a. of hedge notional.
   * Negative means cover *earns* — an EARN name is paid to hedge.
   */
  marginalCarryCostPct: number;
  /**
   * Shortfall this name removes, as % of the whole book's unfunded shortfall.
   *
   * Deliberately portfolio-relative, not self-relative: full cover clears a
   * name's own shortfall by construction, so dividing by its own risk pins
   * every name at 100% and the axis carries no information. Against the book
   * total it answers the question the desk actually asks — how much of the
   * group's risk does this one trade buy down — and the column sums to 100%.
   */
  marginalRiskReductionPct: number;
  /** Shortfall removed in absolute terms, M FCY. */
  riskRemovedM: number;
  /** Notional doing the work — the bubble size. */
  hedgeNotionalM: number;
  /** Deepest unfunded shortfall, M FCY — what is at stake before cover. */
  shortfallAtZeroM: number;
  /** Risk reduction per unit of carry cost. Infinite when cover is free. */
  efficiency: number;
  /** True when cover both removes risk and earns carry — no trade-off at all. */
  isFreeHedge: boolean;
}

/** Raw per-name legs, before the portfolio share is known. */
interface MarginalLegs {
  ccy: string;
  marginalCarryCostPct: number;
  riskRemovedM: number;
  hedgeNotionalM: number;
  shortfallAtZeroM: number;
}

function marginalLegsFor(
  input: LiquidityStrategyInput,
  ccy: string,
  strategyId?: string,
): MarginalLegs | null {
  const f = ccyFundingFrontier(input, ccy, CCY_COVER_RATIOS, strategyId);
  if (!f || f.points.length < 2) return null;

  const at0 = f.points.find(p => p.coverRatio === 0) ?? f.points[0]!;
  const at1 =
    f.points.find(p => p.coverRatio === 1) ?? f.points[f.points.length - 1]!;

  // Notional that does the work. Without it the carry leg is not a rate.
  const notional = Math.max(Math.abs(at1.peakBookM), 1e-9);
  return {
    ccy,
    marginalCarryCostPct:
      ((at0.carryUsdYrM - at1.carryUsdYrM) / notional) * 100,
    riskRemovedM: at0.shortfallM - at1.shortfallM,
    hedgeNotionalM: Math.abs(at1.peakBookM),
    shortfallAtZeroM: at0.shortfallM,
  };
}

/**
 * Every fundable name on the live regime, ordered most efficient first.
 *
 * The risk leg is only meaningful against the book, so it is resolved here
 * rather than per name.
 */
export function ccyMarginalHedgeBook(
  input: LiquidityStrategyInput,
  /** Regime to price. Defaults to the live desk regime. */
  strategyId?: string,
): CcyMarginalHedge[] {
  const results = evaluateLiquidityStrategies(input);
  if (results.length === 0) return [];

  const base = resolveRegime(input, results, strategyId);

  const legs: MarginalLegs[] = [];
  for (const c of base.byCcy) {
    const l = marginalLegsFor(input, c.ccy, strategyId);
    if (l) legs.push(l);
  }
  if (legs.length === 0) return [];

  const bookRisk = legs.reduce((s, l) => s + Math.max(0, l.riskRemovedM), 0);

  return legs
    .map((l): CcyMarginalHedge => {
      const marginalRiskReductionPct =
        bookRisk > 1e-9 ? (Math.max(0, l.riskRemovedM) / bookRisk) * 100 : 0;
      return {
        ccy: l.ccy,
        marginalCarryCostPct: l.marginalCarryCostPct,
        marginalRiskReductionPct,
        riskRemovedM: l.riskRemovedM,
        hedgeNotionalM: l.hedgeNotionalM,
        shortfallAtZeroM: l.shortfallAtZeroM,
        efficiency:
          l.marginalCarryCostPct > 1e-9
            ? marginalRiskReductionPct / l.marginalCarryCostPct
            : Number.POSITIVE_INFINITY,
        isFreeHedge:
          l.marginalCarryCostPct <= 1e-9 && marginalRiskReductionPct > 1e-9,
      };
    })
    .sort((a, b) => b.efficiency - a.efficiency);
}

/**
 * Non-dominated points: nothing else earns more carry for no more shortfall.
 *
 * Same construction as CFaR's `efficientFrontier` — walk carry descending and
 * keep a point only when it strictly improves on the best risk so far.
 */
export function ccyEfficientFrontier(
  points: readonly CcyFrontierPoint[],
): CcyFrontierPoint[] {
  const byCarryDesc = [...points].sort(
    (a, b) => b.carryUsdYrM - a.carryUsdYrM || a.shortfallM - b.shortfallM,
  );
  const keep: CcyFrontierPoint[] = [];
  let bestRisk = Number.POSITIVE_INFINITY;
  for (const p of byCarryDesc) {
    if (p.shortfallM < bestRisk - 1e-9) {
      keep.push(p);
      bestRisk = p.shortfallM;
    }
  }
  return keep.reverse();
}
