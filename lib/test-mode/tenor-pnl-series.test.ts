import { describe, expect, it } from 'vitest';
import { makeSimRow } from '@/lib/fx-buffer';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import type { SpotDayCandle } from '@/lib/test-mode/tape-candles';
import {
  buildLegPnlSeries,
  buildTenorPnlBundle,
  buildTenorPnlSeries,
  cumulativePnlStackK,
  forwardOutrightMarketQuote,
  marketQuoteToUsdPerFcy,
  revalueLadderAtSpot,
} from '@/lib/test-mode/tenor-pnl-series';
import { buildTenorRiskLadder } from '@/lib/test-mode/tenor-risk-ladder';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';

const SETUP = {
  ...DEFAULT_VAR_SETUP,
  forecastMonths: 12,
  confidencePct: 95 as const,
  exposureBasis: 'totalBuildup' as const,
};

const EUR = makeSimRow('1', 'EUR', 2.5, 0, 0, 2.5, 0, 1.2, 0);

function ladder() {
  return buildTenorRiskLadder({
    ccy: 'EUR',
    row: EUR,
    stockM: 2.5,
    monthlyFlowM: 1.2,
    monthlyFlows: Array.from({ length: 12 }, () => 1.2),
    setup: SETUP,
    bookedHedges: [],
    hedgeNotionalLocalM: 0,
  });
}

function bar(t: number, close: number): SpotDayCandle {
  return { t, open: close, high: close, low: close, close, ticks: 1, prints: 1 };
}

describe('tenor-pnl-series', () => {
  it('cash outright equals spot; forward CIP differs from spot', () => {
    expect(
      forwardOutrightMarketQuote({
        spotMarket: 1.16,
        months: 0,
        ccy: 'EUR',
        rFcyPct: 1.78,
      }),
    ).toBe(1.16);
    const fwd = forwardOutrightMarketQuote({
      spotMarket: 1.16,
      months: 12,
      ccy: 'EUR',
      rFcyPct: 1.78,
    });
    expect(fwd).not.toBeCloseTo(1.16, 4);
    expect(fwd).toBeGreaterThan(1.16);
  });

  it('revalues residual delta with the spot ratio and restores at live spot', () => {
    const rows = ladder();
    const live = revalueLadderAtSpot({
      points: rows,
      spotUsdAt: 1.16,
      spotUsdNow: 1.16,
      ccy: 'EUR',
      rFcyPct: EUR.r_FCY,
    });
    const m1 = rows.find(r => r.id === '1m')!;
    expect(live.find(r => r.id === '1m')!.deltaUsdPerPct).toBeCloseTo(
      m1.deltaUsdPerPct,
      8,
    );
    const half = revalueLadderAtSpot({
      points: rows,
      spotUsdAt: 0.58,
      spotUsdNow: 1.16,
      ccy: 'EUR',
      rFcyPct: EUR.r_FCY,
    });
    expect(half.find(r => r.id === '1m')!.deltaUsdPerPct).toBeCloseTo(
      m1.deltaUsdPerPct * 0.5,
      8,
    );
    expect(live.find(r => r.id === '1m')!.m2mUsdM).toBeCloseTo(m1.m2mUsdM, 8);
    expect(live.find(r => r.id === '1m')!.totalPnlUsdM).toBeCloseTo(
      m1.totalPnlUsdM,
      8,
    );
  });

  it('builds matching rate and P&L series from candles', () => {
    const point = ladder().find(r => r.id === '1m')!;
    const candles = [
      bar(1_000_000, 1.10),
      bar(1_060_000, 1.12),
      bar(1_120_000, 1.16),
    ];
    const { rateSeries, pnlSeries } = buildTenorPnlSeries({
      point,
      candles,
      ccy: 'EUR',
      tenorMonths: 1,
      rFcyPct: EUR.r_FCY,
      metric: 'delta',
    });
    expect(rateSeries).toHaveLength(3);
    expect(pnlSeries).toHaveLength(3);
    expect(pnlSeries[2]!.value).toBeCloseTo(point.deltaUsdPerPct, 8);
    expect(pnlSeries[0]!.value).toBeCloseTo(
      point.deltaUsdPerPct * (1.1 / 1.16),
      6,
    );
  });

  it('stacked P&L layers sum to total at every candle', () => {
    const point = ladder().find(r => r.id === '1m')!;
    const candles = [
      bar(1_000_000, 1.10),
      bar(1_060_000, 1.12),
      bar(1_120_000, 1.16),
    ];
    const { snapshots } = buildTenorPnlBundle({
      point,
      candles,
      ccy: 'EUR',
      tenorMonths: 1,
      rFcyPct: EUR.r_FCY,
    });
    expect(snapshots).toHaveLength(3);
    for (const s of snapshots) {
      expect(s.carryOnly + s.m2mOnly).toBeCloseTo(s.total, 8);
    }
    const stack = cumulativePnlStackK(snapshots);
    const last = stack[stack.length - 1]!;
    expect(last.carry + last.m2m).toBeCloseTo(
      (snapshots[2]!.total - snapshots[0]!.total) * 1000,
      6,
    );
  });

  it('leg P&L is zero when dealt outright equals the live forward', () => {
    const candles = [bar(1_000_000, 1.10), bar(1_060_000, 1.16)];
    const liveFwd = forwardOutrightMarketQuote({
      spotMarket: 1.16,
      months: 12,
      ccy: 'EUR',
      rFcyPct: EUR.r_FCY,
    });
    const ticket: HedgeTicket = {
      id: 'eur-fwd',
      ccy: 'EUR',
      instrument: 'forward',
      basis: 'totalBuildup',
      amountLocalM: 5,
      maturity: '1y',
      maturityLabel: '1 year',
      varUsdM: 0.1,
      addressesHigherVar: false,
      status: 'booked',
      ipaQuote: {
        strike: null,
        strikeInput: '',
        premiumUsd: null,
        premiumPercent: null,
        fxSpot: 1.16,
        fxOutright: liveFwd,
        atmVolPercent: null,
        impliedVolPercent: null,
        deltaPercent: null,
      },
    };
    const { pnlSeries } = buildLegPnlSeries({
      ticket,
      candles,
      ccy: 'EUR',
      rFcyPct: EUR.r_FCY,
      metric: 'total',
    });
    expect(pnlSeries[pnlSeries.length - 1]!.value).toBeCloseTo(0, 8);
  });

  it('converts inverted quotes to USD per FCY', () => {
    expect(marketQuoteToUsdPerFcy(4, 'PLN')).toBeCloseTo(0.25, 8);
    expect(marketQuoteToUsdPerFcy(1.16, 'EUR')).toBeCloseTo(1.16, 8);
  });
});
