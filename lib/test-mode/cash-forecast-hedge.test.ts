import { describe, expect, it } from 'vitest';
import { makeSimRow, type RowState } from '@/lib/fx-buffer';
import {
  forecastProfileWithStoreReceivables,
  periodFlowSumLocalM,
  periodFxFlowSumLocalM,
} from '@/lib/forecast-profile';
import { fxHedgeTargetLocalM, type PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import {
  interestBearingCashM,
  nonCashFxStockLocalM,
  withNonCashFxConversion,
  cashForecastCarrySplitByCcyUsdM,
} from '@/lib/test-mode/cash-carry-analytics';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import { getActiveMarketRates } from '@/lib/fx-market-rates';

/** EUR book matching the Cash Carry legend: 2.50 cash, 2.40 NWC, 3.00 debt, 1.20×12 revenue. */
function eurBook(): RowState {
  return {
    ...makeSimRow('e', 'EUR', 2.5, 0, 0, 2.5, 0, 1.2, 0, 0, 0, 0, 3),
    nonCashAsset: 2.4,
  };
}

describe('100% target hedge leaves Debt − Receivables in cash', () => {
  const row = eurBook();
  const T = 12;
  const target = fxHedgeTargetLocalM(row, T);
  const hedge = Array.from({ length: T }, (_, i) => (i === T - 1 ? -target : 0));

  it('the leftover is Debt − Receivables — NWC and debt stay on the BS', () => {
    expect(interestBearingCashM(row)).toBeCloseTo(2.5, 8);
    expect(nonCashFxStockLocalM(row)).toBeCloseTo(2.4 - 3, 8);
    expect(target).toBeCloseTo(2.5 + 2.4 - 3 + 1.2 * 12, 6);
    const cashEnd = 2.5 + 1.2 * 12 + hedge.reduce((s, x) => s + x, 0);
    expect(cashEnd).toBeCloseTo(3 - 2.4, 6);
  });

  it('does not write receivables or debt onto the cash path', () => {
    const settled = withNonCashFxConversion(row, hedge, T);
    expect(settled).toEqual(hedge);
    const cashEnd =
      interestBearingCashM(row) + 1.2 * 12 + settled.reduce((s, x) => s + x, 0);
    expect(cashEnd).toBeCloseTo(3 - 2.4, 6);
  });

  it('leaves the path alone when nothing is hedged', () => {
    const none = Array.from({ length: T }, () => 0);
    expect(withNonCashFxConversion(row, none, T)).toEqual(none);
  });
});

describe('store AR collection is cash, not a second FX hedge', () => {
  const row = eurBook();
  const T = 12;
  const profile = forecastProfileWithStoreReceivables(['EUR']);

  it('keeps 0.2×12 in the cash Σ and out of the FX hedge target', () => {
    expect(periodFlowSumLocalM(row, T, profile)).toBeCloseTo(1.2 * 12 + 0.2 * 12, 6);
    expect(periodFxFlowSumLocalM(row, T, profile)).toBeCloseTo(1.2 * 12, 6);
    expect(fxHedgeTargetLocalM(row, T, profile)).toBeCloseTo(
      2.5 + 2.4 - 3 + 1.2 * 12,
      6,
    );
  });

  it('after 100% hedge, collected AR sits in cash and leftover is remaining debt', () => {
    const target = fxHedgeTargetLocalM(row, T, profile);
    const cashEnd = 2.5 + 1.2 * 12 + 0.2 * 12 - target;
    expect(cashEnd).toBeCloseTo(3.0, 6);
  });
});

function eurStrip(settleA: number, settleB: number): PreparedHedgeProfile {
  return {
    structure: 'strip',
    basis: 'cash',
    ticketBasis: 'stock',
    coverLocalM: 10,
    hedgeRatio: 1,
    legs: [
      {
        index: 0,
        startMonth: 0,
        endMonth: settleA,
        settleMonths: settleA,
        hedgeLocalM: 5,
        tradeNotionalLocalM: 5,
        label: `M${settleA}`,
      },
      {
        index: 1,
        startMonth: settleA,
        endMonth: settleB,
        settleMonths: settleB,
        hedgeLocalM: 10,
        tradeNotionalLocalM: 5,
        label: `M${settleB}`,
      },
    ],
  };
}

describe('cashForecastCarrySplitByCcyUsdM', () => {
  const rows = [eurBook()];
  const marketRatesByCcy = { EUR: getActiveMarketRates() };
  const setup = { ...DEFAULT_VAR_SETUP, forecastMonths: 12 };

  it('leaves unhedged rows on the LP NIM (empty map)', () => {
    expect(
      cashForecastCarrySplitByCcyUsdM({
        rows,
        forecastMonths: 12,
        setup,
        marketRatesByCcy,
      }),
    ).toEqual({});
  });

  it('moves cash interest when a forward strip converts earlier vs later', () => {
    const early = cashForecastCarrySplitByCcyUsdM({
      rows,
      forecastMonths: 12,
      setup,
      marketRatesByCcy,
      preparedByCcy: { EUR: eurStrip(1, 3) },
    }).EUR;
    const late = cashForecastCarrySplitByCcyUsdM({
      rows,
      forecastMonths: 12,
      setup,
      marketRatesByCcy,
      preparedByCcy: { EUR: eurStrip(6, 12) },
    }).EUR;
    expect(early).toBeDefined();
    expect(late).toBeDefined();
    expect(early!.cashUsdM + early!.fwdUsdM).not.toBeCloseTo(
      late!.cashUsdM + late!.fwdUsdM,
      6,
    );
    expect(Math.abs(early!.cashUsdM - late!.cashUsdM)).toBeGreaterThan(1e-6);
    expect(early!.byMonth).toHaveLength(12);
    expect(
      early!.byMonth.reduce((s, m) => s + m.cashUsdM, 0),
    ).toBeCloseTo(early!.cashUsdM, 6);
    expect(
      early!.byMonth.reduce((s, m) => s + m.fwdUsdM, 0),
    ).toBeCloseTo(early!.fwdUsdM, 6);
    // Month-end settle: M1 interest is still on FCY; USD starts the month after.
    expect(
      early!.byMonth.some(
        (m, i) => Math.abs(m.cashUsdM - late!.byMonth[i]!.cashUsdM) > 1e-9,
      ),
    ).toBe(true);
  });
});
