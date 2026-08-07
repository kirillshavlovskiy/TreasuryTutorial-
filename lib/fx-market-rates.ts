/**
 * FX market deposit curves (credit/debit) for carry — seeded from
 * FXOCalculator EURUSD.xlsx CashTable. Deposit Bid = credit, Ask = debit.
 */

import * as XLSX from 'xlsx';
import type { WorkBook } from 'xlsx';
import defaultEurUsd from '@/data/fx-market-rates/EURUSD.json';
import { CURRENCY_PARAMS } from '@/lib/fx-buffer';

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
  /** Term deposit / yield curve — used for forward CIP / points pricing. */
  deposits: DepositTenorRow[];
  volatility?: unknown[];
  parameters?: Record<string, unknown>;
  legsSnapshot?: unknown;
  rateConvention?: Record<string, string>;
}

/** Default overnight cash from JPM NP credit/debit (CURRENCY_PARAMS). */
export function defaultOvernightCashFromNp(
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

/** Ensure overnight cash exists (seed NP if missing). */
export function normalizeMarketRatesBundle(
  bundle: FxMarketRatesBundle,
): FxMarketRatesBundle {
  const overnightCash =
    bundle.overnightCash ??
    defaultOvernightCashFromNp(bundle.baseCcy || 'EUR');
  return {
    ...bundle,
    overnightCash,
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

/** Bundled seed from FXOCalculator EURUSD.xlsx (+ NP overnight cash). */
export const DEFAULT_EURUSD_MARKET_RATES: FxMarketRatesBundle =
  normalizeMarketRatesBundle({
    ...(defaultEurUsd as FxMarketRatesBundle),
    overnightCash:
      (defaultEurUsd as FxMarketRatesBundle).overnightCash ??
      defaultOvernightCashFromNp('EUR'),
  });

export function selectCreditDebitRate(
  signedAmount: number,
  creditPct: number,
  debitPct: number,
): { ratePct: number; side: 'credit' | 'debit' } {
  if (signedAmount >= 0) return { ratePct: creditPct, side: 'credit' };
  return { ratePct: debitPct, side: 'debit' };
}

/**
 * EURUSD (and similar majors) swap points → outright delta.
 * FXOCalculator quotes points so F ≈ S + points/10_000.
 */
export function swapPointsToPriceDelta(
  points: number,
  pair = 'EURUSD',
): number {
  const p = pair.replace('/', '').toUpperCase();
  // JPY pairs use /100; most others (EURUSD) use /10_000.
  const div = p.endsWith('JPY') ? 100 : 10_000;
  return points / div;
}

/** Interpolate EUR/USD swap points (bid/ask) to a settle tenor. */
export function interpolateSwapPoints(
  deposits: readonly DepositTenorRow[],
  months: number,
): { bid: number; ask: number; mid: number } | null {
  const pts = deposits
    .filter(
      d =>
        d.months != null &&
        Number.isFinite(d.months) &&
        d.swapPoints?.bid != null &&
        d.swapPoints?.ask != null,
    )
    .map(d => ({
      m: d.months as number,
      bid: d.swapPoints!.bid as number,
      ask: d.swapPoints!.ask as number,
    }))
    .sort((a, b) => a.m - b.m);
  if (pts.length === 0) return null;
  const t = Math.max(0, months);
  const lerp = (
    a: { bid: number; ask: number },
    b: { bid: number; ask: number },
    w: number,
  ) => {
    const bid = a.bid + w * (b.bid - a.bid);
    const ask = a.ask + w * (b.ask - a.ask);
    return { bid, ask, mid: (bid + ask) / 2 };
  };
  if (t <= pts[0]!.m) {
    const p = pts[0]!;
    return { bid: p.bid, ask: p.ask, mid: (p.bid + p.ask) / 2 };
  }
  const last = pts[pts.length - 1]!;
  if (t >= last.m) {
    return { bid: last.bid, ask: last.ask, mid: (last.bid + last.ask) / 2 };
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (t >= a.m && t <= b.m) {
      const w = (t - a.m) / Math.max(1e-12, b.m - a.m);
      return lerp(a, b, w);
    }
  }
  return { bid: last.bid, ask: last.ask, mid: (last.bid + last.ask) / 2 };
}

/**
 * Forward points carry in $M from the EURUSD Swap Points column.
 * Positive notional = sell FCY → use bid points; buy → ask.
 * P&L = N_FCY_M × (F − S) with F−S from swap points.
 */
export function fwdCarryFromSwapPointsUsdM(input: {
  notionalLocalM: number;
  settleMonths: number;
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
  const curve = interpolateSwapPoints(
    input.bundle.deposits,
    input.settleMonths,
  );
  if (!curve) return null;
  const side: 'bid' | 'ask' = N >= 0 ? 'bid' : 'ask';
  const points = side === 'bid' ? curve.bid : curve.ask;
  const pair = input.bundle.pair || 'EURUSD';
  const priceDelta = swapPointsToPriceDelta(points, pair);
  // N in FCY millions × USD-per-FCY delta = USD millions.
  return {
    fwdCarryUsdM: N * priceDelta,
    points,
    priceDelta,
    side,
  };
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

/**
 * Overnight cash credit/debit — for cash interest / funding only.
 * Separate from term deposits used to price forwards.
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
  const on = normalized?.overnightCash;
  const usdNp = CURRENCY_PARAMS.USD;
  const fcyNp = CURRENCY_PARAMS[ccy];
  if (
    on &&
    (ccy === normalized?.baseCcy || ccy === 'EUR') &&
    (normalized?.baseCcy === 'EUR' || normalized?.pair === 'EURUSD')
  ) {
    return {
      fcy: { ...on.base },
      usd: { ...on.usd },
      source: `${normalized?.sourceFile ?? 'rates'} · overnight cash`,
    };
  }
  return {
    fcy: {
      creditPct: fcyNp?.carry ?? 0,
      debitPct: fcyNp?.r_OD ?? fcyNp?.carry ?? 0,
    },
    usd: {
      creditPct: usdNp?.carry ?? 3.5,
      debitPct: usdNp?.r_OD ?? 3.89,
    },
    source: 'CURRENCY_PARAMS NP · overnight',
  };
}

/**
 * Term deposit credit/debit at tenor — for forward CIP / points pricing only.
 * EURUSD curve when ccy=EUR; otherwise fall back to CURRENCY_PARAMS NP rates.
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
  const usdNp = CURRENCY_PARAMS.USD;
  const fcyNp = CURRENCY_PARAMS[ccy];
  const fallback = {
    fcy: {
      creditPct: fcyNp?.carry ?? 0,
      debitPct: fcyNp?.r_OD ?? fcyNp?.carry ?? 0,
    },
    usd: {
      creditPct: usdNp?.carry ?? 3.5,
      debitPct: usdNp?.r_OD ?? 3.89,
    },
    source: 'CURRENCY_PARAMS NP · term',
  };

  if (
    ccy === 'EUR' &&
    bundle?.deposits &&
    bundle.deposits.length > 0 &&
    (bundle.baseCcy === 'EUR' || bundle.pair === 'EURUSD')
  ) {
    return {
      fcy: interpolateDepositSide(bundle.deposits, 'eur', months),
      usd: interpolateDepositSide(bundle.deposits, 'usd', months),
      source: `${bundle.sourceFile || 'uploaded EURUSD curve'} · term fwd`,
    };
  }
  return fallback;
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
    const tenor = asStr(row[0]);
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

  // Overnight cash: prefer ON / TN / SN row; else keep NP defaults (editable in UI).
  const onRow =
    deposits.find(d => d.tenor === 'ON') ??
    deposits.find(d => d.tenor === 'TN') ??
    deposits.find(d => d.tenor === 'SN');
  const overnightCash: OvernightCashRates = onRow
    ? { base: { ...onRow.eur }, usd: { ...onRow.usd } }
    : defaultOvernightCashFromNp('EUR');

  let spotBid = 1;
  let spotAsk = 1;
  const pairCell = asStr(legs[0]?.[0]) ?? 'EURUSD';
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
    pair: pairCell.replace('/', ''),
    baseCcy: 'EUR',
    quoteCcy: 'USD',
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
