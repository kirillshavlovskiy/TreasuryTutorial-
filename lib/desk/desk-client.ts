import type { DeskModule, DeskPutInput, DeskStateSnapshot } from '@/lib/desk/types';
import { WORKBENCH_DESK_SCOPE } from '@/lib/desk/types';

export { WORKBENCH_DESK_SCOPE, deskScopeForTask } from '@/lib/desk/types';

export interface DeskPutBody extends DeskPutInput {
  scope: string;
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

export async function loadDeskStateClient(
  scope: string = WORKBENCH_DESK_SCOPE,
): Promise<DeskStateSnapshot | null> {
  return fetchJson<DeskStateSnapshot>(
    `/api/desk?scope=${encodeURIComponent(scope)}`,
  );
}

export async function putDeskState(body: DeskPutBody): Promise<boolean> {
  try {
    const res = await fetch('/api/desk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[desk] PUT failed status=${res.status} scope=${body.scope}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[desk] PUT network error — local state still saved', err);
    return false;
  }
}

export async function logDeskAction(input: {
  scope: string;
  module: DeskModule;
  action: string;
  dashboardId?: string;
  scopeId?: string;
  payload?: unknown;
}): Promise<boolean> {
  try {
    const res = await fetch('/api/desk/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounce frequent FX / liquidity book writes. */
export function putDeskStateDebounced(
  key: string,
  body: DeskPutBody,
  ms = 800,
): void {
  const prev = pending.get(key);
  if (prev) clearTimeout(prev);
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      void putDeskState(body);
    }, ms),
  );
}

/** Workbench snapshot write — best-effort, never blocks the UI. */
export function persistWorkbench(input: DeskPutInput & { key?: string }): void {
  const { key, ...rest } = input;
  putDeskStateDebounced(key ?? 'workbench', {
    scope: WORKBENCH_DESK_SCOPE,
    ...rest,
  });
}
