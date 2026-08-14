'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import Link from 'next/link';
import { Simulator, type SimulatorTab } from '@/app/dashboard/Simulator';
import { TaskScore } from '@/components/test-mode/TaskScore';
import { HedgingDecisionLayer } from '@/components/test-mode/HedgingDecisionLayer';
import { ConsolidatedLiveLadder } from '@/components/test-mode/ConsolidatedLiveLadder';
import { DataUploadPanel } from '@/components/test-mode/DataUploadPanel';
import { VarAnalyticsPanel } from '@/components/test-mode/VarAnalyticsPanel';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import type { RowState } from '@/lib/fx-buffer';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import {
  TEST_GUEST_USER_KEY,
  aggregateBookedHedges,
  applyConsolidatedBookedChange,
  computeConsolidatedRisk,
  consolidateEntityBooks,
  defaultSandboxUi,
  emptyHedgeBook,
  entityHasLocalPositions,
  loadSandboxPersistent,
  localReadinessByEntity,
  localsReadyForConsolidation,
  DEFAULT_VAR_SETUP,
  ensureTask01FxLayers,
  GROUP_HEDGE_SCOPE,
  markStep,
  parseForecastMonths,
  parseForecastUncertainty1m,
  normalizeVarSetup,
  parseVarAveragingConvention,
  parseVarConfidencePct,
  parseVarExposureBasis,
  parseVarHorizonId,
  parseVarSetup,
  parseVarVolSource,
  parseVolOverrides,
  resetSandboxPersistent,
  saveSandboxPersistent,
  scoreTask01,
  parseRateVolBpYr,
  serializeRateVolOverride,
  serializeVolOverride,
  simSeedForEntity,
  mergedEntityForecastProfile,
  setupLabel,
  VAR_PROFILE_OPTIONS,
  TASK01_REQUIRED_ANALYTICAL_LAYERS,
  TASK01_REQUIRED_DECISION_LAYERS,
  TASK01_REQUIRED_FX_INPUTS,
  type CarryProfileSessionV1,
  type EntityHedgeBook,
  type ForecastHedgeStructure,
  type HedgeTicket,
  type PreparedHedgeProfile,
  type SandboxUiState,
  type TaskAnswers,
  type TaskStepId,
  type TestSandboxState,
  type VarSetup,
} from '@/lib/test-mode';
import {
  ANALYTICAL_LAYERS,
  DECISION_LAYERS,
  createDashboard,
  createRiskProfile,
  deleteDashboard,
  deleteEntity,
  deleteRiskProfile,
  renameDashboard,
  renameEntity,
  resolveTimingFractions,
  RISK_PROFILE_TYPES,
  FX_INPUTS,
  TASK01_INACTIVE_EXTRA_METRICS,
  TASK01_INACTIVE_FX_INPUTS,
  updateDashboardFormula,
  updateDashboardFormulas,
  updateDashboardForecastProfile,
  updateDashboardTiming,
  updateFxProfileConfig,
  type AnalyticalLayer,
  type Dashboard,
  type DecisionLayer,
  type Entity,
  type FxInput,
  type FxProfileConfig,
  type OptMetric,
  type RiskProfile,
  type RiskProfileType,
  type TimingProfile,
  type Workspace,
} from '@/lib/workspace-store';

export type SandboxPlayMode = 'curriculum' | 'practice';

interface Task01AppProps {
  userKey: string;
  /** Guided Validate rails vs free NordTech exploration. */
  mode?: SandboxPlayMode;
  /** Persistence slot (`01` curriculum · `practice` self practice). */
  taskId?: string;
}

const TASK01_TAB_LABELS: Partial<Record<SimulatorTab, string>> = {
  simulator: 'FX Risk',
  hedging: 'Hedging Decision',
  liveLadder: 'Consolidated Live Ladder',
  analytics: 'Analytics',
  liquidity: 'Liquidity',
  dataUpload: 'Market data',
  sensitivity: 'Sensitivity',
  monteCarlo: 'Monte Carlo',
};

/** Always hide LP Layer Setup / IR Profile / Sensitivity in Task 01. */
const TASK01_BASE_HIDDEN: SimulatorTab[] = ['layers', 'irprofile', 'sensitivity'];

/** Analytical layers selectable in Task Mode create/edit (Sensitivity blocked). */
const TASK01_SELECTABLE_ANALYTICAL = new Set<AnalyticalLayer>(['riskMetrics']);

/**
 * Shared fallback for a book that does not exist yet. Calling emptyHedgeBook()
 * inline in render would hand every consumer a new object identity on each
 * pass, and the CFaR panel keys its Monte Carlo memos on the market-rate map
 * inside it — so an un-booked entity would re-run the simulation on every
 * keystroke. Only ever read, never mutated.
 */
const EMPTY_HEDGE_BOOK = emptyHedgeBook();

function hiddenTabsForLayers(
  decision: readonly DecisionLayer[],
  analytical: readonly AnalyticalLayer[],
): SimulatorTab[] {
  const hide = new Set<SimulatorTab>(TASK01_BASE_HIDDEN);
  if (!decision.includes('hedging')) {
    hide.add('hedging');
    hide.add('liveLadder'); // Live Ladder sits next to Hedging Decision
  }
  if (!analytical.includes('riskMetrics')) {
    hide.add('analytics');
    hide.add('liquidity'); // cash / carry sits with Analytics layer
    hide.add('dataUpload'); // market data sits with Analytics layer
  }
  // Sensitivity is never offered in Task Mode (see TASK01_BASE_HIDDEN).
  if (!analytical.includes('monteCarlo')) hide.add('monteCarlo');
  return [...hide];
}

function sanitizeTaskAnalytical(layers: readonly AnalyticalLayer[]): AnalyticalLayer[] {
  return layers.filter(l => TASK01_SELECTABLE_ANALYTICAL.has(l));
}

const STEPS: { id: TaskStepId; label: string }[] = [
  { id: 'buildWorkspace', label: 'Group FX + entity dashboards + FX profiles' },
  { id: 'largestMismatch', label: 'Largest mismatch on consolidated book' },
  { id: 'setVarConfidence', label: 'Configure VaR in Analytics (conf · horizon · exposure)' },
  { id: 'readVar', label: 'Identify VaR at Δ = 1 for your setup' },
];

function ProfileTypeIcon({
  type,
  size = 14,
  className = '',
}: {
  type: RiskProfileType;
  size?: number;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true as const,
  };
  switch (type) {
    case 'fx':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18" />
          <path d="M12 3a14 14 0 0 0 0 18" />
        </svg>
      );
    case 'bonds':
      return (
        <svg {...common}>
          <path d="M4 19V5" />
          <path d="M4 19h16" />
          <path d="M8 15v-4" />
          <path d="M12 15V8" />
          <path d="M16 15v-6" />
          <path d="M20 15v-2" />
        </svg>
      );
    case 'investments':
      return (
        <svg {...common}>
          <rect x="3" y="10" width="4" height="10" rx="0.5" />
          <rect x="10" y="6" width="4" height="14" rx="0.5" />
          <rect x="17" y="3" width="4" height="17" rx="0.5" />
        </svg>
      );
    case 'equities':
      return (
        <svg {...common}>
          <path d="M4 19V5" />
          <path d="M4 19h16" />
          <path d="M7 14l4-4 3 3 5-6" />
          <path d="M16 7h3v3" />
        </svg>
      );
    case 'commodities':
      return (
        <svg {...common}>
          <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
          <path d="M12 12 4 7" />
          <path d="M12 12v11" />
          <path d="m12 12 8-5" />
        </svg>
      );
    default:
      return null;
  }
}

