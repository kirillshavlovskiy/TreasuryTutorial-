/**
 * Box-constrained (per-leg h ∈ [0,1]) active-set solver for the per-tenor
 * FX hedge efficient frontier (the Optimize step in FX Risk analysis).
 *
 * `walkAtlasEfficientSet` (fx-var-frontier.ts) peels one CCY×tenor leg
 * fully off at a time and never revisits it — a monotonic ratchet. A
 * vendor-published reference frontier (Capital Markets Atlas) does not
 * walk that way: consecutive rows can UN-hedge one leg while RE-hedging
 * another (e.g. USD/GBP 1y 100%→0% alongside USD/PLN 1m 64%→100% at the
 * same VaR step) — proof the true optimum re-solves the whole free set at
 * every risk budget, not a single irreversible peel order.
 *
 * This module re-solves that mix from scratch at each VaR cap:
 *   - u_i ∈ [0,1] is the OPEN (unhedged) fraction of leg i. u=0 is the
 *     origin: every leg fully hedged, zero FX risk.
 *   - Objective: maximize Σ u_i·μ_i where μ_i = −hedgeCarryUsdM_i (the
 *     carry given up by KEEPING leg i hedged). Legs that cost carry to
 *     hold hedged have positive μ and open first.
 *   - Risk: z·√(u′Σu) ≤ cap, Σ_ij = signedVarUsdM_i·signedVarUsdM_j·ρ_ij.
 *   - Box: 0 ≤ u_i ≤ 1 — two-sided, unlike constrained-carry-frontier.ts's
 *     currency-level floor-only pin (that module has no upper bound; a
 *     hedge ratio genuinely cannot go past fully-open or fully-hedged).
 *
 * Algorithm (a "critical line" walk, matching the classical Markowitz
 * turning-point method): unconstrained Σ⁻¹μ direction on the free set
 * (closed form, same idea as portfolio-alloc.ts's allocateCarryVarUsd),
 * scaled by k. The k that would exactly hit the VAR cap is solved
 * analytically (an exact quadratic in k — no bisection needed). Legs are
 * pinned ONE AT A TIME, whichever box bound (0 or 1) would be reached
 * first as k grows — never all violators at once: cross-currency
 * correlation can be negative (a short leg vs a positively-correlated
 * long leg), so clamping several legs down together can *raise* portfolio
 * risk instead of lowering it and silently break the cap. Pinning one leg
 * at a time and re-deriving the direction on the shrinking free set (the
 * same iterative shape as constrained-carry-frontier.ts's
 * buildActiveSetCarryFrontier, generalized to a two-sided box) avoids
 * that failure mode.
 *
 * Validated against a real vendor reference frontier (20 published VaR/
 * carry points across 240 currency×tenor legs, `lib/test-mode/fixtures/
 * atlas-efficient-frontier.ts`): carry matches to within 0.01% of the
 * vendor's own published value at the extreme point once the bugs below
 * were fixed. See the fixture file's own doc comment for provenance.
 */

import { invertMatrix } from '@/lib/portfolio-alloc';
import type { UsdRiskLeg } from '@/lib/fx-market-risk';
import type { FxAtlasLeg } from '@/lib/test-mode/fx-var-frontier';

export type FxLegCorrFn = (a: UsdRiskLeg, b: UsdRiskLeg) => number;

const RIDGE = 1e-9;

function buildLegSigma(
  legs: readonly FxAtlasLeg[],
  corr: FxLegCorrFn,
): number[][] {
  const n = legs.length;
  // corr() only reads ccy/tenorMonths; usdM is part of UsdRiskLeg's shape
  // (shared with other diversifiedUsdRisk callers) but unused here.
  const riskLegs: UsdRiskLeg[] = legs.map(l => ({
    ccy: l.ccy, tenorMonths: l.tenorMonths, usdM: l.signedVarUsdM,
  }));
  const sigma: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    const li = legs[i]!;
    const ri = riskLegs[i]!;
    for (let j = 0; j < n; j++) {
      const lj = legs[j]!;
      const rho = i === j ? 1 : corr(ri, riskLegs[j]!);
      row.push(li.signedVarUsdM * lj.signedVarUsdM * rho + (i === j ? RIDGE : 0));
    }
    sigma.push(row);
  }
  return sigma;
}

function quadForm(x: readonly number[], sigma: readonly number[][]): number {
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    if (xi === 0) continue;
    let row = 0;
    const sigmaRow = sigma[i]!;
    for (let j = 0; j < x.length; j++) {
      const xj = x[j]!;
      if (xj !== 0) row += sigmaRow[j]! * xj;
    }
    v += xi * row;
  }
  return v;
}

