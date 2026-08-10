'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CfarDrawdownChart } from '@/components/test-mode/CfarDrawdownChart';
import {
  buildCashForecastCarryComparison,
  resolvedHedgedTotalCarryUsdM,
  sumCashCarryTotalUsdM,
} from '@/lib/test-mode/cash-carry-analytics';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import { type CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';
import {
  buildSyntheticHedgeProfile,
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
  FORECAST_UNCERTAINTY_OPTIONS,
  VAR_VOL_SOURCE_OPTIONS,
  horizonMonths,
  monthlyVolForSetup,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import {
  resolveMarketRatesForCcy,
  resolveForwardDepositRates,
  resolveOvernightCashRates,
  fwdCarryFromSwapPointsUsdM,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { stripHedgeLegCarryUsdM } from '@/lib/fx-hedge';
import type { RowState } from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  clearLineUncertainties,
  effectiveForecastUncertainty1m,
  monthlyFlowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';

interface CfarAnalysisViewProps {
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  /** Edit the shared VaR setup (σ source + confidence) from the CFaR tab. */
  onSetupChange?: (setup: VarSetup) => void;
  /** Sync Forecast-profile line σ when top-section u₁ₘ chips change. */
  onForecastProfileChange?: (profile: ForecastProfileState) => void;
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

/** Same $K carry format as Cash Carry · Performance tick trades. */
function fmtCarryK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.5) return '$0K';
  return `${k >= 0 ? '+' : '−'}$${Math.abs(k).toFixed(0)}K`;
}

/**
 * Per-leg path carry — FWD CIP/points + FCY/USD overnight interest.
 * Same engine as Cash Carry tick-trades Carry column.
 */
function legCarryBreakdown(
  ccy: string,
  notionalLocalM: number,
  settleMonths: number,
  forecastEndMonths: number,
  marketRates: FxMarketRatesBundle,
) {
  if (Math.abs(notionalLocalM) < 1e-12) {
    return {
      fwdCarryUsdM: 0,
      fcyInterestUsdM: 0,
      usdInterestUsdM: 0,
      totalUsdM: 0,
      swapPoints: undefined as number | undefined,
      swapPointsSide: undefined as 'bid' | 'ask' | 'mid' | undefined,
      r_FCY_used: undefined as number | undefined,
      r_USD_used: undefined as number | undefined,
      r_FCY_side: undefined as 'credit' | 'debit' | undefined,
      r_USD_side: undefined as 'credit' | 'debit' | undefined,
    };
  }
  const settle = Math.max(0, settleMonths);
  const fwd = resolveForwardDepositRates(marketRates, ccy, settle);
  const cash = resolveOvernightCashRates(marketRates, ccy);
  const pts = fwdCarryFromSwapPointsUsdM({
    notionalLocalM,
    settleMonths: settle,
    bundle: marketRates,
  });
  return stripHedgeLegCarryUsdM({
    notionalLocalM,
    ccy,
    recognizeMonths: 0,
    settleMonths: settle,
    forecastEndMonths: Math.max(settle, forecastEndMonths),
    fcyFwdRates: fwd.fcy,
    usdFwdRates: fwd.usd,
    fcyCashRates: cash.fcy,
    usdCashRates: cash.usd,
    swapPointsCarryUsdM: pts?.fwdCarryUsdM,
    swapPoints: pts?.points,
    swapPointsSide: pts?.side,
  });
}

function CarryCell({
  totalUsdM,
  fwdCarryUsdM,
  fcyInterestUsdM,
  usdInterestUsdM,
  titleLines,
}: {
  totalUsdM: number;
  fwdCarryUsdM: number;
  fcyInterestUsdM: number;
  usdInterestUsdM: number;
  titleLines?: string[];
}) {
  const cash = fcyInterestUsdM + usdInterestUsdM;
  return (
    <td
      className={`py-1 ${
        totalUsdM >= 0 ? 'text-sky-300' : 'text-rose-300/90'
      }`}
      title={titleLines?.join('\n')}
    >
      <span className="inline-flex flex-col leading-tight">
        <span className="font-semibold">{fmtCarryK(totalUsdM)}</span>
        <span className="text-[8px] font-normal text-slate-500">
          fwd {fmtCarryK(fwdCarryUsdM)} · cash {fmtCarryK(cash)}
        </span>
      </span>
    </td>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.9 1.01 1.55 1.01H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}
function fmtPct(pct: number): string {
  return `${pct.toFixed(0)}%`;
}

/** Compact “i” control — click opens a short explanation popover. */
function InfoTip({
  label,
  children,
  align = 'left',
}: {
  label: string;
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(v => !v)}
        className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold leading-none transition-colors ${
          open
            ? 'border-sky-500/60 bg-sky-500/20 text-sky-100'
            : 'border-slate-600 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200'
        }`}
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`absolute top-full z-30 mt-1.5 w-72 max-w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-slate-600 bg-slate-900 p-3 text-left text-[10px] leading-relaxed text-slate-300 shadow-xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {label}
          </div>
          {children}
        </div>
      )}
    </div>
  );
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
  /** Explanation — shown in an ⓘ popover, not inline. */
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
  const deltaLabel = (() => {
    if (Math.abs(delta) < 1e-12) return fmt(0);
    const sign = delta >= 0 ? '+' : '−';
    const body = fmt(Math.abs(delta)).replace(/^[+\−\-]/, '');
    return `${sign}${body}`;
  })();
  return (
    <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5">
      <div className="mb-0.5 flex items-center justify-between gap-1">
        <div className="text-[9px] uppercase text-slate-500">{label}</div>
        {note && (
          <InfoTip label={label} align="right">
            <p>{note}</p>
          </InfoTip>
        )}
      </div>
      <div className="flex items-baseline gap-1.5 font-mono">
        <span className="text-slate-500">{fmt(current)}</span>
        <span className="text-slate-600">→</span>
        <span className="font-semibold text-slate-100">{fmt(proposed)}</span>
      </div>
      <div className={`font-mono text-[9px] ${deltaColor}`}>
        Δ {deltaLabel}
      </div>
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
  /** Full-Tf Total carry (same as Cash Carry table for this CCY). */
  totalCarryUsdM: number;
  doNothingUsdM: number;
  benefitUsdM: number;
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
  doNothingUsdM: number;
  benefitUsdM: number;
}

/** One point on the leg-count efficient frontier (CFaR vs carry). */
interface FrontierPoint {
  legCount: number;
  netCfarUsdM: number;
  carryUsdM: number;
}
/** Leg counts sampled for the frontier — coarse enough to stay cheap (each
 * point re-runs the full carry + CFaR pipeline), fine enough near 1 where the
 * curve moves fastest. */
const FRONTIER_LEG_COUNTS = [1, 2, 3, 4, 6, 8, 12, 16, 20, 24];

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
  onForecastProfileChange,
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
  /** Top-section u₁ₘ: write global setup and clear sticky modal line overrides. */
  const patchUncertainty1m = (value: number) => {
    onSetupChange?.({ ...setup, forecastUncertainty1m: value });
    if (onForecastProfileChange && forecastProfile) {
      const cleared = clearLineUncertainties(forecastProfile);
      if (cleared !== forecastProfile) onForecastProfileChange(cleared);
    }
  };
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
        const resolved = cmp
          ? resolvedHedgedTotalCarryUsdM({
              comparison: cmp,
              prepared: preparedByCcy?.[ccy],
              marketRates: rates,
            })
          : null;
        const totalCarryUsdM = resolved?.totalCarryUsdM ?? 0;
        const doNothingUsdM = cmp?.categories.unhedgedIncomeUsdM ?? 0;
        const benefitUsdM = resolved?.benefitUsdM ?? 0;
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
          forecastProfile,
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
          doNothingUsdM,
          benefitUsdM,
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
          grossCashUsdM: a.grossCashUsdM + r.bands.criticalCashUsdM,
          netCashUsdM: a.netCashUsdM + r.bands.netCriticalCashUsdM,
          spotPeakUsdM: a.spotPeakUsdM + r.bands.breakdown.spotPeakUsdM,
          swapPeakUsdM: a.swapPeakUsdM + r.bands.breakdown.swapPeakUsdM,
        }),
        {
          grossCashUsdM: 0,
          netCashUsdM: 0,
          spotPeakUsdM: 0,
          swapPeakUsdM: 0,
        },
      ),
    [rows],
  );

  /**
   * Same Σ as Cash Carry “All CCY · Total” / Analytics tab — not hedged-only
   * and not a partial CFaR row set.
   */
  const carryOffsetUsdM = useMemo(() => {
    const ccys = risk
      .map(r => r.bar.ccy)
      .filter(ccy => ccy !== 'USD' && ccy.length > 0);
    return sumCashCarryTotalUsdM({
      ccys,
      bookRows,
      forecastProfile,
      forecastMonths: setup.forecastMonths,
      marketRatesFor: (ccy: string) =>
        marketRatesProp ??
        resolveMarketRatesForCcy(marketRatesByCcy, ccy, ratesScopeId),
      bookedHedges,
      preparedByCcy,
      setup,
    });
  }, [
    risk,
    bookRows,
    forecastProfile,
    setup,
    bookedHedges,
    preparedByCcy,
    marketRatesProp,
    marketRatesByCcy,
    ratesScopeId,
  ]);

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
  /** Per-leg On / Settle / Notional editor — behind amber gear (same pattern as Strip Schedule). */
  const [whatIfScheduleOpen, setWhatIfScheduleOpen] = useState(false);
  const syncedCcyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    if (syncedCcyRef.current === selected.ccy) return;
    syncedCcyRef.current = selected.ccy;
    setWhatIfLegs(seedWhatIfLegs(appliedDetail, T));
    setWhatIfScheduleOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.ccy]);
  const resetWhatIfToApplied = () => {
    setWhatIfLegs(seedWhatIfLegs(appliedDetail, T));
    // Show tick trades with Carry so Reset surfaces the same params as Cash Carry.
    setWhatIfScheduleOpen(true);
  };
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
    const resolved = cmp
      ? resolvedHedgedTotalCarryUsdM({
          comparison: cmp,
          prepared: synthetic,
          marketRates: rates,
        })
      : null;
    const totalCarryUsdM = resolved?.totalCarryUsdM ?? 0;
    const doNothingUsdM = cmp?.categories.unhedgedIncomeUsdM ?? 0;
    const benefitUsdM = resolved?.benefitUsdM ?? 0;
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
      forecastProfile,
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
    return {
      totalNotionalLocalM,
      hedged,
      bands,
      fundingGap,
      totalCarryUsdM,
      doNothingUsdM,
      benefitUsdM,
    };
  }, [selected, whatIfLegs, T, setup, bookRows, forecastProfile]);

  /**
   * Efficient frontier: same total hedge notional (the applied hedge's, not
   * the what-if scratch total — this answers "given what I've actually
   * decided to hedge, how does leg count trade CFaR against carry", not
   * "given whatever I'm mid-edit on"), redistributed across an equally-spaced
   * strip of N legs for N in FRONTIER_LEG_COUNTS. Each point re-runs the same
   * carry (buildCashForecastCarryComparison + resolvedHedgedTotalCarryUsdM)
   * and CFaR (computeHedgeCfarBands) pipeline as the applied-hedge and
   * what-if figures above, so it's directly comparable to them — not a
   * separate approximation.
   */
  const frontier = useMemo<FrontierPoint[]>(() => {
    if (!selected || !appliedDetail || Math.abs(appliedDetail.totalNotionalLocalM) < 1e-9) {
      return [];
    }
    const ccy = selected.ccy;
    const rates = marketRatesFor(ccy);
    const totalNotionalLocalM = appliedDetail.totalNotionalLocalM;
    return FRONTIER_LEG_COUNTS.map((legCount): FrontierPoint => {
      const synthetic = buildSyntheticHedgeProfile({
        totalNotionalLocalM,
        legCount,
        tenureMonths: T,
      });
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
      const carryScheduleUsdM = cumulativeCarrySchedule(cmp?.hedged.months, totalCarryUsdM);
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
        forecastProfile,
      });
      return { legCount, netCfarUsdM: bands.netCriticalCashUsdM, carryUsdM: totalCarryUsdM };
    });
  }, [selected, appliedDetail, T, setup, bookRows, forecastProfile]);

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
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
              Forecast uncertainty u₁ₘ
            </div>
            <div
              className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Forecast uncertainty"
            >
              {FORECAST_UNCERTAINTY_OPTIONS.map(opt => {
                const on =
                  Math.abs((setup.forecastUncertainty1m ?? 0) - opt.value) <
                  1e-12;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    title={
                      opt.value === 0
                        ? 'Quantity risk off — Target-hedged books show only swap-bridge (rate-diff) risk'
                        : '1m relative vol of monthly forecast F → σ_E = u·√(ΣF²); folds into spot CFaR as z·S₀·σ_E'
                    }
                    disabled={
                      !onSetupChange ||
                      setup.forecastMonths === 0
                    }
                    onClick={() => patchUncertainty1m(opt.value)}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      on
                        ? 'bg-amber-500/20 text-amber-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    } ${onSetupChange ? '' : 'cursor-default opacity-80'}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-[10px] text-slate-500">
              σ_fx={(sigmaMonthly * 100).toFixed(2)}% · z={zConf.toFixed(2)} ·
              u₁ₘ={((setup.forecastUncertainty1m ?? 0) * 100).toFixed(0)}%
            </p>
            <InfoTip label="CriticalCash formula">
              <p>
                CriticalCash = √(spot² + swap²) at peak. Spot =
                z·S₀·σ_fx·√t·|not-dealt| + z·S₀·σ_E (u₁ₘ). Swap =
                z·S₀·σ_rate·√t·|dealt-not-settled|. FX σ only hits undelt
                exposure — a 100% Target bullet has spot FX ≈ 0. u₁ₘ syncs with
                Forecast profile line σ (top chips clear line overrides).
              </p>
            </InfoTip>
          </div>
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
            bridge-cost VaR net of carry — not the funding gap notional
          </div>
        </div>
        <div className="rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-amber-400/80">Gross CFaR</div>
          <div className="font-mono text-sm font-semibold text-amber-200">
            {fmtK(totals.grossCashUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-amber-200/70">
            before carry / swap-points offset
          </div>
        </div>
        <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-emerald-400/80">
            Carry offset
          </div>
          <div
            className={`font-mono text-sm font-semibold ${
              carryOffsetUsdM >= 0 ? 'text-emerald-200' : 'text-rose-300'
            }`}
          >
            {fmtSignedK(carryOffsetUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-emerald-200/60">
            Cash Carry · All CCY Total
          </div>
        </div>
        <div className="rounded border border-blue-700/40 bg-blue-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-blue-400/80">
            Of which · spot / swap
          </div>
          <div className="font-mono text-sm font-semibold text-blue-200">
            {fmtK(totals.spotPeakUsdM)}
            <span className="mx-1 text-slate-600">/</span>
            {fmtK(totals.swapPeakUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-blue-200/60">
            σ_E+undelt · rate-diff bridge (undiversified Σ)
          </div>
        </div>
      </div>

      {/* Chapter 2 — per-currency critical cash table (violet select kit) */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
            Critical cash absorption · {Math.round(T)}m · select currency
          </div>
          <InfoTip label="How to read Net CFaR">
            <p>
              Net CFaR = √(spot² + swap²) − FWD carry. Spot = undelt FX vol +
              forecast σ_E (u₁ₘ) — on a 100% Target deal, undelt ≈ 0 so spot is
              mostly σ_E and does not fall with more legs. Swap =
              dealt-not-settled × rate-diff vol — this (and Funding gap) is what
              leg count/spacing shrinks. Closed form, point-in-time. All CCY is
              an undiversified sum. Funding gap is the zero-vol notional
              g(t)=e−H_settled — not inside Net CFaR.
            </p>
          </InfoTip>
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
                  title="Same Total carry as Cash Carry for this CCY (All CCY Σ = Carry offset card)"
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
                const carryOffset = r.totalCarryUsdM;
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
                      carryOffsetUsdM >= 0
                        ? 'text-emerald-300/90'
                        : 'text-rose-300'
                    }`}
                  >
                    {fmtSignedK(carryOffsetUsdM)}
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

          {/* Applied hedge — Cash Carry–style params + legs (Cover / Carry / etc.) */}
          {(() => {
            const detail =
              appliedDetail ?? {
                source: 'none' as const,
                legs: [],
                totalNotionalLocalM: 0,
              };
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
            const rates = marketRatesFor(selected.ccy);
            const cmp = buildCashForecastCarryComparison({
              ccy: selected.ccy,
              bookRows,
              forecastProfile,
              forecastMonths: setup.forecastMonths,
              marketRates: rates,
              bookedHedges,
              preparedByCcy,
              setup,
            });
            const resolved = cmp
              ? resolvedHedgedTotalCarryUsdM({
                  comparison: cmp,
                  prepared: preparedByCcy?.[selected.ccy],
                  marketRates: rates,
                })
              : null;
            const doNothingUsdM = cmp?.categories.unhedgedIncomeUsdM ?? 0;
            const totalCarryUsdM =
              resolved?.totalCarryUsdM ?? selected.totalCarryUsdM;
            const benefitUsdM = resolved?.benefitUsdM ?? 0;
            const onRates = resolveOvernightCashRates(rates, selected.ccy);
            const fwd1m = resolveForwardDepositRates(rates, selected.ccy, 1);
            const chip =
              'inline-flex items-baseline gap-1 rounded border border-slate-700 bg-slate-950/70 px-1.5 py-0.5';
            const chipLbl =
              'text-[8px] font-semibold uppercase tracking-wide text-slate-500';
            const chipVal = 'font-mono text-[11px] font-semibold tabular-nums';
            return (
              <div className="mb-2 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
                <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                      Applied hedge · {selected.ccy}
                    </div>
                    <InfoTip label="Applied hedge">
                      <p>
                        Same package Cash Carry uses for this CCY — Cover,
                        Legs, Total carry, Do nothing, Benefit (Δ), and Net
                        CFaR. What-if below starts from these legs; Reset
                        restores them.
                      </p>
                    </InfoTip>
                  </div>
                  <div className="font-mono text-[10px] text-slate-400">
                    {sourceLabel}
                  </div>
                </div>

                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className={chip} title="Total dealt notional · % of Tf exposure">
                    <span className={chipLbl}>Cover</span>
                    <span className={`${chipVal} text-slate-100`}>
                      {fmtM(detail.totalNotionalLocalM)}
                    </span>
                    {Math.abs(selected.endM) > 1e-9 && (
                      <span className={`${chipVal} text-slate-500`}>
                        {fmtPct(coverPct)}
                      </span>
                    )}
                  </span>
                  <span className={chip} title="Forward legs in the applied package">
                    <span className={chipLbl}>Legs</span>
                    <span className={`${chipVal} text-sky-200`}>
                      {detail.legs.length > 0 ? detail.legs.length : '—'}
                    </span>
                  </span>
                  <span
                    className={chip}
                    title="Total carry @ Tf — same as Cash Carry Total for this CCY"
                  >
                    <span className={chipLbl}>Carry</span>
                    <span
                      className={`${chipVal} ${
                        totalCarryUsdM >= 0 ? 'text-emerald-200' : 'text-rose-300'
                      }`}
                    >
                      {fmtCarryK(totalCarryUsdM)}
                    </span>
                  </span>
                  <span
                    className={chip}
                    title="Do-nothing / unhedged income @ Tf"
                  >
                    <span className={chipLbl}>Do nothing</span>
                    <span
                      className={`${chipVal} ${
                        doNothingUsdM >= 0 ? 'text-amber-200/90' : 'text-rose-300'
                      }`}
                    >
                      {fmtCarryK(doNothingUsdM)}
                    </span>
                  </span>
                  <span
                    className={chip}
                    title="Benefit = Total − Do nothing (hedge enhancement)"
                  >
                    <span className={chipLbl}>Δ</span>
                    <span
                      className={`${chipVal} ${
                        benefitUsdM >= 0 ? 'text-emerald-200' : 'text-rose-300'
                      }`}
                    >
                      {fmtCarryK(benefitUsdM)}
                    </span>
                  </span>
                  <span className={chip} title="Net CFaR for this currency">
                    <span className={chipLbl}>Net CFaR</span>
                    <span className={`${chipVal} text-yellow-200`}>
                      {fmtK(selected.bands.netCriticalCashUsdM)}
                    </span>
                  </span>
                </div>

                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded border border-slate-700/80 bg-slate-950/60 px-2 py-1 text-[10px]">
                  <span className="text-slate-400">
                    Carry rates ·{' '}
                    <span className="font-mono text-slate-300">
                      {rates.sourceFile || 'CURRENCY_PARAMS'}
                    </span>
                    {' · '}
                    <span className="font-mono text-amber-200/90">
                      ON {selected.ccy} {onRates.fcy.creditPct.toFixed(2)}%/
                      {onRates.fcy.debitPct.toFixed(2)}% · fwd 1M{' '}
                      {fwd1m.fcy.creditPct.toFixed(2)}%/
                      {fwd1m.fcy.debitPct.toFixed(2)}%
                    </span>
                  </span>
                </div>

                {detail.legs.length === 0 ? (
                  <p className="text-[9px] text-slate-500">
                    No booked or prepared hedge for {selected.ccy} — CFaR
                    above is the open (unhedged) path.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-left text-[10px]">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-500">
                          <th className="py-1 pr-3 font-medium">Leg</th>
                          <th className="py-1 pr-3 font-medium">Settle</th>
                          <th className="py-1 pr-3 font-medium">Trade Δ</th>
                          <th className="py-1 pr-3 font-medium">Cumul. cover</th>
                          <th
                            className="py-1 font-medium"
                            title="Per-leg path carry (FWD + FCY int + USD int) — same engine as Cash Carry tick trades"
                          >
                            Carry
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.legs.map((leg, i) => {
                          const carry = legCarryBreakdown(
                            selected.ccy,
                            leg.tradeNotionalLocalM,
                            leg.settleMonths,
                            T,
                            rates,
                          );
                          return (
                            <tr
                              key={`${leg.label}-${i}`}
                              className="border-b border-slate-900/80 font-mono text-slate-300"
                            >
                              <td className="py-1 pr-3">{leg.label}</td>
                              <td className="py-1 pr-3">
                                M
                                {leg.settleMonths.toFixed(
                                  leg.settleMonths < 10 ? 1 : 0,
                                )}
                              </td>
                              <td className="py-1 pr-3">
                                {fmtM(leg.tradeNotionalLocalM)}
                              </td>
                              <td className="py-1 pr-3">
                                {fmtM(leg.cumulCoverLocalM)}
                              </td>
                              <CarryCell
                                totalUsdM={carry.totalUsdM}
                                fwdCarryUsdM={carry.fwdCarryUsdM}
                                fcyInterestUsdM={carry.fcyInterestUsdM}
                                usdInterestUsdM={carry.usdInterestUsdM}
                                titleLines={[
                                  `Total ${fmtCarryK(carry.totalUsdM)}`,
                                  carry.swapPoints != null
                                    ? `FWD points ${fmtCarryK(carry.fwdCarryUsdM)} (swap ${carry.swapPoints.toFixed(2)} ${carry.swapPointsSide ?? ''})`
                                    : `FWD CIP ${fmtCarryK(carry.fwdCarryUsdM)}`,
                                  `FCY int ${fmtCarryK(carry.fcyInterestUsdM)}`,
                                  `USD int ${fmtCarryK(carry.usdInterestUsdM)}`,
                                ]}
                              />
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}

          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-yellow-800/40 bg-yellow-950/20 px-2.5 py-1.5">
            <div className="flex items-baseline gap-1">
              <span className="text-[9px] uppercase tracking-wide text-yellow-400/80">
                {Math.abs(selected.totalCarryUsdM) > 1e-9 ? 'Net CFaR' : 'Max CFaR'}
              </span>
              <span className="font-mono text-sm font-semibold text-yellow-100">
                {fmtK(selected.bands.netCriticalCashUsdM)}
              </span>
            </div>
            <span className="text-[10px] text-slate-400">
              gross {fmtK(selected.bands.criticalCashUsdM)} · gross peak M
              {(selected.bands.grossPeakMonth > 0
                ? selected.bands.grossPeakMonth
                : selected.bands.peakMonth
              ).toFixed(1)}
              {selected.bands.netCriticalCashUsdM > 1e-9
                ? ` · net peak M${selected.bands.peakMonth.toFixed(1)}`
                : ' · net fully offset by carry'}{' '}
              ·{' '}
              {selected.hedged
                ? 'settlement gap g(t)=e−H_settled · point-in-time'
                : 'open exposure e(t) · point-in-time'}
            </span>
            <span
              className="text-[10px] text-slate-500"
              title="Spot = not-dealt + forecast σ_E (leg-count invariant when fully dealt). Swap = dealt-not-settled × rate-diff vol — shrinks with more legs. Swap-expected points are diagnostic only (not netted into Net CFaR)."
            >
              spot {fmtK(selected.bands.breakdown.spotPeakUsdM)} · swap{' '}
              {fmtK(selected.bands.breakdown.swapPeakUsdM)} (RSS-combined) ·
              swap-exp (info){' '}
              {fmtSignedK(selected.bands.breakdown.swapExpectedCostUsdM)}
              {' · '}
              u₁ₘ{' '}
              {(
                effectiveForecastUncertainty1m(
                  forecastProfile,
                  selected.ccy,
                  setup.forecastUncertainty1m,
                ) * 100
              ).toFixed(0)}
              %
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

          {/* What-if hedge — same toolbar as Strip Schedule (Reset | Legs −/+ | gear);
              per-leg Settle / Notional only behind amber gear. */}
          <div className="mb-2 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                  What-if hedge
                </div>
                <InfoTip label="What-if hedge">
                  <p>
                    Seeded from the {selected.ccy} hedge actually applied above
                    ({appliedDetail?.source ?? 'none'}). Chips show Cover / Legs
                    / Carry / Do nothing / Δ / Net CFaR (Cash Carry package).
                    Reset restores Applied legs and opens tick trades with
                    Carry. Legs −/+ redistributes equal spacing; amber gear
                    toggles Settle · Notional · Carry.
                  </p>
                </InfoTip>
                {whatIf && (
                  <span className="font-mono text-[10px] text-slate-500">
                    {whatIfLegs.filter(l => l.on).length >= 2 ? 'Strip' : 'Bullet'}
                    {' · '}
                    {fmtM(whatIf.totalNotionalLocalM)}
                  </span>
                )}
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-1.5 py-0.5">
                <button
                  type="button"
                  onClick={resetWhatIfToApplied}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  title="Re-seed What-if from Applied hedge — Cover, Legs, Carry, Do nothing, Benefit match Cash Carry"
                >
                  Reset
                </button>
                <span className="text-[9px] text-slate-600">|</span>
                <span className="text-[9px] text-slate-500">
                  {whatIfLegs.filter(l => l.on).length >= 2
                    ? 'Strip legs'
                    : 'Bullet · legs'}
                </span>
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
                <span className="text-[9px] text-slate-600">|</span>
                <button
                  type="button"
                  title={
                    whatIfScheduleOpen
                      ? 'Close tick-trades schedule'
                      : 'Strip schedule — Settle · Notional per leg'
                  }
                  aria-label="What-if schedule settings"
                  aria-pressed={whatIfScheduleOpen}
                  onClick={() => setWhatIfScheduleOpen(o => !o)}
                  className={`inline-flex h-6 w-6 items-center justify-center rounded ${
                    whatIfScheduleOpen
                      ? 'bg-amber-500/20 text-amber-200'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  <GearIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Absolute Cash Carry–style params (Reset restores Applied values) */}
            {whatIf && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                {(() => {
                  const chip =
                    'inline-flex items-baseline gap-1 rounded border border-slate-700 bg-slate-950/70 px-1.5 py-0.5';
                  const chipLbl =
                    'text-[8px] font-semibold uppercase tracking-wide text-slate-500';
                  const chipVal =
                    'font-mono text-[11px] font-semibold tabular-nums';
                  const coverPct =
                    Math.abs(selected.endM) > 1e-9
                      ? (whatIf.totalNotionalLocalM / selected.endM) * 100
                      : 0;
                  const legsOn = whatIfLegs.filter(l => l.on).length;
                  return (
                    <>
                      <span
                        className={chip}
                        title="What-if dealt notional · % of Tf exposure"
                      >
                        <span className={chipLbl}>Cover</span>
                        <span className={`${chipVal} text-slate-100`}>
                          {fmtM(whatIf.totalNotionalLocalM)}
                        </span>
                        {Math.abs(selected.endM) > 1e-9 && (
                          <span className={`${chipVal} text-slate-500`}>
                            {fmtPct(coverPct)}
                          </span>
                        )}
                      </span>
                      <span className={chip} title="Legs ticked On">
                        <span className={chipLbl}>Legs</span>
                        <span className={`${chipVal} text-sky-200`}>
                          {legsOn}
                        </span>
                      </span>
                      <span
                        className={chip}
                        title="What-if Total carry @ Tf — Cash Carry Total"
                      >
                        <span className={chipLbl}>Carry</span>
                        <span
                          className={`${chipVal} ${
                            whatIf.totalCarryUsdM >= 0
                              ? 'text-emerald-200'
                              : 'text-rose-300'
                          }`}
                        >
                          {fmtCarryK(whatIf.totalCarryUsdM)}
                        </span>
                      </span>
                      <span
                        className={chip}
                        title="Do-nothing / unhedged income @ Tf"
                      >
                        <span className={chipLbl}>Do nothing</span>
                        <span
                          className={`${chipVal} ${
                            whatIf.doNothingUsdM >= 0
                              ? 'text-amber-200/90'
                              : 'text-rose-300'
                          }`}
                        >
                          {fmtCarryK(whatIf.doNothingUsdM)}
                        </span>
                      </span>
                      <span
                        className={chip}
                        title="Benefit = Total − Do nothing"
                      >
                        <span className={chipLbl}>Δ</span>
                        <span
                          className={`${chipVal} ${
                            whatIf.benefitUsdM >= 0
                              ? 'text-emerald-200'
                              : 'text-rose-300'
                          }`}
                        >
                          {fmtCarryK(whatIf.benefitUsdM)}
                        </span>
                      </span>
                      <span className={chip} title="What-if Net CFaR">
                        <span className={chipLbl}>Net CFaR</span>
                        <span className={`${chipVal} text-yellow-200`}>
                          {fmtK(whatIf.bands.netCriticalCashUsdM)}
                        </span>
                      </span>
                    </>
                  );
                })()}
              </div>
            )}

            {whatIfScheduleOpen && (
              <div className="mb-1.5 rounded border border-amber-500/25 bg-slate-950/70 p-1.5">
                <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200/90">
                  Tick trades · Settle · Notional · Carry
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-[10px]">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500">
                        <th className="w-8 py-1 pr-2 font-medium">On</th>
                        <th className="py-1 pr-3 font-medium">Settle</th>
                        <th className="py-1 pr-3 font-medium">Notional Δ</th>
                        <th className="py-1 pr-3 font-medium">Cumul. cover</th>
                        <th
                          className="py-1 font-medium"
                          title="Per-leg path carry — same engine as Cash Carry tick trades"
                        >
                          Carry
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const rates = marketRatesFor(selected.ccy);
                        let cum = 0;
                        return [...whatIfLegs]
                          .sort((a, b) => a.settleMonths - b.settleMonths)
                          .map(row => {
                            if (row.on) cum += row.amountLocalM;
                            const carry = row.on
                              ? legCarryBreakdown(
                                  selected.ccy,
                                  row.amountLocalM,
                                  row.settleMonths,
                                  T,
                                  rates,
                                )
                              : null;
                            return { row, cum, carry };
                          });
                      })().map(({ row, cum, carry }) => (
                        <tr key={row.id} className="border-b border-slate-900/80">
                          <td className="py-1 pr-2">
                            <input
                              type="checkbox"
                              checked={row.on}
                              onChange={e =>
                                updateWhatIfLeg(row.id, { on: e.target.checked })
                              }
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
                                  settleMonths: Math.max(
                                    0,
                                    Math.min(T, Number(e.target.value) || 0),
                                  ),
                                })
                              }
                              className="w-16 rounded border border-amber-500/40 bg-slate-900 px-1 py-0.5 font-mono text-amber-100"
                            />
                            <span className="ml-1 text-slate-500">m</span>
                          </td>
                          <td className="py-1 pr-3">
                            <input
                              type="number"
                              step={0.1}
                              value={row.amountLocalM}
                              onChange={e =>
                                updateWhatIfLeg(row.id, {
                                  amountLocalM: Number(e.target.value) || 0,
                                })
                              }
                              className="w-20 rounded border border-amber-500/40 bg-slate-900 px-1 py-0.5 font-mono text-amber-100"
                            />
                            <span className="ml-1 text-slate-500">M</span>
                          </td>
                          <td className="py-1 pr-3 font-mono text-slate-400">
                            {row.on ? fmtM(cum) : '—'}
                          </td>
                          {carry ? (
                            <CarryCell
                              totalUsdM={carry.totalUsdM}
                              fwdCarryUsdM={carry.fwdCarryUsdM}
                              fcyInterestUsdM={carry.fcyInterestUsdM}
                              usdInterestUsdM={carry.usdInterestUsdM}
                            />
                          ) : (
                            <td className="py-1 font-mono text-slate-600">—</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {whatIf ? (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
                <WhatIfDeltaRow
                  label="Carry"
                  current={selected.totalCarryUsdM}
                  proposed={whatIf.totalCarryUsdM}
                  fmt={fmtCarryK}
                  lowerIsBetter={false}
                  note="Total carry @ Tf — same as Cash Carry Total for this CCY."
                />
                <WhatIfDeltaRow
                  label="Do nothing"
                  current={selected.doNothingUsdM}
                  proposed={whatIf.doNothingUsdM}
                  fmt={fmtCarryK}
                  lowerIsBetter={false}
                  note="Unhedged income @ Tf — Cash Carry Do nothing column."
                />
                <WhatIfDeltaRow
                  label="Δ Benefit"
                  current={selected.benefitUsdM}
                  proposed={whatIf.benefitUsdM}
                  fmt={fmtCarryK}
                  lowerIsBetter={false}
                  note="Total − Do nothing — Cash Carry Δ / enhancement."
                />
                <WhatIfDeltaRow
                  label="Cover Δ"
                  current={appliedDetail?.totalNotionalLocalM ?? 0}
                  proposed={whatIf.totalNotionalLocalM}
                  fmt={fmtM}
                  lowerIsBetter={false}
                  note="Total dealt notional (local M) — the FX delta locked from trade date."
                />
                <WhatIfDeltaRow
                  label="Resid spot"
                  current={selected.bands.breakdown.spotPeakUsdM}
                  proposed={whatIf.bands.breakdown.spotPeakUsdM}
                  fmt={fmtK}
                  lowerIsBetter
                  note="Undelt FX + forecast σ_E peak — residual spot risk after the dealt hedge."
                />
                <WhatIfDeltaRow
                  label="Swap-bridge"
                  current={selected.bands.breakdown.swapPeakUsdM}
                  proposed={whatIf.bands.breakdown.swapPeakUsdM}
                  fmt={fmtK}
                  lowerIsBetter
                  note="Dealt-but-not-settled × rate-diff vol — the piece leg count/spacing controls."
                />
                <WhatIfDeltaRow
                  label="Net CFaR"
                  current={selected.bands.netCriticalCashUsdM}
                  proposed={whatIf.bands.netCriticalCashUsdM}
                  fmt={fmtK}
                  lowerIsBetter
                  note="RSS(spot, swap) net of real FWD hedge carry."
                />
              </div>
            ) : (
              <p className="text-[9px] text-slate-500">
                No legs ticked On — open the gear and turn a leg on to see impact.
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

          {frontier.length > 1 && (
            <FrontierChart
              points={frontier}
              currentCarryUsdM={selected.totalCarryUsdM}
              currentCfarUsdM={selected.bands.netCriticalCashUsdM}
              currentLegCount={
                selected.hedged
                  ? (appliedDetail?.legs.length ?? 1) || 1
                  : 1
              }
            />
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Efficient frontier: Net CFaR vs carry as leg count varies, same total
 * hedge notional held fixed. Amber dot = the currently applied leg count;
 * hollow dots = the other sampled leg counts on the same total. Lets the
 * desk see where the applied structure sits relative to what more/fewer,
 * equally-spaced legs would trade off — same pipeline as the figures above,
 * not a separate approximation.
 */
function FrontierChart({
  points,
  currentCarryUsdM,
  currentCfarUsdM,
  currentLegCount,
}: {
  points: FrontierPoint[];
  currentCarryUsdM: number;
  currentCfarUsdM: number;
  currentLegCount: number;
}) {
  const W = 560;
  const H = 180;
  const padL = 52;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const allCarry = points.map(p => p.carryUsdM).concat(currentCarryUsdM);
  const allCfar = points.map(p => p.netCfarUsdM).concat(currentCfarUsdM);
  let xMin = Math.min(...allCarry);
  let xMax = Math.max(...allCarry);
  if (xMax - xMin < 1e-9) {
    xMin -= 0.01;
    xMax += 0.01;
  }
  const xPad = (xMax - xMin) * 0.12;
  xMin -= xPad;
  xMax += xPad;
  const yMax = Math.max(1e-9, Math.max(...allCfar) * 1.12);
  const x = (v: number) => padL + ((v - xMin) / (xMax - xMin)) * plotW;
  const y = (v: number) => padT + (1 - v / yMax) * plotH;
  const linePoints = points.map(p => `${x(p.carryUsdM).toFixed(1)},${y(p.netCfarUsdM).toFixed(1)}`).join(' ');
  const x0 = x(0);
  const nearest = points.reduce((best, p) =>
    Math.abs(p.legCount - currentLegCount) < Math.abs(best.legCount - currentLegCount) ? p : best,
  points[0]!);
  const showEveryLabel = points.length <= 6;
  return (
    <div className="mt-3 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
            Efficient frontier · Net CFaR vs Carry
          </span>
          <InfoTip label="Efficient frontier">
            <p>
              Each point redistributes the same applied total notional across N
              equally-spaced legs and re-runs the full carry + CFaR pipeline.
              Amber-filled dot = leg count actually applied ({nearest.legCount}
              ). Moving left along the curve trades lower CFaR for less carry
              (or a carry cost) as legs shift onto different points of the
              forward curve.
            </p>
          </InfoTip>
        </div>
        <span className="text-[9px] text-slate-500">
          same total notional, leg count {points[0]!.legCount}–{points[points.length - 1]!.legCount}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-full rounded border border-slate-800 bg-slate-950"
        preserveAspectRatio="xMidYMid meet"
      >
        {xMin < 0 && xMax > 0 && (
          <line x1={x0} y1={padT} x2={x0} y2={H - padB} stroke="#334155" strokeWidth={1} strokeDasharray="2 3" />
        )}
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#475569" strokeWidth={1} />
        <polyline points={linePoints} fill="none" stroke="#facc15" strokeWidth={1.5} opacity={0.7} />
        {points.map(p => {
          const isCurrent = p.legCount === nearest.legCount;
          return (
            <g key={p.legCount}>
              <circle
                cx={x(p.carryUsdM)}
                cy={y(p.netCfarUsdM)}
                r={isCurrent ? 4 : 2.5}
                fill={isCurrent ? '#facc15' : '#0b1220'}
                stroke="#facc15"
                strokeWidth={isCurrent ? 0 : 1.5}
              />
              {(showEveryLabel || isCurrent) && (
                <text
                  x={x(p.carryUsdM)}
                  y={y(p.netCfarUsdM) - 7}
                  textAnchor="middle"
                  fontSize={8}
                  fontWeight={isCurrent ? 700 : 500}
                  fill={isCurrent ? '#fde047' : '#94a3b8'}
                >
                  {p.legCount}
                </text>
              )}
            </g>
          );
        })}
        <text x={padL - 4} y={H - padB + 3} textAnchor="end" fontSize={8} fill="#64748b">$0</text>
        <text x={padL - 4} y={padT + 6} textAnchor="end" fontSize={8} fill="#64748b">
          {fmtK(yMax)}
        </text>
      </svg>
    </div>
  );
}
