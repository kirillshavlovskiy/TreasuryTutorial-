import { describe, it, expect } from 'vitest';
import { CURRENCY_PARAMS, computePortfolioVAR, optimizePortfolioCarry } from '@/lib/fx-buffer';
import { DEFAULT_EURUSD_MARKET_RATES, impliedCarryRatePct } from '@/lib/fx-market-rates';
import {
  allocateCarryVarUsd,
  buildEfficientCarryVarFrontier,
  joinOverlayStripWeights,
  overlayBookBaseFcyM,
  scaleOverlayLegs,
} from '@/lib/portfolio-alloc';

describe('allocateCarryVarUsd', () => {
  it('fills shared VAR on the Σ⁻¹μ ray (long earn, short pay)', () => {
    const r_USD = 3.5;
    const ccys = ['CAD', 'MXN', 'GBP'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const alloc = allocateCarryVarUsd({ ccys, mu, varCapUsdM: 5 });
    expect(alloc).not.toBeNull();
    // CAD and MXN both hit the MAX_LEG_LEVERAGE ceiling (3x the $5M cap =
    // $15M) before the correlated portfolio VAR reaches $5M — see
    // solveCarryVarUsd's per-coordinate leverage rescale.
    expect(alloc!.varBinding).toBe(false);
    expect(alloc!.varUsdM).toBeLessThan(5);
    expect(alloc!.wUsdM[ccys.indexOf('CAD')]).toBeCloseTo(-15, 5);
    expect(alloc!.wUsdM[ccys.indexOf('MXN')]).toBeCloseTo(15, 5);
    expect(alloc!.carryUsdYrM).toBeGreaterThan(0);
  });

  it('a feasible shared carry target does not spend the whole VAR budget', () => {
    const r_USD = 3.5;
    const ccys = ['CAD', 'MXN'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const filled = allocateCarryVarUsd({ ccys, mu, varCapUsdM: 10 })!;
    const modest = filled.carryUsdYrM * 0.25;
    const hit = allocateCarryVarUsd({
      ccys, mu, varCapUsdM: 10, carryTargetUsdYrM: modest,
    })!;
    expect(hit.carryBinding).toBe(true);
    expect(hit.varBinding).toBe(false);
    expect(hit.varUsdM).toBeLessThan(filled.varUsdM - 0.5);
    expect(hit.carryUsdYrM).toBeCloseTo(modest, 3);
  });

  it('both legs clip to the leverage ceiling when the pair diversifies this aggressively', () => {
    const r_USD = 3.5;
    const ccys = ['EUR', 'JPY'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const alloc = allocateCarryVarUsd({ ccys, mu, varCapUsdM: 5 })!;
    const eurUsd = alloc.wUsdM[0]!;
    const jpyUsd = alloc.wUsdM[1]!;
    // Both pay vs USD NP — shorts. EUR/JPY diversify each other so strongly
    // (ρ=-0.15) that the unconstrained Σ⁻¹μ ray would need each leg far
    // beyond a sane notional to fill just $5M of correlated VAR —
    // MAX_LEG_LEVERAGE clips both to the SAME ceiling (3x cap = $15M)
    // before that happens, which is why they land on identical magnitudes
    // here rather than differentiated ones.
    expect(eurUsd).toBeLessThan(0);
    expect(jpyUsd).toBeLessThan(0);
    expect(Math.abs(eurUsd)).toBeCloseTo(15, 5);
    expect(Math.abs(jpyUsd)).toBeCloseTo(15, 5);
  });
});

describe('buildEfficientCarryVarFrontier', () => {
  const r_USD = 3.5;
  const ccys = ['EUR', 'GBP', 'MXN'] as const;
  const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);

  it('puts the sweet spot on the Policy VAR fill when there is no earn ask', () => {
    const fr = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 5 });
    expect(fr).not.toBeNull();
    // EUR hits the MAX_LEG_LEVERAGE ceiling before the correlated portfolio
    // VAR reaches $5M — see the matching note in allocateCarryVarUsd's
    // test. t stays 1 (the ray still stops at kVar); only varBinding and
    // the VAR magnitude change.
    expect(fr!.sweet.varBinding).toBe(false);
    expect(fr!.sweet.carryBinding).toBe(false);
    expect(fr!.sweet.varUsdM).toBeLessThan(5);
    expect(fr!.sweet.t).toBeCloseTo(1, 5);
    expect(fr!.ray[0]!.varUsdM).toBeLessThan(0.05);
    expect(fr!.ray[fr!.ray.length - 1]!.varUsdM).toBeCloseTo(fr!.sweet.varUsdM, 2);
  });

  it('shorts PAY names and longs EARN names (EUR vs MXN at r_USD = 3.5)', () => {
    const fr = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 5 })!;
    const eur = fr.legs.find(l => l.ccy === 'EUR')!;
    const mxn = fr.legs.find(l => l.ccy === 'MXN')!;
    expect(eur.mu).toBeLessThan(0);
    expect(mxn.mu).toBeGreaterThan(0);
    expect(eur.side).toBe('short');
    expect(mxn.side).toBe('long');
  });

  it('walks the earn ask onto the same ray below the VAR cap', () => {
    const filled = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 10 })!;
    const modest = filled.sweet.carryUsdYrM * 0.25;
    const fr = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 10, carryTargetUsdYrM: modest,
    })!;
    expect(fr.sweet.carryBinding).toBe(true);
    expect(fr.sweet.varBinding).toBe(false);
    expect(fr.sweet.carryUsdYrM).toBeCloseTo(modest, 3);
    expect(fr.sweet.varUsdM).toBeLessThan(filled.sweet.varUsdM - 0.5);
    expect(fr.sweet.t).toBeGreaterThan(0.1);
    expect(fr.sweet.t).toBeLessThan(0.9);
    expect(fr.capLegs).toHaveLength(fr.legs.length);
    const mxnCap = fr.capLegs.find(l => l.ccy === 'MXN')!;
    const mxnSweet = fr.legs.find(l => l.ccy === 'MXN')!;
    expect(Math.abs(mxnCap.usdM)).toBeGreaterThan(Math.abs(mxnSweet.usdM) * 1.5);
  });

  it('EURUSD CIP premium shorts EUR; GBP is not dragged short with it', () => {
    const rEur = impliedCarryRatePct(DEFAULT_EURUSD_MARKET_RATES, 1, 0, r_USD)!;
    const mixCcys = ['EUR', 'GBP', 'PLN'] as const;
    const mixMu = [
      (rEur - r_USD) / 100,
      (CURRENCY_PARAMS.GBP!.carry - r_USD) / 100,
      (CURRENCY_PARAMS.PLN!.carry - r_USD) / 100,
    ];
    const fr = buildEfficientCarryVarFrontier({
      ccys: mixCcys, mu: mixMu, varCapUsdM: 5,
    })!;
    const eur = fr.legs.find(l => l.ccy === 'EUR')!;
    const gbp = fr.legs.find(l => l.ccy === 'GBP')!;
    expect(eur.mu).toBeLessThan(0);
    expect(eur.side).toBe('short');
    expect(gbp.side).toBe('long');
  });
});

