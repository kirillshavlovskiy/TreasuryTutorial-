/**
 * Cross-currency overlay allocation for a shared policy VAR and an optional
 * shared carry target.
 *
 * Positions are USD overlay weights w (H* − hold-the-book, in $M).
 *   carry = μ′w     μ_i = (r_FCY − r_USD)/100
 *   VAR   = z₉₅ √(w′ Σ w)   Σ_ij = σ_i σ_j ρ_ij × 21   (same vols as computePortfolioVAR)
 *
 * Unpinned names follow Σ⁻¹ μ (Lagrangian of max carry s.t. VAR). Scale k so
 * VAR fills the policy cap, or so carry hits a feasible shared target.
 * Manual Target LP Cash is pinned and still consumes the VAR budget.
 */

import {
  CORR_CURRENCIES,
  CORR_MATRIX,
  CURRENCY_PARAMS,
  Z_NEUTRAL,
  computePortfolioVAR,
} from '@/lib/fx-buffer';

const SQRT_21 = Math.sqrt(21);
const RIDGE = 1e-8;
/** Rate-differential materiality scale (decimal, 15bp) — see solveCarryVarUsd. */
const MATERIALITY_MU = 0.0015;
/**
 * Max gross notional per currency, as a multiple of the active VAR cap —
 * see solveCarryVarUsd's pin-and-resolve loop. A correlated Σ⁻¹μ solve can
 * fill a small VAR budget with an arbitrarily large offsetting position
 * (two names that mostly cancel each other's risk can each individually be
 * sized far beyond the cap and still net out to a small portfolio VAR) —
 * real desks bound this with an explicit leverage/notional limit alongside
 * the VAR limit, not VAR alone. 3x is a deliberate policy choice, not a
 * derived constant — revisit with the desk if it turns out too tight or
 * too loose in practice. (Was 12x — a single leg reaching $240M against a
 * $20M policy cap was still an unreasonable multiple.)
 */
export const OVERLAY_MAX_LEG_LEVERAGE = 3;
/**
 * Second, independent ceiling: a leg's overlay notional also can't exceed
 * this multiple of that CURRENCY's own real base book (|basesFcy_i| ×
 * spot_i). OVERLAY_MAX_LEG_LEVERAGE alone bounds every leg by the SAME shared
 * VAR cap regardless of that currency's real size — a correlation-driven
 * diversifier (e.g. low-vol SEK helping cancel other legs' risk) can get
 * slammed to the full cap×3 ceiling even when its real NP book is a small
 * fraction of that (observed: HUF real book ~$2.9M vs a $60M ceiling at the
 * $20M policy tier — 21x). Take the MIN of both ceilings so a leg is bound
 * by whichever is tighter. 2x is a deliberate policy choice, not derived —
 * revisit with the desk. Skipped when basesFcy isn't supplied (old flat
 * behavior) — only applied per-leg when that leg's own base is provided.
 */
export const OVERLAY_MAX_BASE_MULTIPLE = 2;

const MAX_LEG_LEVERAGE = OVERLAY_MAX_LEG_LEVERAGE;
const MAX_BASE_MULTIPLE = OVERLAY_MAX_BASE_MULTIPLE;

/** Per-leg overlay notional ceiling ($M) under the active Policy VAR. */
export function overlayLegNotionalCeilingUsdM(input: {
  policyCapUsdM: number;
  baseFcyM?: number;
  spot?: number;
}): number {
  const capLev = Math.max(0, input.policyCapUsdM) * MAX_LEG_LEVERAGE;
  const baseUsd = Math.abs(input.baseFcyM ?? 0) * Math.max(0, input.spot ?? 0);
  if (baseUsd > 1e-6) return Math.min(capLev, baseUsd * MAX_BASE_MULTIPLE);
  return capLev;
}

