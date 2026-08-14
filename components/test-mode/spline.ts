export type SplinePt = readonly [number, number];

/**
 * Monotone cubic Hermite (Fritsch–Carlson), emitted as SVG cubic Béziers.
 *
 * Deliberately not Catmull-Rom: these series carry hard settlement spikes and
 * running maxima that must never appear to fall, and an overshooting spline
 * would draw dips, and even negative values, the simulation never produced.
 * The clamp also leaves a flat run genuinely flat and rounds a local minimum
 * into a smooth basin rather than a sharp V, which is what the reserve trough
 * needs to read as a curve.
 *
 * x must be monotone but may run either way, so the same code smooths a
 * band's return leg.
 */
export function splineTail(pts: readonly SplinePt[]): string {
  const n = pts.length;
  if (n < 2) return '';
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = pts[i + 1]![0] - pts[i]![0];
    h.push(dx);
    d.push(dx === 0 ? 0 : (pts[i + 1]![1] - pts[i]![1]) / dx);
  }
  const m: number[] = new Array<number>(n);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i]!;
      m[i + 1] = tau * b * d[i]!;
    }
  }
  let out = '';
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const t = h[i]! / 3;
    out +=
      ` C ${(x0 + t).toFixed(1)},${(y0 + m[i]! * t).toFixed(1)}` +
      ` ${(x1 - t).toFixed(1)},${(y1 - m[i + 1]! * t).toFixed(1)}` +
      ` ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return out;
}

export function splinePath(pts: readonly SplinePt[]): string {
  if (pts.length === 0) return '';
  const [x0, y0] = pts[0]!;
  const move = `M ${x0.toFixed(1)},${y0.toFixed(1)}`;
  return pts.length === 1 ? move : `${move}${splineTail(pts)}`;
}

/** Closed band between two series over the same x, both edges smoothed so the
 * fill does not keep polygonal edges against curved lines. */
export function splineBand(
  hi: readonly SplinePt[],
  lo: readonly SplinePt[],
): string {
  if (hi.length === 0 || lo.length === 0) return '';
  const loRev = [...lo].reverse();
  const [jx, jy] = loRev[0]!;
  return `${splinePath(hi)} L ${jx.toFixed(1)},${jy.toFixed(1)}${splineTail(loRev)} Z`;
}
