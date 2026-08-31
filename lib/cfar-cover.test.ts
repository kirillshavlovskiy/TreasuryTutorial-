import { describe, expect, it } from 'vitest';
import {
  computeLayeredBuffer,
  fundingSwapOverlayUsdYr,
  fundingSwapMonthCarryUsdM,
  fundingSwapPathCarryUsdM,
  fundingSwapCashDeltaUsdYr,
  fundingSwapCarryViewFor,
  fundingSwapFcyOnUsdYr,
  fundingSwapPathFcyOnUsdM,
  fundingSwapCashLegUsdYr,
  fundingSwapCipPointsUsdYr,
  makeSimRow,
  usdToFcyM,
  type LayerId,
} from '@/lib/fx-buffer';
import { computeDashboardModel } from '@/lib/dashboard-model';
import { INITIAL_USD_PARAMS, CURRENCY_PARAMS } from '@/lib/fx-buffer';
import { fxHedgeNetCfarByCcyUsdM } from '@/lib/test-mode/cfar-net-by-ccy';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3, forecastMonths: 12 };
const EUR = makeSimRow('1', 'EUR', 10, 0, 0, 2.5, 0, 0, 0);

function model(layers: LayerId[], cfarNetByCcyUsd?: Record<string, number>) {
  return computeDashboardModel({
    rows: [EUR],
    usdCash: 900,
    usdNonLpCash: 0,
    usdParams: INITIAL_USD_PARAMS,
    shared: SHARED,
    activeLayers: new Set(layers),
    policyVAR: 5,
    cfarNetByCcyUsd,
  });
}

describe('fundingSwapOverlayUsdYr', () => {
  const spot = 1.1701;

  it('nets to zero at CIP mid when deploying surplus (sell FCY)', () => {
    const o = fundingSwapOverlayUsdYr(-5, spot, 1.78, 3.50, 2.21);
    expect(o.netUsdYr).toBeCloseTo(0, 12);
    expect(o.fcyOnUsdYr + o.usdOnUsdYr + o.pointsUsdYr).toBeCloseTo(0, 12);
  });

  it('selling EUR pays/forgoes FCY credit; points offset the USD differential', () => {
    const o = fundingSwapOverlayUsdYr(-5, spot, 1.78, 3.50, 2.21);
    expect(o.fcyOnUsdYr).toBeLessThan(0);
    expect(o.usdOnUsdYr).toBeGreaterThan(0);
    expect(o.pointsUsdYr).toBeCloseTo(-(o.fcyOnUsdYr + o.usdOnUsdYr), 12);
  });

  it('long-near EUR: covering book prices FCY O/N at OD; points stay on the credit curve', () => {
    const N = 5;
    const r_FCY = 1.78;
    const r_OD = 2.21;
    const r_USD = 3.50;
    const o = fundingSwapOverlayUsdYr(N, spot, r_FCY, r_USD, r_OD);
    const cashDr = N * ((r_OD - r_USD) / 100) * spot;
    expect(o.fcyOnUsdYr).toBeCloseTo(N * (r_OD / 100) * spot, 12);
    expect(o.usdOnUsdYr).toBeCloseTo(-N * (r_USD / 100) * spot, 12);
    expect(o.fcyOnUsdYr + o.usdOnUsdYr).toBeCloseTo(cashDr, 12);
    expect(cashDr).toBeLessThan(0);
    expect(o.pointsUsdYr).toBeCloseTo(-N * ((r_FCY - r_USD) / 100) * spot, 12);
  });

  it('long-near covering book uses OD for FCY O/N — points stay on r_FCY', () => {
    const N = 10;
    const r_FCY = 1.78;
    const r_OD = 2.21;
    const r_USD = 3.50;
    const o = fundingSwapOverlayUsdYr(N, spot, r_FCY, r_USD, r_OD);
    expect(o.fcyOnUsdYr).toBeCloseTo(N * (r_OD / 100) * spot, 12);
    expect(o.fcyOnUsdYr).not.toBeCloseTo(N * (r_FCY / 100) * spot, 12);
    expect(o.pointsUsdYr).toBeCloseTo(-N * ((r_FCY - r_USD) / 100) * spot, 12);
  });

  it('path Swap Carry sums later-cycle standing book — not just M1 near', () => {
    const spot = 0.27486120;
    const plan = [
      { standing_swap: 0 },
      { standing_swap: 40 },
      { standing_swap: 40 },
    ];
    const m1 = fundingSwapMonthCarryUsdM(0, spot, 3.41, 3.50, 4.41);
    const later = fundingSwapMonthCarryUsdM(40, spot, 3.41, 3.50, 4.41);
    expect(m1).toBeCloseTo(0, 12);
    const path = fundingSwapPathCarryUsdM(plan, spot, 3.41, 3.50, 4.41);
    expect(path).toBeCloseTo(later * 2, 12);
    expect(Math.abs(path ?? 0)).toBeGreaterThan(0);
  });

  it('cashDelta Swap Carry is Δr on the book — CIP-zero deploy still has P&L', () => {
    const spot = 1.1701;
    const N = -40;
    const cip = fundingSwapOverlayUsdYr(N, spot, 1.78, 3.50, 2.21);
    expect(cip.netUsdYr).toBeCloseTo(0, 12);
    const cash = fundingSwapCashDeltaUsdYr(N, spot, 1.78, 3.50, 2.21);
    expect(cash).toBeCloseTo(N * ((2.21 - 3.50) / 100) * spot, 12);
    expect(Math.abs(cash)).toBeGreaterThan(0.01);
    const month = fundingSwapMonthCarryUsdM(N, spot, 1.78, 3.50, 2.21, 'cashDelta');
    expect(month).toBeCloseTo(cash / 12, 12);
  });

  it('selects cashDelta only while a carry target is live on the carry layer', () => {
    expect(fundingSwapCarryViewFor(0.462, true)).toBe('cashDelta');
    expect(fundingSwapCarryViewFor(0.462, false)).toBe('cip');
    expect(fundingSwapCarryViewFor(undefined, true)).toBe('cip');
  });

  it('high-income PAY short: cash Δr is positive and CIP points are the opposite', () => {
    const N = -5;
    const r_FCY = 1.78;
    const r_OD = 2.21;
    const r_USD = 3.50;
    const cash = fundingSwapCashDeltaUsdYr(N, spot, r_FCY, r_USD, r_OD);
    const points = fundingSwapCipPointsUsdYr(N, spot, r_FCY, r_USD);
    expect(cash).toBeGreaterThan(0);
    expect(points).toBeLessThan(0);
    expect(cash).toBeCloseTo(N * ((r_OD - r_USD) / 100) * spot, 12);
  });

  it('cash leg is +r_FCY − r_USD and equals −points', () => {
    const r_FCY = 1.78;
    const r_USD = 3.50;
    const long = fundingSwapCashLegUsdYr(5, spot, r_FCY, r_USD);
    const short = fundingSwapCashLegUsdYr(-5, spot, r_FCY, r_USD);
    const pointsLong = fundingSwapCipPointsUsdYr(5, spot, r_FCY, r_USD);
    const pointsShort = fundingSwapCipPointsUsdYr(-5, spot, r_FCY, r_USD);
    expect(long).toBeCloseTo(-pointsLong, 12);
    expect(short).toBeCloseTo(-pointsShort, 12);
    expect(long).toBeLessThan(0);
    expect(short).toBeGreaterThan(0);
  });

  it('path FCY O/N sums the standing book', () => {
    const plan = [
      { standing_swap: 0 },
      { standing_swap: 40 },
      { standing_swap: 40 },
    ];
    const path = fundingSwapPathFcyOnUsdM(plan, spot, 1.78);
    expect(path).toBeCloseTo(fundingSwapFcyOnUsdYr(40, spot, 1.78) / 12 * 2, 12);
  });
});

