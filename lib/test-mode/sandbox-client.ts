import {
  loadSandbox,
  newerSandboxState,
  normalizeSandboxState,
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

async function fetchJson<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const res = await fetch(input, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Load sandbox: localStorage immediately, then merge newer server copy when
 * DATABASE_URL-backed API is available (cross-device / cross-session).
 */
export async function loadSandboxPersistent(
  userKey: string,
  taskId = '01',
): Promise<{ state: TestSandboxState; persistent: boolean }> {
  const local = loadSandbox(userKey);
  const remote = await fetchJson<ApiSandboxResponse>(
    `/api/test/sandbox?taskId=${encodeURIComponent(taskId)}`,
  );

  if (!remote?.state || remote.source === 'seed') {
    // Push local progress up when the server has nothing yet.
    if (remote?.persistent && local.workspace.entities.length > 0) {
      void persistSandboxRemote(local, taskId);
    }
    return { state: local, persistent: Boolean(remote?.persistent) };
  }

  const remoteState = normalizeSandboxState({
    ...remote.state,
    updatedAt: remote.updatedAt ?? remote.state.updatedAt,
  });
  const merged = newerSandboxState(local, remoteState);
  saveSandbox(userKey, merged);

  // If local was newer, sync it to the server.
  if (merged === local || merged.updatedAt === local.updatedAt) {
    const localAt = Date.parse(local.updatedAt ?? '') || 0;
    const remoteAt = Date.parse(remoteState.updatedAt ?? '') || 0;
    if (localAt > remoteAt) {
      void persistSandboxRemote(local, taskId);
    }
  }

  return { state: merged, persistent: true };
}

/** Save to localStorage and best-effort sync to the server. */
export function saveSandboxPersistent(
  userKey: string,
  state: TestSandboxState,
  taskId = '01',
): TestSandboxState {
  const next: TestSandboxState = {
    ...normalizeSandboxState(state),
    updatedAt: new Date().toISOString(),
  };
  saveSandbox(userKey, next);
  void persistSandboxRemote(next, taskId);
  return next;
}

export async function persistSandboxRemote(
  state: TestSandboxState,
  taskId = '01',
): Promise<boolean> {
  const res = await fetchJson<ApiSandboxResponse>('/api/test/sandbox', {
    method: 'PUT',
    body: JSON.stringify({ taskId, state }),
  });
  return Boolean(res?.persistent);
}

export async function resetSandboxPersistent(
  userKey: string,
  taskId = '01',
): Promise<TestSandboxState> {
  const next = resetSandbox(userKey, taskId);
  try {
    await fetch(`/api/test/sandbox?taskId=${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    });
  } catch {
    // local reset still applies
  }
  // Seed a fresh server row so the next load does not resurrect old progress.
  void persistSandboxRemote(next, taskId);
  return next;
}

export function emptyLoadedSandbox(taskId = '01'): TestSandboxState {
  return seedSandbox(taskId);
}
