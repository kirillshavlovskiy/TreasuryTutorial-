/**
 * Bridge Workbench structure → Curriculum Task 01 sandbox.
 * Workbench persists under treasury:workspace:*; curriculum under treasury:test:*
 * (+ Neon via /api/test/sandbox). Mirroring makes Guided structure appear in
 * the Task 01 Group FX section.
 */

import type { Workspace, WorkspaceGroup } from '@/lib/workspace-store';
import { mergeHedgeBooksPreservingPrepared } from '@/lib/hedge-book-normalize';
import {
  loadSandbox,
  markStep,
  normalizeSandboxState,
} from '@/lib/test-mode/store';
import { saveSandboxPersistent } from '@/lib/test-mode/sandbox-client';
import type { EntityHedgeBook } from '@/lib/test-mode/hedge-var';
import type { GroupDashboard, TestSandboxState } from '@/lib/test-mode/types';

export interface CurriculumMirrorResult {
  ok: boolean;
  /** Local sandbox was updated. */
  local: boolean;
  error?: string;
}

/** Map Workbench WorkspaceGroup → sandbox group.dashboard shape. */
export function workspaceGroupToSandboxGroup(group: WorkspaceGroup): {
  name: string;
  reportingCurrency: string;
  dashboard: GroupDashboard;
} {
  const now = new Date().toISOString();
  return {
    name: group.name,
    reportingCurrency: group.reportingCurrency,
    dashboard: {
      id: `grp-dash-${group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'fx'}`,
      name: group.dashboardName,
      createdAt: now,
      opened: false,
      includedEntityIds: [...group.includedEntityIds],
    },
  };
}

/**
 * Apply a finished Workbench structure onto a sandbox state (pure).
 * Replaces workspace entities with the wizard result and sets group.
 */
export function applyWorkbenchStructureToSandbox(
  sandbox: TestSandboxState,
  workspace: Workspace,
  workbenchHedges?: Record<string, EntityHedgeBook>,
): TestSandboxState {
  const group = workspace.group
    ? workspaceGroupToSandboxGroup(workspace.group)
    : sandbox.group;

  const next: TestSandboxState = normalizeSandboxState({
    ...sandbox,
    workspace: {
      entities: workspace.entities,
      group: workspace.group ?? null,
    },
    group,
    hedgesByEntityId: mergeHedgeBooksPreservingPrepared(
      workbenchHedges,
      sandbox.hedgesByEntityId,
    ),
    progress: markStep(sandbox.progress, 'buildWorkspace', 'done'),
    updatedAt: new Date().toISOString(),
  });
  return next;
}

/**
 * Task 01 localStorage key is `test:${email}` (`treasury:test:test:${email}`).
 * Workbench userKey is the email. Using the email alone writes a different
 * slot AND still PUTs Neon row (email, taskId=01) — wiping Task 01 hedges.
 */
export function curriculumSandboxUserKey(workbenchUserKey: string): string {
  const trimmed = workbenchUserKey.trim();
  if (!trimmed) return 'test:guest';
  if (trimmed === 'test:guest' || trimmed.startsWith('test:')) return trimmed;
  return `test:${trimmed}`;
}

/**
 * Mirror Workbench structure into Curriculum Task 01 sandbox (local + Neon best-effort).
 * Workbench save is independent — call this after saveWorkspace succeeds.
 */
export function mirrorStructureToCurriculumSandbox(
  userKey: string,
  workspaceAfterWizard: Workspace,
  taskId = '01',
  workbenchHedges?: Record<string, EntityHedgeBook>,
): CurriculumMirrorResult {
  if (typeof window === 'undefined') {
    return { ok: false, local: false, error: 'Mirror only runs in the browser.' };
  }
  if (!workspaceAfterWizard.group || workspaceAfterWizard.entities.length === 0) {
    return {
      ok: false,
      local: false,
      error: 'Nothing to mirror — structure has no group or entities.',
    };
  }

  try {
    const sandboxKey = curriculumSandboxUserKey(userKey);
    const current = loadSandbox(sandboxKey);
    const merged = applyWorkbenchStructureToSandbox(
      current,
      workspaceAfterWizard,
      workbenchHedges,
    );
    saveSandboxPersistent(sandboxKey, merged, taskId);
    return { ok: true, local: true };
  } catch (err) {
    return {
      ok: false,
      local: false,
      error: err instanceof Error ? err.message : 'Failed to mirror into curriculum sandbox.',
    };
  }
}
