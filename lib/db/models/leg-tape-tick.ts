import { DataTypes, Model, type Sequelize } from 'sequelize';

/**
 * Per-leg tape history recorded by the server-side matcher, independent of
 * whether any browser tab is open. Keyed by the leg's own tapeQuoteKey
 * (e.g. "EUR|forward|t3.00"), not by bare currency — TapeTick (tape-ticks)
 * is a different, ccy-only table for the simpler per-currency feed and is
 * left alone.
 */
export class LegTapeTick extends Model {
  declare id: number;
  declare quoteKey: string;
  declare userEmail: string;
  declare taskId: string;
  declare timestamp: number;
  declare bid: number;
  declare ask: number;
  declare mid: number;
  declare createdAt: Date;
}

export function initLegTapeTick(sequelize: Sequelize) {
  LegTapeTick.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      quoteKey: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      userEmail: {
        type: DataTypes.STRING(160),
        allowNull: false,
      },
      taskId: {
        type: DataTypes.STRING(32),
        allowNull: false,
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
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'LegTapeTick',
      tableName: 'leg_tape_ticks',
      timestamps: false,
      indexes: [
        {
          name: 'leg_tape_ticks_lookup',
          fields: ['userEmail', 'taskId', 'quoteKey', 'timestamp'],
        },
      ],
    },
  );

  // Creates the table if missing — no force/alter
  return LegTapeTick.sync();
}

let legTapeTickReady: Promise<typeof LegTapeTick | null> | null = null;

/** Ensure model + table exist. Returns null when DATABASE_URL is unset. */
export async function getLegTapeTickModel(): Promise<typeof LegTapeTick | null> {
  if (legTapeTickReady) return legTapeTickReady;

  legTapeTickReady = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    await initLegTapeTick(sequelize);
    return LegTapeTick;
  })().catch(err => {
    legTapeTickReady = null;
    throw err;
  });

  return legTapeTickReady;
}
