import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, type RowState } from './fx-buffer';
import {
  DEFAULT_FORECAST_MONTHS,
  DEFAULT_FORECAST_PROFILE,
  emptyMonthFlow,
  extrapolateProfileToMonths,
  growMonthFlowFrom,
  normalizeMonthFlow,
  resizeMonthSeries,
  type ForecastMonthFlow,
  type ForecastProfileState,
} from './forecast-profile';

const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;

function row(over: Partial<RowState> = {}): RowState {
  return {
    ...eur,
    collections: 1.0,
    payout: -0.4,
    fcastFX: 0.2,
    ...over,
  };
}

function m1(): ForecastMonthFlow {
  return normalizeMonthFlow({
    collections: 1.0,
    payout: -0.4,
    invoiceFcast: 0.2,
    nwcIn: 0.5,
  });
}

describe('growMonthFlowFrom / resizeMonthSeries extrapolation', () => {
  it('compounds each line with default growthRateMoM', () => {
    const profile: ForecastProfileState = {
      ...DEFAULT_FORECAST_PROFILE,
      growthRateMoM: 0.1,
    };
    const next = growMonthFlowFrom(m1(), profile, 'EUR', 1);
    expect(next.collections).toBeCloseTo(1.1, 6);
    expect(next.payout).toBeCloseTo(-0.44, 6);
    expect(next.nwcIn).toBeCloseTo(0.55, 6);
  });

  it('uses per-category flatGrowthByCcy over the default', () => {
    const profile: ForecastProfileState = {
      ...DEFAULT_FORECAST_PROFILE,
      growthRateMoM: 0.1,
      flatGrowthByCcy: {
        EUR: { collections: 0.05, payout: 0, nwcIn: 0.2 },
      },
    };
    const next = growMonthFlowFrom(m1(), profile, 'EUR', 2);
    expect(next.collections).toBeCloseTo(1.0 * 1.05 ** 2, 6);
    expect(next.payout).toBeCloseTo(-0.4, 6); // explicit 0 = no growth
    expect(next.nwcIn).toBeCloseTo(0.5 * 1.2 ** 2, 6);
    expect(next.invoiceFcast).toBeCloseTo(0.2 * 1.1 ** 2, 6); // inherits default
  });

  it('extends a short custom series to 12 months with growth', () => {
    const profile: ForecastProfileState = {
      ...DEFAULT_FORECAST_PROFILE,
      mode: 'custom',
      growthRateMoM: 0.02,
      flatGrowthByCcy: {
        EUR: { collections: 0.03 },
      },
    };
    const known = [
      m1(),
      growMonthFlowFrom(m1(), profile, 'EUR', 1),
    ];
    const series = resizeMonthSeries(
      known,
      DEFAULT_FORECAST_MONTHS,
      row(),
      null,
      profile,
    );
    expect(series).toHaveLength(12);
    expect(series[0]!.collections).toBeCloseTo(1.0, 6);
    expect(series[1]!.collections).toBeCloseTo(1.03, 6);
    // Tail compounds from last known month (M2) with +3% MoM
    expect(series[11]!.collections).toBeCloseTo(1.03 * 1.03 ** 10, 5);
    expect(series[11]!.payout).toBeCloseTo(-0.4 * 1.02 * 1.02 ** 10, 5);
  });

  it('repeats last month when growth is zero (legacy pad)', () => {
    const series = resizeMonthSeries([m1()], 4, row(), null, {
      ...DEFAULT_FORECAST_PROFILE,
      growthRateMoM: 0,
    });
    expect(series).toHaveLength(4);
    for (const m of series) {
      expect(m.collections).toBeCloseTo(1.0, 6);
      expect(m.payout).toBeCloseTo(-0.4, 6);
    }
  });

  it('extrapolateProfileToMonths pads every FCY to Tf=12', () => {
    const profile: ForecastProfileState = {
      ...DEFAULT_FORECAST_PROFILE,
      mode: 'custom',
      growthRateMoM: 0.01,
      byCcy: { EUR: [m1()] },
    };
    const next = extrapolateProfileToMonths(profile, [row()], 12);
    expect(next.byCcy.EUR).toHaveLength(12);
    expect(next.byCcy.EUR![11]!.collections).toBeCloseTo(1.0 * 1.01 ** 11, 5);
  });

  it('empty series seeds from row with per-line growth', () => {
    const profile: ForecastProfileState = {
      ...DEFAULT_FORECAST_PROFILE,
      growthRateMoM: 0,
      flatGrowthByCcy: { EUR: { collections: 0.1, payout: 0.05 } },
    };
    const series = resizeMonthSeries(undefined, 3, row(), emptyMonthFlow(), profile);
    expect(series[0]!.collections).toBeCloseTo(1.0, 6);
    expect(series[2]!.collections).toBeCloseTo(1.0 * 1.1 ** 2, 6);
    expect(series[2]!.payout).toBeCloseTo(-0.4 * 1.05 ** 2, 6);
  });
});
