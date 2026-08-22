import { describe, expect, it } from 'vitest';
import type { EfficientCarryLeg } from '@/lib/portfolio-alloc';
import { INITIAL_ROWS, type LayerId, type PortfolioCarryFrontier, type RowState, type SharedGlobals } from '@/lib/fx-buffer';
import { DEFAULT_FORECAST_PROFILE, type ForecastProfileState } from '@/lib/forecast-profile';
import { DEFAULT_LIQUIDITY_TIMING, type LiquidityTiming } from '@/lib/liquidity-ladder';
import { DEFAULT_VAR_SETUP } from '@/lib/test-mode/var-setup';
import type { LiquidityFrontierInput } from '@/lib/test-mode/liquidity-frontier';
import {
  evaluateLiquidityStrategies,
  type LiquidityStrategyInput,
} from '@/lib/test-mode/liquidity-strategies';
import {
  buildPortfolioLiquidityFrontier,
  toPortfolioCarryFrontier,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import {
  carryTargetOnArm,
  DEFAULT_DESK_TARGET_CARRY_USD_YR,
  orderedLiquidityScenarioPoints,
} from '@/lib/test-mode/portfolio-modal-align';
import {
  buildSolutionPick,
  liftFrontierToTotalCarry,
  normalizeSelectionPoint,
  overlayTAlongPath,
  overlayTForPoint,
  overlayCarryUsdYrM,
  persistScenarioId,
  pointForScenario,
  policyVarForSelection,
  remapSelectionToFrontier,
  selectionPointsEqual,
} from '@/lib/test-mode/solution-pick';
import type { PortfolioCarryFrontierPoint } from '@/lib/fx-buffer';

function pt(k: number, x: number, y: number) {
  return { k, portfolioVarUsd: x, totalCarryUsdYr: y, floorBoundCcys: [] as string[] };
}

function frontier(points: ReturnType<typeof pt>[]): PortfolioCarryFrontier {
  return {
    points,
    farPoints: [],
    sweetSpotIndex: -1,
    nearestClampCcy: null,
    nearestClampVarUsd: null,
    walk: 'book-scale',
  };
}

const capLegs: EfficientCarryLeg[] = [
  {
    ccy: 'EUR', mu: 0.02, usdM: 8, fcyM: 7, side: 'long',
    carryUsdYrM: 0.040, componentVarUsdM: 1.2,
  },
  {
    ccy: 'GBP', mu: 0.01, usdM: 4, fcyM: 3, side: 'long',
    carryUsdYrM: 0.020, componentVarUsdM: 0.6,
  },
];

describe('overlayTAlongPath', () => {
  it('is 0 at the origin and 1 at Max Policy Risk', () => {
    expect(overlayTAlongPath(0.5, 0.5, 20)).toBe(0);
    expect(overlayTAlongPath(20, 0.5, 20)).toBe(1);
    expect(overlayTAlongPath(10.25, 0.5, 20)).toBeCloseTo(0.5, 8);
  });
});

describe('liftFrontierToTotalCarry', () => {
  const raw = frontier([
    pt(0, 0.50, 0),
    pt(0.5, 5.0, 0.016),
    pt(1, 10.0, 0.114),
    pt(1.5, 20.0, 0.200),
  ]);

  it('is identity when overlay is off', () => {
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs: null, policyCapUsd: 20,
    });
    expect(lifted.points.map(p => p.totalCarryUsdYr)).toEqual(
      raw.points.map(p => p.totalCarryUsdYr),
    );
  });

  it('adds overlay carry so every sample Y is Total Carry', () => {
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    expect(lifted.points[0]!.totalCarryUsdYr).toBe(0);
    expect(lifted.points[0]!.portfolioVarUsd).toBe(raw.points[0]!.portfolioVarUsd);
    const mid = lifted.points[1]!;
    const tMid = overlayTAlongPath(5.0, 0.50, 20);
    expect(mid.totalCarryUsdYr).toBeCloseTo(
      0.016 + overlayCarryUsdYrM(capLegs, tMid), 8,
    );
    const cap = lifted.points[3]!;
    expect(cap.totalCarryUsdYr).toBeCloseTo(0.200 + 0.060, 8);
  });

  it('keeps a named marker on the lifted polyline', () => {
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const hit = carryTargetOnArm(lifted.points, DEFAULT_DESK_TARGET_CARRY_USD_YR);
    expect(hit).not.toBeNull();
    expect(hit!.totalCarryUsdYr).toBeCloseTo(DEFAULT_DESK_TARGET_CARRY_USD_YR, 8);
    const onPoly = lifted.points.some(p => (
      Math.abs(p.k - hit!.k) < 1e-9 && Math.abs(p.portfolioVarUsd - hit!.portfolioVarUsd) < 1e-9
    )) || (
      hit!.k > lifted.points[0]!.k - 1e-9
      && hit!.k < lifted.points[lifted.points.length - 1]!.k + 1e-9
    );
    expect(onPoly).toBe(true);
  });

  it('Carry Target is $32k Total, not program-only and not overlay+program $64k', () => {
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const programOnly = carryTargetOnArm(raw.points, DEFAULT_DESK_TARGET_CARRY_USD_YR);
    const total = carryTargetOnArm(lifted.points, DEFAULT_DESK_TARGET_CARRY_USD_YR);
    expect(total).not.toBeNull();
    expect(total!.totalCarryUsdYr).toBeCloseTo(0.032, 8);
    expect(total!.totalCarryUsdYr).not.toBeCloseTo(0.064, 2);
    if (programOnly) {
      expect(total!.k).not.toBeCloseTo(programOnly.k, 4);
    }
    const t = overlayTAlongPath(total!.portfolioVarUsd, 0.50, 20);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
  });
});

