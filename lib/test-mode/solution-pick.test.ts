import { describe, expect, it } from 'vitest';
import { scaleOverlayLegs, type EfficientCarryLeg } from '@/lib/portfolio-alloc';
import { CURRENCY_PARAMS, fundingSwapCashDeltaUsdYr, INITIAL_ROWS, type LayerId, type PortfolioCarryFrontier, type RowState, type SharedGlobals } from '@/lib/fx-buffer';
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
  chartPathTrace,
  DEFAULT_DESK_TARGET_CARRY_USD_YR,
  orderedLiquidityScenarioPoints,
} from '@/lib/test-mode/portfolio-modal-align';
import {
  acceptedDeskCfarByCcy,
  buildSolutionPick,
  stripDisplayedCarryUsdM,
  overlayRayFrontier,
  liftFrontierToTotalCarry,
  rebaseLiveBookArmToHoldY,
  stampFrontierPointY,
  normalizeSelectionPoint,
  optimizerOverlayFromLegs,
  overlayTAlongPath,
  overlayTForPoint,
  overlayTToHitCarry,
  overlayCarryUsdYrM,
  overlayPortfolioVarUsdM,
  persistScenarioId,
  resolveAskFillLiftT,
  splitTicketCfarByCcy,
  swapParkedOverlayRampEndX,
  swapParkedOverlayScale,
  ticketCfarUsdM,
  pointForScenario,
  relHedgeFarPoint,
  policyVarForSelection,
  remapSelectionToFrontier,
  resolveFrontierScenarioId,
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

describe('optimizerOverlayFromLegs', () => {
  it('keeps mix FCY / carry / Euler VAR and drops dust', () => {
    expect(optimizerOverlayFromLegs(capLegs).EUR).toEqual({
      forwardLocalM: 7,
      usdM: 8,
      carryUsdYrM: 0.040,
      componentVarUsdM: 1.2,
    });
    expect(optimizerOverlayFromLegs([
      { ...capLegs[0]!, fcyM: 0, usdM: 0, carryUsdYrM: 0, componentVarUsdM: 0 },
    ])).toEqual({});
  });
});

describe('stripDisplayedCarryUsdM', () => {
  it('is swap cash + CIP + overlay μ — not a levered plot Y', () => {
    expect(stripDisplayedCarryUsdM({
      swapInterestUsdYrM: 0.040,
      swapPointsUsdYrM: 0.021,
      overlayCarryUsdYrM: 0.067,
    })).toBeCloseTo(0.128, 8);
  });

  it('−2.5M EUR short is tens of $K/yr, not ~$1M', () => {
    const eur = CURRENCY_PARAMS.EUR!;
    const usdM = fundingSwapCashDeltaUsdYr(-2.5, eur.spot, eur.carry, 4.5, eur.r_OD);
    expect(Math.abs(usdM)).toBeLessThan(0.15);
    expect(usdM).toBeGreaterThan(0);
  });
});

describe('acceptedDeskCfarByCcy', () => {
  it('adds overlay Euler VAR to funding-regime CFaR', () => {
    expect(acceptedDeskCfarByCcy({
      cfarByCcy: { EUR: 0.54, GBP: 1.09 },
      overlayLegs: capLegs,
    })).toEqual({ EUR: 1.74, GBP: 1.69 });
  });
});

describe('ticketCfarUsdM', () => {
  it('is book Port CFaR when overlay is empty', () => {
    expect(ticketCfarUsdM(1.626, [])).toBeCloseTo(1.626, 8);
    expect(ticketCfarUsdM(1.626, null)).toBeCloseTo(1.626, 8);
  });

  it('is √(book² + overlay²) — not Book+Euler and not Target Carry', () => {
    expect(ticketCfarUsdM(1.626, capLegs)).toBeCloseTo(Math.hypot(1.626, 1.8), 8);
    expect(overlayPortfolioVarUsdM(capLegs)).toBeCloseTo(1.8, 8);
  });

  it('splits ticket CFaR so per-CCY Total sums to the portfolio number', () => {
    const split = splitTicketCfarByCcy(
      [
        { ccy: 'EUR', bookCfarUsdM: 1.0, overlayCfarUsdM: 1.2 },
        { ccy: 'GBP', bookCfarUsdM: 0.6, overlayCfarUsdM: 0.6 },
      ],
      1.626,
      1.8,
    );
    const ticket = Math.hypot(1.626, 1.8);
    expect(split.EUR! + split.GBP!).toBeCloseTo(ticket, 8);
    expect(split.EUR).toBeGreaterThan(split.GBP!);
  });
});

describe('overlayTAlongPath', () => {
  it('is 0 at the origin and 1 at Max Policy Risk', () => {
    expect(overlayTAlongPath(0.5, 0.5, 20)).toBe(0);
    expect(overlayTAlongPath(20, 0.5, 20)).toBe(1);
    expect(overlayTAlongPath(10.25, 0.5, 20)).toBeCloseTo(0.5, 8);
  });
});

describe('overlayTToHitCarry', () => {
  it('is 0 when the target is 0 or the ray cannot help', () => {
    expect(overlayTToHitCarry({ capLegs, targetUsdYrM: 0 })).toBe(0);
    expect(overlayTToHitCarry({ capLegs: [], targetUsdYrM: 0.04 })).toBe(0);
    expect(overlayTToHitCarry({ capLegs, targetUsdYrM: -0.04 })).toBe(0);
  });

  it('hits a feasible target inside the 3× mix and past t = 1', () => {
    expect(overlayTToHitCarry({ capLegs, targetUsdYrM: 0.030 })).toBeCloseTo(0.5, 6);
    expect(overlayTToHitCarry({ capLegs, targetUsdYrM: 0.180 })).toBeCloseTo(3, 6);
    expect(overlayCarryUsdYrM(capLegs, 3)).toBeCloseTo(0.180, 8);
  });
});

describe('resolveAskFillLiftT', () => {
  const points = [
    pt(0, 0.5, 0),
    pt(1, 10, 0.10),
    pt(2, 20, 0.20),
  ];

  it('leaves Both on the t(X) walk', () => {
    expect(resolveAskFillLiftT({
      askFillMode: 'both',
      capLegs,
      universePoints: points,
      policyCapUsd: 20,
      carryTargetUsdYr: 0.16,
    })).toBeUndefined();
  });

  it('runs Swap with no overlay leg (t = 0 — funding book only)', () => {
    const t = resolveAskFillLiftT({
      askFillMode: 'swap',
      capLegs,
      universePoints: points,
      policyCapUsd: 20,
      carryTargetUsdYr: 0.16,
    });
    expect(t).toBe(0);
  });

  it('sizes Overlay t on overlay μ only — not Ask minus book', () => {
    const t = resolveAskFillLiftT({
      askFillMode: 'overlay',
      capLegs,
      universePoints: points,
      policyCapUsd: 20,
      carryTargetUsdYr: 0.030,
    });
    expect(t).toBeCloseTo(0.5, 6);
    expect(overlayCarryUsdYrM(capLegs, t!)).toBeCloseTo(0.030, 6);
  });

  it('sizes Overlay t past the 3× mix to hit Ask', () => {
    const t = resolveAskFillLiftT({
      askFillMode: 'overlay',
      capLegs,
      universePoints: points,
      policyCapUsd: 20,
      carryTargetUsdYr: 0.40,
    });
    expect(t).toBeCloseTo(0.40 / 0.060, 6);
    expect(overlayCarryUsdYrM(capLegs, t!)).toBeCloseTo(0.40, 6);
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

  it('does not add overlay carry onto the far CIP arm', () => {
    const withFar = {
      ...raw,
      farPoints: [pt(0, 0.50, 0), pt(1, 9.5, -0.040), pt(1.5, 18.0, -0.080)],
    };
    const lifted = liftFrontierToTotalCarry({
      frontier: withFar, capLegs, policyCapUsd: 20,
    });
    expect(lifted.farPoints.map(p => p.totalCarryUsdYr)).toEqual(
      withFar.farPoints.map(p => p.totalCarryUsdYr),
    );
    expect(Math.max(...lifted.farPoints.map(p => p.totalCarryUsdYr))).toBeLessThanOrEqual(0);
  });

  it('can lift every sample by a constant overlay t, including t > 1', () => {
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20, overlayT: 2,
    });
    expect(lifted.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(lifted.points[2]!.totalCarryUsdYr).toBeCloseTo(0.114 + 0.120, 8);
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

  it('does not invent k×holdY — Swap walk stays Book(k)+Overlay(1) off origin', () => {
    const book = frontier([
      pt(0, 1.085, 0),
      pt(0.01, 1.085, 0.001),
      pt(0.5, 1.35, 0.055),
      pt(1, 1.626, 0.110),
      pt(4, 5.20, 0.80),
    ]);
    const lifted = liftFrontierToTotalCarry({
      frontier: book, capLegs, policyCapUsd: 20, overlayT: 1,
    });
    const parkedOverlayY = overlayCarryUsdYrM(capLegs, 1);
    expect(lifted.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(lifted.points[1]!.totalCarryUsdYr).toBeCloseTo(0.001, 8);
    const hold = lifted.points.find(p => Math.abs(p.k - 1) < 1e-6)!;
    const mid = lifted.points.find(p => Math.abs(p.k - 0.5) < 1e-6)!;
    expect(mid.totalCarryUsdYr).toBeCloseTo(0.055 + parkedOverlayY, 8);
    expect(Math.abs(mid.totalCarryUsdYr - 0.5 * hold.totalCarryUsdYr))
      .toBeGreaterThan(0.01);
    expect(hold.totalCarryUsdYr).toBeCloseTo(0.110 + parkedOverlayY, 8);
    expect(lifted.points.every(p => p.k >= -1e-12)).toBe(true);
  });

  it('swap parked overlay: raw k=0 is $0 and drawn arm has no origin cliff', () => {
    const book = frontier([
      pt(0, 1.085, 0),
      pt(0.01, 1.085, 0.0005),
      pt(0.02, 1.085, 0.001),
      pt(0.03, 1.086, 0.0015),
      pt(0.06, 1.088, 0.004),
      pt(0.10, 1.092, 0.008),
      pt(0.14, 1.100, 0.014),
      pt(0.17, 1.104, 0.019),
      pt(1, 1.626, 0.110),
      pt(4, 5.20, 0.80),
    ]);
    const lifted = liftFrontierToTotalCarry({
      frontier: book, capLegs, policyCapUsd: 20, overlayT: 1,
    });
    const parkedOverlayY = overlayCarryUsdYrM(capLegs, 1);
    expect(lifted.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(lifted.points[1]!.totalCarryUsdYr).toBeLessThan(0.01);
    const plot = chartPathTrace(lifted.points, 1.085, true);
    expect(plot.rawHead[0]!.y).toBeCloseTo(0, 8);
    expect(plot.drawn[0]).toEqual({ x: 1.085, y: 0 });
    expect(plot.drawn[1]!.y).toBeLessThan(0.05);
    for (let i = 1; i < plot.drawn.length; i += 1) {
      const dx = Math.abs(plot.drawn[i]!.x - plot.drawn[i - 1]!.x);
      const dy = Math.abs(plot.drawn[i]!.y - plot.drawn[i - 1]!.y);
      if (dx < 0.05 - 1e-9) expect(dy).toBeLessThan(0.05);
    }
    const bal = lifted.points.find(p => Math.abs(p.k - 0.17) < 1e-6)!;
    expect(bal.totalCarryUsdYr).toBeCloseTo(
      0.019 + parkedOverlayY, 8,
    );
  });

  it('swap cliff: first off-column X ramps overlay instead of snapping Overlay(1)', () => {
    const parkedOverlayY = overlayCarryUsdYrM(capLegs, 1);
    const book = frontier([
      pt(0, 1.085, 0),
      pt(0.01, 1.085, 0.0006),
      pt(0.01, 1.085, 0.0011),
      pt(0.02, 1.085, 0.0022),
      pt(0.03, 1.086, 0.0031),
      pt(0.04, 1.086, 0.0033),
      pt(0.05, 1.087, 0.0035),
      pt(0.17, 1.104, 0.019),
      pt(1, 1.626, 0.110),
    ]);
    const lifted = liftFrontierToTotalCarry({
      frontier: book, capLegs, policyCapUsd: 20, overlayT: 1,
    });
    const firstOff = lifted.points.find(p => Math.abs(p.k - 0.05) < 1e-6)!;
    expect(firstOff.totalCarryUsdYr).toBeLessThan(0.0035 + parkedOverlayY * 0.15);
    expect(firstOff.totalCarryUsdYr).toBeGreaterThan(0.0035);
    const plot = chartPathTrace(lifted.points, 1.085, true);
    const offIdx = plot.drawn.findIndex(p => p.x > 1.085 + 1e-3);
    expect(offIdx).toBeGreaterThan(0);
    const dy = Math.abs(plot.drawn[offIdx]!.y - plot.drawn[offIdx - 1]!.y);
    expect(dy).toBeLessThan(0.05);
    expect(dy).toBeLessThan(parkedOverlayY * 0.25);
  });

  it('swapParkedOverlayRampEndX never returns origin when hold X is past the column', () => {
    const book = frontier([
      pt(0, 1.085, 0),
      pt(0.01, 1.085, 0.0006),
      pt(0.03, 1.086, 0.0031),
      pt(0.04, 1.086, 0.0033),
      pt(0.17, 1.104, 0.019),
      pt(1, 1.626, 0.110),
    ]);
    const rampEnd = swapParkedOverlayRampEndX(book.points, 1.085, 20);
    expect(rampEnd).toBeGreaterThan(1.085 + 1e-3);
    expect(rampEnd).toBeLessThanOrEqual(1.626);
  });

  it('swapParkedOverlayScale never snaps to full overlay on first off-column sample', () => {
    const parkedOverlayY = overlayCarryUsdYrM(capLegs, 1);
    const book = frontier([
      pt(0, 1.085, 0),
      pt(0.01, 1.085, 0.0006),
      pt(0.04, 1.086, 0.0033),
      pt(0.17, 1.104, 0.019),
      pt(1, 1.626, 0.110),
    ]);
    const rampEnd = swapParkedOverlayRampEndX(book.points, 1.085, 20);
    const lifted = liftFrontierToTotalCarry({
      frontier: book, capLegs, policyCapUsd: 20, overlayT: 1,
    });
    const off = lifted.points.find(p => Math.abs(p.k - 0.04) < 1e-6)!;
    expect(off.totalCarryUsdYr).toBeLessThan(0.0033 + parkedOverlayY * 0.08);
    expect(swapParkedOverlayScale(off, 1.085, rampEnd, 1)).toBeLessThan(0.08);
  });
});

describe('rebaseLiveBookArmToHoldY', () => {
  it('sets k≤1 Y to k × table Total and leaves k>1 alone', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(0.5, 5.0, 0.016),
      pt(1, 10.0, 0.114),
      pt(1.5, 20.0, 0.200),
    ]);
    const holdY = 0.0073;
    const out = rebaseLiveBookArmToHoldY(raw, holdY);
    expect(out.points[0]!.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(out.points[1]!.totalCarryUsdYr).toBeCloseTo(0.5 * holdY, 8);
    expect(out.points[2]!.totalCarryUsdYr).toBeCloseTo(holdY, 8);
    expect(out.points[3]!.totalCarryUsdYr).toBeCloseTo(0.200, 8);
    expect(out.points[2]!.portfolioVarUsd).toBe(10.0);
  });

  it('does not rebase the far CIP arm onto k × holdY', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(1, 10.0, 0.114),
    ]);
    raw.farPoints = [pt(0, 0.50, 0), pt(1, 9.5, -0.040)];
    const out = rebaseLiveBookArmToHoldY(raw, 0.50);
    expect(out.farPoints[1]!.totalCarryUsdYr).toBeCloseTo(-0.040, 8);
  });

  it('Rel hedge is the far CIP twin at hold scale (k=1), overlay t=0', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(0.5, 5.0, 0.10),
      pt(1, 8.0, 0.20),
      pt(1.2, 12.0, 0.22),
    ]);
    raw.farPoints = [
      pt(0, 0.50, 0),
      pt(0.5, 5.0, -0.02),
      pt(1, 8.0, -0.05),
      pt(1.2, 12.0, -0.08),
    ];
    const rel = pointForScenario({
      frontier: raw,
      scenarioId: 'relHedge',
      policyCapUsd: 20,
      confidencePct: 95,
    });
    expect(rel).not.toBeNull();
    expect(rel!.k).toBeCloseTo(1, 6);
    expect(rel!.totalCarryUsdYr).toBeCloseTo(-0.05, 8);
    expect(relHedgeFarPoint(raw)).toMatchObject({ k: 1, totalCarryUsdYr: -0.05 });
    expect(overlayTForPoint({
      point: rel!, frontier: raw, policyCapUsd: 20, scenarioId: 'relHedge',
    })).toBe(0);
  });
});

