import { describe, it, expect } from 'vitest';
import { solveHedgeFrontierAtCap, type FxLegCorrFn } from '@/lib/test-mode/fx-hedge-frontier-optimizer';
import { fxAtlasLegVarUsdM, atlasLegKey, type FxAtlasLeg } from '@/lib/test-mode/fx-var-frontier';
import { atlasRiskCorr, impliedFxVol, atlasPairCorr, atlasTenorCorr, ATLAS_CORR } from '@/lib/fx-market-risk';
import {
  ATLAS_FIXTURE_CCY_ORDER,
  ATLAS_FIXTURE_EXPOSURE_LOCAL_M,
  ATLAS_FIXTURE_EXPOSURE_USD_M,
  ATLAS_FIXTURE_CARRY_RATE_PCT_YR,
  ATLAS_FIXTURE_FRONTIER_POINTS,
  ATLAS_FIXTURE_LEG_KEYS,
  ATLAS_FIXTURE_HEDGE_RATIO_GRID,
} from '@/lib/test-mode/fixtures/atlas-efficient-frontier';

const Z_95 = 1.645;

function buildFixtureLegs(): FxAtlasLeg[] {
  const legs: FxAtlasLeg[] = [];
  for (const ccy of ATLAS_FIXTURE_CCY_ORDER) {
    const localSeries = ATLAS_FIXTURE_EXPOSURE_LOCAL_M[ccy]!;
    for (let t = 1; t <= 12; t++) {
      const key = `${ccy}:${t}`;
      const localM = localSeries[t - 1]!;
      const exposureUsdM = ATLAS_FIXTURE_EXPOSURE_USD_M[key]!;
      const annVol = impliedFxVol(ccy, t);
      const varUsdM = fxAtlasLegVarUsdM(localM, exposureUsdM / localM, t, annVol, Z_95);
      const carryRate = ATLAS_FIXTURE_CARRY_RATE_PCT_YR[key]!;
      const hedgeCarryUsdM = exposureUsdM * carryRate * (t / 12);
      legs.push({
        ccy,
        tenorMonths: t,
        exposureLocalM: localM,
        exposureUsdM,
        signedVarUsdM: localM < 0 ? -varUsdM : varUsdM,
        hedgeCarryUsdM,
      });
    }
  }
  return legs;
}

describe('fixture sanity', () => {
  it('has 240 legs covering all 20 currencies x 12 tenors', () => {
    const legs = buildFixtureLegs();
    expect(legs.length).toBe(240);
    expect(new Set(legs.map(l => l.ccy)).size).toBe(20);
  });

  it('VaR formula reproduces Atlas to within 1e-4 (back-solved z=1.645 check)', () => {
    // NZD placeholder legs (exposure=1 local, flat) — hand-verified earlier
    // against the raw sheet (Portfolio Details rows 76-77, M column) to 4
    // decimal places.
    const legs = buildFixtureLegs();
    const nzd1m = legs.find(l => l.ccy === 'NZD' && l.tenorMonths === 1)!;
    expect(Math.abs(nzd1m.signedVarUsdM)).toBeCloseTo(0.021574, 4);
    const nzd2m = legs.find(l => l.ccy === 'NZD' && l.tenorMonths === 2)!;
    expect(Math.abs(nzd2m.signedVarUsdM)).toBeCloseTo(0.032108, 4);
  });
});

