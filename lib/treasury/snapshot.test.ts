import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INITIAL_ROWS } from '@/lib/fx-buffer';
import { aggregateNpCashByCurrency, getTreasurySnapshotForUser, revenueSummarySchema } from './snapshot';
import { TreasuryReauthRequiredError, TreasuryTemporarilyUnavailableError } from './token-store';

vi.mock('./mcp-client', () => ({
  isTreasuryMcpConfigured: vi.fn(),
  connectTreasuryMcpClient: vi.fn(),
}));
vi.mock('./token-store', async () => {
  const actual = await vi.importActual<typeof import('./token-store')>('./token-store');
  return {
    ...actual,
    getValidTreasuryAccessToken: vi.fn(),
  };
});

import { isTreasuryMcpConfigured, connectTreasuryMcpClient } from './mcp-client';
import { getValidTreasuryAccessToken } from './token-store';

const mockIsConfigured = vi.mocked(isTreasuryMcpConfigured);
const mockConnect = vi.mocked(connectTreasuryMcpClient);
const mockGetToken = vi.mocked(getValidTreasuryAccessToken);

// Real shape from investment_revenue_summary — a full ISO timestamp, not a bare date.
const T = (d: string) => `${d}T00:00:00.000Z`;

describe('aggregateNpCashByCurrency', () => {
  it('sums balances across providers for the same currency and date', () => {
    const { cashByCurrency } = aggregateNpCashByCurrency([
      { provider: 'citi', currency: 'EUR', revenueDate: T('2026-08-10'), balance: '49630005.84' },
      { provider: 'jpmorgan', currency: 'EUR', revenueDate: T('2026-08-10'), balance: '122189431.88' },
    ]);
    // (49630005.84 + 122189431.88) / 1e6 = 171.81943772
    expect(cashByCurrency.get('EUR')).toBeCloseTo(171.81943772, 8);
  });

  it('uses only the most recent date per currency when the SAME provider reports on different days', () => {
    const { cashByCurrency } = aggregateNpCashByCurrency([
      { provider: 'citi', currency: 'GBP', revenueDate: T('2026-08-08'), balance: '1000000' },
      { provider: 'citi', currency: 'GBP', revenueDate: T('2026-08-10'), balance: '2000000' },
    ]);
    expect(cashByCurrency.get('GBP')).toBeCloseTo(2, 8);
  });

  it('sums BOTH providers at their own latest date when they report the same currency on different days (no cross-provider drop)', () => {
    // Citi last reported EUR 2 days before JPM's latest EUR row, but still
    // inside the lookback window — its balance must still be counted, not
    // silently dropped just because a peer provider is more current.
    const { cashByCurrency, asOfRevenueDate } = aggregateNpCashByCurrency([
      { provider: 'citi', currency: 'EUR', revenueDate: T('2026-08-08'), balance: '2000000' },
      { provider: 'jpmorgan', currency: 'EUR', revenueDate: T('2026-08-10'), balance: '5000000' },
    ]);
    expect(cashByCurrency.get('EUR')).toBeCloseTo(7, 8);
    // Conservative: reflects Citi's lag, not JPM's fresher date.
    expect(asOfRevenueDate).toBe(T('2026-08-08'));
  });

  it('sums multiple accounts from the same provider on the same date', () => {
    const { cashByCurrency } = aggregateNpCashByCurrency([
      { provider: 'jpmorgan', currency: 'USD', revenueDate: T('2026-08-10'), balance: '45503884.87' },
      { provider: 'jpmorgan', currency: 'USD', revenueDate: T('2026-08-10'), balance: '325636579.70' },
    ]);
    expect(cashByCurrency.get('USD')).toBeCloseTo(371.14046457, 8);
  });

  it('handles negative balances (short NP position)', () => {
    const { cashByCurrency } = aggregateNpCashByCurrency([
      { provider: 'jpmorgan', currency: 'JPY', revenueDate: T('2026-08-10'), balance: '-3370636532.00' },
    ]);
    expect(cashByCurrency.get('JPY')).toBeCloseTo(-3370.636532, 8);
  });

  it('groups correctly even if one provider sends a bare date and another a full timestamp', () => {
    const { cashByCurrency } = aggregateNpCashByCurrency([
      { provider: 'citi', currency: 'AUD', revenueDate: '2026-08-10', balance: '1000000' },
      { provider: 'jpmorgan', currency: 'AUD', revenueDate: T('2026-08-10'), balance: '2000000' },
    ]);
    expect(cashByCurrency.get('AUD')).toBeCloseTo(3, 8);
  });

  it('returns an empty map and null asOfRevenueDate for no input', () => {
    const { cashByCurrency, asOfRevenueDate } = aggregateNpCashByCurrency([]);
    expect(cashByCurrency.size).toBe(0);
    expect(asOfRevenueDate).toBeNull();
  });

  it('asOfRevenueDate is the OLDEST currency-latest-date, not the newest — a lagging currency must not be hidden behind a fresh one', () => {
    const { asOfRevenueDate } = aggregateNpCashByCurrency([
      { provider: 'citi', currency: 'EUR', revenueDate: T('2026-08-10'), balance: '1000000' },
      // RSD last reported 6 days earlier — still inside a 7-day lookback window.
      { provider: 'citi', currency: 'RSD', revenueDate: T('2026-08-04'), balance: '1000000' },
    ]);
    expect(asOfRevenueDate).toBe(T('2026-08-04'));
  });
});

