import { DataTypes, Model, type Sequelize } from 'sequelize';
import type { ExecutionLogEvent } from '@/lib/test-mode/execution-monitor';

export class ExecutionLog extends Model {
  declare id: number;
  declare atMs: number;
  declare kind: string;
  declare outcome: string | null;
  declare orderId: string | null;
  declare ccy: string | null;
  /** Owning desk (lowercased email); null for a process-level beat. */
  declare userEmail: string | null;
  declare summary: string;
  declare payload: ExecutionLogEvent;
  declare createdAt: Date;
}

export async function initExecutionLog(sequelize: Sequelize) {
  ExecutionLog.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      atMs: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      kind: {
        type: DataTypes.STRING(16),
        allowNull: false,
      },
      outcome: {
        type: DataTypes.STRING(24),
        allowNull: true,
      },
      orderId: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      ccy: {
        type: DataTypes.STRING(8),
        allowNull: true,
      },
      userEmail: {
        type: DataTypes.STRING(320),
        allowNull: true,
      },
      summary: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      payload: {
        type: DataTypes.JSON,
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'ExecutionLog',
      tableName: 'execution_logs',
      timestamps: false,
    },
  );
  // Creates the table if missing — no force/alter. `sync()` never adds a
  // column to an existing table, so the owner column and its index are added
  // by guarded statements: idempotent, additive-only, safe on every start
  // (decisions.md, 2026-09-23). Rows written before the
  // column existed stay NULL and are never shown as anyone's order events.
  const model = await ExecutionLog.sync();
  await sequelize.query(
    'ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS "userEmail" VARCHAR(320)',
  );
  await sequelize.query(
    'CREATE INDEX IF NOT EXISTS execution_logs_user_email_at_ms ON execution_logs ("userEmail", "atMs")',
  );
  return model;
}

let executionLogReady: Promise<typeof ExecutionLog | null> | null = null;

export async function getExecutionLogModel(): Promise<typeof ExecutionLog | null> {
  if (executionLogReady) return executionLogReady;
  executionLogReady = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    await initExecutionLog(sequelize);
    return ExecutionLog;
  })().catch(err => {
    executionLogReady = null;
    throw err;
  });
  return executionLogReady;
}
