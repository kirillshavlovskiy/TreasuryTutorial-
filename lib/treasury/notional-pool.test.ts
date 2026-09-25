import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTreasuryNotionalPoolDailyMetrics,
  getTreasuryNotionalPoolOverview,
  getTreasuryNotionalPoolRateHistory,
  getTreasuryNotionalPoolRateSnapshot,
  notionalPoolDailyMetricsSchema,
  notionalPoolOverviewSchema,
  notionalPoolRateHistorySchema,
  notionalPoolRateSnapshotSchema,
} from './notional-pool';

// See fx-order-blotter.test.ts for why withTreasuryClient is mocked directly rather than the
// token/connect chain it wraps.
vi.mock('./mcp-client', async () => {
  const actual = await vi.importActual<typeof import('./mcp-client')>('./mcp-client');
  return { ...actual, withTreasuryClient: vi.fn() };
});

import { withTreasuryClient } from './mcp-client';

const mockWithTreasuryClient = vi.mocked(withTreasuryClient);

function mockLive(data: unknown) {
  const callTool = vi.fn().mockResolvedValue(data);
  mockWithTreasuryClient.mockImplementation(async (_email, _prefix, fn) => ({ status: 'live', data: await fn({ callTool, close: vi.fn() }) }));
  return callTool;
}

const providerInterest = { citi: { interest: 100 }, jpmorgan: { interest: 200 }, total: { interest: 300 } };
const providerBalance = { citi: { balance: 1000 }, jpmorgan: { balance: 2000 }, total: { balance: 3000 } };