export interface CarryVarAllocInput {
  ccys: readonly string[];
  /** $ carry / $ overlay / year — (r_FCY − r_USD) / 100. */
  mu: readonly number[];
  varCapUsdM: number;
  /** Portfolio carry ask ($M/yr). Hit it at min VAR when feasible; else fill VAR. */
  carryTargetUsdYrM?: number;
  /** Pinned overlay USD (manual targets). Same length as ccys. */
  pinnedUsdM?: readonly number[];
  /**
   * Hold-the-book base position (M FCY) per currency, same order as ccys —
   * enables the credit/debit carry split (see legCarryRate). Omitted =
   * every leg priced at μ regardless of sign, the old flat-rate behavior.
   */
  basesFcy?: readonly number[];
  /** Overdraft rate (% p.a.) per currency, paired with basesFcy. */
  rOd?: readonly number[];
  r_USD?: number;
  /**
   * Per-currency minimum FINAL position (M FCY, i.e. basesFcy[i] +
   * overlayFcy[i]) — the desk's floorH cash_floor. Paired with basesFcy: a
   * floor without a base to measure the final position against is
   * meaningless, so entries are ignored unless basesFcy is also supplied.
   * Omitted/0/negative entries are ignored (no floor for that leg).
   */
  floorFcy?: readonly number[];
  /**
   * Standalone FX exposure CFaR ($M) per currency — RSS'd into VAR as an
   * independent term (see overlayVarUsdM). Omitted/0 = old pure-ray VAR,
   * exactly linear in the overlay scale.
   */
  fixedCfarUsdM?: readonly number[];
  /**
   * Skip MAX_LEG_LEVERAGE entirely. For the one caller that isn't sizing a
   * real position: sweepPortfolioCarryFrontier's unitLegUsd computes a
   * Σ⁻¹μ DIRECTION at a $1M reference scale purely to get a stable x-axis
   * unit — leverage-clamping that normalization step (3x of $1M = $3M) would
   * distort the direction itself for any currency whose natural per-$1M
   * weight exceeds $3M, corrupting the whole k-sweep's mix, not just its
   * scale. Real allocation calls (the live optimizer, the frontier's actual
   * sweet spot) must never set this — the whole point is to cap them.
   */
  skipLeverageCap?: boolean;
}

export interface CarryVarAllocResult {
  wUsdM: number[];
  carryUsdYrM: number;
  varUsdM: number;
  varBinding: boolean;
  carryBinding: boolean;
  /**
   * True when varUsdM > varCapUsdM even at zero overlay (k=0) — the fixed
   * standalone exposure (fixedCfarUsdM) alone already breaches the Policy
   * VAR cap, which the overlay solve has no lever to fix (it can only add
   * risk by taking k > 0, never remove risk that exists at k=0). This is a
   * real base-book breach, not a sizing choice — the desk is already over
   * limit before any overlay decision. Never treat a result with this flag
   * set as a compliant "scenario"; it must not be silently offered as one.
   */
  capBreachedAtZeroOverlay: boolean;
}

export type OverlaySide = 'long' | 'short' | 'flat';

export interface EfficientRayPoint {
  /** 0 = pin-only origin, 1 = Policy VAR fill on the same ray. */
  t: number;
  carryUsdYrM: number;
  varUsdM: number;
}

export interface EfficientCarryLeg {
  ccy: string;
  /** (r_FCY − r_USD)/100. Positive = EARN vs USD NP, negative = PAY. */
  mu: number;
  usdM: number;
  fcyM: number;
  side: OverlaySide;
  /**
   * Carry on THIS leg. Credit/debit-split (μ while the final position stays
   * positive, the overdraft rate once it's pushed negative) when
   * basesFcy/rOd/r_USD were supplied to buildEfficientCarryVarFrontier;
   * otherwise the old flat μ×usdM. Always read this instead of recomputing
   * mu×usdM in a UI layer — that recompute silently drops the split.
   */
  carryUsdYrM: number;
  /**
   * This leg's signed share of the overlay's TOTAL diversified VAR
   * (component VAR — computePortfolioVAR's Euler allocation: Σ over legs
   * equals the portfolio VAR exactly). Negative = this leg diversifies the
   * book and REDUCES total risk rather than consuming budget — not the
   * same as a small standalone VAR. Read this for a per-currency CFaR
   * column; usdM/fcyM are notional, not risk.
   */
  componentVarUsdM: number;
}