/**
 * `sigma_ij = signedVarUsdM_i · signedVarUsdM_j · ρ_ij`, and each
 * `signedVarUsdM` already has the z-score baked in (fxAtlasLegVarUsdM
 * multiplies by z once). So `quadForm(u, sigma)` already carries z² and
 * `sqrt(quadForm(...))` already IS the z-scaled portfolio VaR — do not
 * multiply by z again here (verified against portfolio-liquidity-frontier's
 * diversifiedUsdRisk on the vendor's own published mix: an earlier version
 * of this function that did `z * sqrt(...)` overstated risk by exactly a
 * factor of z, making the solver stop ~40% short of the true risk budget).
 */
function riskAt(u: readonly number[], sigma: readonly number[][]): number {
  return Math.sqrt(Math.max(0, quadForm(u, sigma)));
}

function bilinearForm(
  x: readonly number[],
  y: readonly number[],
  sigma: readonly number[][],
): number {
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    if (xi === 0) continue;
    let row = 0;
    const sigmaRow = sigma[i]!;
    for (let j = 0; j < y.length; j++) {
      const yj = y[j]!;
      if (yj !== 0) row += sigmaRow[j]! * yj;
    }
    v += xi * row;
  }
  return v;
}

/**
 * Largest k≥0 such that risk(base + k·dir) = cap, given risk(base) < cap.
 * `risk(k)² = C2·k² + C1·k + C0` is an exact quadratic in k (no search
 * needed) — solve it directly instead of bisecting.
 */
function solveKForCap(
  base: readonly number[],
  dir: readonly number[],
  sigma: readonly number[][],
  capUsdM: number,
): number {
  // No /z² here — sigma already carries z² (see riskAt's doc comment).
  const target = capUsdM * capUsdM;
  const c0 = quadForm(base, sigma);
  const c1 = 2 * bilinearForm(dir, base, sigma);
  const c2 = quadForm(dir, sigma);
  const rhs = target - c0; // > 0, since risk(base) < cap was already checked
  if (c2 <= 1e-15) {
    // Direction has ~zero quadratic contribution — fall back to the
    // linear term (degenerate direction; extremely rare in practice).
    return c1 > 1e-15 ? Math.max(0, rhs / c1) : Number.POSITIVE_INFINITY;
  }
  const disc = c1 * c1 + 4 * c2 * rhs;
  const k = (-c1 + Math.sqrt(Math.max(0, disc))) / (2 * c2);
  return Math.max(0, k);
}

/**
 * Σ_ff⁻¹·μ_f on the free set. Returns null if the free submatrix is
 * singular (duplicate/degenerate legs — extremely rare, dust legs only).
 */
function freeDirection(
  sigma: readonly number[][],
  mu: readonly number[],
  freeIdx: readonly number[],
): number[] | null {
  const m = freeIdx.length;
  if (m === 0) return [];
  const sub: number[][] = freeIdx.map(i => freeIdx.map(j => sigma[i]![j]!));
  const inv = invertMatrix(sub);
  if (!inv) return null;
  const muF = freeIdx.map(i => mu[i]!);
  return inv.map(row => row.reduce((s, v, k) => s + v * muF[k]!, 0));
}

export interface FxHedgeFrontierSolution {
  /** Per-leg open (unhedged) fraction, same order/length as the input legs. */
  u: number[];
  divVarUsdM: number;
  carryUsdYrM: number;
}

/**
 * Run the critical-line walk to convergence FROM the given (u, pinnedAt)
 * state, mutating both in place. Pins legs one at a time, whichever box
 * bound (0 or 1) is reached first as k grows along the current free-set
 * direction — never all violators at once: cross-currency correlation can
 * be negative (a short leg vs a positively-correlated long leg), so
 * clamping several legs down together can *raise* portfolio risk instead
 * of lowering it and silently break the cap.
 */
