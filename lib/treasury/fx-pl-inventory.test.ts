import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fxPlInventoryByCurrencySchema,
  fxPlInventoryOverviewSchema,
  getTreasuryFxPlInventoryByCurrency,
  getTreasuryFxPlInventoryOverview,
} from './fx-pl-inventory';

// See fx-order-blotter.test.ts for why withTreasuryClient is mocked directly rather than the
// token/connect chain it wraps.
vi.mock('./mcp-client', async () => {
  const actual = await vi.importActual<typeof import('./mcp-client')>('./mcp-client');
  return { ...actual, withTreasuryClient: vi.fn() };
});

import { withTreasuryClient } from './mcp-client';

const mockWithTreasuryClient = vi.mocked(withTreasuryClient);

function plRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    currency: 'EUR',
    products: ['General'],
    amount: '1500000.5',
    USDAmountHistorical: 1620000,
    USDAmountCurrentValue: 1625000,
    numberOfTrades: 3,
    pnlAmount: 5000,
    avgRate: '1.08',
    USDRateCurrentValue: '1.0833',
    premiumPnlAmount: 0,
    ...overrides,
  };
}

describe('fxPlInventoryOverviewSchema / fxPlInventoryByCurrencySchema', () => {
  it('parses an overview body with a Big.js-serialized amount/avgRate (string)', () => {
    const parsed = fxPlInventoryOverviewSchema.safeParse({
      pnlAmount: 5000,
      numberOfTradesTotal: 3,
      PLInventory: [plRow()],
      dateRange: { fromDate: '2026-01-01', toDate: '2026-01-31' },
    });
    expect(parsed.success).toBe(true);
  });

  it('also accepts amount/avgRate as plain numbers', () => {
    const parsed = fxPlInventoryByCurrencySchema.safeParse({
      pnlAmount: 5000,
      numberOfTradesTotal: 3,
      PLInventory: [plRow({ amount: 1500000.5, avgRate: 1.08, USDRateCurrentValue: 1.0833 })],
      dateRange: { fromDate: '2026-01-01', toDate: '2026-01-31' },
      currency: 'EUR',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('getTreasuryFxPlInventoryOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected as-is, with no fabricated pnlAmount', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'not_connected' });
    const result = await getTreasuryFxPlInventoryOverview('user@deel.com', '2026-01-01', '2026-01-31');
    expect(result.status).toBe('not_connected');
    expect(result.inventory).toEqual([]);
    expect(result.pnlAmount).toBeNull();
    expect(result.numberOfTradesTotal).toBeNull();
    expect(result.dateRange).toBeNull();
  });

  it('returns reauth_required as-is', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'reauth_required' });
    const result = await getTreasuryFxPlInventoryOverview('user@deel.com', '2026-01-01', '2026-01-31');
    expect(result.status).toBe('reauth_required');
  });

  it('calls fx_pl_inventory_overview with the date range and filters, and maps a live response', async () => {
    const callTool = vi.fn().mockResolvedValue({
      pnlAmount: 5000,
      numberOfTradesTotal: 3,
      PLInventory: [plRow()],
      dateRange: { fromDate: '2026-01-01', toDate: '2026-01-31' },
    });
    mockWithTreasuryClient.mockImplementation(async (_email, _prefix, fn) => ({ status: 'live', data: await fn({ callTool, close: vi.fn() }) }));

    const result = await getTreasuryFxPlInventoryOverview('user@deel.com', '2026-01-01', '2026-01-31', { kinds: ['HEDGE'] });

    expect(callTool).toHaveBeenCalledWith(
      'fx_pl_inventory_overview',
      { fromDate: '2026-01-01', toDate: '2026-01-31', kinds: ['HEDGE'] },
      fxPlInventoryOverviewSchema,
    );
    expect(result.status).toBe('live');
    expect(result.pnlAmount).toBe(5000);
    expect(result.dateRange).toEqual({ fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.inventory[0]?.currency).toBe('EUR');
  });
});

describe('getTreasuryFxPlInventoryByCurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces the tool's own error message and keeps the requested currency uppercased, with no fabricated pnlAmount", async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'error', errorMessage: 'missing fx_orders_pl_inventory permission' });

    const result = await getTreasuryFxPlInventoryByCurrency('user@deel.com', '2026-01-01', '2026-01-31', 'eur');
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('fx_orders_pl_inventory permission');
    expect(result.currency).toBe('EUR');
    expect(result.pnlAmount).toBeNull();
    expect(result.dateRange).toBeNull();
  });

  it('sends the currency uppercased to the tool and maps a live response scoped to it', async () => {
    const callTool = vi.fn().mockResolvedValue({
      pnlAmount: 5000,
      numberOfTradesTotal: 3,
      PLInventory: [plRow()],
      dateRange: { fromDate: '2026-01-01', toDate: '2026-01-31' },
      // Deliberately a different case than what was sent, to prove the function reports its own
      // normalized value rather than trusting the tool's echo to already agree with it.
      currency: 'eur',
    });
    mockWithTreasuryClient.mockImplementation(async (_email, _prefix, fn) => ({ status: 'live', data: await fn({ callTool, close: vi.fn() }) }));

    const result = await getTreasuryFxPlInventoryByCurrency('user@deel.com', '2026-01-01', '2026-01-31', 'eur', { kinds: ['HEDGE'] });

    // Locks in the fix for the lowercase-vs-uppercase inconsistency: the tool receives the same
    // normalized currency this function reports back on every branch, not the raw input.
    expect(callTool).toHaveBeenCalledWith(
      'fx_pl_inventory_by_currency',
      { fromDate: '2026-01-01', toDate: '2026-01-31', currency: 'EUR', kinds: ['HEDGE'] },
      fxPlInventoryByCurrencySchema,
    );
    expect(result.status).toBe('live');
    expect(result.currency).toBe('EUR');
    expect(result.dateRange).toEqual({ fromDate: '2026-01-01', toDate: '2026-01-31' });
  });
});
