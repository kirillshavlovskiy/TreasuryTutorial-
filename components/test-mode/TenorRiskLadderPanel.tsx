'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { UTCTimestamp } from 'lightweight-charts';
import type { RowState } from '@/lib/fx-buffer';
import { usdMarketPair, type FxMarketRatesBundle } from '@/lib/fx-market-rates';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import {
  PNL_METRIC_OPTIONS,
  PNL_STACK_LAYERS,
  RESIDUAL_LEG_ID,
  buildLegPnlBundle,
  buildTenorPnlBundle,
  candlesToLw,
  cumulativePnlStackK,
  formatAsOf,
  liveHedgeLegsForCcy,
  marketQuoteToUsdPerFcy,
  nearestCandleIndex,
  pnlMetricValue,
  revalueLadderAtSpot,
  type TenorPnlMetric,
  type TenorPnlSnapshot,
} from '@/lib/test-mode/tenor-pnl-series';
import type {
  TenorRiskLadderId,
  TenorRiskLadderPoint,
} from '@/lib/test-mode/tenor-risk-ladder';
import { DeskLwChart } from '@/components/test-mode/DeskLwChart';
import { useSpotDayCandles } from '@/components/test-mode/useSpotDayCandles';

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

function fmtSignedK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-7) return '$0K';
  const sign = usdM >= 0 ? '+' : '−';
  const k = Math.abs(usdM) * 1000;
  const body = k >= 10 ? k.toFixed(0) : k.toFixed(1);
  return `${sign}$${body}K`;
}

function pairPriceFormat(ccy: string): { precision: number; minMove: number } {
  return ccy.toUpperCase() === 'JPY'
    ? { precision: 3, minMove: 0.001 }
    : { precision: 5, minMove: 0.00001 };
}

function candleTimeSec(tMs: number): UTCTimestamp {
  return Math.floor(tMs / 1000) as UTCTimestamp;
}

function metricLabel(id: TenorPnlMetric): string {
  return PNL_METRIC_OPTIONS.find(o => o.id === id)?.label ?? id;
}

function legLabel(ticket: HedgeTicket): string {
  const tenor = ticket.maturityLabel ?? ticket.maturity ?? 'Cash';
  const n = ticket.amountLocalM;
  const sign = n >= 0 ? '+' : '−';
  return `${tenor} · ${sign}${Math.abs(n).toFixed(1)}M · ${ticket.instrument}`;
}

