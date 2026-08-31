import { describe, expect, it } from 'vitest';
import { ccySpotRate, fcyToUsdM } from '@/lib/fx-buffer';
import {
  DEFAULT_EURUSD_MARKET_RATES,
  emptyMarketRatesForCcy,
  normalizeMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import {
  assignImpliedCarryFromSwapPoints,
  buildCashForecastCarryComparison,
  resolvedHedgedTotalCarryUsdM,
} from '@/lib/test-mode/cash-carry-analytics';
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

function jpyBullet(coverLocalM: number, rates = emptyMarketRatesForCcy('JPY')) {
  return assignImpliedCarryFromSwapPoints(
    {
      structure: 'bullet',
      basis: 'totalExpected',
      ticketBasis: 'totalBuildup',
      legs: [],
      coverLocalM,
      hedgeRatio: 1,
      settleMonths: 12,
    },
    { marketRates: rates, bulletSettleMonths: 12, ccy: 'JPY' },
  ) as PreparedHedgeProfile;
}

describe('Task 02 JPY cash carry', () => {
  it('prices Asia OD at JPY 0.95% — not EUR term or EURUSD pips', () => {
    const empty = emptyMarketRatesForCcy('JPY');
    const unhedged = buildCashForecastCarryComparison({
      ccy: 'JPY',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: empty,
      bookedHedges: [],
      preparedByCcy: {},
      setup,
    });
    expect(unhedged).not.toBeNull();
    // Opening −¥900mm × 0.006246 × ~0.95% on a growing short ≈ −$80K, not −$369K.
    expect(unhedged!.categories.unhedgedIncomeUsdM).toBeGreaterThan(-0.12);
    expect(unhedged!.categories.unhedgedIncomeUsdM).toBeLessThan(-0.05);
  });

  it('M12 bullet delivers yen (Hedge CF in) and adds 12M CIP, residual unchanged', () => {
    const empty = emptyMarketRatesForCcy('JPY');
    const cover = -1862.32;
    const prep = jpyBullet(cover, empty);
    const cmp = buildCashForecastCarryComparison({
      ccy: 'JPY',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: empty,
      bookedHedges: [],
      preparedByCcy: { JPY: prep },
      setup,
    });
    expect(cmp).not.toBeNull();
    // Short cover → buy yen far → FCY cash in at Tf.
    expect(cmp!.hedged.totals.hedgeCashFlowM).toBeCloseTo(-cover, 6);
    expect(cmp!.hedged.totals.hedgeCashOutM).toBeCloseTo(0, 8);
    expect(cmp!.hedged.totals.hedgeCashInM).toBeCloseTo(-cover, 6);
    // Tf bullet: residual OD is the same as do-nothing (settle is month-end M12).
    expect(cmp!.categories.residualEurInterestUsdM).toBeCloseTo(
      cmp!.categories.unhedgedIncomeUsdM,
      8,
    );
    const resolved = resolvedHedgedTotalCarryUsdM({
      comparison: cmp!,
      prepared: prep,
      marketRates: empty,
    });
    // 12M CIP on Σ Target (overnight / empty JPY curve), not EURUSD pips.
    expect(resolved.fwdCarryUsdM).toBeCloseTo(cmp!.categories.fwdCarryUsdM, 6);
    expect(resolved.fwdCarryUsdM).toBeLessThan(-0.05);
    expect(Math.abs(resolved.fwdCarryUsdM)).toBeLessThan(0.5);
    expect(resolved.benefitUsdM).toBeCloseTo(resolved.fwdCarryUsdM, 6);
  });

  it('does not multiply EURUSD pips by yen millions', () => {
    const cover = -1862.32;
    const eurusd = DEFAULT_EURUSD_MARKET_RATES;
    const prep = jpyBullet(cover, eurusd);
    const cmp = buildCashForecastCarryComparison({
      ccy: 'JPY',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: eurusd,
      bookedHedges: [],
      preparedByCcy: { JPY: prep },
      setup,
    });
    const resolved = resolvedHedgedTotalCarryUsdM({
      comparison: cmp!,
      prepared: prep,
      marketRates: eurusd,
    });
    // EUR 12M ~170 pips × 1862 would be −$23mm. Desk CIP is hundreds of $K.
    expect(Math.abs(resolved.fwdCarryUsdM)).toBeLessThan(1);
    expect(resolved.fwdCarryUsdM).toBeLessThan(-0.05);
    expect(cmp!.hedged.totals.hedgeCashFlowM).toBeCloseTo(-cover, 6);
  });

  it('forDesk EURUSD onto JPY drops EUR deposits so residual stays Asia OD', () => {
    const asJpy = normalizeMarketRatesBundle(
      { ...DEFAULT_EURUSD_MARKET_RATES, baseCcy: 'JPY' },
      'JPY',
    );
    expect(asJpy.deposits).toHaveLength(0);
    const unhedged = buildCashForecastCarryComparison({
      ccy: 'JPY',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: asJpy,
      bookedHedges: [],
      preparedByCcy: {},
      setup,
    });
    const lp = buildCashForecastCarryComparison({
      ccy: 'JPY',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: emptyMarketRatesForCcy('JPY'),
      bookedHedges: [],
      preparedByCcy: {},
      setup,
    });
    expect(unhedged!.categories.unhedgedIncomeUsdM).toBeCloseTo(
      lp!.categories.unhedgedIncomeUsdM,
      8,
    );
  });

  it('does not accrue JPY OD at the USD deposit ladder', () => {
    const S = 1 / ccySpotRate('JPY');
    const usdLeftAsJpy = {
      pair: 'USDJPY',
      baseCcy: 'JPY',
      quoteCcy: 'JPY',
      sourceFile: 'test USDJPY',
      spot: { bid: S, ask: S, mid: S },
      overnightCash: {
        base: { creditPct: 0.45, debitPct: 0.95 },
        usd: { creditPct: 3.5, debitPct: 3.89 },
      },
      deposits: [
        {
          tenor: '1Y',
          months: 12,
          eur: { creditPct: 3.5, debitPct: 3.89 },
          usd: { creditPct: 0.45, debitPct: 0.95 },
        },
        {
          tenor: '1M',
          months: 1,
          eur: { creditPct: 3.5, debitPct: 3.81 },
          usd: { creditPct: 0.45, debitPct: 0.95 },
        },
      ],
    };
    const cmp = buildCashForecastCarryComparison({
      ccy: 'JPY',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: usdLeftAsJpy as never,
      bookedHedges: [],
      preparedByCcy: {},
      setup,
    });
    const lp = buildCashForecastCarryComparison({
      ccy: 'JPY',
      bookRows: rows,
      forecastProfile: profile,
      forecastMonths: 12,
      marketRates: emptyMarketRatesForCcy('JPY'),
      bookedHedges: [],
      preparedByCcy: {},
      setup,
    });
    expect(cmp!.categories.unhedgedIncomeUsdM).toBeCloseTo(
      lp!.categories.unhedgedIncomeUsdM,
      2,
    );
    expect(cmp!.categories.unhedgedIncomeUsdM).toBeGreaterThan(-0.12);
  });

  it('dates the hedge notional in yen millions, USD at TMS spot', () => {
    const cover = -1862.32;
    expect(fcyToUsdM(cover, 'JPY')).toBeCloseTo(cover * ccySpotRate('JPY'), 8);
    expect(Math.abs(fcyToUsdM(cover, 'JPY'))).toBeLessThan(20);
  });
});
