import { NextResponse } from 'next/server';
import { isSessionConfigured, setSessionCookie } from '@/auth';
import { appBaseUrl } from '@/lib/auth-url';

/**
 * Local-dev-only sign-in, offered when Google OAuth (GOOGLE_CLIENT_ID /
 * GOOGLE_OAUTH_PROJECT_ID) isn't configured. Hard-refuses in production
 * regardless of config, so this can never become a real auth bypass there —
 * it exists purely so /workspace and the Treasury OAuth flow can be
 * exercised locally without real Google platform credentials.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 404 });
  }

  const baseUrl = appBaseUrl(request);
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return NextResponse.redirect(`${baseUrl}/login?error=dev_login_invalid_email`);
  }

  if (!isSessionConfigured()) {
    return NextResponse.redirect(`${baseUrl}/login?error=session_unavailable`);
  }

  // 303, not the redirect() default of 307: this is a POST, and the target
  // is a page route with no POST handler — 307 would preserve the method
  // and re-POST into a 405 instead of rendering the workspace.
  const response = NextResponse.redirect(`${baseUrl}/`, { status: 303 });
  await setSessionCookie(response, { email });
  return response;
}
