import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { AAD_TREASURY_TOKEN, encryptSecret, decryptSecret } from './crypto';

process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');

vi.mock('./okta-client', async () => {
  // Keep the real OktaTokenError class (token-store's `instanceof` checks on
  // it must keep working) — only refreshTokens itself is a mock.
  const actual = await vi.importActual<typeof import('./okta-client')>('./okta-client');
  return { ...actual, refreshTokens: vi.fn() };
});
vi.mock('@/lib/db/models/treasury-oauth-token', () => ({
  getTreasuryOauthTokenModel: vi.fn(),
}));

import { refreshTokens, OktaTokenError } from './okta-client';
import { getTreasuryOauthTokenModel } from '@/lib/db/models/treasury-oauth-token';
import {
  saveTreasuryTokens,
  disconnectTreasury,
  getValidTreasuryAccessToken,
  TreasuryReauthRequiredError,
  TreasuryTemporarilyUnavailableError,
} from './token-store';

const mockRefresh = vi.mocked(refreshTokens);
const mockGetModel = vi.mocked(getTreasuryOauthTokenModel);

type FakeRow = { userEmail: string; accessTokenCiphertext: string; refreshTokenCiphertext: string; expiresAt: Date };

/**
 * Minimal fake standing in for the Sequelize model — exercises token-store's
 * own orchestration (encrypt-before-write, decrypt-after-read, refresh-on-
 * expiry, the lock-then-destroy-on-failure path) without a live Postgres
 * connection. This mocks OUR data-access module, not Treasury's MCP server —
 * distinct from the "no mocking MCP" rule, which is about not faking
 * Treasury's own endpoints in integration tests.
 *
 * `transaction()` simulates real rollback-on-throw semantics: if the
 * callback rejects, row state reverts to what it was before the callback
 * ran. This is what caught the original bug — the code threw inside the
 * transaction after destroying the row, which a non-reverting fake could
 * not have exposed.
 */
function makeFakeModel(row: FakeRow | null) {
  const state = { row: row ? { ...row } : null };
  const calls = { save: 0, destroy: 0, upsert: [] as unknown[] };

  function rowInstance() {
    if (!state.row) return null;
    return {
      get accessTokenCiphertext() { return state.row!.accessTokenCiphertext; },
      set accessTokenCiphertext(v: string) { state.row!.accessTokenCiphertext = v; },
      get refreshTokenCiphertext() { return state.row!.refreshTokenCiphertext; },
      set refreshTokenCiphertext(v: string) { state.row!.refreshTokenCiphertext = v; },
      get expiresAt() { return state.row!.expiresAt; },
      set expiresAt(v: Date) { state.row!.expiresAt = v; },
      async save() { calls.save += 1; },
      async destroy() { calls.destroy += 1; state.row = null; },
    };
  }

  const Model = {
    sequelize: {
      async transaction<T>(cb: (t: unknown) => Promise<T>): Promise<T> {
        const snapshotBeforeCallback = state.row ? { ...state.row } : null;
        try {
          return await cb('fake-transaction');
        } catch (err) {
          state.row = snapshotBeforeCallback; // rollback
          throw err;
        }
      },
    },
    async findOne() {
      return rowInstance();
    },
    async upsert(values: unknown) {
      calls.upsert.push(values);
      return [values];
    },
    async destroy() {
      calls.destroy += 1;
      state.row = null;
    },
  };

  return { Model, calls, getRow: () => state.row };
}

