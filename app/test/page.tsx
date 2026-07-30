'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type SandboxMode = 'curriculum' | 'practice';

const MODE_KEY = 'treasury:sandbox-mode';

const TASKS = [
  {
    id: '01',
    title: 'SIGMA TASK 01 — Map the Book',
    episode: 'E01 — The Imbalanced Balance Sheet',
    time: '~15 minutes',
    steps: [
      'Create FX dashboard + profile on each legal entity',
      'Find largest mismatch on Group FX',
      'Configure VaR in Analytics (confidence · horizon · exposure)',
      'Identify VaR at Δ = 1 for your setup and Validate (±5%)',
    ],
  },
] as const;

function modeCardClass(active: boolean): string {
  return active
    ? 'border-2 border-emerald-500 bg-slate-900/50'
    : 'border border-slate-800 bg-slate-900/50 hover:border-slate-600';
}

export default function TestHubPage() {
  const [mode, setMode] = useState<SandboxMode>('curriculum');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MODE_KEY);
      if (raw === 'curriculum' || raw === 'practice') setMode(raw);
    } catch {
      /* ignore */
    }
  }, []);

  const selectMode = (next: SandboxMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">
        Sandbox · Corporate treasury
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        Train on the NordTech sample book. Choose guided curriculum tasks with
        Validate scoring, or open self practice to explore FX books, VaR and
        hedging freely. Use the header for{' '}
        <Link href="/" className="text-emerald-400 hover:text-emerald-300">
          Home
        </Link>{' '}
        or the{' '}
        <Link href="/workspace" className="text-emerald-400 hover:text-emerald-300">
          Workbench
        </Link>
        .
      </p>

      <section className="mt-8" aria-label="Sandbox mode">
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
          Select mode
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => selectMode('curriculum')}
            aria-pressed={mode === 'curriculum'}
            className={`rounded-xl border p-5 text-left transition-colors ${modeCardClass(mode === 'curriculum')}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Curriculum
              </span>
              {mode === 'curriculum' && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                  Selected
                </span>
              )}
            </div>
            <h2 className="mt-2 text-lg font-semibold text-white">
              Guided Sigma Tasks
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
              Structured episodes with step checklist, answer fields and Validate
              scoring against the hidden reference (±5%).
            </p>
          </button>

          <button
            type="button"
            onClick={() => selectMode('practice')}
            aria-pressed={mode === 'practice'}
            className={`rounded-xl border p-5 text-left transition-colors ${modeCardClass(mode === 'practice')}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Self practice
              </span>
              {mode === 'practice' && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                  Selected
                </span>
              )}
            </div>
            <h2 className="mt-2 text-lg font-semibold text-white">
              Free exploration
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
              Same NordTech multi-entity book — Analytics, Decision hedges and
              path charts — without task rails or Validate. Progress saved
              separately from curriculum.
            </p>
          </button>
        </div>
      </section>

      {mode === 'curriculum' ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {TASKS.map(task => (
            <Link
              key={task.id}
              href={`/test/tasks/${task.id}`}
              className="group rounded-xl border border-slate-800 bg-slate-900/60 p-6 transition-colors hover:border-emerald-600/50"
            >
              <div className="text-xs font-medium uppercase tracking-wide text-emerald-400">
                Episode {task.episode}
              </div>
              <h2 className="mt-2 text-lg font-semibold text-white">{task.title}</h2>
              <p className="mt-1 text-xs text-slate-500">{task.time}</p>
              <ol className="mt-4 list-decimal space-y-1 pl-4 text-sm text-slate-400">
                {task.steps.map(s => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <div className="mt-5 flex w-full items-center justify-center rounded-md border border-emerald-500/60 px-3 py-1.5 text-sm font-medium text-emerald-400 transition-colors group-hover:border-emerald-400 group-hover:bg-emerald-500/10">
                Open task →
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="mt-8 rounded-xl border border-sky-700/40 bg-sky-950/20 p-6">
          <h2 className="text-lg font-semibold text-white">
            NordTech self practice
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Explore entity Cash/FX books, Group consolidation, VaR regimes
            (Cash / VaR-neutral / Target), rolling strips and hedge booking.
            No Validate checklist — your practice book is stored under a
            separate sandbox slot from curriculum Task 01.
          </p>
          <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-400">
            <li>Multi-entity NordTech sample positions</li>
            <li>Analytics path charts + Decision hedge ladder</li>
            <li>Book live / scheduled strip forwards</li>
          </ul>
          <Link
            href="/test/tasks/01?mode=practice"
            className="mt-6 inline-flex items-center justify-center rounded-md border border-sky-500/60 bg-sky-500/15 px-4 py-2 text-sm font-semibold text-sky-200 transition-colors hover:border-sky-400 hover:bg-sky-500/25"
          >
            Enter self practice →
          </Link>
        </div>
      )}
    </main>
  );
}