export function Task01App({
  userKey,
  mode = 'curriculum',
  taskId = '01',
}: Task01AppProps) {
  const storageKey = userKey || TEST_GUEST_USER_KEY;
  const isPractice = mode === 'practice';
  const [state, setState] = useState<TestSandboxState | null>(null);
  const [view, setView] = useState<'home' | 'group' | 'entity'>('home');
  const [entityId, setEntityId] = useState<string | null>(null);
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [modal, setModal] = useState<'none' | 'dashboard' | 'profile'>('none');
  const [showValidate, setShowValidate] = useState(false);
  /** Entity (+ group-scope) hedge books — rolled into consolidated FX metrics. */
  const [hedgesByEntityId, setHedgesByEntityId] = useState<
    Record<string, EntityHedgeBook>
  >({});
  const [resumeReady, setResumeReady] = useState(false);
  const [serverPersistent, setServerPersistent] = useState(false);

  /** Always-current hedges/UI for persist — avoids stale closures wiping prepared. */
  const hedgesRef = useRef(hedgesByEntityId);
  hedgesRef.current = hedgesByEntityId;
  const uiRef = useRef<SandboxUiState>({
    view,
    entityId,
    dashboardId,
    activeProfileId,
  });
  uiRef.current = {
    view,
    entityId,
    dashboardId,
    activeProfileId,
  };

  const currentUi = (): SandboxUiState => uiRef.current;

  const persist = (
    next: TestSandboxState,
    hedges: Record<string, EntityHedgeBook> = hedgesRef.current,
    ui: SandboxUiState = uiRef.current,
  ) => {
    const saved = saveSandboxPersistent(
      storageKey,
      {
        ...next,
        hedgesByEntityId: hedges,
        ui,
      },
      taskId,
    );
    setState(saved);
    hedgesRef.current = saved.hedgesByEntityId ?? {};
    setHedgesByEntityId(hedgesRef.current);
    return saved;
  };

  useEffect(() => {
    let cancelled = false;
    setResumeReady(false);
    void (async () => {
      const { state: loaded, persistent } = await loadSandboxPersistent(
        storageKey,
        taskId,
      );
      if (cancelled) return;
      setServerPersistent(persistent);
      const loadedHedges = loaded.hedgesByEntityId ?? {};
      hedgesRef.current = loadedHedges;
      setState(loaded);
      setHedgesByEntityId(loadedHedges);
      const ui = loaded.ui ?? defaultSandboxUi();
      setView(ui.view);
      setEntityId(ui.entityId);
      setDashboardId(ui.dashboardId);
      setActiveProfileId(ui.activeProfileId);
      setResumeReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [storageKey, taskId]);

  // Persist navigation so the next login resumes the same screen.
  useEffect(() => {
    if (!state || !resumeReady) return;
    const ui = currentUi();
    const prev = state.ui ?? defaultSandboxUi();
    if (
      prev.view === ui.view
      && prev.entityId === ui.entityId
      && prev.dashboardId === ui.dashboardId
      && prev.activeProfileId === ui.activeProfileId
    ) {
      return;
    }
    persist(state, hedgesRef.current, ui);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional navigation snapshot
  }, [view, entityId, dashboardId, activeProfileId, resumeReady]);

  // If locals are incomplete, never stay on the consolidated view.
  useEffect(() => {
    if (!state) return;
    if (view === 'group' && !localsReadyForConsolidation(state.workspace)) {
      setView('home');
      setEntityId(null);
      setDashboardId(null);
    }
  }, [view, state]);

  const update = (
    next: TestSandboxState | ((prev: TestSandboxState) => TestSandboxState),
  ) => {
    if (typeof next === 'function') {
      setState(current => {
        if (!current) return current;
        const resolved = next(current);
        const saved = saveSandboxPersistent(
          storageKey,
          {
            ...resolved,
            // Prefer live hedges ref — never a render-closure snapshot.
            hedgesByEntityId: hedgesRef.current,
            ui: uiRef.current,
          },
          taskId,
        );
        const hedges = saved.hedgesByEntityId ?? hedgesRef.current;
        hedgesRef.current = hedges;
        // Keep React hedge state in lockstep — otherwise a later persist can
        // rewrite Neon/localStorage from a stale empty prepared book.
        setHedgesByEntityId(hedges);
        return saved;
      });
      return;
    }
    persist(next);
  };

  const updateHedges = (
    next:
      | Record<string, EntityHedgeBook>
      | ((prev: Record<string, EntityHedgeBook>) => Record<string, EntityHedgeBook>),
  ) => {
    setHedgesByEntityId(prev => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      hedgesRef.current = resolved;
      setState(current => {
        if (!current) return current;
        return saveSandboxPersistent(
          storageKey,
          {
            ...current,
            hedgesByEntityId: resolved,
            ui: uiRef.current,
          },
          taskId,
        );
      });
      return resolved;
    });
  };

  const setWorkspace = (workspace: Workspace) => {
    if (!state) return;
    update({ ...state, workspace });
  };

  if (!state) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10 text-sm text-slate-400">
        Loading sandbox…
      </main>
    );
  }

  const { workspace, answers, progress, group } = state;
  const entity = workspace.entities.find(e => e.id === entityId);
  const dashboard = entity?.dashboards.find(d => d.id === dashboardId);
  const localsReady = localsReadyForConsolidation(workspace);
  const localReadiness = localReadinessByEntity(workspace);
  const wide = view === 'group' || Boolean(dashboard);

  const openGroup = () => {
    if (!localsReadyForConsolidation(workspace)) return;
    const dash = group.dashboard ?? {
      id: 'grp-dash-fx',
      name: 'Group FX (consolidated)',
      createdAt: new Date().toISOString(),
      opened: true,
      includedEntityIds: workspace.entities.map(e => e.id),
    };
    update({
      ...state,
      group: {
        ...group,
        dashboard: {
          ...dash,
          opened: true,
          includedEntityIds:
            dash.includedEntityIds ?? workspace.entities.map(e => e.id),
        },
      },
    });
    setView('group');
    setEntityId(null);
    setDashboardId(null);
  };

  const saveGroupDashboard = (patch: {
    name: string;
    includedEntityIds: string[];
  }) => {
    const dash = group.dashboard ?? {
      id: 'grp-dash-fx',
      name: patch.name,
      createdAt: new Date().toISOString(),
      opened: false,
    };
    update({
      ...state,
      group: {
        ...group,
        dashboard: {
          ...dash,
          name: patch.name.trim() || dash.name,
          includedEntityIds: patch.includedEntityIds,
        },
      },
    });
  };

  const consolidatedEntities = (() => {
    const ids = group.dashboard?.includedEntityIds;
    if (!ids || ids.length === 0) return workspace.entities;
    const set = new Set(ids);
    return workspace.entities.filter(e => set.has(e.id));
  })();

  const varSetup: VarSetup = normalizeVarSetup({
    confidencePct:
      parseVarConfidencePct(answers.varConfidencePct) ?? DEFAULT_VAR_SETUP.confidencePct,
    exposureBasis:
      parseVarExposureBasis(answers.varExposureBasis) ?? DEFAULT_VAR_SETUP.exposureBasis,
    horizon: parseVarHorizonId(answers.varHorizon) ?? DEFAULT_VAR_SETUP.horizon,
    forecastMonths:
      parseForecastMonths(answers.varForecastMonths) ?? DEFAULT_VAR_SETUP.forecastMonths,
    forecastUncertainty1m:
      parseForecastUncertainty1m(answers.varForecastUncertainty) ??
      DEFAULT_VAR_SETUP.forecastUncertainty1m,
    volSource:
      parseVarVolSource(answers.varVolSource ?? '') ?? DEFAULT_VAR_SETUP.volSource,
    volOverrides: parseVolOverrides({
      varVolHistorical: answers.varVolHistorical,
      varVolImplied: answers.varVolImplied,
    }),
    rateVolOverrideBpYr: parseRateVolBpYr(answers.varRateVol) ?? undefined,
    averagingConvention:
      parseVarAveragingConvention(answers.varAveragingConvention ?? '') ??
      DEFAULT_VAR_SETUP.averagingConvention,
  });

  const setVarSetup = (setup: VarSetup) => {
    const next = normalizeVarSetup(setup);
    update({
      ...state,
      answers: {
        ...answers,
        varConfidencePct: String(next.confidencePct),
        varExposureBasis: next.exposureBasis,
        varHorizon: next.horizon,
        varForecastMonths: String(next.forecastMonths),
        varForecastUncertainty:
          next.forecastUncertainty1m > 0 ? String(next.forecastUncertainty1m) : '',
        varVolSource: next.volSource,
        varVolHistorical: serializeVolOverride(next, 'historical'),
        varVolImplied: serializeVolOverride(next, 'implied'),
        varRateVol: serializeRateVolOverride(next),
        varAveragingConvention: next.averagingConvention,
      },
      progress: markStep(progress, 'setVarConfidence'),
    });
  };

  const answersReady = answersComplete(answers);

  const runValidate = () => {
    if (!answersComplete(answers)) return;
    // Persist Task 01 layer defaults so score matches UI (tabs shown via fallback).
    const ws = ensureTask01FxLayers(workspace);
    const groupOpened = Boolean(state.group.dashboard?.opened);
    const result = scoreTask01(ws, answers, groupOpened);
    let nextProgress = progress;
    if (result.checks.find(c => c.id === 'entities')?.pass
      && result.checks.find(c => c.id === 'groupDashboard')?.pass
      && result.checks.find(c => c.id === 'dashboards')?.pass
      && result.checks.find(c => c.id === 'fxProfiles')?.pass
      && result.checks.find(c => c.id === 'fxInputs')?.pass
      && result.checks.find(c => c.id === 'decisionLayers')?.pass
      && result.checks.find(c => c.id === 'analyticalLayers')?.pass) {
      nextProgress = markStep(nextProgress, 'buildWorkspace');
    }
    if (result.checks.find(c => c.id === 'answerCcy')?.pass
      && result.checks.find(c => c.id === 'answerAmount')?.pass) {
      nextProgress = markStep(nextProgress, 'largestMismatch');
    }
    if (result.checks.find(c => c.id === 'answerConfidence')?.pass) {
      nextProgress = markStep(nextProgress, 'setVarConfidence');
    }
    if (result.checks.find(c => c.id === 'answerVar')?.pass) {
      nextProgress = markStep(nextProgress, 'readVar');
    }
    update({
      ...state,
      workspace: ws,
      lastScore: result,
      progress: nextProgress,
    });
    setShowValidate(true);
  };

  const firstPendingStep = STEPS.find(s => progress.steps[s.id] !== 'done')?.id;

  return (
    <main className={`mx-auto px-6 py-8 ${wide ? 'max-w-screen-2xl' : 'max-w-6xl'}`}>
      <div className="mb-4">
        <Link
          href="/test"
          title="Back to Curriculum vs Self Practice"
          className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/50 bg-violet-500/15 px-3 py-1.5 text-xs font-semibold text-violet-100 transition-colors hover:border-violet-400 hover:bg-violet-500/25"
        >
          ← Sandbox portal
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                isPractice
                  ? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/50'
                  : 'bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/50'
              }`}
            >
              {isPractice ? 'Self practice' : 'Curriculum'}
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {isPractice
              ? 'NordTech — Self practice'
              : 'SIGMA TASK 01 — Map the Book'}
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {isPractice
              ? 'Explore entity books, Group FX, VaR regimes and hedge booking without Validate rails.'
              : 'Build entity dashboards → find the largest mismatch → configure VaR in Analytics (confidence · horizon · exposure) → read VaR at Δ = 1 for that setup.'}
          </p>
          <p className="mt-1 text-[11px] text-slate-600">
            {serverPersistent
              ? isPractice
                ? 'Practice book syncs to your account (separate from curriculum Task 01).'
                : 'Progress syncs to your account — continue on any device after sign-in.'
              : 'Progress is saved in this browser for your Google account. Add DATABASE_URL for cross-device sync.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isPractice && (
            <button
              type="button"
              onClick={runValidate}
              disabled={!answersReady}
              title={answersReady ? 'Validate answers' : 'Fill all answer fields first'}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Validate
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const next = await resetSandboxPersistent(storageKey, taskId);
                setState(next);
                setHedgesByEntityId({});
                setView('home');
                setEntityId(null);
                setDashboardId(null);
                setActiveProfileId(null);
                setShowValidate(false);
              })();
            }}
            className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
          >
            Reset sandbox
          </button>
        </div>
      </div>

      {!isPractice && (
        <ol className="sticky top-0 z-10 mt-6 flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-950/95 p-3 backdrop-blur">
          {STEPS.map((s, i) => {
            const done = progress.steps[s.id] === 'done';
            const current = !done && s.id === firstPendingStep;
            return (
              <li
                key={s.id}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  done
                    ? 'bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-500/50'
                    : current
                      ? 'bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/60'
                      : 'bg-slate-800/80 text-slate-500'
                }`}
              >
                <span className={done ? 'text-emerald-400' : current ? 'text-amber-300' : 'text-slate-600'}>
                  {done ? '✓' : i + 1}.
                </span>{' '}
                {s.label}
              </li>
            );
          })}
        </ol>
      )}

      <div
        className={`mt-6 grid gap-6 ${
          isPractice ? '' : 'lg:grid-cols-[1fr_300px]'
        }`}
      >
        <div className="min-w-0">
          <Breadcrumb
            view={view}
            groupName={group.name}
            entity={entity}
            dashboard={dashboard}
            onHome={() => { setView('home'); setEntityId(null); setDashboardId(null); }}
            onEntity={() => { setView('entity'); setDashboardId(null); }}
          />

          {view === 'group' ? (
            <GroupConsolidatedView
              varSetup={varSetup}
              onVarSetupChange={setVarSetup}
              entities={consolidatedEntities}
              allEntities={workspace.entities}
              groupDashboardName={group.dashboard?.name ?? 'Group FX (consolidated)'}
              includedEntityIds={
                group.dashboard?.includedEntityIds ?? workspace.entities.map(e => e.id)
              }
              onEditSettings={saveGroupDashboard}
              hedgesByEntityId={hedgesByEntityId}
              onHedgesByEntityIdChange={updateHedges}
            />
          ) : view === 'home' || !entity ? (
            <EntitiesView
              groupName={group.name}
              groupDashboardName={group.dashboard?.name ?? 'Group FX (consolidated)'}
              groupOpened={Boolean(group.dashboard?.opened)}
              groupUnlocked={localsReady}
              localReadiness={localReadiness}
              includedEntityIds={
                group.dashboard?.includedEntityIds ?? workspace.entities.map(e => e.id)
              }
              onOpenGroup={openGroup}
              onSaveGroup={saveGroupDashboard}
              entities={workspace.entities}
              onOpen={id => {
                setView('entity');
                setEntityId(id);
                setDashboardId(null);
              }}
              onRename={(id, name) => setWorkspace(renameEntity(workspace, id, name))}
              onDelete={id => setWorkspace(deleteEntity(workspace, id))}
            />
          ) : !dashboard ? (
            <DashboardsView
              entity={entity}
              onBack={() => {
                setView('home');
                setEntityId(null);
                setDashboardId(null);
              }}
              onOpen={id => { setDashboardId(id); setActiveProfileId(null); }}
              onCreate={() => setModal('dashboard')}
              onSaveDashboard={(id, patch) => {
                let ws = renameDashboard(workspace, entity.id, id, patch.name);
                if (patch.fxProfileId && patch.fxConfig) {
                  ws = updateFxProfileConfig(
                    ws,
                    entity.id,
                    id,
                    patch.fxProfileId,
                    patch.fxConfig,
                  );
                }
                setWorkspace(ws);
              }}
              onDelete={id => setWorkspace(deleteDashboard(workspace, entity.id, id))}
            />
          ) : (
            <DashboardView
              entity={entity}
              dashboard={dashboard}
              activeProfileId={activeProfileId}
              onSelect={setActiveProfileId}
              onAdd={() => setModal('profile')}
              varSetup={varSetup}
              onVarSetupChange={setVarSetup}
              hedgeBook={hedgesByEntityId[entity.id] ?? EMPTY_HEDGE_BOOK}
              onHedgeBookChange={updater =>
                updateHedges(prev => ({
                  ...prev,
                  [entity.id]: updater(prev[entity.id] ?? emptyHedgeBook()),
                }))
              }
              onSaveDashboard={patch => {
                let ws = renameDashboard(workspace, entity.id, dashboard.id, patch.name);
                if (patch.fxProfileId && patch.fxConfig) {
                  ws = updateFxProfileConfig(
                    ws,
                    entity.id,
                    dashboard.id,
                    patch.fxProfileId,
                    patch.fxConfig,
                  );
                }
                setWorkspace(ws);
              }}
              onDelete={id =>
                setWorkspace(deleteRiskProfile(workspace, entity.id, dashboard.id, id))
              }
              onTimingChange={t =>
                update(prev => {
                  if (!entity || !dashboard) return prev;
                  return {
                    ...prev,
                    workspace: updateDashboardTiming(
                      prev.workspace,
                      entity.id,
                      dashboard.id,
                      t,
                    ),
                  };
                })
              }
              onFormulaChange={(cellKey, formula) =>
                update(prev => {
                  if (!entity || !dashboard) return prev;
                  return {
                    ...prev,
                    workspace: updateDashboardFormula(
                      prev.workspace,
                      entity.id,
                      dashboard.id,
                      cellKey,
                      formula,
                    ),
                  };
                })
              }
              onFormulaChanges={updates =>
                update(prev => {
                  if (!entity || !dashboard) return prev;
                  return {
                    ...prev,
                    workspace: updateDashboardFormulas(
                      prev.workspace,
                      entity.id,
                      dashboard.id,
                      updates,
                    ),
                  };
                })
              }
              onForecastProfileChange={profile =>
                update(prev => {
                  if (!entity || !dashboard) return prev;
                  return {
                    ...prev,
                    workspace: updateDashboardForecastProfile(
                      prev.workspace,
                      entity.id,
                      dashboard.id,
                      profile,
                    ),
                  };
                })
              }
            />
          )}
        </div>

        {!isPractice && (
          <aside className="space-y-4 lg:sticky lg:top-16 lg:self-start">
            <AnswersPanel
              answers={answers}
              onChange={next => update({ ...state, answers: next })}
            />
            <button
              type="button"
              onClick={runValidate}
              disabled={!answersReady}
              title={answersReady ? 'Validate answers' : 'Fill all answer fields first'}
              className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Validate progress & answers
            </button>
            {!answersReady && (
              <p className="text-[11px] text-amber-400/90">
                Complete every field in Your answers before Validate.
              </p>
            )}
            {state.lastScore && showValidate && <TaskScore result={state.lastScore} />}
            <p className="text-[11px] leading-relaxed text-slate-500">
              Finish entity dashboards → mismatch → Analytics setup → VaR at Δ = 1. Answers must
              match your chosen confidence / horizon / exposure (±5%).
            </p>
          </aside>
        )}
      </div>

      {modal === 'dashboard' && entity && (
        <NameModal
          title="New dashboard"
          subtitle={`Create a dashboard for ${entity.name}`}
          placeholder="e.g. EUR book"
          onClose={() => setModal('none')}
          onCreate={name => {
            const { workspace: ws, dashboard: created } = createDashboard(
              workspace,
              entity.id,
              name,
            );
            setWorkspace(ws);
            setDashboardId(created.id);
            setModal('none');
          }}
        />
      )}

      {modal === 'profile' && entity && dashboard && (
        <ProfileWizard
          entity={entity}
          existingTypes={dashboard.riskProfiles.map(p => p.type)}
          onClose={() => setModal('none')}
          onCreate={input => {
            const seed = simSeedForEntity(entity);
            const currencies =
              input.currencies.length > 0
                ? input.currencies
                : seed.profileCurrencies.filter(c => c !== 'USD');
            const taken = new Set(dashboard.riskProfiles.map(p => p.type));
            // Task 01 practice: Cash/FX only.
            const types = input.types.filter(t => t === 'fx' && !taken.has(t));
            let ws = workspace;
            let firstId: string | null = null;
            for (const type of types) {
              const label = RISK_PROFILE_TYPES.find(t => t.id === type)?.label ?? type;
              const res = createRiskProfile(ws, entity.id, dashboard.id, {
                type,
                name: label,
                fxConfig:
                  type === 'fx'
                    ? {
                        inputs: input.inputs,
                        currencyMode: currencies.length > 0 ? 'selected' : 'all',
                        currencies,
                        optimizationMetrics: input.optimizationMetrics,
                        decisionLayers: input.decisionLayers,
                        analyticalLayers: sanitizeTaskAnalytical(input.analyticalLayers),
                      }
                    : undefined,
              });
              ws = res.workspace;
              if (!firstId) firstId = res.profile.id;
            }
            setWorkspace(ws);
            setModal('none');
            if (firstId) setActiveProfileId(firstId);
          }}
        />
      )}
    </main>
  );
}

