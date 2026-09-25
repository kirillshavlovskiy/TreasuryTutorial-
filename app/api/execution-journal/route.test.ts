import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';
import type {
  ExecutionBeatEvent,
  ExecutionOrderEvent,
} from '@/lib/test-mode/execution-monitor';

const session: { email: string | null } = { email: 'desk@example.com' };
vi.mock('@/auth', () => ({
  auth: async () => (session.email ? { user: { email: session.email } } : null),
}));

// An in-memory bucket keyed by relative key. A missing key throws the same
// `NoSuchKey` the S3 client does; a key in `brokenKeys` throws anything else.
const bucket = new Map<string, string>();
const brokenKeys = new Set<string>();
const putKeys: string[] = [];
vi.mock('@/lib/s3', async importOriginal => ({
  // The real key-segment encoder: the keys under test must be the keys the
  // route and the matcher actually build.
  s3OwnerSegment: (await importOriginal<typeof import('@/lib/s3')>()).s3OwnerSegment,
  getS3ObjectText: async (key: string): Promise<string> => {
    if (brokenKeys.has(key)) throw new Error('AccessDenied');
    const text = bucket.get(key);
    if (text === undefined) {
      const err = new Error('The specified key does not exist.');
      err.name = 'NoSuchKey';
      throw err;
    }
    return text;
  },
  putS3Object: async (input: { relativeKey: string; body: string }) => {
    putKeys.push(input.relativeKey);
    bucket.set(input.relativeKey, input.body);
    return { key: input.relativeKey, bucket: 'test-bucket' };
  },
}));

const { GET, PUT } = await import('@/app/api/execution-journal/route');

const MATCHER_KEY = 'execution-journal/desk@example.com/workspace.json';
const DESK_KEY = 'execution-journal/desk@example.com/workspace.desk.json';
const BELL_KEY = 'execution-journal/desk@example.com/workspace.notifications.json';

type TapePoint = { t: number; bid: number; ask: number; mid: number };
type JournalBody = {
  events: { kind: string; atMs: number; orderId?: string }[];
  tapeByCcy: Record<string, TapePoint[]>;
  notifications?: unknown;
  parts: { desk: boolean; notifications: boolean };
};

function orderEvent(
  orderId: string,
  atMs: number,
  outcome: ExecutionOrderEvent['outcome'] = 'working',
): ExecutionOrderEvent {
  return {
    kind: 'order',
    atMs,
    orderId,
    ccy: 'EUR',
    outcome,
    basis: 'stock',
    instrument: 'forward',
    maturityLabel: '1M',
    orderSide: 'Sell',
    hitSide: 'bid',
    bracketRole: null,
    ocoGroupId: null,
    limitRate: 1.17,
    marketBid: 1.16,
    marketAsk: 1.1602,
    marketMid: 1.1601,
    triggerPx: null,
    filledPx: outcome === 'filled' ? 1.17 : null,
    distancePips: 99,
    amountLocalM: 1,
    notionalUsdM: 1.17,
    committedUsdM: 0,
    policyCapUsdM: 10,
    autoFillAllowed: true,
    quoteConvention: 'usd-per-fcy',
    reason: 'resting',
    summary: `EUR ${outcome.toUpperCase()} ${orderId} sell 1.00M limit 1.17000`,
  };
}

function beatEvent(atMs: number): ExecutionBeatEvent {
  return {
    kind: 'beat',
    atMs,
    elapsedMs: 3,
    ccyCount: 1,
    working: 1,
    triggered: 1,
    filled: 1,
    blocked: 0,
    summary: `[node] BEAT at ${atMs}`,
  };
}

function point(t: number, mid: number): TapePoint {
  return { t, bid: mid - 0.0001, ask: mid + 0.0001, mid };
}

function store(key: string, value: unknown) {
  bucket.set(key, JSON.stringify(value));
}

function stored(key: string): unknown {
  const text = bucket.get(key);
  return text === undefined ? undefined : JSON.parse(text);
}

function get(taskId: string | null = 'workspace'): NextRequest {
  const query = taskId === null ? '' : `?taskId=${encodeURIComponent(taskId)}`;
  return new NextRequest(`http://localhost/api/execution-journal${query}`);
}

