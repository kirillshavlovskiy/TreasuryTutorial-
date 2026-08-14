/** Test-mode domain — Sigma Tasks on the workspace Entity → Dashboard → Simulator flow. */

import type { EntityHedgeBook } from '@/lib/test-mode/hedge-var';
import type { Workspace } from '@/lib/workspace-store';

/** Resume location inside the sandbox task UI. */
export interface SandboxUiState {
  view: 'home' | 'group' | 'entity';
  entityId: string | null;
  dashboardId: string | null;
  activeProfileId: string | null;
}

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
  /** Currency code of the largest mismatch (expected EUR). */
  largestMismatchCcy: string;
  /** Exposure net in local M for the declared Analytics basis (stock or avg). */
  largestMismatchAmount: string;
  /** VaR confidence % from Analytics (90 | 95 | 99). */
  varConfidencePct: string;
  /**
   * VaR profile from Analytics (simpleAvg | avgBuildup | totalBuildup).
   * Not a hedge regime — Cash / Target are Decision hedging only.
   */
  varExposureBasis: string;
  /** VaR analysis horizon from Analytics (1w | 1m | 3m | 6m | 9m | 1y) — vol √T only. */
  varHorizon: string;
  /** FX Risk forecast period in months (scales totalBuildup / Net FX Forecast). */
  varForecastMonths: string;
  /**
   * Incremental 1m forecast uncertainty (relative to monthly flow), e.g. "0.1" or "10%".
   * Empty / omitted → 0 (off).
   */
  varForecastUncertainty: string;
  /** FX vol source for σ₁ₘ: historical | implied. */
  varVolSource: string;
  /**
   * σ₁ₘ overrides replacing the desk presets, as fractions ("0.032"). Held
   * per source so each keeps its own edited value. Empty = use the preset.
   */
  varVolHistorical: string;
  varVolImplied: string;
  /**
   * Rate-differential vol override in bp/year ("120"), replacing the
   * per-currency desk table for every currency. Empty = use the table.
   */
  varRateVol: string;
  /** Average sampling: midMonth | monthEnd. */
  varAveragingConvention: string;
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
  /** Decision-layer hedge books keyed by entity id (or group scope). */
  hedgesByEntityId?: Record<string, EntityHedgeBook>;
  /** Last UI location so practice resumes where the student stopped. */
  ui?: SandboxUiState;
  seededAt: string;
  /** Wall-clock update time — used to merge local vs server copies. */
  updatedAt?: string;
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
