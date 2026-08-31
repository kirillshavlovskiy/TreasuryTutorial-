import { TASK_STEP_IDS } from '@/lib/test-mode/types';
import type {
  SandboxUiState,
  TaskAnswers,
  TaskScoreResult,
  TaskStepId,
  TaskStepStatus,
  TestSandboxState,
  UserProgressStatus,
} from '@/lib/test-mode/types';

export interface ProgressStepView {
  id: TaskStepId;
  status: TaskStepStatus;
}

export interface UserProgressSnapshot {
  taskId: string;
  status: UserProgressStatus;
  stepsDone: number;
  stepsTotal: number;
  steps: Record<TaskStepId, TaskStepStatus>;
  stepList: ProgressStepView[];
  answers: TaskAnswers;
  lastScore: TaskScoreResult | null;
  lastScorePass: boolean | null;
  ui: SandboxUiState | null;
  seededAt: string;
}

function answersStarted(answers: TaskAnswers): boolean {
  return Boolean(
    answers.largestMismatchCcy.trim()
    || answers.largestMismatchAmount.trim()
    || answers.varConfidencePct.trim()
    || answers.varHorizon.trim()
    || answers.eurVarUsdK.trim(),
  );
}

/** Derive queryable progress from the sandbox restore blob. */
export function progressFromSandbox(state: TestSandboxState): UserProgressSnapshot {
  const taskId = state.progress.taskId || '01';
  const steps = { ...state.progress.steps };
  for (const id of TASK_STEP_IDS) {
    if (steps[id] !== 'done') steps[id] = 'pending';
  }
  const stepsDone = TASK_STEP_IDS.filter(id => steps[id] === 'done').length;
  const stepsTotal = TASK_STEP_IDS.length;
  const lastScore = state.lastScore ?? null;
  const lastScorePass = lastScore ? lastScore.pass : null;

  let status: UserProgressStatus = 'not_started';
  if (lastScorePass === true || (stepsTotal > 0 && stepsDone === stepsTotal)) {
    status = 'completed';
  } else if (stepsDone > 0 || answersStarted(state.answers)) {
    status = 'in_progress';
  }

  return {
    taskId,
    status,
    stepsDone,
    stepsTotal,
    steps,
    stepList: TASK_STEP_IDS.map(id => ({ id, status: steps[id] })),
    answers: state.answers,
    lastScore,
    lastScorePass,
    ui: state.ui ?? null,
    seededAt: state.seededAt,
  };
}
