import Link from 'next/link';
import { auth, signIn } from '@/auth';
import { BrandMark } from '@/components/BrandMark';
import { isTestModeEnabled } from '@/lib/test-mode/enabled';

const CAPABILITIES: { title: string; description: string; tag: string }[] = [
  {
    title: 'FX Risk & Liquidity Book',
    tag: 'Cash / FX',
    description:
      'See the full FX position by currency — cash, receivables, liabilities, debt and investments — with net exposure and forecast buildup in one live book. Liquidity and carry sit next to risk so every buffer decision is grounded in the actual treasury stack.',
  },
  {
    title: 'Hedging Decision Layer',
    tag: 'Strategy',
    description:
      'Start unhedged (Δ = 1), size spot and forward cover against stock or average monthly buildup, and read residual VaR before you book. Cancel trades in sandbox to test how hedge structure changes risk.',
  },
  {
    title: 'Analytics & VaR Regime',
    tag: 'Risk',
    description:
      'Configure confidence, horizon and exposure basis, then recalculate parametric VaR under that regime. Answers and desk views stay aligned to the setup you choose — not a single fixed number.',
  },
  {
    title: 'Consolidated Live Ladder',
    tag: 'Structure',
    description:
      'Stack original exposure sources against booked hedges by currency. Residual ticks and VaR-after update as local entity hedges roll into the group book — so consolidation shows structure, not a black box.',
  },
  {
    title: 'Group & Entity Workspace',
    tag: 'Organisation',
    description:
      'Build entity dashboards and Cash/FX profiles, then consolidate into Group FX. Local hedges and metrics wire into the parent view so treasury can decide at both operating-entity and group level.',
  },
  {
    title: 'Liquidity, Carry & Investment View',
    tag: 'Balance sheet',
    description:
      'Connect payout liquidity, interest-rate carry and investment notionals to the same decision loop as FX hedges. Modern treasurers size idle cash, funding cost and hedge overlay together — not in separate spreadsheets.',
  },
];

