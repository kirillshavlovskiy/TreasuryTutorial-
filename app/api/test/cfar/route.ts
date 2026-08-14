import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { computeMonteCarloMismatchCfar } from '@/lib/test-mode/cfar-montecarlo';
import {
  parseCfarJobsRequest,
  type CfarBands,
  type CfarJobEvent,
} from '@/lib/test-mode/cfar-job';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST — run a batch of Monte Carlo CFaR simulations server-side.
 *
 * Responds with newline-delimited JSON rather than one object at the end: a
 * batch is one simulation per currency plus up to ten frontier points, and
 * each is hundreds of milliseconds, so streaming lets the table fill in as
 * results land instead of blocking on the slowest job.
 */
export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email?.trim() ?? '';
  if (!email || email === TEST_GUEST_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
  }

  const parsed = parseCfarJobsRequest(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { jobs } = parsed;

  const encoder = new TextEncoder();
  // The client cancels a batch whenever a parameter changes, which closes this
  // stream underneath us. Every write is guarded so a normal cancellation stays
  // a normal cancellation instead of surfacing as an ERR_INVALID_STATE.
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const gone = () => closed || request.signal.aborted;
      const send = (event: CfarJobEvent) => {
        if (gone()) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      let completed = 0;
      try {
        for (const job of jobs) {
          if (gone()) break;
          let bands: CfarBands | null = null;
          try {
            bands = computeMonteCarloMismatchCfar(job.input);
          } catch (err) {
            console.error('[api/test/cfar] job failed', job.id, err);
          }
          if (bands) {
            send({ type: 'result', id: job.id, bands });
            completed += 1;
          } else {
            send({
              type: 'error',
              id: job.id,
              message: 'Simulation failed for this scenario',
            });
          }
          // The engine is synchronous and CPU-bound. Yielding between jobs
          // flushes the chunk just produced and gives other requests a turn,
          // so a wide batch cannot hold the event loop for its whole duration.
          await new Promise(resolve => setImmediate(resolve));
        }
        if (!gone()) {
          send({ type: 'done', completed });
          closed = true;
          controller.close();
        }
      } catch (err) {
        console.error('[api/test/cfar] stream failed', err);
        if (!gone()) {
          closed = true;
          controller.error(err);
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
    },
  });
}
