/**
 * FX market deposit curves (credit/debit) for carry — seeded from
 * FXOCalculator EURUSD.xlsx CashTable. Deposit Bid = credit, Ask = debit.
 */

import * as XLSX from 'xlsx';
import type { WorkBook } from 'xlsx';
import defaultEurUsd from '@/data/fx-market-rates/EURUSD.json';
import {
  CURRENCY_PARAMS,
  fundingSwapFarSettleMonths,
  roundMoney,
} from '@/lib/fx-buffer';

export interface DepositSideRates {
  /** Earn on long cash — % p.a. (deposit bid). */
  creditPct: number;
  /** Pay on short / OD cash — % p.a. (deposit ask). */
  debitPct: number;
}

export interface DepositTenorRow {
  tenor: string;
  /** Months from spot (approx). */
  months: number | null;
  eur: DepositSideRates;
  usd: DepositSideRates;
  swapPoints?: { bid: number | null; ask: number | null };
  outright?: { bid: number | null; ask: number | null };
}

export interface OvernightCashRates {
  /** Overnight cash credit/debit for base ccy (e.g. EUR) — % p.a. */
  base: DepositSideRates;
  /** Overnight cash credit/debit for USD — % p.a. */
  usd: DepositSideRates;
}

/**
 * How cash interest months pick a rate in Cash Carry / forecast paths.
 * - `current` — flat applied O/N for every month (e.g. LP EUR 1.78%)
 * - `forward` — O/N near 0; SW→1Y deposit ladder for later months
 */
export type CashInterestMode = 'current' | 'forward';

export const DEFAULT_CASH_INTEREST_MODE: CashInterestMode = 'forward';

export function cashInterestModeOf(
  bundle: FxMarketRatesBundle | null | undefined,
): CashInterestMode {
  return bundle?.cashInterestMode === 'current' ? 'current' : 'forward';
}

export interface FxMarketRatesBundle {
  pair: string;
  baseCcy: string;
  quoteCcy: string;
  sourceFile: string;
  asOf?: { tradeDate?: string | null; spotDate?: string | null };
  spot?: { bid: number; ask: number; mid: number };
  /**
   * Overnight cash rates (credit/debit) — used for cash interest income /
   * funding, NOT for forward CIP pricing.
   */
  overnightCash?: OvernightCashRates;
  /**
   * Cash interest tenor selection for analytics (not swap-points FWD).
   * Default: forward (term ladder).
   */
  cashInterestMode?: CashInterestMode;
  /** Term deposit / yield curve — used for forward CIP / points pricing. */
  deposits: DepositTenorRow[];
  volatility?: unknown[];
  parameters?: Record<string, unknown>;
  legsSnapshot?: unknown;
  rateConvention?: Record<string, string>;
}

/** Default overnight cash from JPM NP credit/debit (CURRENCY_PARAMS). */
export function defaultOvernightCashFromLp(
  baseCcy = 'EUR',
): OvernightCashRates {
  const base = CURRENCY_PARAMS[baseCcy];
  const usd = CURRENCY_PARAMS.USD;
  return {
    base: {
      creditPct: base?.carry ?? 0,
      debitPct: base?.r_OD ?? base?.carry ?? 0,
    },
    usd: {
      creditPct: usd?.carry ?? 3.5,
      debitPct: usd?.r_OD ?? 3.89,
    },
  };
}

/** Market quote vs USD is USD per 1 FCY. Every other FCY is units per 1 USD. */
const USD_PER_FCY_QUOTED = new Set(['EUR', 'GBP', 'AUD', 'NZD']);

export function isUsdPerFcyQuoted(ccy: string): boolean {
  return USD_PER_FCY_QUOTED.has(ccy.toUpperCase());
}

/** Market pair vs USD: EURUSD / GBPUSD / AUDUSD / NZDUSD, else USDPLN, USDJPY, … */
export function usdMarketPair(ccy: string): string {
  const c = ccy.toUpperCase();
  if (!c || c === 'USD') return 'USD';
  return isUsdPerFcyQuoted(c) ? `${c}USD` : `USD${c}`;
}

function fcyCcyOf(
  bundle: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy'>,
): string {
  const desk = (bundle.baseCcy || '').toUpperCase();
  if (desk && desk !== 'USD' && CURRENCY_PARAMS[desk]) return desk;
  const pair = (bundle.pair || '').replace('/', '').toUpperCase();
  const a = pair.slice(0, 3);
  const b = pair.slice(3, 6);
  if (a === 'USD' && b && b !== 'USD') return b;
  if (b === 'USD' && a && a !== 'USD') return a;
  if (desk && desk !== 'USD') return desk;
  return a && a !== 'USD' ? a : (b || 'EUR');
}

/**
 * True when the market quote is FCY per 1 USD (USDPLN, USDJPY, USDCHF, …).
 * EUR / GBP / AUD / NZD are the only USD-per-FCY quotes. Pair labels do not
 * change that — a PLN book is USDPLN even if the file cell says PLNUSD.
 */
export function isUsdBaseFcyPair(
  bundle: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy' | 'spot'>,
): boolean {
  const fcy = fcyCcyOf(bundle);
  return fcy !== 'USD' && !isUsdPerFcyQuoted(fcy);
}

/** Ensure overnight cash exists (seed LP if missing). */
export function normalizeMarketRatesBundle(
  bundle: FxMarketRatesBundle,
  deskCcy?: string,
): FxMarketRatesBundle {
  const baseCcy = (deskCcy || bundle.baseCcy || 'EUR').toUpperCase();
  const pair = usdMarketPair(baseCcy);
  const quoteCcy = isUsdPerFcyQuoted(baseCcy) ? 'USD' : baseCcy;
  const overnightCash =
    bundle.overnightCash ??
    defaultOvernightCashFromLp(baseCcy);
  const canon = {
    ...bundle,
    baseCcy,
    pair,
    quoteCcy,
    overnightCash,
  };
  let spot = bundle.spot;
  let deposits = bundle.deposits;
  if (spot?.mid && isUsdBaseFcyPair({ ...canon, spot })) {
    const lp = CURRENCY_PARAMS[baseCcy]?.spot;
    const mid = spot.mid;
    const tms = lp > 0 ? 1 / lp : 0;
    if (lp > 0 && mid > 0) {
      const isFcyPerUsd = mid * lp > 0.85 && mid * lp < 1.15;
      const isUsdPerFcy = mid / lp > 0.85 && mid / lp < 1.15;
      if (isUsdPerFcy && !isFcyPerUsd) {
        spot = {
          bid: 1 / (spot.ask || mid),
          ask: 1 / (spot.bid || mid),
          mid: 1 / mid,
        };
      } else if (!isFcyPerUsd && tms > 0) {
        // EURUSD ~1.16 on a PLN book is not USDPLN. TMS quote; drop foreign points.
        spot = { bid: tms, ask: tms, mid: tms };
        deposits = stripQuotedForwards(deposits);
      }
    }
  }
  return {
    ...canon,
    spot,
    deposits,
    rateConvention: {
      depositBid: 'term credit — forward CIP / points',
      depositAsk: 'term debit — forward CIP / points',
      overnightBid: 'overnight cash credit — cash interest layer',
      overnightAsk: 'overnight cash debit — cash interest layer',
      units: 'percent p.a.',
      ...(bundle.rateConvention ?? {}),
    },
  };
}

