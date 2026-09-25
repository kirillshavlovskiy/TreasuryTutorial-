'use client';

import type { ReactNode } from 'react';
import { FormulaCell } from '@/components/FormulaCell';
import { roundMoney, type RowState } from '@/lib/fx-buffer';
import {
  calcFieldKey,
  effectiveFxAttribution,
  ensureProfileForRows,
  evalPeriodFormula,
  flatLinePeriodSum,
  flowFieldDisplay,
  forecastFlowLinesGrouped,
  forecastFormulaKey,
  forecastFormulaPickToken,
  forecastMonthFlowSeries,
  FX_ATTRIBUTION_SHORT,
  fxAttributionTitle,
  hasFlatGrowthOverride,
  hasFxAttributionOverride,
  lineGrowthMoM,
  lineUncertainty1m,
  nextFxAttribution,
  normalizeExtras,
  periodFormulaScope,
  resizeCalcSeries,
  withFxAttribution,
  type ForecastCalcRow,
  type ForecastCashExtras,
  type ForecastFlowField,
  type ForecastFlowMode,
  type ForecastProfileState,
  type FxAttribution,
} from '@/lib/forecast-profile';
import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildIncomeStatement,
  type BalanceSheetLine,
  type StatementLayerId,
} from '@/lib/statement-layers';

/** Slice of the forecast-profile modal classes this panel paints with. */
export interface StatementPanelUi {
  th: string;
  td: string;
  sectionRow: string;
  input: string;
  growthInherited: string;
  formulaCell: string;
  formulaOverride: string;
  actionBtn: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textNegative: string;
  textValue: string;
  textNet: string;
  netRow: string;
  sigmaSet: string;
  sigmaUnset: string;
}

const FORMULA_SUGGESTIONS = [
  'prev', 'k', 'i', 't', 'rev', 'revenue', 'collections', 'exp', 'expense',
  'payout', 'fcast', 'fcastFX', 'invoice',
  ...Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return [`m${n}`, `rev${n}`, `exp${n}`, `fcast${n}`, `$m${n}`];
  }).flat(),
  'abs', 'min', 'max', 'round', 'sqrt', 'pow', 'exp', 'ln', 'log',
];

function suggestionsFor(calcRows: readonly ForecastCalcRow[]): string[] {
  const refs = calcRows.flatMap(c => [
    c.ref,
    ...Array.from({ length: 6 }, (_, i) => `${c.ref}m${i + 1}`),
  ]);
  return [...refs, ...FORMULA_SUGGESTIONS];
}

function inputText(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(roundMoney(v));
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}

function amountClass(ui: StatementPanelUi, v: number): string {
  return v < 0 ? ui.textNegative : ui.textValue;
}

const TAG_CLASS: Record<FxAttribution, string> = {
  fx: 'border-sky-500/60 text-sky-300',
  book_conversion: 'border-amber-500/70 text-amber-300',
  cash_only: 'border-slate-500 text-slate-300',
};

const TAG_CLASS_LIGHT: Record<FxAttribution, string> = {
  fx: 'border-sky-400 text-sky-800',
  book_conversion: 'border-amber-400 text-amber-800',
  cash_only: 'border-gray-400 text-gray-700',
};

