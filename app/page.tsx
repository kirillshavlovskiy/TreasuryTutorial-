import Link from 'next/link';
import { auth, signIn } from '@/auth';
import { BrandMark } from '@/components/BrandMark';
import { isTestModeEnabled } from '@/lib/test-mode/enabled';

const CAPABILITIES: { title: string; description: string; icon: string }[] = [
  {
    title: 'FX Desk',
    description:
      'Model FX cash buffers across a multi-currency portfolio in real time, with USD NP and local-book positions driving live buffer requirements.',
    icon: '📊',
  },
  {
    title: 'Sensitivity Analysis',
    description:
      'Stress buffers against payout volatility (σ_P) and holding horizons to find the efficient trade-off between coverage and idle cash.',
    icon: '📈',
  },
  {
    title: 'Layered Buffer Analysis',
    description:
      'Compose buffers from toggleable layers — volatility, carry optimisation, floor hedge and portfolio diversification — against a VaR policy limit.',
    icon: '🧱',
  },
  {
    title: 'Interest-Rate Profile',
    description:
      'Track USD carry and per-currency interest-rate profiles to quantify the funding cost of every buffer decision.',
    icon: '💵',
  },
  {
    title: 'Hedging Decision Support',
    description:
      'Evaluate swap overlays and hedging actions with clear, policy-aligned recommendations for the FX team.',
    icon: '🛡️',
  },
  {
    title: 'Portfolio VaR Controls',
    description:
      'Set a portfolio Value-at-Risk limit that flows through every calculation, keeping buffers inside Treasury policy at all times.',
    icon: '🎯',
  },
];

export default async function LandingPage() {
  const session = await auth();
  const user = session?.user;
  const testMode = isTestModeEnabled();

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <BrandMark href="/" label="Treasury Workbench" size="lg" />
        <div className="flex items-center gap-3">
          {testMode && (
            <Link
              href="/test"
              className="rounded-md border border-emerald-600/50 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-600/10"
            >
              Practice
            </Link>
          )}
          {user ? (
            <Link
              href="/workspace"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Open workspace
            </Link>
          ) : (
            <SignInButton compact />
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="py-20 text-center sm:py-28">
          <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/50 px-4 py-1.5 text-xs font-medium text-slate-300">
            Treasury · Foreign-Exchange Risk Tooling
          </div>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
            Size FX buffers with confidence.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-300">
            An interactive treasury workbench for modelling multi-currency cash buffers,
            interest-rate carry and hedging decisions — all inside a single VaR-governed view.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            {user ? (
              <Link
                href="/workspace"
                className="rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
              >
                Go to your workspace
              </Link>
            ) : (
              <SignInButton />
            )}
            {testMode && (
              <Link
                href="/test"
                className="rounded-lg bg-emerald-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
              >
                Practice environment
              </Link>
            )}
            <a
              href="#capabilities"
              className="rounded-lg border border-slate-700 px-6 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800"
            >
              Explore capabilities
            </a>
          </div>
        </section>

        <section id="capabilities" className="pb-24">
          <h2 className="mb-2 text-center text-2xl font-semibold tracking-tight">
            What the app does
          </h2>
          <p className="mx-auto mb-12 max-w-2xl text-center text-slate-400">
            Five connected workspaces that turn treasury spreadsheets into a live, policy-aware model.
          </p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map(cap => (
              <div
                key={cap.title}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 transition-colors hover:border-slate-600"
              >
                <div className="mb-4 text-3xl">{cap.icon}</div>
                <h3 className="mb-2 text-lg font-semibold text-white">{cap.title}</h3>
                <p className="text-sm leading-relaxed text-slate-400">{cap.description}</p>
              </div>
            ))}
          </div>
        </section>

        {!user && (
          <section className="mb-24 rounded-2xl border border-slate-800 bg-slate-900/60 p-10 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">Ready to model your buffers?</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-400">
              Sign in with your Google account to access the FX Buffer Simulator.
            </p>
            <div className="mt-8 flex justify-center">
              <SignInButton />
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-slate-800 py-8 text-center text-xs text-slate-500">
        Treasury · FX Team — internal tooling
      </footer>
    </div>
  );
}

function SignInButton({ compact = false }: { compact?: boolean }) {
  return (
    <form
      action={async () => {
        'use server';
        await signIn('google', { redirectTo: '/workspace' });
      }}
    >
      <button
        type="submit"
        className={
          compact
            ? 'inline-flex items-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100'
            : 'inline-flex items-center gap-3 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-slate-800 shadow-lg transition-colors hover:bg-slate-100'
        }
      >
        <GoogleIcon />
        Sign in with Google
      </button>
    </form>
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
