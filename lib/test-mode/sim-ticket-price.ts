/**
 * Simulated ticket pricer — not IPA.
 * Blends the last downloaded spot, currency curve, and vol surface.
 */

import Decimal from 'decimal.js';
import { CURRENCY_PARAMS } from '@/lib/fx-buffer';
import {
  interpolateSwapPoints,
  isUsdPerFcyQuoted,
  resolveForwardDepositRates,
  swapPointsToPriceDelta,
  usdMarketPair,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { impliedVolRecord } from '@/lib/fx-market-risk';
import {
  readStoredIpaVolSurface,
  swapPointsFromCip,
  tenorToMonths,
  type StoredIpaVolSurface,
} from '@/lib/refinitiv-to-market';
import type { HedgeInstrument, HedgeIpaQuote } from '@/lib/test-mode/hedge-var';
import { parseStrikeInput } from '@/lib/strikeNotation';

export type SimSpotQuote = { bid: number; ask: number; mid: number };

export type TickDir = 'up' | 'down';

export function pipSizeOf(px: number): number {
  return px >= 20 ? 0.01 : 0.0001;
}

/**
 * One beat of the simulated tape: a mean-reverting Brownian step around `anchor`.
 * Shared by /api/fx-spot (when the overlay print is stale), the ticket tape,
 * and the background resting-order monitor so they orbit the last live mid
 * rather than two diverging series.
 */
export function walkSpot(
  prev: SimSpotQuote,
  anchor: SimSpotQuote,
  pip: number,
  rand: () => number = Math.random,
): { next: SimSpotQuote; dir: TickDir | null } {
  const halfSpread = Math.max(
    pip,
    (Math.max(anchor.ask, anchor.bid) - Math.min(anchor.ask, anchor.bid)) / 2,
  );
  const steps = rand() < 0.7 ? 1 : 2;
  const sign = rand() < 0.5 ? -1 : 1;
  const revert = (anchor.mid - prev.mid) * 0.18;
  let mid = prev.mid + sign * steps * pip + revert;
  const cap = pip * 18;
  if (mid > anchor.mid + cap) mid = anchor.mid + cap;
  if (mid < anchor.mid - cap) mid = anchor.mid - cap;
  if (!(mid > 0)) mid = anchor.mid;
  const dir: TickDir | null =
    mid > prev.mid + pip * 0.25 ? 'up' : mid < prev.mid - pip * 0.25 ? 'down' : null;
  return {
    next: { bid: mid - halfSpread, mid, ask: mid + halfSpread },
    dir,
  };
}

export type SimTicketPriceInput = {
  ccy: string;
  instrument: HedgeInstrument;
  /** 0 = spot / T+2. */
  tenorMonths: number;
  strikeInput?: string;
  /** Book-signed FCY millions (+ = long exposure → sell FCY). */
  amountLocalM: number;
  bundle?: FxMarketRatesBundle | null;
  /** Overrides bundle.spot when a newer live print exists. */
  liveSpot?: SimSpotQuote | null;
  /** Which print of the last curve to apply onto live spot. */
  quoteSide?: 'bid' | 'mid' | 'ask';
  /** Pin vol lookup; `auto` walks surface → Atlas → seed. */
  volPref?: 'auto' | 'surface' | 'atlas' | 'seed';
  /** Vanilla put/call. Defaults to sell-FCY → put (long FCY hedge). */
  optionPut?: boolean;
};

export type SimBlendMeta = {
  pair: string;
  spotSource: 'live' | 'bundle' | 'seed';
  curveTenor: string | null;
  curveAsOf: string | null;
  curveSource: 'swap-points' | 'cip-deposits' | 'none';
  curvePoints: number | null;
  quoteSide: 'bid' | 'mid' | 'ask';
  surfacePulledAt: string | null;
  volSource: 'surface' | 'atlas' | 'seed';
};

export type SimTicketPriceResult = {
  quote: HedgeIpaQuote;
  pricedAt: string;
  blend: SimBlendMeta;
  /** Resolved bid/mid/ask used for the live tiles. */
  spot: SimSpotQuote;
};

export type OptionSkewPoint = {
  strike: number;
  volPercent: number;
  label: string;
  /** IPA signed delta when the smile is a Δ axis (−25 = 25ΔP). */
  signedDelta?: number;
};

export type OptionSkewCurve = {
  points: OptionSkewPoint[];
  selectedStrike: number | null;
  /** Ticket Δ when the smile is a delta axis (−25 = 25ΔP). Null for absolute K. */
  selectedSignedDelta: number | null;
  selectedVolPercent: number | null;
  forward: number;
  spot: number;
  volSource: SimBlendMeta['volSource'];
  /** True when the IPA surface supplied a non-flat smile. */
  smile: boolean;
  tenorMonths: number;
};

export type OptionPayoutPoint = {
  spot: number;
  pnlUsdM: number;
  /** Signed book-CCY millions: spot Δ × |notional|. */
  deltaLocalM: number;
  /** Same Δ in USD millions. */
  deltaUsdM: number;
  /** Signed Γ: Δ percentage points per 1% spot move. */
  gamma: number;
  /** Signed ν: premium % of spot per volatility point. */
  vega: number;
  /** Signed Θ: premium % of spot per calendar day. */
  theta: number;
  /**
   * Pre-expiry mark-to-market P&L ($M) at this spot — the Black-Scholes value
   * with K, σ, T and the forward differential fixed at inception, less the
   * premium. Converges on `pnlUsdM` as T → 0.
   */
  markUsdM: number;
};

/** Which discounted payoff the chart compares with the mark. */
export type PayoutBasis = 'forward' | 'spot';

export type OptionPayoutCurve = {
  points: OptionPayoutPoint[];
  strike: number;
  spot: number;
  premiumUsdM: number;
  /** USD millions of P&L per 1.00 of spot on the exercised (ITM) segment. */
  pnlPerSpotUsdM: number;
  /** Smile vol used for Δ (percent). */
  deltaVolPercent: number;
  put: boolean;
  longOption: boolean;
  ccy: string;
  /** |ticket notional| in book CCY millions — ITM Δ → this, OTM Δ → 0. */
  notionalLocalM: number;
  /** Full life used to price the blue mark, in years. */
  tenorYears: number;
  /** Decimal vol held fixed while remaining life moves. */
  vol: number;
  /** Inception forward / spot. Carry decays as remaining life shrinks. */
  forwardOverSpot: number;
  /**
   * Money-market domestic rate (decimal). EURUSD: the USD rate, which
   * discounts the premium and the strike.
   */
  domesticRate: number;
  /** Money-market foreign rate (decimal). EURUSD: the EUR rate, on the spot leg. */
  foreignRate: number;
};

export type OptionPremiumTenor = {
  months: number;
  label: string;
};

export type OptionPremiumRow = {
  value: number;
  label: string;
  axis: 'delta' | 'strike';
};

export type OptionPremiumCell = {
  volPercent: number;
  strike: number;
  premiumUsd: number;
};

/** Vanilla premium at each IPA smile knot (delta or strike × tenor). */
export type OptionPremiumSurface = {
  axisY: 'delta' | 'strike';
  tenors: OptionPremiumTenor[];
  rows: OptionPremiumRow[];
  /** [row][tenor] */
  cells: (OptionPremiumCell | null)[][];
  selectedTenorMonths: number;
  selectedY: number;
  pulledAt: string | null;
};

const SMILE_DELTAS: { signed: number; label: string }[] = [
  { signed: -10, label: '10ΔP' },
  { signed: -25, label: '25ΔP' },
  { signed: -35, label: '35ΔP' },
  { signed: 0, label: 'ATM' },
  { signed: 35, label: '35ΔC' },
  { signed: 25, label: '25ΔC' },
  { signed: 10, label: '10ΔC' },
];

const INV_NORM: Record<string, number> = {
  '10': -1.28155156554,
  '25': -0.674489750196,
  '35': -0.385320466408,
};

export function canConfirmSimTicket(
  quote: HedgeIpaQuote | null | undefined,
  bookUnpriced: boolean,
): boolean {
  if (bookUnpriced) return true;
  if (!quote) return false;
  return quote.fxSpot != null || quote.fxOutright != null;
}

export function simulateTicketPrice(
  input: SimTicketPriceInput,
): SimTicketPriceResult {
  const ccy = input.ccy.toUpperCase();
  const pair = usdMarketPair(ccy);
  const months = input.instrument === 'spot' ? 0 : Math.max(0, input.tenorMonths);
  const { spot, spotSource } = resolveLiveSpot(ccy, input.bundle, input.liveSpot);
  const sellFcy = input.amountLocalM >= 0;
  const quoteSide = input.quoteSide ?? (sellFcy ? 'ask' : 'bid');
  const optionPut = input.optionPut ?? sellFcy;
  const curve = resolveCurveOutright({
    ccy,
    bundle: input.bundle,
    spot,
    months,
    quoteSide,
  });
  const outright = input.instrument === 'spot' ? spot.mid : curve.outright;
  const strikePlan = resolveStrike({
    raw: input.strikeInput ?? 'ATMF',
    spotMid: spot.mid,
    forward: outright,
    sellFcy,
    optionPut,
  });
  const vol = resolveVol({
    bundle: input.bundle,
    ccy,
    months: months > 0 ? months : 1,
    deltaPct: strikePlan.deltaPct,
    put: strikePlan.put,
    pref: input.volPref ?? 'auto',
  });
  const T = Math.max(1 / 365, months / 12);
  const strike = strikePlan.kind === 'absolute'
    ? strikePlan.value
    : strikeFromDelta({
        forward: outright,
        vol: vol.vol,
        T,
        deltaPct: strikePlan.deltaPct,
        put: strikePlan.put,
      });

  let premiumUsd: number | null = null;
  let premiumPercent: number | null = null;
  let deltaPercent: number | null = null;
  let gammaPercent: number | null = null;
  let vegaPercent: number | null = null;
  let thetaPercent: number | null = null;
  let vannaPercent: number | null = null;
  let volgaPercent: number | null = null;
  if (input.instrument === 'option') {
    const priced = priceVanilla({
      spotMid: spot.mid,
      forward: outright,
      strike,
      vol: vol.vol,
      T,
      put: strikePlan.put,
      notionalFcy: Math.abs(input.amountLocalM) * 1_000_000,
      ccy,
    });
    premiumUsd = priced.premiumUsd;
    premiumPercent = priced.premiumPercent;
    deltaPercent = priced.deltaPercent;
    gammaPercent = priced.gammaPercent;
    vegaPercent = priced.vegaPercent;
    thetaPercent = priced.thetaPercent;
    vannaPercent = priced.vannaPercent;
    volgaPercent = priced.volgaPercent;
  }

  const quote: HedgeIpaQuote = {
    strike: input.instrument === 'option' ? strike : null,
    strikeInput: input.strikeInput ?? 'ATMF',
    premiumUsd,
    premiumPercent,
    fxSpot: spot.mid,
    fxOutright: outright,
    atmVolPercent: vol.atmPercent,
    impliedVolPercent: vol.vol * 100,
    deltaPercent,
    gammaPercent,
    vegaPercent,
    thetaPercent,
    vannaPercent,
    volgaPercent,
  };

  return {
    quote,
    pricedAt: new Date().toISOString(),
    spot,
    blend: {
      pair,
      spotSource,
      curveTenor: curve.tenor,
      curveAsOf:
        input.bundle?.asOf?.tradeDate
        ?? input.bundle?.asOf?.spotDate
        ?? null,
      curveSource: curve.source,
      curvePoints: curve.points,
      quoteSide,
      surfacePulledAt: vol.surfacePulledAt,
      volSource: vol.source,
    },
  };
}

/**
 * Market smile at the ticket tenor, plus vanilla expiry P&L vs spot.
 * Uses the same blend as the simulated ticket — never live IPA.
 */
export function sampleOptionMarketCharts(
  input: SimTicketPriceInput & { longOption?: boolean },
): {
  skew: OptionSkewCurve;
  payout: OptionPayoutCurve | null;
  premiumSurface: OptionPremiumSurface | null;
} {
  const priced = simulateTicketPrice({ ...input, instrument: 'option' });
  const months = Math.max(
    1 / 30,
    input.instrument === 'spot' ? 1 : Math.max(0, input.tenorMonths),
  );
  const T = Math.max(1 / 365, months / 12);
  const forward = priced.quote.fxOutright ?? priced.spot.mid;
  const strike = priced.quote.strike ?? forward;
  const selectedVol = priced.quote.impliedVolPercent;
  const plan = resolveStrike({
    raw: input.strikeInput ?? 'ATMF',
    spotMid: priced.spot.mid,
    forward,
    sellFcy: input.amountLocalM >= 0,
    optionPut: input.optionPut,
  });
  const surface = readStoredIpaVolSurface(input.bundle);
  const points = smilePoints({
    surface,
    months,
    T,
    forward,
    atmVol: (priced.quote.atmVolPercent ?? selectedVol ?? 10) / 100,
  });
  const vols = points.map(p => p.volPercent);
  const volSpan = vols.length > 0 ? Math.max(...vols) - Math.min(...vols) : 0;
  const pinned = pickSelectedSmilePoint(points, plan, strike, selectedVol);
  const skew: OptionSkewCurve = {
    points,
    selectedStrike: pinned.strike > 0 ? pinned.strike : null,
    selectedSignedDelta: plan.kind === 'absolute'
      ? null
      : signedDeltaFromPlan(plan.deltaPct, plan.put),
    selectedVolPercent: pinned.vol,
    forward,
    spot: priced.spot.mid,
    volSource: priced.blend.volSource,
    smile: Boolean(surface) && volSpan > 0.05,
    tenorMonths: months,
  };
  const depositRates = resolveForwardDepositRates(input.bundle, input.ccy, months);
  const domesticIsUsd = isUsdPerFcyQuoted(input.ccy);
  const payout = optionPayoutCurve({
    ccy: input.ccy,
    spotMid: priced.spot.mid,
    strike,
    premiumUsd: priced.quote.premiumUsd,
    premiumPercent: priced.quote.premiumPercent,
    amountLocalM: input.amountLocalM,
    put: plan.put,
    longOption: input.longOption !== false,
    volPercent: priced.quote.impliedVolPercent ?? priced.quote.atmVolPercent,
    T,
    forward,
    smile: points,
    domesticRate:
      (domesticIsUsd ? depositRates.usd.creditPct : depositRates.fcy.creditPct) / 100,
    foreignRate:
      (domesticIsUsd ? depositRates.fcy.creditPct : depositRates.usd.creditPct) / 100,
  });
  const premiumSurface = buildPremiumSurface({
    input,
    priced,
    surface,
    months,
    plan,
  });
  return { skew, payout, premiumSurface };
}

function pickSelectedSmilePoint(
  points: OptionSkewPoint[],
  plan: ReturnType<typeof resolveStrike>,
  ticketStrike: number,
  ticketVol: number | null,
): { strike: number; vol: number | null } {
  if (points.length === 0) return { strike: ticketStrike, vol: ticketVol };
  if (plan.kind === 'absolute') {
    return {
      strike: ticketStrike,
      vol: interpVolAtStrike(points, ticketStrike) ?? ticketVol,
    };
  }
  const signed = Math.abs(plan.deltaPct - 50) < 1
    ? 0
    : plan.put
      ? -Math.abs(plan.deltaPct)
      : Math.abs(plan.deltaPct);
  const hit = points.find(p => {
    const d = parseDeltaLabel(p.label);
    return d != null && Math.abs(d - signed) < 0.6;
  });
  if (hit) return { strike: hit.strike, vol: hit.volPercent };
  return {
    strike: ticketStrike,
    vol: interpVolAtStrike(points, ticketStrike) ?? ticketVol,
  };
}

function interpVolAtStrike(
  points: readonly Pick<OptionSkewPoint, 'strike' | 'volPercent'>[],
  strike: number,
): number | null {
  const sorted = [...points].sort((a, b) => a.strike - b.strike);
  if (sorted.length === 0) return null;
  if (strike <= sorted[0]!.strike) return sorted[0]!.volPercent;
  const last = sorted[sorted.length - 1]!;
  if (strike >= last.strike) return last.volPercent;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (strike >= a.strike && strike <= b.strike) {
      const w = (strike - a.strike) / (b.strike - a.strike || 1);
      return a.volPercent + w * (b.volPercent - a.volPercent);
    }
  }
  return null;
}

