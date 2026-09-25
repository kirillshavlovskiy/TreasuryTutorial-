import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { ensureMatchingProcess } from '@/lib/test-mode/matching-process-runtime';
import { loadLegTapeTicks } from '@/lib/test-mode/matching-process-persist';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import type { SimSpotQuote } from '@/lib/test-mode/sim-ticket-price';

export const runtime = 'nodejs';

const MAX_HISTORY_KEYS = 24;
// tapeQuoteKey shapes: "EUR|spot", "EUR|forward|t5.00", "EUR|forward|s0".
const QUOTE_KEY_RE = /^[A-Z]{3}\|[A-Za-z]{1,12}(\|[A-Za-z0-9.]{1,12})?$/;

function isTicket(v: unknown): v is HedgeTicket {
  if (!v || typeof v !== 'object') return false;
  const t = v as {
    id?: unknown;
    ccy?: unknown;
    isSpotReferenced?: unknown;
    stripLegPoints?: unknown;
  };
  if (typeof t.id !== 'string' || typeof t.ccy !== 'string') return false;
  // A spot-referenced order books spot + stripLegPoints when it fills: refuse
  // one whose flag or points would book a forward at a malformed rate.
  if (t.isSpotReferenced === undefined) return true;
  if (typeof t.isSpotReferenced !== 'boolean') return false;
  return (
    !t.isSpotReferenced
    || (typeof t.stripLegPoints === 'number'
      && Number.isFinite(t.stripLegPoints)
      && t.stripLegPoints !== 0)
  );
}

/**
 * GET /api/matching-process/orders?taskId=..&keys=EUR|spot,EUR|forward|t5.00
 * Persisted tape history for this user's own keys, straight from Postgres.
 * Backstop for every state the live feed cannot cover: the heartbeat serves
 * a key only while an order still works it, and the runtime's memory starts
 * empty on every recreation — a reopened booking whose orders all finished
 * has no other source, and without this the chart opens blank.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const requestStartMs = Date.now();
    const params = request.nextUrl.searchParams;
    const taskIdRaw = params.get('taskId') ?? 'workspace';
    const taskId = /^[A-Za-z0-9_-]{1,32}$/.test(taskIdRaw)
      ? taskIdRaw
      : 'workspace';
    const keys = (params.get('keys') ?? '')
      .split(',')
      .map(k => k.trim())
      .filter(k => QUOTE_KEY_RE.test(k))
      .slice(0, MAX_HISTORY_KEYS);
    // Optional order-story window: the booking chart shows the record from
    // the moment the order was placed until a few minutes past execution,
    // so the caller scopes the read to that span instead of "newest 2000
    // rows" (which for an old fill is entirely the wrong stretch of tape).
    const asMs = (name: string): number | null => {
      const n = Number(params.get(name));
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    };
    const fromMs = asMs('fromMs');
    const toMs = asMs('toMs');
    const tapeHistory: Record<
      string,
      { bid: number; ask: number; mid: number; t: number }[]
    > = {};
    // LegTapeTick rows are written with the runtime's normalized owner email.
    const email = session.user.email.trim().toLowerCase();

    const keyLoadTimes: Record<string, number> = {};
    for (const key of keys) {
      const keyStartMs = Date.now();
      // 4000 newest rows ≈ 66 min of 1s prints, so a story that ran for
      // more than half an hour is not cut at its old end.
      const points = await loadLegTapeTicks(email, taskId, key, 4_000, {
        fromMs,
        toMs,
      });
      const keyDurationMs = Date.now() - keyStartMs;
      keyLoadTimes[key] = keyDurationMs;

      if (points.length > 0) {
        tapeHistory[key] = points.map(p => ({
          bid: p.bid,
          ask: p.ask,
          mid: p.mid,
          t: p.t,
        }));
      }
    }

    const totalDurationMs = Date.now() - requestStartMs;
    const pointCounts = Object.entries(tapeHistory).map(([k, pts]) => `${k}:${pts.length}`).join(',');
    const windowStr = fromMs || toMs ? `[${fromMs ?? '?'}-${toMs ?? '?'}]` : 'full';

    console.log(
      `[tape-load-orders] email=${email} task=${taskId} keys=${keys.length} ` +
      `window=${windowStr} total=${totalDurationMs}ms ` +
      `per_key=[${keys.map(k => `${k}:${keyLoadTimes[k] ?? 0}ms`).join(' ')}] ` +
      `points=[${pointCounts}]`
    );

    return NextResponse.json({ taskId, tapeHistory, authenticated: true });
  } catch (error) {
    console.error('Error loading persisted tape history:', error);
    return NextResponse.json(
      { error: 'Failed to load tape history' },
      { status: 500 },
    );
  }
}

function isSpot(v: unknown): v is SimSpotQuote {
  if (!v || typeof v !== 'object') return false;
  const q = v as { bid?: unknown; ask?: unknown; mid?: unknown };
  return (
    typeof q.bid === 'number'
    && typeof q.ask === 'number'
    && typeof q.mid === 'number'
    && q.mid > 0
  );
}

/**
 * POST /api/matching-process/orders
 * Replace this user's working book on the Node matcher.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const tickets = Array.isArray(body?.tickets)
      ? body.tickets.filter(isTicket)
      : [];
    const spotsRaw = body?.spots && typeof body.spots === 'object'
      ? body.spots as Record<string, unknown>
      : {};
    const spots: Record<string, SimSpotQuote> = {};
    for (const [ccy, q] of Object.entries(spotsRaw)) {
      if (isSpot(q)) spots[ccy] = q;
    }
    const taskId = typeof body?.taskId === 'string' && body.taskId.trim()
      ? body.taskId.trim()
      : 'workspace';
    // Currencies with a ticket panel open right now. The desk's rule is
    // that the record starts when the tile is first engaged, so these keep
    // recording before any order exists (a market fill creates its order
    // only at execution).
    const watchCcys = Array.isArray(body?.watchCcys)
      ? body.watchCcys.filter((c: unknown): c is string => typeof c === 'string')
      : [];
    const runtime = await ensureMatchingProcess();
    runtime.replaceUserOrders(session.user.email, taskId, tickets, spots);
    if (watchCcys.length > 0) {
      runtime.watchCcys(session.user.email, taskId, watchCcys.slice(0, 8));
    }
    return NextResponse.json({
      accepted: tickets.length,
      ...runtime.heartbeat(session.user.email),
      fills: runtime.fillsViewForUser(session.user.email),
      tape: runtime.tapeForUser(session.user.email),
      authenticated: true,
    });
  } catch (error) {
    console.error('Error syncing matching orders:', error);
    return NextResponse.json(
      { error: 'Failed to sync matching orders' },
      { status: 500 },
    );
  }
}
