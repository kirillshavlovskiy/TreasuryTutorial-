import { pairCorr } from '@/lib/test-mode/portfolio-liquidity-frontier';
import type { HedgeVarRow } from '@/lib/test-mode/hedge-var';
import { ccySpotRate } from '@/lib/fx-buffer';
import { atlasRiskCorr } from '@/lib/fx-market-risk';
import {
  applyAtlasMixToHedgeRows,
  atlasMixLockedCarryUsdM,
  fxLiveMixWeights,
  fxMixSignedContribs,
  atlasMonotoneEfficient,
  formatHedgePct,
  buildFxAtlasLegs,
  datedAtlasExposuresLocalM,
  fxAtlasHedgeFrontier,
  fxAtlasMarginalEffects,
  fxAtlasMixWorseThanFrontier,
  fxAtlasTenorFrontier,
  fxCarryVarFrontier,
  fxDiversifiedBooks,
  signedFxVarUsdM,
  type FxCarryVarPoint,
} from '@/lib/test-mode/fx-var-frontier';
import { simSeedForEntity, task02ForecastProfile } from '@/lib/test-mode/nordtech-sim-seed';
import type { Entity } from '@/lib/workspace-store';

function row(partial: Partial<HedgeVarRow> & Pick<HedgeVarRow, 'ccy'>): HedgeVarRow {
  return {
    direction: 'long',
    exposureLocalM: 2,
    openExposureLocalM: 2,
    hedgeRatio: 0,
    delta: 1,
    hedgeNotionalLocalM: 0,
    targetHedgeLocalM: 2,
    stockHedgeLocalM: 2,
    equalVarHedgeLocalM: 1.5,
    hedgeCapped: false,
    residualLocalM: 2,
    varBeforeUsdM: 0.4,
    varAfterUsdM: 0.4,
    ...partial,
  };
}

describe('signedFxVarUsdM', () => {
  it('keeps long VaR positive and shorts negative', () => {
    expect(signedFxVarUsdM(0.5, 2)).toBeCloseTo(0.5);
    expect(signedFxVarUsdM(0.5, -2)).toBeCloseTo(-0.5);
  });
});

describe('fxDiversifiedBooks', () => {
  it('is below the undiversified sum when EUR and GBP both long', () => {
    const books = fxDiversifiedBooks([
      row({ ccy: 'EUR', varBeforeUsdM: 0.8, varAfterUsdM: 0.8 }),
      row({ ccy: 'GBP', varBeforeUsdM: 0.5, varAfterUsdM: 0.5 }),
    ]);
    expect(pairCorr('EUR', 'GBP')).toBeGreaterThan(0.5);
    expect(books.before.standaloneUsdM).toBeCloseTo(1.3);
    expect(books.before.portfolioUsdM).toBeLessThan(books.before.standaloneUsdM - 0.02);
    expect(books.before.portfolioUsdM).toBeGreaterThan(0.8);
  });

  it('offsets a JPY short against a EUR long', () => {
    const books = fxDiversifiedBooks([
      row({ ccy: 'EUR', residualLocalM: 2, hedgeNotionalLocalM: 0, varBeforeUsdM: 0.8, varAfterUsdM: 0.8 }),
      row({
        ccy: 'JPY',
        direction: 'short',
        exposureLocalM: -4,
        openExposureLocalM: -4,
        residualLocalM: -4,
        hedgeNotionalLocalM: 0,
        targetHedgeLocalM: -4,
        varBeforeUsdM: 0.5,
        varAfterUsdM: 0.5,
      }),
    ]);
    expect(books.before.standaloneUsdM).toBeCloseTo(1.3);
    expect(books.before.portfolioUsdM).toBeLessThan(books.before.standaloneUsdM);
  });

  it('drops diversified VaR after a full offset hedge', () => {
    const books = fxDiversifiedBooks([
      row({
        ccy: 'EUR',
        hedgeNotionalLocalM: 2,
        residualLocalM: 0,
        hedgeRatio: 1,
        delta: 0,
        varBeforeUsdM: 0.8,
        varAfterUsdM: 0,
      }),
      row({
        ccy: 'GBP',
        hedgeNotionalLocalM: 1,
        residualLocalM: 0,
        hedgeRatio: 1,
        delta: 0,
        varBeforeUsdM: 0.5,
        varAfterUsdM: 0,
      }),
    ]);
    expect(books.before.portfolioUsdM).toBeGreaterThan(0.5);
    expect(books.after.portfolioUsdM).toBeLessThan(1e-9);
  });
});