function smilePoints(args: {
  surface: StoredIpaVolSurface | null;
  months: number;
  T: number;
  forward: number;
  atmVol: number;
}): OptionSkewPoint[] {
  const fromStrikeAxis = args.surface
    ? smileFromStrikeAxis(args.surface, args.months)
    : null;
  if (
    fromStrikeAxis
    && fromStrikeAxis.length >= 3
    && smileCoversForward(fromStrikeAxis, args.forward)
  ) {
    return fromStrikeAxis;
  }

  const deltas = smileDeltaRows(args.surface);
  const out: OptionSkewPoint[] = [];
  for (const row of deltas) {
    const fromSurface = args.surface
      ? volFromSurfaceAtSignedDelta(args.surface, args.months, row.signed)
      : null;
    const vol = fromSurface != null && fromSurface > 0 ? fromSurface : args.atmVol;
    const strike = row.signed === 0
      ? args.forward
      : strikeFromSignedDelta({
          forward: args.forward,
          vol,
          T: args.T,
          signedDelta: row.signed,
        });
    if (!(strike > 0) || !(vol > 0)) continue;
    out.push({
      strike,
      volPercent: vol * 100,
      label: row.label,
      signedDelta: row.signed,
    });
  }
  out.sort((a, b) => a.strike - b.strike);
  return out;
}

