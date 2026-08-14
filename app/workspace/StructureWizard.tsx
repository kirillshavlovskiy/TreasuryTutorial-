'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  IconBranches,
  IconBuilding,
  IconCheck,
  IconDashboard,
  IconEntity,
  IconGauge,
} from '@/components/WorkbenchIcons';
import {
  OptimizeFrameworkIcon,
  ProtectGoalIcon,
  RiskAssetIcon,
  TickerGlyph,
} from '@/components/RiskTaxonomyIcons';
import {
  SelectCard,
  StepBlock,
  defaultOptimizeForAsset,
  defaultTickersForAsset,
  tickersForAsset,
  toggleIn,
} from '@/app/workspace/CreateDashboardWizard';
import {
  OPTIMIZE_FRAMEWORKS,
  PROTECT_GOALS,
  RISK_ASSETS,
  type DashboardSetup,
  type OptimizeFrameworkId,
  type ProtectGoalId,
  type RiskAssetId,
  type StructureWizardInput,
  type StructureWizardSubsidiary,
} from '@/lib/workspace-store';

const BASE_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK'];

const STEPS: {
  id: string;
  label: string;
  Icon: (p: { className?: string }) => ReactNode;
}[] = [
  { id: 'parent', label: 'Parent', Icon: IconBuilding },
  { id: 'subsidiaries', label: 'Subsidiaries', Icon: IconBranches },
  { id: 'desks', label: 'Desks', Icon: IconGauge },
  { id: 'result', label: 'Result', Icon: IconCheck },
];

type DraftSub = {
  key: string;
  name: string;
  baseCurrency: string;
  dashboardName: string;
  setup: DashboardSetup;
};

/** Same starting point the create-dashboard wizard offers. */
function defaultDeskSetup(): DashboardSetup {
  return {
    riskAsset: 'currencies',
    protect: ['assetValue', 'cashFlow'],
    optimize: defaultOptimizeForAsset('currencies'),
    tickers: defaultTickersForAsset('currencies'),
  };
}

function newDraft(baseCurrency: string, index: number): DraftSub {
  return {
    key: `sub_${Date.now().toString(36)}_${index}`,
    name: '',
    baseCurrency,
    dashboardName: '',
    setup: defaultDeskSetup(),
  };
}

function deskComplete(s: { name: string; dashboardName: string; setup: DashboardSetup }): boolean {
  const dash = s.dashboardName.trim() || (s.name.trim() ? `${s.name.trim()} FX` : '');
  return (
    Boolean(dash)
    && s.setup.protect.length > 0
    && s.setup.optimize.length > 0
    && s.setup.tickers.length > 0
  );
}

/** Group FX consolidates Cash/FX books, so only a currencies desk unlocks it. */
function feedsGroupFx(s: { setup: DashboardSetup }): boolean {
  return s.setup.riskAsset === 'currencies';
}

const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none';
const primaryBtn =
  'inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-40';
const ghostBtn =
  'inline-flex items-center gap-2 rounded-md border border-slate-600 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-40';

