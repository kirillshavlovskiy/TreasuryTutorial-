'use client';

import { useEffect, useRef, useState } from 'react';
import { DeskStepper } from '@/components/DeskStepper';
import {
  clampMonthlyVol,
  clampRateVolBpYr,
  MONTHLY_VOL_MAX,
  MONTHLY_VOL_MIN,
  RATE_VOL_BP_MAX,
  RATE_VOL_BP_MIN,
  VAR_VOL_SOURCE_OPTIONS,
  volForSource,
  type VarSetup,
  type VarVolSource,
} from '@/lib/test-mode/var-setup';
import { presetRateVolBpYr, rateVolBpYrFor } from '@/lib/test-mode/cfar-residual';

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.9 1.01 1.55 1.01H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}

/** Trim trailing zeros so a field shows "3" and "2.5", never "3.00". */
function trimNum(v: number): string {
  return String(Number(v.toFixed(4)));
}

function VolResetBtn({
  disabled,
  title,
  onClick,
}: {
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded px-1.5 py-0.5 font-mono text-[9px] text-slate-500 transition-colors hover:text-emerald-300 disabled:cursor-default disabled:opacity-30 disabled:hover:text-slate-500"
    >
      reset
    </button>
  );
}

/**
 * The σ source toggle, plus a gear that opens the custom-volatility editor.
 *
 * The gear sits INSIDE the toggle group as a third segment rather than beside
 * it, because what it edits is the same setting the two chips select: the
 * chips pick which σ is live, the gear says what each of them is worth. A
 * separate button next to the group would read as an unrelated panel-level
 * setting.
 *
 * Both sources are editable from the panel at once, not just the active one.
 * Overrides are held per source precisely so switching back and forth keeps
 * each edited value, and that is only visible if you can see both.
 *
 * Rate vol lives here too. It belongs to the same question — how much do the
 * inputs move — and it had no control anywhere before, so a desk could not
 * see, let alone change, the per-currency table driving the carry leg of every
 * CFaR number on the screen.
 */
