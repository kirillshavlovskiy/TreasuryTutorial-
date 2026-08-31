import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fxRateLookupSchema,
  getTreasuryFxRatesForUser,
  MAX_PAIRS,
  parsePairsInput,
} from './fx-rates';
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

/** Generates the nth distinct 3-letter A-Z code (AAA, AAB, ... ZZZ). */
function nthCode(n: number): string {
  const a = 'A'.charCodeAt(0);
  const c1 = String.fromCharCode(a + (Math.floor(n / 676) % 26));
  const c2 = String.fromCharCode(a + (Math.floor(n / 26) % 26));
  const c3 = String.fromCharCode(a + (n % 26));
  return `${c1}${c2}${c3}`;
}

describe('parsePairsInput', () => {
  it('accepts a valid array of pairs and uppercases codes', () => {
    const result = parsePairsInput([{ base: 'eur', target: 'usd' }]);
    expect(result).toEqual([{ base: 'EUR', target: 'USD' }]);
  });

  it('rejects a non-array input', () => {
    const result = parsePairsInput({ base: 'EUR', target: 'USD' });
    expect(result).toEqual({ error: expect.any(String) });
  });

  it('rejects an empty array', () => {
    const result = parsePairsInput([]);
    expect(result).toEqual({ error: expect.any(String) });
  });

  it('rejects a pair missing target', () => {
    const result = parsePairsInput([{ base: 'EUR' }]);
    expect(result).toEqual({ error: expect.any(String) });
  });

  it('rejects a non-3-letter currency code', () => {
    const result = parsePairsInput([{ base: 'EURO', target: 'USD' }]);
    expect(result).toEqual({ error: expect.any(String) });
  });

  it('dedupes identical pairs case-insensitively', () => {
    const result = parsePairsInput([
      { base: 'eur', target: 'usd' },
      { base: 'EUR', target: 'USD' },
    ]);
    expect(result).toEqual([{ base: 'EUR', target: 'USD' }]);
  });

  it('rejects more than MAX_PAIRS distinct pairs', () => {
    const pairs = Array.from({ length: MAX_PAIRS + 1 }, (_, i) => ({ base: 'USD', target: nthCode(i) }));
    const result = parsePairsInput(pairs);
    expect(result).toEqual({ error: expect.any(String) });
  });

  it('accepts exactly MAX_PAIRS distinct pairs', () => {
    const pairs = Array.from({ length: MAX_PAIRS }, (_, i) => ({ base: 'USD', target: nthCode(i) }));
    const result = parsePairsInput(pairs);
    expect(Array.isArray(result)).toBe(true);
    expect((result as { base: string }[]).length).toBe(MAX_PAIRS);
  });
});

describe('fxRateLookupSchema', () => {
  it('tolerates the summary/followUp fields buildFinanceToolResult adds on top of the tool body', () => {
    const parsed = fxRateLookupSchema.safeParse({
      mode: 'market',
      date: 'latest',
      asOfTime: null,
      results: [{ base: 'EUR', target: 'USD', rate: 1.0842 }],
      missing: [],
      summary: '1 pair(s) @ latest: EUR/USD 1.0842',
      followUp: { tools: [] },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('getTreasuryFxRatesForUser', () => {
  const PAIRS = [{ base: 'EUR', target: 'USD' }];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected when TREASURY_MCP_URL is unset', async () => {
    mockIsConfigured.mockReturnValue(false);
    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('not_connected');
    expect(result.rates).toEqual([]);
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it('returns not_connected when the user has no stored Treasury link', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue(null);
    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('not_connected');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('returns reauth_required when the stored refresh token was rejected outright', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockRejectedValue(new TreasuryReauthRequiredError());
    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('reauth_required');
  });

  it('returns status error (not reauth_required) when the refresh failed transiently', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockRejectedValue(new TreasuryTemporarilyUnavailableError(new Error('ETIMEDOUT')));
    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('error');
  });

  it('returns a generic status error (not throwing) when the token lookup fails with an unrecognized error', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockRejectedValue(new Error('unexpected DB error'));
    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('error');
    expect(result.errorMessage).toBe('Could not verify your Treasury connection.');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('returns status error when the MCP connection fails', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('error');
    expect(result.errorMessage).toBeTruthy();
  });

  it("surfaces the tool's own error message (e.g. a permission denial) and still closes the client", async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    const close = vi.fn().mockResolvedValue(undefined);
    mockConnect.mockResolvedValue({
      callTool: vi
        .fn()
        .mockRejectedValue(new Error('Treasury MCP tool "fx_rate_lookup" failed: missing fx_rates permission')),
      close,
    });

    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('fx_rates permission');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns status error, not live, when the tool returns zero results and zero missing', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    mockConnect.mockResolvedValue({
      callTool: vi.fn().mockResolvedValue({ mode: 'market', date: 'latest', asOfTime: null, results: [], missing: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('error');
  });

  it('returns live status with parsed rates and passes through missing pairs', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    const close = vi.fn().mockResolvedValue(undefined);
    mockConnect.mockResolvedValue({
      callTool: vi.fn().mockResolvedValue({
        mode: 'market',
        date: 'latest',
        asOfTime: null,
        results: [{ base: 'EUR', target: 'USD', rate: 1.0842 }],
        missing: [{ base: 'XYZ', target: 'USD' }],
        summary: '1 pair(s) @ latest: EUR/USD 1.0842 (1 pair(s) with no rate)',
      }),
      close,
    });

    const result = await getTreasuryFxRatesForUser('user@deel.com', [
      { base: 'EUR', target: 'USD' },
      { base: 'XYZ', target: 'USD' },
    ]);
    expect(result.status).toBe('live');
    expect(result.rates).toEqual([{ base: 'EUR', target: 'USD', rate: 1.0842 }]);
    expect(result.missing).toEqual([{ base: 'XYZ', target: 'USD' }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still returns status error (not throwing) when the tool call fails AND close() itself rejects', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockGetToken.mockResolvedValue('valid-access-token');
    const close = vi.fn().mockRejectedValue(new Error('close boom'));
    mockConnect.mockResolvedValue({ callTool: vi.fn().mockRejectedValue(new Error('tool boom')), close });

    const result = await getTreasuryFxRatesForUser('user@deel.com', PAIRS);
    expect(result.status).toBe('error');
  });
});
