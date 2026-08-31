import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as login } from './login/route';
import { GET as callback } from './callback/route';
import { GET as logoutGet, POST as logout } from './logout/route';
import { POST as devLogin } from './dev-login/route';

const ORIGINAL_ENV = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_OAUTH_PROJECT_ID: process.env.GOOGLE_OAUTH_PROJECT_ID,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
};

function devLoginRequest(email: string | null): Request {
  const body = new URLSearchParams();
  if (email !== null) body.set('email', email);
  return new Request('https://app.example/api/auth/dev-login', {
    method: 'POST',
    body,
  });
}

describe('Deel Google OAuth proxy routes', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-session-secret';
    process.env.GOOGLE_CLIENT_ID = 'shared-client';
    process.env.GOOGLE_OAUTH_PROJECT_ID = 'fx-project';
    process.env.GOOGLE_REDIRECT_URI =
      'https://login.dp.com/api/gcp-oauth/callback';
    delete process.env.NEXTAUTH_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds the Google URL with proxy redirect and app callback in state', async () => {
    const response = await login(new Request('http://localhost:3000/api/auth/login'));
    const location = new URL(response.headers.get('location')!);

    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('client_id')).toBe('shared-client');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://login.dp.com/api/gcp-oauth/callback',
    );
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect([...location.searchParams.keys()].sort()).toEqual(
      ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'].sort(),
    );

    const state = JSON.parse(atob(location.searchParams.get('state')!));
    expect(state).toEqual({
      projectId: 'fx-project',
      returnUrl: 'http://localhost:3000/api/auth/callback',
    });
  });

  it('uses NEXTAUTH_URL for returnUrl when set', async () => {
    process.env.NEXTAUTH_URL = 'https://fx-test-project.dp.com';
    const response = await login(new Request('http://localhost:3000/api/auth/login'));
    const location = new URL(response.headers.get('location')!);
    const state = JSON.parse(atob(location.searchParams.get('state')!));
    expect(state.returnUrl).toBe(
      'https://fx-test-project.dp.com/api/auth/callback',
    );
  });

  it('refuses to fall back to a forwarded host in production when NEXTAUTH_URL is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      login(
        new Request('http://localhost:3000/api/auth/login', {
          headers: { 'x-forwarded-host': 'evil.example' },
        }),
      ),
    ).rejects.toThrow(/NEXTAUTH_URL/);
    vi.unstubAllEnvs();
  });

  it('creates a signed session from the proxy JWT payload', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        email: 'user@deel.com',
        name: 'Deel User',
        picture: 'https://example.com/user.png',
      }),
    ).toString('base64url');
    const response = await callback(
      new Request(`https://app.example/api/auth/callback?token=x.${payload}.y`),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example/');
    expect(response.headers.get('set-cookie')).toContain('fx-workbench-session=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('falls back to proxy query parameters and rejects a missing email', async () => {
    const success = await callback(
      new Request(
        'https://app.example/api/auth/callback'
          + '?gcp_user_email=user%40deel.com&gcp_user_name=Deel%20User',
      ),
    );
    expect(success.headers.get('location')).toBe('https://app.example/');

    const failure = await callback(
      new Request('https://app.example/api/auth/callback'),
    );
    expect(failure.headers.get('location')).toBe(
      'https://app.example/login?error=auth_failed',
    );
  });

  it('returns the user to the forwarded host (ingress alias)', async () => {
    const response = await callback(
      new Request(
        'http://10.0.0.5:3000/api/auth/callback?gcp_user_email=user%40deel.com',
        {
          headers: {
            'x-forwarded-host': 'ssigma.dp.com',
            'x-forwarded-proto': 'https',
          },
        },
      ),
    );
    expect(response.headers.get('location')).toBe('https://ssigma.dp.com/');
    expect(response.headers.get('set-cookie')).toContain('fx-workbench-session=');
  });

  it('refuses to trust a forwarded host in production when NEXTAUTH_URL is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      callback(
        new Request(
          'http://10.0.0.5:3000/api/auth/callback?gcp_user_email=user%40deel.com',
          { headers: { 'x-forwarded-host': 'evil.example' } },
        ),
      ),
    ).rejects.toThrow(/NEXTAUTH_URL/);
    vi.unstubAllEnvs();
  });

  it('redirects to login instead of 500 when AUTH_SECRET is missing', async () => {
    delete process.env.AUTH_SECRET;
    const response = await callback(
      new Request(
        'https://ssigma.dp.com/api/auth/callback?gcp_user_email=user%40deel.com',
      ),
    );
    expect(response.headers.get('location')).toBe(
      'https://ssigma.dp.com/login?error=session_unavailable',
    );
  });

  it('clears the cookie and redirects logout to login', async () => {
    const response = await logout(
      new Request('https://app.example/api/auth/logout', { method: 'POST' }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://app.example/login');
    expect(response.headers.get('set-cookie')).toContain(
      'fx-workbench-session=;',
    );
  });

  it('supports GET logout for link navigation', async () => {
    const response = await logoutGet(
      new Request('https://app.example/api/auth/logout'),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://app.example/login');
  });

  describe('dev-login (local-only Google-auth fallback)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('refuses in production regardless of config', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const response = await devLogin(devLoginRequest('user@deel.com'));
      expect(response.status).toBe(404);
    });

    it('rejects a missing or malformed email', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const missing = await devLogin(devLoginRequest(null));
      expect(missing.headers.get('location')).toBe(
        'https://app.example/login?error=dev_login_invalid_email',
      );

      const malformed = await devLogin(devLoginRequest('not-an-email'));
      expect(malformed.headers.get('location')).toBe(
        'https://app.example/login?error=dev_login_invalid_email',
      );
    });

    it('redirects to login instead of throwing when AUTH_SECRET is missing', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      delete process.env.AUTH_SECRET;
      const response = await devLogin(devLoginRequest('user@deel.com'));
      expect(response.headers.get('location')).toBe(
        'https://app.example/login?error=session_unavailable',
      );
    });

    it('sets a signed session cookie and redirects to / with 303 (not 307)', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const response = await devLogin(devLoginRequest('User@Deel.com'));
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://app.example/');
      expect(response.headers.get('set-cookie')).toContain('fx-workbench-session=');
      expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    });
  });
});
