/**
 * Public origin for OAuth returnUrl and post-login redirects.
 * Prefers NEXTAUTH_URL. Falling back to the client-controlled
 * X-Forwarded-Host header behind an untrusted proxy would let a spoofed
 * header redirect a real Google/platform-proxy hand-off (containing a
 * verified user's identity) to an attacker-chosen host — mirroring
 * treasuryCanonicalOrigin's SSRF/open-redirect guard, this throws instead of
 * falling back once NODE_ENV=production. Local dev without NEXTAUTH_URL set
 * still falls back, since there's no untrusted proxy in front of it.
 */
export function appBaseUrl(request: Request): string {
  const configured = process.env.NEXTAUTH_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXTAUTH_URL must be configured in production for auth redirects');
  }

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  if (forwardedHost) {
    const proto =
      request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    return `${proto}://${forwardedHost}`;
  }

  return new URL(request.url).origin.replace(/\/+$/, '');
}