describe('stampFrontierPointY', () => {
  it('writes Y onto the closest k sample', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(1, 10.0, 0.114),
      pt(6.3, 20.0, 0.950),
    ]);
    const out = stampFrontierPointY(raw, 6.267, 0.2084);
    expect(out.points[2]!.totalCarryUsdYr).toBeCloseTo(0.2084, 8);
    expect(out.points[1]!.totalCarryUsdYr).toBeCloseTo(0.114, 8);
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

  it('Fill Ask = Overlay charts the Σ⁻¹μ ray — overlay μ vs overlay VAR', () => {
    const ray = overlayRayFrontier({
      ray: [
        { t: 0, carryUsdYrM: 0, varUsdM: 0.766 },
        { t: 0.5, carryUsdYrM: 0.193, varUsdM: 0.994 },
        { t: 1, carryUsdYrM: 0.386, varUsdM: 1.223 },
      ],
      varCapUsdM: 10,
      sweet: {
        t: 1, carryUsdYrM: 0.386, varUsdM: 1.223,
        varBinding: false, carryBinding: false, capBreachedAtZeroOverlay: false,
      },
      cap: { t: 1, carryUsdYrM: 0.386, varUsdM: 1.223 },
      legs: capLegs,
      capLegs,
    });
    expect(ray.walk).toBe('overlay');
    expect(ray.farPoints).toEqual([]);
    expect(ray.points.length).toBeGreaterThan(8);
    const origin = ray.points[0]!;
    expect(origin.k).toBeCloseTo(0, 8);
    expect(origin.totalCarryUsdYr).toBeCloseTo(0, 8);
    expect(origin.portfolioVarUsd).toBeCloseTo(0.766, 8);
    const cap = ray.points.find(p => Math.abs(p.k - 1) < 1e-6)!;
    expect(cap.totalCarryUsdYr).toBeCloseTo(0.386, 8);
    expect(cap.portfolioVarUsd).toBeCloseTo(1.223, 8);
    const hit = pointForScenario({
      frontier: ray,
      scenarioId: 'carryTarget',
      policyCapUsd: 10,
      carryTargetUsdYr: 1.599,
      confidencePct: 95,
      askFillMode: 'overlay',
    });
    expect(hit).not.toBeNull();
    expect(hit!.k).toBeCloseTo(1, 8);
    expect(hit!.totalCarryUsdYr).toBeCloseTo(0.386, 8);
    expect(hit!.totalCarryUsdYr).toBeLessThan(1.599);
    expect(hit!.portfolioVarUsd).toBeCloseTo(1.223, 5);
    const onAsk = pointForScenario({
      frontier: ray,
      scenarioId: 'carryTarget',
      policyCapUsd: 10,
      carryTargetUsdYr: 0.193,
      confidencePct: 95,
      askFillMode: 'overlay',
    });
    expect(onAsk!.totalCarryUsdYr).toBeCloseTo(0.193, 5);
    expect(onAsk!.k).toBeCloseTo(0.5, 5);
    const past = overlayRayFrontier({
      ray: [
        { t: 0, carryUsdYrM: 0, varUsdM: 0.766 },
        { t: 1, carryUsdYrM: 0.215, varUsdM: 0.925 },
      ],
      varCapUsdM: 5.6,
      sweet: {
        t: 1, carryUsdYrM: 0.215, varUsdM: 0.925,
        varBinding: false, carryBinding: false, capBreachedAtZeroOverlay: false,
      },
      cap: { t: 1, carryUsdYrM: 0.215, varUsdM: 0.925 },
      legs: capLegs,
      capLegs,
    }, { maxT: 1.599 / 0.215 });
    const askHit = pointForScenario({
      frontier: past,
      scenarioId: 'carryTarget',
      policyCapUsd: 20,
      carryTargetUsdYr: 1.599,
      confidencePct: 95,
      askFillMode: 'overlay',
    });
    expect(askHit!.totalCarryUsdYr).toBeCloseTo(1.599, 2);
    expect(askHit!.k).toBeGreaterThan(1);
  });

  it('overlay walk Carry Target can sit past t = 1', () => {
    const arm: PortfolioCarryFrontier = {
      ...frontier([
        pt(0, 1.0, 0),
        pt(0.5, 2.0, 0.20),
        pt(1, 3.592, 0.388),
        pt(1.2, 4.249, 0.466),
      ]),
      walk: 'overlay',
    };
    const onTail = pointForScenario({
      frontier: arm,
      scenarioId: 'carryTarget',
      policyCapUsd: 10,
      carryTargetUsdYr: 0.466,
      confidencePct: 95,
      askFillMode: 'overlay',
    });
    expect(onTail).not.toBeNull();
    expect(onTail!.k).toBeCloseTo(1.2, 8);
    expect(onTail!.totalCarryUsdYr).toBeCloseTo(0.466, 8);
    expect(overlayTForPoint({
      point: onTail!,
      frontier: arm,
      policyCapUsd: 10,
      scenarioId: 'carryTarget',
    })).toBeCloseTo(1.2, 8);
    const pastArm = pointForScenario({
      frontier: arm,
      scenarioId: 'carryTarget',
      policyCapUsd: 10,
      carryTargetUsdYr: 1.599,
      confidencePct: 95,
      askFillMode: 'overlay',
    });
    expect(pastArm!.k).toBeCloseTo(1.2, 8);
    expect(pastArm!.totalCarryUsdYr).toBeCloseTo(0.466, 8);
  });

  it('Carry Target is the curve intersection at the ask Y', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(1, 10.0, 0.10),
      pt(2, 20.0, 0.20),
    ]);
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const hold = lifted.points.find(p => Math.abs(p.k - 1) < 1e-6)!;
    const ask = hold.totalCarryUsdYr + 0.05;
    const hit = pointForScenario({
      frontier: lifted,
      scenarioId: 'carryTarget',
      policyCapUsd: 20,
      carryTargetUsdYr: ask,
      confidencePct: 95,
    });
    expect(hit).not.toBeNull();
    expect(hit!.totalCarryUsdYr).toBeCloseTo(ask, 8);
    expect(hit!.k).toBeGreaterThan(1);
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