describe('solveHedgeFrontierAtCap — edge cases', () => {
  const trivialCorr: FxLegCorrFn = (a, b) => (a.ccy === b.ccy && a.tenorMonths === b.tenorMonths ? 1 : 0);

  it('returns all-zero for an empty leg set', () => {
    const sol = solveHedgeFrontierAtCap([], trivialCorr, 1, Z_95);
    expect(sol.u).toEqual([]);
    expect(sol.divVarUsdM).toBe(0);
    expect(sol.carryUsdYrM).toBe(0);
  });

  it('cap=0 keeps every leg fully hedged (u=0)', () => {
    const legs = buildFixtureLegs().slice(0, 20);
    const sol = solveHedgeFrontierAtCap(legs, atlasRiskCorr, 0, Z_95);
    for (const u of sol.u) expect(u).toBeCloseTo(0, 6);
    expect(sol.divVarUsdM).toBeCloseTo(0, 6);
  });

  it('a single leg with positive carry-give-up opens fully once cap allows', () => {
    const leg: FxAtlasLeg = {
      ccy: 'EUR', tenorMonths: 1, exposureLocalM: 10, exposureUsdM: 11,
      signedVarUsdM: 0.5, hedgeCarryUsdM: -0.02, // negative: costs carry to hold hedged
    };
    const bigCap = 10;
    const sol = solveHedgeFrontierAtCap([leg], trivialCorr, bigCap, Z_95);
    expect(sol.u[0]).toBeCloseTo(1, 6);
    // Fully open: carry = (1-1)*hedgeCarryUsdM = 0, not the hedged value.
    expect(sol.carryUsdYrM).toBeCloseTo(0, 6);
  });

  it('a leg that only costs carry when OPENED stays pinned at u=0', () => {
    const leg: FxAtlasLeg = {
      ccy: 'EUR', tenorMonths: 1, exposureLocalM: 10, exposureUsdM: 11,
      signedVarUsdM: 0.5, hedgeCarryUsdM: 0.05, // positive: hedging EARNS carry, opening gives it up
    };
    const sol = solveHedgeFrontierAtCap([leg], trivialCorr, 10, Z_95);
    expect(sol.u[0]).toBeCloseTo(0, 6);
    expect(sol.carryUsdYrM).toBeCloseTo(0.05, 6);
  });

  it('two offsetting same-currency legs at different tenors: correlated risk partially cancels', () => {
    const legA: FxAtlasLeg = {
      ccy: 'EUR', tenorMonths: 1, exposureLocalM: 10, exposureUsdM: 11,
      signedVarUsdM: 0.5, hedgeCarryUsdM: -0.02,
    };
    const legB: FxAtlasLeg = {
      ccy: 'EUR', tenorMonths: 2, exposureLocalM: -10, exposureUsdM: -11,
      signedVarUsdM: -0.5, hedgeCarryUsdM: -0.02,
    };
    const sol = solveHedgeFrontierAtCap([legA, legB], atlasRiskCorr, 0.3, Z_95);
    // Both want to open (negative hedgeCarryUsdM); opposite-signed VaR
    // under positive same-ccy tenor correlation nets down, not up — so a
    // larger combined u is affordable within the same cap than either
    // leg alone would allow at cap=0.3.
    expect(sol.u[0]).toBeGreaterThan(0);
    expect(sol.u[1]).toBeGreaterThan(0);
  });

  it('cap at or above the fully-open VaR returns u=1 for legs with positive carry-give-up', () => {
    // Real EUR legs have POSITIVE hedgeCarryUsdM (hedging earns carry), so
    // mu is negative — EUR correctly never opens regardless of cap size.
    // Use synthetic legs with negative hedgeCarryUsdM (mu>0) instead, so a
    // huge cap has something worth fully opening.
    const legs: FxAtlasLeg[] = buildFixtureLegs().slice(0, 12).map(l => ({
      ...l, hedgeCarryUsdM: -Math.abs(l.hedgeCarryUsdM || 0.001),
    }));
    const hugeCap = 1e6;
    const sol = solveHedgeFrontierAtCap(legs, atlasRiskCorr, hugeCap, Z_95);
    for (const u of sol.u) expect(u).toBeCloseTo(1, 5);
  });
});

