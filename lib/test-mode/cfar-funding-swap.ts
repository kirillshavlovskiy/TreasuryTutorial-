/**
 * Funding-swap bridge for displayed CFaR.
 *
 * The liquidity funding swap is a different trade from the FX hedge: CIP
 * near+far cancels spot, so the only risk is rate-differential vol on the
 * outstanding book — the same factor as the FX-hedge swap-bridge.
 *
 * Cover sizing stays on FX-only Net CFaR (no loop). Displayed CFaR RSS-combines
 * this path in one pass after the desk has booked the swap.
 */

import {
  computeCfarBands,
  type CfarBandPoint,
  type CfarBandsResult,
  type ExposureKnot,
} from '@/lib/test-mode/cfar-drawdown';

export function fundingSwapOutstandingByMonth(
  plan: readonly { standing_swap: number; far_leg?: number }[] | undefined,
  months: number,
): { outstandingM: number[]; termSettles: boolean } {
  if (!plan?.length || months <= 0) return { outstandingM: [], termSettles: false };
  const outstandingM = Array.from({ length: months }, (_, i) => {
    const n = Number(plan[Math.min(i, plan.length - 1)]!.standing_swap);
    return Number.isFinite(n) ? n : 0;
  });
  if (!outstandingM.some(v => Math.abs(v) > 0.001)) {
    return { outstandingM: [], termSettles: false };
  }
  const termSettles = plan.some(p => Math.abs(p.far_leg ?? 0) > 0.001);
  return { outstandingM, termSettles };
}

export function fundingSwapKnotsFromOutstanding(
  outstandingM: readonly number[],
  T: number,
  termSettles = false,
): ExposureKnot[] {
  const months = outstandingM.length;
  if (months === 0 || T <= 0) return [];
  const knots: ExposureKnot[] = [{ t: 0, e: Math.abs(outstandingM[0] ?? 0) }];
  for (let i = 0; i < months; i += 1) {
    knots.push({ t: Math.min(T, i + 1), e: Math.abs(outstandingM[i] ?? 0) });
  }
  const lastT = knots[knots.length - 1]!.t;
  if (lastT < T) {
    knots.push({
      t: T,
      e: termSettles ? 0 : Math.abs(outstandingM[months - 1] ?? 0),
    });
  } else if (termSettles) {
    knots.push({ t: T, e: 0 });
  }
  return knots;
}

export function fundingSwapBridgeBands(input: {
  outstandingM: readonly number[];
  T: number;
  spotUsd: number;
  sigmaMonthly: number;
  confidencePct: number;
  termSettles?: boolean;
  steps?: number;
  /**
   * Cumulative Buffer Carry through each month (USD M). Gross swap VaR
   * scales with |S|·√t; carry accrues with S·t. Net CFaR is the peak of
   * (gross − carry) — not linear in standing or in carry paid.
   */
  carryScheduleUsdM?: readonly number[];
}): CfarBandsResult | null {
  const knots = fundingSwapKnotsFromOutstanding(
    input.outstandingM,
    input.T,
    input.termSettles,
  );
  if (knots.length === 0) return null;
  return computeCfarBands({
    knots,
    spotUsd: input.spotUsd,
    sigmaMonthly: input.sigmaMonthly,
    confidencePct: input.confidencePct,
    steps: input.steps,
    carryScheduleUsdM: input.carryScheduleUsdM,
  });
}

function rss(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

function lerpPoint(a: CfarBandPoint, b: CfarBandPoint, t: number): CfarBandPoint {
  const span = b.t - a.t;
  const w = span > 1e-12 ? (t - a.t) / span : 1;
  const mix = (x: number, y: number) => x + (y - x) * w;
  return {
    t,
    exposureLocalM: mix(a.exposureLocalM, b.exposureLocalM),
    carryUsdM: mix(a.carryUsdM, b.carryUsdM),
    p05: mix(a.p05, b.p05),
    p25: mix(a.p25, b.p25),
    p50: mix(a.p50, b.p50),
    p75: mix(a.p75, b.p75),
    p95: mix(a.p95, b.p95),
    netP05: mix(a.netP05, b.netP05),
    netP50: mix(a.netP50, b.netP50),
  };
}

function fundingPointAt(
  points: readonly CfarBandPoint[],
  t: number,
): CfarBandPoint | null {
  if (points.length === 0) return null;
  if (t <= points[0]!.t) return points[0]!;
  const last = points[points.length - 1]!;
  if (t >= last.t) return last;
  for (let i = 1; i < points.length; i += 1) {
    if (t <= points[i]!.t) return lerpPoint(points[i - 1]!, points[i]!, t);
  }
  return last;
}

/**
 * RSS the funding-swap bridge into an FX-only CFaR result (closed-form or MC).
 * Expected funding-swap points stay out — same rule as the FX-hedge bridge.
 */
export function applyFundingSwapBridge<T extends CfarBandsResult>(
  fx: T,
  funding?: CfarBandsResult | null,
): T {
  const peak = funding?.criticalCashUsdM ?? 0;
  if (!funding || peak < 1e-12) return fx;
  const points = fx.points.map(p => {
    const fw = fundingPointAt(funding.points, p.t);
    if (!fw) return p;
    const p05 = -rss(Math.abs(p.p05), Math.abs(fw.p05));
    const p25 = -rss(Math.abs(p.p25), Math.abs(fw.p25));
    const p75 = rss(Math.abs(p.p75), Math.abs(fw.p75));
    const p95 = rss(Math.abs(p.p95), Math.abs(fw.p95));
    const carryUsdM = p.carryUsdM + fw.carryUsdM;
    return {
      ...p,
      carryUsdM,
      p05,
      p25,
      p75,
      p95,
      netP05: p05 + carryUsdM,
      netP50: carryUsdM,
    };
  });
  return {
    ...fx,
    points,
    openPathVarUsdM: rss(fx.openPathVarUsdM, peak),
    criticalCashUsdM: rss(fx.criticalCashUsdM, peak),
    netCriticalCashUsdM: rss(fx.netCriticalCashUsdM, peak),
  };
}
