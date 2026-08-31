import { NextResponse } from 'next/server';
import { appBaseUrl } from '@/lib/auth-url';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const projectId = process.env.GOOGLE_OAUTH_PROJECT_ID;
  // Platform proxy URL — same in local and production; passed to Google as redirect_uri.
  const proxyRedirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !projectId || !proxyRedirectUri) {
    console.error(
      '[api/auth/login] Missing GOOGLE_CLIENT_ID, GOOGLE_OAUTH_PROJECT_ID, or GOOGLE_REDIRECT_URI',
    );
    return NextResponse.json(
      { error: 'Google OAuth is not configured' },
      { status: 503 },
    );
  }

  // App callback — never read from GOOGLE_REDIRECT_URI.
  const returnUrl = `${appBaseUrl(request)}/api/auth/callback`;
  const state = btoa(JSON.stringify({ projectId, returnUrl }));

  const googleUrl = new URL(GOOGLE_AUTH_URL);
  googleUrl.searchParams.set('client_id', clientId);
  googleUrl.searchParams.set('redirect_uri', proxyRedirectUri);
  googleUrl.searchParams.set('response_type', 'code');
  googleUrl.searchParams.set('scope', 'openid email profile');
  googleUrl.searchParams.set('state', state);

  return NextResponse.redirect(googleUrl);
}
