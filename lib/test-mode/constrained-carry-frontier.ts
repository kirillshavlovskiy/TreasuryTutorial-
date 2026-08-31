/**
 * Constrained Markowitz frontier for the liquidity overlay.
 *
 * Fixed-ray (today): one Σ⁻¹μ direction, scale k, clamp legs that breach
 * min balance. Mix ratios freeze after the first clamp.
 *
 * Active-set (this module): at each VAR rung, re-solve Σ⁻¹μ on the free
 * set with floored legs pinned at their min-balance overlay. When a floor
 * binds, remaining free currencies re-allocate.
 *
 * Min balance (FCY) — driven by Policy step 2 layers, no extra toggles:
 *   floorH on  → cash_floor
 *   sigmaP on  → + |payout| × σ_P × z₉₅  (Forecast accuracy chip)
 *   and, when OD is expensive vs USD, never below 0 (no-negative LP).
 */

import {
  allocateCarryVarUsd,
  type EfficientCarryLeg,
  type EfficientCarryVarFrontier,
  type OverlaySide,
} from '@/lib/portfolio-alloc';
import {
  allowsNegativeLp,
  computePortfolioVAR,
  CURRENCY_PARAMS,
  Z_NEUTRAL,
  type LayerId,
  type PortfolioCarryFrontier,
  type PortfolioCarryFrontierPoint,
  type RowState,
  type SharedGlobals,
} from '@/lib/fx-buffer';

export interface ConstrainedFrontierLeg {
  ccy: string;
  /** Hold-the-book base (M FCY). */
  baseFcyM: number;
  /** (r_FCY − r_USD) / 100. */
  mu: number;
  rOd: number;
  /** Hard cash floor (M FCY) when floorH is on. */
  cashFloorFcyM: number;
  /** |Payout| scale for σ buffer (M FCY). */
  payoutAbsFcyM: number;
}

export interface MinBalancePolicy {
  floorH: boolean;
  /**
   * Forecast-accuracy (σ_P) layer from Policy step 2.
   * When on, min balance includes the uncertainty cushion — no separate toggle.
   */
  sigmaP: boolean;
  /** Desk σ_P fraction (e.g. 0.10) from shared globals. */
  sigmaPFrac: number;
  rUsd: number;
}

export interface ConstrainedFrontierPoint {
  varUsdM: number;
  carryUsdYrM: number;
  wUsdM: number[];
  floorBoundCcys: string[];
  feasible: boolean;
}

export interface ConstrainedFrontierCompare {
  policy: MinBalancePolicy;
  varCapsUsdM: number[];
  fixedRay: ConstrainedFrontierPoint[];
  activeSet: ConstrainedFrontierPoint[];
}

/** Read Policy step 2 chips — floorH / sigmaP / σ_P / r_USD. No extra UI. */
export function minBalancePolicyFromLayers(
  activeLayers: ReadonlySet<LayerId> | null | undefined,
  shared: Pick<SharedGlobals, 'r_USD' | 'σ_P'>,
): MinBalancePolicy {
  return {
    floorH: activeLayers?.has('floorH') === true,
    sigmaP: activeLayers?.has('sigmaP') === true,
    sigmaPFrac: Number.isFinite(shared.σ_P) ? Math.max(0, shared.σ_P) : 0.1,
    rUsd: shared.r_USD,
  };
}

export function policyImposesMinBalance(policy: MinBalancePolicy): boolean {
  return policy.floorH || policy.sigmaP;
}

export function constrainedLegsFromBookRows(
  rows: readonly RowState[],
  rUsd: number,
  muByCcy?: Readonly<Record<string, number>>,
): ConstrainedFrontierLeg[] {
  return rows
    .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy])
    .map((r) => {
      const mu = muByCcy?.[r.ccy] ?? (r.r_FCY - rUsd) / 100;
      return {
        ccy: r.ccy,
        baseFcyM: Math.max(r.cash + r.payout, 0),
        mu,
        rOd: r.r_OD,
        cashFloorFcyM: Math.max(0, r.cash_floor ?? 0),
        payoutAbsFcyM: Math.abs(r.payout),
      };
    });
}

export function minBalanceFcyM(
  leg: ConstrainedFrontierLeg,
  policy: MinBalancePolicy,
): number {
  let min = 0;
  if (policy.floorH) min += Math.max(0, leg.cashFloorFcyM);
  // Policy Forecast-accuracy chip (sigmaP) IS the uncertainty buffer.
  if (policy.sigmaP) {
    min += Math.max(0, leg.payoutAbsFcyM) * Math.max(0, policy.sigmaPFrac) * Z_NEUTRAL;
  }
  if (!allowsNegativeLp(leg.rOd, policy.rUsd)) {
    min = Math.max(min, 0);
  }
  return min;
}

