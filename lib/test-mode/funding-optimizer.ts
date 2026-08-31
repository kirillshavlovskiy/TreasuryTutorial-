/**
 * KKT / complementary-slackness cover for the live funding regime.
 *
 * Cash Carry's shape search pins WAM and grids N × CoM × kurtosis. CFaR's
 * frontier sweeps hedge cover against gross risk. Neither belongs here: the
 * dated path has already picked a booking convention, and the overlay ledger
 * at CIP mid nets the swap to zero — so it will happily spend USD to avoid
 * a cheaper local facility.
 *
 * This optimizer keeps the live regime (sizing basis × booking mode) and
 * prices each cycle's increment on a USD-capital shadow price:
 *
 *   μ = r_USD − r_FCY     carry of holding $1 FCY instead of USD
 *   λ = max(0, r_OD − r_USD)   extra cost of $1 H* shortfall vs USD
 *
 * Stationarity: book the increment iff μ < λ (USD capital is cheaper than
 * leaving the gap on OD). EARN (μ ≤ 0) takes the whole strip — carry pays
 * you to hold. Cheap OD (λ = 0) drops the book — the facility beats USD.
 * Otherwise the cycle is funded just enough to bind H*, so idle notional
 * (term cover sitting before it bites, a rolling increment that does not
 * close a residual) is not carried.
 *
 * The score is the Lagrangian, not Swap Carry: dropping a cheap-OD name can
 * look worse on the CIP overlay and still be the right use of USD capital.
 */