function smileDeltaRows(
  surface: StoredIpaVolSurface | null,
): { signed: number; label: string }[] {
  if (!surface || surface.yAxis === 'Strike' || surface.xAxis === 'Strike') {
    return SMILE_DELTAS;
  }
  const layout = surfaceTenorYLayout(surface);
  if (layout?.axisY === 'delta' && layout.yTicks.length >= 3) {
    return layout.yTicks.map(y => ({ signed: y.value, label: y.label }));
  }
  const rows: { signed: number; label: string }[] = [];
  const seen = new Set<number>();
  for (const label of surface.yLabels) {
    const signed = parseDeltaLabel(label);
    if (signed == null) continue;
    const key = Math.round(signed * 10);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ signed, label: label.trim() || deltaLabel(signed) });
  }
  return rows.length >= 3 ? rows : SMILE_DELTAS;
}

function deltaLabel(signed: number): string {
  if (Math.abs(signed) < 1e-9) return 'ATM';
  return `${Math.abs(signed)}Δ${signed < 0 ? 'P' : 'C'}`;
}

function smileCoversForward(
  points: OptionSkewPoint[],
  forward: number,
): boolean {
  if (!(forward > 0) || points.length === 0) return false;
  const strikes = points.map(p => p.strike).filter(s => s > 0);
  if (strikes.length === 0) return false;
  const min = Math.min(...strikes);
  const max = Math.max(...strikes);
  return forward >= min * 0.98 && forward <= max * 1.02;
}

function smileFromStrikeAxis(
  surface: StoredIpaVolSurface,
  months: number,
): OptionSkewPoint[] | null {
  if (surface.yAxis !== 'Strike' && surface.xAxis !== 'Strike') return null;
  const strikeOnY = surface.yAxis === 'Strike';
  const labels = strikeOnY ? surface.yLabels : surface.xLabels;
  const tenorLabels = strikeOnY ? surface.xLabels : surface.yLabels;
  const tenorCols = tenorLabels
    .map((l, i) => ({ i, months: surfaceXMonths(l) }))
    .filter((c): c is { i: number; months: number } =>
      c.months != null && Number.isFinite(c.months),
    )
    .sort((a, b) => a.months - b.months);
  if (tenorCols.length === 0) return null;
  const pick = nearestPair(tenorCols.map(c => c.months), months);
  const lo = tenorCols[pick.lo]!.i;
  const hi = tenorCols[pick.hi]!.i;
  const out: OptionSkewPoint[] = [];
  labels.forEach((raw, i) => {
    const strike = Number(String(raw).replace(/,/g, ''));
    if (!(strike > 0)) return;
    const volLo = strikeOnY ? cellVol(surface, i, lo) : cellVol(surface, lo, i);
    const volHi = lo === hi
      ? volLo
      : strikeOnY
        ? cellVol(surface, i, hi)
        : cellVol(surface, hi, i);
    if (volLo == null && volHi == null) return;
    const vol = volLo != null && volHi != null
      ? volLo + pick.w * (volHi - volLo)
      : (volLo ?? volHi)!;
    if (!(vol > 0)) return;
    out.push({
      strike,
      volPercent: vol * 100,
      label: String(raw),
    });
  });
  out.sort((a, b) => a.strike - b.strike);
  return out.length >= 3 ? out : null;
}

function cellVol(
  surface: StoredIpaVolSurface,
  row: number,
  col: number,
): number | null {
  const raw = surface.values[row]?.[col];
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  return raw > 1.5 ? raw / 100 : raw;
}

