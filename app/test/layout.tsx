import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';
import { auth, signIn } from '@/auth';
import { BrandMark } from '@/components/BrandMark';
import { ModeNav } from '@/components/ModeNav';
import { UserAvatarMenu } from '@/components/UserAvatarMenu';
import { isTestModeEnabled, TEST_GUEST_EMAIL } from '@/lib/test-mode/enabled';

function isAuthenticatedUser(session: Session | null): boolean {
  const user = session?.user;
  if (!user) return false;
  if ((user as { isTestGuest?: boolean }).isTestGuest) return false;
  if (user.email === TEST_GUEST_EMAIL) return false;
  return true;
}

export default async function TestLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isTestModeEnabled()) {
    redirect('/');
  }

  const session = await auth();
  if (!isAuthenticatedUser(session)) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
        <TestBanner />
        <header className="border-b border-slate-800">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
            <BrandMark href="/" label="Treasury Workbench Practice" />
            <ModeNav sandboxEnabled />
          </div>
        </header>
        <main className="mx-auto flex max-w-lg flex-col items-center px-6 py-24 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Treasury Workbench Practice</h1>
          <p className="mt-3 text-sm text-slate-400">
            Sign in with your Google account to access the practice sandbox and Sigma Tasks.
          </p>
          <form
            action={async () => {
              'use server';
              await signIn('google', { redirectTo: '/test' });
            }}
            className="mt-8"
          >
            <button
              type="submit"
              className="inline-flex items-center gap-3 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-slate-800 shadow-lg transition-colors hover:bg-slate-100"
            >
              <GoogleIcon />
              Sign in with Google
            </button>
          </form>
          <Link href="/" className="mt-6 text-sm text-slate-400 hover:text-slate-200">
            ← Back to home
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <TestBanner />
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <BrandMark href="/" label="Treasury Workbench Practice" />
          <div className="flex flex-wrap items-center gap-3">
            <ModeNav sandboxEnabled />
            <UserAvatarMenu
              name={session!.user?.name}
              email={session!.user?.email}
              image={session!.user?.image}
              sandboxEnabled
            />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

function TestBanner() {
  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 text-center text-xs font-medium text-amber-200">
      Practice environment — sample data
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
