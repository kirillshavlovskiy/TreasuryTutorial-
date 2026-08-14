import { describe, expect, it } from 'vitest';
import {
  computeLayeredBuffer,
  fundingSwapOverlayUsdYr,
  makeSimRow,
  usdToFcyM,
  type LayerId,
} from '@/lib/fx-buffer';
import { computeDashboardModel } from '@/lib/dashboard-model';
import { INITIAL_USD_PARAMS } from '@/lib/fx-buffer';
import { fxHedgeNetCfarByCcyUsdM } from '@/lib/test-mode/cfar-net-by-ccy';
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

  it('nets to zero at CIP mid', () => {
    const o = fundingSwapOverlayUsdYr(-5, spot, 1.78, 3.50);
    expect(o.netUsdYr).toBeCloseTo(0, 12);
    expect(o.fcyOnUsdYr + o.usdOnUsdYr + o.pointsUsdYr).toBeCloseTo(0, 12);
  });

  it('selling EUR pays/forgoes FCY O/N; points offset the USD differential', () => {
    const o = fundingSwapOverlayUsdYr(-5, spot, 1.78, 3.50);
    expect(o.fcyOnUsdYr).toBeLessThan(0);
    expect(o.usdOnUsdYr).toBeGreaterThan(0);
    expect(o.pointsUsdYr).toBeCloseTo(-(o.fcyOnUsdYr + o.usdOnUsdYr), 12);
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
    // PAY with no other hold: stack cover on the unfunded trough so swap = cover.
    expect(on.cash_threshold).toBeCloseTo(-6.6 + 1.71, 8);
  });

  it('does not use Gross — omitted cover is zero even if the layer is on', () => {
    const r = computeLayeredBuffer(0, 2.5, 0.1, 3.5, 1.78, 2.21, 0, cover, 2.5);
    expect(r.delta_cfar).toBe(0);
  });
});

describe('CFaR cover layer on the desk', () => {
  const netUsd = 2.4;
  const coverFcy = usdToFcyM(netUsd, 'EUR');

  it('sizes the funding swap from Net CFaR and leaves trough / unfunded carry unchanged', () => {
    const off = model([], { EUR: netUsd }).fcyComputed[0]!;
    const on = model(['cfarCover'], { EUR: netUsd }).fcyComputed[0]!;

    expect(on.lp_peak_cash).toBeCloseTo(off.lp_peak_cash, 8);
    expect(on.floatNim).toBeCloseTo(off.floatNim, 8);
    expect(on.swapNear).toBeCloseTo(off.swapNear + coverFcy, 4);
    expect(on.swapCarryUsdYr).toBeCloseTo(0, 9);
    expect(on.swapOnUsdYr + on.swapPointsUsdYr).not.toBe(0);
  });

  it('does not loop — cover sizing is FX-hedge only and ignores the funding swap', () => {
    const a = fxHedgeNetCfarByCcyUsdM({
      rows: [EUR],
      setup: DEFAULT_VAR_SETUP,
    });
    const funded = model(['cfarCover'], a);
    const b = fxHedgeNetCfarByCcyUsdM({
      rows: [EUR],
      setup: DEFAULT_VAR_SETUP,
    });
    expect(a.EUR).toBeCloseTo(b.EUR, 12);
    expect(funded.fcyComputed[0]!.swapNear).not.toBe(0);
    expect(a.EUR).toBeGreaterThan(0.001);
  });

  it('stacks additively with another buffer', () => {
    const floorOnly = model(['floorH'], { EUR: netUsd }).fcyComputed[0]!;
    const both = model(['floorH', 'cfarCover'], { EUR: netUsd }).fcyComputed[0]!;
    expect(both.swapNear).toBeGreaterThan(floorOnly.swapNear);
    expect(both.floatNim).toBeCloseTo(floorOnly.floatNim, 8);
  });
});