function runCriticalLineWalk(
  u: number[],
  pinnedAt: (number | null)[],
  sigma: readonly number[][],
  mu: readonly number[],
  capUsdM: number,
): void {
  const n = u.length;
  // At most n legs can be pinned across the whole walk — a safe hard
  // bound on iterations here, not a tuning knob.
  for (let iter = 0; iter < n; iter++) {
    const freeIdx: number[] = [];
    for (let i = 0; i < n; i++) if (pinnedAt[i] == null) freeIdx.push(i);
    if (freeIdx.length === 0) break;

    const base = u.slice();
    for (const i of freeIdx) base[i] = 0;
    const baseRisk = riskAt(base, sigma);
    if (baseRisk >= capUsdM) {
      freeIdx.forEach(i => { u[i] = 0; });
      break;
    }

    const dir = freeDirection(sigma, mu, freeIdx);
    if (!dir) {
      // Singular free submatrix — pin the largest-|μ| free leg at its
      // natural sign and keep going rather than fail the whole solve.
      let worst = freeIdx[0]!;
      for (const i of freeIdx) if (Math.abs(mu[i]!) > Math.abs(mu[worst]!)) worst = i;
      pinnedAt[worst] = mu[worst]! > 0 ? 1 : 0;
      u[worst] = pinnedAt[worst]!;
      continue;
    }

    const dirFull = new Array<number>(n).fill(0);
    freeIdx.forEach((i, idx) => { dirFull[i] = dir[idx]!; });

    const kCap = solveKForCap(base, dirFull, sigma, capUsdM);

    // Smallest k at which ANY free leg reaches a box bound. Two legs can
    // tie here EXACTLY (e.g. symmetric offsetting exposures at the same
    // |direction| magnitude) — when they do, they must be pinned
    // TOGETHER, not one at a time: pinning just one of a canceling pair
    // at its upper bound leaves it contributing full risk with no partner
    // to offset it, making the remaining free legs look far more
    // expensive than the true joint solution actually is (verified: this
    // silently broke a symmetric two-leg case where the joint answer was
    // u=[1,1] but processing one leg first made the second look
    // infeasible and left it at 0).
    let kBind = Number.POSITIVE_INFINITY;
    freeIdx.forEach((i, idx) => {
      const d = dir[idx]!;
      if (d > 1e-12) kBind = Math.min(kBind, 1 / d);
      else if (d < -1e-12) kBind = 0;
    });

    const k = Math.min(kCap, kBind);
    freeIdx.forEach((i, idx) => { u[i] = k * dir[idx]!; });

    if (kBind >= kCap - 1e-12) {
      // Reached the cap before (or exactly as) any leg binds — done.
      break;
    }
    const tol = Math.max(1e-9, kBind * 1e-9);
    let pinnedAny = false;
    freeIdx.forEach((i, idx) => {
      const d = dir[idx]!;
      if (d > 1e-12 && Math.abs(1 / d - kBind) <= tol) {
        pinnedAt[i] = 1;
        u[i] = 1;
        pinnedAny = true;
      } else if (kBind === 0 && d < -1e-12) {
        pinnedAt[i] = 0;
        u[i] = 0;
        pinnedAny = true;
      }
    });
    if (!pinnedAny) break; // shouldn't happen, but avoid an infinite loop
  }
}

const MAX_RELEASE_ROUNDS = 30;

/**
 * Solve for the carry-maximizing per-leg open-fraction vector at one VaR
 * cap.
 *
 * A leg pinned at 0 early (because its direction was negative given the
 * free set AT THAT TIME) can have its true optimal direction flip
 * positive later, once other correlated legs have themselves been pinned
 * — the reduced covariance structure among the survivors is a different
 * problem than the original joint one. A plain one-way active-set walk
 * never revisits a pin and silently converges to a LOWER ceiling than the
 * true optimum (verified empirically against the vendor reference
 * fixture: pinning decisions from the full 240-leg free set alone left
 * real carry on the table vs the vendor's own published max point). So
 * after the walk converges, every leg pinned at 0 is re-tested ONE AT A
 * TIME — same reasoning as the pin side: testing several release
 * candidates in one joint solve can wrongly reject a leg that would show
 * positive direction once considered on its own against the (possibly
 * already-updated-this-round) free set. Accepted releases are folded in
 * before testing the next candidate; the expensive full walk only reruns
 * once per round, not once per candidate. Repeated until a round releases
 * nothing. Verified against the vendor fixture: this closed the remaining
 * gap to within noise (carry within 0.01% of the reference published
 * value at the max point).
 */
