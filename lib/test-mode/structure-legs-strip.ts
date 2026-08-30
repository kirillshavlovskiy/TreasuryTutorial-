/**
 * Structure · legs — map the selected structure onto the frontier-modal card
 * strip. Overlay fill lists Mix FCY only. Swap fill lists the funding strip
 * (rolling / term / strip-to-term). Both lists Mix + funding. Edits write
 * back to the same schedule the parent nest renders. Do not size H* or
 * rewrite liquidity-book cells.
 */

import type { LiquiditySwapLegRow } from '@/lib/test-mode/liquidity-strategies';
import {
  fundingSwapTenorLabel,
  peakFundingSwapBookM,
  scaleFundingScheduleToBook,
  stripDisplayedSwapFcyM,
  type StandingStripMode,
} from '@/lib/test-mode/liquidity-strip-stage';
import {
  parseAskFillMode,
  type AskFillMode,
} from '@/lib/test-mode/solution-pick';

const NOTIONAL_DUST = 0.001;

/**
 * Which bands the Structure · legs strip lists for the selected fill.
 * Overlay is the Mix FCY bullet — never the operating / standing SWAP
 * programme. Funding SWAP lives in swap / both only.
 */
export function structureStripBands(fillMode: AskFillMode | undefined): {
  overlay: boolean;
  swap: boolean;
} {
  const fill = parseAskFillMode(fillMode);
  if (fill === 'swap') return { overlay: false, swap: true };
  if (fill === 'both') return { overlay: true, swap: true };
  return { overlay: true, swap: false };
}

export const SWAP_LEG_STYLES = ['Spot start', 'Fwd start', 'Bullet'] as const;
export type SwapLegStyle = (typeof SWAP_LEG_STYLES)[number];

export const SWAP_TENOR_KEYS = ['M1', 'M2', 'M3', 'M6'] as const;
export type SwapTenorKey = (typeof SWAP_TENOR_KEYS)[number];

export const OPTION_STRUCTURES = ['Vanilla', 'Collar', 'KO'] as const;
export type OptionStructure = (typeof OPTION_STRUCTURES)[number];

export const OPTION_DIRECTIONS = ['Buy put', 'Buy call', 'Sell'] as const;
export type OptionDirection = (typeof OPTION_DIRECTIONS)[number];

export const OPTION_STRIKE_MODES = ['ATMF', 'Delta', 'Absolute'] as const;
export type OptionStrikeMode = (typeof OPTION_STRIKE_MODES)[number];

export const OPTION_PREMIUM_STYLES = ['Upfront', 'Deferred', 'Zero-cost'] as const;
export type OptionPremiumStyle = (typeof OPTION_PREMIUM_STYLES)[number];

export const OPTION_CUTS = ['NY 10am', 'TOK 3pm', 'LDN 4pm'] as const;
export type OptionCut = (typeof OPTION_CUTS)[number];

export type StructureOptionDraft = {
  id: string;
  tenor: string;
  notional: number;
  structure: OptionStructure;
  direction: OptionDirection;
  strikeMode: OptionStrikeMode;
  delta: number;
  months: number;
  premiumStyle: OptionPremiumStyle;
  barrier: number;
  cut: OptionCut;
};

const BLANK_PRICING = {
  fcyOnUsdYr: 0,
  usdOnUsdYr: 0,
  pointsUsdYr: 0,
  midPoints: null as number | null,
  hasPoints: true,
  interestUsdYr: 0,
  netUsdYr: 0,
};

export function swapLegStyle(
  leg: Pick<LiquiditySwapLegRow, 'preBookable'>,
  bookingMode: StandingStripMode | undefined,
): SwapLegStyle {
  if (bookingMode === 'term') return 'Bullet';
  return leg.preBookable ? 'Fwd start' : 'Spot start';
}

export function swapTenorKey(
  leg: Pick<LiquiditySwapLegRow, 'valueDateMonths'>,
): string {
  return `M${Math.max(0, Math.round(leg.valueDateMonths)) + 1}`;
}

