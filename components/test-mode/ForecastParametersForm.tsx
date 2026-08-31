'use client';

import { useState } from 'react';
import {
  BOOKING_MODE_OPTIONS,
  DEFAULT_LIQUIDITY_TIMING,
  LADDER_DAYS_PER_MONTH,
  dayOfMonthForFraction,
  resolveFlowShape,
  resolveLiquidityTiming,
  shapeCycleWindow,
  SIZING_BASIS_OPTIONS,
  type FlowCurve,
  type FlowShape,
  type LiquidityGranularity,
  type LiquidityLineKey,
  type LiquidityTiming,
} from '@/lib/liquidity-ladder';
import {
  EMPTY_FORECAST_EXTRAS,
  ensureProfileForRows,
  flatLinePeriodSum,
  flowFieldDisplay,
  flowFieldFromDisplay,
  FORECAST_FLOW_LINES,
  forecastFlowLinesGrouped,
  lineGrowthMoM,
  normalizeMonthFlow,
  seedMonthsFromRow,
  seedMonthsFromRowWithLineGrowth,
  sumPeriodFlow,
  withFlowField,
  type ForecastFlowField,
  type ForecastFlowMode,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import type { RowState } from '@/lib/fx-buffer';
import {
  FORECAST_PERIOD_OPTIONS,
  FORECAST_UNCERTAINTY_OPTIONS,
  forecastPeriodIdForMonths,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

const GRANULARITY_OPTIONS: { id: LiquidityGranularity; label: string }[] = [
  { id: 'day', label: 'Daily' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' },
];

const SHAPE_PRESETS: {
  id: string;
  label: string;
  title: string;
  shape: FlowShape;
}[] = [
  {
    id: 'start',
    label: 'Start',
    title: 'Settles on the first day of the month',
    shape: { from: 0, to: 0, curve: 'lump' },
  },
  {
    id: 'even',
    label: 'Even',
    title: 'Spread evenly across the month',
    shape: { from: 0, to: 1, curve: 'even' },
  },
  {
    id: 'mid',
    label: 'Mid',
    title: 'Clustered around mid-month',
    shape: { from: 0.4, to: 0.6, curve: 'even' },
  },
  {
    id: 'end',
    label: 'End',
    title: 'Settles on the last day of the month',
    shape: { from: 1, to: 1, curve: 'lump' },
  },
];

const CURVE_OPTIONS: { id: FlowCurve; label: string }[] = [
  { id: 'lump', label: 'Lump' },
  { id: 'even', label: 'Even' },
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
];

const sameShape = (a: FlowShape, b: FlowShape): boolean =>
  a.curve === b.curve
  && Math.abs(a.from - b.from) < 1e-9
  && Math.abs(a.to - b.to) < 1e-9;

const shapeDayFrom = (s: FlowShape): number => dayOfMonthForFraction(s.from) + 1;
const shapeDayTo = (s: FlowShape): number =>
  s.curve === 'lump' ? shapeDayFrom(s) : dayOfMonthForFraction(s.to) + 1;
const dayToFraction = (d: number): number =>
  Math.min(
    LADDER_DAYS_PER_MONTH - 1,
    Math.max(0, Math.round(Number.isFinite(d) ? d : 1) - 1),
  ) / LADDER_DAYS_PER_MONTH;

const DETAIL_LINES: ForecastFlowField[] = [
  'collections',
  'invoiceFcast',
  'payout',
  'nwcIn',
  'nwcOut',
];

const chip = (on: boolean) =>
  `rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
    on
      ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
      : 'text-slate-500 hover:text-slate-300'
  }`;

const inputCls =
  'w-full min-w-[4.5rem] rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-right font-mono text-[11px] text-slate-100 outline-none focus:border-sky-500/60 disabled:opacity-40';

/**
 * FX Risk wizard step 1 — every forecast input that sizes exposure and the
 * dated liquidity trough: Tf, u₁ₘ, cash-flow mode / growth, and cycle timing.
 */
export function ForecastParametersForm({
  setup,
  onSetupChange,
  forecastProfile,
  onForecastProfileChange,
  bookRows = [],
  onRowFieldChange,
  u1m,
  uncertaintyCustom,
  uCustomDraft,
  onUCustomDraftChange,
  onUCustomOpenChange,
  onUncertainty1m,
  onOpenFullProfile,
}: {
  setup: VarSetup;
  onSetupChange: (setup: VarSetup) => void;
  forecastProfile: ForecastProfileState;
  onForecastProfileChange?: (profile: ForecastProfileState) => void;
  bookRows?: readonly RowState[];
  /** Patch a live book amount (Revenue / Expenses / Invoice fcast). */
  onRowFieldChange?: (
    ccy: string,
    field: 'collections' | 'payout' | 'fcastFX',
    value: number,
  ) => void;
  u1m: number;
  uncertaintyCustom: boolean;
  uCustomDraft: string;
  onUCustomDraftChange: (draft: string) => void;
  onUCustomOpenChange: (open: boolean) => void;
  onUncertainty1m: (value: number) => void;
  onOpenFullProfile?: () => void;
}) {
  const [pane, setPane] = useState<'fx' | 'liquidity'>('fx');
  const timing = resolveLiquidityTiming(forecastProfile) ?? DEFAULT_LIQUIDITY_TIMING;
  const months = setup.forecastMonths;
  const customSchedule = forecastProfile.mode === 'custom';
  const growthPct = Number(
    ((Number.isFinite(forecastProfile.growthRateMoM) ? forecastProfile.growthRateMoM : 0) * 100)
      .toFixed(2),
  );
  const fcyRows = bookRows.filter(r => r.ccy !== 'USD');
  const ensured = ensureProfileForRows(forecastProfile, bookRows, months);

  const patchSetup = (partial: Partial<VarSetup>) =>
    onSetupChange({ ...setup, ...partial });

  const setTf = (nextMonths: number) => {
    patchSetup({ forecastMonths: nextMonths });
    if (!onForecastProfileChange) return;
    onForecastProfileChange(
      ensureProfileForRows(forecastProfile, bookRows, nextMonths),
    );
  };

  const setMode = (mode: ForecastFlowMode) => {
    if (!onForecastProfileChange) return;
    if (mode === 'custom') {
      const extrasByCcy = { ...(forecastProfile.extrasByCcy ?? {}) };
      const byCcy: ForecastProfileState['byCcy'] = {};
      for (const r of bookRows) {
        if (r.ccy === 'USD') continue;
        byCcy[r.ccy] = seedMonthsFromRowWithLineGrowth(
          r,
          months,
          forecastProfile,
          extrasByCcy[r.ccy],
        );
      }
      onForecastProfileChange({
        ...forecastProfile,
        mode: 'custom',
        byCcy,
        extrasByCcy,
        formulas: {},
      });
      return;
    }
    onForecastProfileChange({
      ...forecastProfile,
      mode: 'flat',
      extrasByCcy: forecastProfile.extrasByCcy ?? {},
    });
  };

  const setGrowth = (pct: number) => {
    if (!onForecastProfileChange) return;
    const g = Number.isFinite(pct) ? pct / 100 : 0;
    if (forecastProfile.mode === 'custom') {
      const extrasByCcy = { ...(forecastProfile.extrasByCcy ?? {}) };
      const byCcy: ForecastProfileState['byCcy'] = {};
      for (const r of bookRows) {
        if (r.ccy === 'USD') continue;
        byCcy[r.ccy] = seedMonthsFromRowWithLineGrowth(
          r,
          months,
          { ...forecastProfile, growthRateMoM: g },
          extrasByCcy[r.ccy],
        );
      }
      onForecastProfileChange({
        ...forecastProfile,
        growthRateMoM: g,
        byCcy,
        extrasByCcy,
        formulas: {},
      });
      return;
    }
    onForecastProfileChange({ ...forecastProfile, growthRateMoM: g });
  };

  const setTiming = (patch: Partial<LiquidityTiming>) => {
    if (!onForecastProfileChange) return;
    onForecastProfileChange({
      ...forecastProfile,
      liquidity: { ...timing, ...patch },
    });
  };

  const setFlatLine = (ccy: string, field: ForecastFlowField, display: number) => {
    const row = bookRows.find(r => r.ccy === ccy);
    if (!row) return;
    const side = FORECAST_FLOW_LINES.find(l => l.key === field)?.side ?? 'in';
    const signed = flowFieldFromDisplay(display, side);
    if (field === 'collections' || field === 'payout' || field === 'invoiceFcast') {
      const rowField = field === 'invoiceFcast' ? 'fcastFX' : field;
      onRowFieldChange?.(ccy, rowField, signed);
      return;
    }
    if (!onForecastProfileChange) return;
    const extras = {
      ...EMPTY_FORECAST_EXTRAS,
      ...(ensured.extrasByCcy?.[ccy] ?? {}),
      [field]: signed,
    };
    onForecastProfileChange({
      ...ensured,
      extrasByCcy: { ...(ensured.extrasByCcy ?? {}), [ccy]: extras },
    });
  };

  const setCustomMonth = (
    ccy: string,
    monthIndex: number,
    field: ForecastFlowField,
    display: number,
  ) => {
    if (!onForecastProfileChange || months < 1) return;
    const row = bookRows.find(r => r.ccy === ccy);
    if (!row) return;
    const side = FORECAST_FLOW_LINES.find(l => l.key === field)?.side ?? 'in';
    const series = [
      ...(ensured.byCcy[ccy] ??
        seedMonthsFromRow(row, months, 0, ensured.extrasByCcy?.[ccy])),
    ].map(normalizeMonthFlow);
    const signed = flowFieldFromDisplay(display, side);
    series[monthIndex] = withFlowField(series[monthIndex]!, field, signed);
    onForecastProfileChange({
      ...ensured,
      mode: 'custom',
      byCcy: { ...ensured.byCcy, [ccy]: series },
    });
  };

  const periodTfChips = (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-slate-400">
        Forecast period (Tf)
      </div>
      <div
        className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
        role="group"
        aria-label="Forecast period"
      >
        {FORECAST_PERIOD_OPTIONS.map(opt => {
          const on = forecastPeriodIdForMonths(months) === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              title={
                opt.months === 0
                  ? 'No forecast — stock only'
                  : `Revenue path builds for ${opt.months}m`
              }
              onClick={() => setTf(opt.months)}
              className={chip(on)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  const uncertaintyChips = (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-slate-400">
        Incremental forecast uncertainty (1m)
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
          role="group"
          aria-label="Forecast uncertainty"
        >
          {FORECAST_UNCERTAINTY_OPTIONS.map(opt => {
            const on = !uncertaintyCustom && Math.abs(u1m - opt.value) < 1e-12;
            return (
              <button
                key={opt.id}
                type="button"
                title={
                  opt.value === 0
                    ? 'FX path only — no quantity uncertainty on the forecast'
                    : '1m relative vol of monthly flow F'
                }
                disabled={months === 0 || setup.exposureBasis === 'stock'}
                onClick={() => {
                  onUCustomOpenChange(false);
                  onUncertainty1m(opt.value);
                }}
                className={`${chip(on)} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {opt.label}
              </button>
            );
          })}
          <button
            type="button"
            disabled={months === 0 || setup.exposureBasis === 'stock'}
            onClick={() => {
              onUCustomOpenChange(true);
              onUCustomDraftChange(Number((u1m * 100).toFixed(2)).toString());
              if (u1m <= 0) {
                onUCustomDraftChange('15');
                onUncertainty1m(0.15);
              }
            }}
            className={`${chip(uncertaintyCustom)} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            Custom
          </button>
        </div>
        {uncertaintyCustom && (
          <label className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-[11px] text-slate-300">
            <input
              type="number"
              min={0}
              step={0.1}
              disabled={months === 0 || setup.exposureBasis === 'stock'}
              className="w-16 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 text-right font-mono text-[11px] text-slate-100 disabled:opacity-40"
              value={uCustomDraft}
              onChange={e => {
                onUCustomDraftChange(e.target.value);
                const pct = Number(e.target.value);
                if (!Number.isFinite(pct) || pct < 0) return;
                onUCustomOpenChange(true);
                onUncertainty1m(pct / 100);
              }}
            />
            <span className="text-slate-500">%</span>
          </label>
        )}
      </div>
    </div>
  );

  return (
    <section className="space-y-5 rounded-2xl border border-slate-700 bg-slate-950/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-slate-100">
            FX &amp; liquidity forecast
          </h2>
          <p className="mt-1 max-w-[42rem] text-[11px] leading-relaxed text-slate-500">
            {pane === 'fx'
              ? 'Tf, u₁ₘ, cash-flow mode and amounts size FX exposure / CFaR.'
              : 'Intra-cycle timing dates the liquidity trough — not FX CFaR. Open the full grid for per-CCY overrides.'}
            {customSchedule ? ' Custom period grid is on.' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
            role="tablist"
            aria-label="Forecast pane"
          >
            {([
              { id: 'fx' as const, label: 'FX' },
              { id: 'liquidity' as const, label: 'Liquidity' },
            ]).map(opt => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={pane === opt.id}
                onClick={() => setPane(opt.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  pane === opt.id
                    ? 'bg-sky-500/25 text-sky-100 shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {onOpenFullProfile && (
            <button
              type="button"
              disabled={months === 0}
              onClick={onOpenFullProfile}
              title={
                months === 0
                  ? 'Pick a forecast period of 1 month or more'
                  : 'Full Flows + Liquidity grid (formulas, fill-handle)'
              }
              className="h-9 rounded-lg border border-sky-400/50 bg-sky-500/20 px-3 text-[12px] font-semibold text-sky-100 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Open full grid
            </button>
          )}
        </div>
      </div>

      {pane === 'fx' ? (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            FX cash flows
          </div>
          {periodTfChips}
          {uncertaintyChips}
          <div
            className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
            role="group"
            aria-label="Cash-flow mode"
          >
            {([
              { id: 'flat' as const, label: 'Flat formula' },
              { id: 'custom' as const, label: 'Custom by period' },
            ]).map(opt => (
              <button
                key={opt.id}
                type="button"
                disabled={!onForecastProfileChange || months === 0}
                onClick={() => setMode(opt.id)}
                className={`${chip(forecastProfile.mode === opt.id)} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <label className="flex max-w-[16rem] flex-col gap-1">
            <span className="text-[11px] font-medium text-slate-400">
              Default growth MoM
            </span>
            <div className="flex h-10 items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3">
              <input
                type="number"
                step={0.1}
                disabled={!onForecastProfileChange || months === 0}
                value={growthPct}
                onChange={e => setGrowth(Number(e.target.value))}
                className="min-w-0 flex-1 bg-transparent font-mono text-sm text-slate-100 outline-none disabled:opacity-40"
              />
              <span className="text-[12px] text-slate-500">%</span>
            </div>
          </label>
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            Liquidity trough
          </div>
          <label className="inline-flex items-center gap-2 text-[12px] text-slate-300">
            <input
              type="checkbox"
              checked={timing.enabled}
              disabled={!onForecastProfileChange}
              onChange={e => setTiming({ enabled: e.target.checked })}
              className="h-3.5 w-3.5 accent-sky-500"
            />
            Drive trough from intra-cycle timing
          </label>
          <div>
            <div className="mb-1 text-[10px] text-slate-500">Granularity</div>
            <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5">
              {GRANULARITY_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={!onForecastProfileChange}
                  onClick={() => setTiming({ granularity: opt.id })}
                  className={`${chip(timing.granularity === opt.id)} disabled:opacity-40`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] text-slate-500">Sized on</div>
            <div className="inline-flex flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5">
              {SIZING_BASIS_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  title={opt.hint}
                  disabled={!onForecastProfileChange}
                  onClick={() => setTiming({ sizingBasis: opt.id })}
                  className={`${chip((timing.sizingBasis ?? 'horizon') === opt.id)} disabled:opacity-40`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] text-slate-500">Booked as</div>
            <div className="inline-flex flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5">
              {BOOKING_MODE_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  title={opt.hint}
                  disabled={!onForecastProfileChange}
                  onClick={() => setTiming({ bookingMode: opt.id })}
                  className={`${chip((timing.bookingMode ?? 'rolling') === opt.id)} disabled:opacity-40`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {timing.enabled && (
            <>
              <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
                <span>
                  {Math.max(1, months)}m ×{' '}
                  {GRANULARITY_OPTIONS.find(o => o.id === timing.granularity)?.label.toLowerCase()}
                  {' = '}
                  {Math.round(
                    Math.max(1, months)
                    * (LADDER_DAYS_PER_MONTH
                      / (timing.granularity === 'day' ? 1
                        : timing.granularity === 'week' ? 7
                          : 30)),
                  )}{' '}
                  buckets
                </span>
                {(() => {
                  const win = shapeCycleWindow(timing, '');
                  return (
                    <span>
                      cycle window{' '}
                      <span className="text-slate-300">
                        D{win.startDay + 1} → D{win.endDay + 1}
                      </span>
                      {' '}({win.lengthDays}d)
                    </span>
                  );
                })()}
              </div>
              <InlineCycleTimingTable
                timing={timing}
                disabled={!onForecastProfileChange}
                onWriteShape={(field, shape) => {
                  if (!onForecastProfileChange) return;
                  const byField = { ...(timing.byField ?? {}) };
                  if (shape) byField[field] = shape;
                  else delete byField[field];
                  setTiming({ byField });
                }}
              />
            </>
          )}
        </div>
      )}

      {pane === 'fx' && (
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
            Detailed inputs
          </div>
          <span className="text-[10px] text-slate-500">
            {months === 0
              ? 'Pick Tf ≥ 1m to edit the path'
              : customSchedule
                ? `Custom M1…M${months} · amounts in M FCY`
                : `Flat monthly × ${months}m · amounts in M FCY`}
          </span>
        </div>
        {months === 0 || fcyRows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-8 text-center text-[11px] text-slate-500">
            {months === 0
              ? 'No forecast period — stock only. Choose 1 month or more above.'
              : 'No FCY rows on the book yet — add currencies on the simulator first.'}
          </div>
        ) : customSchedule ? (
          <CustomDetailTable
            rows={fcyRows}
            months={months}
            profile={ensured}
            disabled={!onForecastProfileChange}
            onEdit={setCustomMonth}
          />
        ) : (
          <FlatDetailTable
            rows={fcyRows}
            months={months}
            profile={ensured}
            disabled={!onForecastProfileChange && !onRowFieldChange}
            onEditLine={setFlatLine}
          />
        )}
      </div>
      )}
    </section>
  );
}

/** Same From/To/Preset line editor as LiquidityTimingPanel — all-CCY scope. */
function InlineCycleTimingTable({
  timing,
  disabled,
  onWriteShape,
}: {
  timing: LiquidityTiming;
  disabled: boolean;
  onWriteShape: (field: LiquidityLineKey, shape: FlowShape | null) => void;
}) {
  const lines = forecastFlowLinesGrouped();
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="min-w-full border-collapse font-mono text-[10px] tabular-nums">
        <thead>
          <tr className="text-slate-500">
            <th className="px-2 py-1.5 text-left font-semibold">Line</th>
            <th className="px-2 py-1.5 text-right font-semibold">Preset</th>
            <th className="px-2 py-1.5 text-right font-semibold" title="First day of the settlement window">
              From
            </th>
            <th className="px-2 py-1.5 text-right font-semibold" title="Last day of the settlement window">
              To
            </th>
            <th className="px-2 py-1.5 text-right font-semibold">Curve</th>
            <th className="px-2 py-1.5 text-right font-semibold" />
          </tr>
        </thead>
        <tbody>
          {lines.map(line => {
            const field = line.key as LiquidityLineKey;
            const shape = resolveFlowShape(timing, '', field, line.side);
            const overridden = timing.byField?.[field] !== undefined;
            const out = line.side === 'out';
            return (
              <tr key={field} className="border-t border-slate-800/80 text-slate-200">
                <td className={`px-2 py-1 text-left ${out ? 'text-rose-300/90' : 'text-emerald-300/90'}`}>
                  {line.label}
                  <span className="ml-1 text-[9px] text-slate-600">
                    {out ? 'out' : 'in'}
                  </span>
                </td>
                <td className="px-1 py-1">
                  <div className="flex flex-wrap justify-end gap-0.5">
                    {SHAPE_PRESETS.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        title={p.title}
                        disabled={disabled}
                        onClick={() => onWriteShape(field, p.shape)}
                        className={`${chip(sameShape(shape, p.shape))} px-1.5 py-0.5 text-[9px] disabled:opacity-40`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </td>
                <td className="px-1 py-1">
                  <input
                    type="number"
                    min={1}
                    max={LADDER_DAYS_PER_MONTH}
                    disabled={disabled}
                    value={shapeDayFrom(shape)}
                    onChange={e =>
                      onWriteShape(field, {
                        ...shape,
                        from: dayToFraction(Number(e.target.value)),
                      })
                    }
                    className={`${inputCls} w-12`}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="number"
                    min={1}
                    max={LADDER_DAYS_PER_MONTH}
                    disabled={disabled || shape.curve === 'lump'}
                    value={shapeDayTo(shape)}
                    onChange={e =>
                      onWriteShape(field, {
                        ...shape,
                        to: dayToFraction(Number(e.target.value)),
                      })
                    }
                    className={`${inputCls} w-12`}
                  />
                </td>
                <td className="px-1 py-1">
                  <select
                    disabled={disabled}
                    value={shape.curve}
                    onChange={e =>
                      onWriteShape(field, {
                        ...shape,
                        curve: e.target.value as FlowCurve,
                      })
                    }
                    className="w-[4.5rem] rounded border border-slate-700 bg-slate-950 px-1 py-1 text-left font-mono text-[10px] text-slate-100 outline-none disabled:opacity-40"
                  >
                    {CURVE_OPTIONS.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-1 py-1 text-right">
                  {overridden ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onWriteShape(field, null)}
                      title="Drop this line override — inherit the side default"
                      className={`${chip(false)} px-1.5 py-0.5 text-[9px] disabled:opacity-40`}
                    >
                      reset
                    </button>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FlatDetailTable({
  rows,
  months,
  profile,
  disabled,
  onEditLine,
}: {
  rows: readonly RowState[];
  months: number;
  profile: ForecastProfileState;
  disabled: boolean;
  onEditLine: (ccy: string, field: ForecastFlowField, display: number) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
      <table className="min-w-full border-collapse font-mono text-[10px] tabular-nums">
        <thead>
          <tr className="text-slate-500">
            <th className="sticky left-0 z-10 bg-slate-950 px-2.5 py-2 text-left font-semibold">
              CCY
            </th>
            {DETAIL_LINES.map(key => {
              const line = FORECAST_FLOW_LINES.find(l => l.key === key)!;
              return (
                <th
                  key={key}
                  className="px-2 py-2 text-right font-semibold"
                  title={line.title}
                >
                  {line.label}
                  <span className="ml-1 text-slate-600">/mo</span>
                </th>
              );
            })}
            <th className="px-2 py-2 text-right font-semibold">g MoM</th>
            <th className="px-2 py-2 text-right font-semibold">Period Σ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const extras = {
              ...EMPTY_FORECAST_EXTRAS,
              ...(profile.extrasByCcy?.[row.ccy] ?? {}),
            };
            const g = lineGrowthMoM(profile, row.ccy, 'collections');
            const period = DETAIL_LINES.reduce(
              (s, field) => s + flatLinePeriodSum(row, extras, profile, field, months),
              0,
            );
            return (
              <tr key={row.ccy} className="border-t border-slate-800/80 text-slate-200">
                <td className="sticky left-0 z-10 bg-slate-950 px-2.5 py-1.5 font-semibold text-violet-200">
                  {row.ccy}
                </td>
                {DETAIL_LINES.map(field => {
                  const line = FORECAST_FLOW_LINES.find(l => l.key === field)!;
                  const base =
                    field === 'collections' ? row.collections
                      : field === 'payout' ? row.payout
                        : field === 'invoiceFcast' ? (row.fcastFX ?? 0)
                          : extras[field as keyof typeof extras];
                  const fake = normalizeMonthFlow({
                    ...EMPTY_FORECAST_EXTRAS,
                    collections: 0,
                    payout: 0,
                    invoiceFcast: 0,
                    [field]: Number(base) || 0,
                  });
                  const display = flowFieldDisplay(fake, field, line.side);
                  return (
                    <td key={field} className="px-1.5 py-1">
                      <input
                        type="number"
                        step={0.01}
                        disabled={disabled}
                        className={inputCls}
                        value={Number(display.toFixed(4))}
                        onChange={e => {
                          const n = Number(e.target.value);
                          if (!Number.isFinite(n)) return;
                          onEditLine(row.ccy, field, n);
                        }}
                      />
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-right text-slate-400">
                  {(g * 100).toFixed(1)}%
                </td>
                <td className="px-2 py-1.5 text-right font-semibold text-slate-100">
                  {period.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CustomDetailTable({
  rows,
  months,
  profile,
  disabled,
  onEdit,
}: {
  rows: readonly RowState[];
  months: number;
  profile: ForecastProfileState;
  disabled: boolean;
  onEdit: (
    ccy: string,
    monthIndex: number,
    field: ForecastFlowField,
    display: number,
  ) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
      <table className="min-w-full border-collapse font-mono text-[10px] tabular-nums">
        <thead>
          <tr className="text-slate-500">
            <th className="sticky left-0 z-10 bg-slate-950 px-2.5 py-2 text-left font-semibold">
              CCY
            </th>
            <th className="sticky left-[52px] z-10 bg-slate-950 px-2 py-2 text-left font-semibold">
              Line
            </th>
            {Array.from({ length: months }, (_, i) => (
              <th key={i} className="min-w-[64px] px-1.5 py-2 text-right font-semibold">
                M{i + 1}
              </th>
            ))}
            <th className="px-2 py-2 text-right font-semibold">Period Σ</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap(row => {
            const series = (
              profile.byCcy[row.ccy] ??
              seedMonthsFromRow(row, months, 0, profile.extrasByCcy?.[row.ccy])
            ).map(normalizeMonthFlow);
            const periodNet = sumPeriodFlow(series);
            return DETAIL_LINES.map((field, lineIdx) => {
              const line = FORECAST_FLOW_LINES.find(l => l.key === field)!;
              const lineSum = series.reduce(
                (s, m) => s + flowFieldDisplay(m, field, line.side),
                0,
              );
              return (
                <tr
                  key={`${row.ccy}-${field}`}
                  className="border-t border-slate-800/80 text-slate-200"
                >
                  {lineIdx === 0 ? (
                    <td
                      rowSpan={DETAIL_LINES.length}
                      className="sticky left-0 z-10 border-r border-slate-800 bg-slate-950 px-2.5 py-1.5 align-top font-semibold text-violet-200"
                    >
                      {row.ccy}
                      <div className="mt-1 text-[9px] font-normal text-slate-500">
                        net {periodNet.toFixed(2)}
                      </div>
                    </td>
                  ) : null}
                  <td
                    className={`sticky left-[52px] z-10 bg-slate-950 px-2 py-1 ${
                      line.side === 'in' ? 'text-emerald-300/90' : 'text-rose-300/90'
                    }`}
                  >
                    {line.label}
                  </td>
                  {series.map((m, mi) => {
                    const display = flowFieldDisplay(m, field, line.side);
                    return (
                      <td key={mi} className="px-1 py-0.5">
                        <input
                          type="number"
                          step={0.01}
                          disabled={disabled}
                          className={inputCls}
                          value={Number(display.toFixed(4))}
                          onChange={e => {
                            const n = Number(e.target.value);
                            if (!Number.isFinite(n)) return;
                            onEdit(row.ccy, mi, field, n);
                          }}
                        />
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 text-right text-slate-400">
                    {lineSum.toFixed(2)}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}
