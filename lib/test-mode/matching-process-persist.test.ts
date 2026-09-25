import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyHedgeBook, type HedgeTicket } from '@/lib/test-mode/hedge-var';
import { seedSandbox } from '@/lib/test-mode/store';
import type { TestSandboxState } from '@/lib/test-mode/types';
import type {
  ExecutionBeatEvent,
  ExecutionOrderEvent,
} from '@/lib/test-mode/execution-monitor';

const loadSandboxProgress = vi.fn();
const saveSandboxProgress = vi.fn();

vi.mock('@/lib/test-mode/sandbox-service', () => ({
  loadSandboxProgress: (...args: unknown[]) => loadSandboxProgress(...args),
  saveSandboxProgress: (...args: unknown[]) => saveSandboxProgress(...args),
}));

// The model getters hand back whichever fake a case installs (null = no
// database configured, the default every other case runs under).
const models: { executionLog: unknown; orderExecution: unknown } = {
  executionLog: null,
  orderExecution: null,
};
vi.mock('@/lib/db/models/execution-log', () => ({
  getExecutionLogModel: async () => models.executionLog,
}));
vi.mock('@/lib/db/models/matching-process-state', () => ({
  getMatchingProcessStateModel: vi.fn(),
}));
vi.mock('@/lib/db/models/order-execution', () => ({
  getOrderExecutionModel: async () => models.orderExecution,
}));
vi.mock('@/lib/db/models/sandbox-progress', () => ({ getSandboxProgressModel: vi.fn() }));
vi.mock('@/lib/s3', async importOriginal => ({
  // The real key-segment encoder: the keys under test must be the keys the
  // route and the matcher actually build.
  s3OwnerSegment: (await importOriginal<typeof import('@/lib/s3')>()).s3OwnerSegment,
  getS3ObjectText: vi.fn(),
  putS3Object: vi.fn(),
}));
vi.mock('@/lib/db/models/leg-tape-tick', () => ({ getLegTapeTickModel: vi.fn() }));

const {
  persistFillToSandbox,
  persistExecutionJournalEvents,
  persistLegTapeTicks,
  loadLegTapeTicks,
  executionStore,
  loadExecutedOrderDetail,
  persistOrderExecution,
  persistExecutionLogRows,
} = await import('@/lib/test-mode/matching-process-persist');
const { getLegTapeTickModel } = await import('@/lib/db/models/leg-tape-tick');
const { getS3ObjectText, putS3Object } = await import('@/lib/s3');

function rest(id: string): HedgeTicket {
  return {
    id,
    ccy: 'EUR',
    instrument: 'forward',
    basis: 'stock',
    amountLocalM: 2.55,
    maturity: '1m',
    maturityLabel: '1M',
    varUsdM: 0.1,
    addressesHigherVar: false,
    status: 'scheduled',
    limitRate: 1.17,
  };
}

function bookWith(ticket: HedgeTicket): TestSandboxState {
  return {
    ...seedSandbox('workspace'),
    hedgesByEntityId: {
      ent_1: { ...emptyHedgeBook(), bookedHedges: [ticket] },
    },
  };
}

