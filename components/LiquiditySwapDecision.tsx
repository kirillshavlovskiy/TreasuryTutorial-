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

import { useState } from 'react';
import { DeskStepper } from '@/components/DeskStepper';
import { ccySpotRate } from '@/lib/fx-buffer';
import { swapLegSchedule, type SwapLegScheduleRow } from '@/lib/forecast-profile';
import type { FcyComputedRow } from '@/lib/dashboard-model';
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
    costUsdYr: nearLeg * spot * (deltaR / 100),
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
    costUsdYr: avgBook * spot * (deltaR / 100),
    cycles: plan.length,
  };
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
function LegSchedule({
  schedule,
  term,
  forecastMonths,
  embedded,
}: {
  schedule: readonly SwapLegScheduleRow[];
  term: boolean;
  forecastMonths: number;
  embedded?: boolean;
}) {
  const sth = embedded
    ? 'border-b border-slate-800 px-2 py-1 text-right text-[9px] font-semibold uppercase tracking-wide text-slate-500'
    : 'border-b border-gray-200 px-2 py-1 text-right text-[9px] font-semibold uppercase tracking-wide text-gray-500';
  const std = embedded
    ? 'border-b border-slate-800/50 px-2 py-0.5 text-right text-slate-400'
    : 'border-b border-gray-100 px-2 py-0.5 text-right text-gray-600';
  const dateCls = embedded ? 'text-slate-200' : 'text-gray-700';
  const outCls = embedded ? 'text-slate-200' : 'text-gray-700';
  const note = embedded ? 'text-slate-500' : 'text-gray-500';
  const fwdChip = embedded
    ? 'rounded bg-sky-500/15 px-1 py-px text-sky-200'
    : 'rounded bg-sky-100 px-1 py-px text-sky-700';
  const spotChip = embedded
    ? 'rounded bg-amber-500/15 px-1 py-px text-amber-200'
    : 'rounded bg-orange-100 px-1 py-px text-orange-700';

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[10px] tabular-nums">
        <thead>
          <tr>
            <th className={`${sth} text-left`}>Value date</th>
            <th className={`${sth} text-left`}>Trade</th>
            <th className={sth} title="Notional this leg adds: + buys FCY to fund the trough, − sells excess back">
              New leg
            </th>
            <th className={sth} title="Notional carried in from earlier legs — extended at its far date, not settled">
              Rolled in
            </th>
            <th className={sth} title="Notional outstanding once this leg is on">
              Outstanding
            </th>
          </tr>
        </thead>
        <tbody>
          {schedule.map(l => (
            <tr key={l.cycleIndex}>
              <td className={`${std} text-left font-semibold ${dateCls}`}>
                M{l.valueDateMonths + 1}
              </td>
              <td className={`${std} text-left`}>
                {l.preBookable ? (
                  <span className={fwdChip} title={`Sized already — bookable today as a swap value-dated M${l.valueDateMonths + 1}`}>
                    forward-start · pre-bookable
                  </span>
                ) : (
                  <span className={spotChip} title="The near cycle's trade: spot start, book now">
                    spot · book now
                  </span>
                )}
              </td>
              <td className={`${std} font-semibold ${l.newLeg > 0 ? (embedded ? 'text-sky-200' : 'text-orange-700') : (embedded ? 'text-emerald-300/80' : 'text-green-700')}`}>
                {signed(l.newLeg)}
              </td>
              <td className={std}>
                {Math.abs(l.rolledForward) > 0.001 ? f2(l.rolledForward) : '—'}
              </td>
              <td className={`${std} font-semibold ${outCls}`}>{f2(l.outstanding)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={`mt-1.5 text-[9px] ${note}`}>
        {term
          ? `One leg, value-dated spot and held to M${forecastMonths}: nothing rolls
             and nothing is left to pre-book.`
          : `Only the M1 leg has to be traded spot. Every later leg is already
             sized by the path, so it can be booked today as a forward-starting
             swap on its own value date — leaving it means going back to market
             that cycle at whatever the points are then. Rolled in is the notional
             carried from earlier legs: the far date is extended, not settled, so
             the book only comes down on a cycle that turns cash-positive.`}
      </p>
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
}: {
  sizingBasis: LiquiditySizingBasis;
  bookingMode: LiquidityBookingMode;
  onSizingBasisChange?: (v: LiquiditySizingBasis) => void;
  onBookingModeChange?: (v: LiquidityBookingMode) => void;
  embedded?: boolean;
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
      <div className="flex items-center gap-2">
        <span className={labelCls}>Book as</span>
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
  /** Dark slate — Hedging Decision / Analytics host. */
  embedded?: boolean;
}) {
  const term = bookingMode === 'term';
  const decisions = rows
    .map(r => decisionRowFor(r, r_USD))
    .filter((d): d is DecisionRow =>
      d !== null
      && (Math.abs(d.nearLeg) > 0.001
        || Math.abs(d.peakBook) > 0.001
        || Math.abs(d.endingBook) > 0.001)
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
  const titleCls = embedded
    ? 'text-[11px] font-semibold uppercase tracking-wide text-slate-400'
    : 'text-[11px] font-semibold uppercase tracking-wide text-gray-500';
  const body = embedded ? 'text-xs text-slate-400' : 'text-xs text-gray-500';

  const regime = (
    <RegimeControls
      sizingBasis={sizingBasis}
      bookingMode={bookingMode}
      onSizingBasisChange={onSizingBasisChange}
      onBookingModeChange={onBookingModeChange}
      embedded={embedded}
    />
  );

  if (decisions.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className={titleCls}>Funding hedge · adjust before booking</div>
          {regime}
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
        <div className={titleCls}>Funding hedge · adjust before booking</div>
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
            Liquidity layers
          </div>
        </div>
      </div>

      {decisions.map((full, i) => {
        const d = scaled[i]!;
        const cover = coverRatioFor(full.ccy);
        const coverPct = Math.round(cover * 100);
        const residual = full.nearLeg * (1 - cover);
        const delta = 1 - cover;
        const open = openCcy === full.ccy;
        const forward = d.schedule.filter(s => s.preBookable);
        return (
          <div
            key={full.ccy}
            className={`rounded-lg border ${
              open
                ? embedded
                  ? 'border-violet-500/40 bg-slate-950/60'
                  : 'border-violet-300 bg-violet-50/40'
                : embedded
                  ? `${border} bg-slate-950/30`
                  : `${border} bg-white`
            }`}
          >
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
              className="flex cursor-pointer flex-wrap items-center gap-4 px-3 py-2.5"
            >
              <div className="flex w-[120px] flex-none flex-col gap-0.5">
                <span
                  className={`text-sm font-semibold ${embedded ? 'text-violet-200' : 'text-violet-700'}`}
                >
                  {full.ccy}
                </span>
                <span className={`text-[9px] ${muted}`}>
                  {term
                    ? '1 term swap'
                    : `${full.schedule.length}-leg ${full.rolling ? 'rolling' : 'strip'}`}
                </span>
              </div>
              <div className="flex w-[150px] flex-none flex-col gap-0.5">
                <span className={`text-[9px] uppercase tracking-wide ${muted}`}>
                  Target
                </span>
                <span
                  className={`font-mono text-xs font-semibold ${embedded ? 'text-sky-300' : 'text-sky-700'}`}
                >
                  {signed(full.nearLeg)}
                </span>
              </div>
              <div className="flex w-[130px] flex-none flex-col gap-0.5">
                <span className={`text-[9px] uppercase tracking-wide ${muted}`}>
                  Residual
                </span>
                <span
                  className={`font-mono text-xs ${
                    Math.abs(residual) < 1e-9
                      ? muted
                      : embedded
                        ? 'text-amber-300'
                        : 'text-amber-700'
                  }`}
                >
                  {Math.abs(residual) < 1e-9 ? '—' : signed(residual)}
                </span>
              </div>
              <div className="flex w-[90px] flex-none flex-col gap-0.5">
                <span className={`text-[9px] uppercase tracking-wide ${muted}`}>
                  Δ
                </span>
                <span
                  className={`font-mono text-xs font-semibold ${
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
              </div>
              <div className="flex w-[120px] flex-none flex-col gap-0.5">
                <span className={`text-[9px] uppercase tracking-wide ${muted}`}>
                  $USD funded
                </span>
                <span
                  className={`font-mono text-xs ${embedded ? 'text-slate-200' : 'text-gray-700'}`}
                >
                  {f2(d.usdFunded)}
                </span>
              </div>
              <span className="flex-1" />
              <span className={`text-[10px] ${muted}`}>
                {open ? 'Structuring' : 'Click to structure'}
              </span>
            </div>

            {open && (
              <div
                className={`flex flex-col gap-3 border-t ${border} ${
                  embedded ? 'bg-slate-950/40' : 'bg-gray-50'
                } px-3 py-3.5`}
              >
                <div className="flex flex-wrap items-end gap-5">
                  <div className="flex flex-col gap-1">
                    <span className={`text-[9px] uppercase tracking-wide ${muted}`}>
                      Cycle drain
                    </span>
                    <span className={`font-mono text-xs ${muted}`}>
                      {full.drawdown > 0.001 ? f2(full.drawdown) : '—'}
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
                    suffix={`→ ${signed(d.nearLeg)}`}
                    editable
                    tickValues={[0, 25, 50, 75, 100]}
                    className="min-w-[280px] w-[280px]"
                    title="Scale funding cover of the proposed strip (0% unfunded, 100% full H* · remaining Δ = 1 − cover)"
                    ariaLabel="Funding cover percent"
                    accent="sky"
                  />
                  <div className="flex flex-col gap-1">
                    <span className={`text-[9px] uppercase tracking-wide ${muted}`}>
                      Remaining Δ
                    </span>
                    <span
                      className={`font-mono text-sm font-semibold ${
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
                  </div>
                </div>

                <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-y ${border} py-2.5 text-[10px]`}>
                  <span className={muted}>
                    Outstanding M{forecastMonths}{' '}
                    <span className={`font-mono ${embedded ? 'text-slate-300' : 'text-gray-700'}`}>
                      {f2(d.endingBook)}
                    </span>
                  </span>
                  <span className={muted}>
                    Forward legs{' '}
                    <span className={`font-mono ${embedded ? 'text-slate-300' : 'text-gray-700'}`}>
                      {forward.length === 0
                        ? '—'
                        : `${forward.length} × ${signed(forward.reduce((s, l) => s + l.newLeg, 0))}`}
                    </span>
                  </span>
                  <span className={muted}>
                    Δr cost $/yr{' '}
                    <span
                      className={`font-mono ${
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
                    <span className={`ml-1 ${muted}`}>
                      Δr {full.deltaR >= 0 ? '+' : ''}
                      {full.deltaR.toFixed(2)}
                    </span>
                  </span>
                </div>

                <p className={body}>
                  The near leg buys FCY to bring the trough up to its cushion
                  and the far leg sells it back, so the FX position is
                  untouched. Cover scales how much of that strip is taken —
                  remaining Δ is the unfunded fraction of the proposed near
                  leg.
                </p>

                <LegSchedule
                  schedule={d.schedule}
                  term={term}
                  forecastMonths={forecastMonths}
                  embedded={embedded}
                />
              </div>
            )}
          </div>
        );
      })}

      <div
        className={`flex flex-wrap items-baseline justify-between gap-2 rounded-lg border ${border} ${
          embedded ? 'bg-slate-900/40' : 'bg-gray-50'
        } px-3 py-2`}
      >
        <span className={`text-sm font-semibold ${embedded ? 'text-violet-200' : 'text-violet-700'}`}>
          All CCY
        </span>
        <span className={`font-mono text-xs ${embedded ? 'text-slate-300' : 'text-gray-700'}`}>
          $USD funded {f2(totalUsd)}
          <span className={`ml-3 ${totalCost > 0.001 ? (embedded ? 'text-amber-300' : 'text-red-600') : muted}`}>
            Δr cost {f2(totalCost)} /yr
          </span>
        </span>
      </div>
    </div>
  );
}
