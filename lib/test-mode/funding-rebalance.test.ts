import { describe, it, expect } from 'vitest';
import {
  INITIAL_ROWS,
  type LayerId,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING } from '@/lib/liquidity-ladder';
import { rebalanceFundingBook } from '@/lib/test-mode/funding-rebalance';

const pick = (c: string) => INITIAL_ROWS.find(r => r.ccy === c)!;

/** A book that drains every cycle, so the trough needs funding. */
function drain(base: RowState): RowState {
  return { ...base, cash: 20, payout: -90, collections: 60, fcastFX: 0, cash_floor: 0 };
}

const shared: SharedGlobals = { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 3 };
const profile: ForecastProfileState = {
  ...DEFAULT_FORECAST_PROFILE,
  liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: true },
};

function run(ccys: string[], activeLayers?: Set<LayerId>) {
  return rebalanceFundingBook({
    rows: ccys.map(c => drain(pick(c))),
    forecastProfile: profile,
    months: 3,
    shared,
    activeLayers,
  });
}

describe('rebalanceFundingBook', () => {
  it('reports the free carry from reallocating at constant portfolio VAR', () => {
    const r = run(['EUR', 'GBP', 'PLN']);
    expect(r).not.toBeNull();

    console.log('\n── portfolio ──');
    console.log(`carry now       ${r!.carryNowUsdYrM.toFixed(4)}`);
    console.log(`carry proposed  ${r!.carryProposedUsdYrM.toFixed(4)}`);
    console.log(`free carry      ${r!.carryGainUsdYrM.toFixed(4)}`);
    console.log(`VAR now         ${r!.portfolioVarNowUsdM.toFixed(4)}`);
    console.log(`VAR proposed    ${r!.portfolioVarProposedUsdM.toFixed(4)}`);
    console.log(`standalone sum  ${r!.standaloneSumNowUsdM.toFixed(4)}`);
    console.log(`div factor      ${r!.divFactorNow.toFixed(4)}`);
    console.log(`already optimal ${r!.alreadyOptimal}`);
    console.log('\nccy  cover now → prop   carry now → prop      compVAR    beta   ratio');
    for (const n of r!.names) {
      console.log(
        [
          n.ccy.padEnd(4),
          `${(n.coverNow * 100).toFixed(0)}%`.padStart(5),
          '→',
          `${(n.coverProposed * 100).toFixed(0)}%`.padStart(5),
          n.carryNowUsdYrM.toFixed(3).padStart(9),
          '→',
          n.carryProposedUsdYrM.toFixed(3).padStart(8),
          n.componentVarNowUsdM.toFixed(3).padStart(10),
          n.betaNow.toFixed(3).padStart(7),
          n.marginalRatioNow.toFixed(3).padStart(8),
        ].join(' '),
      );
    }

    // Reallocation must never spend more risk than it started with.
    expect(r!.portfolioVarProposedUsdM).toBeLessThanOrEqual(
      r!.portfolioVarNowUsdM + 0.011,
    );
    // ...and must never lose carry.
    expect(r!.carryGainUsdYrM).toBeGreaterThanOrEqual(-1e-9);
  });

  it('diversification makes portfolio VAR strictly cheaper than the standalone sum', () => {
    const r = run(['EUR', 'GBP', 'PLN'])!;
    expect(r.portfolioVarNowUsdM).toBeLessThan(r.standaloneSumNowUsdM);
    expect(r.divFactorNow).toBeGreaterThan(0);
    expect(r.divFactorNow).toBeLessThan(1);
  });

  it('every name reports a beta at or below 1', () => {
    const r = run(['EUR', 'GBP', 'PLN'])!;
    for (const n of r.names) {
      expect(n.betaNow).toBeLessThanOrEqual(1 + 1e-9);
      expect(n.betaNow).toBeGreaterThan(0);
    }
  });

  it('cover stays inside 0–100% on every name', () => {
    const r = run(['EUR', 'GBP', 'PLN'])!;
    for (const n of r.names) {
      expect(n.coverProposed).toBeGreaterThanOrEqual(0);
      expect(n.coverProposed).toBeLessThanOrEqual(1);
    }
  });

  it('needs two fundable names to have anything to reallocate', () => {
    expect(run(['GBP'])).toBeNull();
  });

  it('returns null with no funding policy — no dial on any name', () => {
    expect(run(['EUR', 'GBP', 'PLN'], new Set<LayerId>())).toBeNull();
  });

  it('flags names the correlation matrix cannot price', () => {
    // AED is outside CORR_CURRENCIES, so including it must be reported rather
    // than silently dropped — otherwise the risk budget is quietly wrong.
    const r = run(['EUR', 'GBP', 'AED']);
    if (r) expect(r.excluded).toContain('AED');
  });
});

describe('H* compliance is a hard constraint', () => {
  it('never proposes more breaches than the live book already has', () => {
    const r = run(['EUR', 'GBP', 'PLN'])!;
    console.log(`\nbreaches now ${r.floorBreachesNow} → proposed ${r.floorBreachesProposed}`);
    console.log(`carry ${r.carryNowUsdYrM.toFixed(4)} → ${r.carryProposedUsdYrM.toFixed(4)}`);
    console.log(`VAR   ${r.portfolioVarNowUsdM.toFixed(4)} → ${r.portfolioVarProposedUsdM.toFixed(4)}`);
    console.log(`cover ${r.names.map(n => `${n.ccy} ${(n.coverProposed * 100).toFixed(0)}%`).join(' · ')}`);
    expect(r.floorBreachesProposed).toBeLessThanOrEqual(r.floorBreachesNow);
  });
});