export function tenorKeyToValueDateMonths(key: string): number {
  const n = Number.parseInt(key.replace(/^M/i, ''), 10);
  if (!Number.isFinite(n) || n < 1) return 0;
  return n - 1;
}

/**
 * Scale a priced funding strip to the inspected standing S.
 * Origin / empty S → no legs (overdraft books nothing).
 * $ fields scale with the same factor as notional so card readouts match S.
 */
export function scalePricedStripToStanding(
  schedule: readonly LiquiditySwapLegRow[],
  targetPeakFcyM: number,
): LiquiditySwapLegRow[] {
  if (schedule.length === 0) return [];
  if (!Number.isFinite(targetPeakFcyM) || Math.abs(targetPeakFcyM) < NOTIONAL_DUST) {
    return [];
  }
  const basePeak = peakFundingSwapBookM(schedule);
  const sized = scaleFundingScheduleToBook(schedule, targetPeakFcyM);
  if (Math.abs(basePeak) < NOTIONAL_DUST) return sized;
  const f = targetPeakFcyM / basePeak;
  if (!Number.isFinite(f) || Math.abs(f - 1) < 1e-6) return sized;
  return sized.map(l => ({
    ...l,
    fcyOnUsdYr: l.fcyOnUsdYr * f,
    usdOnUsdYr: l.usdOnUsdYr * f,
    pointsUsdYr: l.pointsUsdYr * f,
    interestUsdYr: l.interestUsdYr * f,
    netUsdYr: l.netUsdYr * f,
  }));
}

/** Display ÷ book peak — 1 when the inspected S is the live strip. */
export function stripStandingScale(
  schedule: readonly Pick<LiquiditySwapLegRow, 'outstanding'>[],
  selectedStanding: number,
): number {
  const peak = peakFundingSwapBookM(schedule);
  if (Math.abs(peak) < NOTIONAL_DUST) return 1;
  const k = selectedStanding / peak;
  return Number.isFinite(k) && Math.abs(k) > 1e-9 ? k : 1;
}

export function applySwapStyle(
  leg: LiquiditySwapLegRow,
  style: SwapLegStyle,
): LiquiditySwapLegRow {
  if (style === 'Spot start') {
    return { ...leg, preBookable: false, valueDateMonths: 0, cycleIndex: 0 };
  }
  if (style === 'Fwd start') {
    const vd = Math.max(1, leg.valueDateMonths, leg.cycleIndex);
    return { ...leg, preBookable: true, valueDateMonths: vd, cycleIndex: vd };
  }
  return { ...leg, preBookable: false };
}

export function applySwapTenorKey(
  leg: LiquiditySwapLegRow,
  key: string,
): LiquiditySwapLegRow {
  const vd = tenorKeyToValueDateMonths(key);
  return {
    ...leg,
    valueDateMonths: vd,
    cycleIndex: vd,
    preBookable: vd > 0 ? true : leg.preBookable,
  };
}

export function applySwapDisplayedNotional(
  leg: LiquiditySwapLegRow,
  displayedFcyM: number,
  bookingMode: StandingStripMode | undefined,
): LiquiditySwapLegRow {
  const n = Number.isFinite(displayedFcyM) ? displayedFcyM : 0;
  if (bookingMode === 'rolling') {
    const newLeg = leg.cycleIndex === 0 || !leg.preBookable
      ? n
      : n - leg.rolledForward;
    return {
      ...leg,
      outstanding: n,
      newLeg,
    };
  }
  return {
    ...leg,
    newLeg: n,
    outstanding: leg.rolledForward + n,
  };
}

/** Patch one unscaled book-of-record row from a displayed (selected-S) notional. */
export function patchBookSwapNotional(
  schedule: readonly LiquiditySwapLegRow[],
  index: number,
  displayedFcyM: number,
  selectedStanding: number,
  bookingMode: StandingStripMode | undefined,
): LiquiditySwapLegRow[] {
  const k = stripStandingScale(schedule, selectedStanding);
  const unscaled = k === 0 ? displayedFcyM : displayedFcyM / k;
  return schedule.map((l, i) => (
    i === index ? applySwapDisplayedNotional(l, unscaled, bookingMode) : l
  ));
}

