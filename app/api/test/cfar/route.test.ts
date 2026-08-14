import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CfarJobEvent } from '@/lib/test-mode/cfar-job';
import {
  computeMonteCarloMismatchCfar,
  type McCfarInput,
} from '@/lib/test-mode/cfar-montecarlo';

const sessionEmail = { value: 'analyst@example.com' as string | null };
vi.mock('@/auth', () => ({
  auth: async () =>
    sessionEmail.value ? { user: { email: sessionEmail.value } } : null,
}));

/** Sentinel seed that makes the engine throw, so the route's per-job error
 * handling can be exercised without a malformed input the validator would
 * have rejected first. Everything else runs the real engine. */
const EXPLODING_SEED = -987_654;
vi.mock('@/lib/test-mode/cfar-montecarlo', async importActual => {
  const actual = await importActual<
    typeof import('@/lib/test-mode/cfar-montecarlo')
  >();
  return {
    ...actual,
    computeMonteCarloMismatchCfar: (arg: McCfarInput) => {
      if (arg.seed === EXPLODING_SEED) throw new Error('engine exploded');
      return actual.computeMonteCarloMismatchCfar(arg);
    },
  };
});

const { POST } = await import('@/app/api/test/cfar/route');

const input: McCfarInput = {
  stockM: 1,
  monthlyInflows: [1.2, 1.2, 1.2, 1.2],
  monthlyOutflows: [0.4, 0.4, 0.4, 0.4],
  tenureMonths: 4,
  spotUsd: 1.08,
  sigmaFxMonthly: 0.025,
  confidencePct: 95,
  forecastUncertainty1m: 0.08,
  hedgeSettleSchedule: [{ settleMonths: 3, notionalLocalM: 2 }],
  usdRatePctPa: 4.3,
  fcyRatePctPa: 2.15,
  rateVolPctPa: 0.45,
  paths: 300,
  seed: 4242,
};

function post(body: unknown): Request {
  return new Request('http://localhost/api/test/cfar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readEvents(response: Response): Promise<CfarJobEvent[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as CfarJobEvent);
}

describe('POST /api/test/cfar', () => {
  beforeEach(() => {
    sessionEmail.value = 'analyst@example.com';
  });

  it('refuses anonymous and guest callers', async () => {
    sessionEmail.value = null;
    expect((await POST(post({ jobs: [{ id: 'a', input }] }))).status).toBe(401);
    sessionEmail.value = 'test@sigma.local';
    expect((await POST(post({ jobs: [{ id: 'a', input }] }))).status).toBe(401);
  });

  it('answers 400 with the reason on a bad body', async () => {
    const response = await POST(post({ jobs: [{ id: 'a', input: { stockM: 1 } }] }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/finite number/);

    const notJson = new Request('http://localhost/api/test/cfar', {
      method: 'POST',
      body: 'not json',
    });
    expect((await POST(notJson)).status).toBe(400);
  });

  it('streams one event per job, then done, echoing the ids', async () => {
    const response = await POST(
      post({ jobs: [{ id: 'eur', input }, { id: 'pln', input }] }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');

    const events = await readEvents(response);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'result', id: 'eur' });
    expect(events[1]).toMatchObject({ type: 'result', id: 'pln' });
    expect(events[2]).toEqual({ type: 'done', completed: 2 });
  });

  /**
   * The whole point of the move is that the client gets the same numbers it
   * used to compute in-process. Anything the engine returns that JSON cannot
   * represent — a typed array, a NaN, an Infinity — would arrive silently
   * mangled, so compare a full round-trip against a direct call.
   */
  it('returns bands identical to running the engine in-process', async () => {
    const direct = computeMonteCarloMismatchCfar(input);
    const events = await readEvents(await POST(post({ jobs: [{ id: 'a', input }] })));
    const first = events[0]!;
    if (first.type !== 'result') throw new Error('expected a result event');

    expect(first.bands.criticalCashUsdM).toBe(direct.criticalCashUsdM);
    expect(first.bands.netCriticalCashUsdM).toBe(direct.netCriticalCashUsdM);
    expect(first.bands.carryMeanUsdM).toBe(direct.carryMeanUsdM);
    expect(first.bands.peakBridgeFundingUsdM).toBe(direct.peakBridgeFundingUsdM);
    // Charts read every point and component, so these have to survive as
    // arrays — a Float64Array would arrive as an object keyed by index, and
    // every `.map` over it downstream would throw.
    expect(Array.isArray(first.bands.points)).toBe(true);
    expect(Array.isArray(first.bands.components)).toBe(true);
    expect(first.bands.points).toHaveLength(direct.points.length);
    expect(first.bands.components).toHaveLength(direct.components.length);
    // The one thing JSON does change is the sign of zero: stringify turns -0
    // into "0". That is invisible to every consumer here (-0 === 0, and both
    // plot at the same pixel), so compare against a round-tripped reference
    // rather than pretending the difference is a defect.
    expect(first.bands.points).toEqual(JSON.parse(JSON.stringify(direct.points)));
    expect(first.bands.components).toEqual(
      JSON.parse(JSON.stringify(direct.components)),
    );
    // Guard the round-trip itself: nothing may become null, which is what
    // JSON does to NaN and Infinity.
    const flat = JSON.stringify(first.bands);
    expect(flat).not.toContain('null');
  });

  it('isolates a failing job instead of losing the whole batch', async () => {
    const events = await readEvents(
      await POST(
        post({
          jobs: [
            { id: 'boom', input: { ...input, seed: EXPLODING_SEED } },
            { id: 'ok', input },
          ],
        }),
      ),
    );
    // The bad one reports itself and the good one still arrives; the batch
    // finishes cleanly, counting only what actually succeeded.
    expect(events[0]).toMatchObject({ type: 'error', id: 'boom' });
    expect(events[1]).toMatchObject({ type: 'result', id: 'ok' });
    expect(events[2]).toEqual({ type: 'done', completed: 1 });
    // The message must not leak the internal failure to the browser.
    const failure = events[0] as { message: string };
    expect(failure.message).not.toContain('exploded');
  });
});
