import { NextResponse, type NextRequest } from 'next/server';
import { Op } from 'sequelize';
import { auth } from '@/auth';
import { getExecutionLogModel } from '@/lib/db/models/execution-log';
import {
  appendExecutionLogs,
  listExecutionLogs,
  normalizeOwnerEmail,
} from '@/lib/execution-log-store';
import {
  EXEC_LOG_TAG,
  dedupeMonitorEvents,
  type ExecutionLogEvent,
} from '@/lib/test-mode/execution-monitor';

export const runtime = 'nodejs';

function isEvent(v: unknown): v is ExecutionLogEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as { kind?: unknown; summary?: unknown; atMs?: unknown };
  return (
    (e.kind === 'beat' || e.kind === 'order')
    && typeof e.summary === 'string'
    && typeof e.atMs === 'number'
  );
}

/**
 * GET /api/execution-log?limit=200
 * Recent matching / fill decisions for the caller's own desk monitor: its
 * own order lines, plus process-level beats. Another desk's orders are never
 * returned, and neither are order rows written before the owner column.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const viewer = normalizeOwnerEmail(session.user.email);
  const limit = Math.min(
    500,
    Math.max(1, Number(request.nextUrl.searchParams.get('limit') ?? '200') || 200),
  );
  const memory = listExecutionLogs(viewer, limit);
  try {
    const Model = await getExecutionLogModel();
    if (!Model || memory.length >= limit) {
      return NextResponse.json({ count: memory.length, events: memory });
    }
    const rows = await Model.findAll({
      where: {
        [Op.or]: [
          { userEmail: viewer },
          { kind: 'beat', userEmail: { [Op.is]: null } },
        ],
      },
      order: [['atMs', 'DESC']],
      limit,
      raw: true,
    });
    const seen = new Set(memory.map(e => `${e.kind}:${e.atMs}:${e.summary}`));
    const merged = [...memory];
    for (const row of rows) {
      const payload = row.payload as ExecutionLogEvent;
      if (!isEvent(payload)) continue;
      const key = `${payload.kind}:${payload.atMs}:${payload.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(payload);
      if (merged.length >= limit * 4) break;
    }
    const events = dedupeMonitorEvents(merged).slice(0, limit);
    return NextResponse.json({ count: events.length, events });
  } catch (error) {
    console.error('Error fetching execution log:', error);
    return NextResponse.json({
      count: memory.length,
      events: memory,
      degraded: true,
    });
  }
}

/**
 * POST /api/execution-log
 * Body: { events: ExecutionLogEvent[] }
 * Writes to the process ring buffer, server stdout, and DB when configured.
 * Every event is attributed to the caller's session — beats included, so a
 * client-posted beat is never shown to another desk.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const owner = normalizeOwnerEmail(session.user.email);
  try {
    const body = await request.json();
    const raw: unknown[] = Array.isArray(body?.events) ? body.events : [body];
    const events = raw.filter(isEvent);
    if (events.length === 0) {
      return NextResponse.json({ error: 'No events' }, { status: 400 });
    }
    appendExecutionLogs(events.map(event => ({ ownerEmail: owner, event })));
    for (const e of events) {
      if (e.kind === 'beat') {
        console.info(`${EXEC_LOG_TAG} ${e.summary}`);
      } else {
        console.info(`${EXEC_LOG_TAG} ${e.summary}`, {
          orderId: e.orderId,
          ccy: e.ccy,
          basis: e.basis,
          instrument: e.instrument,
          outcome: e.outcome,
          hitSide: e.hitSide,
          limitRate: e.limitRate,
          filledPx: e.filledPx,
          notionalUsdM: e.notionalUsdM,
        });
      }
    }
    const Model = await getExecutionLogModel();
    if (Model) {
      await Model.bulkCreate(
        events.map(e => ({
          atMs: e.atMs,
          kind: e.kind,
          outcome: e.kind === 'order' ? e.outcome : null,
          orderId: e.kind === 'order' ? e.orderId : null,
          ccy: e.kind === 'order' ? e.ccy : null,
          userEmail: owner,
          summary: e.summary,
          payload: e,
        })),
      );
    }
    return NextResponse.json({ ok: true, accepted: events.length });
  } catch (error) {
    console.error('Error recording execution log:', error);
    return NextResponse.json(
      { error: 'Failed to record execution log' },
      { status: 500 },
    );
  }
}
