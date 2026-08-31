import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import {
  getSandboxStorageEnv,
  sandboxProgressTableName,
  type SandboxStorageEnv,
} from '@/lib/db/storage-env';
import type { TestSandboxState } from '@/lib/test-mode/types';

export class SandboxProgress extends Model<
  InferAttributes<SandboxProgress>,
  InferCreationAttributes<SandboxProgress>
> {
  declare userEmail: string;
  declare taskId: string;
  declare state: TestSandboxState;
  declare version: number;
  declare updatedAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
}

export function initSandboxProgressModel(
  sequelize: Sequelize,
  storageEnv: SandboxStorageEnv = getSandboxStorageEnv(),
): typeof SandboxProgress {
  const tableName = sandboxProgressTableName(storageEnv);

  // Re-init is safe when the same table is requested; avoid duplicate model
  // registration when hot-reloading with a different env in tests.
  if (sequelize.isDefined('SandboxProgress')) {
    const existing = sequelize.model('SandboxProgress') as typeof SandboxProgress;
    if (existing.tableName === tableName) return existing;
    sequelize.modelManager.removeModel(existing);
  }

  SandboxProgress.init(
    {
      userEmail: {
        type: DataTypes.STRING(320),
        allowNull: false,
        primaryKey: true,
        field: 'user_email',
      },
      taskId: {
        type: DataTypes.STRING(32),
        allowNull: false,
        primaryKey: true,
        field: 'task_id',
      },
      state: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'created_at',
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'updated_at',
      },
    },
    {
      sequelize,
      modelName: 'SandboxProgress',
      tableName,
      timestamps: true,
      underscored: true,
    },
  );
  return SandboxProgress;
}

let ready: Promise<typeof SandboxProgress | null> | null = null;
let readyEnv: SandboxStorageEnv | null = null;

/** Ensure model + env table exist. Returns null when DATABASE_URL is unset. */
export async function getSandboxProgressModel(): Promise<typeof SandboxProgress | null> {
  const storageEnv = getSandboxStorageEnv();
  if (ready && readyEnv === storageEnv) return ready;

  readyEnv = storageEnv;
  ready = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    const Model = initSandboxProgressModel(sequelize, storageEnv);
    // Creates the env-specific table if missing — no force/alter.
    await Model.sync();
    return Model;
  })().catch(err => {
    ready = null;
    readyEnv = null;
    throw err;
  });

  return ready;
}
