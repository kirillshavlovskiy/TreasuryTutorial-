/**
 * Reconstruct Rate / P&L time series for the tenor ladder by revaluing the
 * current book at each historical spot close. Residual local notionals stay
 * fixed — no VaR engine re-run per candle.
 */

import { CURRENCY_PARAMS } from '@/lib/fx-buffer';
import {
  interpolateSwapPoints,
  isUsdPerFcyQuoted,
  swapPointsToPriceDelta,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { analyticsSpotUsd } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  isLiveHedgeTicket,
  settleMonthsFromHedgeTicket,
  type HedgeTicket,
} from '@/lib/test-mode/hedge-var';
import type { SpotDayCandle } from '@/lib/test-mode/tape-candles';
import {
  gammaUsdPerPctSqAt,
  m2mUsdMAt,
  type TenorRiskLadderId,
  type TenorRiskLadderPoint,
} from '@/lib/test-mode/tenor-risk-ladder';
import { type VarHorizonId } from '@/lib/test-mode/var-setup';
import type { UTCTimestamp } from 'lightweight-charts';

export type TenorLinePt = { time: UTCTimestamp; value: number };
export type TenorCandlePt = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type TenorPnlMetric =
  | 'stacked'
  | 'total'
  | 'delta'
  | 'gamma'
  | 'vega'
  | 'rho'
  | 'carryOnly'
  | 'm2mOnly';

export type TenorPnlSnapshot = {
  time: UTCTimestamp;
  total: number;
  delta: number;
  gamma: number;
  vega: number;
  rho: number;
  carryOnly: number;
  m2mOnly: number;
};

/** Additive P&L stack: Cash carry + M2M = Total. Greeks stay single-metric. */
export const PNL_STACK_LAYERS: {
  id: Extract<TenorPnlMetric, 'carryOnly' | 'm2mOnly'>;
  label: string;
  color: string;
}[] = [
  { id: 'carryOnly', label: 'Cash carry', color: '#34d399' },
  { id: 'm2mOnly', label: 'M2M', color: '#38bdf8' },
];

export const PNL_METRIC_OPTIONS: {
  id: TenorPnlMetric;
  label: string;
}[] = [
  { id: 'stacked', label: 'All stacked' },
  { id: 'total', label: 'Total P&L' },
  { id: 'delta', label: 'Delta (Duration)' },
  { id: 'gamma', label: 'Gamma (Convexity)' },
  { id: 'vega', label: 'Vega' },
  { id: 'rho', label: 'Rho (DV01)' },
  { id: 'carryOnly', label: 'Cash carry only' },
  { id: 'm2mOnly', label: 'M2M Only' },
];

export const RESIDUAL_LEG_ID = 'residual';

function usdRatePct(): number {
  const v = CURRENCY_PARAMS.USD?.carry;
  return typeof v === 'number' && Number.isFinite(v) ? v : 3.5;
}

export function marketQuoteToUsdPerFcy(quote: number, ccy: string): number {
  if (!(quote > 0) || !Number.isFinite(quote)) return 0;
  return isUsdPerFcyQuoted(ccy) ? quote : 1 / quote;
}

export function usdPerFcyToMarketQuote(usdPerFcy: number, ccy: string): number {
  if (!(usdPerFcy > 0) || !Number.isFinite(usdPerFcy)) return 0;
  return isUsdPerFcyQuoted(ccy) ? usdPerFcy : 1 / usdPerFcy;
}

function candleTime(bar: SpotDayCandle): UTCTimestamp {
  return Math.floor(bar.t / 1000) as UTCTimestamp;
}

function usdRatePctFrac(): number {
  return usdRatePct() / 100;
}

/**
 * Forward outright in market-pair convention at `spotMarket`.
 * Cash / t=0 is spot. Swap points when a curve is loaded, else CIP.
 */
export function forwardOutrightMarketQuote(input: {
  spotMarket: number;
  months: number;
  ccy: string;
  rFcyPct: number;
  marketRates?: FxMarketRatesBundle | null;
}): number {
  const S = input.spotMarket;
  if (!(S > 0) || !Number.isFinite(S)) return 0;
  if (!(input.months > 1e-9)) return S;
  const pts = input.marketRates
    ? interpolateSwapPoints(
        input.marketRates.deposits,
        input.months,
        input.marketRates,
      )
    : null;
  if (pts) {
    const delta = swapPointsToPriceDelta(pts.mid, input.ccy);
    const F = S + delta;
    return F > 0 ? F : S;
  }
  const tau = input.months / 12;
  const rUsd = usdRatePctFrac();
  const rFcy = input.rFcyPct / 100;
  const usdSpot = marketQuoteToUsdPerFcy(S, input.ccy);
  if (!(usdSpot > 0)) return S;
  const denom = 1 + rFcy * tau;
  if (!(denom > 0)) return S;
  const usdFwd = usdSpot * (1 + rUsd * tau) / denom;
  return usdPerFcyToMarketQuote(usdFwd, input.ccy);
}

