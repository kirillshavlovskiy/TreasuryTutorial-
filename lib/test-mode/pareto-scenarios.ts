/**
 * Named Pareto picks on the carry × risk plane — the mockup's three Solutions.
 *
 * Axes (desk, not the mockup's fake bps):
 *   carry = Cash + swap cash + CIP  ($M/yr, additive)
 *   risk  = diversified CFaR / component VAR  ($M)
 *
 * A point is Pareto iff nothing else in the sample has both more carry and
 * no more risk. Same skyline as `efficientFrontier` / `ccyEfficientFrontier`:
 * walk carry descending and keep a point only when it strictly improves risk.
 *
 * The three cards are selection rules on that skyline, not new books:
 *
 *   maxCarry      — nearest the top approval rung ($20M), same as the zip pack
 *                   subtitle lists the live receive names (r_FCY > r_USD)
 *   balanced      — richest carry that still clears the VAR budget
 *   conservative  — nearest the bottom approval rung ($5M)
 *
 * Extra cards are appended only when they land on a different (carry, risk)
 * point so the list does not repeat the same book:
 *
 *   director      — richest point that still clears the $5M Director cap
 *   maxEfficiency — best carry $K per $M of risk on the front
 *   asBooked      — the regime's live strip, when it is not already a pick
 *   kktSparse     — shadow-priced cover, when it actually moves the book
 *
 * Used % = risk / budget. Efficiency = carry $K / risk $M (same ratio the
 * mockup printed as 3250 bps / $7.8M = 417). Hardcoded 3,250 / $7.8M are
 * illustration only — the live book prints its own numbers.
 */

import type { PortfolioFrontierPoint, PortfolioLiquidityFrontier } from '@/lib/test-mode/portfolio-liquidity-frontier';

export type ParetoScenarioId =
  | 'maxCarry'
  | 'balanced'
  | 'conservative'
  | 'director'
  | 'maxEfficiency'
  | 'asBooked'
  | 'kktSparse';

export interface ParetoCandidate {
  carryUsdYrM: number;
  riskUsdM: number;
  scale?: number;
  cover?: number;
  arm?: PortfolioFrontierPoint['arm'] | 'book' | 'origin';
}

export interface ParetoScenario {
  id: ParetoScenarioId;
  name: string;
  short: string;
  rationale: string;
  carryUsdYrM: number;
  riskUsdM: number;
  usedPct: number;
  efficiency: number;
  approved: boolean;
  point: ParetoCandidate;
}

export const DIRECTOR_VAR_USD_M = 5;
/** Zip limited-universe top rung — Max Carry is the nearest point to this, not the leverage tail. */
export const UNIVERSE_MAX_VAR_USD_M = 20;
/** Open-arm scale at the Policy VAR fill; anything above is a chart tail, not a named scenario. */
const SCENARIO_MAX_SCALE = 1.2;

/**
 * Non-dominated skyline: richer carry must come with more risk.
 * Returned in ascending carry (left = conservative, right = max carry).
 */
export function paretoSkyline(
  points: readonly ParetoCandidate[],
): ParetoCandidate[] {
  const byCarryDesc = [...points]
    .filter(p => Number.isFinite(p.carryUsdYrM) && Number.isFinite(p.riskUsdM))
    .sort((a, b) => b.carryUsdYrM - a.carryUsdYrM || a.riskUsdM - b.riskUsdM);
  const keep: ParetoCandidate[] = [];
  let bestRisk = Number.POSITIVE_INFINITY;
  for (const p of byCarryDesc) {
    if (p.riskUsdM < bestRisk - 1e-9) {
      keep.push(p);
      bestRisk = p.riskUsdM;
    }
  }
  return keep.reverse();
}

function inScenarioWindow(p: ParetoCandidate): boolean {
  if (p.arm === 'far' || p.arm === 'mix') return false;
  if (p.scale != null && p.scale > SCENARIO_MAX_SCALE + 1e-6) return false;
  return true;
}

/** Candidates from the portfolio left-end frontier plus the live book. */
export function candidatesFromFrontier(
  frontier: PortfolioLiquidityFrontier | null,
): ParetoCandidate[] {
  if (!frontier) return [];
  const pts: ParetoCandidate[] = [
    { ...toCand(frontier.origin), arm: 'origin' },
    ...frontier.open.map(p => toCand(p)),
    {
      carryUsdYrM: frontier.book.carryUsdYrM,
      riskUsdM: frontier.book.portCfarUsdM,
      scale: 1,
      cover: 0,
      arm: 'book',
    },
  ];
  if (frontier.autoSweet) pts.push(toCand(frontier.autoSweet));
  return pts.filter(inScenarioWindow);
}

