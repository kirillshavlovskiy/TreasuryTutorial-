import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchExecutionJournal,
  inferWorkbenchTaskId,
  saveExecutionJournal,
  type ExecutionJournal,
} from '@/lib/test-mode/matching-process-client';
import type { ExecutionOrderEvent } from '@/lib/test-mode/execution-monitor';
import { WORKSPACE_SANDBOX_TASK_ID } from '@/lib/workspace-client';

describe('inferWorkbenchTaskId', () => {
  it('maps curriculum task routes onto the sandbox task_id', () => {
    expect(inferWorkbenchTaskId('/test/tasks/01')).toBe('01');
    expect(inferWorkbenchTaskId('/test/tasks/02?mode=curriculum')).toBe('02');
  });

  it('maps the workbench onto the workspace sandbox row, not task 02', () => {
    expect(inferWorkbenchTaskId('/workspace')).toBe(WORKSPACE_SANDBOX_TASK_ID);
    expect(inferWorkbenchTaskId('/')).toBe('workspace');
    expect(inferWorkbenchTaskId('')).toBe('workspace');
  });
});

const LEGACY_KEY = 'treasury:execution-journal:workspace';

type Call = { url: string; method: string; body: unknown };

function orderEvent(orderId: string, atMs: number): ExecutionOrderEvent {
  return {
    kind: 'order',
    atMs,
    orderId,
    ccy: 'EUR',
    outcome: 'working',
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
    filledPx: null,
    distancePips: 99,
    amountLocalM: 1,
    notionalUsdM: 1.17,
    committedUsdM: 0,
    policyCapUsdM: 10,
    autoFillAllowed: true,
    quoteConvention: 'usd-per-fcy',
    reason: 'resting',
    summary: `EUR WORKING ${orderId} sell 1.00M limit 1.17000`,
  };
}

function serverJournal(
  parts: { desk: boolean; notifications: boolean },
  events: ExecutionOrderEvent[] = [],
): ExecutionJournal {
  return { events, tapeByCcy: {}, parts };
}

const legacyJournal: ExecutionJournal = {
  events: [orderEvent('local-1', 100)],
  tapeByCcy: { 'EUR|spot': [{ t: 100, bid: 1.1, ask: 1.1002, mid: 1.1001 }] },
  notifications: { tickets: [], cancelled: [], readIds: ['n-1'], arrivedAt: {} },
};