function put(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/execution-journal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function journalOf(res: Response): Promise<JournalBody> {
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  session.email = 'desk@example.com';
  bucket.clear();
  brokenKeys.clear();
  putKeys.length = 0;
});

describe('GET /api/execution-journal', () => {
  it('refuses an unauthenticated caller', async () => {
    session.email = null;
    expect((await GET(get())).status).toBe(401);
  });

  it('refuses the shared guest account, which owns no journal', async () => {
    session.email = TEST_GUEST_EMAIL;
    expect((await GET(get())).status).toBe(401);
  });

  it('rejects a missing or malformed task id', async () => {
    expect((await GET(get(null))).status).toBe(400);
    expect((await GET(get('../other'))).status).toBe(400);
    expect((await GET(get('x'.repeat(33)))).status).toBe(400);
  });

  it('answers an empty journal, with no browser parts, when nothing is stored yet', async () => {
    const journal = await journalOf(await GET(get()));
    expect(journal.events).toEqual([]);
    expect(journal.tapeByCcy).toEqual({});
    expect(journal.notifications).toBeUndefined();
    expect(journal.parts).toEqual({ desk: false, notifications: false });
  });

  it('merges the desk feed and the matcher\'s events newest first, one line per fill', async () => {
    store(DESK_KEY, {
      events: [orderEvent('fill-1', 300, 'filled'), beatEvent(100)],
      tapeByCcy: {},
    });
    store(MATCHER_KEY, {
      events: [orderEvent('work-2', 200), orderEvent('fill-1', 300, 'filled')],
      tapeByCcy: {},
    });
    const journal = await journalOf(await GET(get()));
    expect(journal.events.map(e => [e.kind, e.atMs])).toEqual([
      ['order', 300],
      ['order', 200],
      ['beat', 100],
    ]);
  });

  it('caps the merged feed at the 500 newest events', async () => {
    store(DESK_KEY, {
      events: Array.from({ length: 300 }, (_, i) => orderEvent(`d-${i}`, i * 2)),
    });
    store(MATCHER_KEY, {
      events: Array.from({ length: 300 }, (_, i) => orderEvent(`m-${i}`, i * 2 + 1)),
    });
    const journal = await journalOf(await GET(get()));
    expect(journal.events).toHaveLength(500);
    // 600 events at atMs 0..599; the newest 500 are 599 down to 100.
    expect(journal.events[0]?.atMs).toBe(599);
    expect(journal.events[499]?.atMs).toBe(100);
  });

  it('serves the matcher\'s recorded series for a key it has, never interleaved with the desk\'s walk', async () => {
    // The desk walked its own EUR series (t=1, 2) while it thought the matcher
    // was down; the matcher recorded EUR at t=2, 3. Fills were decided against
    // the matcher's series, so that is the only EUR tape the chart may show.
    store(DESK_KEY, {
      events: [],
      tapeByCcy: {
        'EUR|spot': [point(1, 1.1), point(2, 1.11)],
        'GBP|spot': [point(5, 1.3)],
      },
    });
    store(MATCHER_KEY, {
      events: [],
      tapeByCcy: { 'EUR|spot': [point(2, 1.12), point(3, 1.13)] },
    });
    const journal = await journalOf(await GET(get()));
    expect(journal.tapeByCcy['EUR|spot']?.map(p => [p.t, p.mid])).toEqual([
      [2, 1.12],
      [3, 1.13],
    ]);
    // A key only the desk recorded is still served from the desk.
    expect(journal.tapeByCcy['GBP|spot']?.map(p => p.t)).toEqual([5]);
  });

  it('drops the upper-cased keys the pre-split PUT wrote, which no chart reads', async () => {
    store(MATCHER_KEY, {
      events: [],
      tapeByCcy: {
        'EUR|SPOT': [point(1, 1.1)],
        'EUR|FORWARD|T1.00': [point(1, 1.12)],
        'EUR|spot': [point(2, 1.11)],
      },
    });
    const journal = await journalOf(await GET(get()));
    expect(Object.keys(journal.tapeByCcy)).toEqual(['EUR|spot']);
  });

  it('serves the bell\'s own notifications ahead of a legacy copy in the matcher object', async () => {
    store(MATCHER_KEY, { events: [], notifications: { readIds: ['old'] } });
    store(BELL_KEY, { notifications: { readIds: ['new'] } });
    const journal = await journalOf(await GET(get()));
    expect(journal.notifications).toEqual({ readIds: ['new'] });
  });

  it('falls back to the notifications a pre-split journal kept in the matcher object', async () => {
    store(MATCHER_KEY, { events: [], notifications: { readIds: ['old'] } });
    const journal = await journalOf(await GET(get()));
    expect(journal.notifications).toEqual({ readIds: ['old'] });
    expect(journal.parts).toEqual({ desk: false, notifications: false });
  });

  it('reports each browser-owned part the server holds', async () => {
    store(DESK_KEY, { events: [], tapeByCcy: {} });
    expect((await journalOf(await GET(get()))).parts).toEqual({
      desk: true,
      notifications: false,
    });
    store(BELL_KEY, { notifications: {} });
    expect((await journalOf(await GET(get()))).parts).toEqual({
      desk: true,
      notifications: true,
    });
  });

  it('fails with 500 when a part cannot be read for a reason other than being missing', async () => {
    store(MATCHER_KEY, { events: [orderEvent('m-1', 1)] });
    brokenKeys.add(DESK_KEY);
    const res = await GET(get());
    expect(res.status).toBe(500);
  });

  it('never serves one desk\'s journal to another desk', async () => {
    store(DESK_KEY, { events: [orderEvent('mine', 1)], tapeByCcy: { 'EUR|spot': [point(1, 1.1)] } });
    store(BELL_KEY, { notifications: { readIds: ['mine'] } });
    session.email = 'other@example.com';
    const journal = await journalOf(await GET(get()));
    expect(journal.events).toEqual([]);
    expect(journal.tapeByCcy).toEqual({});
    expect(journal.notifications).toBeUndefined();
  });
});

