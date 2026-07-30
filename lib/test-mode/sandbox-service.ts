import { isDatabaseConfigured } from '@/lib/db/sequelize';
import { getSandboxProgressModel } from '@/lib/db/models/sandbox-progress';
import {
  getSandboxStorageEnv,
  type SandboxStorageEnv,
} from '@/lib/db/storage-env';
import {
  STATE_VERSION,
  normalizeSandboxState,
  seedSandbox,
} from '@/lib/test-mode/store';
import type { TestSandboxState } from '@/lib/test-mode/types';

export interface SandboxProgressRecord {
  state: TestSandboxState;
  version: number;
  updatedAt: string;
  source: 'database' | 'seed';
  storageEnv: SandboxStorageEnv;
}

export { getSandboxStorageEnv };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Load sandbox progress for an authenticated user (server-side). */
export async function loadSandboxProgress(
  userEmail: string,
  taskId = '01',
): Promise<SandboxProgressRecord> {
  const Model = await getSandboxProgressModel();
  const storageEnv = getSandboxStorageEnv();
  if (!Model) {
    return {
      state: seedSandbox(taskId),
      version: STATE_VERSION,
      updatedAt: new Date(0).toISOString(),
      source: 'seed',
      storageEnv,
    };
  }

  const row = await Model.findOne({
    where: {
      userEmail: normalizeEmail(userEmail),
      taskId,
    },
  });

  if (!row) {
    return {
      state: seedSandbox(taskId),
      version: STATE_VERSION,
      updatedAt: new Date(0).toISOString(),
      source: 'seed',
      storageEnv,
    };
  }

  return {
    state: normalizeSandboxState(row.state),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    source: 'database',
    storageEnv,
  };
}

/** Upsert sandbox progress for an authenticated user (server-side). */
export async function saveSandboxProgress(
  userEmail: string,
  state: TestSandboxState,
  taskId = '01',
): Promise<SandboxProgressRecord> {
  const Model = await getSandboxProgressModel();
  if (!Model) {
    throw new Error('Postgres DATABASE_URL is not configured');
  }

  const normalized = normalizeSandboxState(state);
  const email = normalizeEmail(userEmail);
  const [row] = await Model.upsert({
    userEmail: email,
    taskId,
    state: normalized,
    version: STATE_VERSION,
  });

  return {
    state: normalizeSandboxState(row.state),
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    source: 'database',
    storageEnv: getSandboxStorageEnv(),
  };
}

/** Delete sandbox progress (Reset sandbox). */
export async function deleteSandboxProgress(
  userEmail: string,
  taskId = '01',
): Promise<void> {
  const Model = await getSandboxProgressModel();
  if (!Model) return;
  await Model.destroy({
    where: {
      userEmail: normalizeEmail(userEmail),
      taskId,
    },
  });
}

export function isSandboxDatabaseAvailable(): boolean {
  return isDatabaseConfigured();
}
