'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Check, LayoutDashboard, X } from 'lucide-react';
import { INITIAL_ROWS } from '@/lib/fx-buffer';
import {
  OptimizeFrameworkIcon,
  ProtectGoalIcon,
  RateInstrumentIcon,
  RiskAssetIcon,
} from '@/components/RiskTaxonomyIcons';
import {
  OPTIMIZE_FRAMEWORKS,
  PROTECT_GOALS,
  RATE_INSTRUMENTS,
  RISK_ASSETS,
  createRateInstrument,
  defaultRateIndex,
  entityEnabledRiskAssets,
  supportsInstruments,
  tickersFromInstruments,
  type DashboardSetup,
  type Entity,
  type OptimizeFrameworkId,
  type ProtectGoalId,
  type RateInstrument,
  type RateInstrumentKind,
  type RateLegType,
  type RiskAssetId,
} from '@/lib/workspace-store';

const BASE_STEPS = [
  { id: 'asset', label: 'Risk asset' },
  { id: 'protect', label: 'Protect' },
  { id: 'optimize', label: 'Optimize' },
] as const;

const TICKER_STEP = { id: 'tickers', label: 'Tickers' } as const;
const INSTRUMENT_STEP = { id: 'instruments', label: 'Instruments' } as const;

type WizardStep = { id: string; label: string };

const FX_TICKERS = INITIAL_ROWS.map(r => r.ccy);
const RATE_TICKERS = ['SOFR', 'EURIBOR', 'SONIA', 'TONA', 'SARON', 'WIBOR'];
const COMMODITY_TICKERS = ['XAU', 'XAG', 'WTI', 'BRT', 'CU'];
const GENERIC_TICKERS = ['TICK1', 'TICK2', 'TICK3'];

export function tickersForAsset(asset: RiskAssetId): string[] {
  switch (asset) {
    case 'currencies':
      return FX_TICKERS;
    case 'interestRates':
      return RATE_TICKERS;
    case 'commodities':
      return COMMODITY_TICKERS;
    default:
      return GENERIC_TICKERS;
  }
}

/**
 * Opening ticker pick for an asset. Currencies get the majors rather than the
 * first three rows of the buffer, which are alphabetical and arbitrary.
 */
export function defaultTickersForAsset(asset: RiskAssetId): string[] {
  if (asset === 'currencies') {
    const majors = ['EUR', 'GBP', 'JPY'].filter(c => FX_TICKERS.includes(c));
    if (majors.length) return majors;
  }
  return tickersForAsset(asset).slice(0, 3);
}

/** Live frameworks offered for an asset — the wizard's default Optimize pick. */
export function defaultOptimizeForAsset(asset: RiskAssetId): OptimizeFrameworkId[] {
  const live = OPTIMIZE_FRAMEWORKS.filter(
    f => f.live && (!f.assets || f.assets.includes(asset)),
  ).map(f => f.id);
  return live.length ? live : ['var'];
}

export function toggleIn<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
}

const primaryBtn =
  'inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-40';
const ghostBtn =
  'inline-flex items-center gap-2 rounded-md border border-slate-600 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800';

