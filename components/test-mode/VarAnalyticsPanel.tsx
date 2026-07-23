'use client';

import { useMemo } from 'react';
import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  buildHedgeVarSummary,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import { VAR_CONFIDENCE_OPTIONS, zForConfidence } from '@/lib/test-mode/var-confidence';
import {
  EUR_REF_EXPOSURE_M,
  expectedEurVarUsdM,
  setupLabel,
  VAR_EXPOSURE_OPTIONS,
  VAR_HORIZON_OPTIONS,
  volForHorizon,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

interface VarAnalyticsPanelProps {
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  onSetupChange: (setup: VarSetup) => void;
  /** Shared with Hedging Decision / Live Ladder — drives residual VaR. */
  hedgeRatios?: Record<string, number>;
  bookedHedges?: HedgeTicket[];
  title?: string;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

function fmtSignedM(v: number): string {
  const sign = v >= 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(2)}M`;
}

/**
 * Analytics — confidence, horizon, and exposure basis.
 * Hedging Decision / Risk Metrics / Live Ladder share this setup.
 * Live VaR table reflects booked hedges / hedge % from the Decision layer.
 */
export function VarAnalyticsPanel({
  risk,
  setup,
  onSetupChange,
  hedgeRatios = {},
  bookedHedges = [],
  title = 'Analytics — VaR setup',
}: VarAnalyticsPanelProps) {
  const z = zForConfidence(setup.confidencePct);
  const vol = volForHorizon(setup.horizon);
  const summary = useMemo(
    () => buildHedgeVarSummary(risk, hedgeRatios, setup, bookedHedges),
    [risk, hedgeRatios, setup, bookedHedges],
  );
  const eur = summary.rows.find(r => r.ccy === 'EUR');
  const expectedEur = expectedEurVarUsdM(setup);
  const hedged =
    bookedHedges.length > 0 || summary.rows.some(r => r.hedgeRatio > 1e-9);

  const patch = (partial: Partial<VarSetup>) => onSetupChange({ ...setup, ...partial });

  return (
    <div className="space-y-5 rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200">
      <div>
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          VaR ≈ |E| × spot × σ₁ₘ × √T × z. Setup updates Hedging Decision and Live Ladder; live
          residual VaR follows hedges booked there.
        </p>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Confidence
        </div>
        <div className="flex flex-wrap gap-2">
          {VAR_CONFIDENCE_OPTIONS.map(opt => (
            <button
              key={opt.pct}
              type="button"
              onClick={() => patch({ confidencePct: opt.pct })}
              className={`rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
                setup.confidencePct === opt.pct
                  ? 'border-blue-500 bg-blue-500/20 text-blue-100'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              {opt.label}
              <span className="ml-2 font-mono text-[10px] font-normal text-slate-500">
                z={opt.z}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Horizon (vol scales √T)
        </div>
        <div className="flex flex-wrap gap-2">
          {VAR_HORIZON_OPTIONS.map(opt => (
            <button
              key={opt.id}
              type="button"
              onClick={() => patch({ horizon: opt.id })}
              className={`rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
                setup.horizon === opt.id
                  ? 'border-blue-500 bg-blue-500/20 text-blue-100'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              {opt.label}
              <span className="ml-2 font-mono text-[10px] font-normal text-slate-500">
                √{opt.months}={Math.sqrt(opt.months).toFixed(2)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Exposure basis
        </div>
        <div
          className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
          role="group"
          aria-label="Exposure basis"
        >
          {VAR_EXPOSURE_OPTIONS.map(opt => {
            const on = setup.exposureBasis === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                title={opt.description}
                onClick={() => patch({ exposureBasis: opt.id })}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  on
                    ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Setup" value={setupLabel(setup)} hint="Active Analytics" accent />
        <Stat
          label="σ horizon"
          value={`${(vol * 100).toFixed(2)}%`}
          hint={`from ${(NORDTECH_VAR.monthlyVol * 100).toFixed(1)}% × √T`}
        />
        <Stat label={`z @ ${setup.confidencePct}%`} value={z.toFixed(3)} hint="Normal one-tail" />
        <Stat
          label="EUR E"
          value={`${EUR_REF_EXPOSURE_M[setup.exposureBasis].toFixed(1)}M`}
          hint={setup.exposureBasis === 'stock' ? 'stock' : 'S+1.5F'}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="VaR at Δ = 1"
          value={fmtVarK(summary.totalVarBeforeUsdM)}
          hint="Unhedged · undiversified Σ"
        />
        <Stat
          label="VaR after hedge"
          value={fmtVarK(summary.totalVarAfterUsdM)}
          hint={hedged ? 'Residual from Decision layer' : 'No hedge yet'}
          accent
        />
        <Stat
          label="VaR reduction"
          value={fmtVarK(summary.varReductionUsdM)}
          hint={
            summary.totalVarBeforeUsdM > 1e-12
              ? `${((summary.varReductionUsdM / summary.totalVarBeforeUsdM) * 100).toFixed(0)}% cut`
              : '—'
          }
        />
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5 font-mono text-[11px] text-slate-400">
        VaR ≈ |E| × spot × {(NORDTECH_VAR.monthlyVol * 100).toFixed(1)}% × √T × z → EUR ref
        (unhedged) <span className="text-emerald-300">{fmtVarK(expectedEur)}</span>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Live VaR · {setupLabel(setup)}
          {hedged ? ' · after Hedging Decision' : ' · Δ = 1 (unhedged)'}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th className="py-2 pr-3 font-medium">CCY</th>
                <th className="py-2 pr-3 font-medium">Exposure</th>
                <th className="py-2 pr-3 font-medium">Hedge %</th>
                <th className="py-2 pr-3 font-medium">Residual</th>
                <th className="py-2 pr-3 font-medium">VaR @ Δ1</th>
                <th className="py-2 font-medium">VaR after</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map(r => (
                <tr key={r.ccy} className="border-b border-slate-800/80">
                  <td className="py-2 pr-3 font-semibold">{r.ccy}</td>
                  <td className="py-2 pr-3 font-mono text-slate-400">
                    {fmtSignedM(r.exposureLocalM)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-emerald-300/90">
                    {Math.round(r.hedgeRatio * 100)}%
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-400">
                    {fmtSignedM(r.residualLocalM)}
                  </td>
                  <td
                    className={`py-2 pr-3 font-mono ${
                      r.ccy === 'EUR' ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    {fmtVarK(r.varBeforeUsdM)}
                  </td>
                  <td
                    className={`py-2 font-mono font-semibold ${
                      r.ccy === 'EUR' ? 'text-emerald-300' : 'text-slate-300'
                    }`}
                  >
                    {fmtVarK(r.varAfterUsdM)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {eur && (
          <p className="mt-2 text-[11px] text-slate-500">
            Task answer uses unhedged EUR VaR thousands:{' '}
            <span className="font-mono text-emerald-300">
              {Math.round(eur.varBeforeUsdM * 1000)}
            </span>
            {' '}(ref {Math.round(expectedEur * 1000)})
            {hedged && Math.abs(eur.residualLocalM) < 1e-9 && (
              <span className="ml-2 text-emerald-400/90">· EUR residual after hedge = 0</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        accent
          ? 'border-blue-600/40 bg-blue-500/10'
          : 'border-slate-800 bg-slate-950/50'
      }`}
    >
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${accent ? 'text-blue-200' : ''}`}>
        {value}
      </div>
      <div className="text-[10px] text-slate-600">{hint}</div>
    </div>
  );
}