describe('persistFillToSandbox', () => {
  beforeEach(() => {
    loadSandboxProgress.mockReset();
    saveSandboxProgress.mockReset();
  });

  it('writes a fill onto the same sandbox task_id the matcher owns', async () => {
    const scheduled = rest('eur-1');
    const filled: HedgeTicket = {
      ...scheduled,
      status: 'booked',
      filledAtMs: 1_700_000_000_000,
    };
    loadSandboxProgress.mockResolvedValue({
      state: bookWith(scheduled),
      version: 1,
      updatedAt: new Date(0).toISOString(),
      source: 'database',
      storageEnv: 'uat',
    });
    saveSandboxProgress.mockImplementation(async (_email, state) => ({
      state,
      version: 1,
      updatedAt: new Date().toISOString(),
      source: 'database',
      storageEnv: 'uat',
    }));

    await persistFillToSandbox({
      userEmail: 'desk@sigma.local',
      taskId: 'workspace',
      orderId: 'eur-1',
      cancelledOrderIds: [],
      outcome: 'filled',
      ticket: filled,
    });

    expect(loadSandboxProgress).toHaveBeenCalledWith('desk@sigma.local', 'workspace');
    expect(saveSandboxProgress).toHaveBeenCalledTimes(1);
    const saved = saveSandboxProgress.mock.calls[0][1] as TestSandboxState;
    expect(saved.hedgesByEntityId?.ent_1?.bookedHedges).toEqual([
      expect.objectContaining({ id: 'eur-1', status: 'booked', filledAtMs: 1_700_000_000_000 }),
    ]);
  });

  it('does not insert a fill into a different sandbox row that never had the ticket', async () => {
    loadSandboxProgress.mockResolvedValue({
      state: seedSandbox('02'),
      version: 1,
      updatedAt: new Date(0).toISOString(),
      source: 'database',
      storageEnv: 'uat',
    });

    await persistFillToSandbox({
      userEmail: 'desk@sigma.local',
      taskId: '02',
      orderId: 'eur-1',
      cancelledOrderIds: [],
      outcome: 'filled',
      ticket: { ...rest('eur-1'), status: 'booked', filledAtMs: 1 },
    });

    expect(saveSandboxProgress).not.toHaveBeenCalled();
  });

  it('keeps the cancelled OCO sibling on the book as cancelled', async () => {
    const sl = { ...rest('sl-1'), ocoGroupId: 'oco-1', bracketRole: 'stopLoss' as const };
    const tp = { ...rest('tp-1'), ocoGroupId: 'oco-1', bracketRole: 'takeProfit' as const };
    const filled = {
      ...sl,
      status: 'booked' as const,
      filledAtMs: 1_700_000_000_000,
    };
    loadSandboxProgress.mockResolvedValue({
      state: {
        ...seedSandbox('workspace'),
        hedgesByEntityId: {
          ent_1: { ...emptyHedgeBook(), bookedHedges: [sl, tp] },
        },
      },
      version: 1,
      updatedAt: new Date(0).toISOString(),
      source: 'database',
      storageEnv: 'uat',
    });
    saveSandboxProgress.mockImplementation(async (_email, state) => ({
      state,
      version: 1,
      updatedAt: new Date().toISOString(),
      source: 'database',
      storageEnv: 'uat',
    }));

    await persistFillToSandbox({
      userEmail: 'desk@sigma.local',
      taskId: 'workspace',
      orderId: 'sl-1',
      cancelledOrderIds: ['tp-1'],
      outcome: 'filled',
      ticket: filled,
    });

    const saved = saveSandboxProgress.mock.calls[0][1] as TestSandboxState;
    const book = saved.hedgesByEntityId?.ent_1?.bookedHedges ?? [];
    expect(book).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sl-1', status: 'booked' }),
        expect.objectContaining({ id: 'tp-1', status: 'cancelled' }),
      ]),
    );
  });
});

describe('persistExecutionJournalEvents', () => {
  beforeEach(() => {
    vi.mocked(getS3ObjectText).mockReset();
    vi.mocked(putS3Object).mockReset();
  });

  it('writes to S3 in dev too — the server matcher is the one recording the tape', async () => {
    // This used to no-op outside NODE_ENV=production, on the assumption the
    // browser's own PUT to /api/execution-journal was the only writer. It
    // is not: the server matcher fills orders on its own tape, independent
    // of whether any browser tab is open, and that tape must reach S3 for
    // a fill to ever be verified against it.
    expect(process.env.NODE_ENV).not.toBe('production');
    vi.mocked(getS3ObjectText).mockRejectedValue(
      Object.assign(new Error('not found'), { name: 'NoSuchKey' }),
    );
    await persistExecutionJournalEvents({
      userEmail: 'desk@sigma.local',
      taskId: 'workspace',
      events: [],
    });
    expect(putS3Object).toHaveBeenCalledTimes(1);
  });

  it('skips the write when the stored journal cannot be read, instead of replacing it with one beat', async () => {
    // The matcher is the only writer of this object: a write after a failed
    // read would erase every stored event and tape point for good.
    vi.mocked(getS3ObjectText).mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), { name: 'ServiceUnavailable' }),
    );
    await expect(
      persistExecutionJournalEvents({
        userEmail: 'desk@example.com',
        taskId: 'workspace',
        events: [],
        tapeByCcy: {
          'EUR|spot': [{ bid: 1.1, ask: 1.1002, mid: 1.1001, t: 2_000 }],
        },
      }),
    ).rejects.toThrow('Service Unavailable');
    expect(putS3Object).not.toHaveBeenCalled();
  });

  it('merges new tape points onto the prior journal instead of overwriting it', async () => {
    vi.mocked(getS3ObjectText).mockResolvedValue(
      JSON.stringify({
        events: [],
        tapeByCcy: {
          'EUR|forward|t1.00': [{ bid: 1.1, ask: 1.1002, mid: 1.1001, t: 1_000 }],
        },
      }),
    );
    await persistExecutionJournalEvents({
      userEmail: 'desk@sigma.local',
      taskId: 'workspace',
      events: [],
      tapeByCcy: {
        'EUR|forward|t1.00': [{ bid: 1.101, ask: 1.1012, mid: 1.1011, t: 2_000 }],
      },
    });
    const call = vi.mocked(putS3Object).mock.calls[0]![0];
    const body = JSON.parse(call.body as string) as {
      tapeByCcy: Record<string, { t: number }[]>;
    };
    expect(body.tapeByCcy['EUR|forward|t1.00']!.map(p => p.t)).toEqual([1_000, 2_000]);
  });

  it('does not duplicate a point already recorded at the same instant', async () => {
    vi.mocked(getS3ObjectText).mockResolvedValue(
      JSON.stringify({
        events: [],
        tapeByCcy: {
          'EUR|forward|t1.00': [{ bid: 1.1, ask: 1.1002, mid: 1.1001, t: 1_000 }],
        },
      }),
    );
    await persistExecutionJournalEvents({
      userEmail: 'desk@sigma.local',
      taskId: 'workspace',
      events: [],
      tapeByCcy: {
        'EUR|forward|t1.00': [{ bid: 1.1, ask: 1.1002, mid: 1.1001, t: 1_000 }],
      },
    });
    const call = vi.mocked(putS3Object).mock.calls[0]![0];
    const body = JSON.parse(call.body as string) as {
      tapeByCcy: Record<string, { t: number }[]>;
    };
    expect(body.tapeByCcy['EUR|forward|t1.00']).toHaveLength(1);
  });

  it('caps a leg tape at 1800 points, keeping the most recent', async () => {
    const prior = Array.from({ length: 1_800 }, (_, i) => ({
      bid: 1.1,
      ask: 1.1002,
      mid: 1.1001,
      t: i,
    }));
    vi.mocked(getS3ObjectText).mockResolvedValue(
      JSON.stringify({ events: [], tapeByCcy: { 'EUR|forward|t1.00': prior } }),
    );
    await persistExecutionJournalEvents({
      userEmail: 'desk@sigma.local',
      taskId: 'workspace',
      events: [],
      tapeByCcy: {
        'EUR|forward|t1.00': [{ bid: 1.1, ask: 1.1002, mid: 1.1001, t: 9_999 }],
      },
    });
    const call = vi.mocked(putS3Object).mock.calls[0]![0];
    const body = JSON.parse(call.body as string) as {
      tapeByCcy: Record<string, { t: number }[]>;
    };
    const tape = body.tapeByCcy['EUR|forward|t1.00']!;
    expect(tape).toHaveLength(1_800);
    expect(tape[0]!.t).toBe(1);
    expect(tape[tape.length - 1]!.t).toBe(9_999);
  });
});