describe('pointForScenario', () => {
  it('places Max Policy Risk at the policy cap on a lifted arm', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(1, 10.0, 0.10),
      pt(2, 20.0, 0.20),
    ]);
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const hit = pointForScenario({
      frontier: lifted,
      scenarioId: 'maxCarry',
      policyCapUsd: 20,
      confidencePct: 95,
    });
    expect(hit).not.toBeNull();
    expect(hit!.portfolioVarUsd).toBeCloseTo(20, 6);
    expect(hit!.totalCarryUsdYr).toBeGreaterThan(0.20);
  });

  it('Carry Target above the arm clamps to max Total Carry, not null', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(1, 10.0, 0.10),
      pt(2, 20.0, 0.20),
    ]);
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const hi = lifted.points.reduce((best, p) => (
      p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
    ));
    const hit = pointForScenario({
      frontier: lifted,
      scenarioId: 'carryTarget',
      policyCapUsd: 20,
      carryTargetUsdYr: hi.totalCarryUsdYr + 5,
      confidencePct: 95,
    });
    expect(hit).not.toBeNull();
    expect(hit!.totalCarryUsdYr).toBeCloseTo(hi.totalCarryUsdYr, 8);
  });

  it('a new Earn ask moves Carry Target off the previous Total Carry', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(1, 10.0, 0.10),
      pt(2, 20.0, 0.20),
    ]);
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const a = pointForScenario({
      frontier: lifted,
      scenarioId: 'carryTarget',
      policyCapUsd: 20,
      carryTargetUsdYr: 0.032,
      confidencePct: 95,
    });
    const b = pointForScenario({
      frontier: lifted,
      scenarioId: 'carryTarget',
      policyCapUsd: 20,
      carryTargetUsdYr: 0.080,
      confidencePct: 95,
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.totalCarryUsdYr).toBeCloseTo(0.032, 6);
    expect(b!.totalCarryUsdYr).toBeCloseTo(0.080, 6);
    expect(b!.portfolioVarUsd).not.toBeCloseTo(a!.portfolioVarUsd, 4);
  });
});

describe('overlayTForPoint', () => {
  const f = frontier([pt(0, 0.5, 0), pt(1, 10, 0.1), pt(2, 20, 0.2)]);

  it('Unhedged is t=0; Max Policy Risk is t=1', () => {
    expect(overlayTForPoint({
      point: f.points[0]!, frontier: f, policyCapUsd: 20, scenarioId: 'unhedged',
    })).toBe(0);
    expect(overlayTForPoint({
      point: f.points[2]!, frontier: f, policyCapUsd: 20, scenarioId: 'maxCarry',
    })).toBe(1);
  });
});