const TENOR_MONTHS: Record<string, number> = {
  ON: 1 / 30,
  TN: 2 / 30,
  SN: 1 / 30,
  SW: 7 / 30,
  '1W': 7 / 30,
  '2W': 14 / 30,
  '3W': 21 / 30,
  '1M': 1,
  '2M': 2,
  '3M': 3,
  '4M': 4,
  '5M': 5,
  '6M': 6,
  '7M': 7,
  '8M': 8,
  '9M': 9,
  '10M': 10,
  '11M': 11,
  '1Y': 12,
  '15M': 15,
  '18M': 18,
  '21M': 21,
  '2Y': 24,
  '30M': 30,
  '3Y': 36,
  '4Y': 48,
  '5Y': 60,
  '6Y': 72,
  '7Y': 84,
  '8Y': 96,
  '9Y': 108,
  '10Y': 120,
};

const STORAGE_KEY = 'treasury.fxMarketRates.v1';
const STORAGE_SCOPE_PREFIX = 'treasury.fxMarketRates.scope.';

export function marketRatesStorageKey(scopeId?: string | null): string {
  if (scopeId != null && scopeId.trim() !== '') {
    return `${STORAGE_SCOPE_PREFIX}${scopeId.trim()}`;
  }
  return STORAGE_KEY;
}

/** Bundled seed from FXOCalculator EURUSD.xlsx (+ LP overnight cash). */
export const DEFAULT_EURUSD_MARKET_RATES: FxMarketRatesBundle =
  normalizeMarketRatesBundle({
    ...(defaultEurUsd as FxMarketRatesBundle),
    overnightCash:
      (defaultEurUsd as FxMarketRatesBundle).overnightCash ??
      defaultOvernightCashFromLp('EUR'),
  });

export function selectCreditDebitRate(
  signedAmount: number,
  creditPct: number,
  debitPct: number,
): { ratePct: number; side: 'credit' | 'debit' } {
  if (signedAmount >= 0) return { ratePct: creditPct, side: 'credit' };
  return { ratePct: debitPct, side: 'debit' };
}

/** File spot is this FCY's USD quote (FCY per USD or USD per FCY), not a peer pair. */
function spotMatchesDeskQuote(mid: number, fcy: string): boolean {
  const lp = CURRENCY_PARAMS[fcy]?.spot;
  if (!(lp > 0) || !(mid > 0)) return false;
  const fcyPerUsd = 1 / lp;
  if (mid / fcyPerUsd > 0.85 && mid / fcyPerUsd < 1.15) return true;
  if (mid / lp > 0.85 && mid / lp < 1.15) return true;
  return false;
}

function stripQuotedForwards(
  deposits: readonly DepositTenorRow[],
): DepositTenorRow[] {
  return deposits.map(d => ({
    tenor: d.tenor,
    months: d.months,
    eur: d.eur,
    usd: d.usd,
  }));
}

/** FCY per 1 USD — the quote the points sit on for every non-EUR/GBP/AUD/NZD pair. */
function usdBasePairSpot(
  bundle: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy' | 'spot'>,
): number {
  const fcy = fcyCcyOf(bundle);
  const usdPerFcy = CURRENCY_PARAMS[fcy]?.spot;
  const tmsFcyPerUsd = usdPerFcy > 0 ? 1 / usdPerFcy : 0;
  const mid = bundle.spot?.mid;
  if (!(typeof mid === 'number' && mid > 0)) return tmsFcyPerUsd;
  // Already FCY per 1 USD (USDPLN ~3.64, USDJPY ~160).
  if (usdPerFcy > 0 && mid * usdPerFcy > 0.85 && mid * usdPerFcy < 1.15) return mid;
  // USD per 1 FCY, or a peer pair (EURUSD ~1.16 on PLN) — never treat those as USDPLN.
  return tmsFcyPerUsd;
}

/** Points column is FCY per 1 USD. `points` unused — call sites stay stable. */
export function swapPointsQuotedUsdPerDollar(
  bundle: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy' | 'spot' | 'deposits'>,
  _points?: number,
): boolean {
  return isUsdBaseFcyPair(bundle);
}

/** Pair-native F−S. FXOCalculator: F ≈ S + points/10_000 (JPY /100). */
export function swapPointsToPriceDelta(
  points: number,
  pairOrCcy = 'EURUSD',
): number {
  const p = pairOrCcy.replace('/', '').toUpperCase();
  const jpy = p === 'JPY' || p.includes('JPY');
  return points / (jpy ? 100 : 10_000);
}

/**
 * Swap points → USD per 1 FCY.
 *
 * EUR / GBP / AUD / NZD (USD per FCY): Δ = points / 10_000 (JPY / 100).
 *
 * USDPLN / USDJPY / USDCHF / … (FCY per 1 USD): the file points sit on that
 * quote. Convert, do not multiply N × pts/10_000:
 *   S = PLN per 1 USD (spot ~3.64; invert the book USD/PLN if needed)
 *   F = S + points / 10_000
 *   Δ = 1/F − 1/S
 * Negative USDPLN points ⇒ F < S ⇒ Δ > 0. A long (sell PLN far) earns CIP.
 */
export function swapPointsToUsdPerFcyDelta(
  points: number,
  bundle: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy' | 'spot' | 'deposits'>,
): number {
  const fcy = fcyCcyOf(bundle);
  const quoteDelta = swapPointsToPriceDelta(points, fcy);
  if (!swapPointsQuotedUsdPerDollar(bundle, points)) return quoteDelta;
  const S = usdBasePairSpot(bundle);
  if (!(S > 0)) return 0;
  const F = S + quoteDelta;
  if (!(F > 0)) return 0;
  return 1 / F - 1 / S;
}

/**
 * Forward-forward swap points → USD per 1 FCY, for a leg that itself starts
 * forward (not at spot) and runs to a later date. `pointsNear`/`pointsFar` are
 * the curve's spot-to-X-month points at the leg's own start and end dates —
 * NOT the tenor of the leg. Reading the curve's tenor-from-spot knot for a
 * forward-starting leg prices the wrong window entirely once the curve has
 * any slope: spot-to-7-months is not the same trade as 5-months-forward-to-
 * 12-months-forward, even though both are "7 months" long.
 *
 * pointsNear = 0 (a spot-starting leg) reduces this exactly to
 * {@link swapPointsToUsdPerFcyDelta} — same formula, same answer.
 */
