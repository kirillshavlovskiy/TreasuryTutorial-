/**
 * Shared Carry-vs-CFaR plot math — isotropic zoom/pan for portfolio and
 * per-currency liquidity frontier charts.
 */

import { carryFwd } from '@/lib/test-mode/liquidity-frontier';

export type CarryVarPlotView = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

export function svgLocalXY(
  el: SVGSVGElement,
  clientX: number,
  clientY: number,
  W: number,
  H: number,
): { sx: number; sy: number } | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    sx: ((clientX - rect.left) / rect.width) * W,
    sy: ((clientY - rect.top) / rect.height) * H,
  };
}

export function inPlotRect(
  sx: number,
  sy: number,
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
): boolean {
  return sx >= padL && sx <= padL + plotW && sy >= padT && sy <= padT + plotH;
}

export function placeAxisSpan(
  start: number,
  span: number,
  lo: number,
  hi: number,
): { start: number; span: number } {
  const room = hi - lo;
  if (!(room > 1e-12)) return { start: lo, span: Math.max(span, 0) };
  let s = Math.min(span, room);
  let a = start;
  if (a < lo) a = lo;
  if (a + s > hi) a = hi - s;
  if (a < lo) {
    a = lo;
    s = room;
  }
  return { start: a, span: s };
}

/** Shrink asinh-carry window vs CFaR so vertical shape reads clearly. */
export function emphasizeCarryFrame(
  yMin: number,
  yMax: number,
  carryS: number,
  emphasis: number,
  mustInclude: readonly number[],
): { yMin: number; yMax: number } {
  const zLo = carryFwd(yMin, carryS);
  const zHi = carryFwd(yMax, carryS);
  if (!(zHi > zLo + 1e-9)) return { yMin, yMax };
  const mid = (zLo + zHi) / 2;
  let half = Math.max((zHi - zLo) / (2 * Math.max(emphasis, 1)), 0.08);
  for (const yv of mustInclude) {
    if (!Number.isFinite(yv)) continue;
    half = Math.max(half, Math.abs(carryFwd(yv, carryS) - mid) * 1.06);
  }
  return {
    yMin: carryS * Math.sinh(mid - half),
    yMax: carryS * Math.sinh(mid + half),
  };
}

/**
 * Clamp a zoom/pan window inside `world` with isotropic X / asinh-Z scaling.
 */
export function clampCarryVarPlotView(
  next: CarryVarPlotView,
  world: CarryVarPlotView,
  carryS: number,
  keep?: { x: number; z: number },
  preferAspect?: number | null,
): CarryVarPlotView {
  const minXSpan = 0.01;
  const worldXSpan = Math.max(world.xMax - world.xMin, minXSpan);
  const xLo = world.xMin - worldXSpan * 0.35;
  const xHi = world.xMax + worldXSpan * 0.35;
  const maxXSpan = Math.max(xHi - xLo, minXSpan);

  const minZSpan = 0.14;
  const worldZMin = carryFwd(world.yMin, carryS);
  const worldZMax = carryFwd(world.yMax, carryS);
  const worldZSpan = Math.max(worldZMax - worldZMin, minZSpan);
  const zLo = worldZMin - worldZSpan * 1.15;
  const zHi = worldZMax + worldZSpan * 1.15;
  const maxZSpan = Math.max(zHi - zLo, minZSpan);

  const reqXSpan = Math.max(next.xMax - next.xMin, 1e-15);
  let rawZ0 = carryFwd(next.yMin, carryS);
  let rawZ1 = carryFwd(next.yMax, carryS);
  if (rawZ1 < rawZ0) {
    const swap = rawZ0;
    rawZ0 = rawZ1;
    rawZ1 = swap;
  }
  const reqZSpan = Math.max(rawZ1 - rawZ0, 1e-15);

  let xSpan = reqXSpan;
  let zSpan = reqZSpan;

  if (preferAspect != null && preferAspect > 1e-12) {
    const curAspect = xSpan / zSpan;
    if (Math.abs(curAspect / preferAspect - 1) > 0.08) {
      const geo = Math.sqrt(xSpan * zSpan);
      zSpan = geo / Math.sqrt(preferAspect);
      xSpan = geo * Math.sqrt(preferAspect);
    }
  }

  const bump = Math.max(1, minXSpan / xSpan, minZSpan / zSpan);
  xSpan *= bump;
  zSpan *= bump;

  const shrink = Math.min(1, maxXSpan / xSpan, maxZSpan / zSpan);
  xSpan *= shrink;
  zSpan *= shrink;

  if (xSpan < minXSpan - 1e-12 || zSpan < minZSpan - 1e-12) {
    xSpan = Math.min(maxXSpan, Math.max(minXSpan, xSpan));
    zSpan = Math.min(maxZSpan, Math.max(minZSpan, zSpan));
  }

  const xAnchor = keep?.x ?? (next.xMin + next.xMax) / 2;
  const zAnchor = keep?.z ?? (rawZ0 + rawZ1) / 2;
  const tX = (xAnchor - next.xMin) / reqXSpan;
  const tZ = (zAnchor - rawZ0) / reqZSpan;
  const xPlaced = placeAxisSpan(xAnchor - tX * xSpan, xSpan, xLo, xHi);
  const zPlaced = placeAxisSpan(zAnchor - tZ * zSpan, zSpan, zLo, zHi);
  return {
    xMin: xPlaced.start,
    xMax: xPlaced.start + xPlaced.span,
    yMin: carryS * Math.sinh(zPlaced.start),
    yMax: carryS * Math.sinh(zPlaced.start + zPlaced.span),
  };
}