export function revalueLadderAtSpot(input: {
  points: readonly TenorRiskLadderPoint[];
  spotUsdAt: number;
  spotUsdNow: number;
  ccy: string;
  rFcyPct: number;
  marketRates?: FxMarketRatesBundle | null;
}): TenorRiskLadderPoint[] {
  const now = input.spotUsdNow > 0 ? input.spotUsdNow : analyticsSpotUsd(input.ccy);
  const at = input.spotUsdAt > 0 ? input.spotUsdAt : now;
  const scale = at / now;
  if (!Number.isFinite(scale) || scale <= 0) return [...input.points];
  // Live candle == reference spot: keep the snapshot so the table and the
  // last chart point match Analytics (curriculum pins, not the tape print).
  if (Math.abs(at - now) / now < 1e-12) return input.points.map(p => ({ ...p }));
  return input.points.map(p => {
    const cashCarryUsdM = p.cashCarryUsdM * scale;
    const m2mLive =
      p.months <= 0
        ? 0
        : m2mUsdMAt(
            p.residualLocalM,
            input.ccy,
            p.months,
            input.rFcyPct,
            input.marketRates,
            now,
          );
    const m2mHist =
      p.months <= 0
        ? 0
        : m2mUsdMAt(
            p.residualLocalM,
            input.ccy,
            p.months,
            input.rFcyPct,
            input.marketRates,
            at,
          );
    const m2mUsdM =
      p.months <= 0
        ? 0
        : Math.abs(m2mLive) > 1e-12
          ? p.m2mUsdM * (m2mHist / m2mLive)
          : p.m2mUsdM * scale;
    return {
      ...p,
      residualVarUsdM: p.residualVarUsdM * scale,
      residualCfarUsdM: p.residualCfarUsdM * scale,
      cashCarryUsdM,
      m2mUsdM,
      totalPnlUsdM: cashCarryUsdM + m2mUsdM,
      deltaUsdPerPct: p.deltaUsdPerPct * scale,
      vegaUsdPerVolPt: p.vegaUsdPerVolPt * scale,
      dv01Usd: p.dv01Usd * scale,
      gammaUsdPerPctSq: gammaUsdPerPctSqAt({
        residualLocalM: p.residualLocalM,
        months: p.months,
        ccy: input.ccy,
        rFcyPct: input.rFcyPct,
        cashCarryUsdM,
        spotUsd: at,
        marketRates: input.marketRates,
      }),
    };
  });
}

function snapshotFromPoint(
  time: UTCTimestamp,
  point: TenorRiskLadderPoint,
): TenorPnlSnapshot {
  return {
    time,
    total: point.totalPnlUsdM,
    delta: point.deltaUsdPerPct,
    gamma: point.gammaUsdPerPctSq,
    vega: point.vegaUsdPerVolPt,
    rho: point.dv01Usd,
    carryOnly: point.cashCarryUsdM,
    m2mOnly: point.m2mUsdM,
  };
}

export function pnlMetricValue(
  snap: TenorPnlSnapshot,
  metric: TenorPnlMetric,
): number {
  switch (metric) {
    case 'stacked':
    case 'total':
      return snap.total;
    case 'delta':
      return snap.delta;
    case 'gamma':
      return snap.gamma;
    case 'vega':
      return snap.vega;
    case 'rho':
      return snap.rho;
    case 'carryOnly':
      return snap.carryOnly;
    case 'm2mOnly':
      return snap.m2mOnly;
  }
}