export function swapPointsToUsdPerFcyFwdFwdDelta(
  pointsNear: number,
  pointsFar: number,
  bundle: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy' | 'spot' | 'deposits'>,
): number {
  const fcy = fcyCcyOf(bundle);
  const deltaNear = swapPointsToPriceDelta(pointsNear, fcy);
  const deltaFar = swapPointsToPriceDelta(pointsFar, fcy);
  if (!swapPointsQuotedUsdPerDollar(bundle, pointsFar)) return deltaFar - deltaNear;
  const S = usdBasePairSpot(bundle);
  if (!(S > 0)) return 0;
  const Fnear = S + deltaNear;
  const Ffar = S + deltaFar;
  if (!(Fnear > 0) || !(Ffar > 0)) return 0;
  return 1 / Ffar - 1 / Fnear;
}

/** First CIP knot — ON/SW/1W/2W are not the 3W–12M swap-points profile. */
const CIP_CURVE_MIN_MONTHS = 21 / 30;
const CIP_STUB_TENORS = new Set(['ON', 'TN', 'SN', 'SW', '1W', '2W']);

function canonTenor(tenor: string): string {
  return tenor.trim().toUpperCase().replace(/\s+/g, '');
}

export interface SwapPointsKnot {
  tenor: string;
  months: number;
  bid: number;
  ask: number;
  mid: number;
}

export interface CipTenorBucket extends SwapPointsKnot {
  /** CIP P&L on the supplied standing, priced at this knot's mid. */
  cipUsdM: number;
  booked: boolean;
}

function tenorLabelFromMonths(months: number): string {
  let best: { tenor: string; d: number } | null = null;
  for (const [tenor, m] of Object.entries(TENOR_MONTHS)) {
    const d = Math.abs(m - months);
    if (!best || d < best.d) best = { tenor, d };
  }
  return best && best.d < 0.2 ? best.tenor : `${months.toFixed(1)}M`;
}

/**
 * 3W+ knots on the uploaded swap-points column. ON/SW/1W/2W are excluded.
 * Duplicate tenors keep the first row.
 */
export function swapPointsTenorCurve(
  deposits: readonly DepositTenorRow[],
  _bundle?: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy' | 'spot'>,
): SwapPointsKnot[] {
  const seen = new Set<string>();
  const raw: SwapPointsKnot[] = [];
  for (const d of deposits) {
    const tenor = canonTenor(d.tenor || '');
    if (CIP_STUB_TENORS.has(tenor)) continue;
    const months = d.months ?? TENOR_MONTHS[tenor] ?? null;
    if (months == null || !Number.isFinite(months)) continue;
    if ((months as number) < CIP_CURVE_MIN_MONTHS - 1e-9) continue;
    const key = tenor || `${(months as number).toFixed(3)}`;
    if (seen.has(key)) continue;
    const bid = d.swapPoints?.bid ?? null;
    const ask = d.swapPoints?.ask ?? null;
    if (bid == null || ask == null) continue;
    seen.add(key);
    raw.push({
      tenor: tenor || tenorLabelFromMonths(months as number),
      months: months as number,
      bid,
      ask,
      mid: (bid + ask) / 2,
    });
  }
  raw.sort((a, b) => a.months - b.months);
  return raw;
}

/** True when the 3W+ swap-points column can price CIP (not an O/N-only shell). */
export function bundleHasCipSwapPoints(
  bundle: FxMarketRatesBundle | null | undefined,
): boolean {
  if (!bundle?.deposits?.length) return false;
  return swapPointsTenorCurve(bundle.deposits, bundle).length > 0;
}

/** EURUSD seed, keeping a desk shell's overnight / cash-interest mode. */
function eurUsdSeedForDesk(shell?: FxMarketRatesBundle): FxMarketRatesBundle {
  if (!shell) return DEFAULT_EURUSD_MARKET_RATES;
  return normalizeMarketRatesBundle({
    ...DEFAULT_EURUSD_MARKET_RATES,
    overnightCash:
      shell.overnightCash ?? DEFAULT_EURUSD_MARKET_RATES.overnightCash,
    cashInterestMode:
      shell.cashInterestMode ?? DEFAULT_EURUSD_MARKET_RATES.cashInterestMode,
  }, 'EUR');
}

/** Interpolate bid/ask/mid on the 3W+ swap-points profile (not ON/SW). */
export function interpolateSwapPoints(
  deposits: readonly DepositTenorRow[],
  months: number,
  bundle?: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy' | 'spot'>,
): { bid: number; ask: number; mid: number } | null {
  const pts = swapPointsTenorCurve(deposits, bundle);
  if (pts.length === 0) return null;
  const t = Math.max(CIP_CURVE_MIN_MONTHS, months);
  const lerp = (
    a: SwapPointsKnot,
    b: SwapPointsKnot,
    w: number,
  ): { bid: number; ask: number; mid: number } => {
    const bid = a.bid + w * (b.bid - a.bid);
    const ask = a.ask + w * (b.ask - a.ask);
    return { bid, ask, mid: (bid + ask) / 2 };
  };
  if (t <= pts[0]!.months) {
    const p = pts[0]!;
    return { bid: p.bid, ask: p.ask, mid: p.mid };
  }
  const last = pts[pts.length - 1]!;
  if (t >= last.months) {
    return { bid: last.bid, ask: last.ask, mid: last.mid };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (t >= a.months && t <= b.months) {
      const w = (t - a.months) / Math.max(1e-12, b.months - a.months);
      return lerp(a, b, w);
    }
  }
  return { bid: last.bid, ask: last.ask, mid: last.mid };
}

/**
 * CIP-implied FCY rate (% p.a.) for a window on the swap-points curve.
 *
 * F and S are USD per 1 FCY (EURUSD / inverted USDPLN). Covered parity:
 *   F/S ≈ (1 + r_USD τ) / (1 + r_FCY τ)
 *   r_FCY = r_USD − (F−S)/S × (365/tenor_days)
 *
 * EURUSD 1M points are a premium (F > S) because r_EUR < r_USD — that is PAY
 * for long EUR, not EARN. The plus form of this identity flips the tilt and
 * the mean-variance mix then shorts correlated names (GBP/PLN) as hedges.
 *
 * Reads MID points — a rate estimate for sizing/allocation, not a trade
 * price (unlike {@link fwdCarryFromSwapPointsUsdM}, which picks bid/ask by
 * trade direction). `startMonths > 0` prices the forward-forward window.
 */