describe('execution journal client — server only, with a one-time legacy import', () => {
  let calls: Call[];
  let serverGets: ExecutionJournal[];
  let getStatus: number;
  let putStatus: number;
  let putDelayMs: number;
  let storage: Map<string, string>;
  let localWrites: number;

  beforeEach(() => {
    calls = [];
    serverGets = [];
    getStatus = 200;
    putStatus = 200;
    putDelayMs = 0;
    storage = new Map();
    localWrites = 0;
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          localWrites += 1;
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url: input, method, body });
      if (method === 'PUT') {
        if (putDelayMs > 0) await new Promise(r => setTimeout(r, putDelayMs));
        return new Response(JSON.stringify({ ok: putStatus === 200 }), { status: putStatus });
      }
      // Each GET answers the next queued journal; the last one repeats.
      const next = serverGets.length > 1 ? serverGets.shift() : serverGets[0];
      return new Response(JSON.stringify(next ?? {}), { status: getStatus });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const puts = () => calls.filter(c => c.method === 'PUT');
  const gets = () => calls.filter(c => c.method === 'GET');

  it('loads the journal from the server in next dev, not from the browser', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    serverGets = [serverJournal({ desk: true, notifications: true }, [orderEvent('srv-1', 5)])];
    storage.set('unrelated', 'x');

    const journal = await fetchExecutionJournal('workspace');

    expect(gets().map(c => c.url)).toEqual(['/api/execution-journal?taskId=workspace']);
    expect(journal?.events.map(e => e.kind === 'order' ? e.orderId : '')).toEqual(['srv-1']);
    expect(puts()).toEqual([]);
  });

  it('answers null when the server keeps refusing or cannot be reached, after retrying', async () => {
    vi.useFakeTimers();
    try {
      getStatus = 500;
      serverGets = [serverJournal({ desk: true, notifications: true })];
      const refused = fetchExecutionJournal('workspace');
      await vi.runAllTimersAsync();
      await expect(refused).resolves.toBeNull();
      // One load, then a retry after each of the three waits.
      expect(gets()).toHaveLength(4);

      vi.stubGlobal('fetch', async () => {
        throw new TypeError('network down');
      });
      const unreachable = fetchExecutionJournal('workspace');
      await vi.runAllTimersAsync();
      await expect(unreachable).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the legacy local tape when the server journal cannot load', async () => {
    vi.useFakeTimers();
    try {
      storage.set(LEGACY_KEY, JSON.stringify(legacyJournal));
      getStatus = 500;
      const load = fetchExecutionJournal('workspace');
      await vi.runAllTimersAsync();
      await expect(load).resolves.toEqual({
        events: legacyJournal.events,
        tapeByCcy: legacyJournal.tapeByCcy,
        notifications: legacyJournal.notifications,
        parts: { desk: false, notifications: false },
        // Marked, so the desk and the bell show it but never start saving on
        // it: a save after a failed read would overwrite the stored journal.
        localFallback: true,
      });
      // Local kept so a later successful GET can still import it.
      expect(storage.get(LEGACY_KEY)).toBe(JSON.stringify(legacyJournal));
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers from a load that failed once, instead of leaving the session unsaved', async () => {
    vi.useFakeTimers();
    try {
      const served = serverJournal({ desk: true, notifications: true }, [orderEvent('srv-1', 5)]);
      let failuresLeft = 1;
      vi.stubGlobal('fetch', async (): Promise<Response> => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return new Response('{}', { status: 503 });
        }
        return new Response(JSON.stringify(served), { status: 200 });
      });
      const load = fetchExecutionJournal('workspace');
      await vi.runAllTimersAsync();
      await expect(load).resolves.toEqual(served);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a signed-out caller', async () => {
    getStatus = 401;
    await expect(fetchExecutionJournal('workspace')).resolves.toBeNull();
    expect(gets()).toHaveLength(1);
  });

  it('uploads a legacy browser journal into both parts the server lacks, drops the local copy, and serves the re-fetched journal', async () => {
    storage.set(LEGACY_KEY, JSON.stringify(legacyJournal));
    const after = serverJournal({ desk: true, notifications: true }, [orderEvent('local-1', 100)]);
    serverGets = [serverJournal({ desk: false, notifications: false }), after];

    const journal = await fetchExecutionJournal('workspace');

    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toEqual({
      taskId: 'workspace',
      events: legacyJournal.events,
      tapeByCcy: legacyJournal.tapeByCcy,
      notifications: legacyJournal.notifications,
    });
    expect(storage.has(LEGACY_KEY)).toBe(false);
    expect(gets()).toHaveLength(2);
    expect(journal).toEqual(after);
  });

  it('uploads only the desk part when the server already holds the bell\'s', async () => {
    storage.set(LEGACY_KEY, JSON.stringify(legacyJournal));
    serverGets = [serverJournal({ desk: false, notifications: true })];

    await fetchExecutionJournal('workspace');

    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toEqual({
      taskId: 'workspace',
      events: legacyJournal.events,
      tapeByCcy: legacyJournal.tapeByCcy,
    });
  });

  it('uploads only the bell\'s part when the server already holds the desk\'s', async () => {
    storage.set(LEGACY_KEY, JSON.stringify(legacyJournal));
    serverGets = [serverJournal({ desk: true, notifications: false })];

    await fetchExecutionJournal('workspace');

    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.body).toEqual({
      taskId: 'workspace',
      notifications: legacyJournal.notifications,
    });
  });

  it('uploads nothing over parts the server already has, and still drops the local copy', async () => {
    storage.set(LEGACY_KEY, JSON.stringify(legacyJournal));
    const server = serverJournal({ desk: true, notifications: true }, [orderEvent('srv-1', 5)]);
    serverGets = [server];

    const journal = await fetchExecutionJournal('workspace');

    expect(puts()).toEqual([]);
    expect(storage.has(LEGACY_KEY)).toBe(false);
    expect(journal).toEqual(server);
  });

  it('keeps the local copy and fails the load when the upload fails, so a later load can retry it', async () => {
    storage.set(LEGACY_KEY, JSON.stringify(legacyJournal));
    putStatus = 500;
    serverGets = [serverJournal({ desk: false, notifications: false })];

    const journal = await fetchExecutionJournal('workspace');

    expect(puts()).toHaveLength(1);
    expect(storage.get(LEGACY_KEY)).toBe(JSON.stringify(legacyJournal));
    // Null, not the server copy: a desk that loaded "successfully" would save
    // an empty desk part, and the next load would then skip the import.
    expect(journal).toBeNull();
  });

  it('imports once when the desk and the bell load the same task together', async () => {
    storage.set(LEGACY_KEY, JSON.stringify(legacyJournal));
    putDelayMs = 20;
    serverGets = [serverJournal({ desk: false, notifications: false })];

    await Promise.all([
      fetchExecutionJournal('workspace'),
      fetchExecutionJournal('workspace'),
    ]);

    expect(puts()).toHaveLength(1);
  });

  it('saves to the server in next dev and never writes the browser', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    const ok = await saveExecutionJournal({ events: [orderEvent('d-1', 1)] }, 'workspace');

    expect(ok).toBe(true);
    expect(puts()).toEqual([
      {
        url: '/api/execution-journal',
        method: 'PUT',
        body: { taskId: 'workspace', events: [orderEvent('d-1', 1)] },
      },
    ]);
    expect(localWrites).toBe(0);
  });

  it('reports a save the server refused as not saved', async () => {
    putStatus = 400;
    await expect(saveExecutionJournal({ events: [] }, 'workspace')).resolves.toBe(false);
  });
});