describe('fxCarryVarFrontier', () => {
  it('walk starts at open diversified VaR and ends at the live hedge', () => {
    const rows = [
      row({
        ccy: 'EUR',
        hedgeNotionalLocalM: 1,
        residualLocalM: 1,
        varBeforeUsdM: 0.8,
        varAfterUsdM: 0.4,
      }),
    ];
    const fr = fxCarryVarFrontier({
      rows,
      cashByCcy: { EUR: 0.2 },
      hedgeCarryByCcy: { EUR: -0.05 },
    });
    expect(fr.walk[0]!.kind).toBe('unhedged');
    expect(fr.walk[fr.walk.length - 1]!.kind).toBe('hedged');
    expect(fr.walk[0]!.divVarUsdM).toBeCloseTo(fr.before.portfolioUsdM, 6);
    expect(fr.walk[fr.walk.length - 1]!.divVarUsdM).toBeCloseTo(fr.after.portfolioUsdM, 6);
    expect(fr.walk[0]!.carryUsdYrM).toBeCloseTo(0.2);
    expect(fr.walk[fr.walk.length - 1]!.carryUsdYrM).toBeCloseTo(0.15);
  });

  it('Pareto includes the unhedged and fully hedged books', () => {
    const fr = fxCarryVarFrontier({
      rows: [
        row({ ccy: 'EUR', hedgeNotionalLocalM: 1, residualLocalM: 1, varBeforeUsdM: 0.8, varAfterUsdM: 0.3 }),
        row({ ccy: 'GBP', hedgeNotionalLocalM: 0.6, residualLocalM: 1.4, varBeforeUsdM: 0.5, varAfterUsdM: 0.35 }),
      ],
      cashByCcy: { EUR: 0.1, GBP: 0.08 },
      hedgeCarryByCcy: { EUR: -0.02, GBP: -0.01 },
    });
    expect(fr.pareto.some(p => p.kind === 'unhedged')).toBe(true);
    expect(fr.pareto.some(p => p.kind === 'hedged')).toBe(true);
    expect(fr.pareto[0]!.divVarUsdM).toBeLessThanOrEqual(fr.pareto[fr.pareto.length - 1]!.divVarUsdM + 1e-12);
  });

  it('GS curve starts fully hedged and walks toward the open book', () => {
    const fr = fxCarryVarFrontier({
      rows: [
        row({ ccy: 'EUR', hedgeNotionalLocalM: 1, residualLocalM: 1, varBeforeUsdM: 0.8, varAfterUsdM: 0.3 }),
        row({ ccy: 'GBP', hedgeNotionalLocalM: 0.6, residualLocalM: 1.4, varBeforeUsdM: 0.5, varAfterUsdM: 0.35 }),
      ],
      cashByCcy: { EUR: 0.1, GBP: 0.08 },
      hedgeCarryByCcy: { EUR: -0.02, GBP: -0.01 },
    });
    expect(fr.curve.length).toBeGreaterThan(8);
    expect(fr.curve[0]!.kind).toBe('hedged');
    expect(fr.curve[fr.curve.length - 1]!.kind).toBe('unhedged');
    expect(fr.curve[0]!.divVarUsdM).toBeCloseTo(fr.walk[fr.walk.length - 1]!.divVarUsdM, 5);
    expect(fr.curve[fr.curve.length - 1]!.divVarUsdM).toBeCloseTo(fr.before.portfolioUsdM, 5);
    expect(fr.curve[0]!.divVarUsdM).toBeLessThanOrEqual(fr.curve[fr.curve.length - 1]!.divVarUsdM + 1e-9);
  });
});