describe('buildSolutionPick', () => {
  const eur = INITIAL_ROWS.find(r => r.ccy === 'EUR')!;
  const gbp = INITIAL_ROWS.find(r => r.ccy === 'GBP')!;
  const shared: SharedGlobals = { r_USD: 4.5, σ_P: 0.1, days: 3, forecastMonths: 6 };
  const rows: RowState[] = [
    { ...eur, id: 'e', cash: 20, payout: -40, collections: 20, fcastFX: 0, cash_floor: 2 },
    { ...gbp, id: 'g', cash: 20, payout: -40, collections: 20, fcastFX: 0, cash_floor: 2 },
  ];
  const forecastProfile: ForecastProfileState = {
    ...DEFAULT_FORECAST_PROFILE,
    liquidity: { ...DEFAULT_LIQUIDITY_TIMING, enabled: true },
  };
  const engine: Omit<LiquidityFrontierInput, 'row' | 'strategy' | 'bookStanding' | 'carryUsdK'> = {
    months: 6,
    shared,
    activeLayers: new Set<LayerId>(['floorH', 'carryOptim']),
    forecastProfile,
    setup: { ...DEFAULT_VAR_SETUP, forecastMonths: 6, confidencePct: 95 },
    cfarNetByCcyUsd: { EUR: 0.36, GBP: 0.22 },
  };
  const stratInput: LiquidityStrategyInput = {
    rows,
    months: 6,
    shared,
    activeLayers: engine.activeLayers,
    forecastProfile: engine.forecastProfile,
    setup: engine.setup,
    cfarNetByCcyUsd: engine.cfarNetByCcyUsd,
  };

  it('Unhedged pick is t=0, k=0, Y=0; Max Policy Risk is t=1 and X ≤ cap', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const raw = toPortfolioCarryFrontier(buildPortfolioLiquidityFrontier({
      result: rolling, strategy: rolling.strategy, rows, engine,
    }));
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const ordered = orderedLiquidityScenarioPoints({
      points: lifted.points,
      conservative: lifted.points.find(p => Math.abs(p.k - 1) < 1e-6) ?? null,
      policyCapUsd: 20,
      originCfarUsd: lifted.points[0]!.portfolioVarUsd,
    });
    const unhedged = buildSolutionPick({
      regimeId: rolling.strategy.id,
      scenarioId: 'unhedged',
      point: ordered.origin!,
      frontier: lifted,
      policyCapUsd: 20,
      result: rolling,
      rows,
      engine,
      capLegs,
    });
    expect(unhedged.overlayT).toBe(0);
    expect(unhedged.k).toBe(0);
    expect(unhedged.point.totalCarryUsdYr).toBe(0);
    expect(unhedged.overlayLegs).toEqual([]);
    expect(
      Object.values(unhedged.totalCarryByCcy).reduce((s, v) => s + v, 0),
    ).toBeCloseTo(0, 8);

    const maxCarry = buildSolutionPick({
      regimeId: rolling.strategy.id,
      scenarioId: 'maxCarry',
      point: ordered.maxCarry!,
      frontier: lifted,
      policyCapUsd: 20,
      result: rolling,
      rows,
      engine,
      capLegs,
    });
    expect(maxCarry.overlayT).toBe(1);
    expect(maxCarry.point.portfolioVarUsd).toBeLessThanOrEqual(20 + 1e-6);
    expect(maxCarry).not.toHaveProperty('programCarryByCcy');
    expect(maxCarry).not.toHaveProperty('overlayCarryByCcy');
  });

  it('Carry Target pick Y is $32k Total; Σ per-CCY is that total', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const raw = toPortfolioCarryFrontier(buildPortfolioLiquidityFrontier({
      result: rolling, strategy: rolling.strategy, rows, engine,
    }));
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const ordered = orderedLiquidityScenarioPoints({
      points: lifted.points,
      conservative: lifted.points.find(p => Math.abs(p.k - 1) < 1e-6) ?? null,
      policyCapUsd: 20,
      originCfarUsd: lifted.points[0]!.portfolioVarUsd,
      carryTargetUsdYr: DEFAULT_DESK_TARGET_CARRY_USD_YR,
    });
    expect(ordered.carryTarget).not.toBeNull();
    expect(ordered.carryTarget!.totalCarryUsdYr).toBeCloseTo(0.032, 8);
    const pick = buildSolutionPick({
      regimeId: rolling.strategy.id,
      scenarioId: 'carryTarget',
      point: ordered.carryTarget!,
      frontier: lifted,
      policyCapUsd: 20,
      result: rolling,
      rows,
      engine,
      capLegs,
    });
    expect(pick.point.totalCarryUsdYr).toBeCloseTo(0.032, 8);
    expect(pick.point.totalCarryUsdYr).not.toBeCloseTo(0.064, 2);
    const pricedSum = Object.values(pick.totalCarryByCcy).reduce((s, v) => s + v, 0);
    expect(pricedSum).toBeCloseTo(pick.point.totalCarryUsdYr, 2);
  });

  it('custom Selection lockstep: solutionPick X/Y equal the committed point', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const raw = toPortfolioCarryFrontier(buildPortfolioLiquidityFrontier({
      result: rolling, strategy: rolling.strategy, rows, engine,
    }));
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const sample = lifted.points[Math.min(3, lifted.points.length - 1)]!;
    const point = normalizeSelectionPoint('custom', sample, 0.5);
    const pick = buildSolutionPick({
      regimeId: rolling.strategy.id,
      scenarioId: 'custom',
      point,
      frontier: lifted,
      policyCapUsd: 20,
      result: rolling,
      rows,
      engine,
      capLegs,
    });
    expect(pick.scenarioId).toBe('custom');
    expect(pick.point.portfolioVarUsd).toBeCloseTo(point.portfolioVarUsd, 8);
    expect(pick.point.totalCarryUsdYr).toBeCloseTo(point.totalCarryUsdYr, 8);
  });
});

