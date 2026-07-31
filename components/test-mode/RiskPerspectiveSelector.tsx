'use client';

export type RiskPerspective = 'fxRisk' | 'cashCarry' | 'dv01' | 'greeks';

export const RISK_PERSPECTIVES: {
  id: RiskPerspective;
  label: string;
  active: boolean;
  description: string;
  yLabel: string;
}[] = [
  {
    id: 'fxRisk',
    label: 'FX Risk',
    active: true,
    description:
      'Original stock (and avg buildup when Analytics includes it) vs hedge structure. Residual = exposure − hedge.',
    yLabel: 'Exposure (M)',
  },
  {
    id: 'cashCarry',
    label: 'Cash Carry',
    active: false,
    description: 'Carry / translation remeasurement by source (preview).',
    yLabel: 'Carry / mo (M)',
  },
  {
    id: 'dv01',
    label: 'DV01',
    active: false,
    description: 'Rate sensitivity stack on debt / investments (preview).',
    yLabel: 'DV01 / bp (M)',
  },
  {
    id: 'greeks',
    label: 'Greeks',
    active: false,
    description: 'δ-effective stack vs hedge overlay (preview).',
    yLabel: 'δ-notional (M)',
  },
];

export function riskPerspectiveMeta(id: RiskPerspective) {
  return RISK_PERSPECTIVES.find(p => p.id === id) ?? RISK_PERSPECTIVES[0]!;
}

interface RiskPerspectiveSelectorProps {
  value: RiskPerspective;
  onChange: (id: RiskPerspective) => void;
  /** Optional class on the chip row. */
  className?: string;
  /** Show description under the chips (default true). */
  showDescription?: boolean;
}

/** FX Risk / Cash Carry / DV01 / Greeks chips — shared across Ladder, Decision, Analytics. */
export function RiskPerspectiveSelector({
  value,
  onChange,
  className = '',
  showDescription = true,
}: RiskPerspectiveSelectorProps) {
  const meta = riskPerspectiveMeta(value);
  const inactive = !meta.active;

  return (
    <div className={className || undefined}>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Risk perspective">
        {RISK_PERSPECTIVES.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              value === p.id
                ? 'border-blue-500 bg-blue-500/15 text-blue-100'
                : 'border-slate-700 text-slate-400 hover:border-slate-500'
            } ${!p.active ? 'opacity-70' : ''}`}
          >
            {p.label}
            {!p.active && (
              <span className="ml-1 text-[9px] uppercase text-slate-600">soon</span>
            )}
          </button>
        ))}
      </div>
      {showDescription && (
        <p className="mt-2 text-[11px] text-slate-500">
          {meta.description}
          {inactive
            ? ' Values are illustrative until the metric is activated on the risk profile.'
            : ''}
        </p>
      )}
    </div>
  );
}