/**
 * Σ⁻¹μ ray used by the zip pack: VAR is Policy overlay VAR ($M), not
 * the liquidity-walk CFaR which can run to hundreds of millions past the cap.
 */
export function candidatesFromMvFrontier(
  mv: {
    ray: readonly { t: number; carryUsdYrM: number; varUsdM: number }[];
    sweet: { t: number; carryUsdYrM: number; varUsdM: number };
    cap: { carryUsdYrM: number; varUsdM: number };
  } | null,
): ParetoCandidate[] {
  if (!mv) return [];
  const pts: ParetoCandidate[] = mv.ray.map(p => ({
    carryUsdYrM: p.carryUsdYrM,
    riskUsdM: p.varUsdM,
    scale: p.t,
    arm: 'open' as const,
  }));
  pts.push({
    carryUsdYrM: mv.sweet.carryUsdYrM,
    riskUsdM: mv.sweet.varUsdM,
    scale: mv.sweet.t,
    arm: 'open',
  });
  pts.push({
    carryUsdYrM: mv.cap.carryUsdYrM,
    riskUsdM: mv.cap.varUsdM,
    scale: 1,
    arm: 'open',
  });
  return pts.filter(p => Number.isFinite(p.carryUsdYrM) && Number.isFinite(p.riskUsdM));
}

function toCand(p: PortfolioFrontierPoint): ParetoCandidate {
  return {
    carryUsdYrM: p.carryUsdYrM,
    riskUsdM: p.cfarUsdM,
    scale: p.scale,
    cover: p.cover,
    arm: p.arm,
  };
}

function usedPct(riskUsdM: number, budgetUsdM: number): number {
  if (!(budgetUsdM > 1e-9)) return 0;
  return (riskUsdM / budgetUsdM) * 100;
}

/** Carry $K per $M of risk — mockup "Eff." integer. */
export function efficiencyRatio(carryUsdYrM: number, riskUsdM: number): number {
  if (!(riskUsdM > 1e-9)) return 0;
  return (carryUsdYrM * 1000) / riskUsdM;
}

function closestToBudget(
  skyline: readonly ParetoCandidate[],
  budgetUsdM: number,
): ParetoCandidate {
  return skyline.reduce((best, p) =>
    Math.abs(p.riskUsdM - budgetUsdM) < Math.abs(best.riskUsdM - budgetUsdM) ? p : best,
  );
}

function samePoint(a: ParetoCandidate, b: ParetoCandidate): boolean {
  return (
    Math.abs(a.carryUsdYrM - b.carryUsdYrM) < 1e-6
    && Math.abs(a.riskUsdM - b.riskUsdM) < 1e-6
  );
}

function alreadyPicked(
  point: ParetoCandidate,
  cards: readonly ParetoScenario[],
): boolean {
  return cards.some(c => samePoint(c.point, point));
}

/**
 * Named picks on the skyline. `receiveNames` are the live high-rate
 * receive CCYs (r_FCY > r_USD), used only in the max-carry label.
 *
 * Always returns the mockup trio. Extra cards append only when they are a
 * different book so "3 shown" stays 3 on a degenerate front.
 */
