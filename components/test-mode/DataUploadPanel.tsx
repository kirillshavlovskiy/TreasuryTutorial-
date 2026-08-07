'use client';

import { useEffect, useMemo, useState } from 'react';
import { MarketRatesUpload } from '@/components/test-mode/MarketRatesUpload';
import {
  defaultOvernightCashFromNp,
  getActiveMarketRates,
  normalizeMarketRatesBundle,
  saveStoredMarketRates,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';

interface DataUploadPanelProps {
  /** Entity id or group scope — rates persist per scope. */
  scopeId: string;
  scopeLabel: string;
  /** Currencies on this entity/group book (for preview). */
  currencies?: readonly string[];
  title?: string;
}

function fmtPct(v: number): string {
  return `${v.toFixed(3)}%`;
}

/**
 * Market data — overnight cash, term deposits, EURUSD swap points.
 * Overnight → cash interest; swap points → forward carry.
 */
export function DataUploadPanel({
  scopeId,
  scopeLabel,
  currencies = ['EUR'],
  title,
}: DataUploadPanelProps) {
  const [rates, setRates] = useState<FxMarketRatesBundle>(() =>
    getActiveMarketRates(scopeId),
  );

  useEffect(() => {
    setRates(getActiveMarketRates(scopeId));
  }, [scopeId]);

  const previewCcy = currencies.includes(rates.baseCcy)
    ? rates.baseCcy
    : (currencies[0] ?? 'EUR');

  const overnight =
    rates.overnightCash ?? defaultOvernightCashFromNp(rates.baseCcy || 'EUR');

  const depositPreview = useMemo(() => {
    return rates.deposits.filter(d =>
      ['1M', '3M', '6M', '1Y', '2Y'].includes(d.tenor),
    );
  }, [rates.deposits]);

  const commit = (next: FxMarketRatesBundle) => {
    const normalized = normalizeMarketRatesBundle(next);
    saveStoredMarketRates(normalized, scopeId);
    setRates(normalized);
  };

  const patchOvernight = (
    book: 'base' | 'usd',
    side: 'creditPct' | 'debitPct',
    raw: string,
  ) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const on = {
      ...(rates.overnightCash ?? defaultOvernightCashFromNp(rates.baseCcy)),
    };
    on[book] = { ...on[book], [side]: n };
    commit({ ...rates, overnightCash: on });
  };

  return (
    <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200">
      <div>
        <h3 className="text-sm font-semibold text-white">
          {title ?? `Market data — ${scopeLabel}`}
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">
          Entity-level market data. Overnight cash → interest income; EURUSD
          Swap Points column → forward carry. Stored for{' '}
          <span className="text-slate-300">{scopeLabel}</span>.
        </p>
      </div>

      <section className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
          Upload FXO curve (deposits + swap points)
        </div>
        <MarketRatesUpload
          rates={rates}
          onRatesChange={next => {
            // Preserve edited overnight unless the file includes an ON/TN/SN row.
            const fileHasOvernightTenor = next.deposits.some(d =>
              ['ON', 'TN', 'SN'].includes(d.tenor),
            );
            const merged = normalizeMarketRatesBundle({
              ...next,
              overnightCash: fileHasOvernightTenor
                ? next.overnightCash
                : (rates.overnightCash ?? next.overnightCash),
            });
            saveStoredMarketRates(merged, scopeId);
            setRates(merged);
          }}
          ccy={previewCcy}
          scopeId={scopeId}
        />
      </section>

      <section className="rounded-lg border border-sky-700/40 bg-slate-950/40 p-3">
        <div className="mb-2">
          <div className="text-[11px] font-semibold text-sky-200">
            Overnight cash rates
          </div>
          <p className="text-[10px] text-slate-500">
            Credit / debit for cash interest income & funding — separate from
            forward pricing deposits. Defaults = JPM NP; edit or set via ON row
            in upload.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-slate-700/80 px-2 py-2">
            <div className="mb-1.5 text-[10px] font-medium text-slate-400">
              {rates.baseCcy} overnight
            </div>
            <label className="mb-1 flex items-center justify-between gap-2 text-[10px]">
              <span className="text-emerald-300/90">Credit %</span>
              <input
                type="number"
                step="0.01"
                value={overnight.base.creditPct}
                onChange={ev =>
                  patchOvernight('base', 'creditPct', ev.target.value)
                }
                className="w-20 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 font-mono text-emerald-200"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-rose-300/90">Debit %</span>
              <input
                type="number"
                step="0.01"
                value={overnight.base.debitPct}
                onChange={ev =>
                  patchOvernight('base', 'debitPct', ev.target.value)
                }
                className="w-20 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 font-mono text-rose-200"
              />
            </label>
          </div>
          <div className="rounded border border-slate-700/80 px-2 py-2">
            <div className="mb-1.5 text-[10px] font-medium text-slate-400">
              USD overnight
            </div>
            <label className="mb-1 flex items-center justify-between gap-2 text-[10px]">
              <span className="text-emerald-300/90">Credit %</span>
              <input
                type="number"
                step="0.01"
                value={overnight.usd.creditPct}
                onChange={ev =>
                  patchOvernight('usd', 'creditPct', ev.target.value)
                }
                className="w-20 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 font-mono text-emerald-200"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-rose-300/90">Debit %</span>
              <input
                type="number"
                step="0.01"
                value={overnight.usd.debitPct}
                onChange={ev =>
                  patchOvernight('usd', 'debitPct', ev.target.value)
                }
                className="w-20 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 font-mono text-rose-200"
              />
            </label>
          </div>
        </div>
      </section>

      <section className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold text-slate-300">
            Term curve + EURUSD swap points — {rates.pair}
          </div>
          <div className="text-[10px] text-slate-500">
            Deposits % p.a. · Swap points → forward carry
          </div>
        </div>
        {depositPreview.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500">
            No deposit tenors loaded — upload a rates file.
          </p>
        ) : (
          <table className="w-full min-w-[720px] text-left text-[10px]">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 pr-2 font-medium">Tenor</th>
                <th className="py-1 pr-2 font-medium text-emerald-300/80">
                  {rates.baseCcy} credit
                </th>
                <th className="py-1 pr-2 font-medium text-rose-300/80">
                  {rates.baseCcy} debit
                </th>
                <th className="py-1 pr-2 font-medium text-emerald-300/80">
                  USD credit
                </th>
                <th className="py-1 pr-2 font-medium text-rose-300/80">
                  USD debit
                </th>
                <th
                  className="py-1 pr-2 font-medium text-amber-200/90"
                  title="EUR/USD Swap Points (bid) — used for forward carry"
                >
                  Swap pts bid
                </th>
                <th
                  className="py-1 pr-2 font-medium text-amber-200/90"
                  title="EUR/USD Swap Points (ask) — used for forward carry"
                >
                  Swap pts ask
                </th>
                <th className="py-1 font-medium text-slate-400">Outright mid</th>
              </tr>
            </thead>
            <tbody>
              {depositPreview.map(d => {
                const outBid = d.outright?.bid;
                const outAsk = d.outright?.ask;
                const outMid =
                  outBid != null && outAsk != null
                    ? (outBid + outAsk) / 2
                    : null;
                return (
                  <tr
                    key={d.tenor}
                    className="border-t border-slate-800/80 font-mono text-slate-300"
                  >
                    <td className="py-1 pr-2 text-slate-400">{d.tenor}</td>
                    <td className="py-1 pr-2 text-emerald-300/90">
                      {fmtPct(d.eur.creditPct)}
                    </td>
                    <td className="py-1 pr-2 text-rose-300/90">
                      {fmtPct(d.eur.debitPct)}
                    </td>
                    <td className="py-1 pr-2 text-emerald-300/90">
                      {fmtPct(d.usd.creditPct)}
                    </td>
                    <td className="py-1 pr-2 text-rose-300/90">
                      {fmtPct(d.usd.debitPct)}
                    </td>
                    <td className="py-1 pr-2 text-amber-200/90">
                      {d.swapPoints?.bid != null
                        ? d.swapPoints.bid.toFixed(2)
                        : '—'}
                    </td>
                    <td className="py-1 pr-2 text-amber-200/90">
                      {d.swapPoints?.ask != null
                        ? d.swapPoints.ask.toFixed(2)
                        : '—'}
                    </td>
                    <td className="py-1 text-slate-400">
                      {outMid != null ? outMid.toFixed(5) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-[10px] text-slate-600">
        Analytics → Cash Carry: overnight for cash interest; Swap pts bid/ask
        for bullet/strip forward carry (interpolated to settle tenor).
      </p>
    </div>
  );
}