export function StructureWizard({
  onClose,
  onFinish,
}: {
  onClose: () => void;
  onFinish: (input: StructureWizardInput) => void;
}) {
  const [step, setStep] = useState(0);
  const [groupName, setGroupName] = useState('');
  const [reportingCurrency, setReportingCurrency] = useState('USD');
  const [groupDashboardName, setGroupDashboardName] = useState('Group FX (consolidated)');
  const [subs, setSubs] = useState<DraftSub[]>(() => [
    newDraft('EUR', 0),
    newDraft('GBP', 1),
    newDraft('USD', 2),
  ]);
  const [profileIdx, setProfileIdx] = useState(0);

  const namedSubs = useMemo(
    () => subs.filter(s => s.name.trim().length > 0),
    [subs],
  );

  const canNext = () => {
    if (step === 0) return groupName.trim().length > 0;
    if (step === 1) return namedSubs.length >= 1;
    if (step === 2) return namedSubs.every(deskComplete);
    return true;
  };

  const buildInput = (): StructureWizardInput => {
    const subsidiaries: StructureWizardSubsidiary[] = namedSubs.map(s => ({
      name: s.name.trim(),
      baseCurrency: s.baseCurrency,
      dashboardName: s.dashboardName.trim() || `${s.name.trim()} FX`,
      setup: s.setup,
    }));
    return {
      groupName: groupName.trim(),
      reportingCurrency,
      groupDashboardName: groupDashboardName.trim() || 'Group FX (consolidated)',
      subsidiaries,
    };
  };

  const updateSub = (key: string, patch: Partial<DraftSub>) => {
    setSubs(prev => prev.map(s => (s.key === key ? { ...s, ...patch } : s)));
  };

  const updateSetup = (key: string, patch: Partial<DashboardSetup>) => {
    setSubs(prev =>
      prev.map(s => (s.key === key ? { ...s, setup: { ...s.setup, ...patch } } : s)),
    );
  };

  const activeProfile = namedSubs[profileIdx] ?? namedSubs[0];

  /** Changing asset resets the picks that are scoped to it. */
  const selectAsset = (key: string, id: RiskAssetId) => {
    setSubs(prev =>
      prev.map(s =>
        s.key === key && s.setup.riskAsset !== id
          ? {
              ...s,
              setup: {
                ...s.setup,
                riskAsset: id,
                optimize: defaultOptimizeForAsset(id),
                tickers: defaultTickersForAsset(id),
              },
            }
          : s,
      ),
    );
  };

  /** Copy the desk you just built onto every other entity. */
  const applyDeskToAll = () => {
    if (!activeProfile) return;
    const setup = activeProfile.setup;
    setSubs(prev =>
      prev.map(s => ({
        ...s,
        dashboardName: s.dashboardName.trim() || (s.name.trim() ? `${s.name.trim()} FX` : ''),
        setup: {
          riskAsset: setup.riskAsset,
          protect: [...setup.protect],
          optimize: [...setup.optimize],
          tickers: [...setup.tickers],
        },
      })),
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="border-b border-slate-800 px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-600/15 text-blue-300">
                <IconBuilding className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Structure setup</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Parent → subsidiaries → a desk per entity (risk asset · protect · optimize ·
                  tickers).
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <ol className="mt-4 flex flex-wrap gap-2">
            {STEPS.map((s, i) => {
              const Icon = s.Icon;
              const active = i === step;
              const done = i < step;
              return (
                <li
                  key={s.id}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
                    active
                      ? 'bg-blue-600 text-white'
                      : done
                        ? 'bg-slate-700 text-slate-200'
                        : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {i + 1}. {s.label}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <IconBuilding className="mt-0.5 h-5 w-5 text-blue-400" />
                <p className="text-sm text-slate-400">
                  Name the parent / reporting group. Legal entities are added next; Group FX
                  consolidates them once each has a desk with a Cash/FX book.
                </p>
              </div>
              <div>
                <label className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-300">
                  <IconBuilding className="h-4 w-4 text-slate-500" />
                  Parent / group name
                </label>
                <input
                  autoFocus
                  className={inputClass}
                  placeholder="e.g. NordTech Holdings"
                  value={groupName}
                  onChange={e => setGroupName(e.target.value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-300">
                    Reporting currency
                  </label>
                  <select
                    className={inputClass}
                    value={reportingCurrency}
                    onChange={e => setReportingCurrency(e.target.value)}
                  >
                    {BASE_CURRENCIES.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-300">
                    <IconDashboard className="h-4 w-4 text-slate-500" />
                    Group dashboard name
                  </label>
                  <input
                    className={inputClass}
                    value={groupDashboardName}
                    onChange={e => setGroupDashboardName(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <IconBranches className="mt-0.5 h-5 w-5 text-blue-400" />
                <p className="text-sm text-slate-400">
                  Add subsidiaries (legal entities). These become peer entities under the parent,
                  each getting its own desk in the next step.
                </p>
              </div>
              <div className="space-y-3">
                {subs.map((s, i) => (
                  <div
                    key={s.key}
                    className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 sm:grid-cols-[auto_1fr_120px_auto]"
                  >
                    <div className="flex h-10 w-10 items-center justify-center self-end rounded-lg border border-slate-700 bg-slate-900 text-slate-400">
                      <IconEntity className="h-4 w-4" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-400">
                        Entity {i + 1}
                      </label>
                      <input
                        className={inputClass}
                        placeholder="e.g. NordTech GmbH"
                        value={s.name}
                        onChange={e => updateSub(s.key, { name: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-400">Base CCY</label>
                      <select
                        className={inputClass}
                        value={s.baseCurrency}
                        onChange={e => updateSub(s.key, { baseCurrency: e.target.value })}
                      >
                        {BASE_CURRENCIES.map(c => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-end">
                      <button
                        type="button"
                        className={ghostBtn}
                        disabled={subs.length <= 1}
                        onClick={() => setSubs(prev => prev.filter(x => x.key !== s.key))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className={ghostBtn}
                onClick={() =>
                  setSubs(prev => [...prev, newDraft(reportingCurrency, prev.length)])
                }
              >
                + Add subsidiary
              </button>
            </div>
          )}

          {step === 2 && activeProfile && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-start gap-2 text-sm text-slate-400">
                  <IconGauge className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
                  <span>
                    Build one desk per entity — risk asset → protect → optimize → tickers, the
                    same setup the Create dashboard flow runs.
                  </span>
                </div>
                <button
                  type="button"
                  className={ghostBtn}
                  onClick={applyDeskToAll}
                  title="Copy this entity's desk onto every other entity"
                >
                  Apply this desk to all
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {namedSubs.map((s, i) => {
                  const ok = deskComplete(s);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setProfileIdx(i)}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${
                        (namedSubs[profileIdx]?.key ?? namedSubs[0].key) === s.key
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      <IconEntity className="h-3.5 w-3.5" />
                      {s.name.trim()}
                      <span
                        className={`ml-0.5 h-1.5 w-1.5 rounded-full ${
                          ok ? 'bg-emerald-400' : 'bg-amber-400'
                        }`}
                      />
                    </button>
                  );
                })}
              </div>

              <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <div>
                  <label className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-300">
                    <IconDashboard className="h-4 w-4 text-slate-500" />
                    Dashboard name — {activeProfile.name.trim()}
                  </label>
                  <input
                    className={inputClass}
                    placeholder={`${activeProfile.name.trim()} FX`}
                    value={activeProfile.dashboardName}
                    onChange={e =>
                      updateSub(activeProfile.key, { dashboardName: e.target.value })
                    }
                  />
                </div>

                <StepBlock
                  title="Risk asset"
                  helper="One dashboard · one risk asset. Group FX consolidates currencies desks."
                >
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {RISK_ASSETS.map(a => (
                      <SelectCard
                        key={a.id}
                        selected={activeProfile.setup.riskAsset === a.id}
                        onClick={() => selectAsset(activeProfile.key, a.id)}
                        icon={<RiskAssetIcon id={a.id} className="h-6 w-6" />}
                        label={a.label}
                        badge={a.live ? 'Live' : 'Soon'}
                        soon={!a.live}
                      />
                    ))}
                  </div>
                </StepBlock>

                <StepBlock title="Protect" helper="What this desk defends.">
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {PROTECT_GOALS.map(g => (
                      <SelectCard
                        key={g.id}
                        selected={activeProfile.setup.protect.includes(g.id)}
                        onClick={() =>
                          updateSetup(activeProfile.key, {
                            protect: toggleIn<ProtectGoalId>(
                              activeProfile.setup.protect,
                              g.id,
                            ),
                          })
                        }
                        icon={<ProtectGoalIcon id={g.id} className="h-6 w-6" />}
                        label={g.label}
                      />
                    ))}
                  </div>
                </StepBlock>

                <StepBlock title="Optimize" helper="Frameworks this desk runs.">
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {OPTIMIZE_FRAMEWORKS.filter(
                      f => !f.assets || f.assets.includes(activeProfile.setup.riskAsset),
                    ).map(f => (
                      <SelectCard
                        key={f.id}
                        selected={activeProfile.setup.optimize.includes(f.id)}
                        onClick={() =>
                          updateSetup(activeProfile.key, {
                            optimize: toggleIn<OptimizeFrameworkId>(
                              activeProfile.setup.optimize,
                              f.id,
                            ),
                          })
                        }
                        icon={<OptimizeFrameworkIcon id={f.id} className="h-6 w-6" />}
                        label={f.label}
                        badge={f.live ? 'Live' : 'Soon'}
                        soon={!f.live}
                      />
                    ))}
                  </div>
                </StepBlock>

                <StepBlock title="Tickers" helper="Codes scoped to this desk.">
                  <div className="flex flex-wrap gap-2">
                    {tickersForAsset(activeProfile.setup.riskAsset).map(t => {
                      const on = activeProfile.setup.tickers.includes(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            updateSetup(activeProfile.key, {
                              tickers: toggleIn(activeProfile.setup.tickers, t),
                            })
                          }
                          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                            on
                              ? 'border-violet-500 bg-violet-600/25 text-violet-100'
                              : 'border-slate-700 bg-slate-950/40 text-slate-400 hover:border-slate-500'
                          }`}
                        >
                          <TickerGlyph code={t} />
                          {t}
                        </button>
                      );
                    })}
                  </div>
                </StepBlock>
              </div>
            </div>
          )}

          {step === 3 && (
            <ResultPreview input={buildInput()} />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-6 py-4">
          <button type="button" className={ghostBtn} onClick={step === 0 ? onClose : () => setStep(s => s - 1)}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          <div className="flex gap-2">
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                className={primaryBtn}
                disabled={!canNext()}
                onClick={() => {
                  if (step === 1) {
                    setSubs(prev =>
                      prev.map(s => ({
                        ...s,
                        dashboardName:
                          s.dashboardName.trim()
                          || (s.name.trim() ? `${s.name.trim()} FX` : ''),
                      })),
                    );
                    setProfileIdx(0);
                  }
                  setStep(s => s + 1);
                }}
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                className={primaryBtn}
                onClick={() => onFinish(buildInput())}
              >
                <IconCheck className="h-4 w-4" />
                Create structure
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewTags({
  label,
  items,
  tone,
}: {
  label: string;
  items: { key: string; label: string; icon: ReactNode }[];
  tone: string;
}) {
  return (
    <div className="mt-2">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      {items.length === 0 ? (
        <p className="text-[10px] text-slate-600">None selected</p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1">
          {items.map(i => (
            <span
              key={i.key}
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
            >
              {i.icon}
              {i.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultPreview({ input }: { input: StructureWizardInput }) {
  const drafts = input.subsidiaries.map(s => ({
    name: s.name,
    dashboardName: s.dashboardName,
    setup: s.setup ?? defaultDeskSetup(),
  }));
  const ready = drafts.every(s => deskComplete(s) && feedsGroupFx(s));

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <IconCheck className="mt-0.5 h-5 w-5 text-emerald-400" />
        <p className="text-sm text-slate-400">
          The parent consolidated layer unlocks once every subsidiary has a desk with a Cash/FX
          book. Other asset classes still create their desk — they just do not feed Group FX.
        </p>
      </div>

      <div
        className={`rounded-2xl border p-5 ${
          ready
            ? 'border-emerald-700/60 bg-emerald-950/30'
            : 'border-dashed border-slate-600 bg-slate-950/40'
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
              ready
                ? 'border-emerald-600/40 bg-emerald-900/40 text-emerald-300'
                : 'border-slate-700 bg-slate-900 text-slate-400'
            }`}
          >
            <IconBuilding className="h-5 w-5" />
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Parent · consolidated
            </div>
            <h3 className="mt-1 text-xl font-semibold text-white">{input.groupName}</h3>
            <p className="mt-1 text-sm text-slate-300">
              {input.groupDashboardName ?? 'Group FX (consolidated)'} · {input.reportingCurrency}
            </p>
            <p className="mt-3 text-sm">
              {ready ? (
                <span className="text-emerald-300">
                  Group FX unlocked — all {input.subsidiaries.length} entities have dashboard + FX
                  profile.
                </span>
              ) : (
                <span className="text-amber-200">
                  Group FX locked until every entity meets the profile checklist.
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Legal entities
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {input.subsidiaries.map(s => {
          const setup = s.setup ?? defaultDeskSetup();
          const ok = deskComplete({ ...s, setup });
          const asset = RISK_ASSETS.find(a => a.id === setup.riskAsset);
          return (
            <div
              key={s.name}
              className={`rounded-xl border p-4 ${
                ok
                  ? 'border-emerald-800/50 bg-emerald-950/20'
                  : 'border-slate-800 bg-slate-950/50'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-400">
                    <IconEntity className="h-4 w-4" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-white">{s.name}</h4>
                    <p className="text-xs text-slate-400">
                      {s.baseCurrency} · {s.dashboardName}
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    ok ? 'bg-emerald-900/60 text-emerald-300' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {ok ? 'Ready' : 'Incomplete'}
                </span>
              </div>

              <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-300">
                <RiskAssetIcon id={setup.riskAsset} className="h-4 w-4 text-slate-400" />
                {asset?.label ?? setup.riskAsset}
                {!feedsGroupFx({ setup }) && (
                  <span className="text-[10px] text-amber-300/80">· outside Group FX</span>
                )}
              </div>

              <PreviewTags
                label="Protect"
                items={setup.protect.map(id => ({
                  key: id,
                  label: PROTECT_GOALS.find(g => g.id === id)?.label ?? id,
                  icon: <ProtectGoalIcon id={id} className="h-3 w-3" />,
                }))}
                tone="border-rose-700/50 bg-rose-950/40 text-rose-200"
              />
              <PreviewTags
                label="Optimize"
                items={setup.optimize.map(id => ({
                  key: id,
                  label: OPTIMIZE_FRAMEWORKS.find(f => f.id === id)?.label ?? id,
                  icon: <OptimizeFrameworkIcon id={id} className="h-3 w-3" />,
                }))}
                tone="border-emerald-700/50 bg-emerald-950/50 text-emerald-300"
              />
              <PreviewTags
                label="Tickers"
                items={setup.tickers.map(t => ({
                  key: t,
                  label: t,
                  icon: <TickerGlyph code={t} />,
                }))}
                tone="border-violet-700/40 bg-violet-950/30 font-mono text-violet-200"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
