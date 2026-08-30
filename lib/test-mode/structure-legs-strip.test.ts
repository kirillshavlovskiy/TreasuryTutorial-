import { describe, it, expect } from 'vitest';
import type { LiquiditySwapLegRow } from '@/lib/test-mode/liquidity-strategies';
import {
  addFwdSwapLeg,
  applySwapDisplayedNotional,
  applySwapStyle,
  applySwapTenorKey,
  patchBookSwapNotional,
  removeBookSwapLeg,
  scalePricedStripToStanding,
  stripStandingScale,
  structureStripBands,
  swapLegStyle,
  swapTenorKey,
} from '@/lib/test-mode/structure-legs-strip';

function row(over: Partial<LiquiditySwapLegRow> = {}): LiquiditySwapLegRow {
  return {
    cycleIndex: 0,
    valueDateMonths: 0,
    newLeg: -2.5,
    rolledForward: 0,
    outstanding: -2.5,
    preBookable: false,
    settleMonths: 1,
    fcyOnUsdYr: -0.01,
    usdOnUsdYr: 0.008,
    pointsUsdYr: -0.002,
    midPoints: 12,
    hasPoints: true,
    interestUsdYr: -0.002,
    netUsdYr: -0.004,
    ...over,
  };
}

describe('structureStripBands', () => {
  it('overlay (default) lists Mix FCY only — not the funding SWAP programme', () => {
    expect(structureStripBands('overlay')).toEqual({ overlay: true, swap: false });
    expect(structureStripBands(undefined)).toEqual({ overlay: true, swap: false });
  });

  it('swap fill lists the funding strip and hides overlay Mix', () => {
    expect(structureStripBands('swap')).toEqual({ overlay: false, swap: true });
  });

  it('both lists overlay Mix plus the funding SWAP strip', () => {
    expect(structureStripBands('both')).toEqual({ overlay: true, swap: true });
  });
});

describe('swapLegStyle / tenor', () => {
  it('labels spot vs fwd from preBookable; term is always Bullet', () => {
    expect(swapLegStyle(row(), 'rolling')).toBe('Spot start');
    expect(swapLegStyle(row({ preBookable: true }), 'rolling')).toBe('Fwd start');
    expect(swapLegStyle(row({ preBookable: true }), 'term')).toBe('Bullet');
  });

  it('maps value-date month onto M{n}', () => {
    expect(swapTenorKey(row())).toBe('M1');
    expect(swapTenorKey(row({ valueDateMonths: 5 }))).toBe('M6');
  });
});

describe('scalePricedStripToStanding', () => {
  const strip = [
    row(),
    row({
      cycleIndex: 1, valueDateMonths: 1, preBookable: true,
      newLeg: -1.5, rolledForward: -2.5, outstanding: -4, settleMonths: 1,
      pointsUsdYr: -0.001, interestUsdYr: -0.0012, netUsdYr: -0.0022,
    }),
  ];

  it('returns no legs at the origin (overdraft books nothing)', () => {
    expect(scalePricedStripToStanding(strip, 0)).toEqual([]);
  });

  it('scales notionals and $ fields to the inspected standing', () => {
    const out = scalePricedStripToStanding(strip, -8);
    expect(out[0]!.outstanding).toBeCloseTo(-5, 5);
    expect(out[1]!.outstanding).toBeCloseTo(-8, 5);
    expect(out[0]!.pointsUsdYr).toBeCloseTo(-0.004, 6);
    expect(out[1]!.netUsdYr).toBeCloseTo(-0.0044, 6);
  });
});

describe('patchBookSwapNotional', () => {
  it('writes the displayed notional back through the standing scale', () => {
    const book = [row({ outstanding: -10, newLeg: -10 })];
    expect(stripStandingScale(book, -15)).toBeCloseTo(1.5, 6);
    const next = patchBookSwapNotional(book, 0, -18, -15, 'rolling');
    // displayed −18 at k=1.5 → book −12
    expect(next[0]!.outstanding).toBeCloseTo(-12, 5);
    expect(next[0]!.newLeg).toBeCloseTo(-12, 5);
  });

  it('term / strip-to-term patches newLeg and outstanding = rolled + new', () => {
    const leg = applySwapDisplayedNotional(
      row({ newLeg: -2, rolledForward: -3, outstanding: -5 }),
      -4,
      'stripTerm',
    );
    expect(leg.newLeg).toBe(-4);
    expect(leg.outstanding).toBe(-7);
  });
});

describe('add / remove / style / tenor', () => {
  it('appends a fwd-start slice without touching earlier legs', () => {
    const book = [row({ outstanding: -6, newLeg: -6 })];
    const next = addFwdSwapLeg(book, -6);
    expect(next).toHaveLength(2);
    expect(next[0]!.newLeg).toBe(-6);
    expect(next[1]!.preBookable).toBe(true);
    expect(next[1]!.valueDateMonths).toBe(1);
    expect(next[1]!.newLeg).toBeCloseTo(-3, 5);
  });

  it('removes by index', () => {
    const book = [row(), row({ cycleIndex: 1, valueDateMonths: 1, preBookable: true })];
    expect(removeBookSwapLeg(book, 0)).toHaveLength(1);
    expect(removeBookSwapLeg(book, 0)[0]!.cycleIndex).toBe(1);
  });

  it('Spot start pins value date to M1; tenor M6 is cycle 5', () => {
    const fwd = applySwapStyle(row({ preBookable: true, valueDateMonths: 3, cycleIndex: 3 }), 'Spot start');
    expect(fwd.preBookable).toBe(false);
    expect(fwd.valueDateMonths).toBe(0);
    const m6 = applySwapTenorKey(row(), 'M6');
    expect(m6.valueDateMonths).toBe(5);
    expect(m6.preBookable).toBe(true);
  });
});
