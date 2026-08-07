'use client';

import { useRef, useState } from 'react';
import {
  clearStoredMarketRates,
  DEFAULT_EURUSD_MARKET_RATES,
  getActiveMarketRates,
  parseFxoCalculatorWorkbook,
  resolveForwardDepositRates,
  resolveOvernightCashRates,
  saveStoredMarketRates,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';

interface MarketRatesUploadProps {
  rates: FxMarketRatesBundle;
  onRatesChange: (next: FxMarketRatesBundle) => void;
  /** CCY used for the compact 1M credit/debit preview. */
  ccy?: string;
  /** Entity / group scope for persistence. */
  scopeId?: string;
}

export function MarketRatesUpload({
  rates,
  onRatesChange,
  ccy = 'EUR',
  scopeId,
}: MarketRatesUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const overnight = resolveOvernightCashRates(rates, ccy);
  const fwd1m = resolveForwardDepositRates(rates, ccy, 1);
  const isSeed =
    rates.sourceFile === DEFAULT_EURUSD_MARKET_RATES.sourceFile &&
    rates.deposits.length === DEFAULT_EURUSD_MARKET_RATES.deposits.length;

  const onFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseFxoCalculatorWorkbook(buf, file.name);
      saveStoredMarketRates(parsed, scopeId);
      onRatesChange(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse rates file');
    }
  };

  return (
    <div className="mb-2 rounded-md border border-slate-700/80 bg-slate-950/60 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Market rates
        </span>
        <span className="font-mono text-[10px] text-slate-300">
          {rates.pair} · {rates.sourceFile}
          {rates.asOf?.spotDate ? ` · spot ${rates.asOf.spotDate}` : ''}
        </span>
        <span
          className="font-mono text-[9px] text-amber-200/90"
          title="Overnight cash (credit/debit) · term 1M for forward CIP"
        >
          ON {overnight.fcy.creditPct.toFixed(2)}%/
          {overnight.fcy.debitPct.toFixed(2)}% · fwd1M{' '}
          {fwd1m.fcy.creditPct.toFixed(2)}%/{fwd1m.fcy.debitPct.toFixed(2)}%
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={ev => {
            void onFile(ev.target.files?.[0] ?? null);
            ev.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded border border-sky-600/50 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/20"
          title="Upload FXOCalculator-style xlsx (CashTable EUR/USD deposit Bid/Ask)"
        >
          Upload rates
        </button>
        {!isSeed && (
          <button
            type="button"
            onClick={() => {
              clearStoredMarketRates(scopeId);
              onRatesChange(getActiveMarketRates(scopeId));
              setError(null);
            }}
            className="rounded border border-slate-600 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800"
            title="Restore bundled FXOCalculator EURUSD seed"
          >
            Reset to seed
          </button>
        )}
      </div>
      <p className="mt-1 text-[8px] leading-relaxed text-slate-600">
        Upload loads the term deposit curve for forward CIP. Overnight cash
        rates are edited separately (or taken from an ON row if present).
      </p>
      {error && (
        <p className="mt-1 text-[10px] text-rose-300">{error}</p>
      )}
    </div>
  );
}
