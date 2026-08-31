import { describe, expect, it } from 'vitest';
import { DEFAULT_EURUSD_MARKET_RATES } from '@/lib/fx-market-rates';
import { fwdCarryForExposureCoverUsdM } from '@/lib/fx-hedge';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import {
  assignImpliedCarryFromSwapPoints,
  buildCashForecastCarryComparison,
  resolvedHedgedTotalCarryUsdM,
} from '@/lib/test-mode/cash-carry-analytics';
import { computeFxAtlasJob } from '@/lib/test-mode/fx-atlas-job';
import { datedAtlasExposuresLocalM } from '@/lib/test-mode/fx-var-frontier';
import { simSeedForEntity, task02ForecastProfile } from '@/lib/test-mode/nordtech-sim-seed';
import type { Entity } from '@/lib/workspace-store';
import type { PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';

function fake(id: string, name: string, base: string): Entity {
  return { id, name, baseCurrency: base, description: '', createdAt: '', dashboards: [] };
}

const rows = [
  ...simSeedForEntity(fake('de', 'NordTech GmbH Frankfurt', 'EUR'), '02').rows,
  ...simSeedForEntity(fake('pl', 'NordTech Poland Krakow', 'PLN'), '02').rows,
  ...simSeedForEntity(fake('us', 'NordTech US Hub', 'USD'), '02').rows,
];

const setup = { ...DEFAULT_VAR_SETUP, forecastMonths: 12, horizon: '1y' as const };
const profile = task02ForecastProfile();
const rates = DEFAULT_EURUSD_MARKET_RATES;
const eurRow = rows.find(r => r.ccy === 'EUR')!;

function eurBullet(coverLocalM: number, extra?: Partial<PreparedHedgeProfile>) {
  return {
    structure: 'bullet' as const,
    basis: 'totalExpected' as const,
    ticketBasis: 'totalBuildup' as const,
    legs: [],
    coverLocalM,
    hedgeRatio: 1,
    settleMonths: 12,
    ...extra,
  } as PreparedHedgeProfile;
}

describe('Task 02 EUR cash carry CIP', () => {
  it('M12 bullet FWD is 12M swap points on Target, not dated-leg CIP', () => {
    const atlas = computeFxAtlasJob({
      rows,
      forecastMonths: 12,
      forecastProfile: profile,
      confidencePct: 95,
      rUsd: 4,
      marketRatesByCcy: { EUR: rates },
    });
    const locked = atlas.byCcy.carry.EUR ?? 0;
    const cover = datedAtlasExposuresLocalM(eurRow, 12, profile).reduce(
      (s, x) => s + x,
      0,
    );
    expect(cover).toBeCloseTo(12.1, 1);
    const tfKnot = fwdCarryForExposureCoverUsdM({
      coverLocalM: cover,
      ccy: 'EUR',
      settleMonths: 12,
      bundle: rates,
      r_FCY: 1.78,
      r_USD: 4,
    }).fwdCarryUsdM;
    expect(tfKnot).toBeGreaterThan(0.18);
    expect(tfKnot).toBeLessThan(0.25);
    expect(locked).toBeCloseTo(tfKnot, 3);
    // Dated 1m…12m CIP was ~$0.11mm — that is not the 12M bullet.
    expect(locked).toBeGreaterThan(0.18);

    const prep = eurBullet(cover);
    const cmp = buildCashForecastCarryComparison({
      ccy: 'EUR',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: rates,
      bookedHedges: [],
      preparedByCcy: { EUR: prep },
      setup,
    });
    expect(cmp).not.toBeNull();
    expect(cmp!.hedged.totals.hedgeCashFlowM).toBeCloseTo(-cover, 6);
    expect(cmp!.categories.residualEurInterestUsdM).toBeCloseTo(
      cmp!.categories.unhedgedIncomeUsdM,
      8,
    );
    expect(cmp!.categories.residualEurInterestUsdM).toBeGreaterThan(0.12);
    expect(cmp!.categories.residualEurInterestUsdM).toBeLessThan(0.3);

    const resolved = resolvedHedgedTotalCarryUsdM({
      comparison: cmp!,
      prepared: prep,
      marketRates: rates,
    });
    expect(resolved.fwdCarryUsdM).toBeCloseTo(tfKnot, 3);
    expect(resolved.fwdCarryUsdM).toBeCloseTo(locked, 3);

    const assigned = assignImpliedCarryFromSwapPoints(prep, {
      marketRates: rates,
      bulletSettleMonths: 12,
      ccy: 'EUR',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
    });
    expect(assigned.impliedCarryUsdM).toBeCloseTo(tfKnot, 3);
  });

  it('reprices a staged Optimize bullet off 12M points, not a frozen 0.11', () => {
    const cover = datedAtlasExposuresLocalM(eurRow, 12, profile).reduce(
      (s, x) => s + x,
      0,
    );
    const prep = eurBullet(cover, {
      preparedFor: 'var',
      impliedCarryUsdM: 0.11,
    });
    const cmp = buildCashForecastCarryComparison({
      ccy: 'EUR',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: rates,
      bookedHedges: [],
      preparedByCcy: { EUR: prep },
      setup,
    });
    expect(cmp!.hedged.totals.fwdCarryUsdM).toBeGreaterThan(0.18);
    expect(cmp!.hedged.totals.fwdCarryUsdM).not.toBeCloseTo(0.11, 2);
    const assigned = assignImpliedCarryFromSwapPoints(prep, {
      marketRates: rates,
      bulletSettleMonths: 12,
      ccy: 'EUR',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
    });
    expect(assigned.impliedCarryUsdM).toBeGreaterThan(0.18);
    expect(assigned.impliedCarryUsdM).not.toBeCloseTo(0.11, 2);
  });
});