export function buildTenorPnlBundle(input: {
  point: TenorRiskLadderPoint;
  candles: readonly SpotDayCandle[];
  ccy: string;
  tenorMonths: number;
  rFcyPct: number;
  marketRates?: FxMarketRatesBundle | null;
}): { rateSeries: TenorLinePt[]; snapshots: TenorPnlSnapshot[] } {
  const rateSeries: TenorLinePt[] = [];
  const snapshots: TenorPnlSnapshot[] = [];
  if (input.candles.length === 0) return { rateSeries, snapshots };
  const last = input.candles[input.candles.length - 1]!;
  const spotNow = marketQuoteToUsdPerFcy(last.close, input.ccy);
  const live = [input.point];
  for (const bar of input.candles) {
    if (!(bar.close > 0)) continue;
    const t = candleTime(bar);
    const outright = forwardOutrightMarketQuote({
      spotMarket: bar.close,
      months: input.tenorMonths,
      ccy: input.ccy,
      rFcyPct: input.rFcyPct,
      marketRates: input.marketRates,
    });
    if (outright > 0) rateSeries.push({ time: t, value: outright });
    const spotAt = marketQuoteToUsdPerFcy(bar.close, input.ccy);
    if (!(spotAt > 0) || !(spotNow > 0)) continue;
    const [rev] = revalueLadderAtSpot({
      points: live,
      spotUsdAt: spotAt,
      spotUsdNow: spotNow,
      ccy: input.ccy,
      rFcyPct: input.rFcyPct,
      marketRates: input.marketRates,
    });
    if (!rev) continue;
    snapshots.push(snapshotFromPoint(t, rev));
  }
  return { rateSeries, snapshots };
}

export function buildTenorPnlSeries(input: {
  point: TenorRiskLadderPoint;
  candles: readonly SpotDayCandle[];
  ccy: string;
  tenorMonths: number;
  rFcyPct: number;
  marketRates?: FxMarketRatesBundle | null;
  metric: TenorPnlMetric;
}): { rateSeries: TenorLinePt[]; pnlSeries: TenorLinePt[] } {
  const { rateSeries, snapshots } = buildTenorPnlBundle(input);
  return {
    rateSeries,
    pnlSeries: snapshots.map(s => ({
      time: s.time,
      value: pnlMetricValue(s, input.metric),
    })),
  };
}

export function liveHedgeLegsForCcy(
  booked: readonly HedgeTicket[],
  ccy: string,
): HedgeTicket[] {
  return booked.filter(t => t.ccy === ccy && isLiveHedgeTicket(t));
}

export function legTenureMonths(ticket: HedgeTicket): number {
  return settleMonthsFromHedgeTicket(ticket);
}

export function legTenorId(ticket: HedgeTicket): TenorRiskLadderId {
  if (ticket.maturity) return ticket.maturity;
  const months = legTenureMonths(ticket);
  if (!(months > 1e-9)) return 'cash';
  const chips: { id: VarHorizonId; months: number }[] = [
    { id: '1w', months: 0.25 },
    { id: '1m', months: 1 },
    { id: '3m', months: 3 },
    { id: '6m', months: 6 },
    { id: '9m', months: 9 },
    { id: '1y', months: 12 },
  ];
  return chips.reduce((best, h) =>
    Math.abs(h.months - months) < Math.abs(best.months - months) ? h : best,
  ).id;
}

function dealtOutrightMarket(ticket: HedgeTicket): number | null {
  const outright = ticket.ipaQuote?.fxOutright;
  if (outright != null && Number.isFinite(outright) && outright > 0) {
    return outright;
  }
  const spot = ticket.ipaQuote?.fxSpot;
  if (spot != null && Number.isFinite(spot) && spot > 0) {
    return spot;
  }
  const limit = ticket.limitRate;
  if (limit != null && Number.isFinite(limit) && limit > 0) return limit;
  return null;
}

function legUsdPnl(
  ticket: HedgeTicket,
  fwdMarket: number,
  dealtMarket: number,
  ccy: string,
): number {
  if (!(fwdMarket > 0) || !(dealtMarket > 0)) return 0;
  const fwdUsd = marketQuoteToUsdPerFcy(fwdMarket, ccy);
  const dealtUsd = marketQuoteToUsdPerFcy(dealtMarket, ccy);
  // Covering long FCY (N>0) is a short outright: P&L = N × (F_dealt − F_now).
  return ticket.amountLocalM * (dealtUsd - fwdUsd);
}

function legGammaUsd(
  ticket: HedgeTicket,
  fwd: number,
  dealt: number,
  ccy: string,
  months: number,
  scaleSpot: number,
  rFcyPct: number,
  marketRates: FxMarketRatesBundle | null | undefined,
): number {
  const p0 = legUsdPnl(ticket, fwd, dealt, ccy);
  const bump = (s: number) => {
    const q = usdPerFcyToMarketQuote(s, ccy);
    const f = forwardOutrightMarketQuote({
      spotMarket: q,
      months,
      ccy,
      rFcyPct,
      marketRates,
    });
    return legUsdPnl(ticket, f, dealt, ccy);
  };
  return bump(scaleSpot * 1.01) + bump(scaleSpot * 0.99) - 2 * p0;
}

