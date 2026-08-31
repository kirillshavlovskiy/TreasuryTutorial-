import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateCodeVerifier,
  deriveCodeChallenge,
  generateState,
  generateNonce,
  buildAuthorizeUrl,
  isOktaConfigured,
  extractEmailFromIdTokenPayload,
  exchangeCodeForTokens,
  refreshTokens,
  treasuryCanonicalOrigin,
  OktaTokenError,
} from './okta-client';

const ORIGINAL_ENV = { ...process.env };

function setOktaEnv() {
  process.env.OKTA_ISSUER = 'https://deel.okta.com/oauth2/aus119fy0xf85o6eF698';
  process.env.OKTA_CLIENT_ID = 'test-client-id';
  process.env.OKTA_CLIENT_SECRET = 'test-client-secret';
}

/** Typed stand-in for the global fetch, so `mock.calls[0]` destructures cleanly. */
function mockFetch(handler: (url: string | URL, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('treasury/okta-client', () => {
  beforeEach(() => {
    setOktaEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  describe('PKCE / state / nonce', () => {
    it('generates a code_verifier in the RFC 7636 valid length range (43-128 chars)', () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('generates a different verifier on every call', () => {
      expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    });

    it('derives the S256 code_challenge matching the RFC 7636 Appendix B test vector', () => {
      // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      expect(deriveCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('generates a random, non-empty state', () => {
      const a = generateState();
      const b = generateState();
      expect(a.length).toBeGreaterThan(10);
      expect(a).not.toBe(b);
    });

    it('generates a random, non-empty nonce, distinct from state', () => {
      const nonce = generateNonce();
      expect(nonce.length).toBeGreaterThan(10);
      expect(nonce).not.toBe(generateNonce());
    });
  });

  describe('isOktaConfigured', () => {
    it('is true when issuer/client id/secret are all set', () => {
      expect(isOktaConfigured()).toBe(true);
    });

    it('is false when any is missing', () => {
      delete process.env.OKTA_CLIENT_SECRET;
      expect(isOktaConfigured()).toBe(false);
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('includes all required Authorization Code + PKCE + nonce parameters', () => {
      const url = new URL(
        buildAuthorizeUrl({
          state: 'the-state',
          codeChallenge: 'the-challenge',
          redirectUri: 'https://fx-test-project.dp.com/api/treasury/oauth/callback',
          nonce: 'the-nonce',
        }),
      );
      expect(url.origin + url.pathname).toBe(`${process.env.OKTA_ISSUER}/v1/authorize`);
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://fx-test-project.dp.com/api/treasury/oauth/callback',
      );
      expect(url.searchParams.get('state')).toBe('the-state');
      expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('nonce')).toBe('the-nonce');
      // Exact set, not a subset: an extra scope the Authorization Server's access
      // policy rule doesn't list makes the request match no rule, and Okta returns
      // access_denied at /authorize.
      const scopes = url.searchParams.get('scope')?.split(' ') ?? [];
      expect(scopes.sort()).toEqual(['email', 'finance_mcp:access', 'offline_access', 'openid']);
    });
  });

  describe('extractEmailFromIdTokenPayload', () => {
    it('prefers the email claim', () => {
      expect(extractEmailFromIdTokenPayload({ email: 'User@Deel.com', preferred_username: 'other@deel.com' }))
        .toBe('user@deel.com');
    });

    it('falls back to preferred_username when email is absent', () => {
      expect(extractEmailFromIdTokenPayload({ preferred_username: 'fallback@deel.com' }))
        .toBe('fallback@deel.com');
    });

    it('returns null when neither claim is an email-shaped string', () => {
      expect(extractEmailFromIdTokenPayload({ sub: 'not-an-email' })).toBeNull();
      expect(extractEmailFromIdTokenPayload({})).toBeNull();
    });

    it('ignores non-string claim values', () => {
      expect(extractEmailFromIdTokenPayload({ email: 12345 })).toBeNull();
    });
  });

  describe('token exchange (fetch mocked — no live Okta credentials in this environment)', () => {
    it('posts the expected grant_type=authorization_code body and pins client credentials', async () => {
      const fetchMock = mockFetch(() =>
        new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: 'rt',
            id_token: 'idt',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );

      const tokens = await exchangeCodeForTokens({
        code: 'the-code',
        codeVerifier: 'the-verifier',
        redirectUri: 'https://example.com/callback',
      });

      expect(tokens.accessToken).toBe('at');
      expect(tokens.refreshToken).toBe('rt');
      expect(tokens.idToken).toBe('idt');
      expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${process.env.OKTA_ISSUER}/v1/token`);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('the-code');
      expect(body.get('code_verifier')).toBe('the-verifier');
      expect(body.get('client_id')).toBe('test-client-id');
      expect(body.get('client_secret')).toBe('test-client-secret');
    });

    it('throws an OktaTokenError with isInvalidGrant=true on an invalid_grant response', async () => {
      mockFetch(() =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }), {
          status: 400,
        }),
      );

      const err = await exchangeCodeForTokens({ code: 'x', codeVerifier: 'y', redirectUri: 'z' }).catch(e => e);
      expect(err).toBeInstanceOf(OktaTokenError);
      expect(err.message).toMatch(/code expired/);
      expect(err.isInvalidGrant).toBe(true);
    });

    it('throws an OktaTokenError with isInvalidGrant=false on a transient (non-invalid_grant) failure', async () => {
      // e.g. Okta 503 during a degradation — must NOT be treated as a dead refresh token.
      mockFetch(() => new Response(JSON.stringify({}), { status: 503 }));

      const err = await exchangeCodeForTokens({ code: 'x', codeVerifier: 'y', redirectUri: 'z' }).catch(e => e);
      expect(err).toBeInstanceOf(OktaTokenError);
      expect(err.isInvalidGrant).toBe(false);
    });

    it('rejects an initial-exchange response missing refresh_token/id_token (offline_access/openid not granted)', async () => {
      mockFetch(() =>
        new Response(
          JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600 }),
          { status: 200 },
        ),
      );

      await expect(
        exchangeCodeForTokens({ code: 'x', codeVerifier: 'y', redirectUri: 'z' }),
      ).rejects.toThrow(/refresh_token.*id_token/);
    });

    it('refreshTokens posts grant_type=refresh_token with the given refresh token', async () => {
      const fetchMock = mockFetch(() =>
        new Response(
          JSON.stringify({
            access_token: 'at2',
            refresh_token: 'rt2',
            id_token: 'idt2',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );

      await refreshTokens('old-refresh-token');

      const [, init] = fetchMock.mock.calls[0];
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('old-refresh-token');
    });

    it('refreshTokens falls back to the prior refresh token when Okta omits one (rotation off)', async () => {
      mockFetch(() =>
        new Response(
          JSON.stringify({
            access_token: 'at3',
            // no refresh_token in the response — legitimate when AS rotation is disabled
            id_token: 'idt3',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );

      const tokens = await refreshTokens('kept-refresh-token');
      expect(tokens.accessToken).toBe('at3');
      expect(tokens.refreshToken).toBe('kept-refresh-token');
    });
  });

  describe('treasuryCanonicalOrigin', () => {
    it('prefers AUTH_URL over the request origin, stripping a trailing slash', () => {
      process.env.AUTH_URL = 'https://fx-test-project.dp.com/';
      const req = new Request('http://attacker-controlled-host/api/treasury/oauth/connect');
      expect(treasuryCanonicalOrigin(req)).toBe('https://fx-test-project.dp.com');
    });

    it('uses AUTH_URL in production too (the actual production configuration) — does not throw when it is set', () => {
      process.env.AUTH_URL = 'https://fx-test-project.dp.com';
      vi.stubEnv('NODE_ENV', 'production');
      const req = new Request('http://attacker-controlled-host/api/treasury/oauth/connect');
      expect(treasuryCanonicalOrigin(req)).toBe('https://fx-test-project.dp.com');
    });

    it('falls back to the request origin in non-production when AUTH_URL is unset', () => {
      delete process.env.AUTH_URL;
      vi.stubEnv('NODE_ENV', 'test');
      const req = new Request('http://localhost:3000/api/treasury/oauth/connect');
      expect(treasuryCanonicalOrigin(req)).toBe('http://localhost:3000');
    });

    it('throws in production when AUTH_URL is unset, rather than trusting the Host header', () => {
      delete process.env.AUTH_URL;
      vi.stubEnv('NODE_ENV', 'production');
      const req = new Request('http://evil.example/api/treasury/oauth/connect');
      expect(() => treasuryCanonicalOrigin(req)).toThrow(/AUTH_URL/);
    });
  });
});
