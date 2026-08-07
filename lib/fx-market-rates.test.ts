import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_EURUSD_MARKET_RATES,
  interpolateDepositSide,
  parseFxoCalculatorWorkbook,
  fwdCarryFromSwapPointsUsdM,
  resolveForwardDepositRates,
  resolveOvernightCashRates,
  selectCreditDebitRate,
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
    const on = DEFAULT_EURUSD_MARKET_RATES.overnightCash!;
    expect(on.base.creditPct).toBeCloseTo(1.78, 2);
    expect(on.usd.creditPct).toBeCloseTo(3.5, 2);
    // Overnight cash ≠ 1M term (forward) rates
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
});