export function FxAttributionButton({
  profile,
  ccy,
  field,
  dark,
  disabled,
  onChange,
}: {
  profile: ForecastProfileState;
  ccy: string;
  field: ForecastFlowField;
  dark: boolean;
  disabled?: boolean;
  onChange?: (profile: ForecastProfileState) => void;
}) {
  const tag = effectiveFxAttribution(profile, ccy, field);
  const explicit = hasFxAttributionOverride(profile, ccy, field);
  const tone = (dark ? TAG_CLASS : TAG_CLASS_LIGHT)[tag];
  const className = `ml-1 rounded border px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${tone}${
    explicit ? '' : ' opacity-80'
  }`;
  const title = fxAttributionTitle(field, tag);
  if (disabled || !onChange) {
    return (
      <span className={className} title={title}>
        {FX_ATTRIBUTION_SHORT[tag]}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${className} hover:brightness-125`}
      title={`${title} · click to cycle FX / Book / Cash`}
      onClick={e => {
        e.stopPropagation();
        onChange(withFxAttribution(profile, ccy, field, nextFxAttribution(tag)));
      }}
    >
      {FX_ATTRIBUTION_SHORT[tag]}
    </button>
  );
}

const OPENING_FIELD: Partial<
  Record<'cash' | 'receivables' | 'debt', 'cash' | 'nonCashAsset' | 'ir_liab_notional'>
> = {
  cash: 'cash',
  receivables: 'nonCashAsset',
  debt: 'ir_liab_notional',
};

const INCOME_FIELDS: {
  field: ForecastFlowField;
  label: string;
  note: string;
}[] = [
  { field: 'collections', label: 'Revenue', note: 'Operating collections' },
  { field: 'invoiceFcast', label: 'Invoice fcast', note: 'Invoice / AR forecast inflow' },
  { field: 'payout', label: 'Operating expenses', note: 'Expenses cash line' },
];

type BalanceSlot =
  | { kind: 'stock'; id: BalanceSheetLine['id'] }
  | { kind: 'flow'; field: ForecastFlowField };

const BALANCE_SLOTS: BalanceSlot[] = [
  { kind: 'stock', id: 'cash' },
  { kind: 'stock', id: 'receivables' },
  { kind: 'flow', field: 'nwcIn' },
  { kind: 'stock', id: 'investments' },
  { kind: 'flow', field: 'investIn' },
  { kind: 'flow', field: 'investOut' },
  { kind: 'stock', id: 'payables' },
  { kind: 'flow', field: 'nwcOut' },
  { kind: 'stock', id: 'debt' },
  { kind: 'flow', field: 'debtIn' },
  { kind: 'flow', field: 'debtOut' },
];

export interface StatementEditApi {
  drafts: Record<string, string>;
  setDraft: (key: string, value: string | null) => void;
  editRow?: (rowId: string, field: 'collections' | 'fcastFX' | 'cash' | 'nonCashAsset' | 'ir_liab_notional', raw: string) => void;
  blurRow?: (rowId: string, field: string) => void;
  onPayout?: (rowId: string, raw: string) => void;
  commitExtra?: (ccy: string, field: keyof ForecastCashExtras, raw: string) => void;
  commitGrowth?: (ccy: string, field: ForecastFlowField, raw: string) => void;
  commitFormula?: (ccy: string, monthIndex: number, field: string, text: string) => void;
  addCalcRow?: (ccy: string) => void;
  removeCalcRow?: (ccy: string, calcId: string) => void;
  renameCalcRow?: (
    ccy: string,
    calcId: string,
    patch: Partial<Pick<ForecastCalcRow, 'label' | 'ref'>>,
    opts?: { trimLabel?: boolean },
  ) => void;
  onOpenUncertainty?: (
    ccy: string,
    field: ForecastFlowField,
    label: string,
    event: React.MouseEvent,
  ) => void;
}

function lineMeta(field: ForecastFlowField) {
  return forecastFlowLinesGrouped().find(l => l.key === field)!;
}

function signedPeriod(
  row: RowState,
  field: ForecastFlowField,
  forecastMonths: number,
  profile: ForecastProfileState,
): number {
  if (profile.mode === 'custom') {
    return roundMoney(
      forecastMonthFlowSeries(row, forecastMonths, profile).reduce(
        (sum, month) => sum + (month[field] ?? 0),
        0,
      ),
    );
  }
  const extras = normalizeExtras(profile.extrasByCcy?.[row.ccy]);
  return flatLinePeriodSum(row, extras, profile, field, forecastMonths);
}

function ForecastInputs({
  row,
  field,
  profile,
  forecastMonths,
  ui,
  dark,
  api,
  onProfile,
}: {
  row: RowState;
  field: ForecastFlowField;
  profile: ForecastProfileState;
  forecastMonths: number;
  ui: StatementPanelUi;
  dark: boolean;
  api: StatementEditApi;
  onProfile?: (profile: ForecastProfileState) => void;
}) {
  if (profile.mode === 'custom') {
    return (
      <CustomMonthCells
        row={row}
        field={field}
        profile={profile}
        forecastMonths={forecastMonths}
        ui={ui}
        dark={dark}
        api={api}
      />
    );
  }
  return (
    <FlatInputs
      row={row}
      field={field}
      profile={profile}
      ui={ui}
      api={api}
      onProfile={onProfile}
    />
  );
}

function FlatInputs({
  row,
  field,
  profile,
  ui,
  api,
  onProfile,
}: {
  row: RowState;
  field: ForecastFlowField;
  profile: ForecastProfileState;
  ui: StatementPanelUi;
  api: StatementEditApi;
  onProfile?: (profile: ForecastProfileState) => void;
}) {
  const line = lineMeta(field);
  const extras = normalizeExtras(profile.extrasByCcy?.[row.ccy]);
  const base = {
    collections: row.collections,
    payout: row.payout,
    invoiceFcast: row.fcastFX ?? 0,
    ...extras,
  };
  const displayNum = flowFieldDisplay(
    { ...base, collections: row.collections, payout: row.payout, invoiceFcast: row.fcastFX ?? 0 },
    field,
    line.side,
  );
  const isExtra = field !== 'collections' && field !== 'payout' && field !== 'invoiceFcast';
  const draftKey = isExtra
    ? `fp.flat.${row.ccy}.${field}`
    : field === 'collections'
      ? `${row.id}.collections`
      : field === 'invoiceFcast'
        ? `${row.id}.fcastFX`
        : `${row.id}.expenseOut`;
  const growthKey = `fp.growth.${row.ccy}.${field}`;
  const growthOverride = hasFlatGrowthOverride(profile, row.ccy, field);
  const lineGrowthPct = lineGrowthMoM(profile, row.ccy, field) * 100;
  const shownGrowth = String(Number(lineGrowthPct.toFixed(2)));
  const defaultGrowthPct = Number(
    ((Number.isFinite(profile.growthRateMoM) ? profile.growthRateMoM : 0) * 100).toFixed(2),
  );
  const locked = !onProfile;

  return (
    <>
      <td className={ui.td}>
        <input
          type="text"
          inputMode="decimal"
          title={line.title}
          disabled={locked}
          className={ui.input}
          value={api.drafts[draftKey] ?? inputText(displayNum)}
          onChange={e => {
            const raw = e.target.value;
            api.setDraft(draftKey, raw);
            if (isExtra) return;
            if (field === 'collections') api.editRow?.(row.id, 'collections', raw);
            else if (field === 'invoiceFcast') api.editRow?.(row.id, 'fcastFX', raw);
            else api.onPayout?.(row.id, raw);
          }}
          onBlur={e => {
            if (isExtra) {
              api.commitExtra?.(row.ccy, field as keyof ForecastCashExtras, e.target.value);
              return;
            }
            if (field === 'collections') api.blurRow?.(row.id, 'collections');
            else if (field === 'invoiceFcast') api.blurRow?.(row.id, 'fcastFX');
            else api.setDraft(draftKey, null);
          }}
        />
      </td>
      <td className={ui.td}>
        <input
          type="text"
          inputMode="decimal"
          title="MoM growth · blank inherits Default g MoM · 0 = no growth"
          disabled={locked}
          placeholder={String(defaultGrowthPct)}
          className={
            growthOverride || api.drafts[growthKey] !== undefined
              ? ui.input
              : ui.growthInherited
          }
          value={api.drafts[growthKey] !== undefined ? api.drafts[growthKey]! : shownGrowth}
          onChange={e => api.setDraft(growthKey, e.target.value)}
          onFocus={e => {
            if (!growthOverride) e.target.select();
          }}
          onBlur={e => {
            const raw = e.target.value.trim();
            if (!growthOverride && api.drafts[growthKey] === undefined) return;
            if (!growthOverride && (raw === '' || raw === shownGrowth)) {
              api.commitGrowth?.(row.ccy, field, '');
              return;
            }
            api.commitGrowth?.(row.ccy, field, e.target.value);
          }}
        />
      </td>
    </>
  );
}

function CustomMonthCells({
  row,
  field,
  profile,
  forecastMonths,
  ui,
  dark,
  api,
}: {
  row: RowState;
  field: ForecastFlowField;
  profile: ForecastProfileState;
  forecastMonths: number;
  ui: StatementPanelUi;
  dark: boolean;
  api: StatementEditApi;
}) {
  const line = lineMeta(field);
  const ensured = ensureProfileForRows(profile, [row], forecastMonths);
  const months = forecastMonthFlowSeries(row, forecastMonths, ensured);
  const calcRows = ensured.calcRowsByCcy?.[row.ccy] ?? [];
  const calcValues = ensured.calcByCcy?.[row.ccy] ?? {};
  const suggestions = suggestionsFor(calcRows);
  return (
    <>
      {months.map((month, mi) => {
        const fKey = forecastFormulaKey(row.ccy, field, mi);
        const storedFormula = profile.formulas[fKey];
        const displayNum = flowFieldDisplay(month, field, line.side);
        const scope = periodFormulaScope(row, months, field, mi, { calcRows, calcValues });
        const cellError = storedFormula
          ? evalPeriodFormula(storedFormula, scope).error
          : undefined;
        const columnKey = `${row.ccy}::${field}`;
        return (
          <FormulaCell
            key={mi}
            tdClass={`${ui.td} ${ui.formulaCell} ${storedFormula ? ui.formulaOverride : ''} ${ui.textValue}`}
            display={fmt(displayNum)}
            formula={storedFormula?.replace(/^=/, '')}
            defaultFormula=""
            onCommit={text => api.commitFormula?.(row.ccy, mi, field, text)}
            error={cellError}
            cellAddress={`${line.label} · M${mi + 1}`}
            evaluateLive={text => {
              const t = text.trim();
              if (!t) return { valid: true, resultLabel: fmt(displayNum) };
              const ev = evalPeriodFormula(t.startsWith('=') ? t : `=${t}`, scope);
              if (ev.error || ev.value == null) return { valid: false, resultLabel: '—' };
              const shown = line.side === 'out' ? Math.abs(ev.value) : ev.value;
              return { valid: true, resultLabel: fmt(shown) };
            }}
            title={`${line.title} · =3.5*idx1 · drag across months`}
            suggestions={suggestions}
            columnKey={columnKey}
            rowKey={String(mi)}
            pickTokenResolver={active =>
              forecastFormulaPickToken(active.columnKey, active.rowKey, columnKey, String(mi), calcRows)
            }
            theme={dark ? 'dark' : 'light'}
          />
        );
      })}
    </>
  );
}

function BlankInputs({
  mode,
  months,
  ui,
}: {
  mode: ForecastFlowMode;
  months: number;
  ui: StatementPanelUi;
}) {
  const n = mode === 'custom' ? months : 2;
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <td key={i} className={ui.td} />
      ))}
    </>
  );
}

function LineName({
  row,
  field,
  label,
  profile,
  ui,
  dark,
  api,
  onProfile,
}: {
  row: RowState;
  field?: ForecastFlowField;
  label: string;
  profile: ForecastProfileState;
  ui: StatementPanelUi;
  dark: boolean;
  api: StatementEditApi;
  onProfile?: (profile: ForecastProfileState) => void;
}) {
  const sigma = field ? lineUncertainty1m(profile, row.ccy, field) : 0;
  return (
    <td
      className={`${ui.td} text-left ${ui.textPrimary}${
        field && api.onOpenUncertainty ? ' cursor-pointer' : ''
      }`}
      title={field ? `${lineMeta(field).title} · click to set 1m projection σ` : undefined}
      onClick={
        field && api.onOpenUncertainty
          ? e => api.onOpenUncertainty!(row.ccy, field, label, e)
          : undefined
      }
    >
      {label}
      {field && api.onOpenUncertainty && (
        <span className={sigma > 0 ? ui.sigmaSet : ui.sigmaUnset} title="Set 1m projection σ">
          {sigma > 0 ? `σ ${(sigma * 100).toFixed(0)}%` : 'σ'}
        </span>
      )}
      {field && (
        <FxAttributionButton
          profile={profile}
          ccy={row.ccy}
          field={field}
          dark={dark}
          disabled={!onProfile}
          onChange={onProfile}
        />
      )}
    </td>
  );
}

function headerInputs(mode: ForecastFlowMode, months: number, ui: StatementPanelUi) {
  if (mode === 'custom') {
    return Array.from({ length: months }, (_, i) => (
      <th key={i} className={ui.th} title="Click to edit · drag corner across months">
        M{i + 1}
      </th>
    ));
  }
  return (
    <>
      <th className={ui.th} title="Monthly amount (M FCY). Outflows entered positive.">
        Monthly
      </th>
      <th className={ui.th} title="MoM growth · blank inherits Default g MoM · 0 = no growth">
        Growth %
      </th>
    </>
  );
}

export function StatementLayerView({
  layer,
  rows,
  forecastMonths,
  profile,
  ui,
  dark,
  api,
  onProfile,
}: {
  layer: StatementLayerId;
  rows: readonly RowState[];
  forecastMonths: number;
  profile: ForecastProfileState;
  ui: StatementPanelUi;
  dark: boolean;
  api: StatementEditApi;
  onProfile?: (profile: ForecastProfileState) => void;
}) {
  const books = rows.filter(r => r.ccy !== 'USD');
  const shared = {
    books,
    forecastMonths,
    profile,
    ui,
    dark,
    api,
    onProfile,
  };
  return (
    <div>
      {layer === 'income' && <IncomeTable {...shared} />}
      {layer === 'balance' && <BalanceTable {...shared} />}
      {layer === 'cashflow' && <CashFlowTable {...shared} />}
    </div>
  );
}

type Shared = {
  books: RowState[];
  forecastMonths: number;
  profile: ForecastProfileState;
  ui: StatementPanelUi;
  dark: boolean;
  api: StatementEditApi;
  onProfile?: (profile: ForecastProfileState) => void;
};

function IncomeTable({ books, forecastMonths, profile, ui, dark, api, onProfile }: Shared) {
  const colSpan = (profile.mode === 'custom' ? forecastMonths : 2) + 4;
  return (
    <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
      <thead className="sticky top-0 z-20">
        <tr>
          <th className={`${ui.th} text-left`}>CCY</th>
          <th className={`${ui.th} text-left`}>Line</th>
          {headerInputs(profile.mode, forecastMonths, ui)}
          <th className={ui.th}>Period</th>
          <th className={`${ui.th} text-left`}>Source</th>
        </tr>
      </thead>
      <tbody>
        {books.flatMap(row => {
          const derived = buildIncomeStatement(row, forecastMonths, profile);
          const body: ReactNode[] = [];
          if (profile.mode === 'custom') {
            body.push(
              <CalcBlock
                key={`${row.id}.calc`}
                row={row}
                colSpan={colSpan}
                padBeforeMonths={0}
                trail={1}
                forecastMonths={forecastMonths}
                profile={profile}
                ui={ui}
                dark={dark}
                api={api}
              />,
            );
          }
          INCOME_FIELDS.forEach((line, i) => {
            body.push(
              <tr key={`${row.id}.${line.field}`}>
                <td className={`${ui.td} text-left font-semibold ${ui.textPrimary}`}>
                  {i === 0 ? row.ccy : ''}
                </td>
                <LineName
                  row={row}
                  field={line.field}
                  label={line.label}
                  profile={profile}
                  ui={ui}
                  dark={dark}
                  api={api}
                  onProfile={onProfile}
                />
                <ForecastInputs
                  row={row}
                  field={line.field}
                  profile={profile}
                  forecastMonths={forecastMonths}
                  ui={ui}
                  dark={dark}
                  api={api}
                  onProfile={onProfile}
                />
                <td className={`${ui.td} ${amountClass(ui, signedPeriod(row, line.field, forecastMonths, profile))}`}>
                  {fmt(signedPeriod(row, line.field, forecastMonths, profile))}
                </td>
                <td className={`${ui.td} text-left ${ui.textMuted}`}>{line.note}</td>
              </tr>,
            );
          });
          for (const line of derived) {
            if (line.id === 'revenue' || line.id === 'expenses') continue;
            body.push(
              <tr key={`${row.id}.${line.id}`} className={line.emphasis ? ui.netRow : ''}>
                <td className={ui.td} />
                <td className={`${ui.td} text-left ${line.emphasis ? ui.textNet : ui.textPrimary}`}>
                  {line.label}
                  {line.memo && (
                    <span className={`ml-1 text-[9px] uppercase tracking-wide ${ui.textMuted}`}>
                      memo
                    </span>
                  )}
                </td>
                <BlankInputs mode={profile.mode} months={forecastMonths} ui={ui} />
                <td className={`${ui.td} ${line.emphasis ? ui.textNet : amountClass(ui, line.amount)}`}>
                  {fmt(line.amount)}
                </td>
                <td className={`${ui.td} text-left ${ui.textMuted}`}>{line.note}</td>
              </tr>,
            );
          }
          return body;
        })}
      </tbody>
    </table>
  );
}

function BalanceTable({ books, forecastMonths, profile, ui, dark, api, onProfile }: Shared) {
  const colSpan = (profile.mode === 'custom' ? forecastMonths : 2) + 5;
  return (
    <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
      <thead className="sticky top-0 z-20">
        <tr>
          <th className={`${ui.th} text-left`}>CCY</th>
          <th className={`${ui.th} text-left`}>Account</th>
          <th className={ui.th}>Opening</th>
          {headerInputs(profile.mode, forecastMonths, ui)}
          <th className={ui.th}>Movement</th>
          <th className={ui.th}>Closing</th>
        </tr>
      </thead>
      <tbody>
        {books.flatMap(row => {
          const view = buildBalanceSheet(row, forecastMonths, profile);
          const byId = Object.fromEntries(view.lines.map(l => [l.id, l])) as Record<
            BalanceSheetLine['id'],
            BalanceSheetLine
          >;
          const body: ReactNode[] = [];
          if (profile.mode === 'custom') {
            body.push(
              <CalcBlock
                key={`${row.id}.calc`}
                row={row}
                colSpan={colSpan}
                padBeforeMonths={1}
                trail={1}
                forecastMonths={forecastMonths}
                profile={profile}
                ui={ui}
                dark={dark}
                api={api}
              />,
            );
          }
          let labeled = false;
          for (const slot of BALANCE_SLOTS) {
            const showCcy = !labeled;
            labeled = true;
            if (slot.kind === 'stock') {
              const line = byId[slot.id];
              const field = OPENING_FIELD[line.id as 'cash' | 'receivables' | 'debt'];
              const draftKey = field ? `${row.id}.${field}` : '';
              body.push(
                <tr key={`${row.id}.${line.id}`}>
                  <td className={`${ui.td} text-left font-semibold ${ui.textPrimary}`}>
                    {showCcy ? row.ccy : ''}
                  </td>
                  <td className={`${ui.td} text-left ${ui.textPrimary}`} title={line.note}>
                    {line.label}
                    {!line.rolled && (
                      <span className={`ml-1 text-[9px] uppercase tracking-wide ${ui.textMuted}`}>
                        not rolled
                      </span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {line.editable && field && api.editRow ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        className={ui.input}
                        title={line.note}
                        value={api.drafts[draftKey] ?? inputText(line.opening)}
                        onChange={e => api.editRow!(row.id, field, e.target.value)}
                        onBlur={() => api.blurRow?.(row.id, field)}
                      />
                    ) : (
                      <span className={amountClass(ui, line.opening)}>{fmt(line.opening)}</span>
                    )}
                  </td>
                  <BlankInputs mode={profile.mode} months={forecastMonths} ui={ui} />
                  <td className={`${ui.td} ${line.movement == null ? ui.textMuted : amountClass(ui, line.movement)}`}>
                    {line.movement == null ? '—' : fmt(line.movement)}
                  </td>
                  <td className={`${ui.td} ${line.closing == null ? ui.textMuted : amountClass(ui, line.closing)}`}>
                    {line.closing == null ? '—' : fmt(line.closing)}
                  </td>
                </tr>,
              );
            } else {
              const meta = lineMeta(slot.field);
              const period = signedPeriod(row, slot.field, forecastMonths, profile);
              body.push(
                <tr key={`${row.id}.${slot.field}`}>
                  <td className={`${ui.td} text-left font-semibold ${ui.textPrimary}`}>
                    {showCcy ? row.ccy : ''}
                  </td>
                  <LineName
                    row={row}
                    field={slot.field}
                    label={meta.label}
                    profile={profile}
                    ui={ui}
                    dark={dark}
                    api={api}
                    onProfile={onProfile}
                  />
                  <td className={ui.td} />
                  <ForecastInputs
                    row={row}
                    field={slot.field}
                    profile={profile}
                    forecastMonths={forecastMonths}
                    ui={ui}
                    dark={dark}
                    api={api}
                    onProfile={onProfile}
                  />
                  <td className={`${ui.td} ${amountClass(ui, period)}`}>{fmt(period)}</td>
                  <td className={ui.td} />
                </tr>,
              );
            }
          }
          body.push(
            <tr key={`${row.id}.tie`} className={ui.netRow}>
              <td className={ui.td} />
              <td className={`${ui.td} text-left ${ui.textSecondary}`} colSpan={colSpan - 1}>
                {view.cashTies
                  ? `Closing cash ${fmt(roundMoney(row.cash + view.netCash))} = opening ${fmt(row.cash)} + net forecast ${fmt(view.netCash)}`
                  : 'Closing cash does not match opening cash plus the net forecast'}
              </td>
            </tr>,
          );
          return body;
        })}
      </tbody>
    </table>
  );
}

function CashFlowTable({ books, forecastMonths, profile, ui, dark, api, onProfile }: Shared) {
  const colSpan = (profile.mode === 'custom' ? forecastMonths : 2) + 5;
  return (
    <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
      <thead className="sticky top-0 z-20">
        <tr>
          <th className={`${ui.th} text-left`}>CCY</th>
          <th className={`${ui.th} text-left`}>Line</th>
          {headerInputs(profile.mode, forecastMonths, ui)}
          <th className={ui.th}>Period Σ</th>
          <th className={`${ui.th} text-left`}>Attribution</th>
          <th className={ui.th}>Of which FX</th>
        </tr>
      </thead>
      <tbody>
        {books.flatMap(row => {
          const view = buildCashFlowStatement(row, forecastMonths, profile);
          const body: ReactNode[] = [];
          if (profile.mode === 'custom') {
            body.push(
              <CalcBlock
                key={`${row.id}.calc`}
                row={row}
                colSpan={colSpan}
                padBeforeMonths={0}
                trail={2}
                forecastMonths={forecastMonths}
                profile={profile}
                ui={ui}
                dark={dark}
                api={api}
              />,
            );
          }
          let lastGroup = '';
          let first = true;
          for (const line of view.lines) {
            if (line.groupId !== lastGroup) {
              lastGroup = line.groupId;
              body.push(
                <tr key={`${row.id}.sec.${line.groupId}`}>
                  <td colSpan={colSpan} className={`${ui.sectionRow} sticky left-0`}>
                    {line.groupLabel}
                  </td>
                </tr>,
              );
            }
            body.push(
              <tr key={`${row.id}.${line.field}`}>
                <td className={`${ui.td} text-left font-semibold ${ui.textPrimary}`}>
                  {first ? row.ccy : ''}
                </td>
                <LineName
                  row={row}
                  field={line.field}
                  label={line.label}
                  profile={profile}
                  ui={ui}
                  dark={dark}
                  api={api}
                  onProfile={onProfile}
                />
                <ForecastInputs
                  row={row}
                  field={line.field}
                  profile={profile}
                  forecastMonths={forecastMonths}
                  ui={ui}
                  dark={dark}
                  api={api}
                  onProfile={onProfile}
                />
                <td className={`${ui.td} ${amountClass(ui, line.signed)}`}>{fmt(line.signed)}</td>
                <td className={`${ui.td} text-left ${ui.textSecondary}`}>
                  {FX_ATTRIBUTION_SHORT[line.attribution]}
                </td>
                <td className={`${ui.td} ${amountClass(ui, line.fx)}`}>{fmt(line.fx)}</td>
              </tr>,
            );
            first = false;
          }
          body.push(
            <tr key={`${row.id}.foot`} className={ui.netRow}>
              <td className={ui.td} />
              <td className={`${ui.td} text-left ${ui.textSecondary}`}>Net cash</td>
              <BlankInputs mode={profile.mode} months={forecastMonths} ui={ui} />
              <td className={`${ui.td} ${ui.textNet}`}>{fmt(view.netCash)}</td>
              <td className={`${ui.td} text-left ${ui.textMuted}`} colSpan={2}>
                FX {fmt(view.fxChanging)} · book / cash-only {fmt(view.nonFx)}
              </td>
            </tr>,
          );
          return body;
        })}
      </tbody>
    </table>
  );
}

function CalcBlock({
  row,
  colSpan,
  padBeforeMonths,
  trail,
  forecastMonths,
  profile,
  ui,
  dark,
  api,
}: {
  row: RowState;
  colSpan: number;
  padBeforeMonths: number;
  trail: number;
  forecastMonths: number;
  profile: ForecastProfileState;
  ui: StatementPanelUi;
  dark: boolean;
  api: StatementEditApi;
}) {
  const ensured = ensureProfileForRows(profile, [row], forecastMonths);
  const calcRows = ensured.calcRowsByCcy?.[row.ccy] ?? [];
  const calcValues = ensured.calcByCcy?.[row.ccy] ?? {};
  const months = forecastMonthFlowSeries(row, forecastMonths, ensured);
  const suggestions = suggestionsFor(calcRows);
  return (
    <>
      <tr>
        <td colSpan={colSpan} className={`${ui.sectionRow} sticky left-0`}>
          <span className="inline-flex items-center gap-2">
            Calculations
            {api.addCalcRow && (
              <button
                type="button"
                className={`${ui.actionBtn} normal-case tracking-normal`}
                title="Temporary index / helper row (not in Net)"
                onClick={() => api.addCalcRow!(row.ccy)}
              >
                + Calc row
              </button>
            )}
          </span>
        </td>
      </tr>
      {calcRows.length === 0 && (
        <tr>
          <td colSpan={colSpan} className={`${ui.td} text-left ${ui.textMuted}`}>
            Optional · e.g. idx1 = <span className="font-mono">pow(1.01, k-1)</span>
          </td>
        </tr>
      )}
      {calcRows.map(calc => {
        const field = calcFieldKey(calc.id);
        const series = resizeCalcSeries(calcValues[calc.id], forecastMonths);
        return (
          <tr key={calc.id}>
            <td className={ui.td} />
            <td className={`${ui.td} text-left`}>
              <div className="flex min-w-0 items-center gap-1">
                <input
                  type="text"
                  className={`min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-left font-mono text-[11px] ${ui.textPrimary} outline-none`}
                  title="Formula ref (idx1)"
                  defaultValue={calc.ref}
                  key={`${calc.id}.ref.${calc.ref}`}
                  disabled={!api.renameCalcRow}
                  onBlur={e => api.renameCalcRow?.(row.ccy, calc.id, { ref: e.target.value })}
                />
                {api.removeCalcRow && (
                  <button
                    type="button"
                    className={`shrink-0 px-1 text-[11px] ${ui.textMuted}`}
                    title="Delete calc row"
                    onClick={() => api.removeCalcRow!(row.ccy, calc.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            </td>
            {Array.from({ length: padBeforeMonths }, (_, i) => (
              <td key={`pad.${i}`} className={ui.td} />
            ))}
            {series.map((val, mi) => {
              const fKey = forecastFormulaKey(row.ccy, field, mi);
              const storedFormula = profile.formulas[fKey];
              const scope = periodFormulaScope(row, months, field, mi, { calcRows, calcValues });
              const columnKey = `${row.ccy}::${field}`;
              return (
                <FormulaCell
                  key={mi}
                  tdClass={`${ui.td} ${ui.formulaCell} ${storedFormula ? ui.formulaOverride : ''} ${ui.textValue}`}
                  display={fmt(val)}
                  formula={storedFormula?.replace(/^=/, '')}
                  defaultFormula=""
                  onCommit={text => api.commitFormula?.(row.ccy, mi, field, text)}
                  error={storedFormula ? evalPeriodFormula(storedFormula, scope).error : undefined}
                  cellAddress={`${calc.ref} · M${mi + 1}`}
                  evaluateLive={text => {
                    const t = text.trim();
                    if (!t) return { valid: true, resultLabel: fmt(val) };
                    const ev = evalPeriodFormula(t.startsWith('=') ? t : `=${t}`, scope);
                    if (ev.error || ev.value == null) return { valid: false, resultLabel: '—' };
                    return { valid: true, resultLabel: fmt(ev.value) };
                  }}
                  title={`${calc.ref} · drag across months`}
                  suggestions={suggestions}
                  columnKey={columnKey}
                  rowKey={String(mi)}
                  pickTokenResolver={active =>
                    forecastFormulaPickToken(active.columnKey, active.rowKey, columnKey, String(mi), calcRows)
                  }
                  theme={dark ? 'dark' : 'light'}
                />
              );
            })}
            <td className={`${ui.td} ${ui.textValue}`}>
              {fmt(series.reduce((s, v) => s + v, 0))}
            </td>
            {Array.from({ length: trail }, (_, i) => (
              <td key={`trail.${i}`} className={ui.td} />
            ))}
          </tr>
        );
      })}
    </>
  );
}