export function minOverlayFcyM(
  leg: ConstrainedFrontierLeg,
  policy: MinBalancePolicy,
): number {
  return minBalanceFcyM(leg, policy) - leg.baseFcyM;
}

function spotOf(ccy: string): number {
  return CURRENCY_PARAMS[ccy]?.spot ?? 1;
}

function overlayVarUsdM(ccys: readonly string[], wUsdM: readonly number[]): number {
  return computePortfolioVAR(
    ccys.map((ccy, i) => {
      const spot = spotOf(ccy);
      return { ccy, cashFCY: spot > 1e-12 ? wUsdM[i]! / spot : 0 };
    }),
  ).portfolio_VAR_USD;
}

function clampOverlayToFloor(
  legs: readonly ConstrainedFrontierLeg[],
  wUsdM: readonly number[],
  policy: MinBalancePolicy,
): { wUsdM: number[]; floorBoundCcys: string[] } {
  const out = wUsdM.slice();
  const bound: string[] = [];
  legs.forEach((leg, i) => {
    const spot = spotOf(leg.ccy);
    if (!(spot > 1e-12)) return;
    const minFcy = minOverlayFcyM(leg, policy);
    const wFcy = out[i]! / spot;
    if (wFcy + 1e-9 < minFcy) {
      out[i] = minFcy * spot;
      bound.push(leg.ccy);
    }
  });
  return { wUsdM: out, floorBoundCcys: bound };
}

function carryOf(
  legs: readonly ConstrainedFrontierLeg[],
  wUsdM: readonly number[],
  rUsd: number,
): number {
  return legs.reduce((s, leg, i) => {
    const spot = spotOf(leg.ccy);
    const fcy = spot > 1e-12 ? wUsdM[i]! / spot : 0;
    const final = leg.baseFcyM + fcy;
    const rate = final >= 0 ? leg.mu : (leg.rOd - rUsd) / 100;
    return s + wUsdM[i]! * rate;
  }, 0);
}

function solveOverlay(
  legs: readonly ConstrainedFrontierLeg[],
  policy: MinBalancePolicy,
  varCapUsdM: number,
  pinnedUsdM?: readonly number[],
  fixedCfarUsdM?: readonly number[],
) {
  return allocateCarryVarUsd({
    ccys: legs.map(l => l.ccy),
    mu: legs.map(l => l.mu),
    varCapUsdM,
    pinnedUsdM,
    basesFcy: legs.map(l => l.baseFcyM),
    rOd: legs.map(l => l.rOd),
    r_USD: policy.rUsd,
    fixedCfarUsdM,
    skipLeverageCap: true,
  });
}

export function buildFixedRayClampedFrontier(
  legs: readonly ConstrainedFrontierLeg[],
  policy: MinBalancePolicy,
  varCapsUsdM: readonly number[],
  fixedCfarUsdM?: readonly number[],
): ConstrainedFrontierPoint[] {
  const ccys = legs.map(l => l.ccy);
  const maxCap = Math.max(...varCapsUsdM.filter(v => v > 0), 1);
  const unit = solveOverlay(legs, policy, maxCap, undefined, fixedCfarUsdM);
  if (!unit || !(unit.varUsdM > 1e-9)) {
    return varCapsUsdM.map(() => ({
      varUsdM: 0,
      carryUsdYrM: 0,
      wUsdM: ccys.map(() => 0),
      floorBoundCcys: [],
      feasible: true,
    }));
  }
  const dir = unit.wUsdM.map(w => w / unit.varUsdM);
  return varCapsUsdM.map((cap) => {
    const target = Math.max(0, cap);
    let lo = 0;
    let hi = Math.max(target * 4, 1);
    let best = clampOverlayToFloor(legs, dir.map(d => d * target), policy);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const trial = clampOverlayToFloor(legs, dir.map(d => d * mid), policy);
      const v = overlayVarUsdM(ccys, trial.wUsdM);
      best = trial;
      if (v > target) hi = mid; else lo = mid;
    }
    const { wUsdM, floorBoundCcys } = best;
    return {
      varUsdM: overlayVarUsdM(ccys, wUsdM),
      carryUsdYrM: carryOf(legs, wUsdM, policy.rUsd),
      wUsdM,
      floorBoundCcys,
      feasible: true,
    };
  });
}