describe('buildEfficientCarryVarFrontier — credit/debit split and fixed CFaR', () => {
  const r_USD = 3.5;
  const ccys = ['EUR', 'GBP', 'MXN'] as const;
  const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);

  it('omitting basesFcy/rOd/r_USD/fixedCfarUsdM reproduces the old flat-rate, pure-ray behavior exactly', () => {
    const withNew = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 5 })!;
    // Same call, explicit zeros/undefined — must match byte-for-byte.
    // basesFcy itself is NOT included here: an explicit [0,0,0] is now
    // meaningfully different from omitting it entirely — it tells the
    // MAX_BASE_MULTIPLE leverage ceiling "this currency's real book is
    // known to be zero," which correctly bounds its overlay near zero
    // rather than falling back to the old base-agnostic cap×3 ceiling. Only
    // a genuinely omitted basesFcy reproduces the pure flat-rate behavior.
    const explicit = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 5,
      rOd: [0, 0, 0], r_USD: undefined, fixedCfarUsdM: [0, 0, 0],
    })!;
    expect(explicit.sweet.carryUsdYrM).toBeCloseTo(withNew.sweet.carryUsdYrM, 9);
    expect(explicit.sweet.varUsdM).toBeCloseTo(withNew.sweet.varUsdM, 9);
    explicit.legs.forEach((leg, i) => {
      expect(leg.carryUsdYrM).toBeCloseTo(leg.mu * leg.usdM, 9);
      expect(leg.usdM).toBeCloseTo(withNew.legs[i]!.usdM, 9);
    });
  });

  it('a real EUR base position crossing zero puts a genuine kink in leg carry vs. flat μ×usdM', () => {
    // EUR base of 30M FCY, sold down by the overlay — same mechanism proven
    // in fx-buffer.test.ts for sweepPortfolioCarryFrontier, here for the
    // actual overlay legs the Book's SweetStripSplit table reads.
    const rOd = ccys.map(c => CURRENCY_PARAMS[c]!.r_OD);
    const basesFcy = ccys.map(c => (c === 'EUR' ? 30 : 0));
    const fr = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 20, basesFcy, rOd, r_USD,
    })!;
    const eur = fr.legs.find(l => l.ccy === 'EUR')!;
    expect(eur.side).toBe('short'); // EUR is the natural PAY name here, sold to fund MXN/GBP
    const flatCarry = eur.mu * eur.usdM;
    // Once EUR's final position (30 + fcyM) has crossed below zero, its leg
    // is priced at the (worse) overdraft rate, not μ — the two must differ.
    const finalFcy = 30 + eur.fcyM;
    if (finalFcy < 0) {
      expect(eur.carryUsdYrM).not.toBeCloseTo(flatCarry, 6);
      const muDebit = (CURRENCY_PARAMS.EUR!.r_OD - r_USD) / 100;
      expect(eur.carryUsdYrM).toBeCloseTo(eur.usdM * muDebit, 6);
    }
  });

  it('scaleOverlayLegs is the Policy VAR fill at t=1 and half the notionals at t=½', () => {
    const fr = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 10 })!;
    const full = scaleOverlayLegs(fr.capLegs, 1);
    const half = scaleOverlayLegs(fr.capLegs, 0.5);
    const zero = scaleOverlayLegs(fr.capLegs, 0);
    expect(full[0]!.usdM).toBeCloseTo(fr.capLegs[0]!.usdM, 8);
    expect(half[0]!.usdM).toBeCloseTo(fr.capLegs[0]!.usdM * 0.5, 8);
    expect(zero.every(l => Math.abs(l.usdM) < 1e-12)).toBe(true);
  });

  it('fixedCfarUsdM makes pin-only VAR the RSS of the fixed CFaRs, not zero', () => {
    const fixedCfarUsdM = [4, 0, 3]; // EUR, GBP, MXN
    const fr = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 20, pinnedUsdM: [0, 0, 0], fixedCfarUsdM,
    })!;
    // t=0 point is pin-only (no overlay) — VAR there must be exactly the
    // RSS of the fixed terms: sqrt(4^2+3^2) = 5.
    const originPt = fr.ray.find(p => p.t === 0)!;
    expect(originPt.varUsdM).toBeCloseTo(5, 6);
  });

  it('fixedCfarUsdM flattens the VAR slope near the origin — the same hyperbola shape as the per-currency model', () => {
    const fixedCfarUsdM = [6, 0, 0];
    const fr = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 20, fixedCfarUsdM })!;
    const byT = (t: number) => fr.ray.reduce((best, p) => (
      Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best
    ));
    const near = byT(0.125);
    const far = byT(1);
    const slopeNear = near.varUsdM / Math.max(near.t, 1e-9);
    const slopeFar = far.varUsdM / far.t;
    expect(slopeNear).toBeGreaterThan(slopeFar);
  });
});

