import { Transaction } from 'sequelize';
import { getTreasuryOauthTokenModel } from '@/lib/db/models/treasury-oauth-token';
import { AAD_TREASURY_TOKEN, decryptSecret, encryptSecret, TokenKeyConfigError } from '@/lib/treasury/crypto';
import { OktaTokenError, refreshTokens, type TreasuryTokens } from '@/lib/treasury/okta-client';

/** Thrown when the stored refresh token is no longer valid — user must reconnect. */
export class TreasuryReauthRequiredError extends Error {
  constructor() {
    super('Treasury connection expired — please reconnect from the Workspace.');
    this.name = 'TreasuryReauthRequiredError';
  }
}

/** Thrown when a refresh attempt fails for a reason unrelated to the refresh
 *  token's validity (network, timeout, Okta 5xx/429, or a key env var —
 *  TOKEN_ENCRYPTION_KEY or, mid-rotation, TOKEN_ENCRYPTION_KEY_PREVIOUS —
 *  being unset/malformed) — the stored link is left intact; the caller
 *  should treat this as transient and retry once the underlying problem
 *  (Okta, or the deploy's own config) is resolved. */
export class TreasuryTemporarilyUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Treasury is temporarily unavailable — please try again shortly.');
    this.name = 'TreasuryTemporarilyUnavailableError';
    this.cause = cause;
  }
}