export function TenorRiskLadderPanel({
  ccy,
  points,
  confidencePct,
  row,
  bookedHedges = [],
  marketRates = null,
}: {
  ccy: string;
  points: readonly TenorRiskLadderPoint[];
  confidencePct: number;
  row: RowState;
  bookedHedges?: readonly HedgeTicket[];
  marketRates?: FxMarketRatesBundle | null;
}) {
  const { candles, pair, loading } = useSpotDayCandles(ccy);
  const [tenorId, setTenorId] = useState<TenorRiskLadderId>('1m');
  const [metric, setMetric] = useState<TenorPnlMetric>('stacked');
  const [legId, setLegId] = useState<string>(RESIDUAL_LEG_ID);
  const [asOfIndex, setAsOfIndex] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<UTCTimestamp | null>(null);

  useEffect(() => {
    setAsOfIndex(null);
    setHoverTime(null);
    setTenorId('1m');
    setMetric('stacked');
    setLegId(RESIDUAL_LEG_ID);
  }, [ccy]);

  useEffect(() => {
    if (asOfIndex == null) return;
    if (candles.length === 0) {
      setAsOfIndex(null);
      return;
    }
    if (asOfIndex >= candles.length) setAsOfIndex(candles.length - 1);
  }, [asOfIndex, candles.length]);

  const tenorIds = useMemo(() => points.map(p => p.id), [points]);
  const selectedTenor: TenorRiskLadderId = tenorIds.includes(tenorId)
    ? tenorId
    : tenorIds.includes('1m')
      ? '1m'
      : (tenorIds[0] ?? 'cash');
  const livePoint =
    points.find(p => p.id === selectedTenor) ?? points[0]!;

  const legs = useMemo(
    () => liveHedgeLegsForCcy(bookedHedges, ccy),
    [bookedHedges, ccy],
  );
  useEffect(() => {
    if (legId !== RESIDUAL_LEG_ID && !legs.some(t => t.id === legId)) {
      setLegId(RESIDUAL_LEG_ID);
    }
  }, [legId, legs]);
  const selectedLeg =
    legId === RESIDUAL_LEG_ID
      ? null
      : (legs.find(t => t.id === legId) ?? null);

  const lastBar = candles[candles.length - 1] ?? null;
  const asOfBar =
    asOfIndex != null && candles[asOfIndex] ? candles[asOfIndex]! : lastBar;
  const isLive = asOfIndex == null || asOfIndex === candles.length - 1;

  const displayedPoints = useMemo(() => {
    if (isLive || !asOfBar || !lastBar) return points;
    const spotUsdAt = marketQuoteToUsdPerFcy(asOfBar.close, ccy);
    const spotUsdNow = marketQuoteToUsdPerFcy(lastBar.close, ccy);
    if (!(spotUsdAt > 0) || !(spotUsdNow > 0)) return points;
    return revalueLadderAtSpot({
      points,
      spotUsdAt,
      spotUsdNow,
      ccy,
      rFcyPct: row.r_FCY,
      marketRates,
    });
  }, [isLive, asOfBar, lastBar, points, ccy, row.r_FCY, marketRates]);

  const snapshots = useMemo((): TenorPnlSnapshot[] => {
    if (candles.length === 0) return [];
    if (selectedLeg) {
      return buildLegPnlBundle({
        ticket: selectedLeg,
        candles,
        ccy,
        rFcyPct: row.r_FCY,
        marketRates,
      }).snapshots;
    }
    return buildTenorPnlBundle({
      point: livePoint,
      candles,
      ccy,
      tenorMonths: livePoint.months,
      rFcyPct: row.r_FCY,
      marketRates,
    }).snapshots;
  }, [candles, livePoint, ccy, row.r_FCY, marketRates, selectedLeg]);

  const pairName = pair ?? usdMarketPair(ccy);
  const lwCandles = useMemo(() => candlesToLw(candles), [candles]);
  const asOfMarker: UTCTimestamp | null = asOfBar
    ? candleTimeSec(asOfBar.t)
    : null;
  const markerTime = hoverTime ?? (isLive ? null : asOfMarker);
  const kPnl = useMemo(() => {
    if (snapshots.length === 0) return [];
    const pick = metric === 'stacked' ? 'total' : metric;
    const base = pnlMetricValue(snapshots[0]!, pick);
    return snapshots.map(s => ({
      time: s.time,
      value: (pnlMetricValue(s, pick) - base) * 1000,
    }));
  }, [snapshots, metric]);
  const stackBars = useMemo(
    () => cumulativePnlStackK(snapshots),
    [snapshots],
  );

  const headline =
    displayedPoints.find(p => p.id === '1y')
    ?? displayedPoints[displayedPoints.length - 1]!;
  const COL_H = 108;
  const maxBar = Math.max(
    0.001,
    ...displayedPoints.map(
      p =>
        p.residualVarUsdM + p.residualCfarUsdM + Math.abs(p.totalPnlUsdM),
    ),
  );
  const barH = (usdM: number) =>
    Math.max(usdM > 1e-12 ? 2 : 0, Math.round((Math.abs(usdM) / maxBar) * COL_H));

  const sliderMax = Math.max(0, candles.length - 1);
  const sliderValue = asOfIndex ?? sliderMax;
  const asOfLabel =
    isLive || !asOfBar ? 'Live' : formatAsOf(asOfBar.t);

  const commitIndex = (idx: number) => {
    if (candles.length === 0) {
      setAsOfIndex(null);
      return;
    }
    const clamped = Math.max(0, Math.min(idx, candles.length - 1));
    setAsOfIndex(clamped >= candles.length - 1 ? null : clamped);
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Residual VaR"
          value={fmtVarK(headline.residualVarUsdM)}
          hint={`${ccy} · ${headline.label} · ${confidencePct}%`}
          accent
        />
        <Stat
          label="Residual CFaR"
          value={fmtVarK(headline.residualCfarUsdM)}
          hint="Net critical cash through this tenor"
        />
        <Stat
          label="Total P&L accrued"
          value={fmtSignedK(headline.totalPnlUsdM)}
          hint={`Cash carry ${fmtSignedK(headline.cashCarryUsdM)} · M2M ${fmtSignedK(headline.m2mUsdM)}`}
        />
        <Stat
          label="Delta · 1% spot"
          value={fmtSignedK(headline.deltaUsdPerPct)}
          hint={`Gamma ${fmtSignedK(headline.gammaUsdPerPctSq)} · Vega ${fmtSignedK(headline.vegaUsdPerVolPt)} · DV01 ${fmtSignedK(headline.dv01Usd)}`}
        />
      </div>

      <section className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
              {ccy} tenor ladder
            </div>
            <p className="mt-1 text-[10px] text-slate-500">
              Residual VaR / CFaR and accrued P&L after the live hedge book.
              Delta = USD P&L for +1% FCY. Gamma = Total P&L convexity for a
              ±1% spot bump. Vega = residual VaR per +1 vol point. DV01 = +1bp
              rates. Pick a tenor, a P&amp;L component or All stacked (Cash
              carry + M2M), and a non-settled leg.
            </p>
          </div>
          {!isLive && (
            <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-200">
              as of {asOfLabel}
            </span>
          )}
        </div>

        <div className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
          <div className="flex min-w-0 flex-col gap-3">
            <ChartPane
              title={`${pairName} spot`}
              empty={
                loading
                  ? 'Loading tape…'
                  : lwCandles.length === 0
                    ? 'No tape for this pair yet.'
                    : null
              }
            >
              {lwCandles.length > 0 && (
                <DeskLwChart
                  kind="candlestick"
                  candles={lwCandles}
                  height={220}
                  priceFormat={pairPriceFormat(ccy)}
                  markerTime={markerTime}
                  onHoverTime={setHoverTime}
                  onClickTime={t => {
                    if (t == null) return;
                    commitIndex(nearestCandleIndex(candles, Number(t)));
                  }}
                  seriesKey={`spot:${ccy}`}
                  scale="fit"
                  fitOnLoad
                  showControlBar
                  autoInterval={false}
                  currentInterval={60}
                />
              )}
            </ChartPane>
            <ChartPane
              title={
                metric === 'stacked'
                  ? `Cumulative P&L stack ($K)${selectedLeg ? ` · ${legLabel(selectedLeg)}` : ' · residual'}`
                  : `Cumulative ${metricLabel(metric)} ($K)${selectedLeg ? ` · ${legLabel(selectedLeg)}` : ' · residual'}`
              }
              empty={
                loading
                  ? 'Loading tape…'
                  : snapshots.length === 0
                    ? 'No P&L history for this selection yet.'
                    : null
              }
            >
              {metric === 'stacked'
                ? stackBars.length > 0 && (
                    <StackedPnlChart
                      bars={stackBars}
                      height={220}
                      markerTime={markerTime}
                      onHoverTime={setHoverTime}
                      onClickTime={t => {
                        if (t == null) return;
                        commitIndex(nearestCandleIndex(candles, Number(t)));
                      }}
                    />
                  )
                : kPnl.length > 0 && (
                    <DeskLwChart
                      kind="histogram"
                      line={kPnl}
                      height={220}
                      priceFormat={{ precision: 1, minMove: 0.1 }}
                      zeroPrice={0}
                      zeroLineTitle="0"
                      markerTime={markerTime}
                      onHoverTime={setHoverTime}
                      onClickTime={t => {
                        if (t == null) return;
                        commitIndex(nearestCandleIndex(candles, Number(t)));
                      }}
                      seriesKey={`pnl:${ccy}:${livePoint.id}:${metric}:${legId}`}
                      fitOnLoad
                    />
                  )}
            </ChartPane>
          </div>

          <aside className="flex min-w-0 flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <ChipGroup
              label="Tenor"
              stacked
              value={selectedTenor}
              options={points.map(p => ({
                id: p.id,
                label: p.id === 'cash' ? 'Cash' : p.id,
              }))}
              onChange={id => setTenorId(id as TenorRiskLadderId)}
            />
            <ChipGroup
              label="P&L component"
              stacked
              value={metric}
              options={PNL_METRIC_OPTIONS}
              onChange={id => setMetric(id as TenorPnlMetric)}
            />
            <label className="flex flex-col gap-1.5 text-[10px] text-slate-500">
              Leg (non-settled)
              <select
                value={selectedLeg ? selectedLeg.id : RESIDUAL_LEG_ID}
                onChange={e => setLegId(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[10px] text-slate-200"
              >
                <option value={RESIDUAL_LEG_ID}>Residual book</option>
                {legs.map(t => (
                  <option key={t.id} value={t.id}>
                    {legLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-auto space-y-2 border-t border-slate-800 pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-slate-500">As-of</span>
                <span className="font-mono text-[10px] tabular-nums text-slate-400">
                  {asOfLabel}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAsOfIndex(null)}
                  className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                    isLive
                      ? 'bg-emerald-500/20 text-emerald-200'
                      : 'border border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Live
                </button>
                <input
                  type="range"
                  min={0}
                  max={sliderMax}
                  step={1}
                  value={sliderValue}
                  disabled={candles.length < 2}
                  onInput={e => commitIndex(Number(e.currentTarget.value))}
                  onChange={e => commitIndex(Number(e.currentTarget.value))}
                  className="min-w-0 flex-1 accent-sky-400"
                  aria-label="Roll back as-of time"
                />
              </div>
              <p className="text-[10px] leading-relaxed text-slate-600">
                Scrub to revalue Cash vs outright tenor P&amp;L at that spot.
                Hedges and flows stay at the current book.
              </p>
            </div>
          </aside>
        </div>

        <div className="mt-3 grid gap-1" style={{ gridTemplateColumns: `repeat(${displayedPoints.length}, minmax(0, 1fr))` }}>
          {displayedPoints.map(t => {
            const varH = barH(t.residualVarUsdM);
            const cfarH = barH(t.residualCfarUsdM);
            const pnlH = barH(t.totalPnlUsdM);
            const layers = [
              pnlH > 0
                ? {
                    key: 'pnl',
                    h: pnlH,
                    className:
                      t.totalPnlUsdM >= 0 ? 'bg-emerald-400/85' : 'bg-sky-400/80',
                    title: `P&L ${fmtSignedK(t.totalPnlUsdM)} · cash ${fmtSignedK(t.cashCarryUsdM)} · M2M ${fmtSignedK(t.m2mUsdM)}`,
                  }
                : null,
              cfarH > 0
                ? {
                    key: 'cfar',
                    h: cfarH,
                    className: 'bg-amber-300/85',
                    title: `Resid CFaR ${fmtVarK(t.residualCfarUsdM)}`,
                  }
                : null,
              varH > 0
                ? {
                    key: 'var',
                    h: varH,
                    className: 'bg-rose-400/85',
                    title: `Resid VaR ${fmtVarK(t.residualVarUsdM)}`,
                  }
                : null,
            ].filter((x): x is NonNullable<typeof x> => x != null);
            const selected = t.id === selectedTenor;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTenorId(t.id)}
                className={`flex flex-col items-center rounded-md px-0.5 py-1 ${
                  selected ? 'bg-violet-500/15' : ''
                }`}
                title={`${ccy} ${t.label}: resid VaR ${fmtVarK(t.residualVarUsdM)} · CFaR ${fmtVarK(t.residualCfarUsdM)} · P&L ${fmtSignedK(t.totalPnlUsdM)}`}
              >
                <div className="mb-1 flex min-h-[2.25rem] flex-col items-center justify-end gap-0.5 font-mono text-[9px] tabular-nums leading-none">
                  <span className="text-rose-300/90">
                    {fmtVarK(t.residualVarUsdM)}
                  </span>
                  <span className="text-amber-300/90">
                    {fmtVarK(t.residualCfarUsdM)}
                  </span>
                </div>
                <div className="flex h-[108px] w-full items-end justify-center border-b border-slate-700/80">
                  <div className="flex h-full w-4 flex-col justify-end sm:w-5">
                    {layers.map((layer, i) => (
                      <div
                        key={layer.key}
                        className={`w-full ${layer.className} ${
                          i === 0 ? 'rounded-t-sm' : ''
                        }`}
                        style={{ height: layer.h }}
                        title={layer.title}
                      />
                    ))}
                  </div>
                </div>
                <span
                  className={`mt-1 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-[10px] font-semibold ${
                    selected ? 'text-violet-200' : 'text-slate-400'
                  }`}
                >
                  {t.id}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-rose-400/85" />
            Resid VaR
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-amber-300/85" />
            Resid CFaR
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-emerald-400/85" />
            Total P&L (cash + M2M)
          </span>
        </div>
      </section>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full min-w-[860px] text-left text-[10px]">
          <thead>
            <tr className="border-b border-slate-800 text-slate-500">
              <th className="px-3 py-2 font-medium">
                Tenor
                {!isLive && (
                  <span className="ml-1.5 font-normal text-amber-300/80">
                    as of {asOfLabel}
                  </span>
                )}
              </th>
              <th
                className="px-3 py-2 font-medium text-rose-300/80"
                title="Unmatched-book VaR at this horizon"
              >
                Resid VaR
              </th>
              <th
                className="px-3 py-2 font-medium text-amber-300/80"
                title="Net critical cash through this tenor"
              >
                Resid CFaR
              </th>
              <th
                className="px-3 py-2 font-medium text-sky-300/80"
                title="FX mark of unmatched residual (swap points / CIP)"
              >
                M2M
              </th>
              <th
                className="px-3 py-2 font-medium"
                title="USD P&L for +1% FCY vs USD"
              >
                Δ 1%
              </th>
              <th
                className="px-3 py-2 font-medium"
                title="Total P&L convexity for a ±1% spot bump"
              >
                Gamma
              </th>
              <th
                className="px-3 py-2 font-medium"
                title="Residual VaR change for +1 vol point"
              >
                Vega
              </th>
              <th
                className="px-3 py-2 font-medium"
                title="USD P&L for +1bp rates (Cash: IR book + overnight Cash FX)"
              >
                DV01
              </th>
              <th className="px-3 py-2 font-medium">Total P&L</th>
              <th
                className="px-3 py-2 font-medium text-emerald-300/80"
                title="Cash interest earned on the cash path"
              >
                Cash carry
              </th>
            </tr>
          </thead>
          <tbody>
            {displayedPoints.map(t => {
              const selected = t.id === selectedTenor;
              return (
                <tr
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setTenorId(t.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setTenorId(t.id);
                    }
                  }}
                  className={`cursor-pointer border-b border-slate-800/80 hover:bg-slate-800/40 ${
                    selected ? 'bg-violet-500/10' : ''
                  }`}
                >
                  <td className="px-3 py-2 font-semibold text-slate-200">
                    {t.id === 'cash' ? 'Cash' : t.id}
                    <span className="ml-1.5 font-normal text-slate-500">
                      {t.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono font-semibold text-rose-300">
                    {fmtVarK(t.residualVarUsdM)}
                  </td>
                  <td className="px-3 py-2 font-mono text-amber-300">
                    {fmtVarK(t.residualCfarUsdM)}
                  </td>
                  <td className="px-3 py-2 font-mono text-sky-300">
                    {fmtSignedK(t.m2mUsdM)}
                  </td>
                  <td className="px-3 py-2 font-mono text-fuchsia-300">
                    {fmtSignedK(t.deltaUsdPerPct)}
                  </td>
                  <td className="px-3 py-2 font-mono text-cyan-300">
                    {fmtSignedK(t.gammaUsdPerPctSq)}
                  </td>
                  <td className="px-3 py-2 font-mono text-violet-300">
                    {fmtSignedK(t.vegaUsdPerVolPt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-orange-300">
                    {fmtSignedK(t.dv01Usd)}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono font-semibold ${
                      t.totalPnlUsdM >= 0 ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {fmtSignedK(t.totalPnlUsdM)}
                  </td>
                  <td className="px-3 py-2 font-mono text-emerald-300/90">
                    {fmtSignedK(t.cashCarryUsdM)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        Rows are Cash (spot / t=0) then Analytics VaR chips (1w–1y). Residual
        VaR uses the same unmatched-book engine as Hedging Decision. Residual
        CFaR is the closed-form net critical cash to that tenor. M2M is the
        unmatched FX mark (swap points when a curve is loaded, otherwise CIP;
        Cash is spot so M2M is 0). Delta / Gamma / Vega / DV01 are residual
        sensitivities — Cash also carries IR-book and overnight Cash FX DV01.
        Rate and P&amp;L charts reconstruct the last 48h of tape at the current
        book. Controls on the right pick tenor, P&amp;L component (or All
        stacked) and non-settled leg. Total P&L and Cash carry sit on the right
        of the table.
      </p>
    </>
  );
}

const STACK_PAD = { l: 44, r: 10, t: 12, b: 28 } as const;

function downsampleBars<T>(bars: readonly T[], max: number): T[] {
  if (bars.length <= max) return [...bars];
  const out: T[] = [];
  const step = (bars.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(bars[Math.min(bars.length - 1, Math.round(i * step))]!);
  }
  out[out.length - 1] = bars[bars.length - 1]!;
  return out;
}

function fmtAxisK(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 0.05) return '0';
  const sign = v >= 0 ? '' : '−';
  const a = Math.abs(v);
  const body = a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(1);
  return `${sign}${body}`;
}

function StackedPnlChart({
  bars,
  height,
  markerTime,
  onHoverTime,
  onClickTime,
}: {
  bars: readonly { time: UTCTimestamp; carry: number; m2m: number }[];
  height: number;
  markerTime: UTCTimestamp | null;
  onHoverTime: (t: UTCTimestamp | null) => void;
  onClickTime: (t: UTCTimestamp | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [width, setWidth] = useState(640);
  const plot = useMemo(() => downsampleBars(bars, 420), [bars]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth;
      if (next > 0) setWidth(next);
    });
    ro.observe(el);
    if (el.clientWidth > 0) setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const n = plot.length;
  const maxAbs = useMemo(() => {
    let m = 1e-6;
    for (const b of plot) {
      const pos = Math.max(0, b.carry) + Math.max(0, b.m2m);
      const neg = Math.max(0, -b.carry) + Math.max(0, -b.m2m);
      m = Math.max(m, pos, neg);
    }
    return m;
  }, [plot]);
  const markerIdx = useMemo(() => {
    if (markerTime == null || n === 0) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(Number(plot[i]!.time) - Number(markerTime));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }, [markerTime, plot, n]);
  const activeIdx = hoverIdx ?? markerIdx;

  const indexFromClientX = useCallback(
    (clientX: number) => {
      const el = wrapRef.current;
      if (!el || n === 0) return 0;
      const rect = el.getBoundingClientRect();
      const innerW = Math.max(1, rect.width - STACK_PAD.l - STACK_PAD.r);
      const x = clientX - rect.left - STACK_PAD.l;
      const i = Math.round((x / innerW) * (n - 1));
      return Math.max(0, Math.min(n - 1, i));
    },
    [n],
  );

  const w = Math.max(240, width);
  const innerW = w - STACK_PAD.l - STACK_PAD.r;
  const innerH = height - STACK_PAD.t - STACK_PAD.b;
  const zeroY = STACK_PAD.t + innerH / 2;
  const yOf = (v: number) => zeroY - (v / maxAbs) * (innerH / 2);
  const slot = n > 0 ? innerW / n : innerW;
  const barW = Math.max(0.6, slot * 0.82);
  const layers = PNL_STACK_LAYERS;
  const active = activeIdx != null ? plot[activeIdx] : null;

  const rects: {
    key: string;
    x: number;
    y: number;
    h: number;
    color: string;
  }[] = [];
  for (let i = 0; i < n; i++) {
    const b = plot[i]!;
    const x = STACK_PAD.l + i * slot + (slot - barW) / 2;
    let pos = 0;
    let neg = 0;
    for (const layer of layers) {
      const v = layer.id === 'carryOnly' ? b.carry : b.m2m;
      if (!Number.isFinite(v) || v === 0) continue;
      if (v > 0) {
        const y0 = yOf(pos + v);
        const y1 = yOf(pos);
        const h = y1 - y0;
        if (Number.isFinite(y0) && Number.isFinite(h) && h > 0) {
          rects.push({
            key: `${i}-${layer.id}`,
            x,
            y: y0,
            h,
            color: layer.color,
          });
        }
        pos += v;
      } else {
        const y0 = yOf(neg);
        const y1 = yOf(neg + v);
        const h = y1 - y0;
        if (Number.isFinite(y0) && Number.isFinite(h) && h > 0) {
          rects.push({
            key: `${i}-${layer.id}`,
            x,
            y: y0,
            h,
            color: layer.color,
          });
        }
        neg += v;
      }
    }
  }

  return (
    <div className="relative" style={{ height }}>
      <div
        ref={wrapRef}
        className="h-full w-full"
        onMouseMove={e => {
          const i = indexFromClientX(e.clientX);
          setHoverIdx(i);
          onHoverTime(plot[i]?.time ?? null);
        }}
        onMouseLeave={() => {
          setHoverIdx(null);
          onHoverTime(null);
        }}
        onClick={e => {
          const i = indexFromClientX(e.clientX);
          onClickTime(plot[i]?.time ?? null);
        }}
      >
        <svg
          width={w}
          height={height}
          className="block cursor-crosshair"
        >
          <line
            x1={STACK_PAD.l}
            x2={w - STACK_PAD.r}
            y1={zeroY}
            y2={zeroY}
            stroke="#334155"
            strokeWidth="1"
          />
          <text
            x={STACK_PAD.l - 6}
            y={STACK_PAD.t + 8}
            textAnchor="end"
            fill="#64748b"
            fontSize="9"
            fontFamily="ui-monospace, monospace"
          >
            {fmtAxisK(maxAbs)}
          </text>
          <text
            x={STACK_PAD.l - 6}
            y={zeroY + 3}
            textAnchor="end"
            fill="#64748b"
            fontSize="9"
            fontFamily="ui-monospace, monospace"
          >
            0
          </text>
          <text
            x={STACK_PAD.l - 6}
            y={height - STACK_PAD.b}
            textAnchor="end"
            fill="#64748b"
            fontSize="9"
            fontFamily="ui-monospace, monospace"
          >
            {fmtAxisK(-maxAbs)}
          </text>
          {rects.map(r => (
            <rect
              key={r.key}
              x={r.x}
              y={r.y}
              width={barW}
              height={r.h}
              fill={r.color}
              opacity={0.92}
            />
          ))}
          {activeIdx != null && n > 0 && (
            <line
              x1={STACK_PAD.l + activeIdx * slot + slot / 2}
              x2={STACK_PAD.l + activeIdx * slot + slot / 2}
              y1={STACK_PAD.t}
              y2={height - STACK_PAD.b}
              stroke="#fbbf24"
              strokeWidth="1"
              opacity={0.85}
            />
          )}
        </svg>
      </div>
      <div className="pointer-events-none absolute bottom-1 left-12 right-2 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
        {layers.map(layer => (
          <span key={layer.id} className="inline-flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ background: layer.color }}
            />
            {layer.label}
          </span>
        ))}
        {active && (
          <span className="ml-auto font-mono tabular-nums text-slate-400">
            carry {fmtSignedK(active.carry / 1000)} · M2M{' '}
            {fmtSignedK(active.m2m / 1000)} · Σ{' '}
            {fmtSignedK((active.carry + active.m2m) / 1000)}
          </span>
        )}
      </div>
    </div>
  );
}

function ChipGroup({
  label,
  value,
  options,
  onChange,
  stacked,
}: {
  label: string;
  value: string;
  options: readonly { id: string; label: string }[];
  onChange: (id: string) => void;
  stacked?: boolean;
}) {
  return (
    <div
      className={stacked ? 'flex flex-col gap-1.5' : 'inline-flex flex-wrap items-center gap-1'}
      role="group"
      aria-label={label}
    >
      <span className={`${stacked ? '' : 'pr-1'} text-[10px] text-slate-500`}>
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {options.map(opt => {
          const on = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChange(opt.id)}
              className={`rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                on
                  ? 'bg-violet-500/25 text-violet-100 shadow-sm'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChartPane({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/60">
      <div className="border-b border-slate-800 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-slate-500">
        {title}
      </div>
      {empty ? (
        <p className="px-3 py-10 text-center text-[10px] text-slate-500">{empty}</p>
      ) : (
        children
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        accent
          ? 'border-emerald-600/40 bg-emerald-500/10'
          : 'border-slate-800 bg-slate-950/50'
      }`}
    >
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${accent ? 'text-emerald-300' : ''}`}>
        {value}
      </div>
      <div className="text-[10px] text-slate-600">{hint}</div>
    </div>
  );
}
