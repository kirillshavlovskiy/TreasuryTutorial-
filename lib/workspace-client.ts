/**
 * Workbench persistence: localStorage envelope + best-effort Neon via
 * /api/test/sandbox?taskId=workspace (same sandbox_progress table as Task 01).
 */

import { hedgeBookContentScore } from '@/lib/hedge-book-normalize';
import {
  finishSandboxHydration,
  persistSandboxRemote,
  startSandboxHydration,
} from '@/lib/test-mode/sandbox-client';
import {
  defaultTaskProgress,
  emptyAnswers,
  mergeHedgeBooksPreservingPrepared,
  normalizeSandboxState,
  preferWorkspaceSetup,
  workspaceFxProfileCount,
} from '@/lib/test-mode/store';
import type { TestSandboxState } from '@/lib/test-mode/types';
import { workspaceGroupToSandboxGroup } from '@/lib/workspace-curriculum-bridge';
import {
  loadWorkspaceDetailed,
  saveWorkspace,
  type WorkspaceLoadResult,
  type WorkspaceSaveResult,
} from '@/lib/workspace-store';

export const WORKSPACE_SANDBOX_TASK_ID = 'workspace';

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
      credentials: 'same-origin',
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

function toSandboxState(book: WorkspaceLoadResult): TestSandboxState {
  return normalizeSandboxState({
    workspace: book.workspace,
    hedgesByEntityId: book.hedgesByEntityId,
    varSetup: book.varSetup,
    group: book.workspace.group
      ? workspaceGroupToSandboxGroup(book.workspace.group)
      : { name: 'Workbench', reportingCurrency: 'USD', dashboard: null },
    answers: emptyAnswers(),
    progress: defaultTaskProgress(WORKSPACE_SANDBOX_TASK_ID),
    seededAt: book.updatedAt ?? new Date().toISOString(),
    updatedAt: book.updatedAt ?? new Date().toISOString(),
    hedgesUpdatedAt: book.hedgesUpdatedAt,
  });
}

function bookFromSandboxState(
  state: TestSandboxState,
  updatedAt?: string,
): WorkspaceLoadResult {
  return {
    workspace: state.workspace,
    hedgesByEntityId: state.hedgesByEntityId ?? {},
    ...(state.varSetup ? { varSetup: state.varSetup } : {}),
    updatedAt: updatedAt ?? state.updatedAt,
    hedgesUpdatedAt: state.hedgesUpdatedAt,
  };
}

function asSandboxShell(book: WorkspaceLoadResult): TestSandboxState {
  return toSandboxState(book);
}

export async function persistWorkspaceRemote(
  book: WorkspaceLoadResult,
): Promise<boolean> {
  return persistSandboxRemote(
    toSandboxState({
      ...book,
      updatedAt: new Date().toISOString(),
    }),
    WORKSPACE_SANDBOX_TASK_ID,
  );
}

/**
 * Load workspace: localStorage immediately, then merge a newer Neon copy when
 * the signed-in sandbox API is available.
 */