export function impliedCarryRatePct(
  bundle: Pick<FxMarketRatesBundle, 'pair' | 'baseCcy' | 'quoteCcy' | 'spot' | 'deposits'>,
  tenorMonths: number,
  startMonths = 0,
  rUsdPct = 0,
): number | null {
  const mid = bundle.spot?.mid;
  if (!(typeof mid === 'number' && mid > 0) || !(tenorMonths > 0)) return null;
  const sUsd = isUsdBaseFcyPair(bundle) ? 1 / usdBasePairSpot(bundle) : mid;
  if (!(sUsd > 0)) return null;
  const far = interpolateSwapPoints(bundle.deposits, startMonths + tenorMonths, bundle);
  if (!far) return null;
  const tenorDays = tenorMonths * 30;
  let delta: number;
  if (startMonths < 1e-9) {
    delta = swapPointsToUsdPerFcyDelta(far.mid, bundle);
  } else {
    const near = interpolateSwapPoints(bundle.deposits, startMonths, bundle);
    if (!near) return null;
    delta = swapPointsToUsdPerFcyFwdFwdDelta(near.mid, far.mid, bundle);
  }
  // delta = F − S in USD per FCY. Premium (delta > 0) ⇒ r_FCY < r_USD.
  return rUsdPct - (delta / sUsd) * (365 / tenorDays) * 100;
}

/**
 * Mid CIP knots for the booked far. Rolling (1M) returns only the 1M knot —
 * later tenors are not monthly rolls. Term returns knots up to the forecast.
 */
export function cipTenorProfile(input: {
  notionalLocalM: number;
  bundle: FxMarketRatesBundle;
  bookedMonths?: number;
  /** Inclusive cap in months (forecast horizon). */
  maxMonths?: number;
}): CipTenorBucket[] {
  const N = input.notionalLocalM;
  const booked = input.bookedMonths;
  const cap =
    typeof input.maxMonths === 'number' && Number.isFinite(input.maxMonths)
      ? input.maxMonths
      : Infinity;
  const rolling =
    typeof booked === 'number'
    && Number.isFinite(booked)
    && booked <= 1 + 0.35;
  return swapPointsTenorCurve(input.bundle.deposits, input.bundle)
    .filter(k => {
      if (k.months > cap + 0.35) return false;
      if (rolling) return Math.abs(k.months - 1) < 0.35;
      return true;
    })
    .map(k => ({
      ...k,
      cipUsdM: N * swapPointsToUsdPerFcyDelta(k.mid, input.bundle),
      booked:
        typeof booked === 'number'
        && Number.isFinite(booked)
        && Math.abs(k.months - booked) < 0.35,
    }));
}

/**
 * Far-leg CIP at the settle tenor, priced on the 3W+ swap-points curve.
 * P&L = N_FCY_M × Δ(USD per FCY). FCY-per-USD quotes invert 1/F − 1/S.
 *
 * Quote side: sell FCY far → ask; buy FCY far → bid.
 * On USDPLN that means a long cover (sell PLN far) takes the ask — the
 * less-negative side when points are negative.
 */
export function fwdCarryFromSwapPointsUsdM(input: {
  notionalLocalM: number;
  /** Duration of the leg — spot-to-settleMonths when startMonths is 0/omitted. */
  settleMonths: number;
  /**
   * Months from spot the leg itself starts. 0 (default) = spot-starting (the
   * curve's settleMonths knot, as before). > 0 = forward-starting — priced off
   * the forward-forward window (curve at startMonths → curve at
   * startMonths+settleMonths), not the spot-to-settleMonths knot. A
   * forward-starting leg read off the wrong window misprices it the moment
   * the curve has any slope, even though "months long" looks the same.
   */
  startMonths?: number;
  bundle: FxMarketRatesBundle;
}): {
  fwdCarryUsdM: number;
  points: number;
  priceDelta: number;
  side: 'bid' | 'ask' | 'mid';
} | null {
  const N = input.notionalLocalM;
  if (Math.abs(N) < 1e-12) {
    return { fwdCarryUsdM: 0, points: 0, priceDelta: 0, side: 'mid' };
  }
  const mid = input.bundle.spot?.mid;
  if (
    typeof mid === 'number'
    && mid > 0
    && isUsdBaseFcyPair(input.bundle)
    && !spotMatchesDeskQuote(mid, fcyCcyOf(input.bundle))
  ) {
    return null;
  }
  // Sell FCY far (N > 0 covering long) → ask; buy FCY far (N < 0) → bid.
  // USDPLN ask is the RHS — less negative when the points column is negative.
  const side: 'bid' | 'ask' = N >= 0 ? 'ask' : 'bid';
  const pick = (c: { bid: number; ask: number; mid: number }) => c[side];
  const startMonths = Math.max(0, input.startMonths ?? 0);
  const farCurve = interpolateSwapPoints(
    input.bundle.deposits,
    startMonths + input.settleMonths,
    input.bundle,
  );
  if (!farCurve) return null;
  if (startMonths < 1e-9) {
    const points = pick(farCurve);
    const priceDelta = swapPointsToUsdPerFcyDelta(points, input.bundle);
    return { fwdCarryUsdM: N * priceDelta, points, priceDelta, side };
  }
  const nearCurve = interpolateSwapPoints(
    input.bundle.deposits,
    startMonths,
    input.bundle,
  );
  if (!nearCurve) return null;
  const nearPts = pick(nearCurve);
  const farPts = pick(farCurve);
  const priceDelta = swapPointsToUsdPerFcyFwdFwdDelta(
    nearPts, farPts, input.bundle,
  );
  return {
    fwdCarryUsdM: N * priceDelta,
    points: roundMoney(farPts - nearPts, 6),
    priceDelta,
    side,
  };
}

/**
 * Locked-far monthly CIP: the settle-tenor points, spread evenly over the
 * months the far is alive. Not CIP(t) − CIP(t−1) along the curve — that walk
 * treats calendar month M4 as a 4M tenor and can flip sign vs the booked far.
 */
export function fwdCarryMonthlyAccrualUsdM(input: {
  notionalLocalM: number;
  settleMonths: number;
  month: number;
  bundle: FxMarketRatesBundle;
}): number {
  const S = input.settleMonths;
  const m = input.month;
  if (S < 1 - 1e-12 || m < 1 - 1e-12 || m > S + 1e-12) return 0;
  const total = fwdCarryFromSwapPointsUsdM({
    notionalLocalM: input.notionalLocalM,
    settleMonths: S,
    bundle: input.bundle,
  });
  if (!total) return 0;
  return total.fwdCarryUsdM / S;
}

/**
 * Funding-swap far-leg CIP P&L ($M over the tenor) from the swap-points curve.
 * Same side rule as {@link fwdCarryFromSwapPointsUsdM}: long standing sells
 * FCY far → ask; short standing buys FCY far → bid. Overnight cash Δr is not used.
 */