describe('computeLayeredBuffer CFaR cover', () => {
  const none = new Set<LayerId>();
  const cover = new Set<LayerId>(['cfarCover']);

  it('adds only Net CFaR when the layer is on', () => {
    const off = computeLayeredBuffer(0, -6.6, 0.1, 3.5, 1.78, 2.21, 0, none, 2.5, undefined, 1.71);
    const on = computeLayeredBuffer(0, -6.6, 0.1, 3.5, 1.78, 2.21, 0, cover, 2.5, undefined, 1.71);
    expect(off.delta_cfar).toBe(0);
    expect(on.delta_cfar).toBeCloseTo(1.71, 8);
    // Readout only — never sizes the FCY trough / Swap Near.
    expect(on.cash_threshold).toBeCloseTo(off.cash_threshold, 8);
  });

  it('does not use Gross — omitted cover is zero even if the layer is on', () => {
    const r = computeLayeredBuffer(0, 2.5, 0.1, 3.5, 1.78, 2.21, 0, cover, 2.5);
    expect(r.delta_cfar).toBe(0);
  });
});

describe('CFaR cover layer on the desk', () => {
  const netUsd = 2.4;
  const coverFcy = usdToFcyM(netUsd, 'EUR');

  it('does not size the funding swap from Net CFaR — trough / swap stay put', () => {
    const off = model([], { EUR: netUsd }).fcyComputed[0]!;
    const on = model(['cfarCover'], { EUR: netUsd }).fcyComputed[0]!;

    expect(on.lp_peak_cash).toBeCloseTo(off.lp_peak_cash, 8);
    expect(on.swapNear).toBeCloseTo(off.swapNear, 4);
  });

  it('does not loop — cover sizing is FX-hedge only and ignores the funding swap', () => {
    const row = makeSimRow('1', 'EUR', 10, 0, 0, 2.5, 0, 1.2, 0);
    const hedge: HedgeTicket = {
      id: 'eur-fwd',
      ccy: 'EUR',
      instrument: 'forward',
      basis: 'simpleAvg',
      amountLocalM: 25,
      maturity: '1y',
      maturityLabel: 'M12',
      varUsdM: 0,
      addressesHigherVar: false,
    };
    const setup = { ...DEFAULT_VAR_SETUP, forecastUncertainty1m: 0.3 };
    const a = fxHedgeNetCfarByCcyUsdM({
      rows: [row],
      setup,
      bookedHedges: [hedge],
    });
    const b = fxHedgeNetCfarByCcyUsdM({
      rows: [row],
      setup,
      bookedHedges: [hedge],
      fundingPlanByCcy: {
        EUR: Array.from({ length: 12 }, () => ({ standing_swap: 5, far_leg: 0 })),
      },
    });
    const a2 = fxHedgeNetCfarByCcyUsdM({
      rows: [row],
      setup,
      bookedHedges: [hedge],
    });
    expect(a.EUR ?? 0).toBeCloseTo(a2.EUR ?? 0, 12);
    expect(b.EUR ?? 0).toBeGreaterThan(a.EUR ?? 0);
  });

  it('does not stack into Swap Near when paired with another buffer', () => {
    const floorOnly = model(['floorH'], { EUR: netUsd }).fcyComputed[0]!;
    const both = model(['floorH', 'cfarCover'], { EUR: netUsd }).fcyComputed[0]!;
    expect(both.swapNear).toBeCloseTo(floorOnly.swapNear, 4);
  });
});
