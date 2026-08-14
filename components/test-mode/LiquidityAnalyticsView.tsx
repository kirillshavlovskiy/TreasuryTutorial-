'use client';

/**
 * Liquidity perspective on Analytics — how the desk covers the dip in the dated
 * cash path under the live sizing/booking regime.
 *
 * The other perspectives measure a risk; this one prices the live funding
 * programme: the desk's current sizing/booking regime, charged on the same
 * interest ledger as the Liquidity desk (see `lib/test-mode/liquidity-strategies`).
 */

import { Fragment, useMemo, useState } from 'react';
import {
  bufferConstraintLabel,
  evaluateLiquidityStrategies,
  liquidityStrategyInputFrom,
  strategyForRegime,
  type LiquidityAnalyticsSource,
  type LiquidityStrategyCcy,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import {
  DEFAULT_LIQUIDITY_TIMING,
  resolveLiquidityTiming,
} from '@/lib/liquidity-ladder';

type LiquidityAnalyticsViewProps = LiquidityAnalyticsSource;

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
  cfarNetByCcyUsd,
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
        cfarNetByCcyUsd,
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
      cfarNetByCcyUsd,
    ],
  );
  const rUsd = input.shared.r_USD;
  const results = useMemo(() => evaluateLiquidityStrategies(input), [input]);
  const selected =
    results.find(r => r.strategy.id === liveStrategy.id) ?? results[0];

  if (results.length === 0 || !selected) {
    return (
      <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-10 text-center text-xs text-slate-500">
        {months > 0
          ? 'No FCY book to fund — the liquidity path is built from the currency rows on the simulator.'
          : 'Pick a forecast period of 1 month or more: without a cash path there is no trough to cover.'}
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
          Each row is a funding regime. Constraint is what sizes H* (VaR,
          Carry, or Balance). Default Carry is the unfunded FX path — the same
          on every regime. Final CFaR is displayed Net CFaR after the FX hedge
          and that regime&apos;s funding-swap bridge. USD rate{' '}
          <span className="font-mono text-slate-300">{rUsd.toFixed(2)}%</span>.
        </p>
      </section>

      <RegimeSummaryTable results={results} liveId={liveStrategy.id} />

      <SelectedStrategyDetail result={selected} />
    </div>
  );
}

