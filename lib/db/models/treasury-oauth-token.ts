import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

const TABLE_NAME = 'treasury_oauth_tokens';

export class TreasuryOauthToken extends Model<
  InferAttributes<TreasuryOauthToken>,
  InferCreationAttributes<TreasuryOauthToken>
> {
  declare userEmail: string;
  /** AES-256-GCM ciphertext — see lib/treasury/crypto.ts. */
  declare accessTokenCiphertext: string;
  declare refreshTokenCiphertext: string;
  declare expiresAt: Date;
  declare updatedAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
}

export function initTreasuryOauthTokenModel(sequelize: Sequelize): typeof TreasuryOauthToken {
  if (sequelize.isDefined('TreasuryOauthToken')) {
    return sequelize.model('TreasuryOauthToken') as typeof TreasuryOauthToken;
  }

  TreasuryOauthToken.init(
    {
      userEmail: {
        type: DataTypes.STRING(320),
        allowNull: false,
        primaryKey: true,
        field: 'user_email',
      },
      accessTokenCiphertext: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'access_token_ciphertext',
      },
      refreshTokenCiphertext: {
        type: DataTypes.TEXT,
        allowNull: false,
        field: 'refresh_token_ciphertext',
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
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
      modelName: 'TreasuryOauthToken',
      tableName: TABLE_NAME,
      timestamps: true,
      underscored: true,
    },
  );
  return TreasuryOauthToken;
}

let ready: Promise<typeof TreasuryOauthToken | null> | null = null;

/** Ensure model + table exist. Returns null when DATABASE_URL is unset. */
export async function getTreasuryOauthTokenModel(): Promise<typeof TreasuryOauthToken | null> {
  if (ready) return ready;

  ready = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    const Model = initTreasuryOauthTokenModel(sequelize);
    // Creates the table if missing — no force/alter. Mirrors the sandbox-progress
    // model's pattern; see lib/db/migrations for the documented schema.
    await Model.sync();
    return Model;
  })().catch(err => {
    ready = null;
    throw err;
  });

  return ready;
}