export async function loadWorkspacePersistent(
  userKey: string,
): Promise<{ book: WorkspaceLoadResult; persistent: boolean }> {
  const gen = startSandboxHydration(WORKSPACE_SANDBOX_TASK_ID);
  let loaded: WorkspaceLoadResult | undefined;
  try {
  const remote = await fetchJson<ApiSandboxResponse>(
    `/api/test/sandbox?taskId=${encodeURIComponent(WORKSPACE_SANDBOX_TASK_ID)}`,
  );
  const local = loadWorkspaceDetailed(userKey);

  if (!remote?.state || remote.source === 'seed') {
    const live = loadWorkspaceDetailed(userKey);
    loaded = live;
    if (remote?.persistent && live.workspace.entities.length > 0) {
      void persistWorkspaceRemote(live);
    }
    return { book: live, persistent: Boolean(remote?.persistent) };
  }

  const remoteState = normalizeSandboxState({
    ...remote.state,
    updatedAt: remote.updatedAt ?? remote.state.updatedAt,
  });
  const remoteBook = bookFromSandboxState(remoteState, remote.updatedAt);
  const localAt = Date.parse(local.updatedAt ?? '') || 0;
  const remoteAt = Date.parse(remoteBook.updatedAt ?? '') || 0;
  const localNewer = localAt > remoteAt;
  const newer = localNewer ? local : remoteBook;
  const older = localNewer ? remoteBook : local;
  const hedgesMerged = mergeHedgeBooksPreservingPrepared(
    newer.hedgesByEntityId,
    older.hedgesByEntityId,
  );
  const setup = preferWorkspaceSetup(
    asSandboxShell(newer),
    asSandboxShell(older),
  );
  const merged: WorkspaceLoadResult = {
    workspace: setup.workspace,
    hedgesByEntityId: hedgesMerged,
    varSetup: newer.varSetup ?? older.varSetup,
    updatedAt: newer.updatedAt ?? older.updatedAt,
    hedgesUpdatedAt:
      (Date.parse(local.hedgesUpdatedAt ?? '') || 0)
        >= (Date.parse(remoteBook.hedgesUpdatedAt ?? '') || 0)
        ? local.hedgesUpdatedAt
        : remoteBook.hedgesUpdatedAt,
  };
  const live = loadWorkspaceDetailed(userKey);
  const liveHedges = mergeHedgeBooksPreservingPrepared(
    live.hedgesByEntityId,
    hedgesMerged,
  );
  const liveSetup = preferWorkspaceSetup(
    asSandboxShell(live),
    asSandboxShell(merged),
  );
  const finalBook: WorkspaceLoadResult = {
    workspace: liveSetup.workspace,
    hedgesByEntityId: liveHedges,
    varSetup: live.varSetup ?? merged.varSetup,
    updatedAt:
      (Date.parse(live.updatedAt ?? '') || 0)
        >= (Date.parse(merged.updatedAt ?? '') || 0)
        ? live.updatedAt
        : merged.updatedAt,
    hedgesUpdatedAt:
      (Date.parse(live.hedgesUpdatedAt ?? '') || 0)
        >= (Date.parse(merged.hedgesUpdatedAt ?? '') || 0)
        ? live.hedgesUpdatedAt
        : merged.hedgesUpdatedAt,
  };
  saveWorkspace(userKey, finalBook.workspace, {
    hedgesByEntityId: finalBook.hedgesByEntityId,
    varSetup: finalBook.varSetup,
    hedgesUpdatedAt: finalBook.hedgesUpdatedAt,
  });

  const mergedScore = hedgeBookContentScore(liveHedges);
  const newerScore = hedgeBookContentScore(newer.hedgesByEntityId);
  if (
    localAt > remoteAt
    || mergedScore.prepared > newerScore.prepared
    || mergedScore.booked > newerScore.booked
    || mergedScore.desk > newerScore.desk
    || mergedScore.carry > newerScore.carry
    || mergedScore.market > newerScore.market
    || workspaceFxProfileCount(asSandboxShell(finalBook))
      > workspaceFxProfileCount(asSandboxShell(newer))
  ) {
    void persistWorkspaceRemote(loadWorkspaceDetailed(userKey));
  }

  loaded = finalBook;
  return { book: finalBook, persistent: true };
  } finally {
    finishSandboxHydration(
      WORKSPACE_SANDBOX_TASK_ID,
      loaded ? toSandboxState(loaded) : undefined,
      gen,
    );
  }
}

/** Save to localStorage and best-effort sync to Neon (even if local quota fails). */
export function saveWorkspacePersistent(
  userKey: string,
  book: WorkspaceLoadResult,
): WorkspaceSaveResult {
  const result = saveWorkspace(userKey, book.workspace, {
    hedgesByEntityId: book.hedgesByEntityId,
    varSetup: book.varSetup,
    hedgesUpdatedAt: book.hedgesUpdatedAt,
  });
  if (result.ok) {
    void persistWorkspaceRemote(loadWorkspaceDetailed(userKey));
  } else {
    void persistWorkspaceRemote(book);
  }
  return result;
}
