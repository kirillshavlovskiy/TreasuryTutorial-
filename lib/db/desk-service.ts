import { isDatabaseConfigured } from '@/lib/db/sequelize';
import { getDeskModels, hedgeBookFromRow } from '@/lib/db/models/desk';
import { getSandboxStorageEnv } from '@/lib/db/storage-env';
import { snapshotsFromSandbox } from '@/lib/desk/sandbox-sync';
import {
  DESK_STATE_VERSION,
  deskScopeForTask,
  type DeskActionInput,
  type DeskModule,
  type DeskPutInput,
  type DeskStateSnapshot,
} from '@/lib/desk/types';
import type { EntityHedgeBook } from '@/lib/test-mode/hedge-var';
import type { TestSandboxState } from '@/lib/test-mode/types';

export {
  DESK_STATE_VERSION,
  WORKBENCH_DESK_SCOPE,
  deskScopeForTask,
  type DeskActionInput,
  type DeskAnalyticsInput,
  type DeskFxBookInput,
  type DeskHedgeInput,
  type DeskLiquidityInput,
  type DeskPutInput,
  type DeskStateSnapshot,
} from '@/lib/desk/types';
export { snapshotsFromSandbox } from '@/lib/desk/sandbox-sync';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function loadDeskState(
  userEmail: string,
  deskScope: string,
): Promise<DeskStateSnapshot> {
  const storageEnv = getSandboxStorageEnv();
  const empty: DeskStateSnapshot = {
    scope: deskScope,
    workspace: null,
    fxBooks: [],
    liquidity: [],
    analytics: [],
    hedges: {},
    storageEnv,
    persistent: false,
  };
  const models = await getDeskModels();
  if (!models) return empty;

  const email = normalizeEmail(userEmail);
  const where = { userEmail: email, deskScope };
  const [workspace, fxBooks, liquidity, analytics, hedges] = await Promise.all([
    models.DeskWorkspace.findOne({ where }),
    models.DeskFxBook.findAll({ where }),
    models.DeskLiquidity.findAll({ where }),
    models.DeskAnalytics.findAll({ where }),
    models.DeskHedge.findAll({ where }),
  ]);

  const hedgeMap: Record<string, EntityHedgeBook> = {};
  for (const row of hedges) hedgeMap[row.scopeId] = hedgeBookFromRow(row);

  return {
    scope: deskScope,
    workspace: workspace?.workspace ?? null,
    fxBooks: fxBooks.map(r => ({
      dashboardId: r.dashboardId,
      entityId: r.entityId,
      rows: r.rows ?? [],
      usdCash: r.usdCash,
      usdNonLpCash: r.usdNonLpCash,
      usdParams: r.usdParams,
      shared: r.shared,
      activeLayers: r.activeLayers,
      policyVar: r.policyVar,
      formulas: r.formulas,
      updatedAt: r.updatedAt.toISOString(),
    })),
    liquidity: liquidity.map(r => ({
      dashboardId: r.dashboardId,
      entityId: r.entityId,
      forecastProfile: r.forecastProfile,
      timing: r.timing,
      sizingBasis: r.sizingBasis,
      bookingMode: r.bookingMode,
      activeLayers: r.activeLayers,
      updatedAt: r.updatedAt.toISOString(),
    })),
    analytics: analytics.map(r => ({
      dashboardId: r.dashboardId,
      entityId: r.entityId,
      varSetup: r.varSetup,
      preparedByCcy: r.preparedByCcy,
      carrySessions: r.carrySessions,
      marketRates: r.marketRates,
      updatedAt: r.updatedAt.toISOString(),
    })),
    hedges: hedgeMap,
    storageEnv,
    persistent: true,
  };
}

