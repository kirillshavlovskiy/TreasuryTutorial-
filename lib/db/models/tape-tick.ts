import { DataTypes, Model, type Sequelize } from 'sequelize';

export class TapeTick extends Model {
  declare id: number;
  declare timestamp: number;
  declare bid: number;
  declare ask: number;
  declare mid: number;
  declare ccy: string;
  declare sessionId: string;
  declare createdAt: Date;
}

export function initTapeTick(sequelize: Sequelize) {
  TapeTick.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      timestamp: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      bid: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
      },
      ask: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
      },
      mid: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
      },
      ccy: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      sessionId: {
        type: DataTypes.STRING(50),
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
      modelName: 'TapeTick',
      tableName: 'tape_ticks',
      timestamps: false,
    },
  );

  // Creates the table if missing — no force/alter
  return TapeTick.sync();
}

let tapeTickReady: Promise<typeof TapeTick | null> | null = null;

/** Ensure model + table exist. Returns null when DATABASE_URL is unset. */
export async function getTapeTickModel(): Promise<typeof TapeTick | null> {
  if (tapeTickReady) return tapeTickReady;

  tapeTickReady = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    await initTapeTick(sequelize);
    return TapeTick;
  })().catch(err => {
    tapeTickReady = null;
    throw err;
  });

  return tapeTickReady;
}
