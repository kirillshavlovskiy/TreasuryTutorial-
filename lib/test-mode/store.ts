import {
  createEntity,
  type Workspace,
} from '@/lib/workspace-store';
import { ensureTask01FxLayers } from '@/lib/test-mode/score';
import type {
  TaskAnswers,
  TaskProgress,
  TaskStepId,
  TestSandboxState,
} from '@/lib/test-mode/types';

const STORAGE_PREFIX = 'treasury:test:';
const STATE_VERSION = 3; // v3: parent-group consolidated dashboard

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
    varExposureBasis: '',
    varHorizon: '',
    eurVarUsdK: '',
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
    seededAt: new Date().toISOString(),
  };
}

interface StoredBlob extends TestSandboxState {
  version?: number;
}

export function loadSandbox(userKey: string): TestSandboxState {
  if (typeof window === 'undefined') return seedSandbox();
  try {
    const raw = window.localStorage.getItem(storageKey(userKey));
    if (!raw) return seedSandbox();
    const parsed = JSON.parse(raw) as StoredBlob;
    // Migrate away from pre-v2 account-ladder sandbox shape.
    if (!parsed?.version || parsed.version < STATE_VERSION) return seedSandbox();
    if (!parsed.workspace || !Array.isArray(parsed.workspace.entities)) {
      return seedSandbox();
    }
    // Reject legacy / corrupt entities (e.g. TestEntity with legalName only).
    const entitiesOk = parsed.workspace.entities.every(
      (e: { name?: unknown; baseCurrency?: unknown }) =>
        typeof e?.name === 'string' &&
        e.name.length > 0 &&
        typeof e?.baseCurrency === 'string' &&
        e.baseCurrency.length > 0,
    );
    if (!entitiesOk) return seedSandbox();
    const seeded = seedSandbox();
    const group = parsed.group?.dashboard
      ? {
          ...parsed.group,
          dashboard: {
            ...parsed.group.dashboard,
            // Default: include every entity currently in the workspace.
            includedEntityIds:
              parsed.group.dashboard.includedEntityIds ??
              parsed.workspace.entities.map((e: { id: string }) => e.id),
          },
        }
      : seeded.group;
    const defaults = defaultTaskProgress();
    const workspace = ensureTask01FxLayers(parsed.workspace);
    const state: TestSandboxState = {
      workspace,
      group,
      answers: { ...emptyAnswers(), ...parsed.answers },
      progress: {
        taskId: parsed.progress?.taskId ?? defaults.taskId,
        steps: { ...defaults.steps, ...parsed.progress?.steps },
      },
      lastScore: parsed.lastScore,
      seededAt: parsed.seededAt ?? new Date().toISOString(),
    };
    // Persist layer backfill so Validate matches what the UI already shows.
    if (workspace !== parsed.workspace) {
      saveSandbox(userKey, state);
    }
    return state;
  } catch {
    return seedSandbox();
  }
}

export function saveSandbox(userKey: string, state: TestSandboxState): void {
  if (typeof window === 'undefined') return;
  const blob: StoredBlob = { ...state, version: STATE_VERSION };
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