describe('PortfolioSelection helpers', () => {
  const p = (k: number, x: number, y: number): PortfolioCarryFrontierPoint => ({
    k, portfolioVarUsd: x, totalCarryUsdYr: y, floorBoundCcys: [],
  });

  it('normalizeSelectionPoint pins Unhedged to origin Y=0', () => {
    const out = normalizeSelectionPoint('unhedged', p(1, 9, 0.4), 0.74);
    expect(out.k).toBe(0);
    expect(out.portfolioVarUsd).toBeCloseTo(0.74, 8);
    expect(out.totalCarryUsdYr).toBe(0);
  });

  it('policyVarForSelection: Unhedged leaves dial; Max Carry uses tier; else rounds X', () => {
    expect(policyVarForSelection({
      kind: 'unhedged', point: p(0, 0.74, 0), policyVAR: 5, approvalTierUsd: 5,
    })).toBeNull();
    expect(policyVarForSelection({
      kind: 'maxCarry', point: p(2, 18, 0.2), policyVAR: 5, approvalTierUsd: 20,
    })).toBe(20);
    expect(policyVarForSelection({
      kind: 'balanced', point: p(1.2, 7.479, 0.11), policyVAR: 5, approvalTierUsd: 10,
    })).toBe(7.5);
  });

  it('persistScenarioId drops custom', () => {
    expect(persistScenarioId('balanced')).toBe('balanced');
    expect(persistScenarioId('custom')).toBeNull();
  });

  it('remapSelectionToFrontier re-prices named picks when the arm changes', () => {
    const before = frontier([pt(0, 1, 0), pt(1, 8, 0.10), pt(2, 20, 0.22)]);
    const after = frontier([pt(0, 0.5, 0), pt(1, 4, 0.05), pt(2, 10, 0.12)]);
    const sel = {
      kind: 'maxCarry' as const,
      point: pointForScenario({
        frontier: before,
        scenarioId: 'maxCarry',
        policyCapUsd: 20,
        confidencePct: 95,
      })!,
    };
    expect(sel.point.portfolioVarUsd).toBeGreaterThan(10);
    const remapped = remapSelectionToFrontier({
      selection: sel,
      frontier: after,
      policyCapUsd: 10,
      confidencePct: 95,
      unhedgedOriginUsdM: 0.5,
    });
    expect(remapped).not.toBeNull();
    expect(remapped!.kind).toBe('maxCarry');
    expect(remapped!.point.portfolioVarUsd).toBeLessThanOrEqual(10 + 1e-6);
    expect(selectionPointsEqual(remapped!.point, sel.point)).toBe(false);
  });

  it('pointForScenario custom snaps to nearest k after a universe rebuild', () => {
    const next = frontier([pt(0, 0.5, 0), pt(0.8, 3, 0.04), pt(1.6, 7, 0.09)]);
    const hit = pointForScenario({
      frontier: next,
      scenarioId: 'custom',
      policyCapUsd: 20,
      confidencePct: 95,
      customPoint: pt(0.75, 99, 0.99), // old coordinates, k≈0.8
    });
    expect(hit).not.toBeNull();
    expect(hit!.k).toBeCloseTo(0.8, 8);
    expect(hit!.portfolioVarUsd).toBeCloseTo(3, 8);
  });
});
