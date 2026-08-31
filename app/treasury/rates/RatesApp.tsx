'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/BrandMark';
import { ModeNav } from '@/components/ModeNav';
import { INITIAL_ROWS } from '@/lib/fx-buffer';
import type { FxRatePair, FxRatesResult, FxRatesStatus } from '@/lib/treasury/fx-rates';

const MODEL_CURRENCIES = [...INITIAL_ROWS.map(r => r.ccy)].sort();
const DEFAULT_PAIRS: FxRatePair[] = MODEL_CURRENCIES.map(ccy => ({ base: ccy, target: 'USD' }));

interface RatesAppProps {
  accountMenu: ReactNode;
  sandboxEnabled?: boolean;
  /** Whether Treasury OAuth is configured server-side at all (OKTA_* env set). */
  treasuryAvailable?: boolean;
  /**
   * Server-enforced pair limit (lib/treasury/fx-rates.ts MAX_PAIRS), passed
   * down rather than imported directly — that module also exports the
   * server-only getTreasuryFxRatesForUser, which pulls in node:crypto and
   * sequelize via token-store.ts; a value import here would drag those into
   * the client bundle. A type-only import (see below) is compiler-erased
   * and stays safe.
   */
  maxPairs: number;
}

interface PairDraft {
  id: string;
  base: string;
  target: string;
}

let draftSeq = 0;
function nextDraftId(): string {
  draftSeq += 1;
  return `draft-${draftSeq}`;
}

function toDrafts(pairs: FxRatePair[]): PairDraft[] {
  return pairs.map(p => ({ id: nextDraftId(), base: p.base, target: p.target }));
}

