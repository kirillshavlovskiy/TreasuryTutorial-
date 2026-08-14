'use client';

/**
 * Liquidity perspective on Analytics — how the desk covers the dip in the dated
 * cash path, and what each way of covering it costs.
 *
 * The other perspectives measure a risk; this one prices the response to one.
 * Every strategy runs over the same ladder and is charged on the same interest
 * ledger (see `lib/test-mode/liquidity-strategies`), so the columns are
 * comparable and the choice is a choice rather than a preference. Adopting a
 * strategy writes its regime onto the forecast profile, which is the same state
 * the Liquidity desk toolbar and the simulator's swap book read.
 */

import { Fragment, useMemo, useState } from 'react';
import {
  evaluateLiquidityStrategies,
  liquidityStrategyInputFrom,
  strategyForRegime,
  type LiquidityAnalyticsSource,
  type LiquidityStrategyCcy,
  type LiquidityStrategyId,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import {
  DEFAULT_LIQUIDITY_TIMING,
  resolveLiquidityTiming,
} from '@/lib/liquidity-ladder';
import type { ForecastProfileState } from '@/lib/forecast-profile';

interface LiquidityAnalyticsViewProps extends LiquidityAnalyticsSource {
  /** Adopting a strategy writes its regime here. Read-only without it. */
  onForecastProfileChange?: (profile: ForecastProfileState) => void;
}

function fmtK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.5) return '$0K';
  return `${k >= 0 ? '' : '−'}$${Math.abs(k).toFixed(0)}K`;
}

function fmtM(m: number): string {
  if (Math.abs(m) < 0.005) return '—';
  return `${m >= 0 ? '' : '−'}${Math.abs(m).toFixed(2)}M`;
}

const TH = 'py-2 pr-3 font-medium';

