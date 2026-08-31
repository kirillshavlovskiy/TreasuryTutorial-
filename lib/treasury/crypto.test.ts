import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  AAD_TREASURY_TOKEN,
  AAD_OAUTH_STATE_COOKIE,
  encryptSecret,
  decryptSecret,
  isTokenEncryptionConfigured,
  TokenKeyConfigError,
} from './crypto';

const ORIGINAL_KEY = process.env.TOKEN_ENCRYPTION_KEY;
const ORIGINAL_PREVIOUS_KEY = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;

function restoreEnvVar(name: string, original: string | undefined) {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

describe('treasury/crypto', () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  });

  afterEach(() => {
    restoreEnvVar('TOKEN_ENCRYPTION_KEY', ORIGINAL_KEY);
    restoreEnvVar('TOKEN_ENCRYPTION_KEY_PREVIOUS', ORIGINAL_PREVIOUS_KEY);
  });

  it('round-trips plaintext through encrypt then decrypt with matching AAD', () => {
    const plaintext = 'a-treasury-access-token.with.dots';
    expect(decryptSecret(encryptSecret(plaintext, AAD_TREASURY_TOKEN), AAD_TREASURY_TOKEN)).toBe(plaintext);
  });

  it('produces a different ciphertext each call for the same plaintext (random IV)', () => {
    const a = encryptSecret('same-input', AAD_TREASURY_TOKEN);
    const b = encryptSecret('same-input', AAD_TREASURY_TOKEN);
    expect(a).not.toBe(b);
  });

  it('tags output with the envelope version', () => {
    expect(encryptSecret('x', AAD_TREASURY_TOKEN)).toMatch(/^v1:/);
  });

  it('rejects a tampered ciphertext (auth tag check fails)', () => {
    const packed = encryptSecret('sensitive-token', AAD_TREASURY_TOKEN);
    const [version, body] = packed.split(':');
    const buf = Buffer.from(body!, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a bit in the ciphertext tail
    const tampered = `${version}:${buf.toString('base64')}`;
    expect(() => decryptSecret(tampered, AAD_TREASURY_TOKEN)).toThrow();
  });

  it('rejects an unrecognized envelope version rather than guessing a format', () => {
    const packed = encryptSecret('sensitive-token', AAD_TREASURY_TOKEN);
    const body = packed.split(':')[1];
    expect(() => decryptSecret(`v99:${body}`, AAD_TREASURY_TOKEN)).toThrow(/version/i);
  });

  it('still decrypts pre-versioning legacy ciphertext (no "v1:" prefix)', () => {
    const packed = encryptSecret('sensitive-token', AAD_TREASURY_TOKEN);
    const legacyBody = packed.split(':')[1]!;
    expect(decryptSecret(legacyBody, AAD_TREASURY_TOKEN)).toBe('sensitive-token');
  });

  it('key rotation: decrypts old rows via the previous key while writing new ones under the current key', () => {
    const oldKey = process.env.TOKEN_ENCRYPTION_KEY!;
    const encryptedUnderOldKey = encryptSecret('rotate-me', AAD_TREASURY_TOKEN);

    // Rotate: old key moves to _PREVIOUS, a fresh key becomes current.
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = oldKey;
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');

    expect(decryptSecret(encryptedUnderOldKey, AAD_TREASURY_TOKEN)).toBe('rotate-me');

    // New writes use only the current key — the previous key is read-only fallback.
    const encryptedAfterRotation = encryptSecret('freshly-written', AAD_TREASURY_TOKEN);
    delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
    expect(decryptSecret(encryptedAfterRotation, AAD_TREASURY_TOKEN)).toBe('freshly-written');
  });

  it('fails closed when neither the current nor previous key can decrypt', () => {
    const packed = encryptSecret('sensitive-token', AAD_TREASURY_TOKEN);
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = randomBytes(32).toString('base64');
    expect(() => decryptSecret(packed, AAD_TREASURY_TOKEN)).toThrow();
  });

  it('a malformed TOKEN_ENCRYPTION_KEY_PREVIOUS surfaces as TokenKeyConfigError, not a generic decrypt failure', () => {
    // Regression: this must be distinguishable from "the row is dead" so
    // token-store.ts's decryptStored() can keep the row instead of
    // destroying it over what is actually an operator typo during rotation.
    const oldKey = process.env.TOKEN_ENCRYPTION_KEY!;
    const encryptedUnderOldKey = encryptSecret('rotate-me', AAD_TREASURY_TOKEN);

    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = 'not-32-bytes';
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    void oldKey; // the row now needs the (broken) previous key to decrypt

    let caught: unknown;
    try {
      decryptSecret(encryptedUnderOldKey, AAD_TREASURY_TOKEN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TokenKeyConfigError);
  });

  it('does not silently decrypt via the previous key when the current key itself is unset (fails closed, not open)', () => {
    const validPrevious = process.env.TOKEN_ENCRYPTION_KEY!;
    const encryptedUnderPrevious = encryptSecret('should-not-be-readable', AAD_TREASURY_TOKEN);

    process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = validPrevious;
    delete process.env.TOKEN_ENCRYPTION_KEY;

    let caught: unknown;
    try {
      decryptSecret(encryptedUnderPrevious, AAD_TREASURY_TOKEN);
    } catch (err) {
      caught = err;
    }
    // Must be the current-key config error, not a decrypted value and not
    // some other error masked by a previous-key attempt that shouldn't
    // have been reached at all.
    expect(caught).toBeInstanceOf(TokenKeyConfigError);
  });

  it('rejects a ciphertext too short to contain a valid IV and auth tag, rather than accepting a truncated tag', () => {
    expect(() => decryptSecret('v1:dG9vLXNob3J0', AAD_TREASURY_TOKEN)).toThrow(/too short/i);
  });

  it('fails to decrypt with the wrong key', () => {
    const packed = encryptSecret('sensitive-token', AAD_TREASURY_TOKEN);
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decryptSecret(packed, AAD_TREASURY_TOKEN)).toThrow();
  });

  it('fails to decrypt a value encrypted under a different AAD purpose', () => {
    // Proves the OAuth state cookie and the stored tokens are not
    // cross-decryptable even though both use TOKEN_ENCRYPTION_KEY.
    const packed = encryptSecret('stolen-cookie-payload', AAD_OAUTH_STATE_COOKIE);
    expect(() => decryptSecret(packed, AAD_TREASURY_TOKEN)).toThrow();
  });

  it('throws a clear error when TOKEN_ENCRYPTION_KEY is unset', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSecret('x', AAD_TREASURY_TOKEN)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('throws when TOKEN_ENCRYPTION_KEY does not decode to 32 bytes', () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    expect(() => encryptSecret('x', AAD_TREASURY_TOKEN)).toThrow(/32 bytes/);
  });

  describe('isTokenEncryptionConfigured', () => {
    it('is true for a valid 32-byte base64 key', () => {
      expect(isTokenEncryptionConfigured()).toBe(true);
    });

    it('is false when unset', () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;
      expect(isTokenEncryptionConfigured()).toBe(false);
    });

    it('is false for a malformed key', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'not-base64-!!!';
      expect(isTokenEncryptionConfigured()).toBe(false);
    });
  });
});