export async function saveDeskState(
  userEmail: string,
  deskScope: string,
  input: DeskPutInput,
): Promise<DeskStateSnapshot> {
  const models = await getDeskModels();
  if (!models) {
    throw new Error('Postgres DATABASE_URL is not configured');
  }
  const email = normalizeEmail(userEmail);
  const version = DESK_STATE_VERSION;

  if (input.workspace) {
    await models.DeskWorkspace.upsert({
      userEmail: email,
      deskScope,
      workspace: input.workspace,
      version,
    });
  }

  if (input.fxBook) {
    const fx = input.fxBook;
    await models.DeskFxBook.upsert({
      userEmail: email,
      deskScope,
      dashboardId: fx.dashboardId,
      entityId: fx.entityId ?? null,
      rows: fx.rows,
      usdCash: fx.usdCash ?? null,
      usdNonLpCash: fx.usdNonLpCash ?? null,
      usdParams: fx.usdParams ?? null,
      shared: fx.shared ?? null,
      activeLayers: fx.activeLayers ?? null,
      policyVar: fx.policyVar ?? null,
      formulas: fx.formulas ?? null,
      version,
    });
  }

  if (input.liquidity) {
    const liq = input.liquidity;
    await models.DeskLiquidity.upsert({
      userEmail: email,
      deskScope,
      dashboardId: liq.dashboardId,
      entityId: liq.entityId ?? null,
      forecastProfile: liq.forecastProfile ?? null,
      timing: liq.timing ?? null,
      sizingBasis: liq.sizingBasis ?? null,
      bookingMode: liq.bookingMode ?? null,
      activeLayers: liq.activeLayers ?? null,
      version,
    });
  }

  if (input.analytics) {
    const a = input.analytics;
    await models.DeskAnalytics.upsert({
      userEmail: email,
      deskScope,
      dashboardId: a.dashboardId,
      entityId: a.entityId ?? null,
      varSetup: a.varSetup ?? null,
      preparedByCcy: a.preparedByCcy ?? null,
      carrySessions: a.carrySessions ?? null,
      marketRates: a.marketRates ?? null,
      version,
    });
  }

  if (input.hedge) {
    const book = input.hedge.book;
    await models.DeskHedge.upsert({
      userEmail: email,
      deskScope,
      scopeId: input.hedge.scopeId,
      bookedHedges: book.bookedHedges ?? [],
      hedgeRatios: book.hedgeRatios ?? {},
      preparedByCcy: book.preparedByCcy ?? null,
      carrySessions: book.carrySessionsByCcy ?? null,
      marketRates: book.marketRatesByCcy ?? null,
      version,
    });
  }

  if (input.action) {
    await models.DeskAction.create({
      userEmail: email,
      deskScope,
      dashboardId: input.action.dashboardId ?? null,
      scopeId: input.action.scopeId ?? null,
      module: input.action.module,
      action: input.action.action,
      payload: input.action.payload ?? null,
    });
  }

  return loadDeskState(email, deskScope);
}

export async function appendDeskAction(
  userEmail: string,
  deskScope: string,
  input: DeskActionInput,
): Promise<void> {
  const models = await getDeskModels();
  if (!models) return;
  await models.DeskAction.create({
    userEmail: normalizeEmail(userEmail),
    deskScope,
    dashboardId: input.dashboardId ?? null,
    scopeId: input.scopeId ?? null,
    module: input.module,
    action: input.action,
    payload: input.payload ?? null,
  });
}

export async function listDeskActions(
  userEmail: string,
  deskScope: string,
  opts?: { module?: DeskModule; limit?: number },
): Promise<
  Array<{
    id: number;
    module: DeskModule;
    action: string;
    dashboardId: string | null;
    scopeId: string | null;
    payload: unknown;
    createdAt: string;
  }>
> {
  const models = await getDeskModels();
  if (!models) return [];
  const where: { userEmail: string; deskScope: string; module?: DeskModule } = {
    userEmail: normalizeEmail(userEmail),
    deskScope,
  };
  if (opts?.module) where.module = opts.module;
  const rows = await models.DeskAction.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit: Math.min(opts?.limit ?? 100, 500),
  });
  return rows.map(r => ({
    id: Number(r.id),
    module: r.module,
    action: r.action,
    dashboardId: r.dashboardId,
    scopeId: r.scopeId,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function deleteDeskScope(
  userEmail: string,
  deskScope: string,
): Promise<void> {
  const models = await getDeskModels();
  if (!models) return;
  const where = { userEmail: normalizeEmail(userEmail), deskScope };
  await Promise.all([
    models.DeskWorkspace.destroy({ where }),
    models.DeskFxBook.destroy({ where }),
    models.DeskLiquidity.destroy({ where }),
    models.DeskAnalytics.destroy({ where }),
    models.DeskHedge.destroy({ where }),
    models.DeskAction.destroy({ where }),
  ]);
}

/** Copy sandbox JSONB into the normalized desk tables + one sync action. */
export async function syncSandboxToDeskTables(
  userEmail: string,
  taskId: string,
  state: TestSandboxState,
): Promise<void> {
  if (!isDatabaseConfigured()) return;
  const scope = deskScopeForTask(taskId);
  const puts = snapshotsFromSandbox(state);
  for (const put of puts) {
    await saveDeskState(userEmail, scope, put);
  }
  await appendDeskAction(userEmail, scope, {
    module: 'workspace',
    action: 'sandbox.sync',
    payload: {
      entityCount: state.workspace.entities.length,
      hedgeScopes: Object.keys(state.hedgesByEntityId ?? {}),
    },
  });
}

export function isDeskDatabaseAvailable(): boolean {
  return isDatabaseConfigured();
}
