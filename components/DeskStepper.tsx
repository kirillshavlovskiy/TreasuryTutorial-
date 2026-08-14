'use client';

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

export type DeskStepperAccent = 'emerald' | 'violet' | 'sky';

const ACCENT: Record<
  DeskStepperAccent,
  { fill: string; thumb: string; edit: string; hover: string }
> = {
  emerald: {
    fill: 'bg-emerald-500/70',
    thumb: 'border-emerald-300/80',
    edit: 'border-emerald-600/50 text-emerald-100',
    hover: 'hover:text-emerald-100',
  },
  violet: {
    fill: 'bg-violet-500/70',
    thumb: 'border-violet-300/80',
    edit: 'border-violet-600/50 text-violet-100',
    hover: 'hover:text-violet-100',
  },
  sky: {
    fill: 'bg-sky-500/70',
    thumb: 'border-sky-300/80',
    edit: 'border-sky-600/50 text-sky-100',
    hover: 'hover:text-sky-100',
  },
};

function snapStepperValue(
  raw: number,
  min: number,
  max: number,
  step: number,
): number {
  if (!(step > 0)) return Math.min(max, Math.max(min, raw));
  const n = Math.round((raw - min) / step);
  const snapped = min + n * step;
  const rounded = Math.round(snapped * 1e6) / 1e6;
  return Math.min(max, Math.max(min, rounded));
}

function defaultMajorTicks(min: number, max: number): number[] {
  if (!(max > min)) return [min];
  return [0, 0.25, 0.5, 0.75, 1].map(t => min + t * (max - min));
}

const STEP_BTN =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-950 text-[11px] font-semibold text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40';

