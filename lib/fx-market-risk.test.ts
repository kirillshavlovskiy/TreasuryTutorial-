import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ATLAS_CORR,
  ATLAS_TENOR_DECAY,
  atlasPairCorr,
  atlasRiskCorr,
  atlasTenorCorr,
  impliedFxVol,
  parseAtlasMarketRiskWorkbook,
  setCorrPair,
  stampFxCorrOnBook,
  stampImpliedVolOnBook,
} from '@/lib/fx-market-risk';
import { emptyMarketRatesForCcy } from '@/lib/fx-market-rates';
import { pairCorr } from '@/lib/test-mode/portfolio-liquidity-frontier';
import { fxAtlasLegVarUsdM } from '@/lib/test-mode/fx-var-frontier';

const ATLAS_XLSX =
  'C:/Users/KirillShavlovskiy/Downloads/Capital Markets Atlas Report Sat Aug 29 2026 01_03_05 GMT+0300 (Israel Daylight Time).xlsx';

describe('Atlas market-risk seed (27-Aug-2026)', () => {
  it('stores implied vol by CCY×tenor from the Atlas Volatility sheet', () => {
    expect(impliedFxVol('EUR', 1)).toBeCloseTo(0.052848, 5);
    expect(impliedFxVol('EUR', 12)).toBeCloseTo(0.063485, 5);
    expect(impliedFxVol('JPY', 1)).toBeCloseTo(0.06897, 4);
    expect(impliedFxVol('MXN', 12)).toBeCloseTo(0.097982, 5);
  });

  it('stores daily pair corr — EUR/JPY is positive, unlike the desk matrix', () => {
    expect(atlasPairCorr('EUR', 'GBP')).toBeCloseTo(0.834865, 5);
    expect(atlasPairCorr('EUR', 'JPY')).toBeCloseTo(0.60072, 4);
    expect(atlasPairCorr('EUR', 'JPY')).toBeGreaterThan(0);
    expect(pairCorr('EUR', 'JPY')).toBeLessThan(0);
    expect(atlasPairCorr('EUR', 'EUR')).toBe(1);
  });

  it('matches Atlas Individual 5%-ile VaR on EUR 1m', () => {
    const spot = 14.09529 / 12.1;
    const varUsd = fxAtlasLegVarUsdM(2.53, spot, 1, impliedFxVol('EUR', 1), 1.645);
    expect(varUsd).toBeCloseTo(0.073956, 4);
  });

  it('decays same-pair tenors so adjacent months are not ρ = 1', () => {
    expect(atlasTenorCorr(1, 1)).toBe(1);
    expect(atlasTenorCorr(1, 12)).toBeCloseTo(
      Math.exp(-ATLAS_TENOR_DECAY * 11 / 12),
      8,
    );
    const sameTenor = atlasRiskCorr(
      { ccy: 'EUR', usdM: 1, tenorMonths: 1 },
      { ccy: 'GBP', usdM: 1, tenorMonths: 1 },
    );
    const splitTenor = atlasRiskCorr(
      { ccy: 'EUR', usdM: 1, tenorMonths: 1 },
      { ccy: 'GBP', usdM: 1, tenorMonths: 12 },
    );
    expect(sameTenor).toBeCloseTo(atlasPairCorr('EUR', 'GBP'), 8);
    expect(splitTenor).toBeLessThan(sameTenor);
  });
});

describe('Market data vol / corr edits', () => {
  it('writes a symmetric corr cell and stamps it on every book CCY', () => {
    const edited = setCorrPair(ATLAS_CORR, 'EUR', 'JPY', 0.42);
    expect(atlasPairCorr('EUR', 'JPY', edited)).toBeCloseTo(0.42, 8);
    expect(atlasPairCorr('JPY', 'EUR', edited)).toBeCloseTo(0.42, 8);
    expect(setCorrPair(edited, 'EUR', 'EUR', 0.3).matrix[
      edited.ccys.indexOf('EUR')
    ]![edited.ccys.indexOf('EUR')]).toBe(1);
    const seed = {
      EUR: emptyMarketRatesForCcy('EUR'),
      JPY: emptyMarketRatesForCcy('JPY'),
    };
    const book = stampFxCorrOnBook(seed, edited, ['EUR', 'JPY', 'GBP'], emptyMarketRatesForCcy);
    expect(book.EUR?.parameters?.atlasCorr).toEqual(edited);
    expect(book.JPY?.parameters?.atlasCorr).toEqual(edited);
    expect(book.GBP).toBeUndefined();
  });

  it('stamps an implied-vol row onto that CCY only', () => {
    const vol = { '1': 0.08, '12': 0.09 };
    const book = stampImpliedVolOnBook({}, 'MXN', vol, emptyMarketRatesForCcy);
    expect(impliedFxVol('MXN', 1, book.MXN)).toBeCloseTo(0.08, 8);
    expect(book.EUR).toBeUndefined();
  });
});

describe('parseAtlasMarketRiskWorkbook', () => {
  it.skipIf(!existsSync(ATLAS_XLSX))('reads the attached Atlas report', () => {
    const nodeBuf = readFileSync(ATLAS_XLSX);
    const buf = nodeBuf.buffer.slice(
      nodeBuf.byteOffset,
      nodeBuf.byteOffset + nodeBuf.byteLength,
    );
    const parsed = parseAtlasMarketRiskWorkbook(buf, 'atlas.xlsx');
    expect(parsed).toBeTruthy();
    expect(parsed!.volByCcy.EUR?.['1']).toBeCloseTo(0.052848, 5);
    expect(parsed!.corr.ccys).toContain('EUR');
    expect(parsed!.corr.ccys).toContain('JPY');
    const i = parsed!.corr.ccys.indexOf('EUR');
    const j = parsed!.corr.ccys.indexOf('GBP');
    expect(parsed!.corr.matrix[i]![j]).toBeCloseTo(0.834865, 5);
  });
});
