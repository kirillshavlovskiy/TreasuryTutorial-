import { describe, expect, it } from 'vitest';
import {
  compareConstrainedFrontiers,
  demoConstrainedFrontierLegs,
  minBalanceFcyM,
} from '@/lib/test-mode/constrained-carry-frontier';

describe('constrained carry frontier (active-set vs fixed ray)', () => {
  const legs = demoConstrainedFrontierLegs();
  const caps = [5, 12, 20];

  it('raises min balance when Forecast accuracy (sigmaP) is on', () => {
    const floorOnly = {
      floorH: true,
      sigmaP: false,
      sigmaPFrac: 0.1,
      rUsd: 3.5,
    };
    const withSigma = { ...floorOnly, sigmaP: true };
    for (const leg of legs) {
      expect(minBalanceFcyM(leg, withSigma)).toBeGreaterThan(minBalanceFcyM(leg, floorOnly));
    }
  });

  it('active-set earns more carry than fixed-ray clamp at the same VAR', () => {
    const cmp = compareConstrainedFrontiers(
      legs,
      {
        floorH: true,
        sigmaP: false,
        sigmaPFrac: 0.1,
        rUsd: 3.5,
      },
      caps,
    );
    for (let i = 0; i < caps.length; i++) {
      const f = cmp.fixedRay[i]!;
      const a = cmp.activeSet[i]!;
      expect(a.varUsdM).toBeCloseTo(caps[i]!, 6);
      expect(f.varUsdM).toBeCloseTo(caps[i]!, 4);
      expect(a.carryUsdYrM).toBeGreaterThan(f.carryUsdYrM);
      expect(a.floorBoundCcys.length).toBeGreaterThanOrEqual(f.floorBoundCcys.length);
    }
  });

  it('sigmaP cushion lowers absolute carry on both methods', () => {
    const floorOnlyPolicy = {
      floorH: true,
      sigmaP: false,
      sigmaPFrac: 0.1,
      rUsd: 3.5,
    };
    const floorOnly = compareConstrainedFrontiers(legs, floorOnlyPolicy, [12]);
    const withSigma = compareConstrainedFrontiers(
      legs,
      { ...floorOnlyPolicy, sigmaP: true },
      [12],
    );
    expect(withSigma.activeSet[0]!.carryUsdYrM)
      .toBeLessThan(floorOnly.activeSet[0]!.carryUsdYrM);
    expect(withSigma.fixedRay[0]!.carryUsdYrM)
      .toBeLessThan(floorOnly.fixedRay[0]!.carryUsdYrM);
  });
});
