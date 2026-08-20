import {
  hedgeBookContentScore,
  mergeHedgeBooksPreservingPrepared,
  pickHedgeBooksForWrite,
} from '@/lib/hedge-book-normalize';
import {
  buildSandboxFullPutBody,
  buildSandboxHedgePatchBody,
  canUseKeepaliveFetch,
} from '@/lib/test-mode/sandbox-put';
import {
  loadSandbox,
  newerSandboxState,
  normalizeSandboxState,
  preferWorkspaceSetup,
  resetSandbox,
  saveSandbox,
  seedSandbox,
} from '@/lib/test-mode/store';
import type { TestSandboxState } from '@/lib/test-mode/types';

interface ApiSandboxResponse {
  state: TestSandboxState;
  updatedAt: string;
  source: 'database' | 'seed' | 'local';
  persistent: boolean;
}

export interface SandboxPersistEvent {
  taskId: string;
  ok: boolean;
  persistent: boolean;
  status: number;
  error?: string;
}

type PersistListener = (event: SandboxPersistEvent) => void;
const persistListeners = new Set<PersistListener>();

/** UI hook for last Neon PUT (success / 401 / 503). */
export function subscribeSandboxPersist(listener: PersistListener): () => void {
  persistListeners.add(listener);
  return () => {
    persistListeners.delete(listener);
  };
}

function emitPersist(event: SandboxPersistEvent): void {
  for (const listener of persistListeners) listener(event);
}

const FETCH_INIT: Pick<RequestInit, 'credentials' | 'cache'> = {
  credentials: 'same-origin',
  cache: 'no-store',
};

export async function fetchSandboxApi(taskId: string): Promise<{
  status: number;
  body: ApiSandboxResponse | null;
  error?: string;
}> {
  try {
    const res = await fetch(
      `/api/test/sandbox?taskId=${encodeURIComponent(taskId)}`,
      FETCH_INIT,
    );
    if (!res.ok) {
      let error = `Database load failed (${res.status})`;
      try {
        const json = (await res.json()) as { error?: string };
        if (json.error) error = json.error;
      } catch {
        // ignore parse
      }
      if (res.status === 401) {
        error = 'Sign in to save hedges to the database.';
      } else if (res.status === 503) {
        error = 'Database is not configured — hedges stay in this browser only.';
      }
      return { status: res.status, body: null, error };
    }
    return { status: res.status, body: (await res.json()) as ApiSandboxResponse };
  } catch (err) {
    return {
      status: 0,
      body: null,
      error:
        err instanceof Error
          ? err.message
          : 'Could not reach the database — hedges stay in this browser.',
    };
  }
}

/**
 * Load sandbox: localStorage immediately, then merge newer server copy when
 * DATABASE_URL-backed API is available (cross-device / cross-session).
 */
