'use client';

import type { ReactNode } from 'react';
import { IconPencil, IconTrash, ProfileTypeIcon } from '@/components/WorkbenchIcons';
import {
  OptimizeFrameworkIcon,
  ProtectGoalIcon,
  RateInstrumentIcon,
  TickerGlyph,
} from '@/components/RiskTaxonomyIcons';
import {
  OPTIMIZE_FRAMEWORKS,
  PROTECT_GOALS,
  RATE_INSTRUMENTS,
  RISK_ASSETS,
  dashboardSetupFromDashboard,
  type Dashboard,
  type RateInstrument,
} from '@/lib/workspace-store';

const SETUP_LANE_VISIBLE = 8;
const TICKER_VISIBLE = 8;

/** Chip text for a scoped instrument: "EUR loan · EURIBOR +50bp · 12m". */
export function describeInstrument(inst: RateInstrument): string {
  const label = RATE_INSTRUMENTS.find(i => i.id === inst.kind)?.label ?? inst.kind;
  const pair = inst.legCurrency ? `${inst.currency}/${inst.legCurrency}` : inst.currency;
  const rate =
    inst.rateType === 'floating'
      ? [inst.index, inst.spreadBp ? `${inst.spreadBp > 0 ? '+' : ''}${inst.spreadBp}bp` : null]
          .filter(Boolean)
          .join(' ')
      : inst.ratePct != null
        ? `${inst.ratePct}% fixed`
        : 'fixed';
  const tenor = inst.tenorMonths ? `${inst.tenorMonths}m` : null;
  return [`${pair} ${label}`, rate, tenor].filter(Boolean).join(' · ');
}

function SetupLane({
  title,
  tone,
  items,
}: {
  title: string;
  tone: 'rose' | 'emerald' | 'amber';
  items: { id: string; label: string; hint?: string; icon: ReactNode }[];
}) {
  const shown = items.slice(0, SETUP_LANE_VISIBLE);
  const extra = items.length - shown.length;
  const iconTone =
    tone === 'rose'
      ? 'text-rose-300/80'
      : tone === 'emerald'
        ? 'text-emerald-300/80'
        : 'text-amber-200/80';
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
          {title}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-slate-600">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-[10px] text-slate-600">Not set</p>
      ) : (
        <ul className="space-y-1">
          {shown.map(item => (
            <li
              key={item.id}
              title={item.hint ?? item.label}
              className="flex min-w-0 items-center gap-1.5"
            >
              <span className={`shrink-0 ${iconTone}`}>{item.icon}</span>
              <span className="truncate text-[11px] font-medium text-slate-200">
                {item.label}
              </span>
            </li>
          ))}
          {extra > 0 && (
            <li
              className="pl-5 text-[10px] text-slate-500"
              title={items.map(i => i.hint ?? i.label).join(', ')}
            >
              +{extra}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Catalog tile for one entity desk — setup at a glance, whole card opens the desk. */
export function DashboardDeskCard({
  dashboard,
  onOpen,
  onEdit,
  onDelete,
}: {
  dashboard: Dashboard;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const setup = dashboardSetupFromDashboard(dashboard);
  const assetMeta = RISK_ASSETS.find(a => a.id === setup.riskAsset);
  const live = assetMeta?.live ?? false;
  const protect = setup.protect.map(id => {
    const meta = PROTECT_GOALS.find(g => g.id === id);
    return {
      id,
      label: meta?.label ?? id,
      hint: meta?.longLabel,
      icon: <ProtectGoalIcon id={id} className="h-3.5 w-3.5" />,
    };
  });
  const optimize = setup.optimize.map(id => {
    const meta = OPTIMIZE_FRAMEWORKS.find(g => g.id === id);
    return {
      id,
      label: meta?.label ?? id,
      hint: meta?.longLabel,
      icon: <OptimizeFrameworkIcon id={id} className="h-3.5 w-3.5" />,
    };
  });
  const instruments = setup.instruments ?? [];
  const tickersShown = setup.tickers.slice(0, TICKER_VISIBLE);
  const tickersExtra = setup.tickers.length - tickersShown.length;

  return (
    <article className="group relative flex h-full flex-col rounded-xl border border-slate-700 bg-slate-900 p-4 transition-colors hover:border-slate-500">
      <div className="absolute right-3 top-3 z-10 flex gap-1.5">
        <button
          type="button"
          title="Edit dashboard setup"
          aria-label={`Edit ${dashboard.name}`}
          onClick={onEdit}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-slate-400 transition-colors hover:border-sky-500/50 hover:text-sky-300"
        >
          <IconPencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Delete dashboard"
          aria-label={`Delete ${dashboard.name}`}
          onClick={onDelete}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-slate-400 transition-colors hover:border-rose-500/60 hover:text-rose-400"
        >
          <IconTrash className="h-3.5 w-3.5" />
        </button>
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-0 flex-1 flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      >
        <div className="flex items-start gap-3 pr-16">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-950 text-slate-300">
            <ProfileTypeIcon
              type={assetMeta?.profileType ?? 'fx'}
              className="h-5 w-5"
            />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-white">
              {dashboard.name}
            </h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-400">
                {assetMeta?.label ?? 'Risk asset'}
              </span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                  live
                    ? 'border-emerald-700/50 bg-emerald-950/50 text-emerald-200'
                    : 'border-slate-700 bg-slate-950/60 text-slate-500'
                }`}
              >
                {live ? 'Live' : 'Soon'}
              </span>
            </div>
            <p className="mt-1 font-mono text-[10px] tabular-nums text-slate-500">
              {protect.length} protect · {optimize.length} optimize
              {setup.tickers.length > 0 && ` · ${setup.tickers.length} tickers`}
              {instruments.length > 0 && ` · ${instruments.length} instruments`}
              {' · Liquidity always on'}
            </p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <SetupLane title="Protect" tone="rose" items={protect} />
          <SetupLane title="Optimize" tone="emerald" items={optimize} />
        </div>

        {setup.tickers.length > 0 && (
          <div className="mt-2 rounded-lg border border-slate-700 bg-slate-950/40 p-2.5">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                Tickers
              </span>
              <span className="font-mono text-[10px] tabular-nums text-slate-600">
                {setup.tickers.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {tickersShown.map(t => (
                <span
                  key={t}
                  title={t}
                  className="inline-flex items-center gap-1 rounded border border-violet-700/40 bg-slate-950/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-violet-200"
                >
                  <TickerGlyph code={t} className="w-3 text-center text-violet-300/80" />
                  {t}
                </span>
              ))}
              {tickersExtra > 0 && (
                <span
                  className="inline-flex items-center px-1 font-mono text-[10px] text-slate-500"
                  title={setup.tickers.join(' ')}
                >
                  +{tickersExtra}
                </span>
              )}
            </div>
          </div>
        )}

        {instruments.length > 0 && (
          <div className="mt-2">
            <SetupLane
              title="Instruments"
              tone="amber"
              items={instruments.map(inst => ({
                id: inst.uid,
                label: `${inst.currency} ${RATE_INSTRUMENTS.find(i => i.id === inst.kind)?.label ?? inst.kind}`,
                hint: describeInstrument(inst),
                icon: <RateInstrumentIcon id={inst.kind} className="h-3.5 w-3.5" />,
              }))}
            />
          </div>
        )}

        <div className="mt-auto pt-3 text-[11px] font-medium text-slate-500 transition-colors group-hover:text-sky-300">
          Open desk →
        </div>
      </button>
    </article>
  );
}
