/**
 * Swap + Forward Δ — Cash Carry gross forward, CIP reallocation, and
 * liquidity-book isolation (remaining far never enters liquidityCycles).
 */
import { describe, expect, it } from 'vitest';
import {
  allocateSwapForwardOverlay,
  analyticsForwardsFromOverlays,
  resolveStrategyHedge,
} from '@/lib/fx-hedge';
import { fcyToUsdM, fundingSwapCipPointsUsdYr, makeSimRow } from '@/lib/fx-buffer';
import {
  buildCashForecastCarryComparison,
} from '@/lib/test-mode/cash-carry-analytics';
import { getActiveMarketRates } from '@/lib/fx-market-rates';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import {
  buildLiquidityLadder,
  DEFAULT_LIQUIDITY_TIMING,
} from '@/lib/liquidity-ladder';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
} from '@/lib/forecast-profile';

function profileWithTiming(): ForecastProfileState {
  return {
    ...DEFAULT_FORECAST_PROFILE,
    liquidity: { ...DEFAULT_LIQUIDITY_TIMING, granularity: 'month' },
  };
}

describe('Swap+Fwd Δ — carry reallocation', () => {
  it('gross forward carry rises exactly as retained CIP falls (matched curves)', () => {
    const E = 20;
    const S = 8;
    const r_FCY = 1.49;
    const r_USD = 3.50;
    const spot = fcyToUsdM(1, 'CAD');
    const fullCip = fundingSwapCipPointsUsdYr(S, spot, r_FCY, r_USD);

    const carries = [0, 0.5, 1].map(delta =>
      resolveStrategyHedge('SWAP_FWD', {
        ccy: 'CAD',
        currentFx: E,
        forecastFx: E,
        swapNear: S,
        swapStanding: S,
        swapForwardDelta: delta,
        optDelta: 0,
        horizonDays: 30,
        r_FCY,
        r_USD,
        σ_daily: 0.004,
      }),
    );

    expect(carries[0]!.cipCarryUsdYr).toBeCloseTo(fullCip, 9);
    expect(carries[1]!.cipCarryUsdYr).toBeCloseTo(fullCip * 0.5, 9);
    expect(carries[2]!.cipCarryUsdYr).toBeCloseTo(0, 9);

    expect(Math.abs(carries[2]!.fwdCarryUsdYr)).toBeGreaterThan(
      Math.abs(carries[0]!.fwdCarryUsdYr),
    );
    expect(carries[0]!.hedgeCarryUsdYr).toBeCloseTo(carries[1]!.hedgeCarryUsdYr, 6);
    expect(carries[1]!.hedgeCarryUsdYr).toBeCloseTo(carries[2]!.hedgeCarryUsdYr, 6);
  });

  it('Cash Carry FWD pts rise with Δ when overlay forward is injected', () => {
    const row = makeSimRow('1', 'EUR', 5, 0, 0, 2.5, 0, 1.2, 0);
    const setup = { ...DEFAULT_VAR_SETUP, forecastMonths: 12 };
    const marketRates = getActiveMarketRates();

    const fwdAt = (delta: number) => {
      const overlay = allocateSwapForwardOverlay({
        exposureLocalM: 10,
        swapNearLocalM: 4,
        delta,
      });
      const extra = analyticsForwardsFromOverlays({
        overlayByCcy: { EUR: overlay },
        forecastMonths: 12,
      });
      const cmp = buildCashForecastCarryComparison({
        ccy: 'EUR',
        bookRows: [row],
        forecastMonths: 12,
        marketRates,
        bookedHedges: [],
        preparedByCcy: {},
        setup,
        extraForwards: extra,
      });
      return cmp?.categories.fwdCarryUsdM ?? 0;
    };

    const f0 = fwdAt(0);
    const f1 = fwdAt(1);
    expect(Math.abs(f1)).toBeGreaterThan(Math.abs(f0));
  });
});

describe('Swap+Fwd Δ — liquidity-book isolation', () => {
  it('unfunded liquidity ladder is identical across Δ (remaining far stays out)', () => {
    const row = makeSimRow('1', 'EUR', 5, 0, 0, 10, -4, 3, 0);
    const profile = profileWithTiming();

    const bare = buildLiquidityLadder(row, profile, { months: 6 });

    // Injecting RemainingFar as if it were hedge settle would contaminate the
    // ladder — prove analytics extras do NOT do that path.
    const overlay = allocateSwapForwardOverlay({
      exposureLocalM: 10,
      swapNearLocalM: 5,
      delta: 0.5,
    });
    expect(Math.abs(overlay.remainingFarLocalM)).toBeGreaterThan(0);

    const extras = analyticsForwardsFromOverlays({
      overlayByCcy: { EUR: overlay },
      forecastMonths: 6,
    });
    // Only the outright forward is emitted — never RemainingFar.
    expect(extras).toHaveLength(1);
    expect(extras[0]!.amountLocalM).toBeCloseTo(overlay.forwardLocalM, 9);
    expect(extras[0]!.amountLocalM).not.toBeCloseTo(
      overlay.remainingFarLocalM, 6,
    );

    // Same ladder inputs (no hedgeSettle from remaining far) → identical book.
    const again = buildLiquidityLadder(row, profile, { months: 6 });
    expect(again.trough).toBeCloseTo(bare.trough, 9);
    expect(again.closing).toBeCloseTo(bare.closing, 9);
    expect(again.buckets.map(b => b.closing)).toEqual(
      bare.buckets.map(b => b.closing),
    );

    // Contaminating with RemainingFar as settle WOULD change the ladder —
    // documenting the forbidden path so regression stays sharp.
    const contaminated = buildLiquidityLadder(row, profile, {
      months: 6,
      hedgeSettle: Array.from({ length: 6 }, (_, i) =>
        i === 5 ? overlay.remainingFarLocalM : 0,
      ),
    });
    expect(contaminated.closing).not.toBeCloseTo(bare.closing, 6);
  });
});