export function LiquidityAnalyticsView({
  setup,
  bookRows,
  forecastProfile,
  bookedHedges,
  preparedByCcy,
  ratesScopeId,
  marketRatesByCcy,
  activeLayers,
  livePlanByCcy,
  onForecastProfileChange,
}: LiquidityAnalyticsViewProps) {
  const months = setup.forecastMonths;
  const timing = resolveLiquidityTiming(forecastProfile) ?? DEFAULT_LIQUIDITY_TIMING;
  const liveStrategy = strategyForRegime(
    timing.sizingBasis ?? 'horizon',
    timing.bookingMode ?? 'rolling',
  );

  const input = useMemo(
    () =>
      liquidityStrategyInputFrom({
        setup,
        bookRows,
        forecastProfile,
        bookedHedges,
        preparedByCcy,
        ratesScopeId,
        marketRatesByCcy,
        activeLayers,
        livePlanByCcy,
      }),
    [
      setup,
      bookRows,
      forecastProfile,
      bookedHedges,
      preparedByCcy,
      ratesScopeId,
      marketRatesByCcy,
      activeLayers,
      livePlanByCcy,
    ],
  );
  const rUsd = input.shared.r_USD;
  const results = useMemo(() => evaluateLiquidityStrategies(input), [input]);

  const [selectedId, setSelectedId] = useState<LiquidityStrategyId | null>(null);
  const selected =
    results.find(r => r.strategy.id === selectedId) ??
    results.find(r => r.strategy.id === liveStrategy.id) ??
    results[0];

  const cheapestId = useMemo(() => {
    if (results.length === 0) return null;
    return results.reduce((best, r) =>
      r.netCostUsdYrM < best.netCostUsdYrM ? r : best,
    ).strategy.id;
  }, [results]);

  const adopt = (result: LiquidityStrategyResult) => {
    const regime = result.strategy.regime;
    if (!regime || !onForecastProfileChange || !forecastProfile) return;
    onForecastProfileChange({
      ...forecastProfile,
      liquidity: {
        ...timing,
        sizingBasis: regime.sizingBasis,
        bookingMode: regime.bookingMode,
      },
    });
    setSelectedId(result.strategy.id);
  };

  if (results.length === 0 || !selected) {
    return (
      <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-10 text-center text-xs text-slate-500">
        {months > 0
          ? 'No FCY book to fund — the liquidity path is built from the currency rows on the simulator.'
          : 'Pick a forecast period of 1 month or more: without a cash path there is no trough to cover and nothing to compare.'}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          Funding regime · {months}-cycle dated path
        </div>
        <p className="max-w-[62rem] text-xs leading-relaxed text-slate-400">
          The dated path says how deep the book dips and when. It does not say
          how the dip is covered, and the cover has a price. Each strategy below
          runs over the same ladder and is charged on the same annual interest
          ledger — USD given up to hold the swap book, less interest earned on
          positive FCY balances, plus overdraft paid on negative ones — so the
          only thing that differs between the cards is the funding decision.
          The Live card is the desk&apos;s own strip when one is on the book;
          the other cards are counterfactuals on the same dated path. Cushions
          follow the desk layers, against a USD rate of{' '}
          <span className="font-mono text-slate-300">{rUsd.toFixed(2)}%</span>.
        </p>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {results.map(r => {
          const on = selected.strategy.id === r.strategy.id;
          const isLive = liveStrategy.id === r.strategy.id;
          const short = r.gapToThresholdUsdM < -0.0005;
          return (
            <button
              key={r.strategy.id}
              type="button"
              aria-pressed={on}
              onClick={() => setSelectedId(r.strategy.id)}
              className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3 text-left transition-colors ${
                on
                  ? 'border-sky-500/70 bg-sky-500/[0.07]'
                  : 'border-slate-700 bg-slate-950/40 hover:border-slate-500'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-semibold text-slate-100">
                  {r.strategy.label}
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {isLive && (
                    <span
                      className="rounded bg-sky-500/20 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-sky-200"
                      title="The regime persisted on the forecast profile — what the simulator's swap book is running now"
                    >
                      Live
                    </span>
                  )}
                  {cheapestId === r.strategy.id && (
                    <span
                      className="rounded bg-emerald-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-300"
                      title="Lowest net annual funding cost of the strategies compared"
                    >
                      Cheapest
                    </span>
                  )}
                </span>
              </div>

              <div>
                <div
                  className={`font-mono text-lg font-semibold tabular-nums ${
                    on ? 'text-slate-50' : 'text-slate-300'
                  }`}
                >
                  {fmtK(r.netCostUsdYrM)}
                </div>
                <div className="text-[9px] uppercase tracking-[0.09em] text-slate-600">
                  Net funding cost $/yr
                </div>
              </div>

              <dl className="space-y-0.5 border-t border-slate-800 pt-1.5 font-mono text-[10px] tabular-nums text-slate-500">
                <div className="flex justify-between gap-2">
                  <dt title="USD forgone to hold the FCY swap book over the horizon">
                    USD give-up
                  </dt>
                  <dd className="text-slate-400">{fmtK(r.usdGiveUpUsdYrM)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt title="Interest earned on the positive part of the funded balance">
                    FCY earned
                  </dt>
                  <dd className="text-emerald-300/80">−{fmtK(r.fcyEarnedUsdYrM)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt title="Debit interest on the days the balance is still negative">
                    Overdraft
                  </dt>
                  <dd className={r.odPaidUsdYrM > 0.0005 ? 'text-amber-300/90' : 'text-slate-600'}>
                    {fmtK(r.odPaidUsdYrM)}
                  </dd>
                </div>
              </dl>

              <dl className="space-y-0.5 border-t border-slate-800 pt-1.5 font-mono text-[10px] tabular-nums text-slate-500">
                <div className="flex justify-between gap-2">
                  <dt title="Notional traded today: the spot leg plus anything pre-booked forward">
                    Commit today
                  </dt>
                  <dd className="text-slate-400">
                    {r.committedTodayUsdM > 0.005
                      ? `$${r.committedTodayUsdM.toFixed(1)}M`
                      : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt title="Trades the desk has to put on across the horizon — a trip left to a future cycle is priced at whatever the points are then">
                    Market trips
                  </dt>
                  <dd className="text-slate-400">{r.marketTrips || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt title="Cycles whose low still sits under the cash floor after funding">
                    Below floor
                  </dt>
                  <dd className={r.floorBreaches > 0 ? 'text-amber-300/90' : 'text-slate-600'}>
                    {r.floorBreaches || '—'}
                  </dd>
                </div>
              </dl>

              <p className="text-[10px] leading-snug text-slate-500">
                {r.strategy.summary}
              </p>

              {short && (
                <p
                  className="rounded border border-amber-500/25 bg-amber-500/[0.07] px-1.5 py-1 font-mono text-[9px] text-amber-200/90"
                  title="Deepest shortfall of a cycle low against its own policy cushion H*"
                >
                  Leaves {fmtK(-r.gapToThresholdUsdM)} short of H*
                </p>
              )}
            </button>
          );
        })}
      </div>

      <SelectedStrategyDetail
        result={selected}
        isLive={selected.strategy.id === liveStrategy.id}
        onAdopt={
          selected.strategy.regime && onForecastProfileChange && forecastProfile
            ? () => adopt(selected)
            : undefined
        }
      />
    </div>
  );
}

/**
 * The programme behind the selected card, currency by currency: what the near
 * leg is, how big the book gets, where the funded path troughs, and — opened up
 * — every leg with its value date and the book it rolls onto.
 */
function SelectedStrategyDetail({
  result,
  isLive,
  onAdopt,
}: {
  result: LiquidityStrategyResult;
  isLive: boolean;
  /** Omitted when the strategy is the baseline, or the profile is read-only. */
  onAdopt?: () => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (ccy: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(ccy)) next.add(ccy);
      return next;
    });

  const baseline = result.strategy.regime === null;

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          {result.strategy.label} · by currency
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] text-slate-500">
            net {fmtK(result.netCostUsdYrM)}/yr · peak book $
            {result.peakBookUsdM.toFixed(1)}M
          </span>
          {onAdopt && (
            <button
              type="button"
              disabled={isLive}
              onClick={onAdopt}
              title={
                isLive
                  ? 'Already the live regime'
                  : 'Write this regime onto the forecast profile — the Liquidity desk toolbar and the simulator swap book follow it'
              }
              className={`rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors ${
                isLive
                  ? 'cursor-default border-slate-800 text-slate-600'
                  : 'cursor-pointer border-sky-500/50 text-sky-200 hover:bg-sky-500/10'
              }`}
            >
              {isLive ? 'Running' : 'Adopt this regime'}
            </button>
          )}
        </div>
      </div>
      <p className="mb-3 max-w-[62rem] text-[11px] leading-relaxed text-slate-500">
        {result.strategy.tradeoff}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-500">
              <th className={TH}>CCY</th>
              <th className={TH} title="Near leg for the cycle in front of us (M FCY)">
                Book now
              </th>
              <th className={TH} title="Peak swap notional outstanding over the horizon (M FCY)">
                Peak book
              </th>
              <th className={TH} title="Deepest low on this strategy's funded path (M FCY)">
                Trough
              </th>
              <th className={TH} title="USD forgone to hold the book, per year">
                USD give-up
              </th>
              <th className={TH} title="Interest earned on positive FCY balances, per year">
                FCY earned
              </th>
              <th className={TH} title="Debit interest on the days the balance stays negative">
                Overdraft
              </th>
              <th className={TH} title="USD give-up − FCY earned + overdraft">
                Net $/yr
              </th>
              <th className={TH} title="Deepest shortfall against the cycle's own cushion H*">
                Gap vs H*
              </th>
            </tr>
          </thead>
          <tbody>
            {result.byCcy.map(c => {
              const open = expanded.has(c.ccy);
              const canOpen = c.schedule.length > 0;
              return (
                <Fragment key={c.ccy}>
                  <tr className="border-b border-slate-800/60 font-mono tabular-nums text-slate-300">
                    <td className="py-1.5 pr-3 font-semibold text-slate-200">
                      {canOpen && (
                        <button
                          type="button"
                          onClick={() => toggle(c.ccy)}
                          title={open ? 'Hide the leg schedule' : 'Show every leg, its value date and the book it rolls onto'}
                          className="mr-1.5 w-3 text-slate-500 hover:text-slate-200"
                        >
                          {open ? '▾' : '▸'}
                        </button>
                      )}
                      {c.ccy}
                    </td>
                    <td className={`py-1.5 pr-3 ${c.bookNow > 0.005 ? 'text-sky-200' : 'text-slate-600'}`}>
                      {fmtM(c.bookNow)}
                    </td>
                    <td className="py-1.5 pr-3">{fmtM(c.peakBook)}</td>
                    <td
                      className={`py-1.5 pr-3 ${c.floorBreaches > 0 ? 'text-amber-300/90' : 'text-slate-400'}`}
                      title={
                        c.floorBreaches > 0
                          ? `${c.floorBreaches} of ${c.cycles} cycles low under the cash floor`
                          : 'Every cycle clears the cash floor'
                      }
                    >
                      {fmtM(c.trough)}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-400">{fmtK(c.usdGiveUpUsdYrM)}</td>
                    <td className="py-1.5 pr-3 text-emerald-300/80">
                      {fmtK(c.fcyEarnedUsdYrM)}
                    </td>
                    <td className={`py-1.5 pr-3 ${c.odPaidUsdYrM > 0.0005 ? 'text-amber-300/90' : 'text-slate-600'}`}>
                      {fmtK(c.odPaidUsdYrM)}
                    </td>
                    <td className="py-1.5 pr-3 font-semibold text-slate-100">
                      {fmtK(c.netCostUsdYrM)}
                    </td>
                    <td className={`py-1.5 pr-3 ${c.gapToThreshold < -0.0005 ? 'text-amber-300/90' : 'text-slate-600'}`}>
                      {c.gapToThreshold < -0.0005 ? fmtM(c.gapToThreshold) : 'covered'}
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={9} className="border-b border-slate-800/60 bg-slate-950/60 px-3 py-2">
                        <LegSchedule row={c} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-mono font-semibold tabular-nums text-slate-200">
              <td className="py-2 pr-3 text-slate-400">TOTAL $USD</td>
              <td className="py-2 pr-3">
                {result.bookNowUsdM > 0.005 ? `$${result.bookNowUsdM.toFixed(1)}M` : '—'}
              </td>
              <td className="py-2 pr-3">
                {result.peakBookUsdM > 0.005 ? `$${result.peakBookUsdM.toFixed(1)}M` : '—'}
              </td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3">{fmtK(result.usdGiveUpUsdYrM)}</td>
              <td className="py-2 pr-3 text-emerald-300/80">{fmtK(result.fcyEarnedUsdYrM)}</td>
              <td className="py-2 pr-3">{fmtK(result.odPaidUsdYrM)}</td>
              <td className="py-2 pr-3 text-slate-50">{fmtK(result.netCostUsdYrM)}</td>
              <td className="py-2 pr-3" />
            </tr>
          </tfoot>
        </table>
      </div>

      {baseline && (
        <p className="mt-2 border-t border-slate-800 pt-2 text-[10px] leading-relaxed text-slate-500">
          Nothing is booked on the baseline, so the whole cost is debit interest
          and the requirement stays open. It is here to be beaten: a funded
          programme is only worth its points if it takes more off the overdraft
          line than it adds to the give-up line.
        </p>
      )}
    </section>
  );
}

function LegSchedule({ row }: { row: LiquidityStrategyCcy }) {
  const th =
    'border-b border-slate-800 px-2 py-1 text-right text-[9px] font-semibold uppercase tracking-wide text-slate-500';
  const td = 'border-b border-slate-800/50 px-2 py-0.5 text-right text-slate-400';

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[10px] tabular-nums">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Value date</th>
            <th className={`${th} text-left`}>Trade</th>
            <th className={th} title="Notional this leg adds: + buys FCY to fund the trough, − sells excess back">
              New leg
            </th>
            <th className={th} title="Notional carried in from earlier legs — extended at its far date, not settled">
              Rolled in
            </th>
            <th className={th} title="Notional outstanding once this leg is on">
              Outstanding
            </th>
          </tr>
        </thead>
        <tbody>
          {row.schedule.map(l => (
            <tr key={l.cycleIndex}>
              <td className={`${td} text-left font-semibold text-slate-300`}>
                M{l.valueDateMonths + 1}
              </td>
              <td className={`${td} text-left`}>
                {l.preBookable ? (
                  <span
                    className="rounded bg-sky-500/15 px-1 py-px text-sky-200"
                    title={`Already sized by the path — bookable today as a swap value-dated M${l.valueDateMonths + 1}`}
                  >
                    forward-start
                  </span>
                ) : (
                  <span
                    className="rounded bg-amber-500/15 px-1 py-px text-amber-200"
                    title="The near cycle's trade: spot start, book now"
                  >
                    spot · book now
                  </span>
                )}
              </td>
              <td className={`${td} font-semibold ${l.newLeg > 0 ? 'text-sky-200' : 'text-emerald-300/80'}`}>
                {`${l.newLeg >= 0 ? '+' : '−'}${Math.abs(l.newLeg).toFixed(2)}`}
              </td>
              <td className={td}>
                {Math.abs(l.rolledForward) > 0.001 ? l.rolledForward.toFixed(2) : '—'}
              </td>
              <td className={`${td} font-semibold text-slate-300`}>
                {l.outstanding.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[9px] leading-relaxed text-slate-500">
        Rolling a leg keeps its cash, it does not repay the drain: a drain that
        repeats adds a leg every cycle and the outstanding book grows to the
        horizon&rsquo;s burn. Only a cycle that turns cash-positive retires
        notional — the far date is extended, not settled.
      </p>
    </div>
  );
}