export interface EfficientCarryVarFrontier {
  ray: EfficientRayPoint[];
  varCapUsdM: number;
  sweet: EfficientRayPoint & {
    varBinding: boolean;
    carryBinding: boolean;
    /** See CarryVarAllocResult.capBreachedAtZeroOverlay — never treat this sweet as a compliant scenario when true. */
    capBreachedAtZeroOverlay: boolean;
  };
  cap: EfficientRayPoint;
  /** Overlay at the sweet spot (earn ask or VAR fill). */
  legs: EfficientCarryLeg[];
  /** Overlay at the Policy VAR fill — the walk's unit mix, independent of earn. */
  capLegs: EfficientCarryLeg[];
  carryTargetUsdYrM?: number;
}

function pairCorr(a: string, b: string): number {
  if (a === b) return 1;
  const i = CORR_CURRENCIES.indexOf(a);
  const j = CORR_CURRENCIES.indexOf(b);
  if (i < 0 || j < 0) return 0;
  return CORR_MATRIX[i]![j]!;
}

function volFactor(ccy: string): number {
  const p = CURRENCY_PARAMS[ccy];
  return (p?.σ_daily ?? 0.005) * SQRT_21;
}

/** Gauss-Jordan invert. Returns null if the pivot vanishes. */
export function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  if (n === 0) return [];
  const M = A.map((row, i) => {
    const aug = row.slice();
    for (let j = 0; j < n; j++) aug.push(i === j ? 1 : 0);
    return aug;
  });
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r]![i]!) > Math.abs(M[piv]![i]!)) piv = r;
    }
    if (Math.abs(M[piv]![i]!) < 1e-12) return null;
    if (piv !== i) {
      const tmp = M[i]!;
      M[i] = M[piv]!;
      M[piv] = tmp;
    }
    const d = M[i]![i]!;
    for (let c = 0; c < 2 * n; c++) M[i]![c]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r]![i]!;
      for (let c = 0; c < 2 * n; c++) M[r]![c]! -= f * M[i]![c]!;
    }
  }
  return M.map(row => row.slice(n));
}

function sigmaUsd(ccys: readonly string[]): number[][] {
  const n = ccys.length;
  const vf = ccys.map(volFactor);
  const S: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(vf[i]! * vf[j]! * pairCorr(ccys[i]!, ccys[j]!) + (i === j ? RIDGE : 0));
    }
    S.push(row);
  }
  return S;
}

/**
 * √(fixed² + overlay²) — same shape displayedCfarUsdMFromFxNet uses per
 * currency (cfar-net-by-ccy.ts), generalized so the overlay portion keeps
 * its cross-currency correlation while each currency's fixed standalone
 * exposure is treated as independent (no evidence of correlation between
 * different currencies' own base exposures). fixedCfarUsdM omitted/all-zero
 * reproduces the old pure-ray VAR exactly — see sweepPortfolioCarryFrontier
 * in fx-buffer.ts for the parallel, independently-verified implementation.
 */
function overlayVarUsdM(
  ccys: readonly string[],
  wUsdM: readonly number[],
  fixedCfarUsdM?: readonly number[],
): number {
  const n = ccys.length;
  const S = sigmaUsd(ccys);
  let q = 0;
  for (let i = 0; i < n; i++) {
    if (CORR_CURRENCIES.indexOf(ccys[i]!) < 0) continue;
    for (let j = 0; j < n; j++) {
      if (CORR_CURRENCIES.indexOf(ccys[j]!) < 0) continue;
      q += wUsdM[i]! * S[i]![j]! * wUsdM[j]!;
    }
  }
  const fixedQ = (fixedCfarUsdM ?? []).reduce((s, v) => s + (v / Z_NEUTRAL) ** 2, 0);
  return Z_NEUTRAL * Math.sqrt(Math.max(0, q) + fixedQ);
}

/**
 * Credit/debit split — same mechanism unfundedCashCarryUsdYr uses
 * (liquidity-frontier.ts): price at μ (deposit rate) while the FINAL
 * position stays in credit, at the overdraft rate once it's pushed into
 * debit. Falls back to flat μ when bases/rOd/r_USD aren't supplied.
 */
