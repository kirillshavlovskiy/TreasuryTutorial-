'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CfarDrawdownChart } from '@/components/test-mode/CfarDrawdownChart';
import {
  buildCashForecastCarryComparison,
  resolvedHedgedTotalCarryUsdM,
} from '@/lib/test-mode/cash-carry-analytics';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import { type CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';
import {
  computeHedgeCfarBands,
  settlementFundingGapForHedge,
  type CfarRiskBreakdown,
  type FundingGapResult,
} from '@/lib/test-mode/cfar-residual';
import {
  VAR_CONFIDENCE_OPTIONS,
  zForConfidence,
} from '@/lib/test-mode/var-confidence';
import {
  isLiveHedgeTicket,
  stripTicketsForCcy,
  type HedgeTicket,
  type PreparedHedgeLeg,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import {
  VAR_VOL_SOURCE_OPTIONS,
  horizonMonths,
  monthlyVolForSetup,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import {
  resolveMarketRatesForCcy,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import type { RowState } from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  monthlyFlowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';

interface CfarAnalysisViewProps {
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  /** Edit the shared VaR setup (σ source + confidence) from the CFaR tab. */
  onSetupChange?: (setup: VarSetup) => void;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  ratesScopeId?: string;
  marketRates?: FxMarketRatesBundle;
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
}

function fmtK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}
function fmtSignedK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.5) return '$0K';
  return `${k >= 0 ? '+' : '−'}$${Math.abs(k).toFixed(0)}K`;
}
function fmtM(m: number): string {
  return `${m >= 0 ? '' : '−'}${Math.abs(m).toFixed(1)}M`;
}
function fmtPct(pct: number): string {
  return `${pct.toFixed(0)}%`;
}

/** One leg of the actual hedge applied to a currency (booked or prepared). */
interface HedgeLegDetail {
  label: string;
  settleMonths: number;
  tradeNotionalLocalM: number;
  cumulCoverLocalM: number;
}

/** The real hedge feeding the "current" CFaR numbers for one currency. */
interface HedgeDetail {
  source: 'booked' | 'prepared-strip' | 'prepared-bullet' | 'none';
  legs: HedgeLegDetail[];
  totalNotionalLocalM: number;
}

/**
 * Resolve exactly what hedge is driving the "current" row — same priority
 * order as {@link residualKnotsForHedge}: booked strip → booked bullet →
 * prepared strip → prepared bullet → none. Lets the desk verify what CFaR is
 * actually simulating instead of trusting the Hedged/Strip·N badge alone.
 */
function hedgeDetailForCcy(
  bookedHedges: readonly HedgeTicket[],
  preparedByCcy: Record<string, PreparedHedgeProfile> | undefined,
  ccy: string,
  setup: VarSetup,
): HedgeDetail {
  const bookedStrip = stripTicketsForCcy(bookedHedges, ccy)
    .slice()
    .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
  if (bookedStrip.length > 0) {
    let cum = 0;
    const legs = bookedStrip.map((t, i) => {
      cum += t.amountLocalM;
      return {
        label: t.maturityLabel ?? `Leg ${i + 1}`,
        settleMonths: horizonMonths(t.maturity ?? setup.horizon),
        tradeNotionalLocalM: t.amountLocalM,
        cumulCoverLocalM: cum,
      };
    });
    return { source: 'booked', legs, totalNotionalLocalM: cum };
  }
  const bookedBullet = bookedHedges.find(
    t => t.ccy === ccy && isLiveHedgeTicket(t) && !t.stripId,
  );
  if (bookedBullet) {
    const settle = horizonMonths(bookedBullet.maturity ?? setup.horizon);
    return {
      source: 'booked',
      legs: [
        {
          label: bookedBullet.maturityLabel ?? `M${Math.round(settle)}`,
          settleMonths: settle,
          tradeNotionalLocalM: bookedBullet.amountLocalM,
          cumulCoverLocalM: bookedBullet.amountLocalM,
        },
      ],
      totalNotionalLocalM: bookedBullet.amountLocalM,
    };
  }
  const prep = preparedByCcy?.[ccy];
  if (prep?.structure === 'strip' && prep.legs.length > 0) {
    const legs = prep.legs.map(l => ({
      label: l.label,
      settleMonths: l.settleMonths ?? l.endMonth,
      tradeNotionalLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
      cumulCoverLocalM: l.hedgeLocalM,
    }));
    return { source: 'prepared-strip', legs, totalNotionalLocalM: prep.coverLocalM };
  }
  if (prep && Math.abs(prep.coverLocalM) > 1e-9) {
    const settle = prep.settleMonths ?? horizonMonths(setup.horizon);
    return {
      source: 'prepared-bullet',
      legs: [
        {
          label: `M${Math.round(settle)}`,
          settleMonths: settle,
          tradeNotionalLocalM: prep.coverLocalM,
          cumulCoverLocalM: prep.coverLocalM,
        },
      ],
      totalNotionalLocalM: prep.coverLocalM,
    };
  }
  return { source: 'none', legs: [], totalNotionalLocalM: 0 };
}

/** One editable row in the What-if hedge table — mirrors the real Strip
 * Schedule · Tick Trades table (On / Settle / Notional Δ) in the Cash Carry
 * hedging modal, so this editor has the same shape as the real thing. */
interface WhatIfLegRow {
  id: number;
  on: boolean;
  settleMonths: number;
  amountLocalM: number;
}

/** Seed the what-if table from the REAL applied hedge (one row per leg) so
 * editing starts at parity with "current" — never an arbitrary default. */
/** Round to sane display/edit precision — raw division (e.g. total/legCount)
 * produces 15-significant-digit floats that render unreadably in a number
 * input (and via locale formatting can even show a comma as the decimal
 * separator, e.g. "7,7823308270676685"). */
function roundMonths(v: number): number {
  return Math.round(v * 100) / 100;
}
function roundNotionalM(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function seedWhatIfLegs(detail: HedgeDetail | null, tenureMonths: number): WhatIfLegRow[] {
  if (!detail || detail.legs.length === 0) {
    return [{ id: 0, on: true, settleMonths: roundMonths(tenureMonths), amountLocalM: 0 }];
  }
  return detail.legs.map((l, i) => ({
    id: i,
    on: true,
    settleMonths: roundMonths(l.settleMonths),
    amountLocalM: roundNotionalM(l.tradeNotionalLocalM),
  }));
}

/** Current → proposed comparison row for the what-if panel. */
function WhatIfDeltaRow({
  label,
  current,
  proposed,
  fmt,
  lowerIsBetter,
  note,
}: {
  label: string;
  current: number;
  proposed: number;
  fmt: (v: number) => string;
  lowerIsBetter: boolean;
  /** Short expectation-setting hint shown under the delta (e.g. "expect flat"). */
  note?: string;
}) {
  const delta = proposed - current;
  const improved = lowerIsBetter ? delta < -1e-9 : delta > 1e-9;
  const worsened = lowerIsBetter ? delta > 1e-9 : delta < -1e-9;
  const deltaColor = improved
    ? 'text-emerald-300'
    : worsened
      ? 'text-rose-300'
      : 'text-slate-500';
  return (
    <div
      className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5"
      title={note}
    >
      <div className="text-[9px] uppercase text-slate-500">{label}</div>
      <div className="flex items-baseline gap-1.5 font-mono">
        <span className="text-slate-500">{fmt(current)}</span>
        <span className="text-slate-600">→</span>
        <span className="font-semibold text-slate-100">{fmt(proposed)}</span>
      </div>
      <div className={`font-mono text-[9px] ${deltaColor}`}>
        Δ {fmtSignedK(delta)}
      </div>
      {note && (
        <div className="mt-0.5 text-[9px] leading-snug text-slate-600">
          {note}
        </div>
      )}
    </div>
  );
}

/**
 * Cumulative carry accrued to the end of each month (USD M), taken from the
 * realized platform book (`buildCashForecastSchedule` months) and scaled so its
 * terminal value equals the resolved total carry. Lets the CFaR offset trace
 * the exact book shape (front/back-skewed strips) instead of a flat ramp.
 * Returns undefined when the shape carries no signal (sim falls back to linear).
 */
function cumulativeCarrySchedule(
  months: readonly { hedgeCarryUsdM: number }[] | undefined,
  totalUsdM: number,
): number[] | undefined {
  if (!months || months.length === 0) return undefined;
  const cum: number[] = [];
  let acc = 0;
  for (const m of months) {
    acc += Number.isFinite(m.hedgeCarryUsdM) ? m.hedgeCarryUsdM : 0;
    cum.push(acc);
  }
  const last = cum[cum.length - 1] ?? 0;
  if (Math.abs(last) < 1e-12) return undefined;
  const scale = totalUsdM / last;
  return cum.map(c => c * scale);
}

interface CfarRow {
  ccy: string;
  stockM: number;
  endM: number;
  flows: number[];
  hedged: boolean;
  structLabel: string | null;
  totalCarryUsdM: number;
  bands: CfarBandsResult & { breakdown: CfarRiskBreakdown };
  fundingGap: FundingGapResult | null;
}

/** What-if hedge scenario result — same shape family as the live row. */
interface WhatIfResult {
  totalNotionalLocalM: number;
  hedged: boolean;
  bands: CfarBandsResult & { breakdown: CfarRiskBreakdown };
  fundingGap: FundingGapResult | null;
  totalCarryUsdM: number;
}

/**
 * CFaR analysis tab — critical cash absorption per currency, computed off the
 * REAL hedge chosen in Cash Carry via {@link computeHedgeCfarBands}, which
 * combines three risk sources (RSS, closed form, no simulation):
 *
 * 1. Spot risk — the piece of the gap with NO forward dealt at all
 *    (r_trade(t) = e(t)−H_traded(t)). Converting this needs an outright spot
 *    trade with nothing to net against, so it's exposed to full FX vol.
 * 2. Forecast/quantity uncertainty — e(t) is a forecast; any shortfall or
 *    excess beyond what's hedged gets covered on the real spot market too,
 *    so it's folded (RSS) into the spot-risk magnitude — same σ_E convention
 *    as the Analytics VaR engine (forecastErrorStdForSetupM in var-setup.ts).
 * 3. Swap-bridge risk — the piece that's already DEALT but not yet SETTLED
 *    (H_traded(t)−H_settled(t)). Bridging this via spot+swap-back has ~zero
 *    net spot exposure (the eventual forward delivery cancels the swap's far
 *    leg) — only the swap points at the future bridge moment are uncertain,
 *    sized off a flat assumed rate-differential vol per currency
 *    (RATE_DIFF_VOL_BP_YR in cfar-residual.ts), not FX vol.
 *
 * This genuinely depends on strip leg count and spacing through both (1) and
 * (3): discrete legs settling against continuously-accruing exposure produce
 * a sawtooth between settlements — more, better-spaced legs shrink it, and
 * CFaR shrinks toward zero (pure carry) in the limit of continuous matching.
 * The "Funding gap" column is the same g(t)=e−H_settled's deterministic
 * (zero-vol) floor — see {@link settlementFundingGapForHedge}. Styling
 * follows the hedge carry profile modal locked kit (slate sections · violet
 * CCY select · yellow CFaR).
 */
export function CfarAnalysisView({
  risk,
  setup,
  onSetupChange,
  bookedHedges,
  preparedByCcy,
  bookRows,
  forecastProfile,
  ratesScopeId,
  marketRates: marketRatesProp,
  marketRatesByCcy,
}: CfarAnalysisViewProps) {
  const marketRatesFor = (ccy: string): FxMarketRatesBundle =>
    marketRatesProp ??
    resolveMarketRatesForCcy(marketRatesByCcy, ccy, ratesScopeId);

  const patch = (partial: Partial<VarSetup>) =>
    onSetupChange?.({ ...setup, ...partial });
  const sigmaMonthly = monthlyVolForSetup(setup);
  const zConf = zForConfidence(setup.confidencePct);

  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  const T = Tf > 0 ? Tf : horizonMonths(setup.horizon);

  const rows = useMemo<CfarRow[]>(() => {
    const ccys = risk
      .map(r => r.bar.ccy)
      .filter(ccy => ccy !== 'USD' && ccy.length > 0);
    return ccys
      .map((ccy): CfarRow | null => {
        const bar = risk.find(r => r.bar.ccy === ccy)?.bar;
        const bookRow = bookRows?.find(r => r.ccy === ccy);
        const stockM =
          bar?.stockNetM ??
          (typeof bookRow?.cash === 'number' ? bookRow.cash : 0);
        const flows = bookRow
          ? monthlyFlowSeriesLocalM(
              bookRow,
              Math.max(1, T),
              forecastProfile ?? DEFAULT_FORECAST_PROFILE,
            )
          : [];
        if (
          Math.abs(stockM) < 1e-9 &&
          !flows.some(f => Math.abs(f) > 1e-9)
        ) {
          return null;
        }
        const rates = marketRatesFor(ccy);
        const cmp = buildCashForecastCarryComparison({
          ccy,
          bookRows,
          forecastProfile,
          forecastMonths: setup.forecastMonths,
          marketRates: rates,
          bookedHedges,
          preparedByCcy,
          setup,
        });
        const totalCarryUsdM = cmp
          ? resolvedHedgedTotalCarryUsdM({
              comparison: cmp,
              prepared: preparedByCcy?.[ccy],
              marketRates: rates,
            }).totalCarryUsdM
          : 0;
        const carryScheduleUsdM = cumulativeCarrySchedule(
          cmp?.hedged.months,
          totalCarryUsdM,
        );
        const bands = computeHedgeCfarBands({
          stockM,
          monthlyFlows: flows,
          ccy,
          setup,
          bookedHedges,
          prepared: preparedByCcy?.[ccy],
          tenureMonths: T,
          carryUsdM: totalCarryUsdM,
          carryScheduleUsdM,
        });
        const { hedged } = bands;
        const fundingGap = settlementFundingGapForHedge({
          stockM,
          monthlyFlows: flows,
          ccy,
          setup,
          bookedHedges,
          prepared: preparedByCcy?.[ccy],
          tenureMonths: T,
        });
        const prep = preparedByCcy?.[ccy];
        const bookedLegs = stripTicketsForCcy(bookedHedges, ccy).length;
        const structLabel =
          bookedLegs >= 2
            ? `Strip · ${bookedLegs}`
            : prep?.structure === 'strip' && prep.legs.length >= 2
              ? `Strip · ${prep.legs.length}`
              : hedged
                ? 'Bullet'
                : null;
        return {
          ccy,
          stockM,
          endM: stockM + flows.reduce((a, b) => a + b, 0),
          flows,
          hedged,
          structLabel,
          totalCarryUsdM,
          bands,
          fundingGap,
        };
      })
      .filter((r): r is CfarRow => r != null);
  }, [risk, bookRows, forecastProfile, setup, bookedHedges, preparedByCcy, T]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (a, r) => ({
          openPathVarUsdM: a.openPathVarUsdM + r.bands.openPathVarUsdM,
          grossCashUsdM: a.grossCashUsdM + r.bands.criticalCashUsdM,
          netCashUsdM: a.netCashUsdM + r.bands.netCriticalCashUsdM,
          carryOffsetUsdM:
            a.carryOffsetUsdM +
            (r.bands.criticalCashUsdM - r.bands.netCriticalCashUsdM),
        }),
        { openPathVarUsdM: 0, grossCashUsdM: 0, netCashUsdM: 0, carryOffsetUsdM: 0 },
      ),
    [rows],
  );

  const [selCcy, setSelCcy] = useState<string | null>(null);
  const selected =
    rows.find(r => r.ccy === selCcy) ??
    rows.find(r => r.ccy === 'EUR') ??
    rows[0] ??
    null;

  /** The real hedge driving "current" — same object the Applied-hedge panel shows. */
  const appliedDetail = useMemo(
    () =>
      selected
        ? hedgeDetailForCcy(bookedHedges, preparedByCcy, selected.ccy, setup)
        : null,
    [selected, bookedHedges, preparedByCcy, setup],
  );
  /**
   * What-if hedge — one editable row per forward leg (On / Settle / Notional
   * Δ), the same shape as the real Strip Schedule · Tick Trades table in the
   * Cash Carry hedging modal. Re-seeded from the REAL applied hedge
   * (`appliedDetail`) whenever the selected currency changes, so "current →"
   * always starts at parity (Δ=0) — divergence only ever comes from an
   * actual edit, never from comparing against an unrelated default.
   */
  const [whatIfLegs, setWhatIfLegs] = useState<WhatIfLegRow[]>(() =>
    seedWhatIfLegs(appliedDetail, T),
  );
  const syncedCcyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    if (syncedCcyRef.current === selected.ccy) return;
    syncedCcyRef.current = selected.ccy;
    setWhatIfLegs(seedWhatIfLegs(appliedDetail, T));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ccy]);
  const resetWhatIfToApplied = () => setWhatIfLegs(seedWhatIfLegs(appliedDetail, T));
  const updateWhatIfLeg = (id: number, patch: Partial<WhatIfLegRow>) =>
    setWhatIfLegs(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  /**
   * Regenerate the whole schedule to `n` equally-spaced legs, redistributing
   * the current total notional evenly — same "− Legs +" behavior as the real
   * Strip Schedule toolbar (`renderStripLegsToolbar` in ExposureHedgePathChart),
   * not an ad-hoc row append. Settle months are continuous (k·T/n), matching
   * the funding-gap convergence fix — more legs genuinely close the gap
   * sooner instead of being capped at whole months.
   */
  const regenerateEqualLegs = (n: number) => {
    const count = Math.max(1, Math.min(24, Math.round(n)));
    const total =
      Math.abs(whatIfLegs.filter(l => l.on).reduce((s, l) => s + l.amountLocalM, 0)) > 1e-9
        ? whatIfLegs.filter(l => l.on).reduce((s, l) => s + l.amountLocalM, 0)
        : (appliedDetail?.totalNotionalLocalM ?? 0);
    const per = roundNotionalM(total / count);
    setWhatIfLegs(
      Array.from({ length: count }, (_, i) => {
        const k = i + 1;
        const settle = k === count ? T : (k * T) / count;
        return { id: i, on: true, settleMonths: roundMonths(settle), amountLocalM: per };
      }),
    );
  };

  const whatIf = useMemo<WhatIfResult | null>(() => {
    if (!selected) return null;
    const ccy = selected.ccy;
    const activeLegs = whatIfLegs
      .filter(l => l.on && Math.abs(l.amountLocalM) > 1e-9)
      .slice()
      .sort((a, b) => a.settleMonths - b.settleMonths);
    if (activeLegs.length === 0) return null;
    let cum = 0;
    const preparedLegs: PreparedHedgeLeg[] = activeLegs.map((l, i) => {
      cum += l.amountLocalM;
      return {
        index: i,
        startMonth: 0, // dealt today — FX delta hedged from trade date
        endMonth: l.settleMonths,
        settleMonths: l.settleMonths,
        hedgeLocalM: cum,
        tradeNotionalLocalM: l.amountLocalM,
        label: `M${l.settleMonths.toFixed(l.settleMonths < 10 ? 1 : 0)}`,
      };
    });
    const totalNotionalLocalM = cum;
    const synthetic: PreparedHedgeProfile =
      activeLegs.length >= 2
        ? {
            structure: 'strip',
            basis: 'varNeutral',
            ticketBasis: 'stock',
            legs: preparedLegs,
            coverLocalM: totalNotionalLocalM,
            hedgeRatio: 0,
          }
        : {
            structure: 'bullet',
            basis: 'varNeutral',
            ticketBasis: 'stock',
            legs: [],
            coverLocalM: totalNotionalLocalM,
            hedgeRatio: 0,
            settleMonths: activeLegs[0]!.settleMonths,
          };
    const rates = marketRatesFor(ccy);
    const cmp = buildCashForecastCarryComparison({
      ccy,
      bookRows,
      forecastProfile,
      forecastMonths: setup.forecastMonths,
      marketRates: rates,
      bookedHedges: [],
      preparedByCcy: { [ccy]: synthetic },
      setup,
    });
    const totalCarryUsdM = cmp
      ? resolvedHedgedTotalCarryUsdM({
          comparison: cmp,
          prepared: synthetic,
          marketRates: rates,
        }).totalCarryUsdM
      : 0;
    const carryScheduleUsdM = cumulativeCarrySchedule(
      cmp?.hedged.months,
      totalCarryUsdM,
    );
    const bands = computeHedgeCfarBands({
      stockM: selected.stockM,
      monthlyFlows: selected.flows,
      ccy,
      setup,
      bookedHedges: [],
      prepared: synthetic,
      tenureMonths: T,
      carryUsdM: totalCarryUsdM,
      carryScheduleUsdM,
    });
    const { hedged } = bands;
    const fundingGap = settlementFundingGapForHedge({
      stockM: selected.stockM,
      monthlyFlows: selected.flows,
      ccy,
      setup,
      bookedHedges: [],
      prepared: synthetic,
      tenureMonths: T,
    });
    return { totalNotionalLocalM, hedged, bands, fundingGap, totalCarryUsdM };
  }, [selected, whatIfLegs, T, setup, bookRows, forecastProfile]);

  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-slate-500">
        No cash rows on the FX book — add currencies in the Simulator table.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          CFaR · critical cash absorption
        </div>
        <div className="font-mono text-[9px] text-slate-600">
          {Math.round(T)}m horizon · {setup.confidencePct}% · point-in-time bridge-funding VaR (closed form)
        </div>
      </div>

      {/* Chapter 0 — CFaR risk settings (σ source + confidence), mirrors VaR */}
      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          CFaR settings · σ &amp; confidence
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
              Volatility σ₁ₘ
            </div>
            <div
              className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Volatility source"
            >
              {VAR_VOL_SOURCE_OPTIONS.map(opt => {
                const on = setup.volSource === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    title={opt.description}
                    disabled={!onSetupChange}
                    onClick={() => patch({ volSource: opt.id })}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      on
                        ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    } ${onSetupChange ? '' : 'cursor-default opacity-80'}`}
                  >
                    {opt.label}
                    <span className="ml-1 font-mono text-[10px] font-normal opacity-80">
                      {(opt.monthlyVol * 100).toFixed(1)}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-blue-300">
              Confidence
            </div>
            <div
              className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Confidence level"
            >
              {VAR_CONFIDENCE_OPTIONS.map(opt => {
                const on = setup.confidencePct === opt.pct;
                return (
                  <button
                    key={opt.pct}
                    type="button"
                    title={`z = ${opt.z}`}
                    disabled={!onSetupChange}
                    onClick={() => patch({ confidencePct: opt.pct })}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      on
                        ? 'bg-blue-500/20 text-blue-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    } ${onSetupChange ? '' : 'cursor-default opacity-80'}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="font-mono text-[10px] text-slate-500">
            CriticalCash = √(spot² + swap²) at peak, spot=z·S₀·σ_fx·√t·|not-dealt,
            incl. forecast σ_E| · swap=z·S₀·σ_rate·√t·|dealt-not-settled| ·
            σ₁ₘ={(sigmaMonthly * 100).toFixed(2)}% · z={zConf.toFixed(2)}
          </p>
        </div>
      </section>

      {/* Chapter 1 — summary metric cards (locked kit) */}
      <div className="grid gap-2 sm:grid-cols-4">
        <div className="rounded border border-yellow-700/40 bg-yellow-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-yellow-400/80">
            Net CFaR · {setup.confidencePct}%
          </div>
          <div className="font-mono text-sm font-semibold text-yellow-200">
            {fmtK(totals.netCashUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-yellow-200/70">
            peak cash to fund, net of carry
          </div>
        </div>
        <div className="rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-amber-400/80">Gross CFaR</div>
          <div className="font-mono text-sm font-semibold text-amber-200">
            {fmtK(totals.grossCashUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-amber-200/70">
            before carry offset
          </div>
        </div>
        <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-emerald-400/80">
            Carry offset
          </div>
          <div
            className={`font-mono text-sm font-semibold ${
              totals.carryOffsetUsdM >= 0 ? 'text-emerald-200' : 'text-rose-300'
            }`}
          >
            {fmtSignedK(totals.carryOffsetUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-emerald-200/60">
            earned by peak draw
          </div>
        </div>
        <div className="rounded border border-blue-700/40 bg-blue-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-blue-400/80">
            Path VaR ref
          </div>
          <div className="font-mono text-sm font-semibold text-blue-200">
            {fmtK(totals.openPathVarUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-blue-200/60">
            z·S₀·σ·√∫e²
          </div>
        </div>
      </div>

      {/* Chapter 2 — per-currency critical cash table (violet select kit) */}
      <div className="space-y-2">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          Critical cash absorption · {Math.round(T)}m · select currency
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th className="py-2 pr-3 font-medium">CCY</th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Net FX stock at t=0 → accrued exposure at Tf"
                >
                  Stock → End
                </th>
                <th
                  className="py-2 pr-3 font-medium text-amber-300/90"
                  title="Gross critical cash before carry offset"
                >
                  Gross CFaR
                </th>
                <th
                  className="py-2 pr-3 font-medium text-emerald-300/80"
                  title="Carry accrued by the drawdown peak"
                >
                  Carry
                </th>
                <th
                  className="py-2 pr-3 font-medium text-yellow-300/90"
                  title="Net critical cash to fund, net of carry"
                >
                  Net CFaR
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Month of the worst running cash draw"
                >
                  Peak
                </th>
                <th
                  className="py-2 font-medium text-fuchsia-300/90"
                  title="Settlement funding gap e(t)−H_settled(t) — forecast not yet delivered by a settled forward. Depends on leg count/spacing, not FX volatility. Separate from Net CFaR."
                >
                  Funding gap
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const on = selected?.ccy === r.ccy;
                const carryOffset =
                  r.bands.criticalCashUsdM - r.bands.netCriticalCashUsdM;
                return (
                  <tr
                    key={r.ccy}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelCcy(r.ccy)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelCcy(r.ccy);
                      }
                    }}
                    title={`Select ${r.ccy} CFaR chart`}
                    className={`cursor-pointer border-b border-slate-800/80 hover:bg-violet-500/10 ${
                      on ? 'bg-violet-500/10' : ''
                    }`}
                  >
                    <td className="py-2 pr-3 font-semibold text-violet-200">
                      <span className="inline-flex flex-col gap-0.5">
                        <span className="inline-flex items-baseline gap-1.5">
                          {r.ccy}
                          {r.structLabel ? (
                            <span
                              className="text-[9px] font-semibold uppercase tracking-wide text-violet-300/90"
                              title="Prepared / booked hedge structure"
                            >
                              {r.structLabel}
                            </span>
                          ) : null}
                        </span>
                        {r.hedged ? (
                          <span className="text-[9px] font-semibold uppercase tracking-wide text-emerald-400/90">
                            Hedged
                          </span>
                        ) : (
                          <span className="text-[9px] font-normal text-slate-600">
                            Open
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-slate-400">
                      {fmtM(r.stockM)} → {fmtM(r.endM)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-amber-300">
                      {fmtK(r.bands.criticalCashUsdM)}
                    </td>
                    <td
                      className={`py-2 pr-3 font-mono ${
                        Math.abs(carryOffset) < 1e-12
                          ? 'text-slate-600'
                          : carryOffset >= 0
                            ? 'text-emerald-300/90'
                            : 'text-rose-300'
                      }`}
                    >
                      {Math.abs(carryOffset) < 1e-12
                        ? '—'
                        : fmtSignedK(carryOffset)}
                    </td>
                    <td className="py-2 pr-3 font-mono font-semibold text-yellow-200">
                      {fmtK(r.bands.netCriticalCashUsdM)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-slate-400">
                      M{r.bands.peakMonth.toFixed(r.bands.peakMonth < 10 ? 1 : 0)}
                    </td>
                    <td className="py-2 font-mono text-fuchsia-200">
                      {r.fundingGap ? (
                        <span title={`${fmtM(r.fundingGap.maxGapLocalM)} FCY undelivered · M${r.fundingGap.peakMonth.toFixed(r.fundingGap.peakMonth < 10 ? 1 : 0)} · ${r.fundingGap.legCount} settlement${r.fundingGap.legCount === 1 ? '' : 's'}`}>
                          {fmtK(r.fundingGap.maxGapUsdM)}
                          <span className="ml-1 text-[9px] text-fuchsia-300/60">
                            M{r.fundingGap.peakMonth.toFixed(r.fundingGap.peakMonth < 10 ? 1 : 0)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr className="border-b border-slate-800/80 bg-slate-900/40">
                  <td className="py-2 pr-3 font-semibold text-violet-200">
                    All CCY
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-500">—</td>
                  <td className="py-2 pr-3 font-mono text-amber-300">
                    {fmtK(totals.grossCashUsdM)}
                  </td>
                  <td
                    className={`py-2 pr-3 font-mono ${
                      totals.carryOffsetUsdM >= 0
                        ? 'text-emerald-300/90'
                        : 'text-rose-300'
                    }`}
                  >
                    {fmtSignedK(totals.carryOffsetUsdM)}
                  </td>
                  <td className="py-2 pr-3 font-mono font-semibold text-yellow-200">
                    {fmtK(totals.netCashUsdM)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-500">—</td>
                  <td className="py-2 font-mono text-slate-500" title="Not summed — each currency's gap peaks at a different month">
                    —
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="text-[9px] leading-relaxed text-slate-500">
          Net CFaR combines two independent risks in quadrature: spot risk on
          exposure with no forward dealt at all (full FX vol, plus forecast
          uncertainty folded in), and swap-bridge risk on notional that&apos;s
          dealt but not yet settled (rate-differential vol only — bridging via
          spot+swap-back nets out the spot exposure once the forward
          eventually delivers). Both genuinely depend on leg count/spacing.
          Closed form, not simulated — each t is an independent point-in-time
          draw, not a compounding path. All CCY sums per-currency figures
          (undiversified). Funding gap is the settlement gap g(t)=e−H_settled&apos;s
          deterministic floor (zero volatility, either kind) and is not
          summed into Net CFaR.
        </p>
      </div>

      {/* Chapter 3 — drawdown fan for the selected currency */}
      {selected && (
        <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
              {selected.ccy} · {selected.hedged ? 'residual' : 'open'} cash
              drawdown
            </div>
            <div
              className="inline-flex shrink-0 flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Currency"
            >
              {rows.map(r => {
                const on = selected.ccy === r.ccy;
                return (
                  <button
                    key={r.ccy}
                    type="button"
                    onClick={() => setSelCcy(r.ccy)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                      on
                        ? 'bg-violet-500/25 text-violet-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {r.ccy}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Applied hedge — exactly what's driving the "current" numbers below */}
          {(() => {
            const detail = appliedDetail ?? { source: 'none' as const, legs: [], totalNotionalLocalM: 0 };
            const coverPct =
              Math.abs(selected.endM) > 1e-9
                ? (detail.totalNotionalLocalM / selected.endM) * 100
                : 0;
            const sourceLabel =
              detail.source === 'booked'
                ? 'Booked'
                : detail.source === 'prepared-strip'
                  ? 'Prepared · strip (staged, not booked)'
                  : detail.source === 'prepared-bullet'
                    ? 'Prepared · bullet (staged, not booked)'
                    : 'None — open book';
            return (
              <div className="mb-2 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
                <div className="mb-0.5 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                    Applied hedge · {selected.ccy}
                  </div>
                  <div className="font-mono text-[10px] text-slate-400">
                    {sourceLabel}
                  </div>
                </div>
                {detail.legs.length === 0 ? (
                  <p className="text-[9px] text-slate-500">
                    No booked or prepared hedge for {selected.ccy} — CFaR
                    above is the open (unhedged) path.
                  </p>
                ) : (
                  <>
                    <p className="mb-1.5 text-[9px] leading-relaxed text-slate-500">
                      This is exactly what {selected.hedged ? 'residual' : 'the'} CFaR,
                      funding gap, and carry above are simulating — not the What-if
                      scenario below. Total {fmtM(detail.totalNotionalLocalM)} ·{' '}
                      {fmtPct(coverPct)} of accrued exposure at Tf.
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[420px] text-left text-[10px]">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-500">
                            <th className="py-1 pr-3 font-medium">Leg</th>
                            <th className="py-1 pr-3 font-medium">Settle</th>
                            <th className="py-1 pr-3 font-medium">Trade Δ</th>
                            <th className="py-1 font-medium">Cumul. cover</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.legs.map((leg, i) => (
                            <tr
                              key={`${leg.label}-${i}`}
                              className="border-b border-slate-900/80 font-mono text-slate-300"
                            >
                              <td className="py-1 pr-3">{leg.label}</td>
                              <td className="py-1 pr-3">
                                M{leg.settleMonths.toFixed(
                                  leg.settleMonths < 10 ? 1 : 0,
                                )}
                              </td>
                              <td className="py-1 pr-3">
                                {fmtM(leg.tradeNotionalLocalM)}
                              </td>
                              <td className="py-1">
                                {fmtM(leg.cumulCoverLocalM)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-yellow-800/40 bg-yellow-950/20 px-2.5 py-1.5">
            <div className="flex items-baseline gap-1">
              <span className="text-[9px] uppercase tracking-wide text-yellow-400/80">
                {Math.abs(
                  selected.bands.criticalCashUsdM -
                    selected.bands.netCriticalCashUsdM,
                ) > 1e-9
                  ? 'Net CFaR'
                  : 'Max CFaR'}
              </span>
              <span className="font-mono text-sm font-semibold text-yellow-100">
                {fmtK(selected.bands.netCriticalCashUsdM)}
              </span>
            </div>
            <span className="text-[10px] text-slate-400">
              gross {fmtK(selected.bands.criticalCashUsdM)} · peak M
              {selected.bands.peakMonth.toFixed(1)} ·{' '}
              {selected.hedged ? 'settlement gap g(t)=e−H_settled · point-in-time' : 'open exposure e(t) · point-in-time'}
            </span>
            <span
              className="text-[10px] text-slate-500"
              title="Spot risk = not-yet-dealt exposure + forecast uncertainty, full FX vol. Swap risk = dealt-but-not-settled notional, rate-differential vol only (bridge-funding swap points)."
            >
              spot {fmtK(selected.bands.breakdown.spotPeakUsdM)} · swap{' '}
              {fmtK(selected.bands.breakdown.swapPeakUsdM)} (RSS-combined)
            </span>
            {selected.fundingGap && (
              <span
                className="text-[10px] text-fuchsia-300/80"
                title="Settlement funding gap — depends on leg count/spacing, not FX volatility"
              >
                funding gap {fmtK(selected.fundingGap.maxGapUsdM)} · M
                {selected.fundingGap.peakMonth.toFixed(1)} ·{' '}
                {selected.fundingGap.legCount} settlement
                {selected.fundingGap.legCount === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {/* What-if hedge — real per-leg editor, same shape as the Strip
              Schedule · Tick Trades table in the Cash Carry hedging modal */}
          <div className="mb-2 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                What-if hedge · tick trades
              </div>
              {/* Same Reset | Legs −/+ toolbar shape as the real Strip Schedule
                  header (renderStripLegsToolbar) — the stepper regenerates N
                  equally-spaced legs off the current total, it doesn't append
                  a blank row. No gear/custom-schedule mode here yet (that's
                  the deeper drag-schedule feature in the real modal). */}
              <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-1.5 py-0.5">
                <button
                  type="button"
                  onClick={resetWhatIfToApplied}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  title="Re-seed from the currently applied hedge"
                >
                  Reset
                </button>
                <span className="text-[9px] text-slate-600">|</span>
                <span className="text-[9px] text-slate-500">Legs</span>
                <button
                  type="button"
                  disabled={whatIfLegs.length <= 1}
                  onClick={() => regenerateEqualLegs(whatIfLegs.length - 1)}
                  className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                  title="Fewer legs — redistributes total notional, equal spacing"
                >
                  −
                </button>
                <span className="min-w-[1.25rem] text-center font-mono text-[11px] text-amber-200">
                  {whatIfLegs.length}
                </span>
                <button
                  type="button"
                  disabled={whatIfLegs.length >= 24}
                  onClick={() => regenerateEqualLegs(whatIfLegs.length + 1)}
                  className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                  title="More legs — redistributes total notional, equal spacing"
                >
                  +
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] text-left text-[10px]">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-500">
                    <th className="w-8 py-1 pr-2 font-medium">On</th>
                    <th className="py-1 pr-3 font-medium">Settle</th>
                    <th className="py-1 pr-3 font-medium">Notional Δ</th>
                    <th className="py-1 font-medium">Cumul. cover</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let cum = 0;
                    return [...whatIfLegs]
                      .sort((a, b) => a.settleMonths - b.settleMonths)
                      .map(row => {
                        if (row.on) cum += row.amountLocalM;
                        return { row, cum };
                      });
                  })().map(({ row, cum }) => (
                      <tr key={row.id} className="border-b border-slate-900/80">
                        <td className="py-1 pr-2">
                          <input
                            type="checkbox"
                            checked={row.on}
                            onChange={e => updateWhatIfLeg(row.id, { on: e.target.checked })}
                            className="h-3.5 w-3.5 accent-sky-500"
                          />
                        </td>
                        <td className="py-1 pr-3">
                          <input
                            type="number"
                            step={0.5}
                            min={0}
                            max={T}
                            value={row.settleMonths}
                            onChange={e =>
                              updateWhatIfLeg(row.id, {
                                settleMonths: Math.max(0, Math.min(T, Number(e.target.value) || 0)),
                              })
                            }
                            className="w-16 rounded border border-slate-700 bg-slate-950 px-1 py-0.5 font-mono text-sky-100"
                          />
                          <span className="ml-1 text-slate-500">m</span>
                        </td>
                        <td className="py-1 pr-3">
                          <input
                            type="number"
                            step={0.1}
                            value={row.amountLocalM}
                            onChange={e =>
                              updateWhatIfLeg(row.id, { amountLocalM: Number(e.target.value) || 0 })
                            }
                            className="w-20 rounded border border-slate-700 bg-slate-950 px-1 py-0.5 font-mono text-sky-100"
                          />
                          <span className="ml-1 text-slate-500">M</span>
                        </td>
                        <td className="py-1 font-mono text-slate-400">
                          {row.on ? fmtM(cum) : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className="mb-2 mt-1.5 text-[9px] leading-relaxed text-slate-500">
              Seeded from the {selected.ccy} hedge actually applied above (
              {appliedDetail?.source ?? 'none'}). Edit Settle / Notional Δ per
              leg, or use the Legs stepper to redistribute the total across
              more/fewer equally-spaced legs — every recalculation below
              re-runs the same CFaR / funding-gap / Cash-Carry pipeline used
              for the figures above, on exactly the legs ticked On.
            </p>
            {whatIf ? (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-4">
                <WhatIfDeltaRow
                  label="Net CFaR"
                  current={selected.bands.netCriticalCashUsdM}
                  proposed={whatIf.bands.netCriticalCashUsdM}
                  fmt={fmtK}
                  lowerIsBetter
                  note="Spot risk (not-dealt + forecast uncertainty, leg-count invariant by construction) RSS-combined with swap-bridge risk (dealt-not-settled, leg-sensitive). When spot dominates — any book below ~full cover — this total can look flat even as legs change; watch Swap-bridge risk below instead."
                />
                <WhatIfDeltaRow
                  label="Swap-bridge risk"
                  current={selected.bands.breakdown.swapPeakUsdM}
                  proposed={whatIf.bands.breakdown.swapPeakUsdM}
                  fmt={fmtK}
                  lowerIsBetter
                  note="Isolated dealt-but-not-settled component only — this is the piece leg count/spacing actually controls. More, better-spaced legs shrink the settlement sawtooth and should lower this even when Net CFaR above barely moves."
                />
                <WhatIfDeltaRow
                  label="Funding gap"
                  current={selected.fundingGap?.maxGapUsdM ?? 0}
                  proposed={whatIf.fundingGap?.maxGapUsdM ?? 0}
                  fmt={fmtK}
                  lowerIsBetter
                  note="The deterministic (zero-FX-vol) floor of the same settlement residual driving Net CFaR above — moves with Settle dates the same way."
                />
                <WhatIfDeltaRow
                  label="Carry"
                  current={selected.totalCarryUsdM}
                  proposed={whatIf.totalCarryUsdM}
                  fmt={fmtSignedK}
                  lowerIsBetter={false}
                  note="Each leg's own Settle month picks up a different point on the forward curve."
                />
              </div>
            ) : (
              <p className="text-[9px] text-slate-500">
                No legs ticked On — turn one on or add a leg to see the what-if impact.
              </p>
            )}
          </div>

          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
              Chart shows: what-if scenario ({fmtM(whatIf?.totalNotionalLocalM ?? 0)}
              {' '}across {whatIfLegs.filter(l => l.on).length} leg
              {whatIfLegs.filter(l => l.on).length === 1 ? '' : 's'})
            </span>
            <span className="text-[9px] text-slate-600">
              current Net CFaR {fmtK(selected.bands.netCriticalCashUsdM)} shown
              above for reference
            </span>
          </div>
          <CfarDrawdownChart
            bands={whatIf?.bands ?? selected.bands}
            confidencePct={setup.confidencePct}
            height={240}
            fundingGapPoints={whatIf?.fundingGap?.points ?? selected.fundingGap?.points}
          />
        </section>
      )}
    </div>
  );
}
