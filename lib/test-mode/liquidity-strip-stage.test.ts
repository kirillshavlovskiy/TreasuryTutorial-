import { describe, it, expect } from 'vitest';
import { allocateSwapForwardOverlay } from '@/lib/fx-hedge';
import {
  fundingStripPreparedProfile,
  mergeResidualOverlays,
  overlayDeltaStub,
  residualNeedsFxStage,
} from '@/lib/test-mode/liquidity-strip-stage';

const strip = [
  {
    cycleIndex: 0,
    valueDateMonths: 0,
    newLeg: -2.5,
    outstanding: -2.5,
    settleMonths: 12,
    preBookable: false,
  },
  {
    cycleIndex: 1,
    valueDateMonths: 1,
    newLeg: -1.4,
    outstanding: -3.9,
    settleMonths: 11,
    preBookable: true,
  },
];

describe('fundingStripPreparedProfile', () => {
  it('does not stage a far (Δ = 0) book', () => {
    expect(fundingStripPreparedProfile({
      ccy: 'EUR',
      schedule: strip,
      residual: 0,
      forecastMonths: 12,
    })).toBeNull();
    expect(residualNeedsFxStage(0)).toBe(false);
  });

  it('sizes the FX strip at the modeled residual Δ', () => {
    const profile = fundingStripPreparedProfile({
      ccy: 'EUR',
      schedule: strip,
      residual: 0.4,
      forecastMonths: 12,
    });
    expect(profile).not.toBeNull();
    expect(profile!.preparedFor).toBe('liquidity');
    expect(profile!.structure).toBe('strip');
    expect(profile!.hedgeRatio).toBeCloseTo(0.4, 9);
    expect(profile!.legs).toHaveLength(2);
    expect(profile!.legs[0]!.tradeNotionalLocalM).toBeCloseTo(-1.0, 9);
    expect(profile!.legs[1]!.tradeNotionalLocalM).toBeCloseTo(-0.56, 9);
    expect(profile!.coverLocalM).toBeCloseTo(-1.56, 9);
    expect(residualNeedsFxStage(0.4)).toBe(true);
  });

  it('stages a term programme as a bullet', () => {
    const profile = fundingStripPreparedProfile({
      ccy: 'EUR',
      schedule: [{
        cycleIndex: 0,
        valueDateMonths: 0,
        newLeg: -8,
        outstanding: -8,
        settleMonths: 12,
        preBookable: false,
      }],
      residual: 1,
      forecastMonths: 12,
    });
    expect(profile!.structure).toBe('bullet');
    expect(profile!.legs).toHaveLength(0);
    expect(profile!.coverLocalM).toBeCloseTo(-8, 9);
    expect(profile!.settleMonths).toBe(12);
  });
});

describe('mergeResidualOverlays', () => {
  it('replaces desk Δ with the modeled residual, converted to the hedge-coverage convention downstream readers expect', () => {
    // overlayDeltaStub's `residual` param is the frontier convention (1 =
    // open/nothing hedged); the stored `.delta` field it returns is the
    // OPPOSITE hedge-coverage convention (Δ=1 = fully hedged) that
    // retainedFundingPlanByCcy/overlayCipRetention actually read — so
    // .delta = 1 - residual. See overlayDeltaStub's own doc comment.
    const desk = {
      EUR: allocateSwapForwardOverlay({
        exposureLocalM: 10,
        swapNearLocalM: 6,
        delta: 1,
      }),
    };
    const merged = mergeResidualOverlays(desk, { EUR: 0.25, GBP: 0 });
    expect(merged.EUR!.delta).toBeCloseTo(0.75, 9); // residual=0.25 (mostly hedged) → delta=1-0.25
    expect(merged.EUR!.forwardLocalM).toBe(0);
    expect(merged.GBP!.delta).toBe(1); // residual=0 (fully hedged/far) → delta=1-0
    expect(overlayDeltaStub(1).delta).toBe(0); // residual=1 (fully open) → delta=1-1
  });
});
