import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { ensureMatchingProcess } from '@/lib/test-mode/matching-process-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/matching-process/heartbeat?probeMs=1200
 *
 * Process liveness for the Node matching engine. Bare liveness (no probe)
 * needs no browser session; `probeMs` steps the tape orders are decided and
 * verified against, and the monitor/fills/tape payloads carry order levels
 * and notionals, so all of those require an authenticated caller.
 */
export async function GET(request: NextRequest) {
  const requestStartMs = Date.now();
  const session = await auth();
  const email = session?.user?.email;
  const probeRequested =
    Number(request.nextUrl.searchParams.get('probeMs') ?? '0') > 0;
  if (probeRequested && !email) {
    // Refusing visibly beats returning 200 with a silently missing probe.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const runtime = await ensureMatchingProcess();
  const probeMs = Math.max(
    0,
    Math.min(5_000, Number(request.nextUrl.searchParams.get('probeMs') ?? '0') || 0),
  );
  // Currencies with a ticket open right now. Registering BEFORE the probe
  // means the very beat this request drives already records them — the
  // desk's rule is that the record starts when the tile is engaged, and a
  // market execution has no order to key off until it fills.
  if (email) {
    const watch = (request.nextUrl.searchParams.get('watch') ?? '')
      .split(',')
      .map(c => c.trim())
      .filter(c => /^[A-Za-z]{3}$/.test(c))
      .slice(0, 8);
    if (watch.length > 0) {
      const taskIdRaw = request.nextUrl.searchParams.get('taskId') ?? '02';
      const taskId = /^[A-Za-z0-9_-]{1,32}$/.test(taskIdRaw) ? taskIdRaw : '02';
      runtime.watchCcys(email, taskId, watch);
    }
  }
  // monitorEvents carries working levels and USD notionals, so it is scoped
  // to the caller's own desk; an unauthenticated caller gets process
  // liveness only, never the book.
  const body =
    email && probeMs > 0
      ? await runtime.probe(probeMs, email)
      : runtime.heartbeat(email ?? null);
  const fills = email ? runtime.fillsViewForUser(email) : [];

  const tapeStartMs = Date.now();
  const tape = email ? runtime.tapeForUser(email) : {};
  const tapeDurationMs = Date.now() - tapeStartMs;
  const totalDurationMs = Date.now() - requestStartMs;

  // Log tape serve metrics
  const tapeKeys = Object.keys(tape);
  const tapeSizes = tapeKeys.map(k => `${k}:${tape[k]?.length ?? 0}`).join(',');
  console.log(
    `[tape-serve-heartbeat] email=${email ?? 'anon'} keys=${tapeKeys.length} ` +
    `tape=${tapeDurationMs}ms total=${totalDurationMs}ms ` +
    `sizes=[${tapeSizes || 'none'}]`
  );

  return NextResponse.json({
    ...body,
    fills,
    // The server-recorded tape for this user's working keys — the series the
    // matcher decides fills against, which the UI charts instead of walking
    // its own.
    tape,
    authenticated: Boolean(email),
  });
}
