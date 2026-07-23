'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { INITIAL_ROWS } from '@/lib/fx-buffer';
import { Simulator } from '@/app/dashboard/Simulator';
import {
  loadWorkspace,
  saveWorkspace,
  createEntity,
  createDashboard,
  createRiskProfile,
  deleteEntity,
  deleteDashboard,
  deleteRiskProfile,
  metricsToLayers,
  updateDashboardTiming,
  updateDashboardFormula,
  resolveTimingFractions,
  DEFAULT_TIMING,
  RISK_PROFILE_TYPES,
  FX_INPUTS,
  OPT_METRICS,
  type Workspace,
  type Entity,
  type Dashboard,
  type RiskProfileType,
  type FxInput,
  type OptMetric,
  type TimingProfile,
  type FlowTiming,
} from '@/lib/workspace-store';

const SIM_CURRENCIES = INITIAL_ROWS.map(r => r.ccy);
const BASE_CURRENCIES = ['USD', ...[...SIM_CURRENCIES].sort()];

interface WorkspaceAppProps {
  userKey: string;
  userName: string;
  accountMenu: ReactNode;
}

type Modal =
  | { kind: 'none' }
  | { kind: 'entity' }
  | { kind: 'dashboard' }
  | { kind: 'profile' };

export function WorkspaceApp({ userKey, userName, accountMenu }: WorkspaceAppProps) {
  const [workspace, setWorkspace] = useState<Workspace>({ entities: [] });
  const [loaded, setLoaded] = useState(false);

  const [entityId, setEntityId] = useState<string | null>(null);
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });

  useEffect(() => {
    setWorkspace(loadWorkspace(userKey));
    setLoaded(true);
  }, [userKey]);

  const update = (next: Workspace) => {
    setWorkspace(next);
    saveWorkspace(userKey, next);
  };

  const entity: Entity | undefined = useMemo(
    () => workspace.entities.find(e => e.id === entityId),
    [workspace, entityId],
  );
  const dashboard: Dashboard | undefined = useMemo(
    () => entity?.dashboards.find(d => d.id === dashboardId),
    [entity, dashboardId],
  );

  const wide = Boolean(dashboard);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className={`mx-auto flex items-center justify-between px-6 py-4 ${wide ? 'max-w-screen-2xl' : 'max-w-6xl'}`}>
          <BrandMark href="/workspace" label="Treasury Workbench" />
          {accountMenu}
        </div>
      </header>

      <main className={`mx-auto px-6 py-8 ${wide ? 'max-w-screen-2xl' : 'max-w-6xl'}`}>
        <Breadcrumb
          entity={entity}
          dashboard={dashboard}
          onHome={() => { setEntityId(null); setDashboardId(null); }}
          onEntity={() => setDashboardId(null)}
        />

        {!loaded ? (
          <p className="mt-10 text-slate-400">Loading your workspace…</p>
        ) : !entity ? (
          <EntitiesView
            userName={userName}
            entities={workspace.entities}
            onOpen={id => { setEntityId(id); setDashboardId(null); }}
            onCreate={() => setModal({ kind: 'entity' })}
            onDelete={id => update(deleteEntity(workspace, id))}
          />
        ) : !dashboard ? (
          <DashboardsView
            entity={entity}
            onOpen={id => { setDashboardId(id); setActiveProfileId(null); }}
            onCreate={() => setModal({ kind: 'dashboard' })}
            onDelete={id => update(deleteDashboard(workspace, entity.id, id))}
          />
        ) : (
          <DashboardView
            entity={entity}
            dashboard={dashboard}
            activeProfileId={activeProfileId}
            onSelect={setActiveProfileId}
            onAdd={() => setModal({ kind: 'profile' })}
            onDelete={id => update(deleteRiskProfile(workspace, entity.id, dashboard.id, id))}
            onTimingChange={t => update(updateDashboardTiming(workspace, entity.id, dashboard.id, t))}
            onFormulaChange={(cellKey, formula) => update(updateDashboardFormula(workspace, entity.id, dashboard.id, cellKey, formula))}
          />
        )}
      </main>

      {modal.kind === 'entity' && (
        <EntityModal
          onClose={() => setModal({ kind: 'none' })}
          onCreate={input => {
            const { workspace: ws, entity: created } = createEntity(workspace, input);
            update(ws);
            setEntityId(created.id);
            setDashboardId(null);
            setModal({ kind: 'none' });
          }}
        />
      )}

      {modal.kind === 'dashboard' && entity && (
        <DashboardModal
          onClose={() => setModal({ kind: 'none' })}
          onCreate={name => {
            const { workspace: ws, dashboard: created } = createDashboard(workspace, entity.id, name);
            update(ws);
            setDashboardId(created.id);
            setModal({ kind: 'none' });
          }}
        />
      )}

      {modal.kind === 'profile' && entity && dashboard && (
        <ProfileWizard
          onClose={() => setModal({ kind: 'none' })}
          onCreate={(input) => {
            // FX first so its tab becomes active; then the rest.
            const orderedTypes = [...input.types].sort(
              (a, b) => (a === 'fx' ? -1 : 0) - (b === 'fx' ? -1 : 0),
            );
            let ws = workspace;
            let firstId: string | null = null;
            for (const type of orderedTypes) {
              const label = RISK_PROFILE_TYPES.find(t => t.id === type)?.label ?? type;
              const existing = ws.entities
                .find(e => e.id === entity.id)?.dashboards
                .find(d => d.id === dashboard.id)?.riskProfiles
                .filter(p => p.type === type).length ?? 0;
              const name = existing === 0 ? label : `${label} ${existing + 1}`;
              const res = createRiskProfile(ws, entity.id, dashboard.id, {
                type,
                name,
                fxConfig: type === 'fx' ? input.fxConfig : undefined,
              });
              ws = res.workspace;
              if (!firstId) firstId = res.profile.id;
            }
            update(ws);
            setModal({ kind: 'none' });
            if (firstId) setActiveProfileId(firstId);
          }}
        />
      )}
    </div>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────────────────