export function VolSourceControl({
  setup,
  onSetupChange,
  rateVolCcy,
  className,
}: {
  setup: VarSetup;
  onSetupChange?: (next: VarSetup) => void;
  /** Currency whose desk-table rate vol is quoted as the preset. Omitted when
   * the panel spans currencies, in which case the table itself is the preset
   * and only the override can be a single number. */
  rateVolCcy?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const editable = onSetupChange != null;
  const patch = (partial: Partial<VarSetup>) =>
    onSetupChange?.({ ...setup, ...partial });

  const setVolOverride = (source: VarVolSource, pct: number) => {
    if (!Number.isFinite(pct)) return;
    patch({
      volOverrides: {
        ...setup.volOverrides,
        [source]: clampMonthlyVol(pct / 100),
      },
    });
  };
  const resetVolOverride = (source: VarVolSource) => {
    const next = { ...setup.volOverrides };
    delete next[source];
    patch({ volOverrides: Object.keys(next).length > 0 ? next : undefined });
  };

  const rateVolOverridden = setup.rateVolOverrideBpYr != null;
  const rateVolBp = rateVolBpYrFor(rateVolCcy ?? '', setup);
  const rateVolPreset = rateVolCcy ? presetRateVolBpYr(rateVolCcy) : null;
  const anyOverride =
    rateVolOverridden ||
    VAR_VOL_SOURCE_OPTIONS.some(
      o => Math.abs(volForSource(setup, o.id) - o.monthlyVol) > 1e-12,
    );

  // The panel floats rather than expanding the toggle, so opening it cannot
  // shove the neighbouring confidence control down the settings row.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          className="inline-flex max-w-full flex-wrap items-center rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
          role="group"
          aria-label="Volatility source"
        >
          {VAR_VOL_SOURCE_OPTIONS.map(opt => {
            const on = setup.volSource === opt.id;
            const eff = volForSource(setup, opt.id);
            const edited = Math.abs(eff - opt.monthlyVol) > 1e-12;
            return (
              <button
                key={opt.id}
                type="button"
                title={
                  edited
                    ? `${opt.description}\nOverridden — desk preset is ${(opt.monthlyVol * 100).toFixed(1)}%.`
                    : opt.description
                }
                disabled={!editable}
                onClick={() => patch({ volSource: opt.id })}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  on
                    ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                } ${editable ? '' : 'cursor-default opacity-80'}`}
              >
                {opt.label}
                <span
                  className={`ml-1 font-mono text-[10px] font-normal ${
                    edited ? 'text-emerald-300' : 'opacity-80'
                  }`}
                >
                  {(eff * 100).toFixed(1)}%
                  {edited ? '*' : ''}
                </span>
              </button>
            );
          })}
          {editable && (
            <>
              <span aria-hidden className="mx-0.5 h-4 w-px bg-slate-700" />
              <button
                type="button"
                aria-label="Custom volatility settings"
                aria-pressed={open}
                aria-expanded={open}
                title="Set custom σ₁ₘ for either source, and the rate-differential vol"
                onClick={() => setOpen(o => !o)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  open
                    ? 'bg-emerald-500/20 text-emerald-200'
                    : anyOverride
                      ? 'text-emerald-300 hover:bg-slate-800'
                      : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
                }`}
              >
                <GearIcon className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {open && editable && (
        <div className="absolute left-0 top-full z-30 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] space-y-2 rounded-lg border border-slate-600 bg-slate-950 p-2.5 shadow-xl shadow-black/50">
          <div className="font-mono text-[9px] uppercase tracking-[0.09em] text-slate-500">
            Custom volatility
          </div>
          {VAR_VOL_SOURCE_OPTIONS.map(opt => {
            const eff = volForSource(setup, opt.id);
            const edited = Math.abs(eff - opt.monthlyVol) > 1e-12;
            const presetPct = opt.monthlyVol * 100;
            return (
              <DeskStepper
                key={opt.id}
                label={`${opt.label} σ₁ₘ`}
                value={eff * 100}
                min={MONTHLY_VOL_MIN * 100}
                max={MONTHLY_VOL_MAX * 100}
                step={0.1}
                onChange={pct => setVolOverride(opt.id, pct)}
                formatValue={v => `${trimNum(v)}%${edited ? '*' : ''}`}
                suffix="/mo"
                editable
                tickValues={[0, 12.5, 25, 37.5, 50]}
                tickLabels={['0', '', '25', '', '50']}
                className="w-full"
                title={`σ₁ₘ for the ${opt.label.toLowerCase()} source, 0–${MONTHLY_VOL_MAX * 100}%/mo. Desk preset ${presetPct.toFixed(1)}%. Headline CFaR is size and timing only — the planned structural gap is not revalued at this vol.`}
                ariaLabel={`${opt.label} monthly volatility`}
                headerExtra={
                  <VolResetBtn
                    disabled={!edited}
                    title={`Restore desk preset (${presetPct.toFixed(1)}%)`}
                    onClick={() => resetVolOverride(opt.id)}
                  />
                }
              />
            );
          })}
          <div className="border-t border-slate-800 pt-2">
            <DeskStepper
              label="Rate vol σ_r"
              value={rateVolBp}
              min={RATE_VOL_BP_MIN}
              max={RATE_VOL_BP_MAX}
              step={5}
              onChange={bp =>
                patch({ rateVolOverrideBpYr: clampRateVolBpYr(bp) })
              }
              formatValue={v => `${trimNum(v)}${rateVolOverridden ? '*' : ''}`}
              suffix="bp/yr"
              editable
              accent="sky"
              tickValues={[0, 250, 500, 750, 1000]}
              tickLabels={['0', '250', '500', '750', '1k']}
              className="w-full"
              title={
                rateVolPreset != null
                  ? `Annualized rate-differential vol for every currency. ${rateVolCcy} desk preset ${rateVolPreset} bp. Set 0 to freeze rates.`
                  : 'Annualized rate-differential vol, applied to every currency in place of the desk table. Set 0 to freeze rates.'
              }
              ariaLabel="Rate-differential volatility"
              headerExtra={
                <VolResetBtn
                  disabled={!rateVolOverridden}
                  title="Restore the per-currency desk table"
                  onClick={() => patch({ rateVolOverrideBpYr: undefined })}
                />
              }
            />
            <p className="mt-1.5 text-[9px] leading-snug text-slate-500">
              One number for all currencies — it replaces the table rather than
              shifting it, so USD stops sitting at 0 while TRY sits at 450.
              Reset to put every currency back on its own.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
