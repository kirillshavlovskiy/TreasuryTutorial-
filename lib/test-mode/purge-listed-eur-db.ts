import { QueryTypes } from 'sequelize';
import { getSequelize } from '@/lib/db/sequelize';
import { stripListedEurFromHedgeBooks } from '@/lib/test-mode/listed-eur-orders';
import type { EntityHedgeBook } from '@/lib/test-mode/hedge-var';

export type ListedEurPurgeReport = {
  sandboxRows: number;
  sandboxRemoved: number;
  deskRows: number;
  deskRemoved: number;
  executionRows: number;
  ids: string[];
};

function asHedges(state: unknown): Record<string, EntityHedgeBook> {
  if (!state || typeof state !== 'object') return {};
  const hedges = (state as { hedgesByEntityId?: unknown }).hedgesByEntityId;
  return hedges && typeof hedges === 'object'
    ? (hedges as Record<string, EntityHedgeBook>)
    : {};
}

export async function purgeListedEurOrdersFromDb(): Promise<ListedEurPurgeReport> {
  const sequelize = getSequelize();
  const report: ListedEurPurgeReport = {
    sandboxRows: 0,
    sandboxRemoved: 0,
    deskRows: 0,
    deskRemoved: 0,
    executionRows: 0,
    ids: [],
  };
  if (!sequelize) return report;

  const now = new Date().toISOString();
  const sandboxTables = ['sandbox_progress_uat', 'sandbox_progress_production'];
  for (const table of sandboxTables) {
    let rows: { user_email: string; task_id: string; state: unknown }[] = [];
    try {
      rows = await sequelize.query(
        `SELECT user_email, task_id, state FROM ${table}`,
        { type: QueryTypes.SELECT },
      );
    } catch {
      continue;
    }
    for (const row of rows) {
      const hedges = asHedges(row.state);
      const stripped = stripListedEurFromHedgeBooks(hedges);
      if (stripped.removedCount === 0) continue;
      report.sandboxRows += 1;
      report.sandboxRemoved += stripped.removedCount;
      report.ids.push(...stripped.removedIds);
      const state = {
        ...(row.state as object),
        hedgesByEntityId: stripped.hedges,
        hedgesUpdatedAt: now,
      };
      await sequelize.query(
        `UPDATE ${table}
         SET state = $1::jsonb, updated_at = NOW()
         WHERE user_email = $2 AND task_id = $3`,
        { bind: [JSON.stringify(state), row.user_email, row.task_id] },
      );
    }
  }

  const deskTables = ['desk_hedge_uat', 'desk_hedge_production'];
  for (const table of deskTables) {
    let rows: {
      user_email: string;
      desk_scope: string;
      scope_id: string;
      booked_hedges: unknown;
    }[] = [];
    try {
      rows = await sequelize.query(
        `SELECT user_email, desk_scope, scope_id, booked_hedges FROM ${table}`,
        { type: QueryTypes.SELECT },
      );
    } catch {
      continue;
    }
    for (const row of rows) {
      const list = Array.isArray(row.booked_hedges) ? row.booked_hedges : [];
      const book = { bookedHedges: list, hedgeRatios: {} };
      const stripped = stripListedEurFromHedgeBooks({ _: book as EntityHedgeBook });
      if (stripped.removedCount === 0) continue;
      report.deskRows += 1;
      report.deskRemoved += stripped.removedCount;
      report.ids.push(...stripped.removedIds);
      await sequelize.query(
        `UPDATE ${table}
         SET booked_hedges = $1::jsonb, updated_at = NOW()
         WHERE user_email = $2 AND desk_scope = $3 AND scope_id = $4`,
        {
          bind: [
            JSON.stringify(stripped.hedges._?.bookedHedges ?? []),
            row.user_email,
            row.desk_scope,
            row.scope_id,
          ],
        },
      );
    }
  }

  const ids = [...new Set(report.ids.filter(Boolean))];
  report.ids = ids;
  if (ids.length > 0) {
    try {
      const [execCount] = await sequelize.query(
        `DELETE FROM order_executions WHERE order_id = ANY($1::text[])`,
        { bind: [ids] },
      );
      report.executionRows = Array.isArray(execCount) ? execCount.length : 0;
    } catch {
      /* table may not exist locally */
    }
    try {
      await sequelize.query(
        `DELETE FROM execution_logs WHERE order_id = ANY($1::text[])`,
        { bind: [ids] },
      );
    } catch {
      /* optional */
    }
  }
  return report;
}
