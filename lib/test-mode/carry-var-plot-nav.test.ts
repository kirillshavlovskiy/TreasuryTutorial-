import { describe, expect, it } from 'vitest';
import { carryFwd } from '@/lib/test-mode/liquidity-frontier';
import {
  clampCarryVarPlotView,
  inPlotRect,
  type CarryVarPlotView,
} from '@/lib/test-mode/carry-var-plot-nav';

const world: CarryVarPlotView = {
  xMin: 0,
  xMax: 0.2,
  yMin: -0.04,
  yMax: 0.08,
};

describe('carry-var-plot-nav', () => {
  it('keeps a zoom window inside the padded world', () => {
    const next = clampCarryVarPlotView(
      { xMin: 0.04, xMax: 0.08, yMin: 0, yMax: 0.02 },
      world,
      0.012,
    );
    expect(next.xMin).toBeGreaterThanOrEqual(-0.1);
    expect(next.xMax).toBeLessThanOrEqual(0.3);
    expect(next.xMax).toBeGreaterThan(next.xMin);
    expect(next.yMax).toBeGreaterThan(next.yMin);
  });

  it('zooms isotropically around a keep point', () => {
    const keepX = 0.06;
    const keepZ = carryFwd(0.01, 0.012);
    const next = clampCarryVarPlotView(
      { xMin: 0.05, xMax: 0.07, yMin: 0.005, yMax: 0.015 },
      world,
      0.012,
      { x: keepX, z: keepZ },
    );
    expect(next.xMin).toBeLessThan(keepX);
    expect(next.xMax).toBeGreaterThan(keepX);
  });

  it('reports whether a screen point sits in the plot', () => {
    expect(inPlotRect(80, 40, 72, 32, 568, 268)).toBe(true);
    expect(inPlotRect(10, 40, 72, 32, 568, 268)).toBe(false);
  });
});