export function buildActiveSetCarryFrontier(
  legs: readonly ConstrainedFrontierLeg[],
  policy: MinBalancePolicy,
  varCapsUsdM: readonly number[],
  maxIters = 8,
  fixedCfarUsdM?: readonly number[],
): ConstrainedFrontierPoint[] {
  const ccys = legs.map(l => l.ccy);

  return varCapsUsdM.map((cap) => {
    const pinned = ccys.map(() => 0);
    const isPinned = ccys.map(() => false);
    let floorBoundCcys: string[] = [];
    let last = solveOverlay(legs, policy, Math.max(0, cap), undefined, fixedCfarUsdM);

    for (let iter = 0; iter < maxIters; iter++) {
      const pinnedUsdM = pinned.map((v, i) => (isPinned[i] ? v : 0));
      if (isPinned.every(Boolean)) {
        const wUsdM = pinned.slice();
        return {
          varUsdM: overlayVarUsdM(ccys, wUsdM),
          carryUsdYrM: carryOf(legs, wUsdM, policy.rUsd),
          wUsdM,
          floorBoundCcys: [...ccys],
          feasible: true,
        };
      }
      const solved = solveOverlay(legs, policy, Math.max(0, cap), pinnedUsdM, fixedCfarUsdM);
      if (!solved) {
        return {
          varUsdM: cap,
          carryUsdYrM: 0,
          wUsdM: pinned.slice(),
          floorBoundCcys,
          feasible: false,
        };
      }
      last = solved;
      isPinned.forEach((p, i) => {
        if (p) solved.wUsdM[i] = pinned[i]!;
      });

      let newlyBound = false;
      const boundNow: string[] = [];
      legs.forEach((leg, i) => {
        if (isPinned[i]) {
          boundNow.push(leg.ccy);
          return;
        }
        const spot = spotOf(leg.ccy);
        if (!(spot > 1e-12)) return;
        const minFcy = minOverlayFcyM(leg, policy);
        const wFcy = solved.wUsdM[i]! / spot;
        if (wFcy + 1e-9 < minFcy) {
          pinned[i] = minFcy * spot;
          isPinned[i] = true;
          newlyBound = true;
          boundNow.push(leg.ccy);
        }
      });
      floorBoundCcys = boundNow;
      if (!newlyBound) break;
    }

    const wUsdM = last?.wUsdM ?? pinned.slice();
    return {
      varUsdM: last?.varUsdM ?? overlayVarUsdM(ccys, wUsdM),
      carryUsdYrM: carryOf(legs, wUsdM, policy.rUsd),
      wUsdM,
      floorBoundCcys,
      feasible: last != null,
    };
  });
}

export function compareConstrainedFrontiers(
  legs: readonly ConstrainedFrontierLeg[],
  policy: MinBalancePolicy,
  varCapsUsdM: readonly number[],
): ConstrainedFrontierCompare {
  return {
    policy,
    varCapsUsdM: [...varCapsUsdM],
    fixedRay: buildFixedRayClampedFrontier(legs, policy, varCapsUsdM),
    activeSet: buildActiveSetCarryFrontier(legs, policy, varCapsUsdM),
  };
}

export function buildPolicyConstrainedPortfolioFrontier(input: {
  legs: readonly ConstrainedFrontierLeg[];
  policy: MinBalancePolicy;
  policyVarUsdM: number;
  unhedgedCfarUsdM?: number;
  steps?: number;
  fixedCfarUsdM?: readonly number[];
}): PortfolioCarryFrontier {
  const policyCap = Math.max(0.5, input.policyVarUsdM);
  const steps = input.steps ?? 24;
  const caps: number[] = [];
  for (let i = 0; i <= steps; i++) caps.push((policyCap * i) / steps);
  caps.push(policyCap * 1.25, policyCap * 1.5, policyCap * 2);

  const active = buildActiveSetCarryFrontier(
    input.legs, input.policy, caps, 8, input.fixedCfarUsdM,
  );
  const originVar = Math.max(0, input.unhedgedCfarUsdM ?? 0);
  const points: PortfolioCarryFrontierPoint[] = [];

  if (originVar > 1e-9) {
    points.push({
      k: 0,
      portfolioVarUsd: originVar,
      totalCarryUsdYr: 0,
      floorBoundCcys: [],
    });
  }

  active.forEach((p, i) => {
    const cap = caps[i]!;
    if (cap < 1e-12 && originVar > 1e-9) return;
    const portfolioVarUsd = originVar > 1e-9
      ? Math.sqrt(originVar * originVar + p.varUsdM * p.varUsdM)
      : p.varUsdM;
    points.push({
      k: policyCap > 1e-12 ? cap / policyCap : 0,
      portfolioVarUsd,
      totalCarryUsdYr: p.carryUsdYrM,
      floorBoundCcys: p.floorBoundCcys,
    });
  });

  points.sort((a, b) => a.portfolioVarUsd - b.portfolioVarUsd);

  let sweetSpotIndex = -1;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    if (p.floorBoundCcys.length > 0 && p.totalCarryUsdYr >= prev.totalCarryUsdYr - 1e-9) {
      sweetSpotIndex = i;
      break;
    }
  }

  const clampPt = points.find(p => p.floorBoundCcys.length > 0);
  return {
    points,
    farPoints: [],
    sweetSpotIndex,
    nearestClampCcy: clampPt?.floorBoundCcys[0] ?? null,
    nearestClampVarUsd: clampPt?.portfolioVarUsd ?? null,
    walk: 'overlay',
  };
}