describe('golden fixture regression — Atlas Efficient Frontier sheet', () => {
  const legs = buildFixtureLegs();
  const legIndexByKey = new Map(legs.map((l, i) => [atlasLegKey(l.ccy, l.tenorMonths), i]));

  // Sanity: fixture leg ordering matches ATLAS_FIXTURE_LEG_KEYS ordering
  // (both built ccy-major, tenor-minor from the same ATLAS_FIXTURE_CCY_ORDER).
  it('leg order matches the hedge-ratio grid column order', () => {
    expect(legs.map(l => atlasLegKey(l.ccy, l.tenorMonths))).toEqual([...ATLAS_FIXTURE_LEG_KEYS]);
  });

  it.each(ATLAS_FIXTURE_FRONTIER_POINTS.map((p, i) => [i, p] as const))(
    'point %i: VaR cap-binding within tolerance',
    (i, point) => {
      if (point.varUsdM < 1e-6) return; // cap=0 checked separately above
      const sol = solveHedgeFrontierAtCap(legs, atlasRiskCorr, point.varUsdM, Z_95);
      expect(sol.divVarUsdM).toBeCloseTo(point.varUsdM, 1);
    },
  );

  it('reproduces the overall shape: approximately non-decreasing VaR and carry across independently-solved caps', () => {
    // Each cap here is solved from scratch, independent of its neighbors —
    // the release-and-retry heuristic can converge to a very slightly
    // different local optimum between two adjacent caps (observed: ~0.1%
    // dips, never more). A real efficient frontier cannot have less carry
    // at a strictly higher risk cap, but guaranteeing that from
    // independent solves alone is not free — production code
    // (fxAtlasTenorFrontier in fx-var-frontier.ts) gets exact monotonicity
    // by carrying forward each cap's fully-open legs as forced pins for
    // the next, larger cap. This test checks the raw per-cap solver stays
    // CLOSE to monotonic, not exactly so.
    const sols = ATLAS_FIXTURE_FRONTIER_POINTS.map(p =>
      solveHedgeFrontierAtCap(legs, atlasRiskCorr, p.varUsdM, Z_95));
    const tol = 0.002; // ~0.2% of typical carry magnitude here
    for (let i = 1; i < sols.length; i++) {
      expect(sols[i]!.divVarUsdM).toBeGreaterThanOrEqual(sols[i - 1]!.divVarUsdM - 1e-6);
      expect(sols[i]!.carryUsdYrM).toBeGreaterThanOrEqual(sols[i - 1]!.carryUsdYrM - tol);
    }
  });

  it('carry at full-hedge cap (point 0) matches Atlas within tolerance', () => {
    const sol = solveHedgeFrontierAtCap(legs, atlasRiskCorr, ATLAS_FIXTURE_FRONTIER_POINTS[0]!.varUsdM, Z_95);
    expect(sol.carryUsdYrM).toBeCloseTo(ATLAS_FIXTURE_FRONTIER_POINTS[0]!.carryUsdM, 1);
  });
});

describe('tenor-correlation calibration: fitted decay vs rho=1', () => {
  const legs = buildFixtureLegs();
  const decayCorr: FxLegCorrFn = atlasRiskCorr;
  const rho1Corr: FxLegCorrFn = (a, b) => atlasPairCorr(a.ccy, b.ccy, ATLAS_CORR);
  void atlasTenorCorr;

  function totalAbsError(corr: FxLegCorrFn): number {
    let err = 0;
    for (const point of ATLAS_FIXTURE_FRONTIER_POINTS) {
      if (point.varUsdM < 1e-6) continue;
      const sol = solveHedgeFrontierAtCap(legs, corr, point.varUsdM, Z_95);
      err += Math.abs(sol.carryUsdYrM - point.carryUsdM);
    }
    return err;
  }

  it('reports which tenor-correlation model better reproduces the golden curve', () => {
    const decayErr = totalAbsError(decayCorr);
    const rho1Err = totalAbsError(rho1Corr);
    // Not a hard pass/fail — this is the documented calibration decision.
    // eslint-disable-next-line no-console
    console.log(`[atlas-calibration] fitted-decay total abs carry error: ${decayErr.toFixed(4)}, rho=1 total abs carry error: ${rho1Err.toFixed(4)}`);
    expect(Number.isFinite(decayErr)).toBe(true);
    expect(Number.isFinite(rho1Err)).toBe(true);
  }, 120_000);
});

describe('hedge-ratio vector match against Atlas\'s published mix', () => {
  const legs = buildFixtureLegs();

  it('reports mean absolute error of the hedge-ratio vector at each point', () => {
    const errors: number[] = [];
    ATLAS_FIXTURE_FRONTIER_POINTS.forEach((point, i) => {
      if (point.varUsdM < 1e-6) return;
      const sol = solveHedgeFrontierAtCap(legs, atlasRiskCorr, point.varUsdM, Z_95);
      const golden = ATLAS_FIXTURE_HEDGE_RATIO_GRID[i]!;
      let sumAbs = 0;
      legs.forEach((l, idx) => {
        const h = 1 - sol.u[idx]!;
        sumAbs += Math.abs(h - golden[idx]!);
      });
      const mae = sumAbs / legs.length;
      errors.push(mae);
    });
    // eslint-disable-next-line no-console
    console.log('[atlas-calibration] per-point hedge-ratio MAE:', errors.map(e => e.toFixed(4)).join(', '));
    expect(errors.every(Number.isFinite)).toBe(true);
  });
});
