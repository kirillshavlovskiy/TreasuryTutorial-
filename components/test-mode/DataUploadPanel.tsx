'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { setMarketRatesForCcy } from '@/lib/test-mode';
import {
  cashInterestModeOf,
  clearStoredMarketRates,
  DEFAULT_EURUSD_MARKET_RATES,
  defaultOvernightCashFromLp,
  effectiveOvernightCash,
  getActiveMarketRates,
  normalizeMarketRatesBundle,
  overnightCashFromDeposits,
  parseFxoCalculatorWorkbook,
  pickPeerMarketRatesForUsd,
  pickSharedUsdOvernight,
  resolveForwardDepositRates,
  resolveMarketRatesForCcy,
  resolveOvernightCashRates,
  saveStoredMarketRates,
  stampSharedUsdOvernight,
  suggestOvernightFromSw,
  SW_TO_ON_EUR,
  type CashInterestMode,
  type DepositSideRates,
  type FxMarketRatesBundle,
  type OvernightCashRates,
} from '@/lib/fx-market-rates';

interface DataUploadPanelProps {
  /** Entity id or group scope — rates persist per scope. */
  scopeId: string;
  scopeLabel: string;
  /** Currencies on this entity/group book (for preview + per-CCY selection). */
  currencies?: readonly string[];
  title?: string;
  /** DB-persisted market data, one dataset per currency (book field). */
  marketRatesByCcy: Record<string, FxMarketRatesBundle>;
  onMarketRatesByCcyChange: (next: Record<string, FxMarketRatesBundle>) => void;
}

const ON_INDEX_LABEL: Record<string, string> = {
  EUR: 'ESTR + spread',
  USD: 'SOFR + spread',
  GBP: 'SONIA + spread',
  JPY: 'TONA + spread',
  CHF: 'SARON + spread',
  AUD: 'AONIA + spread',
  CAD: 'CORRA + spread',
};

function onIndexLabel(ccy: string): string {
  return ON_INDEX_LABEL[ccy] ?? `${ccy} O/N + spread`;
}

function fmtPct(v: number): string {
  return `${v.toFixed(3)}%`;
}

function fmtPct2(v: number): string {
  return `${v.toFixed(2)}%`;
}

function tenorSortKey(tenor: string, months: number | null): number {
  if (months != null && Number.isFinite(months)) return months;
  return 10_000 + tenor.charCodeAt(0);
}

function nearEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function sameSide(a: DepositSideRates, b: DepositSideRates): boolean {
  return (
    nearEq(a.creditPct, b.creditPct) && nearEq(a.debitPct, b.debitPct)
  );
}

function sameOvernight(a: OvernightCashRates, b: OvernightCashRates): boolean {
  return sameSide(a.base, b.base) && sameSide(a.usd, b.usd);
}

/**
 * Market data — overnight cash, term deposits, EURUSD swap points.
 * SW lives only in the term-curve table. O/N is a separate cash field + Apply.
 */
