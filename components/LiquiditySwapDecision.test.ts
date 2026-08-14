import { describe, it, expect } from 'vitest';
import { decisionRowFor } from '@/components/LiquiditySwapDecision';
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
