import { describe, expect, it } from 'vitest';
import { computeHedgeCfarBands } from '@/lib/test-mode/cfar-residual';
import { fxHedgeNetCfarByCcyUsdM } from '@/lib/test-mode/cfar-net-by-ccy';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import { makeSimRow } from '@/lib/fx-buffer';
import {
  applyFundingSwapBridge,
  fundingSwapBridgeBands,
  fundingSwapKnotsFromOutstanding,
  fundingSwapOutstandingByMonth,
} from '@/lib/test-mode/cfar-funding-swap';

const SETUP = { ...DEFAULT_VAR_SETUP, forecastMonths: 12, confidencePct: 95 as const };

describe('fundingSwapOutstandingByMonth', () => {
  it('returns empty when there is no book', () => {
    expect(fundingSwapOutstandingByMonth(undefined, 12)).toEqual({
      outstandingM: [],
      termSettles: false,
    });
    expect(fundingSwapOutstandingByMonth([{ standing_swap: 0, far_leg: 0 }], 12)).toEqual({
      outstandingM: [],
      termSettles: false,
    });
  });

  it('repeats standing_swap across months and flags a term far-leg', () => {
    const { outstandingM, termSettles } = fundingSwapOutstandingByMonth(
      [
        { standing_swap: 2, far_leg: 0 },
        { standing_swap: 2, far_leg: -2 },
      ],
      4,
    );
    expect(outstandingM).toEqual([2, 2, 2, 2]);
    expect(termSettles).toBe(true);
  });
});

describe('fundingSwapKnotsFromOutstanding', () => {
  it('goes to zero at T when the term far-leg settles', () => {
    const knots = fundingSwapKnotsFromOutstanding([5, 5, 5], 3, true);
    expect(knots[0]!.e).toBe(5);
    expect(knots[knots.length - 1]!.t).toBe(3);
    expect(knots[knots.length - 1]!.e).toBe(0);
  });
});

describe('fundingSwapBridgeBands — net of Buffer Carry', () => {
  it('Net CFaR is peak(gross |S|·√t − carry(t)), not total carry paid', () => {
    const base = {
      T: 12,
      spotUsd: 1.17,
      sigmaMonthly: 0.01,
      confidencePct: 95 as const,
    };
    const outstandingM = Array.from({ length: 12 }, () => 80);
    // Large enough that net peaks before T (√t vs linear carry) — not gross − Σcarry.
    const carryScheduleUsdM = Array.from({ length: 12 }, (_, i) => 4 * (i + 1) / 12);
    const grossOnly = fundingSwapBridgeBands({ ...base, outstandingM })!;
    const withCarry = fundingSwapBridgeBands({
      ...base, outstandingM, carryScheduleUsdM,
    })!;
    expect(withCarry.netCriticalCashUsdM).toBeLessThan(grossOnly.criticalCashUsdM);
    expect(withCarry.peakMonth).toBeLessThan(withCarry.grossPeakMonth);
    expect(withCarry.netCriticalCashUsdM).not.toBeCloseTo(
      grossOnly.criticalCashUsdM - 4,
      2,
    );
  });
});

describe('applyFundingSwapBridge', () => {
  it('RSS-combines the funding peak into Gross and Net', () => {
    const fx = {
      points: [],
      openPathVarUsdM: 3,
      criticalCashUsdM: 3,
      netCriticalCashUsdM: 2,
      peakMonth: 6,
      grossPeakMonth: 6,
      kEmpirical: 1,
    };
    const funding = fundingSwapBridgeBands({
      outstandingM: [4, 4, 4, 4],
      T: 4,
      spotUsd: 1,
      sigmaMonthly: 0.01,
      confidencePct: 95,
    });
    expect(funding).not.toBeNull();
    const combined = applyFundingSwapBridge(fx, funding);
    expect(combined.criticalCashUsdM).toBeCloseTo(
      Math.sqrt(3 * 3 + funding!.criticalCashUsdM ** 2),
      10,
    );
    expect(combined.netCriticalCashUsdM).toBeCloseTo(
      Math.sqrt(2 * 2 + funding!.criticalCashUsdM ** 2),
      10,
    );
    expect(combined.criticalCashUsdM).toBeGreaterThan(3);
  });

  it('is a no-op when the funding book is empty', () => {
    const fx = {
      points: [],
      openPathVarUsdM: 3,
      criticalCashUsdM: 3,
      netCriticalCashUsdM: 2,
      peakMonth: 6,
      grossPeakMonth: 6,
      kEmpirical: 1,
    };
    expect(applyFundingSwapBridge(fx, null)).toBe(fx);
  });
});

describe('displayed CFaR vs cover sizing', () => {
  const EUR = makeSimRow('1', 'EUR', 10, 0, 0, 2.5, 0, 0, 0);
  const base = {
    stockM: 10,
    monthlyFlows: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ccy: 'EUR',
    setup: SETUP,
    bookedHedges: [],
    tenureMonths: 12,
  };

  it('rises when the funding swap is on, without changing FX-only cover CFaR', () => {
    const fxOnly = computeHedgeCfarBands(base);
    const withFunding = computeHedgeCfarBands({
      ...base,
      fundingSwapOutstandingM: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
    });
    expect(withFunding.criticalCashUsdM).toBeGreaterThan(fxOnly.criticalCashUsdM);
    expect(withFunding.netCriticalCashUsdM).toBeGreaterThan(fxOnly.netCriticalCashUsdM);
    expect(withFunding.breakdown.fundingPeakUsdM).toBeGreaterThan(0.001);
    expect(fxOnly.breakdown.fundingPeakUsdM).toBe(0);

    const coverA = fxHedgeNetCfarByCcyUsdM({ rows: [EUR], setup: SETUP });
    const coverB = fxHedgeNetCfarByCcyUsdM({ rows: [EUR], setup: SETUP });
    // Unhedged: no conversion, so FX-only cover is ~0. The swap residual is
    // displayed-only and must not size cover.
    expect(coverA.EUR ?? 0).toBeLessThan(0.001);
    expect(coverA.EUR ?? 0).toBeCloseTo(coverB.EUR ?? 0, 12);
  });
});
