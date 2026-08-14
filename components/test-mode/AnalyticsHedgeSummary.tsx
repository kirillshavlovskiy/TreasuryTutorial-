'use client';

import {
  bufferConstraintLabel,
  type BufferConstraint,
} from '@/lib/test-mode/liquidity-strategies';

function fmtK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.5) return '$0K';
  return `${k >= 0 ? '' : '−'}$${Math.abs(k).toFixed(0)}K`;
}

function fmtCarryYr(usdYrM: number): string {
  return `${fmtK(usdYrM)}/yr`;
}

export function AnalyticsHedgeSummary({
  regimeLabel,
  regimeDetail,
  constraint,
  constraintDetail,
  defaultCarryUsdYrM,
  finalCfarUsdM,
}: {
  regimeLabel: string;
  regimeDetail?: string;
  constraint: BufferConstraint;
  constraintDetail: string;
  defaultCarryUsdYrM: number;
  finalCfarUsdM: number;
}) {
  const constraintHue =
    constraint === 'var'
      ? 'text-amber-200'
      : constraint === 'carry'
        ? 'text-emerald-200'
        : 'text-sky-200';

  return (
    <section
      aria-label="Hedging proposition"
      className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
    >
      <SummaryCell
        label="Live regime"
        value={regimeLabel}
        detail={regimeDetail ?? 'Funding programme on the desk'}
      />
      <SummaryCell
        label="Constraint"
        value={bufferConstraintLabel(constraint)}
        detail={constraintDetail}
        valueClass={constraintHue}
      />
      <SummaryCell
        label="Default Carry"
        value={fmtCarryYr(defaultCarryUsdYrM)}
        detail="Unfunded FX path — same on every regime"
        valueClass={
          defaultCarryUsdYrM >= 0 ? 'text-emerald-200' : 'text-rose-200/90'
        }
      />
      <SummaryCell
        label="Final CFaR"
        value={fmtK(finalCfarUsdM)}
        detail="FX hedge + funding-swap bridge"
        valueClass="text-yellow-200"
      />
    </section>
  );
}

function SummaryCell({
  label,
  value,
  detail,
  valueClass,
}: {
  label: string;
  value: string;
  detail: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2">
      <div className="font-mono text-[9px] font-medium uppercase tracking-[0.09em] text-slate-500">
        {label}
      </div>
      <div className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${valueClass ?? 'text-slate-100'}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] leading-snug text-slate-500">{detail}</div>
    </div>
  );
}
