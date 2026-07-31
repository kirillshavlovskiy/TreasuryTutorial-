import {
  createEntity,
  type Workspace,
} from '@/lib/workspace-store';
import { ensureTask01FxLayers } from '@/lib/test-mode/score';
import type { EntityHedgeBook } from '@/lib/test-mode/hedge-var';
import type {
  SandboxUiState,
  TaskAnswers,
  TaskProgress,
  TaskStepId,
  TestSandboxState,
} from '@/lib/test-mode/types';

const STORAGE_PREFIX = 'treasury:test:';
/** v4: hedges + UI resume location for cross-session continuity. */
export const STATE_VERSION = 4;

export const TEST_GUEST_USER_KEY = 'test:guest';

function storageKey(userKey: string): string {
  return `${STORAGE_PREFIX}${userKey}`;
}

export function defaultTaskProgress(taskId = '01'): TaskProgress {
  return {
    taskId,
    steps: {
      buildWorkspace: 'pending',
      largestMismatch: 'pending',
      setVarConfidence: 'pending',
      readVar: 'pending',
    },
  };
}

export function emptyAnswers(): TaskAnswers {
  return {
    largestMismatchCcy: '',
    largestMismatchAmount: '',
    varConfidencePct: '',
    varExposureBasis: 'simpleAvg',
    varHorizon: '',
    varForecastMonths: '',
    varForecastUncertainty: '',
    varVolSource: '',
    varAveragingConvention: 'midMonth',
    eurVarUsdK: '',
  };
}

export function defaultSandboxUi(): SandboxUiState {
  return {
    view: 'home',
    entityId: null,
    dashboardId: null,
    activeProfileId: null,
  };
}

/** Seed three NordTech entities with empty dashboards — student creates dashboards. */
export function seedNordtechWorkspace(): Workspace {
  let ws: Workspace = { entities: [] };
  const specs = [
    {
      name: 'NordTech US',
      baseCurrency: 'USD',
      description: 'Parent · USD hub — settles group cash',
    },
    {
      name: 'NordTech GmbH',
      baseCurrency: 'EUR',
      description: 'Frankfurt · EUR operating hub · debt · EU billing',
    },
    {
      name: 'NordTech Poland',
      baseCurrency: 'PLN',
      description: 'Kraków · PLN payroll entity',
    },
  ] as const;
  for (const s of specs) {
    const res = createEntity(ws, s);
    ws = res.workspace;
  }
  return ws;
}

export function seedSandbox(taskId = '01'): TestSandboxState {
  const workspace = seedNordtechWorkspace();
  return {
    workspace,
    group: {
      name: 'NordTech Group',
      reportingCurrency: 'USD',
      // Pre-seed consolidated Group FX — student still opens it for Task 01.
      dashboard: {
        id: 'grp-dash-fx',
        name: 'Group FX (consolidated)',
        createdAt: new Date().toISOString(),
        opened: false,
        includedEntityIds: workspace.entities.map(e => e.id),
      },
    },
    answers: emptyAnswers(),
    progress: defaultTaskProgress(taskId),
    hedgesByEntityId: {},
    ui: defaultSandboxUi(),
    seededAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

interface StoredBlob extends TestSandboxState {
  version?: number;
}

function isEntityShape(e: unknown): e is { name: string; baseCurrency: string; id: string } {
  if (!e || typeof e !== 'object') return false;
  const row = e as { name?: unknown; baseCurrency?: unknown; id?: unknown };
  return (
    typeof row.name === 'string'
    && row.name.length > 0
    && typeof row.baseCurrency === 'string'
    && row.baseCurrency.length > 0
    && typeof row.id === 'string'
  );
}

function normalizeHedges(
  raw: unknown,
): Record<string, EntityHedgeBook> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, EntityHedgeBook> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const book = value as { bookedHedges?: unknown; hedgeRatios?: unknown };
    out[key] = {
      bookedHedges: Array.isArray(book.bookedHedges) ? book.bookedHedges : [],
      hedgeRatios:
        book.hedgeRatios && typeof book.hedgeRatios === 'object'
          ? (book.hedgeRatios as Record<string, number>)
          : {},
    };
  }
  return out;
}

