import { DataTypes, Model, type Sequelize } from 'sequelize';

export class MatchingProcessState extends Model {
  declare id: number;
  declare isRunning: boolean;
  declare lastTickAt: number | null;
  declare processInstanceId: string;
  declare updatedAt: Date;
}

export function initMatchingProcessState(sequelize: Sequelize) {
  MatchingProcessState.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      isRunning: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      lastTickAt: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      processInstanceId: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'MatchingProcessState',
      tableName: 'matching_process_state',
      timestamps: false,
    },
  );

  // Creates the table if missing — no force/alter
  return MatchingProcessState.sync();
}

let matchingProcessStateReady: Promise<typeof MatchingProcessState | null> | null = null;

/** Ensure model + table exist. Returns null when DATABASE_URL is unset. */
export async function getMatchingProcessStateModel(): Promise<typeof MatchingProcessState | null> {
  if (matchingProcessStateReady) return matchingProcessStateReady;

  matchingProcessStateReady = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    await initMatchingProcessState(sequelize);
    return MatchingProcessState;
  })().catch(err => {
    matchingProcessStateReady = null;
    throw err;
  });

  return matchingProcessStateReady;
}
