import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_EURUSD_MARKET_RATES,
  effectiveOvernightCash,
  emptyMarketRatesForCcy,
  interpolateDepositSide,
  overnightCashFromDeposits,
  parseFxoCalculatorWorkbook,
  pickSharedUsdOvernight,
  fwdCarryFromSwapPointsUsdM,
  resolveCashRatesForHorizon,
  resolveForwardDepositRates,
  resolveMarketRatesForCcy,
  resolveOvernightCashRates,
  selectCreditDebitRate,
  stampSharedUsdOvernight,
} from '@/lib/fx-market-rates';
import { stripHedgeLegCarryUsdM } from '@/lib/fx-hedge';

describe('fx-market-rates', () => {
  it('seeds EURUSD with separate overnight cash vs term deposits', () => {
    const oneM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '1M');
    expect(oneM).toBeTruthy();
    expect(oneM!.usd.creditPct).toBeCloseTo(3.687, 3);
    expect(oneM!.usd.debitPct).toBeCloseTo(3.993, 3);
    expect(oneM!.eur.creditPct).toBeCloseTo(2.26, 3);
    expect(oneM!.eur.debitPct).toBeCloseTo(2.56, 3);
    const on = effectiveOvernightCash(DEFAULT_EURUSD_MARKET_RATES, 'EUR');
    // Applied overnightCash on the seed bundle (SW→O/N desk rates).
    expect(on.base.creditPct).toBeCloseTo(2.15, 2);
    expect(on.base.debitPct).toBeCloseTo(2.35, 2);
    expect(on.base.creditPct).not.toBeCloseTo(oneM!.eur.creditPct, 1);
  });

  it('picks credit for long and debit for short', () => {
    expect(selectCreditDebitRate(1, 2, 4).side).toBe('credit');
    expect(selectCreditDebitRate(-1, 2, 4).ratePct).toBe(4);
  });

  it('interpolates deposit curve', () => {
    const mid = interpolateDepositSide(
      DEFAULT_EURUSD_MARKET_RATES.deposits,
      'usd',
      1,
    );
    expect(mid.creditPct).toBeCloseTo(3.687, 3);
  });

  it('parses the bundled FXOCalculator workbook', () => {
    const buf = readFileSync(
      join(process.cwd(), 'data/fx-market-rates/FXOCalculator EURUSD.xlsx'),
    );
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
    const parsed = parseFxoCalculatorWorkbook(
      ab,
      'FXOCalculator EURUSD.xlsx',
    );
    expect(parsed.deposits.length).toBeGreaterThan(5);
    const oneM = parsed.deposits.find(d => d.tenor === '1M');
    expect(oneM?.usd.debitPct).toBeGreaterThan(oneM!.usd.creditPct);
  });

  it('forward carry uses EURUSD swap points column', () => {
    const oneM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '1M');
    expect(oneM?.swapPoints?.bid).toBeCloseTo(14.14, 2);
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: 10,
      settleMonths: 1,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
    });
    expect(pts).toBeTruthy();
    expect(pts!.points).toBeCloseTo(14.14, 2); // sell → bid
    expect(pts!.fwdCarryUsdM).toBeCloseTo(10 * (14.14 / 10_000), 6);
  });

  it('carry uses overnight for cash int and swap points for FWD', () => {
    const fwd = resolveForwardDepositRates(
      DEFAULT_EURUSD_MARKET_RATES,
      'EUR',
      6,
    );
    const cash = resolveOvernightCashRates(DEFAULT_EURUSD_MARKET_RATES, 'EUR');
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: 10,
      settleMonths: 6,
      bundle: DEFAULT_EURUSD_MARKET_RATES,
    });
    expect(cash.fcy.creditPct).not.toBeCloseTo(fwd.fcy.creditPct, 1);
    const long = stripHedgeLegCarryUsdM({
      notionalLocalM: 10,
      ccy: 'EUR',
      recognizeMonths: 0,
      settleMonths: 6,
      forecastEndMonths: 12,
      fcyFwdRates: fwd.fcy,
      usdFwdRates: fwd.usd,
      fcyCashRates: cash.fcy,
      usdCashRates: cash.usd,
      swapPointsCarryUsdM: pts?.fwdCarryUsdM,
      swapPoints: pts?.points,
      swapPointsSide: pts?.side,
    });
    expect(long.r_FCY_used).toBeCloseTo(cash.fcy.creditPct, 3);
    expect(long.swapPoints).toBeTruthy();
    expect(long.fwdCarryUsdM).toBeCloseTo(pts!.fwdCarryUsdM, 8);
  });

  it('uses per-CCY uploaded curve for overnight and term (not EUR-only)', () => {
    const plnBundle = {
      ...DEFAULT_EURUSD_MARKET_RATES,
      pair: 'PLNUSD',
      baseCcy: 'PLN',
      overnightCash: {
        base: { creditPct: 3.41, debitPct: 4.41 },
        usd: { creditPct: 3.5, debitPct: 3.89 },
      },
    };
    const cash = resolveOvernightCashRates(plnBundle, 'PLN');
    const fwd = resolveForwardDepositRates(plnBundle, 'PLN', 1);
    // Applied overnightCash wins (not SW deposit column).
    expect(cash.fcy.creditPct).toBeCloseTo(3.41, 2);
    expect(fwd.fcy.creditPct).toBeCloseTo(2.26, 2);
    const gbpCash = resolveOvernightCashRates(plnBundle, 'GBP');
    expect(gbpCash.source).toContain('LP');
  });

  it('suggests EUR SW→O/N 2.15/2.35 without overwriting SW deposits', () => {
    const sw = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === 'SW');
    expect(sw).toBeTruthy();
    const depositsNoOn = DEFAULT_EURUSD_MARKET_RATES.deposits.filter(
      d => !['ON', 'TN', 'SN'].includes(d.tenor),
    );
    const suggested = overnightCashFromDeposits(depositsNoOn, 'EUR');
    expect(suggested.base.creditPct).toBeCloseTo(2.15, 3);
    expect(suggested.base.debitPct).toBeCloseTo(2.35, 3);
    expect(suggested.usd.creditPct).toBeCloseTo(sw!.usd.creditPct, 3);
    // SW term row unchanged.
    expect(sw!.eur.creditPct).toBeCloseTo(2.09, 2);
  });

  it('takes USD overnight/term from peer FCY pair files (no USD upload)', () => {
    const map = {
      EUR: {
        ...DEFAULT_EURUSD_MARKET_RATES,
        overnightCash: {
          base: { creditPct: 2.15, debitPct: 2.35 },
          usd: { creditPct: 3.505, debitPct: 3.809 },
        },
      },
    };
    const bundle = resolveMarketRatesForCcy(map, 'USD');
    expect(bundle.baseCcy).toBe('EUR');
    const cash = resolveOvernightCashRates(bundle, 'USD');
    expect(cash.fcy.creditPct).toBeCloseTo(3.505, 3);
    expect(cash.source).toContain('pair file');
    const fwd = resolveForwardDepositRates(bundle, 'USD', 1);
    const oneM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '1M');
    expect(fwd.fcy.creditPct).toBeCloseTo(oneM!.usd.creditPct, 3);
  });

  it('uses O/N near 0 and SW–1Y term for longer cash horizons', () => {
    const on = resolveCashRatesForHorizon(DEFAULT_EURUSD_MARKET_RATES, 'EUR', 0);
    expect(on.fcy.creditPct).toBeCloseTo(2.15, 2);
    const at6m = resolveCashRatesForHorizon(
      DEFAULT_EURUSD_MARKET_RATES,
      'EUR',
      6,
    );
    const sixM = DEFAULT_EURUSD_MARKET_RATES.deposits.find(d => d.tenor === '6M')!;
    expect(at6m.fcy.creditPct).toBeCloseTo(sixM.eur.creditPct, 3);
    expect(at6m.source).toMatch(/term|cash/);
  });

  it('current mode keeps flat O/N for every cash horizon', () => {
    const withOn = {
      ...DEFAULT_EURUSD_MARKET_RATES,
      overnightCash: {
        base: { creditPct: 1.78, debitPct: 2.21 },
        usd: { creditPct: 3.5, debitPct: 3.89 },
      },
      cashInterestMode: 'current' as const,
    };
    const at0 = resolveCashRatesForHorizon(withOn, 'EUR', 0);
    const at5 = resolveCashRatesForHorizon(withOn, 'EUR', 5);
    expect(at0.fcy.creditPct).toBeCloseTo(1.78, 3);
    expect(at5.fcy.creditPct).toBeCloseTo(1.78, 3);
    expect(at5.source).toMatch(/flat current/);
  });

  it('stamps shared USD O/N onto every currency bundle', () => {
    const map = stampSharedUsdOvernight(
      {
        EUR: {
          ...DEFAULT_EURUSD_MARKET_RATES,
          overnightCash: {
            base: { creditPct: 1.78, debitPct: 2.21 },
            usd: { creditPct: 3.5, debitPct: 3.89 },
          },
        },
        PLN: emptyMarketRatesForCcy('PLN'),
      },
      { creditPct: 4.1, debitPct: 4.4 },
    );
    expect(map.EUR!.overnightCash!.usd.creditPct).toBeCloseTo(4.1, 6);
    expect(map.PLN!.overnightCash!.usd.debitPct).toBeCloseTo(4.4, 6);
    expect(map.EUR!.overnightCash!.base.creditPct).toBeCloseTo(1.78, 6);
    expect(pickSharedUsdOvernight(map).creditPct).toBeCloseTo(4.1, 6);
  });
});
