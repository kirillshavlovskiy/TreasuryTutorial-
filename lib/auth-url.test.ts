import { describe, expect, it, afterEach } from 'vitest';
import { appBaseUrl } from './auth-url';

describe('appBaseUrl', () => {
  const original = process.env.NEXTAUTH_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = original;
  });

  it('prefers NEXTAUTH_URL when set', () => {
    process.env.NEXTAUTH_URL = 'https://fx-test-project.dp.com/';
    const req = new Request('http://127.0.0.1:3000/api/auth/login');
    expect(appBaseUrl(req)).toBe('https://fx-test-project.dp.com');
  });

  it('uses x-forwarded headers when NEXTAUTH_URL is unset', () => {
    delete process.env.NEXTAUTH_URL;
    const req = new Request('http://10.0.0.1:3000/api/auth/login', {
      headers: {
        'x-forwarded-host': 'ssigma.dp.com',
        'x-forwarded-proto': 'https',
      },
    });
    expect(appBaseUrl(req)).toBe('https://ssigma.dp.com');
  });

  it('falls back to request origin', () => {
    delete process.env.NEXTAUTH_URL;
    const req = new Request('http://localhost:3000/api/auth/login');
    expect(appBaseUrl(req)).toBe('http://localhost:3000');
  });
});