describe('executionStore', () => {
  const prior = process.env.EXECUTION_STORE;
  afterEach(() => {
    if (prior === undefined) delete process.env.EXECUTION_STORE;
    else process.env.EXECUTION_STORE = prior;
  });

  it('defaults to s3 so the cluster keeps writing the journal', () => {
    delete process.env.EXECUTION_STORE;
    expect(executionStore()).toBe('s3');
    process.env.EXECUTION_STORE = 'S3';
    expect(executionStore()).toBe('s3');
  });

  it('selects postgres for a local checkout, case- and space-insensitively', () => {
    process.env.EXECUTION_STORE = ' Postgres ';
    expect(executionStore()).toBe('postgres');
  });

  it('falls back to s3 for an unrecognised value instead of guessing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EXECUTION_STORE = 'dynamo';
    expect(executionStore()).toBe('s3');
    warn.mockRestore();
  });
});

describe('one store per write', () => {
  const prior = process.env.EXECUTION_STORE;
  beforeEach(() => {
    vi.mocked(getS3ObjectText).mockReset();
    vi.mocked(putS3Object).mockReset();
    vi.mocked(getLegTapeTickModel).mockReset();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.EXECUTION_STORE;
    else process.env.EXECUTION_STORE = prior;
    vi.mocked(getLegTapeTickModel).mockReset();
  });

  it('does not touch Postgres for the tape while S3 is the store', async () => {
    process.env.EXECUTION_STORE = 's3';
    await persistLegTapeTicks({
      userEmail: 'desk@deel.com',
      taskId: '02',
      points: [{ quoteKey: 'EUR|spot', bid: 1.1, ask: 1.2, mid: 1.15, t: 5 }],
    });
    // The model getter opens a connection — it must not even be reached.
    expect(getLegTapeTickModel).not.toHaveBeenCalled();
  });

  it('reads the tape back out of the journal when S3 is the store', async () => {
    process.env.EXECUTION_STORE = 's3';
    vi.mocked(getS3ObjectText).mockResolvedValue(
      JSON.stringify({
        tapeByCcy: {
          'EUR|spot': [
            { t: 100, bid: 1.0, ask: 1.2, mid: 1.1 },
            { t: 200, bid: 1.1, ask: 1.3, mid: 1.2 },
            { t: 300, bid: 1.2, ask: 1.4, mid: 1.3 },
          ],
          'GBP|spot': [{ t: 150, bid: 1.3, ask: 1.5, mid: 1.4 }],
        },
      }),
    );
    const rows = await loadLegTapeTicks('desk@deel.com', '02', 'EUR|spot', 4000, {
      fromMs: 150,
      toMs: 300,
    });
    expect(rows.map(r => r.t)).toEqual([200, 300]);
    expect(rows[0]).toMatchObject({ quoteKey: 'EUR|spot', mid: 1.2 });
    expect(getLegTapeTickModel).not.toHaveBeenCalled();
  });

  it('does not touch S3 for the journal while Postgres is the store', async () => {
    process.env.EXECUTION_STORE = 'postgres';
    await persistExecutionJournalEvents({
      userEmail: 'desk@deel.com',
      taskId: '02',
      events: [],
      tapeByCcy: { 'EUR|spot': [{ t: 1, bid: 1.0, ask: 1.2, mid: 1.1 }] },
    });
    expect(putS3Object).not.toHaveBeenCalled();
    expect(getS3ObjectText).not.toHaveBeenCalled();
  });

  it('answers empty rather than throwing when the journal is unreachable', async () => {
    process.env.EXECUTION_STORE = 's3';
    vi.mocked(getS3ObjectText).mockRejectedValue(new Error('no credentials'));
    await expect(
      loadLegTapeTicks('desk@deel.com', '02', 'EUR|spot', 4000),
    ).resolves.toEqual([]);
  });
});

