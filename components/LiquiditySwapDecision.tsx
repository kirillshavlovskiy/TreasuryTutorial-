'use client';

/**
 * Liquidity layer of the hedging decision: what the funded forecast path asks
 * the desk to book. Every number here comes from the same per-cycle plan that
 * sizes H* and the swap on the simulator row — near leg for the cycle in front
 * of us, the notional left outstanding once every leg has been rolled, and the
 * leg-by-leg schedule behind it: what to trade, on what value date, and which
 * legs are already sized enough to book today as forward-starting swaps.
 */

import { Fragment } from 'react';
import { ccySpotRate } from '@/lib/fx-buffer';
import { swapLegSchedule, type SwapLegScheduleRow } from '@/lib/forecast-profile';
import type { FcyComputedRow } from '@/lib/dashboard-model';
import {
  BOOKING_MODE_OPTIONS,
  SIZING_BASIS_OPTIONS,
  type LiquidityBookingMode,
  type LiquiditySizingBasis,
} from '@/lib/liquidity-ladder';

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

export function decisionRowFor(r: FcyComputedRow, r_USD: number): DecisionRow | null {
  const plan = r.liquidityPlan;
  // A buffer layer sizes the row's swap even before the dated plan is on —
  // still a proposed trade the decision module has to show.
  if (!plan || plan.length === 0) {
    const rowSwap = r.swapNear;
    if (typeof rowSwap !== 'number' || !Number.isFinite(rowSwap) || Math.abs(rowSwap) <= 0.001) {
      return null;
    }
    return rowFromNearLeg(r, r_USD, rowSwap, 1);
  }
  const nearLeg = plan[0]?.swap_needed ?? 0;
  // Each cycle's leg is rolled, so the book is the running sum — a drain that
  // repeats every cycle funds at the whole horizon's burn, not at one leg.
  const book = plan.map(p => p.standing_swap);
  const endingBook = book[book.length - 1] ?? 0;
  const peakBook = book.reduce((m, v) => Math.max(m, v), 0);
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
}: {
  sizingBasis: LiquiditySizingBasis;
  bookingMode: LiquidityBookingMode;
  onSizingBasisChange?: (v: LiquiditySizingBasis) => void;
  onBookingModeChange?: (v: LiquidityBookingMode) => void;
}) {
  if (!onSizingBasisChange && !onBookingModeChange) {
    return (
      <span className="font-mono text-[10px] text-gray-500">
        sizing on{' '}
        {sizingBasis === 'cycle' ? 'the nearest cycle' : 'the worst cycle'} ·{' '}
        {bookingMode === 'term' ? 'one term swap' : 'a leg per cycle, rolled'}
      </span>
    );
  }
  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[9px] tracking-wide text-gray-400">Size on</span>
      <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5" role="group" aria-label="Sizing basis">
        {SIZING_BASIS_OPTIONS.map(o => (
          <button
            key={o.id}
            type="button"
            title={o.hint}
            disabled={!onSizingBasisChange}
            onClick={() => onSizingBasisChange?.(o.id)}
            className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
              sizingBasis === o.id
                ? 'bg-sky-50 text-sky-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="font-mono text-[9px] tracking-wide text-gray-400">Book as</span>
      <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5" role="group" aria-label="Swap booking mode">
        {BOOKING_MODE_OPTIONS.map(o => (
          <button
            key={o.id}
            type="button"
            title={o.hint}
            disabled={!onBookingModeChange}
            onClick={() => onBookingModeChange?.(o.id)}
            className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
              bookingMode === o.id
                ? 'bg-sky-50 text-sky-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {o.label}
          </button>
        ))}
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
    .filter((d): d is DecisionRow => d !== null && (d.nearLeg > 0.001 || d.peakBook > 0.001));

  const card = embedded
    ? 'rounded-lg border border-slate-700 bg-slate-950/40 p-3'
    : 'rounded-lg border border-gray-200 bg-white p-4';
  const title = embedded ? 'text-sm font-semibold text-slate-100' : 'text-sm font-semibold text-gray-800';
  const body = embedded ? 'text-xs text-slate-400' : 'text-xs text-gray-500';
  const th = embedded
    ? 'border-b border-slate-800 px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-500'
    : 'border-b border-gray-200 px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-gray-500';
  const td = embedded
    ? 'border-b border-slate-800/60 px-2 py-1 text-right'
    : 'border-b border-gray-100 px-2 py-1 text-right';
  const schedBg = embedded ? 'border-b border-slate-800/60 bg-slate-950/60 px-2 py-2' : 'border-b border-gray-200 bg-gray-50 px-2 py-2';

  if (decisions.length === 0) {
    return (
      <div className={card}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className={title}>
            Proposed funding strip
          </h3>
          <RegimeControls
            sizingBasis={sizingBasis}
            bookingMode={bookingMode}
            onSizingBasisChange={onSizingBasisChange}
            onBookingModeChange={onBookingModeChange}
          />
        </div>
        <p className={`mt-1.5 ${body}`}>
          No strip yet. Turn on a buffer layer on Liquidity (floor, payout σ,
          carry, or portfolio VaR) — that sizes the swap, and the legs land
          here as the funding decision. With no layer on, a structural gap
          stays in carry.
        </p>
      </div>
    );
  }

  const totalUsd = decisions.reduce((s, d) => s + d.usdFunded, 0);
  const totalCost = decisions.reduce((s, d) => s + d.costUsdYr, 0);

  return (
    <div className={`space-y-3 ${card}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={title}>
          Proposed funding strip · Δ = 0
        </h3>
        <span className={`font-mono text-[10px] ${embedded ? 'text-slate-500' : 'text-gray-500'}`}>
          sized by Liquidity layers · {forecastMonths}-cycle path
        </span>
      </div>
      <div className="flex justify-end">
        <RegimeControls
          sizingBasis={sizingBasis}
          bookingMode={bookingMode}
          onSizingBasisChange={onSizingBasisChange}
          onBookingModeChange={onBookingModeChange}
        />
      </div>
      <p className={embedded ? 'text-xs text-slate-400' : 'text-xs text-gray-600'}>
        The near leg buys FCY to bring the trough up to its cushion and the far
        leg sells it back, so the FX position is untouched.{' '}
        {term
          ? `One swap today carries the whole horizon: the leg covers the deepest
             requirement on the path and nothing is rolled, so there is no
             rollover risk and one set of points — paid for by holding cover
             before it bites, which is what the Δr column charges.`
          : `Rolling a leg keeps its cash, it does not repay the drain: when the
             drain repeats, every cycle adds another leg and the outstanding book
             grows to the horizon's burn. Book now is this cycle's spot trade;
             outstanding is the position it builds into. Open a currency for the
             leg-by-leg schedule and which legs can be booked forward today.`}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
          <thead>
            <tr>
              <th className={`${th} text-left`}>CCY</th>
              <th className={th} title="Cash the binding cycle drains at its deepest">
                Cycle drain
              </th>
              <th className={th} title="Near leg for the cycle in front of us — book now">
                Book now
              </th>
              <th
                className={th}
                title={term
                  ? 'The term leg, outstanding for the whole horizon'
                  : 'Swap notional outstanding after the last cycle — every leg rolled, none run off'}
              >
                Outstanding M{forecastMonths}
              </th>
              <th
                className={th}
                title={term
                  ? 'Nothing left to pre-book: the single leg is already on'
                  : 'Legs after this cycle, each already sized by the path — tradeable today as forward-starting swaps value-dated at their own cycle. Open the row for the schedule'}
              >
                Forward legs
              </th>
              <th className={th} title="USD the peak outstanding book consumes at spot">
                $USD funded
              </th>
              <th className={th} title="Δr = r_USD − r_FCY on the average outstanding book over the horizon. Under CIP the swap prices at mid, so the differential shows on the cash, not on the swap">
                Δr cost $/yr
              </th>
            </tr>
          </thead>
          <tbody>
            {decisions.map(d => {
              const forward = d.schedule.filter(s => s.preBookable);
              const forwardTotal = forward.reduce((s, l) => s + l.newLeg, 0);
              return (
              <Fragment key={d.ccy}>
              <tr>
                <td className={`${td} text-left font-semibold ${embedded ? 'text-slate-200' : 'text-gray-700'}`}>
                  {d.ccy}
                  {d.rolling && (
                    <span
                      className="ml-1.5 rounded bg-amber-100 px-1 py-px text-[9px] font-semibold text-amber-700"
                      title="The drain repeats every cycle — roll the leg instead of letting it run off"
                    >
                      rolling
                    </span>
                  )}
                </td>
                <td className={`${td} ${d.drawdown > 0.001 ? 'text-red-600' : 'text-gray-400'}`}>
                  {d.drawdown > 0.001 ? f2(d.drawdown) : '—'}
                </td>
                <td className={`${td} font-semibold ${d.nearLeg > 0.001 ? 'text-orange-700' : 'text-gray-400'}`}>
                  {d.nearLeg > 0.001 ? `+${f2(d.nearLeg)}` : '—'}
                </td>
                <td
                  className={`${td} ${d.endingBook > d.nearLeg + 0.001 ? 'font-semibold text-red-700' : 'text-gray-600'}`}
                  title={term
                    ? `${f2(d.nearLeg)} booked once, held to M${forecastMonths}`
                    : `${f2(d.nearLeg)} booked now, rolled and added to every cycle · peak ${f2(d.peakBook)}`}
                >
                  {f2(d.endingBook)}
                </td>
                <td className={`${td} text-left`}>
                  {forward.length === 0 ? (
                    <span className="text-gray-400">—</span>
                  ) : (
                    <span
                      className="text-gray-600"
                      title={forward
                        .map(l => `M${l.valueDateMonths + 1} ${signed(l.newLeg)}`)
                        .join(' · ')}
                    >
                      {forward.length} × M{forward[0]!.valueDateMonths + 1}–M
                      {forward[forward.length - 1]!.valueDateMonths + 1}
                      <span className="ml-1 text-gray-500">{signed(forwardTotal)}</span>
                    </span>
                  )}
                </td>
                <td className={`${td} text-gray-700`}>{f2(d.usdFunded)}</td>
                <td className={`${td} ${d.costUsdYr > 0.001 ? 'text-red-600' : d.costUsdYr < -0.001 ? 'text-green-700' : 'text-gray-400'}`}>
                  {f2(d.costUsdYr)}
                  <span className="ml-1 text-[9px] text-gray-400">
                    Δr {d.deltaR >= 0 ? '+' : ''}{d.deltaR.toFixed(2)}
                  </span>
                </td>
              </tr>
              <tr>
                <td colSpan={7} className={schedBg}>
                  <LegSchedule
                    schedule={d.schedule}
                    term={term}
                    forecastMonths={forecastMonths}
                    embedded={embedded}
                  />
                </td>
              </tr>
              </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 font-semibold">
              <td className={`${td} text-left text-gray-700`}>TOTAL</td>
              <td className={td} />
              <td className={td} />
              <td className={td} />
              <td className={td} />
              <td className={`${td} text-gray-800`}>{f2(totalUsd)}</td>
              <td className={`${td} ${totalCost > 0.001 ? 'text-red-600' : 'text-gray-500'}`}>
                {f2(totalCost)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="border-t border-gray-100 pt-2 text-[10px] text-gray-400">
        {term
          ? `Cover is committed up front, so the cash runs down cycle by cycle
             instead of the swap book building up. Outstanding is flat and the
             carry is charged on cover that is not working yet — switch to
             rolling on the desk to price the same path leg by leg.`
          : `Every cycle on the path is funded, so each one opens where the leg
             before it left off — which is exactly why the outstanding book
             compounds. A rolling swap is a funding line, not a repayment: only a
             cycle that turns cash-positive retires notional. Switch to term on
             the desk to price the same path as one committed swap.`}
      </p>
    </div>
  );
}
