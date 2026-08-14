/**
 * Bridge Workbench structure → Curriculum Task 01 sandbox.
 * Workbench persists under treasury:workspace:*; curriculum under treasury:test:*
 * (+ Neon via /api/test/sandbox). Mirroring makes Guided structure appear in
 * the Task 01 Group FX section.
 */

import type { Workspace, WorkspaceGroup } from '@/lib/workspace-store';
import {
  loadSandbox,
  markStep,
  normalizeSandboxState,
} from '@/lib/test-mode/store';
import { saveSandboxPersistent } from '@/lib/test-mode/sandbox-client';
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
    progress: markStep(sandbox.progress, 'buildWorkspace', 'done'),
    updatedAt: new Date().toISOString(),
  });
  return next;
}

/**
 * Mirror Workbench structure into Curriculum Task 01 sandbox (local + Neon best-effort).
 * Workbench save is independent — call this after saveWorkspace succeeds.
 */
export function mirrorStructureToCurriculumSandbox(
  userKey: string,
  workspaceAfterWizard: Workspace,
  taskId = '01',
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
    const current = loadSandbox(userKey);
    const merged = applyWorkbenchStructureToSandbox(current, workspaceAfterWizard);
    saveSandboxPersistent(userKey, merged, taskId);
    return { ok: true, local: true };
  } catch (err) {
    return {
      ok: false,
      local: false,
      error: err instanceof Error ? err.message : 'Failed to mirror into curriculum sandbox.',
    };
  }
}