describe('executions are stored and read back per owning desk', () => {
  afterEach(() => {
    models.executionLog = null;
    models.orderExecution = null;
  });

  it('reads an executed order back only from the requesting desk\'s own rows', async () => {
    const findAll = vi.fn(async (_options: unknown) => [
      { orderId: 'eur-1', executedAt: 1_000, price: '1.17', fill: 'bid', ticket: null },
    ]);
    models.orderExecution = { findAll };

    const detail = await loadExecutedOrderDetail('Desk@Example.com', 'workspace', 'eur-1');

    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'eur-1', userEmail: 'desk@example.com' } }),
    );
    expect(detail?.executions).toEqual([{ executedAt: 1_000, price: 1.17, fill: 'bid' }]);
  });

  it('answers null when the requesting desk has no execution of that order', async () => {
    models.orderExecution = { findAll: vi.fn(async (_options: unknown) => []) };
    await expect(
      loadExecutedOrderDetail('other@example.com', 'workspace', 'eur-1'),
    ).resolves.toBeNull();
  });

  it('stamps a persisted execution with its owner, lowercased, as part of its identity', async () => {
    const findOrCreate = vi.fn(async (_options: unknown) => [{ ticket: null }, true]);
    models.orderExecution = { findOrCreate };

    await persistOrderExecution('Desk@Example.com', 'eur-1', 1_000, 1.17, 'bid');

    expect(findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'eur-1', executedAt: 1_000, userEmail: 'desk@example.com' },
      }),
    );
  });

  it('writes each monitor row with the owner its entry carries, null for a process beat', async () => {
    const bulkCreate = vi.fn(async (_rows: unknown) => []);
    models.executionLog = { bulkCreate };
    const order: ExecutionOrderEvent = {
      kind: 'order',
      atMs: 10,
      orderId: 'eur-1',
      ccy: 'EUR',
      outcome: 'filled',
      basis: 'stock',
      instrument: 'forward',
      maturityLabel: '1M',
      orderSide: 'Sell',
      hitSide: 'bid',
      bracketRole: null,
      ocoGroupId: null,
      limitRate: 1.17,
      marketBid: 1.18,
      marketAsk: 1.1802,
      marketMid: 1.1801,
      triggerPx: 1.18,
      filledPx: 1.18,
      distancePips: 0,
      amountLocalM: 1,
      notionalUsdM: 1.18,
      committedUsdM: 0,
      policyCapUsdM: 10,
      autoFillAllowed: true,
      quoteConvention: 'usd-per-fcy',
      reason: 'crossed',
      summary: 'EUR FILLED eur-1',
    };
    const beat: ExecutionBeatEvent = {
      kind: 'beat',
      atMs: 11,
      elapsedMs: 2,
      ccyCount: 1,
      working: 0,
      triggered: 1,
      filled: 1,
      blocked: 0,
      summary: '[node] BEAT',
    };

    await persistExecutionLogRows([
      { ownerEmail: 'desk@example.com', event: order },
      { ownerEmail: null, event: beat },
    ]);

    expect(bulkCreate).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'order', orderId: 'eur-1', userEmail: 'desk@example.com' }),
      expect.objectContaining({ kind: 'beat', userEmail: null }),
    ]);
  });
});
