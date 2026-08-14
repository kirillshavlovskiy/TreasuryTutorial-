'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CfarDrawdownChart } from '@/components/test-mode/CfarDrawdownChart';
import {
  buildCashForecastCarryComparison,
  buildCarryEvolutionLegBarsFromSamples,
  resolvedHedgedTotalCarryUsdM,
  sumCashCarryTotalUsdM,
} from '@/lib/test-mode/cash-carry-analytics';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import { type CfarBandsResult } from '@/lib/test-mode/cfar-drawdown';
import {
  buildSyntheticHedgeProfile,
  rateVolBpYrFor,
  settlementFundingGapForHedge,
  type FundingGapResult,
} from '@/lib/test-mode/cfar-residual';
import {
  efficientFrontier,
  isDegenerateFrontier,
  lowestReservePoint,
  type FrontierPoint,
} from '@/lib/test-mode/cfar-frontier';
import {
  type McCfarInput,
  type McHedgeSettleLeg,
  type McCfarComponentPoint,
  type McCfarDiagnostics,
} from '@/lib/test-mode/cfar-montecarlo';
import { cfarJobKey, useCfarJobs } from '@/components/test-mode/use-cfar-jobs';
import {
  splineBand,
  splinePath,
  type SplinePt,
} from '@/components/test-mode/spline';
import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
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
  MONTHLY_VOL_MAX,
  MONTHLY_VOL_MIN,
  VAR_VOL_SOURCE_OPTIONS,
  clampMonthlyVol,
  horizonMonths,
  monthlyVolForSetup,
  type VarSetup,
  type VarVolSource,
} from '@/lib/test-mode/var-setup';
import { VolSourceControl } from '@/components/test-mode/VolSourceControl';
import { DeskStepper } from '@/components/DeskStepper';
import {
  resolveMarketRatesForCcy,
  resolveForwardDepositRates,
  resolveOvernightCashRates,
  fwdCarryFromSwapPointsUsdM,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { stripHedgeLegCarryUsdM } from '@/lib/fx-hedge';
import { CURRENCY_PARAMS, type RowState } from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  clearLineUncertainties,
  effectiveForecastUncertainty1m,
  monthlyFlowSeriesLocalM,
  monthlyInflowSeriesLocalM,
  monthlyOutflowSeriesLocalM,
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

/** Shortest readable form of a σ input value — 2.5 → "2.5", 3 → "3". */
function trimNum(v: number): string {
  return String(Number(v.toFixed(3)));
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

/** HedgeDetail.legs → the deterministic settlement schedule the Monte Carlo
 * cash-mismatch engine needs (settle month + signed notional per leg). */
function scheduleFromHedgeDetail(detail: HedgeDetail): McHedgeSettleLeg[] {
  return detail.legs.map(l => ({
    settleMonths: l.settleMonths,
    notionalLocalM: l.tradeNotionalLocalM,
  }));
}

/** Same, from a (possibly synthetic/what-if) PreparedHedgeProfile directly. */
function scheduleFromPreparedProfile(
  prep: PreparedHedgeProfile,
  tenureMonths: number,
): McHedgeSettleLeg[] {
  if (prep.structure === 'strip' && prep.legs.length > 0) {
    return prep.legs.map(l => ({
      settleMonths: l.settleMonths ?? l.endMonth,
      notionalLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
    }));
  }
  if (Math.abs(prep.coverLocalM) > 1e-9) {
    return [{ settleMonths: prep.settleMonths ?? tenureMonths, notionalLocalM: prep.coverLocalM }];
  }
  return [];
}

/**
 * Deposit rates and rate-differential vol for the cash-ledger engine. Levels
 * come from the same JPM NP table the Cash Carry module sources its own carry
 * from (CURRENCY_PARAMS); the vol is the flat per-currency rate-differential
 * table (RATE_DIFF_VOL_BP_YR, bp/year → %/year) unless the setup overrides it
 * from the σ gear, which the engine random-walks
 * across the horizon. The differential usd − fcy also sets the CIP drift on
 * the simulated spot path, so forwards struck at the implied rate are fair.
 */
function mcRateParamsFor(
  ccy: string,
  setup: Pick<VarSetup, 'rateVolOverrideBpYr'>,
): {
  usdRatePctPa: number;
  fcyRatePctPa: number;
  rateVolPctPa: number;
} {
  return {
    usdRatePctPa: CURRENCY_PARAMS.USD?.carry ?? 0,
    fcyRatePctPa: CURRENCY_PARAMS[ccy]?.carry ?? 0,
    rateVolPctPa: rateVolBpYrFor(ccy, setup) / 100,
  };
}

/** Deterministic per-currency MC seed — stable across renders (no flicker)
 * and distinct per CCY (no cross-currency correlation from sharing one seed). */
function hashSeedForCcy(ccy: string): number {
  let h = 0x5f3759df;
  for (let i = 0; i < ccy.length; i += 1) {
    h = (Math.imul(h ^ ccy.charCodeAt(i), 0x01000193) >>> 0);
  }
  return h >>> 0;
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

/** Current → proposed comparison card — notes live in ⓘ popup only. */
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
        Δ {fmtSignedK(delta)}
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
  /** Cumulative deterministic hedge-carry schedule (USD M, index i =
   * cumulative through month i+1) — the real forward-points accrual on the
   * FULL hedge notional, 0 at T0 growing toward totalCarryUsdM by Tf. */
  carryScheduleUsdM?: number[];
  doNothingUsdM: number;
  benefitUsdM: number;
  bands: CfarBandsResult & McCfarDiagnostics;
  fundingGap: FundingGapResult | null;
}

/** A row with everything the client can work out on its own. The simulation
 * itself runs on the server, so `bands` is attached later, once its job
 * comes back. */
type CfarRowSpec = Omit<CfarRow, 'bands'> & {
  mcInput: McCfarInput;
  jobKey: string;
};

/** What-if hedge scenario result — same shape family as the live row. */
interface WhatIfResult {
  totalNotionalLocalM: number;
  hedged: boolean;
  bands: CfarBandsResult & McCfarDiagnostics;
  fundingGap: FundingGapResult | null;
  totalCarryUsdM: number;
  carryScheduleUsdM?: number[];
  doNothingUsdM: number;
  benefitUsdM: number;
}

type WhatIfSpec = Omit<WhatIfResult, 'bands'> & {
  mcInput: McCfarInput;
  jobKey: string;
};

/** Frontier point before its simulation lands — the CFaR figures are the only
 * fields that have to come back from the server. */
interface FrontierSpec {
  coverRatio: number;
  carryUsdM: number;
  mcInput: McCfarInput;
  jobKey: string;
  /** The hedge actually dealt, rather than a member of the evenly-spaced
   * sweep. Priced on the sweep's basis but held out of its frontier. */
  applied?: boolean;
}
/**
 * Cover levels sampled, as a fraction of the applied notional. Clustered
 * around full cover, which is where risk turns: it falls steeply up to roughly
 * 100–110% and climbs again beyond, so a uniform grid would spend most of its
 * points on the dominated branch and miss the turn itself.
 */
const FRONTIER_COVER_RATIOS = [0, 0.25, 0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5];
/** Paths per frontier point. Ten simulations run per batch at roughly 70ms
 * each, so this is latency the desk does not notice — see the note on common
 * random numbers where the seed is set, which is what makes differences at
 * this path count readable. */
const FRONTIER_PATHS = 600;

/**
 * CFaR analysis tab — critical cash absorption per currency, computed off the
 * REAL hedge chosen in Cash Carry via {@link computeMonteCarloMismatchCfar}
 * (2026-08-10 rebuild — replaces the earlier closed-form spot/swap-bridge
 * split entirely; there is no swap/liquidity-funding assumption in this
 * analysis at all, gap-bridging mechanics are out of scope here):
 *
 * - A single unified mismatch e(t)−H_settled(t) — no split between
 *   "not-dealt" and "dealt-not-settled" notional. The stochastic INPUTS
 *   (gross monthly in/out flow realizations, with outflow conservatively
 *   assumed to hit before inflow within a month, and the carry rate
 *   differential) are Monte Carlo simulated; the FX shock scales with √t
 *   using cumulative time from T0 (point-in-time draw at each interval, no
 *   continuous accrual — an unconverted mismatch doesn't itself generate
 *   cash P&L, only the worst point-in-time draw does).
 * - Carry is itself stochastic — both the rate differential and the
 *   notional it applies to (the random mismatch) are random draws, summed
 *   across the path (a genuine accruing flow, unlike the FX shock).
 * - Settlement frequency lowers CFaR through the SIZE of the mismatch
 *   (H_settled updates more often against the continuously-accruing
 *   exposure as legs settle) — not through any separate swap-bridge term.
 *
 * The "Funding gap" column is the same e(t)−H_settled(t) mismatch's
 * deterministic (zero-vol) floor — see {@link settlementFundingGapForHedge}.
 * Styling follows the hedge carry profile modal locked kit (slate sections ·
 * violet CCY select · yellow CFaR).
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
  // Stable across renders but re-created the moment any rate input changes,
  // so the Monte Carlo memos below can depend on it directly: they re-run when
  // the curve moves and not on every unrelated render.
  const marketRatesFor = useCallback(
    (ccy: string): FxMarketRatesBundle =>
      marketRatesProp ??
      resolveMarketRatesForCcy(marketRatesByCcy, ccy, ratesScopeId),
    [marketRatesProp, marketRatesByCcy, ratesScopeId],
  );

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
  const patchVolOverride = (source: VarVolSource, monthlyVol: number) =>
    patch({
      volOverrides: { ...setup.volOverrides, [source]: clampMonthlyVol(monthlyVol) },
    });
  const resetVolOverride = (source: VarVolSource) => {
    const next = { ...setup.volOverrides };
    delete next[source];
    patch({ volOverrides: Object.keys(next).length > 0 ? next : undefined });
  };
  const sigmaMonthly = monthlyVolForSetup(setup);
  const zConf = zForConfidence(setup.confidencePct);
  const activeVolIsOverridden =
    setup.volOverrides?.[setup.volSource] !== undefined;
  const activeVolOpt = VAR_VOL_SOURCE_OPTIONS.find(o => o.id === setup.volSource);

  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  const T = Tf > 0 ? Tf : horizonMonths(setup.horizon);

  const rowSpecs = useMemo<CfarRowSpec[]>(() => {
    const ccys = risk
      .map(r => r.bar.ccy)
      .filter(ccy => ccy !== 'USD' && ccy.length > 0);
    return ccys
      .map((ccy): CfarRowSpec | null => {
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
        const hedgeDetail = hedgeDetailForCcy(bookedHedges, preparedByCcy, ccy, setup);
        const hedgeSettleSchedule = scheduleFromHedgeDetail(hedgeDetail);
        const hedged = hedgeSettleSchedule.length > 0;
        const monthlyInflows = bookRow
          ? monthlyInflowSeriesLocalM(bookRow, Math.max(1, T), forecastProfile ?? DEFAULT_FORECAST_PROFILE)
          : [];
        const monthlyOutflows = bookRow
          ? monthlyOutflowSeriesLocalM(bookRow, Math.max(1, T), forecastProfile ?? DEFAULT_FORECAST_PROFILE)
          : [];
        const mcInput: McCfarInput = {
          stockM,
          monthlyInflows,
          monthlyOutflows,
          tenureMonths: T,
          spotUsd: NORDTECH_VAR.spotUsd[ccy] ?? 1,
          sigmaFxMonthly: sigmaMonthly,
          confidencePct: setup.confidencePct,
          forecastUncertainty1m: effectiveForecastUncertainty1m(
            forecastProfile,
            ccy,
            setup.forecastUncertainty1m,
          ),
          hedgeSettleSchedule,
          hedgeCarryScheduleUsdM: carryScheduleUsdM,
          ...mcRateParamsFor(ccy, setup),
          seed: hashSeedForCcy(ccy),
        };
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
          carryScheduleUsdM,
          doNothingUsdM,
          benefitUsdM,
          fundingGap,
          mcInput,
          jobKey: cfarJobKey(`row:${ccy}`, mcInput),
        };
      })
      .filter((r): r is CfarRowSpec => r != null);
  }, [
    risk,
    bookRows,
    forecastProfile,
    setup,
    bookedHedges,
    preparedByCcy,
    T,
    marketRatesFor,
    sigmaMonthly,
  ]);

  const rowJobs = useMemo(
    () => rowSpecs.map(s => ({ key: s.jobKey, input: s.mcInput })),
    [rowSpecs],
  );
  const rowSim = useCfarJobs(rowJobs);

  /**
   * Rows whose simulation has come back. Not memoized: the hook's result map
   * is mutated in place as jobs land, so a memo keyed on it would never see
   * the new entries, and the loop is a handful of currencies.
   */
  const freshRows: CfarRow[] = [];
  for (const spec of rowSpecs) {
    const bands = rowSim.results.get(spec.jobKey);
    if (bands) freshRows.push({ ...spec, bands });
  }
  /**
   * Hold the last complete set on screen while a new one computes. Every key
   * changes at once when a parameter moves, so without this the whole panel
   * would empty and rebuild on each nudge of a slider.
   */
  const lastRowsRef = useRef<CfarRow[]>([]);
  const rowsComplete = freshRows.length === rowSpecs.length;
  if (rowsComplete) lastRowsRef.current = freshRows;
  const rows =
    rowsComplete || lastRowsRef.current.length === 0
      ? freshRows
      : lastRowsRef.current;
  const rowsStale = !rowsComplete && lastRowsRef.current.length > 0;

  const totals = useMemo(
    () =>
      rows.reduce(
        (a, r) => ({
          grossCashUsdM: a.grossCashUsdM + r.bands.criticalCashUsdM,
          netCashUsdM: a.netCashUsdM + r.bands.netCriticalCashUsdM,
          mismatchCarryMeanUsdM: a.mismatchCarryMeanUsdM + r.bands.carryMeanUsdM,
          mismatchCarryStdUsdM: a.mismatchCarryStdUsdM + r.bands.carryStdUsdM,
          bridgeFundingUsdM: a.bridgeFundingUsdM + r.bands.peakBridgeFundingUsdM,
          planBridgeFundingUsdM:
            a.planBridgeFundingUsdM + r.bands.planPeakBridgeFundingUsdM,
          unplannedFundingUsdM:
            a.unplannedFundingUsdM + r.bands.peakUnplannedUsdFundingUsdM,
        }),
        {
          grossCashUsdM: 0,
          netCashUsdM: 0,
          mismatchCarryMeanUsdM: 0,
          mismatchCarryStdUsdM: 0,
          bridgeFundingUsdM: 0,
          planBridgeFundingUsdM: 0,
          unplannedFundingUsdM: 0,
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

  /** The selected row's own simulation inputs. The frontier re-runs them at
   * its own path count so the applied marker stands on the same footing as the
   * sweep it is being read against. */
  const selectedSpec = selected
    ? (rowSpecs.find(s => s.ccy === selected.ccy) ?? null)
    : null;

  /** The real hedge driving "current" — same object the Applied-hedge panel shows. */
  const appliedDetail = useMemo(
    () =>
      selected
        ? hedgeDetailForCcy(bookedHedges, preparedByCcy, selected.ccy, setup)
        : null,
    [selected, bookedHedges, preparedByCcy, setup],
  );
  const appliedLegCount = selected?.hedged ? appliedDetail?.legs.length || 1 : 1;
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
  /** Gear open = edit Settle / Notional; closed = read-only legs + metric chips. */
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
  const resetWhatIfToApplied = () =>
    setWhatIfLegs(seedWhatIfLegs(appliedDetail, T));
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

  /**
   * Per-leg Carry + Enhancement vs do-nothing — same engine as Cash Carry
   * carry-evolution leg bars (`buildCarryEvolutionLegBarsFromSamples`).
   */
  const whatIfLegMetricsById = useMemo(() => {
    type LegMetric = {
      carryUsdM: number;
      enhancementUsdM: number;
      doNothingUsdM: number;
      fwdCarryUsdM: number;
      fcyInterestUsdM: number;
      usdInterestUsdM: number;
    };
    const out = new Map<number, LegMetric>();
    if (!selected) return out;
    const active = [...whatIfLegs]
      .filter(l => l.on && Math.abs(l.amountLocalM) > 1e-12)
      .sort((a, b) => a.settleMonths - b.settleMonths);
    if (active.length === 0) return out;
    const bars = buildCarryEvolutionLegBarsFromSamples({
      ccy: selected.ccy,
      setup,
      marketRates: marketRatesFor(selected.ccy),
      legs: active.map(l => ({
        settleMonths: l.settleMonths,
        amountLocalM: l.amountLocalM,
        recognizeMonths: 0,
        structure: active.length >= 2 ? 'strip' : 'bullet',
      })),
    });
    active.forEach((leg, i) => {
      const bar = bars[i];
      if (!bar) return;
      out.set(leg.id, {
        carryUsdM: bar.improvedCarryUsdM,
        enhancementUsdM: bar.hedgeImprovementUsdM,
        doNothingUsdM: bar.defaultCarryUsdM,
        fwdCarryUsdM: bar.hedgeBreakdown?.fwdCarryUsdM ?? 0,
        fcyInterestUsdM: bar.hedgeBreakdown?.fcyInterestUsdM ?? 0,
        usdInterestUsdM: bar.hedgeBreakdown?.usdInterestUsdM ?? 0,
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected?.ccy,
    whatIfLegs,
    setup,
    marketRatesProp,
    marketRatesByCcy,
    ratesScopeId,
    T,
  ]);

  const whatIfSpec = useMemo<WhatIfSpec | null>(() => {
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
    const bookRow = bookRows?.find(r => r.ccy === ccy);
    const monthlyInflows = bookRow
      ? monthlyInflowSeriesLocalM(bookRow, Math.max(1, T), forecastProfile ?? DEFAULT_FORECAST_PROFILE)
      : [];
    const monthlyOutflows = bookRow
      ? monthlyOutflowSeriesLocalM(bookRow, Math.max(1, T), forecastProfile ?? DEFAULT_FORECAST_PROFILE)
      : [];
    const hedgeSettleSchedule = scheduleFromPreparedProfile(synthetic, T);
    const hedged = hedgeSettleSchedule.length > 0;
    const mcInput: McCfarInput = {
      stockM: selected.stockM,
      monthlyInflows,
      monthlyOutflows,
      tenureMonths: T,
      spotUsd: NORDTECH_VAR.spotUsd[ccy] ?? 1,
      sigmaFxMonthly: sigmaMonthly,
      confidencePct: setup.confidencePct,
      forecastUncertainty1m: effectiveForecastUncertainty1m(
        forecastProfile,
        ccy,
        setup.forecastUncertainty1m,
      ),
      hedgeSettleSchedule,
      hedgeCarryScheduleUsdM: carryScheduleUsdM,
      ...mcRateParamsFor(ccy, setup),
      seed: hashSeedForCcy(ccy),
    };
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
      fundingGap,
      totalCarryUsdM,
      carryScheduleUsdM,
      doNothingUsdM,
      benefitUsdM,
      mcInput,
      jobKey: cfarJobKey(`whatif:${ccy}`, mcInput),
    };
  }, [
    selected,
    whatIfLegs,
    T,
    setup,
    bookRows,
    forecastProfile,
    marketRatesFor,
    sigmaMonthly,
  ]);

  /**
   * Efficient frontier: how much to COVER, holding the applied leg spacing.
   * Each point scales the applied notional by a cover ratio, redistributes it
   * across the same number of evenly-spaced legs, and re-runs the same carry
   * (buildCashForecastCarryComparison + resolvedHedgedTotalCarryUsdM) and CFaR
   * (computeMonteCarloMismatchCfar) pipeline as the applied-hedge and what-if
   * figures above, so it is directly comparable to them.
   *
   * Cover rather than leg count, because leg count does not trade anything
   * off: settling earlier closes the mismatch AND converts into the
   * higher-yielding currency sooner, so more legs win on both axes at once and
   * every other structure is dominated. Cover is genuinely two-sided — risk
   * falls to a minimum near full cover and rises again beyond it, as the
   * over-hedge becomes an exposure in its own right, while carry keeps
   * climbing with notional.
   *
   * The applied structure is appended as a final point on exactly this basis —
   * same seed, same path count, and its carry taken through the same function
   * from a profile built out of its own legs, so its x is comparable and not a
   * figure from the booked-ticket branch. It is deliberately NOT part of the
   * sweep: its legs are wherever they were dealt, so it does not belong to the
   * evenly-spaced family whose frontier the curve traces, and it may well sit
   * inside that frontier.
   */
  const frontierSpecs = useMemo<FrontierSpec[]>(() => {
    if (
      !selected ||
      !selectedSpec ||
      !appliedDetail ||
      Math.abs(appliedDetail.totalNotionalLocalM) < 1e-9
    ) {
      return [];
    }
    const ccy = selected.ccy;
    const rates = marketRatesFor(ccy);
    const totalNotionalLocalM = appliedDetail.totalNotionalLocalM;
    const bookRow = bookRows?.find(r => r.ccy === ccy);
    const monthlyInflows = bookRow
      ? monthlyInflowSeriesLocalM(bookRow, Math.max(1, T), forecastProfile ?? DEFAULT_FORECAST_PROFILE)
      : [];
    const monthlyOutflows = bookRow
      ? monthlyOutflowSeriesLocalM(bookRow, Math.max(1, T), forecastProfile ?? DEFAULT_FORECAST_PROFILE)
      : [];
    const rateParams = mcRateParamsFor(ccy, setup);
    const spotUsd = NORDTECH_VAR.spotUsd[ccy] ?? 1;
    const u1m = effectiveForecastUncertainty1m(forecastProfile, ccy, setup.forecastUncertainty1m);
    /** Carry for an arbitrary structure, always down the prepared-profile
     * branch. The applied hedge goes through this too: reading its carry off
     * the booked-ticket branch instead put its marker a long way right of a
     * sweep it was supposed to be measured against. */
    const carryFor = (prep: PreparedHedgeProfile) => {
      const cmp = buildCashForecastCarryComparison({
        ccy,
        bookRows,
        forecastProfile,
        forecastMonths: setup.forecastMonths,
        marketRates: rates,
        bookedHedges: [],
        preparedByCcy: { [ccy]: prep },
        setup,
      });
      const totalCarryUsdM = cmp
        ? resolvedHedgedTotalCarryUsdM({
            comparison: cmp,
            prepared: prep,
            marketRates: rates,
          }).totalCarryUsdM
        : 0;
      return {
        totalCarryUsdM,
        scheduleUsdM: cumulativeCarrySchedule(cmp?.hedged.months, totalCarryUsdM),
      };
    };

    const specs = FRONTIER_COVER_RATIOS.map((coverRatio): FrontierSpec => {
      const synthetic = buildSyntheticHedgeProfile({
        totalNotionalLocalM: totalNotionalLocalM * coverRatio,
        legCount: appliedLegCount,
        tenureMonths: T,
      });
      const carry = carryFor(synthetic);
      const mcInput: McCfarInput = {
        stockM: selected.stockM,
        monthlyInflows,
        monthlyOutflows,
        tenureMonths: T,
        spotUsd,
        sigmaFxMonthly: sigmaMonthly,
        confidencePct: setup.confidencePct,
        forecastUncertainty1m: u1m,
        hedgeSettleSchedule: scheduleFromPreparedProfile(synthetic, T),
        // Carried by the rows and the what-if, so it has to be carried here
        // too: without it the reserve is netted against ledger interest only,
        // never the forward points, which roughly doubles it on a strip that
        // earns carry and puts the curve on a different footing from every
        // other CFaR figure in the panel.
        hedgeCarryScheduleUsdM: carry.scheduleUsdM,
        ...rateParams,
        // Common random numbers. Every cover level is priced against the SAME
        // draws, so the difference between two points is the structure and not
        // the sample: independent seeds leave a per-point error of the order of
        // the gap between neighbouring points near the turn of the curve,
        // which is exactly where the choice is marginal and where an inverted
        // ordering would be believed.
        seed: hashSeedForCcy(ccy),
        paths: FRONTIER_PATHS,
      };
      return {
        coverRatio,
        carryUsdM: carry.totalCarryUsdM,
        mcInput,
        jobKey: cfarJobKey(`frontier:${ccy}:${coverRatio}`, mcInput),
      };
    });

    const appliedPrepared: PreparedHedgeProfile =
      appliedDetail.legs.length >= 2
        ? {
            structure: 'strip',
            basis: 'varNeutral',
            ticketBasis: 'stock',
            legs: appliedDetail.legs.map((l, i) => ({
              index: i,
              startMonth: 0,
              endMonth: l.settleMonths,
              settleMonths: l.settleMonths,
              hedgeLocalM: l.cumulCoverLocalM,
              tradeNotionalLocalM: l.tradeNotionalLocalM,
              label: l.label,
            })),
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
            settleMonths: appliedDetail.legs[0]?.settleMonths ?? T,
          };
    const appliedCarry = carryFor(appliedPrepared);
    const appliedInput: McCfarInput = {
      ...selectedSpec.mcInput,
      hedgeCarryScheduleUsdM: appliedCarry.scheduleUsdM,
      seed: hashSeedForCcy(ccy),
      paths: FRONTIER_PATHS,
    };
    specs.push({
      coverRatio: 1,
      carryUsdM: appliedCarry.totalCarryUsdM,
      mcInput: appliedInput,
      jobKey: cfarJobKey(`frontier:${ccy}:applied`, appliedInput),
      applied: true,
    });
    return specs;
  }, [
    selected,
    selectedSpec,
    appliedDetail,
    appliedLegCount,
    T,
    setup,
    bookRows,
    forecastProfile,
    marketRatesFor,
    sigmaMonthly,
  ]);

  /** What-if and frontier travel together: both belong to the selected
   * currency and both are wanted at the same moment, so one batch keeps them
   * behind a single request while the per-currency rows stream separately. */
  const detailJobs = useMemo(() => {
    const jobs = frontierSpecs.map(s => ({ key: s.jobKey, input: s.mcInput }));
    if (whatIfSpec) {
      jobs.unshift({ key: whatIfSpec.jobKey, input: whatIfSpec.mcInput });
    }
    return jobs;
  }, [whatIfSpec, frontierSpecs]);
  const detailSim = useCfarJobs(detailJobs);

  const lastWhatIfRef = useRef<WhatIfResult | null>(null);
  let whatIf: WhatIfResult | null = null;
  if (whatIfSpec) {
    const bands = detailSim.results.get(whatIfSpec.jobKey);
    if (bands) {
      whatIf = { ...whatIfSpec, bands };
      lastWhatIfRef.current = whatIf;
    } else {
      // Falling back to null here would swap the chart to the applied hedge
      // mid-edit, which reads as the what-if having been discarded.
      whatIf = lastWhatIfRef.current;
    }
  } else {
    lastWhatIfRef.current = null;
  }

  /** The equally-spaced sweep and the applied structure, kept apart: the sweep
   * is the family whose frontier gets traced, the applied point is where the
   * desk actually stands and may sit inside it. */
  const freshSweep: FrontierPoint[] = [];
  let freshApplied: FrontierPoint | null = null;
  let landed = 0;
  for (const spec of frontierSpecs) {
    const bands = detailSim.results.get(spec.jobKey);
    if (!bands) continue;
    landed += 1;
    const point: FrontierPoint = {
      coverRatio: spec.coverRatio,
      grossCfarUsdM: bands.criticalCashUsdM,
      netCfarUsdM: bands.netCriticalCashUsdM,
      carryUsdM: spec.carryUsdM,
    };
    if (spec.applied) freshApplied = point;
    else freshSweep.push(point);
  }
  const lastFrontierRef = useRef<{ sweep: FrontierPoint[]; applied: FrontierPoint | null }>({
    sweep: [],
    applied: null,
  });
  const frontierComplete = frontierSpecs.length > 0 && landed === frontierSpecs.length;
  if (frontierComplete) {
    lastFrontierRef.current = { sweep: freshSweep, applied: freshApplied };
  }
  const showLast = !frontierComplete && lastFrontierRef.current.sweep.length > 0;
  const frontier = showLast ? lastFrontierRef.current.sweep : freshSweep;
  const frontierApplied = showLast ? lastFrontierRef.current.applied : freshApplied;

  const simError = rowSim.error ?? detailSim.error;
  const simPending = rowSim.pending || detailSim.pending;

  if (rowSpecs.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-slate-500">
        No cash rows on the FX book — add currencies in the Simulator table.
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-slate-500">
        {simError
          ? `Simulation unavailable — ${simError}`
          : `Simulating ${rowSpecs.length} ${rowSpecs.length === 1 ? 'currency' : 'currencies'} on the server…`}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          CFaR · critical cash absorption
        </div>
        <div className="flex items-baseline gap-2 font-mono text-[9px] text-slate-600">
          {simError ? (
            <span
              className="rounded border border-rose-700/50 bg-rose-950/40 px-1.5 py-0.5 text-rose-300"
              title={simError}
            >
              simulation failed — showing last good numbers
            </span>
          ) : simPending ? (
            <span
              className="rounded border border-sky-700/50 bg-sky-950/40 px-1.5 py-0.5 text-sky-300"
              title="The Monte Carlo runs on the server; figures update as each scenario returns."
            >
              {rowsStale ? 'recomputing…' : 'simulating…'}
            </span>
          ) : null}
          <span>
            {Math.round(T)}m horizon · {setup.confidencePct}% · Monte Carlo cash-mismatch VaR (point-in-time, no swap-bridge)
          </span>
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
            <div className="flex flex-wrap items-end gap-1.5">
              <VolSourceControl
                setup={setup}
                onSetupChange={onSetupChange}
                rateVolCcy={selected.ccy}
              />
              <DeskStepper
                label={activeVolOpt?.label ?? 'σ₁ₘ'}
                value={sigmaMonthly * 100}
                min={MONTHLY_VOL_MIN * 100}
                max={MONTHLY_VOL_MAX * 100}
                step={0.1}
                onChange={pct => patchVolOverride(setup.volSource, pct / 100)}
                formatValue={v =>
                  `${trimNum(v)}%${activeVolIsOverridden ? '*' : ''}`
                }
                suffix="/mo"
                editable
                disabled={!onSetupChange}
                tickValues={[0, 12.5, 25, 37.5, 50]}
                tickLabels={['0', '', '25', '', '50']}
                className="w-[220px]"
                title={`Edit σ₁ₘ for the ${setup.volSource} source (0–${MONTHLY_VOL_MAX * 100}% per month). Set 0 to switch FX vol off — the structural gap then costs nothing and only size and timing move CFaR.`}
                ariaLabel={`${setup.volSource} monthly volatility`}
                headerExtra={
                  onSetupChange ? (
                    <button
                      type="button"
                      onClick={() => resetVolOverride(setup.volSource)}
                      disabled={!activeVolIsOverridden}
                      title={`Restore the desk preset (${(
                        (activeVolOpt?.monthlyVol ?? 0) * 100
                      ).toFixed(1)}%)`}
                      className="rounded px-1.5 py-0.5 font-mono text-[9px] text-slate-500 transition-colors hover:text-emerald-300 disabled:cursor-default disabled:opacity-30 disabled:hover:text-slate-500"
                    >
                      reset
                    </button>
                  ) : undefined
                }
              />
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
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div className="rounded border border-yellow-700/40 bg-yellow-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-yellow-400/80">
            Net CFaR · {setup.confidencePct}%
          </div>
          <div className="font-mono text-sm font-semibold text-yellow-200">
            {fmtK(totals.netCashUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-yellow-200/70">
            USD to reserve to survive every moment · $0 = carry covers it
          </div>
        </div>
        <div className="rounded border border-sky-700/40 bg-sky-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-sky-400/80">
            Peak bridge funding · {setup.confidencePct}%
          </div>
          <div className="font-mono text-sm font-semibold text-sky-200">
            {fmtK(totals.bridgeFundingUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-sky-200/70">
            facility to size, principal included ·{' '}
            {fmtK(totals.planBridgeFundingUsdM)} of it planned
          </div>
        </div>
        <div className="rounded border border-fuchsia-700/40 bg-fuchsia-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-fuchsia-400/80">
            Unplanned USD funding · {setup.confidencePct}%
          </div>
          <div className="font-mono text-sm font-semibold text-fuchsia-200">
            {fmtK(totals.unplannedFundingUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-fuchsia-200/70">
            USD to move to hold fact on plan · survives σ=0
          </div>
        </div>
        <div className="rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-amber-400/80">Gross CFaR</div>
          <div className="font-mono text-sm font-semibold text-amber-200">
            {fmtK(totals.grossCashUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-amber-200/70">
            drawdown alone · before carry · the ceiling on Net
          </div>
        </div>
        <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-emerald-400/80">
            Carry {carryOffsetUsdM >= 0 ? 'earned' : 'paid'}
          </div>
          <div
            className={`font-mono text-sm font-semibold ${
              carryOffsetUsdM >= 0 ? 'text-emerald-200' : 'text-rose-300'
            }`}
          >
            {fmtSignedK(carryOffsetUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-emerald-200/60">
            {carryOffsetUsdM >= 0
              ? 'Cash Carry · All CCY Σ · reduces the reserve'
              : 'Cash Carry · All CCY Σ · a cost, but not a risk reserve'}
          </div>
        </div>
        <div className="rounded border border-blue-700/40 bg-blue-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-blue-400/80">
            Sim carry · mean ± std
          </div>
          <div className="font-mono text-sm font-semibold text-blue-200">
            {fmtSignedK(totals.mismatchCarryMeanUsdM)}
            <span className="mx-1 text-slate-600">±</span>
            {fmtK(totals.mismatchCarryStdUsdM)}
          </div>
          <div className="mt-0.5 text-[9px] text-blue-200/60">
            hedge points + ledger interest · ± is the buffer at risk (Σ)
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
              Net CFaR is the USD cash to RESERVE: set it aside up front and
              the book survives every moment to date at this confidence. Each
              path nets its own carry against its own drawdown at each
              instant, takes the running max of that, and the percentile is
              taken across paths — so $0 means carry stayed ahead throughout
              and nothing needs setting aside. Two pairings matter. In TIME,
              because carry accrues gradually while a drawdown lands whenever
              it likes: a book three months in may hold $8K of carry against a
              $309K excursion. Across PATHS, because carry is itself
              stochastic — balances, the random-walked rate differential and
              the borrow spread all vary — so the percentile lands where the
              drawdown was bad AND the buffer underdelivered, rather than
              pinning a bad drawdown against average carry. Only booked
              forward points are deterministic, as they should be. CARRY IS
              FLOORED AT ZERO, so it can only ever reduce this and never
              exceed Gross CFaR. A book short a higher-rate currency PAYS to
              hold the position, but that cost is known at trade time and has
              zero variance, so charging it as a &ldquo;95% reserve&rdquo; would
              be a category error — it is P&amp;L, and it is reported in the Sim
              carry column instead. All CCY is an undiversified sum. Funding
              gap is the zero-vol notional
              g(t)=e−H_settled and sits outside this entirely — financed from
              the liquidity buffer, not charged as a cost here.
            </p>
          </InfoTip>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-left text-xs">
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
                  title="Gross critical cash — the drawdown alone, before carry"
                >
                  Gross CFaR
                </th>
                <th
                  className="py-2 pr-3 font-medium text-emerald-300/80"
                  title="Same Total carry as Cash Carry for this CCY (All CCY Σ = the Carry card). Negative means the book pays to hold the position, which ADDS to the reserve."
                >
                  Carry
                </th>
                <th
                  className="py-2 pr-3 font-medium text-blue-300/80"
                  title="Total carry the simulation itself banks, mean ± std across paths: the deterministic hedge points above PLUS this path's own interest on both accounts, at the borrow rate wherever one is overdrawn. The ± is the part that is genuinely uncertain, and it is the buffer Net CFaR is measured against."
                >
                  Sim carry ± σ
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
                  className="py-2 pr-3 font-medium text-sky-300/90"
                  title="Peak bridge funding — the largest overdraft this book ever runs, principal included, at the setup confidence. A LIQUIDITY number, not a cost: a receivable that is merely late costs ~nothing but still has to be funded while you wait. The smaller figure beneath is the plan's own peak, which is deterministic, so the difference is the part actually at risk."
                >
                  Bridge fund
                </th>
                <th
                  className="py-2 pr-3 font-medium text-fuchsia-300/80"
                  title="Unplanned USD funding — the USD you never budgeted for, to bring fact back onto plan: (USD_plan − USD_fact) + (FCY_plan − FCY_fact)·S(t), running max, at the setup confidence. Unlike CFaR it SURVIVES zero FX vol, because a forecast miss still leaves currency to buy; and hedging does not cure it, because a forward locks the rate on the gap but does not conjure the revenue."
                >
                  Unplanned USD
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
                    <td
                      className={`py-2 pr-3 font-mono ${
                        r.bands.carryMeanUsdM >= 0
                          ? 'text-blue-200/90'
                          : 'text-rose-300'
                      }`}
                    >
                      {fmtSignedK(r.bands.carryMeanUsdM)}
                      <span className="ml-1 text-[9px] text-blue-300/60">
                        ±{fmtK(r.bands.carryStdUsdM)}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono font-semibold text-yellow-200">
                      {fmtK(r.bands.netCriticalCashUsdM)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-slate-400">
                      M{r.bands.peakMonth.toFixed(r.bands.peakMonth < 10 ? 1 : 0)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-sky-200">
                      {fmtK(r.bands.peakBridgeFundingUsdM)}
                      <span
                        className="ml-1 text-[9px] text-sky-300/60"
                        title="The plan's own peak overdraft — deterministic, so only the excess is at risk"
                      >
                        {fmtK(r.bands.planPeakBridgeFundingUsdM)} plan
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-fuchsia-200/90">
                      {fmtK(r.bands.peakUnplannedUsdFundingUsdM)}
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
                  <td
                    className={`py-2 pr-3 font-mono ${
                      totals.mismatchCarryMeanUsdM >= 0
                        ? 'text-blue-200/90'
                        : 'text-rose-300'
                    }`}
                  >
                    {fmtSignedK(totals.mismatchCarryMeanUsdM)}
                    <span
                      className="ml-1 text-[9px] text-blue-300/60"
                      title="Standard deviations added, not combined in quadrature — an undiversified sum, consistent with every other All CCY total here"
                    >
                      ±{fmtK(totals.mismatchCarryStdUsdM)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono font-semibold text-yellow-200">
                    {fmtK(totals.netCashUsdM)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-500">—</td>
                  <td className="py-2 pr-3 font-mono text-sky-200">
                    {fmtK(totals.bridgeFundingUsdM)}
                    <span className="ml-1 text-[9px] text-sky-300/60">
                      {fmtK(totals.planBridgeFundingUsdM)} plan
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-fuchsia-200/90">
                    {fmtK(totals.unplannedFundingUsdM)}
                  </td>
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

          {/* What-if: review (chips + read-only legs) by default; gear = edit tick trades.
              Legs −/+ always available in both modes. */}
          <div className="mb-2 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                  What-if hedge · tick trades
                </div>
                <InfoTip label="What-if hedge">
                  <p>
                    Review mode shows Cover / Legs / Carry chips and a read-only
                    strip table. Legs −/+ always redistribute. Amber gear opens
                    Settle · Notional editing. Reset restores Applied legs.
                  </p>
                </InfoTip>
              </div>
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
                <span className="text-[9px] text-slate-600">|</span>
                <button
                  type="button"
                  title={
                    whatIfScheduleOpen
                      ? 'Close schedule edit — back to review table'
                      : 'Edit Settle · Notional per leg'
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

            {!whatIfScheduleOpen && whatIf && (
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
                      <span className={chip} title="What-if dealt notional">
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
                      <span className={chip} title="What-if Total carry @ Tf">
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
                      <span className={chip} title="Do-nothing income @ Tf">
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
                      <span className={chip} title="Benefit = Total − Do nothing">
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

            {whatIfScheduleOpen ? (
              <div className="mb-1.5 rounded border border-amber-500/25 bg-slate-950/70 p-1.5">
                <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200/90">
                  Edit · Settle · Notional · Carry
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
                          className="py-1 pr-3 font-medium"
                          title="Hedged path carry (FWD + FCY int + USD int)"
                        >
                          Carry
                        </th>
                        <th
                          className="py-1 font-medium"
                          title="Enhancement vs do-nothing on this leg notional (Carry − DN)"
                        >
                          Enhancement
                        </th>
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
                      })().map(({ row, cum }) => {
                        const m = row.on
                          ? whatIfLegMetricsById.get(row.id)
                          : undefined;
                        return (
                        <tr key={row.id} className="border-b border-slate-900/80">
                          <td className="py-1 pr-2">
                            <input
                              type="checkbox"
                              checked={row.on}
                              onChange={e =>
                                updateWhatIfLeg(row.id, {
                                  on: e.target.checked,
                                })
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
                          {m ? (
                            <CarryCell
                              totalUsdM={m.carryUsdM}
                              fwdCarryUsdM={m.fwdCarryUsdM}
                              fcyInterestUsdM={m.fcyInterestUsdM}
                              usdInterestUsdM={m.usdInterestUsdM}
                            />
                          ) : (
                            <td className="py-1 pr-3 font-mono text-slate-600">—</td>
                          )}
                          <td
                            className={`py-1 font-mono ${
                              !m
                                ? 'text-slate-600'
                                : m.enhancementUsdM >= 0
                                  ? 'text-emerald-200'
                                  : 'text-rose-300'
                            }`}
                            title={
                              m
                                ? `Enhancement ${fmtCarryK(m.enhancementUsdM)} = Carry ${fmtCarryK(m.carryUsdM)} − Do nothing ${fmtCarryK(m.doNothingUsdM)}`
                                : undefined
                            }
                          >
                            {m ? (
                              <span className="inline-flex flex-col leading-tight">
                                <span className="font-semibold">
                                  {fmtCarryK(m.enhancementUsdM)}
                                </span>
                                <span className="text-[8px] font-normal text-slate-500">
                                  vs DN {fmtCarryK(m.doNothingUsdM)}
                                </span>
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-[10px]">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-500">
                      <th className="py-1 pr-3 font-medium">Leg</th>
                      <th className="py-1 pr-3 font-medium">Settle</th>
                      <th className="py-1 pr-3 font-medium">Trade Δ</th>
                      <th className="py-1 pr-3 font-medium">Cumul. cover</th>
                      <th
                        className="py-1 pr-3 font-medium"
                        title="Hedged path carry (FWD + FCY int + USD int)"
                      >
                        Carry
                      </th>
                      <th
                        className="py-1 font-medium"
                        title="Enhancement vs do-nothing on this leg notional (Carry − DN)"
                      >
                        Enhancement
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let cum = 0;
                      let i = 0;
                      return [...whatIfLegs]
                        .sort((a, b) => a.settleMonths - b.settleMonths)
                        .filter(row => row.on)
                        .map(row => {
                          i += 1;
                          cum += row.amountLocalM;
                          return {
                            row,
                            cum,
                            i,
                            m: whatIfLegMetricsById.get(row.id),
                          };
                        });
                    })().map(({ row, cum, i, m }) => (
                      <tr
                        key={row.id}
                        className="border-b border-slate-900/80 font-mono text-slate-300"
                      >
                        <td className="py-1 pr-3">L{i}</td>
                        <td className="py-1 pr-3">
                          M
                          {row.settleMonths.toFixed(
                            row.settleMonths < 10 ? 1 : 0,
                          )}
                        </td>
                        <td className="py-1 pr-3">
                          {fmtM(row.amountLocalM)}
                        </td>
                        <td className="py-1 pr-3">{fmtM(cum)}</td>
                        {m ? (
                          <CarryCell
                            totalUsdM={m.carryUsdM}
                            fwdCarryUsdM={m.fwdCarryUsdM}
                            fcyInterestUsdM={m.fcyInterestUsdM}
                            usdInterestUsdM={m.usdInterestUsdM}
                          />
                        ) : (
                          <td className="py-1 pr-3 text-slate-600">—</td>
                        )}
                        <td
                          className={`py-1 ${
                            !m
                              ? 'text-slate-600'
                              : m.enhancementUsdM >= 0
                                ? 'text-emerald-200'
                                : 'text-rose-300'
                          }`}
                          title={
                            m
                              ? `Enhancement ${fmtCarryK(m.enhancementUsdM)} = Carry ${fmtCarryK(m.carryUsdM)} − Do nothing ${fmtCarryK(m.doNothingUsdM)}`
                              : undefined
                          }
                        >
                          {m ? (
                            <span className="inline-flex flex-col leading-tight">
                              <span className="font-semibold">
                                {fmtCarryK(m.enhancementUsdM)}
                              </span>
                              <span className="text-[8px] font-normal text-slate-500">
                                vs DN {fmtCarryK(m.doNothingUsdM)}
                              </span>
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mb-2 mt-1.5 text-[9px] leading-relaxed text-slate-500">
              Seeded from the {selected.ccy} hedge applied above (
              {appliedDetail?.source ?? 'none'}). Use Legs −/+ any time; open
              the gear to edit Settle / Notional per leg.
            </p>
            {whatIf ? (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <WhatIfDeltaRow
                  label="Net CFaR"
                  current={selected.bands.netCriticalCashUsdM}
                  proposed={whatIf.bands.netCriticalCashUsdM}
                  fmt={fmtK}
                  lowerIsBetter
                  note="USD to reserve to survive every moment at this confidence, each path netting its own stochastic carry. More/better-spaced legs shrink the mismatch — this should fall, and reads $0 once carry covers every excursion."
                />
                <WhatIfDeltaRow
                  label="Gross CFaR"
                  current={selected.bands.criticalCashUsdM}
                  proposed={whatIf.bands.criticalCashUsdM}
                  fmt={fmtK}
                  lowerIsBetter
                  note="The drawdown on its own, before carry. Net sits below this when the book earns carry and above it when the book pays."
                />
                <WhatIfDeltaRow
                  label="Sim carry"
                  current={selected.bands.carryMeanUsdM}
                  proposed={whatIf.bands.carryMeanUsdM}
                  fmt={fmtSignedK}
                  lowerIsBetter={false}
                  note="Mean total carry the simulation banks — the hedge's forward points plus the ledger's own interest on both accounts. This is the buffer Net CFaR is measured against."
                />
                <WhatIfDeltaRow
                  label="Funding gap"
                  current={selected.fundingGap?.maxGapUsdM ?? 0}
                  proposed={whatIf.fundingGap?.maxGapUsdM ?? 0}
                  fmt={fmtK}
                  lowerIsBetter
                  note="Deterministic settlement residual floor."
                />
                <WhatIfDeltaRow
                  label="Carry"
                  current={selected.totalCarryUsdM}
                  proposed={whatIf.totalCarryUsdM}
                  fmt={fmtCarryK}
                  lowerIsBetter={false}
                  note="Total carry @ Tf — same as Cash Carry Total."
                />
                <WhatIfDeltaRow
                  label="Do nothing"
                  current={selected.doNothingUsdM}
                  proposed={whatIf.doNothingUsdM}
                  fmt={fmtCarryK}
                  lowerIsBetter={false}
                  note="Unhedged income @ Tf."
                />
                <WhatIfDeltaRow
                  label="Δ Benefit"
                  current={selected.benefitUsdM}
                  proposed={whatIf.benefitUsdM}
                  fmt={fmtCarryK}
                  lowerIsBetter={false}
                  note="Total − Do nothing."
                />
                <WhatIfDeltaRow
                  label="Cover"
                  current={appliedDetail?.totalNotionalLocalM ?? 0}
                  proposed={whatIf.totalNotionalLocalM}
                  fmt={fmtM}
                  lowerIsBetter={false}
                  note="Total dealt notional (local M)."
                />
              </div>
            ) : (
              <p className="text-[9px] text-slate-500">
                No legs ticked On — open the gear and turn a leg on to see
                impact.
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
          />

          <CfarDecompositionCharts
            components={(whatIf?.bands ?? selected.bands).components}
          />

          {frontier.length > 1 && (
            <FrontierChart
              points={frontier}
              applied={frontierApplied}
              legCount={appliedLegCount}
            />
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Decomposition: the three drivers behind the main CFaR curve, each plotted
 * on its own — computed independently at every point, none of them
 * running-maxed, so their actual (non-monotonic) behavior is visible. The
 * main chart's curve is the running-max of "raw risk" netted against
 * "carry"; this shows what those two — plus the mismatch that drives raw
 * risk — are doing underneath, at exactly the same t values.
 */
function CfarDecompositionCharts({
  components,
}: {
  components: McCfarComponentPoint[];
}) {
  if (components.length < 2) return null;
  const W = 560;
  const H = 110;
  const padL = 52;
  const padR = 16;
  const padT = 10;
  const padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const T = components[components.length - 1]!.t || 1;
  const x = (t: number) => padL + (t / T) * plotW;
  const lastM = Math.max(1, Math.round(T));
  const monthTicks: number[] = [];
  for (let m = 0; m <= lastM; m += 2) monthTicks.push(m);

  function MiniChart({
    title,
    desc,
    unit,
    color,
    mean,
    lo,
    hi,
    fmt,
  }: {
    title: string;
    desc: string;
    unit: string;
    color: string;
    mean: readonly number[];
    lo?: readonly number[];
    hi?: readonly number[];
    fmt: (v: number) => string;
  }) {
    let dataMax = 0;
    let dataMin = 0;
    for (let i = 0; i < mean.length; i += 1) {
      dataMax = Math.max(dataMax, mean[i]!, hi?.[i] ?? mean[i]!);
      dataMin = Math.min(dataMin, mean[i]!, lo?.[i] ?? mean[i]!);
    }
    const span = dataMax - dataMin || 1;
    const pad = span * 0.15;
    const yMax = dataMax + pad;
    const yMin = dataMin - pad;
    const y = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * plotH;
    const pts = (vals: readonly number[]): SplinePt[] =>
      components.map((c, i) => [x(c.t), y(vals[i]!)] as SplinePt);
    const line = (vals: readonly number[]) => splinePath(pts(vals));
    const band = lo && hi ? splineBand(pts(hi), pts(lo)) : null;
    const y0 = y(0);
    const last = mean[mean.length - 1]!;
    return (
      <div className="mb-2">
        <div className="mb-0.5 flex items-baseline justify-between gap-2">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
            {title}
          </span>
          <span className="whitespace-nowrap text-[9px] text-slate-500">
            now {fmt(last)} {unit}
          </span>
        </div>
        <p className="mb-0.5 text-[8.5px] leading-snug text-slate-500">{desc}</p>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full max-w-full rounded border border-slate-800 bg-slate-950"
          preserveAspectRatio="xMidYMid meet"
        >
          {monthTicks.map(m => (
            <line
              key={m}
              x1={x(m)}
              x2={x(m)}
              y1={padT}
              y2={H - padB}
              stroke={m === 0 || m === lastM ? '#334155' : '#1a2436'}
            />
          ))}
          <line x1={padL} y1={y0} x2={W - padR} y2={y0} stroke="#475569" strokeWidth={1} />
          {band && <path d={band} fill={color} opacity={0.28} />}
          {lo && (
            <path
              d={line(lo)}
              fill="none"
              stroke={color}
              strokeWidth={0.75}
              strokeDasharray="2 2"
              opacity={0.7}
            />
          )}
          {hi && (
            <path
              d={line(hi)}
              fill="none"
              stroke={color}
              strokeWidth={0.75}
              strokeDasharray="2 2"
              opacity={0.7}
            />
          )}
          <path
            d={line(mean)}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <text x={padL - 4} y={padT + 6} textAnchor="end" fontSize={7.5} fill="#64748b">
            {fmt(dataMax)}
          </text>
          {Math.abs(y0 - padT) > 12 && Math.abs(y0 - (H - padB)) > 12 && (
            <text x={padL - 4} y={y0 + 3} textAnchor="end" fontSize={7.5} fill="#64748b">
              0
            </text>
          )}
          <text x={padL - 4} y={H - padB} textAnchor="end" fontSize={7.5} fill="#64748b">
            {fmt(dataMin)}
          </text>
        </svg>
      </div>
    );
  }

  const structuralMean = components.map(c => c.structuralGapLocalM);
  const timingMean = components.map(c => c.timingMismatchLocalM);
  const timingLo = components.map(c => c.timingMismatchP05);
  const timingHi = components.map(c => c.timingMismatchP95);
  const sizeMean = components.map(c => c.sizeMismatchLocalM);
  const sizeLo = components.map(c => c.sizeMismatchP05);
  const sizeHi = components.map(c => c.sizeMismatchP95);
  const mismatchMean = components.map(c => c.mismatchLocalM);
  const mismatchLo = components.map(c => c.mismatchP05);
  const mismatchHi = components.map(c => c.mismatchP95);
  const rawGrossK = components.map(c => c.rawGrossUsdM * 1000);
  const structuralFxRiskK = components.map(c => c.structuralFxRiskUsdM * 1000);
  const sizeFxRiskK = components.map(c => c.sizeFxRiskUsdM * 1000);
  const timingFxRiskK = components.map(c => c.timingFxRiskUsdM * 1000);
  const reserveK = components.map(c => c.reserveUsdM * 1000);
  const squaringK = components.map(c => c.squaringCostUsdM * 1000);
  const squaringHiK = components.map(c => c.squaringCostP95UsdM * 1000);
  const bridgeK = components.map(c => c.bridgeNeedUsdM * 1000);
  const planBridgeK = components.map(c => c.planBridgeNeedUsdM * 1000);
  const unplannedK = components.map(c => c.unplannedUsdFundingUsdM * 1000);
  // carryMeanUsdM already carries the deterministic hedge schedule — the
  // engine is given it as hedgeCarryScheduleUsdM so the net line can be
  // measured against the same buffer — so only the std band is added here.
  const carryMeanK = components.map(c => c.carryMeanUsdM * 1000);
  const carryLoK = components.map(c => (c.carryMeanUsdM - c.carryStdUsdM) * 1000);
  const carryHiK = components.map(c => (c.carryMeanUsdM + c.carryStdUsdM) * 1000);

  return (
    <div className="mt-3 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
        Decomposition · each driver computed separately, not running-maxed
      </div>
      <MiniChart
        title="Structural liquidity gap — the PLAN ledger's own FCY balance"
        desc="Fully deterministic SIZE (single line, no band) — the settlement schedule vs. the (correctly-forecast) accrual pattern, including the intra-month outflow-before-inflow sawtooth. A 100%-planned, known cash-timing fact — its LCY size is never treated as uncertain (no p05/p95 here, unlike ① and ②). It is NOT excluded from CFaR though: holding this known gap open still means it is converted at whatever spot the path delivers — see ④ below, which is the dollar impact it generates."
        unit="local M"
        color="#94a3b8"
        mean={structuralMean}
        fmt={v => v.toFixed(2)}
      />
      <MiniChart
        title="① Timing risk — jittered flow and settlement DATES (ledger C − B)"
        desc="Stochastic. Two date effects together: customers paying late or payment runs slipping (flowJitterDays, default 5), and settlement never landing exactly on the planned date — bank cutoffs, holidays, counterparty processing (settlementJitterDays, default 2). Shaded = p05–p95 across paths. Amounts are held at their realized values here, so this isolates WHEN cash moves from HOW MUCH moves."
        unit="local M"
        color="#a78bfa"
        mean={timingMean}
        lo={timingLo}
        hi={timingHi}
        fmt={v => v.toFixed(2)}
      />
      <MiniChart
        title="② Size mismatch — realized flow AMOUNTS vs forecast (ledger B − A)"
        desc="Stochastic — the extra gap purely from actual flows differing from plan, with dates held on the forecast calendar. Independent of hedge structure entirely: a bullet and a 20-leg strip have the identical size-mismatch distribution for the same total notional. Driven only by forecast uncertainty (u₁ₘ)."
        unit="local M"
        color="#f472b6"
        mean={sizeMean}
        lo={sizeLo}
        hi={sizeHi}
        fmt={v => v.toFixed(2)}
      />
      <MiniChart
        title="③ Total FCY balance = structural + ① + ② (ledger C)"
        desc="What is actually sitting in the currency account after operating flows and hedge deliveries. The three parts are NESTED counterfactuals, not independent factors, so they sum to this exactly at every point — no RSS and no independence assumption. Shaded = p05–p95 across simulated paths (structural itself has no band, so the width comes entirely from ① and ②)."
        unit="local M"
        color="#38bdf8"
        mean={mismatchMean}
        lo={mismatchLo}
        hi={mismatchHi}
        fmt={v => v.toFixed(2)}
      />
      <MiniChart
        title="④ Structural USD impact — revaluation only, zero at σ=0"
        desc="The structural gap is a planned SIZE, not a risk in itself, so it is never charged for merely being large. Its only route into CFaR is that the rate the known balance is eventually valued at is uncertain. Ledger A runs the FORECAST flows on their FORECAST dates against the planned settlement schedule and differs from the plan ONLY in the simulated spot path — so this line is identically zero when FX vol is zero, however big the gap, and scales up with σ from there. Percentiled across paths at the setup confidence."
        unit="$K"
        color="#94a3b8"
        mean={structuralFxRiskK}
        fmt={v => Math.round(v).toString()}
      />
      <MiniChart
        title="⑤ Size USD impact — ledger A vs ledger B · needs a settlement to bite"
        desc="EXPECT ZEROS, AND READ THEM DELIBERATELY. On an UNHEDGED book this is $0 for the whole horizon at ANY forecast error: move uncertainty from 0% to 60% and gross CFaR does not shift by a dollar, because the extra or missing currency is credited back at the same live rate that revalues it and the two cancel exactly, on every path, at every instant. On a hedged book it is $0 until the first delivery and modest after it. That is the cost-only rule working as chosen, not a dead chart. What it charges is the UNWIND, not the missing revenue: a shortfall against a hedge is bought back at spot to honour delivery (see ⑩), so you pay the gap between that rate and the one you sold at, and the principal is not a treasury loss. Hence it is also ~0 at σ=0, since you buy back at exactly the rate you hedged. Currency you merely have more or less of, and have NOT sold, is worth what it is worth — there is no rate to have been wrong about. The forecast miss is real and still measured: see the local-currency mismatch charts and Unplanned USD funding, which is the metric that does respond to forecast quality. It simply has no CASH cost until it meets a delivery obligation."
        unit="$K"
        color="#f472b6"
        mean={sizeFxRiskK}
        fmt={v => Math.round(v).toString()}
      />
      <MiniChart
        title="⑥ Timing USD impact — ledger B vs ledger C · spikes at settlements, zero between"
        desc="EXPECT A SPIKE AT EACH SETTLEMENT AND $0 EITHER SIDE OF IT — that shape is the answer, not a glitch. A spike is the leg's mark-to-market, notional × (strike − spot), over the window where one ledger has settled and the jittered one has not; it is the only moment the two books differ. It falls back to zero afterwards because a forward pays CONTRACTUAL amounts at a CONTRACTUAL strike, so once both ledgers have delivered they hold identical positions and settling two days apart leaves no trace outside the interest. Before the first settlement, and for the whole horizon on an UNHEDGED book, this is flat $0 however late the flows run: a date shift only changes WHEN currency you still hold arrived, and the principal credit cancels it exactly, so there is no rate to have been wrong about. What it does charge is the FX move across a genuine conversion gap plus the borrow rate over any window the shift leaves an account overdrawn. A late receivable is never charged its face value — it is delayed, not lost. On an unhedged book the entire drawdown is revaluation and lands in ④; for the displacement itself rather than its cost, read the local-currency mismatch charts above."
        unit="$K"
        color="#a78bfa"
        mean={timingFxRiskK}
        fmt={v => Math.round(v).toString()}
      />
      <MiniChart
        title="⑦ Raw gross shortfall vs plan — the whole, before running-max"
        desc="The point-in-time USD shortfall of the realized ledger against the plan ledger, interest accrual off. Unlike ⑤ and ⑥ this does NOT wait for a settlement — it is live from the first month on any book carrying an FCY position, because ④ alone drives it until something converts. DO NOT expect ④+⑤+⑥ to equal this line. The three are nested counterfactuals, so they telescope to it exactly PATH BY PATH — but each is percentiled separately, and the path that is worst for timing is not the path that is worst for FX, so adding the three plotted lines overstates the whole — by more than 20% at the end of a typical hedged book. Read ④/⑤/⑥ for which driver dominates and how that ranking shifts over the horizon; read this line, never the sum, for the size. This is 'how far behind plan am I right now'; the main chart's amber curve is its running max."
        unit="$K"
        color="#fb923c"
        mean={rawGrossK}
        fmt={v => Math.round(v).toString()}
      />
      <MiniChart
        title="⑧ Total carry — the buffer, mean and its own spread"
        desc="The dominant trend is the REAL forward-points carry on the full hedge notional (0 at T0, growing toward the target by Tf) — the same number as the Carry column, and the one genuinely deterministic piece, since a booked forward's points are contractual. The band around it is what is NOT deterministic: the ledger's accrued interest on both accounts, at the BORROW rate wherever a balance is overdrawn, with the rate differential random-walked across the horizon. That spread is why the reserve nets carry per path rather than against this mean — the width of this band is buffer that may not show up."
        unit="$K"
        color="#34d399"
        mean={carryMeanK}
        lo={carryLoK}
        hi={carryHiK}
        fmt={v => Math.round(v).toString()}
      />
      <MiniChart
        title="⑨ USD reserve — the ratchet behind the headline Net CFaR"
        desc="The main chart's yellow line is where the book STANDS; this is what it had to HAVE. Same per-path netting — each path's own carry against its own drawdown at each instant, never ⑧ minus ⑦, which would pin an adverse drawdown against average carry and understate it — but here the uncovered part is floored at zero and running-maxed before percentiling. So it only ever climbs, and its last value is the headline Net CFaR. Flat at $0 means carry stayed ahead the whole way and no cash ever had to be set aside. Read the main chart to see where you ended up; read this to size the facility."
        unit="$K"
        color="#facc15"
        mean={reserveK}
        fmt={v => Math.round(v).toString()}
      />
      <MiniChart
        title="⑩ Forced FCY purchase cost — cumulative, mean and p95"
        desc="Cash actually paid to buy FCY at spot when the currency account was short of the notional a leg had to deliver. This is the over-hedge crystallization the previous parametric engine could not express: it is realized and permanent, not a mark that reverses on the next grid point, and it is why over-hedging and under-hedging are no longer symmetric. Rises in steps at settlements and never falls. Shaded to p95."
        unit="$K"
        color="#f87171"
        mean={squaringK}
        hi={squaringHiK}
        lo={squaringK}
        fmt={v => Math.round(v).toString()}
      />
      <MiniChart
        title="⑪ Peak bridge funding — liquidity, not cost"
        desc="The other side of the coin from every chart above. CFaR charges a late receivable only what the delay COSTS, because the money does arrive — but you still have to fund the wait, and this is that hole: max(0, −USD balance) + max(0, −FCY balance)·S(t), running max, at the setup confidence. Principal INCLUDED here, which is exactly why it is kept out of CFaR. Shaded band is the at-risk portion; the lower line is the plan's own funding need, which you owe whatever happens. A hedge strip that matches the accrual is self-funding — settlement proceeds land in USD before the outflows draw on them — so this stays flat at zero until delays get long enough to outrun that buffer."
        unit="$K"
        color="#38bdf8"
        mean={bridgeK}
        hi={bridgeK}
        lo={planBridgeK}
        fmt={v => Math.round(v).toString()}
      />
      <MiniChart
        title="⑫ Unplanned USD funding — the gap itself, not its cost"
        desc="The USD the desk has to move that it never budgeted for, to bring fact back onto plan: (USD_plan − USD_fact) + (FCY_plan − FCY_fact)·S(t), running max, at the setup confidence. That is exactly the CFaR drawdown BEFORE the displaced principal is netted out of it, so the two are complements on one gap — CFaR says what a mismatch COSTS, this says what it takes to CARRY. Measured against plan rather than against zero, so a payer book's planned overdraft is excluded and only the deviation counts. Two things make it behave unlike every cost chart above. It SURVIVES σ=0: a forecast miss still leaves currency to buy, and zero vol only means you know the price up front. And hedging does not cure it — a forward locks the rate on the gap, it does not conjure the revenue the forecast promised, so a hedged book with a loose forecast can run a small CFaR and a large funding need at the same time."
        unit="$K"
        color="#e879f9"
        mean={unplannedK}
        hi={unplannedK}
        lo={unplannedK}
        fmt={v => Math.round(v).toString()}
      />
    </div>
  );
}

/**
 * Tick values covering [min, max], stepped 1/2/5×10ⁿ so the labels read as
 * round money instead of as arbitrary fractions of whatever range the sweep
 * happened to produce. Snaps a near-zero tick to exactly zero, which matters
 * on the carry axis: it is signed, and "$0" is the line between being paid to
 * hedge and paying for it.
 */
function axisTicks(min: number, max: number, target: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const rough = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return out;
}

/**
 * Efficient frontier: gross CFaR against carry as COVER varies, leg spacing
 * held at the applied hedge's.
 *
 * Both axes are independent by construction — see {@link FrontierPoint} for
 * why the risk axis cannot be Net CFaR, and why cover is the dial rather than
 * leg count. Net is still the criterion the desk optimises, and on these axes
 * it is a diagonal: net = gross − carry, so lines of equal reserve run at 45°
 * in data space and the best structure is the one the lowest such line
 * touches. That point is marked rather than left to be eyeballed.
 */
function FrontierChart({
  points,
  applied,
  legCount,
}: {
  points: FrontierPoint[];
  applied: FrontierPoint | null;
  legCount: number;
}) {
  const W = 560;
  const H = 210;
  const padL = 60;
  const padR = 22;
  const padT = 16;
  const padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const drawn = applied ? [...points, applied] : points;
  const allCarry = drawn.map(p => p.carryUsdM);
  const allCfar = drawn.map(p => p.grossCfarUsdM);
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
  const xTicks = axisTicks(xMin, xMax, 5);
  const yTicks = axisTicks(0, yMax, 6);
  const efficient = efficientFrontier(points);
  const onFrontier = new Set(efficient);
  // Splined, and safe to spline: the efficient set comes back sorted by carry
  // and rises in both coordinates, so x is monotone and the Fritsch–Carlson
  // clamp cannot bulge the curve past a structure the sweep actually priced.
  const frontierPath = splinePath(
    efficient.map(p => [x(p.carryUsdM), y(p.grossCfarUsdM)] as SplinePt),
  );
  const x0 = x(0);
  const best = lowestReservePoint(efficient);
  const pct = (p: FrontierPoint) => `${Math.round(p.coverRatio * 100)}%`;
  const degenerate = isDegenerateFrontier(points, efficient);
  return (
    <div className="mt-3 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">
            Efficient frontier · Gross CFaR vs Carry
          </span>
          <InfoTip label="Efficient frontier">
            <p>
              Each point scales the applied notional to a cover level, spreads
              it across the same {legCount} evenly-spaced leg
              {legCount === 1 ? '' : 's'}, and re-runs the full carry + CFaR
              pipeline — all against the same random draws, so the difference
              between two points is the structure and not the sample.
            </p>
            <p className="mt-1">
              Cover is the dial, not leg count. Leg count trades nothing off:
              settling earlier closes the mismatch AND converts into the
              higher-yielding currency sooner, so more legs win on both counts
              and everything else is dominated. Cover is two-sided — risk falls
              to a minimum near full cover and climbs again beyond it, where
              the over-hedge is an exposure of its own, while carry keeps
              rising with notional.
            </p>
            <p className="mt-1">
              The risk axis is GROSS CFaR, before carry. Net CFaR would put
              carry on both axes — it is the drawdown already less the carry —
              and a structure would appear to buy down risk with carry it had
              just been paid for on the x-axis. Net is still what you minimise,
              and here it is a diagonal: net = gross − carry, so equal-reserve
              lines run at 45° and the best cover is the one the lowest such
              line touches. That is the filled amber dot
              {best ? ` (${pct(best)} cover, net ${fmtK(best.netCfarUsdM)})` : ''}.
            </p>
            <p className="mt-1">
              Hollow dots are efficient but not optimal. Grey dots are
              DOMINATED — some other cover level gives at least as much carry
              for no more risk — so the curve skips them. On a currency that
              earns carry that is the whole under-hedged branch, since covering
              more buys less risk and more carry at once. The amber ring is the
              hedge actually applied, priced on this same basis; its legs are
              wherever they were dealt rather than evenly spaced, so it can sit
              inside the curve.
            </p>
          </InfoTip>
        </div>
        <span className="text-[9px] text-slate-500">
          cover {pct(points[0]!)}–{pct(points[points.length - 1]!)} of applied ·{' '}
          {legCount} leg{legCount === 1 ? '' : 's'} · {FRONTIER_PATHS} paths, common seed
        </span>
      </div>
      {degenerate && (
        <p className="mb-1 text-[8.5px] leading-snug text-amber-300/70">
          No trade-off to walk at this leg spacing: cover barely moves risk
          across the whole sweep, so whatever slope survives dominance is
          inside the simulation&apos;s own error. Read the filled dot as the
          answer rather than as a compromise — and if these are bullets, that
          is why, since one settlement at maturity cannot touch a drawdown that
          peaks before it.
        </p>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-full rounded border border-slate-800 bg-slate-950"
        preserveAspectRatio="xMidYMid meet"
      >
        {yTicks.map(v => (
          <g key={`y${v}`}>
            <line
              x1={padL}
              y1={y(v)}
              x2={W - padR}
              y2={y(v)}
              stroke="#1e293b"
              strokeWidth={1}
            />
            <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize={8} fill="#64748b">
              {fmtK(v)}
            </text>
          </g>
        ))}
        {xTicks.map(v => (
          <g key={`x${v}`}>
            <line
              x1={x(v)}
              y1={padT}
              x2={x(v)}
              y2={H - padB}
              stroke="#1e293b"
              strokeWidth={1}
            />
            <text
              x={x(v)}
              y={H - padB + 12}
              textAnchor="middle"
              fontSize={8}
              fill="#64748b"
            >
              {fmtSignedK(v)}
            </text>
          </g>
        ))}
        {xMin < 0 && xMax > 0 && (
          <line x1={x0} y1={padT} x2={x0} y2={H - padB} stroke="#475569" strokeWidth={1} strokeDasharray="2 3" />
        )}
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#475569" strokeWidth={1} />
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#475569" strokeWidth={1} />
        <text
          x={padL + plotW / 2}
          y={H - 6}
          textAnchor="middle"
          fontSize={8}
          fill="#94a3b8"
        >
          Carry — more to the right →
        </text>
        <text
          x={12}
          y={padT + plotH / 2}
          textAnchor="middle"
          fontSize={8}
          fill="#94a3b8"
          transform={`rotate(-90 12 ${padT + plotH / 2})`}
        >
          ← safer · Gross CFaR
        </text>
        <path
          d={frontierPath}
          fill="none"
          stroke="#facc15"
          strokeWidth={1.5}
          strokeLinecap="round"
          opacity={0.75}
        />
        {points.map(p => {
          const isBest = p === best;
          const isEfficient = onFrontier.has(p);
          return (
            <g key={p.coverRatio}>
              <circle
                cx={x(p.carryUsdM)}
                cy={y(p.grossCfarUsdM)}
                r={isBest ? 4 : 2.5}
                fill={isBest ? '#facc15' : '#0b1220'}
                stroke={isEfficient ? '#facc15' : '#64748b'}
                strokeWidth={isBest ? 0 : 1.5}
              />
              <text
                x={x(p.carryUsdM)}
                y={y(p.grossCfarUsdM) - 7}
                textAnchor="middle"
                fontSize={8}
                fontWeight={isBest ? 700 : 500}
                fill={isBest ? '#fde047' : isEfficient ? '#94a3b8' : '#64748b'}
                opacity={isEfficient ? 1 : 0.55}
              >
                {pct(p)}
              </text>
            </g>
          );
        })}
        {applied && (
          <g>
            <circle
              cx={x(applied.carryUsdM)}
              cy={y(applied.grossCfarUsdM)}
              r={5.5}
              fill="none"
              stroke="#f97316"
              strokeWidth={1.5}
            />
            <circle
              cx={x(applied.carryUsdM)}
              cy={y(applied.grossCfarUsdM)}
              r={1.5}
              fill="#f97316"
            />
            <text
              x={x(applied.carryUsdM)}
              y={y(applied.grossCfarUsdM) + 15}
              textAnchor="middle"
              fontSize={8}
              fontWeight={700}
              fill="#fdba74"
            >
              applied
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
