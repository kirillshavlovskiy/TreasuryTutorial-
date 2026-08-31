'use client';

/**
 * Inline SVG icons for Treasury Workbench chrome — no external icon package.
 * Desk taxonomy marks (risk asset · protect · optimize · ticker) live in
 * RiskTaxonomyIcons instead, so the wizards and the summary chips agree.
 * ProfileTypeIcon / RiskProfileTypeCards are shared by Workbench and Sandbox.
 */

import { RISK_PROFILE_TYPES } from '@/lib/workspace-store';

type IconProps = { className?: string; title?: string };

const base = 'h-5 w-5 shrink-0';

export function IconBuilding({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M9 8h2M9 12h2M9 16h2M14 21h6a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconBranches({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9c0 4.5-3 6-9 6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconGauge({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a8 8 0 1 0-14.8 0M12 12l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconCheck({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconEntity({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 10h.01M15 10h.01M9 14h.01M15 14h.01"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconDashboard({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M4 5a1 1 0 0 1 1-1h6v8H4V5ZM13 4h6a1 1 0 0 1 1 1v4h-7V4ZM4 14h7v6H5a1 1 0 0 1-1-1v-5ZM13 11h7v8a1 1 0 0 1-1 1h-6v-9Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconSpark({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPencil({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPlus({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function IconTrash({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path
        d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Cash/FX — globe / exchange. */
export function IconFx({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/** Bonds / IR — coupon / yield percent. */
export function IconBonds({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <circle cx="6.75" cy="6.75" r="2.45" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="17.25" cy="17.25" r="2.45" stroke="currentColor" strokeWidth="1.75" />
      <path d="M17.6 5.2 6.4 18.8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/** Investments — circular portfolio mix across instruments. */
export function IconInvestments({ className = base, title }: IconProps) {
  const r = 7.15;
  const C = 2 * Math.PI * r;
  const gap = 1.55;
  const weights = [0.38, 0.27, 0.20, 0.15];
  const opacities = [1, 0.72, 0.46, 0.26];
  const usable = C - gap * weights.length;
  let cursor = 0;
  const slices = weights.map((w, i) => {
    const len = usable * w;
    const slice = { len, offset: cursor, opacity: opacities[i]! };
    cursor += len + gap;
    return slice;
  });
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      {slices.map((s, i) => (
        <circle
          key={i}
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="4.5"
          strokeDasharray={`${s.len} ${C - s.len}`}
          strokeDashoffset={-s.offset}
          transform="rotate(-90 12 12)"
          opacity={s.opacity}
        />
      ))}
    </svg>
  );
}

export function IconEquities({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d="M4 19V5M4 19h16M7 15l4-5 3 3 5-7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCommodities({ className = base, title }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <path d="M12 12 4 7M12 12l8-5M12 12v10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export type WorkbenchProfileType = 'fx' | 'bonds' | 'investments' | 'equities' | 'commodities';

export function ProfileTypeIcon({
  type,
  className = base,
}: {
  type: WorkbenchProfileType;
  className?: string;
}) {
  switch (type) {
    case 'fx':
      return <IconFx className={className} />;
    case 'bonds':
      return <IconBonds className={className} />;
    case 'investments':
      return <IconInvestments className={className} />;
    case 'equities':
      return <IconEquities className={className} />;
    case 'commodities':
      return <IconCommodities className={className} />;
  }
}

/**
 * Asset-class picker used by Add risk profile on Workbench and Sandbox.
 * Bonds / IR = %, Investments = portfolio donut.
 */
export function RiskProfileTypeCards({
  selected,
  onToggle,
  badgeFor,
}: {
  selected: Iterable<string>;
  onToggle: (id: WorkbenchProfileType) => void;
  /** Badge text also locks the card unless it is already selected. */
  badgeFor?: (id: WorkbenchProfileType) => string | undefined;
}) {
  const selectedSet = selected instanceof Set ? selected : new Set(selected);
  return (
    <div className="space-y-3">
      {RISK_PROFILE_TYPES.map(t => {
        const isSelected = selectedSet.has(t.id);
        const badge = badgeFor?.(t.id) ?? (!t.available ? 'Soon' : undefined);
        const locked = Boolean(badge) && !isSelected;
        return (
          <button
            key={t.id}
            type="button"
            disabled={locked}
            onClick={() => {
              if (!locked) onToggle(t.id);
            }}
            className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
              locked
                ? 'cursor-not-allowed border-slate-800 opacity-55'
                : isSelected
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-700 hover:border-slate-600'
            }`}
          >
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
                isSelected
                  ? 'border-blue-500/40 bg-blue-600/20 text-blue-300'
                  : 'border-slate-700 bg-slate-950 text-slate-400'
              }`}
            >
              <ProfileTypeIcon type={t.id} className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-white">{t.label}</span>
                {badge && (
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-400">
                    {badge}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-400">{t.description}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