function Breadcrumb({
  entity, dashboard, onHome, onEntity,
}: {
  entity?: Entity;
  dashboard?: Dashboard;
  onHome: () => void;
  onEntity: () => void;
}) {
  return (
    <nav className="mb-6 flex items-center gap-2 text-sm text-slate-400">
      <button onClick={onHome} className="hover:text-white">Entities</button>
      {entity && (
        <>
          <span className="text-slate-600">/</span>
          <button onClick={onEntity} className="hover:text-white">{entity.name}</button>
        </>
      )}
      {dashboard && (
        <>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200">{dashboard.name}</span>
        </>
      )}
    </nav>
  );
}

// ── Entities ────────────────────────────────────────────────────────────────

function EntitiesView({
  userName, entities, onOpen, onCreate, onDelete,
}: {
  userName: string;
  entities: Entity[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  if (entities.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-10 text-center">
        <div className="mb-4 text-4xl">🏛️</div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {userName}!</h1>
        <p className="mx-auto mt-3 max-w-lg text-slate-400">
          Let&apos;s get started. Create your first <strong className="text-slate-200">entity</strong> —
          a legal entity or business unit you manage treasury risk for.
        </p>
        <button
          onClick={onCreate}
          className="mt-8 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >
          + Create your first entity
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Entities</h1>
          <p className="text-sm text-slate-400">Select an entity to manage its dashboards.</p>
        </div>
        <button
          onClick={onCreate}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >
          + New entity
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entities.map(e => (
          <Card
            key={e.id}
            title={e.name}
            meta={`${e.baseCurrency} · ${e.dashboards.length} dashboard${e.dashboards.length === 1 ? '' : 's'}`}
            description={e.description}
            onOpen={() => onOpen(e.id)}
            onDelete={() => onDelete(e.id)}
          />
        ))}
      </div>
    </>
  );
}

// ── Dashboards ────────────────────────────────────────────────────────────

function DashboardsView({
  entity, onOpen, onCreate, onDelete,
}: {
  entity: Entity;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{entity.name} · Dashboards</h1>
          <p className="text-sm text-slate-400">Create a dashboard to group risk profiles.</p>
        </div>
        <button
          onClick={onCreate}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >
          + New dashboard
        </button>
      </div>
      {entity.dashboards.length === 0 ? (
        <EmptyState
          icon="📋"
          title="No dashboards yet"
          body="Create a dashboard for this entity, then add FX, bonds, equities or commodities risk profiles."
          cta="+ Create dashboard"
          onCta={onCreate}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {entity.dashboards.map(d => (
            <Card
              key={d.id}
              title={d.name}
              meta={`${d.riskProfiles.length} risk profile${d.riskProfiles.length === 1 ? '' : 's'}`}
              onOpen={() => onOpen(d.id)}
              onDelete={() => onDelete(d.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ── Dashboard: risk-section tabs ─────────────────────────────────────────────

const TYPE_ICON: Record<RiskProfileType, string> = {
  fx: '💱',
  bonds: '📈',
  investments: '🏦',
  equities: '📊',
  commodities: '🛢️',
};

function DashboardView({
  entity, dashboard, activeProfileId, onSelect, onAdd, onDelete, onTimingChange, onFormulaChange,
}: {
  entity: Entity;
  dashboard: Dashboard;
  activeProfileId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onTimingChange: (timing: TimingProfile) => void;
  onFormulaChange: (cellKey: string, formula: string) => void;
}) {
  const profiles = dashboard.riskProfiles;
  const active = profiles.find(p => p.id === activeProfileId) ?? profiles[0];
  const activeMeta = active ? RISK_PROFILE_TYPES.find(t => t.id === active.type) : undefined;

  const [timingOpen, setTimingOpen] = useState(false);
  const timing = dashboard.timing ?? DEFAULT_TIMING;
  const fractions = useMemo(() => resolveTimingFractions(timing), [timing]);

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{dashboard.name}</h1>
          <p className="text-sm text-slate-400">{entity.name} · risk profiles</p>
        </div>
        <button
          onClick={() => setTimingOpen(true)}
          className="shrink-0 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500"
          title="Calendar dates and payin/payout timing that drive the carry calculation"
        >
          🗓 Timing · {timingSummary(timing)}
        </button>
      </div>

      {timingOpen && (
        <TimingModal
          timing={timing}
          onClose={() => setTimingOpen(false)}
          onSave={t => { onTimingChange(t); setTimingOpen(false); }}
        />
      )}

      {profiles.length === 0 ? (
        <EmptyState
          icon="🧭"
          title="No risk profiles yet"
          body="Add a risk profile: FX, Bonds/Interest rates, Equities or Commodities. FX uses the FX Simulator template."
          cta="+ Add risk profile"
          onCta={onAdd}
        />
      ) : (
        <>
          {/* Section tabs — one per risk profile */}
          <div className="flex flex-wrap items-stretch gap-1 border-b border-slate-800">
            {profiles.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                className={`flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition-colors ${
                  active?.id === p.id
                    ? 'border-blue-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>{TYPE_ICON[p.type]}</span>
                {RISK_PROFILE_TYPES.find(t => t.id === p.type)?.label ?? p.name}
              </button>
            ))}
            <button
              type="button"
              onClick={onAdd}
              title="Add risk profile"
              aria-label="Add risk profile"
              className="ml-1 flex h-11 w-11 shrink-0 items-center justify-center border-b-2 border-transparent text-blue-300 transition-colors hover:bg-slate-800/80 hover:text-blue-200"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          </div>

          {active && (
            <div className="mt-4">
              {/* Active-profile summary + delete */}
              <div className="mb-3 flex items-center justify-between">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  {active.type === 'fx' && active.fxConfig ? (
                    <>
                      <span className="rounded bg-slate-800 px-2 py-0.5">
                        {active.fxConfig.currencyMode === 'all'
                          ? `All currencies (${SIM_CURRENCIES.length})`
                          : `${active.fxConfig.currencies.length} currencies`}
                      </span>
                      {active.fxConfig.optimizationMetrics.map(m => (
                        <span key={m} className="rounded bg-blue-500/15 px-2 py-0.5 text-blue-300">
                          {OPT_METRICS.find(o => o.id === m)?.label ?? m}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span>{activeMeta?.description}</span>
                  )}
                </div>
                <button
                  onClick={() => onDelete(active.id)}
                  className="text-xs text-slate-500 transition-colors hover:text-red-400"
                >
                  Delete profile
                </button>
              </div>

              {active.type === 'fx' ? (
                <div className="overflow-hidden rounded-xl border border-slate-800">
                  <Simulator
                    key={active.id}
                    embedded
                    currencyFilter={
                      active.fxConfig?.currencyMode === 'selected'
                        ? active.fxConfig.currencies
                        : undefined
                    }
                    initialActiveLayers={
                      active.fxConfig ? metricsToLayers(active.fxConfig.optimizationMetrics) : undefined
                    }
                    fxInputs={active.fxConfig?.inputs}
                    timing={fractions}
                    formulas={dashboard.formulas}
                    onFormulaChange={onFormulaChange}
                  />
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-16 text-center">
                  <div className="mb-3 text-4xl">{TYPE_ICON[active.type]}</div>
                  <h3 className="text-lg font-semibold text-white">{activeMeta?.label} template coming soon</h3>
                  <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">{activeMeta?.description}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

// ── Timing setup ─────────────────────────────────────────────────────────────

const FLOW_OPTIONS: { id: FlowTiming; label: string }[] = [
  { id: 'start',  label: 'Start of cycle' },
  { id: 'mid',    label: 'Middle of month' },
  { id: 'end',    label: 'End of month (EOM)' },
  { id: 'custom', label: 'Custom %' },
];

function flowLabel(t: FlowTiming): string {
  return t === 'start' ? 'start' : t === 'mid' ? 'mid' : t === 'end' ? 'EOM' : 'custom';
}

function timingSummary(t: TimingProfile): string {
  if (t.mode === 'calendar' && t.payoutDate && t.payinDate) {
    const d = (s: string) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `Payout ${d(t.payoutDate)} · Payin ${d(t.payinDate)}`;
  }
  return `Payout ${flowLabel(t.payout)} · Payin ${flowLabel(t.payin)}`;
}

function TimingModal({
  timing, onClose, onSave,
}: {
  timing: TimingProfile;
  onClose: () => void;
  onSave: (t: TimingProfile) => void;
}) {
  const [draft, setDraft] = useState<TimingProfile>(timing);
  const set = (patch: Partial<TimingProfile>) => setDraft(d => ({ ...d, ...patch }));
  const { fPayout, fPayin } = resolveTimingFractions(draft);
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <ModalShell
      title="Timing & calendar"
      subtitle="When payouts and payins land in the cycle drives how much carry (interest) the cash earns. A flow at EOM earns no carry; one at the start earns the full run."
      onClose={onClose}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          <button className={primaryBtn} onClick={() => onSave(draft)}>Save timing</button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Mode toggle */}
        <div className="flex gap-2">
          {(['preset', 'calendar'] as const).map(m => (
            <button
              key={m}
              onClick={() => set({ mode: m })}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors ${
                draft.mode === m
                  ? 'border-blue-500 bg-blue-500/15 text-blue-200'
                  : 'border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {m === 'preset' ? 'Distribution preset' : 'Calendar dates'}
            </button>
          ))}
        </div>

        {draft.mode === 'preset' ? (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-300">Payout timing</label>
              <select
                className={inputClass}
                value={draft.payout}
                onChange={e => set({ payout: e.target.value as FlowTiming })}
              >
                {FLOW_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {draft.payout === 'custom' && (
                <input
                  type="number" min={0} max={100}
                  className={`${inputClass} mt-2`}
                  value={draft.payoutCustom}
                  onChange={e => set({ payoutCustom: Number(e.target.value) })}
                />
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-300">Payin timing</label>
              <select
                className={inputClass}
                value={draft.payin}
                onChange={e => set({ payin: e.target.value as FlowTiming })}
              >
                {FLOW_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {draft.payin === 'custom' && (
                <input
                  type="number" min={0} max={100}
                  className={`${inputClass} mt-2`}
                  value={draft.payinCustom}
                  onChange={e => set({ payinCustom: Number(e.target.value) })}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-300">Period start</label>
              <input type="date" className={inputClass} value={draft.periodStart ?? ''} onChange={e => set({ periodStart: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-300">Period end</label>
              <input type="date" className={inputClass} value={draft.periodEnd ?? ''} onChange={e => set({ periodEnd: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-300">Payout date</label>
              <input type="date" className={inputClass} value={draft.payoutDate ?? ''} onChange={e => set({ payoutDate: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-300">Payin date</label>
              <input type="date" className={inputClass} value={draft.payinDate ?? ''} onChange={e => set({ payinDate: e.target.value })} />
            </div>
          </div>
        )}

        {/* Live readout */}
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-3 text-xs text-slate-300">
          <div className="mb-1 font-semibold text-slate-200">Carry weighting</div>
          <p>Payout lands at <span className="text-blue-300">{pct(fPayout)}</span> of cycle → carry on <span className="text-blue-300">{pct(1 - fPayout)}</span> of the payout amount.</p>
          <p>Payin lands at <span className="text-blue-300">{pct(fPayin)}</span> of cycle → carry on <span className="text-blue-300">{pct(1 - fPayin)}</span> of the payin amount.</p>
          <p className="mt-1 text-slate-500">Hedge, forward and swap tenor default to matching the cycle. Timing re-weights the natural NP cash carry only.</p>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Shared UI ────────────────────────────────────────────────────────────────

function Card({
  title, meta, description, onOpen, onDelete,
}: {
  title: string;
  meta: string;
  description?: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5 transition-colors hover:border-slate-600">
      <div className="mb-1 flex items-start justify-between">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <button
          onClick={onDelete}
          className="text-xs text-slate-500 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
        >
          Delete
        </button>
      </div>
      <p className="text-xs text-slate-400">{meta}</p>
      {description && <p className="mt-2 text-sm text-slate-400">{description}</p>}
      <button
        onClick={onOpen}
        className="mt-4 rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
      >
        Open →
      </button>
    </div>
  );
}

function EmptyState({
  icon, title, body, cta, onCta,
}: {
  icon: string;
  title: string;
  body: string;
  cta: string;
  onCta: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-10 text-center">
      <div className="mb-3 text-4xl">{icon}</div>
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">{body}</p>
      <button
        onClick={onCta}
        className="mt-6 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
      >
        {cta}
      </button>
    </div>
  );
}

function ModalShell({
  title, subtitle, onClose, children, footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">{children}</div>
        <div className="mt-6 flex justify-end gap-3">{footer}</div>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none';
const primaryBtn =
  'rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-40';
const ghostBtn =
  'rounded-md border border-slate-600 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800';

function EntityModal({
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { name: string; baseCurrency: string }) => void;
}) {
  const [name, setName] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('USD');

  return (
    <ModalShell
      title="Create entity"
      subtitle="A legal entity or business unit you manage treasury risk for."
      onClose={onClose}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          <button
            className={primaryBtn}
            disabled={!name.trim()}
            onClick={() => onCreate({ name, baseCurrency })}
          >
            Create entity
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-300">Entity name</label>
          <input
            autoFocus
            className={inputClass}
            placeholder="e.g. Acme Holdings Ltd"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-300">Base / reporting currency</label>
          <select className={inputClass} value={baseCurrency} onChange={e => setBaseCurrency(e.target.value)}>
            {BASE_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
    </ModalShell>
  );
}

function DashboardModal({
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  return (
    <ModalShell
      title="Create dashboard"
      subtitle="Group risk profiles for this entity."
      onClose={onClose}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          <button className={primaryBtn} disabled={!name.trim()} onClick={() => onCreate(name)}>
            Create dashboard
          </button>
        </>
      }
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-300">Dashboard name</label>
        <input
          autoFocus
          className={inputClass}
          placeholder="e.g. Q3 FX Risk"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>
    </ModalShell>
  );
}

// ── Add-risk-profile wizard ──────────────────────────────────────────────────

function ProfileWizard({
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    types: RiskProfileType[];
    fxConfig?: {
      inputs: FxInput[];
      currencyMode: 'all' | 'selected';
      currencies: string[];
      optimizationMetrics: OptMetric[];
    };
  }) => void;
}) {
  const [step, setStep] = useState(0);
  const [types, setTypes] = useState<Set<RiskProfileType>>(new Set(['fx']));
  const [inputs, setInputs] = useState<Set<FxInput>>(new Set(['liquidity', 'fxExposure', 'rates']));
  const [ccyMode, setCcyMode] = useState<'all' | 'selected'>('all');
  const [ccys, setCcys] = useState<Set<string>>(new Set(['EUR', 'GBP', 'JPY']));
  const [metrics, setMetrics] = useState<Set<OptMetric>>(
    new Set(['minFloor', 'payoutBuffer', 'carryTarget', 'portfolioVar']),
  );

  const toggle = <T,>(set: Set<T>, setter: (s: Set<T>) => void, val: T) => {
    const next = new Set(set);
    next.has(val) ? next.delete(val) : next.add(val);
    setter(next);
  };

  const isFx = types.has('fx');
  // FX config steps (inputs/currencies/metrics) only apply when FX is selected.
  const lastStep = isFx ? 3 : 0;

  const canNext = () => {
    if (step === 0) return types.size > 0;
    if (isFx && step === 2) return ccyMode === 'all' || ccys.size > 0;
    if (isFx && step === 3) return metrics.size > 0;
    return true;
  };

  const finish = () => {
    onCreate({
      types: [...types],
      fxConfig: isFx
        ? {
            inputs: [...inputs],
            currencyMode: ccyMode,
            currencies: [...ccys],
            optimizationMetrics: [...metrics],
          }
        : undefined,
    });
  };

  return (
    <ModalShell
      title="Add risk profile"
      subtitle={isFx ? `Step ${step + 1} of ${lastStep + 1}` : undefined}
      onClose={onClose}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          {step > 0 && (
            <button className={ghostBtn} onClick={() => setStep(s => s - 1)}>Back</button>
          )}
          {step < lastStep ? (
            <button className={primaryBtn} disabled={!canNext()} onClick={() => setStep(s => s + 1)}>
              Next
            </button>
          ) : (
            <button className={primaryBtn} disabled={!canNext()} onClick={finish}>
              {types.size > 1
                ? `Create ${types.size} profiles`
                : isFx
                  ? 'Create & open simulator'
                  : 'Create profile'}
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Choose one or more asset classes to add to this dashboard.
          </p>
          {RISK_PROFILE_TYPES.map(t => {
            const selected = types.has(t.id);
            return (
              <button
                key={t.id}
                onClick={() => toggle(types, setTypes, t.id)}
                className={`flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors ${
                  selected ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 hover:border-slate-600'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  readOnly
                  className="mt-0.5 h-4 w-4 accent-blue-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span>{TYPE_ICON[t.id]}</span>
                    <span className="font-medium text-white">{t.label}</span>
                    {!t.available && (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                        Soon
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{t.description}</p>
                </div>
              </button>
            );
          })}
          {isFx && (
            <p className="pt-1 text-xs text-slate-500">
              FX uses the FX Simulator template — the next steps configure its inputs, currencies and
              optimization metrics. Other selected classes are added as sections.
            </p>
          )}
        </div>
      )}

      {isFx && step === 1 && (
        <div>
          <p className="mb-3 text-sm text-slate-400">Which inputs / metrics should this profile include?</p>
          <div className="space-y-2">
            {FX_INPUTS.map(inp => (
              <CheckRow
                key={inp.id}
                checked={inputs.has(inp.id)}
                onChange={() => toggle(inputs, setInputs, inp.id)}
                label={inp.label}
                description={inp.description}
              />
            ))}
          </div>
        </div>
      )}

      {isFx && step === 2 && (
        <div>
          <p className="mb-3 text-sm text-slate-400">Select currencies for this profile.</p>
          <div className="space-y-2">
            <RadioRow
              checked={ccyMode === 'all'}
              onChange={() => setCcyMode('all')}
              label={`All currencies (${SIM_CURRENCIES.length})`}
              description="Use the full multi-currency book already in the simulator."
            />
            <RadioRow
              checked={ccyMode === 'selected'}
              onChange={() => setCcyMode('selected')}
              label="Select specific currencies"
              description="Restrict the book to a subset."
            />
          </div>
          {ccyMode === 'selected' && (
            <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6">
              {SIM_CURRENCIES.map(c => (
                <button
                  key={c}
                  onClick={() => toggle(ccys, setCcys, c)}
                  className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                    ccys.has(c)
                      ? 'border-blue-500 bg-blue-500/15 text-blue-200'
                      : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isFx && step === 3 && (
        <div>
          <p className="mb-3 text-sm text-slate-400">Select metrics for optimization.</p>
          <div className="space-y-2">
            {OPT_METRICS.map(m => (
              <CheckRow
                key={m.id}
                checked={metrics.has(m.id)}
                onChange={() => toggle(metrics, setMetrics, m.id)}
                label={m.label}
                description={m.description}
              />
            ))}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function CheckRow({
  checked, onChange, label, description,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
      checked ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 hover:border-slate-600'
    }`}>
      <input type="checkbox" checked={checked} onChange={onChange} className="mt-0.5 h-4 w-4 accent-blue-500" />
      <div>
        <div className="text-sm font-medium text-white">{label}</div>
        <div className="text-xs text-slate-400">{description}</div>
      </div>
    </label>
  );
}

function RadioRow({
  checked, onChange, label, description,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
      checked ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 hover:border-slate-600'
    }`}>
      <input type="radio" checked={checked} onChange={onChange} className="mt-0.5 h-4 w-4 accent-blue-500" />
      <div>
        <div className="text-sm font-medium text-white">{label}</div>
        <div className="text-xs text-slate-400">{description}</div>
      </div>
    </label>
  );
}