function legCarryRate(
  mu: number,
  finalFcy: number,
  rOd: number | undefined,
  r_USD: number | undefined,
): number {
  if (rOd == null || r_USD == null) return mu;
  return finalFcy >= 0 ? mu : (rOd - r_USD) / 100;
}

function overlayCarryUsdYrM(
  ccys: readonly string[],
  mu: readonly number[],
  wUsdM: readonly number[],
  basesFcy?: readonly number[],
  rOd?: readonly number[],
  r_USD?: number,
): number {
  return mu.reduce((s, m, i) => {
    const usdM = wUsdM[i]!;
    if (!basesFcy || !rOd || r_USD == null) return s + m * usdM;
    const spot = CURRENCY_PARAMS[ccys[i]!]?.spot ?? 1;
    const fcyM = spot > 1e-12 ? usdM / spot : 0;
    const finalFcy = (basesFcy[i] ?? 0) + fcyM;
    return s + usdM * legCarryRate(m, finalFcy, rOd[i], r_USD);
  }, 0);
}

function addScaled(
  pin: readonly number[],
  dir: readonly number[],
  k: number,
): number[] {
  return pin.map((p, i) => p + k * dir[i]!);
}

interface CarryVarSolve {
  ccys: readonly string[];
  mu: readonly number[];
  pin: number[];
  dir: number[];
  kVar: number;
  k: number;
  result: CarryVarAllocResult;
}

/**
 * Max μ′w s.t. VAR(w) ≤ cap, with optional carry target (same efficient ray).
 * Pinned coordinates stay put; free coordinates follow Σ_ff⁻¹ μ_f.
 */