function optionPayoutCurve(args: {
  ccy: string;
  spotMid: number;
  strike: number;
  premiumUsd: number | null;
  premiumPercent: number | null;
  amountLocalM: number;
  put: boolean;
  longOption: boolean;
  volPercent?: number | null;
  T?: number;
  forward?: number;
  smile?: readonly Pick<OptionSkewPoint, 'strike' | 'volPercent'>[];
  /** Decimal domestic money-market rate. Discounts the strike and the premium. */
  domesticRate?: number;
  /** Decimal foreign money-market rate. Discounts the spot leg in spot mode. */
  foreignRate?: number;
}): OptionPayoutCurve | null {
  const { spotMid, strike, put, longOption, ccy } = args;
  if (!(spotMid > 0) || !(strike > 0)) return null;
  const notionalAbsM = Math.abs(args.amountLocalM);
  const notionalFcy = notionalAbsM * 1_000_000;
  if (!(notionalFcy > 0)) return null;
  const usdPerFcyAt = (s: number) => (isUsdPerFcyQuoted(ccy) ? s : 1 / s);
  const usdPerFcy = usdPerFcyAt(spotMid);
  const premQuote = args.premiumPercent != null
    ? (args.premiumPercent / 100) * spotMid
    : 0;
  const premiumUsd = args.premiumUsd
    ?? notionalFcy * usdPerFcy * (premQuote / spotMid);
  const quoteToUsdM = (q: number) =>
    (notionalFcy * usdPerFcy * (q / spotMid)) / 1_000_000;
  const smileVol = args.smile && args.smile.length > 0
    ? interpVolAtStrike(args.smile, strike)
    : null;
  const volPercent = smileVol ?? args.volPercent ?? 10;
  const vol = Math.max(0.01, volPercent / 100);
  const T = Math.max(1 / 365, args.T ?? 1 / 12);
  const sigma = vol * Math.sqrt(T);
  // Fixed spot-centered window: 0 P&L stays put and K slides the hockey
  // stick across it. Do not expand the domain when strike walks off-chart.
  const half = spotMid * Math.max(0.08, 3.5 * sigma);
  const x0 = Math.max(1e-8, spotMid - half);
  const x1 = spotMid + half;
  const span = x1 - x0;
  const sign = longOption ? 1 : -1;
  const forward0 = args.forward != null && args.forward > 0 ? args.forward : spotMid;
  const premiumUsdM = premiumUsd / 1_000_000;
  const n = 257;
  const step = span / (n - 1);
  const spots: number[] = [];
  for (let i = 0; i < n; i++) spots.push(x0 + step * i);
  // K must be sampled exactly, or the kink and the strike line both land on
  // the nearest node instead — up to half a step away while still labelled
  // with the true strike. Move that node onto K rather than inserting a new
  // one: the axis is plotted by index, so an inserted node draws a sliver of
  // spot at a full cell's width and shifts everything right of K over by a
  // whole cell. Endpoints are left alone, so the window stays fixed while K
  // slides across it.
  if (strike > x0 && strike < x1) {
    let nearest = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(spots[i]! - strike) < Math.abs(spots[nearest]! - strike)) {
        nearest = i;
      }
    }
    if (nearest > 0 && nearest < n - 1) spots[nearest] = strike;
  }
  const points: OptionPayoutPoint[] = spots.map(s => {
    const intrinsic = put ? Math.max(strike - s, 0) : Math.max(s - strike, 0);
    const fwd = s * (forward0 / spotMid);
    const greeks = priceVanilla({
      spotMid: s,
      forward: fwd,
      strike,
      vol,
      T,
      put,
      notionalFcy,
      ccy,
    });
    // BS Δ is a 0…±1 coefficient; book Δ is that times ticket notional.
    const deltaFrac = greeks.deltaPercent / 100;
    const deltaLocalM = sign * deltaFrac * notionalAbsM;
    const intrinsicUsdM = quoteToUsdM(intrinsic);
    const profile = signedGreekProfile(sign, greeks);
    return {
      spot: s,
      pnlUsdM: sign * (intrinsicUsdM - premiumUsdM),
      deltaLocalM,
      deltaUsdM: deltaLocalM * usdPerFcyAt(s),
      ...profile,
      // Pre-expiry M2M at this spot, priced off the same Black-Scholes call
      // the Δ comes from — K, σ, T and the forward differential all held at
      // their inception values. Carried as P&L against premium so it shares
      // the expiry line's zero and collapses onto it as T → 0.
      markUsdM: sign * (greeks.premiumUsd / 1_000_000 - premiumUsdM),
    };
  });
  return {
    points,
    strike,
    spot: spotMid,
    premiumUsdM: premiumUsd / 1_000_000,
    pnlPerSpotUsdM: quoteToUsdM(1),
    deltaVolPercent: volPercent,
    put,
    longOption,
    ccy,
    notionalLocalM: notionalAbsM,
    tenorYears: T,
    vol,
    forwardOverSpot: forward0 / spotMid,
    domesticRate: finiteRate(args.domesticRate),
    foreignRate: finiteRate(args.foreignRate),
  };
}

function finiteRate(rate: number | null | undefined): number {
  return rate != null && Number.isFinite(rate) ? rate : 0;
}

/** 1 / (1 + r τ). τ = 0 → 1, so the discount falls out at expiry. */
function moneyMarketDf(rate: number, years: number): number {
  const t = Math.max(0, years);
  const den = 1 + finiteRate(rate) * t;
  return den > 1e-8 ? 1 / den : 1;
}

/** Spot on the x-axis where this basis's discounted payoff kinks. At expiry, the strike. */
export function payoutKinkSpot(
  curve: OptionPayoutCurve,
  lifeFrac: number,
  basis: PayoutBasis,
): number {
  const f = Math.min(1, Math.max(0, Number.isFinite(lifeFrac) ? lifeFrac : 1));
  const years = curve.tenorYears * f;
  if (basis === 'spot') {
    const dfD = moneyMarketDf(curve.domesticRate, years);
    const dfF = moneyMarketDf(curve.foreignRate, years);
    return dfF > 0 ? (curve.strike * dfD) / dfF : curve.strike;
  }
  const ratio = Math.pow(curve.forwardOverSpot, f);
  return ratio > 0 ? curve.strike / ratio : curve.strike;
}

/**
 * Present value of the expiry payoff, quote per 1 base unit — the same units
 * `priceVanilla` discounts.
 * Forward: (S/F) × max(K−F, 0), the floor under the ticket mark.
 * Spot: max(K·DF_d − S·DF_f, 0). Both rates are in, and the corner is where
 * the discounted strike equals the discounted spot.
 */
function discountedPayoffQuote(args: {
  basis: PayoutBasis;
  spot: number;
  forward: number;
  strike: number;
  put: boolean;
  domesticDf: number;
  foreignDf: number;
}): number {
  if (args.basis === 'spot') {
    const legs = args.put
      ? args.strike * args.domesticDf - args.spot * args.foreignDf
      : args.spot * args.foreignDf - args.strike * args.domesticDf;
    return Math.max(0, legs);
  }
  const df = args.forward > 0 ? args.spot / args.forward : 1;
  const intrinsic = args.put
    ? Math.max(args.strike - args.forward, 0)
    : Math.max(args.forward - args.strike, 0);
  return df * intrinsic;
}

function signedGreekProfile(
  sign: number,
  greeks: { gammaPercent: number; vegaPercent: number; thetaPercent: number },
): { gamma: number; vega: number; theta: number } {
  return {
    gamma: sign * greeks.gammaPercent,
    vega: sign * greeks.vegaPercent,
    theta: sign * greeks.thetaPercent,
  };
}