describe('treasury/token-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveTreasuryTokens', () => {
    it('encrypts access and refresh tokens before persisting', async () => {
      const { Model, calls } = makeFakeModel(null);
      mockGetModel.mockResolvedValue(Model as never);

      await saveTreasuryTokens('User@Deel.com', {
        accessToken: 'plain-access',
        refreshToken: 'plain-refresh',
        idToken: 'idt',
        expiresAt: new Date(Date.now() + 3600_000),
      });

      expect(calls.upsert).toHaveLength(1);
      const persisted = calls.upsert[0] as { userEmail: string; accessTokenCiphertext: string; refreshTokenCiphertext: string };
      expect(persisted.userEmail).toBe('user@deel.com'); // normalized
      expect(persisted.accessTokenCiphertext).not.toBe('plain-access');
      expect(decryptSecret(persisted.accessTokenCiphertext, AAD_TREASURY_TOKEN)).toBe('plain-access');
      expect(decryptSecret(persisted.refreshTokenCiphertext, AAD_TREASURY_TOKEN)).toBe('plain-refresh');
    });

    it('throws when Postgres is not configured', async () => {
      mockGetModel.mockResolvedValue(null);
      await expect(
        saveTreasuryTokens('user@deel.com', {
          accessToken: 'a', refreshToken: 'b', idToken: 'c', expiresAt: new Date(),
        }),
      ).rejects.toThrow(/DATABASE_URL/);
    });
  });

  describe('disconnectTreasury', () => {
    it('is a no-op (not an error) when Postgres is unavailable', async () => {
      mockGetModel.mockResolvedValue(null);
      await expect(disconnectTreasury('user@deel.com')).resolves.toBeUndefined();
    });
  });

  describe('getValidTreasuryAccessToken', () => {
    it('returns the decrypted access token unchanged when far from expiry, without refreshing', async () => {
      const { Model, calls } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: encryptSecret('still-valid-token', AAD_TREASURY_TOKEN),
        refreshTokenCiphertext: encryptSecret('refresh', AAD_TREASURY_TOKEN),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      mockGetModel.mockResolvedValue(Model as never);

      const token = await getValidTreasuryAccessToken('user@deel.com');
      expect(token).toBe('still-valid-token');
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(calls.save).toBe(0);
    });

    it('returns null when the user has no stored link', async () => {
      const { Model } = makeFakeModel(null);
      mockGetModel.mockResolvedValue(Model as never);
      expect(await getValidTreasuryAccessToken('user@deel.com')).toBeNull();
    });

    it('returns null when Postgres is not configured', async () => {
      mockGetModel.mockResolvedValue(null);
      expect(await getValidTreasuryAccessToken('user@deel.com')).toBeNull();
    });

    it('refreshes and persists new tokens when within the expiry skew window', async () => {
      const { Model, calls, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: encryptSecret('about-to-expire', AAD_TREASURY_TOKEN),
        refreshTokenCiphertext: encryptSecret('old-refresh', AAD_TREASURY_TOKEN),
        expiresAt: new Date(Date.now() + 10_000), // inside the 60s skew
      });
      mockGetModel.mockResolvedValue(Model as never);
      mockRefresh.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: 'idt',
        expiresAt: new Date(Date.now() + 3600_000),
      });

      const token = await getValidTreasuryAccessToken('user@deel.com');
      expect(token).toBe('new-access');
      expect(mockRefresh).toHaveBeenCalledWith('old-refresh');
      expect(calls.save).toBe(1);
      expect(decryptSecret(getRow()!.accessTokenCiphertext, AAD_TREASURY_TOKEN)).toBe('new-access');
      expect(decryptSecret(getRow()!.refreshTokenCiphertext, AAD_TREASURY_TOKEN)).toBe('new-refresh');
    });

    it('drops the stored link (commits the delete) and throws TreasuryReauthRequiredError when Okta rejects the refresh token (invalid_grant)', async () => {
      const { Model, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: encryptSecret('expired', AAD_TREASURY_TOKEN),
        refreshTokenCiphertext: encryptSecret('revoked-refresh', AAD_TREASURY_TOKEN),
        expiresAt: new Date(Date.now() - 1_000), // already expired
      });
      mockGetModel.mockResolvedValue(Model as never);
      mockRefresh.mockRejectedValue(new OktaTokenError('refresh token revoked', 'invalid_grant'));

      await expect(getValidTreasuryAccessToken('user@deel.com')).rejects.toBeInstanceOf(
        TreasuryReauthRequiredError,
      );
      // The critical assertion: with a transaction fake that actually
      // reverts on throw, this only stays null if the code commits the
      // delete instead of throwing from inside the transaction callback.
      expect(getRow()).toBeNull();
    });

    it('keeps the stored link and throws TreasuryTemporarilyUnavailableError on a transient refresh failure (not invalid_grant)', async () => {
      const { Model, calls, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: encryptSecret('expired', AAD_TREASURY_TOKEN),
        refreshTokenCiphertext: encryptSecret('still-good-refresh', AAD_TREASURY_TOKEN),
        expiresAt: new Date(Date.now() - 1_000),
      });
      mockGetModel.mockResolvedValue(Model as never);
      // A 503 during an Okta degradation — the refresh token itself is fine.
      mockRefresh.mockRejectedValue(new OktaTokenError('Okta token request failed: HTTP 503', undefined));

      await expect(getValidTreasuryAccessToken('user@deel.com')).rejects.toBeInstanceOf(
        TreasuryTemporarilyUnavailableError,
      );
      expect(getRow()).not.toBeNull(); // NOT dropped — this is the round-2 regression fix
      expect(calls.destroy).toBe(0);
    });

    it('also treats a plain non-Okta error (e.g. a network exception) as transient, not as a dead refresh token', async () => {
      const { Model, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: encryptSecret('expired', AAD_TREASURY_TOKEN),
        refreshTokenCiphertext: encryptSecret('still-good-refresh', AAD_TREASURY_TOKEN),
        expiresAt: new Date(Date.now() - 1_000),
      });
      mockGetModel.mockResolvedValue(Model as never);
      mockRefresh.mockRejectedValue(new TypeError('fetch failed'));

      await expect(getValidTreasuryAccessToken('user@deel.com')).rejects.toBeInstanceOf(
        TreasuryTemporarilyUnavailableError,
      );
      expect(getRow()).not.toBeNull();
    });

    it('drops the row and throws TreasuryReauthRequiredError when the stored ciphertext is undecryptable under a validly-configured key (fast path)', async () => {
      const { Model, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: 'not-valid-base64-gcm-ciphertext',
        refreshTokenCiphertext: encryptSecret('refresh', AAD_TREASURY_TOKEN),
        expiresAt: new Date(Date.now() + 3600_000), // far from expiry — hits the fast path
      });
      mockGetModel.mockResolvedValue(Model as never);

      await expect(getValidTreasuryAccessToken('user@deel.com')).rejects.toBeInstanceOf(
        TreasuryReauthRequiredError,
      );
      expect(getRow()).toBeNull();
    });

    it('keeps the row and throws TreasuryTemporarilyUnavailableError (fast path) when TOKEN_ENCRYPTION_KEY is unset — a config problem is not the same as a dead link', async () => {
      // Encrypt the fixture BEFORE removing the key, so the ciphertext itself
      // is perfectly valid — only the key needed to read it is missing.
      const validCiphertext = encryptSecret('still-valid-token', AAD_TREASURY_TOKEN);
      const { Model, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: validCiphertext,
        refreshTokenCiphertext: encryptSecret('refresh', AAD_TREASURY_TOKEN),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      mockGetModel.mockResolvedValue(Model as never);

      const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
      delete process.env.TOKEN_ENCRYPTION_KEY;
      try {
        await expect(getValidTreasuryAccessToken('user@deel.com')).rejects.toBeInstanceOf(
          TreasuryTemporarilyUnavailableError,
        );
      } finally {
        process.env.TOKEN_ENCRYPTION_KEY = savedKey;
      }
      expect(getRow()).not.toBeNull(); // NOT dropped — this is the round-3 fix
    });

    it('keeps the row and throws TreasuryTemporarilyUnavailableError (fast path) when TOKEN_ENCRYPTION_KEY_PREVIOUS is set but malformed during a rotation — a mistyped env var must not be treated as a dead link', async () => {
      // Ciphertext genuinely needs the (about-to-be-broken) previous key:
      // encrypted under the "old" key, before the simulated rotation below.
      const oldKey = process.env.TOKEN_ENCRYPTION_KEY;
      const ciphertextNeedingOldKey = encryptSecret('pre-rotation-token', AAD_TREASURY_TOKEN);
      const { Model, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: ciphertextNeedingOldKey,
        refreshTokenCiphertext: encryptSecret('refresh', AAD_TREASURY_TOKEN),
        expiresAt: new Date(Date.now() + 3600_000), // far from expiry — hits the fast path
      });
      mockGetModel.mockResolvedValue(Model as never);

      process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64'); // rotate to a new current key
      process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = 'this-is-not-32-bytes'; // typo'd during the rotation
      try {
        await expect(getValidTreasuryAccessToken('user@deel.com')).rejects.toBeInstanceOf(
          TreasuryTemporarilyUnavailableError,
        );
      } finally {
        process.env.TOKEN_ENCRYPTION_KEY = oldKey;
        delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
      }
      // Must NOT be dropped: the data is fully recoverable once the typo in
      // TOKEN_ENCRYPTION_KEY_PREVIOUS is fixed. Destroying it here would be
      // exactly the failure mode key rotation was built to avoid.
      expect(getRow()).not.toBeNull();
    });

    it('drops the row and throws TreasuryReauthRequiredError when the REFRESH token ciphertext is undecryptable under a validly-configured key — the round-3 regression this commit fixes', async () => {
      const { Model, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: encryptSecret('expired', AAD_TREASURY_TOKEN),
        refreshTokenCiphertext: 'not-valid-base64-gcm-ciphertext',
        expiresAt: new Date(Date.now() - 1_000), // expired — takes the refresh path, not the fast path
      });
      mockGetModel.mockResolvedValue(Model as never);

      await expect(getValidTreasuryAccessToken('user@deel.com')).rejects.toBeInstanceOf(
        TreasuryReauthRequiredError,
      );
      expect(getRow()).toBeNull();
      expect(mockRefresh).not.toHaveBeenCalled(); // never even attempted with garbage input
    });

    it('keeps the row and throws TreasuryTemporarilyUnavailableError (refresh path) when TOKEN_ENCRYPTION_KEY is unset', async () => {
      const validRefreshCiphertext = encryptSecret('still-good-refresh', AAD_TREASURY_TOKEN);
      const { Model, getRow } = makeFakeModel({
        userEmail: 'user@deel.com',
        accessTokenCiphertext: encryptSecret('expired', AAD_TREASURY_TOKEN),
        refreshTokenCiphertext: validRefreshCiphertext,
        expiresAt: new Date(Date.now() - 1_000),
      });
      mockGetModel.mockResolvedValue(Model as never);

      const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
      delete process.env.TOKEN_ENCRYPTION_KEY;
      try {
        await expect(getValidTreasuryAccessToken('user@deel.com')).rejects.toBeInstanceOf(
          TreasuryTemporarilyUnavailableError,
        );
      } finally {
        process.env.TOKEN_ENCRYPTION_KEY = savedKey;
      }
      expect(getRow()).not.toBeNull();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });
});
