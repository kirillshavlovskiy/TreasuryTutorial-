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

/** Ensure overnight cash exists (seed LP if missing). */
export function normalizeMarketRatesBundle(
  bundle: FxMarketRatesBundle,
): FxMarketRatesBundle {
  const overnightCash =
    bundle.overnightCash ??
    defaultOvernightCashFromLp(bundle.baseCcy || 'EUR');
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

/**
 * Funding-swap far-leg CIP P&L ($M over the tenor) from the swap-points curve.
 * Same sign convention as {@link fwdCarryFromSwapPointsUsdM}: standing < 0
 * (sold FCY near → buy FCY far) hits the ask. Overnight cash Δr is not used.
 */
export function fundingSwapFarLegCipUsdM(input: {
  standingLocalM: number;
  settleMonths: number;
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
  }[];
  standingFallback: number;
  forecastMonths: number;
  bundle?: FxMarketRatesBundle | null;
  fallbackAnnualUsdYr: (standing: number) => number;
}): number {
  const cipAt = (standing: number, months: number) =>
    fundingSwapFarLegCipUsdM({
      standingLocalM: standing,
      settleMonths: months,
      bundle: input.bundle,
      fallbackUsdM: input.fallbackAnnualUsdYr(standing) * (months / 12),
    });

  const plan = input.plan;
  if (!plan?.length) {
    return cipAt(input.standingFallback, Math.max(1, input.forecastMonths));
  }
  const term = plan.some(p => Math.abs(p.far_leg ?? 0) > 0.001);
  if (term) {
    return cipAt(
      plan[0]!.standing_swap,
      fundingSwapFarSettleMonths(plan, input.forecastMonths),
    );
  }
  return plan.reduce((s, p) => s + cipAt(p.standing_swap, 1), 0);
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
  return normalizeMarketRatesBundle({
    pair: `${base}USD`,
    baseCcy: base,
    quoteCcy: 'USD',
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
    });
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
  if (ccy === 'USD') {
    const peer = pickPeerMarketRatesForUsd(marketRatesByCcy);
    if (peer) return peer.bundle;
    const scoped = loadStoredMarketRates(scopeId);
    if (scoped?.deposits?.length) return scoped;
    return DEFAULT_EURUSD_MARKET_RATES;
  }

  const fromBook = marketRatesByCcy?.[ccy];
  if (fromBook) return fromBook;

  const scoped = loadStoredMarketRates(scopeId);
  if (
    scoped &&
    (scoped.baseCcy === ccy ||
      (ccy === 'EUR' &&
        (scoped.baseCcy === 'EUR' || scoped.pair === 'EURUSD')))
  ) {
    return scoped;
  }

  if (ccy === 'EUR') return DEFAULT_EURUSD_MARKET_RATES;
  return emptyMarketRatesForCcy(ccy);
}
