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
  userProgressTableName,
  type SandboxStorageEnv,
} from '@/lib/db/storage-env';
import type {
  SandboxUiState,
  TaskAnswers,
  TaskScoreResult,
  TaskStepStatus,
  UserProgressStatus,
} from '@/lib/test-mode/types';

export type ProgressEventKind = 'step' | 'validate' | 'reset' | 'save';

export class UserProgress extends Model<
  InferAttributes<UserProgress>,
  InferCreationAttributes<UserProgress>
> {
  declare userEmail: string;
  declare taskId: string;
  declare status: UserProgressStatus;
  declare stepsDone: number;
  declare stepsTotal: number;
  declare steps: Record<string, TaskStepStatus>;
  declare answers: TaskAnswers;
  declare lastScore: TaskScoreResult | null;
  declare lastScorePass: boolean | null;
  declare ui: SandboxUiState | null;
  declare seededAt: Date | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class UserProgressStep extends Model<
  InferAttributes<UserProgressStep>,
  InferCreationAttributes<UserProgressStep>
> {
  declare userEmail: string;
  declare taskId: string;
  declare stepId: string;
  declare status: TaskStepStatus;
  declare completedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class UserProgressEvent extends Model<
  InferAttributes<UserProgressEvent>,
  InferCreationAttributes<UserProgressEvent>
> {
  declare id: CreationOptional<number>;
  declare userEmail: string;
  declare taskId: string;
  declare kind: ProgressEventKind;
  declare stepId: string | null;
  declare status: string | null;
  declare payload: unknown;
  declare createdAt: CreationOptional<Date>;
}

function reinitIfNeeded(
  sequelize: Sequelize,
  modelName: string,
  tableName: string,
): boolean {
  if (!sequelize.isDefined(modelName)) return true;
  const existing = sequelize.model(modelName);
  if (existing.tableName === tableName) return false;
  sequelize.modelManager.removeModel(existing);
  return true;
}

export function initUserProgressModels(
  sequelize: Sequelize,
  storageEnv: SandboxStorageEnv = getSandboxStorageEnv(),
): {
  UserProgress: typeof UserProgress;
  UserProgressStep: typeof UserProgressStep;
  UserProgressEvent: typeof UserProgressEvent;
} {
  const snapshotTable = userProgressTableName('snapshot', storageEnv);
  if (reinitIfNeeded(sequelize, 'UserProgress', snapshotTable)) {
    UserProgress.init(
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
        status: { type: DataTypes.STRING(32), allowNull: false },
        stepsDone: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
          field: 'steps_done',
        },
        stepsTotal: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
          field: 'steps_total',
        },
        steps: { type: DataTypes.JSONB, allowNull: false },
        answers: { type: DataTypes.JSONB, allowNull: false },
        lastScore: {
          type: DataTypes.JSONB,
          allowNull: true,
          field: 'last_score',
        },
        lastScorePass: {
          type: DataTypes.BOOLEAN,
          allowNull: true,
          field: 'last_score_pass',
        },
        ui: { type: DataTypes.JSONB, allowNull: true },
        seededAt: { type: DataTypes.DATE, allowNull: true, field: 'seeded_at' },
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        createdAt: { type: DataTypes.DATE, allowNull: false, field: 'created_at' },
        updatedAt: { type: DataTypes.DATE, allowNull: false, field: 'updated_at' },
      },
      {
        sequelize,
        modelName: 'UserProgress',
        tableName: snapshotTable,
        timestamps: true,
        underscored: true,
      },
    );
  }

  const stepTable = userProgressTableName('step', storageEnv);
  if (reinitIfNeeded(sequelize, 'UserProgressStep', stepTable)) {
    UserProgressStep.init(
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
        stepId: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          field: 'step_id',
        },
        status: { type: DataTypes.STRING(16), allowNull: false },
        completedAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: 'completed_at',
        },
        createdAt: { type: DataTypes.DATE, allowNull: false, field: 'created_at' },
        updatedAt: { type: DataTypes.DATE, allowNull: false, field: 'updated_at' },
      },
      {
        sequelize,
        modelName: 'UserProgressStep',
        tableName: stepTable,
        timestamps: true,
        underscored: true,
      },
    );
  }

  const eventTable = userProgressTableName('event', storageEnv);
  if (reinitIfNeeded(sequelize, 'UserProgressEvent', eventTable)) {
    UserProgressEvent.init(
      {
        id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
        userEmail: {
          type: DataTypes.STRING(320),
          allowNull: false,
          field: 'user_email',
        },
        taskId: {
          type: DataTypes.STRING(32),
          allowNull: false,
          field: 'task_id',
        },
        kind: { type: DataTypes.STRING(16), allowNull: false },
        stepId: { type: DataTypes.STRING(64), allowNull: true, field: 'step_id' },
        status: { type: DataTypes.STRING(32), allowNull: true },
        payload: { type: DataTypes.JSONB, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, field: 'created_at' },
      },
      {
        sequelize,
        modelName: 'UserProgressEvent',
        tableName: eventTable,
        timestamps: true,
        updatedAt: false,
        underscored: true,
        indexes: [{ fields: ['user_email', 'task_id', 'created_at'] }],
      },
    );
  }

  return { UserProgress, UserProgressStep, UserProgressEvent };
}

let ready: Promise<ReturnType<typeof initUserProgressModels> | null> | null = null;
let readyEnv: SandboxStorageEnv | null = null;

/** Ensure progress tables exist. Null when DATABASE_URL is unset. */
export async function getUserProgressModels(): Promise<
  ReturnType<typeof initUserProgressModels> | null
> {
  const storageEnv = getSandboxStorageEnv();
  if (ready && readyEnv === storageEnv) return ready;

  readyEnv = storageEnv;
  ready = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    const models = initUserProgressModels(sequelize, storageEnv);
    await Promise.all([
      models.UserProgress.sync(),
      models.UserProgressStep.sync(),
      models.UserProgressEvent.sync(),
    ]);
    return models;
  })().catch(err => {
    ready = null;
    readyEnv = null;
    throw err;
  });

  return ready;
}
