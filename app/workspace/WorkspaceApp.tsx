'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { ModeNav } from '@/components/ModeNav';
import {
  IconBuilding,
  IconDashboard,
  IconEntity,
  IconGauge,
  IconPencil,
  IconPlus,
  IconSpark,
  IconTrash,
  ProfileTypeIcon,
} from '@/components/WorkbenchIcons';
import {
  OptimizeFrameworkIcon,
  ProtectGoalIcon,
  RateInstrumentIcon,
  TickerGlyph,
} from '@/components/RiskTaxonomyIcons';
import { INITIAL_ROWS } from '@/lib/fx-buffer';
import { WorkbenchFxDesk } from '@/components/workbench/WorkbenchFxDesk';
import { WorkbenchGroupDesk } from '@/components/workbench/WorkbenchGroupDesk';
import { mirrorStructureToCurriculumSandbox } from '@/lib/workspace-curriculum-bridge';
import type { ForecastProfileState } from '@/lib/forecast-profile';
import {
  DEFAULT_VAR_SETUP,
  emptyHedgeBook,
  normalizeVarSetup,
  type EntityHedgeBook,
  type VarSetup,
} from '@/lib/test-mode';
import {
  loadWorkspaceDetailed,
  saveWorkspace,
  createEntity,
  createDashboardFromWizard,
  updateDashboardFromWizard,
  dashboardSetupFromDashboard,
  createRiskProfile,
  applyStructureWizard,
  OPTIMIZE_FRAMEWORKS,
  PROTECT_GOALS,
  RATE_INSTRUMENTS,
  RISK_ASSETS,
  deleteEntity,
  deleteDashboard,
  deleteRiskProfile,
  entityHasFxSetup,
  groupFxUnlocked,
  updateDashboardTiming,
  updateDashboardFormula,
  updateDashboardFormulas,
  updateDashboardForecastProfile,
  resolveTimingFractions,
  defaultCurriculumFxConfig,
  DEFAULT_TIMING,
  RISK_PROFILE_TYPES,
  FX_INPUTS,
  OPT_METRICS,
  DECISION_LAYERS,
  ANALYTICAL_LAYERS,
  type Workspace,
  type Entity,
  type Dashboard,
  type RiskProfileType,
  type OptimizeFrameworkId,
  type RateInstrument,
  type FxInput,
  type OptMetric,
  type DecisionLayer,
  type AnalyticalLayer,
  type FxProfileConfig,
  type TimingProfile,
  type FlowTiming,
} from '@/lib/workspace-store';
import { StructureWizard } from '@/app/workspace/StructureWizard';
import { CreateDashboardWizard } from '@/app/workspace/CreateDashboardWizard';

const SIM_CURRENCIES = INITIAL_ROWS.map(r => r.ccy);
const BASE_CURRENCIES = ['USD', ...[...SIM_CURRENCIES].sort()];

interface WorkspaceAppProps {
  userKey: string;
  userName: string;
  accountMenu: ReactNode;
  sandboxEnabled?: boolean;
}

type Modal =
  | { kind: 'none' }
  | { kind: 'entity' }
  | { kind: 'dashboard'; editDashboardId?: string }
  | { kind: 'profile' }
  | { kind: 'structure' };

