/**
 * Sandbox PUT payloads. Hedge patches stay small enough for Chromium's
 * keepalive quota (64KiB); the full workspace blob must not use keepalive.
 */

import {
  fillMarketRatesFromExisting,
  normalizeHedgeBooksMap,
  omitMarketRatesFromHedgeBooks,
} from '@/lib/hedge-book-normalize';
import {
  normalizeSandboxState,
  sandboxStateWithProtectedHedges,
  seedSandbox,
} from '@/lib/test-mode/store';
import type { TestSandboxState } from '@/lib/test-mode/types';

/** Chromium fetch keepalive body cap is 64KiB — stay under it. */
export const SANDBOX_KEEPALIVE_MAX_BYTES = 60 * 1024;

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function canUseKeepaliveFetch(body: string): boolean {
  return utf8ByteLength(body) <= SANDBOX_KEEPALIVE_MAX_BYTES;
}

export function buildSandboxFullPutBody(
  state: TestSandboxState,
  taskId: string,
): string {
  return JSON.stringify({ taskId, state });
}

export function buildSandboxHedgePatchBody(
  state: TestSandboxState,
  taskId: string,
): string {
  return JSON.stringify({
    taskId,
    patch: 'hedges',
    hedgesByEntityId: omitMarketRatesFromHedgeBooks(state.hedgesByEntityId),
    hedgesUpdatedAt: state.hedgesUpdatedAt,
    updatedAt: state.updatedAt,
  });
}

export function isSandboxHedgePatch(body: unknown): boolean {
  return Boolean(
    body
    && typeof body === 'object'
    && (body as { patch?: unknown }).patch === 'hedges',
  );
}

/** Merge a full-state PUT or a hedge-only PATCH into the existing Postgres row. */
export function applySandboxPutPayload(
  body: unknown,
  existing: TestSandboxState | null,
  taskId: string,
): TestSandboxState {
  if (!body || typeof body !== 'object') {
    throw new Error('Missing state');
  }
  const row = body as Record<string, unknown>;
  if (isSandboxHedgePatch(row)) {
    const base = existing ?? seedSandbox(taskId);
    const incomingHedges = fillMarketRatesFromExisting(
      normalizeHedgeBooksMap(row.hedgesByEntityId),
      base.hedgesByEntityId,
    );
    const incoming = normalizeSandboxState({
      ...base,
      hedgesByEntityId: incomingHedges,
      hedgesUpdatedAt:
        typeof row.hedgesUpdatedAt === 'string'
          ? row.hedgesUpdatedAt
          : base.hedgesUpdatedAt,
      updatedAt:
        typeof row.updatedAt === 'string'
          ? row.updatedAt
          : new Date().toISOString(),
    });
    return sandboxStateWithProtectedHedges(incoming, existing);
  }
  if (!row.state || typeof row.state !== 'object') {
    throw new Error('Missing state');
  }
  return sandboxStateWithProtectedHedges(
    normalizeSandboxState(row.state),
    existing,
  );
}