function solveCarryVarUsd(input: CarryVarAllocInput): CarryVarSolve | null {
  const { ccys, mu, varCapUsdM, basesFcy, rOd, r_USD, fixedCfarUsdM } = input;
  const n = ccys.length;
  if (n === 0) return null;
  const pin = (input.pinnedUsdM ?? ccys.map(() => 0)).slice();
  while (pin.length < n) pin.push(0);
  const freeIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(pin[i]!) > 1e-12) continue;
    if (CORR_CURRENCIES.indexOf(ccys[i]!) < 0) continue;
    if (!CURRENCY_PARAMS[ccys[i]!]) continue;
    freeIdx.push(i);
  }
  const pinnedOnly = (): CarryVarSolve => {
    const wUsdM = pin.slice();
    return {
      ccys,
      mu,
      pin: pin.slice(),
      dir: ccys.map(() => 0),
      kVar: 0,
      k: 0,
      result: {
        wUsdM,
        carryUsdYrM: overlayCarryUsdYrM(ccys, mu, wUsdM, basesFcy, rOd, r_USD),
        varUsdM: overlayVarUsdM(ccys, wUsdM, fixedCfarUsdM),
        varBinding: false,
        carryBinding: false,
        capBreachedAtZeroOverlay: overlayVarUsdM(ccys, wUsdM, fixedCfarUsdM) > Math.max(0, varCapUsdM) + 1e-6,
      },
    };
  };
  if (freeIdx.length === 0) return pinnedOnly();

  const S = sigmaUsd(ccys);
  const Sf = freeIdx.map(i => freeIdx.map(j => S[i]![j]!));
  const inv = invertMatrix(Sf);
  if (!inv) return null;
  // Materiality dampening — Σ⁻¹ alone naturally favors low-variance names
  // regardless of how small their own expected return is: a currency with a
  // near-zero rate differential but low vol (or a helpful correlation to
  // the rest of the book) can absorb an outsized notional to fill the SAME
  // VAR budget "efficiently," sizing a real position purely to harvest a
  // negligible yield. Scale mu by min(1, |mu|/MATERIALITY_MU) before the
  // Σ⁻¹ solve — a smooth, continuous haircut (not a hard cutoff): a
  // currency at the threshold is unaffected, one at half the threshold gets
  // half its mu (and, since Σ⁻¹ is linear in mu, roughly half its
  // notional), one at zero mu stays at zero. Direction sign is preserved,
  // so a genuinely EARN/PAY currency still shows up correctly — it's the
  // MAGNITUDE for marginal, near-zero differentials that shrinks.
  const muF = freeIdx.map((i) => {
    const m = mu[i]!;
    const damp = Math.min(1, Math.abs(m) / MATERIALITY_MU);
    return m * damp;
  });
  const dirF = inv.map(row => row.reduce((s, a, j) => s + a * muF[j]!, 0));
  if (dirF.every(v => Math.abs(v) < 1e-16)) return null;
  const dir = ccys.map(() => 0);
  freeIdx.forEach((i, idx) => { dir[i] = dirF[idx]!; });

  const varAt = (scale: number) => overlayVarUsdM(ccys, addScaled(pin, dir, scale), fixedCfarUsdM);
  const carryAt = (scale: number) => overlayCarryUsdYrM(ccys, mu, addScaled(pin, dir, scale), basesFcy, rOd, r_USD);

  const cap = Math.max(0, varCapUsdM);
  let kHi = 1;
  let grew = false;
  for (let i = 0; i < 40; i++) {
    if (varAt(kHi) > cap + 1e-9) { grew = true; break; }
    kHi *= 2;
  }
  let kVar = 0;
  if (grew && Number.isFinite(kHi) && kHi < 1e12) {
    let lo = 0, hi = kHi;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (varAt(mid) > cap) hi = mid; else lo = mid;
    }
    kVar = lo;
  }
  // Leverage ceiling — rescale (not pin) any coordinate whose direction
  // would carry it past MAX_LEG_LEVERAGE × cap at the VAR-filling point.
  // This must adjust `dir` itself, not fold the leg into `pin`: `pin` is
  // read at every ray point via addScaled(pin, dir, scale), including
  // scale=0 (the pure unhedged origin — see the module comment for
  // farSettleExposureCfarUsdM's shape). Folding a leverage-driven leg into
  // `pin` would make it appear as if it were there even with zero overlay,
  // corrupting the one point that must be net of any overlay/funding risk.
  // Rescaling `dir[i]` instead keeps that coordinate proportional to scale
  // like every other leg — it lands exactly at the ceiling at kVar, and at
  // 0 when scale is 0, same as everything else. A currency-by-currency
  // rescale (not a single shared k) so one oversized leg cannot throttle
  // the fill for every OTHER currency — see the reverted single-scale-cap
  // attempt, which broke a 24-currency book down to a fraction of its
  // budget because one low-vol leg needed a huge notional to matter for
  // VAR at all.
  if (kVar > 1e-12 && !input.skipLeverageCap) {
    const capLeverageUsdM = cap * MAX_LEG_LEVERAGE;
    if (capLeverageUsdM > 0) {
      const wAtKVar = addScaled(pin, dir, kVar);
      freeIdx.forEach((i) => {
        const w = wAtKVar[i]!;
        let ceilingUsdM = capLeverageUsdM;
        if (basesFcy) {
          const spot = CURRENCY_PARAMS[ccys[i]!]?.spot ?? 0;
          const baseUsdM = Math.abs(basesFcy[i] ?? 0) * spot;
          // A missing/zero trough proxy must not zero the leg. PAY names
          // often have cash+payout ≤ 0 — that used to drop PLN/GBP and
          // leave a ~$5M EUR-only overlay.
          if (baseUsdM > 1e-6) {
            ceilingUsdM = Math.min(ceilingUsdM, baseUsdM * MAX_BASE_MULTIPLE);
          }
        }
        if (Math.abs(w) <= ceilingUsdM + 1e-9) return;
        const ceiling = Math.sign(w) * ceilingUsdM;
        dir[i] = (ceiling - pin[i]!) / kVar;
      });
    }
  }
  // Floor — the mirror of the leverage ceiling above: rescale `dir[i]` (not
  // pin, same reasoning as the ceiling) so the leg's FINAL position
  // (basesFcy[i] + overlayFcy[i]) lands at least at floorFcy[i] at kVar.
  // Runs after the ceiling so a genuine floor always wins if the two ever
  // conflict — the floor is an operational minimum the desk set directly,
  // the ceiling is a derived risk-sizing guard. A leg the ceiling clipped
  // down below its own floor gets pushed back up here.
  if (kVar > 1e-12 && input.floorFcy && basesFcy) {
    const wAtKVar = addScaled(pin, dir, kVar);
    freeIdx.forEach((i) => {
      const floorFcyI = input.floorFcy![i];
      if (floorFcyI == null || !(floorFcyI > 0)) return;
      const spot = CURRENCY_PARAMS[ccys[i]!]?.spot ?? 0;
      if (spot <= 1e-12) return;
      const baseFcy = basesFcy[i] ?? 0;
      const finalFcy = baseFcy + wAtKVar[i]! / spot;
      if (finalFcy >= floorFcyI - 1e-9) return;
      const requiredUsdM = (floorFcyI - baseFcy) * spot;
      dir[i] = (requiredUsdM - pin[i]!) / kVar;
    });
  }
  const target = input.carryTargetUsdYrM;
  let k = kVar;
  let carryBinding = false;
  if (typeof target === 'number' && Number.isFinite(target) && kVar > 1e-12) {
    const c0 = carryAt(0);
    const cVar = carryAt(kVar);
    // carryAt is piecewise-linear once the credit/debit split is active (at
    // most one kink per currency, where its position crosses zero) — a
    // single linear interpolation between the endpoints would misplace k
    // whenever the target sits past a kink. Bisection is exact regardless
    // of how many kinks there are, as long as carryAt stays monotonic
    // along the ray — true in every case checked so far, since dir is
    // built to maximize carry and the split only ever makes a leg's rate
    // worse (never better) once it crosses into debit.
    const between = (target - c0) * (target - cVar) <= 0;
    if (between && Math.abs(cVar - c0) > 1e-12) {
      const rising = cVar > c0;
      let lo = 0;
      let hi = kVar;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const below = rising ? carryAt(mid) < target : carryAt(mid) > target;
        if (below) lo = mid; else hi = mid;
      }
      k = lo;
      carryBinding = true;
    }
  }

  const wUsdM = addScaled(pin, dir, k);
  const varUsdM = overlayVarUsdM(ccys, wUsdM, fixedCfarUsdM);
  return {
    ccys,
    mu,
    pin,
    dir,
    kVar,
    k,
    result: {
      wUsdM,
      carryUsdYrM: overlayCarryUsdYrM(ccys, mu, wUsdM, basesFcy, rOd, r_USD),
      varUsdM,
      varBinding: !carryBinding && varUsdM >= cap - 1e-6 && cap > 1e-9,
      carryBinding,
      // The bisection above can only ADD risk (k ≥ 0) — it has no lever to
      // reduce risk that already exists at k=0 (the fixed standalone
      // exposure). If varUsdM is still above cap here, that risk was there
      // before any overlay decision — a real base-book breach, not
      // something this solve failed to size correctly.
      capBreachedAtZeroOverlay: varUsdM > cap + 1e-6,
    },
  };
}

