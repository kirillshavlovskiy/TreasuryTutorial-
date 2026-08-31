import { describe, expect, it } from 'vitest';
import {
  allocateUsdCapital,
  deriveUsdLiquidity,
  enforceUsdLiquidityStress,
  computeUsdBuffer,
  makeSimRow,
  INITIAL_USD_PARAMS,
  CURRENCY_PARAMS,
  type LayerId,
} from '@/lib/fx-buffer';
import { computeDashboardModel } from '@/lib/dashboard-model';
import {
  fxHedgeNetCfarByCcyUsdM,
  fxOnlyCfarReserveUsdM,
} from '@/lib/test-mode/cfar-net-by-ccy';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3, forecastMonths: 12 };

function model(
  layers: LayerId[],
  cfarNetByCcyUsd?: Record<string, number>,
  opts?: {
    usdCash?: number;
    usdPayout?: number;
    rows?: ReturnType<typeof makeSimRow>[];
  },
) {
  return computeDashboardModel({
    rows: opts?.rows ?? [makeSimRow('1', 'EUR', 10, 0, 0, 2.5, 0, 0, 0)],
    usdCash: opts?.usdCash ?? 900,
    usdNonLpCash: 0,
    usdParams: { ...INITIAL_USD_PARAMS, payout: opts?.usdPayout ?? 0 },
    shared: SHARED,
    activeLayers: new Set(layers),
    policyVAR: 5,
    cfarNetByCcyUsd,
  });
}

describe('allocateUsdCapital', () => {
  it('leftover = peak − WC − Σ FX-only Net CFaR', () => {
    const a = allocateUsdCapital(303.9, 116.45, 40, 0);
    expect(a.usd_peak).toBeCloseTo(303.9);
    expect(a.leftover).toBeCloseTo(303.9 - 156.45);
    expect(a.protected).toBeCloseTo(156.45);
    expect(a.wc_dip_ceiling).toBeCloseTo(303.9 - 40);
  });

  it('never negative leftover', () => {
    const a = allocateUsdCapital(50, 40, 30);
    expect(a.leftover).toBe(0);
    expect(a.wc_dip_ceiling).toBeCloseTo(20);
  });
});

describe('deriveUsdLiquidity — CFaR capital', () => {
  it('shrinks leftover by residual CFaR and keeps USD swap = −FCY net', () => {
    const d = deriveUsdLiquidity(116.45, 42.5, 303.9, 0, true, 40);
    expect(d.available_for_fcy).toBeCloseTo(303.9 - 116.45 - 40);
    expect(d.cfar_reserve).toBeCloseTo(40);
    expect(d.usd_protected).toBeCloseTo(156.45);
    expect(d.swapNear).toBeCloseTo(-42.5);
    expect(d.reserved_for_payout).toBeCloseTo(116.45);
  });

  it('flags leftover shortfall without changing the mechanical USD leg', () => {
    const d = deriveUsdLiquidity(0, 80, 100, 0, true, 40);
    expect(d.available_for_fcy).toBeCloseTo(60);
    expect(d.fcy_funding_shortfall).toBeCloseTo(20);
    expect(d.budget_binding).toBe(true);
    expect(d.swapNear).toBeCloseTo(-80);
  });
});