describe('revenueSummarySchema', () => {
  it('normalizes a lowercase currency code to uppercase — this is what guarantees aggregateNpCashByCurrency and the book ccy codes agree', () => {
    const parsed = revenueSummarySchema.parse({
      count: 1,
      summaries: [{ provider: 'citi', currency: 'eur', revenueDate: T('2026-08-10'), balance: '10000000' }],
    });
    expect(parsed.summaries[0].currency).toBe('EUR');
  });

  it('rejects a response where balance is a number instead of a string (the real API always sends a string)', () => {
    const result = revenueSummarySchema.safeParse({
      count: 1,
      summaries: [{ provider: 'citi', currency: 'EUR', revenueDate: T('2026-08-10'), balance: 10000000 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('getTreasurySnapshotForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the static book with status not_connected when TREASURY_MCP_URL is unset', async () => {
    mockIsConfigured.mockReturnValue(false);
    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('not_connected');
    expect(snapshot.rows).toEqual(INITIAL_ROWS);
    expect(snapshot.liveCurrencies).toEqual([]);
    expect(snapshot.usdCashIsLive).toBe(false);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('returns not_connected when the user has no stored Treasury link', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue(null);
    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('not_connected');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('returns reauth_required when the stored refresh token was rejected outright (invalid_grant)', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockRejectedValue(new TreasuryReauthRequiredError());
    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('reauth_required');
    expect(snapshot.rows).toEqual(INITIAL_ROWS);
  });

  it('returns status error (not reauth_required) when the refresh failed transiently — the link is not dead, just unreachable right now', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockRejectedValue(new TreasuryTemporarilyUnavailableError(new Error('ETIMEDOUT')));
    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('error');
    expect(snapshot.rows).toEqual(INITIAL_ROWS);
  });

  it('falls back to the static book with status error when the MCP connection fails', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));

    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('error');
    expect(snapshot.errorMessage).toBeTruthy();
    expect(snapshot.rows).toEqual(INITIAL_ROWS);
  });

  it('falls back to the static book with status error when the tool call throws, and still closes the client', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    const close = vi.fn().mockResolvedValue(undefined);
    mockConnect.mockResolvedValue({ callTool: vi.fn().mockRejectedValue(new Error('tool boom')), close });

    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('error');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still returns status error (not throwing) when the tool call fails AND close() itself rejects', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    const close = vi.fn().mockRejectedValue(new Error('close boom'));
    mockConnect.mockResolvedValue({ callTool: vi.fn().mockRejectedValue(new Error('tool boom')), close });

    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('error');
  });

  it('returns status error, not live, when the fetch succeeds but yields zero usable rows', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    mockConnect.mockResolvedValue({
      callTool: vi.fn().mockResolvedValue({ count: 0, nextCursor: null, summaries: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('error');
    expect(snapshot.rows).toEqual(INITIAL_ROWS);
  });

  it('returns status error, not live, when the aggregate has data but none of it matches a book currency or USD', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    mockConnect.mockResolvedValue({
      // 'XYZ' is not one of INITIAL_ROWS' 24 currencies, and it isn't USD.
      callTool: vi.fn().mockResolvedValue({
        count: 1,
        nextCursor: null,
        summaries: [{ provider: 'citi', currency: 'XYZ', revenueDate: T('2026-08-10'), balance: '10000000' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('error');
    expect(snapshot.rows).toEqual(INITIAL_ROWS);
  });

  it('merges live NP cash (including USD) onto the static book, reports which currencies are live, and asOf reflects the data date not wall-clock', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    const close = vi.fn().mockResolvedValue(undefined);
    mockConnect.mockResolvedValue({
      callTool: vi.fn().mockResolvedValue({
        count: 3,
        nextCursor: null,
        summaries: [
          { provider: 'citi', currency: 'EUR', revenueDate: T('2026-08-10'), balance: '10000000' },
          { provider: 'jpmorgan', currency: 'EUR', revenueDate: T('2026-08-10'), balance: '5000000' },
          { provider: 'jpmorgan', currency: 'USD', revenueDate: T('2026-08-10'), balance: '371000000' },
        ],
      }),
      close,
    });

    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('live');
    expect(snapshot.liveCurrencies).toEqual(['EUR']); // USD tracked separately, not in `rows`
    expect(snapshot.usdCashIsLive).toBe(true);
    expect(snapshot.usdCash).toBeCloseTo(371, 6);
    expect(snapshot.asOf).toBe(T('2026-08-10')); // the data's own date, not Date.now()
    expect(close).toHaveBeenCalledTimes(1);

    const eurRow = snapshot.rows.find(r => r.ccy === 'EUR');
    const staticEurRow = INITIAL_ROWS.find(r => r.ccy === 'EUR');
    expect(eurRow?.cash).toBeCloseTo(15, 6);
    // Every other field on the row is untouched — only `cash` is overridden.
    expect(eurRow?.spot).toBe(staticEurRow?.spot);
    expect(eurRow?.fwd).toBe(staticEurRow?.fwd);
    expect(eurRow?.nonLpCash).toBe(staticEurRow?.nonLpCash);
  });

  it('leaves currencies absent from the live response at their static cash value (partial coverage, not masked)', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    mockConnect.mockResolvedValue({
      callTool: vi.fn().mockResolvedValue({
        count: 1,
        nextCursor: null,
        summaries: [{ provider: 'citi', currency: 'EUR', revenueDate: T('2026-08-10'), balance: '10000000' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.liveCurrencies).toEqual(['EUR']);
    const cadRow = snapshot.rows.find(r => r.ccy === 'CAD');
    const staticCadRow = INITIAL_ROWS.find(r => r.ccy === 'CAD');
    expect(cadRow?.cash).toBe(staticCadRow?.cash);
  });

  it('refuses a paginated result outright (status error) rather than summing a partial page', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    mockConnect.mockResolvedValue({
      // A realistic partial page: count matches the rows actually returned,
      // nextCursor says there is more.
      callTool: vi.fn().mockResolvedValue({
        count: 1,
        nextCursor: 'more-pages-exist',
        summaries: [{ provider: 'citi', currency: 'EUR', revenueDate: T('2026-08-10'), balance: '10000000' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = await getTreasurySnapshotForUser('user@deel.com');
    expect(snapshot.status).toBe('error');
    expect(snapshot.rows).toEqual(INITIAL_ROWS);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('paginated'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });
});
