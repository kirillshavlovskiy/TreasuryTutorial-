'use client';

import type { TaskScoreResult } from '@/lib/test-mode';

interface TaskScoreProps {
  result: TaskScoreResult;
}

export function TaskScore({ result }: TaskScoreProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">±5% vs reference ladder</h3>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            result.pass
              ? 'bg-emerald-500/20 text-emerald-300'
              : 'bg-rose-500/20 text-rose-300'
          }`}
        >
          {result.pass ? 'PASS' : 'FAIL'}
        </span>
      </div>

      <ul className="mt-4 space-y-2">
        {result.checks.map(c => (
          <li
            key={c.id}
            className={`rounded-lg border px-3 py-2 text-xs ${
              c.pass
                ? 'border-emerald-500/20 bg-emerald-500/5'
                : 'border-rose-500/20 bg-rose-500/5'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className={c.pass ? 'text-emerald-200' : 'text-rose-200'}>
                {c.pass ? '✓' : '✗'} {c.label}
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-slate-500">
              expected {c.expected} · actual {c.actual}
            </div>
          </li>
        ))}
      </ul>

      {result.hints.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-400/80">
            Troubleshooting
          </div>
          {result.hints.map(h => (
            <p key={h} className="text-xs leading-relaxed text-amber-100/80">
              {h}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