describe('notional_pool schemas', () => {
  it('parses a notional_pool_overview body', () => {
    const parsed = notionalPoolOverviewSchema.safeParse({
      overview: {
        interest: {
          monthToDate: { dateFrom: '2026-01-01', dateTo: '2026-01-31', data: providerInterest },
          yearToDate: { dateFrom: '2026-01-01', dateTo: '2026-01-31', data: providerInterest },
        },
        balance: {
          current: { data: providerBalance },
          monthToDateAverage: { dateFrom: '2026-01-01', dateTo: '2026-01-31', data: providerBalance },
        },
      },
      populated: { currency: { code: 'USD', symbol: '$' } },
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a notional_pool_daily_metrics body', () => {
    const parsed = notionalPoolDailyMetricsSchema.safeParse({
      records: [
        {
          date: '2026-01-01',
          npTotalUsd: 5_000_000,
          currencies: {
            USD: {
              jpmorgan: { value: 1, previousPeriodPercentageChange: 0.1 },
              citi: { value: 2, previousPeriodPercentageChange: -0.1 },
            },
          },
        },
      ],
      meta: { perPage: '20', lastId: '2026-01-01', hasMore: false, currencies: ['USD'] },
      nextCursor: null,
      populated: { currencies: { USD: { code: 'USD', symbol: '$' } } },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts meta.perPage as a number as well as a string', () => {
    const parsed = notionalPoolDailyMetricsSchema.safeParse({
      records: [],
      meta: { perPage: 20, lastId: null, hasMore: false, currencies: [] },
      nextCursor: null,
      populated: { currencies: {} },
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a notional_pool_rate_snapshot body', () => {
    const parsed = notionalPoolRateSnapshotSchema.safeParse({
      records: [
        {
          id: 'usd-jpmorgan',
          provider: 'jpmorgan',
          currency: 'USD',
          latestRate: 3.5,
          latestDate: '2026-01-01',
          percentageChange: 0,
          previousRate: null,
          previousDate: null,
        },
      ],
      total: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a notional_pool_rate_history body', () => {
    const parsed = notionalPoolRateHistorySchema.safeParse({
      ratesByDate: { '2026-01-01': { market: 3.4, jpmorgan: 3.5, citi: null } },
      meta: { currency: 'USD', fromDate: '2026-01-01', toDate: '2026-01-01', interval: 1, pointCount: 1 },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('getTreasuryNotionalPoolOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected as-is', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'not_connected' });
    const result = await getTreasuryNotionalPoolOverview('user@deel.com', 'USD');
    expect(result.status).toBe('not_connected');
    expect(result.overview).toBeNull();
  });

  it('returns reauth_required as-is', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'reauth_required' });
    const result = await getTreasuryNotionalPoolOverview('user@deel.com', 'USD');
    expect(result.status).toBe('reauth_required');
  });

  it('calls notional_pool_overview with the given currency and maps a live response', async () => {
    const callTool = mockLive({
      overview: {
        interest: {
          monthToDate: { dateFrom: '2026-01-01', dateTo: '2026-01-31', data: providerInterest },
          yearToDate: { dateFrom: '2026-01-01', dateTo: '2026-01-31', data: providerInterest },
        },
        balance: {
          current: { data: providerBalance },
          monthToDateAverage: { dateFrom: '2026-01-01', dateTo: '2026-01-31', data: providerBalance },
        },
      },
      populated: { currency: { code: 'USD', symbol: '$' } },
    });

    const result = await getTreasuryNotionalPoolOverview('user@deel.com', 'USD');

    expect(callTool).toHaveBeenCalledWith('notional_pool_overview', { currency: 'USD' }, notionalPoolOverviewSchema);
    expect(result.status).toBe('live');
    expect(result.overview?.balance.current.data.total.balance).toBe(3000);
  });
});

describe('getTreasuryNotionalPoolDailyMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces the tool's own error message", async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'error', errorMessage: 'dateFrom must be on or before dateTo' });
    const result = await getTreasuryNotionalPoolDailyMetrics('user@deel.com', 'interest', '2026-02-01', '2026-01-01');
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('dateFrom must be on or before dateTo');
  });

  it('calls notional_pool_daily_metrics with metric/date range/filters and maps records + pagination', async () => {
    const callTool = mockLive({
      records: [
        {
          date: '2026-01-01',
          npTotalUsd: 5_000_000,
          currencies: { USD: { jpmorgan: { value: 1, previousPeriodPercentageChange: 0 }, citi: { value: 2, previousPeriodPercentageChange: 0 } } },
        },
      ],
      meta: { perPage: '20', lastId: '2026-01-01', hasMore: true, currencies: ['USD'] },
      nextCursor: 'eyJkYXRlIjoiMjAyNi0wMS0wMSJ9',
      populated: { currencies: { USD: { code: 'USD', symbol: '$' } } },
    });

    const result = await getTreasuryNotionalPoolDailyMetrics('user@deel.com', 'interest', '2026-01-01', '2026-01-31', { currency: ['USD'] });

    expect(callTool).toHaveBeenCalledWith(
      'notional_pool_daily_metrics',
      { metric: 'interest', dateFrom: '2026-01-01', dateTo: '2026-01-31', currency: ['USD'] },
      notionalPoolDailyMetricsSchema,
    );
    expect(result.status).toBe('live');
    expect(result.records).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('eyJkYXRlIjoiMjAyNi0wMS0wMSJ9');
  });
});

describe('getTreasuryNotionalPoolRateSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls notional_pool_rate_snapshot with the given currency and maps per-provider records', async () => {
    const callTool = mockLive({
      records: [
        {
          id: 'usd-jpmorgan',
          provider: 'jpmorgan',
          currency: 'USD',
          latestRate: 3.5,
          latestDate: '2026-01-01',
          percentageChange: 0,
          previousRate: null,
          previousDate: null,
        },
      ],
      total: 1,
    });

    const result = await getTreasuryNotionalPoolRateSnapshot('user@deel.com', 'USD');

    expect(callTool).toHaveBeenCalledWith('notional_pool_rate_snapshot', { currency: 'USD' }, notionalPoolRateSnapshotSchema);
    expect(result.status).toBe('live');
    expect(result.records[0]?.provider).toBe('jpmorgan');
    expect(result.records[0]?.latestDate).toBe('2026-01-01');
  });
});

describe('getTreasuryNotionalPoolRateHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected as-is', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'not_connected' });
    const result = await getTreasuryNotionalPoolRateHistory('user@deel.com', 'USD', '2026-01-01', '2026-01-31', 7);
    expect(result.status).toBe('not_connected');
    expect(result.ratesByDate).toEqual({});
  });

  it('calls notional_pool_rate_history with the sampling interval and maps the rate history', async () => {
    const callTool = mockLive({
      ratesByDate: { '2026-01-01': { market: 3.4, jpmorgan: 3.5, citi: null } },
      meta: { currency: 'USD', fromDate: '2026-01-01', toDate: '2026-01-01', interval: 1, pointCount: 1 },
    });

    const result = await getTreasuryNotionalPoolRateHistory('user@deel.com', 'USD', '2026-01-01', '2026-01-01', 1);

    expect(callTool).toHaveBeenCalledWith(
      'notional_pool_rate_history',
      { currency: 'USD', fromDate: '2026-01-01', toDate: '2026-01-01', interval: 1 },
      notionalPoolRateHistorySchema,
    );
    expect(result.status).toBe('live');
    expect(result.ratesByDate['2026-01-01']?.jpmorgan).toBe(3.5);
  });
});