export function fundingSwapFarLegCipUsdM(input: {
  standingLocalM: number;
  settleMonths: number;
  /** Months from spot this leg itself starts — 0/omitted = spot-starting. */
  startMonths?: number;
  bundle?: FxMarketRatesBundle | null;
  /** Deposit-rate CIP fallback already scaled to the tenor ($M). */
  fallbackUsdM?: number;
}): number {
  const N = input.standingLocalM;
  if (Math.abs(N) < 1e-12) return 0;
  if (input.settleMonths < 1 - 1e-12) return 0;
  if (input.bundle) {
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: N,
      settleMonths: input.settleMonths,
      startMonths: input.startMonths,
      bundle: input.bundle,
    });
    if (pts) return pts.fwdCarryUsdM;
  }
  return input.fallbackUsdM ?? 0;
}

/**
 * Desk CIP on the funding far: term = 12M (or far-cycle) points on M1 standing;
 * rolling = Σ 1M points on each cycle's outstanding. Not overnight cash Δr.
 */
export function fundingSwapPathFarCipUsdM(input: {
  plan?: readonly {
    standing_swap: number;
    cycleIndex?: number;
    far_leg?: number;
    /** Incremental leg this cycle adds — the notional a stripTerm tranche prices on. */
    swap_needed?: number;
  }[];
  standingFallback: number;
  forecastMonths: number;
  bundle?: FxMarketRatesBundle | null;
  fallbackAnnualUsdYr: (standing: number) => number;
  /** When `rolling`, never treat stray `far_leg` as term cover. */
  bookingMode?: 'rolling' | 'term' | 'stripTerm';
}): number {
  const cipAt = (standing: number, months: number, startMonths = 0) =>
    fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: months,
      startMonths,
      bundle: input.bundle,
      fallbackUsdM: input.fallbackAnnualUsdYr(standing) * (months / 12),
    });

  const plan = input.plan;
  if (!plan?.length) {
    return cipAt(input.standingFallback, Math.max(1, input.forecastMonths));
  }
  // Strip to term: every leg is its OWN forward-starting tranche held to the
  // same fixed maturity, priced ONCE on its own incremental notional
  // (swap_needed) at ITS OWN remaining tenor, off the forward-forward window
  // from ITS OWN start date to the horizon — not the curve's spot-to-tenor
  // knot, which prices the wrong window the moment the curve has any slope.
  // Pricing the cumulative standing_swap here would also re-price every
  // earlier tranche again at each later cycle's tenor too — the same money
  // counted at 12M, then again at 11M, again at 10M... Both a `term` and a
  // `stripTerm` plan carry a closing far_leg, so this must branch before the
  // far_leg-based term detection below or it would misread a multi-leg strip
  // as one bullet swap priced on M1 alone.
  if (input.bookingMode === 'stripTerm') {
    const horizon = Math.max(1, input.forecastMonths);
    return plan.reduce((s, p, i) => {
      const notional = p.swap_needed ?? p.standing_swap;
      if (Math.abs(notional) < 1e-9) return s;
      const startMonths = p.cycleIndex ?? i;
      const tenor = Math.max(0, horizon - startMonths);
      return tenor < 1 - 1e-9 ? s : s + cipAt(notional, tenor, startMonths);
    }, 0);
  }
  const term = input.bookingMode === 'term'
    || (input.bookingMode !== 'rolling'
      && plan.some(p => Math.abs(p.far_leg ?? 0) > 0.001));
  if (term) {
    return cipAt(
      plan[0]!.standing_swap,
      fundingSwapFarSettleMonths(plan, input.forecastMonths),
    );
  }
  // Rolling: each cycle's fresh 1-month roll is itself forward-starting once
  // cycleIndex > 0 — cycle k's window is [k, k+1], priced off the
  // forward-forward rate for that window, not the curve's spot-to-1M knot
  // reused unchanged for every cycle regardless of how far out it is.
  return plan.reduce(
    (s, p, i) => s + cipAt(p.standing_swap, 1, p.cycleIndex ?? i),
    0,
  );
}

/** Linear interpolate credit/debit on a sorted deposit curve at `months`. */
export function interpolateDepositSide(
  deposits: readonly DepositTenorRow[],
  ccy: 'eur' | 'usd',
  months: number,
): DepositSideRates {
  const pts = deposits
    .filter(d => d.months != null && Number.isFinite(d.months))
    .map(d => ({
      m: d.months as number,
      creditPct: d[ccy].creditPct,
      debitPct: d[ccy].debitPct,
    }))
    .sort((a, b) => a.m - b.m);
  if (pts.length === 0) {
    return { creditPct: 0, debitPct: 0 };
  }
  const t = Math.max(0, months);
  if (t <= pts[0]!.m) {
    return { creditPct: pts[0]!.creditPct, debitPct: pts[0]!.debitPct };
  }
  const last = pts[pts.length - 1]!;
  if (t >= last.m) {
    return { creditPct: last.creditPct, debitPct: last.debitPct };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (t >= a.m && t <= b.m) {
      const w = (t - a.m) / Math.max(1e-12, b.m - a.m);
      return {
        creditPct: a.creditPct + w * (b.creditPct - a.creditPct),
        debitPct: a.debitPct + w * (b.debitPct - a.debitPct),
      };
    }
  }
  return { creditPct: last.creditPct, debitPct: last.debitPct };
}

export const SW_TO_ON_EUR: DepositSideRates = {
  creditPct: 2.15,
  debitPct: 2.35,
};

/** Overnight from short-end deposit row: ON → TN → SN → SW → 1W. */
export function overnightCashFromDeposits(
  deposits: readonly DepositTenorRow[],
  baseCcy = 'EUR',
): OvernightCashRates {
  const onRow =
    deposits.find(d => d.tenor === 'ON') ??
    deposits.find(d => d.tenor === 'TN') ??
    deposits.find(d => d.tenor === 'SN');
  if (onRow) {
    return { base: { ...onRow.eur }, usd: { ...onRow.usd } };
  }

  // No true O/N row — SW/1W is the short-end proxy. For EUR, desk O/N is
  // fixed (not raw SW deposit bid/ask); USD still comes from the SW usd column.
  const swRow =
    deposits.find(d => d.tenor === 'SW') ??
    deposits.find(d => d.tenor === '1W');
  if (swRow) {
    const base =
      baseCcy.toUpperCase() === 'EUR'
        ? { ...SW_TO_ON_EUR }
        : { ...swRow.eur };
    return { base, usd: { ...swRow.usd } };
  }

  return defaultOvernightCashFromLp(baseCcy);
}