export async function loadSandboxPersistent(
  userKey: string,
  taskId = '01',
): Promise<{ state: TestSandboxState; persistent: boolean; error?: string }> {
  const gen = startSandboxHydration(taskId);
  let loaded: TestSandboxState | undefined;
  try {
  const remote = await fetchSandboxApi(taskId);
  // Fast Refresh / Strict Mode remount started a newer GET — do not let this
  // stale response rewrite localStorage or queue an empty Neon PUT.
  if (!isSandboxHydrationCurrent(taskId, gen)) {
    return { state: loadSandbox(userKey), persistent: false };
  }
  // User may have booked hedges while GET was in flight — re-read disk.
  const local = loadSandbox(userKey);

  if (!remote.body) {
    const live = loadSandbox(userKey);
    loaded = live;
    // Failed GET must not PUT a local seed over an unknown Neon row.
    return { state: live, persistent: false, error: remote.error };
  }

  if (!remote.body.state || remote.body.source === 'seed') {
    const live = loadSandbox(userKey);
    loaded = live;
    if (
      isSandboxHydrationCurrent(taskId, gen)
      && remote.body.persistent
      && live.workspace.entities.length > 0
    ) {
      void persistSandboxRemote(live, taskId);
    }
    return { state: live, persistent: Boolean(remote.body.persistent) };
  }

  const remoteState = normalizeSandboxState({
    ...remote.body.state,
    updatedAt: remote.body.updatedAt ?? remote.body.state.updatedAt,
  });
  const newer = newerSandboxState(local, remoteState);
  const older = newer === local ? remoteState : local;
  const remoteMergedHedges = mergeHedgeBooksPreservingPrepared(
    newer.hedgesByEntityId,
    older.hedgesByEntityId,
  );
  // Re-read: a hedge can land in localStorage while GET/merge was running.
  const live = loadSandbox(userKey);
  const hedgesMerged = mergeHedgeBooksPreservingPrepared(
    live.hedgesByEntityId,
    remoteMergedHedges,
  );
  const remoteSetup = preferWorkspaceSetup(newer, older);
  const setup = preferWorkspaceSetup(live, {
    ...newer,
    workspace: remoteSetup.workspace,
    group: remoteSetup.group,
  });
  const merged: TestSandboxState = {
    ...newer,
    workspace: setup.workspace,
    group: setup.group,
    hedgesByEntityId: hedgesMerged,
    hedgesUpdatedAt:
      (Date.parse(live.hedgesUpdatedAt ?? '') || 0)
        >= (Date.parse(newer.hedgesUpdatedAt ?? '') || 0)
        ? live.hedgesUpdatedAt
        : newer.hedgesUpdatedAt,
    updatedAt:
      (Date.parse(live.updatedAt ?? '') || 0)
        >= (Date.parse(newer.updatedAt ?? '') || 0)
        ? (live.updatedAt ?? newer.updatedAt)
        : newer.updatedAt,
  };
  if (!isSandboxHydrationCurrent(taskId, gen)) {
    return { state: loadSandbox(userKey), persistent: false };
  }
  try {
    saveSandbox(userKey, merged);
  } catch {
    // Quota — still return the merged book; Neon PUT may still land.
  }

  const mergedScore = hedgeBookContentScore(hedgesMerged);
  const newerScore = hedgeBookContentScore(newer.hedgesByEntityId);
  const localAt = Date.parse(local.updatedAt ?? '') || 0;
  const remoteAt = Date.parse(remoteState.updatedAt ?? '') || 0;
  if (
    isSandboxHydrationCurrent(taskId, gen)
    && (
      localAt > remoteAt
      || mergedScore.prepared > newerScore.prepared
      || mergedScore.booked > newerScore.booked
      || mergedScore.desk > newerScore.desk
      || mergedScore.carry > newerScore.carry
      || mergedScore.market > newerScore.market
    )
  ) {
    void persistSandboxRemote(merged, taskId);
  }

  loaded = merged;
  return { state: merged, persistent: true };
  } finally {
    finishSandboxHydration(taskId, loaded, gen);
  }
}

/** Save to localStorage and best-effort sync to the server. */
export function saveSandboxPersistent(
  userKey: string,
  state: TestSandboxState,
  taskId = '01',
): TestSandboxState {
  const incoming = normalizeSandboxState(state);
  const local =
    typeof window !== 'undefined' ? loadSandbox(userKey) : incoming;
  const picked = pickHedgeBooksForWrite(
    incoming.hedgesByEntityId,
    local.hedgesByEntityId,
    incoming.hedgesUpdatedAt,
    local.hedgesUpdatedAt,
  );
  const next: TestSandboxState = {
    ...incoming,
    hedgesByEntityId: picked.hedgesByEntityId,
    hedgesUpdatedAt: picked.hedgesUpdatedAt,
    updatedAt: new Date().toISOString(),
  };
  try {
    saveSandbox(userKey, next);
  } catch (err) {
    console.warn(
      '[sandbox] localStorage save failed — still pushing Neon',
      err,
    );
  }
  void persistSandboxRemote(next, taskId);
  return next;
}

const PERSIST_DEBOUNCE_MS = process.env.NODE_ENV === 'test' ? 0 : 400;
/** Cold Neon + first compile often takes ~8s; 8s used to time out mid-GET. */
const HYDRATION_MAX_MS = process.env.NODE_ENV === 'test' ? 0 : 30_000;

type PersistWaiter = (event: SandboxPersistEvent) => void;
const latestByTask = new Map<string, TestSandboxState>();
const waitersByTask = new Map<string, PersistWaiter[]>();
const debounceByTask = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Set<string>();
const hydrating = new Set<string>();
const hydrateGen = new Map<string, number>();
const hydrateTimer = new Map<string, ReturnType<typeof setTimeout>>();
let unloadFlushBound = false;

