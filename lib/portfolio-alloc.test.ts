import { describe, it, expect } from 'vitest';
import { CURRENCY_PARAMS, computePortfolioVAR, optimizePortfolioCarry } from '@/lib/fx-buffer';
import { DEFAULT_EURUSD_MARKET_RATES, impliedCarryRatePct } from '@/lib/fx-market-rates';
import {
  allocateCarryVarUsd,
  buildEfficientCarryVarFrontier,
  joinOverlayStripWeights,
  l1Weights,
  overlayBookBaseFcyM,
  overlayLegCarryAtUsd,
  scaleOverlayLegs,
  type EfficientCarryLeg,
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

  it('an ask above the 3× fill binds on the same ray once per-name leverage is raised', () => {
    const r_USD = 3.5;
    const ccys = ['EUR', 'PLN'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const at3 = allocateCarryVarUsd({ ccys, mu, varCapUsdM: 11.6 })!;
    const ask = at3.carryUsdYrM * 2.4;
    expect(ask).toBeGreaterThan(at3.carryUsdYrM + 0.05);
    const blocked = allocateCarryVarUsd({
      ccys, mu, varCapUsdM: 11.6, carryTargetUsdYrM: ask,
    })!;
    expect(blocked.carryBinding).toBe(false);
    const hit = allocateCarryVarUsd({
      ccys, mu, varCapUsdM: 11.6, carryTargetUsdYrM: ask, maxLegLeverage: 12,
    })!;
    expect(hit.carryBinding).toBe(true);
    expect(hit.carryUsdYrM).toBeCloseTo(ask, 3);
    expect(Math.abs(hit.wUsdM[0]!)).toBeGreaterThan(Math.abs(at3.wUsdM[0]!) + 1);
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

  it('a deeper PAY short past zero can earn less — scale t does not linearly copy cap carry', () => {
    const r_USD = 2.0;
    const eurMu = (CURRENCY_PARAMS.EUR!.carry - r_USD) / 100;
    const rOd = CURRENCY_PARAMS.EUR!.r_OD;
    const spot = CURRENCY_PARAMS.EUR!.spot;
    const baseFcy = 2.54;
    const midFcy = -2.00;
    const capFcy = -4.15;
    const midUsd = midFcy * spot;
    const capUsd = capFcy * spot;
    expect(eurMu).toBeLessThan(0);
    expect(rOd).toBeGreaterThan(r_USD);
    expect(baseFcy + midFcy).toBeGreaterThan(0);
    expect(baseFcy + capFcy).toBeLessThan(0);
    const cap: EfficientCarryLeg = {
      ccy: 'EUR',
      mu: eurMu,
      usdM: capUsd,
      fcyM: capFcy,
      side: 'short',
      carryUsdYrM: capUsd * (rOd - r_USD) / 100,
      componentVarUsdM: 5,
      baseFcyM: baseFcy,
      rOdPct: rOd,
      rUsdPct: r_USD,
    };
    const mid = scaleOverlayLegs([cap], midUsd / capUsd)[0]!;
    expect(mid.usdM).toBeCloseTo(midUsd, 6);
    expect(mid.carryUsdYrM).toBeCloseTo(midUsd * eurMu, 6);
    expect(mid.carryUsdYrM).toBeGreaterThan(cap.carryUsdYrM * (midUsd / capUsd));
    expect(mid.carryUsdYrM).toBeGreaterThan(cap.carryUsdYrM);
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

  it('Strip w% follows live outstanding sign — not scenario Book S', () => {
    const joined = joinOverlayStripWeights(
      [{
        ccy: 'EUR', mu: -0.01, usdM: -55.5, fcyM: -47.43, side: 'short',
        carryUsdYrM: 0.716, componentVarUsdM: 1.8,
      }],
      [{ ccy: 'EUR', bookNow: -36.74, outstanding: -23.51 }],
    );
    const eur = joined.find(r => r.ccy === 'EUR')!;
    expect(eur.overlayFcyM).toBeCloseTo(-47.43, 2);
    expect(eur.outstanding).toBeCloseTo(-23.51, 2);
    expect(eur.stripWeight).toBeLessThan(0);
    expect(eur.overlayWeight).toBeLessThan(0);
  });
});

describe('overlayBookBaseFcyM', () => {
  it('does not floor a PAY trough at 0', () => {
    expect(overlayBookBaseFcyM({ cash: 10, payout: -40 })).toBeCloseTo(40, 10);
    expect(overlayBookBaseFcyM({ cash: 20, payout: -8 })).toBeCloseTo(20, 10);
  });

  it('counts the unhedged FX book and the cash floor as buffer', () => {
    expect(overlayBookBaseFcyM({
      cash: 1.26, payout: 0, cash_floor: 0.4, fxExposureM: -8.2,
    })).toBeCloseTo(8.2, 10);
  });
});

describe('allocateCarryVarUsd — PAY harvest is not clipped to 2× cash', () => {
  it('lets a short EUR PAY exceed 2× a 1.26M cash buffer', () => {
    const r_USD = 4.5;
    const eur = CURRENCY_PARAMS.EUR!;
    const mu = (eur.carry - r_USD) / 100;
    const alloc = allocateCarryVarUsd({
      ccys: ['EUR'],
      mu: [mu],
      varCapUsdM: 10.6,
      basesFcy: [1.26],
      rOd: [eur.r_OD],
      r_USD,
    })!;
    const usd = alloc.wUsdM[0]!;
    const twoXCashUsd = 1.26 * eur.spot * 2;
    expect(usd).toBeLessThan(0);
    expect(Math.abs(usd)).toBeGreaterThan(twoXCashUsd + 0.5);
    expect(Math.abs(usd)).toBeLessThanOrEqual(10.6 * 3 + 1e-6);
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

  it('does not harvest a dust-μ empty book to 3×VAR', () => {
    const alloc = allocateCarryVarUsd({
      ccys: ['EUR', 'GBP'],
      mu: [-0.015, 0.00003],
      varCapUsdM: 12,
      basesFcy: [3.7, 0],
      rOd: [CURRENCY_PARAMS.EUR!.r_OD, CURRENCY_PARAMS.GBP!.r_OD],
      r_USD: 3.5,
    })!;
    const gbp = alloc.wUsdM[1]!;
    expect(Math.abs(gbp)).toBeLessThan(0.05);
    expect(Math.abs(alloc.wUsdM[0]!)).toBeGreaterThan(1);
  });
});

describe('allocation invariants — mix, VAR, and the PAY kink', () => {
  const rUsdPay = 2.0;
  const eur = CURRENCY_PARAMS.EUR!;
  const pln = CURRENCY_PARAMS.PLN!;

  function payKinkCap(): EfficientCarryLeg {
    const mu = (eur.carry - rUsdPay) / 100;
    const capFcy = -4.15;
    const capUsd = capFcy * eur.spot;
    return {
      ccy: 'EUR',
      mu,
      usdM: capUsd,
      fcyM: capFcy,
      side: 'short',
      carryUsdYrM: capUsd * (eur.r_OD - rUsdPay) / 100,
      componentVarUsdM: 5.5,
      baseFcyM: 2.54,
      rOdPct: eur.r_OD,
      rUsdPct: rUsdPay,
    };
  }

  it('a single PAY name is 100% short and L1 mix is ±1', () => {
    const mu = (eur.carry - 4.5) / 100;
    const fr = buildEfficientCarryVarFrontier({
      ccys: ['EUR'], mu: [mu], varCapUsdM: 10,
    })!;
    expect(fr.capLegs).toHaveLength(1);
    expect(fr.capLegs[0]!.side).toBe('short');
    const w = l1Weights(fr.capLegs.map(l => l.usdM));
    expect(w[0]).toBeCloseTo(-1, 8);
  });

  it('the ray keeps a constant mix — t only scales notionals', () => {
    const r_USD = 3.5;
    const ccys = ['EUR', 'MXN'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const fr = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 10 })!;
    const half = scaleOverlayLegs(fr.capLegs, 0.5);
    const cap = new Map(fr.capLegs.map(l => [l.ccy, l.usdM] as const));
    for (const l of half) {
      expect(l.usdM).toBeCloseTo(cap.get(l.ccy)! * 0.5, 6);
    }
    const wCap = l1Weights(fr.capLegs.map(l => l.usdM));
    const wHalf = l1Weights(half.map(l => l.usdM));
    wCap.forEach((w, i) => expect(w).toBeCloseTo(wHalf[i]!, 8));
  });

  it('overlay VAR is monotone along the ray (more t, not less risk)', () => {
    const r_USD = 3.5;
    const ccys = ['EUR', 'PLN'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const fr = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 16.7 })!;
    for (let i = 1; i < fr.ray.length; i++) {
      expect(fr.ray[i]!.varUsdM).toBeGreaterThanOrEqual(fr.ray[i - 1]!.varUsdM - 1e-9);
    }
  });

  it('dropping PLN re-solves the mix — EUR is not 100% of the pair and not a zeroed slice', () => {
    const r_USD = 3.5;
    const pair = buildEfficientCarryVarFrontier({
      ccys: ['EUR', 'PLN'],
      mu: [(eur.carry - r_USD) / 100, (pln.carry - r_USD) / 100],
      varCapUsdM: 2,
      skipLeverageCap: true,
    })!;
    const solo = buildEfficientCarryVarFrontier({
      ccys: ['EUR'],
      mu: [(eur.carry - r_USD) / 100],
      varCapUsdM: 2,
      skipLeverageCap: true,
    })!;
    const eurPair = pair.capLegs.find(l => l.ccy === 'EUR')!;
    const plnPair = pair.capLegs.find(l => l.ccy === 'PLN')!;
    const wPair = l1Weights(pair.capLegs.map(l => l.usdM));
    const eurW = wPair[pair.capLegs.findIndex(l => l.ccy === 'EUR')]!;
    expect(Math.abs(plnPair.usdM)).toBeGreaterThan(0.05);
    expect(Math.abs(eurW)).toBeLessThan(0.99);
    expect(solo.capLegs[0]!.usdM).not.toBeCloseTo(eurPair.usdM, 2);
    expect(solo.capLegs[0]!.side).toBe('short');
    expect(eurPair.side).toBe('short');
  });

  it('diversified EUR+PLN can short more EUR than EUR-only at the same cap', () => {
    const r_USD = 3.5;
    const basesFcy = [2.54, 10];
    const rOd = [eur.r_OD, pln.r_OD];
    const pair = buildEfficientCarryVarFrontier({
      ccys: ['EUR', 'PLN'],
      mu: [(eur.carry - r_USD) / 100, (pln.carry - r_USD) / 100],
      varCapUsdM: 16.7,
      basesFcy, rOd, r_USD,
    })!;
    const solo = buildEfficientCarryVarFrontier({
      ccys: ['EUR'],
      mu: [(eur.carry - r_USD) / 100],
      varCapUsdM: 16.7,
      basesFcy: [2.54], rOd: [eur.r_OD], r_USD,
    })!;
    const eurPair = pair.capLegs.find(l => l.ccy === 'EUR')!.usdM;
    const eurSolo = solo.capLegs[0]!.usdM;
    expect(eurPair).toBeLessThan(0);
    expect(eurSolo).toBeLessThan(0);
    expect(Math.abs(eurPair)).toBeGreaterThan(Math.abs(eurSolo) - 1e-6);
  });

  it('Euler component VAR on cap legs sums to the overlay portfolio VAR', () => {
    const r_USD = 3.5;
    const ccys = ['EUR', 'GBP', 'PLN'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const fr = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 10 })!;
    const port = computePortfolioVAR(
      fr.capLegs.map(l => ({
        ccy: l.ccy,
        cashFCY: (CURRENCY_PARAMS[l.ccy]!.spot > 1e-12)
          ? l.usdM / CURRENCY_PARAMS[l.ccy]!.spot
          : 0,
      })),
    );
    const euler = fr.capLegs.reduce((s, l) => s + l.componentVarUsdM, 0);
    expect(euler).toBeCloseTo(port.portfolio_VAR_USD, 5);
    expect(euler).toBeCloseTo(fr.cap.varUsdM, 4);
  });

  it('a PAY short past zero can make ray carry peak before the VAR fill', () => {
    const cap = payKinkCap();
    expect(2.54 + cap.fcyM).toBeLessThan(0);
    const samples = [0, 0.25, 0.4, 0.55, 0.7, 0.85, 1].map(t => ({
      t,
      carry: overlayLegCarryAtUsd(cap, cap.usdM * t),
    }));
    const peak = samples.reduce((best, p) => (p.carry >= best.carry ? p : best));
    expect(peak.t).toBeLessThan(1);
    expect(peak.carry).toBeGreaterThan(samples[samples.length - 1]!.carry);
    const credit = samples.find(p => {
      const fcy = cap.fcyM * p.t;
      return 2.54 + fcy > 0;
    })!;
    expect(credit.carry).toBeGreaterThan(overlayLegCarryAtUsd(cap, cap.usdM));
  });

  it('Σ⁻¹μ still longs EARN and shorts PAY when a third name is added', () => {
    const r_USD = 3.5;
    const ccys = ['EUR', 'GBP', 'MXN'] as const;
    const mu = ccys.map(c => (CURRENCY_PARAMS[c]!.carry - r_USD) / 100);
    const fr = buildEfficientCarryVarFrontier({ ccys, mu, varCapUsdM: 8 })!;
    for (const l of fr.capLegs) {
      if (l.mu > 1e-4) expect(l.side).toBe('long');
      if (l.mu < -1e-4) expect(l.side).toBe('short');
    }
  });
});
