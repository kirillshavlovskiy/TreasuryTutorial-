import { describe, it, expect } from 'vitest';
import { INITIAL_ROWS, POLICY_VAR_LIMITS, type LayerId } from '@/lib/fx-buffer';
import {
  buildLimitedUniverseFrontier,
  generateUsableParetoScenarios,
  maxExpectedReturnFrontierPoint,
  overlaySampleVars,
  portfolioScenarioDefs,
  strategyExpectedReturnUsdM,
  type PricedOverlaySample,
} from '@/lib/test-mode/portfolio-carry-scenarios';

const SHARED = { r_USD: 3.50, σ_P: 0.10, days: 3, forecastMonths: 12 };
const LAYERS = new Set<LayerId>(['floorH', 'sigmaP', 'cfarCover']);

describe('limited-universe carry/VAR scenarios', () => {
  const frontier = buildLimitedUniverseFrontier({
    rows: INITIAL_ROWS,
    shared: SHARED,
    activeLayers: new Set(LAYERS),
  });

  it('sweeps a real overlay curve, not a liquidity-walk tail', () => {
    expect(frontier).not.toBeNull();
    expect(frontier!.points.length).toBeGreaterThan(8);
    const vars = frontier!.points.map(p => p.portfolioVarUsd);
    expect(Math.max(...vars)).toBeLessThan(80);
  });

  it('pins Conservative / Max Carry to the $5M and $20M rungs', () => {
    const defs = portfolioScenarioDefs(frontier, 95);
    const minTier = POLICY_VAR_LIMITS[0]!.usd;
    const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
    const conservative = defs.find(s => s.id === 'conservative')?.point;
    const maxCarry = defs.find(s => s.id === 'maxCarry')?.point;
    expect(conservative).toBeTruthy();
    expect(maxCarry).toBeTruthy();
    expect(Math.abs(conservative!.portfolioVarUsd - minTier)).toBeLessThan(1.5);
    expect(Math.abs(maxCarry!.portfolioVarUsd - maxTier)).toBeLessThan(1.5);
    expect(maxCarry!.portfolioVarUsd).toBeLessThan(40);
  });

  it('never lets Max Carry win a $611M CFaR walk', () => {
    const defs = portfolioScenarioDefs(frontier, 95);
    const maxCarry = defs.find(s => s.id === 'maxCarry')?.point;
    expect(maxCarry!.portfolioVarUsd).toBeLessThan(25);
  });

  it('places Balanced on the knee when one exists, else the $10M Director rung', () => {
    const defs = portfolioScenarioDefs(frontier, 95);
    const balanced = defs.find(s => s.id === 'balanced')!;
    expect(balanced.point).toBeTruthy();
    if (frontier!.sweetSpotIndex >= 0) {
      expect(balanced.point).toBe(frontier!.points[frontier!.sweetSpotIndex]);
    } else {
      expect(Math.abs(balanced.point!.portfolioVarUsd - 10)).toBeLessThan(1.5);
    }
  });
});

