import { isDatabaseConfigured } from '@/lib/db/sequelize';
import { getSandboxProgressModel } from '@/lib/db/models/sandbox-progress';
import {
  getSandboxStorageEnv,
  type SandboxStorageEnv,
} from '@/lib/db/storage-env';
import { applySandboxPutPayload } from '@/lib/test-mode/sandbox-put';
import {
  STATE_VERSION,
  normalizeSandboxState,
  seedSandbox,
} from '@/lib/test-mode/store';
import type { TestSandboxState } from '@/lib/test-mode/types';
import type { Transaction } from 'sequelize';

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
export async function saveSandboxPut(
  userEmail: string,
  body: unknown,
  taskId = '01',
): Promise<SandboxProgressRecord> {
  const Model = await getSandboxProgressModel();
  if (!Model) {
    throw new Error('Postgres DATABASE_URL is not configured');
  }

  const email = normalizeEmail(userEmail);
  const persistRow = async (transaction?: Transaction) => {
    const row = await Model.findOne({
      where: { userEmail: email, taskId },
      ...(transaction
        ? { transaction, lock: transaction.LOCK.UPDATE }
        : {}),
    });
    const existingState = row ? normalizeSandboxState(row.state) : null;
    const normalized = applySandboxPutPayload(body, existingState, taskId);
    if (row) {
      // JSONB: assigning a new object does not always mark the field dirty,
      // so Sequelize can UPDATE updated_at and leave the hedge book unchanged.
      row.set('state', normalized);
      row.changed('state', true);
      row.version = STATE_VERSION;
      await row.save({ transaction });
      return row;
    }
    return Model.create(
      {
        userEmail: email,
        taskId,
        state: normalized,
        version: STATE_VERSION,
      },
      { transaction },
    );
  };

  let saved;
  const sequelize = Model.sequelize;
  if (sequelize) {
    try {
      saved = await sequelize.transaction(async t => persistRow(t));
    } catch (err) {
      console.warn(
        '[sandbox] transactional save failed — retrying without row lock',
        err,
      );
      saved = await persistRow();
    }
  } else {
    saved = await persistRow();
  }

  return {
    state: normalizeSandboxState(saved.state),
    version: saved.version,
    updatedAt: saved.updatedAt.toISOString(),
    source: 'database',
    storageEnv: getSandboxStorageEnv(),
  };
}

export async function saveSandboxProgress(
  userEmail: string,
  state: TestSandboxState,
  taskId = '01',
): Promise<SandboxProgressRecord> {
  return saveSandboxPut(userEmail, { taskId, state }, taskId);
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