function legSide(usdM: number): OverlaySide {
  if (usdM > 1e-9) return 'long';
  if (usdM < -1e-9) return 'short';
  return 'flat';
}

function legsFromW(
  legs: readonly ConstrainedFrontierLeg[],
  wUsdM: readonly number[],
  rUsd: number,
): EfficientCarryLeg[] {
  const ccys = legs.map(l => l.ccy);
  const varRes = computePortfolioVAR(
    ccys.map((ccy, i) => {
      const spot = spotOf(ccy);
      return { ccy, cashFCY: spot > 1e-12 ? wUsdM[i]! / spot : 0 };
    }),
  );

  return legs.map((leg, i) => {
    const spot = spotOf(leg.ccy);
    const usdM = wUsdM[i]!;
    const fcyM = spot > 1e-12 ? usdM / spot : 0;
    const final = leg.baseFcyM + fcyM;
    const rate = final >= 0 ? leg.mu : (leg.rOd - rUsd) / 100;
    const comp = varRes.currencies.find(c => c.ccy === leg.ccy);
    return {
      ccy: leg.ccy,
      mu: leg.mu,
      usdM,
      fcyM,
      side: legSide(usdM),
      carryUsdYrM: usdM * rate,
      componentVarUsdM: comp?.component_VAR_USD ?? 0,
    };
  });
}

export function buildPolicyConstrainedEfficientFrontier(input: {
  legs: readonly ConstrainedFrontierLeg[];
  policy: MinBalancePolicy;
  varCapUsdM: number;
  carryTargetUsdYrM?: number;
  fixedCfarUsdM?: readonly number[];
}): EfficientCarryVarFrontier | null {
  const { legs, policy } = input;
  if (legs.length < 1) return null;
  const cap = Math.max(0, input.varCapUsdM);
  const caps = [0, cap * 0.25, cap * 0.5, cap * 0.75, cap];
  const active = buildActiveSetCarryFrontier(legs, policy, caps, 8, input.fixedCfarUsdM);
  const sweetPt = active[active.length - 1];
  if (!sweetPt) return null;

  let sweet = sweetPt;
  if (
    input.carryTargetUsdYrM != null
    && Number.isFinite(input.carryTargetUsdYrM)
    && input.carryTargetUsdYrM > 0
    && sweetPt.carryUsdYrM > input.carryTargetUsdYrM + 1e-9
  ) {
    for (const p of active) {
      if (p.carryUsdYrM >= input.carryTargetUsdYrM - 1e-9) {
        sweet = p;
        break;
      }
    }
  }

  const ray = active.map((p, i) => ({
    t: caps[i]! / Math.max(cap, 1e-12),
    carryUsdYrM: p.carryUsdYrM,
    varUsdM: p.varUsdM,
  }));

  return {
    ray,
    varCapUsdM: cap,
    sweet: {
      t: cap > 1e-12 ? sweet.varUsdM / cap : 0,
      carryUsdYrM: sweet.carryUsdYrM,
      varUsdM: sweet.varUsdM,
      varBinding: sweet.varUsdM >= cap - 1e-6 && cap > 1e-9,
      carryBinding: input.carryTargetUsdYrM != null
        && sweet.carryUsdYrM >= (input.carryTargetUsdYrM - 1e-9),
      capBreachedAtZeroOverlay: false,
    },
    cap: {
      t: 1,
      carryUsdYrM: sweetPt.carryUsdYrM,
      varUsdM: sweetPt.varUsdM,
    },
    legs: legsFromW(legs, sweet.wUsdM, policy.rUsd),
    capLegs: legsFromW(legs, sweetPt.wUsdM, policy.rUsd),
    carryTargetUsdYrM: input.carryTargetUsdYrM,
  };
}

export function demoConstrainedFrontierLegs(rUsd = 3.5): ConstrainedFrontierLeg[] {
  const mk = (
    ccy: string,
    baseFcyM: number,
    cashFloorFcyM: number,
    payoutAbsFcyM: number,
  ): ConstrainedFrontierLeg => {
    const p = CURRENCY_PARAMS[ccy]!;
    return {
      ccy,
      baseFcyM,
      mu: (p.carry - rUsd) / 100,
      rOd: p.r_OD,
      cashFloorFcyM,
      payoutAbsFcyM,
    };
  };
  return [
    mk('EUR', 12, 2.0, 8),
    mk('GBP', 6, 1.0, 4),
    mk('PLN', 40, 5.0, 25),
    mk('MXN', 80, 8.0, 50),
  ];
}