describe('buildEfficientCarryVarFrontier — floorFcy (desk min-floor)', () => {
  const r_USD = 3.5;
  const ccys = ['EUR', 'GBP', 'MXN'] as const;
  const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
  const rOd = ccys.map(c => CURRENCY_PARAMS[c]!.r_OD);
  const basesFcy = ccys.map(c => (c === 'EUR' ? 30 : 0));

  it('without a floor, EUR is sold down (short) same as the credit/debit-split test', () => {
    const fr = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 20, basesFcy, rOd, r_USD,
    })!;
    const eur = fr.legs.find(l => l.ccy === 'EUR')!;
    const finalFcy = 30 + eur.fcyM;
    expect(finalFcy).toBeLessThan(30);
  });

  it('a floor above the unconstrained final position pulls the overlay up to hit it exactly', () => {
    const unconstrained = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 20, basesFcy, rOd, r_USD,
    })!;
    const eurBefore = unconstrained.legs.find(l => l.ccy === 'EUR')!;
    const finalBefore = 30 + eurBefore.fcyM;
    // EUR is the natural PAY name here and gets sold deeply short
    // unconstrained (see the credit/debit-split test) — a realistic desk
    // floor (cash_floor is always ≥0 in this domain, never a negative
    // minimum) sits well above that.
    expect(finalBefore).toBeLessThan(0);

    const floorFcy = [10, 0, 0];
    const floored = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 20, basesFcy, rOd, r_USD, floorFcy,
    })!;
    const eurAfter = floored.legs.find(l => l.ccy === 'EUR')!;
    const finalAfter = 30 + eurAfter.fcyM;
    expect(finalAfter).toBeGreaterThan(finalBefore);
    expect(finalAfter).toBeCloseTo(floorFcy[0]!, 6);
  });

  it('a floor already satisfied by the unconstrained solve is a no-op', () => {
    // MXN is the natural big EARN name here — it goes long unconstrained
    // (see the sign-flip discussion elsewhere), so a small positive floor
    // is already satisfied without the clip ever engaging.
    const unconstrained = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 20, basesFcy, rOd, r_USD,
    })!;
    const mxnBefore = unconstrained.legs.find(l => l.ccy === 'MXN')!;
    expect(mxnBefore.fcyM).toBeGreaterThan(1);

    const floorFcy = [0, 0, 0.5];
    const floored = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 20, basesFcy, rOd, r_USD, floorFcy,
    })!;
    const mxnAfter = floored.legs.find(l => l.ccy === 'MXN')!;
    expect(mxnAfter.usdM).toBeCloseTo(mxnBefore.usdM, 6);
  });

  it('floorFcy without basesFcy is ignored — a floor needs a base to measure the final position against', () => {
    const withFloor = buildEfficientCarryVarFrontier({
      ccys, mu, varCapUsdM: 20, r_USD, floorFcy: [1000, 0, 0],
    })!;
    const bare = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 20, r_USD })!;
    withFloor.legs.forEach((leg, i) => {
      expect(leg.usdM).toBeCloseTo(bare.legs[i]!.usdM, 6);
    });
  });
});

