import { describe, expect, it } from 'vitest';
import {
  stagedFxHedgeCarryByCcyUsdM,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';

function stubProfile(impliedCarryUsdM?: number): PreparedHedgeProfile {
  return {
    structure: 'bullet',
    basis: 'cash',
    ticketBasis: 'stock',
    legs: [],
    coverLocalM: 10,
    hedgeRatio: 1,
    impliedCarryUsdM,
  };
}

describe('stagedFxHedgeCarryByCcyUsdM', () => {
  it('maps finite implied FWD-points carry, including zero', () => {
    expect(
      stagedFxHedgeCarryByCcyUsdM({
        EUR: stubProfile(0.042),
        PLN: stubProfile(0),
        GBP: stubProfile(undefined),
      }),
    ).toEqual({ EUR: 0.042, PLN: 0 });
  });

  it('returns an empty map when nothing is staged', () => {
    expect(stagedFxHedgeCarryByCcyUsdM()).toEqual({});
    expect(stagedFxHedgeCarryByCcyUsdM({})).toEqual({});
  });
});