function RegimeSummaryTable({
  results,
  liveId,
}: {
  results: readonly LiquidityStrategyResult[];
  liveId: string;
}) {
  return (
    <section className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950/40 p-3">
      <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
        Regime · constraint · default Carry · swap Carry · final CFaR
      </div>
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead>
          <tr className="border-b border-slate-800 text-slate-500">
            <th className={TH}>Regime</th>
            <th className={TH} title="What sizes H* on the desk layers">
              Constraint
            </th>
            <th className={TH} title="Unfunded FX cash carry — same on every regime">
              Default Carry
            </th>
            <th className={TH} title="Rate-diff carry on this regime's book (FCY O/N + USD O/N). Points offset this to 0 at CIP mid.">
              Swap Carry
            </th>
            <th className={TH} title="Displayed Net CFaR: FX hedge + this regime's funding-swap bridge">
              Final CFaR
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map(r => {
            const live = r.strategy.id === liveId;
            return (
              <tr
                key={r.strategy.id}
                className={`border-b border-slate-800/60 font-mono tabular-nums ${
                  live ? 'bg-sky-500/[0.06] text-slate-100' : 'text-slate-300'
                }`}
              >
                <td className="py-1.5 pr-3">
                  <span className="font-semibold text-slate-200">{r.strategy.label}</span>
                  {live && (
                    <span className="ml-2 rounded bg-sky-500/20 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-sky-200">
                      Live
                    </span>
                  )}
                  <div className="text-[10px] font-normal text-slate-500">
                    {r.strategy.summary}
                  </div>
                </td>
                <td className="py-1.5 pr-3">
                  <div className="font-semibold text-slate-100">
                    {bufferConstraintLabel(r.constraint)}
                  </div>
                  <div className="text-[10px] text-slate-500">{r.constraintDetail}</div>
                </td>
                <td
                  className={`py-1.5 pr-3 ${r.cashCarryUsdYrM >= 0 ? 'text-emerald-300/80' : 'text-slate-400'}`}
                >
                  {fmtK(r.cashCarryUsdYrM)}/yr
                </td>
                <td
                  className={`py-1.5 pr-3 ${
                    Math.abs(r.swapInterestUsdYrM) < 0.0005
                      ? 'text-slate-600'
                      : r.swapInterestUsdYrM >= 0 ? 'text-emerald-300/80' : 'text-slate-400'
                  }`}
                  title={`Rate-diff carry ${fmtK(r.swapInterestUsdYrM)} = FCY O/N ${fmtK(r.swapOnUsdYrM)} + USD O/N. Points ${fmtK(r.swapPointsUsdYrM)} offset this to CIP net ${fmtK(r.swapCarryUsdYrM)}.`}
                >
                  {fmtK(r.swapInterestUsdYrM)}/yr
                </td>
                <td className="py-1.5 pr-3 font-semibold text-yellow-200/90">
                  {fmtK(r.finalCfarUsdM)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * The live funding programme, currency by currency: what the near leg is, how
 * big the book gets, where the funded path troughs, and — opened up — every
 * leg with its value date and the book it rolls onto.
 */
function SelectedStrategyDetail({
  result,
}: {
  result: LiquidityStrategyResult;
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
        <span className="font-mono text-[10px] text-slate-500">
          {bufferConstraintLabel(result.constraint)} · default Carry{' '}
          {fmtK(result.cashCarryUsdYrM)}/yr · final CFaR {fmtK(result.finalCfarUsdM)}
        </span>
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
              <th className={TH} title="Unfunded FX cash carry vs USD — no funding swap. Same on every regime.">
                Default Carry
              </th>
              <th className={TH} title="Funding-swap overlay: FCY O/N + USD O/N + swap points. 0 at CIP mid.">
                Swap Carry
              </th>
              <th className={TH} title="−(Cash Carry + Swap Carry) — funding cost $/yr">
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
                    <td
                      className={`py-1.5 pr-3 ${c.cashCarryUsdYrM >= 0 ? 'text-emerald-300/80' : 'text-slate-400'}`}
                      title="Unfunded FX cash carry — does not include the funding swap"
                    >
                      {fmtK(c.cashCarryUsdYrM)}
                    </td>
                    <td
                      className={`py-1.5 pr-3 ${
                        Math.abs(c.swapInterestUsdYrM) < 0.0005
                          ? 'text-slate-600'
                          : c.swapInterestUsdYrM >= 0 ? 'text-emerald-300/80' : 'text-slate-400'
                      }`}
                      title={`Rate-diff ${fmtK(c.swapInterestUsdYrM)} = FCY O/N ${fmtK(c.swapOnUsdYrM)} + USD O/N. Points ${fmtK(c.swapPointsUsdYrM)} offset to CIP net ${fmtK(c.swapCarryUsdYrM)}.`}
                    >
                      {fmtK(c.swapInterestUsdYrM)}
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
                      <td colSpan={8} className="border-b border-slate-800/60 bg-slate-950/60 px-3 py-2">
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
              <td className="py-2 pr-3">{fmtK(result.cashCarryUsdYrM)}</td>
              <td className="py-2 pr-3">{fmtK(result.swapInterestUsdYrM)}</td>
              <td className="py-2 pr-3 text-slate-50">{fmtK(result.netCostUsdYrM)}</td>
              <td className="py-2 pr-3" />
            </tr>
          </tfoot>
        </table>
      </div>

      {baseline && (
        <p className="mt-2 border-t border-slate-800 pt-2 text-[10px] leading-relaxed text-slate-500">
          Nothing is booked on the baseline, so Swap Carry is zero and the
          number is unfunded Cash Carry only. A funded programme adds the
          swap overlay on top — at CIP mid that overlay nets to zero, and the
          requirement is what the strip actually covers.
        </p>
      )}
    </section>
  );
}

function LegSchedule({ row }: { row: LiquidityStrategyCcy }) {
  const th =
    'border-b border-slate-800 px-2 py-1 text-right text-[9px] font-semibold uppercase tracking-wide text-slate-500';
  const td = 'border-b border-slate-800/50 px-2 py-0.5 text-right text-slate-400';
  const tot = row.schedule.reduce(
    (s, l) => ({
      fcy: s.fcy + l.fcyOnUsdYr,
      usd: s.usd + l.usdOnUsdYr,
      pts: s.pts + l.pointsUsdYr,
      net: s.net + l.interestUsdYr,
    }),
    { fcy: 0, usd: 0, pts: 0, net: 0 },
  );

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
            <th className={th} title="FCY overnight on this new leg, $K/yr">
              FCY O/N
            </th>
            <th className={th} title="Opposite USD overnight on this new leg, $K/yr">
              USD O/N
            </th>
            <th className={th} title="CIP mid points on the swap (near→far tenor). Every funding leg is a swap.">
              Points
            </th>
            <th className={th} title="Rate-diff carry (FCY O/N + USD O/N). Points offset this to 0 at CIP mid.">
              Leg carry
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
                    title={`FX swap booked today, near leg value-dated M${l.valueDateMonths + 1}. Has swap points.`}
                  >
                    fwd-start swap
                  </span>
                ) : (
                  <span
                    className="rounded bg-amber-500/15 px-1 py-px text-amber-200"
                    title="FX swap booked today: near leg at spot, far leg rolled or repaid. Has swap points — not a spot outright."
                  >
                    spot-start swap
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
              <td className={td}>{fmtK(l.fcyOnUsdYr)}</td>
              <td className={td}>{fmtK(l.usdOnUsdYr)}</td>
              <td className={td}>{fmtK(l.pointsUsdYr)}</td>
              <td
                className={`${td} font-semibold ${
                  Math.abs(l.interestUsdYr) < 0.0005
                    ? 'text-slate-600'
                    : l.interestUsdYr >= 0 ? 'text-emerald-300/80' : 'text-rose-300/80'
                }`}
                title={`Spot-start swap: FCY O/N ${fmtK(l.fcyOnUsdYr)} + USD O/N ${fmtK(l.usdOnUsdYr)} = ${fmtK(l.interestUsdYr)}/yr. Points ${fmtK(l.pointsUsdYr)} offset to CIP net ${fmtK(l.netUsdYr)}.`}
              >
                {fmtK(l.interestUsdYr)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold text-slate-300">
            <td className={`${td} text-left text-slate-500`} colSpan={5}>
              Σ new-leg overlay
            </td>
            <td className={td}>{fmtK(tot.fcy)}</td>
            <td className={td}>{fmtK(tot.usd)}</td>
            <td className={td}>{fmtK(tot.pts)}</td>
            <td className={`${td} text-slate-200`}>{fmtK(tot.net)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="mt-1.5 text-[9px] leading-relaxed text-slate-500">
        Every funding leg is an FX swap (near + far), not a spot outright.
        M1 is a spot-starting swap — near today, far rolled or repaid — so it
        has points. Forward-start legs are the same instrument, value-dated
        later. Leg carry is the rate differential; points offset it at CIP mid.
      </p>
    </div>
  );
}
