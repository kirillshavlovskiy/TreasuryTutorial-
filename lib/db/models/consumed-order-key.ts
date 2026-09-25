import { DataTypes, Model, type Sequelize } from 'sequelize';

/**
 * Rest keys / order ids the matcher has consumed (filled or OCO-cancelled).
 * The matcher's in-memory consumed sets die with the runtime instance —
 * an HMR rev bump or restart plus a browser re-sync of a stale sandbox row
 * then resurrects an already-filled rest and double-books it (observed
 * live: one order, two execution rows). This table is the durable copy the
 * runtime reloads on start, so a financial write stays idempotent across
 * process lifetimes.
 */
export class ConsumedOrderKey extends Model {
  declare id: number;
  declare orderId: string;
  declare restKey: string | null;
  declare consumedAtMs: number;
  declare createdAt: Date;
}

export function initConsumedOrderKey(sequelize: Sequelize) {
  ConsumedOrderKey.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      orderId: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      restKey: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      consumedAtMs: {
        type: DataTypes.BIGINT,
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
      modelName: 'ConsumedOrderKey',
      tableName: 'consumed_order_keys',
      timestamps: false,
      indexes: [
        { name: 'consumed_order_keys_at', fields: ['consumedAtMs'] },
      ],
    },
  );

  // Creates the table if missing — no force/alter
  return ConsumedOrderKey.sync();
}

let consumedOrderKeyReady: Promise<typeof ConsumedOrderKey | null> | null = null;

/** Ensure model + table exist. Returns null when DATABASE_URL is unset. */
export async function getConsumedOrderKeyModel(): Promise<
  typeof ConsumedOrderKey | null
> {
  if (consumedOrderKeyReady) return consumedOrderKeyReady;

  consumedOrderKeyReady = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    await initConsumedOrderKey(sequelize);
    return ConsumedOrderKey;
  })().catch(err => {
    consumedOrderKeyReady = null;
    throw err;
  });

  return consumedOrderKeyReady;
}
