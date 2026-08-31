'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { setMarketRatesForCcy } from '@/lib/test-mode';
import {
  ATLAS_IMPLIED_VOL,
  ATLAS_TENOR_MONTHS,
  applyAtlasMarketRisk,
  impliedFxVol,
  impliedVolRecord,
  parseAtlasMarketRiskWorkbook,
  resolveFxCorrMatrix,
  setCorrPair,
  stampFxCorrOnBook,
  stampImpliedVolOnBook,
} from '@/lib/fx-market-risk';
import { todayIso } from '@/lib/isoDates';
import {
  fetchForwardCurves,
  fetchRefinitivAuthStatus,
  fetchVolSurfaces,
  readSessionRefinitivToken,
  writeSessionRefinitivToken,
} from '@/lib/refinitivPriceClient';
import {
  applyForwardCurvesToBundle,
  dualCcyCurveRequest,
  fxVolPullRequest,
  impliedVolFromSurface,
} from '@/lib/refinitiv-to-market';
import {
  cashInterestModeOf,
  clearStoredMarketRates,
  bundleHasCipSwapPoints,
  DEFAULT_EURUSD_MARKET_RATES,
  defaultOvernightCashFromLp,
  effectiveOvernightCash,
  fcyCcyOf,
  getActiveMarketRates,
  loadStoredMarketRates,
  normalizeMarketRatesBundle,
  overnightCashFromDeposits,
  emptyMarketRatesForCcy,
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
  usdMarketPair,
  isUsdBaseFcyPair,
  isUsdPerFcyQuoted,
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

  const hasUpload = bundleHasCipSwapPoints(marketRatesByCcy[previewCcy]);
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
  const [pullBusy, setPullBusy] = useState<'curve' | 'vol' | null>(null);
  const [ipaAuth, setIpaAuth] = useState<{
    authConfigured: boolean;
    tokenExpired: boolean;
  } | null>(null);
  const [bearerDraft, setBearerDraft] = useState('');
  const [riskOpen, setRiskOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBearerDraft(readSessionRefinitivToken());
    void fetchRefinitivAuthStatus().then(setIpaAuth).catch(() => {
      setIpaAuth({ authConfigured: false, tokenExpired: false });
    });
  }, []);

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

  // Atlas-risk / sidecar patches can leave an LP shell in the book while the
  // last FXO upload is still in scoped storage. Write that curve back so the
  // server job sees GBPUSD.xlsx instead of flat r_FCY.
  useEffect(() => {
    const scoped = loadStoredMarketRates(scopeId);
    if (!scoped || !bundleHasCipSwapPoints(scoped)) return;
    const ccy = fcyCcyOf(scoped);
    if (!ccy || ccy === 'USD' || !uploadCcys.includes(ccy)) return;
    if (bundleHasCipSwapPoints(marketRatesByCcy[ccy])) return;
    const stamped = normalizeMarketRatesBundle({
      ...scoped,
      baseCcy: ccy,
      quoteCcy: isUsdPerFcyQuoted(ccy) ? 'USD' : ccy,
      pair: usdMarketPair(ccy),
    }, ccy);
    onMarketRatesByCcyChange(setMarketRatesForCcy(marketRatesByCcy, ccy, stamped));
  }, [
    marketRatesByCcy,
    onMarketRatesByCcyChange,
    scopeId,
    uploadCcys,
  ]);

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
    const pair = usdMarketPair(targetCcy);
    const stamped = normalizeMarketRatesBundle({
      ...next,
      baseCcy: targetCcy,
      quoteCcy: isUsdPerFcyQuoted(targetCcy) ? 'USD' : targetCcy,
      pair,
    }, targetCcy);
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
      const atlas = parseAtlasMarketRiskWorkbook(buf, file.name);
      if (atlas) {
        const next = applyAtlasMarketRisk(
          marketRatesByCcy,
          atlas,
          uploadCcys,
          emptyMarketRatesForCcy,
        );
        const preview = next[previewCcy];
        if (preview) saveStoredMarketRates(preview, scopeId);
        onMarketRatesByCcyChange(next);
        return;
      }
      const parsed = await parseFxoCalculatorWorkbook(buf, file.name);
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
    commitUpload(
      previewCcy === 'EUR'
        ? getActiveMarketRates(scopeId)
        : emptyMarketRatesForCcy(previewCcy),
    );
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
  const tokenForPull = bearerDraft.trim() || undefined;

  const pullCurve = async () => {
    setUploadError(null);
    setPullBusy('curve');
    writeSessionRefinitivToken(bearerDraft);
    try {
      const asOf = todayIso();
      const result = await fetchForwardCurves(
        dualCcyCurveRequest(previewCcy, asOf),
        tokenForPull,
      );
      const next = applyForwardCurvesToBundle(rates, result.curves, previewCcy, asOf);
      commitUpload(next);
    } catch (e) {
      setUploadError(
        e instanceof Error ? e.message : 'IPA curve pull failed',
      );
    } finally {
      setPullBusy(null);
    }
  };

  const pullVol = async () => {
    setUploadError(null);
    setPullBusy('vol');
    writeSessionRefinitivToken(bearerDraft);
    try {
      const result = await fetchVolSurfaces(
        fxVolPullRequest(previewCcy, todayIso()),
        tokenForPull,
      );
      const surface = result.surfaces[0];
      if (!surface) throw new Error('IPA returned no vol surface');
      if (surface.errorMessage) throw new Error(surface.errorMessage);
      const rec = impliedVolFromSurface(surface);
      if (Object.keys(rec).length === 0) {
        throw new Error('IPA surface had no ATM tenors');
      }
      const next = stampImpliedVolOnBook(
        marketRatesByCcy,
        previewCcy,
        rec,
        emptyMarketRatesForCcy,
      );
      const preview = next[previewCcy];
      if (preview) saveStoredMarketRates(preview, scopeId);
      onMarketRatesByCcyChange(next);
      setRiskOpen(true);
    } catch (e) {
      setUploadError(
        e instanceof Error ? e.message : 'IPA vol pull failed',
      );
    } finally {
      setPullBusy(null);
    }
  };

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
            income; the {usdMarketPair(previewCcy)} swap points column feeds
            forward carry. Pull a live IPA curve or vol surface instead of
            uploading — or edit the implied-vol strip and pair ρ matrix in
            the section below.
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
                    {usdMarketPair(previewCcy)}
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
                disabled={pullBusy != null}
                onClick={() => void pullCurve()}
                title={`Fetch ${previewCcy} + USD swap ZC forwards from Refinitiv IPA and write the term table`}
                className="h-[30px] rounded-md border border-slate-600 px-3 text-[11px] font-medium text-slate-200 hover:border-slate-400 hover:text-white disabled:opacity-40"
              >
                {pullBusy === 'curve' ? 'Pulling curve…' : 'Pull curve'}
              </button>
              <button
                type="button"
                disabled={pullBusy != null}
                onClick={() => void pullVol()}
                title={`Fetch the ${usdMarketPair(previewCcy)} IPA vol surface and write the ATM strip into implied vol below`}
                className="h-[30px] rounded-md border border-slate-600 px-3 text-[11px] font-medium text-slate-200 hover:border-slate-400 hover:text-white disabled:opacity-40"
              >
                {pullBusy === 'vol' ? 'Pulling vol…' : 'Pull vol'}
              </button>
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
            Upload an FXO / Atlas xlsx, or Pull curve / Pull vol from
            Refinitiv IPA (same session as the overlay pricer). Overnight
            cash is edited separately. Pair ρ is not in IPA — edit the
            correlation matrix in the section below.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              placeholder="Optional IPA Bearer"
              value={bearerDraft}
              onChange={ev => setBearerDraft(ev.target.value)}
              onBlur={() => writeSessionRefinitivToken(bearerDraft)}
              className="h-[28px] w-[220px] rounded-md border border-slate-800 bg-slate-950 px-2 font-mono text-[10px] text-slate-300 outline-none focus:border-sky-500"
            />
            <span className="text-[10px] text-slate-600">
              {ipaAuth == null
                ? 'Checking IPA…'
                : ipaAuth.authConfigured
                  ? 'Server IPA session ready'
                  : ipaAuth.tokenExpired
                    ? 'Server token expired — paste a Bearer or set REFINITIV_* in .env.local'
                    : 'No server IPA credentials — paste a Bearer or set REFINITIV_*'}
            </span>
          </div>
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
            Term curve + {usdMarketPair(previewCcy)} swap points
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
                    {usdMarketPair(previewCcy)} swap points
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

      <DefaultRiskInputs
        ccys={uploadCcys}
        marketRatesByCcy={marketRatesByCcy}
        onCommit={onMarketRatesByCcyChange}
        open={riskOpen}
        onOpenChange={setRiskOpen}
      />

      <div className="flex items-center gap-2 pt-0.5 text-[10px] leading-relaxed text-slate-600">
        <span className="rounded border border-slate-800 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500">
          Downstream
        </span>
        <span>
          Cash Carry uses overnight for cash interest; swap points bid/ask
          for bullet and strip forward carry, interpolated to settle tenor.
          {' '}
          {isUsdBaseFcyPair(rates)
            ? `${usdMarketPair(previewCcy)} points are FCY per 1 USD. Read Bid/Ask as printed; outright = S + pts/10_000 on that quote. CIP is N × (1/F − 1/S), not N × pts/10_000. Long cover sells FCY far at the ask — negative points earn.`
            : `${usdMarketPair(previewCcy)} points are USD per 1 FCY. CIP = N × pts/10_000 (JPY /100).`}
          {' '}
          {cashMode === 'current'
            ? 'Cash interest mode: flat Current O/N for all months.'
            : 'Cash interest mode: Forward ladder (O/N near 0, SW→1Y by month).'}
          {' '}
          Group FX Optimize reads implied vol and the pair ρ matrix from
          the Implied vol + correlation section on this tab.
        </span>
      </div>
    </div>
  );
}