describe('carry / CFaR optimization — kinked overlay and named picks', () => {
  const eur = {
    carry: 1.78,
    r_OD: 2.21,
    spot: 1.1701,
  };
  const rUsd = 2.0;
  const kinkCap: EfficientCarryLeg = (() => {
    const mu = (eur.carry - rUsd) / 100;
    const capFcy = -4.15;
    const capUsd = capFcy * eur.spot;
    return {
      ccy: 'EUR',
      mu,
      usdM: capUsd,
      fcyM: capFcy,
      side: 'short' as const,
      carryUsdYrM: capUsd * (eur.r_OD - rUsd) / 100,
      componentVarUsdM: 5.5,
      baseFcyM: 2.54,
      rOdPct: eur.r_OD,
      rUsdPct: rUsd,
    };
  })();

  function programFlat(xs: number[]) {
    return frontier(xs.map((x, i) => pt(i / Math.max(1, xs.length - 1), x, 0)));
  }

  it('overlay carry is not linear in t once the PAY short crosses zero', () => {
    const tCredit = 0.45;
    const linear = kinkCap.carryUsdYrM * tCredit;
    const priced = overlayCarryUsdYrM([kinkCap], tCredit);
    expect(priced).not.toBeCloseTo(linear, 3);
    expect(priced).toBeGreaterThan(linear);
    expect(overlayCarryUsdYrM([kinkCap], 1)).toBeCloseTo(kinkCap.carryUsdYrM, 8);
  });

  it('lifted Total Carry can peak before Max Policy Risk when overlay walks into overdraft', () => {
    const xs = [0.5, 3, 5.5, 8, 10, 12, 14, 16.7, 20];
    const lifted = liftFrontierToTotalCarry({
      frontier: programFlat(xs),
      capLegs: [kinkCap],
      policyCapUsd: 20,
    });
    const peak = lifted.points.reduce((best, p) => (
      p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
    ));
    const tip = lifted.points[lifted.points.length - 1]!;
    expect(peak.portfolioVarUsd).toBeLessThan(tip.portfolioVarUsd - 0.5);
    expect(peak.totalCarryUsdYr).toBeGreaterThan(tip.totalCarryUsdYr);
  });

  it('Carry Target above the peak sits on the peak (less overlay), not the policy-cap tip', () => {
    const xs = [0.5, 3, 5.5, 8, 10, 12, 14, 16.7, 20];
    const lifted = liftFrontierToTotalCarry({
      frontier: programFlat(xs),
      capLegs: [kinkCap],
      policyCapUsd: 20,
    });
    const peak = lifted.points.reduce((best, p) => (
      p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
    ));
    const hit = pointForScenario({
      frontier: lifted,
      scenarioId: 'carryTarget',
      policyCapUsd: 20,
      carryTargetUsdYr: peak.totalCarryUsdYr + 1,
      confidencePct: 95,
    });
    expect(hit).not.toBeNull();
    expect(hit!.totalCarryUsdYr).toBeCloseTo(peak.totalCarryUsdYr, 8);
    expect(hit!.portfolioVarUsd).toBeCloseTo(peak.portfolioVarUsd, 6);
    expect(overlayTAlongPath(hit!.portfolioVarUsd, 0.5, 20)).toBeLessThan(1);
  });

  it('a feasible Carry Target on the rising arm has smaller CFaR than one closer to the peak', () => {
    const xs = [0.5, 3, 5.5, 8, 10, 12, 14, 16.7, 20];
    const lifted = liftFrontierToTotalCarry({
      frontier: programFlat(xs),
      capLegs: [kinkCap],
      policyCapUsd: 20,
    });
    const peak = lifted.points.reduce((best, p) => (
      p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
    ));
    const lo = peak.totalCarryUsdYr * 0.35;
    const hi = peak.totalCarryUsdYr * 0.8;
    expect(lo).toBeGreaterThan(1e-6);
    expect(hi).toBeLessThan(peak.totalCarryUsdYr - 1e-9);
    const a = pointForScenario({
      frontier: lifted, scenarioId: 'carryTarget', policyCapUsd: 20,
      carryTargetUsdYr: lo, confidencePct: 95,
    })!;
    const b = pointForScenario({
      frontier: lifted, scenarioId: 'carryTarget', policyCapUsd: 20,
      carryTargetUsdYr: hi, confidencePct: 95,
    })!;
    expect(a.totalCarryUsdYr).toBeCloseTo(lo, 5);
    expect(b.totalCarryUsdYr).toBeCloseTo(hi, 5);
    expect(b.portfolioVarUsd).toBeGreaterThan(a.portfolioVarUsd);
    expect(b.portfolioVarUsd).toBeLessThanOrEqual(peak.portfolioVarUsd + 1e-6);
  });

  it('named picks stay ordered on CFaR: Unhedged ≤ Carry Target ≤ Max Policy Risk', () => {
    const raw = frontier([
      pt(0, 0.50, 0),
      pt(0.5, 5.5, 0.05),
      pt(1, 10, 0.10),
      pt(1.5, 16.7, 0.16),
      pt(2, 20, 0.20),
    ]);
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const unhedged = pointForScenario({
      frontier: lifted, scenarioId: 'unhedged', policyCapUsd: 20, confidencePct: 95,
    })!;
    const target = pointForScenario({
      frontier: lifted, scenarioId: 'carryTarget', policyCapUsd: 20,
      carryTargetUsdYr: 0.08, confidencePct: 95,
    })!;
    const maxCarry = pointForScenario({
      frontier: lifted, scenarioId: 'maxCarry', policyCapUsd: 20, confidencePct: 95,
    })!;
    expect(unhedged.portfolioVarUsd).toBeLessThanOrEqual(target.portfolioVarUsd + 1e-9);
    expect(target.portfolioVarUsd).toBeLessThanOrEqual(maxCarry.portfolioVarUsd + 1e-9);
    expect(maxCarry.portfolioVarUsd).toBeLessThanOrEqual(20 + 1e-6);
    expect(unhedged.totalCarryUsdYr).toBe(0);
  });

  it('Max Policy Risk t=1; Unhedged t=0 on the same lifted arm', () => {
    const raw = frontier([pt(0, 5.5, 0), pt(1, 10, 0.1), pt(2, 16.7, 0.2)]);
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs: [kinkCap], policyCapUsd: 16.7,
    });
    expect(overlayTForPoint({
      point: lifted.points[0]!, frontier: lifted, policyCapUsd: 16.7, scenarioId: 'unhedged',
    })).toBe(0);
    expect(overlayTForPoint({
      point: lifted.points[2]!, frontier: lifted, policyCapUsd: 16.7, scenarioId: 'maxCarry',
    })).toBe(1);
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

  it('Carry Target $999k stays on the live book (k ≤ 1); Σ = chart Y, not a leveraged ask', () => {
    const results = evaluateLiquidityStrategies(stratInput);
    const rolling = results.find(r => r.strategy.id === 'rollingProgramme')!;
    const raw = toPortfolioCarryFrontier(buildPortfolioLiquidityFrontier({
      result: rolling, strategy: rolling.strategy, rows, engine,
    }));
    const lifted = liftFrontierToTotalCarry({
      frontier: raw, capLegs, policyCapUsd: 20,
    });
    const ask = 0.999;
    const point = pointForScenario({
      frontier: lifted,
      scenarioId: 'carryTarget',
      policyCapUsd: 20,
      carryTargetUsdYr: ask,
      confidencePct: 95,
    });
    expect(point).not.toBeNull();
    expect(point!.k).toBeLessThanOrEqual(1 + 1e-6);
    const peak = lifted.points
      .filter(p => p.k <= 1 + 1e-6)
      .reduce((best, p) => (
        p.totalCarryUsdYr >= best.totalCarryUsdYr ? p : best
      ));
    const expectY = ask <= peak.totalCarryUsdYr + 1e-12 ? ask : peak.totalCarryUsdYr;
    expect(point!.totalCarryUsdYr).toBeCloseTo(expectY, 6);
    const pick = buildSolutionPick({
      regimeId: rolling.strategy.id,
      scenarioId: 'carryTarget',
      point: point!,
      frontier: lifted,
      policyCapUsd: 20,
      result: rolling,
      rows,
      engine,
      capLegs,
    });
    const pricedSum = Object.values(pick.totalCarryByCcy).reduce((s, v) => s + v, 0);
    expect(pricedSum).toBeCloseTo(pick.point.totalCarryUsdYr, 2);
    expect(pick.k).toBeGreaterThan(0);
    expect(pick.k).toBeLessThanOrEqual(1 + 1e-6);
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
    expect(policyVarForSelection({
      kind: 'carryTarget', point: p(1, 13.8, 1.599), policyVAR: 5, approvalTierUsd: 20,
      askFillMode: 'overlay',
    })).toBeNull();
  });

  it('persistScenarioId drops custom', () => {
    expect(persistScenarioId('balanced')).toBe('balanced');
    expect(persistScenarioId('custom')).toBeNull();
  });

  it('resolveFrontierScenarioId defaults to Carry Target', () => {
    expect(resolveFrontierScenarioId(null)).toBe('carryTarget');
    expect(resolveFrontierScenarioId(undefined)).toBe('carryTarget');
    expect(resolveFrontierScenarioId('balanced')).toBe('balanced');
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
