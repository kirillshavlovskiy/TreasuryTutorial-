export type {
  GroupDashboard,
  LadderBar,
  LadderLayer,
  ScoreCheck,
  TaskAnswers,
  TaskProgress,
  TaskScoreResult,
  TaskStepId,
  TestAccount,
  TestDashboardLabel,
  TestEntity,
  TestSandboxState,
  TestWorkspace,
} from '@/lib/test-mode/types';
export {
  consolidateEntityBooks,
  computeConsolidatedRisk,
  type ConsolidatedBook,
  type CurrencyRiskRow,
} from '@/lib/test-mode/consolidate';

export {
  buildNordtechWorkspace,
  NORDTECH_ACCOUNT_ENTITY_MAP,
  NORDTECH_ACCOUNTS,
  NORDTECH_DASHBOARDS,
  NORDTECH_ENTITIES,
  NORDTECH_ENTITY_IDS,
} from '@/lib/test-mode/fixtures/nordtech-accounts';
export { NORDTECH_REFERENCE, SCORE_TOLERANCE, withinTolerance } from '@/lib/test-mode/fixtures/nordtech-reference';
export { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
export { computeStockLadder, largestMismatch } from '@/lib/test-mode/exposure-ladder';
export { computeTaskVar, type VarResult } from '@/lib/test-mode/task-var';
export {
  isVarConfidencePct,
  parseVarConfidencePct,
  VAR_CONFIDENCE_OPTIONS,
  VAR_Z_BY_CONFIDENCE,
  zForConfidence,
  type VarConfidencePct,
} from '@/lib/test-mode/var-confidence';
export {
  DEFAULT_VAR_SETUP,
  EUR_REF_EXPOSURE_M,
  computeParametricVarUsdM,
  expectedEurVarUsdM,
  horizonMonths,
  parseVarExposureBasis,
  parseVarHorizonId,
  parseVarSetup,
  setupLabel,
  VAR_EXPOSURE_OPTIONS,
  VAR_HORIZON_OPTIONS,
  volForHorizon,
  type VarExposureBasis,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
export {
  ensureTask01FxLayers,
  entityHasLocalPositions,
  localReadinessByEntity,
  localsReadyForConsolidation,
  scoreTask01,
} from '@/lib/test-mode/score';
export {
  bookedNotionalLocalM,
  bookedTicketForCcy,
  buildHedgeVarSummary,
  newHedgeTicketId,
  computeVarOnExposure,
  fxStockExposureLocalM,
  proposeBookHedge,
  proposeHigherVarHedge,
  aggregateBookedHedges,
  applyConsolidatedBookedChange,
  emptyHedgeBook,
  fxTableRiskMetrics,
  GROUP_HEDGE_SCOPE,
  riskMetricsFromRows,
  type EntityHedgeBook,
  type FxTableRiskMetric,
  type HedgeInstrument,
  type HedgeTicket,
  type HedgeVarRow,
  type HedgeVarSummary,
  type RowRiskMetric,
} from '@/lib/test-mode/hedge-var';
export {
  classifyNordtechEntity,
  simSeedForEntity,
  TASK01_REQUIRED_ANALYTICAL_LAYERS,
  TASK01_REQUIRED_DECISION_LAYERS,
  TASK01_REQUIRED_FX_INPUTS,
  type EntitySimSeed,
} from '@/lib/test-mode/nordtech-sim-seed';
export {
  TEST_GUEST_USER_KEY,
  defaultTaskProgress,
  emptyAnswers,
  loadSandbox,
  markStep,
  resetSandbox,
  saveSandbox,
  seedNordtechWorkspace,
  seedSandbox,
} from '@/lib/test-mode/store';
export {
  isTestModeEnabled,
  TEST_GUEST_EMAIL,
  TEST_GUEST_NAME,
} from '@/lib/test-mode/enabled';
