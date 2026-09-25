import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fxOrderBlotterSearchSchema, searchTreasuryFxOrderBlotter } from './fx-order-blotter';

// withTreasuryClient is mocked directly here (a genuine cross-module import for this file) rather
// than simulating the token/connect chain it wraps — that chain is exercised once, directly,
// in mcp-client.test.ts. Mocking it while still invoking the callback with a fake client lets
// these tests verify the tool name/args this file sends and how it maps a 'live' response, which
// is the part specific to this file.
vi.mock('./mcp-client', async () => {
  const actual = await vi.importActual<typeof import('./mcp-client')>('./mcp-client');
  return { ...actual, withTreasuryClient: vi.fn() };
});

import { withTreasuryClient } from './mcp-client';

const mockWithTreasuryClient = vi.mocked(withTreasuryClient);

function minimalOrderRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    status: 'Booked',
    sourceAmount: '100.5',
    destinationAmount: '109.2',
    exchangeRate: '1.0842',
    tradingPlatform: 'citi',
    tradeType: 'SPOT',
    kind: 'HEDGE',
    product: 'General',
    region: 'NA',
    country: 'US',
    cycle: '26-Apr',
    informationalStatus: 'EXECUTIONAL',
    tradeDate: '2026-04-01',
    valueDate: '2026-04-03',
    createdAt: '2026-04-01T00:00:00.000Z',
    creatorType: 'Admin',
    CreatorId: 7,
    withdrawalId: null,
    invoiceId: null,
    orderType: 'REQUEST',
    fixingDate: null,
    fixingRate: null,
    farLegSourceAmount: null,
    farLegSourceCurrencyId: null,
    farLegSourceAccountId: null,
    farLegDestinationAmount: null,
    farLegDestinationCurrencyId: null,
    farLegDestinationAccountId: null,
    farLegExchangeRate: null,
    farLegFeeAmount: null,
    farLegFeeCurrencyId: null,
    farLegTradeDate: null,
    valueDateFarLeg: null,
    premiumAmount: null,
    premiumCurrencyId: null,
    optionLifecycleStatus: null,
    optionType: null,
    isSettled: false,
    isAggregated: false,
    ...overrides,
  };
}

describe('fxOrderBlotterSearchSchema', () => {
  it('parses a row with far-leg/account fields present', () => {
    const parsed = fxOrderBlotterSearchSchema.safeParse({
      count: 1,
      nextCursor: null,
      fxOrders: [
        minimalOrderRow({
          SourceCurrency: { code: 'EUR' },
          DestinationCurrency: { code: 'USD' },
          SourceFinancialAccount: { id: 5, name: 'JPM EUR' },
          DestinationFinancialAccount: null,
        }),
      ],
      summary: 'Found 1 FX order(s); newest id=1.',
    });
    expect(parsed.success).toBe(true);
  });

  it('parses a row missing the optional currency/account includes', () => {
    const parsed = fxOrderBlotterSearchSchema.safeParse({
      count: 1,
      nextCursor: 'eyJpZCI6MX0=',
      fxOrders: [minimalOrderRow()],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('searchTreasuryFxOrderBlotter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected as-is, with no fabricated count', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'not_connected' });
    const result = await searchTreasuryFxOrderBlotter('user@deel.com', { status: 'Booked' });
    expect(result.status).toBe('not_connected');
    expect(result.orders).toEqual([]);
    expect(result.count).toBeNull();
  });

  it('returns reauth_required as-is', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'reauth_required' });
    const result = await searchTreasuryFxOrderBlotter('user@deel.com', { status: 'Booked' });
    expect(result.status).toBe('reauth_required');
  });

  it('calls fx_order_blotter_search with the given filters and maps a live response', async () => {
    const callTool = vi.fn().mockResolvedValue({ count: 1, nextCursor: null, fxOrders: [minimalOrderRow()] });
    mockWithTreasuryClient.mockImplementation(async (_email, _prefix, fn) => {
      const data = await fn({ callTool, close: vi.fn() });
      return { status: 'live', data };
    });

    const result = await searchTreasuryFxOrderBlotter('user@deel.com', { status: 'Booked', limit: 10 });

    expect(callTool).toHaveBeenCalledWith('fx_order_blotter_search', { status: 'Booked', limit: 10 }, fxOrderBlotterSearchSchema);
    expect(result.status).toBe('live');
    expect(result.count).toBe(1);
    expect(result.orders[0]?.id).toBe(1);
  });

  it('rejects an empty filter object locally, without a round trip to Treasury', async () => {
    const result = await searchTreasuryFxOrderBlotter('user@deel.com', {});
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('Provide at least one filter');
    expect(result.orders).toEqual([]);
    expect(mockWithTreasuryClient).not.toHaveBeenCalled();
  });

  it('treats a filter object with only sortBy/direction/limit/afterCursor as empty (mirrors the tool)', async () => {
    const result = await searchTreasuryFxOrderBlotter('user@deel.com', { sortBy: 'tradeDate', direction: 'ASC', limit: 10 });
    expect(result.status).toBe('error');
    expect(mockWithTreasuryClient).not.toHaveBeenCalled();
  });

  it("surfaces the tool's own error message for a genuine remote failure", async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'error', errorMessage: 'missing fx_orders permission' });
    const result = await searchTreasuryFxOrderBlotter('user@deel.com', { status: 'Booked' });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('fx_orders permission');
    expect(result.orders).toEqual([]);
  });
});