/**
 * Blue mark at a fraction of the original life. `1` is the ticket as priced
 * now (current value − premium paid). `0` is expiry, where the mark is the
 * green payoff (intrinsic − premium). Strike, vol and premium stay put;
 * only time left, and the forward carry that belongs to it, move.
 *
 * `basis` redraws both lines in present value. `forward` keeps the ticket
 * mark (Black on the market forward, discount spot/forward) and sets the
 * green line to that same discount times the forward intrinsic, so time
 * value sits on top. `spot` reprices off spot with both deposit discounts
 * (strike at the domestic rate, spot at the foreign rate) and sets the green
 * line to that floor. Omit `basis` to leave the stored cash payoff as-is.
 */
export function payoutAtRemainingLife(
  curve: OptionPayoutCurve,
  lifeFrac: number,
  basis?: PayoutBasis,
): OptionPayoutCurve {
  const f = Math.min(1, Math.max(0, Number.isFinite(lifeFrac) ? lifeFrac : 1));
  if (!basis && f >= 1 - 1e-9) return curve;
  const sign = curve.longOption ? 1 : -1;
  const notionalFcy = curve.notionalLocalM * 1_000_000;
  const usdPerFcyAt = (s: number) =>
    isUsdPerFcyQuoted(curve.ccy) ? s : s > 0 ? 1 / s : 0;
  const years = curve.tenorYears * f;
  const expiry = years < 1 / 365 / 24;
  const dfD = moneyMarketDf(curve.domesticRate, years);
  const dfF = moneyMarketDf(curve.foreignRate, years);
  const activeBasis: PayoutBasis = basis ?? 'forward';
  const points = curve.points.map(p => {
    if (expiry) {
      const exercised = curve.put
        ? p.spot < curve.strike
        : p.spot > curve.strike;
      const deltaFrac = exercised ? (curve.put ? -1 : 1) : 0;
      const deltaLocalM = sign * deltaFrac * curve.notionalLocalM;
      const cash = curve.put
        ? Math.max(curve.strike - p.spot, 0)
        : Math.max(p.spot - curve.strike, 0);
      const pnlUsdM = basis
        ? sign * (quotePremiumUsd(cash, p.spot, notionalFcy, curve.ccy) / 1_000_000 - curve.premiumUsdM)
        : p.pnlUsdM;
      return {
        ...p,
        pnlUsdM,
        markUsdM: basis ? pnlUsdM : p.pnlUsdM,
        deltaLocalM,
        deltaUsdM: deltaLocalM * usdPerFcyAt(p.spot),
        gamma: 0,
        vega: 0,
        theta: 0,
      };
    }
    if (!basis) {
      const greeks = priceVanilla({
        spotMid: p.spot,
        forward: p.spot * Math.pow(curve.forwardOverSpot, f),
        strike: curve.strike,
        vol: curve.vol,
        T: years,
        put: curve.put,
        notionalFcy,
        ccy: curve.ccy,
      });
      const deltaLocalM =
        sign * (greeks.deltaPercent / 100) * curve.notionalLocalM;
      return {
        ...p,
        deltaLocalM,
        deltaUsdM: deltaLocalM * usdPerFcyAt(p.spot),
        markUsdM: sign * (greeks.premiumUsd / 1_000_000 - curve.premiumUsdM),
        ...signedGreekProfile(sign, greeks),
      };
    }
    const forward = activeBasis === 'spot'
      ? p.spot * (dfD > 0 ? dfF / dfD : 1)
      : p.spot * Math.pow(curve.forwardOverSpot, f);
    const greeks = priceVanilla({
      spotMid: p.spot,
      forward,
      strike: curve.strike,
      vol: curve.vol,
      T: years,
      put: curve.put,
      notionalFcy,
      ccy: curve.ccy,
      discount: activeBasis === 'spot' ? dfD : undefined,
    });
    const deltaLocalM =
      sign * (greeks.deltaPercent / 100) * curve.notionalLocalM;
    const profile = signedGreekProfile(sign, greeks);
    const payoffUsd = quotePremiumUsd(
      discountedPayoffQuote({
        basis: activeBasis,
        spot: p.spot,
        forward,
        strike: curve.strike,
        put: curve.put,
        domesticDf: dfD,
        foreignDf: dfF,
      }),
      p.spot,
      notionalFcy,
      curve.ccy,
    );
    return {
      ...p,
      deltaLocalM,
      deltaUsdM: deltaLocalM * usdPerFcyAt(p.spot),
      pnlUsdM: sign * (payoffUsd / 1_000_000 - curve.premiumUsdM),
      markUsdM: sign * (greeks.premiumUsd / 1_000_000 - curve.premiumUsdM),
      ...profile,
    };
  });
  return { ...curve, points };
}

function quotePremiumUsd(
  premQuote: number,
  spotMid: number,
  notionalFcy: number,
  ccy: string,
): number {
  const premPct = spotMid > 0 ? (premQuote / spotMid) * 100 : 0;
  const usdPerFcy = isUsdPerFcyQuoted(ccy) ? spotMid : spotMid > 0 ? 1 / spotMid : 0;
  return new Decimal(notionalFcy).mul(usdPerFcy).mul(premPct).div(100).toNumber();
}

function resolveLiveSpot(
  ccy: string,
  bundle: FxMarketRatesBundle | null | undefined,
  liveSpot: SimSpotQuote | null | undefined,
): { spot: SimSpotQuote; spotSource: SimBlendMeta['spotSource'] } {
  if (liveSpot && liveSpot.mid > 0) {
    return { spot: liveSpot, spotSource: 'live' };
  }
  const mid = bundle?.spot?.mid;
  if (typeof mid === 'number' && mid > 0) {
    return {
      spot: {
        bid: bundle!.spot!.bid > 0 ? bundle!.spot!.bid : mid,
        ask: bundle!.spot!.ask > 0 ? bundle!.spot!.ask : mid,
        mid,
      },
      spotSource: 'bundle',
    };
  }
  const usdPerFcy = CURRENCY_PARAMS[ccy]?.spot ?? 0;
  const seedMid = usdPerFcy > 0
    ? (isUsdPerFcyQuoted(ccy) ? usdPerFcy : 1 / usdPerFcy)
    : 0;
  if (!(seedMid > 0)) {
    throw new Error(`No live or seed spot for ${ccy}`);
  }
  return {
    spot: { bid: seedMid, ask: seedMid, mid: seedMid },
    spotSource: 'seed',
  };
}

function pickSide(
  quotes: { bid: number; ask: number; mid: number },
  side: 'bid' | 'mid' | 'ask',
): number {
  return quotes[side];
}