export function isSandboxHydrationCurrent(taskId: string, gen: number): boolean {
  return hydrateGen.get(taskId) === gen;
}

function flushQueuedPersists(): void {
  const ids = new Set([...debounceByTask.keys(), ...latestByTask.keys()]);
  for (const taskId of ids) {
    const timer = debounceByTask.get(taskId);
    if (timer) {
      clearTimeout(timer);
      debounceByTask.delete(taskId);
    }
    if (!hydrating.has(taskId)) void flushPersist(taskId);
  }
}

function bindUnloadFlush(): void {
  if (unloadFlushBound || typeof window === 'undefined') return;
  unloadFlushBound = true;
  window.addEventListener('pagehide', flushQueuedPersists);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushQueuedPersists();
  });
}

/** Block Neon PUTs until the first GET merge finishes so a thin unmount cannot wipe Postgres. */
export function startSandboxHydration(taskId: string): number {
  const gen = (hydrateGen.get(taskId) ?? 0) + 1;
  hydrateGen.set(taskId, gen);
  hydrating.add(taskId);
  const prevTimer = hydrateTimer.get(taskId);
  if (prevTimer) clearTimeout(prevTimer);
  if (HYDRATION_MAX_MS > 0) {
    hydrateTimer.set(
      taskId,
      setTimeout(() => {
        hydrateTimer.delete(taskId);
        if (hydrateGen.get(taskId) === gen && hydrating.has(taskId)) {
          console.warn(
            `[sandbox] hydration timed out taskId=${taskId} — flushing queued saves`,
          );
          finishSandboxHydration(taskId, undefined, gen);
        }
      }, HYDRATION_MAX_MS),
    );
  }
  return gen;
}

export function finishSandboxHydration(
  taskId: string,
  merged: TestSandboxState | undefined,
  gen: number,
): void {
  if (hydrateGen.get(taskId) !== gen) return;
  const timer = hydrateTimer.get(taskId);
  if (timer) {
    clearTimeout(timer);
    hydrateTimer.delete(taskId);
  }
  const queued = latestByTask.get(taskId);
  if (merged && queued) {
    const setup = preferWorkspaceSetup(queued, merged);
    latestByTask.set(taskId, {
      ...queued,
      workspace: setup.workspace,
      group: setup.group,
      hedgesByEntityId: mergeHedgeBooksPreservingPrepared(
        queued.hedgesByEntityId,
        merged.hedgesByEntityId,
      ),
      hedgesUpdatedAt:
        (Date.parse(queued.hedgesUpdatedAt ?? '') || 0)
        >= (Date.parse(merged.hedgesUpdatedAt ?? '') || 0)
          ? queued.hedgesUpdatedAt
          : merged.hedgesUpdatedAt,
    });
  }
  hydrating.delete(taskId);
  if (latestByTask.has(taskId)) void flushPersist(taskId);
}

export function cancelSandboxHydration(taskId: string): void {
  hydrateGen.set(taskId, (hydrateGen.get(taskId) ?? 0) + 1);
  hydrating.delete(taskId);
  latestByTask.delete(taskId);
  const hydrate = hydrateTimer.get(taskId);
  if (hydrate) clearTimeout(hydrate);
  hydrateTimer.delete(taskId);
  const timer = debounceByTask.get(taskId);
  if (timer) clearTimeout(timer);
  debounceByTask.delete(taskId);
}