describe('fxAtlasHedgeFrontier', () => {
  const atlasRows = [
    row({
      ccy: 'EUR',
      targetHedgeLocalM: 2,
      openExposureLocalM: 2,
      residualLocalM: 2,
      hedgeNotionalLocalM: 0,
      varBeforeUsdM: 0.8,
      varAfterUsdM: 0.8,
    }),
    row({
      ccy: 'GBP',
      targetHedgeLocalM: 2,
      openExposureLocalM: 2,
      residualLocalM: 2,
      hedgeNotionalLocalM: 0,
      varBeforeUsdM: 0.5,
      varAfterUsdM: 0.5,
    }),
  ];

  it('credits hedge carry only and zeros VaR when fully on Target', () => {
    const atlas = fxAtlasHedgeFrontier(atlasRows, { EUR: 0.4, GBP: -0.1 });
    expect(atlas.fullyHedged?.divVarUsdM).toBeLessThan(1e-9);
    expect(atlas.fullyHedged?.carryUsdYrM).toBeCloseTo(0.3);
    expect(atlas.unhedged?.carryUsdYrM).toBeCloseTo(0);
    expect(atlas.unhedged?.divVarUsdM).toBeGreaterThan(0.5);
  });

  it('unhedges the negative-carry name first and recommends that mix', () => {
    const atlas = fxAtlasHedgeFrontier(atlasRows, { EUR: 0.4, GBP: -0.1 });
    expect(atlas.sweet).toBeTruthy();
    expect(atlas.sweet!.hedgeByCcy?.EUR).toBeCloseTo(1);
    expect(atlas.sweet!.hedgeByCcy?.GBP).toBeCloseTo(0);
    expect(atlas.sweet!.carryUsdYrM).toBeCloseTo(0.4);
    expect(atlas.sweet!.divVarUsdM).toBeGreaterThan(atlas.fullyHedged!.divVarUsdM);
    expect(atlas.sweet!.divVarUsdM).toBeLessThan(atlas.unhedged!.divVarUsdM);
  });

  it('keeps a flat GBP hedge — dust carry is not worth the extra VaR', () => {
    const atlas = fxAtlasHedgeFrontier(atlasRows, { EUR: 0.4, GBP: -0.001 });
    expect(atlas.sweet!.hedgeByCcy?.EUR).toBeCloseTo(1);
    expect(atlas.sweet!.hedgeByCcy?.GBP).toBeCloseTo(1);
    expect(atlas.sweet!.divVarUsdM).toBeLessThan(atlas.unhedged!.divVarUsdM);
  });

  it('stops the blue set at max carry — unhedged stays off the line at carry 0', () => {
    const atlas = fxAtlasHedgeFrontier(atlasRows, { EUR: 0.4, GBP: -0.1 });
    const last = atlas.curve[atlas.curve.length - 1];
    expect(last?.id).toBe(atlas.sweet?.id);
    expect(atlas.curve.every(p => p.kind !== 'unhedged')).toBe(true);
    expect(atlas.curve.every(p => p.id !== atlas.unhedged?.id)).toBe(true);
    expect(atlas.unhedged?.carryUsdYrM).toBeCloseTo(0);
    expect(atlas.unhedged?.hedgeByCcy?.EUR).toBeCloseTo(0);
  });
});