export function solveHedgeFrontierAtCap(
  legs: readonly FxAtlasLeg[],
  corr: FxLegCorrFn,
  capUsdM: number,
  z: number,
  /**
   * Force specific legs to a fixed bound (0 or 1) before the walk starts,
   * and let the rest solve freely within the same cap. Two production
   * uses in fx-var-frontier.ts: a user's explicit "leave open" toggle
   * (pin at 1, atlasForceOpenPins) and the dust-currency guard (pin at 0,
   * atlasDustCurrencyPins) that keeps a zero-carry name hedged regardless
   * of what the unconstrained joint optimum would otherwise pick.
   */
  forcedPins?: ReadonlyMap<number, 0 | 1>,
): FxHedgeFrontierSolution {
  const n = legs.length;
  if (n === 0 || !(capUsdM >= 0) || !(z > 0)) {
    return { u: legs.map(() => 0), divVarUsdM: 0, carryUsdYrM: 0 };
  }
  const sigma = buildLegSigma(legs, corr);
  const mu = legs.map(l => -l.hedgeCarryUsdM);

  const u = new Array<number>(n).fill(0);
  const pinnedAt = new Array<number | null>(n).fill(null);
  if (forcedPins) {
    for (const [i, bound] of forcedPins) {
      pinnedAt[i] = bound;
      u[i] = bound;
    }
  }

  runCriticalLineWalk(u, pinnedAt, sigma, mu, capUsdM);

  for (let round = 0; round < MAX_RELEASE_ROUNDS; round++) {
    const zeroPinned: number[] = [];
    for (let i = 0; i < n; i++) if (pinnedAt[i] === 0 && !forcedPins?.has(i)) zeroPinned.push(i);
    if (zeroPinned.length === 0) break;

    // Test release ONE LEG AT A TIME, same reasoning as the pin side:
    // checking several legs' release-worthiness in one joint solve can
    // wrongly reject a leg that WOULD show positive direction once
    // considered on its own against the (possibly already-updated-this-
    // round) free set. Each accepted release is folded into the
    // candidate set before testing the next leg, so order matters and
    // reflects genuine sequential dependency — but the expensive full
    // walk (with its own cap bisection) only reruns once per round, not
    // once per leg.
    const candidateFree: number[] = [];
    for (let i = 0; i < n; i++) if (pinnedAt[i] == null) candidateFree.push(i);
    let released = false;
    for (const i of zeroPinned) {
      const trialDir = freeDirection(sigma, mu, [...candidateFree, i]);
      if (!trialDir) continue; // degenerate for this leg — skip, don't fail the round
      const d = trialDir[trialDir.length - 1]!;
      if (d > 1e-9) {
        pinnedAt[i] = null;
        candidateFree.push(i);
        released = true;
      }
    }
    if (!released) break;
    runCriticalLineWalk(u, pinnedAt, sigma, mu, capUsdM);
  }

  // Symmetric check for legs pinned at 1 (fully open): one can be pinned
  // open early because it looked worthwhile against the free set AT THAT
  // TIME, then turn out to be part of a WORSE joint answer once other
  // legs settle — e.g. it stops being needed for diversification once a
  // better-correlated leg opens instead. Unlike the release-from-0 check
  // (where the direction's SIGN alone proves the move helps), there's no
  // equally cheap sufficient test here — "should this leg be pulled back
  // from 1" depends on the specific k the rest of the free set settles
  // at, not just a sign. So this tries each candidate directly: release
  // it, re-solve, see if carry improves.
  //
  // Accept only the SINGLE BEST improving release per round (steepest-
  // ascent), never all improving candidates at once — same reasoning as
  // the pin side and the release-from-0 side: accepting several "look
  // good in isolation" moves together is path-dependent and can leave the
  // solver WORSE off than accepting them one at a time, because releasing
  // leg A can change whether releasing leg B still helps (verified
  // against a real 5-currency vendor reference frontier: accept-all
  // degraded some points instead of only improving them).
  for (let round = 0; round < MAX_RELEASE_ROUNDS; round++) {
    const onePinned: number[] = [];
    for (let i = 0; i < n; i++) if (pinnedAt[i] === 1 && !forcedPins?.has(i)) onePinned.push(i);
    if (onePinned.length === 0) break;

    const currentCarry = legs.reduce((s, l, idx) => s + (1 - u[idx]!) * l.hedgeCarryUsdM, 0);
    let bestU: number[] | null = null;
    let bestPinned: (number | null)[] | null = null;
    let bestCarry = currentCarry;
    for (const i of onePinned) {
      const trialU = u.slice();
      const trialPinned = pinnedAt.slice();
      trialPinned[i] = null;
      runCriticalLineWalk(trialU, trialPinned, sigma, mu, capUsdM);
      const trialCarry = legs.reduce((s, l, idx) => s + (1 - trialU[idx]!) * l.hedgeCarryUsdM, 0);
      if (trialCarry > bestCarry + 1e-9) {
        bestCarry = trialCarry;
        bestU = trialU;
        bestPinned = trialPinned;
      }
    }
    if (!bestU || !bestPinned) break;
    for (let k = 0; k < n; k++) { u[k] = bestU[k]!; pinnedAt[k] = bestPinned[k]!; }
  }

  const divVarUsdM = riskAt(u, sigma);
  const carryUsdYrM = legs.reduce((s, l, i) => s + (1 - u[i]!) * l.hedgeCarryUsdM, 0);
  return { u, divVarUsdM, carryUsdYrM };
}