export function patchBookSwapLeg(
  schedule: readonly LiquiditySwapLegRow[],
  index: number,
  patch: (leg: LiquiditySwapLegRow) => LiquiditySwapLegRow,
): LiquiditySwapLegRow[] {
  return schedule.map((l, i) => (i === index ? patch(l) : l));
}

export function removeBookSwapLeg(
  schedule: readonly LiquiditySwapLegRow[],
  index: number,
): LiquiditySwapLegRow[] {
  return schedule.filter((_, i) => i !== index);
}

function scalePricing(
  src: LiquiditySwapLegRow,
  fromNotional: number,
  toNotional: number,
): Pick<
  LiquiditySwapLegRow,
  'fcyOnUsdYr' | 'usdOnUsdYr' | 'pointsUsdYr' | 'interestUsdYr' | 'netUsdYr'
> {
  if (Math.abs(fromNotional) < NOTIONAL_DUST) return BLANK_PRICING;
  const f = toNotional / fromNotional;
  if (!Number.isFinite(f)) return BLANK_PRICING;
  return {
    fcyOnUsdYr: src.fcyOnUsdYr * f,
    usdOnUsdYr: src.usdOnUsdYr * f,
    pointsUsdYr: src.pointsUsdYr * f,
    interestUsdYr: src.interestUsdYr * f,
    netUsdYr: src.netUsdYr * f,
  };
}

export function addFwdSwapLeg(
  schedule: readonly LiquiditySwapLegRow[],
  bookFcyM: number,
): LiquiditySwapLegRow[] {
  const sign = bookFcyM < 0 || (bookFcyM === 0 && (schedule[0]?.newLeg ?? 0) < 0)
    ? -1
    : 1;
  const n = schedule.length;
  const slice = (Number.isFinite(bookFcyM) && Math.abs(bookFcyM) > NOTIONAL_DUST
    ? Math.abs(bookFcyM) / Math.max(n + 1, 1)
    : Math.abs(schedule[0] ? stripDisplayedSwapFcyM(schedule[0], undefined) : 0)
  ) * sign;
  const last = schedule[n - 1];
  const vd = last ? Math.max(last.valueDateMonths, last.cycleIndex) + 1 : 0;
  const rolled = last?.outstanding ?? 0;
  const srcNotional = last
    ? (Math.abs(last.newLeg) > NOTIONAL_DUST ? last.newLeg : last.outstanding)
    : slice;
  const priced = last
    ? scalePricing(last, srcNotional, slice)
    : BLANK_PRICING;
  const next: LiquiditySwapLegRow = {
    ...BLANK_PRICING,
    ...priced,
    hasPoints: true,
    midPoints: last?.midPoints ?? null,
    cycleIndex: vd,
    valueDateMonths: vd,
    newLeg: slice,
    rolledForward: rolled,
    outstanding: rolled + slice,
    preBookable: n > 0,
    settleMonths: last?.settleMonths ?? 1,
  };
  if (n === 0) {
    next.preBookable = false;
    next.cycleIndex = 0;
    next.valueDateMonths = 0;
    next.rolledForward = 0;
    next.outstanding = slice;
  }
  return [...schedule, next];
}

export function defaultOptionDraft(
  bookFcyM: number,
  cycleCount: number,
  index: number,
): StructureOptionDraft {
  const n = Math.max(1, cycleCount);
  const slice = (Number.isFinite(bookFcyM) ? Math.abs(bookFcyM) : 0) / n;
  const month = Math.min(index + 1, n);
  return {
    id: `op${index}-${month}`,
    tenor: `M${month}`,
    notional: slice,
    structure: 'Vanilla',
    direction: 'Buy put',
    strikeMode: 'Delta',
    delta: 25,
    months: 3,
    premiumStyle: 'Upfront',
    barrier: 110,
    cut: 'NY 10am',
  };
}

export function swapCardTenor(leg: LiquiditySwapLegRow): string {
  return fundingSwapTenorLabel(leg);
}

export function swapCardSub(
  leg: LiquiditySwapLegRow,
  bookingMode: StandingStripMode | undefined,
): string {
  return swapLegStyle(leg, bookingMode);
}
