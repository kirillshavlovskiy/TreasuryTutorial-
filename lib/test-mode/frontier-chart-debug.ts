const TAG = '[frontier-chart]';

export function frontierChartDebugEnabled(): boolean {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
    return process.env.DEBUG_FRONTIER_CHART === '1'
      || process.env.NEXT_PUBLIC_DEBUG_FRONTIER_CHART === '1';
  }
  return true;
}

export function logFrontierChart(
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!frontierChartDebugEnabled()) return;
  console.info(TAG, event, payload);
}

export function frontierPointCoords(
  p: { portfolioVarUsd?: number; totalCarryUsdYr?: number; k?: number } | null | undefined,
): { x: number; y: number; k: number } | null {
  if (!p) return null;
  return {
    x: p.portfolioVarUsd ?? 0,
    y: p.totalCarryUsdYr ?? 0,
    k: p.k ?? 0,
  };
}