function resolveCurveOutright(args: {
  ccy: string;
  bundle: FxMarketRatesBundle | null | undefined;
  spot: SimSpotQuote;
  months: number;
  quoteSide: 'bid' | 'mid' | 'ask';
}): {
  outright: number;
  tenor: string | null;
  source: SimBlendMeta['curveSource'];
  points: number | null;
} {
  const { ccy, bundle, spot, months, quoteSide } = args;
  if (!(months > 0)) {
    return { outright: spot.mid, tenor: null, source: 'none', points: null };
  }
  const interp = bundle
    ? interpolateSwapPoints(bundle.deposits, months, bundle)
    : null;
  if (interp) {
    const pts = pickSide(interp, quoteSide);
    return {
      outright: spot.mid + swapPointsToPriceDelta(pts, ccy),
      tenor: `${months}M`,
      source: 'swap-points',
      points: pts,
    };
  }
  const rFcy = bundle?.overnightCash?.base.creditPct
    ?? CURRENCY_PARAMS[ccy]?.carry
    ?? 0;
  const rUsd = bundle?.overnightCash?.usd.creditPct
    ?? CURRENCY_PARAMS.USD?.carry
    ?? 3.5;
  const cip = swapPointsFromCip({
    ccy,
    spotMid: spot.mid,
    rFcyPct: rFcy,
    rUsdPct: rUsd,
    months,
  });
  if (cip) {
    const pts = pickSide({ bid: cip.bid, ask: cip.ask, mid: (cip.bid + cip.ask) / 2 }, quoteSide);
    return {
      outright: spot.mid + swapPointsToPriceDelta(pts, ccy),
      tenor: `${months}M`,
      source: 'cip-deposits',
      points: pts,
    };
  }
  return { outright: spot.mid, tenor: `${months}M`, source: 'none', points: null };
}

function resolveStrike(args: {
  raw: string;
  spotMid: number;
  forward: number;
  sellFcy: boolean;
  optionPut?: boolean;
}): { kind: 'atm' | 'absolute'; value: number; deltaPct: number; put: boolean } {
  const put = args.optionPut ?? args.sellFcy;
  const parsed = parseStrikeInput(args.raw);
  if (!parsed) {
    return { kind: 'atm', value: args.forward, deltaPct: 50, put };
  }
  if (parsed.kind === 'absolute') {
    return { kind: 'absolute', value: parsed.value, deltaPct: 50, put };
  }
  if (parsed.kind === 'delta') {
    const deltaPct = parsed.deltaPct;
    const sidePut = parsed.optionType === 'call' ? false : parsed.optionType === 'put' ? true : put;
    return { kind: 'atm', value: args.forward, deltaPct, put: sidePut };
  }
  if (parsed.kind === 'atm' && parsed.expression === 'ATMS') {
    return { kind: 'absolute', value: args.spotMid, deltaPct: 50, put };
  }
  return { kind: 'atm', value: args.forward, deltaPct: 50, put };
}

function resolveVol(args: {
  bundle: FxMarketRatesBundle | null | undefined;
  ccy: string;
  months: number;
  deltaPct: number;
  put: boolean;
  pref: 'auto' | 'surface' | 'atlas' | 'seed';
}): {
  vol: number;
  atmPercent: number | null;
  source: SimBlendMeta['volSource'];
  surfacePulledAt: string | null;
} {
  const surface = readStoredIpaVolSurface(args.bundle);
  const pulledAt = surface?.pulledAt || null;
  const signed = signedDeltaFromPlan(args.deltaPct, args.put);
  const fromSurface = surface
    ? volFromSurfaceAtSignedDelta(surface, args.months, signed)
    : null;
  const atlas = interpolateTenorVol(args.bundle?.impliedVolByTenor, args.months)
    ?? interpolateTenorVol(impliedVolRecord(args.ccy), args.months);
  const daily = CURRENCY_PARAMS[args.ccy]?.σ_daily ?? 0;
  const seed = daily > 0 ? daily * Math.sqrt(252) : 0.10;
  const useSurface = args.pref === 'surface' || (args.pref === 'auto' && fromSurface != null && fromSurface > 0);
  if (useSurface && fromSurface != null && fromSurface > 0) {
    const atm = volFromSurfaceAtSignedDelta(surface!, args.months, 0);
    return {
      vol: fromSurface,
      atmPercent: atm != null ? atm * 100 : fromSurface * 100,
      source: 'surface',
      surfacePulledAt: pulledAt,
    };
  }
  const useAtlas = args.pref === 'atlas' || (args.pref === 'auto' && atlas != null && atlas > 0);
  if (useAtlas && atlas != null && atlas > 0) {
    return {
      vol: atlas,
      atmPercent: atlas * 100,
      source: 'atlas',
      surfacePulledAt: surface?.pulledAt || null,
    };
  }
  return {
    vol: seed,
    atmPercent: seed * 100,
    source: 'seed',
    surfacePulledAt: pulledAt,
  };
}

function signedDeltaFromPlan(deltaPct: number, put: boolean): number {
  if (Math.abs(deltaPct - 50) < 1e-9) return 0;
  const mag = Math.abs(deltaPct);
  if (mag >= 49.5) return 0;
  return put ? -mag : mag;
}

function interpolateTenorVol(
  rec: Record<string, number> | undefined,
  months: number,
): number | null {
  if (!rec) return null;
  const exact = rec[String(Math.round(months))];
  if (typeof exact === 'number' && exact > 0) return exact;
  const keys = Object.keys(rec)
    .map(Number)
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (keys.length === 0) return null;
  const lo = [...keys].reverse().find(m => m <= months) ?? keys[0]!;
  const hi = keys.find(m => m >= months) ?? keys[keys.length - 1]!;
  const a = rec[String(lo)];
  const b = rec[String(hi)];
  if (!(a > 0) || !(b > 0)) return a ?? b ?? null;
  if (hi === lo) return a;
  const w = (months - lo) / (hi - lo);
  return a + w * (b - a);
}

function parseDeltaLabel(label: string): number | null {
  const raw = label.trim();
  if (!raw) return null;
  const tenorish = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (/^(ON|O\/N|ONIGHT|OVERNIGHT|TN|T\/N|SN|S\/N|SW|SPOTWEEK)$/.test(tenorish)) {
    return null;
  }
  if (/^\d+[WMY]$/.test(tenorish)) return null;

  const t = raw
    .toUpperCase()
    .replace(/[Δ𝛅δ]/g, 'D');
  const compact = t.replace(/[\s_\/]/g, '');
  const unsigned = compact.replace(/^-/, '');
  if (
    unsigned === 'ATM'
    || unsigned === 'ATMF'
    || unsigned === 'ATMS'
    || unsigned === 'ATMD'
    || unsigned === 'DNS'
    || unsigned === '50D'
    || unsigned === '50DC'
    || unsigned === '50DP'
  ) {
    return 0;
  }

  const put = /PUT/.test(unsigned) || /DP$/.test(unsigned) || /(?:^|\d)P$/.test(unsigned);
  const call = /CALL/.test(unsigned) || /DC$/.test(unsigned) || /(?:^|\d)C$/.test(unsigned);
  const magMatch = compact.match(/(-?\d+(?:\.\d+)?)/);
  if (!magMatch) return null;
  let mag = Math.abs(Number(magMatch[1]));
  if (!(mag > 0)) return null;
  if (mag <= 1) mag *= 100;
  if (mag < 5 || mag > 50) return null;
  if (mag >= 49.5) return 0;
  const negative = compact.startsWith('-') || put;
  if (put || (negative && !call)) return -mag;
  return mag;
}

function surfaceXMonths(label: string): number | null {
  const tenor = tenorToMonths(label);
  if (tenor != null) return tenor;
  const raw = label.trim();
  const iso = raw.slice(0, 10);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? Date.parse(`${iso}T00:00:00Z`)
    : Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return ((t - Date.now()) / (365.25 * 24 * 3600 * 1000)) * 12;
}

