// Statement readouts of the forecast cash lines. They do not invent P&L
// lines the book does not have, and they do not change hedge math — FX vs
// cash comes from attributeForecastLines.

import { roundMoney, type RowState } from '@/lib/fx-buffer';
import {
  attributeForecastLines,
  effectiveFxAttribution,
  FORECAST_FLOW_GROUPS,
  FORECAST_FLOW_LINES,
  flowFieldValue,
  periodFlowSumLocalM,
  periodFxFlowSumLocalM,
  type FlowAttributionTotals,
  type ForecastFlowField,
  type ForecastMonthFlow,
  type ForecastProfileState,
  type FxAttribution,
} from '@/lib/forecast-profile';

export type StatementLayerId = 'income' | 'balance' | 'cashflow';

export const STATEMENT_LAYER_OPTIONS: {
  id: StatementLayerId;
  label: string;
  title: string;
}[] = [
  {
    id: 'income',
    label: 'Income',
    title: 'Edit Revenue, Invoice fcast, and Expenses, and read operating profit',
  },
  {
    id: 'balance',
    label: 'Balance sheet',
    title: 'Edit working capital, debt, and investing lines, and roll the stocks',
  },
  {
    id: 'cashflow',
    label: 'Cash flow',
    title: 'Edit every cash line and read the FX versus book-conversion split',
  },
];

const INCOME_GROUP_IDS = new Set(['operating', 'receivables']);
const BALANCE_GROUP_IDS = new Set(['nwc', 'financing', 'investing']);

/** Cash lines edited on this statement. Cash flow keeps the full forecast. */
export function statementInputGroups(layer: StatementLayerId) {
  if (layer === 'cashflow') return FORECAST_FLOW_GROUPS;
  const ids = layer === 'income' ? INCOME_GROUP_IDS : BALANCE_GROUP_IDS;
  return FORECAST_FLOW_GROUPS.filter(g => ids.has(g.id));
}

export function statementInputFields(layer: StatementLayerId): ForecastFlowField[] {
  return statementInputGroups(layer).flatMap(g => [...g.keys]);
}

/** Signed net of the lines this statement edits. */
export function statementMonthNet(
  flow: ForecastMonthFlow,
  layer: StatementLayerId,
): number {
  return roundMoney(
    statementInputFields(layer).reduce(
      (sum, key) => sum + flowFieldValue(flow, key),
      0,
    ),
  );
}

export interface IncomeStatementLine {
  id: string;
  label: string;
  amount: number;
  memo: boolean;
  note: string;
  emphasis?: boolean;
}

export interface BalanceSheetLine {
  id: 'cash' | 'receivables' | 'investments' | 'payables' | 'debt';
  label: string;
  opening: number;
  /** Null when the stock is not driven by a tagged cash line. */
  movement: number | null;
  closing: number | null;
  rolled: boolean;
  note: string;
  /** Opening can be edited on the row. */
  editable: boolean;
}

export interface BalanceSheetView {
  lines: BalanceSheetLine[];
  /** Closing cash equals opening cash plus the net cash forecast. */
  cashTies: boolean;
  netCash: number;
}

export interface CashFlowLine {
  groupId: string;
  groupLabel: string;
  field: ForecastFlowField;
  label: string;
  /** Signed period sum (M FCY). */
  signed: number;
  attribution: FxAttribution;
  fx: number;
}

export interface CashFlowStatementView {
  lines: CashFlowLine[];
  netCash: number;
  /** Hedge flow — periodFxFlowSumLocalM. */
  fxChanging: number;
  /** Net cash minus the hedge flow (book conversion and cash-only). */
  nonFx: number;
}

function lineTotals(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): Record<ForecastFlowField, FlowAttributionTotals> {
  return attributeForecastLines(row, forecastMonths, profile).totals;
}

function nonFx(t: FlowAttributionTotals): number {
  return roundMoney(t.conversion + t.cashOnly);
}

/** Accrual-style interest over Tf. Memo only — not added to cash or FX. */
function interestMemo(notional: number, ratePct: number, months: number): number {
  const n = Number.isFinite(notional) ? notional : 0;
  const r = Number.isFinite(ratePct) ? ratePct : 0;
  if (months <= 0) return 0;
  return roundMoney(n * (r / 100) * (months / 12));
}

function horizonMonths(forecastMonths: number): number {
  return Math.max(
    0,
    Math.floor(
      Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1,
    ),
  );
}

