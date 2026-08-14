/**
 * Shared curriculum / Workbench desk tab labels and visibility.
 * Top nav is driven by SimulatorTab ids; labels match Task 01.
 */

import type { SimulatorTab } from '@/app/dashboard/Simulator';
import type { AnalyticalLayer, DecisionLayer } from '@/lib/workspace-store';

/** Curriculum-style labels for Simulator top nav. */
export const CURRICULUM_TAB_LABELS: Partial<Record<SimulatorTab, string>> = {
  simulator: 'FX Risk',
  hedging: 'Hedging Decision',
  liveLadder: 'Consolidated Live Ladder',
  analytics: 'Analytics',
  liquidity: 'Liquidity',
  dataUpload: 'Market data',
  sensitivity: 'Sensitivity',
  monteCarlo: 'Monte Carlo',
};

/** Always hide LP Layer Setup / IR Profile / Sensitivity on the curriculum desk. */
export const CURRICULUM_BASE_HIDDEN: SimulatorTab[] = [
  'layers',
  'irprofile',
  'sensitivity',
];

/** Analytical layers selectable in curriculum create/edit (Sensitivity blocked). */
export const CURRICULUM_SELECTABLE_ANALYTICAL = new Set<AnalyticalLayer>([
  'riskMetrics',
]);

/**
 * Hide desk tabs based on dashboard decision / analytical layers.
 * Missing hedging → hide Hedging + Live Ladder.
 * Missing riskMetrics → hide Analytics + Liquidity + Market data.
 */
export function hiddenTabsForLayers(
  decision: readonly DecisionLayer[],
  analytical: readonly AnalyticalLayer[],
): SimulatorTab[] {
  const hide = new Set<SimulatorTab>(CURRICULUM_BASE_HIDDEN);
  if (!decision.includes('hedging')) {
    hide.add('hedging');
    hide.add('liveLadder');
  }
  if (!analytical.includes('riskMetrics')) {
    hide.add('analytics');
    hide.add('liquidity');
    hide.add('dataUpload');
  }
  if (!analytical.includes('monteCarlo')) hide.add('monteCarlo');
  return [...hide];
}

export function sanitizeCurriculumAnalytical(
  layers: readonly AnalyticalLayer[],
): AnalyticalLayer[] {
  return layers.filter(l => CURRICULUM_SELECTABLE_ANALYTICAL.has(l));
}