describe('generateUsableParetoScenarios', () => {
  const s = (
    varUsdM: number,
    carry: number,
    mix = '',
  ): PricedOverlaySample => ({
    overlayVarUsdM: varUsdM,
    bookCarryUsdYrM: carry,
    mix,
  });

  it('Max Carry is the richest book inside $20M, not the $20M scale if carry already turned over', () => {
    const picks = generateUsableParetoScenarios({
      samples: [
        s(5, 0.40, 'MXN 40%'),
        s(8, 0.70, 'MXN 38%'),
        s(12, 0.92, 'MXN 30%'),
        s(20, 0.55, 'MXN 22%'),
        s(611, 2.4, 'tail'),
      ],
      budgetUsdM: 7,
      confidencePct: 95,
    });
    const maxCarry = picks.find(p => p.id === 'maxCarry')!;
    expect(maxCarry.disabled).toBe(false);
    expect(maxCarry.overlayVarUsdM).toBe(12);
    expect(maxCarry.bookCarryUsdYrM).toBe(0.92);
  });

  it('drops a $611M walk from the universe', () => {
    const picks = generateUsableParetoScenarios({
      samples: [s(5, 0.4), s(20, 0.8), s(611, 4)],
      budgetUsdM: 7,
      confidencePct: 95,
    });
    expect(picks.every(p => p.overlayVarUsdM < 25 || p.disabled)).toBe(true);
  });

  it('Conservative is max carry inside $5M, Balanced is max carry inside the Policy budget', () => {
    const picks = generateUsableParetoScenarios({
      samples: [s(3, 0.22), s(5, 0.40), s(7, 0.58), s(20, 0.80)],
      budgetUsdM: 7,
      confidencePct: 95,
    });
    expect(picks.find(p => p.id === 'conservative')!.overlayVarUsdM).toBe(5);
    expect(picks.find(p => p.id === 'balanced')!.overlayVarUsdM).toBe(7);
    expect(picks.find(p => p.id === 'maxCarry')!.overlayVarUsdM).toBe(20);
  });

  it('hits a typed carry ask at the lowest VAR that clears it', () => {
    const picks = generateUsableParetoScenarios({
      samples: [s(5, 0.30), s(8, 0.55), s(12, 0.70), s(20, 0.80)],
      budgetUsdM: 10,
      carryTargetUsdYrM: 0.54,
      confidencePct: 95,
    });
    const hit = picks.find(p => p.id === 'balanced')!;
    expect(hit.label).toBe('Hit carry target');
    expect(hit.overlayVarUsdM).toBe(8);
  });

  it('when Policy is $20, Balanced is an interior book — not a clone of Max Carry', () => {
    const picks = generateUsableParetoScenarios({
      samples: [s(5, 0.40, 'MXN 40%'), s(10, 0.80, 'MXN 40%'), s(15, 1.20, 'MXN 40%'), s(20, 1.60, 'MXN 40%')],
      budgetUsdM: 20,
      confidencePct: 95,
    });
    const conservative = picks.find(p => p.id === 'conservative')!;
    const balanced = picks.find(p => p.id === 'balanced')!;
    const maxCarry = picks.find(p => p.id === 'maxCarry')!;
    expect(conservative.overlayVarUsdM).toBe(5);
    expect(maxCarry.overlayVarUsdM).toBe(20);
    expect(balanced.disabled).toBe(false);
    expect(balanced.overlayVarUsdM).toBe(10);
    expect(Math.abs(balanced.overlayVarUsdM - conservative.overlayVarUsdM)).toBeGreaterThan(1.4);
    expect(Math.abs(balanced.overlayVarUsdM - maxCarry.overlayVarUsdM)).toBeGreaterThan(1.4);
  });

  it('Max E[Return] maximizes determined carry − E[loss] on standing above the unhedged floor', () => {
    // Floor $4M residual. Hedgeable standing = √(CFaR² − 4²).
    // At 95% (tail 5%): E[R] = carry − 0.05 × standing.
    const pts = [
      { k: 0, portfolioVarUsd: 4, totalCarryUsdYr: 0, floorBoundCcys: [] as string[] },
      { k: 1, portfolioVarUsd: 5, totalCarryUsdYr: 0.25, floorBoundCcys: [] },
      { k: 2, portfolioVarUsd: 8, totalCarryUsdYr: 0.50, floorBoundCcys: [] },
      { k: 3, portfolioVarUsd: 12, totalCarryUsdYr: 0.55, floorBoundCcys: [] },
      { k: 4, portfolioVarUsd: 20, totalCarryUsdYr: 0.60, floorBoundCcys: [] },
    ];
    // k=0: 0
    // k=1: 0.25 − 0.05×3 = 0.10
    // k=2: 0.50 − 0.05×√48 ≈ 0.154  ← max
    // k=3: 0.55 − 0.05×√128 ≈ −0.016
    // k=4: 0.60 − 0.05×√384 ≈ −0.38
    const pick = maxExpectedReturnFrontierPoint(pts, 95, 4);
    expect(pick).not.toBeNull();
    expect(pick!.k).toBe(2);
    expect(strategyExpectedReturnUsdM(pts[2]!, 95, 4)).toBeGreaterThan(
      strategyExpectedReturnUsdM(pts[1]!, 95, 4),
    );
    expect(strategyExpectedReturnUsdM(pts[2]!, 95, 4)).toBeGreaterThan(
      strategyExpectedReturnUsdM(pts[3]!, 95, 4),
    );
  });

  it('Max E[Return] falls back inside Policy VAR when the sweep-edge still wins', () => {
    // Carry keeps beating E[loss] through the last point → unconstrained
    // winner is the sweep edge. With a $12M policy cap, pick best ≤ $12M.
    const pts = [
      { k: 0, portfolioVarUsd: 4, totalCarryUsdYr: 0, floorBoundCcys: [] as string[] },
      { k: 1, portfolioVarUsd: 8, totalCarryUsdYr: 0.50, floorBoundCcys: [] },
      { k: 2, portfolioVarUsd: 12, totalCarryUsdYr: 1.00, floorBoundCcys: [] },
      { k: 3, portfolioVarUsd: 20, totalCarryUsdYr: 2.00, floorBoundCcys: [] },
    ];
    expect(maxExpectedReturnFrontierPoint(pts, 95, 4)).toBeNull();
    const pick = maxExpectedReturnFrontierPoint(pts, 95, 4, 12);
    expect(pick).not.toBeNull();
    expect(pick!.k).toBe(2);
    expect(pick!.portfolioVarUsd).toBe(12);
  });
});
