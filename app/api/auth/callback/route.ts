import { NextResponse } from 'next/server';
import { isSessionConfigured, setSessionCookie, type SessionData } from '@/auth';
import { appBaseUrl } from '@/lib/auth-url';

type UserClaims = {
  email?: unknown;
  name?: unknown;
  picture?: unknown;
  gcp_user_email?: unknown;
  gcp_user_name?: unknown;
  gcp_user_picture?: unknown;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function userFromClaims(claims: UserClaims): SessionData | null {
  const email = optionalString(claims.gcp_user_email)
    ?? optionalString(claims.email);
  if (!email) return null;

  const name = optionalString(claims.gcp_user_name)
    ?? optionalString(claims.name);
  const picture = optionalString(claims.gcp_user_picture)
    ?? optionalString(claims.picture);
  return {
    email,
    ...(name ? { name } : {}),
    ...(picture ? { picture } : {}),
  };
}

function userFromToken(token: string): SessionData | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UserClaims;
    return userFromClaims(claims);
  } catch {
    return null;
  }
}

function userFromQuery(searchParams: URLSearchParams): SessionData | null {
  return userFromClaims({
    gcp_user_email: searchParams.get('gcp_user_email'),
    gcp_user_name: searchParams.get('gcp_user_name'),
    gcp_user_picture: searchParams.get('gcp_user_picture'),
    email: searchParams.get('email'),
    name: searchParams.get('name'),
    picture: searchParams.get('picture'),
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl = appBaseUrl(request);
  const token = url.searchParams.get('token');
  const user = (token ? userFromToken(token) : null)
    ?? userFromQuery(url.searchParams);

  if (!user) {
    return NextResponse.redirect(`${baseUrl}/login?error=auth_failed`);
  }

  if (!isSessionConfigured()) {
    console.error('[api/auth/callback] AUTH_SECRET is not set — cannot sign the session cookie');
    return NextResponse.redirect(`${baseUrl}/login?error=session_unavailable`);
  }

  const response = NextResponse.redirect(`${baseUrl}/`);
  try {
    await setSessionCookie(response, user);
  } catch (err) {
    console.error('[api/auth/callback] failed to set session cookie', err);
    return NextResponse.redirect(`${baseUrl}/login?error=session_unavailable`);
  }
  return response;
}