describe('desk USD waterfall', () => {
  it('reserves the FX-only Net CFaR sum when the cover layer is on', () => {
    const nets = { EUR: 12, GBP: 8 };
    const off = model(['sigmaP'], nets);
    const on = model(['sigmaP', 'cfarCover'], nets);
    expect(off.usdComputed.usd_cfar_reserved).toBe(0);
    expect(on.usdComputed.usd_cfar_reserved).toBeCloseTo(20);
    expect(on.usdComputed.usd_available_for_fcy).toBeCloseTo(
      off.usdComputed.usd_available_for_fcy - 20,
    );
    expect(on.usdComputed.usd_protected).toBeCloseTo(
      on.usdComputed.usd_reserved + 20,
    );
  });

  it('does not size FCY Swap Near from CFaR', () => {
    const nets = { EUR: 12 };
    const off = model(['sigmaP', 'floorH'], nets);
    const on = model(['sigmaP', 'floorH', 'cfarCover'], nets);
    expect(on.fcyComputed[0]!.swapNear).toBeCloseTo(off.fcyComputed[0]!.swapNear, 4);
    expect(on.fcyComputed[0]!.floatNim).toBeCloseTo(off.fcyComputed[0]!.floatNim, 8);
  });

  it('smaller FX-hedge cover map shrinks usd_cfar_reserved (cover first, cash second)', () => {
    const naked = { EUR: 10 };
    const hedged = { EUR: 4 };
    expect(fxOnlyCfarReserveUsdM(hedged)).toBeLessThan(fxOnlyCfarReserveUsdM(naked));
    const a = model(['cfarCover'], naked);
    const b = model(['cfarCover'], hedged);
    expect(a.usdComputed.usd_cfar_reserved).toBeCloseTo(10);
    expect(b.usdComputed.usd_cfar_reserved).toBeCloseTo(4);
  });

  it('cover map (no funding plan) is the reserve — not displayed Net with the swap bridge', () => {
    const row = makeSimRow('1', 'EUR', 10, 0, 0, 2.5, 0, 1.2, 0);
    const setup = { ...DEFAULT_VAR_SETUP, forecastUncertainty1m: 0.3 };
    const cover = fxHedgeNetCfarByCcyUsdM({ rows: [row], setup });
    const displayed = fxHedgeNetCfarByCcyUsdM({
      rows: [row],
      setup,
      fundingPlanByCcy: {
        EUR: Array.from({ length: 12 }, () => ({ standing_swap: 5, far_leg: 0 })),
      },
    });
    expect(fxOnlyCfarReserveUsdM(cover)).toBeLessThan(fxOnlyCfarReserveUsdM(displayed));
    const reserved = model(['cfarCover'], cover, { rows: [row] }).usdComputed.usd_cfar_reserved;
    expect(reserved).toBeCloseTo(fxOnlyCfarReserveUsdM(cover));
    expect(reserved).toBeLessThan(fxOnlyCfarReserveUsdM(displayed));
  });
});

describe('USD stress vs CFaR floor', () => {
  it('trims EARN FCY when leftover binds; CFaR reserve unchanged', () => {
    const mxn = { ...makeSimRow('1', 'MXN', 0, 0, 0, 0, 0), carry_target: 400 };
    const nets = { MXN: 40 };
    const res = model(['carryOptim', 'cfarCover'], nets, { usdCash: 50, rows: [mxn] });
    expect(res.usdComputed.usd_cfar_reserved).toBeCloseTo(40);
    expect(res.fcyComputed[0]!.cash_threshold).toBeLessThan(400);
    expect(res.usdComputed.usd_cfar_reserved).toBeCloseTo(40);
  });

  it('PAY cheap OD may dip WC; CFaR reserve stays intact', () => {
    const eur = { ...makeSimRow('1', 'EUR', 0, 0, 0, 10, 0), cash_floor: 80 };
    const nets = { EUR: 20 };
    const res = model(['floorH', 'sigmaP', 'cfarCover'], nets, {
      usdCash: 200,
      usdPayout: -80,
      rows: [eur],
    });
    expect(res.usdComputed.usd_cfar_reserved).toBeCloseTo(20);
    expect(res.fcyComputed[0]!.cash_threshold).toBeGreaterThan(70);
    expect(res.usdComputed.usd_cfar_reserved).toBeCloseTo(20);
  });

  it('never haircuts CFaR capital to fund FCY buffers', () => {
    const mxnSpot = CURRENCY_PARAMS.MXN!.spot;
    const rows = [{
      ccy: 'MXN',
      cash_threshold: 500,
      total_cash: 0,
      cash: 0,
      payout: 0,
      trough_lp: 0,
      P_contrib: 0,
      floor_contrib: 0,
      delta_sigma: 0,
      r_FCY: CURRENCY_PARAMS.MXN!.carry,
      r_OD: CURRENCY_PARAMS.MXN!.r_OD,
    }];
    const wc = computeUsdBuffer(0, 0, 0.10, new Set()).cash_threshold;
    const stress = enforceUsdLiquidityStress(rows, 50, wc, 3.50, true, 0, 40);
    expect(stress.usdLiquidity.cfar_reserve).toBeCloseTo(40);
    expect(stress.usdLiquidity.available_for_fcy).toBeCloseTo(10);
    const need = Math.max(0, stress.fcySwapNearUsd);
    expect(need).toBeLessThan(500 * mxnSpot);
    expect(stress.usdLiquidity.cfar_reserve).toBeCloseTo(40);
  });
});
