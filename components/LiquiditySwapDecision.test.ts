import { describe, it, expect } from 'vitest';
import {
  clampCoverRatio,
  decisionRowFor,
  scaleDecisionRow,
} from '@/components/LiquiditySwapDecision';
import type { FcyComputedRow } from '@/lib/dashboard-model';
import type { LiquidityCycleProjection } from '@/lib/forecast-profile';

/**
 * Only the fields decisionRowFor / swapLegSchedule actually read — the real
 * types carry the whole layered-buffer / sim-row surface, which is unrelated
 * to this decision math.
 */
function mkPlan(
  cycles: readonly Pick<LiquidityCycleProjection, 'swap_needed' | 'standing_swap' | 'drawdown'>[],
): LiquidityCycleProjection[] {
  return cycles.map((c, cycleIndex) => ({
    cycleIndex,
    ...c,
  })) as unknown as LiquidityCycleProjection[];
}

function mkRow(overrides: {
  ccy: string;
  r_FCY: number;
  cycleDrawdown?: number;
  swapNear?: number;
  liquidityPlan?: LiquidityCycleProjection[];
}): FcyComputedRow {
  return overrides as unknown as FcyComputedRow;
}

describe('decisionRowFor', () => {
  it('returns null when there is no liquidity plan and no row swap', () => {
    const row = mkRow({ ccy: 'ZZZ', r_FCY: 2 });
    expect(decisionRowFor(row, 4)).toBeNull();
  });

  it('proposes a one-leg strip from the row swap a buffer layer just sized', () => {
    const row = mkRow({ ccy: 'ZZZ', r_FCY: 2, swapNear: 6.58 });
    const d = decisionRowFor(row, 4)!;
    expect(d.nearLeg).toBeCloseTo(6.58, 6);
    expect(d.schedule).toHaveLength(1);
    expect(d.schedule[0]!.newLeg).toBeCloseTo(6.58, 6);
    expect(d.schedule[0]!.preBookable).toBe(false);
  });

  it('still stages the buffer-sized swap when the dated plan has not booked a cycle-1 leg', () => {
    const plan = mkPlan([
      { swap_needed: 0, standing_swap: 0, drawdown: 0 },
      { swap_needed: 0, standing_swap: 0, drawdown: 0 },
    ]);
    const d = decisionRowFor(
      mkRow({ ccy: 'ZZZ', r_FCY: 2, swapNear: 6.58, liquidityPlan: plan }),
      4,
    )!;
    expect(d.nearLeg).toBeCloseTo(6.58, 6);
    expect(d.schedule[0]!.newLeg).toBeCloseTo(6.58, 6);
  });

  it('keeps a sell-side (PAY) funding swap instead of dropping it', () => {
    const plan = mkPlan([
      { swap_needed: -4.2, standing_swap: -4.2, drawdown: 0 },
    ]);
    const d = decisionRowFor(
      mkRow({ ccy: 'ZZZ', r_FCY: 1.78, swapNear: -4.2, liquidityPlan: plan }),
      3.5,
    )!;
    expect(d.nearLeg).toBeCloseTo(-4.2, 6);
    expect(d.peakBook).toBeCloseTo(-4.2, 6);
  });

  it('returns null when the plan is empty', () => {
    const row = mkRow({ ccy: 'ZZZ', r_FCY: 2, liquidityPlan: [] });
    expect(decisionRowFor(row, 4)).toBeNull();
  });

  it('sizes the near leg off cycle 0 and the book off the running standing_swap', () => {
    const plan = mkPlan([
      { swap_needed: 10, standing_swap: 10, drawdown: 8 },
      { swap_needed: 5, standing_swap: 15, drawdown: 6 },
      { swap_needed: 0, standing_swap: 15, drawdown: 0 },
    ]);
    const row = mkRow({ ccy: 'ZZZ', r_FCY: 2, cycleDrawdown: 8, liquidityPlan: plan });
    const d = decisionRowFor(row, 4)!;

    expect(d.nearLeg).toBe(10);
    expect(d.peakBook).toBe(15);
    expect(d.endingBook).toBe(15);
    expect(d.cycles).toBe(3);
    // ZZZ is not a recognised currency, so ccySpotRate falls back to 1.
    expect(d.usdFunded).toBe(15);
  });

  it('prices Δr cost on the average outstanding book, not the near leg alone', () => {
    const plan = mkPlan([
      { swap_needed: 10, standing_swap: 10, drawdown: 8 },
      { swap_needed: 10, standing_swap: 20, drawdown: 8 },
    ]);
    const row = mkRow({ ccy: 'ZZZ', r_FCY: 1, liquidityPlan: plan });
    // r_USD − r_FCY = 4 − 1 = 3 (%); avgBook = (10 + 20) / 2 = 15.
    const d = decisionRowFor(row, 4)!;
    expect(d.deltaR).toBe(3);
    expect(d.costUsdYr).toBeCloseTo(15 * (3 / 100), 10);
  });

  it('flags rolling only when the plan has more than one cycle and the last one still drains', () => {
    const repeatingDrain = mkPlan([
      { swap_needed: 10, standing_swap: 10, drawdown: 8 },
      { swap_needed: 10, standing_swap: 20, drawdown: 8 },
    ]);
    expect(
      decisionRowFor(mkRow({ ccy: 'ZZZ', r_FCY: 2, liquidityPlan: repeatingDrain }), 4)!.rolling,
    ).toBe(true);

    const singleCycle = mkPlan([{ swap_needed: 10, standing_swap: 10, drawdown: 8 }]);
    expect(
      decisionRowFor(mkRow({ ccy: 'ZZZ', r_FCY: 2, liquidityPlan: singleCycle }), 4)!.rolling,
    ).toBe(false);

    const runsOff = mkPlan([
      { swap_needed: 10, standing_swap: 10, drawdown: 8 },
      { swap_needed: 0, standing_swap: 10, drawdown: 0 },
    ]);
    expect(
      decisionRowFor(mkRow({ ccy: 'ZZZ', r_FCY: 2, liquidityPlan: runsOff }), 4)!.rolling,
    ).toBe(false);
  });

  it('known limitation: only the last cycle is checked, so a mid-horizon drain that happens to close flat is not flagged rolling', () => {
    // Cycle 1 drains hard and adds a leg; cycle 2 (the last) closes flat.
    // The programme is still a real, repeating drain over the horizon, but
    // the heuristic only reads the last cycle, so it reports non-rolling.
    const troughsEarlyThenFlat = mkPlan([
      { swap_needed: 10, standing_swap: 10, drawdown: 8 },
      { swap_needed: 0, standing_swap: 10, drawdown: 0 },
    ]);
    const d = decisionRowFor(
      mkRow({ ccy: 'ZZZ', r_FCY: 2, liquidityPlan: troughsEarlyThenFlat }),
      4,
    )!;
    expect(d.rolling).toBe(false);
    expect(d.peakBook).toBe(10);
  });
});