describe('fxAtlasTenorFrontier · Task 02 book', () => {
  function fake(id: string, name: string, base: string): Entity {
    return { id, name, baseCurrency: base, description: '', createdAt: '', dashboards: [] };
  }

  const rows = [
    ...simSeedForEntity(fake('de', 'NordTech GmbH Frankfurt', 'EUR'), '02').rows,
    ...simSeedForEntity(fake('pl', 'NordTech Poland Krakow', 'PLN'), '02').rows,
    ...simSeedForEntity(fake('us', 'NordTech US Hub', 'USD'), '02').rows,
  ];
  const legs = buildFxAtlasLegs({
    rows,
    forecastMonths: 12,
    forecastProfile: task02ForecastProfile(),
    confidencePct: 95,
    rUsd: 4,
  });

  it('dates JPY as yen millions and prices USD at the TMS spot', () => {
    const jpy = rows.find(r => r.ccy === 'JPY')!;
    const dated = datedAtlasExposuresLocalM(jpy, 12, task02ForecastProfile());
    const sum = dated.reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(-1862.32, 1);
    expect(dated[0]).toBeCloseTo(-968, 0);
    const usd = sum * ccySpotRate('JPY');
    expect(usd).toBeCloseTo(-11.63, 1);
    expect(Math.abs(usd)).toBeLessThan(20);
  });

  it('recommends hedge EUR and leave JPY / MXN open', () => {
    const atlas = fxAtlasTenorFrontier(legs);
    expect(atlas.sweet).toBeTruthy();
    expect(atlas.sweet!.hedgeByCcy?.EUR ?? 0).toBeGreaterThan(0.5);
    expect(atlas.sweet!.hedgeByCcy?.JPY ?? 1).toBeLessThan(0.5);
    expect(atlas.sweet!.hedgeByCcy?.MXN ?? 1).toBeLessThan(0.5);
    expect(atlas.sweet!.hedgeByCcy?.GBP ?? 0).toBeGreaterThan(0.5);
    expect(atlas.fullyHedged!.divVarUsdM).toBeLessThan(1e-6);
    expect(atlas.sweet!.carryUsdYrM).toBeGreaterThan(atlas.fullyHedged!.carryUsdYrM);
  });

  it('excluding EUR pins that name open and re-solves the mix', () => {
    const atlas = fxAtlasTenorFrontier(legs, atlasRiskCorr, {
      forceOpenCcys: new Set(['EUR']),
    });
    expect(atlas.fullyHedged!.hedgeByCcy?.EUR ?? 1).toBeCloseTo(0, 5);
    expect(atlas.sweet!.hedgeByCcy?.EUR ?? 1).toBeCloseTo(0, 5);
    expect(atlas.fullyHedged!.divVarUsdM).toBeGreaterThan(0.05);
    expect(atlas.unhedged?.hedgeByCcy?.EUR ?? 1).toBeCloseTo(0, 5);
  });

  it('flags a tweaked mix that sits inside the frontier (higher VaR / lower carry)', () => {
    const atlas = fxAtlasTenorFrontier(legs);
    const sweet = atlas.sweet!;
    expect(fxAtlasMixWorseThanFrontier(sweet, atlas.curve)).toBe(false);
    expect(fxAtlasMixWorseThanFrontier({
      divVarUsdM: sweet.divVarUsdM + 0.15,
      carryUsdYrM: sweet.carryUsdYrM - 0.05,
    }, atlas.curve)).toBe(true);
  });

  it('plots the Atlas three-point contract: hedged → sweet, unhedged off the line', () => {
    const atlas = fxAtlasTenorFrontier(legs);
    const last = atlas.curve[atlas.curve.length - 1];
    expect(last?.carryUsdYrM).toBeCloseTo(atlas.sweet!.carryUsdYrM, 8);
    expect(atlas.curve.every(p => p.id !== atlas.unhedged?.id)).toBe(true);
    expect(atlas.unhedged?.carryUsdYrM).toBeCloseTo(0, 5);
    expect(atlas.unhedged!.divVarUsdM).toBeGreaterThan(atlas.sweet!.divVarUsdM + 0.05);
    expect(atlas.fullyHedged!.carryUsdYrM).toBeLessThan(0);
    expect(atlas.sweet!.carryUsdYrM).toBeGreaterThan(0);
  });

  it('prices marginal effects as carry-cost % and Euler risk-reduction %', () => {
    const pts = fxAtlasMarginalEffects(legs);
    expect(pts.length).toBeGreaterThan(20);
    const eur = pts.filter(p => p.ccy === 'EUR');
    const mxn = pts.filter(p => p.ccy === 'MXN');
    expect(eur.length).toBeGreaterThan(0);
    expect(eur.every(p => p.marginalCarryCostPct < 0)).toBe(true);
    expect(mxn.some(p => p.marginalCarryCostPct > 0)).toBe(true);
    const jpy1 = pts.find(p => p.ccy === 'JPY' && p.tenorMonths === 1);
    const jpy12 = pts.find(p => p.ccy === 'JPY' && p.tenorMonths === 12);
    expect(jpy1 && jpy12).toBeTruthy();
    // Tf-bullet carry density is the same on every tenor.
    expect(jpy12!.marginalCarryCostPct).toBeCloseTo(jpy1!.marginalCarryCostPct, 4);
    const jpyLeg1 = legs.find(l => l.ccy === 'JPY' && l.tenorMonths === 1)!;
    const jpyLeg12 = legs.find(l => l.ccy === 'JPY' && l.tenorMonths === 12)!;
    expect(
      Math.abs(jpyLeg12.signedVarUsdM) / Math.abs(jpyLeg12.exposureUsdM),
    ).toBeGreaterThan(
      Math.abs(jpyLeg1.signedVarUsdM) / Math.abs(jpyLeg1.exposureUsdM),
    );
  });

  it('drops already-hedged names from residual marginal effects', () => {
    const atlas = fxAtlasTenorFrontier(legs);
    const open = fxAtlasMarginalEffects(legs, atlas.unhedged?.hedgeByCcy);
    const sweet = fxAtlasMarginalEffects(legs, atlas.sweet?.hedgeByCcy);
    const hedged = fxAtlasMarginalEffects(legs, atlas.fullyHedged?.hedgeByCcy);
    expect(hedged).toEqual([]);
    expect(open.length).toBeGreaterThan(sweet.length);
    expect(sweet.some(p => p.ccy === 'JPY' || p.ccy === 'MXN')).toBe(true);
    expect(sweet.every(p => (atlas.sweet?.hedgeByCcy?.[p.ccy] ?? 0) < 0.99)).toBe(true);
  });

  it('does not scribble a PLN offset hook at the end of the blue line', () => {
    const atlas = fxAtlasTenorFrontier(legs);
    for (let i = 1; i < atlas.curve.length; i++) {
      expect(atlas.curve[i]!.divVarUsdM).toBeGreaterThanOrEqual(
        atlas.curve[i - 1]!.divVarUsdM - 1e-2,
      );
    }
    const tail = atlas.curve.slice(-5);
    const vSpan = tail[tail.length - 1]!.divVarUsdM - tail[0]!.divVarUsdM;
    expect(vSpan).toBeGreaterThan(0.05);
  });

  it('samples arc-length-equal knots up to the sweet mix and is concave (carry per VaR falls)', () => {
    const atlas = fxAtlasTenorFrontier(legs);
    expect(atlas.curve.length).toBeGreaterThanOrEqual(8);
    expect(atlas.curve.length).toBeLessThanOrEqual(20);
    expect(atlas.curve[atlas.curve.length - 1]!.id).toBe(atlas.sweet!.id);
    // Knots are spaced by cumulative distance along the (VaR, Carry) path,
    // each axis normalized by its own end-to-end range — not by equal raw
    // carry steps. Equal-carry spacing clustered knots on top of a real
    // critical-line kink (a big carry gain for almost no extra VaR) and
    // starved the rest of the curve; see resampleAtlasEqualCarry. Check
    // the normalized step sizes are roughly equal instead.
    const varSpan = Math.max(1e-9, Math.abs(
      atlas.curve[atlas.curve.length - 1]!.divVarUsdM - atlas.curve[0]!.divVarUsdM,
    ));
    const carrySpan = Math.max(1e-9, Math.abs(
      atlas.curve[atlas.curve.length - 1]!.carryUsdYrM - atlas.curve[0]!.carryUsdYrM,
    ));
    const steps: number[] = [];
    for (let i = 1; i < atlas.curve.length; i++) {
      const dv = (atlas.curve[i]!.divVarUsdM - atlas.curve[i - 1]!.divVarUsdM) / varSpan;
      const dc = (atlas.curve[i]!.carryUsdYrM - atlas.curve[i - 1]!.carryUsdYrM) / carrySpan;
      steps.push(Math.hypot(dv, dc));
    }
    const meanStep = steps.reduce((s, v) => s + v, 0) / steps.length;
    for (const s of steps) expect(s).toBeCloseTo(meanStep, 1);
    const head = atlas.curve[3]!;
    const first = atlas.curve[0]!;
    const tailA = atlas.curve[atlas.curve.length - 4]!;
    const last = atlas.curve[atlas.curve.length - 1]!;
    const headSlope = (head.carryUsdYrM - first.carryUsdYrM)
      / Math.max(1e-9, head.divVarUsdM - first.divVarUsdM);
    const tailSlope = (last.carryUsdYrM - tailA.carryUsdYrM)
      / Math.max(1e-9, last.divVarUsdM - tailA.divVarUsdM);
    expect(headSlope).toBeGreaterThan(tailSlope);
  });
});