export function buildIncomeStatement(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): IncomeStatementLine[] {
  const totals = lineTotals(row, forecastMonths, profile);
  const revenue = roundMoney(totals.collections.signed + totals.invoiceFcast.signed);
  const expenses = totals.payout.signed;
  const T = horizonMonths(forecastMonths);
  const interestIncome = interestMemo(row.ir_asset_notional, row.ir_asset_rate, T);
  const interestExpense = roundMoney(
    -Math.abs(interestMemo(row.ir_liab_notional, row.ir_liab_rate, T)),
  );
  return [
    {
      id: 'revenue',
      label: 'Revenue',
      amount: revenue,
      memo: false,
      note: 'Collections + invoice forecast',
    },
    {
      id: 'expenses',
      label: 'Operating expenses',
      amount: expenses,
      memo: false,
      note: 'Expenses cash line',
    },
    {
      id: 'operating',
      label: 'Operating profit',
      amount: roundMoney(revenue + expenses),
      memo: false,
      note: 'Revenue + operating expenses',
      emphasis: true,
    },
    {
      id: 'interest-income',
      label: 'Interest income',
      amount: interestIncome,
      memo: true,
      note: 'IR asset × rate over Tf — not in the cash forecast',
    },
    {
      id: 'interest-expense',
      label: 'Interest expense',
      amount: interestExpense,
      memo: true,
      note: 'IR liability × rate over Tf — not in the cash forecast',
    },
  ];
}

export function buildBalanceSheet(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): BalanceSheetView {
  const totals = lineTotals(row, forecastMonths, profile);
  const netCash = periodFlowSumLocalM(row, forecastMonths, profile);
  const cashOpen = roundMoney(row.cash);
  const cashClose = roundMoney(cashOpen + netCash);

  const arMove = roundMoney(-nonFx(totals.nwcIn));
  const arOpen = roundMoney(row.nonCashAsset ?? 0);

  const investTagIn = effectiveFxAttribution(profile, row.ccy, 'investIn');
  const investTagOut = effectiveFxAttribution(profile, row.ccy, 'investOut');
  const investRolled = investTagIn !== 'fx' || investTagOut !== 'fx';
  const investOpen = roundMoney(row.ir_invest_notional ?? 0);
  const investMove = roundMoney(-nonFx(totals.investIn) - nonFx(totals.investOut));

  const payTag = effectiveFxAttribution(profile, row.ccy, 'nwcOut');
  const payRolled = payTag !== 'fx';
  const payOpen = roundMoney(Math.max(0, -(row.nonCash ?? 0)));
  const payMove = nonFx(totals.nwcOut);

  const debtOpen = roundMoney(row.ir_liab_notional ?? 0);
  const debtMove = roundMoney(nonFx(totals.debtIn) + nonFx(totals.debtOut));

  const lines: BalanceSheetLine[] = [
    {
      id: 'cash',
      label: 'Cash',
      opening: cashOpen,
      movement: netCash,
      closing: cashClose,
      rolled: true,
      note: 'Opening cash plus every cash line',
      editable: true,
    },
    {
      id: 'receivables',
      label: 'Receivables',
      opening: arOpen,
      movement: arMove,
      closing: roundMoney(arOpen + arMove),
      rolled: true,
      note: 'Opening receivables minus NWC in that converts the stock',
      editable: true,
    },
    {
      id: 'investments',
      label: 'Investments',
      opening: investOpen,
      movement: investRolled ? investMove : null,
      closing: investRolled ? roundMoney(investOpen + investMove) : null,
      rolled: investRolled,
      note: investRolled
        ? 'Rolled from Invest in / Invest out tagged off FX'
        : 'Not rolled — tag Invest in or Invest out as book conversion',
      editable: false,
    },
    {
      id: 'payables',
      label: 'Payables',
      opening: payOpen,
      movement: payRolled ? payMove : null,
      closing: payRolled ? roundMoney(payOpen + payMove) : null,
      rolled: payRolled,
      note: payRolled
        ? 'Rolled from NWC out tagged off FX'
        : 'Not rolled — tag NWC out as book conversion',
      editable: false,
    },
    {
      id: 'debt',
      label: 'Debt',
      opening: debtOpen,
      movement: debtMove,
      closing: roundMoney(debtOpen + debtMove),
      rolled: true,
      note: 'Draws that are off FX, minus repayments capped at opening debt',
      editable: true,
    },
  ];

  return {
    lines,
    netCash,
    cashTies: cashClose === roundMoney(cashOpen + netCash),
  };
}

export function buildCashFlowStatement(
  row: RowState,
  forecastMonths: number,
  profile?: ForecastProfileState | null,
): CashFlowStatementView {
  const totals = lineTotals(row, forecastMonths, profile);
  const labelByKey = Object.fromEntries(
    FORECAST_FLOW_LINES.map(l => [l.key, l.label]),
  ) as Record<ForecastFlowField, string>;
  const lines: CashFlowLine[] = [];
  for (const group of FORECAST_FLOW_GROUPS) {
    for (const field of group.keys) {
      const t = totals[field];
      lines.push({
        groupId: group.id,
        groupLabel: group.label,
        field,
        label: labelByKey[field],
        signed: t.signed,
        attribution: effectiveFxAttribution(profile, row.ccy, field),
        fx: t.fx,
      });
    }
  }
  const netCash = periodFlowSumLocalM(row, forecastMonths, profile);
  const fxChanging = periodFxFlowSumLocalM(row, forecastMonths, profile);
  return {
    lines,
    netCash,
    fxChanging,
    nonFx: roundMoney(netCash - fxChanging),
  };
}
