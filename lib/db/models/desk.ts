import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import {
  deskTableName,
  getSandboxStorageEnv,
  type SandboxStorageEnv,
} from '@/lib/db/storage-env';
import type { ForecastProfileState } from '@/lib/forecast-profile';
import type { RowState, SharedGlobals, UsdParams } from '@/lib/fx-buffer';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import type {
  CarryProfileSessionV1,
  EntityHedgeBook,
  HedgeTicket,
  PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import type { VarSetup } from '@/lib/test-mode/var-setup';
import type { TimingProfile, Workspace } from '@/lib/workspace-store';
import type { DeskModule } from '@/lib/desk/types';

export type { DeskModule } from '@/lib/desk/types';

export class DeskWorkspace extends Model<
  InferAttributes<DeskWorkspace>,
  InferCreationAttributes<DeskWorkspace>
> {
  declare userEmail: string;
  declare deskScope: string;
  declare workspace: Workspace;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class DeskFxBook extends Model<
  InferAttributes<DeskFxBook>,
  InferCreationAttributes<DeskFxBook>
> {
  declare userEmail: string;
  declare deskScope: string;
  declare dashboardId: string;
  declare entityId: string | null;
  declare rows: RowState[];
  declare usdCash: number | null;
  declare usdNonLpCash: number | null;
  declare usdParams: UsdParams | null;
  declare shared: SharedGlobals | null;
  declare activeLayers: string[] | null;
  declare policyVar: number | null;
  declare formulas: Record<string, string> | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class DeskLiquidity extends Model<
  InferAttributes<DeskLiquidity>,
  InferCreationAttributes<DeskLiquidity>
> {
  declare userEmail: string;
  declare deskScope: string;
  declare dashboardId: string;
  declare entityId: string | null;
  declare forecastProfile: ForecastProfileState | null;
  declare timing: TimingProfile | null;
  declare sizingBasis: string | null;
  declare bookingMode: string | null;
  declare activeLayers: string[] | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class DeskAnalytics extends Model<
  InferAttributes<DeskAnalytics>,
  InferCreationAttributes<DeskAnalytics>
> {
  declare userEmail: string;
  declare deskScope: string;
  declare dashboardId: string;
  declare entityId: string | null;
  declare varSetup: VarSetup | null;
  declare preparedByCcy: Record<string, PreparedHedgeProfile> | null;
  declare carrySessions: Record<string, CarryProfileSessionV1> | null;
  declare marketRates: Record<string, FxMarketRatesBundle> | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class DeskHedge extends Model<
  InferAttributes<DeskHedge>,
  InferCreationAttributes<DeskHedge>
> {
  declare userEmail: string;
  declare deskScope: string;
  declare scopeId: string;
  declare bookedHedges: HedgeTicket[];
  declare hedgeRatios: Record<string, number>;
  declare preparedByCcy: Record<string, PreparedHedgeProfile> | null;
  declare carrySessions: Record<string, CarryProfileSessionV1> | null;
  declare marketRates: Record<string, FxMarketRatesBundle> | null;
  declare version: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class DeskAction extends Model<
  InferAttributes<DeskAction>,
  InferCreationAttributes<DeskAction>
> {
  declare id: CreationOptional<number>;
  declare userEmail: string;
  declare deskScope: string;
  declare dashboardId: string | null;
  declare scopeId: string | null;
  declare module: DeskModule;
  declare action: string;
  declare payload: unknown;
  declare createdAt: CreationOptional<Date>;
}

const snapshotKeys = {
  userEmail: {
    type: DataTypes.STRING(320),
    allowNull: false,
    primaryKey: true,
    field: 'user_email',
  },
  deskScope: {
    type: DataTypes.STRING(64),
    allowNull: false,
    primaryKey: true,
    field: 'desk_scope',
  },
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: 'created_at' },
  updatedAt: { type: DataTypes.DATE, allowNull: false, field: 'updated_at' },
} as const;

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

export function initDeskModels(
  sequelize: Sequelize,
  storageEnv: SandboxStorageEnv = getSandboxStorageEnv(),
): {
  DeskWorkspace: typeof DeskWorkspace;
  DeskFxBook: typeof DeskFxBook;
  DeskLiquidity: typeof DeskLiquidity;
  DeskAnalytics: typeof DeskAnalytics;
  DeskHedge: typeof DeskHedge;
  DeskAction: typeof DeskAction;
} {
  const workspaceTable = deskTableName('workspace', storageEnv);
  if (reinitIfNeeded(sequelize, 'DeskWorkspace', workspaceTable)) {
    DeskWorkspace.init(
      {
        ...snapshotKeys,
        workspace: { type: DataTypes.JSONB, allowNull: false },
      },
      {
        sequelize,
        modelName: 'DeskWorkspace',
        tableName: workspaceTable,
        timestamps: true,
        underscored: true,
      },
    );
  }

  const fxTable = deskTableName('fx_book', storageEnv);
  if (reinitIfNeeded(sequelize, 'DeskFxBook', fxTable)) {
    DeskFxBook.init(
      {
        ...snapshotKeys,
        dashboardId: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          field: 'dashboard_id',
        },
        entityId: { type: DataTypes.STRING(64), allowNull: true, field: 'entity_id' },
        rows: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        usdCash: { type: DataTypes.DOUBLE, allowNull: true, field: 'usd_cash' },
        usdNonLpCash: { type: DataTypes.DOUBLE, allowNull: true, field: 'usd_non_lp_cash' },
        usdParams: { type: DataTypes.JSONB, allowNull: true, field: 'usd_params' },
        shared: { type: DataTypes.JSONB, allowNull: true },
        activeLayers: { type: DataTypes.JSONB, allowNull: true, field: 'active_layers' },
        policyVar: { type: DataTypes.DOUBLE, allowNull: true, field: 'policy_var' },
        formulas: { type: DataTypes.JSONB, allowNull: true },
      },
      {
        sequelize,
        modelName: 'DeskFxBook',
        tableName: fxTable,
        timestamps: true,
        underscored: true,
      },
    );
  }

  const liqTable = deskTableName('liquidity', storageEnv);
  if (reinitIfNeeded(sequelize, 'DeskLiquidity', liqTable)) {
    DeskLiquidity.init(
      {
        ...snapshotKeys,
        dashboardId: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          field: 'dashboard_id',
        },
        entityId: { type: DataTypes.STRING(64), allowNull: true, field: 'entity_id' },
        forecastProfile: { type: DataTypes.JSONB, allowNull: true, field: 'forecast_profile' },
        timing: { type: DataTypes.JSONB, allowNull: true },
        sizingBasis: { type: DataTypes.STRING(32), allowNull: true, field: 'sizing_basis' },
        bookingMode: { type: DataTypes.STRING(32), allowNull: true, field: 'booking_mode' },
        activeLayers: { type: DataTypes.JSONB, allowNull: true, field: 'active_layers' },
      },
      {
        sequelize,
        modelName: 'DeskLiquidity',
        tableName: liqTable,
        timestamps: true,
        underscored: true,
      },
    );
  }

  const analyticsTable = deskTableName('analytics', storageEnv);
  if (reinitIfNeeded(sequelize, 'DeskAnalytics', analyticsTable)) {
    DeskAnalytics.init(
      {
        ...snapshotKeys,
        dashboardId: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          field: 'dashboard_id',
        },
        entityId: { type: DataTypes.STRING(64), allowNull: true, field: 'entity_id' },
        varSetup: { type: DataTypes.JSONB, allowNull: true, field: 'var_setup' },
        preparedByCcy: { type: DataTypes.JSONB, allowNull: true, field: 'prepared_by_ccy' },
        carrySessions: { type: DataTypes.JSONB, allowNull: true, field: 'carry_sessions' },
        marketRates: { type: DataTypes.JSONB, allowNull: true, field: 'market_rates' },
      },
      {
        sequelize,
        modelName: 'DeskAnalytics',
        tableName: analyticsTable,
        timestamps: true,
        underscored: true,
      },
    );
  }

  const hedgeTable = deskTableName('hedge', storageEnv);
  if (reinitIfNeeded(sequelize, 'DeskHedge', hedgeTable)) {
    DeskHedge.init(
      {
        ...snapshotKeys,
        scopeId: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          field: 'scope_id',
        },
        bookedHedges: {
          type: DataTypes.JSONB,
          allowNull: false,
          defaultValue: [],
          field: 'booked_hedges',
        },
        hedgeRatios: {
          type: DataTypes.JSONB,
          allowNull: false,
          defaultValue: {},
          field: 'hedge_ratios',
        },
        preparedByCcy: { type: DataTypes.JSONB, allowNull: true, field: 'prepared_by_ccy' },
        carrySessions: { type: DataTypes.JSONB, allowNull: true, field: 'carry_sessions' },
        marketRates: { type: DataTypes.JSONB, allowNull: true, field: 'market_rates' },
      },
      {
        sequelize,
        modelName: 'DeskHedge',
        tableName: hedgeTable,
        timestamps: true,
        underscored: true,
      },
    );
  }

  const actionTable = deskTableName('action', storageEnv);
  if (reinitIfNeeded(sequelize, 'DeskAction', actionTable)) {
    DeskAction.init(
      {
        id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
        userEmail: {
          type: DataTypes.STRING(320),
          allowNull: false,
          field: 'user_email',
        },
        deskScope: {
          type: DataTypes.STRING(64),
          allowNull: false,
          field: 'desk_scope',
        },
        dashboardId: {
          type: DataTypes.STRING(64),
          allowNull: true,
          field: 'dashboard_id',
        },
        scopeId: { type: DataTypes.STRING(64), allowNull: true, field: 'scope_id' },
        module: { type: DataTypes.STRING(32), allowNull: false },
        action: { type: DataTypes.STRING(64), allowNull: false },
        payload: { type: DataTypes.JSONB, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false, field: 'created_at' },
      },
      {
        sequelize,
        modelName: 'DeskAction',
        tableName: actionTable,
        timestamps: true,
        updatedAt: false,
        underscored: true,
      },
    );
  }

  return {
    DeskWorkspace,
    DeskFxBook,
    DeskLiquidity,
    DeskAnalytics,
    DeskHedge,
    DeskAction,
  };
}

export function hedgeBookFromRow(row: DeskHedge): EntityHedgeBook {
  return {
    bookedHedges: row.bookedHedges ?? [],
    hedgeRatios: row.hedgeRatios ?? {},
    preparedByCcy: row.preparedByCcy ?? {},
    carrySessionsByCcy: row.carrySessions ?? {},
    marketRatesByCcy: row.marketRates ?? {},
  };
}

let ready: Promise<ReturnType<typeof initDeskModels> | null> | null = null;
let readyEnv: SandboxStorageEnv | null = null;

/** Ensure desk models + env tables exist. Null when DATABASE_URL is unset. */
export async function getDeskModels(): Promise<ReturnType<typeof initDeskModels> | null> {
  const storageEnv = getSandboxStorageEnv();
  if (ready && readyEnv === storageEnv) return ready;

  readyEnv = storageEnv;
  ready = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    const models = initDeskModels(sequelize, storageEnv);
    await Promise.all([
      models.DeskWorkspace.sync(),
      models.DeskFxBook.sync(),
      models.DeskLiquidity.sync(),
      models.DeskAnalytics.sync(),
      models.DeskHedge.sync(),
      models.DeskAction.sync(),
    ]);
    return models;
  })().catch(err => {
    ready = null;
    readyEnv = null;
    throw err;
  });

  return ready;
}