const SHORT_END_TENORS = ['ON', 'TN', 'SN', 'SW', '1W'] as const;

export function shortEndDepositTenor(
  deposits: readonly DepositTenorRow[],
): string | null {
  for (const t of SHORT_END_TENORS) {
    if (deposits.some(d => d.tenor === t)) return t;
  }
  return null;
}

/**
 * Effective overnight for a bundle.
 * Applied `overnightCash` wins (set via UI Apply or ON row in file).
 * Else ON/TN/SN deposit row; else LP — SW is term-only until user Applies O/N.
 */
export function effectiveOvernightCash(
  bundle: FxMarketRatesBundle | null | undefined,
  baseCcy?: string,
): OvernightCashRates {
  const ccy = (baseCcy || bundle?.baseCcy || 'EUR').toUpperCase();
  if (bundle?.overnightCash) {
    return {
      base: { ...bundle.overnightCash.base },
      usd: { ...bundle.overnightCash.usd },
    };
  }
  const deposits = bundle?.deposits ?? [];
  const onRow =
    deposits.find(d => d.tenor === 'ON') ??
    deposits.find(d => d.tenor === 'TN') ??
    deposits.find(d => d.tenor === 'SN');
  if (onRow) {
    return { base: { ...onRow.eur }, usd: { ...onRow.usd } };
  }
  return defaultOvernightCashFromLp(ccy);
}

/** Suggested O/N from SW (EUR desk 2.15/2.35; else copy SW deposits). */
export function suggestOvernightFromSw(
  deposits: readonly DepositTenorRow[],
  baseCcy = 'EUR',
): OvernightCashRates | null {
  return overnightCashFromDeposits(
    deposits.filter(d => !['ON', 'TN', 'SN'].includes(d.tenor)),
    baseCcy,
  );
}

/** Empty per-CCY shell — LP overnight, no term curve (until upload). */
export function emptyMarketRatesForCcy(ccy: string): FxMarketRatesBundle {
  const base = (ccy || 'EUR').toUpperCase();
  const pair = usdMarketPair(base);
  return normalizeMarketRatesBundle({
    pair,
    baseCcy: base,
    quoteCcy: pair === 'USD' ? 'USD' : pair.slice(3, 6) || 'USD',
    sourceFile: 'LP defaults (no upload)',
    overnightCash: defaultOvernightCashFromLp(base),
    deposits: [],
  });
}

/**
 * Book-level USD O/N — same for every FCY pair (not from that pair’s USD column).
 * Prefers any applied `overnightCash.usd`; else JPM NP USD.
 */
export function pickSharedUsdOvernight(
  marketRatesByCcy: Record<string, FxMarketRatesBundle> | undefined,
): DepositSideRates {
  for (const bundle of Object.values(marketRatesByCcy ?? {})) {
    const usd = bundle?.overnightCash?.usd;
    if (
      usd &&
      Number.isFinite(usd.creditPct) &&
      Number.isFinite(usd.debitPct)
    ) {
      return { creditPct: usd.creditPct, debitPct: usd.debitPct };
    }
  }
  return { ...defaultOvernightCashFromLp('EUR').usd };
}

/** Stamp the same USD O/N onto every currency bundle in the book. */
export function stampSharedUsdOvernight(
  marketRatesByCcy: Record<string, FxMarketRatesBundle> | undefined,
  usd: DepositSideRates,
): Record<string, FxMarketRatesBundle> {
  const map = { ...(marketRatesByCcy ?? {}) };
  const shared = { creditPct: usd.creditPct, debitPct: usd.debitPct };
  for (const ccy of Object.keys(map)) {
    const bundle = map[ccy]!;
    const on =
      bundle.overnightCash ?? defaultOvernightCashFromLp(bundle.baseCcy || ccy);
    map[ccy] = normalizeMarketRatesBundle({
      ...bundle,
      overnightCash: {
        base: { ...on.base },
        usd: { ...shared },
      },
    }, ccy);
  }
  return map;
}

/**
 * Overnight cash credit/debit — for cash interest / funding only.
 * Separate from term deposits used to price forwards.
 * Uses the bundle when it belongs to `ccy` (per-CCY upload map).
 * USD O/N is book-shared (same on every pair); pass a peer FCY bundle that
 * already has the stamped `overnightCash.usd`.
 */
export function resolveOvernightCashRates(
  bundle: FxMarketRatesBundle | null | undefined,
  ccy: string,
): {
  fcy: DepositSideRates;
  usd: DepositSideRates;
  source: string;
} {
  const normalized = bundle ? normalizeMarketRatesBundle(bundle) : null;
  const usdLp = CURRENCY_PARAMS.USD;
  const fcyLp = CURRENCY_PARAMS[ccy];
  const hasShortEnd = Boolean(
    normalized && shortEndDepositTenor(normalized.deposits),
  );
  const on = normalized ? effectiveOvernightCash(normalized, normalized.baseCcy) : null;
  const shortLabel = normalized
    ? shortEndDepositTenor(normalized.deposits)
    : null;

  // USD cash: use the USD side of a peer FCY×USD curve (no USD upload).
  if (ccy === 'USD') {
    if (on && (hasShortEnd || normalized?.overnightCash)) {
      return {
        fcy: { ...on.usd },
        usd: { ...on.usd },
        source: `${normalized?.sourceFile ?? 'rates'} · USD overnight (shared)${
          shortLabel ? ` ← ${shortLabel}` : ''
        }`,
      };
    }
    return {
      fcy: {
        creditPct: usdLp?.carry ?? 3.5,
        debitPct: usdLp?.r_OD ?? 3.89,
      },
      usd: {
        creditPct: usdLp?.carry ?? 3.5,
        debitPct: usdLp?.r_OD ?? 3.89,
      },
      source: 'CURRENCY_PARAMS LP · USD overnight',
    };
  }

  const bundleForCcy =
    on != null &&
    normalized != null &&
    (normalized.baseCcy === ccy ||
      // Legacy: shared EURUSD seed still applies to EUR.
      (ccy === 'EUR' &&
        (normalized.baseCcy === 'EUR' || normalized.pair === 'EURUSD')));
  if (bundleForCcy && on && (hasShortEnd || normalized.overnightCash)) {
    return {
      fcy: { ...on.base },
      usd: { ...on.usd },
      source: `${normalized?.sourceFile ?? 'rates'} · overnight${
        shortLabel === 'SW' || shortLabel === '1W'
          ? ' ← SW→ O/N'
          : shortLabel
            ? ` ← ${shortLabel}`
            : ''
      } · USD shared`,
    };
  }
  return {
    fcy: {
      creditPct: fcyLp?.carry ?? 0,
      debitPct: fcyLp?.r_OD ?? fcyLp?.carry ?? 0,
    },
    usd: {
      creditPct: usdLp?.carry ?? 3.5,
      debitPct: usdLp?.r_OD ?? 3.89,
    },
    source: 'CURRENCY_PARAMS LP · overnight',
  };
}