export function allocateCarryVarUsd(input: CarryVarAllocInput): CarryVarAllocResult | null {
  return solveCarryVarUsd(input)?.result ?? null;
}

/** Book-size proxy for overlay leverage. Do not floor cash+payout at 0 — PAY names go to 0 and drop out. */
export function overlayBookBaseFcyM(row: {
  cash: number;
  payout: number;
  carry_target?: number | null;
}): number {
  return Math.max(
    Math.abs(row.cash),
    Math.abs(row.payout),
    Math.abs(row.cash + row.payout),
    Math.abs(row.carry_target ?? 0),
  );
}

function overlaySide(usdM: number): OverlaySide {
  if (usdM > 0.02) return 'long';
  if (usdM < -0.02) return 'short';
  return 'flat';
}

function legsFromUsd(
  ccys: readonly string[],
  mu: readonly number[],
  wUsdM: readonly number[],
  basesFcy?: readonly number[],
  rOd?: readonly number[],
  r_USD?: number,
): EfficientCarryLeg[] {
  // Component VAR needs the FULL overlay vector at once — it's an Euler
  // allocation of the correlated portfolio VAR, not something computable
  // leg-by-leg in isolation.
  const componentVarByCcy: Record<string, number> = Object.fromEntries(
    computePortfolioVAR(
      ccys.map((ccy, i) => {
        const spot = CURRENCY_PARAMS[ccy]?.spot ?? 1;
        return { ccy, cashFCY: spot > 1e-12 ? wUsdM[i]! / spot : 0 };
      }),
    ).currencies.map(c => [c.ccy, c.component_VAR_USD]),
  );
  return ccys.map((ccy, i) => {
    const usdM = wUsdM[i]!;
    const spot = CURRENCY_PARAMS[ccy]?.spot ?? 1;
    const fcyM = spot > 1e-12 ? usdM / spot : 0;
    const finalFcy = (basesFcy?.[i] ?? 0) + fcyM;
    return {
      ccy,
      mu: mu[i]!,
      componentVarUsdM: componentVarByCcy[ccy] ?? 0,
      usdM,
      fcyM,
      side: overlaySide(usdM),
      carryUsdYrM: usdM * legCarryRate(mu[i]!, finalFcy, rOd?.[i], r_USD),
    };
  }).sort((a, b) => Math.abs(b.usdM) - Math.abs(a.usdM));
}