/** Cover-of-target chrome: card + label/value + − / tick-track / +. */
export function DeskStepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled = false,
  formatValue,
  suffix,
  editable = false,
  tickValues,
  tickLabels,
  showMinorTicks = false,
  nudgeStep,
  className = '',
  title,
  accent = 'emerald',
  ariaLabel,
  editClassName = 'w-10',
  headerExtra,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  formatValue?: (v: number) => string;
  suffix?: ReactNode;
  editable?: boolean;
  tickValues?: readonly number[];
  tickLabels?: readonly string[];
  showMinorTicks?: boolean;
  nudgeStep?: number;
  className?: string;
  title?: string;
  accent?: DeskStepperAccent;
  ariaLabel?: string;
  editClassName?: string;
  headerExtra?: ReactNode;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [draft, setDraft] = useState<string | null>(null);
  const span = max - min;
  const pct =
    span > 1e-12 ? ((Math.min(max, Math.max(min, value)) - min) / span) * 100 : 0;
  const fmt = formatValue ?? ((v: number) => String(v));
  const bump = nudgeStep ?? step;
  const majors = tickValues ?? defaultMajorTicks(min, max);
  const hue = ACCENT[accent];
  const name = ariaLabel ?? label;

  const valueFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1e-6) return value;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snapStepperValue(min + t * span, min, max, step);
  };

  const nudge = (dir: -1 | 1) => {
    if (disabled) return;
    onChange(snapStepperValue(value + dir * bump, min, max, bump));
  };

  const commitDraft = () => {
    if (draft == null) return;
    const n = Number(draft.replace(/%/g, '').replace(/\$/g, '').trim());
    if (Number.isFinite(n)) {
      onChange(Math.min(max, Math.max(min, n)));
    }
    setDraft(null);
  };

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    onChangeRef.current(valueFromClientX(e.clientX));
    const onMove = (ev: PointerEvent) => {
      onChangeRef.current(valueFromClientX(ev.clientX));
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const minorTicks: number[] = [];
  if (showMinorTicks) {
    const maxMinors = 24;
    const stepCount = Math.round(span / step);
    if (stepCount > 0 && stepCount <= maxMinors) {
      for (let i = 0; i <= stepCount; i++) minorTicks.push(min + i * step);
    }
  }

  return (
    <div
      className={`shrink-0 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1.5${
        disabled ? ' opacity-50' : ''
      } ${className}`}
      title={title}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        {label ? (
          <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
            {label}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
          {editable && draft != null ? (
            <input
              autoFocus
              type="text"
              inputMode="decimal"
              value={draft}
              disabled={disabled}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={e => {
                if (e.key === 'Enter') commitDraft();
                if (e.key === 'Escape') setDraft(null);
              }}
              className={`${editClassName} rounded border bg-slate-950 px-1 py-0.5 text-right text-[11px] font-semibold outline-none ${hue.edit}`}
              aria-label={name}
            />
          ) : editable ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setDraft(String(value))}
              className={`text-[11px] font-semibold text-slate-100 disabled:cursor-not-allowed ${hue.hover}`}
              title="Click to type"
            >
              {fmt(value)}
            </button>
          ) : (
            <span className="text-[11px] font-semibold text-slate-100">
              {fmt(value)}
            </span>
          )}
          {suffix != null && suffix !== '' && (
            <span
              className={`text-[10px] ${disabled ? 'text-slate-600' : 'text-slate-400'}`}
            >
              {suffix}
            </span>
          )}
          {headerExtra}
        </div>
      </div>

      <div className="flex h-6 items-center gap-1.5">
        <button
          type="button"
          className={STEP_BTN}
          disabled={disabled || value <= min + 1e-12}
          aria-label={`Decrease ${name}`}
          onClick={() => nudge(-1)}
        >
          −
        </button>

        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={name}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={
            suffix != null && typeof suffix === 'string'
              ? `${fmt(value)} ${suffix}`
              : fmt(value)
          }
          aria-disabled={disabled}
          onKeyDown={e => {
            if (disabled) return;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault();
              nudge(-1);
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault();
              nudge(1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              onChange(min);
            } else if (e.key === 'End') {
              e.preventDefault();
              onChange(max);
            }
          }}
          onPointerDown={beginDrag}
          className={`relative h-6 min-w-0 flex-1 select-none touch-none ${
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          }`}
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-slate-800 ring-1 ring-slate-700/80">
            <div
              className={`h-full rounded-full ${hue.fill}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {minorTicks.map(t => {
            const p = span > 1e-12 ? ((t - min) / span) * 100 : 0;
            const isMajor = majors.some(
              m => Math.abs(m - t) < step * 0.25 + 1e-9,
            );
            if (isMajor) return null;
            return (
              <span
                key={`m-${t}`}
                className="pointer-events-none absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-600"
                style={{ left: `${p}%` }}
              />
            );
          })}
          {majors.map(t => {
            const p = span > 1e-12 ? ((t - min) / span) * 100 : 0;
            return (
              <span
                key={`M-${t}`}
                className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-500"
                style={{ left: `${p}%` }}
              />
            );
          })}
          <span
            className={`pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-slate-950 shadow-md ${hue.thumb}`}
            style={{ left: `${pct}%` }}
          />
        </div>

        <button
          type="button"
          className={STEP_BTN}
          disabled={disabled || value >= max - 1e-12}
          aria-label={`Increase ${name}`}
          onClick={() => nudge(1)}
        >
          +
        </button>
      </div>

      {tickLabels != null && tickLabels.length > 0 && (
        <div className="mt-1 flex gap-1.5">
          <div className="h-3 w-6 shrink-0" aria-hidden />
          <div className="relative h-3 min-w-0 flex-1">
            {majors.map((t, i) => {
              const lab = tickLabels[i];
              if (lab == null) return null;
              const p = span > 1e-12 ? ((t - min) / span) * 100 : 0;
              return (
                <span
                  key={`L-${t}`}
                  className={`absolute top-0 whitespace-nowrap font-mono text-[8px] leading-none text-slate-500 ${
                    i === 0
                      ? 'left-0'
                      : i === majors.length - 1
                        ? 'right-0'
                        : '-translate-x-1/2'
                  }`}
                  style={
                    i === 0 || i === majors.length - 1
                      ? undefined
                      : { left: `${p}%` }
                  }
                >
                  {lab}
                </span>
              );
            })}
          </div>
          <div className="h-3 w-6 shrink-0" aria-hidden />
        </div>
      )}
    </div>
  );
}

/** Read-only Cover-style track fill (no − / + / thumb). */
export function DeskProgressTrack({
  pct,
  accent = 'emerald',
  className = 'w-20',
}: {
  pct: number;
  accent?: DeskStepperAccent;
  className?: string;
}) {
  const width = Math.min(100, Math.max(0, pct));
  return (
    <div
      className={`relative h-1.5 overflow-hidden rounded-full bg-slate-800 ring-1 ring-slate-700/80 ${className}`}
    >
      <div
        className={`h-full rounded-full ${ACCENT[accent].fill}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