describe('joinOverlayStripWeights — overlayCarryUsdYrM sources from the leg, not a UI recompute', () => {
  it('reads the leg\'s own carryUsdYrM even when it differs from mu×usdM', () => {
    const joined = joinOverlayStripWeights(
      [{ ccy: 'EUR', mu: -0.02, usdM: 5, fcyM: 4, side: 'long', carryUsdYrM: 0.99, componentVarUsdM: 0.5 }],
      [{ ccy: 'EUR', bookNow: 0, outstanding: 0 }],
    );
    const eur = joined.find(r => r.ccy === 'EUR')!;
    expect(eur.overlayCarryUsdYrM).toBe(0.99);
    expect(eur.overlayCarryUsdYrM).not.toBeCloseTo(-0.02 * 5, 6);
  });

  it('falls back to mu×usdM only when there is no matching leg at all', () => {
    const joined = joinOverlayStripWeights(
      [],
      [{ ccy: 'EUR', bookNow: 2, outstanding: 2 }],
    );
    const eur = joined.find(r => r.ccy === 'EUR')!;
    expect(eur.overlayCarryUsdYrM).toBe(0);
  });
});

describe('optimizePortfolioCarry mean-variance mix', () => {
  const r_USD = 3.5;
  const σ_P = 0.10;
  const mk = (ccy: string, lp: number) => {
    const p = CURRENCY_PARAMS[ccy]!;
    return {
      ccy, P: 0, lp_cash: lp, P_contrib: 0, forecasted_cash: lp,
      floor_contrib: 0, delta_sigma: 0, r_FCY: p.carry, r_OD: p.r_OD,
    };
  };

  it('CAD/MXN overlays still sell PAY and buy EARN, bounded by leverage before the VAR cap', () => {
    const res = optimizePortfolioCarry([mk('CAD', 95.1), mk('MXN', 238)], σ_P, r_USD, 5);
    const cad = res.find(r => r.ccy === 'CAD')!;
    const mxn = res.find(r => r.ccy === 'MXN')!;
    expect(cad.delta_portfolio).toBeLessThan(0);
    expect(mxn.delta_portfolio).toBeGreaterThan(0);
    const overlayVar = computePortfolioVAR([
      { ccy: 'CAD', cashFCY: cad.delta_portfolio },
      { ccy: 'MXN', cashFCY: mxn.delta_portfolio },
    ]).portfolio_VAR_USD;
    // CAD/MXN are only moderately correlated (0.52) — filling the full $5M
    // of correlated VAR used to require CAD/MXN notional in the hundreds of
    // millions. MAX_LEG_LEVERAGE now caps that leg-by-leg before VAR gets
    // anywhere near the limit, so overlayVar lands well under the cap —
    // this is the leverage ceiling binding, not a VAR fill. See
    // solveCarryVarUsd.
    expect(overlayVar).toBeLessThan(1);
    expect(overlayVar).toBeGreaterThan(0.5);
  });
});