/**
 * Σ⁻¹μ ray at fraction `t` of the Policy VAR fill (t = 0 hold, t = 1 cap).
 * Weights are linear on the ray; component VAR is recomputed at the scaled book.
 */
export function scaleOverlayLegs(
  legs: readonly EfficientCarryLeg[],
  t: number,
): EfficientCarryLeg[] {
  const s = Number.isFinite(t) ? Math.max(0, t) : 0;
  if (legs.length === 0) return [];
  if (Math.abs(s - 1) < 1e-12) return [...legs];
  const ccys = legs.map(l => l.ccy);
  const wUsdM = legs.map(l => l.usdM * s);
  const varByCcy = new Map(
    legsFromUsd(ccys, legs.map(l => l.mu), wUsdM).map(l => [l.ccy, l.componentVarUsdM] as const),
  );
  return legs.map(l => {
    const usdM = l.usdM * s;
    return {
      ...l,
      usdM,
      fcyM: l.fcyM * s,
      carryUsdYrM: l.carryUsdYrM * s,
      componentVarUsdM: varByCcy.get(l.ccy) ?? l.componentVarUsdM * s,
      side: overlaySide(usdM),
    };
  });
}

/**
 * Sample the Σ⁻¹μ ray from pin-only (t=0) through the Policy VAR fill (t=1).
 * The sweet spot is the VAR fill, or a feasible shared earn ask on that ray.
 */
export function buildEfficientCarryVarFrontier(
  input: CarryVarAllocInput,
): EfficientCarryVarFrontier | null {
  const solved = solveCarryVarUsd(input);
  if (!solved) return null;
  const { pin, dir, kVar, k, result, ccys, mu } = solved;
  const { basesFcy, rOd, r_USD, fixedCfarUsdM } = input;
  const pointAt = (scale: number, t: number): EfficientRayPoint => {
    const w = addScaled(pin, dir, scale);
    return {
      t,
      carryUsdYrM: overlayCarryUsdYrM(ccys, mu, w, basesFcy, rOd, r_USD),
      varUsdM: overlayVarUsdM(ccys, w, fixedCfarUsdM),
    };
  };
  const capPt = kVar > 0 ? pointAt(kVar, 1) : pointAt(0, 1);
  const sweetT = kVar > 1e-12 ? k / kVar : 0;
  const ts = new Set<number>([0, 1, Math.min(1, Math.max(0, sweetT))]);
  for (let i = 1; i <= 7; i++) ts.add(i / 8);
  const ray = [...ts]
    .sort((a, b) => a - b)
    .map(t => pointAt(t * kVar, t));
  const capW = addScaled(pin, dir, kVar);
  const legs = legsFromUsd(ccys, mu, result.wUsdM, basesFcy, rOd, r_USD);
  const capLegs = legsFromUsd(ccys, mu, capW, basesFcy, rOd, r_USD);

  return {
    ray,
    varCapUsdM: input.varCapUsdM,
    sweet: {
      t: sweetT,
      carryUsdYrM: result.carryUsdYrM,
      varUsdM: result.varUsdM,
      varBinding: result.varBinding,
      carryBinding: result.carryBinding,
      capBreachedAtZeroOverlay: result.capBreachedAtZeroOverlay,
    },
    cap: capPt,
    legs,
    capLegs,
    carryTargetUsdYrM: input.carryTargetUsdYrM,
  };
}

