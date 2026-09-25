'use client';

/**
 * Liquidity layer of the hedging decision: what the funded forecast path asks
 * the desk to book. Every number here comes from the same per-cycle plan that
 * sizes H* and the swap on the simulator row — near leg for the cycle in front
 * of us, the notional left outstanding once every leg has been rolled, and the
 * leg-by-leg schedule behind it: what to trade, on what value date, and which
 * legs are already sized enough to book today as forward-starting swaps.
 *
 * Cover % is the funding analog of FX hedge %: 100% takes the full proposed
 * strip (FX-neutral, remaining Δ = 0); 0% leaves the trough unfunded (Δ = 1).
 */

import { Fragment, useState } from 'react';
import { DeskStepper } from '@/components/DeskStepper';
import { ccySpotRate, fundingSwapCashDeltaUsdYr } from '@/lib/fx-buffer';
import { swapLegSchedule, type SwapLegScheduleRow } from '@/lib/forecast-profile';
import type { FcyComputedRow } from '@/lib/dashboard-model';
import type { PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import {
  BOOKING_MODE_OPTIONS,
  SIZING_BASIS_OPTIONS,
  type LiquidityBookingMode,
  type LiquiditySizingBasis,
} from '@/lib/liquidity-ladder';

const COVER_STEP_PCT = 10;
const MAX_COVER_PCT = 100;

const f2 = (v: number): string => v.toFixed(2);
const signed = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;

function fmtLocal(v: number, ccy: string): string {
  const abs = Math.abs(v).toFixed(2);
  const sign = v >= 0 ? '+' : '−';
  if (ccy === 'EUR') return `${sign}€${abs}M`;
  if (ccy === 'PLN') return `${sign}zł${abs}M`;
  if (ccy === 'GBP') return `${sign}£${abs}M`;
  return `${sign}${abs}M ${ccy}`;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

function fmtShare(v: number): string {
  return `${(Math.round(v * 10) / 10).toFixed(v % 1 ? 1 : 0)}%`;
}

export interface DecisionRow {
  ccy: string;
  /** Cash the binding cycle drains at its deepest. */
  drawdown: number;
  /** Near leg for cycle 1 — book now. */
  nearLeg: number;
  /** Swap notional outstanding at the end of the horizon: every leg, rolled. */
  endingBook: number;
  /** Deepest the outstanding book gets on the path. */
  peakBook: number;
  /** The drain repeats instead of reversing: a rolling programme, not a bridge. */
  rolling: boolean;
  /** Every leg the path asks for, with its value date and the book it rolls onto. */
  schedule: SwapLegScheduleRow[];
  /** USD the peak outstanding book consumes at spot. */
  usdFunded: number;
  /** Δr = r_USD − r_FCY: positive means the funded FCY cash costs carry. */
  deltaR: number;
  /** Annual USD cost of Δr on the average outstanding book, not on one leg. */
  costUsdYr: number;
  cycles: number;
}

function rowFromNearLeg(r: FcyComputedRow, r_USD: number, nearLeg: number, cycles: number): DecisionRow {
  const spot = ccySpotRate(r.ccy);
  const deltaR = r_USD - r.r_FCY;
  return {
    ccy: r.ccy,
    drawdown: r.cycleDrawdown ?? 0,
    nearLeg,
    endingBook: nearLeg,
    peakBook: nearLeg,
    rolling: false,
    schedule: [{
      cycleIndex: 0,
      valueDateMonths: 0,
      newLeg: nearLeg,
      rolledForward: 0,
      outstanding: nearLeg,
      preBookable: false,
    }],
    usdFunded: nearLeg * spot,
    deltaR,
    costUsdYr: -fundingSwapCashDeltaUsdYr(nearLeg, spot, r.r_FCY, r_USD, r.r_OD),
    cycles,
  };
}

function rowSwapNear(r: FcyComputedRow): number {
  const v = r.swapNear;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function peakOutstanding(book: readonly number[]): number {
  let peak = 0;
  for (const v of book) {
    if (Math.abs(v) > Math.abs(peak)) peak = v;
  }
  return peak;
}

export function decisionRowFor(r: FcyComputedRow, r_USD: number): DecisionRow | null {
  const plan = r.liquidityPlan;
  const rowSwap = rowSwapNear(r);
  // A buffer layer sizes Swap near on the Liquidity row. That is the staged
  // funding trade — show it even before a dated plan exists, and even when
  // cycle 1 of a dated plan does not happen to be the H* cycle.
  if (!plan || plan.length === 0) {
    if (Math.abs(rowSwap) <= 0.001) return null;
    return rowFromNearLeg(r, r_USD, rowSwap, 1);
  }
  const planNear = plan[0]?.swap_needed ?? 0;
  // Each cycle's leg is rolled, so the book is the running sum — a drain that
  // repeats every cycle funds at the whole horizon's burn, not at one leg.
  const book = plan.map(p => p.standing_swap);
  const endingBook = book[book.length - 1] ?? 0;
  const peakBook = peakOutstanding(book);
  const hasPlanStrip =
    book.some(v => Math.abs(v) > 0.001)
    || plan.some(p => Math.abs(p.swap_needed) > 0.001);
  if (!hasPlanStrip) {
    if (Math.abs(rowSwap) <= 0.001) return null;
    return rowFromNearLeg(r, r_USD, rowSwap, plan.length);
  }
  const firstLeg = plan.find(p => Math.abs(p.swap_needed) > 0.001)?.swap_needed ?? 0;
  const nearLeg = Math.abs(planNear) > 0.001
    ? planNear
    : Math.abs(rowSwap) > 0.001
      ? rowSwap
      : firstLeg;
  const avgBook = book.reduce((s, v) => s + v, 0) / book.length;
  const spot = ccySpotRate(r.ccy);
  const deltaR = r_USD - r.r_FCY;
  // Repeating drain: the last cycle still drains what the first one did, so the
  // funding does not unwind — the leg has to be rolled rather than run off.
  const last = plan[plan.length - 1]!;
  const rolling = plan.length > 1
    && last.drawdown > 0.001
    && last.swap_needed > 0.001;
  return {
    ccy: r.ccy,
    drawdown: r.cycleDrawdown ?? 0,
    nearLeg,
    endingBook,
    peakBook,
    rolling,
    schedule: swapLegSchedule(plan),
    usdFunded: peakBook * spot,
    deltaR,
    costUsdYr: -fundingSwapCashDeltaUsdYr(avgBook, spot, r.r_FCY, r_USD, r.r_OD),
    cycles: plan.length,
  };
}

/**
 * Exposure · hedge structuring owns the package on Hedging Decision.
 * A staged strip / bullet replaces the independent 12-cycle H* plan so Target,
 * residual, and leg count match the table above (e.g. EUR 3 staged strip at
 * +€16.30M, not a 12-leg funding H*).
 */
export function decisionRowFromPrepared(
  profile: PreparedHedgeProfile,
  r: FcyComputedRow,
  r_USD: number,
): DecisionRow | null {
  const cover = profile.coverLocalM;
  const stripLegs = profile.structure === 'strip'
    ? [...profile.legs].sort((a, b) => a.index - b.index)
    : [];
  const legs = stripLegs.length > 0
    ? stripLegs
    : [{
        index: 0,
        startMonth: 0,
        endMonth: profile.settleMonths ?? 0,
        settleMonths: profile.settleMonths,
        hedgeLocalM: cover,
        tradeNotionalLocalM: cover,
        label: 'bullet',
      }];
  if (
    Math.abs(cover) <= 0.001
    && legs.every(l => Math.abs((l.tradeNotionalLocalM ?? l.hedgeLocalM) ?? 0) <= 0.001)
  ) {
    return null;
  }

  let prev = 0;
  const schedule: SwapLegScheduleRow[] = legs.map((leg, i) => {
    const outstanding = leg.hedgeLocalM;
    const newLeg = Number.isFinite(leg.tradeNotionalLocalM)
      ? (leg.tradeNotionalLocalM as number)
      : outstanding - prev;
    const rolledForward = outstanding - newLeg;
    prev = outstanding;
    return {
      cycleIndex: leg.index,
      valueDateMonths: i === 0 ? 0 : (leg.settleMonths ?? leg.endMonth ?? i),
      newLeg,
      rolledForward,
      outstanding,
      preBookable: i > 0,
    };
  });
  const book = schedule.map(s => s.outstanding);
  const peakBook = peakOutstanding(book);
  const endingBook = book[book.length - 1] ?? cover;
  const avgBook = book.reduce((s, v) => s + v, 0) / Math.max(1, book.length);
  const spot = ccySpotRate(r.ccy);
  const deltaR = r_USD - r.r_FCY;
  return {
    ccy: r.ccy,
    drawdown: r.cycleDrawdown ?? 0,
    nearLeg: cover,
    endingBook,
    peakBook,
    rolling: profile.structure === 'strip' && legs.some(l => l.startMonth > 0),
    schedule,
    usdFunded: peakBook * spot,
    deltaR,
    costUsdYr: -fundingSwapCashDeltaUsdYr(avgBook, spot, r.r_FCY, r_USD, r.r_OD),
    cycles: legs.length,
  };
}

/** Staged Exposure package wins over the Liquidity H* plan when both exist. */
export function pickDecisionRow(
  r: FcyComputedRow,
  r_USD: number,
  prepared?: PreparedHedgeProfile,
): DecisionRow | null {
  if (prepared && Math.abs(prepared.coverLocalM) > 0.001) {
    return decisionRowFromPrepared(prepared, r, r_USD);
  }
  return decisionRowFor(r, r_USD);
}

export function clampCoverRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(1, Math.max(0, ratio));
}

/** Scale a proposed strip by cover % — 1 keeps the full H* path, 0 books nothing. */
export function scaleDecisionRow(d: DecisionRow, coverRatio: number): DecisionRow {
  const k = clampCoverRatio(coverRatio);
  if (Math.abs(k - 1) < 1e-12) return d;
  return {
    ...d,
    nearLeg: d.nearLeg * k,
    endingBook: d.endingBook * k,
    peakBook: d.peakBook * k,
    usdFunded: d.usdFunded * k,
    costUsdYr: d.costUsdYr * k,
    schedule: d.schedule.map(l => ({
      ...l,
      newLeg: l.newLeg * k,
      rolledForward: l.rolledForward * k,
      outstanding: l.outstanding * k,
    })),
  };
}

/**
 * The programme behind one currency's number: every leg, when it is value-dated,
 * what it rolls on top of, and the book it leaves outstanding. Legs after the
 * near cycle are already sized by the path, so each is a forward-starting swap
 * that can be traded today instead of going back to market when it bites.
 */
function settleLabel(months: number): string {
  return Math.abs(months - Math.round(months)) < 1e-6
    ? `M${Math.round(months)}`
    : `t=${months.toFixed(1)}`;
}

/**
 * Same Leg / Settle / Share / Notional / Cumulative H table as Exposure ·
 * hedge structuring — funding legs, not a separate schedule layout.
 */
function LegSchedule({
  schedule,
  term,
  forecastMonths,
  ccy,
  costUsdYr,
  embedded,
}: {
  schedule: readonly SwapLegScheduleRow[];
  term: boolean;
  forecastMonths: number;
  ccy: string;
  costUsdYr: number;
  embedded?: boolean;
}) {
  const border = embedded ? 'border-slate-800' : 'border-gray-200';
  const muted = embedded ? 'text-slate-500' : 'text-gray-500';
  const sumAbs = schedule.reduce((s, l) => s + Math.abs(l.newLeg), 0);
  const isStrip = !term && schedule.length > 1;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-[11px]">
        <thead>
          <tr className={muted}>
            <th className="py-0 pb-1.5 pr-3 font-medium">Leg</th>
            <th className="py-0 pb-1.5 pr-3 font-medium">Settle</th>
            <th className="py-0 pb-1.5 pr-3 font-medium">Share</th>
            <th className="py-0 pb-1.5 pr-3 font-medium">Notional</th>
            <th className="py-0 pb-1.5 pr-3 font-medium">Cumulative H</th>
            <th className="py-0 pb-1.5 pr-3 font-medium text-emerald-300/70">
              Implied carry
            </th>
            <th className="py-0 pb-1.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {schedule.map((l, i) => {
            const share = sumAbs < 1e-12 ? 0 : (Math.abs(l.newLeg) / sumAbs) * 100;
            const carry = sumAbs < 1e-12 ? 0 : costUsdYr * (Math.abs(l.newLeg) / sumAbs);
            const settle = term ? forecastMonths : l.valueDateMonths;
            return (
              <tr key={l.cycleIndex} className={`border-t ${border}/80`}>
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={
                        embedded
                          ? 'rounded bg-violet-500/20 px-1 py-0.5 text-[9px] font-semibold text-violet-200'
                          : 'rounded bg-violet-100 px-1 py-0.5 text-[9px] font-semibold text-violet-700'
                      }
                    >
                      {l.preBookable ? 'FWD' : 'SWAP'}
                    </span>
                    <span
                      className={`font-mono ${embedded ? 'text-slate-100' : 'text-gray-800'}`}
                    >
                      {isStrip
                        ? `L${i + 1}`
                        : term
                          ? `M0–M${Math.round(forecastMonths)}`
                          : `L${i + 1}`}
                    </span>
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono text-amber-200/90">
                  {settleLabel(settle)}
                </td>
                <td className={`py-1.5 pr-3 font-mono ${embedded ? 'text-slate-100' : 'text-gray-800'}`}>
                  {fmtShare(share)}
                </td>
                <td className="py-1.5 pr-3 font-mono font-semibold text-emerald-300">
                  {fmtLocal(l.newLeg, ccy)}
                </td>
                <td className={`py-1.5 pr-3 font-mono ${muted}`}>
                  {fmtLocal(l.outstanding, ccy)}
                </td>
                <td className="py-1.5 pr-3 font-mono text-emerald-300/90">
                  {Math.abs(carry) < 1e-9
                    ? '—'
                    : fmtVarK(Math.abs(carry)).replace('$', carry >= 0 ? '+$' : '−$')}
                </td>
                <td className={`py-1.5 text-[10px] ${muted}`}>
                  {l.preBookable ? 'forward · pre-bookable' : 'spot · book now'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Sizing basis × booking mode is the liquidity management regime: which low
 * the swap covers, and how the cover is bought. Controls live here, next to
 * the decision they drive, instead of only on the Liquidity desk toolbar —
 * changing the regime and reading the resulting swap decision is one view.
 */
function RegimeControls({
  sizingBasis,
  bookingMode,
  onSizingBasisChange,
  onBookingModeChange,
  embedded,
  parts = 'both',
}: {
  sizingBasis: LiquiditySizingBasis;
  bookingMode: LiquidityBookingMode;
  onSizingBasisChange?: (v: LiquiditySizingBasis) => void;
  onBookingModeChange?: (v: LiquidityBookingMode) => void;
  embedded?: boolean;
  /** Header keeps Size on; Book as lives in the expand Structure bar. */
  parts?: 'sizing' | 'booking' | 'both';
}) {
  const labelCls = embedded
    ? 'text-[9px] uppercase tracking-wide text-slate-500'
    : 'font-mono text-[9px] tracking-wide text-gray-400';
  const groupCls = embedded
    ? 'inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5'
    : 'inline-flex rounded-md border border-gray-200 bg-white p-0.5';
  const btnOn = embedded
    ? 'rounded-md px-2.5 py-1 text-[11px] font-semibold bg-violet-500/25 text-violet-100'
    : 'rounded px-2 py-0.5 text-[10px] font-semibold bg-sky-50 text-sky-700';
  const btnOff = embedded
    ? 'rounded-md px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:text-slate-300'
    : 'rounded px-2 py-0.5 text-[10px] font-semibold text-gray-500 hover:text-gray-700';

  if (!onSizingBasisChange && !onBookingModeChange) {
    return (
      <span className={embedded ? 'font-mono text-[10px] text-slate-500' : 'font-mono text-[10px] text-gray-500'}>
        sizing on{' '}
        {sizingBasis === 'cycle' ? 'the nearest cycle' : 'the worst cycle'} ·{' '}
        {bookingMode === 'term' ? 'one term swap' : 'a leg per cycle, rolled'}
      </span>
    );
  }
  return (
    <div className="inline-flex flex-wrap items-center gap-4">
      {parts !== 'booking' && (
      <div className="flex items-center gap-2">
        <span className={labelCls}>Size on</span>
        <span className={groupCls} role="group" aria-label="Sizing basis">
          {SIZING_BASIS_OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              title={o.hint}
              disabled={!onSizingBasisChange}
              onClick={() => onSizingBasisChange?.(o.id)}
              className={sizingBasis === o.id ? btnOn : btnOff}
            >
              {o.label}
            </button>
          ))}
        </span>
      </div>
      )}
      {parts !== 'sizing' && (
      <div className="flex items-center gap-2">
        <span className={labelCls}>{parts === 'booking' ? 'Structure' : 'Book as'}</span>
        <span className={groupCls} role="group" aria-label="Swap booking mode">
          {BOOKING_MODE_OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              title={o.hint}
              disabled={!onBookingModeChange}
              onClick={() => onBookingModeChange?.(o.id)}
              className={bookingMode === o.id ? btnOn : btnOff}
            >
              {o.label}
            </button>
          ))}
        </span>
      </div>
      )}
    </div>
  );
}

export function LiquiditySwapDecision({
  rows,
  r_USD,
  sizingBasis,
  bookingMode,
  forecastMonths,
  onSizingBasisChange,
  onBookingModeChange,
  preparedByCcy,
  embedded = false,
}: {
  rows: readonly FcyComputedRow[];
  r_USD: number;
  sizingBasis: LiquiditySizingBasis;
  bookingMode: LiquidityBookingMode;
  forecastMonths: number;
  /** Wired up, the regime becomes editable from this card — not only the Liquidity desk toolbar. */
  onSizingBasisChange?: (v: LiquiditySizingBasis) => void;
  onBookingModeChange?: (v: LiquidityBookingMode) => void;
  /**
   * Staged Exposure · hedge structuring packages. When a CCY has cover, that
   * strip / bullet is the funding decision (leg count + Target), not the
   * independent Liquidity H* cycle plan.
   */
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  /** Dark slate — Hedging Decision / Analytics host. */
  embedded?: boolean;
}) {
  const term = bookingMode === 'term';
  const decisions = rows
    .map(r => pickDecisionRow(r, r_USD, preparedByCcy?.[r.ccy]))
    .filter((d): d is DecisionRow =>
      d !== null
      && (Math.abs(d.nearLeg) > 0.001
        || Math.abs(d.peakBook) > 0.001
        || Math.abs(d.endingBook) > 0.001)
    );
  const sizedByStructuring = rows.some(
    r => Math.abs(preparedByCcy?.[r.ccy]?.coverLocalM ?? 0) > 0.001,
  );

  const [openCcy, setOpenCcy] = useState<string | null>(null);
  const [coverByCcy, setCoverByCcy] = useState<Record<string, number>>({});

  const coverRatioFor = (ccy: string): number =>
    clampCoverRatio(coverByCcy[ccy] ?? 1);
  const setCoverPct = (ccy: string, pct: number) => {
    setCoverByCcy(prev => ({ ...prev, [ccy]: clampCoverRatio(pct / 100) }));
  };

  const border = embedded ? 'border-slate-800' : 'border-gray-200';
  const muted = embedded ? 'text-slate-500' : 'text-gray-500';
  const head = embedded ? 'text-slate-500' : 'text-gray-500';
  const titleCls = embedded
    ? 'text-[11px] font-semibold uppercase tracking-wide text-slate-400'
    : 'text-[11px] font-semibold uppercase tracking-wide text-gray-500';
  const body = embedded ? 'text-xs text-slate-400' : 'text-xs text-gray-500';
  /** Same 13-column rhythm as Exposure · hedge structuring. */
  const structRowGrid =
    'grid w-full min-w-[52rem] grid-cols-[2.4rem_2.85rem_5.5rem_5.5rem_5.75rem_3.6rem_3.6rem_minmax(4.5rem,1fr)_5.75rem_5.75rem_3.6rem_3.6rem_0.85rem] items-baseline gap-x-2 px-3';

  const regime = (
    <RegimeControls
      sizingBasis={sizingBasis}
      bookingMode={bookingMode}
      onSizingBasisChange={onSizingBasisChange}
      onBookingModeChange={onBookingModeChange}
      embedded={embedded}
      parts="sizing"
    />
  );

  if (decisions.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className={titleCls}>Funding · hedge structuring</div>
          <RegimeControls
            sizingBasis={sizingBasis}
            bookingMode={bookingMode}
            onSizingBasisChange={onSizingBasisChange}
            onBookingModeChange={onBookingModeChange}
            embedded={embedded}
          />
        </div>
        <p className={body}>
          No strip yet. Turn on a buffer layer on Liquidity (floor, payout σ,
          carry, or portfolio VaR) — that sizes the swap, and the legs land
          here as the funding decision. With no layer on, a structural gap
          stays in carry.
        </p>
      </div>
    );
  }

  const scaled = decisions.map(d => scaleDecisionRow(d, coverRatioFor(d.ccy)));
  const totalUsd = scaled.reduce((s, d) => s + d.usdFunded, 0);
  const totalCost = scaled.reduce((s, d) => s + d.costUsdYr, 0);

  return (
    <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className={titleCls}>Funding · hedge structuring</div>
          <div className="flex flex-wrap items-center gap-3">
          {regime}
          <button
            type="button"
            onClick={() => {
              const next: Record<string, number> = {};
              for (const d of decisions) next[d.ccy] = 0;
              setCoverByCcy(next);
            }}
            className={
              embedded
                ? 'rounded-md border border-slate-600 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800'
                : 'rounded-md border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-50'
            }
          >
            Unfunded
          </button>
          <div className={`font-mono text-[9px] ${embedded ? 'text-slate-600' : 'text-gray-400'}`}>
            {forecastMonths}m horizon · {decisions.length}{' '}
            {decisions.length === 1 ? 'currency' : 'currencies'} · sized by
            {sizedByStructuring
              ? ' Exposure · hedge structuring'
              : ' Liquidity layers'}
          </div>
        </div>
      </div>

      <div className={`overflow-x-auto rounded-lg border ${border}`}>
        <div className={`${structRowGrid} border-b ${border} py-1.5 ${head}`}>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            CCY
          </span>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Dir
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Cash the binding cycle drains at its deepest"
          >
            Drain
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Near leg for cycle 1 — book now"
          >
            Near
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Deepest the outstanding book gets on the path"
          >
            Peak
          </span>
          <span
            className={`text-right text-[9px] font-medium uppercase tracking-wide ${
              embedded ? 'text-amber-300/90' : 'text-amber-700'
            }`}
            title="USD the (scaled) peak outstanding book consumes at spot"
          >
            $USD
          </span>
          <span
            className={`text-right text-[9px] font-medium uppercase tracking-wide ${
              embedded ? 'text-emerald-300/80' : 'text-emerald-700'
            }`}
            title="Unfunded fraction of the proposed near leg (1 − cover)"
          >
            Δ
          </span>
          <span className="text-[9px] font-medium uppercase tracking-wide">
            Structure
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            Target
          </span>
          <span className="text-right text-[9px] font-medium uppercase tracking-wide">
            Resid
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Annual USD cost of Δr on the average outstanding book"
          >
            Cost
          </span>
          <span
            className="text-right text-[9px] font-medium uppercase tracking-wide"
            title="Δr = r_USD − r_FCY"
          >
            Δr
          </span>
          <span />
        </div>
        {decisions.map((full, i) => {
          const d = scaled[i]!;
          const cover = coverRatioFor(full.ccy);
          const coverPct = Math.round(cover * 100);
          const residual = full.nearLeg * (1 - cover);
          const delta = 1 - cover;
          const open = openCcy === full.ccy;
          const direction: 'long' | 'short' | 'flat' =
            Math.abs(full.nearLeg) < 1e-9
              ? 'flat'
              : full.nearLeg > 0
                ? 'long'
                : 'short';
          const structureLabel = term
            ? '1 term swap'
            : `${full.schedule.length}-leg ${full.rolling ? 'rolling' : 'strip'}`;
          return (
            <Fragment key={full.ccy}>
              <div
                role="button"
                tabIndex={0}
                title={`Structure ${full.ccy} funding hedge`}
                onClick={() => setOpenCcy(open ? null : full.ccy)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpenCcy(open ? null : full.ccy);
                  }
                }}
                className={`${structRowGrid} cursor-pointer border-b ${border}/60 py-1.5 ${
                  open
                    ? embedded
                      ? 'bg-violet-500/10'
                      : 'bg-violet-50'
                    : embedded
                      ? 'bg-slate-950/30 hover:bg-violet-500/10'
                      : 'bg-white hover:bg-violet-50/60'
                }`}
              >
                <span
                  className={`text-[13px] font-semibold ${
                    embedded ? 'text-violet-200' : 'text-violet-700'
                  }`}
                >
                  {full.ccy}
                </span>
                <span>
                  <span
                    className={`rounded px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${
                      direction === 'long'
                        ? embedded
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-emerald-50 text-emerald-700'
                        : direction === 'short'
                          ? embedded
                            ? 'bg-rose-500/15 text-rose-300'
                            : 'bg-rose-50 text-rose-700'
                          : embedded
                            ? 'bg-slate-700/50 text-slate-500'
                            : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {direction}
                  </span>
                </span>
                <span
                  className={`text-right font-mono text-[11px] tabular-nums ${
                    embedded ? 'text-slate-300' : 'text-gray-700'
                  }`}
                >
                  {full.drawdown > 0.001 ? f2(full.drawdown) : '—'}
                </span>
                <span
                  className={`text-right font-mono text-[11px] tabular-nums ${
                    Math.abs(d.nearLeg) < 1e-9
                      ? muted
                      : embedded
                        ? 'text-slate-300'
                        : 'text-gray-700'
                  }`}
                >
                  {Math.abs(d.nearLeg) < 1e-9 ? '—' : signed(d.nearLeg)}
                </span>
                <span
                  className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                    embedded ? 'text-violet-200' : 'text-violet-700'
                  }`}
                >
                  {signed(d.peakBook)}
                </span>
                <span
                  className={`text-right font-mono text-[11px] tabular-nums ${
                    embedded ? 'text-amber-300' : 'text-amber-700'
                  }`}
                >
                  {f2(d.usdFunded)}
                </span>
                <span
                  className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                    delta < 1e-9
                      ? embedded
                        ? 'text-emerald-300'
                        : 'text-emerald-700'
                      : embedded
                        ? 'text-amber-300'
                        : 'text-amber-700'
                  }`}
                >
                  {delta.toFixed(2)}
                </span>
                <span className={`truncate text-[9px] ${muted}`}>
                  {structureLabel}
                </span>
                <span
                  className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                    embedded ? 'text-sky-300' : 'text-sky-700'
                  }`}
                >
                  {signed(full.nearLeg)}
                </span>
                <span
                  className={`text-right font-mono text-[11px] tabular-nums ${
                    Math.abs(residual) < 1e-9
                      ? muted
                      : embedded
                        ? 'text-amber-300'
                        : 'text-amber-700'
                  }`}
                >
                  {Math.abs(residual) < 1e-9 ? '—' : signed(residual)}
                </span>
                <span
                  className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                    d.costUsdYr > 0.001
                      ? embedded
                        ? 'text-amber-300'
                        : 'text-red-600'
                      : d.costUsdYr < -0.001
                        ? embedded
                          ? 'text-emerald-300'
                          : 'text-green-700'
                        : muted
                  }`}
                >
                  {f2(d.costUsdYr)}
                </span>
                <span
                  className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                    embedded ? 'text-emerald-300' : 'text-emerald-700'
                  }`}
                >
                  {full.deltaR >= 0 ? '+' : ''}
                  {full.deltaR.toFixed(2)}
                </span>
                <span className={`text-center text-[9px] ${muted}`}>
                  {open ? '▾' : '▸'}
                </span>
              </div>
              {open && (
                <div
                  className={`border-b ${border} ${
                    embedded ? 'bg-slate-950/40' : 'bg-gray-50'
                  }`}
                >
                  <div className="flex flex-col gap-3 px-3 py-3.5">
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex flex-col gap-1">
                        <span className="text-[9px] uppercase tracking-wide text-slate-500">
                          Cycle drain
                        </span>
                        <span className={`font-mono text-xs ${muted}`}>
                          {full.drawdown > 0.001
                            ? fmtLocal(full.drawdown, full.ccy)
                            : '—'}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-[9px] uppercase tracking-wide text-slate-500">
                          Peak book
                        </span>
                        <span className={`font-mono text-xs ${muted}`}>
                          {fmtLocal(full.peakBook, full.ccy)}
                        </span>
                      </div>
                      <DeskStepper
                        label="Cover"
                        value={coverPct}
                        min={0}
                        max={MAX_COVER_PCT}
                        step={1}
                        nudgeStep={COVER_STEP_PCT}
                        onChange={pct => setCoverPct(full.ccy, pct)}
                        formatValue={v => `${v}%`}
                        suffix={`→ ${fmtLocal(d.nearLeg, full.ccy)}`}
                        editable
                        tickValues={[0, 25, 50, 75, 100]}
                        layout="inline"
                        className="w-[22rem] sm:w-[26rem] lg:w-[30rem] xl:w-[34rem] max-w-full"
                        title="Scale funding cover of the proposed strip (0% unfunded, 100% full H* · remaining Δ = 1 − cover)"
                        ariaLabel="Funding cover percent"
                      />
                      <div className="flex flex-col gap-1">
                        <span className="text-[9px] uppercase tracking-wide text-slate-500">
                          Target (near)
                        </span>
                        <span className="font-mono text-sm font-semibold text-sky-300">
                          {fmtLocal(full.nearLeg, full.ccy)}
                        </span>
                      </div>
                    </div>

                    <div
                      className={`flex flex-wrap items-center gap-4 border-y ${border} py-2.5`}
                    >
                      <RegimeControls
                        sizingBasis={sizingBasis}
                        bookingMode={bookingMode}
                        onSizingBasisChange={onSizingBasisChange}
                        onBookingModeChange={onBookingModeChange}
                        embedded={embedded}
                        parts="booking"
                      />
                      {!term && (
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Legs
                          </span>
                          <span
                            className={`w-3 text-center font-mono text-xs ${
                              embedded ? 'text-slate-100' : 'text-gray-800'
                            }`}
                          >
                            {full.schedule.length}
                          </span>
                        </div>
                      )}
                      <span className="flex-1" />
                      <span className={`text-[10px] ${muted}`}>
                        {!term
                          ? 'Σ share 100% · path-sized'
                          : '1 term swap · held to Tf'}
                      </span>
                    </div>

                    <LegSchedule
                      schedule={d.schedule}
                      term={term}
                      forecastMonths={forecastMonths}
                      ccy={full.ccy}
                      costUsdYr={d.costUsdYr}
                      embedded={embedded}
                    />

                    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto">
                      <span className="flex min-w-0 shrink gap-x-3 whitespace-nowrap text-[10px]">
                        <span className={muted}>
                          Outstanding M{forecastMonths}{' '}
                          <span className={`font-mono ${embedded ? 'text-slate-300' : 'text-gray-700'}`}>
                            {fmtLocal(d.endingBook, full.ccy)}
                          </span>
                        </span>
                        <span className={muted}>
                          Δ{' '}
                          <span
                            className={`font-mono ${
                              delta < 1e-9
                                ? embedded
                                  ? 'text-emerald-300'
                                  : 'text-emerald-700'
                                : 'text-amber-300'
                            }`}
                          >
                            {delta.toFixed(2)}
                          </span>
                        </span>
                        <span className={muted}>
                          Resid{' '}
                          <span className={`font-mono ${embedded ? 'text-slate-300' : 'text-gray-700'}`}>
                            {Math.abs(residual) < 1e-9
                              ? '—'
                              : fmtLocal(residual, full.ccy)}
                          </span>
                        </span>
                        <span className={muted}>
                          Cost{' '}
                          <span
                            className={`font-mono font-semibold ${
                              d.costUsdYr > 0.001
                                ? 'text-amber-300'
                                : d.costUsdYr < -0.001
                                  ? 'text-emerald-300'
                                  : embedded
                                    ? 'text-slate-300'
                                    : 'text-gray-700'
                            }`}
                          >
                          {Math.abs(d.costUsdYr) < 1e-9
                            ? '—'
                            : fmtVarK(Math.abs(d.costUsdYr)).replace(
                                '$',
                                d.costUsdYr >= 0 ? '+$' : '−$',
                              )}
                          </span>
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </Fragment>
          );
        })}
        {decisions.length > 1 && (
          <div
            className={`${structRowGrid} ${
              embedded ? 'bg-slate-900/40' : 'bg-gray-50'
            } py-1.5`}
            title="FCY amounts don't sum across currencies — $USD and Cost are USD totals"
          >
            <span
              className={`text-[11px] font-semibold ${
                embedded ? 'text-violet-200' : 'text-violet-700'
              }`}
            >
              All
            </span>
            <span />
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span
              className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                embedded ? 'text-amber-300' : 'text-amber-700'
              }`}
            >
              {f2(totalUsd)}
            </span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span />
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span
              className={`text-right font-mono text-[11px] font-semibold tabular-nums ${
                totalCost > 0.001
                  ? embedded
                    ? 'text-amber-300'
                    : 'text-red-600'
                  : totalCost < -0.001
                    ? embedded
                      ? 'text-emerald-300'
                      : 'text-green-700'
                    : muted
              }`}
            >
              {f2(totalCost)}
            </span>
            <span className={`text-right font-mono text-[11px] ${muted}`}>—</span>
            <span />
          </div>
        )}
      </div>
    </div>
  );
}
