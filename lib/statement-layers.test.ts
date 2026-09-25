import { describe, expect, it } from 'vitest';
import { makeSimRow, roundMoney, type RowState } from '@/lib/fx-buffer';
import {
  attributeForecastLines,
  DEFAULT_FORECAST_PROFILE,
  EMPTY_FORECAST_EXTRAS,
  forecastMonthFlowSeries,
  forecastProfileWithStoreReceivables,
  monthNet,
  monthlyFxFlowSeriesLocalM,
  normalizeMonthFlow,
  periodFlowSumLocalM,
  periodFxFlowSumLocalM,
  withFxAttribution,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import {
  buildBalanceSheet,
  buildIncomeStatement,
  statementInputFields,
  STATEMENT_LAYER_OPTIONS,
} from '@/lib/statement-layers';

/** The strip as it stood before per-line tags. Defaults must match it. */
function legacyMonthlyFx(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): number[] {
  const months = forecastMonthFlowSeries(row, forecastMonths, profile);
  let nwcLeft = Math.max(0, row.nonCashAsset ?? 0);
  let debtLeft = Math.max(0, row.ir_liab_notional);
  return months.map(m => {
    const n = normalizeMonthFlow(m);
    const convNwc = Math.min(Math.max(0, n.nwcIn), nwcLeft);
    nwcLeft = roundMoney(Math.max(0, nwcLeft - convNwc));
    const repay = Math.min(Math.max(0, -n.debtOut), debtLeft);
    debtLeft = roundMoney(Math.max(0, debtLeft - repay));
    return roundMoney(monthNet(n) - convNwc - n.debtIn + repay);
  });
}

function eurBook(): RowState {
  return {
    ...makeSimRow('e', 'EUR', 2.5, 0, 0, 2.5, 0, 1.2, 0, 0, 0, 0, 3),
    nonCashAsset: 2.4,
  };
}

describe('default FX attribution matches the historical strip', () => {
  it('keeps store AR in cash and out of FX', () => {
    const row = eurBook();
    const profile = forecastProfileWithStoreReceivables(['EUR']);
    expect(monthlyFxFlowSeriesLocalM(row, 12, profile)).toEqual(
      legacyMonthlyFx(row, 12, profile),
    );
    expect(periodFlowSumLocalM(row, 12, profile)).toBeCloseTo(1.2 * 12 + 0.2 * 12, 6);
    expect(periodFxFlowSumLocalM(row, 12, profile)).toBeCloseTo(1.2 * 12, 6);
  });

  it('matches when debt, NWC, and growth all move', () => {
    const row = {
      ...makeSimRow('e', 'EUR', 1, 0, -1.5, 2, -0.4, 1, 0, 0.2, 0, 0, 4),
      nonCashAsset: 2,
    };
    const profile: ForecastProfileState = {
      ...DEFAULT_FORECAST_PROFILE,
      growthRateMoM: 0.05,
      extrasByCcy: {
        EUR: {
          ...EMPTY_FORECAST_EXTRAS,
          nwcIn: 0.5,
          debtIn: 0.1,
          debtOut: -0.4,
          investIn: 0.25,
        },
      },
    };
    expect(monthlyFxFlowSeriesLocalM(row, 12, profile)).toEqual(
      legacyMonthlyFx(row, 12, profile),
    );
  });
});

describe('explicit book conversion', () => {
  const row: RowState = {
    ...makeSimRow('e', 'EUR', 0, 0, 0, 2, 0, 1, 0, 0),
    ir_invest_notional: 5,
  };
  const base: ForecastProfileState = {
    ...DEFAULT_FORECAST_PROFILE,
    extrasByCcy: {
      EUR: { ...EMPTY_FORECAST_EXTRAS, investIn: 0.3 },
    },
  };
  const tagged = withFxAttribution(base, 'EUR', 'investIn', 'book_conversion');

  it('drops Invest in from the FX series and leaves the cash series', () => {
    expect(periodFlowSumLocalM(row, 12, tagged)).toBeCloseTo(
      periodFlowSumLocalM(row, 12, base),
      6,
    );
    expect(periodFxFlowSumLocalM(row, 12, base)).toBeCloseTo((1 + 0.3) * 12, 6);
    expect(periodFxFlowSumLocalM(row, 12, tagged)).toBeCloseTo(1 * 12, 6);
  });

  it('caps the conversion at opening investments', () => {
    const thin = { ...row, ir_invest_notional: 1 };
    const totals = attributeForecastLines(thin, 12, tagged).totals;
    expect(totals.investIn.conversion).toBeCloseTo(1, 6);
    expect(totals.investIn.fx).toBeCloseTo(0.3 * 12 - 1, 6);
    expect(periodFlowSumLocalM(thin, 12, tagged)).toBeCloseTo((1 + 0.3) * 12, 6);
    const bs = buildBalanceSheet(thin, 12, tagged);
    const investments = bs.lines.find(l => l.id === 'investments');
    expect(investments?.rolled).toBe(true);
    expect(investments?.movement).toBeCloseTo(-1, 6);
    expect(investments?.closing).toBeCloseTo(0, 6);
  });
});

describe('statement tabs', () => {
  it('has no Forecast tab; each statement edits its own lines', () => {
    expect(STATEMENT_LAYER_OPTIONS.map(o => o.id)).toEqual([
      'income',
      'balance',
      'cashflow',
    ]);
    expect(statementInputFields('income')).toEqual([
      'collections',
      'payout',
      'invoiceFcast',
    ]);
    expect(statementInputFields('balance')).toEqual([
      'nwcIn',
      'nwcOut',
      'debtIn',
      'debtOut',
      'investIn',
      'investOut',
    ]);
    expect(statementInputFields('cashflow')).toContain('otherIn');
    expect(statementInputFields('cashflow')).toContain('collections');
  });
});

describe('statement readouts', () => {
  it('closes cash at opening plus the net forecast', () => {
    const row = eurBook();
    const profile = forecastProfileWithStoreReceivables(['EUR']);
    const bs = buildBalanceSheet(row, 12, profile);
    const cash = bs.lines.find(l => l.id === 'cash');
    const net = periodFlowSumLocalM(row, 12, profile);
    expect(bs.cashTies).toBe(true);
    expect(cash?.closing).toBeCloseTo(row.cash + net, 6);
    const ar = bs.lines.find(l => l.id === 'receivables');
    expect(ar?.movement).toBeCloseTo(-2.4, 6);
    expect(ar?.closing).toBeCloseTo(0, 6);
    const investments = bs.lines.find(l => l.id === 'investments');
    expect(investments?.rolled).toBe(false);
    expect(investments?.closing).toBeNull();
  });

  it('sets operating profit to collections + invoice forecast + payout', () => {
    const row = makeSimRow('e', 'EUR', 0, 0, 0, 2, -0.4, 1.2, 0, 0.1);
    const lines = buildIncomeStatement(row, 12, DEFAULT_FORECAST_PROFILE);
    const revenue = 1.2 * 12 + 0.1 * 12;
    const expenses = -0.4 * 12;
    expect(lines.find(l => l.id === 'revenue')?.amount).toBeCloseTo(revenue, 6);
    expect(lines.find(l => l.id === 'expenses')?.amount).toBeCloseTo(expenses, 6);
    expect(lines.find(l => l.id === 'operating')?.amount).toBeCloseTo(
      revenue + expenses,
      6,
    );
    expect(lines.find(l => l.id === 'interest-income')?.memo).toBe(true);
  });
});
