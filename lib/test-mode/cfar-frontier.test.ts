import { describe, expect, it } from 'vitest';
import {
  efficientFrontier,
  isDegenerateFrontier,
  lowestReservePoint,
  type FrontierPoint,
} from './cfar-frontier';
import { computeMonteCarloMismatchCfar, type McCfarInput } from './cfar-montecarlo';
import { buildSyntheticHedgeProfile } from './cfar-residual';

const pt = (
  coverRatio: number,
  carryUsdM: number,
  grossCfarUsdM: number,
  netCfarUsdM = Math.max(0, grossCfarUsdM - Math.max(0, carryUsdM)),
): FrontierPoint => ({ coverRatio, carryUsdM, grossCfarUsdM, netCfarUsdM });

const covers = (ps: readonly FrontierPoint[]) => ps.map(p => p.coverRatio);

/**
 * A currency that EARNS carry, so covering more buys less risk and more carry
 * at once until the over-hedge turns risk back up. Only the over-hedged branch
 * can be efficient.
 */
const earnsCarry = [
  pt(0, 0.0, 3.18),
  pt(0.5, 0.25, 1.68),
  pt(0.9, 0.45, 0.63),
  pt(1.1, 0.55, 0.31),
  pt(1.25, 0.62, 0.54),
  pt(1.5, 0.75, 1.06),
];

describe('efficientFrontier', () => {
  it('throws away the whole under-hedged branch when covering more is free money', () => {
    // Everything below the turn is beaten by 110% cover on both counts at
    // once — drawing those points on the curve would offer the desk choices
    // that are simply worse.
    expect(covers(efficientFrontier(earnsCarry))).toEqual([1.1, 1.25, 1.5]);
  });

  it('keeps the descending branch when cover has to be paid for', () => {
    // A currency that PAYS carry: covering costs money and buys safety, so
    // every level is a real choice and none is dominated.
    const paysCarry = [
      pt(0, 0.0, 3.18),
      pt(0.5, -0.2, 1.68),
      pt(0.9, -0.36, 0.63),
      pt(1.1, -0.44, 0.31),
    ];
    expect(covers(efficientFrontier(paysCarry))).toEqual([1.1, 0.9, 0.5, 0]);
  });

  it('returns a curve that only ever rises, so a line through it cannot fold back', () => {
    const eff = efficientFrontier(earnsCarry);
    for (let i = 1; i < eff.length; i += 1) {
      expect(eff[i]!.carryUsdM).toBeGreaterThan(eff[i - 1]!.carryUsdM);
      expect(eff[i]!.grossCfarUsdM).toBeGreaterThan(eff[i - 1]!.grossCfarUsdM);
    }
  });

  it('keeps only the safest of several cover levels paying identical carry', () => {
    const all = [pt(0.9, 0.5, 1.4), pt(1.0, 0.5, 1.1), pt(1.1, 0.5, 2.0)];
    expect(covers(efficientFrontier(all))).toEqual([1.0]);
  });

  it('never drops the safest structure nor the richest', () => {
    const eff = efficientFrontier(earnsCarry);
    expect(eff[0]!.coverRatio).toBe(1.1); // lowest risk of all
    expect(eff[eff.length - 1]!.coverRatio).toBe(1.5); // highest carry of all
  });

  it('collapses to one point when a single cover level wins outright', () => {
    const flat = [pt(0.5, 0.2, 3.05), pt(1.0, 0.4, 3.05), pt(1.5, 0.6, 3.05)];
    expect(covers(efficientFrontier(flat))).toEqual([1.5]);
  });

  it('survives the degenerate inputs', () => {
    expect(efficientFrontier([])).toEqual([]);
    expect(covers(efficientFrontier([pt(1, 0.5, 1.1)]))).toEqual([1]);
    expect(lowestReservePoint([])).toBeNull();
  });
});

describe('isDegenerateFrontier', () => {
  it('accepts a frontier that spans real ground', () => {
    expect(isDegenerateFrontier(earnsCarry, efficientFrontier(earnsCarry))).toBe(false);
  });

  it('rejects a lone survivor', () => {
    const flat = [pt(0.5, 0.2, 3.05), pt(1.0, 0.4, 3.05), pt(1.5, 0.6, 3.05)];
    expect(isDegenerateFrontier(flat, efficientFrontier(flat))).toBe(true);
  });

  it('rejects the bullet book, where two points survive on noise alone', () => {
    // The real measured shape: 3.048 flat across cover, with the top point a
    // hair higher. Dominance says two are efficient; the slope between them is
    // 0.26% of the sweep's own range and means nothing.
    const bullet = [pt(0.5, 0.2, 3.048), pt(1.0, 0.4, 3.048), pt(1.5, 0.6, 3.056)];
    const eff = efficientFrontier(bullet);
    expect(eff.length).toBeGreaterThan(1);
    expect(isDegenerateFrontier(bullet, eff)).toBe(true);
  });

  it('has nothing to say about an empty sweep', () => {
    expect(isDegenerateFrontier([], [])).toBe(true);
  });
});