describe('clampCoverRatio', () => {
  it('defaults non-finite values to full cover', () => {
    expect(clampCoverRatio(Number.NaN)).toBe(1);
    expect(clampCoverRatio(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('clamps to [0, 1]', () => {
    expect(clampCoverRatio(-0.2)).toBe(0);
    expect(clampCoverRatio(0.4)).toBe(0.4);
    expect(clampCoverRatio(1.8)).toBe(1);
  });
});

describe('scaleDecisionRow', () => {
  it('leaves the proposal unchanged at 100% cover', () => {
    const plan = mkPlan([
      { swap_needed: 10, standing_swap: 10, drawdown: 8 },
      { swap_needed: 5, standing_swap: 15, drawdown: 6 },
    ]);
    const d = decisionRowFor(mkRow({ ccy: 'ZZZ', r_FCY: 2, liquidityPlan: plan }), 4)!;
    expect(scaleDecisionRow(d, 1)).toBe(d);
  });

  it('scales near leg, book, USD, carry, and each schedule amount by cover', () => {
    const plan = mkPlan([
      { swap_needed: 10, standing_swap: 10, drawdown: 8 },
      { swap_needed: 5, standing_swap: 15, drawdown: 6 },
    ]);
    const d = decisionRowFor(mkRow({ ccy: 'ZZZ', r_FCY: 2, liquidityPlan: plan }), 4)!;
    const half = scaleDecisionRow(d, 0.5);
    expect(half.nearLeg).toBeCloseTo(5, 10);
    expect(half.endingBook).toBeCloseTo(7.5, 10);
    expect(half.peakBook).toBeCloseTo(7.5, 10);
    expect(half.usdFunded).toBeCloseTo(d.usdFunded * 0.5, 10);
    expect(half.costUsdYr).toBeCloseTo(d.costUsdYr * 0.5, 10);
    expect(half.schedule[0]!.newLeg).toBeCloseTo(d.schedule[0]!.newLeg * 0.5, 10);
    expect(half.schedule[0]!.outstanding).toBeCloseTo(d.schedule[0]!.outstanding * 0.5, 10);
    expect(half.drawdown).toBe(d.drawdown);
  });

  it('books nothing at 0% cover — remaining delta is 1', () => {
    const plan = mkPlan([{ swap_needed: 10, standing_swap: 10, drawdown: 8 }]);
    const d = decisionRowFor(mkRow({ ccy: 'ZZZ', r_FCY: 2, liquidityPlan: plan }), 4)!;
    const none = scaleDecisionRow(d, 0);
    expect(none.nearLeg).toBe(0);
    expect(none.usdFunded).toBe(0);
  });
});