function rhoCellClass(rho: number, locked: boolean): string {
  if (locked) return 'bg-slate-900/80 text-slate-500';
  if (rho >= 0.7) return 'bg-emerald-500/20';
  if (rho >= 0.4) return 'bg-emerald-500/10';
  if (rho <= -0.15) return 'bg-rose-500/20';
  if (rho < 0) return 'bg-rose-500/10';
  return '';
}

function DefaultRiskInputs({
  ccys,
  marketRatesByCcy,
  onCommit,
  open,
  onOpenChange,
}: {
  ccys: readonly string[];
  marketRatesByCcy: Record<string, FxMarketRatesBundle>;
  onCommit: (next: Record<string, FxMarketRatesBundle>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bookCcys = ccys.filter(c => c !== 'USD');
  const bookSet = new Set(bookCcys);
  const corr = resolveFxCorrMatrix(marketRatesByCcy);
  const matrixCcys = corr.ccys.filter(c => c !== 'USD');
  const volCcys = [
    ...bookCcys,
    ...Object.keys(ATLAS_IMPLIED_VOL)
      .filter(c => c !== 'USD' && !bookSet.has(c))
      .sort(),
  ];
  const uploaded = bookCcys.some(c => {
    const p = marketRatesByCcy[c]?.parameters;
    return Boolean(p?.atlasCorr) || Boolean(p?.atlasRiskFile);
  });
  const riskFile = bookCcys
    .map(c => marketRatesByCcy[c]?.parameters?.atlasRiskFile)
    .find((v): v is string => typeof v === 'string');
  const source = riskFile ?? 'Default';

  const commitVol = (ccy: string, months: number, pct: number) => {
    if (!Number.isFinite(pct) || pct <= 0 || pct > 80) return;
    const rec = {
      ...(marketRatesByCcy[ccy]?.impliedVolByTenor ?? impliedVolRecord(ccy) ?? {}),
      [String(months)]: pct / 100,
    };
    onCommit(
      stampImpliedVolOnBook(
        marketRatesByCcy,
        ccy,
        rec,
        emptyMarketRatesForCcy,
      ),
    );
  };

  const commitCorr = (a: string, b: string, rho: number) => {
    if (!Number.isFinite(rho)) return;
    const next = setCorrPair(corr, a, b, rho);
    onCommit(
      stampFxCorrOnBook(marketRatesByCcy, next, bookCcys, emptyMarketRatesForCcy),
    );
  };

  const commitDecay = (k: number) => {
    if (!Number.isFinite(k) || k < 0 || k > 8) return;
    onCommit(
      stampFxCorrOnBook(
        marketRatesByCcy,
        { ...corr, tenorDecay: k },
        bookCcys,
        emptyMarketRatesForCcy,
      ),
    );
  };

  return (
    <section className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full flex-wrap items-baseline justify-between gap-3 text-left"
      >
        <div className="flex flex-wrap items-baseline gap-2.5">
          <span className={`text-[9px] ${open ? 'text-slate-400' : 'text-slate-600'}`}>
            {open ? '▾' : '▸'}
          </span>
          <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            Implied vol surface + pair correlation matrix
          </div>
          <div className="text-[10px] text-slate-600">
            Edit cells here. σ is % p.a. by tenor (the vol surface Optimize
            uses). ρ is the daily pair matrix — IPA does not supply this;
            type a value or upload an Atlas report. {matrixCcys.length}×
            {matrixCcys.length}, book names highlighted.
          </div>
        </div>
        <div className="inline-flex items-center gap-1.5 text-[10px] text-slate-600">
          <span
            className={`h-[5px] w-[5px] rounded-full ${
              uploaded ? 'bg-emerald-400' : 'bg-slate-600'
            }`}
          />
          {uploaded ? `Uploaded · ${source}` : 'Default'}
        </div>
      </button>

      {open && (
        <>
          <div className="overflow-x-auto rounded-[10px] border border-slate-800 bg-slate-950/45">
            <table className="w-full min-w-[640px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] text-slate-500">
                  <th className="sticky left-0 z-[1] bg-slate-950 px-3 py-2 font-medium">
                    σ implied %
                  </th>
                  {ATLAS_TENOR_MONTHS.map(m => (
                    <th key={m} className="px-1 py-2 text-right font-medium">
                      {m === 12 ? '1y' : `${m}m`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {volCcys.map(ccy => {
                  const onBook = bookSet.has(ccy);
                  return (
                    <tr
                      key={ccy}
                      className={`border-b border-slate-800/60 ${
                        onBook ? 'bg-violet-500/[0.06]' : ''
                      }`}
                    >
                      <td
                        className={`sticky left-0 z-[1] px-3 py-1.5 font-semibold ${
                          onBook
                            ? 'bg-slate-950 text-violet-200'
                            : 'bg-slate-950 text-slate-400'
                        }`}
                      >
                        {ccy}
                      </td>
                      {ATLAS_TENOR_MONTHS.map(m => (
                        <td key={m} className="px-1 py-1">
                          <input
                            type="number"
                            step="0.01"
                            min="0.1"
                            max="80"
                            disabled={!onBook}
                            defaultValue={(
                              impliedFxVol(ccy, m, marketRatesByCcy[ccy]) * 100
                            ).toFixed(2)}
                            key={`${ccy}-${m}-${impliedFxVol(ccy, m, marketRatesByCcy[ccy]).toFixed(5)}`}
                            onBlur={ev =>
                              commitVol(ccy, m, Number(ev.target.value))
                            }
                            className="h-7 w-14 rounded border border-slate-800 bg-slate-950 px-1 text-right font-mono text-[11px] text-slate-200 outline-none focus:border-sky-500 disabled:text-slate-500"
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-600">
            <label className="inline-flex items-center gap-1.5">
              Tenor decay k
              <input
                type="number"
                step="0.01"
                min="0"
                max="8"
                defaultValue={(corr.tenorDecay ?? 0).toFixed(3)}
                key={`k-${corr.tenorDecay ?? 0}`}
                onBlur={ev => commitDecay(Number(ev.target.value))}
                className="h-7 w-16 rounded border border-slate-800 bg-slate-950 px-1.5 text-right font-mono text-[11px] text-slate-200 outline-none focus:border-sky-500"
              />
            </label>
            <span>ρ_tenor = ρ_pair × exp(−k |ΔT| / 12)</span>
            <span>
              Book {bookCcys.join(' · ')} highlighted
            </span>
          </div>

          <div className="overflow-auto rounded-[10px] border border-slate-800 bg-slate-950/45">
            <table className="text-left text-[10px]">
              <thead>
                <tr className="border-b border-slate-800 text-[9px] text-slate-500">
                  <th className="sticky left-0 z-[1] bg-slate-950 px-2 py-2 font-medium">
                    ρ
                  </th>
                  {matrixCcys.map(c => (
                    <th
                      key={c}
                      className={`px-0.5 py-2 text-center font-medium ${
                        bookSet.has(c) ? 'text-violet-300' : ''
                      }`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrixCcys.map((rowCcy, i) => (
                  <tr key={rowCcy} className="border-b border-slate-800/50">
                    <td
                      className={`sticky left-0 z-[1] bg-slate-950 px-2 py-0.5 font-semibold ${
                        bookSet.has(rowCcy) ? 'text-violet-200' : 'text-slate-400'
                      }`}
                    >
                      {rowCcy}
                    </td>
                    {matrixCcys.map((colCcy, j) => {
                      const i0 = corr.ccys.indexOf(rowCcy);
                      const j0 = corr.ccys.indexOf(colCcy);
                      const rho =
                        i0 >= 0 && j0 >= 0
                          ? corr.matrix[i0]![j0]!
                          : rowCcy === colCcy
                            ? 1
                            : 0;
                      const locked = i === j;
                      return (
                        <td
                          key={colCcy}
                          className={`px-0.5 py-0.5 ${rhoCellClass(rho, locked)}`}
                        >
                          <input
                            type="number"
                            step="0.01"
                            min="-1"
                            max="1"
                            disabled={locked}
                            defaultValue={rho.toFixed(3)}
                            key={`${rowCcy}-${colCcy}-${rho.toFixed(5)}`}
                            onBlur={ev =>
                              commitCorr(rowCcy, colCcy, Number(ev.target.value))
                            }
                            title={`${rowCcy}/${colCcy} ${rho.toFixed(3)}`}
                            className="h-6 w-[2.55rem] rounded border-0 bg-transparent px-0.5 text-right font-mono text-[10px] tabular-nums text-slate-200 outline-none focus:bg-slate-900 focus:ring-1 focus:ring-sky-500 disabled:cursor-default"
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