function answersComplete(answers: TaskAnswers): boolean {
  return (
    answers.largestMismatchCcy.trim().length > 0
    && answers.largestMismatchAmount.trim().length > 0
    && answers.varConfidencePct.trim().length > 0
    && answers.varExposureBasis.trim().length > 0
    && answers.varHorizon.trim().length > 0
    && answers.eurVarUsdK.trim().length > 0
  );
}

function AnswersPanel({
  answers,
  onChange,
}: {
  answers: TaskAnswers;
  onChange: (a: TaskAnswers) => void;
}) {
  const setup = parseVarSetup(answers);
  const ready = answersComplete(answers);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="text-sm font-semibold text-white">Your answers</h3>
      <p className="mt-1 text-[11px] text-slate-500">
        Mismatch exposure for your Analytics basis → setup → VaR at Δ = 1 from the book.
        {!ready && (
          <span className="mt-1 block text-amber-400/90">All fields required.</span>
        )}
      </p>
      <label className="mt-3 block text-[11px] text-slate-400">
        Largest mismatch currency
        <input
          value={answers.largestMismatchCcy}
          onChange={e => onChange({ ...answers, largestMismatchCcy: e.target.value })}
          placeholder="CCY"
          className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
        />
      </label>
      <label className="mt-2 block text-[11px] text-slate-400">
        Largest mismatch (local M)
        <span className="mt-0.5 block text-[10px] text-slate-600">
          Exposure @ Δ1 under your VaR profile (Simple / Time-weighted / Growth
          path)
        </span>
        <input
          value={answers.largestMismatchAmount}
          onChange={e => onChange({ ...answers, largestMismatchAmount: e.target.value })}
          placeholder="local M"
          className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
        />
      </label>
      <label className="mt-2 block text-[11px] text-slate-400">
        VaR confidence %
        <input
          value={answers.varConfidencePct}
          onChange={e => onChange({ ...answers, varConfidencePct: e.target.value })}
          placeholder="%"
          className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
        />
      </label>
      <label className="mt-2 block text-[11px] text-slate-400">
        VaR analysis horizon (1w / 1m / 3m / 6m / 9m / 1y)
        <span className="mt-0.5 block text-[10px] text-slate-600">
          Vol √T only — Task Q / Analytics. Does not scale forecast exposure.
        </span>
        <input
          value={answers.varHorizon}
          onChange={e => onChange({ ...answers, varHorizon: e.target.value })}
          placeholder="horizon"
          className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
        />
      </label>
      <label className="mt-2 block text-[11px] text-slate-400">
        Forecast period (months)
        <span className="mt-0.5 block text-[10px] text-slate-600">
          From FX Risk — scales Net FX Forecast / total buildup (0 = none / 1 / 3 / 6 / 12)
        </span>
        <input
          value={answers.varForecastMonths}
          onChange={e => onChange({ ...answers, varForecastMonths: e.target.value })}
          placeholder="months"
          className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
        />
      </label>
      <div className="mt-2 block text-[11px] text-slate-400">
        VaR profile (how VaR evolves over time)
        <span className="mt-0.5 block text-[10px] text-slate-600">
          Not a hedge regime — Cash / Target are Decision hedging only. Pick the
          Analytics VaR calculation method.
        </span>
        <div
          className="mt-1.5 flex flex-wrap gap-1"
          role="group"
          aria-label="VaR profile"
        >
          {VAR_PROFILE_OPTIONS.map(opt => {
            const parsed = parseVarExposureBasis(answers.varExposureBasis);
            const on = parsed === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={on}
                title={opt.description}
                onClick={() =>
                  onChange({ ...answers, varExposureBasis: opt.id })
                }
                className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${
                  on
                    ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-100'
                    : 'border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
      <label className="mt-2 block text-[11px] text-slate-400">
        EUR VaR @ Δ=1 for that profile ($K)
        <span className="mt-0.5 block text-[10px] text-slate-600">
          From Analytics / Risk Metrics under the VaR profile above
        </span>
        <input
          value={answers.eurVarUsdK}
          onChange={e => onChange({ ...answers, eurVarUsdK: e.target.value })}
          placeholder="$K"
          className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white"
        />
      </label>
      {setup && (
        <p className="mt-2 text-[10px] text-slate-500">
          Declared setup: {setupLabel(setup)} — score VaR against that profile.
        </p>
      )}
    </div>
  );
}

function Breadcrumb({
  view, groupName, entity, dashboard, onHome, onEntity,
}: {
  view: 'home' | 'group' | 'entity';
  groupName: string;
  entity?: Entity;
  dashboard?: Dashboard;
  onHome: () => void;
  onEntity: () => void;
}) {
  return (
    <nav className="mb-4 flex items-center gap-2 text-sm text-slate-400">
      <button type="button" onClick={onHome} className="hover:text-white">Workspace</button>
      {view === 'group' && (
        <>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200">{groupName} · Group FX</span>
        </>
      )}
      {view === 'entity' && entity && (
        <>
          <span className="text-slate-600">/</span>
          <button type="button" onClick={onEntity} className="hover:text-white">{entity.name}</button>
        </>
      )}
      {view === 'entity' && dashboard && (
        <>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200">{dashboard.name}</span>
        </>
      )}
    </nav>
  );
}

function GroupConsolidatedView({
  entities,
  allEntities,
  groupDashboardName,
  includedEntityIds,
  onEditSettings,
  varSetup,
  onVarSetupChange,
  hedgesByEntityId,
  onHedgesByEntityIdChange,
}: {
  entities: Entity[];
  allEntities: Entity[];
  groupDashboardName: string;
  includedEntityIds: string[];
  onEditSettings: (patch: { name: string; includedEntityIds: string[] }) => void;
  varSetup: VarSetup;
  onVarSetupChange: (setup: VarSetup) => void;
  hedgesByEntityId: Record<string, EntityHedgeBook>;
  onHedgesByEntityIdChange: Dispatch<
    SetStateAction<Record<string, EntityHedgeBook>>
  >;
}) {
  const book = useMemo(() => consolidateEntityBooks(entities), [entities]);
  const groupForecast = useMemo(
    () => mergedEntityForecastProfile(entities),
    [entities],
  );
  const risk = useMemo(
    () => computeConsolidatedRisk(entities, varSetup),
    [entities, varSetup],
  );
  const decision = [...TASK01_REQUIRED_DECISION_LAYERS];
  const analytical = [...TASK01_REQUIRED_ANALYTICAL_LAYERS];
  const [editing, setEditing] = useState(false);
  const [analyticsBook, setAnalyticsBook] = useState<{
    rows: RowState[];
    forecastProfile: ForecastProfileState;
  }>({ rows: [], forecastProfile: DEFAULT_FORECAST_PROFILE });
  /** Shared Analytics ↔ Decision: bullet vs rolling strip. */
  const [hedgeStructure, setHedgeStructure] =
    useState<ForecastHedgeStructure>('bullet');
  const includedNames = entities.map(e => e.name).join(' · ') || 'none';

  const entityIds = useMemo(
    () => entities.map(e => e.id),
    [entities],
  );
  const bookedHedges = useMemo(
    () => aggregateBookedHedges(hedgesByEntityId, entityIds, true),
    [hedgesByEntityId, entityIds],
  );
  const groupBook = hedgesByEntityId[GROUP_HEDGE_SCOPE] ?? EMPTY_HEDGE_BOOK;
  const hedgeRatios = groupBook.hedgeRatios;
  const preparedByCcy = groupBook.preparedByCcy ?? {};
  const carrySessionsByCcy = groupBook.carrySessionsByCcy ?? {};
  const marketRatesByCcy = groupBook.marketRatesByCcy ?? {};

  const setHedgeRatios = (ratios: Record<string, number>) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          bookedHedges: g.bookedHedges,
          hedgeRatios: ratios,
          preparedByCcy: g.preparedByCcy ?? {},
          carrySessionsByCcy: g.carrySessionsByCcy ?? {},
          marketRatesByCcy: g.marketRatesByCcy ?? {},
        },
      };
    });
  };

  const setBookedHedges = (tickets: HedgeTicket[]) => {
    // New group-level tickets (no entityId) are stamped as group-scope.
    const stamped = tickets.map(t =>
      t.entityId
        ? t
        : { ...t, entityId: GROUP_HEDGE_SCOPE, entityName: groupDashboardName },
    );
    onHedgesByEntityIdChange(prev =>
      applyConsolidatedBookedChange(stamped, entityIds, prev),
    );
  };

  const setPreparedByCcy = (next: Record<string, PreparedHedgeProfile>) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          preparedByCcy: next,
          carrySessionsByCcy: g.carrySessionsByCcy ?? {},
          marketRatesByCcy: g.marketRatesByCcy ?? {},
        },
      };
    });
  };

  const setCarrySessionsByCcy = (
    next: Record<string, CarryProfileSessionV1>,
  ) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          preparedByCcy: g.preparedByCcy ?? {},
          carrySessionsByCcy: next,
          marketRatesByCcy: g.marketRatesByCcy ?? {},
        },
      };
    });
  };

  const setMarketRatesByCcy = (
    next: Record<string, FxMarketRatesBundle>,
  ) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          preparedByCcy: g.preparedByCcy ?? {},
          carrySessionsByCcy: g.carrySessionsByCcy ?? {},
          marketRatesByCcy: next,
        },
      };
    });
  };

  /** Reset incremental hedge % after a book (ticket list updated via onBookedHedgesChange). */
  const handleBookHedge = (ticket: HedgeTicket) => {
    onHedgesByEntityIdChange(prev => {
      const g = prev[GROUP_HEDGE_SCOPE] ?? emptyHedgeBook();
      return {
        ...prev,
        [GROUP_HEDGE_SCOPE]: {
          ...g,
          bookedHedges: g.bookedHedges,
          hedgeRatios: { ...g.hedgeRatios, [ticket.ccy]: 0 },
          preparedByCcy: g.preparedByCcy ?? {},
          carrySessionsByCcy: g.carrySessionsByCcy ?? {},
          marketRatesByCcy: g.marketRatesByCcy ?? {},
        },
      };
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">{groupDashboardName}</h2>
          <p className="mt-1 text-[11px] text-slate-400">Included: {includedNames}</p>
        </div>
        <button
          type="button"
          title="Edit consolidation settings"
          aria-label="Edit consolidation settings"
          onClick={() => setEditing(true)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
        >
          <PencilIcon />
        </button>
      </div>

      {editing && (
        <GroupSettingsModal
          name={groupDashboardName}
          entities={allEntities}
          includedEntityIds={includedEntityIds}
          onClose={() => setEditing(false)}
          onSave={patch => {
            onEditSettings(patch);
            setEditing(false);
          }}
        />
      )}

      <div className="overflow-hidden rounded-xl border border-slate-800">
        <Simulator
          key={`group-consol-${includedEntityIds.slice().sort().join(',')}`}
          embedded
          simplifiedBook
          showRiskMetrics
          varSetup={varSetup}
          onVarSetupChange={onVarSetupChange}
          bookedHedges={bookedHedges}
          preparedByCcy={preparedByCcy}
          hedgeRatios={hedgeRatios}
          initialRows={book.rows}
          initialUsdCash={book.usdCash}
          initialUsdNonLpCash={book.usdNonLpCash}
          initialUsdParams={book.usdParams}
          initialActiveLayers={[]}
          fxInputs={[...TASK01_REQUIRED_FX_INPUTS]}
          forecastProfile={groupForecast}
          hiddenTabs={hiddenTabsForLayers(decision, analytical)}
          tabLabels={TASK01_TAB_LABELS}
          onAnalyticsBookChange={setAnalyticsBook}
          hedgingPanel={
            <HedgingDecisionLayer
              risk={risk}
              title="Decision layer — consolidated hedge & VaR"
              hedgeRatios={hedgeRatios}
              onHedgeRatiosChange={setHedgeRatios}
              bookedHedges={bookedHedges}
              onBookedHedgesChange={setBookedHedges}
              preparedByCcy={preparedByCcy}
              onPreparedByCcyChange={setPreparedByCcy}
              marketRatesByCcy={marketRatesByCcy}
              ratesScopeId={GROUP_HEDGE_SCOPE}
              hedgeStructure={hedgeStructure}
              onHedgeStructureChange={setHedgeStructure}
              onBookHedge={handleBookHedge}
              varSetup={varSetup}
              bookRows={analyticsBook.rows}
              forecastProfile={analyticsBook.forecastProfile}
            />
          }
          liveLadderPanel={
            <ConsolidatedLiveLadder
              rows={analyticsBook.rows.length > 0 ? analyticsBook.rows : book.rows}
              risk={risk}
              hedgeRatios={hedgeRatios}
              onHedgeRatiosChange={setHedgeRatios}
              bookedHedges={bookedHedges}
              varSetup={varSetup}
              forecastProfile={analyticsBook.forecastProfile}
              title="Consolidated Live Ladder — Group FX"
            />
          }
          analyticsPanel={
            <VarAnalyticsPanel
              risk={risk}
              setup={varSetup}
              onSetupChange={onVarSetupChange}
              hedgeRatios={hedgeRatios}
              onHedgeRatiosChange={setHedgeRatios}
              bookedHedges={bookedHedges}
              onBookedHedgesChange={setBookedHedges}
              preparedByCcy={preparedByCcy}
              onPreparedByCcyChange={setPreparedByCcy}
              marketRatesByCcy={marketRatesByCcy}
              onMarketRatesByCcyChange={setMarketRatesByCcy}
              hedgeStructure={hedgeStructure}
              onHedgeStructureChange={setHedgeStructure}
              title="Analytics — Group FX VaR setup"
              bookRows={analyticsBook.rows}
              forecastProfile={analyticsBook.forecastProfile}
              ratesScopeId={GROUP_HEDGE_SCOPE}
            />
          }
          dataUploadPanel={
            <DataUploadPanel
              scopeId={GROUP_HEDGE_SCOPE}
              scopeLabel={groupDashboardName}
              currencies={risk.map(r => r.bar.ccy)}
              title={`Market data — ${groupDashboardName}`}
              marketRatesByCcy={marketRatesByCcy}
              onMarketRatesByCcyChange={setMarketRatesByCcy}
            />
          }
        />
      </div>
    </div>
  );
}

function GroupSettingsModal({
  name: initialName,
  entities,
  includedEntityIds,
  onClose,
  onSave,
}: {
  name: string;
  entities: Entity[];
  includedEntityIds: string[];
  onClose: () => void;
  onSave: (patch: { name: string; includedEntityIds: string[] }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [included, setIncluded] = useState<Set<string>>(() => new Set(includedEntityIds));

  const toggle = (id: string) => {
    setIncluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="text-lg font-semibold text-white">Edit consolidated dashboard</h3>
        <p className="mt-1 text-xs text-slate-400">
          Choose which legal entities feed Group FX consolidation.
        </p>

        <label className="mt-4 block text-xs font-semibold text-slate-400">
          Name
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            className="mt-1.5 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal text-white"
          />
        </label>

        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-slate-400">Include in consolidation</legend>
          <div className="mt-2 space-y-2">
            {entities.map(e => {
              const ready = entityHasLocalPositions(e);
              const checked = included.has(e.id);
              return (
                <label
                  key={e.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                    checked
                      ? 'border-emerald-500/40 bg-emerald-500/10'
                      : 'border-slate-700 hover:border-slate-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(e.id)}
                    className="mt-0.5 h-4 w-4 accent-emerald-500"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white">{e.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {e.baseCurrency}
                      {ready ? ' · ready' : ' · setup incomplete'}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          {included.size === 0 && (
            <p className="mt-2 text-[11px] text-amber-400/90">
              Select at least one entity to consolidate.
            </p>
          )}
        </fieldset>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400">
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || included.size === 0}
            onClick={() =>
              onSave({ name: name.trim(), includedEntityIds: [...included] })
            }
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function EntitiesView({
  groupName, groupDashboardName, groupOpened, groupUnlocked, localReadiness,
  includedEntityIds, onOpenGroup, onSaveGroup, entities, onOpen, onRename, onDelete,
}: {
  groupName: string;
  groupDashboardName: string;
  groupOpened: boolean;
  groupUnlocked: boolean;
  localReadiness: { code: string; name: string; ready: boolean }[];
  includedEntityIds: string[];
  onOpenGroup: () => void;
  onSaveGroup: (patch: { name: string; includedEntityIds: string[] }) => void;
  entities: Entity[];
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const readyCount = localReadiness.filter(r => r.ready).length;
  const [editing, setEditing] = useState<Entity | null>(null);
  const [editingGroup, setEditingGroup] = useState(false);
  const includedSet = new Set(includedEntityIds);
  const includedLabel = entities
    .filter(e => includedSet.has(e.id))
    .map(e => e.name.replace(/^NordTech\s+/i, ''))
    .join(' · ');

  return (
    <>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white">NordTech workspace</h2>
        <p className="text-xs text-slate-500">
          Group FX sits above local books. Unlock consolidation when all three entities have
          dashboards + FX profiles ({readyCount}/3 ready).
        </p>
      </div>

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Parent · consolidated
      </div>
      {groupUnlocked ? (
        <div className="relative mb-8">
          <div className="absolute right-3 top-3 z-10">
            <button
              type="button"
              title="Edit consolidation settings"
              aria-label="Edit consolidation settings"
              onClick={() => setEditingGroup(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-emerald-700/50 bg-slate-950/60 text-emerald-300/80 hover:border-emerald-500 hover:text-emerald-200"
            >
              <PencilIcon />
            </button>
          </div>
          <button
            type="button"
            onClick={onOpenGroup}
            className="w-full rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-5 pr-14 text-left transition-colors hover:border-emerald-500/70"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
                  Parent · consolidated · unlocked
                </div>
                <div className="mt-1 text-base font-semibold text-white">{groupName}</div>
                <div className="mt-1 text-xs text-slate-400">{groupDashboardName}</div>
                <div className="mt-1 text-[11px] text-emerald-200/70">
                  Includes: {includedLabel || 'none selected'}
                </div>
              </div>
              <span className="shrink-0 text-xs font-medium text-emerald-300">
                {groupOpened ? 'Open →' : 'Open Group FX →'}
              </span>
            </div>
          </button>
        </div>
      ) : (
        <div className="mb-8 w-full rounded-xl border border-dashed border-slate-700 bg-slate-900/40 p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Parent · consolidated · locked
          </div>
          <div className="mt-1 text-base font-semibold text-slate-300">{groupName}</div>
          <p className="mt-2 text-xs text-slate-500">
            Add a dashboard and FX Risk profile on every entity below. Group FX unlocks when all
            three local books are ready — then choose which entities to consolidate.
          </p>
          <ul className="mt-3 space-y-1 text-xs">
            {localReadiness.map(r => (
              <li
                key={r.code}
                className={r.ready ? 'text-emerald-400' : 'text-slate-500'}
              >
                {r.ready ? '✓' : '○'} {r.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      {editingGroup && (
        <GroupSettingsModal
          name={groupDashboardName}
          entities={entities}
          includedEntityIds={includedEntityIds}
          onClose={() => setEditingGroup(false)}
          onSave={patch => {
            onSaveGroup(patch);
            setEditingGroup(false);
          }}
        />
      )}

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Legal entities
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entities.map(e => {
          const ready = entityHasLocalPositions(e);
          const inConsol = includedSet.has(e.id);
          return (
            <div
              key={e.id}
              className={`group relative rounded-xl border p-5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-lg ${
                ready
                  ? 'border-emerald-700/40 bg-slate-900/60 hover:border-emerald-500/60 hover:shadow-emerald-950/30'
                  : 'border-slate-800 bg-slate-900/60 hover:border-blue-500/50 hover:shadow-blue-950/40'
              }`}
            >
              <div className="absolute right-3 top-3 z-10 flex gap-1.5">
                <button
                  type="button"
                  title="Edit"
                  aria-label={`Edit ${e.name}`}
                  onClick={ev => { ev.stopPropagation(); setEditing(e); }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900/90 text-slate-400 opacity-70 transition-all hover:border-slate-500 hover:text-white hover:opacity-100 group-hover:opacity-100"
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  title="Delete"
                  aria-label={`Delete ${e.name}`}
                  onClick={ev => {
                    ev.stopPropagation();
                    if (window.confirm(`Delete entity “${e.name}”?`)) onDelete(e.id);
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900/90 text-slate-400 opacity-70 transition-all hover:border-rose-500/60 hover:text-rose-400 hover:opacity-100 group-hover:opacity-100"
                >
                  <TrashIcon />
                </button>
              </div>
              <button
                type="button"
                onClick={() => onOpen(e.id)}
                className="w-full cursor-pointer rounded-lg pr-20 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-base font-semibold text-white transition-colors group-hover:text-blue-100">
                    {e.name}
                  </div>
                  <span
                    className={`text-[10px] font-semibold uppercase ${
                      ready ? 'text-emerald-400' : 'text-amber-400/80'
                    }`}
                  >
                    {ready ? 'Ready' : 'Setup'}
                  </span>
                  {groupUnlocked && (
                    <span
                      className={`text-[10px] font-medium ${
                        inConsol ? 'text-emerald-500/80' : 'text-slate-600'
                      }`}
                    >
                      {inConsol ? 'In consol.' : 'Excluded'}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500 transition-colors group-hover:text-slate-400">
                  {e.baseCurrency} · {e.dashboards.length} dashboard
                  {e.dashboards.length === 1 ? '' : 's'}
                  {ready ? ' · FX positions' : ' · needs dashboard + FX profile'}
                </div>
                <p className="mt-2 text-xs text-slate-400">{e.description}</p>
                {e.dashboards.length > 0 ? (
                  <div className="mt-3 space-y-2 border-t border-slate-800/80 pt-3">
                    {e.dashboards.map(d => (
                      <DashboardSetupSummary key={d.id} dashboard={d} />
                    ))}
                  </div>
                ) : null}
                <div className="mt-3 text-[11px] font-medium text-slate-600 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-blue-400">
                  Open →
                </div>
              </button>
            </div>
          );
        })}
      </div>

      {editing && (
        <NameModal
          title="Edit entity"
          subtitle="Rename this legal entity"
          placeholder="Entity name"
          initialValue={editing.name}
          confirmLabel="Save"
          onClose={() => setEditing(null)}
          onCreate={name => {
            onRename(editing.id, name);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function fxSetupFromDashboard(dashboard: Dashboard): {
  currencies: string[];
  decisionLabels: string[];
  analyticalLabels: string[];
  profileLabels: { type: RiskProfileType; name: string; detail: string }[];
} {
  const currencies = new Set<string>();
  const decision = new Set<DecisionLayer>();
  const analytical = new Set<AnalyticalLayer>();
  let anyAllCcy = false;
  for (const p of dashboard.riskProfiles) {
    if (p.type !== 'fx' || !p.fxConfig) continue;
    if (p.fxConfig.currencyMode === 'all') anyAllCcy = true;
    for (const c of p.fxConfig.currencies) {
      if (c.trim()) currencies.add(c.trim().toUpperCase());
    }
    for (const l of p.fxConfig.decisionLayers ?? []) decision.add(l);
    for (const l of p.fxConfig.analyticalLayers ?? []) analytical.add(l);
  }
  const profileLabels = dashboard.riskProfiles.map(p => {
    const typeLabel = RISK_PROFILE_TYPES.find(t => t.id === p.type)?.label ?? p.type;
    const detail =
      p.type === 'fx' && p.fxConfig
        ? [
            p.fxConfig.inputs.includes('fxExposure') ? 'FX Risk' : null,
            (p.fxConfig.decisionLayers ?? []).length
              ? DECISION_LAYERS.filter(l => p.fxConfig!.decisionLayers!.includes(l.id))
                  .map(l => l.label)
                  .join(', ')
              : null,
            (p.fxConfig.analyticalLayers ?? []).length
              ? ANALYTICAL_LAYERS.filter(l => p.fxConfig!.analyticalLayers!.includes(l.id))
                  .map(l => l.label)
                  .join(', ')
              : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : p.type === 'fx'
          ? 'Cash/FX'
          : 'stub';
    return { type: p.type, name: typeLabel || p.name, detail };
  });
  return {
    currencies: anyAllCcy && currencies.size === 0 ? ['All'] : [...currencies].sort(),
    decisionLabels: DECISION_LAYERS.filter(l => decision.has(l.id)).map(l => l.label),
    analyticalLabels: ANALYTICAL_LAYERS.filter(l => analytical.has(l.id)).map(l => l.label),
    profileLabels,
  };
}

function ChipRow({ label, values, empty }: { label: string; values: string[]; empty: string }) {
  return (
    <div className="text-[11px] leading-relaxed">
      <span className="font-medium text-slate-500">{label}: </span>
      {values.length === 0 ? (
        <span className="text-slate-600">{empty}</span>
      ) : (
        <span className="text-slate-300">{values.join(' · ')}</span>
      )}
    </div>
  );
}

function DashboardSetupSummary({
  dashboard,
  showName = true,
}: {
  dashboard: Dashboard;
  showName?: boolean;
}) {
  const setup = fxSetupFromDashboard(dashboard);
  return (
    <div className="space-y-2">
      {showName ? (
        <div className="text-[11px] font-medium text-slate-400">{dashboard.name}</div>
      ) : null}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Risk profiles
        </div>
        {setup.profileLabels.length === 0 ? (
          <div className="mt-1 text-[11px] text-slate-600">None selected</div>
        ) : (
          <ul className="mt-1 space-y-1">
            {setup.profileLabels.map((p, i) => (
              <li key={`${p.type}-${p.name}-${i}`} className="flex items-start gap-1.5 text-[11px]">
                <ProfileTypeIcon type={p.type} className="mt-0.5 shrink-0 text-slate-400" />
                <span>
                  <span className="font-medium text-slate-200">{p.name}</span>
                  {p.detail ? (
                    <span className="text-slate-500"> — {p.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ChipRow label="CCY" values={setup.currencies} empty="none" />
    </div>
  );
}

type DashboardEditPatch = {
  name: string;
  fxProfileId?: string;
  fxConfig?: Partial<FxProfileConfig>;
};

function DashboardsView({
  entity, onBack, onOpen, onCreate, onSaveDashboard, onDelete,
}: {
  entity: Entity;
  onBack: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onSaveDashboard: (id: string, patch: DashboardEditPatch) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<Dashboard | null>(null);

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            className="mt-0.5 shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-800 hover:text-white"
          >
            ← Back
          </button>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white">Dashboards — {entity.name}</h2>
            <p className="text-xs text-slate-500">Create at least one dashboard for this entity.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500"
        >
          + New dashboard
        </button>
      </div>
      {entity.dashboards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400">
          No dashboards yet. Create one to open the FX Simulator table.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {entity.dashboards.map(d => (
            <div
              key={d.id}
              className="group relative rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-blue-500/50 hover:bg-slate-900 hover:shadow-lg hover:shadow-blue-950/40"
            >
              <div className="absolute right-3 top-3 z-10 flex gap-1.5">
                <button
                  type="button"
                  title="Edit"
                  aria-label={`Edit ${d.name}`}
                  onClick={e => { e.stopPropagation(); setEditing(d); }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900/90 text-slate-400 opacity-70 transition-all hover:border-slate-500 hover:text-white hover:opacity-100 group-hover:opacity-100"
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  title="Delete"
                  aria-label={`Delete ${d.name}`}
                  onClick={e => {
                    e.stopPropagation();
                    if (window.confirm(`Delete dashboard “${d.name}”?`)) onDelete(d.id);
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900/90 text-slate-400 opacity-70 transition-all hover:border-rose-500/60 hover:text-rose-400 hover:opacity-100 group-hover:opacity-100"
                >
                  <TrashIcon />
                </button>
              </div>
              <button
                type="button"
                onClick={() => onOpen(d.id)}
                className="w-full cursor-pointer rounded-lg pr-20 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
              >
                <div className="font-medium text-white transition-colors group-hover:text-blue-100">
                  {d.name}
                </div>
                <div className="mt-2">
                  <DashboardSetupSummary dashboard={d} showName={false} />
                </div>
                <div className="mt-3 text-[11px] font-medium text-slate-600 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-blue-400">
                  Open →
                </div>
              </button>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <DashboardEditModal
          entity={entity}
          dashboard={editing}
          onClose={() => setEditing(null)}
          onSave={patch => {
            onSaveDashboard(editing.id, patch);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function DashboardView({
  entity,
  dashboard,
  activeProfileId,
  onSelect,
  onAdd,
  onSaveDashboard,
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
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  onSaveDashboard: (patch: DashboardEditPatch) => void;
  onDelete: (id: string) => void;
  onTimingChange: (t: TimingProfile) => void;
  onFormulaChange: (cellKey: string, formula: string) => void;
  onFormulaChanges: (updates: Record<string, string>) => void;
  onForecastProfileChange: (profile: ForecastProfileState) => void;
  varSetup: VarSetup;
  onVarSetupChange: (setup: VarSetup) => void;
  hedgeBook: EntityHedgeBook;
  onHedgeBookChange: (updater: (prev: EntityHedgeBook) => EntityHedgeBook) => void;
}) {
  const [editingDash, setEditingDash] = useState(false);
  const profiles = dashboard.riskProfiles;
  const active =
    profiles.find(p => p.id === activeProfileId) ?? profiles[0] ?? null;

  useEffect(() => {
    if (active && active.id !== activeProfileId) onSelect(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard.id, profiles.length]);

  const seed = useMemo(() => simSeedForEntity(entity), [entity]);
  const entityRisk = useMemo(
    () => computeConsolidatedRisk([entity], varSetup),
    [entity, varSetup],
  );
  const [analyticsBook, setAnalyticsBook] = useState<{
    rows: RowState[];
    forecastProfile: ForecastProfileState;
  }>({
    rows: [],
    forecastProfile:
      dashboard.forecastProfile ??
      seed.forecastProfile ??
      DEFAULT_FORECAST_PROFILE,
  });
  /** Shared Analytics ↔ Decision: bullet vs rolling strip. */
  const [hedgeStructure, setHedgeStructure] =
    useState<ForecastHedgeStructure>('bullet');
  const hedgeRatios = hedgeBook.hedgeRatios;
  const bookedHedges = hedgeBook.bookedHedges;
  const preparedByCcy = hedgeBook.preparedByCcy ?? {};
  const carrySessionsByCcy = hedgeBook.carrySessionsByCcy ?? {};
  const marketRatesByCcy = hedgeBook.marketRatesByCcy ?? {};

  const setHedgeRatios = (ratios: Record<string, number>) => {
    onHedgeBookChange(prev => ({
      ...prev,
      hedgeRatios: ratios,
      preparedByCcy: prev.preparedByCcy ?? {},
      carrySessionsByCcy: prev.carrySessionsByCcy ?? {},
    }));
  };
  const setBookedHedges = (tickets: HedgeTicket[]) => {
    onHedgeBookChange(prev => ({
      ...prev,
      bookedHedges: tickets.map(t => ({
        ...t,
        entityId: entity.id,
        entityName: entity.name,
      })),
      preparedByCcy: prev.preparedByCcy ?? {},
      carrySessionsByCcy: prev.carrySessionsByCcy ?? {},
    }));
  };
  const setPreparedByCcy = (next: Record<string, PreparedHedgeProfile>) => {
    onHedgeBookChange(prev => ({
      ...prev,
      preparedByCcy: next,
      carrySessionsByCcy: prev.carrySessionsByCcy ?? {},
    }));
  };
  const setCarrySessionsByCcy = (
    next: Record<string, CarryProfileSessionV1>,
  ) => {
    onHedgeBookChange(prev => ({
      ...prev,
      preparedByCcy: prev.preparedByCcy ?? {},
      carrySessionsByCcy: next,
    }));
  };
  const setMarketRatesByCcy = (next: Record<string, FxMarketRatesBundle>) => {
    onHedgeBookChange(prev => ({
      ...prev,
      marketRatesByCcy: next,
    }));
  };
  const handleBookHedge = (ticket: HedgeTicket) => {
    onHedgeBookChange(prev => ({
      ...prev,
      hedgeRatios: { ...prev.hedgeRatios, [ticket.ccy]: 0 },
      preparedByCcy: prev.preparedByCcy ?? {},
      carrySessionsByCcy: prev.carrySessionsByCcy ?? {},
    }));
  };
  const fractions = resolveTimingFractions(dashboard.timing ?? {
    mode: 'preset',
    payout: 'mid',
    payin: 'end',
    payoutCustom: 50,
    payinCustom: 100,
  });

  const ladderRows = useMemo(() => {
    if (
      active?.type === 'fx'
      && active.fxConfig?.currencyMode === 'selected'
      && active.fxConfig.currencies.length > 0
    ) {
      return seed.rows.filter(r => active.fxConfig!.currencies.includes(r.ccy));
    }
    return seed.rows;
  }, [active, seed.rows]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">{dashboard.name}</h2>
          <button
            type="button"
            title="Edit dashboard"
            aria-label={`Edit ${dashboard.name}`}
            onClick={() => setEditingDash(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
          >
            <PencilIcon />
          </button>
        </div>
        <span className="text-[11px] text-slate-500">
          Timing: payout mid · payin EOM
          <button
            type="button"
            className="ml-2 text-blue-400 hover:underline"
            onClick={() =>
              onTimingChange({
                mode: 'preset',
                payout: 'mid',
                payin: 'end',
                payoutCustom: 50,
                payinCustom: 100,
              })
            }
          >
            reset
          </button>
        </span>
      </div>

      {editingDash && (
        <DashboardEditModal
          entity={entity}
          dashboard={dashboard}
          onClose={() => setEditingDash(false)}
          onSave={patch => {
            onSaveDashboard(patch);
            setEditingDash(false);
          }}
        />
      )}

      {profiles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 p-12 text-center">
          <p className="text-sm text-slate-400">Add an FX risk profile to open the simulator table.</p>
          <button
            type="button"
            onClick={onAdd}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
          >
            + Add risk profile
          </button>
        </div>
      ) : (
        <>
          <div
            data-profile-tabs
            className="flex flex-wrap items-stretch gap-1 border-b border-slate-800"
          >
            {profiles.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                className={`flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium ${
                  active?.id === p.id
                    ? 'border-blue-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <ProfileTypeIcon
                  type={p.type}
                  className={active?.id === p.id ? 'text-blue-400' : 'text-current'}
                />
                {RISK_PROFILE_TYPES.find(t => t.id === p.type)?.label ?? p.name}
              </button>
            ))}
            <button
              type="button"
              onClick={onAdd}
              title="Add risk profile"
              aria-label="Add risk profile"
              className="ml-1 flex h-11 w-11 shrink-0 items-center justify-center border-b-2 border-transparent text-blue-300 hover:bg-slate-800/80 hover:text-blue-200"
            >
              <PlusIcon />
            </button>
          </div>

          {active && (
            <div className="mt-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                  {active.type === 'fx' && active.fxConfig && (
                    <span className="rounded bg-slate-800 px-2 py-0.5">
                      {active.fxConfig.currencyMode === 'all'
                        ? 'All currencies'
                        : `${active.fxConfig.currencies.join(', ') || 'selected'}`}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onDelete(active.id)}
                  className="text-xs text-slate-500 hover:text-red-400"
                >
                  Delete profile
                </button>
              </div>

              {active.type === 'fx' ? (
                <div className="overflow-hidden rounded-xl border border-slate-800">
                  <Simulator
                    key={`${entity.id}-${active.id}`}
                    embedded
                    initialRows={
                      active.fxConfig?.currencyMode === 'selected'
                      && active.fxConfig.currencies.length > 0
                        ? seed.rows.filter(r =>
                            active.fxConfig!.currencies.includes(r.ccy),
                          )
                        : seed.rows
                    }
                    initialUsdCash={seed.usdCash}
                    initialUsdNonLpCash={seed.usdNonLpCash}
                    initialUsdParams={seed.usdParams}
                    initialActiveLayers={[]}
                    simplifiedBook
                    varSetup={varSetup}
                    onVarSetupChange={onVarSetupChange}
                    bookedHedges={bookedHedges}
                    preparedByCcy={preparedByCcy}
                    hedgeRatios={hedgeRatios}
                    onAnalyticsBookChange={setAnalyticsBook}
                    showRiskMetrics={
                      (
                        active.fxConfig?.analyticalLayers?.length
                          ? active.fxConfig.analyticalLayers
                          : [...TASK01_REQUIRED_ANALYTICAL_LAYERS]
                      ).includes('riskMetrics')
                    }
                    fxInputs={active.fxConfig?.inputs ?? [...TASK01_REQUIRED_FX_INPUTS]}
                    timing={fractions}
                    formulas={dashboard.formulas}
                    onFormulaChange={onFormulaChange}
                    onFormulaChanges={onFormulaChanges}
                    forecastProfile={
                      dashboard.forecastProfile ??
                      seed.forecastProfile ??
                      DEFAULT_FORECAST_PROFILE
                    }
                    onForecastProfileChange={onForecastProfileChange}
                    hiddenTabs={hiddenTabsForLayers(
                      // Match Group FX: missing layers → Task 01 required defaults
                      // (empty decisionLayers hid Hedging + Live Ladder and collapsed the tab nav).
                      active.fxConfig?.decisionLayers?.length
                        ? active.fxConfig.decisionLayers
                        : [...TASK01_REQUIRED_DECISION_LAYERS],
                      sanitizeTaskAnalytical(
                        active.fxConfig?.analyticalLayers?.length
                          ? active.fxConfig.analyticalLayers
                          : [...TASK01_REQUIRED_ANALYTICAL_LAYERS],
                      ),
                    )}
                    tabLabels={TASK01_TAB_LABELS}
                    hedgingPanel={
                      <HedgingDecisionLayer
                        risk={entityRisk}
                        title={`Decision layer — ${entity.name}`}
                        hedgeRatios={hedgeRatios}
                        onHedgeRatiosChange={setHedgeRatios}
                        bookedHedges={bookedHedges}
                        onBookedHedgesChange={setBookedHedges}
                        preparedByCcy={preparedByCcy}
                        onPreparedByCcyChange={setPreparedByCcy}
                        marketRatesByCcy={marketRatesByCcy}
                        ratesScopeId={entity.id}
                        hedgeStructure={hedgeStructure}
                        onHedgeStructureChange={setHedgeStructure}
                        onBookHedge={handleBookHedge}
                        varSetup={varSetup}
                        bookRows={analyticsBook.rows}
                        forecastProfile={analyticsBook.forecastProfile}
                      />
                    }
                    liveLadderPanel={
                      <ConsolidatedLiveLadder
                        rows={
                          analyticsBook.rows.length > 0
                            ? analyticsBook.rows
                            : ladderRows
                        }
                        risk={entityRisk}
                        hedgeRatios={hedgeRatios}
                        onHedgeRatiosChange={setHedgeRatios}
                        bookedHedges={bookedHedges}
                        varSetup={varSetup}
                        forecastProfile={analyticsBook.forecastProfile}
                        title={`Live Ladder — ${entity.name}`}
                      />
                    }
                    analyticsPanel={
                      <VarAnalyticsPanel
                        risk={entityRisk}
                        setup={varSetup}
                        onSetupChange={onVarSetupChange}
                        hedgeRatios={hedgeRatios}
                        onHedgeRatiosChange={setHedgeRatios}
                        bookedHedges={bookedHedges}
                        onBookedHedgesChange={setBookedHedges}
                        preparedByCcy={preparedByCcy}
                        onPreparedByCcyChange={setPreparedByCcy}
                        marketRatesByCcy={marketRatesByCcy}
                        onMarketRatesByCcyChange={setMarketRatesByCcy}
                        hedgeStructure={hedgeStructure}
                        onHedgeStructureChange={setHedgeStructure}
                        title={`Analytics — ${entity.name} VaR setup`}
                        bookRows={analyticsBook.rows}
                        forecastProfile={analyticsBook.forecastProfile}
                        ratesScopeId={entity.id}
                      />
                    }
                    dataUploadPanel={
                      <DataUploadPanel
                        scopeId={entity.id}
                        scopeLabel={entity.name}
                        currencies={entityRisk.map(r => r.bar.ccy)}
                        title={`Market data — ${entity.name}`}
                        marketRatesByCcy={marketRatesByCcy}
                        onMarketRatesByCcyChange={setMarketRatesByCcy}
                      />
                    }
                  />
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-10 text-center">
                  <div className="flex justify-center text-slate-400">
                    <ProfileTypeIcon type={active.type} size={28} />
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-white">
                    {RISK_PROFILE_TYPES.find(t => t.id === active.type)?.label ?? active.type}
                  </h3>
                  <p className="mx-auto mt-2 max-w-md text-xs text-slate-400">
                    Profile added on this dashboard. The {active.type === 'bonds' ? 'Bonds / IR (DV01)' : active.type}{' '}
                    book is not active in Task 01 yet — same inactive lane as Liquidity and optimization metrics.
                    FX remains the working book for Hedging Decision and Risk Metrics.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

function InactiveChip({
  label,
  title,
  badge = 'soon',
}: {
  label: string;
  title?: string;
  badge?: string;
}) {
  return (
    <span
      title={title ?? `${label} — coming soon`}
      className="inline-flex cursor-not-allowed items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-1 text-xs text-slate-600 opacity-60"
    >
      {label}
      <span className="text-[9px] uppercase tracking-wide text-slate-700">{badge}</span>
    </span>
  );
}

/** Task Mode chip order: Liquidity · FX Risk · DV01 · Greeks. */
const TASK01_FX_INPUT_CHIP_IDS: readonly FxInput[] = ['liquidity', 'fxExposure'];

/**
 * Single FX inputs / metrics row: Liquidity, FX Risk, DV01, Greeks.
 * Only FX Risk is selectable in Task 01.
 */
function FxInputsMetricsRow({
  inputs,
  onToggle,
}: {
  inputs: FxInput[];
  onToggle?: (id: FxInput) => void;
}) {
  const inactiveIds = TASK01_INACTIVE_FX_INPUTS as readonly string[];
  return (
    <fieldset className="mt-4">
      <legend className="text-xs font-semibold text-slate-400">FX inputs / metrics</legend>
      <p className="mt-1 text-[11px] text-slate-500">
        FX Risk is active. Liquidity, DV01 and Greeks are shown inactive.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {TASK01_FX_INPUT_CHIP_IDS.map(id => {
          const meta = FX_INPUTS.find(i => i.id === id);
          if (!meta) return null;
          if (inactiveIds.includes(id)) {
            return <InactiveChip key={id} label={meta.label} title={meta.description} />;
          }
          const checked = inputs.includes(id);
          return (
            <label
              key={id}
              title={meta.description}
              className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs ${
                checked
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'
                  : 'border-slate-700 text-slate-400'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                onChange={() => onToggle?.(id)}
                disabled={!onToggle}
              />
              {meta.label}
            </label>
          );
        })}
        {TASK01_INACTIVE_EXTRA_METRICS.map(m => (
          <InactiveChip key={m.id} label={m.label} title={m.description} />
        ))}
      </div>
    </fieldset>
  );
}

function DashboardEditModal({
  entity,
  dashboard,
  onClose,
  onSave,
}: {
  entity: Entity;
  dashboard: Dashboard;
  onClose: () => void;
  onSave: (patch: DashboardEditPatch) => void;
}) {
  const fxProfile: RiskProfile | undefined = dashboard.riskProfiles.find(p => p.type === 'fx');
  const cfg = fxProfile?.fxConfig;
  const [name, setName] = useState(dashboard.name);
  const [decisionLayers, setDecisionLayers] = useState<DecisionLayer[]>(
    cfg?.decisionLayers ?? [...TASK01_REQUIRED_DECISION_LAYERS],
  );
  const [analyticalLayers, setAnalyticalLayers] = useState<AnalyticalLayer[]>(
    sanitizeTaskAnalytical(cfg?.analyticalLayers ?? [...TASK01_REQUIRED_ANALYTICAL_LAYERS]),
  );

  const toggle = <T extends string>(list: T[], id: T, set: (v: T[]) => void) => {
    set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  };

  const otherProfiles = dashboard.riskProfiles.filter(p => p.type !== 'fx');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="text-lg font-semibold text-white">Edit dashboard</h3>
        <p className="mt-1 text-xs text-slate-400">
          {entity.name} · same presetup as create (layers active; Liquidity / DV01 / opt metrics inactive).
        </p>

        <label className="mt-4 block text-xs font-semibold text-slate-400">
          Name
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            className="mt-1.5 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal text-white"
          />
        </label>

        <div className="mt-4">
          <div className="text-xs font-semibold text-slate-400">Risk profiles on this dashboard</div>
          <ul className="mt-2 space-y-1 text-xs text-slate-300">
            {dashboard.riskProfiles.length === 0 ? (
              <li className="text-slate-600">None yet — use + Add inside the dashboard.</li>
            ) : (
                  dashboard.riskProfiles.map(p => (
                <li key={p.id} className="flex items-center gap-2">
                  <ProfileTypeIcon type={p.type} className="text-slate-400" />
                  <span>{p.name}</span>
                  <span className="text-slate-600">({p.type})</span>
                </li>
              ))
            )}
          </ul>
          {otherProfiles.length > 0 && (
            <p className="mt-2 text-[11px] text-slate-500">
              Non-FX profiles are stubs until Bonds / Investments / Equities / Commodities books ship.
            </p>
          )}
        </div>

        {fxProfile && (
          <>
            <FxInputsMetricsRow inputs={cfg?.inputs ?? [...TASK01_REQUIRED_FX_INPUTS]} />

            <fieldset className="mt-4">
              <legend className="text-xs font-semibold text-slate-400">Decision layers</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {DECISION_LAYERS.map(l => (
                  <label
                    key={l.id}
                    title={l.description}
                    className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs ${
                      decisionLayers.includes(l.id)
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-100'
                        : 'border-slate-700 text-slate-400'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={decisionLayers.includes(l.id)}
                      onChange={() => toggle(decisionLayers, l.id, setDecisionLayers)}
                    />
                    {l.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="mt-4">
              <legend className="text-xs font-semibold text-slate-400">Analytical layers</legend>
              <p className="mt-1 text-[11px] text-slate-500">
                Sensitivity is blocked in Test Mode.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {ANALYTICAL_LAYERS.map(l => {
                  const blocked = l.id === 'sensitivity' || !l.available;
                  return (
                  <label
                    key={l.id}
                    title={
                      l.id === 'sensitivity'
                        ? 'Sensitivity is blocked in Test Mode'
                        : l.description
                    }
                    className={`rounded-lg border px-2.5 py-1 text-xs ${
                      analyticalLayers.includes(l.id) && !blocked
                        ? 'border-violet-500/50 bg-violet-500/10 text-violet-100'
                        : 'border-slate-700 text-slate-400'
                    } ${blocked ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      disabled={blocked}
                      checked={l.id !== 'sensitivity' && analyticalLayers.includes(l.id)}
                      onChange={() => toggle(analyticalLayers, l.id, setAnalyticalLayers)}
                    />
                    {l.label}
                    {l.id === 'sensitivity' && (
                      <span className="ml-1 text-[9px] uppercase text-slate-600">blocked</span>
                    )}
                  </label>
                  );
                })}
              </div>
            </fieldset>
          </>
        )}

        {!fxProfile && <FxInputsMetricsRow inputs={[...TASK01_REQUIRED_FX_INPUTS]} />}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400">
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                fxProfileId: fxProfile?.id,
                fxConfig: fxProfile
                  ? {
                      decisionLayers,
                      analyticalLayers: sanitizeTaskAnalytical(analyticalLayers),
                    }
                  : undefined,
              })
            }
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function NameModal({
  title,
  subtitle,
  placeholder,
  initialValue = '',
  confirmLabel = 'Create',
  onClose,
  onCreate,
}: {
  title: string;
  subtitle: string;
  placeholder: string;
  initialValue?: string;
  confirmLabel?: string;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState(initialValue);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={placeholder}
          className="mt-4 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400">
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => onCreate(name.trim())}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileWizard({
  entity,
  existingTypes = [],
  onClose,
  onCreate,
}: {
  entity: Entity;
  /** Asset classes already on this dashboard — cannot be added again. */
  existingTypes?: RiskProfileType[];
  onClose: () => void;
  onCreate: (input: {
    types: RiskProfileType[];
    inputs: FxInput[];
    currencies: string[];
    optimizationMetrics: OptMetric[];
    decisionLayers: DecisionLayer[];
    analyticalLayers: AnalyticalLayer[];
  }) => void;
}) {
  const seed = simSeedForEntity(entity);
  const taken = new Set(existingTypes);
  const defaultTypes: RiskProfileType[] = taken.has('fx') ? [] : ['fx'];
  const [types, setTypes] = useState<RiskProfileType[]>(defaultTypes);
  const [inputs, setInputs] = useState<FxInput[]>([...TASK01_REQUIRED_FX_INPUTS]);
  const [currencies, setCurrencies] = useState<string[]>(
    seed.profileCurrencies.filter(c => c !== 'USD'),
  );
  const [decisionLayers, setDecisionLayers] = useState<DecisionLayer[]>([
    ...TASK01_REQUIRED_DECISION_LAYERS,
  ]);
  const [analyticalLayers, setAnalyticalLayers] = useState<AnalyticalLayer[]>([
    ...TASK01_REQUIRED_ANALYTICAL_LAYERS,
  ]);

  const toggle = <T extends string>(list: T[], id: T, set: (v: T[]) => void) => {
    set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-6">
        <h3 className="text-lg font-semibold text-white">Add risk profile — {entity.name}</h3>
        <p className="mt-1 text-xs text-slate-400">
          Task 01 uses Cash/FX only. Other asset classes stay disabled for this practice task.
        </p>

        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-slate-400">Asset class</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {RISK_PROFILE_TYPES.map(t => {
              const alreadyAdded = taken.has(t.id);
              // Practice Task 01: only Cash/FX is enabled — others match inactive FX metrics chips.
              if (t.id !== 'fx') {
                return (
                  <InactiveChip
                    key={t.id}
                    label={t.label}
                    title={`${t.label} is not part of Task 01`}
                  />
                );
              }
              if (alreadyAdded) {
                return (
                  <InactiveChip
                    key={t.id}
                    label={t.label}
                    title={`${t.label} is already on this dashboard`}
                    badge="added"
                  />
                );
              }
              return (
                <label
                  key={t.id}
                  title={t.description}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs ${
                    types.includes(t.id)
                      ? 'border-blue-500 bg-blue-500/15 text-blue-200'
                      : 'border-slate-700 text-slate-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={types.includes(t.id)}
                    onChange={() => toggle(types, t.id, setTypes)}
                  />
                  {t.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        {types.includes('fx') && (
          <>
            <FxInputsMetricsRow
              inputs={inputs}
              onToggle={id => toggle(inputs, id, setInputs)}
            />

            <fieldset className="mt-4">
              <legend className="text-xs font-semibold text-slate-400">Decision layers</legend>
              <p className="mt-1 text-[11px] text-slate-500">
                Hedging Decision: start at delta = 1 (unhedged), add hedge notional, read VaR.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {DECISION_LAYERS.map(l => (
                  <label
                    key={l.id}
                    title={l.description}
                    className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs ${
                      decisionLayers.includes(l.id)
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-100'
                        : 'border-slate-700 text-slate-400'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={decisionLayers.includes(l.id)}
                      onChange={() => toggle(decisionLayers, l.id, setDecisionLayers)}
                    />
                    {l.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="mt-4">
              <legend className="text-xs font-semibold text-slate-400">Analytical layers</legend>
              <p className="mt-1 text-[11px] text-slate-500">
                Risk Metrics (VaR) is active. Sensitivity is blocked in Test Mode; Monte Carlo soon.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {ANALYTICAL_LAYERS.map(l => {
                  const blocked = l.id === 'sensitivity' || !l.available;
                  return (
                  <label
                    key={l.id}
                    title={
                      l.id === 'sensitivity'
                        ? 'Sensitivity is blocked in Test Mode'
                        : l.description
                    }
                    className={`rounded-lg border px-2.5 py-1 text-xs ${
                      analyticalLayers.includes(l.id) && !blocked
                        ? 'border-violet-500/50 bg-violet-500/10 text-violet-100'
                        : 'border-slate-700 text-slate-400'
                    } ${blocked ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      disabled={blocked}
                      checked={l.id !== 'sensitivity' && analyticalLayers.includes(l.id)}
                      onChange={() => toggle(analyticalLayers, l.id, setAnalyticalLayers)}
                    />
                    {l.label}
                    {l.id === 'sensitivity' && (
                      <span className="ml-1 text-[9px] uppercase text-slate-600">blocked</span>
                    )}
                  </label>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="mt-4">
              <legend className="text-xs font-semibold text-slate-400">Currencies</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {seed.profileCurrencies.map(c => (
                  <label
                    key={c}
                    className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs ${
                      c === 'USD' || currencies.includes(c)
                        ? 'border-blue-500/50 bg-blue-500/10 text-blue-200'
                        : 'border-slate-700 text-slate-400'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      disabled={c === 'USD'}
                      checked={c === 'USD' || currencies.includes(c)}
                      onChange={() => toggle(currencies, c, setCurrencies)}
                    />
                    {c}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400">
            Cancel
          </button>
          <button
            type="button"
            disabled={types.length === 0}
            onClick={() =>
              onCreate({
                types,
                inputs: inputs.length ? inputs : [...TASK01_REQUIRED_FX_INPUTS],
                currencies,
                optimizationMetrics: [] as OptMetric[],
                decisionLayers: decisionLayers.length
                  ? decisionLayers
                  : [...TASK01_REQUIRED_DECISION_LAYERS],
                analyticalLayers: sanitizeTaskAnalytical(
                  analyticalLayers.length
                    ? analyticalLayers
                    : [...TASK01_REQUIRED_ANALYTICAL_LAYERS],
                ),
              })
            }
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
