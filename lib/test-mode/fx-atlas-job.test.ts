import { ccySpotRate } from '@/lib/fx-buffer';
import {
  computeFxAtlasJob,
  parseFxAtlasJobRequest,
} from '@/lib/test-mode/fx-atlas-job';
import { simSeedForEntity, task02ForecastProfile } from '@/lib/test-mode/nordtech-sim-seed';
import type { Entity } from '@/lib/workspace-store';

function fake(id: string, name: string, base: string): Entity {
  return { id, name, baseCurrency: base, description: '', createdAt: '', dashboards: [] };
}

const rows = [
  ...simSeedForEntity(fake('de', 'NordTech GmbH Frankfurt', 'EUR'), '02').rows,
  ...simSeedForEntity(fake('pl', 'NordTech Poland Krakow', 'PLN'), '02').rows,
  ...simSeedForEntity(fake('us', 'NordTech US Hub', 'USD'), '02').rows,
];

describe('parseFxAtlasJobRequest', () => {
  it('rejects a missing book', () => {
    const parsed = parseFxAtlasJobRequest({ forecastMonths: 12, confidencePct: 95, rUsd: 4 });
    expect('error' in parsed).toBe(true);
  });

  it('accepts a Task 02 book', () => {
    const parsed = parseFxAtlasJobRequest({
      rows,
      forecastMonths: 12,
      forecastProfile: task02ForecastProfile(),
      confidencePct: 95,
      rUsd: 4,
    });
    expect('request' in parsed).toBe(true);
  });

  it('keeps known forceOpen names and drops unknowns', () => {
    const parsed = parseFxAtlasJobRequest({
      rows,
      forecastMonths: 12,
      forecastProfile: task02ForecastProfile(),
      confidencePct: 95,
      rUsd: 4,
      forceOpenCcys: ['JPY', 'XXX', 'JPY', 'MXN'],
    });
    expect('request' in parsed).toBe(true);
    if (!('request' in parsed)) return;
    expect(parsed.request.forceOpenCcys).toEqual(['JPY', 'MXN']);
  });
});

describe('computeFxAtlasJob', () => {
  it('prices JPY in yen millions and recommends hedge EUR', () => {
    const result = computeFxAtlasJob({
      rows,
      forecastMonths: 12,
      forecastProfile: task02ForecastProfile(),
      confidencePct: 95,
      rUsd: 4,
    });
    const jpyLocal = result.byCcy.local.JPY ?? 0;
    expect(jpyLocal).toBeCloseTo(-1862.32, 1);
    expect((result.byCcy.usd.JPY ?? 0)).toBeCloseTo(jpyLocal * ccySpotRate('JPY'), 5);
    expect(result.sweet?.hedgeByCcy?.EUR ?? 0).toBeGreaterThan(0.5);
    expect(result.sweet?.hedgeByCcy?.JPY ?? 1).toBeLessThan(0.5);
    expect(result.curve.length).toBeGreaterThan(8);
    expect(result.curve.every(p => p.id !== result.unhedged?.id)).toBe(true);
    expect(result.unhedged?.carryUsdYrM ?? 1).toBeCloseTo(0, 5);
    expect((result.sweet?.carryUsdYrM ?? 0)).toBeGreaterThan(0);
    expect(result.marginal.length).toBeGreaterThan(8);
    expect(result.marginal.some(p => p.ccy === 'JPY')).toBe(true);
  });

  it('MXN hedge carry is a cost — MXN yields more than USD', () => {
    const result = computeFxAtlasJob({
      rows,
      forecastMonths: 12,
      forecastProfile: task02ForecastProfile(),
      confidencePct: 95,
      rUsd: 4,
    });
    expect(result.byCcy.carry.MXN ?? 0).toBeLessThan(-0.01);
    expect(result.byCcy.usd.MXN ?? 0).toBeGreaterThan(0);
    expect(result.fullyHedged?.hedgeByCcy?.MXN ?? 0).toBeGreaterThan(0.99);
    expect(result.fullyHedged?.carryByCcy?.MXN ?? 0).toBeLessThan(-0.01);
    const earn = ['EUR', 'GBP', 'PLN']
      .reduce((s, c) => s + (result.byCcy.carry[c] ?? 0), 0);
    expect(earn).toBeGreaterThan(0);
  });

  it('MXN locked carry stays a cost when the upload has a flat USDMXN points curve', () => {
    const S = 1 / ccySpotRate('MXN');
    const flat = {
      MXN: {
        pair: 'USDMXN',
        baseCcy: 'USD',
        quoteCcy: 'MXN',
        sourceFile: 'test',
        spot: { bid: S, ask: S, mid: S },
        deposits: [
          {
            tenor: '1M',
            months: 1,
            eur: { creditPct: 6.19, debitPct: 7.59 },
            usd: { creditPct: 4, debitPct: 4.5 },
            swapPoints: { bid: 0, ask: 0 },
          },
          {
            tenor: '1Y',
            months: 12,
            eur: { creditPct: 6.19, debitPct: 7.59 },
            usd: { creditPct: 4, debitPct: 4.5 },
            swapPoints: { bid: 20, ask: 24 },
          },
        ],
      },
    };
    const result = computeFxAtlasJob({
      rows,
      forecastMonths: 12,
      forecastProfile: task02ForecastProfile(),
      confidencePct: 95,
      rUsd: 4,
      marketRatesByCcy: flat,
    });
    expect(result.byCcy.carry.MXN ?? 0).toBeLessThan(-0.01);
    expect(result.fullyHedged?.carryByCcy?.MXN ?? 0).toBeLessThan(-0.01);
  });

  it('re-solves the mix with force-open names pinned at 0%', () => {
    const result = computeFxAtlasJob({
      rows,
      forecastMonths: 12,
      forecastProfile: task02ForecastProfile(),
      confidencePct: 95,
      rUsd: 4,
      forceOpenCcys: ['EUR'],
    });
    expect(result.sweet?.hedgeByCcy?.EUR ?? 1).toBeCloseTo(0, 5);
    expect(result.fullyHedged?.hedgeByCcy?.EUR ?? 1).toBeCloseTo(0, 5);
    expect(result.fullyHedged?.divVarUsdM ?? 0).toBeGreaterThan(0.05);
  });
});
