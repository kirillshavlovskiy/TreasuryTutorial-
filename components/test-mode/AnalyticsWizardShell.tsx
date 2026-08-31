'use client';

import { useState, type ReactNode } from 'react';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';

export type AnalyticsWizardStep = {
  id: string;
  n: number;
  label: string;
  Icon: LucideIcon;
};

export function useAnalyticsWizard(stepCount: number) {
  const [step, setStep] = useState(1);
  const [maxReached, setMaxReached] = useState(1);
  const goToStep = (n: number) => {
    if (n < 1 || n > stepCount || n > maxReached) return;
    setStep(n);
  };
  /** Unlock through `n` (for drill-ins like Cash Carry profile) then go there. */
  const unlockAndGo = (n: number) => {
    if (n < 1 || n > stepCount) return;
    setMaxReached(m => Math.max(m, n));
    setStep(n);
  };
  const nextStep = () => {
    const n = Math.min(stepCount, step + 1);
    setMaxReached(m => Math.max(m, n));
    setStep(n);
  };
  const prevStep = () => setStep(s => Math.max(1, s - 1));
  return {
    step,
    maxReached,
    goToStep,
    unlockAndGo,
    nextStep,
    prevStep,
    isLast: step >= stepCount,
  };
}

/**
 * Shared Analytics setup chrome — aside, one visible step, Back / Next.
 * Each tab supplies its own step list and keeps its own step index.
 */
export function AnalyticsWizardShell({
  title,
  crumb,
  steps,
  step,
  maxReached,
  onGoToStep,
  onNext,
  onPrev,
  nextLabel,
  children,
}: {
  title: string;
  crumb?: string;
  steps: readonly AnalyticsWizardStep[];
  step: number;
  maxReached: number;
  onGoToStep: (n: number) => void;
  onNext: () => void;
  onPrev: () => void;
  nextLabel?: string;
  children: ReactNode;
}) {
  const last = steps[steps.length - 1]?.n ?? steps.length;
  const label = nextLabel ?? (step >= last ? 'Done' : 'Next');

  return (
    <div className="flex min-h-[72vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
      <aside className="flex w-52 flex-none flex-col border-r border-slate-800 bg-slate-950/60">
        <div className="border-b border-slate-800 px-4 py-4">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            Setup wizard
          </div>
          <div className="mt-1 text-[11px] text-slate-400">{title}</div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {steps.map(s => {
            const reached = s.n <= maxReached;
            const active = s.n === step;
            const done = s.n < step;
            return (
              <button
                key={s.id}
                type="button"
                disabled={!reached}
                onClick={() => onGoToStep(s.n)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                  active
                    ? 'bg-sky-500/15 text-slate-100 ring-1 ring-inset ring-sky-400/40'
                    : reached
                      ? 'text-slate-200 hover:bg-slate-800/70'
                      : 'cursor-default text-slate-600'
                }`}
              >
                <span
                  className={`flex h-6 w-6 flex-none items-center justify-center rounded-md ${
                    done
                      ? 'bg-emerald-500/20 text-emerald-200'
                      : active
                        ? 'bg-sky-500/20 text-sky-200'
                        : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  {done ? (
                    <Check className="h-3.5 w-3.5" strokeWidth={2} />
                  ) : (
                    <s.Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  )}
                </span>
                {s.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
          <div className="flex items-center gap-1.5 text-[12px] text-slate-500">
            Treasury
            <ChevronRight className="h-3.5 w-3.5" />
            <span className="font-medium text-slate-200">{crumb ?? title}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="font-mono text-[11px] text-slate-500">
              Step {step} of {last}
            </span>
            <div className="h-1 w-40 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-sky-400 transition-[width] duration-200"
                style={{ width: `${(step / last) * 100}%` }}
              />
            </div>
            <button
              type="button"
              onClick={onPrev}
              disabled={step === 1}
              className="h-9 rounded-lg border border-slate-600 px-4 text-[13px] font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-default disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              onClick={onNext}
              className="h-9 rounded-lg bg-sky-600 px-4 text-[13px] font-semibold text-white hover:bg-sky-500"
            >
              {label}
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {children}
        </div>
      </div>
    </div>
  );
}
