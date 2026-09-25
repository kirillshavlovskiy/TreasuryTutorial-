'use strict';

const { Client } = require('pg');

function near(a, b, tol) {
  return Number.isFinite(a) && Math.abs(a - b) <= tol;
}

function isListed(ticket) {
  if (!ticket || ticket.ccy !== 'EUR') return false;
  const amt = Math.abs(Number(ticket.amountLocalM) || 0);
  const lim = ticket.limitRate;
  if (
    lim != null
    && [1.1575, 1.1565, 1.1573, 1.1561, 1.15745, 1.156].some(x =>
      near(lim, x, 6e-5),
    )
  ) {
    return true;
  }
  if (ticket.stripId && [6.99, 3.96, 3.69, 14.65].some(x => near(amt, x, 0.04))) {
    return true;
  }
  if (ticket.instrument === 'option' && near(amt, 12.1, 0.04)) return true;
  if (
    (ticket.instrument === 'forward' || ticket.instrument === 'spot')
    && [2.55, 12.1, 14.65].some(x => near(amt, x, 0.04))
  ) {
    return true;
  }
  return false;
}

function stripList(list) {
  const next = [];
  const removed = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (isListed(t)) removed.push(t);
    else next.push(t);
  }
  return { next, removed };
}

async function main() {
  const url =
    process.env.DATABASE_URL
    || process.env.ssigma_DATABASE_URL
    || process.env.POSTGRES_URL;
  if (!url) {
    console.error('No DATABASE_URL');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const now = new Date().toISOString();
  const ids = new Set();
  let sandboxRows = 0;
  let sandboxRemoved = 0;
  let deskRows = 0;
  let deskRemoved = 0;

  for (const table of ['sandbox_progress_uat', 'sandbox_progress_production']) {
    let rows;
    try {
      rows = await client.query(`SELECT user_email, task_id, state FROM ${table}`);
    } catch {
      continue;
    }
    for (const row of rows.rows) {
      const hedges = row.state?.hedgesByEntityId ?? {};
      let changed = 0;
      const nextHedges = {};
      for (const [scope, book] of Object.entries(hedges)) {
        const { next, removed } = stripList(book?.bookedHedges);
        changed += removed.length;
        for (const t of removed) if (t.id) ids.add(t.id);
        nextHedges[scope] = { ...book, bookedHedges: next };
      }
      if (changed === 0) continue;
      sandboxRows += 1;
      sandboxRemoved += changed;
      const state = {
        ...row.state,
        hedgesByEntityId: nextHedges,
        hedgesUpdatedAt: now,
      };
      await client.query(
        `UPDATE ${table} SET state = $1::jsonb, updated_at = NOW() WHERE user_email = $2 AND task_id = $3`,
        [state, row.user_email, row.task_id],
      );
    }
  }

  for (const table of ['desk_hedge_uat', 'desk_hedge_production']) {
    let rows;
    try {
      rows = await client.query(
        `SELECT user_email, desk_scope, scope_id, booked_hedges FROM ${table}`,
      );
    } catch {
      continue;
    }
    for (const row of rows.rows) {
      const { next, removed } = stripList(row.booked_hedges);
      if (removed.length === 0) continue;
      deskRows += 1;
      deskRemoved += removed.length;
      for (const t of removed) if (t.id) ids.add(t.id);
      await client.query(
        `UPDATE ${table} SET booked_hedges = $1::jsonb, updated_at = NOW()
         WHERE user_email = $2 AND desk_scope = $3 AND scope_id = $4`,
        [JSON.stringify(next), row.user_email, row.desk_scope, row.scope_id],
      );
    }
  }

  const idList = [...ids];
  let executions = 0;
  if (idList.length > 0) {
    try {
      const del = await client.query(
        'DELETE FROM order_executions WHERE order_id = ANY($1::text[])',
        [idList],
      );
      executions = del.rowCount ?? 0;
    } catch {
      /* optional */
    }
    try {
      await client.query(
        'DELETE FROM execution_logs WHERE order_id = ANY($1::text[])',
        [idList],
      );
    } catch {
      /* optional */
    }
  }

  await client.end();
  console.log(JSON.stringify({
    sandboxRows,
    sandboxRemoved,
    deskRows,
    deskRemoved,
    executions,
    ids: idList.length,
  }));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