/** Signed L1 share: w_i / Σ|w_j|. Abs shares sum to 1. */
export function l1Weights(values: readonly number[]): number[] {
  const den = values.reduce((s, v) => s + Math.abs(v), 0);
  if (!(den > 1e-12)) return values.map(() => 0);
  return values.map(v => v / den);
}

export interface OverlayStripJoinRow {
  ccy: string;
  mu: number;
  side: OverlaySide;
  /** Overlay USD at the sweet (H* − hold). */
  overlayUsdM: number;
  overlayFcyM: number;
  /** Carry on the overlay leg — credit/debit-split when the leg supplied it. Read this, not mu×overlayUsdM. */
  overlayCarryUsdYrM: number;
  /** This leg's signed share of the overlay's diversified VAR — see EfficientCarryLeg.componentVarUsdM. Not overlayUsdM's own standalone VAR. */
  overlayComponentVarUsdM: number;
  overlayWeight: number;
  bookNow: number;
  outstanding: number;
  /** Swap-book USD (outstanding, else book-now) × spot. */
  stripUsdM: number;
  stripWeight: number;
}

/**
 * Join Σ⁻¹μ sweet overlay legs with one regime's funding-swap strip.
 * Overlay is the discretionary mix. Strip is the swap that funds H* — it
 * also covers hold/trough, so the two weight vectors are not required to
 * match; the join is so the desk can see both on the same CCY list.
 */
export function joinOverlayStripWeights(
  legs: readonly EfficientCarryLeg[],
  strips: readonly {
    ccy: string;
    bookNow: number;
    outstanding: number;
  }[],
): OverlayStripJoinRow[] {
  const legByCcy = new Map(legs.map(l => [l.ccy, l]));
  const seen = new Set<string>();
  const ccys: string[] = [];
  for (const l of legs) {
    if (seen.has(l.ccy)) continue;
    seen.add(l.ccy);
    ccys.push(l.ccy);
  }
  for (const s of strips) {
    if (seen.has(s.ccy)) continue;
    seen.add(s.ccy);
    ccys.push(s.ccy);
  }
  const stripByCcy = new Map(strips.map(s => [s.ccy, s]));
  const overlayUsd = ccys.map(c => legByCcy.get(c)?.usdM ?? 0);
  const stripUsd = ccys.map(c => {
    const s = stripByCcy.get(c);
    if (!s) return 0;
    const fcy = Math.abs(s.outstanding) > 0.001 ? s.outstanding : s.bookNow;
    const spot = CURRENCY_PARAMS[c]?.spot ?? 1;
    return fcy * spot;
  });
  const overlayW = l1Weights(overlayUsd);
  const stripW = l1Weights(stripUsd);
  return ccys.map((ccy, i) => {
    const leg = legByCcy.get(ccy);
    const s = stripByCcy.get(ccy);
    const usdM = overlayUsd[i]!;
    return {
      ccy,
      mu: leg?.mu ?? 0,
      side: leg?.side ?? overlaySide(usdM),
      overlayUsdM: usdM,
      overlayFcyM: leg?.fcyM ?? 0,
      overlayCarryUsdYrM: leg?.carryUsdYrM ?? (leg?.mu ?? 0) * usdM,
      overlayComponentVarUsdM: leg?.componentVarUsdM ?? 0,
      overlayWeight: overlayW[i]!,
      bookNow: s?.bookNow ?? 0,
      outstanding: s?.outstanding ?? 0,
      stripUsdM: stripUsd[i]!,
      stripWeight: stripW[i]!,
    };
  }).sort((a, b) =>
    Math.max(Math.abs(b.overlayUsdM), Math.abs(b.stripUsdM))
    - Math.max(Math.abs(a.overlayUsdM), Math.abs(a.stripUsdM))
  );
}