function pageIsHiding(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

async function putSandboxJson(
  body: string,
  taskId: string,
  keepalive: boolean,
): Promise<SandboxPersistEvent> {
  try {
    const res = await fetch(
      `/api/test/sandbox?taskId=${encodeURIComponent(taskId)}`,
      {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive,
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    );
    if (!res.ok) {
      let error = `Neon PUT failed (${res.status})`;
      try {
        const json = (await res.json()) as { error?: string };
        if (json.error) error = json.error;
      } catch {
        // ignore parse
      }
      console.warn(
        `[sandbox] Neon PUT failed status=${res.status} taskId=${taskId} — ${error}`,
      );
      return {
        taskId,
        ok: false,
        persistent: false,
        status: res.status,
        error,
      };
    }
    const json = (await res.json()) as ApiSandboxResponse;
    if (!json.persistent) {
      console.warn(
        `[sandbox] Neon PUT ok but persistent=false taskId=${taskId} — check DATABASE_URL / session`,
      );
    }
    return {
      taskId,
      ok: true,
      persistent: Boolean(json.persistent),
      status: res.status,
    };
  } catch (err) {
    console.warn('[sandbox] Neon PUT network error — localStorage still saved', err);
    return {
      taskId,
      ok: false,
      persistent: false,
      status: 0,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

async function putSandboxOnce(
  state: TestSandboxState,
  taskId: string,
): Promise<SandboxPersistEvent> {
  const hedgeBody = buildSandboxHedgePatchBody(state, taskId);
  const hedgeEvent = await putSandboxJson(
    hedgeBody,
    taskId,
    pageIsHiding() && canUseKeepaliveFetch(hedgeBody),
  );
  if (!hedgeEvent.ok && (hedgeEvent.status === 401 || hedgeEvent.status === 503)) {
    return hedgeEvent;
  }
  const fullBody = buildSandboxFullPutBody(state, taskId);
  const fullEvent = await putSandboxJson(fullBody, taskId, false);
  if (fullEvent.ok && fullEvent.persistent) return fullEvent;
  if (hedgeEvent.ok && hedgeEvent.persistent) {
    return { ...hedgeEvent, error: fullEvent.error };
  }
  return fullEvent.ok ? fullEvent : hedgeEvent;
}

async function flushPersist(taskId: string): Promise<void> {
  // A GET merge is still in flight — do not PUT a remount shell over Neon.
  // finishSandboxHydration flushes the queued book once the merge lands.
  if (hydrating.has(taskId)) return;
  if (inflight.has(taskId)) {
    debounceByTask.set(
      taskId,
      setTimeout(() => {
        void flushPersist(taskId);
      }, 50),
    );
    return;
  }
  const state = latestByTask.get(taskId);
  if (!state) return;
  latestByTask.delete(taskId);
  const waiters = waitersByTask.get(taskId) ?? [];
  waitersByTask.delete(taskId);
  inflight.add(taskId);
  try {
    const event = await putSandboxOnce(state, taskId);
    emitPersist(event);
    for (const waiter of waiters) waiter(event);
  } finally {
    inflight.delete(taskId);
    if (latestByTask.has(taskId)) void flushPersist(taskId);
  }
}

export async function persistSandboxRemote(
  state: TestSandboxState,
  taskId = '01',
): Promise<boolean> {
  bindUnloadFlush();
  const prev = latestByTask.get(taskId);
  const picked = prev
    ? pickHedgeBooksForWrite(
        state.hedgesByEntityId,
        prev.hedgesByEntityId,
        state.hedgesUpdatedAt,
        prev.hedgesUpdatedAt,
      )
    : null;
  latestByTask.set(
    taskId,
    picked
      ? {
          ...state,
          hedgesByEntityId: picked.hedgesByEntityId,
          hedgesUpdatedAt: picked.hedgesUpdatedAt,
        }
      : state,
  );
  if (hydrating.has(taskId)) {
    return new Promise<boolean>(resolve => {
      const list = waitersByTask.get(taskId) ?? [];
      list.push(event => resolve(event.ok && event.persistent));
      waitersByTask.set(taskId, list);
    });
  }
  const event = await new Promise<SandboxPersistEvent>(resolve => {
    const list = waitersByTask.get(taskId) ?? [];
    list.push(resolve);
    waitersByTask.set(taskId, list);
    const prev = debounceByTask.get(taskId);
    if (prev) clearTimeout(prev);
    debounceByTask.set(
      taskId,
      setTimeout(() => {
        void flushPersist(taskId);
      }, PERSIST_DEBOUNCE_MS),
    );
  });
  return event.ok && event.persistent;
}

export async function resetSandboxPersistent(
  userKey: string,
  taskId = '01',
): Promise<TestSandboxState> {
  cancelSandboxHydration(taskId);
  const next = resetSandbox(userKey, taskId);
  try {
    await fetch(`/api/test/sandbox?taskId=${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    // local reset still applies
  }
  void persistSandboxRemote(next, taskId);
  return next;
}

export function emptyLoadedSandbox(taskId = '01'): TestSandboxState {
  return seedSandbox(taskId);
}
