import { describe, expect, it } from 'vitest';
import { makeSimRow, type RowState } from '@/lib/fx-buffer';
import { fxHedgeTargetLocalM } from '@/lib/test-mode/hedge-var';
import {
  interestBearingCashM,
  nonCashFxStockLocalM,
  withNonCashFxConversion,
} from '@/lib/test-mode/cash-carry-analytics';

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
