import {
  hedgeSidecarStorageKey,
  hedgeWorkspaceFitScore,
  mergeHedgeBooksPreservingPrepared,
  mergeHedgesWithSidecar,
  normalizeHedgeBooksMap,
  parseHedgeSidecar,
  pickHedgeBooksForWrite,
  rebindHedgeBooksToWorkspace,
  serializeHedgeSidecar,
} from '@/lib/hedge-book-normalize';
import { NORDTECH_ENTITY_IDS } from '@/lib/test-mode/fixtures/nordtech-accounts';
import {
  createEntity,
  type Workspace,
} from '@/lib/workspace-store';
import { ensureTask01FxLayers } from '@/lib/test-mode/score';
import type { VarSetup } from '@/lib/test-mode/var-setup';
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
    varVolHistorical: '',
    varVolImplied: '',
    varRateVol: '',
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
      id: NORDTECH_ENTITY_IDS.us,
      name: 'NordTech US',
      baseCurrency: 'USD',
      description: 'Parent · USD hub — settles group cash',
    },
    {
      id: NORDTECH_ENTITY_IDS.de,
      name: 'NordTech GmbH',
      baseCurrency: 'EUR',
      description: 'Frankfurt · EUR operating hub · debt · EU billing',
    },
    {
      id: NORDTECH_ENTITY_IDS.pl,
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

function normalizeVarSetupBlob(raw: unknown): VarSetup | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as VarSetup;
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
  const hedges = normalizeHedgeBooksMap(blob.hedgesByEntityId);

  if (
    !blob.workspace
    || !Array.isArray(blob.workspace.entities)
    || !blob.workspace.entities.every(isEntityShape)
  ) {
    return {
      ...seeded,
      hedgesByEntityId: rebindHedgeBooksToWorkspace(
        hedges,
        seeded.workspace.entities,
        normalizeUi(blob.ui).entityId,
      ),
      varSetup: normalizeVarSetupBlob(blob.varSetup) ?? seeded.varSetup,
      ui: normalizeUi(blob.ui),
      updatedAt: blob.updatedAt ?? seeded.updatedAt,
      hedgesUpdatedAt:
        typeof blob.hedgesUpdatedAt === 'string' ? blob.hedgesUpdatedAt : undefined,
    };
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
  const ui = normalizeUi(blob.ui);

  return {
    workspace,
    group,
    answers: { ...emptyAnswers(), ...blob.answers },
    progress: {
      taskId: blob.progress?.taskId ?? defaults.taskId,
      steps: { ...defaults.steps, ...blob.progress?.steps },
    },
    lastScore: blob.lastScore,
    hedgesByEntityId: rebindHedgeBooksToWorkspace(
      hedges,
      workspace.entities,
      ui.entityId,
    ),
    varSetup: normalizeVarSetupBlob(blob.varSetup),
    ui,
    seededAt: blob.seededAt ?? new Date().toISOString(),
    updatedAt: blob.updatedAt ?? new Date().toISOString(),
    hedgesUpdatedAt:
      typeof blob.hedgesUpdatedAt === 'string' ? blob.hedgesUpdatedAt : undefined,
  };
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function readHedgeSidecar(userKey: string) {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    return parseHedgeSidecar(
      storage.getItem(hedgeSidecarStorageKey(storageKey(userKey))),
    );
  } catch {
    return null;
  }
}

function writeHedgeSidecar(
  userKey: string,
  hedges: TestSandboxState['hedgesByEntityId'],
  hedgesUpdatedAt?: string,
  storage: Storage | null = getLocalStorage(),
): void {
  if (!storage) return;
  const payload = serializeHedgeSidecar(hedges, hedgesUpdatedAt);
  try {
    storage.setItem(
      hedgeSidecarStorageKey(storageKey(userKey)),
      payload,
    );
  } catch {
    // Quota — full blob write may still succeed, or Neon PUT will.
  }
}

function withSidecarHedges(state: TestSandboxState, userKey: string): TestSandboxState {
  const picked = mergeHedgesWithSidecar(
    state.hedgesByEntityId,
    state.hedgesUpdatedAt,
    readHedgeSidecar(userKey),
  );
  return {
    ...state,
    hedgesByEntityId: rebindHedgeBooksToWorkspace(
      picked.hedgesByEntityId,
      state.workspace.entities,
      state.ui?.entityId,
    ),
    hedgesUpdatedAt: picked.hedgesUpdatedAt,
  };
}

function peekSandboxState(userKey: string): TestSandboxState {
  const storage = getLocalStorage();
  if (!storage) return seedSandbox();
  try {
    const raw = storage.getItem(storageKey(userKey));
    if (!raw) return withSidecarHedges(seedSandbox(), userKey);
    const parsed = JSON.parse(raw) as StoredBlob;
    // Migrate away from pre-v2 account-ladder sandbox shape.
    // v3 → v4 is additive (hedges/ui); keep workspace/answers/progress.
    if (!parsed?.version || parsed.version < 3) {
      return withSidecarHedges(seedSandbox(), userKey);
    }
    return withSidecarHedges(normalizeSandboxState(parsed), userKey);
  } catch {
    return withSidecarHedges(seedSandbox(), userKey);
  }
}

/** Read local sandbox. Never writes — a GET/hydration must not clobber a newer book. */
export function loadSandbox(userKey: string): TestSandboxState {
  return peekSandboxState(userKey);
}

export function saveSandbox(
  userKey: string,
  state: TestSandboxState,
  opts?: { replaceHedges?: boolean },
): void {
  const storage = getLocalStorage();
  if (!storage) return;
  const incoming = normalizeSandboxState(state);
  const existing = opts?.replaceHedges ? null : peekSandboxState(userKey);
  const picked = existing
    ? pickHedgeBooksForWrite(
        incoming.hedgesByEntityId,
        existing.hedgesByEntityId,
        incoming.hedgesUpdatedAt,
        existing.hedgesUpdatedAt,
      )
    : {
        hedgesByEntityId: incoming.hedgesByEntityId,
        hedgesUpdatedAt: incoming.hedgesUpdatedAt,
      };
  const blob: StoredBlob = {
    ...incoming,
    hedgesByEntityId: picked.hedgesByEntityId,
    hedgesUpdatedAt: picked.hedgesUpdatedAt,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
    version: STATE_VERSION,
  };
  // Sidecar first: a quota throw on the fat workspace blob must not drop hedges.
  writeHedgeSidecar(userKey, blob.hedgesByEntityId, blob.hedgesUpdatedAt, storage);
  storage.setItem(storageKey(userKey), JSON.stringify(blob));
}

export function resetSandbox(userKey: string, taskId = '01'): TestSandboxState {
  const next = seedSandbox(taskId);
  saveSandbox(userKey, next, { replaceHedges: true });
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

/** Count FX risk profiles — used so a newer empty shell cannot wipe a set-up workspace. */
export function workspaceFxProfileCount(state: TestSandboxState): number {
  return state.workspace.entities.reduce(
    (n, e) =>
      n
      + e.dashboards.reduce(
        (m, d) => m + d.riskProfiles.filter(p => p.type === 'fx').length,
        0,
      ),
    0,
  );
}

/**
 * Prefer the side with real FX setup when timestamps alone would keep an empty
 * reseed over a completed Task 01 workspace (common after guest/localStorage drift).
 * When profile counts tie, keep the workspace whose entity ids still match the hedge book.
 */
export function preferWorkspaceSetup(
  primary: TestSandboxState,
  secondary: TestSandboxState,
): Pick<TestSandboxState, 'workspace' | 'group'> {
  const primaryScore = workspaceFxProfileCount(primary);
  const secondaryScore = workspaceFxProfileCount(secondary);
  if (secondaryScore > primaryScore) {
    return { workspace: secondary.workspace, group: secondary.group };
  }
  if (secondaryScore === primaryScore) {
    const primaryFit = hedgeWorkspaceFitScore(
      primary.hedgesByEntityId,
      primary.workspace.entities.map(e => e.id),
    );
    const secondaryFit = hedgeWorkspaceFitScore(
      secondary.hedgesByEntityId,
      secondary.workspace.entities.map(e => e.id),
    );
    if (secondaryFit > primaryFit) {
      return { workspace: secondary.workspace, group: secondary.group };
    }
  }
  return { workspace: primary.workspace, group: primary.group };
}

export { mergeHedgeBooksPreservingPrepared } from '@/lib/hedge-book-normalize';

/**
 * Server PUT guard: a newer empty / structure-only / thinner hedge blob must
 * not replace booked tickets, prepared packages, or desk overlay already in
 * Postgres. A stale PUT (older updatedAt) is merged into the existing row.
 */
export function sandboxStateWithProtectedHedges(
  incoming: TestSandboxState,
  existing: TestSandboxState | null | undefined,
): TestSandboxState {
  if (!existing) return incoming;
  const incomingAt = Date.parse(incoming.updatedAt ?? '') || 0;
  const existingAt = Date.parse(existing.updatedAt ?? '') || 0;
  if (incomingAt < existingAt) {
    return {
      ...existing,
      hedgesByEntityId: mergeHedgeBooksPreservingPrepared(
        existing.hedgesByEntityId,
        incoming.hedgesByEntityId,
      ),
      hedgesUpdatedAt:
        (Date.parse(incoming.hedgesUpdatedAt ?? '') || 0)
          > (Date.parse(existing.hedgesUpdatedAt ?? '') || 0)
          ? incoming.hedgesUpdatedAt
          : existing.hedgesUpdatedAt,
    };
  }

  const picked = pickHedgeBooksForWrite(
    incoming.hedgesByEntityId,
    existing.hedgesByEntityId,
    incoming.hedgesUpdatedAt,
    existing.hedgesUpdatedAt,
  );
  return {
    ...incoming,
    hedgesByEntityId: picked.hedgesByEntityId,
    hedgesUpdatedAt: picked.hedgesUpdatedAt,
  };
}