export function WorkspaceApp({
  userKey,
  userName,
  accountMenu,
  sandboxEnabled = true,
}: WorkspaceAppProps) {
  const [workspace, setWorkspace] = useState<Workspace>({ entities: [] });
  const [loaded, setLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{
    tone: 'ok' | 'error' | 'warn';
    message: string;
  } | null>(null);

  const [entityId, setEntityId] = useState<string | null>(null);
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const [varSetup, setVarSetup] = useState<VarSetup>(() =>
    normalizeVarSetup(DEFAULT_VAR_SETUP),
  );
  const [hedgesByEntityId, setHedgesByEntityId] = useState<
    Record<string, EntityHedgeBook>
  >({});

  useEffect(() => {
    const { workspace: ws, loadWarning } = loadWorkspaceDetailed(userKey);
    setWorkspace(ws);
    setLoaded(true);
    if (loadWarning) {
      setSaveStatus({ tone: 'warn', message: loadWarning });
    }
  }, [userKey]);

  useEffect(() => {
    if (!saveStatus || saveStatus.tone === 'error') return;
    const t = window.setTimeout(() => setSaveStatus(null), 4000);
    return () => window.clearTimeout(t);
  }, [saveStatus]);

  const persist = (resolved: Workspace, okMessage = 'Workspace saved') => {
    const result = saveWorkspace(userKey, resolved);
    if (result.ok) {
      setSaveStatus({ tone: 'ok', message: okMessage });
    } else {
      setSaveStatus({
        tone: 'error',
        message: result.error
          ? `Save failed — ${result.error}`
          : 'Save failed — storage full or blocked',
      });
    }
    return result;
  };

  const update = (
    next: Workspace | ((prev: Workspace) => Workspace),
    okMessage = 'Workspace saved',
  ) => {
    setWorkspace(prev => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      persist(resolved, okMessage);
      return resolved;
    });
  };

  const entity: Entity | undefined = useMemo(
    () => workspace.entities.find(e => e.id === entityId),
    [workspace, entityId],
  );
  const dashboard: Dashboard | undefined = useMemo(
    () => entity?.dashboards.find(d => d.id === dashboardId),
    [entity, dashboardId],
  );

  const groupEntities = useMemo(() => {
    const g = workspace.group;
    if (!g) return [];
    const ids = new Set(g.includedEntityIds);
    const included = workspace.entities.filter(e => ids.has(e.id));
    return included.length > 0 ? included : workspace.entities;
  }, [workspace]);

  const wide = Boolean(dashboard) || groupOpen;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div
          className={`mx-auto flex flex-wrap items-center justify-between gap-3 px-6 py-4 ${
            wide ? 'max-w-screen-2xl' : 'max-w-6xl'
          }`}
        >
          <BrandMark href="/" label="Treasury Workbench" />
          <div className="flex flex-wrap items-center gap-3">
            {saveStatus && (
              <span
                role="status"
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  saveStatus.tone === 'ok'
                    ? 'bg-emerald-900/50 text-emerald-200'
                    : saveStatus.tone === 'warn'
                      ? 'bg-amber-900/40 text-amber-100'
                      : 'bg-rose-900/50 text-rose-100'
                }`}
              >
                {saveStatus.message}
              </span>
            )}
            <ModeNav sandboxEnabled={sandboxEnabled} />
            {accountMenu}
          </div>
        </div>
      </header>

      <main className={`mx-auto px-6 py-8 ${wide ? 'max-w-screen-2xl' : 'max-w-6xl'}`}>
        <Breadcrumb
          entity={entity}
          dashboard={dashboard}
          groupOpen={groupOpen}
          groupName={workspace.group?.dashboardName}
          onHome={() => {
            setGroupOpen(false);
            setEntityId(null);
            setDashboardId(null);
          }}
          onEntity={() => setDashboardId(null)}
        />

        {!loaded ? (
          <p className="mt-10 text-slate-400">Loading your workspace…</p>
        ) : groupOpen && workspace.group ? (
          <WorkbenchGroupDesk
            group={workspace.group}
            entities={groupEntities}
            varSetup={varSetup}
            onVarSetupChange={setup => setVarSetup(normalizeVarSetup(setup))}
            hedgesByEntityId={hedgesByEntityId}
            onHedgesByEntityIdChange={setHedgesByEntityId}
          />
        ) : !entity ? (
          <EntitiesView
            userName={userName}
            workspace={workspace}
            onOpen={id => {
              setGroupOpen(false);
              setEntityId(id);
              setDashboardId(null);
            }}
            onOpenGroup={() => {
              if (!groupFxUnlocked(workspace)) return;
              setEntityId(null);
              setDashboardId(null);
              setGroupOpen(true);
            }}
            onCreate={() => setModal({ kind: 'entity' })}
            onGuidedSetup={() => setModal({ kind: 'structure' })}
            onDelete={id => update(deleteEntity(workspace, id), 'Entity deleted')}
          />
        ) : !dashboard ? (
          <DashboardsView
            entity={entity}
            onBack={() => {
              setEntityId(null);
              setDashboardId(null);
            }}
            onOpen={id => { setDashboardId(id); setActiveProfileId(null); }}
            onCreate={() => setModal({ kind: 'dashboard' })}
            onEdit={id => setModal({ kind: 'dashboard', editDashboardId: id })}
            onDelete={id => update(deleteDashboard(workspace, entity.id, id), 'Dashboard deleted')}
          />
        ) : (
          <DashboardView
            entity={entity}
            dashboard={dashboard}
            activeProfileId={activeProfileId}
            onSelect={setActiveProfileId}
            onAdd={() => setModal({ kind: 'profile' })}
            onEditSetup={() =>
              setModal({ kind: 'dashboard', editDashboardId: dashboard.id })
            }
            onDelete={id =>
              update(
                deleteRiskProfile(workspace, entity.id, dashboard.id, id),
                'Profile deleted',
              )
            }
            onTimingChange={t =>
              update(
                ws => updateDashboardTiming(ws, entity.id, dashboard.id, t),
                'Timing saved',
              )
            }
            onFormulaChange={(cellKey, formula) =>
              update(ws =>
                updateDashboardFormula(ws, entity.id, dashboard.id, cellKey, formula),
              )
            }
            onFormulaChanges={updates =>
              update(ws =>
                updateDashboardFormulas(ws, entity.id, dashboard.id, updates),
              )
            }
            onForecastProfileChange={profile =>
              update(ws =>
                updateDashboardForecastProfile(
                  ws,
                  entity.id,
                  dashboard.id,
                  profile,
                ),
              )
            }
            varSetup={varSetup}
            onVarSetupChange={setup => setVarSetup(normalizeVarSetup(setup))}
            hedgeBook={hedgesByEntityId[entity.id] ?? emptyHedgeBook()}
            onHedgeBookChange={updater =>
              setHedgesByEntityId(prev => ({
                ...prev,
                [entity.id]: updater(prev[entity.id] ?? emptyHedgeBook()),
              }))
            }
          />
        )}
      </main>

      {modal.kind === 'structure' && (
        <StructureWizard
          onClose={() => setModal({ kind: 'none' })}
          onFinish={input => {
            const next = applyStructureWizard(workspace, input);
            const save = persist(next, 'Structure saved');
            setWorkspace(next);
            if (save.ok) {
              // Mirroring into the curriculum sandbox is a background sync —
              // only worth surfacing when it fails.
              const mirror = mirrorStructureToCurriculumSandbox(userKey, next, '01');
              if (!mirror.ok) {
                setSaveStatus({
                  tone: 'warn',
                  message: `Structure saved · sandbox sync skipped${
                    mirror.error ? ` (${mirror.error})` : ''
                  }`,
                });
              }
            }
            setEntityId(null);
            setDashboardId(null);
            setModal({ kind: 'none' });
          }}
        />
      )}

      {modal.kind === 'entity' && (
        <EntityModal
          onClose={() => setModal({ kind: 'none' })}
          onCreate={input => {
            const { workspace: createdWs, entity: created } = createEntity(workspace, {
              name: input.name,
              baseCurrency: input.baseCurrency,
              description: input.description,
              riskAssets: ['currencies', 'interestRates'],
            });
            let ws = createdWs;
            if (input.withFxSetup) {
              const built = createDashboardFromWizard(ws, created.id, {
                name: input.dashboardName.trim() || `${input.name.trim()} FX`,
                setup: {
                  riskAsset: 'currencies',
                  protect: ['assetValue', 'cashFlow'],
                  optimize: ['var', 'hedgeCarry', 'cfar'],
                  tickers: ['EUR', 'GBP', 'JPY'],
                },
              });
              // Prefer explicit curriculum fxConfig when provided.
              if (input.fxConfig) {
                const dashId = built.dashboard.id;
                const profileId = built.profile.id;
                ws = built.workspace;
                const entities = ws.entities.map(e => {
                  if (e.id !== created.id) return e;
                  return {
                    ...e,
                    dashboards: e.dashboards.map(d => {
                      if (d.id !== dashId) return d;
                      return {
                        ...d,
                        riskProfiles: d.riskProfiles.map(p =>
                          p.id === profileId
                            ? { ...p, fxConfig: input.fxConfig }
                            : p,
                        ),
                      };
                    }),
                  };
                });
                ws = { ...ws, entities };
              } else {
                ws = built.workspace;
              }
              update(ws, 'Entity + Cash/FX setup created');
              setEntityId(created.id);
              setDashboardId(built.dashboard.id);
              setActiveProfileId(built.profile.id);
            } else {
              update(ws, 'Entity created');
              setEntityId(created.id);
              setDashboardId(null);
            }
            setModal({ kind: 'none' });
          }}
        />
      )}

      {modal.kind === 'dashboard' && entity && (
        <CreateDashboardWizard
          key={modal.editDashboardId ?? 'create'}
          entity={entity}
          mode={modal.editDashboardId ? 'edit' : 'create'}
          initial={
            modal.editDashboardId
              ? (() => {
                  const d = entity.dashboards.find(x => x.id === modal.editDashboardId);
                  if (!d) return undefined;
                  return {
                    name: d.name,
                    setup: dashboardSetupFromDashboard(d),
                  };
                })()
              : undefined
          }
          onClose={() => setModal({ kind: 'none' })}
          onFinish={input => {
            if (modal.editDashboardId) {
              const { workspace: ws, profile } = updateDashboardFromWizard(
                workspace,
                entity.id,
                modal.editDashboardId,
                input,
              );
              update(ws, 'Dashboard updated');
              setActiveProfileId(profile.id);
              setModal({ kind: 'none' });
              return;
            }
            const { workspace: ws, dashboard: created, profile } = createDashboardFromWizard(
              workspace,
              entity.id,
              input,
            );
            update(ws, 'Dashboard created');
            setDashboardId(created.id);
            setActiveProfileId(profile.id);
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
            update(ws, 'Risk profile created');
            setModal({ kind: 'none' });
            if (firstId) setActiveProfileId(firstId);
          }}
        />
      )}
    </div>
  );
}

type EntityAssetCard = {
  id: string;
  /** Risk asset class label (Currencies, Interest rates, …). */
  assetLabel: string;
  assetType: RiskProfileType;
  dashboardName: string;
  tickerTags: string[];
  optimizeTags: { id: OptimizeFrameworkId; label: string }[];
};

/** Chip text for a scoped instrument: "EUR loan · EURIBOR +50bp · 12m". */
function describeInstrument(inst: RateInstrument): string {
  const label = RATE_INSTRUMENTS.find(i => i.id === inst.kind)?.label ?? inst.kind;
  const pair = inst.legCurrency ? `${inst.currency}/${inst.legCurrency}` : inst.currency;
  const rate =
    inst.rateType === 'floating'
      ? [inst.index, inst.spreadBp ? `${inst.spreadBp > 0 ? '+' : ''}${inst.spreadBp}bp` : null]
          .filter(Boolean)
          .join(' ')
      : inst.ratePct != null
        ? `${inst.ratePct}% fixed`
        : 'fixed';
  const tenor = inst.tenorMonths ? `${inst.tenorMonths}m` : null;
  return [`${pair} ${label}`, rate, tenor].filter(Boolean).join(' · ');
}

function inferRiskAsset(d: Dashboard): {
  label: string;
  type: RiskProfileType;
} {
  if (d.setup?.riskAsset) {
    const meta = RISK_ASSETS.find(a => a.id === d.setup!.riskAsset);
    return {
      label: meta?.label ?? d.setup.riskAsset,
      type: meta?.profileType ?? 'fx',
    };
  }
  const primary = d.riskProfiles[0];
  if (primary) {
    // Dashboards predating the setup model only carry a profile type, so map it
    // back onto the risk-asset taxonomy — otherwise the same desk reads
    // "Cash/FX" here and "Currencies" on a wizard-built neighbour.
    const asset = RISK_ASSETS.find(a => a.profileType === primary.type);
    return {
      label:
        asset?.label ??
        RISK_PROFILE_TYPES.find(t => t.id === primary.type)?.label ??
        primary.type,
      type: primary.type,
    };
  }
  return { label: 'Dashboard', type: 'fx' };
}

/** One card per added dashboard — risk asset class only (no layer/metric dump). */
function entityAssetCards(entity: Entity): {
  assets: EntityAssetCard[];
  profileCount: number;
} {
  const assets: EntityAssetCard[] = entity.dashboards.map(d => {
    const inferred = inferRiskAsset(d);
    const fx = d.riskProfiles.find(p => p.type === 'fx' && p.fxConfig)?.fxConfig;
    return {
      id: d.id,
      assetLabel: inferred.label,
      assetType: inferred.type,
      dashboardName: d.name,
      tickerTags: d.setup?.tickers ?? (fx?.currencyMode === 'selected' ? fx.currencies : []),
      optimizeTags: (d.setup?.optimize ?? []).map(id => ({
        id,
        label: OPTIMIZE_FRAMEWORKS.find(g => g.id === id)?.label ?? id,
      })),
    };
  });
  return {
    assets,
    profileCount: entity.dashboards.reduce((n, d) => n + d.riskProfiles.length, 0),
  };
}

/**
 * One desk on an entity card — a preview of what's inside, not a link. The
 * whole card is the click target, so this stays inert markup. Leads with the
 * dashboard name and treats the risk asset class as its subtitle, with only
 * enough of the setup to tell two desks apart.
 */
function EntityDeskRow({ asset }: { asset: EntityAssetCard }) {
  const MAX_TAGS = 3;
  const shown = asset.optimizeTags.slice(0, MAX_TAGS);
  const extra = asset.optimizeTags.length - shown.length;
  return (
    <div
      title={`${asset.dashboardName} — ${asset.assetLabel}`}
      className="flex w-full items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-2 text-left"
    >
      <ProfileTypeIcon
        type={asset.assetType}
        className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-slate-100">
          {asset.dashboardName}
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-slate-500">
          {asset.assetLabel}
          {asset.tickerTags.length > 0 && (
            <span className="text-slate-600"> · {asset.tickerTags.join(' ')}</span>
          )}
        </span>
        {shown.length > 0 && (
          <span className="mt-1.5 flex flex-wrap items-center gap-1">
            {shown.map(t => (
              <TagChip
                key={t.id}
                label={t.label}
                tone="emerald"
                icon={<OptimizeFrameworkIcon id={t.id} className="h-3 w-3 shrink-0" />}
              />
            ))}
            {extra > 0 && (
              <span
                className="text-[10px] text-slate-500"
                title={asset.optimizeTags.map(t => t.label).join(', ')}
              >
                +{extra}
              </span>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

function TagChip({
  label,
  tone = 'slate',
  icon,
  size = 'sm',
}: {
  label: string;
  tone?: 'slate' | 'emerald' | 'amber' | 'violet' | 'blue' | 'rose';
  icon?: ReactNode;
  /** `md` is for desk summaries, where the framework name is spelled out. */
  size?: 'sm' | 'md';
}) {
  const tones: Record<typeof tone, string> = {
    slate: 'border-slate-700 bg-slate-800/80 text-slate-300',
    emerald: 'border-emerald-700/50 bg-emerald-950/50 text-emerald-300',
    amber: 'border-amber-700/50 bg-amber-950/40 text-amber-200',
    violet: 'border-violet-700/50 bg-violet-950/40 text-violet-200',
    blue: 'border-blue-700/50 bg-blue-950/40 text-blue-200',
    rose: 'border-rose-700/50 bg-rose-950/40 text-rose-200',
  };
  return (
    <span
      title={label}
      className={`inline-flex items-center rounded-md border font-medium ${tones[tone]} ${
        size === 'md'
          ? 'gap-1.5 px-2 py-1 text-xs'
          : 'gap-1 px-1.5 py-0.5 text-[10px]'
      }`}
    >
      {icon}
      {label}
    </span>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────────────────

function Breadcrumb({
  entity, dashboard, groupOpen, groupName, onHome, onEntity,
}: {
  entity?: Entity;
  dashboard?: Dashboard;
  groupOpen?: boolean;
  groupName?: string;
  onHome: () => void;
  onEntity: () => void;
}) {
  return (
    <nav className="mb-6 flex items-center gap-2 text-sm text-slate-400">
      <button type="button" onClick={onHome} className="hover:text-white">Entities</button>
      {groupOpen && (
        <>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200">{groupName ?? 'Group FX'}</span>
        </>
      )}
      {entity && !groupOpen && (
        <>
          <span className="text-slate-600">/</span>
          <button type="button" onClick={onEntity} className="hover:text-white">{entity.name}</button>
        </>
      )}
      {dashboard && !groupOpen && (
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
  userName, workspace, onOpen, onOpenGroup, onCreate, onGuidedSetup, onDelete,
}: {
  userName: string;
  workspace: Workspace;
  onOpen: (id: string) => void;
  onOpenGroup: () => void;
  onCreate: () => void;
  onGuidedSetup: () => void;
  onDelete: (id: string) => void;
}) {
  const entities = workspace.entities;
  const group = workspace.group;
  const unlocked = groupFxUnlocked(workspace);
  const readyCount = entities.filter(entityHasFxSetup).length;

  if (entities.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-10 text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-600/15 text-blue-300">
          <IconBuilding className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {userName}!</h1>
        <p className="mx-auto mt-3 max-w-lg text-slate-400">
          Start with a guided structure — parent group, subsidiaries, then a dashboard and Cash/FX
          metrics profile per entity (same result shape as the curriculum Group FX section).
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={onGuidedSetup}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
          >
            <IconSpark className="h-4 w-4" />
            Guided structure setup
          </button>
          <button
            onClick={onCreate}
            className="rounded-lg border border-slate-600 px-6 py-3 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
          >
            + Create a single entity
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Entities</h1>
          <p className="text-sm text-slate-400">
            Parent consolidated layer and legal entities — same shape as curriculum Group FX.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onGuidedSetup}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
          >
            <IconSpark className="h-4 w-4" />
            Guided structure setup
          </button>
          <button
            onClick={onCreate}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
          >
            + New entity
          </button>
        </div>
      </div>

      {group && (
        <>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Parent · consolidated
          </div>
          {unlocked ? (
            <button
              type="button"
              onClick={onOpenGroup}
              aria-label="Open consolidated Group FX dashboard"
              className="mb-8 w-full rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-5 text-left transition-colors hover:border-emerald-500/70 hover:bg-emerald-500/15"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-600/40 bg-emerald-900/40 text-emerald-300">
                    <IconBuilding className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
                      Parent · consolidated · unlocked
                    </div>
                    <h2 className="mt-1 text-base font-semibold text-white">{group.name}</h2>
                    <p className="mt-1 text-xs text-slate-400">
                      {group.dashboardName} · {group.reportingCurrency}
                    </p>
                    <p className="mt-2 text-xs text-emerald-200/80">
                      Group FX ready — {readyCount}/{entities.length} entities have dashboard + FX
                      profile.
                    </p>
                  </div>
                </div>
                <span className="shrink-0 text-xs font-medium text-emerald-300">
                  Open Group FX →
                </span>
              </div>
            </button>
          ) : (
            <div className="mb-8 w-full rounded-xl border border-dashed border-slate-700 bg-slate-900/40 p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-400">
                  <IconBuilding className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Parent · consolidated · locked
                  </div>
                  <h2 className="mt-1 text-base font-semibold text-slate-300">{group.name}</h2>
                  <p className="mt-1 text-xs text-slate-400">
                    {group.dashboardName} · {group.reportingCurrency}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    Add a dashboard and FX Risk profile on every included entity (
                    {readyCount}/{group.includedEntityIds.length} ready).
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Legal entities
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entities.map(e => {
          const ready = entityHasFxSetup(e);
          const { assets } = entityAssetCards(e);
          return (
            <div
              key={e.id}
              className={`group relative rounded-xl border p-5 transition-colors ${
                ready
                  ? 'border-emerald-700/40 bg-slate-900/60 hover:border-emerald-500/60'
                  : 'border-slate-800 bg-slate-900/60 hover:border-blue-500/50'
              }`}
            >
              <button
                type="button"
                title={`Delete ${e.name}`}
                aria-label={`Delete ${e.name}`}
                onClick={() => onDelete(e.id)}
                className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900/90 text-slate-400 opacity-70 transition-all hover:border-rose-500/60 hover:text-rose-400 group-hover:opacity-100"
              >
                <IconTrash className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onOpen(e.id)}
                title={`Open ${e.name} desks`}
                className="w-full text-left"
              >
                <div className="flex items-start gap-3 pr-10">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-950 text-slate-400">
                    <IconEntity className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-semibold text-white">{e.name}</h3>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          ready
                            ? 'bg-emerald-900/60 text-emerald-300'
                            : 'bg-slate-800 text-amber-300/90'
                        }`}
                      >
                        {ready ? 'Ready' : 'Incomplete'}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{e.baseCurrency}</span>
                      <span className="inline-flex items-center gap-1">
                        <IconDashboard className="h-3.5 w-3.5" />
                        {assets.length} desk{assets.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    {e.description && (
                      <p className="mt-1 truncate text-xs text-slate-400" title={e.description}>
                        {e.description}
                      </p>
                    )}
                  </div>
                </div>

                {assets.length > 0 ? (
                  <div className="mt-3 space-y-1.5">
                    {assets.map(a => (
                      <EntityDeskRow key={a.id} asset={a} />
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-md border border-dashed border-slate-700 px-2 py-2 text-center text-[11px] font-medium text-amber-400/80">
                    No desk yet — open to create a dashboard
                  </div>
                )}

                <div className="mt-3 text-[11px] font-medium text-slate-600 transition-colors group-hover:text-blue-400">
                  Open desks →
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Dashboards ────────────────────────────────────────────────────────────

function DashboardsView({
  entity, onBack, onOpen, onCreate, onEdit, onDelete,
}: {
  entity: Entity;
  onBack: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            className="mt-1 shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-800 hover:text-white"
          >
            ← Back
          </button>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{entity.name} · Dashboards</h1>
            <p className="text-sm text-slate-400">
              Detailed risk-asset desks — edit re-runs asset → protect → optimize → tickers.
            </p>
          </div>
        </div>
        <button
          onClick={onCreate}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >
          <IconPlus className="h-4 w-4" />
          New dashboard
        </button>
      </div>
      {entity.dashboards.length === 0 ? (
        <EmptyState
          icon={<IconDashboard className="h-7 w-7" />}
          title="No dashboards yet"
          body="Open the create wizard: pick a risk asset, protect goals, optimize frameworks, then tickers."
          cta="Create dashboard"
          onCta={onCreate}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {entity.dashboards.map(d => {
            const setup = dashboardSetupFromDashboard(d);
            const assetMeta = RISK_ASSETS.find(a => a.id === setup.riskAsset);
            const protect = setup.protect.map(id => ({
              id,
              label: PROTECT_GOALS.find(g => g.id === id)?.label ?? id,
            }));
            const optimize = setup.optimize.map(id => ({
              id,
              label: OPTIMIZE_FRAMEWORKS.find(g => g.id === id)?.longLabel ?? id,
            }));
            return (
              <div
                key={d.id}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 transition-colors hover:border-slate-600"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-950 text-slate-300">
                      <ProfileTypeIcon
                        type={assetMeta?.profileType ?? 'fx'}
                        className="h-5 w-5"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-white">
                          {assetMeta?.label ?? 'Risk asset'}
                        </h3>
                        <span className="rounded border border-violet-700/40 bg-violet-950/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-violet-200">
                          {assetMeta?.live ? 'Live' : 'Soon'}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-slate-400">{d.name}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button
                      type="button"
                      title="Edit dashboard setup"
                      aria-label={`Edit ${d.name}`}
                      onClick={() => onEdit(d.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition-colors hover:border-sky-500/50 hover:text-sky-300"
                    >
                      <IconPencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Delete dashboard"
                      aria-label={`Delete ${d.name}`}
                      onClick={() => onDelete(d.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition-colors hover:border-rose-500/60 hover:text-rose-400"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="mt-4 space-y-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                  <div>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Protect
                    </div>
                    {protect.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {protect.map(t => (
                          <TagChip
                            key={t.id}
                            label={t.label}
                            tone="rose"
                            size="md"
                            icon={<ProtectGoalIcon id={t.id} className="h-3.5 w-3.5 shrink-0" />}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-[10px] text-slate-600">None — edit to set</p>
                    )}
                  </div>
                  <div>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Optimize
                    </div>
                    {optimize.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {optimize.map(t => (
                          <TagChip
                            key={t.id}
                            label={t.label}
                            tone="emerald"
                            size="md"
                            icon={
                              <OptimizeFrameworkIcon id={t.id} className="h-3.5 w-3.5 shrink-0" />
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-[10px] text-slate-600">None — edit to set</p>
                    )}
                  </div>
                  <div>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Tickers
                    </div>
                    {setup.tickers.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {setup.tickers.map(t => (
                          <span
                            key={t}
                            className="inline-flex items-center gap-1.5 rounded-md border border-violet-700/40 bg-violet-950/30 px-2 py-1 font-mono text-xs font-semibold text-violet-200"
                          >
                            <TickerGlyph code={t} className="w-3 text-center text-violet-300/80" />
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[10px] text-slate-600">None — edit to set</p>
                    )}
                  </div>
                  {setup.instruments && setup.instruments.length > 0 && (
                    <div>
                      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Instruments
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {setup.instruments.map(inst => (
                          <TagChip
                            key={inst.uid}
                            label={describeInstrument(inst)}
                            tone="amber"
                            size="md"
                            icon={
                              <RateInstrumentIcon id={inst.kind} className="h-3.5 w-3.5 shrink-0" />
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onOpen(d.id)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
                  >
                    Open desk →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Dashboard: risk-section tabs ─────────────────────────────────────────────

function DashboardView({
  entity,
  dashboard,
  activeProfileId,
  onSelect,
  onAdd,
  onEditSetup,
  onDelete,
  onTimingChange,
  onFormulaChange,
  onFormulaChanges,
  onForecastProfileChange,
  varSetup,
  onVarSetupChange,
  hedgeBook,
  onHedgeBookChange,
}: {
  entity: Entity;
  dashboard: Dashboard;
  activeProfileId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEditSetup: () => void;
  onDelete: (id: string) => void;
  onTimingChange: (timing: TimingProfile) => void;
  onFormulaChange: (cellKey: string, formula: string) => void;
  onFormulaChanges: (updates: Record<string, string>) => void;
  onForecastProfileChange: (profile: ForecastProfileState) => void;
  varSetup: VarSetup;
  onVarSetupChange: (setup: VarSetup) => void;
  hedgeBook: EntityHedgeBook;
  onHedgeBookChange: (updater: (prev: EntityHedgeBook) => EntityHedgeBook) => void;
}) {
  const profiles = dashboard.riskProfiles;
  const active = profiles.find(p => p.id === activeProfileId) ?? profiles[0];
  const activeMeta = active ? RISK_PROFILE_TYPES.find(t => t.id === active.type) : undefined;

  const [timingOpen, setTimingOpen] = useState(false);
  const timing = dashboard.timing ?? DEFAULT_TIMING;

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{dashboard.name}</h1>
            <button
              type="button"
              title="Edit dashboard setup"
              aria-label={`Edit ${dashboard.name} setup`}
              onClick={onEditSetup}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 transition-colors hover:border-sky-500/50 hover:text-sky-300"
            >
              <IconPencil className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-sm text-slate-400">
            {entity.name} · curriculum desk (FX Risk · Liquidity · Analytics · Hedging)
          </p>
        </div>
        <button
          onClick={() => setTimingOpen(true)}
          className="shrink-0 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500"
          title="Calendar dates and payin/payout timing that drive the carry calculation"
        >
          Timing · {timingSummary(timing)}
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
          icon={<IconGauge className="h-7 w-7" />}
          title="No risk profiles yet"
          body="Add asset-class profiles: Cash/FX with inputs, decision and analytical layers, plus Bonds / Investments / Equities / Commodities stubs."
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
                <ProfileTypeIcon
                  type={p.type}
                  className={`h-4 w-4 ${active?.id === p.id ? 'text-blue-400' : 'text-current'}`}
                />
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
              <IconPlus className="h-4 w-4" />
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
                      {active.fxConfig.inputs.map(m => (
                        <span key={m} className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-300">
                          {FX_INPUTS.find(o => o.id === m)?.label ?? m}
                        </span>
                      ))}
                      {(active.fxConfig.decisionLayers ?? []).map(m => (
                        <span key={m} className="rounded bg-amber-500/15 px-2 py-0.5 text-amber-200">
                          {DECISION_LAYERS.find(o => o.id === m)?.label ?? m}
                        </span>
                      ))}
                      {(active.fxConfig.analyticalLayers ?? []).map(m => (
                        <span key={m} className="rounded bg-violet-500/15 px-2 py-0.5 text-violet-200">
                          {ANALYTICAL_LAYERS.find(o => o.id === m)?.label ?? m}
                        </span>
                      ))}
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
                  className="inline-flex items-center gap-1 text-xs text-slate-500 transition-colors hover:text-red-400"
                >
                  <IconTrash className="h-3.5 w-3.5" />
                  Delete profile
                </button>
              </div>

              {active.type === 'fx' ? (
                <div className="overflow-hidden rounded-xl border border-slate-800">
                  <WorkbenchFxDesk
                    entity={entity}
                    dashboard={dashboard}
                    profile={active}
                    varSetup={varSetup}
                    onVarSetupChange={onVarSetupChange}
                    hedgeBook={hedgeBook}
                    onHedgeBookChange={onHedgeBookChange}
                    onFormulaChange={onFormulaChange}
                    onFormulaChanges={onFormulaChanges}
                    onForecastProfileChange={onForecastProfileChange}
                  />
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-16 text-center">
                  <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-700 bg-slate-950 text-slate-400">
                    <ProfileTypeIcon type={active.type} className="h-7 w-7" />
                  </div>
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
          <p className="mt-1 text-slate-500">Hedge, forward and swap tenor default to matching the cycle. Timing re-weights the natural LP cash carry only.</p>
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
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-950 text-slate-400">
            <IconDashboard className="h-4 w-4" />
          </div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
        </div>
        <button
          type="button"
          title="Delete"
          aria-label={`Delete ${title}`}
          onClick={onDelete}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-500 opacity-0 transition-all hover:border-rose-500/60 hover:text-rose-400 group-hover:opacity-100"
        >
          <IconTrash className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-xs text-slate-400">{meta}</p>
      {description && <p className="mt-2 text-sm text-slate-400">{description}</p>}
      <button
        type="button"
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
  icon: ReactNode;
  title: string;
  body: string;
  cta: string;
  onCta: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-10 text-center">
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-700 bg-slate-950 text-slate-400">
        {icon}
      </div>
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">{body}</p>
      <button
        onClick={onCta}
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
      >
        <IconPlus className="h-4 w-4" />
        {cta}
      </button>
    </div>
  );
}

function ModalShell({
  title, subtitle, onClose, children, footer, wide, headerIcon,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
  headerIcon?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className={`flex max-h-[90vh] w-full flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl ${
          wide ? 'max-w-2xl' : 'max-w-lg'
        }`}
        onClick={e => e.stopPropagation()}
      >
        <div className="border-b border-slate-800 px-6 py-4">
          <div className="flex items-start gap-3">
            {headerIcon && (
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-600/15 text-blue-300">
                {headerIcon}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-white">{title}</h2>
              {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        <div className="flex justify-end gap-3 border-t border-slate-800 px-6 py-4">{footer}</div>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none';
const primaryBtn =
  'inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-40';
const ghostBtn =
  'inline-flex items-center gap-2 rounded-md border border-slate-600 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800';

function EntityModal({
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    name: string;
    baseCurrency: string;
    description?: string;
    withFxSetup: boolean;
    dashboardName: string;
    fxConfig?: FxProfileConfig;
  }) => void;
}) {
  const [name, setName] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [description, setDescription] = useState('');
  const [withFxSetup, setWithFxSetup] = useState(true);
  const [dashboardName, setDashboardName] = useState('');

  return (
    <ModalShell
      title="Create entity"
      subtitle="Legal entity with optional dashboard + Cash/FX metrics (FX Risk, Hedging, Risk Metrics)."
      onClose={onClose}
      headerIcon={<IconEntity className="h-5 w-5" />}
      wide
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          <button
            className={primaryBtn}
            disabled={!name.trim()}
            onClick={() =>
              onCreate({
                name: name.trim(),
                baseCurrency,
                description: description.trim() || undefined,
                withFxSetup,
                dashboardName: dashboardName.trim() || `${name.trim()} FX`,
                fxConfig: withFxSetup ? defaultCurriculumFxConfig() : undefined,
              })
            }
          >
            <IconPlus className="h-4 w-4" />
            {withFxSetup ? 'Create entity + Cash/FX' : 'Create entity only'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-slate-300">Entity name</label>
            <input
              autoFocus
              className={inputClass}
              placeholder="e.g. Deel US"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-300">Base currency</label>
            <select className={inputClass} value={baseCurrency} onChange={e => setBaseCurrency(e.target.value)}>
              {BASE_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-300">Description</label>
            <input
              className={inputClass}
              placeholder="Optional role / hub note"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setWithFxSetup(v => !v)}
          className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
            withFxSetup
              ? 'border-emerald-600/50 bg-emerald-950/30'
              : 'border-slate-700 bg-slate-950/40 hover:border-slate-600'
          }`}
        >
          <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg border ${
            withFxSetup
              ? 'border-emerald-600/40 bg-emerald-900/40 text-emerald-300'
              : 'border-slate-700 bg-slate-900 text-slate-400'
          }`}
          >
            <IconGauge className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white">
              Include dashboard + Cash/FX profile
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Applies curriculum defaults: FX Risk, Hedging Decision, Risk Metrics (VaR), and
              optimization metrics — same checklist as Guided structure setup.
            </p>
            {withFxSetup && (
              <div className="mt-3">
                <label className="mb-1 block text-xs font-medium text-slate-400">Dashboard name</label>
                <input
                  className={inputClass}
                  placeholder={name.trim() ? `${name.trim()} FX` : 'Entity FX'}
                  value={dashboardName}
                  onClick={e => e.stopPropagation()}
                  onChange={e => {
                    e.stopPropagation();
                    setDashboardName(e.target.value);
                  }}
                />
              </div>
            )}
          </div>
        </button>
      </div>
    </ModalShell>
  );
}

// ── Add-risk-profile wizard ──────────────────────────────────────────────────

const PROFILE_STEPS = [
  { id: 'classes', label: 'Asset classes' },
  { id: 'layers', label: 'FX layers' },
  { id: 'ccy', label: 'Currencies' },
  { id: 'metrics', label: 'Opt. metrics' },
] as const;

function ProfileWizard({
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    types: RiskProfileType[];
    fxConfig?: FxProfileConfig;
  }) => void;
}) {
  const curriculum = defaultCurriculumFxConfig();
  const [step, setStep] = useState(0);
  const [types, setTypes] = useState<Set<RiskProfileType>>(new Set(['fx']));
  const [inputs, setInputs] = useState<Set<FxInput>>(new Set(curriculum.inputs));
  const [decisionLayers, setDecisionLayers] = useState<Set<DecisionLayer>>(
    new Set(curriculum.decisionLayers ?? []),
  );
  const [analyticalLayers, setAnalyticalLayers] = useState<Set<AnalyticalLayer>>(
    new Set(curriculum.analyticalLayers ?? []),
  );
  const [ccyMode, setCcyMode] = useState<'all' | 'selected'>('all');
  const [ccys, setCcys] = useState<Set<string>>(new Set(['EUR', 'GBP', 'JPY']));
  const [metrics, setMetrics] = useState<Set<OptMetric>>(
    new Set(curriculum.optimizationMetrics),
  );

  const toggle = <T,>(set: Set<T>, setter: (s: Set<T>) => void, val: T) => {
    const next = new Set(set);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    setter(next);
  };

  const isFx = types.has('fx');
  const lastStep = isFx ? 3 : 0;
  const visibleSteps = isFx ? PROFILE_STEPS : [PROFILE_STEPS[0]];

  const applyCurriculumDefaults = () => {
    const cfg = defaultCurriculumFxConfig();
    setInputs(new Set(cfg.inputs));
    setDecisionLayers(new Set(cfg.decisionLayers ?? []));
    setAnalyticalLayers(new Set(cfg.analyticalLayers ?? []));
    setMetrics(new Set(cfg.optimizationMetrics));
    setCcyMode('all');
  };

  const canNext = () => {
    if (step === 0) return types.size > 0;
    if (isFx && step === 1) return inputs.has('fxExposure');
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
            decisionLayers: [...decisionLayers],
            analyticalLayers: [...analyticalLayers],
          }
        : undefined,
    });
  };

  return (
    <ModalShell
      title="Add risk profile"
      subtitle="Choose asset classes, then configure Cash/FX inputs, decision and analytical layers."
      onClose={onClose}
      wide
      headerIcon={<IconGauge className="h-5 w-5" />}
      footer={
        <>
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          {step > 0 && (
            <button className={ghostBtn} onClick={() => setStep(s => s - 1)}>Back</button>
          )}
          {step < lastStep ? (
            <button className={primaryBtn} disabled={!canNext()} onClick={() => setStep(s => s + 1)}>
              Continue
            </button>
          ) : (
            <button className={primaryBtn} disabled={!canNext()} onClick={finish}>
              <IconPlus className="h-4 w-4" />
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
      <ol className="mb-5 flex flex-wrap gap-2">
        {visibleSteps.map((s, i) => {
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
              {i + 1}. {s.label}
            </li>
          );
        })}
      </ol>

      {step === 0 && (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Select one or more asset classes. Cash/FX opens the simulator; other classes are stub sections for now.
          </p>
          {RISK_PROFILE_TYPES.map(t => {
            const selected = types.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(types, setTypes, t.id)}
                className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
                  selected
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-700 hover:border-slate-600'
                }`}
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
                    selected
                      ? 'border-blue-500/40 bg-blue-600/20 text-blue-300'
                      : 'border-slate-700 bg-slate-950 text-slate-400'
                  }`}
                >
                  <ProfileTypeIcon type={t.id} className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
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
        </div>
      )}

      {isFx && step === 1 && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-400">
              Curriculum checklist:{' '}
              <span className="text-emerald-300/90">FX Risk</span>,{' '}
              <span className="text-emerald-300/90">Hedging Decision</span>,{' '}
              <span className="text-emerald-300/90">Risk Metrics</span>.
            </p>
            <button type="button" className={ghostBtn} onClick={applyCurriculumDefaults}>
              Apply curriculum defaults
            </button>
          </div>

          <ChipPickSection
            title="FX inputs"
            requiredIds={new Set(['fxExposure'])}
            items={FX_INPUTS.map(x => ({ id: x.id, label: x.label, description: x.description }))}
            selected={[...inputs]}
            onToggle={id => toggle(inputs, setInputs, id as FxInput)}
          />
          <ChipPickSection
            title="Decision layers"
            requiredIds={new Set(['hedging'])}
            items={DECISION_LAYERS.map(x => ({
              id: x.id,
              label: x.label,
              description: x.description,
            }))}
            selected={[...decisionLayers]}
            onToggle={id => toggle(decisionLayers, setDecisionLayers, id as DecisionLayer)}
          />
          <ChipPickSection
            title="Analytical layers"
            requiredIds={new Set(['riskMetrics'])}
            items={ANALYTICAL_LAYERS.filter(x => x.available).map(x => ({
              id: x.id,
              label: x.label,
              description: x.description,
            }))}
            selected={[...analyticalLayers]}
            onToggle={id => toggle(analyticalLayers, setAnalyticalLayers, id as AnalyticalLayer)}
          />
        </div>
      )}

      {isFx && step === 2 && (
        <div>
          <p className="mb-3 text-sm text-slate-400">Select currencies for this Cash/FX book.</p>
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
                  type="button"
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
          <p className="mb-3 text-sm text-slate-400">
            Optimization metrics map to simulator layers (floor, payout buffer, carry, portfolio VaR).
          </p>
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

function ChipPickSection({
  title,
  items,
  selected,
  onToggle,
  requiredIds,
}: {
  title: string;
  items: { id: string; label: string; description: string }[];
  selected: string[];
  onToggle: (id: string) => void;
  requiredIds?: Set<string>;
}) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-slate-200">{title}</h4>
      <div className="flex flex-wrap gap-2">
        {items.map(item => {
          const on = selected.includes(item.id);
          const required = requiredIds?.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              title={item.description}
              onClick={() => onToggle(item.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                on
                  ? required
                    ? 'border-emerald-500 bg-emerald-600/25 text-emerald-100'
                    : 'border-blue-500 bg-blue-600/30 text-blue-100'
                  : required
                    ? 'border-emerald-800/80 bg-slate-800 text-emerald-200/70 hover:border-emerald-600'
                    : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500'
              }`}
            >
              {required ? '★ ' : ''}{item.label}
            </button>
          );
        })}
      </div>
    </div>
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