/**
 * Term deposit credit/debit at tenor — for forward CIP / points pricing only.
 * Uses the uploaded curve when the bundle belongs to `ccy`; else LP.
 * USD uses the USD deposit column of a peer FCY×USD file.
 */
export function resolveForwardDepositRates(
  bundle: FxMarketRatesBundle | null | undefined,
  ccy: string,
  months: number,
): {
  fcy: DepositSideRates;
  usd: DepositSideRates;
  source: string;
} {
  const usdLp = CURRENCY_PARAMS.USD;
  const fcyLp = CURRENCY_PARAMS[ccy];
  const fallback = {
    fcy: {
      creditPct: fcyLp?.carry ?? 0,
      debitPct: fcyLp?.r_OD ?? fcyLp?.carry ?? 0,
    },
    usd: {
      creditPct: usdLp?.carry ?? 3.5,
      debitPct: usdLp?.r_OD ?? 3.89,
    },
    source: 'CURRENCY_PARAMS LP · term',
  };

  if (ccy === 'USD' && bundle?.deposits && bundle.deposits.length > 0) {
    const usd = interpolateDepositSide(bundle.deposits, 'usd', months);
    return {
      fcy: usd,
      usd,
      source: `${bundle.sourceFile || 'uploaded curve'} · USD term (from pair file)`,
    };
  }

  const bundleForCcy =
    bundle?.deposits &&
    bundle.deposits.length > 0 &&
    (bundle.baseCcy === ccy ||
      (ccy === 'EUR' &&
        (bundle.baseCcy === 'EUR' || bundle.pair === 'EURUSD')));
  if (bundleForCcy) {
    return {
      fcy: interpolateDepositSide(bundle.deposits, 'eur', months),
      usd: interpolateDepositSide(bundle.deposits, 'usd', months),
      source: `${bundle.sourceFile || 'uploaded curve'} · term fwd`,
    };
  }
  return fallback;
}

/**
 * Cash interest rates for a holding horizon.
 * Mode `current`: flat applied O/N for every tenor (e.g. LP 1.78%).
 * Mode `forward` (default):
 * - Near 0 / below SW → O/N
 * - SW…1Y → interpolate deposit term structure (capped at 12m)
 * Used for multi-month FCY/USD cash accrual; not for swap-points FWD.
 */
export function resolveCashRatesForHorizon(
  bundle: FxMarketRatesBundle | null | undefined,
  ccy: string,
  months: number,
  modeOverride?: CashInterestMode,
): {
  fcy: DepositSideRates;
  usd: DepositSideRates;
  source: string;
} {
  const mode = modeOverride ?? cashInterestModeOf(bundle);
  const on = resolveOvernightCashRates(bundle, ccy);

  if (mode === 'current') {
    return {
      fcy: on.fcy,
      usd: on.usd,
      source: `${on.source} · flat current @ ${Math.max(0, months).toFixed(2)}m`,
    };
  }

  const t = Math.max(0, months);
  // Below SW (~1w): overnight quote.
  if (t < 7 / 30) {
    return { fcy: on.fcy, usd: on.usd, source: on.source };
  }

  const capped = Math.min(t, 12);
  const term = resolveForwardDepositRates(bundle, ccy, capped);
  if (term.source.includes('uploaded') || term.source.includes('term')) {
    return {
      fcy: term.fcy,
      usd: term.usd,
      source: `${term.source.replace('term fwd', 'cash ← term')} @ ${capped.toFixed(2)}m`,
    };
  }

  // LP fallback still tenor-flat; prefer overnight if no curve.
  return {
    fcy: on.fcy,
    usd: on.usd,
    source: `${on.source} (no term curve)`,
  };
}

/** @deprecated use resolveForwardDepositRates — term curve for CIP */
export function resolveCarryDepositRates(
  bundle: FxMarketRatesBundle | null | undefined,
  ccy: string,
  months: number,
): {
  fcy: DepositSideRates;
  usd: DepositSideRates;
  source: string;
} {
  return resolveForwardDepositRates(bundle, ccy, months);
}

