import { DataTypes, Model, type Sequelize } from 'sequelize';

export class OrderExecution extends Model {
  declare id: number;
  declare orderId: string;
  declare executedAt: number;
  declare price: number;
  declare fill: 'bid' | 'ask';
  /** Owning desk (lowercased email). NULL on rows written before it existed. */
  declare userEmail: string | null;
  /**
   * Full ticket snapshot at fill time. The sandbox book is current-state
   * only — clearing it used to orphan every past execution (98 of 115 rows
   * had no retrievable details). The fill is the last moment the ticket is
   * guaranteed known, so it is recorded here.
   */
  declare ticket: object | null;
  declare createdAt: Date;
}

export function initOrderExecution(sequelize: Sequelize) {
  OrderExecution.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      orderId: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      executedAt: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      price: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
      },
      fill: {
        type: DataTypes.ENUM('bid', 'ask'),
        allowNull: false,
      },
      userEmail: {
        type: DataTypes.STRING(320),
        allowNull: true,
      },
      ticket: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'OrderExecution',
      tableName: 'order_executions',
      timestamps: false,
    },
  );

  // Creates the table if missing — no force/alter. `sync()` never adds a
  // column to an existing table, so the snapshot and owner columns are added
  // by guarded ALTERs: idempotent, additive-only, safe on every start.
  return OrderExecution.sync().then(async model => {
    await sequelize.query(
      'ALTER TABLE order_executions ADD COLUMN IF NOT EXISTS ticket JSONB',
    );
    await sequelize.query(
      'ALTER TABLE order_executions ADD COLUMN IF NOT EXISTS "userEmail" VARCHAR(320)',
    );
    await sequelize.query(
      'CREATE INDEX IF NOT EXISTS order_executions_user_email_order_id ON order_executions ("userEmail", "orderId")',
    );
    return model;
  });
}

let orderExecutionReady: Promise<typeof OrderExecution | null> | null = null;

/** Ensure model + table exist. Returns null when DATABASE_URL is unset. */
export async function getOrderExecutionModel(): Promise<typeof OrderExecution | null> {
  if (orderExecutionReady) return orderExecutionReady;

  orderExecutionReady = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    await initOrderExecution(sequelize);
    return OrderExecution;
  })().catch(err => {
    orderExecutionReady = null;
    throw err;
  });

  return orderExecutionReady;
}