describe('fxMixSignedContribs', () => {
  it('VaR before mix is atlas indiv; VaR after mix is indiv × (1 − w)', () => {
    const rows = [
      row({ ccy: 'JPY', varBeforeUsdM: 1.23, targetHedgeLocalM: -1900 }),
      row({ ccy: 'EUR', varBeforeUsdM: 0.4, targetHedgeLocalM: 12 }),
      row({ ccy: 'MXN', varBeforeUsdM: 0.5, targetHedgeLocalM: 140 }),
    ];
    const atlas = {
      indiv: { JPY: 0.76, EUR: 0.18, MXN: 0.51 },
      local: { JPY: -1832, EUR: 12.1, MXN: 147.3 },
    };
    const weights = fxLiveMixWeights(
      { JPY: 0.16, EUR: 1, MXN: 0.2 },
      { JPY: 0.4 },
      ['MXN'],
    );
    expect(weights.JPY).toBeCloseTo(0.4);
    expect(weights.EUR).toBe(1);
    expect(weights.MXN).toBe(0);

    const before = fxMixSignedContribs(rows, atlas, weights, 'before');
    const after = fxMixSignedContribs(rows, atlas, weights, 'after');
    const b = Object.fromEntries(before.map(c => [c.ccy, c.usdM]));
    const a = Object.fromEntries(after.map(c => [c.ccy, c.usdM]));
    expect(b.JPY).toBeCloseTo(-0.76);
    expect(b.EUR).toBeCloseTo(0.18);
    expect(b.MXN).toBeCloseTo(0.51);
    expect(a.JPY).toBeCloseTo(-0.76 * 0.6);
    expect(a.EUR).toBeUndefined();
    expect(a.MXN).toBeCloseTo(0.51);
  });
});