export function pickParetoScenarios(input: {
  points: readonly ParetoCandidate[];
  budgetUsdM: number;
  directorUsdM?: number;
  universeMaxUsdM?: number;
  receiveNames?: readonly string[];
  extras?: {
    kkt?: ParetoCandidate;
    kktShort?: string;
    booked?: ParetoCandidate;
  };
}): ParetoScenario[] {
  const budget = input.budgetUsdM > 0 ? input.budgetUsdM : 7;
  const director = input.directorUsdM ?? DIRECTOR_VAR_USD_M;
  const universeMax = input.universeMaxUsdM ?? UNIVERSE_MAX_VAR_USD_M;
  const receive = (input.receiveNames ?? []).slice(0, 3);

  const inUniverse = (p: ParetoCandidate) => p.riskUsdM <= universeMax * 1.05 + 1e-9;
  const skyline = paretoSkyline(input.points.filter(inUniverse));
  if (skyline.length === 0) return [];

  const maxPt = closestToBudget(skyline, universeMax);
  const minPt = closestToBudget(skyline, director);

  const insideBudget = skyline.filter(p => p.riskUsdM <= budget + 1e-9);
  const balancedPt = insideBudget.length > 0
    ? insideBudget[insideBudget.length - 1]!
    : closestToBudget(skyline, budget);

  const receiveLabel = receive.length > 0 ? receive.join('/') : 'high-rate receive';
  const overBudget = (p: ParetoCandidate) => p.riskUsdM > budget + 1e-9;

  const card = (
    id: ParetoScenarioId,
    name: string,
    short: string,
    rationale: string,
    point: ParetoCandidate,
  ): ParetoScenario => ({
    id,
    name,
    short,
    rationale,
    carryUsdYrM: point.carryUsdYrM,
    riskUsdM: point.riskUsdM,
    usedPct: usedPct(point.riskUsdM, budget),
    efficiency: efficiencyRatio(point.carryUsdYrM, point.riskUsdM),
    approved: !overBudget(point),
    point,
  });

  const cards: ParetoScenario[] = [
    card(
      'maxCarry',
      `Max carry (${receiveLabel})`,
      overBudget(maxPt)
        ? 'Closest to the $20M approval cap — still over the scenario budget'
        : 'High-rate receive currencies',
      'Zip Max Carry: nearest sampled book to the top approval rung ($20M overlay VAR). Not the liquidity-walk leverage tail.',
      maxPt,
    ),
    card(
      'balanced',
      'Balanced carry / VAR',
      overBudget(balancedPt)
        ? `Closest to the $${budget.toFixed(0)}M budget — still over`
        : `Carry within the $${budget.toFixed(0)}M budget`,
      'Richest Pareto point whose diversified risk is ≤ the scenario VAR budget. If the whole front sits above the budget, the nearest point is flagged for review.',
      balancedPt,
    ),
    card(
      'conservative',
      'Conservative (low VAR)',
      overBudget(minPt)
        ? 'Closest to the $5M Director rung — still above budget'
        : 'Closest to the $5M Director rung',
      'Zip Conservative: nearest sampled book to the bottom approval rung ($5M overlay VAR).',
      minPt,
    ),
  ];

  const insideDirector = skyline.filter(p => p.riskUsdM <= director + 1e-9);
  const directorPt = insideDirector.length > 0
    ? insideDirector[insideDirector.length - 1]!
    : null;
  if (
    directorPt
    && director + 1e-9 < budget
    && !alreadyPicked(directorPt, cards)
  ) {
    cards.push(card(
      'director',
      `Director cap ($${director.toFixed(0)}M)`,
      'Richest carry that still clears Director',
      `Max carry on the front whose diversified risk is ≤ the Director $${director.toFixed(0)}M cap, so the book can clear without a CFO sign-off.`,
      directorPt,
    ));
  }

  const effPt = skyline.reduce((best, p) =>
    efficiencyRatio(p.carryUsdYrM, p.riskUsdM) > efficiencyRatio(best.carryUsdYrM, best.riskUsdM)
      ? p
      : best,
  );
  if (!alreadyPicked(effPt, cards) && efficiencyRatio(effPt.carryUsdYrM, effPt.riskUsdM) > 0) {
    cards.push(card(
      'maxEfficiency',
      'Best efficiency',
      'Most carry per $1M of CFaR',
      'Skyline point with the highest carry $K / risk $M. Not the same as max carry when the last increment of risk buys little carry.',
      effPt,
    ));
  }

  if (input.extras?.booked && inUniverse(input.extras.booked) && !alreadyPicked(input.extras.booked, cards)) {
    cards.push(card(
      'asBooked',
      'As booked',
      'This regime’s live strip',
      'The funding strip the selected regime already runs. Shown when that book is not already one of the named Pareto picks.',
      input.extras.booked,
    ));
  }

  if (input.extras?.kkt && inUniverse(input.extras.kkt) && !alreadyPicked(input.extras.kkt, cards)) {
    cards.push(card(
      'kktSparse',
      'KKT sparse cover',
      input.extras.kktShort ?? 'Shadow-priced H* on this regime',
      'Complementary slackness on the selected regime: EARN keeps the strip, cheap OD drops it, bind names fund just enough to clear H*.',
      input.extras.kkt,
    ));
  }

  return cards;
}

/** Live receive names for the max-carry subtitle, rate-spread descending. */
export function receiveNamesFromRows(
  rows: readonly { ccy: string; r_FCY: number }[],
  rUsd: number,
): string[] {
  return [...rows]
    .filter(r => r.r_FCY - rUsd > 1e-6)
    .sort((a, b) => (b.r_FCY - rUsd) - (a.r_FCY - rUsd))
    .map(r => r.ccy);
}
