/** Test-mode domain — Sigma Tasks on the workspace Entity → Dashboard → Simulator flow. */

import type { Workspace } from '@/lib/workspace-store';

export type TaskStepId =
  | 'buildWorkspace'
  | 'largestMismatch'
  | 'setVarConfidence'
  | 'readVar';

export interface TaskProgress {
  taskId: string;
  steps: Record<TaskStepId, 'pending' | 'done'>;
}

/** Student answers submitted before Validate. */
export interface TaskAnswers {
  /** Currency code of the largest stock mismatch (expected EUR). */
  largestMismatchCcy: string;
  /** Stock net in local millions (expected +4.9). */
  largestMismatchAmount: string;
  /** VaR confidence % from Analytics (90 | 95 | 99). */
  varConfidencePct: string;
  /** Exposure basis from Analytics (stock | avgBuildup). */
  varExposureBasis: string;
  /** Horizon from Analytics (1w | 1m | 3m | 6m | 1y). */
  varHorizon: string;
  /**
   * EUR VaR at Δ=1 in USD thousands — must match Analytics setup
   * (confidence × horizon × exposure basis) within ±5%.
   */
  eurVarUsdK: string;
}

/** Parent-company consolidated dashboard (group net + risk VaR layer). */
export interface GroupDashboard {
  id: string;
  name: string;
  createdAt: string;
  /** True once the student has opened / confirmed the consolidated view. */
  opened: boolean;
  /**
   * Entity ids included in consolidation.
   * Empty / missing → all workspace entities (default for Task 01).
   */
  includedEntityIds?: string[];
}

export interface TestSandboxState {
  /** Same workspace shape as /workspace (entities → dashboards → risk profiles). */
  workspace: Workspace;
  /** NordTech Group parent-level consolidated dashboard. */
  group: {
    name: string;
    reportingCurrency: string;
    dashboard: GroupDashboard | null;
  };
  answers: TaskAnswers;
  progress: TaskProgress;
  /** Last Validate result snapshot (optional UI). */
  lastScore?: TaskScoreResult;
  seededAt: string;
}

export interface ScoreCheck {
  id: string;
  label: string;
  pass: boolean;
  expected?: string;
  actual?: string;
  hint?: string;
}

export interface TaskScoreResult {
  pass: boolean;
  checks: ScoreCheck[];
  hints: string[];
}

// ── Legacy ladder types (still used by exposure/VaR engines + fixtures) ─────

export type AccountKind = 'asset' | 'liability' | 'equity' | 'flow';
export type AccountCadence = 'stock' | 'monthly';
export type LadderLayer = 'stock' | 'flow' | 'none';

export interface TestEntity {
  id: string;
  code: string;
  legalName: string;
  functionalCurrency: string;
  role: string;
  description: string;
}

export interface TestAccount {
  id: string;
  seedKey: string;
  entityId: string;
  name: string;
  kind: AccountKind;
  currency: string;
  amount: number;
  cadence: AccountCadence;
  ladderLayer: LadderLayer;
}

export interface TestDashboardLabel {
  id: string;
  name: string;
  purpose: string;
}

export interface TestWorkspace {
  group: {
    id: string;
    name: string;
    reportingCurrency: string;
  };
  entities: TestEntity[];
  accounts: TestAccount[];
  dashboards: TestDashboardLabel[];
}

export interface LadderBar {
  ccy: string;
  stockNetM: number;
  avg3mM: number;
  flowM: number;
  direction: 'long' | 'short' | 'hub';
}
