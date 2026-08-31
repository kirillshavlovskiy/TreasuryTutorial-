import { describe, expect, it } from 'vitest';
import {
  CURRENCY_PARAMS,
  INITIAL_ROWS,
  fundingSwapCashDeltaUsdYr,
  fundingSwapCipPointsUsdYr,
} from '@/lib/fx-buffer';
import {
  evaluateLiquidityStrategies,
  type LiquidityStrategyId,
} from '@/lib/test-mode/liquidity-strategies';
import { DEFAULT_FORECAST_PROFILE } from '@/lib/forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING } from '@/lib/liquidity-ladder';

const EUR_SPOT = CURRENCY_PARAMS.EUR?.spot ?? 1.1701;
const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3, forecastMonths: 12 };

function strategies(bookingMode: 'term' | 'rolling') {
  const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
  return evaluateLiquidityStrategies({
    rows: [{ ...eur, cash: 10, payout: -80, collections: 20, cash_floor: 0 }],
    forecastProfile: {
      ...DEFAULT_FORECAST_PROFILE,
      liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: true, bookingMode },
    },
    months: 12,
    shared: SHARED,
  });
}

function pick(bookingMode: 'term' | 'rolling', id: LiquidityStrategyId) {
  return strategies(bookingMode).find(r => r.strategy.id === id)!;
}

/**
 * Swap Carry and Gap Hedge are two different books priced off two different
 * sources. They must never be derived from the same position and the same rate
 * pair — that collapses them into the covered-interest-parity identity and the
 * desk ends up reading one number printed twice with opposite signs.
 *
 *   Swap Carry — funding book × NP cash rates (r_FCY / r_OD vs r_USD)
 *   Gap Hedge  — traded swap points off the market curve (bid/ask sided)
 *
 * The residual between them is the cross-currency basis plus the dealer
 * spread, which is the number the desk is actually trying to see.
 */
describe('Swap Carry and Gap Hedge are independent books', () => {
  it('CIP mid on the cash rates IS the parity identity — which is why points must not come from it', () => {
    // Documents the trap rather than endorsing it: derive both from r_FCY and
    // r_USD and you get one number twice. This is the pair the displayed
    // columns must NOT be built from.
    const N = 80;
    const cashDelta = fundingSwapCashDeltaUsdYr(N, EUR_SPOT, 1.78, 3.50, 2.21);
    const cipMid = fundingSwapCipPointsUsdYr(N, EUR_SPOT, 1.78, 3.50);
    expect(cashDelta).toBeCloseTo(-cipMid, 10);
  });

  it('funding a long EUR book out of dearer USD is negative carry', () => {
    // EUR credit 1.78 and debit 2.21 both sit under USD 3.50, so there is no
    // branch on which holding EUR bought with USD earns. A positive Swap Carry
    // here means a rate has been double counted.
    for (const mode of ['term', 'rolling'] as const) {
      const r = pick(mode, mode === 'term' ? 'termSwap' : 'rollingProgramme');
      expect(r.byCcy[0]!.avgBook).toBeGreaterThan(0);
      expect(r.swapInterestUsdYrM).toBeLessThan(0);
    }
  });

  it('displayed Swap Carry is never the negative of displayed Gap Hedge', () => {
    for (const mode of ['term', 'rolling'] as const) {
      for (const r of strategies(mode)) {
        if (Math.abs(r.byCcy[0]?.avgBook ?? 0) < 0.001) continue;
        const swap = r.swapInterestUsdYrM;
        const gap = r.swapPointsUsdYrM;
        expect(Math.abs(swap + gap)).toBeGreaterThan(0.001);
      }
    }
  });

  it('the residual between them is the basis — same sign story on term and rolling', () => {
    const term = pick('term', 'termSwap');
    const roll = pick('rolling', 'rollingProgramme');
    const basisOf = (r: typeof term) => r.swapInterestUsdYrM + r.swapPointsUsdYrM;
    expect(Math.abs(basisOf(term))).toBeGreaterThan(0.001);
    expect(Math.abs(basisOf(roll))).toBeGreaterThan(0.001);
    // Term carries the deepest cover from day one, so its book — and therefore
    // its cash-rate give-up — is larger than the rolling strip's.
    expect(term.swapInterestUsdYrM).toBeLessThan(roll.swapInterestUsdYrM);
  });

  it('points are sided off the traded curve, not a rate difference', () => {
    const term = pick('term', 'termSwap');
    expect(term.byCcy[0]!.schedule.some(l => l.pointsFromMarket)).toBe(true);
  });
});