import type { LiquidityCycleProjection } from '@/lib/forecast-profile';
import {
  resolveLiquidityTiming,
  type LiquidityBookingMode,
} from '@/lib/liquidity-ladder';
import { roundMoney, type RowState } from '@/lib/fx-buffer';
import {
  evaluateLiquidityStrategies,
  strategyForRegime,
  type LiquidityStrategy,
  type LiquidityStrategyCcy,
  type LiquidityStrategyInput,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';

export type KktVerdict = 'earn' | 'cheapOd' | 'bind' | 'skip';

export interface FundingOptCycle {
  cycleIndex: number;
  /** 0–1 share of this cycle's live increment that KKT keeps. */
  cover: number;
  /** Proposed new-leg notional (M FCY). */
  increment: number;
  /** H* shortfall if this increment is skipped, after prior KKT legs (M FCY). */
  residualIfSkip: number;
}

export interface FundingOptCcy {
  ccy: string;
  /** r_USD − r_FCY, % p.a. Positive = PAY. */
  muPct: number;
  /** max(0, r_OD − r_USD), % p.a. */
  lambdaPct: number;
  verdict: KktVerdict;
  /** Peak cycle cover on the strip (the Decision-card Cover %). */
  cover: number;
  liveBookNow: number;
  proposedBookNow: number;
  livePeak: number;
  proposedPeak: number;
  liveKktUsdYrM: number;
  proposedKktUsdYrM: number;
  liveGap: number;
  proposedGap: number;
  cycles: readonly FundingOptCycle[];
}

export interface FundingOptResult {
  strategy: LiquidityStrategy;
  method: 'kkt-shadow-price';
  live: LiquidityStrategyResult;
  proposed: LiquidityStrategyResult;
  byCcy: FundingOptCcy[];
  /** live Lagrangian − proposed (positive = KKT is cheaper on USD capital). */
  savedKktUsdYrM: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function bookingModeOf(strategy: LiquidityStrategy): LiquidityBookingMode {
  return strategy.regime?.bookingMode ?? 'rolling';
}

/** Unfunded trough implied by a fully-funded plan cycle. */
export function unfundedTroughOf(p: LiquidityCycleProjection): number {
  return p.forecasted_cash - (p.standing_swap - p.swap_needed);
}

export function kktSpreads(
  r_USD: number,
  r_FCY: number,
  r_OD: number,
): { muPct: number; lambdaPct: number } {
  return {
    muPct: r_USD - r_FCY,
    lambdaPct: Math.max(0, r_OD - r_USD),
  };
}

export function kktVerdictOf(muPct: number, lambdaPct: number): KktVerdict {
  if (muPct <= 0) return 'earn';
  if (lambdaPct <= 1e-9) return 'cheapOd';
  if (muPct >= lambdaPct) return 'skip';
  return 'bind';
}

export function kktScoreUsdYrM(
  avgBook: number,
  gapToThreshold: number,
  spot: number,
  muPct: number,
  lambdaPct: number,
): number {
  return roundMoney(
    (avgBook * muPct + Math.max(0, -gapToThreshold) * lambdaPct) / 100 * spot,
  );
}

/**
 * Rewrite a live strip at per-cycle cover, keeping H* and the unfunded trough
 * so Analytics can reprice the sparse book on the same interest ledger.
 */
export function scaleFundingPlan(
  plan: readonly LiquidityCycleProjection[],
  coverByCycle: readonly number[],
): LiquidityCycleProjection[] {
  let standing = 0;
  const firstLive = plan[0]?.swap_needed ?? 0;
  const firstCover = clamp01(coverByCycle[0] ?? 0);

  return plan.map((p, k) => {
    const a = clamp01(coverByCycle[k] ?? 0);
    const trough = unfundedTroughOf(p);
    const unfundedPost = p.post_swap_cash - p.standing_swap;
    const swap_needed = roundMoney(p.swap_needed * a);
    const standingBefore = standing;
    standing = roundMoney(standing + swap_needed);
    const far_leg =
      k === plan.length - 1 && Math.abs(p.far_leg) > 0.001
        ? roundMoney(-standing)
        : 0;
    const endAdj = (swap_needed - p.swap_needed) + (far_leg - p.far_leg);
    return {
      ...p,
      forecasted_cash: roundMoney(trough + standingBefore),
      swap_needed,
      incremental_swap:
        k === 0
          ? 0
          : roundMoney(Math.max(0, swap_needed - firstLive * firstCover)),
      standing_swap: standing,
      post_swap_cash: roundMoney(unfundedPost + standing),
      far_leg,
      cycle_end_cash: roundMoney(p.cycle_end_cash + endAdj),
    };
  });
}

export interface KktCycleCoverResult {
  muPct: number;
  lambdaPct: number;
  verdict: KktVerdict;
  covers: number[];
  cycles: FundingOptCycle[];
}

/**
 * Per-cycle cover under the live booking convention.
 *
 * Rolling: greedy complementary slackness — fund the residual H* gap when
 * μ < λ, otherwise skip. Term: one α on the opening leg; breakpoints are
 * the cycle gaps / peak, and the Lagrangian is evaluated at each.
 */
export function kktCycleCovers(
  row: Pick<RowState, 'r_FCY' | 'r_OD'>,
  plan: readonly LiquidityCycleProjection[],
  r_USD: number,
  bookingMode: LiquidityBookingMode,
): KktCycleCoverResult {
  const { muPct, lambdaPct } = kktSpreads(r_USD, row.r_FCY, row.r_OD);
  const verdict = kktVerdictOf(muPct, lambdaPct);
  const n = plan.length;

  if (n === 0) {
    return { muPct, lambdaPct, verdict, covers: [], cycles: [] };
  }

  if (bookingMode === 'term') {
    const cover = termCover(plan, verdict);
    const covers = plan.map((p, k) => (k === 0 || Math.abs(p.swap_needed) > 0.001 ? cover : 0));
    return {
      muPct,
      lambdaPct,
      verdict,
      covers,
      cycles: plan.map((p, k) => {
        const trough = unfundedTroughOf(p);
        const residualIfSkip = roundMoney(p.cash_threshold - trough);
        return {
          cycleIndex: p.cycleIndex,
          cover: covers[k] ?? 0,
          increment: roundMoney(p.swap_needed * (covers[k] ?? 0)),
          residualIfSkip,
        };
      }),
    };
  }

  let standing = 0;
  const covers: number[] = [];
  const cycles: FundingOptCycle[] = [];
  for (const p of plan) {
    const trough = unfundedTroughOf(p);
    const residualIfSkip = roundMoney(p.cash_threshold - trough - standing);
    const I = p.swap_needed;
    let cover = 0;
    if (verdict === 'earn') cover = 1;
    else if (verdict === 'bind' && I > 1e-9) {
      cover = clamp01(Math.max(0, residualIfSkip) / I);
    }
    const increment = roundMoney(I * cover);
    standing = roundMoney(standing + increment);
    covers.push(cover);
    cycles.push({
      cycleIndex: p.cycleIndex,
      cover,
      increment,
      residualIfSkip,
    });
  }
  return { muPct, lambdaPct, verdict, covers, cycles };
}

function termCover(
  plan: readonly LiquidityCycleProjection[],
  verdict: KktVerdict,
): number {
  if (verdict === 'earn') return 1;
  if (verdict === 'cheapOd' || verdict === 'skip') return 0;

  const I = plan.reduce((m, p) => Math.max(m, Math.abs(p.swap_needed), Math.abs(p.standing_swap)), 0);
  if (I <= 1e-9) return 0;

  // μ < λ: closing a gap lowers L, so the deepest requirement binds.
  const worst = plan.reduce(
    (m, p) => Math.max(m, p.cash_threshold - unfundedTroughOf(p)),
    0,
  );
  return worst <= 1e-9 ? 0 : clamp01(worst / I);
}

function peakCover(covers: readonly number[]): number {
  return covers.reduce((m, a) => Math.max(m, a), 0);
}

function rowByCcy(rows: readonly RowState[]): Record<string, RowState> {
  const out: Record<string, RowState> = {};
  for (const r of rows) {
    if (r.ccy) out[r.ccy] = r;
  }
  return out;
}

function compareCcy(
  live: LiquidityStrategyCcy,
  proposed: LiquidityStrategyCcy | undefined,
  kkt: KktCycleCoverResult,
): FundingOptCcy {
  const p = proposed ?? live;
  return {
    ccy: live.ccy,
    muPct: kkt.muPct,
    lambdaPct: kkt.lambdaPct,
    verdict: kkt.verdict,
    cover: peakCover(kkt.covers),
    liveBookNow: live.bookNow,
    proposedBookNow: p.bookNow,
    livePeak: live.peakBook,
    proposedPeak: p.peakBook,
    liveKktUsdYrM: kktScoreUsdYrM(live.avgBook, live.gapToThreshold, live.spot, kkt.muPct, kkt.lambdaPct),
    proposedKktUsdYrM: kktScoreUsdYrM(p.avgBook, p.gapToThreshold, p.spot, kkt.muPct, kkt.lambdaPct),
    liveGap: live.gapToThreshold,
    proposedGap: p.gapToThreshold,
    cycles: kkt.cycles,
  };
}

/**
 * Sparse a funding regime's strip by complementary slackness and reprice it
 * on the same evaluator the Analytics table uses.
 *
 * `strategyId` picks the regime to sparsify. Omit it to use the live desk
 * (sizing × booking from the forecast profile).
 */
export function optimizeFundingRegime(
  input: LiquidityStrategyInput,
  strategyId?: string,
): FundingOptResult | null {
  const results = evaluateLiquidityStrategies(input);
  if (results.length === 0) return null;

  const timing = resolveLiquidityTiming(input.forecastProfile);
  const liveMeta = strategyForRegime(
    timing?.sizingBasis ?? 'horizon',
    timing?.bookingMode ?? 'rolling',
  );
  const live =
    (strategyId
      ? results.find(r => r.strategy.id === strategyId)
      : undefined)
    ?? results.find(r => r.strategy.id === liveMeta.id)
    ?? results[0]!;
  const booking = bookingModeOf(live.strategy);
  const rows = rowByCcy(input.rows);

  const kktByCcy = new Map<string, KktCycleCoverResult>();
  const scaledPlans: Record<string, LiquidityCycleProjection[]> = {};
  for (const c of live.byCcy) {
    const row = rows[c.ccy];
    if (!row) continue;
    const kkt = kktCycleCovers(row, c.plan, input.shared.r_USD, booking);
    kktByCcy.set(c.ccy, kkt);
    if (c.plan.length > 0) {
      scaledPlans[c.ccy] = scaleFundingPlan(c.plan, kkt.covers);
    }
  }

  const canInject =
    live.strategy.regime != null && Object.keys(scaledPlans).length > 0;
  const proposed = canInject
    ? (evaluateLiquidityStrategies({
        ...input,
        livePlanByCcy: { ...input.livePlanByCcy, ...scaledPlans },
      }).find(r => r.strategy.id === live.strategy.id) ?? live)
    : live;

  const proposedByCcy = new Map(proposed.byCcy.map(c => [c.ccy, c]));
  const byCcy = live.byCcy.map(c => {
    const kkt = kktByCcy.get(c.ccy) ?? kktCycleCovers(
      rows[c.ccy] ?? { r_FCY: 0, r_OD: 0 },
      c.plan,
      input.shared.r_USD,
      booking,
    );
    return compareCcy(c, proposedByCcy.get(c.ccy), kkt);
  });

  const savedKktUsdYrM = roundMoney(
    byCcy.reduce((s, c) => s + (c.liveKktUsdYrM - c.proposedKktUsdYrM), 0),
  );

  return {
    strategy: live.strategy,
    method: 'kkt-shadow-price',
    live,
    proposed,
    byCcy,
    savedKktUsdYrM,
  };
}

/** Sparse the live desk regime. Same as `optimizeFundingRegime` with no id. */
export function optimizeLiveRegime(
  input: LiquidityStrategyInput,
): FundingOptResult | null {
  return optimizeFundingRegime(input);
}