const REFRESH_SKEW_MS = 60_000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Decrypts a stored ciphertext, distinguishing two failure modes that must
 * be handled oppositely:
 *  - A key env var (TOKEN_ENCRYPTION_KEY or, mid-rotation,
 *    TOKEN_ENCRYPTION_KEY_PREVIOUS) is unset/malformed — an operational
 *    config problem. The row is fine; it just can't be read right now.
 *    Must NOT delete it, or a missing/mistyped env var on one bad deploy
 *    permanently disconnects every affected user with no way back (fixing
 *    the config doesn't un-delete anything).
 *  - Every configured key loaded fine, but decryption/auth-tag
 *    verification still fails (wrong key value after a rotation, or
 *    tampering) — that row is genuinely unrecoverable and should be
 *    dropped so the user gets a "reconnect" affordance instead of being
 *    wedged forever.
 * Distinguishing by `err instanceof TokenKeyConfigError` (crypto.ts) rather
 * than by checking TOKEN_ENCRYPTION_KEY alone up front is what makes this
 * reliable during a rotation: a row that still needs
 * TOKEN_ENCRYPTION_KEY_PREVIOUS to decrypt must not be destroyed just
 * because that var was mistyped — the earlier up-front check only ever
 * looked at the current key and had no way to see that failure mode.
 */
function decryptStored(ciphertext: string): { value: string } | { configError: true } | { configError: false } {
  try {
    return { value: decryptSecret(ciphertext, AAD_TREASURY_TOKEN) };
  } catch (err) {
    return { configError: err instanceof TokenKeyConfigError };
  }
}

/** Persist tokens from a fresh OAuth code exchange (upsert). */
export async function saveTreasuryTokens(email: string, tokens: TreasuryTokens): Promise<void> {
  const Model = await getTreasuryOauthTokenModel();
  if (!Model) throw new Error('Postgres DATABASE_URL is not configured');

  await Model.upsert({
    userEmail: normalizeEmail(email),
    accessTokenCiphertext: encryptSecret(tokens.accessToken, AAD_TREASURY_TOKEN),
    refreshTokenCiphertext: encryptSecret(tokens.refreshToken, AAD_TREASURY_TOKEN),
    expiresAt: tokens.expiresAt,
  });
}

export async function disconnectTreasury(email: string): Promise<void> {
  const Model = await getTreasuryOauthTokenModel();
  if (!Model) return;
  await Model.destroy({ where: { userEmail: normalizeEmail(email) } });
}

type RefreshOutcome =
  | { kind: 'none' }
  | { kind: 'token'; token: string }
  | { kind: 'reauth' }
  | { kind: 'transient'; cause: unknown };

/**
 * Returns a valid Treasury Bearer access token for `email`, transparently
 * refreshing it when within REFRESH_SKEW_MS of expiry. Returns null when the
 * user has never connected Treasury. Throws TreasuryReauthRequiredError only
 * when the stored data is genuinely dead — Okta definitively rejects the
 * refresh token (invalid_grant), or every configured key loaded fine but
 * still can't decrypt the row (tampered, or truly rotated away with no
 * matching key left) — the stored link is dropped first in both cases.
 * Throws TreasuryTemporarilyUnavailableError for everything else that can
 * go wrong (timeout, 5xx, network, or a key env var itself being
 * unset/malformed) — the link is left intact so the next request can
 * simply try again.
 *
 * Two-phase to avoid holding a Postgres row lock across the network round
 * trip to Okta on every call: an unlocked read serves the common case
 * (token nowhere near expiry) with no lock and no transaction at all. Only
 * when a refresh is actually needed does it open a transaction with
 * `SELECT ... FOR UPDATE`, so concurrent requests for the same user
 * serialize on the refresh itself rather than each burning the single-use
 * rotated refresh token.
 */
export async function getValidTreasuryAccessToken(email: string): Promise<string | null> {
  const Model = await getTreasuryOauthTokenModel();
  if (!Model || !Model.sequelize) return null;
  const normalized = normalizeEmail(email);

  const fastRow = await Model.findOne({ where: { userEmail: normalized } });
  if (!fastRow) return null;
  if (fastRow.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
    const decrypted = decryptStored(fastRow.accessTokenCiphertext);
    if ('value' in decrypted) return decrypted.value;
    if (decrypted.configError) {
      throw new TreasuryTemporarilyUnavailableError('token encryption key is unset or malformed (TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY_PREVIOUS)');
    }
    // Validly-keyed decrypt still failed — the row itself is dead (tampered,
    // or encrypted under a key that's since been rotated away). Not
    // recoverable by retrying, and not something a refresh can fix either.
    console.warn('[treasury/token-store] stored token undecryptable under the configured key, dropping link');
    await Model.destroy({ where: { userEmail: normalized } });
    throw new TreasuryReauthRequiredError();
  }

  const outcome: RefreshOutcome = await Model.sequelize.transaction(async (transaction) => {
    const row = await Model.findOne({
      where: { userEmail: normalized },
      transaction,
      lock: Transaction.LOCK.UPDATE,
    });
    if (!row) return { kind: 'none' };

    if (row.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) {
      // Another request already refreshed it while this one waited for the lock.
      const decrypted = decryptStored(row.accessTokenCiphertext);
      if ('value' in decrypted) return { kind: 'token', token: decrypted.value };
      if (decrypted.configError) return { kind: 'transient', cause: 'token encryption key is unset or malformed (TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY_PREVIOUS)' };
      await row.destroy({ transaction });
      return { kind: 'reauth' };
    }

    const decryptedRefresh = decryptStored(row.refreshTokenCiphertext);
    if (!('value' in decryptedRefresh)) {
      if (decryptedRefresh.configError) {
        return { kind: 'transient', cause: 'token encryption key is unset or malformed (TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY_PREVIOUS)' };
      }
      // Must not throw here: this callback rejecting would roll back the
      // transaction and undo the destroy() below. Signal the outcome
      // instead and throw after commit — same reasoning as the
      // invalid_grant case right below.
      await row.destroy({ transaction });
      return { kind: 'reauth' };
    }

    let refreshed: TreasuryTokens;
    try {
      // refreshTokens() itself falls back to this same refresh token when
      // Okta's response omits a new one (rotation off) — see okta-client.ts.
      refreshed = await refreshTokens(decryptedRefresh.value);
    } catch (err) {
      // Only a definitive Okta rejection means the refresh token itself is
      // dead. Anything else (timeout, 5xx, network blip) says nothing about
      // its validity — must not destroy the row for that, or a single Okta
      // outage force-disconnects every user whose token happened to be near
      // expiry during it.
      if (err instanceof OktaTokenError && err.isInvalidGrant) {
        console.warn('[treasury/token-store] refresh token rejected by Okta, dropping stored link', err);
        await row.destroy({ transaction });
        return { kind: 'reauth' };
      }
      return { kind: 'transient', cause: err };
    }

    row.accessTokenCiphertext = encryptSecret(refreshed.accessToken, AAD_TREASURY_TOKEN);
    row.refreshTokenCiphertext = encryptSecret(refreshed.refreshToken, AAD_TREASURY_TOKEN);
    row.expiresAt = refreshed.expiresAt;
    await row.save({ transaction });
    return { kind: 'token', token: refreshed.accessToken };
  });

  if (outcome.kind === 'reauth') throw new TreasuryReauthRequiredError();
  if (outcome.kind === 'transient') throw new TreasuryTemporarilyUnavailableError(outcome.cause);
  return outcome.kind === 'token' ? outcome.token : null;
}
