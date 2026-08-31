import { isDatabaseConfigured } from '@/lib/db/sequelize';
import { getUserProgressModels } from '@/lib/db/models/user-progress';
import {
  progressFromSandbox,
  type UserProgressSnapshot,
} from '@/lib/db/progress-snapshot';
import { getSandboxStorageEnv, type SandboxStorageEnv } from '@/lib/db/storage-env';
import { TASK_STEP_IDS } from '@/lib/test-mode/types';
import type { TestSandboxState } from '@/lib/test-mode/types';
import { STATE_VERSION } from '@/lib/test-mode/store';

export { progressFromSandbox, type UserProgressSnapshot } from '@/lib/db/progress-snapshot';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface UserProgressRecord extends UserProgressSnapshot {
  updatedAt: string;
  storageEnv: SandboxStorageEnv;
  persistent: boolean;
}

export interface UserProgressEventView {
  id: number;
  kind: string;
  stepId: string | null;
  status: string | null;
  payload: unknown;
  createdAt: string;
}

function seededAtDate(raw: string): Date | null {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Upsert snapshot + per-step rows; append events when a step or score changes. */
export async function syncUserProgress(
  userEmail: string,
  taskId: string,
  state: TestSandboxState,
): Promise<void> {
  const models = await getUserProgressModels();
  if (!models) return;

  const email = normalizeEmail(userEmail);
  const snap = progressFromSandbox({
    ...state,
    progress: { ...state.progress, taskId },
  });

  const [prevSnap, prevSteps] = await Promise.all([
    models.UserProgress.findOne({ where: { userEmail: email, taskId } }),
    models.UserProgressStep.findAll({ where: { userEmail: email, taskId } }),
  ]);
  const prevByStep = new Map(prevSteps.map(r => [r.stepId, r]));
  const prevScore = prevSnap?.lastScore ? JSON.stringify(prevSnap.lastScore) : '';
  const nextScore = snap.lastScore ? JSON.stringify(snap.lastScore) : '';

  await models.UserProgress.upsert({
    userEmail: email,
    taskId,
    status: snap.status,
    stepsDone: snap.stepsDone,
    stepsTotal: snap.stepsTotal,
    steps: snap.steps,
    answers: snap.answers,
    lastScore: snap.lastScore,
    lastScorePass: snap.lastScorePass,
    ui: snap.ui,
    seededAt: seededAtDate(snap.seededAt),
    version: STATE_VERSION,
  });

  for (const stepId of TASK_STEP_IDS) {
    const status = snap.steps[stepId] ?? 'pending';
    const was = prevByStep.get(stepId);
    const newlyDone = status === 'done' && was?.status !== 'done';
    const completedAt = status === 'done' ? (was?.completedAt ?? new Date()) : null;

    await models.UserProgressStep.upsert({
      userEmail: email,
      taskId,
      stepId,
      status,
      completedAt,
    });

    if (newlyDone) {
      await models.UserProgressEvent.create({
        userEmail: email,
        taskId,
        kind: 'step',
        stepId,
        status,
        payload: { stepId, status },
      });
    }
  }

  if (nextScore && nextScore !== prevScore) {
    await models.UserProgressEvent.create({
      userEmail: email,
      taskId,
      kind: 'validate',
      stepId: null,
      status: snap.lastScorePass ? 'pass' : 'fail',
      payload: snap.lastScore,
    });
  }
}

export async function loadUserProgress(
  userEmail: string,
  taskId: string,
): Promise<UserProgressRecord | null> {
  const models = await getUserProgressModels();
  const storageEnv = getSandboxStorageEnv();
  if (!models) return null;

  const row = await models.UserProgress.findOne({
    where: { userEmail: normalizeEmail(userEmail), taskId },
  });
  if (!row) return null;

  const steps = row.steps as UserProgressSnapshot['steps'];
  return {
    taskId: row.taskId,
    status: row.status,
    stepsDone: row.stepsDone,
    stepsTotal: row.stepsTotal,
    steps,
    stepList: TASK_STEP_IDS.map(id => ({
      id,
      status: steps[id] ?? 'pending',
    })),
    answers: row.answers,
    lastScore: row.lastScore,
    lastScorePass: row.lastScorePass,
    ui: row.ui,
    seededAt: row.seededAt?.toISOString() ?? '',
    updatedAt: row.updatedAt.toISOString(),
    storageEnv,
    persistent: true,
  };
}

export async function listUserProgress(
  userEmail: string,
): Promise<UserProgressRecord[]> {
  const models = await getUserProgressModels();
  if (!models) return [];
  const storageEnv = getSandboxStorageEnv();
  const rows = await models.UserProgress.findAll({
    where: { userEmail: normalizeEmail(userEmail) },
    order: [['updatedAt', 'DESC']],
  });
  return rows.map(row => {
    const steps = row.steps as UserProgressSnapshot['steps'];
    return {
      taskId: row.taskId,
      status: row.status,
      stepsDone: row.stepsDone,
      stepsTotal: row.stepsTotal,
      steps,
      stepList: TASK_STEP_IDS.map(id => ({
        id,
        status: steps[id] ?? 'pending',
      })),
      answers: row.answers,
      lastScore: row.lastScore,
      lastScorePass: row.lastScorePass,
      ui: row.ui,
      seededAt: row.seededAt?.toISOString() ?? '',
      updatedAt: row.updatedAt.toISOString(),
      storageEnv,
      persistent: true,
    };
  });
}

export async function listUserProgressEvents(
  userEmail: string,
  taskId: string,
  limit = 50,
): Promise<UserProgressEventView[]> {
  const models = await getUserProgressModels();
  if (!models) return [];
  const rows = await models.UserProgressEvent.findAll({
    where: { userEmail: normalizeEmail(userEmail), taskId },
    order: [['createdAt', 'DESC']],
    limit: Math.min(Math.max(limit, 1), 200),
  });
  return rows.map(r => ({
    id: Number(r.id),
    kind: r.kind,
    stepId: r.stepId,
    status: r.status,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function deleteUserProgress(
  userEmail: string,
  taskId: string,
): Promise<void> {
  const models = await getUserProgressModels();
  if (!models) return;
  const email = normalizeEmail(userEmail);
  const where = { userEmail: email, taskId };
  await Promise.all([
    models.UserProgress.destroy({ where }),
    models.UserProgressStep.destroy({ where }),
    models.UserProgressEvent.destroy({ where }),
  ]);
  await models.UserProgressEvent.create({
    userEmail: email,
    taskId,
    kind: 'reset',
    stepId: null,
    status: 'reset',
    payload: null,
  });
}

export function isProgressDatabaseAvailable(): boolean {
  return isDatabaseConfigured();
}