export function DataUploadPanel({
  scopeId,
  scopeLabel,
  currencies = ['EUR'],
  title,
  marketRatesByCcy,
  onMarketRatesByCcyChange,
}: DataUploadPanelProps) {
  const uploadCcys = useMemo(
    () => currencies.filter(c => c !== 'USD'),
    [currencies],
  );
  const [selectedCcy, setSelectedCcy] = useState(uploadCcys[0] ?? 'EUR');
  const previewCcy = uploadCcys.includes(selectedCcy)
    ? selectedCcy
    : (uploadCcys[0] ?? 'EUR');

  const hasUpload = Boolean(marketRatesByCcy[previewCcy]);
  const rates = resolveMarketRatesForCcy(
    marketRatesByCcy,
    previewCcy,
    scopeId,
  );

  const usdPeer = useMemo(() => {
    if (hasUpload) return { ccy: previewCcy, bundle: rates };
    return pickPeerMarketRatesForUsd(marketRatesByCcy, previewCcy);
  }, [hasUpload, previewCcy, rates, marketRatesByCcy]);

  const appliedOn = effectiveOvernightCash(rates, previewCcy);
  const sharedUsd = pickSharedUsdOvernight(marketRatesByCcy);
  const [onDraft, setOnDraft] = useState<OvernightCashRates>(() => ({
    base: { ...appliedOn.base },
    usd: { ...sharedUsd },
  }));
  const [dirty, setDirty] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDirty(false);
    const on = effectiveOvernightCash(rates, previewCcy);
    setOnDraft({
      base: { ...on.base },
      usd: { ...pickSharedUsdOvernight(marketRatesByCcy) },
    });
    // Reset draft when switching CCY / re-upload — not on every overnight edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewCcy, rates.sourceFile, rates.deposits.length, hasUpload]);

  const appliedShared: OvernightCashRates = {
    base: { ...appliedOn.base },
    usd: { ...sharedUsd },
  };
  const unsaved = dirty || !sameOvernight(onDraft, appliedShared);

  const depositPreview = useMemo(() => {
    return [...rates.deposits].sort(
      (a, b) =>
        tenorSortKey(a.tenor, a.months) - tenorSortKey(b.tenor, b.months),
    );
  }, [rates.deposits]);

  const commitBundle = (
    next: FxMarketRatesBundle,
    targetCcy: string = previewCcy,
    opts?: { stampUsd?: DepositSideRates },
  ) => {
    const quote = (next.quoteCcy || 'USD').toUpperCase();
    const stamped = normalizeMarketRatesBundle({
      ...next,
      baseCcy: targetCcy,
      quoteCcy: quote,
      pair: `${targetCcy}${quote}`,
    });
    saveStoredMarketRates(stamped, scopeId);
    let nextMap = setMarketRatesForCcy(marketRatesByCcy, targetCcy, stamped);
    if (opts?.stampUsd) {
      nextMap = stampSharedUsdOvernight(nextMap, opts.stampUsd);
    }
    onMarketRatesByCcyChange(nextMap);
  };

  const cashMode = cashInterestModeOf(rates);

  /** Upload: term curve from file; keep FCY O/N + cash mode; USD O/N stays shared. */
  const commitUpload = (next: FxMarketRatesBundle) => {
    const fileHasOn = next.deposits.some(d =>
      ['ON', 'TN', 'SN'].includes(d.tenor),
    );
    const shared = pickSharedUsdOvernight(marketRatesByCcy);
    const baseOn = fileHasOn
      ? (next.overnightCash?.base ??
        effectiveOvernightCash(next, previewCcy).base)
      : (rates.overnightCash?.base ??
        next.overnightCash?.base ??
        effectiveOvernightCash(rates, previewCcy).base);
    commitBundle(
      {
        ...next,
        overnightCash: {
          base: { ...baseOn },
          usd: { ...shared },
        },
        cashInterestMode: rates.cashInterestMode ?? next.cashInterestMode,
      },
      previewCcy,
      { stampUsd: shared },
    );
    setDirty(false);
  };

  const onFile = async (file: File | null) => {
    if (!file) return;
    setUploadError(null);
    try {
      const buf = await file.arrayBuffer();
      const parsed = parseFxoCalculatorWorkbook(buf, file.name);
      saveStoredMarketRates(parsed, scopeId);
      commitUpload(parsed);
    } catch (e) {
      setUploadError(
        e instanceof Error ? e.message : 'Failed to parse rates file',
      );
    }
  };

  const isSeed =
    rates.sourceFile === DEFAULT_EURUSD_MARKET_RATES.sourceFile &&
    rates.deposits.length === DEFAULT_EURUSD_MARKET_RATES.deposits.length;

  const clearUpload = () => {
    clearStoredMarketRates(scopeId);
    commitUpload(getActiveMarketRates(scopeId));
    setUploadError(null);
  };

  const setCashInterestMode = (mode: CashInterestMode) => {
    commitBundle({ ...rates, cashInterestMode: mode });
  };

  const patchDraft = (
    book: 'base' | 'usd',
    side: 'creditPct' | 'debitPct',
    raw: string,
  ) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setOnDraft(prev => ({
      ...prev,
      [book]: { ...prev[book], [side]: n },
    }));
    setDirty(true);
  };

  const prefillOnFromSwHint = () => {
    const hint =
      suggestOvernightFromSw(rates.deposits, previewCcy) ??
      (previewCcy === 'EUR'
        ? {
            base: { ...SW_TO_ON_EUR },
            usd: pickSharedUsdOvernight(marketRatesByCcy),
          }
        : overnightCashFromDeposits(rates.deposits, previewCcy));
    setOnDraft({
      base: { ...hint.base },
      // Prefill only touches FCY O/N; keep shared USD draft unless empty.
      usd: { ...onDraft.usd },
    });
    setDirty(true);
  };

  const applyOvernight = () => {
    const usd = { ...onDraft.usd };
    commitBundle(
      {
        ...rates,
        overnightCash: {
          base: { ...onDraft.base },
          usd,
        },
      },
      previewCcy,
      { stampUsd: usd },
    );
    setDirty(false);
  };

  /** One-click: FCY LP for this CCY + shared USD LP for all pairs. */
  const applyLpOvernight = () => {
    const lp = defaultOvernightCashFromLp(previewCcy);
    setOnDraft(lp);
    commitBundle(
      {
        ...rates,
        overnightCash: {
          base: { ...lp.base },
          usd: { ...lp.usd },
        },
      },
      previewCcy,
      { stampUsd: lp.usd },
    );
    setDirty(false);
  };

  const sourceOvernight = resolveOvernightCashRates(rates, previewCcy);
  const sourceFwd1m = resolveForwardDepositRates(rates, previewCcy, 1);

  return (
    <div className="flex flex-col gap-[22px] rounded-xl border border-slate-800 bg-slate-950 px-7 py-6 text-slate-200">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={ev => {
          void onFile(ev.target.files?.[0] ?? null);
          ev.target.value = '';
        }}
      />

      <div className="flex flex-wrap items-start justify-between gap-6 border-b border-slate-800 pb-[18px]">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold tracking-tight text-slate-50">
            {title ?? 'Market data'}
          </h3>
          <p className="max-w-[760px] text-xs leading-relaxed text-slate-500">
            {scopeLabel}-level market data. Overnight cash feeds interest
            income; the {previewCcy}USD swap points column feeds forward
            carry.
          </p>
        </div>
        <div className="flex flex-none flex-col items-end gap-2">
          <span className="inline-flex items-baseline gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-2.5 py-1 text-[11px] text-slate-500">
            Stored for
            <span className="font-semibold text-slate-200">
              {scopeLabel}
            </span>
          </span>
          {uploadCcys.length > 1 && (
            <div
              className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Market data currency"
            >
              {uploadCcys.map(ccy => {
                const hasData = Boolean(marketRatesByCcy[ccy]);
                const on = ccy === previewCcy;
                return (
                  <button
                    key={ccy}
                    type="button"
                    title={
                      hasData
                        ? `${ccy} — file uploaded`
                        : `${ccy} — no file uploaded yet`
                    }
                    onClick={() => setSelectedCcy(ccy)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                      on
                        ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                        : hasData
                          ? 'text-slate-400 hover:text-slate-300'
                          : 'text-slate-600 hover:text-slate-400'
                    }`}
                  >
                    {ccy}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            FXO curve — deposits + swap points
          </div>
          <div className="inline-flex items-center gap-1.5 text-[10px] text-slate-600">
            <span
              className={`h-[5px] w-[5px] rounded-full ${
                hasUpload ? 'bg-emerald-400' : 'bg-slate-600'
              }`}
            />
            {hasUpload
              ? `Loaded${rates.asOf?.spotDate ? ` · spot ${rates.asOf.spotDate}` : ''}`
              : 'No file uploaded — default curve in use'}
          </div>
        </div>

        <div className="flex flex-col gap-3.5 rounded-[10px] border border-slate-800 bg-slate-950/45 px-[18px] py-4">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="flex flex-wrap items-center gap-[26px]">
              <div className="flex flex-col gap-0.5">
                <div className="text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-600">
                  Source file
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-xs text-slate-200">
                    {rates.sourceFile}
                  </span>
                  <span className="rounded border border-slate-700 px-1 py-px text-[9px] font-semibold text-slate-400">
                    {rates.pair || `${previewCcy}USD`}
                  </span>
                </div>
              </div>
              <div className="h-7 w-px bg-slate-800" />
              <div className="flex flex-col gap-0.5">
                <div className="text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-600">
                  Spot date
                </div>
                <div className="font-mono text-xs text-slate-200">
                  {rates.asOf?.spotDate ?? '—'}
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <div className="text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-600">
                  ON credit / debit
                </div>
                <div className="font-mono text-xs">
                  <span className="text-emerald-400">
                    {fmtPct2(sourceOvernight.fcy.creditPct)}
                  </span>
                  <span className="text-slate-700"> / </span>
                  <span className="text-rose-400">
                    {fmtPct2(sourceOvernight.fcy.debitPct)}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <div className="text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-600">
                  Fwd 1M
                </div>
                <div className="font-mono text-xs">
                  <span className="text-emerald-400">
                    {fmtPct2(sourceFwd1m.fcy.creditPct)}
                  </span>
                  <span className="text-slate-700"> / </span>
                  <span className="text-rose-400">
                    {fmtPct2(sourceFwd1m.fcy.debitPct)}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex flex-none items-center gap-2">
              <button
                type="button"
                disabled
                title="Template download isn't wired up yet — use an existing FXOCalculator export as a starting point"
                className="h-[30px] cursor-not-allowed rounded-md border border-slate-800 px-3 text-[11px] font-medium text-slate-600"
              >
                Download template
              </button>
              {!isSeed && (
                <button
                  type="button"
                  onClick={clearUpload}
                  title={`Remove the uploaded file for ${previewCcy} and go back to the default curve`}
                  className="h-[30px] rounded-md border border-slate-800 px-3 text-[11px] font-medium text-slate-400 hover:border-slate-700 hover:text-slate-200"
                >
                  Clear upload
                </button>
              )}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title={`Upload FXOCalculator-style xlsx for ${previewCcy} (CashTable deposit Bid/Ask)`}
                className="h-[30px] rounded-md border border-sky-600 bg-sky-700 px-3.5 text-[11px] font-semibold text-sky-50 hover:bg-sky-600"
              >
                Replace file
              </button>
            </div>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-600">
            Upload loads the term deposit curve used for forward CIP.
            Overnight cash rates are edited separately, or taken from an ON
            row if present in the file.
          </p>
          {uploadError && (
            <p className="text-[10px] text-rose-300">{uploadError}</p>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              Overnight cash rates
            </div>
            <div className="text-[10px] text-slate-600">
              Credit and debit for cash interest income and funding —
              separate from forward pricing deposits. Defaults = JPM NP.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {unsaved ? (
              <span className="text-[10px] font-medium text-amber-300/90">
                unsaved
              </span>
            ) : (
              <span className="text-[10px] text-slate-600">applied</span>
            )}
            <button
              type="button"
              onClick={prefillOnFromSwHint}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-800"
              title={
                previewCcy === 'EUR'
                  ? 'Prefill FCY O/N draft: 2.150% / 2.350% (USD unchanged)'
                  : 'Prefill FCY O/N draft from SW (USD unchanged)'
              }
            >
              {previewCcy === 'EUR' ? 'Prefill 2.15 / 2.35' : 'Prefill from SW'}
            </button>
            <button
              type="button"
              onClick={applyLpOvernight}
              className="rounded border border-amber-700/50 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-100 hover:bg-amber-500/20"
              title={
                previewCcy === 'EUR'
                  ? 'Apply LP: EUR 1.78% / 2.21% here · USD 3.50% / 3.89% on all pairs'
                  : `Apply LP: ${previewCcy} here · USD LP on all pairs`
              }
            >
              Apply LP O/N
            </button>
            <button
              type="button"
              onClick={applyOvernight}
              disabled={!unsaved}
              className="rounded border border-emerald-600/60 bg-emerald-500/20 px-2.5 py-1 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
            >
              Apply O/N
            </button>
          </div>
        </div>
        {usdPeer && !hasUpload && (
          <p className="text-[10px] text-slate-600">
            Term USD peer ← {usdPeer.ccy}.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              { key: 'base' as const, ccy: previewCcy },
              { key: 'usd' as const, ccy: 'USD' },
            ] as const
          ).map(col => (
            <div
              key={col.key}
              className="flex flex-col gap-3 rounded-[10px] border border-slate-800 bg-slate-950/45 px-4 py-3.5"
            >
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-200">
                  {col.ccy} overnight
                  {col.key === 'usd' && (
                    <span className="ml-1 font-normal text-slate-600">
                      · shared (all pairs)
                    </span>
                  )}
                </div>
                <div className="font-mono text-[9px] text-slate-600">
                  {onIndexLabel(col.ccy)}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <label className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
                    <span className="h-1 w-1 rounded-full bg-emerald-400" />
                    Credit
                  </span>
                  <span className="relative flex items-center">
                    <input
                      type="number"
                      step="0.01"
                      value={onDraft[col.key].creditPct}
                      onChange={ev =>
                        patchDraft(col.key, 'creditPct', ev.target.value)
                      }
                      className="h-[30px] w-full rounded-md border border-slate-800 bg-slate-950 px-2.5 pr-6 font-mono text-xs text-slate-200 outline-none focus:border-sky-500"
                    />
                    <span className="pointer-events-none absolute right-2.5 text-[10px] text-slate-600">
                      %
                    </span>
                  </span>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 text-[10px] text-rose-400">
                    <span className="h-1 w-1 rounded-full bg-rose-400" />
                    Debit
                  </span>
                  <span className="relative flex items-center">
                    <input
                      type="number"
                      step="0.01"
                      value={onDraft[col.key].debitPct}
                      onChange={ev =>
                        patchDraft(col.key, 'debitPct', ev.target.value)
                      }
                      className="h-[30px] w-full rounded-md border border-slate-800 bg-slate-950 px-2.5 pr-6 font-mono text-xs text-slate-200 outline-none focus:border-sky-500"
                    />
                    <span className="pointer-events-none absolute right-2.5 text-[10px] text-slate-600">
                      %
                    </span>
                  </span>
                </label>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/45 px-3 py-2.5">
          <div>
            <div className="text-[10px] font-medium text-slate-300">
              Cash interest in analytics
            </div>
            <p className="text-[10px] text-slate-600">
              Current = flat O/N (e.g. LP {fmtPct2(appliedOn.base.creditPct)}
              ). Forward = rate ladder SW→1Y by month.
            </p>
          </div>
          <div
            className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
            role="group"
            aria-label="Cash interest mode"
          >
            {(
              [
                {
                  id: 'current' as const,
                  label: 'Current',
                  title: 'Flat applied O/N for every month',
                },
                {
                  id: 'forward' as const,
                  label: 'Forward',
                  title: 'Term deposits SW→1Y at each month',
                },
              ] as const
            ).map(opt => {
              const on = cashMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={opt.title}
                  onClick={() => setCashInterestMode(opt.id)}
                  className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                    on
                      ? 'bg-sky-500/25 text-sky-100 shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            Term curve + {previewCcy}USD swap points
          </div>
          <div className="text-[10px] text-slate-600">
            Deposits % p.a. · swap points feed forward carry
          </div>
        </div>

        <div className="overflow-hidden overflow-x-auto rounded-[10px] border border-slate-800 bg-slate-950/45">
          {depositPreview.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">
              No deposit tenors for {previewCcy} — upload a rates file.
            </p>
          ) : (
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                  <th className="px-4 pb-1.5 pt-2.5" />
                  <th
                    colSpan={2}
                    className="border-b border-slate-800 px-1 pb-1.5 pt-2.5 pr-4 text-right text-slate-500"
                  >
                    {previewCcy} deposits
                  </th>
                  <th
                    colSpan={2}
                    className="border-b border-slate-800 px-1 pb-1.5 pt-2.5 pr-4 text-right text-slate-500"
                  >
                    USD deposits
                  </th>
                  <th
                    colSpan={2}
                    className="border-b border-slate-800 px-1 pb-1.5 pt-2.5 pr-4 text-right text-amber-300/90"
                  >
                    {previewCcy}USD swap points
                  </th>
                  <th className="px-4 pb-1.5 pt-2.5" />
                </tr>
                <tr className="border-b border-slate-800 text-[10px] text-slate-500">
                  <th className="px-4 py-2 font-medium">Tenor</th>
                  <th className="px-1 py-2 text-right font-medium">Credit</th>
                  <th className="px-1 py-2 pr-4 text-right font-medium">
                    Debit
                  </th>
                  <th className="px-1 py-2 text-right font-medium">Credit</th>
                  <th className="px-1 py-2 pr-4 text-right font-medium">
                    Debit
                  </th>
                  <th className="px-1 py-2 text-right font-medium">Bid</th>
                  <th className="px-1 py-2 pr-4 text-right font-medium">
                    Ask
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    Outright mid
                  </th>
                </tr>
              </thead>
              <tbody>
                {depositPreview.map((d, i) => {
                  const outBid = d.outright?.bid;
                  const outAsk = d.outright?.ask;
                  const outMid =
                    outBid != null && outAsk != null
                      ? (outBid + outAsk) / 2
                      : null;
                  return (
                    <tr
                      key={d.tenor}
                      className={`border-b border-slate-800/60 font-mono text-[11.5px] tabular-nums hover:bg-slate-800/40 ${
                        i % 2 ? 'bg-slate-900/40' : ''
                      }`}
                    >
                      <td className="px-4 py-2 font-semibold text-slate-200">
                        {d.tenor}
                      </td>
                      <td className="px-1 py-2 text-right text-emerald-400">
                        {fmtPct(d.eur.creditPct)}
                      </td>
                      <td className="px-1 py-2 pr-4 text-right text-rose-400">
                        {fmtPct(d.eur.debitPct)}
                      </td>
                      <td className="px-1 py-2 text-right text-emerald-400">
                        {fmtPct(d.usd.creditPct)}
                      </td>
                      <td className="px-1 py-2 pr-4 text-right text-rose-400">
                        {fmtPct(d.usd.debitPct)}
                      </td>
                      <td className="px-1 py-2 text-right text-amber-300/90">
                        {d.swapPoints?.bid != null
                          ? d.swapPoints.bid.toFixed(2)
                          : '—'}
                      </td>
                      <td className="px-1 py-2 pr-4 text-right text-amber-300/90">
                        {d.swapPoints?.ask != null
                          ? d.swapPoints.ask.toFixed(2)
                          : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-300">
                        {outMid != null ? outMid.toFixed(5) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div className="flex items-center gap-2 pt-0.5 text-[10px] leading-relaxed text-slate-600">
        <span className="rounded border border-slate-800 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500">
          Downstream
        </span>
        <span>
          Cash Carry uses overnight for cash interest; swap points bid/ask
          for bullet and strip forward carry, interpolated to settle tenor.
          {' '}
          {cashMode === 'current'
            ? 'Cash interest mode: flat Current O/N for all months.'
            : 'Cash interest mode: Forward ladder (O/N near 0, SW→1Y by month).'}
        </span>
      </div>
    </div>
  );
}
