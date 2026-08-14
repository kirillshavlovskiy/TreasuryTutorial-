import { describe, expect, it } from 'vitest';
import { splineBand, splinePath, type SplinePt } from './spline';

/** Walk an SVG "M x,y C ...' path back into the cubics it describes. */
function cubics(
  d: string,
): { p0: SplinePt; c1: SplinePt; c2: SplinePt; p1: SplinePt }[] {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  expect(nums.length).toBeGreaterThanOrEqual(2);
  expect((nums.length - 2) % 6).toBe(0);
  const out: { p0: SplinePt; c1: SplinePt; c2: SplinePt; p1: SplinePt }[] = [];
  let p0: SplinePt = [nums[0]!, nums[1]!];
  for (let i = 2; i < nums.length; i += 6) {
    const p1: SplinePt = [nums[i + 4]!, nums[i + 5]!];
    out.push({ p0, c1: [nums[i]!, nums[i + 1]!], c2: [nums[i + 2]!, nums[i + 3]!], p1 });
    p0 = p1;
  }
  return out;
}

/** Sample the drawn curve densely — the only thing the reader actually sees. */
function sample(d: string, per = 40): SplinePt[] {
  const pts: SplinePt[] = [];
  for (const { p0, c1, c2, p1 } of cubics(d)) {
    for (let s = 0; s <= per; s += 1) {
      const t = s / per;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      pts.push([
        w0 * p0[0] + w1 * c1[0] + w2 * c2[0] + w3 * p1[0],
        w0 * p0[1] + w1 * c1[1] + w2 * c2[1] + w3 * p1[1],
      ]);
    }
  }
  return pts;
}

const at = (ys: readonly number[]): SplinePt[] => ys.map((v, i) => [i * 10, v]);

describe('splinePath', () => {
  it('passes through every simulated value rather than approximating them', () => {
    const ys = [0, -3, -11, -8, -20, -14, -14, -2];
    const segs = cubics(splinePath(at(ys)));
    expect(segs).toHaveLength(ys.length - 1);
    segs.forEach((seg, i) => {
      expect(seg.p0[1]).toBeCloseTo(ys[i]!, 1);
      expect(seg.p1[1]).toBeCloseTo(ys[i + 1]!, 1);
      expect(seg.p0[0]).toBeCloseTo(i * 10, 1);
    });
  });

  it('never draws a drawdown deeper than any path produced', () => {
    // The whole point of the monotone clamp: an overshooting spline would
    // invent a trough below the simulated worst case and the reserve read off
    // this chart would be a number no simulation ever generated.
    const ys = [0, -1, -2, -30, -30, -4, -1, 0];
    const drawn = sample(splinePath(at(ys)));
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    for (const [, y] of drawn) {
      expect(y).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(y).toBeLessThanOrEqual(hi + 1e-6);
    }
  });

  it('rounds the reserve trough into a basin instead of a hard corner', () => {
    const ys = [0, -4, -9, -15, -9, -4, 0];
    const drawn = sample(splinePath(at(ys)));
    const trough = drawn.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(trough[1]).toBeCloseTo(-15, 1);
    // A polyline meets its minimum at a corner: the two sides arrive with
    // opposite, non-zero slopes. A monotone spline flattens to zero there, so
    // the floor line lands on a curve and not on a spike.
    const near = drawn.filter(p => Math.abs(p[0] - trough[0]) < 4);
    const slope = (near[near.length - 1]![1] - near[0]![1]) / (near[near.length - 1]![0] - near[0]![0]);
    expect(Math.abs(slope)).toBeLessThan(0.1);
    const straightSlope = Math.abs((-15 - -9) / 10);
    expect(Math.abs(slope)).toBeLessThan(straightSlope / 4);
  });

  it('keeps a flat run flat so a dormant reserve does not appear to drift', () => {
    const ys = [0, -5, -5, -5, -5, -12];
    const drawn = sample(splinePath(at(ys)));
    const middle = drawn.filter(p => p[0] > 12 && p[0] < 38);
    for (const [, y] of middle) expect(y).toBeCloseTo(-5, 6);
  });

  it('holds a running maximum monotone all the way across', () => {
    const ys = [0, -2, -2, -6, -6, -6, -9, -9];
    const drawn = sample(splinePath(at(ys)));
    for (let i = 1; i < drawn.length; i += 1) {
      expect(drawn[i]![1]).toBeLessThanOrEqual(drawn[i - 1]![1] + 1e-6);
    }
  });

  it('degrades quietly on the empty and single-point cases', () => {
    expect(splinePath([])).toBe('');
    expect(splinePath([[3, 4]])).toBe('M 3.0,4.0');
  });
});

describe('splineBand', () => {
  it('closes the fan and curves the return leg like the outbound one', () => {
    const hi = at([0, -2, -6, -3]);
    const lo = at([0, -8, -18, -12]);
    const d = splineBand(hi, lo);
    expect(d.endsWith(' Z')).toBe(true);
    // Two curved legs joined by the single straight hop across the far edge.
    expect(d.match(/ C /g) ?? []).toHaveLength(2 * (hi.length - 1));
    expect(d.match(/ L /g) ?? []).toHaveLength(1);
  });

  it('draws nothing when either edge is missing', () => {
    expect(splineBand([], at([0, -1]))).toBe('');
    expect(splineBand(at([0, -1]), [])).toBe('');
  });
});
