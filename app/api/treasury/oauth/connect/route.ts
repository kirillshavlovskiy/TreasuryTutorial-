import { NextResponse } from 'next/server';
import { getServerSession } from '@/auth';
import { AAD_OAUTH_STATE_COOKIE, encryptSecret, isTokenEncryptionConfigured } from '@/lib/treasury/crypto';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
  isOktaConfigured,
  treasuryCanonicalOrigin,
  TREASURY_OAUTH_STATE_COOKIE,
  TREASURY_OAUTH_STATE_COOKIE_PATH,
  TREASURY_OAUTH_STATE_TTL_SECONDS,
} from '@/lib/treasury/okta-client';

export const runtime = 'nodejs';

/** GET — start the Treasury OAuth Authorization Code + PKCE flow.
 *  Requires an existing Nexus (Google) session; additive to it, never
 *  touches auth.ts. See app/api/treasury/oauth/callback/route.ts. */
export async function GET(request: Request) {
  const session = await getServerSession();
  const email = session?.user?.email?.trim();
  if (!email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isOktaConfigured() || !isTokenEncryptionConfigured()) {
    return NextResponse.json({ error: 'Treasury OAuth is not configured' }, { status: 501 });
  }

  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const nonce = generateNonce();
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  const redirectUri = new URL('/api/treasury/oauth/callback', treasuryCanonicalOrigin(request)).toString();

  const authorizeUrl = buildAuthorizeUrl({ state, codeChallenge, redirectUri, nonce });

  console.info('[treasury/oauth/connect] initiating link', { email, at: new Date().toISOString() });
  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(
    TREASURY_OAUTH_STATE_COOKIE,
    encryptSecret(
      JSON.stringify({ state, codeVerifier, nonce, email: email.toLowerCase() }),
      AAD_OAUTH_STATE_COOKIE,
    ),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: TREASURY_OAUTH_STATE_TTL_SECONDS,
      path: TREASURY_OAUTH_STATE_COOKIE_PATH,
    },
  );
  return response;
}
