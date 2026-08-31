import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { BrandMark } from '@/components/BrandMark';

/** GOOGLE_CLIENT_ID / GOOGLE_OAUTH_PROJECT_ID are deprecated as a hard
 *  requirement for local dev — see app/api/auth/dev-login/route.ts for the
 *  NODE_ENV-gated fallback used when they're unset. Production deployments
 *  still need them; this only relaxes the local dev-loop. */
function isGoogleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_OAUTH_PROJECT_ID?.trim(),
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await auth()) redirect('/');
  const { error } = await searchParams;
  const googleConfigured = isGoogleConfigured();
  const devLoginAvailable = !googleConfigured && process.env.NODE_ENV !== 'production';

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <section className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/70 p-8 text-center shadow-xl">
        <div className="flex justify-center">
          <BrandMark href="/" label="Treasury Workbench" />
        </div>
        <h1 className="mt-8 text-2xl font-semibold">Sign in</h1>
        <p className="mt-3 text-sm text-slate-400">
          Continue through the Deel Google login platform.
        </p>
        {error && (
          <p className="mt-5 rounded-lg border border-rose-800/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {error === 'session_unavailable'
              ? 'Sign-in succeeded but the session could not be created. This environment is missing AUTH_SECRET.'
              : error === 'dev_login_invalid_email'
                ? 'Enter a valid email to continue.'
                : 'Authentication failed. Please try again.'}
          </p>
        )}
        {googleConfigured ? (
          <Link
            href="/api/auth/login"
            className="mt-7 inline-flex w-full items-center justify-center rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100"
          >
            Sign in with Google
          </Link>
        ) : devLoginAvailable ? (
          <form action="/api/auth/dev-login" method="post" className="mt-7 space-y-3 text-left">
            <p className="text-center text-xs font-medium uppercase tracking-wide text-amber-400">
              Dev-only sign-in — GOOGLE_CLIENT_ID / GOOGLE_OAUTH_PROJECT_ID are unset
            </p>
            <input
              type="email"
              name="email"
              required
              placeholder="you@deel.com"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
            />
            <button
              type="submit"
              className="w-full rounded-lg bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100"
            >
              Continue (dev)
            </button>
          </form>
        ) : (
          <p className="mt-7 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-400">
            Google OAuth is not configured in this environment.
          </p>
        )}
        <Link href="/" className="mt-5 inline-block text-sm text-slate-400 hover:text-slate-200">
          Back to home
        </Link>
      </section>
    </main>
  );
}
