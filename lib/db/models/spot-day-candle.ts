import { DataTypes, Model, type Sequelize } from 'sequelize';

/**
 * One persisted OHLC bar of the process-wide spot tape
 * (`lib/fx-spot-tape.ts`), keyed by market pair and bar length (`barSec`:
 * 1, 5, 15, 30 or 60 seconds). The day record the trade ticket charts
 * before an order exists. It stores our own derived aggregate (the bar),
 * never bid/ask ticks, and nothing from Treasury.
 *
 * Deliberately not scoped by user: the spot tape is one shared market feed
 * per currency (decisions.md, 2026-09-07), so every desk must see the same
 * bars. LegTapeTick stays the per-order, per-user tape the matcher verifies
 * fills against; this table never feeds a fill decision. Rows older than
 * SPOT_DAY_RETENTION_MS are deleted by the recorder — a chart cache, not an
 * audit trail. The walk is per process, so two instances closing the same
 * bucket are last-writer-wins here; the matcher runtime is single-process by
 * design and this table inherits that.
 */
export class SpotDayCandleRow extends Model {
  declare id: number;
  declare pair: string;
  declare barSec: number;
  declare bucketStartMs: number;
  declare openMid: number;
  declare highMid: number;
  declare lowMid: number;
  declare closeMid: number;
  declare tickCount: number;
  declare livePrintCount: number;
  declare updatedAt: Date;
}

/**
 * The bar's high and low used to be the best ask and the best bid of the
 * bucket, and the columns were named for it. They are now the mid path's own
 * extremes (`foldSpotDayTick`), so the columns are renamed to match rather
 * than left holding a different number than their name claims.
 *
 * Runs before `sync()`, which only ever CREATES the table. A fresh database
 * has no table to describe and lands on the new names directly; a database
 * already renamed is left alone. A failure here is reported and not thrown —
 * this table is a chart cache, and losing it must not take down the import.
 */
async function renameSpreadColumns(sequelize: Sequelize): Promise<void> {
  const queryInterface = sequelize.getQueryInterface();
  let columns: Record<string, unknown>;
  try {
    columns = await queryInterface.describeTable('spot_day_candles');
  } catch {
    return; // No table yet — sync() creates it with the current names.
  }
  const renames: [from: string, to: string][] = [
    ['highAsk', 'highMid'],
    ['lowBid', 'lowMid'],
  ];
  for (const [from, to] of renames) {
    if (!(from in columns) || to in columns) continue;
    try {
      await queryInterface.renameColumn('spot_day_candles', from, to);
    } catch (err) {
      console.warn(
        `[fx-spot] could not rename spot_day_candles.${from} to ${to}; the day record will not persist until it is renamed`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function initSpotDayCandleRow(sequelize: Sequelize) {
  SpotDayCandleRow.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      pair: {
        type: DataTypes.STRING(7),
        allowNull: false,
      },
      barSec: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      bucketStartMs: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      openMid: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
      },
      highMid: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
      },
      lowMid: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
      },
      closeMid: {
        type: DataTypes.DECIMAL(20, 8),
        allowNull: false,
      },
      tickCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      // Of tickCount, how many were live overlay prints (the rest: walk steps).
      livePrintCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'SpotDayCandleRow',
      tableName: 'spot_day_candles',
      timestamps: false,
      indexes: [
        {
          // The upsert's conflict target: one row per pair, bar length and bucket.
          name: 'spot_day_candles_bucket',
          unique: true,
          fields: ['pair', 'barSec', 'bucketStartMs'],
        },
      ],
    },
  );

  await renameSpreadColumns(sequelize);
  // Creates the table if missing — no force/alter
  return SpotDayCandleRow.sync();
}

let spotDayCandleRowReady: Promise<typeof SpotDayCandleRow | null> | null = null;

/** Ensure model + table exist. Returns null when DATABASE_URL is unset. */
export async function getSpotDayCandleRowModel(): Promise<
  typeof SpotDayCandleRow | null
> {
  if (spotDayCandleRowReady) return spotDayCandleRowReady;

  spotDayCandleRowReady = (async () => {
    const { getSequelize } = await import('@/lib/db/sequelize');
    const sequelize = getSequelize();
    if (!sequelize) return null;
    await initSpotDayCandleRow(sequelize);
    return SpotDayCandleRow;
  })().catch(err => {
    spotDayCandleRowReady = null;
    throw err;
  });

  return spotDayCandleRowReady;
}
