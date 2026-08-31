import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { AAD_OAUTH_STATE_COOKIE, decryptSecret } from '@/lib/treasury/crypto';
import {
  exchangeCodeForTokens,
  treasuryCanonicalOrigin,
  verifyIdTokenEmail,
  TREASURY_OAUTH_STATE_COOKIE,
  TREASURY_OAUTH_STATE_COOKIE_PATH,
} from '@/lib/treasury/okta-client';
import { saveTreasuryTokens } from '@/lib/treasury/token-store';

export const runtime = 'nodejs';

const statePayloadShape = (
  value: unknown,
): value is { state: string; codeVerifier: string; nonce: string; email: string } =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as Record<string, unknown>).state === 'string' &&
  typeof (value as Record<string, unknown>).codeVerifier === 'string' &&
  typeof (value as Record<string, unknown>).nonce === 'string' &&
  typeof (value as Record<string, unknown>).email === 'string';

function redirectClearingState(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, treasuryCanonicalOrigin(request)));
  // Must match the `path` the cookie was set with (connect/route.ts) —
  // .delete() with no options targets Path=/ and silently fails to remove
  // a cookie scoped to a narrower path.
  response.cookies.delete({ name: TREASURY_OAUTH_STATE_COOKIE, path: TREASURY_OAUTH_STATE_COOKIE_PATH });
  return response;
}

function failure(request: NextRequest, reason: string): NextResponse {
  console.warn('[treasury/oauth/callback] rejected', { reason });
  return redirectClearingState(request, '/workspace?treasury=error');
}

/** GET — Okta redirects here with `code`/`state` (or `error`) after the user
 *  approves. Verifies state, exchanges the code, confirms the Okta identity
 *  matches the signed-in Nexus session, then persists the tokens. */
export async function GET(request: NextRequest) {
  const session = await auth();
  const sessionEmail = session?.user?.email?.trim().toLowerCase();
  if (!sessionEmail) {
    // No Nexus session to link to — clear any pending state cookie too, so
    // an expired-session abandonment doesn't leave it alive for its full TTL.
    return redirectClearingState(request, '/');
  }

  const oktaError = request.nextUrl.searchParams.get('error');
  if (oktaError) return failure(request, `okta_error:${oktaError}`);

  const code = request.nextUrl.searchParams.get('code');
  const returnedState = request.nextUrl.searchParams.get('state');
  const cookieValue = request.cookies.get(TREASURY_OAUTH_STATE_COOKIE)?.value;
  if (!code || !returnedState || !cookieValue) return failure(request, 'missing_params');

  let statePayload: { state: string; codeVerifier: string; nonce: string; email: string };
  try {
    const decoded: unknown = JSON.parse(decryptSecret(cookieValue, AAD_OAUTH_STATE_COOKIE));
    if (!statePayloadShape(decoded)) return failure(request, 'bad_state_shape');
    statePayload = decoded;
  } catch {
    return failure(request, 'bad_state_cookie');
  }

  // `state` is single-use and consumed immediately below regardless of
  // outcome, so a non-constant-time comparison here is not a timing risk.
  if (statePayload.state !== returnedState) return failure(request, 'state_mismatch');
  if (statePayload.email !== sessionEmail) return failure(request, 'session_mismatch');

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: statePayload.codeVerifier,
      redirectUri: new URL('/api/treasury/oauth/callback', treasuryCanonicalOrigin(request)).toString(),
    });
  } catch (err) {
    console.error('[treasury/oauth/callback] token exchange failed', err);
    return failure(request, 'token_exchange_failed');
  }

  let oktaEmail: string;
  try {
    oktaEmail = await verifyIdTokenEmail(tokens.idToken, statePayload.nonce);
  } catch (err) {
    console.error('[treasury/oauth/callback] id_token verification failed', err);
    return failure(request, 'id_token_invalid');
  }

  if (oktaEmail !== sessionEmail) {
    // The Okta identity that completed the flow isn't the signed-in Nexus
    // user — refuse to link Treasury access to the wrong account.
    return failure(request, 'identity_mismatch');
  }

  try {
    await saveTreasuryTokens(sessionEmail, tokens);
  } catch (err) {
    console.error('[treasury/oauth/callback] failed to persist tokens', err);
    return failure(request, 'persist_failed');
  }

  console.info('[treasury/oauth/callback] link established', {
    email: sessionEmail,
    at: new Date().toISOString(),
  });
  return redirectClearingState(request, '/workspace?treasury=connected');
}