export function CreateDashboardWizard({
  entity,
  onClose,
  onFinish,
  mode = 'create',
  initial,
}: {
  entity: Entity;
  onClose: () => void;
  onFinish: (input: { name?: string; setup: DashboardSetup }) => void;
  mode?: 'create' | 'edit';
  /** Prefill for edit — full wizard workflow (asset → protect → optimize → tickers). */
  initial?: { name: string; setup: DashboardSetup };
}) {
  const enabled = useMemo(() => new Set(entityEnabledRiskAssets(entity)), [entity]);
  const assets = RISK_ASSETS.filter(a => enabled.has(a.id));
  const editing = mode === 'edit';

  const [step, setStep] = useState(0);
  const [riskAsset, setRiskAsset] = useState<RiskAssetId | null>(
    initial?.setup.riskAsset
    ?? assets.find(a => a.id === 'currencies')?.id
    ?? assets[0]?.id
    ?? null,
  );
  const [protect, setProtect] = useState<ProtectGoalId[]>(
    initial?.setup.protect?.length ? [...initial.setup.protect] : ['assetValue', 'cashFlow'],
  );
  const [optimize, setOptimize] = useState<OptimizeFrameworkId[]>(
    initial?.setup.optimize?.length ? [...initial.setup.optimize] : ['var', 'hedgeCarry'],
  );
  const [tickers, setTickers] = useState<string[]>(
    initial?.setup.tickers?.length
      ? [...initial.setup.tickers]
      : defaultTickersForAsset('currencies'),
  );
  const [instruments, setInstruments] = useState<RateInstrument[]>(
    initial?.setup.instruments?.map(i => ({ ...i })) ?? [],
  );
  const [tickerQuery, setTickerQuery] = useState('');
  const [name, setName] = useState(initial?.name ?? '');

  const steps: WizardStep[] = useMemo(
    () => [
      ...BASE_STEPS,
      riskAsset && supportsInstruments(riskAsset) ? INSTRUMENT_STEP : TICKER_STEP,
    ],
    [riskAsset],
  );
  const stepIndex = Math.min(step, steps.length - 1);
  const stepId = steps[stepIndex]?.id ?? 'asset';
  const lastStep = stepIndex === steps.length - 1;

  const currencyOptions = useMemo(() => {
    const base = entity.baseCurrency.toUpperCase();
    return [...new Set([base, 'USD', ...FX_TICKERS])];
  }, [entity.baseCurrency]);

  const indexOptionsFor = (currency: string) => [
    ...new Set(
      [...tickersForAsset('interestRates'), defaultRateIndex(currency)].filter(
        Boolean,
      ) as string[],
    ),
  ];

  const addInstrument = (kind: RateInstrumentKind) =>
    setInstruments(list => [...list, createRateInstrument(kind, entity.baseCurrency.toUpperCase())]);

  const patchInstrument = (uid: string, patch: Partial<RateInstrument>) =>
    setInstruments(list => list.map(i => (i.uid === uid ? { ...i, ...patch } : i)));

  const removeInstrument = (uid: string) =>
    setInstruments(list => list.filter(i => i.uid !== uid));

  const optimizeOptions = useMemo(() => {
    if (!riskAsset) return [];
    return OPTIMIZE_FRAMEWORKS.filter(
      f => !f.assets || f.assets.includes(riskAsset),
    );
  }, [riskAsset]);

  const tickerOptions = useMemo(() => {
    if (!riskAsset) return [];
    const all = tickersForAsset(riskAsset);
    const q = tickerQuery.trim().toUpperCase();
    return q ? all.filter(t => t.includes(q)) : all;
  }, [riskAsset, tickerQuery]);

  const canNext = () => {
    if (stepId === 'asset') return Boolean(riskAsset);
    if (stepId === 'protect') return protect.length >= 1;
    if (stepId === 'optimize') {
      const livePicked = optimize.some(
        id => optimizeOptions.find(o => o.id === id)?.live,
      );
      return optimize.length >= 1 && (livePicked || optimizeOptions.every(o => !o.live));
    }
    if (stepId === 'tickers') return tickers.length >= 1;
    // Instruments are optional, but a half-filled row would persist as junk.
    if (stepId === 'instruments') return instruments.every(instrumentComplete);
    return true;
  };

  const selectAsset = (id: RiskAssetId) => {
    const changing = riskAsset !== id;
    setRiskAsset(id);
    if (changing) {
      setOptimize(defaultOptimizeForAsset(id));
      // Instrument-scoped desks derive their tickers from the legs instead.
      setTickers(supportsInstruments(id) ? [] : defaultTickersForAsset(id));
      if (!supportsInstruments(id)) setInstruments([]);
    }
    const assetLabel = RISK_ASSETS.find(a => a.id === id)?.label ?? 'Dashboard';
    if (!name.trim() || (!editing && changing)) setName(`${assetLabel} desk`);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 border-b border-slate-800/80 bg-slate-900 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-600/15 text-blue-300">
              <LayoutDashboard className="h-5 w-5" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white">
                {editing ? 'Edit dashboard' : 'Create dashboard'}
              </h2>
              <p className="mt-0.5 text-[11px] text-slate-400">
                {entity.name} · risk asset → protect → optimize → tickers
                {editing ? ' · re-run setup workflow' : ''}
              </p>
            </div>
          </div>
          <ol className="mt-3 flex flex-wrap gap-1.5">
            {steps.map((s, i) => {
              const active = i === stepIndex;
              const done = i < stepIndex;
              return (
                <li
                  key={s.id}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                    active
                      ? 'bg-sky-600/30 text-sky-100 ring-1 ring-sky-500/50'
                      : done
                        ? 'bg-slate-800 text-slate-200'
                        : 'bg-slate-950 text-slate-500'
                  }`}
                >
                  {done ? <Check className="h-3 w-3" strokeWidth={2} /> : <span>{i + 1}</span>}
                  {s.label}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {stepId === 'asset' && (
            <StepBlock
              title="Risk asset"
              helper="One dashboard · one risk asset · analysis & hedging."
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {assets.map(a => (
                  <SelectCard
                    key={a.id}
                    selected={riskAsset === a.id}
                    disabled={!a.live && false}
                    onClick={() => selectAsset(a.id)}
                    icon={<RiskAssetIcon id={a.id} />}
                    label={a.label}
                    badge={a.live ? 'Live' : 'Soon'}
                    soon={!a.live}
                  />
                ))}
              </div>
              {assets.length === 0 && (
                <p className="text-[11px] text-amber-300/90">
                  No risk assets enabled on this entity. Use Guided structure or create entity with
                  Cash/FX.
                </p>
              )}
            </StepBlock>
          )}

          {stepId === 'protect' && (
            <StepBlock
              title="Protect"
              helper="What this desk defends. Pick one or more."
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PROTECT_GOALS.map(g => (
                  <SelectCard
                    key={g.id}
                    selected={protect.includes(g.id)}
                    onClick={() => setProtect(toggleIn(protect, g.id))}
                    icon={<ProtectGoalIcon id={g.id} />}
                    label={g.label}
                  />
                ))}
              </div>
            </StepBlock>
          )}

          {stepId === 'optimize' && (
            <StepBlock
              title="Optimize"
              helper="Frameworks / metrics for this asset desk."
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {optimizeOptions.map(f => (
                  <SelectCard
                    key={f.id}
                    selected={optimize.includes(f.id)}
                    onClick={() => setOptimize(toggleIn(optimize, f.id))}
                    icon={<OptimizeFrameworkIcon id={f.id} />}
                    label={f.label}
                    badge={f.live ? 'Live' : 'Soon'}
                    soon={!f.live}
                  />
                ))}
              </div>
            </StepBlock>
          )}

          {stepId === 'tickers' && riskAsset && (
            <StepBlock
              title="Tickers"
              helper="Last step — currencies or asset codes scoped to this desk."
            >
              <NameField
                value={name}
                onChange={setName}
                placeholder={`${RISK_ASSETS.find(a => a.id === riskAsset)?.label ?? 'Asset'} desk`}
              />
              <input
                className="mb-3 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 placeholder-slate-600 focus:border-violet-500 focus:outline-none"
                placeholder="Search tickers…"
                value={tickerQuery}
                onChange={e => setTickerQuery(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {tickerOptions.map(t => {
                  const on = tickers.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTickers(toggleIn(tickers, t))}
                      className={`min-w-[3.25rem] rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                        on
                          ? 'border-violet-500 bg-violet-600/25 text-violet-100'
                          : 'border-slate-700 bg-slate-950/40 text-slate-400 hover:border-slate-500'
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </StepBlock>
          )}

          {stepId === 'instruments' && (
            <StepBlock
              title="Instruments"
              helper="Last step — what this desk holds and hedges with. Each row carries its own currency, index and rate terms."
            >
              <NameField
                value={name}
                onChange={setName}
                placeholder="Rates desk"
              />
              {(['cash', 'derivative'] as const).map(group => (
                <div key={group}>
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    {group === 'cash' ? 'Cash instruments' : 'Rate derivatives'}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {RATE_INSTRUMENTS.filter(i => i.group === group).map(meta => {
                      const count = instruments.filter(i => i.kind === meta.id).length;
                      return (
                        <SelectCard
                          key={meta.id}
                          selected={count > 0}
                          onClick={() => addInstrument(meta.id)}
                          icon={<RateInstrumentIcon id={meta.id} />}
                          label={meta.label}
                          badge={count > 0 ? `${count} added` : 'Add'}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}

              {instruments.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-700 px-3 py-3 text-center text-[11px] text-slate-500">
                  No instruments yet — pick one above, or add them later from Edit setup.
                </p>
              ) : (
                <div className="space-y-2">
                  {instruments.map(inst => (
                    <InstrumentRow
                      key={inst.uid}
                      instrument={inst}
                      currencies={currencyOptions}
                      indices={indexOptionsFor(inst.currency)}
                      onChange={patch => patchInstrument(inst.uid, patch)}
                      onRemove={() => removeInstrument(inst.uid)}
                    />
                  ))}
                </div>
              )}
            </StepBlock>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3">
          <button
            type="button"
            className={ghostBtn}
            onClick={stepIndex === 0 ? onClose : () => setStep(s => s - 1)}
          >
            {stepIndex === 0 ? 'Cancel' : 'Back'}
          </button>
          {!lastStep ? (
            <button
              type="button"
              className={primaryBtn}
              disabled={!canNext()}
              onClick={() => setStep(stepIndex + 1)}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              className={primaryBtn}
              disabled={!canNext() || !riskAsset}
              onClick={() => {
                if (!riskAsset) return;
                const scoped = supportsInstruments(riskAsset);
                onFinish({
                  name: name.trim() || undefined,
                  setup: {
                    riskAsset,
                    protect,
                    optimize,
                    tickers: scoped ? tickersFromInstruments(instruments) : tickers,
                    instruments: scoped && instruments.length ? instruments : undefined,
                  },
                });
              }}
            >
              <Check className="h-4 w-4" strokeWidth={2} />
              {editing ? 'Save dashboard' : 'Create dashboard'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A row is complete once it names what it is and where its rate comes from. */
export function instrumentComplete(inst: RateInstrument): boolean {
  if (!inst.currency.trim()) return false;
  if (inst.rateType === 'floating' && !inst.index?.trim()) return false;
  const meta = RATE_INSTRUMENTS.find(i => i.id === inst.kind);
  if (meta?.dualCurrency) {
    if (!inst.legCurrency?.trim()) return false;
    if (inst.legCurrency === inst.currency) return false;
  }
  return true;
}

function NameField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        Dashboard name
      </label>
      <input
        className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

const fieldClass =
  'rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100 focus:border-sky-500 focus:outline-none';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function InstrumentRow({
  instrument,
  currencies,
  indices,
  onChange,
  onRemove,
}: {
  instrument: RateInstrument;
  currencies: string[];
  indices: string[];
  onChange: (patch: Partial<RateInstrument>) => void;
  onRemove: () => void;
}) {
  const meta = RATE_INSTRUMENTS.find(i => i.id === instrument.kind);
  const floating = instrument.rateType === 'floating';
  const derivative = meta?.group === 'derivative';
  const invalid = !instrumentComplete(instrument);

  const setRateType = (rateType: RateLegType) =>
    onChange({
      rateType,
      // Swapping legs strands the other side's terms, so clear as we go.
      index: rateType === 'floating' ? (instrument.index ?? defaultRateIndex(instrument.currency)) : undefined,
      ratePct: rateType === 'fixed' ? instrument.ratePct : undefined,
      spreadBp: rateType === 'floating' ? instrument.spreadBp : undefined,
    });

  return (
    <div
      className={`rounded-lg border bg-slate-950/60 p-2.5 ${
        invalid ? 'border-amber-600/50' : 'border-slate-800'
      }`}
    >
      <div className="flex items-center gap-2">
        <RateInstrumentIcon id={instrument.kind} className="h-4 w-4 shrink-0 text-slate-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold text-slate-100">
            {meta?.label ?? instrument.kind}
          </div>
          <div className="truncate text-[10px] text-slate-500">{meta?.hint}</div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          title={`Remove ${meta?.label ?? 'instrument'}`}
          aria-label={`Remove ${meta?.label ?? 'instrument'}`}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-500 transition-colors hover:border-rose-500/60 hover:text-rose-400"
        >
          <X className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Field label={meta?.dualCurrency ? 'Pay ccy' : 'Currency'}>
          <select
            className={fieldClass}
            value={instrument.currency}
            onChange={e =>
              onChange({
                currency: e.target.value,
                index: floating ? defaultRateIndex(e.target.value) ?? instrument.index : undefined,
              })
            }
          >
            {currencies.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>

        {meta?.dualCurrency && (
          <Field label="Receive ccy">
            <select
              className={fieldClass}
              value={instrument.legCurrency ?? ''}
              onChange={e => onChange({ legCurrency: e.target.value })}
            >
              <option value="">—</option>
              {currencies.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label={derivative ? 'Pay leg' : 'Rate type'}>
          <div className="flex gap-1">
            {(meta?.rateTypes ?? ['fixed']).map(rt => (
              <button
                key={rt}
                type="button"
                onClick={() => setRateType(rt)}
                className={`rounded-md border px-2 py-1 text-[11px] font-medium capitalize transition-colors ${
                  instrument.rateType === rt
                    ? 'border-sky-500 bg-sky-600/20 text-sky-100'
                    : 'border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500'
                }`}
              >
                {rt}
              </button>
            ))}
          </div>
        </Field>

        {floating ? (
          <>
            <Field label="Index">
              <select
                className={fieldClass}
                value={instrument.index ?? ''}
                onChange={e => onChange({ index: e.target.value })}
              >
                <option value="">—</option>
                {indices.map(i => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
            </Field>
            <Field label="Spread bp">
              <input
                type="number"
                step="1"
                className={`${fieldClass} w-20`}
                placeholder="0"
                value={instrument.spreadBp ?? ''}
                onChange={e =>
                  onChange({ spreadBp: e.target.value === '' ? undefined : Number(e.target.value) })
                }
              />
            </Field>
          </>
        ) : (
          <Field label={instrument.kind === 'swaption' ? 'Strike %' : 'Rate %'}>
            <input
              type="number"
              step="0.05"
              className={`${fieldClass} w-20`}
              placeholder="0.00"
              value={instrument.ratePct ?? ''}
              onChange={e =>
                onChange({ ratePct: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
        )}

        <Field label="Tenor (m)">
          <input
            type="number"
            step="1"
            min="1"
            className={`${fieldClass} w-16`}
            placeholder="12"
            value={instrument.tenorMonths ?? ''}
            onChange={e =>
              onChange({ tenorMonths: e.target.value === '' ? undefined : Number(e.target.value) })
            }
          />
        </Field>
      </div>

      {invalid && (
        <p className="mt-1.5 text-[10px] text-amber-400/90">
          {floating && !instrument.index
            ? 'Pick the index this leg floats off.'
            : 'Receive currency must be set and differ from the pay currency.'}
        </p>
      )}
    </div>
  );
}

export function StepBlock({
  title,
  helper,
  children,
}: {
  title: string;
  helper: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[11px] font-semibold text-slate-100">{title}</h3>
        <p className="mt-0.5 text-[11px] text-slate-500">{helper}</p>
      </div>
      {children}
    </div>
  );
}

export function SelectCard({
  selected,
  onClick,
  icon,
  label,
  badge,
  soon,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  badge?: string;
  soon?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`relative flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        selected
          ? 'border-sky-500 bg-sky-600/15 text-sky-100'
          : soon
            ? 'border-slate-700 bg-slate-950/40 text-slate-400'
            : 'border-slate-700 bg-slate-950/40 text-slate-300 hover:border-slate-500'
      }`}
    >
      {selected && (
        <span className="absolute right-1.5 top-1.5 text-sky-300">
          <Check className="h-3 w-3" strokeWidth={2} />
        </span>
      )}
      <span className={selected ? 'text-sky-300' : 'text-slate-300'}>{icon}</span>
      <span className="text-[11px] font-semibold leading-tight">{label}</span>
      {badge && (
        <span
          className={`text-[9px] font-medium uppercase tracking-wide ${
            soon ? 'text-slate-600' : 'text-slate-500'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