function sheetToMatrix(wb: WorkBook, name: string): unknown[][] {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  }) as unknown[][];
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function asStr(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Parse FXOCalculator-style workbook (CashTable + Legs). */
export function parseFxoCalculatorWorkbook(
  data: ArrayBuffer,
  fileName: string,
): FxMarketRatesBundle {
  const wb = XLSX.read(data, { type: 'array', cellDates: false });
  const cashName =
    wb.SheetNames.find(n => /cash/i.test(n)) ??
    wb.SheetNames.find(n => /deposit/i.test(n)) ??
    wb.SheetNames[2];
  const legsName =
    wb.SheetNames.find(n => /leg/i.test(n)) ?? wb.SheetNames[0];
  const volName = wb.SheetNames.find(n => /vol/i.test(n));
  const paramName = wb.SheetNames.find(n => /param/i.test(n));

  const cash = cashName ? sheetToMatrix(wb, cashName) : [];
  const legs = legsName ? sheetToMatrix(wb, legsName) : [];

  const deposits: DepositTenorRow[] = [];
  for (let r = 1; r < cash.length; r++) {
    const row = cash[r] ?? [];
    const tenor = canonTenor(asStr(row[0]) ?? '');
    if (!tenor || /^maturity$/i.test(tenor)) continue;
    const eurBid = asNum(row[1]);
    const eurAsk = asNum(row[2]);
    const usdBid = asNum(row[3]);
    const usdAsk = asNum(row[4]);
    if (eurBid == null || eurAsk == null || usdBid == null || usdAsk == null) {
      continue;
    }
    // Workbook stores deposits as decimals (0.0226); convert to % p.a.
    const toPct = (x: number) => (Math.abs(x) <= 1.5 ? x * 100 : x);
    deposits.push({
      tenor,
      months: TENOR_MONTHS[tenor] ?? null,
      eur: { creditPct: toPct(eurBid), debitPct: toPct(eurAsk) },
      usd: { creditPct: toPct(usdBid), debitPct: toPct(usdAsk) },
      swapPoints: {
        bid: asNum(row[5]),
        ask: asNum(row[6]),
      },
      outright: {
        bid: asNum(row[7]),
        ask: asNum(row[8]),
      },
    });
  }
  if (deposits.length < 2) {
    throw new Error(
      'Could not find EUR/USD deposit Bid/Ask columns in CashTable',
    );
  }

  // Pair drives base/quote — must match whichever currency was actually
  // uploaded (GBPUSD, JPYUSD, ...), not a hardcoded EUR/USD assumption.
  const pairCell = asStr(legs[0]?.[0]) ?? 'EURUSD';
  const pairNormalized = pairCell.replace('/', '').toUpperCase();
  const baseCcy = pairNormalized.slice(0, 3) || 'EUR';
  const quoteCcy = pairNormalized.slice(3, 6) || 'USD';

  // Overnight cash: prefer ON / TN / SN row only. SW stays on the term
  // curve — O/N is applied separately in the market-data UI.
  const onRow =
    deposits.find(d => d.tenor === 'ON') ??
    deposits.find(d => d.tenor === 'TN') ??
    deposits.find(d => d.tenor === 'SN');
  const overnightCash: OvernightCashRates | undefined = onRow
    ? { base: { ...onRow.eur }, usd: { ...onRow.usd } }
    : undefined;

  let spotBid = 1;
  let spotAsk = 1;
  const sb = asNum(legs[0]?.[1]);
  const sa = asNum(legs[0]?.[2]);
  if (sb != null && sa != null) {
    spotBid = sb;
    spotAsk = sa;
  }

  const excelSerialToIso = (n: number | null): string | null => {
    if (n == null) return null;
    const ms = Date.UTC(1899, 11, 30) + n * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  };

  const volatility =
    volName != null
      ? (sheetToMatrix(wb, volName) as unknown[])
      : undefined;
  const parameters: Record<string, unknown> = {};
  if (paramName) {
    for (const row of sheetToMatrix(wb, paramName)) {
      const k = asStr(row[0]);
      if (k) parameters[k] = row[1] ?? null;
    }
  }

  return normalizeMarketRatesBundle({
    pair: pairNormalized,
    baseCcy,
    quoteCcy,
    sourceFile: fileName,
    asOf: {
      tradeDate: excelSerialToIso(asNum(legs[1]?.[0])),
      spotDate: excelSerialToIso(asNum(legs[1]?.[2])),
    },
    spot: {
      bid: spotBid,
      ask: spotAsk,
      mid: (spotBid + spotAsk) / 2,
    },
    overnightCash,
    deposits,
    volatility,
    parameters,
  });
}

export function loadStoredMarketRates(
  scopeId?: string | null,
): FxMarketRatesBundle | null {
  if (typeof window === 'undefined') return null;
  try {
    const scoped = window.localStorage.getItem(marketRatesStorageKey(scopeId));
    const raw =
      scoped ??
      (scopeId ? window.localStorage.getItem(STORAGE_KEY) : null);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FxMarketRatesBundle;
    if (!parsed?.deposits?.length) return null;
    return normalizeMarketRatesBundle(parsed);
  } catch {
    return null;
  }
}

export function saveStoredMarketRates(
  bundle: FxMarketRatesBundle,
  scopeId?: string | null,
): void {
  if (typeof window === 'undefined') return;
  const normalized = normalizeMarketRatesBundle(bundle);
  window.localStorage.setItem(
    marketRatesStorageKey(scopeId),
    JSON.stringify(normalized),
  );
  // Keep legacy global key in sync for path-chart consumers.
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

export function clearStoredMarketRates(scopeId?: string | null): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(marketRatesStorageKey(scopeId));
  if (scopeId) window.localStorage.removeItem(STORAGE_KEY);
}

/** Active bundle: scoped upload → global upload → bundled EURUSD seed. */
export function getActiveMarketRates(
  scopeId?: string | null,
): FxMarketRatesBundle {
  return loadStoredMarketRates(scopeId) ?? DEFAULT_EURUSD_MARKET_RATES;
}

/**
 * Pick a FCY×USD upload that carries USD deposit / overnight columns.
 * USD is never uploaded on its own — rates come from peer pair files.
 */
export function pickPeerMarketRatesForUsd(
  marketRatesByCcy: Record<string, FxMarketRatesBundle> | undefined,
  preferredCcy?: string | null,
): { ccy: string; bundle: FxMarketRatesBundle } | null {
  const map = marketRatesByCcy ?? {};
  const prefer = (preferredCcy ?? '').toUpperCase();
  const order = [
    ...(prefer && prefer !== 'USD' ? [prefer] : []),
    'EUR',
    'GBP',
    'PLN',
    ...Object.keys(map).filter(
      k =>
        k !== 'USD' &&
        k !== prefer &&
        k !== 'EUR' &&
        k !== 'GBP' &&
        k !== 'PLN',
    ),
  ];
  for (const ccy of order) {
    const bundle = map[ccy];
    if (bundle && (bundle.deposits?.length > 0 || bundle.overnightCash)) {
      return { ccy, bundle };
    }
  }
  return null;
}

/**
 * Per-CCY market rates bundle: DB-persisted book map → legacy scoped
 * localStorage (pre-per-CCY books, matching ccy) → EURUSD seed (EUR only)
 * → LP empty shell for other currencies.
 *
 * USD: no dedicated upload — borrow a peer FCY×USD file (USD columns).
 */
export function resolveMarketRatesForCcy(
  marketRatesByCcy: Record<string, FxMarketRatesBundle> | undefined,
  ccy: string,
  scopeId?: string | null,
): FxMarketRatesBundle {
  const forDesk = (bundle: FxMarketRatesBundle) =>
    normalizeMarketRatesBundle(bundle, ccy);

  if (ccy === 'USD') {
    const peer = pickPeerMarketRatesForUsd(marketRatesByCcy);
    if (peer) return normalizeMarketRatesBundle(peer.bundle);
    const scoped = loadStoredMarketRates(scopeId);
    if (scoped?.deposits?.length) {
      return normalizeMarketRatesBundle(scoped);
    }
    return DEFAULT_EURUSD_MARKET_RATES;
  }

  const fromBook = marketRatesByCcy?.[ccy];
  // A live CIP upload wins. An O/N-only / empty EUR shell must not shadow
  // the bundled EURUSD swap-points curve — that is what prices Book CIP.
  if (fromBook && bundleHasCipSwapPoints(fromBook)) return forDesk(fromBook);

  const scoped = loadStoredMarketRates(scopeId);
  if (
    scoped &&
    bundleHasCipSwapPoints(scoped) &&
    (scoped.baseCcy === ccy ||
      (ccy === 'EUR' &&
        (scoped.baseCcy === 'EUR' || scoped.pair === 'EURUSD')))
  ) {
    const desk = forDesk(scoped);
    if (fromBook?.overnightCash) {
      return {
        ...desk,
        overnightCash: forDesk(fromBook).overnightCash,
        cashInterestMode:
          fromBook.cashInterestMode ?? desk.cashInterestMode,
      };
    }
    return desk;
  }

  if (ccy === 'EUR') return eurUsdSeedForDesk(fromBook);
  return fromBook ? forDesk(fromBook) : emptyMarketRatesForCcy(ccy);
}
