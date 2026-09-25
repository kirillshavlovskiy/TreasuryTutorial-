import { describe, expect, it } from 'vitest';
import {
  structCfgFromPrepared,
  structPreset,
} from '@/components/test-mode/HedgingDecisionLayer';
import { maxStripLegsForForecast } from '@/lib/test-mode/rolling-hedge';
import type {
  PreparedHedgeLeg,
  PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';

/** Equal-weight strip of `n` legs settling every 2 months, Σ notional = cover. */
function equalStrip(n: number, coverLocalM: number): PreparedHedgeProfile {
  const per = coverLocalM / n;
  const legs: PreparedHedgeLeg[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    startMonth: 0,
    endMonth: (i + 1) * 2,
    settleMonths: (i + 1) * 2,
    hedgeLocalM: per * (i + 1),
    tradeNotionalLocalM: per,
    label: `L${i + 1}`,
  }));
  return {
    structure: 'strip',
    basis: 'varNeutral',
    ticketBasis: 'simpleAvg',
    legs,
    coverLocalM,
    hedgeRatio: 1,
  };
}

describe('structCfgFromPrepared — share rounding', () => {
  it('reads six equal legs as summing to exactly 100%', () => {
    // The reported defect: each leg rounded on its own to 16.7%, so the card
    // showed "Σ share 100.2% · off target" and offered Rebalance on a strip
    // that was already balanced. Sizes are sandbox figures shaped like the
    // ladder that surfaced it — six equal legs of a 12.12M cover.
    const cfg = structCfgFromPrepared(equalStrip(6, 12.12), 12);
    expect(cfg.sh).toHaveLength(6);
    expect(cfg.sh.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    // The drift lands on the last leg only; the rest read their own share.
    expect(cfg.sh.slice(0, 5)).toEqual([16.7, 16.7, 16.7, 16.7, 16.7]);
    expect(cfg.sh[5]).toBeCloseTo(16.5, 10);
  });

  it('reads three equal legs as summing to exactly 100%', () => {
    const cfg = structCfgFromPrepared(equalStrip(3, 9), 12);
    expect(cfg.sh.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(cfg.sh).toEqual([33.3, 33.3, 33.4]);
  });

  it('leaves an already-exact split alone', () => {
    const cfg = structCfgFromPrepared(equalStrip(4, 8), 12);
    expect(cfg.sh).toEqual([25, 25, 25, 25]);
  });

  it('still reports a strip whose legs do not add up to its cover', () => {
    // Only rounding drift is absorbed. A package genuinely short of its own
    // cover must keep reading off target, or the warning stops meaning
    // anything.
    const short = equalStrip(4, 8);
    short.coverLocalM = 10;
    const cfg = structCfgFromPrepared(short, 12);
    expect(cfg.sh.reduce((a, b) => a + b, 0)).toBeCloseTo(80, 10);
  });

  it('still reports a shortfall smaller than the warning threshold', () => {
    // Absorption is for float noise only. Three legs totalling 99.98% of
    // cover round to 33.3 each and sum to 99.9 — off target by 0.1pp, which
    // the card warns about. An absorption tolerance wide enough to cover
    // 0.02pp would force the last leg to 33.4 and report it as balanced,
    // hiding a real shortfall behind a rounding fix.
    const short = equalStrip(3, 2.9994);
    short.coverLocalM = 3;
    const cfg = structCfgFromPrepared(short, 12);
    expect(cfg.sh).toEqual([33.3, 33.3, 33.3]);
    const total = cfg.sh.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(99.9, 10);
    // Above the 0.05pp the card uses to decide it must warn.
    expect(100 - total).toBeGreaterThan(0.05);
  });

  it('reads a short (negative-cover) ladder the same way as a long one', () => {
    // The unwind this change exists for sells rather than buys, so every leg
    // notional and the cover are negative. Shares are a ratio of the two and
    // must stay positive and still total 100 — a sign leak here would read
    // as -16.7% a leg and permanently "off target".
    const cfg = structCfgFromPrepared(equalStrip(6, -12.12), 12);
    expect(cfg.sh.slice(0, 5)).toEqual([16.7, 16.7, 16.7, 16.7, 16.7]);
    expect(cfg.sh[5]).toBeCloseTo(16.5, 10);
    expect(cfg.sh.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
  });

  it('reports zero shares for a zero-cover package rather than forcing 100', () => {
    const zero = equalStrip(3, 0);
    const cfg = structCfgFromPrepared(zero, 12);
    expect(cfg.sh).toEqual([0, 0, 0]);
  });

  it('keeps the legs settle ladder as the draft tenors', () => {
    const cfg = structCfgFromPrepared(equalStrip(6, 12.12), 12);
    expect(cfg.structure).toBe('strip');
    expect(cfg.legCount).toBe(6);
    expect(cfg.t).toEqual([2, 4, 6, 8, 10, 12]);
  });
});

describe('leg count set on the card survives to the ladder', () => {
  // The defect this guards: the desk set a leg count and the modal opened a
  // different ladder. Nothing asserted the number end to end, so it broke
  // silently. These pin the card's half of the chain — the number the
  // stepper writes is the number of settle months the package is built
  // from, which is what buildStructuredProfile maps one-to-one into legs.
  it('turns N legs into N settle months, for every N the stepper allows', () => {
    for (const n of [2, 3, 6, 12]) {
      const preset = structPreset('strip', n, 'equal', 12);
      expect(preset.t).toHaveLength(n);
      expect(preset.sh).toHaveLength(n);
      expect(preset.sh.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    }
  });

  it('keeps the settle ladder inside the forecast and ends on it', () => {
    const preset = structPreset('strip', 6, 'equal', 12);
    expect(preset.t[preset.t.length - 1]).toBe(12);
    expect(preset.t.every(m => m > 0 && m <= 12)).toBe(true);
    expect([...preset.t].sort((a, b) => a - b)).toEqual(preset.t);
  });

  it('clamps the stepper to one leg per forecast month, 2 to 24', () => {
    // Both the card's stepper and the hedge-path chart's clamp through this,
    // so a ladder built in one round-trips back to the other.
    expect(maxStripLegsForForecast(12)).toBe(12);
    expect(maxStripLegsForForecast(6)).toBe(6);
    expect(maxStripLegsForForecast(1)).toBe(2);
    expect(maxStripLegsForForecast(0)).toBe(2);
    expect(maxStripLegsForForecast(60)).toBe(24);
    expect(maxStripLegsForForecast(2.5)).toBe(3);
  });
});

describe('structCfgFromPrepared — a configured leg count survives a re-derive', () => {
  // Reported after deleting an executed strip: an approved 5-leg ladder came
  // back as the default 3. Cancel re-derives the card's draft from whatever
  // package is left, and a non-strip package carries no leg count — the
  // branches answered a hard 3 and overwrote the desk's own number.
  const bullet: PreparedHedgeProfile = {
    structure: 'bullet',
    basis: 'varNeutral',
    ticketBasis: 'simpleAvg',
    legs: [],
    coverLocalM: 12.1,
    hedgeRatio: 1,
    settleMonths: 12,
  };

  it('keeps the card leg count when the package is a bullet', () => {
    expect(structCfgFromPrepared(bullet, 12, 5).legCount).toBe(5);
  });

  it('keeps the card leg count when there is no package at all', () => {
    const cfg = structCfgFromPrepared(undefined, 12, 5);
    expect(cfg.legCount).toBe(5);
    // t/sh must describe the same number of legs the counter claims.
    expect(cfg.t).toHaveLength(5);
    expect(cfg.sh).toHaveLength(5);
  });

  it('still defaults to 3 when the card has no count to carry', () => {
    expect(structCfgFromPrepared(undefined, 12).legCount).toBe(3);
    expect(structCfgFromPrepared(bullet, 12).legCount).toBe(3);
  });

  it('lets a real strip state its own leg count over the carried one', () => {
    // A 4-leg strip is authoritative: it has legs, so it is not guessing.
    expect(structCfgFromPrepared(equalStrip(4, 8), 12, 5).legCount).toBe(4);
  });

  it('ignores a nonsensical carried count', () => {
    expect(structCfgFromPrepared(undefined, 12, 1).legCount).toBe(3);
    expect(structCfgFromPrepared(undefined, 12, Number.NaN).legCount).toBe(3);
  });
});
