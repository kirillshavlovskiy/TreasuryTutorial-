import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for Treasury OAuth tokens at rest (Postgres).
 * Key comes from TOKEN_ENCRYPTION_KEY (base64, 32 raw bytes) — never hardcoded.
 *
 * AES-256 (not AES-128) is the deliberate choice here: Grover's algorithm
 * only gives a quadratic speedup against symmetric ciphers, so AES-256 keeps
 * ~128-bit effective security against a quantum adversary — the same margin
 * NIST's own post-quantum guidance targets. There is no asymmetric/public-key
 * step in this module (no key exchange, no signatures) for Shor's algorithm
 * to threaten, so no PQC KEM/signature scheme belongs here; introducing one
 * would add real complexity for a threat model this design doesn't have.
 * What we DO borrow from post-quantum-readiness guidance is crypto agility:
 * every ciphertext is tagged with an envelope version (see ENVELOPE_VERSION)
 * so a future algorithm change is a new case in decryptSecret, not a
 * flag-day migration of every stored row.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Bump when the wire format or algorithm changes; decryptSecret dispatches on this. */
const ENVELOPE_VERSION = 'v1';

/** AAD tags — one per ciphertext purpose, so both share TOKEN_ENCRYPTION_KEY
 *  without a state-cookie payload ever being decryptable as a stored token. */
export const AAD_TREASURY_TOKEN = 'treasury-oauth-token';
export const AAD_OAUTH_STATE_COOKIE = 'treasury-oauth-state';

/**
 * Thrown when a key ENV VAR itself is unset or malformed — as opposed to a
 * `decryptWithKey` failure, which means the key loaded fine but the
 * ciphertext genuinely doesn't decrypt under it. Callers (token-store.ts)
 * must tell these apart: a config error means "can't tell yet, try again
 * later"; a decrypt failure under a validly-configured key means "this row
 * is genuinely dead." Distinguishing by `instanceof` rather than by
 * inspecting the current key alone is what lets a malformed
 * TOKEN_ENCRYPTION_KEY_PREVIOUS (a rotation-time typo, not tampering) be
 * treated as the config problem it is instead of destroying every row that
 * still needs the previous key to decrypt.
 */
export class TokenKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenKeyConfigError';
  }
}

function decodeKey(raw: string, envVarName: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new TokenKeyConfigError(`${envVarName} must decode to 32 bytes (openssl rand -base64 32)`);
  }
  return key;
}

function loadCurrentKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new TokenKeyConfigError('TOKEN_ENCRYPTION_KEY is not configured');
  }
  return decodeKey(raw, 'TOKEN_ENCRYPTION_KEY');
}

/**
 * Prior key, kept live only long enough to decrypt rows written before a
 * rotation. Set TOKEN_ENCRYPTION_KEY to a freshly generated key and move the
 * old value here; once every row has been re-encrypted (re-save on next
 * refresh, or a one-off backfill), drop this var entirely.
 */
function loadPreviousKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (!raw) return null;
  return decodeKey(raw, 'TOKEN_ENCRYPTION_KEY_PREVIOUS');
}

function encryptWithKey(plaintext: string, aad: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptWithKey(body: string, aad: string, key: Buffer): string {
  const buf = Buffer.from(body, 'base64');
  // Without this, a too-short input silently yields a truncated authTag
  // slice below, and an unconstrained GCM decipher can accept tag lengths
  // shorter than 16 bytes — weakening auth-tag verification instead of
  // failing outright. `authTagLength` on createDecipheriv (below) then
  // rejects anything but a full-length tag.
  if (buf.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext is too short to contain a valid IV and auth tag');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Encrypts `plaintext`; output is `<version>:<base64(iv + authTag + ciphertext)>`.
 * Always encrypts under the CURRENT key — rotation only ever affects reads.
 *
 * `aad` (associated data) binds the ciphertext to its purpose so a value
 * encrypted for one use (e.g. the short-lived OAuth state cookie) cannot be
 * decrypted as if it were another (e.g. a stored refresh token) even though
 * both currently share the one TOKEN_ENCRYPTION_KEY — see call sites.
 */
export function encryptSecret(plaintext: string, aad: string): string {
  return `${ENVELOPE_VERSION}:${encryptWithKey(plaintext, aad, loadCurrentKey())}`;
}

/**
 * Reverses `encryptSecret`. Throws if the key, `aad`, or payload is
 * invalid/tampered. Tries the current key first; if that fails (wrong key
 * for this ciphertext, not a config problem — see below) and a previous
 * key is configured, falls back to it. Unversioned input (no `v1:` prefix)
 * is treated as pre-rotation legacy ciphertext in the original wire
 * format, so existing rows never need a bulk migration before this change
 * ships.
 *
 * `loadCurrentKey()` is called OUTSIDE the try deliberately: if
 * TOKEN_ENCRYPTION_KEY itself is unset/malformed, that must surface as a
 * `TokenKeyConfigError` immediately, not be silently rescued by a previous
 * key happening to decrypt this particular row — encryptSecret already
 * refuses to write under a broken current key, so reads silently limping
 * along on the previous key alone would only hide a config problem that
 * writes are already failing on. Only a `decryptWithKey` failure (the
 * current key loaded fine, but doesn't decrypt this ciphertext) reaches the
 * previous-key fallback. If loading the PREVIOUS key throws (also a
 * `TokenKeyConfigError` — e.g. a typo made during a rotation), that must
 * propagate as-is rather than being treated as proof the row is dead: see
 * decryptStored() in token-store.ts, which depends on this distinction to
 * avoid destroying every row still on the previous key just because
 * TOKEN_ENCRYPTION_KEY_PREVIOUS was mistyped.
 */
export function decryptSecret(packed: string, aad: string): string {
  const sep = packed.indexOf(':');
  const version = sep === -1 ? null : packed.slice(0, sep);
  const body = version === ENVELOPE_VERSION ? packed.slice(sep + 1) : packed;
  if (version !== null && version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported ciphertext envelope version: ${version}`);
  }
  const currentKey = loadCurrentKey();
  try {
    return decryptWithKey(body, aad, currentKey);
  } catch (err) {
    const previous = loadPreviousKey();
    if (!previous) throw err;
    return decryptWithKey(body, aad, previous);
  }
}

export function isTokenEncryptionConfigured(): boolean {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return false;
  try {
    return Buffer.from(raw, 'base64').length === 32;
  } catch {
    return false;
  }
}