describe('applyAtlasMixToHedgeRows', () => {
  it('reprints Optimize Resid VaR on Book rows (not hist-σ path VaR)', () => {
    const point: FxCarryVarPoint = {
      id: 'sweet',
      t: 0.4,
      carryUsdYrM: 0.069,
      divVarUsdM: 0.52,
      standaloneVarUsdM: 1.05,
      kind: 'walk',
      hedgeByCcy: { JPY: 0.16, MXN: 0.2, EUR: 1 },
      carryByCcy: { JPY: -0.016, MXN: -0.02, EUR: 0.11 },
    };
    const booked = applyAtlasMixToHedgeRows(
      [
        row({
          ccy: 'JPY',
          hedgeRatio: 0.16,
          targetHedgeLocalM: -1900,
          varBeforeUsdM: 1.23,
          varAfterUsdM: 1.04,
        }),
        row({
          ccy: 'MXN',
          hedgeRatio: 0.2,
          varBeforeUsdM: 0.52,
          varAfterUsdM: 0.41,
        }),
        row({
          ccy: 'EUR',
          hedgeRatio: 1,
          varBeforeUsdM: 0.18,
          varAfterUsdM: 0.03,
        }),
      ],
      point,
      {
        indiv: { JPY: 0.76, MXN: 0.51, EUR: 0.18 },
        local: { JPY: -1832, MXN: 147.3, EUR: 12.1 },
      },
    );
    const jpy = booked.find(r => r.ccy === 'JPY')!;
    const mxn = booked.find(r => r.ccy === 'MXN')!;
    const eur = booked.find(r => r.ccy === 'EUR')!;
    expect(jpy.varBeforeUsdM).toBeCloseTo(0.76);
    expect(jpy.varAfterUsdM).toBeCloseTo(0.76 * 0.84);
    expect(jpy.delta).toBeCloseTo(0.84);
    expect(jpy.targetHedgeLocalM).toBeCloseTo(-1832);
    expect(jpy.hedgeNotionalLocalM).toBeCloseTo(-1832 * 0.16);
    expect(jpy.residualLocalM).toBeCloseTo(-1832 * 0.84);
    expect(mxn.varAfterUsdM).toBeCloseTo(0.51 * 0.8);
    expect(eur.varAfterUsdM).toBeCloseTo(0);
    expect(eur.hedgeNotionalLocalM).toBeCloseTo(12.1);
    expect(atlasMixLockedCarryUsdM(point, 'JPY', -0.1)).toBeCloseTo(-0.016);
    expect(atlasMixLockedCarryUsdM(point, 'MXN', -0.1)).toBeCloseTo(-0.02);
    expect(atlasMixLockedCarryUsdM(point, 'JPY', -0.34, 1)).toBeCloseTo(-0.34);
    expect(atlasMixLockedCarryUsdM(point, 'JPY', -0.34, 0)).toBeCloseTo(0);
    expect(formatHedgePct(0.157394)).toBe('15.7%');
    expect(formatHedgePct(1)).toBe('100%');
    expect(formatHedgePct(0.2)).toBe('20%');
  });
});

describe('atlasMonotoneEfficient', () => {
  function pt(id: string, v: number, c: number): FxCarryVarPoint {
    return {
      id, t: 0, divVarUsdM: v, carryUsdYrM: c, standaloneVarUsdM: v, kind: 'walk',
    };
  }

  it('drops a backward-VaR hook and keeps the ends', () => {
    const cleaned = atlasMonotoneEfficient([
      pt('a', 0.70, 0.05),
      pt('b', 0.68, 0.052),
      pt('c', 0.67, 0.054),
      pt('d', 0.72, 0.06),
      pt('e', 1.20, 0.11),
    ]);
    expect(cleaned.map(p => p.id)).toEqual(['a', 'd', 'e']);
  });
});
