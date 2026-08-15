'use client';

import type { ReactNode } from 'react';
import type {
  HedgePathPrepareAction,
  HedgePathSummaryMetrics,
} from '@/components/test-mode/ExposureHedgePathChart';
import type { PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';

/** Cover / Legs / Resid / BE (+ optional module chips) in the sticky hedge-modal header. */
export type HedgeStagingChip = {
  label: string;
  value: string;
  pct?: string | null;
  title?: string | null;
  tone: string;
};

/** True when the path-chart draft no longer matches the staged package. */
export function pathChartDraftDirty(
  staged: PreparedHedgeProfile,
  metrics: HedgePathSummaryMetrics,
): boolean {
  const stagedLegs =
    staged.structure === 'strip' && staged.legs.length > 0
      ? staged.legs.length
      : 1;
  if (metrics.legCount !== stagedLegs) return true;
  const chartStrip = metrics.legCount >= 2;
  if (chartStrip !== (staged.structure === 'strip')) return true;
  return (
    Math.abs(Math.abs(metrics.coverLocalM) - Math.abs(staged.coverLocalM))
    > 0.015
  );
}

export function chipsFromPathSummary(
  metrics: HedgePathSummaryMetrics,
  overrides?: { legsValue?: string },
): HedgeStagingChip[] {
  return [
    {
      label: 'Cover',
      value: metrics.coverValue,
      pct: metrics.coverPct,
      title: metrics.coverSub,
      tone: 'text-emerald-200',
    },
    {
      label: 'Legs',
      value: overrides?.legsValue ?? metrics.legsValue,
      title: metrics.legsSub,
      tone: 'text-sky-200',
    },
    {
      label: 'Resid',
      value: metrics.residVarValue,
      pct: metrics.residVarPct,
      title: metrics.residVarSub,
      tone: 'text-rose-300',
    },
    {
      label: 'BE',
      value: metrics.breakevenValue,
      title: metrics.breakevenSub ?? 'Breakeven',
      tone: 'text-amber-200/90',
    },
  ];
}

/**
 * Shared hedge-modal staging chrome — Decision, FX Risk, and Cash Carry.
 * Title + regime/structure subtitle · ✓ Staged · Stage / Reset · Close · chips.
 */
export function HedgeStagingHeader({
  titleId,
  title,
  subtitle,
  chips,
  isPrebooked,
  draftDirty = false,
  prepareAction,
  extraActions,
  onReset,
  onClose,
}: {
  titleId: string;
  title: string;
  subtitle?: ReactNode;
  chips?: readonly HedgeStagingChip[];
  isPrebooked?: boolean;
  /** True when the modal draft no longer matches the staged package. */
  draftDirty?: boolean;
  prepareAction?: HedgePathPrepareAction | null;
  extraActions?: ReactNode;
  /** Drop the staged package (Decision, Analytics, Liquidity all drop this CCY). */
  onReset?: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id={titleId} className="text-sm font-semibold text-white">
            {title}
          </h4>
          {subtitle ? (
            <p className="mt-0.5 text-[11px] text-slate-400">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-nowrap items-center justify-end gap-1">
          {isPrebooked ? (
            <span
              className={`rounded border px-2 py-1 text-[10px] font-semibold ${
                draftDirty
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                  : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
              }`}
              title={
                draftDirty
                  ? 'Draft changed — Restage to update the package'
                  : 'Staged for Hedging Decision — Book under this CCY'
              }
            >
              {draftDirty ? 'Edited' : '✓ Staged'}
            </span>
          ) : null}
          {extraActions}
          {prepareAction && (!isPrebooked || draftDirty) ? (
            <button
              type="button"
              disabled={prepareAction.disabled}
              onClick={() => prepareAction.run()}
              title={
                isPrebooked
                  ? 'Restage — write this path over the staged package'
                  : prepareAction.title
              }
              className="rounded border border-violet-500/50 bg-violet-500/20 px-2.5 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isPrebooked ? 'Restage' : prepareAction.label}
            </button>
          ) : null}
          {onReset ? (
            <button
              type="button"
              onClick={onReset}
              title="Clear staged package — Decision and Liquidity drop this CCY"
              className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800"
            >
              Reset
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </div>
      {chips && chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {chips.map(chip => (
            <span
              key={chip.label}
              title={chip.title ?? undefined}
              className="inline-flex items-center gap-1 rounded border border-slate-700/80 bg-slate-950/90 px-1.5 py-0.5 text-[10px] text-slate-500"
            >
              {chip.label}{' '}
              <span
                className={`font-mono font-semibold tabular-nums ${chip.tone}`}
              >
                {chip.value}
              </span>
              {chip.pct != null ? (
                <span className="font-mono font-semibold tabular-nums text-slate-400">
                  {chip.pct}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