/**
 * Individual non-settled leg P&L vs its dealt outright (fallback: live
 * forward so P&L(now) = 0). Rate series is the leg's remaining-tenor outright.
 */
export function buildLegPnlBundle(input: {
  ticket: HedgeTicket;
  candles: readonly SpotDayCandle[];
  ccy: string;
  rFcyPct: number;
  marketRates?: FxMarketRatesBundle | null;
}): { rateSeries: TenorLinePt[]; snapshots: TenorPnlSnapshot[] } {
  const rateSeries: TenorLinePt[] = [];
  const snapshots: TenorPnlSnapshot[] = [];
  const months = legTenureMonths(input.ticket);
  if (input.candles.length === 0) return { rateSeries, snapshots };
  const last = input.candles[input.candles.length - 1]!;
  const liveFwd = forwardOutrightMarketQuote({
    spotMarket: last.close,
    months,
    ccy: input.ccy,
    rFcyPct: input.rFcyPct,
    marketRates: input.marketRates,
  });
  const dealt = dealtOutrightMarket(input.ticket) ?? liveFwd;
  const n = input.ticket.amountLocalM;
  for (const bar of input.candles) {
    if (!(bar.close > 0)) continue;
    const t = candleTime(bar);
    const fwd = forwardOutrightMarketQuote({
      spotMarket: bar.close,
      months,
      ccy: input.ccy,
      rFcyPct: input.rFcyPct,
      marketRates: input.marketRates,
    });
    if (fwd > 0) rateSeries.push({ time: t, value: fwd });
    const fwdUsd = marketQuoteToUsdPerFcy(fwd, input.ccy);
    const scaleSpot = marketQuoteToUsdPerFcy(bar.close, input.ccy);
    const total = legUsdPnl(input.ticket, fwd, dealt, input.ccy);
    snapshots.push({
      time: t,
      total,
      delta: -n * fwdUsd * 0.01,
      gamma: legGammaUsd(
        input.ticket,
        fwd,
        dealt,
        input.ccy,
        months,
        scaleSpot,
        input.rFcyPct,
        input.marketRates,
      ),
      vega: 0,
      rho: -n * fwdUsd * (months / 12) * 0.0001,
      carryOnly: 0,
      m2mOnly: total,
    });
  }
  return { rateSeries, snapshots };
}

export function buildLegPnlSeries(input: {
  ticket: HedgeTicket;
  candles: readonly SpotDayCandle[];
  ccy: string;
  rFcyPct: number;
  marketRates?: FxMarketRatesBundle | null;
  metric: TenorPnlMetric;
}): { rateSeries: TenorLinePt[]; pnlSeries: TenorLinePt[] } {
  const { rateSeries, snapshots } = buildLegPnlBundle(input);
  return {
    rateSeries,
    pnlSeries: snapshots.map(s => ({
      time: s.time,
      value: pnlMetricValue(s, input.metric),
    })),
  };
}

export function cumulativePnlStackK(
  snapshots: readonly TenorPnlSnapshot[],
): { time: UTCTimestamp; carry: number; m2m: number }[] {
  if (snapshots.length === 0) return [];
  const base = snapshots[0]!;
  return snapshots.map(s => ({
    time: s.time,
    carry: (s.carryOnly - base.carryOnly) * 1000,
    m2m: (s.m2mOnly - base.m2mOnly) * 1000,
  }));
}

export function candlesToLw(candles: readonly SpotDayCandle[]): TenorCandlePt[] {
  const out: TenorCandlePt[] = [];
  let lastT = -1;
  for (const bar of candles) {
    if (!(bar.open > 0) || !(bar.close > 0)) continue;
    const time = candleTime(bar);
    if (time <= lastT) continue;
    lastT = time;
    out.push({
      time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });
  }
  return out;
}

export function mergeSpotDayCandles(
  closed: readonly SpotDayCandle[],
  forming: SpotDayCandle | null,
): SpotDayCandle[] {
  const bars = closed.filter(b => b.close > 0);
  if (forming && forming.close > 0) {
    const last = bars[bars.length - 1];
    if (last && last.t === forming.t) bars[bars.length - 1] = forming;
    else bars.push(forming);
  }
  return bars;
}

export function nearestCandleIndex(
  candles: readonly SpotDayCandle[],
  timeSec: number | null,
): number {
  if (candles.length === 0 || timeSec == null || !Number.isFinite(timeSec)) {
    return Math.max(0, candles.length - 1);
  }
  const ms = timeSec * 1000;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const d = Math.abs(candles[i]!.t - ms);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function formatAsOf(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}