function normalizeUi(raw: unknown): SandboxUiState {
  const defaults = defaultSandboxUi();
  if (!raw || typeof raw !== 'object') return defaults;
  const ui = raw as Partial<SandboxUiState>;
  const view =
    ui.view === 'home' || ui.view === 'group' || ui.view === 'entity'
      ? ui.view
      : defaults.view;
  return {
    view,
    entityId: typeof ui.entityId === 'string' ? ui.entityId : null,
    dashboardId: typeof ui.dashboardId === 'string' ? ui.dashboardId : null,
    activeProfileId:
      typeof ui.activeProfileId === 'string' ? ui.activeProfileId : null,
  };
}

/** Normalize any stored / API blob into a valid TestSandboxState. */
export function normalizeSandboxState(parsed: unknown): TestSandboxState {
  const seeded = seedSandbox();
  if (!parsed || typeof parsed !== 'object') return seeded;
  const blob = parsed as StoredBlob;

  if (!blob.workspace || !Array.isArray(blob.workspace.entities)) {
    return seeded;
  }
  if (!blob.workspace.entities.every(isEntityShape)) {
    return seeded;
  }

  const group = blob.group?.dashboard
    ? {
        ...blob.group,
        dashboard: {
          ...blob.group.dashboard,
          includedEntityIds:
            blob.group.dashboard.includedEntityIds
            ?? blob.workspace.entities.map(e => e.id),
        },
      }
    : seeded.group;

  const defaults = defaultTaskProgress();
  const workspace = ensureTask01FxLayers(blob.workspace);

  return {
    workspace,
    group,
    answers: { ...emptyAnswers(), ...blob.answers },
    progress: {
      taskId: blob.progress?.taskId ?? defaults.taskId,
      steps: { ...defaults.steps, ...blob.progress?.steps },
    },
    lastScore: blob.lastScore,
    hedgesByEntityId: normalizeHedges(blob.hedgesByEntityId),
    ui: normalizeUi(blob.ui),
    seededAt: blob.seededAt ?? new Date().toISOString(),
    updatedAt: blob.updatedAt ?? new Date().toISOString(),
  };
}

export function loadSandbox(userKey: string): TestSandboxState {
  if (typeof window === 'undefined') return seedSandbox();
  try {
    const raw = window.localStorage.getItem(storageKey(userKey));
    if (!raw) return seedSandbox();
    const parsed = JSON.parse(raw) as StoredBlob;
    // Migrate away from pre-v2 account-ladder sandbox shape.
    // v3 → v4 is additive (hedges/ui); keep workspace/answers/progress.
    if (!parsed?.version || parsed.version < 3) return seedSandbox();
    const state = normalizeSandboxState(parsed);
    // Persist layer / v4 backfill so Validate matches what the UI already shows.
    saveSandbox(userKey, state);
    return state;
  } catch {
    return seedSandbox();
  }
}

export function saveSandbox(userKey: string, state: TestSandboxState): void {
  if (typeof window === 'undefined') return;
  const blob: StoredBlob = {
    ...normalizeSandboxState(state),
    updatedAt: state.updatedAt ?? new Date().toISOString(),
    version: STATE_VERSION,
  };
  window.localStorage.setItem(storageKey(userKey), JSON.stringify(blob));
}

export function resetSandbox(userKey: string, taskId = '01'): TestSandboxState {
  const next = seedSandbox(taskId);
  saveSandbox(userKey, next);
  return next;
}

export function markStep(
  progress: TaskProgress,
  step: TaskStepId,
  status: 'pending' | 'done' = 'done',
): TaskProgress {
  return {
    ...progress,
    steps: { ...progress.steps, [step]: status },
  };
}

/** Pick the newer of two sandbox states by updatedAt. */
export function newerSandboxState(
  a: TestSandboxState,
  b: TestSandboxState,
): TestSandboxState {
  const aAt = Date.parse(a.updatedAt ?? a.seededAt ?? '') || 0;
  const bAt = Date.parse(b.updatedAt ?? b.seededAt ?? '') || 0;
  return bAt >= aAt ? b : a;
}