describe('joinOverlayStripWeights', () => {
  it('reports L1 overlay mix and swap-book mix on the same CCY list', () => {
    const joined = joinOverlayStripWeights(
      [
        { ccy: 'EUR', mu: -0.01, usdM: 2, fcyM: 2 / 1.1, side: 'long', carryUsdYrM: -0.01 * 2, componentVarUsdM: 0.3 },
        { ccy: 'GBP', mu: 0.02, usdM: -1, fcyM: -1 / 1.3, side: 'short', carryUsdYrM: 0.02 * -1, componentVarUsdM: -0.1 },
      ],
      [
        { ccy: 'EUR', bookNow: -2.5, outstanding: -2.5 },
        { ccy: 'GBP', bookNow: 1.0, outstanding: 1.0 },
      ],
    );
    expect(joined).toHaveLength(2);
    const eur = joined.find(r => r.ccy === 'EUR')!;
    const gbp = joined.find(r => r.ccy === 'GBP')!;
    expect(eur.overlayWeight).toBeCloseTo(2 / 3, 9);
    expect(gbp.overlayWeight).toBeCloseTo(-1 / 3, 9);
    expect(Math.abs(eur.stripWeight) + Math.abs(gbp.stripWeight)).toBeCloseTo(1, 9);
    expect(eur.overlayWeight + gbp.overlayWeight).toBeCloseTo(1 / 3, 9);
  });

  it('keeps a book name with $0 overlay and $0 CFaR strip so untick does not drop it', () => {
    const joined = joinOverlayStripWeights(
      [{ ccy: 'EUR', mu: -0.01, usdM: 3, fcyM: 3 / 1.1, side: 'long', carryUsdYrM: -0.03, componentVarUsdM: 0.4 }],
      [
        { ccy: 'EUR', bookNow: -2.5, outstanding: -2.5 },
        { ccy: 'GBP', bookNow: 0, outstanding: 0 },
      ],
    );
    expect(joined.map(r => r.ccy).sort()).toEqual(['EUR', 'GBP']);
    const gbp = joined.find(r => r.ccy === 'GBP')!;
    expect(gbp.overlayUsdM).toBe(0);
    expect(gbp.overlayWeight).toBe(0);
    expect(gbp.stripUsdM).toBe(0);
  });

  it('still splits the strip when there is no overlay mix', () => {
    const joined = joinOverlayStripWeights(
      [],
      [
        { ccy: 'EUR', bookNow: -4, outstanding: -4 },
        { ccy: 'GBP', bookNow: 4, outstanding: 4 },
      ],
    );
    expect(joined.every(r => r.overlayWeight === 0)).toBe(true);
    expect(joined.reduce((s, r) => s + Math.abs(r.stripWeight), 0)).toBeCloseTo(1, 9);
  });
});

describe('overlayBookBaseFcyM', () => {
  it('does not floor a PAY trough at 0', () => {
    expect(overlayBookBaseFcyM({ cash: 10, payout: -40 })).toBeCloseTo(40, 10);
    expect(overlayBookBaseFcyM({ cash: 20, payout: -8 })).toBeCloseTo(20, 10);
  });
});

describe('allocateCarryVarUsd — zero trough does not drop a name', () => {
  it('keeps PLN and GBP in the mix when cash+payout is 0', () => {
    const r_USD = 4.5;
    const ccys = ['EUR', 'GBP', 'PLN'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const basesFcy = [5, 0, 0];
    const alloc = allocateCarryVarUsd({
      ccys, mu, varCapUsdM: 20, basesFcy,
      rOd: ccys.map(c => CURRENCY_PARAMS[c]!.r_OD),
      r_USD,
    })!;
    const gbp = alloc.wUsdM[ccys.indexOf('GBP')]!;
    const pln = alloc.wUsdM[ccys.indexOf('PLN')]!;
    expect(Math.abs(gbp) + Math.abs(pln)).toBeGreaterThan(1);
  });
});