type SurfaceTenorKnot = { i: number; months: number; label: string };
type SurfaceYKnot = { i: number; value: number; label: string };

type SurfaceTenorYLayout = {
  axisY: 'delta' | 'strike';
  tenorOnX: boolean;
  tenors: SurfaceTenorKnot[];
  yTicks: SurfaceYKnot[];
};

function surfaceTenorYLayout(
  surface: StoredIpaVolSurface,
): SurfaceTenorYLayout | null {
  const xTenors = knotsFromLabels(surface.xLabels, surface.xAxis, 'tenor');
  const yDeltas = knotsFromLabels(surface.yLabels, surface.yAxis, 'delta');
  if (xTenors.length > 0 && yDeltas.length > 0) {
    return {
      axisY: 'delta',
      tenorOnX: true,
      tenors: xTenors,
      yTicks: yDeltas,
    };
  }
  const yTenors = knotsFromLabels(surface.yLabels, surface.yAxis, 'tenor');
  const xDeltas = knotsFromLabels(surface.xLabels, surface.xAxis, 'delta');
  if (yTenors.length > 0 && xDeltas.length > 0) {
    return {
      axisY: 'delta',
      tenorOnX: false,
      tenors: yTenors,
      yTicks: xDeltas,
    };
  }
  const yStrikes = knotsFromLabels(surface.yLabels, surface.yAxis, 'strike');
  if (xTenors.length > 0 && yStrikes.length > 0) {
    return {
      axisY: 'strike',
      tenorOnX: true,
      tenors: xTenors,
      yTicks: yStrikes,
    };
  }
  const xStrikes = knotsFromLabels(surface.xLabels, surface.xAxis, 'strike');
  if (yTenors.length > 0 && xStrikes.length > 0) {
    return {
      axisY: 'strike',
      tenorOnX: false,
      tenors: yTenors,
      yTicks: xStrikes,
    };
  }
  return null;
}

function knotsFromLabels(
  labels: string[],
  _axis: StoredIpaVolSurface['xAxis'],
  want: 'tenor' | 'delta' | 'strike',
): { i: number; months: number; value: number; label: string }[] {
  const out: { i: number; months: number; value: number; label: string }[] = [];
  labels.forEach((label, i) => {
    if (want === 'tenor') {
      const months = surfaceXMonths(label);
      if (months == null || !Number.isFinite(months)) return;
      out.push({ i, months, value: months, label: label.trim() || `${months}M` });
      return;
    }
    if (want === 'delta') {
      const signed = parseDeltaLabel(label);
      if (signed == null) return;
      out.push({
        i,
        months: signed,
        value: signed,
        label: label.trim() || deltaLabel(signed),
      });
      return;
    }
    if (surfaceXMonths(label) != null || parseDeltaLabel(label) != null) return;
    const strike = Number(String(label).replace(/,/g, ''));
    if (!(strike > 0)) return;
    out.push({ i, months: strike, value: strike, label: label.trim() });
  });
  out.sort((a, b) => a.value - b.value);
  return out;
}

function volFromSurfaceAtSignedDelta(
  surface: StoredIpaVolSurface,
  months: number,
  signedDelta: number,
): number | null {
  const layout = surfaceTenorYLayout(surface);
  if (!layout || layout.axisY !== 'delta' || layout.tenors.length === 0 || layout.yTicks.length === 0) {
    return null;
  }
  return bilinearOnLayout(surface, layout, months, signedDelta);
}

function bilinearOnLayout(
  surface: StoredIpaVolSurface,
  layout: SurfaceTenorYLayout,
  tenorMonths: number,
  yValue: number,
): number | null {
  const tenors = [...layout.tenors].sort((a, b) => a.months - b.months);
  const yTicks = [...layout.yTicks].sort((a, b) => a.value - b.value);
  const pickY = nearestPair(yTicks.map(r => r.value), yValue);
  const pickT = nearestPair(tenors.map(c => c.months), tenorMonths);
  const cell = (yi: number, ti: number): number | null => {
    const y = yTicks[yi]!.i;
    const t = tenors[ti]!.i;
    return layout.tenorOnX ? cellVol(surface, y, t) : cellVol(surface, t, y);
  };
  const v00 = cell(pickY.lo, pickT.lo);
  const v01 = cell(pickY.lo, pickT.hi);
  const v10 = cell(pickY.hi, pickT.lo);
  const v11 = cell(pickY.hi, pickT.hi);
  const corners = [v00, v01, v10, v11].filter((v): v is number => v != null);
  if (corners.length === 0) return null;
  const wy = pickY.w;
  const wx = pickT.w;
  const a = v00 ?? v01 ?? v10 ?? v11!;
  const b = v01 ?? v00 ?? v11 ?? v10!;
  const c = v10 ?? v11 ?? v00 ?? v01!;
  const d = v11 ?? v10 ?? v01 ?? v00!;
  const left = a + wy * (c - a);
  const right = b + wy * (d - b);
  return left + wx * (right - left);
}

function compactDeltaLabel(signed: number, raw?: string): string {
  if (Math.abs(signed) < 1e-9) return 'ATM';
  if (raw && /atm/i.test(raw)) return 'ATM';
  return `${Math.round(Math.abs(signed))}${signed < 0 ? 'P' : 'C'}`;
}

function knotVol(
  surface: StoredIpaVolSurface,
  layout: SurfaceTenorYLayout,
  y: SurfaceYKnot,
  t: SurfaceTenorKnot,
): number | null {
  return layout.tenorOnX
    ? cellVol(surface, y.i, t.i)
    : cellVol(surface, t.i, y.i);
}

function medianStrike(cells: (OptionPremiumCell | null)[]): number | null {
  const ks = cells
    .map(c => c?.strike)
    .filter((k): k is number => k != null && k > 0)
    .sort((a, b) => a - b);
  if (ks.length === 0) return null;
  return ks[Math.floor(ks.length / 2)]!;
}