describe('PUT /api/execution-journal', () => {
  it('refuses an unauthenticated caller and the shared guest, writing nothing', async () => {
    session.email = null;
    expect((await PUT(put({ taskId: 'workspace', events: [] }))).status).toBe(401);
    session.email = TEST_GUEST_EMAIL;
    expect((await PUT(put({ taskId: 'workspace', events: [] }))).status).toBe(401);
    expect(putKeys).toEqual([]);
  });

  it('rejects a missing or malformed task id', async () => {
    expect((await PUT(put({ events: [] }))).status).toBe(400);
    expect((await PUT(put({ taskId: '../x', events: [] }))).status).toBe(400);
    expect((await PUT(put({ taskId: 7, events: [] }))).status).toBe(400);
    expect(putKeys).toEqual([]);
  });

  it('rejects a body that is not JSON or not an object', async () => {
    expect((await PUT(put('{not json'))).status).toBe(400);
    expect((await PUT(put([1, 2]))).status).toBe(400);
    expect(putKeys).toEqual([]);
  });

  it('rejects a body that carries nothing to save', async () => {
    expect((await PUT(put({ taskId: 'workspace' }))).status).toBe(400);
    expect(putKeys).toEqual([]);
  });

  it('refuses a body larger than any desk save, writing nothing', async () => {
    // 64 MiB of characters plus the JSON around them.
    const huge = JSON.stringify({ taskId: 'workspace', notifications: { pad: 'x'.repeat(64 * 1024 * 1024) } });
    const res = await PUT(put(huge));
    expect(res.status).toBe(413);
    expect(putKeys).toEqual([]);
  });

  it('rejects parts of the wrong shape', async () => {
    expect((await PUT(put({ taskId: 'workspace', events: {} }))).status).toBe(400);
    expect((await PUT(put({ taskId: 'workspace', tapeByCcy: [] }))).status).toBe(400);
    expect((await PUT(put({ taskId: 'workspace', notifications: 'x' }))).status).toBe(400);
    expect((await PUT(put({ taskId: 'workspace', notifications: [] }))).status).toBe(400);
    expect(putKeys).toEqual([]);
  });

  it('saves events and tape into the desk object only', async () => {
    const res = await PUT(put({
      taskId: 'workspace',
      events: [orderEvent('d-1', 10)],
      tapeByCcy: { 'EUR|spot': [point(1, 1.1)] },
    }));
    expect(res.status).toBe(200);
    expect(putKeys).toEqual([DESK_KEY]);
    expect(stored(DESK_KEY)).toEqual({
      events: [orderEvent('d-1', 10)],
      tapeByCcy: { 'EUR|spot': [point(1, 1.1)] },
    });
  });

  it('saves notifications into the bell object only', async () => {
    const notifications = { readIds: ['n-1'], clearedAtMs: 5 };
    const res = await PUT(put({ taskId: 'workspace', notifications }));
    expect(res.status).toBe(200);
    expect(putKeys).toEqual([BELL_KEY]);
    expect(stored(BELL_KEY)).toEqual({ notifications });
  });

  it('never writes the matcher\'s object, even when a body carries every part', async () => {
    const matcher = { events: [orderEvent('m-1', 1)], tapeByCcy: { 'EUR|spot': [point(1, 1.1)] } };
    store(MATCHER_KEY, matcher);
    const res = await PUT(put({
      taskId: 'workspace',
      events: [],
      tapeByCcy: {},
      notifications: { readIds: [] },
    }));
    expect(res.status).toBe(200);
    expect(putKeys).not.toContain(MATCHER_KEY);
    expect(stored(MATCHER_KEY)).toEqual(matcher);
  });

  it('drops malformed tape points and events instead of storing them', async () => {
    const res = await PUT(put({
      taskId: 'workspace',
      events: [
        orderEvent('good', 10),
        beatEvent(11),
        { ...orderEvent('bad-kind', 12), kind: 'trade' },
        { kind: 'order', orderId: 'no-at', summary: 'EUR WORKING no-at' },
        { kind: 'order', orderId: 'no-summary', atMs: 13 },
        { ...beatEvent(14), atMs: '14' },
        'not an event',
        null,
      ],
      tapeByCcy: {
        'EUR|spot': [
          point(1, 1.1),
          point(2, 0),
          point(3, -1.1),
          { t: '4', bid: 1.1, ask: 1.1002, mid: 1.1001 },
          { t: 5, bid: 1.1, ask: 1.1002 },
          { t: 6, bid: 1.1, ask: 1.1002, mid: '1.1001' },
          point(7, 1.11),
        ],
        'GBP|spot': 'not a series',
      },
    }));
    expect(res.status).toBe(200);
    expect(stored(DESK_KEY)).toEqual({
      events: [orderEvent('good', 10), beatEvent(11)],
      tapeByCcy: { 'EUR|spot': [point(1, 1.1), point(7, 1.11)] },
    });
  });

  it('keeps the stored tape when a save carries only events', async () => {
    store(DESK_KEY, { events: [], tapeByCcy: { 'EUR|spot': [point(1, 1.1)] } });
    await PUT(put({ taskId: 'workspace', events: [orderEvent('d-2', 20)] }));
    expect(stored(DESK_KEY)).toEqual({
      events: [orderEvent('d-2', 20)],
      tapeByCcy: { 'EUR|spot': [point(1, 1.1)] },
    });
  });

  it('stores tape keys exactly as sent, so a reload finds them under the same key', async () => {
    await PUT(put({
      taskId: 'workspace',
      events: [],
      tapeByCcy: {
        'EUR|spot': [point(1, 1.1)],
        'EUR|forward|t0.08': [point(1, 1.1014)],
      },
    }));
    const journal = await journalOf(await GET(get()));
    expect(Object.keys(journal.tapeByCcy).sort()).toEqual(['EUR|forward|t0.08', 'EUR|spot']);
    expect(journal.parts.desk).toBe(true);
  });

  it('writes under the caller\'s own email, whatever else the body says', async () => {
    session.email = 'Other@Example.com';
    await PUT(put({ taskId: 'workspace', events: [], userEmail: 'desk@example.com' }));
    expect(putKeys).toEqual(['execution-journal/other@example.com/workspace.desk.json']);
  });
});
