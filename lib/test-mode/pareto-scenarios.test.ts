import { describe, expect, it } from 'vitest';
import {
  DIRECTOR_VAR_USD_M,
  candidatesFromFrontier,
  efficiencyRatio,
  paretoSkyline,
  pickParetoScenarios,
  receiveNamesFromRows,
  type ParetoCandidate,
} from './pareto-scenarios';

const pt = (carry: number, risk: number, extra: Partial<ParetoCandidate> = {}): ParetoCandidate => ({
  carryUsdYrM: carry,
  riskUsdM: risk,
  ...extra,
});

describe('paretoSkyline', () => {
  it('drops a point that is worse on both legs', () => {
    const sky = paretoSkyline([
      pt(0.80, 7.8),
      pt(0.50, 8.5),
      pt(0.40, 4.2),
    ]);
    expect(sky.map(p => p.carryUsdYrM)).toEqual([0.40, 0.80]);
  });

  it('keeps the safer of two equal-carry books', () => {
    const sky = paretoSkyline([pt(0.50, 6.4), pt(0.50, 7.1), pt(0.30, 4.0)]);
    expect(sky.map(p => p.riskUsdM)).toEqual([4.0, 6.4]);
  });

  it('returns ascending carry so the left end is conservative', () => {
    const sky = paretoSkyline([pt(0.80, 7.8), pt(0.62, 6.4), pt(0.40, 4.2)]);
    expect(sky[0]!.carryUsdYrM).toBe(0.40);
    expect(sky[sky.length - 1]!.carryUsdYrM).toBe(0.80);
  });
});

describe('efficiencyRatio', () => {
  it('matches the mockup 3,250 bps / $7.8M = 417 shape (carry $K / risk $M)', () => {
    expect(efficiencyRatio(3.250, 7.8)).toBeCloseTo(416.67, 1);
  });
});

describe('pickParetoScenarios', () => {
  const front = [pt(0.40, 4.2), pt(0.62, 6.4), pt(0.80, 7.8)];

  it('maps the mockup trio onto max / balanced / conservative', () => {
    const cards = pickParetoScenarios({
      points: front,
      budgetUsdM: 7,
      receiveNames: ['GBP', 'AUD', 'MXN'],
    });
    expect(cards.map(c => c.id)).toEqual(['maxCarry', 'balanced', 'conservative']);

    const max = cards[0]!;
    expect(max.name).toBe('Max carry (GBP/AUD/MXN)');
    expect(max.carryUsdYrM).toBe(0.80);
    expect(max.riskUsdM).toBe(7.8);
    expect(max.approved).toBe(false);
    expect(max.usedPct).toBeCloseTo(111.4, 0);

    const bal = cards[1]!;
    expect(bal.carryUsdYrM).toBe(0.62);
    expect(bal.riskUsdM).toBe(6.4);
    expect(bal.approved).toBe(true);
    expect(bal.usedPct).toBeCloseTo(91.4, 0);

    const cons = cards[2]!;
    expect(cons.carryUsdYrM).toBe(0.40);
    expect(cons.riskUsdM).toBe(4.2);
    expect(cons.approved).toBe(true);
    expect(cons.riskUsdM).toBeLessThanOrEqual(DIRECTOR_VAR_USD_M);
  });

  it('does not pick a $611M leverage tail as Max carry — zip Max Carry is the $20M rung', () => {
    const cards = pickParetoScenarios({
      points: [
        pt(0.40, 4.2),
        pt(0.62, 6.4),
        pt(0.80, 7.8),
        pt(107.2, 611),
      ],
      budgetUsdM: 10,
      receiveNames: ['GBP'],
    });
    const max = cards.find(c => c.id === 'maxCarry')!;
    expect(max.riskUsdM).toBe(7.8);
    expect(max.riskUsdM).toBeLessThan(25);
    expect(cards.every(c => c.riskUsdM < 25)).toBe(true);
  });

  it('flags balanced for review when every skyline point is over budget', () => {
    const cards = pickParetoScenarios({
      points: [pt(1.2, 12), pt(1.5, 14)],
      budgetUsdM: 7,
    });
    expect(cards[1]!.approved).toBe(false);
    expect(cards[1]!.riskUsdM).toBe(12);
  });

  it('collapses to one book when the front is a single point', () => {
    const cards = pickParetoScenarios({
      points: [pt(0.5, 3.0)],
      budgetUsdM: 7,
    });
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map(c => c.riskUsdM))).toEqual(new Set([3.0]));
  });

  it('adds Director and best-efficiency cards when they are a different book', () => {
    const cards = pickParetoScenarios({
      points: [
        pt(0.20, 2.5),
        pt(0.45, 4.0),
        pt(0.52, 4.9),
        pt(0.62, 6.4),
        pt(0.80, 7.8),
      ],
      budgetUsdM: 7,
    });
    expect(cards.map(c => c.id)).toEqual([
      'maxCarry',
      'balanced',
      'conservative',
      'maxEfficiency',
    ]);
    expect(cards.find(c => c.id === 'conservative')!.riskUsdM).toBe(4.9);
    expect(cards.find(c => c.id === 'maxEfficiency')!.riskUsdM).toBe(4.0);
    expect(cards.find(c => c.id === 'director')).toBeUndefined();
  });

  it('skips extras that land on an already-named point', () => {
    const cards = pickParetoScenarios({
      points: [pt(0.40, 4.2), pt(0.62, 6.4), pt(0.80, 7.8)],
      budgetUsdM: 7,
      extras: { booked: pt(0.80, 7.8), kkt: pt(0.62, 6.4) },
    });
    expect(cards.map(c => c.id)).toEqual(['maxCarry', 'balanced', 'conservative']);
  });

  it('appends KKT when the sparse book is a new point', () => {
    const cards = pickParetoScenarios({
      points: [pt(0.40, 4.2), pt(0.62, 6.4), pt(0.80, 7.8)],
      budgetUsdM: 7,
      extras: { kkt: pt(0.55, 5.1), kktShort: '1 name moves' },
    });
    const kkt = cards.find(c => c.id === 'kktSparse')!;
    expect(kkt.short).toBe('1 name moves');
    expect(kkt.riskUsdM).toBe(5.1);
  });
});

describe('receiveNamesFromRows', () => {
  it('lists receive names by spread, not a hardcoded GBP/AUD/MXN basket', () => {
    expect(
      receiveNamesFromRows(
        [
          { ccy: 'EUR', r_FCY: 1.78 },
          { ccy: 'GBP', r_FCY: 4.20 },
          { ccy: 'MXN', r_FCY: 6.19 },
          { ccy: 'AUD', r_FCY: 4.35 },
        ],
        3.50,
      ),
    ).toEqual(['MXN', 'AUD', 'GBP']);
  });
});

describe('candidatesFromFrontier', () => {
  it('returns empty when there is no frontier', () => {
    expect(candidatesFromFrontier(null)).toEqual([]);
  });
});
