import { describe, expect, it } from 'vitest';
import { makeSimRow } from '@/lib/fx-buffer';
import {
  displayedCfarUsdMFromFxNet,
  fxHedgeMcCfarByCcy,
  fxHedgeNetCfarByCcyUsdM,
} from '@/lib/test-mode/cfar-net-by-ccy';
import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import { allocateSwapForwardOverlay } from '@/lib/fx-hedge';

const EUR = makeSimRow('1', 'EUR', 10, 0, 0, 2.5, 0, 1.2, 0);
const SETUP = {
  ...DEFAULT_VAR_SETUP,
  forecastMonths: 12,
  confidencePct: 95 as const,
  forecastUncertainty1m: 0.3,
};
/** Over-hedge so conversion CFaR survives the carry buffer (Net, not Gross). */
const HEDGE: HedgeTicket = {
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

describe('fxHedgeNetCfarByCcyUsdM — cover vs displayed', () => {
  it('gives an unhedged book ~0 cover CFaR (no conversion)', () => {
    const cover = fxHedgeNetCfarByCcyUsdM({ rows: [EUR], setup: SETUP });
    expect(cover.EUR ?? 0).toBeLessThan(0.001);
  });

  it('raises Gross CFaR once a hedge forces a delivery', () => {
    const open = fxHedgeMcCfarByCcy({ rows: [EUR], setup: SETUP });
    const hedged = fxHedgeMcCfarByCcy({
      rows: [EUR],
      setup: SETUP,
      bookedHedges: [HEDGE],
    });
    expect(open.EUR!.criticalCashUsdM).toBeLessThan(0.05);
    expect(hedged.EUR!.criticalCashUsdM).toBeGreaterThan(open.EUR!.criticalCashUsdM);
  });

  it('does not put the funding swap into cover, and RSS-adds it when displayed', () => {
    const cover = fxHedgeNetCfarByCcyUsdM({
      rows: [EUR],
      setup: SETUP,
      bookedHedges: [HEDGE],
    });
    const displayed = fxHedgeNetCfarByCcyUsdM({
      rows: [EUR],
      setup: SETUP,
      bookedHedges: [HEDGE],
      fundingPlanByCcy: {
        EUR: Array.from({ length: 12 }, () => ({ standing_swap: 4, far_leg: 0 })),
      },
    });
    expect(displayed.EUR ?? 0).toBeGreaterThan(cover.EUR ?? 0);
  });

  it('scales funding-bridge CFaR by (1−Δ) and does not double-count directional FX', () => {
    const plan = {
      EUR: Array.from({ length: 12 }, () => ({ standing_swap: 8, far_leg: -8 })),
    };
    const overlayFull = allocateSwapForwardOverlay({
      exposureLocalM: 10,
      swapNearLocalM: 8,
      delta: 0,
    });
    const overlayHalf = allocateSwapForwardOverlay({
      exposureLocalM: 10,
      swapNearLocalM: 8,
      delta: 0.5,
    });
    const overlayGone = allocateSwapForwardOverlay({
      exposureLocalM: 10,
      swapNearLocalM: 8,
      delta: 1,
    });

    const at0 = fxHedgeNetCfarByCcyUsdM({
      rows: [EUR],
      setup: SETUP,
      bookedHedges: [HEDGE],
      fundingPlanByCcy: plan,
      swapForwardOverlayByCcy: { EUR: overlayFull },
    });
    const at50 = fxHedgeNetCfarByCcyUsdM({
      rows: [EUR],
      setup: SETUP,
      bookedHedges: [HEDGE],
      fundingPlanByCcy: plan,
      swapForwardOverlayByCcy: { EUR: overlayHalf },
    });
    const at100 = fxHedgeNetCfarByCcyUsdM({
      rows: [EUR],
      setup: SETUP,
      bookedHedges: [HEDGE],
      fundingPlanByCcy: plan,
      swapForwardOverlayByCcy: { EUR: overlayGone },
    });
    const coverOnly = fxHedgeNetCfarByCcyUsdM({
      rows: [EUR],
      setup: SETUP,
      bookedHedges: [HEDGE],
    });

    // Full retention ≥ half retention ≥ fully replaced (bridge → 0).
    expect(at0.EUR ?? 0).toBeGreaterThanOrEqual(at50.EUR ?? 0);
    expect(at50.EUR ?? 0).toBeGreaterThanOrEqual(at100.EUR ?? 0);
    // Δ=1 cancels the funding bridge — displayed ≈ FX-only cover.
    expect(at100.EUR ?? 0).toBeCloseTo(coverOnly.EUR ?? 0, 3);
  });
});

describe('displayedCfarUsdMFromFxNet — swap Net, not linear in carry', () => {
  const plan = (standing: number) =>
    Array.from({ length: 12 }, () => ({ standing_swap: standing, far_leg: -standing }));
  const carryRamp = (totalUsdM: number) =>
    Array.from({ length: 12 }, (_, i) => (totalUsdM * (i + 1)) / 12);

  it('RSS with the FX-only section is not a linear map from standing or from carry paid', () => {
    const fx = 0.36;
    const atBook = displayedCfarUsdMFromFxNet(
      fx, 'EUR', plan(-317.5), SETUP, carryRamp(4.773),
    );
    const doubled = displayedCfarUsdMFromFxNet(
      fx, 'EUR', plan(-635), SETUP, carryRamp(9.546),
    );
    expect(doubled).toBeGreaterThan(atBook);
    expect(doubled).not.toBeCloseTo(2 * atBook, 2);
    expect(atBook).not.toBeCloseTo(fx + 4.773, 1);
  });

  it('Buffer Carry cuts swap-net CFaR vs the same standing with no carry', () => {
    const fx = 0.36;
    const standing = plan(-317.5);
    const noCarry = displayedCfarUsdMFromFxNet(fx, 'EUR', standing, SETUP);
    const withCarry = displayedCfarUsdMFromFxNet(
      fx, 'EUR', standing, SETUP, carryRamp(4.773),
    );
    expect(withCarry).toBeLessThan(noCarry);
    expect(withCarry).toBeGreaterThan(fx);
  });
});