describe('lowestReservePoint', () => {
  it('picks the tangency of the 45° net line, not the safest point', () => {
    // net = gross − carry across the efficient branch: 110% leaves 0.00 by
    // flooring, but 150% leaves 0.31 and 125% 0.00 — the tie goes to the first
    // minimum found, which is the least over-hedged of the equals.
    const eff = efficientFrontier(earnsCarry);
    expect(lowestReservePoint(eff)!.coverRatio).toBe(1.1);
  });

  it('will take more risk when the carry more than pays for it', () => {
    // 125% is riskier in gross terms than 110% but earns enough to leave the
    // smaller reserve — the whole reason net is the criterion and gross is
    // only the axis.
    const eff = efficientFrontier([
      pt(1.1, 0.4, 0.9, 0.5),
      pt(1.25, 1.4, 1.6, 0.2),
    ]);
    expect(lowestReservePoint(eff)!.coverRatio).toBe(1.25);
  });
});

/**
 * The engine has to actually produce the shape the chart is built on. If risk
 * ever stopped turning at full cover the sweep would have no trade-off left in
 * it and the frontier would be a straight dominance ranking again.
 */
describe('the cover sweep the frontier is drawn from', () => {
  const T = 12;
  const mk = (coverM: number, legCount: number): McCfarInput => {
    const p = buildSyntheticHedgeProfile({
      totalNotionalLocalM: coverM,
      legCount,
      tenureMonths: T,
    });
    const hedgeSettleSchedule =
      p.structure === 'strip' && p.legs.length > 0
        ? p.legs.map(l => ({
            settleMonths: l.settleMonths ?? l.endMonth,
            notionalLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
          }))
        : [{ settleMonths: p.settleMonths ?? T, notionalLocalM: p.coverLocalM }];
    return {
      stockM: 1.9,
      monthlyInflows: Array.from({ length: T }, () => 1.5),
      monthlyOutflows: Array.from({ length: T }, () => 0.25),
      tenureMonths: T,
      spotUsd: 1.08,
      sigmaFxMonthly: 0.03,
      confidencePct: 95,
      forecastUncertainty1m: 0.3,
      hedgeSettleSchedule,
      usdRatePctPa: 4.3,
      fcyRatePctPa: 2.0,
      rateVolPctPa: 0.8,
      seed: 999,
      paths: 600,
    };
  };
  const grossAt = (ratio: number, legCount = 12) =>
    computeMonteCarloMismatchCfar(mk(16.3 * ratio, legCount)).criticalCashUsdM;

  it('turns conversion risk up once the hedge overshoots the exposure', () => {
    // Unhedged CFaR is ~0 — no delivery, so the open book is not an FX-vol
    // proxy. Cover introduces conversion; overshoot costs more via squaring.
    const unhedged = grossAt(0);
    const full = grossAt(1);
    const over = grossAt(1.5);
    expect(unhedged).toBeLessThan(0.05);
    expect(full).toBeGreaterThan(unhedged);
    expect(over).toBeGreaterThan(full * 1.5);
  });

  it('raises CFaR as cover first forces a delivery', () => {
    const walk = [0, 0.25, 0.5, 0.75, 0.9].map(r => grossAt(r));
    expect(walk[0]!).toBeLessThan(0.05);
    expect(walk[walk.length - 1]!).toBeGreaterThan(walk[0]!);
  });

  it('raises CFaR when a single bullet overshoots', () => {
    // Under-hedged bullet: leftover FCY is unconverted, so headline stays
    // near zero. Overshoot forces a square — conversion CFaR, not an FX-vol
    // proxy on the open gap.
    const lo = grossAt(0.5, 1);
    const hi = grossAt(1.25, 1);
    expect(lo).toBeLessThan(0.05);
    expect(hi).toBeGreaterThan(lo + 0.05);
  });
});

/** The axes have to stay independent for any of this to mean anything. */
describe('axis independence', () => {
  const T = 12;
  const base = (carry?: number[]): McCfarInput => {
    const prep = buildSyntheticHedgeProfile({
      totalNotionalLocalM: 16.3,
      legCount: 4,
      tenureMonths: T,
    });
    return {
      stockM: 1.9,
      monthlyInflows: Array.from({ length: T }, () => 1.5),
      monthlyOutflows: Array.from({ length: T }, () => 0.25),
      tenureMonths: T,
      spotUsd: 1.08,
      sigmaFxMonthly: 0.03,
      confidencePct: 95,
      forecastUncertainty1m: 0.3,
      hedgeSettleSchedule: prep.legs.map(l => ({
        settleMonths: l.settleMonths ?? l.endMonth,
        notionalLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
      })),
      usdRatePctPa: 4.3,
      fcyRatePctPa: 2.0,
      rateVolPctPa: 0.8,
      seed: 12345,
      paths: 400,
      ...(carry ? { hedgeCarryScheduleUsdM: carry } : {}),
    };
  };
  const rich = Array.from({ length: T }, (_, k) => (2.0 * (k + 1)) / T);

  it('leaves gross CFaR untouched by the carry the structure earns', () => {
    expect(computeMonteCarloMismatchCfar(base(rich)).criticalCashUsdM).toBeCloseTo(
      computeMonteCarloMismatchCfar(base()).criticalCashUsdM,
      9,
    );
  });

  it('moves net CFaR with that same carry, which is why net cannot be an axis', () => {
    expect(
      computeMonteCarloMismatchCfar(base(rich)).netCriticalCashUsdM,
    ).toBeLessThan(computeMonteCarloMismatchCfar(base()).netCriticalCashUsdM - 0.05);
  });

  it('prices every cover level off the same draws when the seed is shared', () => {
    const a = computeMonteCarloMismatchCfar(base());
    const b = computeMonteCarloMismatchCfar(base());
    expect(a.criticalCashUsdM).toBe(b.criticalCashUsdM);
    expect(a.netCriticalCashUsdM).toBe(b.netCriticalCashUsdM);
  });
});
