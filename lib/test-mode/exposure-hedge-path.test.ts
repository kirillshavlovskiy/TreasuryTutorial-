import { describe, expect, it } from 'vitest';
import {
  buildExposurePathPoints,
  exposureAtT,
  mapPathToUncoveredIncrement,
  scalePathToForecastEnd,
  uncoveredIncrementLocalM,
} from '@/lib/test-mode/exposure-hedge-path';

describe('uncovered forecast increment', () => {
  it('leftover clip is E − booked (desk +2.55)', () => {
    expect(uncoveredIncrementLocalM(1.9, 12.1, 14.65)).toBeCloseTo(2.55);
    expect(uncoveredIncrementLocalM(12.1, 12.1, 14.65)).toBeCloseTo(2.55);
    expect(uncoveredIncrementLocalM(14.65, 12.1, 14.65)).toBeCloseTo(2.55);
    expect(uncoveredIncrementLocalM(14.65, -12.1, 14.65)).toBeCloseTo(2.55);
  });

  it('grows 0 → leftover with the forecast shape, not a late cliff after booked', () => {
    const raw = buildExposurePathPoints(
      1.9,
      Array.from({ length: 12 }, () => 0.774),
      12,
    );
    const nativeEnd = raw[raw.length - 1]!.exposureM;
    expect(nativeEnd).toBeLessThan(12.1);
    const inc = mapPathToUncoveredIncrement(raw, 12.1, 14.65);
    expect(inc[0]!.exposureM).toBeCloseTo(0);
    expect(inc[inc.length - 1]!.exposureM).toBeCloseTo(2.55);
    expect(exposureAtT(inc, 6)).toBeGreaterThan(1);
    expect(exposureAtT(inc, 6)).toBeLessThan(2);
  });

  it('scales a short path so it ends at forecast E before sizing leftover', () => {
    const raw = [
      { t: 0, exposureM: 1.9 },
      { t: 12, exposureM: 11.19 },
    ];
    const scaled = scalePathToForecastEnd(raw, 14.65);
    expect(scaled[0]!.exposureM).toBeCloseTo(1.9);
    expect(scaled[1]!.exposureM).toBeCloseTo(14.65);
  });

  it('unwind leftover follows the same growth onto −clip, not a flat residual', () => {
    expect(uncoveredIncrementLocalM(1.9, 12.1, 8)).toBeCloseTo(-4.1);
    expect(uncoveredIncrementLocalM(8, 12.1, 8)).toBeCloseTo(-4.1);
    const path = [
      { t: 0, exposureM: 1.9 },
      { t: 12, exposureM: 8 },
    ];
    const inc = mapPathToUncoveredIncrement(path, 12.1, 8);
    expect(inc[0]!.exposureM).toBeCloseTo(0);
    expect(inc[1]!.exposureM).toBeCloseTo(-4.1);
  });
});