async function fetchRates(pairs: FxRatePair[]): Promise<FxRatesResult> {
  const res = await fetch('/api/treasury/fx-rates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body as FxRatesResult;
}

export function RatesApp({ accountMenu, sandboxEnabled = true, treasuryAvailable = false, maxPairs }: RatesAppProps) {
  const [drafts, setDrafts] = useState<PairDraft[]>(() => toDrafts(DEFAULT_PAIRS));
  const [result, setResult] = useState<FxRatesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const runRefresh = async (pairs: FxRatePair[]) => {
    setLoading(true);
    setFetchError(null);
    try {
      const data = await fetchRates(pairs);
      setResult(data);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setLoading(false);
    }
  };

  // Fetch the default book once on mount only — subsequent refreshes are
  // user-triggered via the Refresh button below, so runRefresh/treasuryAvailable
  // are deliberately not in the dependency array.
  useEffect(() => {
    if (treasuryAvailable) {
      runRefresh(DEFAULT_PAIRS);
    }
  }, []);

  const updateDraft = (id: string, field: 'base' | 'target', value: string) => {
    const next = value.toUpperCase().slice(0, 3);
    setDrafts(prev => prev.map(d => (d.id === id ? { ...d, [field]: next } : d)));
  };

  const removeDraft = (id: string) => {
    setDrafts(prev => prev.filter(d => d.id !== id));
  };

  const addDraft = () => {
    setDrafts(prev => (prev.length >= maxPairs ? prev : [...prev, { id: nextDraftId(), base: '', target: 'USD' }]));
  };

  const handleRefreshClick = () => {
    const pairs = drafts
      .map(d => ({ base: d.base.trim().toUpperCase(), target: d.target.trim().toUpperCase() }))
      .filter(p => p.base.length === 3 && p.target.length === 3);
    if (pairs.length === 0) {
      setFetchError('Add at least one valid { base, target } pair (3-letter codes).');
      return;
    }
    runRefresh(pairs);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <BrandMark href="/" label="Treasury Workbench" />
          <div className="flex flex-wrap items-center gap-3">
            <ModeNav sandboxEnabled={sandboxEnabled} />
            {accountMenu}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-xl font-semibold text-white">Treasury FX Rates</h1>
        <p className="mt-1 text-sm text-slate-400">
          PoC — live market rates via the Treasury Finance MCP (<code className="text-slate-300">fx_rate_lookup</code>), latest only.
        </p>

        <div className="mt-6">
          <StatusBanner treasuryAvailable={treasuryAvailable} status={result?.status ?? null} errorMessage={result?.errorMessage} />
        </div>

        <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-slate-200">Currency pairs ({drafts.length}/{maxPairs})</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={addDraft}
                disabled={drafts.length >= maxPairs}
                className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-blue-500 hover:text-blue-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                + Add pair
              </button>
              <button
                type="button"
                onClick={handleRefreshClick}
                disabled={loading || !treasuryAvailable}
                className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {drafts.map(d => (
              <div
                key={d.id}
                className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1.5"
              >
                <input
                  value={d.base}
                  onChange={e => updateDraft(d.id, 'base', e.target.value)}
                  maxLength={3}
                  aria-label="Base currency"
                  className="w-14 bg-transparent text-center text-xs uppercase text-slate-100 outline-none"
                />
                <span className="text-slate-600">/</span>
                <input
                  value={d.target}
                  onChange={e => updateDraft(d.id, 'target', e.target.value)}
                  maxLength={3}
                  aria-label="Target currency"
                  className="w-14 bg-transparent text-center text-xs uppercase text-slate-100 outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeDraft(d.id)}
                  aria-label={`Remove pair ${d.base}/${d.target}`}
                  className="ml-auto text-xs text-slate-600 transition-colors hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        {fetchError && (
          <div className="mt-4 rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            {fetchError}
          </div>
        )}

        {result && result.status === 'live' && (
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="mb-3 text-xs text-slate-500">
              Treasury MCP · fx_rate_lookup · latest · fetched at {new Date(result.fetchedAt).toLocaleString()}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2">Pair</th>
                  <th className="pb-2 text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {result.rates.map(r => (
                  <tr key={`${r.base}-${r.target}`} className="border-b border-slate-900">
                    <td className="py-1.5 text-slate-200">
                      {r.base}/{r.target}
                    </td>
                    <td className="py-1.5 text-right font-mono text-slate-100">{r.rate.toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {result.missing.length > 0 && (
              <div className="mt-4 text-xs text-amber-300">
                No rate available for: {result.missing.map(m => `${m.base}/${m.target}`).join(', ')}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function StatusBanner({
  treasuryAvailable,
  status,
  errorMessage,
}: {
  treasuryAvailable: boolean;
  status: FxRatesStatus | null;
  errorMessage?: string;
}) {
  if (!treasuryAvailable) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-400">
        Treasury OAuth is not configured in this environment.
      </div>
    );
  }

  if (status === null || status === 'not_connected') {
    return (
      <form action="/api/treasury/oauth/connect" method="get">
        <button
          type="submit"
          className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-blue-500 hover:text-blue-300"
          title="Connect Treasury to pull live FX rates"
        >
          Connect Treasury
        </button>
      </form>
    );
  }

  if (status === 'reauth_required') {
    return (
      <form action="/api/treasury/oauth/connect" method="get">
        <button
          type="submit"
          className="rounded-lg border border-amber-700 bg-amber-950/40 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:border-amber-500"
          title="Treasury connection expired — reconnect to resume live data"
        >
          Reconnect Treasury
        </button>
      </form>
    );
  }

  if (status === 'error') {
    return (
      <span
        className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-1.5 text-xs font-medium text-red-300"
        title={errorMessage}
      >
        {errorMessage ?? 'Treasury data unavailable'}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="rounded-lg border border-emerald-800 bg-emerald-950/30 px-3 py-1.5 text-xs font-medium text-emerald-300">
        Treasury live
      </span>
      <form action="/api/treasury/oauth/disconnect" method="post">
        <button type="submit" className="text-xs text-slate-500 transition-colors hover:text-red-400">
          Disconnect
        </button>
      </form>
    </div>
  );
}