function buildPremiumSurface(args: {
  input: SimTicketPriceInput;
  priced: SimTicketPriceResult;
  surface: StoredIpaVolSurface | null;
  months: number;
  plan: ReturnType<typeof resolveStrike>;
}): OptionPremiumSurface | null {
  if (!args.surface) return null;
  const surface = args.surface;
  const layout = surfaceTenorYLayout(surface);
  if (!layout || layout.tenors.length === 0 || layout.yTicks.length === 0) return null;
  const notionalFcy = Math.abs(args.input.amountLocalM) * 1_000_000;
  if (!(notionalFcy > 0)) return null;
  const tenors = [...layout.tenors].sort((a, b) => a.months - b.months);
  const yTicks = [...layout.yTicks];
  const axisY = layout.axisY;
  const zipped = yTicks.map(y => {
    const row: OptionPremiumRow = {
      value: y.value,
      label: axisY === 'delta' ? compactDeltaLabel(y.value, y.label) : y.label,
      axis: axisY,
    };
    const cells = tenors.map(t => {
      const vol = knotVol(surface, layout, y, t);
      if (vol == null || !(vol > 0)) return null;
      const T = Math.max(1 / 365, Math.max(t.months, 1 / 30) / 12);
      const forward = resolveCurveOutright({
        ccy: args.input.ccy,
        bundle: args.input.bundle,
        spot: args.priced.spot,
        months: Math.max(t.months, 1 / 30),
        quoteSide: args.priced.blend.quoteSide,
      }).outright;
      if (!(forward > 0)) return null;
      const strike = axisY === 'strike'
        ? y.value
        : y.value === 0
          ? forward
          : strikeFromSignedDelta({
              forward,
              vol,
              T,
              signedDelta: y.value,
            });
      if (!(strike > 0)) return null;
      const vanilla = priceVanilla({
        spotMid: args.priced.spot.mid,
        forward,
        strike,
        vol,
        T,
        put: axisY === 'delta' ? y.value < 0 : args.plan.put,
        notionalFcy,
        ccy: args.input.ccy,
      });
      return {
        volPercent: vol * 100,
        strike,
        premiumUsd: vanilla.premiumUsd,
      } satisfies OptionPremiumCell;
    });
    return { row, cells };
  });
  zipped.sort((a, b) => {
    const ka = medianStrike(a.cells);
    const kb = medianStrike(b.cells);
    if (ka != null && kb != null && ka !== kb) return ka - kb;
    return a.row.value - b.row.value;
  });
  const selectedY = axisY === 'strike' && args.priced.quote.strike
    ? args.priced.quote.strike
    : signedDeltaFromPlan(args.plan.deltaPct, args.plan.put);
  return {
    axisY,
    tenors: tenors.map(t => ({ months: t.months, label: t.label })),
    rows: zipped.map(z => z.row),
    cells: zipped.map(z => z.cells),
    selectedTenorMonths: args.months,
    selectedY,
    pulledAt: surface.pulledAt || args.priced.blend.surfacePulledAt,
  };
}

function nearestPair(
  values: number[],
  target: number,
): { lo: number; hi: number; w: number } {
  if (values.length === 1) return { lo: 0, hi: 0, w: 0 };
  let lo = 0;
  let hi = values.length - 1;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! <= target) lo = i;
    if (values[i]! >= target) {
      hi = i;
      break;
    }
  }
  if (lo === hi) return { lo, hi, w: 0 };
  const a = values[lo]!;
  const b = values[hi]!;
  return { lo, hi, w: (target - a) / (b - a) };
}

function deltaToZ(mag: number): number {
  const hit = INV_NORM[String(Math.round(mag))];
  if (hit != null) return hit;
  return invNormCdf(Math.min(0.49, Math.max(0.01, mag / 100)));
}

/** Abramowitz–Stegun 26.2.23 — N^{-1}(p). */
function invNormCdf(p: number): number {
  const pp = Math.min(0.999, Math.max(0.001, p));
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;
  const upper = pp >= 0.5;
  const q = upper ? 1 - pp : pp;
  const t = Math.sqrt(-2 * Math.log(q));
  const z = t - ((c2 * t + c1) * t + c0) / (((d3 * t + d2) * t + d1) * t + 1);
  return upper ? z : -z;
}

function strikeFromSignedDelta(args: {
  forward: number;
  vol: number;
  T: number;
  signedDelta: number;
}): number {
  const { forward, vol, T, signedDelta } = args;
  if (!(forward > 0) || !(vol > 0)) return forward;
  const mag = Math.abs(signedDelta);
  if (mag < 1e-9 || mag >= 49.5) return forward;
  const z = deltaToZ(mag);
  const d1 = signedDelta < 0 ? -z : z;
  const lnFK = d1 * vol * Math.sqrt(T) - 0.5 * vol * vol * T;
  return forward * Math.exp(-lnFK);
}

function strikeFromDelta(args: {
  forward: number;
  vol: number;
  T: number;
  deltaPct: number;
  put: boolean;
}): number {
  const mag = Math.abs(args.deltaPct - 50) < 1e-9 ? 50 : Math.abs(args.deltaPct);
  return strikeFromSignedDelta({
    forward: args.forward,
    vol: args.vol,
    T: args.T,
    signedDelta: args.put ? -mag : mag,
  });
}

function priceVanilla(args: {
  spotMid: number;
  forward: number;
  strike: number;
  vol: number;
  T: number;
  put: boolean;
  notionalFcy: number;
  ccy: string;
  /**
   * Multiplier on the undiscounted Black price. Omitted → spot/forward,
   * which is how the ticket is priced. Spot mode passes the domestic
   * discount 1/(1+r_d τ) so both rates are not collapsed into one factor.
   */
  discount?: number;
}): {
  premiumUsd: number;
  premiumPercent: number;
  deltaPercent: number;
  gammaPercent: number;
  vegaPercent: number;
  thetaPercent: number;
  vannaPercent: number;
  volgaPercent: number;
} {
  const { spotMid, forward, strike, vol, T, put, notionalFcy, ccy } = args;
  const sqrtT = Math.sqrt(Math.max(T, 0));
  const sigmaSqrtT = vol * sqrtT;
  const d1 =
    sigmaSqrtT > 0
      ? (Math.log(forward / strike) + 0.5 * vol * vol * T) / sigmaSqrtT
      : forward >= strike ? 8 : -8;
  const d2 = d1 - sigmaSqrtT;
  const df =
    args.discount != null && Number.isFinite(args.discount)
      ? Math.max(0, args.discount)
      : forward > 0
        ? spotMid / forward
        : 1;
  const undiscounted = put
    ? strike * normCdf(-d2) - forward * normCdf(-d1)
    : forward * normCdf(d1) - strike * normCdf(d2);
  const premQuote = Math.max(0, df * undiscounted);
  const premPct = spotMid > 0 ? (premQuote / spotMid) * 100 : 0;
  const usdPerFcy = isUsdPerFcyQuoted(ccy) ? spotMid : 1 / spotMid;
  const premiumUsd = new Decimal(notionalFcy)
    .mul(usdPerFcy)
    .mul(premPct)
    .div(100)
    .toNumber();
  const deltaSpot = put ? normCdf(d1) - 1 : normCdf(d1);
  const n1 = normPdf(d1);
  // Same Black-on-forward model as the premium: Δ points per 1% spot,
  // premium-% of spot per vol point / calendar day, Δ points per vol point.
  const gammaPercent = sigmaSqrtT > 0 ? n1 / sigmaSqrtT : 0;
  const vegaPercent =
    spotMid > 0 ? (df * forward * n1 * sqrtT) / spotMid : 0;
  const thetaPercent =
    spotMid > 0 && sqrtT > 0
      ? -((df * forward * n1 * vol) / (2 * sqrtT) / spotMid) * (100 / 365)
      : 0;
  const vannaPercent = vol > 0 ? (-n1 * d2) / vol : 0;
  const volgaPercent =
    vol > 0 && spotMid > 0
      ? ((df * forward * n1 * sqrtT * d1 * d2) / (vol * spotMid)) * 0.01
      : 0;
  return {
    premiumUsd,
    premiumPercent: premPct,
    deltaPercent: deltaSpot * 100,
    gammaPercent,
    vegaPercent,
    thetaPercent,
    vannaPercent,
    volgaPercent,
  };
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1
    - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736)
      * t
      + 0.254829592)
      * t
      * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
