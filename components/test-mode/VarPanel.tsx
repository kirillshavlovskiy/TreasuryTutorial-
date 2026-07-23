'use client';

import type { LadderBar, VarResult } from '@/lib/test-mode';
import { NORDTECH_REFERENCE } from '@/lib/test-mode';

interface VarPanelProps {
  bar: LadderBar | null;
  result: VarResult | null;
}

export function VarPanel({ bar, result }: VarPanelProps) {
  if (!bar || !result) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="text-sm font-semibold text-white">1-month 95% VaR</h3>
        <p className="mt-2 text-xs text-slate-500">
          Select a currency on the ladder (start with EUR — the largest mismatch).
        </p>
      </div>
    );
  }

  const varK = result.varUsdM * 1000;
  const handK = NORDTECH_REFERENCE.handEstimateUsdM * 1000;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="text-sm font-semibold text-white">1-month 95% VaR</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Horizon {result.horizonLabel} · Confidence {result.confidenceLabel} · Currency {result.ccy}
      </p>

      <div className="mt-4">
        <div className="text-3xl font-bold tracking-tight text-white">
          ${varK.toFixed(0)}K
        </div>
        <div className="mt-1 text-xs text-slate-400">
          USD reporting · exposure basis:{' '}
          <span className="font-medium text-slate-300">
            {result.exposureBasis === 'stock' ? 'stock net' : '3-month average'}
          </span>{' '}
          ({result.exposureLocalM >= 0 ? '+' : ''}
          {result.exposureLocalM.toFixed(1)}M {result.ccy})
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-slate-800/60 px-3 py-2">
          <dt className="text-slate-500">Monthly vol</dt>
          <dd className="font-mono text-slate-200">{(result.monthlyVol * 100).toFixed(1)}%</dd>
        </div>
        <div className="rounded-lg bg-slate-800/60 px-3 py-2">
          <dt className="text-slate-500">z-score (95%)</dt>
          <dd className="font-mono text-slate-200">{result.z95}</dd>
        </div>
      </dl>

      {result.ccy === 'EUR' && (
        <p className="mt-4 rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2 text-xs leading-relaxed text-slate-300">
          Episode hand estimate ≈ ${handK.toFixed(0)}K. Dashboard figure ${varK.toFixed(0)}K —
          same order of magnitude; EUR dominates group FX risk.
        </p>
      )}
    </div>
  );
}
