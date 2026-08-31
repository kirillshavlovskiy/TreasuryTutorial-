import { randomBytes, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * Server-to-server OAuth 2.0 Authorization Code + PKCE client for the
 * Treasury "Treasury MCP" Okta Authorization Server. This app is registered
 * as its own confidential (Web) OIDC client under that SAME Authorization
 * Server — same issuer/audience the Finance MCP server already verifies
 * access tokens against (see Treasury's verifyFinanceMcpBearerToken). No
 * changes to Treasury are required: it does not check client_id/cid on the
 * presented token, only iss/aud/signature.
 *
 * This flow is additive to the existing Google sign-in (auth.ts) — it never
 * touches NextAuth. A user must already have a Nexus session before starting
 * it; see app/api/treasury/oauth/connect/route.ts.
 */

/** Requested scopes. Must stay a subset of what the "Treasury MCP" Authorization
 *  Server's access policy rule lists: a request carrying a scope the rule does not
 *  cover matches no rule at all, and Okta answers `access_denied` at /authorize
 *  without naming the offending scope. `profile` was exactly that — requested here,
 *  absent from the rule — and nothing in this app reads a profile claim (only
 *  `email`, see extractEmailFromIdTokenPayload). */
const SCOPES = ['openid', 'email', 'offline_access', 'finance_mcp:access'];
const FETCH_TIMEOUT_MS = 10_000;

/** Shared between the connect and callback route handlers — kept out of
 *  route.ts files since Next.js only allows a fixed export set there.
 *  `TREASURY_OAUTH_STATE_COOKIE_PATH` must be passed to both `.set()` (on
 *  connect) and `.delete()` (on callback) — a delete with no `path` targets
 *  `Path=/` and silently fails to remove a cookie scoped to a narrower path. */
export const TREASURY_OAUTH_STATE_COOKIE = 'treasury_oauth_state';
export const TREASURY_OAUTH_STATE_COOKIE_PATH = '/api/treasury/oauth';
export const TREASURY_OAUTH_STATE_TTL_SECONDS = 600;

/**
 * Canonical origin for building redirect_uri/Location URLs. Prefers AUTH_URL
 * (the app's own already-established canonical origin — see .env.example)
 * over deriving from the request, since `request.url` in a Next.js Route
 * Handler is reconstructed from the client-controlled Host/X-Forwarded-Host
 * header and building redirects from it risks an open redirect and/or a
 * redirect_uri Okta's exact-match allowlist rejects behind a proxy.
 *
 * Falling back to the request-derived origin when AUTH_URL is unset would
 * silently reopen exactly that risk, so — mirroring Treasury's own
 * `getBaseUrl()` SSRF guard for the same class of problem — this throws
 * instead of falling back once `NODE_ENV=production`. Local dev without
 * AUTH_URL set still falls back, since there's no untrusted proxy in front
 * of it.
 */
export function treasuryCanonicalOrigin(request: Request): string {
  const configured = process.env.AUTH_URL?.trim().replace(/\/$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_URL must be configured in production for Treasury OAuth redirects');
  }
  return new URL(request.url).origin;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function issuer(): string {
  return requireEnv('OKTA_ISSUER').replace(/\/$/, '');
}

export function isOktaConfigured(): boolean {
  return Boolean(
    process.env.OKTA_ISSUER?.trim() &&
      process.env.OKTA_CLIENT_ID?.trim() &&
      process.env.OKTA_CLIENT_SECRET?.trim(),
  );
}

/** Cryptographically random, URL-safe PKCE code_verifier (RFC 7636, 43-128 chars). */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

/** S256 code_challenge derived from a code_verifier. */
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

/** OIDC nonce — binds the id_token to this specific authorize request, on
 *  top of (not instead of) the PKCE/state/session-email checks that already
 *  gate identity linking; defense-in-depth against SSO re-linking silently
 *  reusing a stale/replayed id_token. */
export function generateNonce(): string {
  return randomBytes(24).toString('base64url');
}

export function buildAuthorizeUrl(params: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  nonce: string;
}): string {
  const url = new URL(`${issuer()}/v1/authorize`);
  url.searchParams.set('client_id', requireEnv('OKTA_CLIENT_ID'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('nonce', params.nonce);
  return url.toString();
}

const sharedTokenFields = {
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
};
// The initial code exchange must yield a refresh_token (offline_access was requested).
const initialTokenResponseSchema = z.object({ ...sharedTokenFields, refresh_token: z.string().min(1) });
// Okta only returns a new refresh_token on refresh when rotation is enabled on the
// Authorization Server — a config this app doesn't own (it rides Treasury's existing
// "Treasury MCP" AS). Treat it as optional here and keep the prior one when absent.
const refreshTokenResponseSchema = z.object({ ...sharedTokenFields, refresh_token: z.string().min(1).optional() });

export interface TreasuryTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: Date;
}

/**
 * Thrown by postToken(). `oktaErrorCode` carries Okta's OAuth `error` field
 * when the response body had one — used by token-store.ts to tell "this
 * refresh token is genuinely dead" (invalid_grant) apart from a transient
 * failure (network blip, timeout, Okta 5xx/429) that says nothing about the
 * refresh token's validity and must NOT cause it to be deleted.
 */
export class OktaTokenError extends Error {
  readonly oktaErrorCode?: string;
  constructor(message: string, oktaErrorCode?: string) {
    super(message);
    this.name = 'OktaTokenError';
    this.oktaErrorCode = oktaErrorCode;
  }
  get isInvalidGrant(): boolean {
    return this.oktaErrorCode === 'invalid_grant';
  }
}

async function postToken(
  body: URLSearchParams,
  opts: { fallbackRefreshToken?: string } = {},
): Promise<TreasuryTokens> {
  body.set('client_id', requireEnv('OKTA_CLIENT_ID'));
  body.set('client_secret', requireEnv('OKTA_CLIENT_SECRET'));

  const res = await fetch(`${issuer()}/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const raw: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const errBody = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const description =
      typeof errBody.error_description === 'string' ? errBody.error_description : `HTTP ${res.status}`;
    const code = typeof errBody.error === 'string' ? errBody.error : undefined;
    throw new OktaTokenError(`Okta token request failed: ${description}`, code);
  }

  const schema = opts.fallbackRefreshToken !== undefined ? refreshTokenResponseSchema : initialTokenResponseSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Okta token response missing required fields (refresh_token/id_token) — was offline_access/openid scope granted?');
  }

  const refreshToken = parsed.data.refresh_token ?? opts.fallbackRefreshToken;
  if (!refreshToken) {
    // Unreachable given the schema split above, but keeps the return type honest.
    throw new Error('Okta token response has no refresh_token and no prior one to fall back to');
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken,
    idToken: parsed.data.id_token,
    expiresAt: new Date(Date.now() + parsed.data.expires_in * 1000),
  };
}

export function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TreasuryTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });
  return postToken(body);
}

export function refreshTokens(refreshToken: string): Promise<TreasuryTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return postToken(body, { fallbackRefreshToken: refreshToken });
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksIssuer: string | null = null;

function getJwks() {
  const currentIssuer = issuer();
  if (!jwks || jwksIssuer !== currentIssuer) {
    jwks = createRemoteJWKSet(new URL(`${currentIssuer}/v1/keys`));
    jwksIssuer = currentIssuer;
  }
  return jwks;
}

/** Pure claim-extraction, mirroring Treasury's own emailFromJwtPayload precedence. */
export function extractEmailFromIdTokenPayload(payload: Record<string, unknown>): string | null {
  const email = [payload.email, payload.preferred_username].find(
    (v): v is string => typeof v === 'string' && v.includes('@'),
  );
  return email ? email.trim().toLowerCase() : null;
}

/**
 * Verifies the id_token's signature/issuer/audience/nonce and returns the
 * authenticated email — used to confirm the Okta identity matches the
 * signed-in Nexus (Google) session before persisting a Treasury token link.
 */
export async function verifyIdTokenEmail(idToken: string, expectedNonce: string): Promise<string> {
  const { payload } = await jwtVerify(idToken, getJwks(), {
    issuer: issuer(),
    audience: requireEnv('OKTA_CLIENT_ID'),
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error('Okta id_token nonce does not match the authorize request');
  }

  const email = extractEmailFromIdTokenPayload(payload);
  if (!email) {
    throw new Error('Okta id_token has no email claim');
  }
  return email;
}
