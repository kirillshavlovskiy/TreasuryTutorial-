import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ExecutedOrderDetail } from '@/lib/test-mode/matching-process-persist';

const session: { email: string | null } = { email: 'desk@example.com' };
vi.mock('@/auth', () => ({
  auth: async () => (session.email ? { user: { email: session.email } } : null),
}));

type ExecutionWhere = { orderId: unknown; executedAt: unknown; userEmail: unknown };
type FindOrCreateOptions = {
  where: ExecutionWhere;
  defaults: { price: unknown; fill: unknown };
};

// An in-memory order_executions table with Sequelize's findOrCreate
// semantics: a row matches only when EVERY where-field matches, so a retry
// with the same (orderId, executedAt) from the same desk finds the row it
// wrote, and anything else creates a new one.
const rows: { id: number; where: ExecutionWhere }[] = [];
const findOrCreate = vi.fn(
  async (options: FindOrCreateOptions): Promise<[{ id: number }, boolean]> => {
    const existing = rows.find(
      r =>
        r.where.orderId === options.where.orderId
        && r.where.executedAt === options.where.executedAt
        && r.where.userEmail === options.where.userEmail,
    );
    if (existing) return [{ id: existing.id }, false];
    const row = { id: rows.length + 1, where: options.where };
    rows.push(row);
    return [{ id: row.id }, true];
  },
);
const model: { available: boolean } = { available: true };
vi.mock('@/lib/db/models/order-execution', () => ({
  getOrderExecutionModel: async () => (model.available ? { findOrCreate } : null),
}));

const loadExecutedOrderDetail = vi.fn(
  async (
    _userEmail: string,
    _taskId: string,
    _orderId: string,
  ): Promise<ExecutedOrderDetail | null> => null,
);
vi.mock('@/lib/test-mode/matching-process-persist', () => ({
  loadExecutedOrderDetail: (userEmail: string, taskId: string, orderId: string) =>
    loadExecutedOrderDetail(userEmail, taskId, orderId),
}));

const { GET, POST } = await import('@/app/api/order-execution/route');

const DETAIL: ExecutedOrderDetail = {
  orderId: 'ord-1',
  executions: [{ executedAt: 1_700_000_000_000, price: 1.17, fill: 'bid' }],
  ticket: null,
  tapeKey: null,
  tape: [],
  window: null,
};

function get(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/order-execution?${query}`);
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/order-execution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const FILL = { orderId: 'ord-1', executedAt: 1_700_000_000_000, price: 1.17, fill: 'bid' };

beforeEach(() => {
  session.email = 'desk@example.com';
  model.available = true;
  rows.length = 0;
  findOrCreate.mockClear();
  loadExecutedOrderDetail.mockReset();
  loadExecutedOrderDetail.mockResolvedValue(null);
});

describe('GET /api/order-execution', () => {
  it('refuses an unauthenticated caller before reading anything', async () => {
    session.email = null;
    const res = await GET(get('orderId=ord-1'));
    expect(res.status).toBe(401);
    expect(loadExecutedOrderDetail).not.toHaveBeenCalled();
  });

  it('rejects a request with no orderId', async () => {
    const res = await GET(get(''));
    expect(res.status).toBe(400);
    expect(loadExecutedOrderDetail).not.toHaveBeenCalled();
  });

  it('reads the execution for the signed-in desk, trimmed and lower-cased', async () => {
    session.email = '  Desk@Example.COM ';
    loadExecutedOrderDetail.mockResolvedValueOnce(DETAIL);
    const res = await GET(get('orderId=ord-1&taskId=02'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DETAIL);
    expect(loadExecutedOrderDetail).toHaveBeenCalledWith('desk@example.com', '02', 'ord-1');
  });

  it('falls back to the workspace task for a malformed taskId', async () => {
    await GET(get('orderId=ord-1&taskId=../other'));
    expect(loadExecutedOrderDetail).toHaveBeenCalledWith('desk@example.com', 'workspace', 'ord-1');
  });

  it('answers 404 when the desk has no execution recorded for that order', async () => {
    const res = await GET(get('orderId=someone-elses-order'));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/order-execution', () => {
  it('refuses an unauthenticated caller without writing', async () => {
    session.email = null;
    const res = await POST(post(FILL));
    expect(res.status).toBe(401);
    expect(findOrCreate).not.toHaveBeenCalled();
  });

  it('stamps the owner from the session email, trimmed and lower-cased', async () => {
    session.email = '  Desk@Example.COM ';
    const res = await POST(post(FILL));
    expect(res.status).toBe(200);
    expect(findOrCreate).toHaveBeenCalledWith({
      where: {
        orderId: 'ord-1',
        executedAt: 1_700_000_000_000,
        userEmail: 'desk@example.com',
      },
      defaults: { price: 1.17, fill: 'bid' },
    });
  });

  it('ignores an owner field in the body — a caller cannot write as another desk', async () => {
    await POST(post({ ...FILL, userEmail: 'other@example.com' }));
    expect(findOrCreate).toHaveBeenCalledTimes(1);
    expect(findOrCreate.mock.calls[0]?.[0].where.userEmail).toBe('desk@example.com');
  });

  it('returns the same execution, not a second one, when a desk retries the same fill', async () => {
    const first = await (await POST(post(FILL))).json();
    const retry = await (await POST(post(FILL))).json();
    expect(first).toEqual({ success: true, executionId: 1, created: true });
    expect(retry).toEqual({ success: true, executionId: 1, created: false });
    expect(rows).toHaveLength(1);
  });

  it('keeps a second desk\'s fill with the same orderId and time apart from the first', async () => {
    const alice = await (await POST(post(FILL))).json();
    session.email = 'bob@example.com';
    const bob = await (await POST(post(FILL))).json();
    expect(alice.created).toBe(true);
    expect(bob.created).toBe(true);
    expect(bob.executionId).not.toBe(alice.executionId);
  });

  it.each([
    ['orderId', { executedAt: FILL.executedAt, price: FILL.price, fill: FILL.fill }],
    ['executedAt', { orderId: FILL.orderId, price: FILL.price, fill: FILL.fill }],
    ['price', { orderId: FILL.orderId, executedAt: FILL.executedAt, fill: FILL.fill }],
    ['fill', { orderId: FILL.orderId, executedAt: FILL.executedAt, price: FILL.price }],
  ])('rejects a body missing %s without writing', async (_field, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(findOrCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-number executedAt or price without writing', async () => {
    expect((await POST(post({ ...FILL, executedAt: '1700000000000' }))).status).toBe(400);
    expect((await POST(post({ ...FILL, price: '1.17' }))).status).toBe(400);
    expect(findOrCreate).not.toHaveBeenCalled();
  });

  it('rejects a fill side other than bid or ask without writing', async () => {
    const res = await POST(post({ ...FILL, fill: 'mid' }));
    expect(res.status).toBe(400);
    expect(findOrCreate).not.toHaveBeenCalled();
  });

  it('answers 503 when no database is configured', async () => {
    model.available = false;
    const res = await POST(post(FILL));
    expect(res.status).toBe(503);
  });
});
