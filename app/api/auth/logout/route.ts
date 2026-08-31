import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/auth';
import { appBaseUrl } from '@/lib/auth-url';

async function logoutAndRedirect(request: Request) {
  const response = NextResponse.redirect(`${appBaseUrl(request)}/login`, 303);
  await clearSessionCookie(response);
  return response;
}

/** Full-page navigation from <Link href="/api/auth/logout">. */
export async function GET(request: Request) {
  return logoutAndRedirect(request);
}

/** Kept for form POST clients. */
export async function POST(request: Request) {
  return logoutAndRedirect(request);
}