export default async function LandingPage() {
  const session = await auth();
  const user = session?.user;
  const sandboxEnabled = isTestModeEnabled();

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <BrandMark href="/" label="Treasury Workbench" size="lg" />
        <div className="flex items-center gap-3">
          {user ? (
            <Link
              href="/workspace"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
            >
              Workbench
            </Link>
          ) : (
            <SignInButton compact redirectTo="/workspace" />
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="py-16 text-center sm:py-24">
          <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/50 px-4 py-1.5 text-xs font-medium text-slate-300">
            Simple Sigma · Modern Treasury Workbench
          </div>
          <h1 className="mx-auto max-w-4xl text-4xl font-bold tracking-tight sm:text-6xl">
            Smart decisions for financing and hedging, liquidity investment management.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-300">
            Choose how you want to work: train in the sandbox curriculum on corporate treasury
            topics, or open the live workbench for desk decisions on your own books.
          </p>
        </section>

        <section id="modes" className="pb-20">
          <h2 className="mb-2 text-center text-2xl font-semibold tracking-tight">
            Choose your mode
          </h2>
          <p className="mx-auto mb-10 max-w-xl text-center text-sm text-slate-400">
            Two ways in — same platform. Pick sandbox learning or the production workbench.
          </p>

          <div
            className={`mx-auto grid max-w-4xl gap-5 ${
              sandboxEnabled ? 'md:grid-cols-2' : 'md:grid-cols-1'
            }`}
          >
            {sandboxEnabled && (
              <ModeCard
                eyebrow="Sandbox"
                title="Curriculum & practice"
                description="Guided Sigma Tasks on corporate treasury topics — FX books, VaR regimes, hedge booking and group consolidation — on NordTech sample data. Learn and rehearse before the live desk."
                points={[
                  'Corporate treasury curriculum (Sigma Tasks)',
                  'Sample multi-entity books & Validate scoring',
                  'Safe place to book / cancel hedges and watch VaR',
                ]}
                accent="emerald"
                signedIn={Boolean(user)}
                href="/test"
                cta="Enter sandbox"
                signInRedirect="/test"
              />
            )}

            <ModeCard
              eyebrow="Workbench"
              title="Live treasury desk"
              description="Full Treasury Workbench for your entities and dashboards — FX risk, liquidity, investment context, hedging decisions and consolidated metrics without the training rails."
              points={[
                'Your workspace entities & risk profiles',
                'Decision layers, Analytics and Live Ladder',
                'Desk-ready hedging and liquidity views',
              ]}
              accent="blue"
              signedIn={Boolean(user)}
              href="/workspace"
              cta="Open workbench"
              signInRedirect="/workspace"
            />
          </div>
        </section>

        <section className="pb-16">
          <div className="mx-auto max-w-3xl rounded-2xl border border-slate-800 bg-slate-900/40 px-6 py-8 text-center sm:px-10">
            <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
              Built for how treasury actually decides
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-slate-400 sm:text-base">
              From entity Cash/FX books to group consolidation, the workbench links exposure,
              hedge tickets (spot and forward), residual risk and policy VaR. Sandbox curriculum
              walks through structured scenarios; Workbench mode applies the same stack to your
              operating books.
            </p>
          </div>
        </section>

        <section id="capabilities" className="pb-24">
          <h2 className="mb-2 text-center text-2xl font-semibold tracking-tight">
            What you can run today
          </h2>
          <p className="mx-auto mb-12 max-w-2xl text-center text-slate-400">
            Connected layers for risk, hedging, liquidity and investment — shared by sandbox
            curriculum and the live workbench.
          </p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map(cap => (
              <div
                key={cap.title}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 transition-colors hover:border-slate-600"
              >
                <div className="mb-3 text-[11px] font-medium uppercase tracking-wide text-emerald-400/90">
                  {cap.tag}
                </div>
                <h3 className="mb-2 text-lg font-semibold text-white">{cap.title}</h3>
                <p className="text-sm leading-relaxed text-slate-400">{cap.description}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-800 py-8 text-center text-xs text-slate-500">
        Simple Sigma · Treasury Workbench — sandbox curriculum & live desk modes
      </footer>
    </div>
  );
}

function ModeCard({
  eyebrow,
  title,
  description,
  points,
  accent,
  signedIn,
  href,
  cta,
  signInRedirect,
}: {
  eyebrow: string;
  title: string;
  description: string;
  points: string[];
  accent: 'emerald' | 'blue';
  signedIn: boolean;
  href: string;
  cta: string;
  signInRedirect: string;
}) {
  const border =
    accent === 'emerald'
      ? 'border-emerald-700/50 hover:border-emerald-500/60'
      : 'border-blue-700/50 hover:border-blue-500/60';
  const eyebrowCls =
    accent === 'emerald' ? 'text-emerald-400' : 'text-blue-400';
  const btnCls =
    accent === 'emerald'
      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
      : 'bg-blue-600 hover:bg-blue-500 text-white';

  return (
    <div
      className={`flex flex-col rounded-2xl border bg-slate-900/70 p-6 text-left transition-colors sm:p-8 ${border}`}
    >
      <div className={`text-xs font-semibold uppercase tracking-wide ${eyebrowCls}`}>
        {eyebrow}
      </div>
      <h3 className="mt-2 text-xl font-semibold text-white sm:text-2xl">{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">{description}</p>
      <ul className="mt-5 flex-1 space-y-2 text-sm text-slate-300">
        {points.map(p => (
          <li key={p} className="flex gap-2">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
              accent === 'emerald' ? 'bg-emerald-400' : 'bg-blue-400'
            }`} />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <div className="mt-8">
        {signedIn ? (
          <Link
            href={href}
            className={`inline-flex w-full items-center justify-center rounded-lg px-5 py-3 text-sm font-semibold transition-colors ${btnCls}`}
          >
            {cta}
          </Link>
        ) : (
          <SignInButton
            redirectTo={signInRedirect}
            label={`Sign in · ${cta}`}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold transition-colors ${btnCls}`}
          />
        )}
      </div>
    </div>
  );
}

function SignInButton({
  compact = false,
  redirectTo = '/workspace',
  label = 'Sign in with Google',
  className,
}: {
  compact?: boolean;
  redirectTo?: string;
  label?: string;
  className?: string;
}) {
  return (
    <form
      action={async () => {
        'use server';
        await signIn('google', { redirectTo });
      }}
    >
      <button
        type="submit"
        className={
          className ??
          (compact
            ? 'inline-flex items-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100'
            : 'inline-flex items-center gap-3 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-slate-800 shadow-lg transition-colors hover:bg-slate-100')
        }
      >
        {(compact || !className) && <GoogleIcon />}
        {label}
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
