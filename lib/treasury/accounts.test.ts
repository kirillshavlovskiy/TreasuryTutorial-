import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getFinancialAccountSchema,
  getTreasuryFinancialAccount,
  searchFinancialAccountsAdvancedSchema,
  searchTreasuryFinancialAccountsAdvanced,
} from './accounts';

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

function accountDetail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    name: 'JPM EUR Pay In',
    createdAt: '2024-01-01T00:00:00.000Z',
    financialInstitutionId: 3,
    deelLegalEntityId: 2,
    currencyId: 10,
    openingDate: '2024-01-02',
    netsuiteAccountId: null,
    accountUse: 'Corporate Account',
    accountType: 'Checking',
    purpose: null,
    accountStatus: 'Active',
    closingDate: null,
    fundingDatesInfo: null,
    beforeDueDays: null,
    entityRegion: 'Europe',
    safeguardingRegion: null,
    api: null,
    accountSigners: null,
    accountPortalUsers: null,
    paymentMethodUUID: null,
    isAllowedACHTransferSource: false,
    isFavorite: false,
    financialInstitution: { id: 3, legalName: 'JPMorgan Chase' },
    currency: { id: 10, code: 'EUR', symbol: '€' },
    deelLegalEntity: { id: 2, legalName: 'Deel Inc', displayName: 'Deel Inc' },
    ...overrides,
  };
}

describe('getFinancialAccountSchema', () => {
  it('parses a full account detail row', () => {
    const parsed = getFinancialAccountSchema.safeParse({ account: accountDetail() });
    expect(parsed.success).toBe(true);
  });
});

describe('getTreasuryFinancialAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected as-is', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'not_connected' });
    const result = await getTreasuryFinancialAccount('user@deel.com', 42);
    expect(result.status).toBe('not_connected');
    expect(result.account).toBeNull();
  });

  it('returns reauth_required as-is', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'reauth_required' });
    const result = await getTreasuryFinancialAccount('user@deel.com', 42);
    expect(result.status).toBe('reauth_required');
  });

  it("surfaces the tool's own 'not found' error", async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'error', errorMessage: 'FinancialAccount id=999 not found.' });
    const result = await getTreasuryFinancialAccount('user@deel.com', 999);
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('not found');
  });

  it('calls get_financial_account with the given id and maps a live response', async () => {
    const callTool = mockLive({ account: accountDetail() });
    const result = await getTreasuryFinancialAccount('user@deel.com', 42);

    expect(callTool).toHaveBeenCalledWith('get_financial_account', { financialAccountId: 42 }, getFinancialAccountSchema);
    expect(result.status).toBe('live');
    expect(result.account?.id).toBe(42);
    expect(result.account?.currency?.code).toBe('EUR');
  });
});

describe('searchFinancialAccountsAdvancedSchema', () => {
  it('parses a search result page', () => {
    const parsed = searchFinancialAccountsAdvancedSchema.safeParse({
      count: 1,
      total: 1,
      page: 1,
      perPage: 50,
      accounts: [
        {
          id: 42,
          name: 'JPM EUR Pay In',
          accountStatus: 'Active',
          accountUse: 'Corporate Account',
          accountType: 'Checking',
          subRegion: null,
          deelLegalEntityId: 2,
          currencyId: 10,
          financialInstitutionId: 3,
          yieldRate: '0.0125',
          netsuiteAccountId: null,
          openingDate: '2024-01-02',
          closingDate: null,
          masterFinancialAccountId: null,
          financialInstitution: { id: 3, legalName: 'JPMorgan Chase' },
          currency: { id: 10, code: 'EUR', symbol: '€' },
          deelLegalEntity: { id: 2, legalName: 'Deel Inc', country: 'US', region: 'NAM' },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('searchTreasuryFinancialAccountsAdvanced', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected as-is, with no fabricated count/total', async () => {
    mockWithTreasuryClient.mockResolvedValue({ status: 'not_connected' });
    const result = await searchTreasuryFinancialAccountsAdvanced('user@deel.com', { name: 'JPM' });
    expect(result.status).toBe('not_connected');
    expect(result.accounts).toEqual([]);
    expect(result.count).toBeNull();
    expect(result.total).toBeNull();
  });

  it('calls search_financial_accounts_advanced with the given filters and maps a live response', async () => {
    const callTool = mockLive({
      count: 1,
      total: 1,
      page: 1,
      perPage: 50,
      accounts: [
        {
          id: 42,
          name: 'JPM EUR Pay In',
          accountStatus: 'Active',
          accountUse: 'Corporate Account',
          accountType: 'Checking',
          subRegion: null,
          deelLegalEntityId: 2,
          currencyId: 10,
          financialInstitutionId: 3,
          yieldRate: null,
          netsuiteAccountId: null,
          openingDate: '2024-01-02',
          closingDate: null,
          masterFinancialAccountId: null,
          financialInstitution: null,
          currency: null,
          deelLegalEntity: null,
        },
      ],
    });

    const result = await searchTreasuryFinancialAccountsAdvanced('user@deel.com', { name: 'JPM' });

    expect(callTool).toHaveBeenCalledWith('search_financial_accounts_advanced', { name: 'JPM' }, searchFinancialAccountsAdvancedSchema);
    expect(result.status).toBe('live');
    expect(result.total).toBe(1);
    expect(result.accounts[0]?.id).toBe(42);
  });
});
