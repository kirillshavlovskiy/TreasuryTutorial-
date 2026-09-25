'use client';
import Decimal from 'decimal.js';

import {
  Fragment,
  cloneElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  swapPointsToPriceDelta,
  isUsdPerFcyQuoted,
  usdMarketPair,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import {
  type HedgeInstrument,
  type HedgeIpaQuote,
  type HedgeOrderType,
  type HedgeTicket,
  type PreparedHedgeProfile,
  bracketRoleFor,
  classifyBracketLevel,
  classifyRestingLevel,
  fcySideFromPairSide,
  chartTicketsAtEdge,
  fillTicketAtEdge,
  isEditableWorkingOrder,
  isMarketExecutedHedgeTicket,
  legPeersAtEdge,
  newHedgeTicketId,
  signedLocalMForPairSide,
  sessionExecutedCoverAbs,
  sessionPendingHedgeAbs,
  sessionStripClipAbs,
  sessionBookOverlayClipAbs,
  packageForStructure,
  restingOrderHitSide,
  restingOrderTriggersAt,
  preparedFromStripChoice,
  stripChoicesOf,
  stripPackageForTicketView,
  ticketOpensAsStrip,
  stripExecutionStarted,
  bookedStripResumeSeed,
  resumePartWorkedStripOnBook,
} from '@/lib/test-mode/hedge-var';
import {
  freeStripSettleEnds,
  nextFreeStripEdges,
  occupiedStripEdgeIndices,
  occupiedStripTenorMonths,
  stripCoverSlotMonths,
  stripLadderMonths,
} from '@/lib/test-mode/rolling-hedge';
import {
  executionFillRate,
  POST_FILL_TAPE_TAIL_MS,
  ticketPlacedAtMs,
  formatGoodTillMs,
  goodTillMsForValidity,
  bankForLeg,
  limitTakeProfitHit,
  placementAnchorRate,
  spotReferencedLegShift,
  tapeOrderLevels as tapeOrderLevelsForChart,
  ticketTradeSide,
  ticketOrderTypeChip,
  type OrderValidity,
  type TicketOrderTypeChip,
} from '@/lib/test-mode/ticket-desk-label';
import {
  canConfirmSimTicket,
  pipSizeOf,
  sampleOptionMarketCharts,
  simulateTicketPrice,
  type SimSpotQuote,
  type SimTicketPriceResult,
  type TickDir,
} from '@/lib/test-mode/sim-ticket-price';
import {
  clickTradePadQuote,
  clickTradePadResetsToSpot,
  leaveRateFieldEnabled,
  stripPadShowsLiveQuote,
  spotTileStripLegFields,
  stripLegTenorFields,
  stripLevelFillRate,
  bookedForwardFromSpotFill,
} from '@/lib/test-mode/click-trade-pad';
import {
  SPOT_DAY_MAX_WINDOW_MS,
  TAPE_TRAIL_MAX_POINTS,
  appendLiveTapeTick,
  dropTapeConventionBreak,
  isCurrentOverlayTapeFill,
  isTapeContinuityBreak,
  withFillPrints,
  liveTapeQuoteForOrder,
  overlayOpenTapeTrail,
  overlayTapeConventionLabel,
  placementMarkFromTrail,
  pickSpotDayStoreBarSec,
  restingTapeAnchorMid,
  spotDayCandlesToPremiumTicks,
  spotDayCandlesToTapeTicks,
  tapeFillPrint,
  linearTapeInstrument,
  tapeInstrument,
  tapeJumpPips,
  tapeLookbackStartMs,
  tapeQuoteKey,
  tapeQuoteKeyCandidates,
  type SpotDayCandle,
  type SpotDayStoreBarSec,
  type TapeLookback,
} from '@/lib/test-mode/tape-candles';
import type { ExecutionLogEvent } from '@/lib/test-mode/execution-monitor';
import { defaultStripLegCount } from '@/lib/test-mode/remodel-prepared-hedge';
import { ChartViewFrame } from '@/components/ChartViewToggle';
import {
  OptionSkewPayoutChart,
  type TapeCandleSide,
  type DeskTapeFill,
  type OptionDeskPick,
} from '@/components/test-mode/OptionSkewPayoutChart';
import {
  ExposureHedgePathChart,
} from '@/components/test-mode/ExposureHedgePathChart';
import type { HedgePathBasisId } from '@/lib/test-mode/exposure-hedge-path';
import {
  fetchFxSpot,
  fetchFxSpotDayCandles,
  isRefinitivTokenExpiredMessage,
} from '@/lib/refinitivPriceClient';
import { Pencil, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { CalendarIcon } from 'lucide-react';
import { addYears, startOfToday } from 'date-fns';
import { enGB } from 'react-day-picker/locale';
import { DeskIcon, type DeskIconName } from '@/components/DeskIcons';
import {
  STRIKE_SHORTCUTS,
  parseStrikeInput,
  strikeShortcutActive,
} from '@/lib/strikeNotation';
import {
  VAR_EXPOSURE_OPTIONS,
  VAR_HORIZON_OPTIONS,
  horizonIdForForecastMonths,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

const BOOK_INSTRUMENTS: {
  id: HedgeInstrument | 'swap';
  label: string;
  icon: DeskIconName;
  hint: string;
  soon?: boolean;
}[] = [
  { id: 'spot', label: 'Spot', icon: 'asset-currencies', hint: 'T+2' },
  { id: 'forward', label: 'Forward', icon: 'instr-forward', hint: 'Outright' },
  { id: 'option', label: 'Option', icon: 'instr-option', hint: 'Vanilla' },
  { id: 'swap', label: 'Swap', icon: 'instr-swap', hint: 'Near/far' },
];

const VOL_PREFS = ['auto', 'surface', 'atlas', 'seed'] as const;

type QuoteSide = 'bid' | 'mid' | 'ask';
type VolPref = (typeof VOL_PREFS)[number];
type HitSide = 'bid' | 'ask';
type HitTarget =
  | { kind: 'main' }
  // months is the leg's settle, captured at arm time — a stable identity
  // that survives liveStripPkg swapping from the draft to the booked
  // package mid-interaction (e.g. a matcher poll landing between the two
  // clicks a leg fill needs). `key` alone is `leg-${leg.index}-${i}`,
  // derived from array position in whichever package is current, so it can
  // point at nothing in the package resolved by the second click — and
  // executeHit's `if (!row) return` failed silently.
  | { kind: 'leg'; key: string; months: number };
type TapePt = { bid: number; ask: number; mid: number; t: number; marker?: boolean };

function tapeWithFillMarker(
  trail: readonly TapePt[],
  filledAtMs: number | undefined,
  px: number | null | undefined,
): TapePt[] {
  const lastMid = trail.length > 0 ? trail[trail.length - 1]!.mid : null;
  const fillOnThisTape =
    px != null
    && px > 0
    && (lastMid == null || !isTapeContinuityBreak(px, lastMid));
  const pts: TapePt[] = trail.map(p => ({ ...p, marker: false }));
  if (
    !fillOnThisTape
    || filledAtMs == null
    || !(filledAtMs > 0)
    || px == null
    || !(px > 0)
  ) {
    return pts;
  }
  // Stamp the execution print onto the marked tick — do not leave the live
  // mid at fill time, or a tick-marker fallback walks with the tape.
  const stamp = (point: TapePt): TapePt => {
    const half = Math.max(
      Math.abs(point.ask - point.bid) / 2,
      Math.abs(point.mid) * 1e-6,
    );
    return {
      ...point,
      t: filledAtMs,
      mid: px,
      bid: px - half,
      ask: px + half,
      marker: true,
    };
  };
  const near = pts.findIndex(p => Math.abs(p.t - filledAtMs) < 1500);
  if (near >= 0) {
    pts[near] = stamp(pts[near]!);
    return pts;
  }
  if (pts.length === 0) return pts;
  const closest = pts.reduce((best, point, index) =>
    Math.abs(point.t - filledAtMs) < Math.abs(pts[best]!.t - filledAtMs)
      ? index
      : best,
  0);
  pts[closest] = stamp(pts[closest]!);
  return pts;
}

function sameHitTarget(a: HitTarget | null, b: HitTarget): boolean {
  if (a == null) return false;
  if (a.kind === 'main') return b.kind === 'main';
  return b.kind === 'leg' && a.key === b.key;
}

/** Selected Bid/Ask chip — vermillion, not washed Tailwind orange. */
const HIT_CHIP_ON = 'border-[#FF5722] bg-[#FF5722] text-white';

type ExecFill = {
  key: string;
  label: string;
  instrument: HedgeInstrument;
  sizeM: number;
  rate: number | null;
  bank: string;
  premiumUsd: number | null;
};

type ExecReport = {
  at: string;
  atMs: number;
  pair: string;
  hit: HitSide;
  side: 'Buy' | 'Sell';
  scope: 'strip' | 'bullet' | 'leg';
  fills: ExecFill[];
};

export type TicketBookChoice = {
  structure: 'bullet' | 'strip';
  package?: PreparedHedgeProfile;
  /** `leg` = one strip row; `strip` = every open row from the main tiles. */
  fillScope?: 'main' | 'leg' | 'strip';
  /** Per-leg live fill outrights, keyed by strip edge index. */
  stripFills?: readonly { edgeIndex: number; rate: number | null }[];
  /** Market-filled cover tickets for an all-legs main-tile hit. */
  stripTickets?: readonly HedgeTicket[];
};

function parseLeaveRate(raw: string, fallback: number | null): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clockNow(): string {
  return new Date().toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatFillClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function tenorLabel(id: VarHorizonId | null): string | null {
  if (!id) return null;
  return VAR_HORIZON_OPTIONS.find(h => h.id === id)?.label ?? id;
}

function sourceLabel(blend: SimTicketPriceResult['blend']): string {
  const spot =
    blend.spotSource === 'live'
      ? 'Spot live'
      : blend.spotSource === 'bundle'
        ? 'Spot last pull'
        : 'Spot seed';
  const curve =
    blend.curveSource === 'swap-points'
      ? `Curve ${blend.curveAsOf ?? 'last download'}`
      : blend.curveSource === 'cip-deposits'
        ? 'Curve CIP fallback'
        : 'Curve none';
  const vol =
    blend.volSource === 'surface'
      ? `Vol surface${blend.surfacePulledAt ? ` ${blend.surfacePulledAt.slice(0, 10)}` : ''}`
      : blend.volSource === 'atlas'
        ? 'Vol Atlas'
        : 'Vol seed';
  return `${spot} · ${curve} · ${vol} · ${blend.quoteSide.toUpperCase()}`;
}

function defaultQuoteSide(amountLocalM: number): QuoteSide {
  return amountLocalM >= 0 ? 'ask' : 'bid';
}

function overrideSpot(mid: number): SimSpotQuote {
  const pip = mid >= 20 ? 0.01 : 0.0001;
  return { bid: mid - pip, mid, ask: mid + pip };
}

function pairSlash(pair: string): string {
  const p = pair.replace('/', '').toUpperCase();
  if (p.length < 6) return pair;
  return `${p.slice(0, 3)}/${p.slice(3, 6)}`;
}

function pairBase(pair: string): string {
  return pair.replace('/', '').toUpperCase().slice(0, 3);
}

/** Big figure + lead pip + large pips, Reuters-style. */
function splitFxPips(px: number): { big: string; lead: string; pips: string } {
  if (!(px > 0) || !Number.isFinite(px)) {
    return { big: '—', lead: '', pips: '—' };
  }
  if (px >= 20) {
    const big = Math.floor(px);
    const frac = Math.round((px - big) * 1000);
    const pips = String(Math.floor(frac / 10)).padStart(2, '0');
    return { big: String(big), lead: pips[0] ?? '0', pips };
  }
  const cents = Math.floor(px * 100);
  const big = (cents / 100).toFixed(2);
  const rest = Math.round(px * 100000 - cents * 1000);
  const pips = String(Math.floor(rest / 10)).padStart(2, '0');
  return { big, lead: pips[0] ?? '0', pips };
}

/** One-line outright from a Reuters split — `1.16` + `34` → `1.1634`. */
function joinFxPips(parts: { big: string; pips: string }): string {
  if (parts.big === '—' || parts.pips === '—') return '—';
  if (!parts.big.includes('.')) return `${parts.big}.${parts.pips}`;
  return `${parts.big}${parts.pips}`;
}

function spreadPips(bid: number, ask: number): string {
  if (!(bid > 0) || !(ask > 0)) return '—';
  const pips = (ask - bid) / pipSizeOf(bid);
  return pips.toFixed(1);
}

function addWeekdays(start: Date, n: number): Date {
  const d = new Date(start);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function settleDateOf(instrument: HedgeInstrument, tenor: VarHorizonId): Date {
  const months = VAR_HORIZON_OPTIONS.find(h => h.id === tenor)?.months ?? 1;
  return settleDateFromMonths(instrument, months);
}

function settleDateFromMonths(instrument: HedgeInstrument, months: number): Date {
  const d = new Date();
  if (instrument === 'spot' || !(months > 0)) return addWeekdays(d, 2);
  const fwd = new Date(d);
  const whole = Math.floor(months);
  const frac = months - whole;
  fwd.setMonth(fwd.getMonth() + whole);
  if (frac > 0) fwd.setDate(fwd.getDate() + Math.round(frac * 30.4375));
  return addWeekdays(fwd, 2);
}

function impliedTenorIso(
  id: VarHorizonId | 'spot',
  instrument: HedgeInstrument,
): string {
  if (id === 'spot') return toIsoDate(addWeekdays(new Date(), 2));
  const inst = instrument === 'spot' ? 'forward' : instrument;
  return toIsoDate(settleDateOf(inst, id));
}

function defaultStrikeInput(instrument: HedgeInstrument): string {
  return instrument === 'spot' ? 'ATMS' : 'ATMF';
}

const TENOR_CHIPS: { id: VarHorizonId | 'spot'; label: string }[] = [
  { id: 'spot', label: 'T+2' },
  ...VAR_HORIZON_OPTIONS.map(h => ({ id: h.id, label: h.id.toUpperCase() })),
];

function fmtSettle(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: '2-digit',
  });
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * 30.4375);
}

/** IPA-style tenor label from a month count (ON, 6M, 1Y, 2Y…). */
const UNPRICED_FORWARD_LEAVE =
  'No forward points priced for this tenor — order not left. Retry once the curve prices.';
const NO_OPEN_LEG_LEAVE =
  'That leg has already executed — order not left. Pick a leg still to trade.';

function formatMarketTenor(months: number): string {
  if (!(months > 0) || !Number.isFinite(months)) return '';
  const rungs: [string, number][] = [
    ['ON', 1 / 30],
    ['SW', 7 / 30],
    ['2W', 0.5],
    ['1M', 1],
    ['2M', 2],
    ['3M', 3],
    ['6M', 6],
    ['9M', 9],
    ['1Y', 12],
    ['2Y', 24],
    ['3Y', 36],
    ['5Y', 60],
    ['10Y', 120],
  ];
  let best = rungs[0]!;
  let bestD = Infinity;
  for (const rung of rungs) {
    const d = Math.abs(rung[1] - months);
    if (d < bestD) {
      best = rung;
      bestD = d;
    }
  }
  if (bestD <= Math.max(0.08 * months, 0.05)) return best[0];
  if (months >= 11.5) {
    const years = months / 12;
    const rounded = Math.round(years);
    if (Math.abs(years - rounded) < 0.08) return `${rounded}Y`;
  }
  const roundedM = Math.round(months);
  if (Math.abs(months - roundedM) < 0.08) return `${roundedM}M`;
  return `${months.toFixed(1)}M`;
}

function orderSideForHit(hit: HitSide): 'Buy' | 'Sell' {
  return hit === 'bid' ? 'Sell' : 'Buy';
}

function pairSideForFcySide(
  fcySide: 'Buy' | 'Sell',
  ticketCcy: string,
  pairBaseCcy: string,
): 'Buy' | 'Sell' {
  const fcyIsBase = ticketCcy.toUpperCase() === pairBaseCcy.toUpperCase();
  return fcyIsBase === (fcySide === 'Buy') ? 'Buy' : 'Sell';
}

function limitOrderSideForHit(hit: HitSide): 'Buy' | 'Sell' {
  return hit === 'bid' ? 'Buy' : 'Sell';
}

function stopLossHitForSelection(hit: HitSide): HitSide {
  return hit === 'bid' ? 'ask' : 'bid';
}

function fmtUnits(sizeM: number): string {
  return Math.round(Math.abs(sizeM) * 1_000_000).toLocaleString('en-US');
}


type StripRow = {
  key: string;
  label: string;
  instrument: HedgeInstrument;
  tenor: VarHorizonId;
  months: number;
  sizeM: number;
  near: boolean;
  linked: boolean;
  bank: string;
  bankBid: string;
  bankAsk: string;
};

function fmtCarryK(usdM: number): string {
  const k = usdM * 1000;
  const sign = k >= 0 ? '+' : '−';
  return `${sign}${Math.abs(k).toFixed(1)}K`;
}

function withStripLegEdits(
  pkg: PreparedHedgeProfile,
  enabled: Record<number, boolean>,
  deltaAbsM: Record<number, number>,
  clipAbsM?: number,
): PreparedHedgeProfile {
  if (pkg.structure !== 'strip' || pkg.legs.length === 0) return pkg;
  const sign = pkg.coverLocalM >= 0 ? 1 : -1;
  const baseCover = Math.abs(pkg.coverLocalM);
  const scale =
    clipAbsM != null && clipAbsM > 1e-9 && baseCover > 1e-9
      ? clipAbsM / baseCover
      : 1;
  let cumul = 0;
  const legs = pkg.legs.map((leg, i) => {
    const on = enabled[leg.index] !== false;
    const raw =
      deltaAbsM[leg.index] ?? incrementalLegSize(pkg.legs, i) * scale;
    const size = on && Number.isFinite(raw) ? Math.max(0, raw) : 0;
    const inc = sign * size;
    cumul += inc;
    return {
      ...leg,
      tradeNotionalLocalM: inc,
      hedgeLocalM: cumul,
    };
  });
  return { ...pkg, legs, coverLocalM: cumul };
}

function stripFromSchedule(
  pkg: PreparedHedgeProfile,
  ends: readonly number[],
  weights: readonly number[] | null,
  clipAbsM: number,
): PreparedHedgeProfile {
  if (ends.length < 1) return pkg;
  const sign = pkg.coverLocalM >= 0 ? 1 : -1;
  const w =
    weights != null && weights.length === ends.length
      ? [...weights]
      : ends.map(() => 1 / ends.length);
  const tot = w.reduce((s, n) => s + n, 0);
  const norm = tot > 1e-9 ? w.map(n => n / tot) : w;
  const clip = clipAbsM > 1e-9 ? clipAbsM : Math.abs(pkg.coverLocalM);
  let cumul = 0;
  const legs = ends.map((end, i) => {
    const size = clip * (norm[i] ?? 0);
    const inc = sign * size;
    cumul += inc;
    const prev = i > 0 ? ends[i - 1]! : 0;
    return {
      index: i,
      startMonth: prev,
      endMonth: end,
      settleMonths: end,
      hedgeLocalM: cumul,
      tradeNotionalLocalM: inc,
      label: `L${i + 1} · M${Math.round(end)}`,
    };
  });
  return {
    ...pkg,
    structure: 'strip',
    legs,
    coverLocalM: cumul,
    settleMonths: ends[ends.length - 1],
  };
}

/** Equal-window strip settles — same spacing as ExposureHedgePathChart. */
function equalStripSettleEnds(forecastMonths: number, legCount: number): number[] {
  const n = Math.max(2, legCount);
  const tf = forecastMonths > 0 ? forecastMonths : 12;
  return Array.from({ length: n }, (_, k) =>
    Math.round(((k + 1) * tf) / n),
  ).map((m, i, arr) => (i === arr.length - 1 ? tf : Math.max(1, m)));
}

function defaultHdStripPackage(args: {
  coverLocalM: number;
  basis: HedgePathBasisId;
  ticketBasis: VarSetup['exposureBasis'];
  forecastMonths: number;
  hedgeRatio?: number;
  legCount: number;
}): PreparedHedgeProfile {
  const stub: PreparedHedgeProfile = {
    structure: 'strip',
    basis: args.basis,
    ticketBasis: args.ticketBasis,
    legs: [],
    coverLocalM: args.coverLocalM,
    hedgeRatio:
      args.hedgeRatio != null && args.hedgeRatio > 1e-9 ? args.hedgeRatio : 1,
  };
  return stripFromSchedule(
    stub,
    equalStripSettleEnds(args.forecastMonths, args.legCount),
    null,
    Math.abs(args.coverLocalM),
  );
}

function incrementalLegSize(
  legs: PreparedHedgeProfile['legs'],
  i: number,
): number {
  const leg = legs[i]!;
  if (typeof leg.tradeNotionalLocalM === 'number') {
    return Math.abs(leg.tradeNotionalLocalM);
  }
  const prev = i > 0 ? legs[i - 1]!.hedgeLocalM : 0;
  return Math.abs(leg.hedgeLocalM - prev);
}

function settleLabel(months: number): string {
  if (months <= 0.05) return 'Spot';
  if (Math.abs(months - Math.round(months)) < 1e-6) return `M${Math.round(months)}`;
  return `${months.toFixed(1)}m`;
}

function buildStripRows(
  prep: PreparedHedgeProfile | null | undefined,
  instrument: HedgeInstrument,
  ccy: string,
): StripRow[] {
  if (!(prep?.structure === 'strip' && prep.legs.length > 0)) return [];
  const rows = prep.legs.map((leg, i) => {
    const months = Math.max(0, leg.settleMonths ?? leg.endMonth);
    const spotish = months <= 0.05;
    const tenor = spotish ? '1w' : horizonIdForForecastMonths(months);
    const inst: HedgeInstrument = spotish
      ? 'spot'
      : instrument === 'option'
        ? 'option'
        : 'forward';
    return {
      key: `leg-${leg.index}-${i}`,
      label: `L${i + 1} · ${settleLabel(months)}`,
      instrument: inst,
      tenor,
      months,
      // Unrounded. This is the leg's real notional, not a display value:
      // `stripRowsForOrder` books only rows with `sizeM > 1e-9`, so rounding
      // to 2dp here silently DROPPED every leg under €5,000 — a ladder split
      // across a small clip booked one leg and discarded the rest with no
      // message. It also made six equal legs of a 12.10M cover book 6 × 2.02
      // = 12.12M, over-covering by 24,240. The row renders `.toFixed(2)`, so
      // rounding at the boundary is already handled where it belongs.
      sizeM: incrementalLegSize(prep.legs, i),
      near: false,
      linked: spotish,
      bank: bankForLeg(ccy, i),
      bankBid: bankForLeg(ccy, i),
      bankAsk: bankForLeg(ccy, i + 1),
    };
  });
  const minM = Math.min(...rows.map(r => r.months));
  return rows.map(r => ({
    ...r,
    near: r.months === minM,
    linked: r.linked || r.months === minM,
  }));
}

const RATES_BOOK_VIEWS = [
  {
    id: 'path' as const,
    label: 'Path',
    title: 'Cash settlement path plan · exposure and hedge schedule',
  },
  {
    id: 'tape' as const,
    label: 'Tape',
    title: 'Recorded bid / ask candlesticks · Period picks how far back to load',
  },
];

type RatesChartView = (typeof RATES_BOOK_VIEWS)[number]['id'];

/** Height the Tape notice banner takes from an explicit plot height. */
const TAPE_NOTICE_H = 30;

/**
 * Dev-only pricing profiler. The pricing memos re-run at 1Hz (repriceTick),
 * so an unthrottled log would itself dominate the frame it is measuring:
 * accumulate per stage and report once every PRICE_PROFILE_WINDOW_MS with
 * the call count and the worst single run in the window.
 */
const PRICE_PROFILE_WINDOW_MS = 5_000;
type PriceProfileBucket = { runs: number; totalMs: number; maxMs: number; note: string };
const pricePerf: {
  windowStartMs: number;
  stages: Map<string, PriceProfileBucket>;
} = { windowStartMs: 0, stages: new Map() };

function notePriceStage(stage: string, ms: number, note = ''): void {
  if (process.env.NODE_ENV === 'production') return;
  const now = Date.now();
  if (pricePerf.windowStartMs === 0) pricePerf.windowStartMs = now;
  const bucket = pricePerf.stages.get(stage) ?? {
    runs: 0,
    totalMs: 0,
    maxMs: 0,
    note: '',
  };
  bucket.runs += 1;
  bucket.totalMs += ms;
  bucket.maxMs = Math.max(bucket.maxMs, ms);
  bucket.note = note;
  pricePerf.stages.set(stage, bucket);
  const elapsed = now - pricePerf.windowStartMs;
  if (elapsed < PRICE_PROFILE_WINDOW_MS) return;
  const parts = [...pricePerf.stages.entries()].map(
    ([name, b]) =>
      `${name}: ${b.runs}x avg=${(b.totalMs / b.runs).toFixed(1)}ms `
      + `max=${b.maxMs.toFixed(1)}ms sum=${b.totalMs.toFixed(0)}ms`
      + (b.note ? ` (${b.note})` : ''),
  );
  const sum = [...pricePerf.stages.values()].reduce((a, b) => a + b.totalMs, 0);
  console.log(
    `[price-perf] window=${(elapsed / 1000).toFixed(1)}s `
    + `busy=${sum.toFixed(0)}ms (${((sum / elapsed) * 100).toFixed(1)}% of wall)\n  `
    + parts.join('\n  '),
  );
  pricePerf.windowStartMs = now;
  pricePerf.stages.clear();
}

export type TicketPathExposure = {
  stockM: number;
  monthlyFlowM: number;
  monthlyFlows?: readonly number[];
  equalVarHedgeLocalM: number;
  endExposureM: number;
  selectedBasis: HedgePathBasisId;
  hedgeRatio: number;
  /** Live booked cover — path chart draws only the leftover increment. */
  bookedCoverLocalM?: number;
};

export function TradeTicketPanel({
  ticket,
  varSetup,
  marketRates,
  prepared,
  pathExposure,
  onClose,
  onConfirm,
  onLeaveOrder,
  onStripShapeChange,
  decisionStructure = null,
  onEditWorkingOrder,
  onCancelWorkingOrder,
  onCancelOrder,
  siblingOrder = null,
  relatedStripTickets = [],
  occupyingStripTickets = [],
  restingSides = [],
  initialTapeTrail = [],
  legTapeHistory,
  readOnly = false,
  bookSession = false,
  overlayOpenedAtMs = null,
  tapeHistoryLoading = false,
  execEvents: _execEvents = [],
}: {
  ticket: HedgeTicket;
  varSetup: VarSetup;
  marketRates?: FxMarketRatesBundle | null;
  prepared?: PreparedHedgeProfile | null;
  /** Exposure path for the Book ticket (forwards and options). */
  pathExposure?: TicketPathExposure | null;
  onClose: () => void;
  onConfirm: (ticket: HedgeTicket, choice?: TicketBookChoice) => void;
  /**
   * Leave the order working at `limitRate` instead of hitting the market.
   * Kept separate from `onConfirm`: nothing has executed, so this must not
   * supersede live cover or clear the staged package.
   */
  onLeaveOrder?: (ticket: HedgeTicket | readonly HedgeTicket[]) => void;
  /** Escalate from viewing (readOnly) to actually editing this same order. */
  /**
   * The desk reshaped the strip here (added/removed a leg, moved a settle,
   * retilted shares) — hand the resulting package back so the staged one
   * follows. Without it the edit lives only in this panel's local state and
   * the Hedging Decision table keeps rendering the pre-edit ladder. Fires
   * only for an explicit shape edit, never for the seeded package.
   */
  onStripShapeChange?: (pkg: PreparedHedgeProfile) => void;
  /**
   * Structure the Hedging Decision card is currently on. Opens this modal in
   * the same mode — a staged package cannot stand in for it, because Reset
   * leaves the card on a structure with no package behind it.
   */
  decisionStructure?: 'bullet' | 'strip' | null;
  /** Open a working order for editing — the opened one or a selected leg's. */
  onEditWorkingOrder?: (order: HedgeTicket) => void;
  /**
   * Cancel ONE working order (and its OCO sibling), leaving the rest of its
   * strip — a leg's own Cancel. `onCancelOrder` below is the whole order.
   */
  onCancelWorkingOrder?: (
    order: HedgeTicket,
    opts?: {
      /**
       * The leg was just filled at market in its place: the order is retired
       * quietly — no CANCELLED notice, hidden from the blotter — since it was
       * replaced, not cancelled by the desk.
       */
      replacedByFill?: boolean;
    },
  ) => void;
  /** Cancel this order outright — closes the panel too. */
  onCancelOrder?: () => void;
  /**
   * The other leg of this ticket's OCO bracket, if any — so its own real
   * limitRate can be shown, instead of the "reference live" auto-fill
   * silently overwriting it with the current market rate.
   */
  siblingOrder?: HedgeTicket | null;
  /** Other working/filled tickets in this strip — one fill per priced leg. */
  relatedStripTickets?: readonly HedgeTicket[];
  /**
   * Live CCY strip tickets even when Book is a leftover remaining program
   * (relatedStripTickets is empty so old fills are not greys on the new
   * ladder). Occupied tenors / edges size the leftover clip onto contracts
   * that merge will actually keep.
   */
  occupyingStripTickets?: readonly HedgeTicket[];
  /** Sides already carrying a working order for this CCY. Both for an OCO. */
  restingSides?: readonly HitSide[];
  /**
   * Tape recorded since this CCY's order was first placed (from the
   * background monitor, not from whenever this panel happens to be open) —
   * seeds the tape so reopening an order shows its whole path, not just
   * ticks from the moment you reopened it.
   */
  initialTapeTrail?: readonly (SimSpotQuote & { t: number })[];
  /**
   * Per-leg tape history for a strip, keyed by `tapeQuoteKey` — each leg walks
   * its own outright tape. Lets the chart reseed to the selected leg's own
   * path (and its placement instant) when the desk clicks between legs,
   * instead of only ever showing the leg this panel opened on.
   */
  legTapeHistory?: Readonly<Record<string, readonly (SimSpotQuote & { t: number })[]>>;
  /**
   * Opened just to look — parameters and tape, no rate/size inputs, no
   * Submit/Book/TP/SL/OCO buttons. Distinct from editing an existing
   * working order, which is a separate, explicit action on the blotter row.
   */
  readOnly?: boolean;
  /** Decision Book compose — do not pin fills from a previous strip session. */
  bookSession?: boolean;
  overlayOpenedAtMs?: number | null;
  /**
   * True while the parent's Postgres backstop fetch for this overlay's own
   * tape is in flight. Without this the chart painted an empty series on
   * first render and popped the recorded history in a moment later once the
   * fetch resolved — a visible "blank then loads" flash on every reopened
   * executed leg.
   */
  tapeHistoryLoading?: boolean;
  /** Matcher / blotter [fx-exec] lines for this overlay's tickets. */
  execEvents?: readonly ExecutionLogEvent[];
}) {
  /**
   * Only this ticket's own strip — never another CCY's strip on the book.
   * Matched by CCY + is-strip, NOT by exact stripId: a fresh strip draft has
   * no stripId yet (legs book under the panel's private sessionStripId), and
   * unifyCcyStripIds renames booked stripIds to the CCY's canonical one —
   * both broke an id-equality match, so an executed leg was never found as a
   * peer and its grey filled tile vanished. The book enforces one live strip
   * per CCY, which is exactly what this filter expresses.
   */
  const relatedOwnStripTickets = relatedStripTickets.filter(
    t => t.ccy === ticket.ccy && Boolean(t.stripId),
  );
  const occupancyStripTickets = occupyingStripTickets.filter(
    t => t.ccy === ticket.ccy && Boolean(t.stripId) && t.status !== 'cancelled',
  );
  const stripStarted = stripExecutionStarted(relatedOwnStripTickets);
  const defaultTenor: VarHorizonId =
    ticket.maturity && VAR_HORIZON_OPTIONS.some(h => h.id === ticket.maturity)
      ? ticket.maturity
      : varSetup.horizon;
  // A forward opens on the FORWARD reference, and that reference is the
  // live spot + FWD points for the input tenor (the pricing pad rebases the
  // outright off the live spot print every beat, and the matcher triggers
  // forwards off the same derived rate — see pullSharedSpotTape). Strips
  // open on FWD — Spot is not a strip contract.
  const openAsStrip = ticketOpensAsStrip({
    ticket,
    bookSession,
    decisionStructure,
    prepared,
  });
  const [instrument, setInstrument] = useState<HedgeInstrument>(() => {
    if (ticket.instrument === 'option') return 'option';
    // Nothing selected yet: open on SPOT. The chart and the tiles follow the
    // modal's selection, so before there is one they must show the series
    // that actually exists — storage is spot-only (one CCY|spot per
    // currency) and a forward chart is derived from it with the leg's
    // stamped points, which a ticket that has booked nothing does not have.
    // Opening on forward drew a derived series with no points to derive
    // from, put spot-referenced levels a convention away from the candles,
    // and priced a tile the desk had not asked for.
    const hasOwnStory =
      (ticket.limitRate != null && ticket.limitRate > 0)
      || (ticket.filledAtMs != null && ticket.filledAtMs > 0)
      || ticket.status === 'booked';
    if (!hasOwnStory) return 'spot';
    // Reopened: the booked instrument IS the selection.
    return openAsStrip ? 'forward' : ticket.instrument;
  });
  const bulletSettleInit = (() => {
    if (prepared?.structure === 'strip') return null;
    const settle = packageForStructure(prepared, 'bullet')?.settleMonths;
    return settle != null && settle > 0 ? settle : null;
  })();
  const [tenor, setTenor] = useState<VarHorizonId>(
    bulletSettleInit != null
      ? horizonIdForForecastMonths(bulletSettleInit)
      : defaultTenor,
  );
  const [settleIso, setSettleIso] = useState<string | null>(null);
  const [strikeInput, setStrikeInput] = useState(() => {
    if (ticket.instrument === 'option' && ticket.ipaQuote?.strikeInput) {
      return ticket.ipaQuote.strikeInput;
    }
    const inst =
      ticket.instrument === 'option'
        ? 'option'
        : openAsStrip
          ? 'forward'
          : ticket.instrument;
    return defaultStrikeInput(inst);
  });
  /**
   * `side` is the PAIR-BASE side everywhere it is consumed —
   * `${side} ${baseCcy}` rows, limitTakeProfitHit(side), bracketSide,
   * signedLocalMForPairSide. The hedge sign / ticket.orderSide are the FCY
   * side; on the 11 USD-base desk CCYs those are opposites (Sell PLN = Buy
   * USD), so seeding `side` from the raw sign inverted the whole bracket
   * presentation there: wrong Side row, flipped TP/SL pads, and a sign flip
   * in signedLocalMForPairSide. Always convert via pairSideForFcySide.
   */
  const pairSideFromFcySign = (localM: number): 'Buy' | 'Sell' =>
    pairSideForFcySide(
      localM >= 0 ? 'Sell' : 'Buy',
      ticket.ccy,
      pairBase(usdMarketPair(ticket.ccy)),
    );
  const [side, setSide] = useState<'Buy' | 'Sell'>(
    pairSideFromFcySign(ticket.amountLocalM),
  );
  const [optionPut, setOptionPut] = useState(side === 'Sell');
  const optionProtectionLabel = side === 'Sell' ? 'BUY PUT' : 'BUY CALL';
  const optionFinancingLabel = side === 'Sell' ? 'SELL CALL' : 'SELL PUT';
  const optionProtectionIsPut = side === 'Sell';
  const optionFinancingIsPut = !optionProtectionIsPut;
  const [sizeM, setSizeM] = useState(
    Math.round(Math.abs(ticket.amountLocalM) * 100) / 100,
  );
  const [quoteSide, setQuoteSide] = useState<QuoteSide>(
    defaultQuoteSide(ticket.amountLocalM),
  );
  const [volPref, setVolPref] = useState<VolPref>('auto');
  const [spotOverride, setSpotOverride] = useState('');
  const [tileMenu, setTileMenu] = useState(false);
  const [structure, setStructure] = useState<'bullet' | 'strip'>(
    openAsStrip ? 'strip' : 'bullet',
  );
  const [isStructureSelectionOpen, setIsStructureSelectionOpen] = useState(false);
  const preconfiguredStructure = prepared?.structure ?? null;
  const structurePreconfigured = preconfiguredStructure != null;
  const [ratesLeft, setRatesLeft] = useState<'structure' | 'chart'>(
    openAsStrip ? 'structure' : 'chart',
  );
  // A spot-referenced ticket (spot, and the spot brackets that hedge a
  // forward leg) opens on today's record whatever its state: its story —
  // levels, PLACED pin, spot fills — is drawn on that same series, so the
  // desk keeps the day's history when it leaves or fills an order. A
  // forward's or option's story lives on the outright, so a ticket with one
  // opens on its own 1s tape instead.
  const ticketTapeInstrument = tapeInstrument(ticket);
  // One price chart — the Tape. Path is the cash settlement path plan, the
  // desk's own choice when it wants the schedule rather than the market.
  const [ratesChartView, setRatesChartView] = useState<RatesChartView>('tape');
  // How far back the Tape loads: the order's own story, or a window whose
  // older stretch comes from the 1m day record in this chart's convention.
  //
  // "order" only means something once there IS an order: the window comes
  // from its placement and fills. On a ticket with no story it resolves to
  // no window at all (`tapeLookbackStartMs` returns null), the record fetch
  // early-returns, and the chart can only show what accumulates live from
  // the moment the panel opened — the desk watching a currency before
  // placing anything saw an empty plot with the whole day already in the
  // database. Default to a real window whenever there is no story to use,
  // which is what a Book compose already did.
  const [tapeLookback, setTapeLookback] = useState<TapeLookback>(() => {
    const hasOwnStory =
      (ticket.limitRate != null && ticket.limitRate > 0)
      || (ticket.filledAtMs != null && ticket.filledAtMs > 0)
      || ticket.status === 'booked';
    // The DAY, not the last hour. The record persists (7-day retention on
    // the day bars, none on the 1s tape) and a session routinely holds
    // since the morning, but a 1h default opened every chart on the last
    // sixty minutes of it — read, reasonably, as "nothing before 3pm was
    // ever saved". Show what is there; the From control narrows it.
    return bookSession || !hasOwnStory ? 'today' : 'order';
  });
  // An execution moves the desk back onto its tape from the Path plan.
  useEffect(() => {
    if (ticket.status === 'booked' || ticket.filledAtMs != null) {
      setRatesChartView('tape');
    }
  }, [ticket.status, ticket.filledAtMs]);
  const [ratesFullScreen, setRatesFullScreen] = useState(false);
  const [ratesFullH, setRatesFullH] = useState(560);
  const [tickTradesHost, setTickTradesHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [deskSwap, setDeskSwap] = useState(false);
  const bulletPkg =
    packageForStructure(prepared, 'bullet')
    ?? packageForStructure(ticket.sourcePackage, 'bullet');
  const preparedStrip = packageForStructure(prepared, 'strip');
  const ticketStrip = packageForStructure(ticket.sourcePackage, 'strip');
  const stripPkg = (() => {
    const protect = (p: PreparedHedgeProfile | null) =>
      p != null
      && (p.preparedFor === 'carry' || p.preparedFor === 'liquidity');
    if (protect(ticketStrip) && ticketStrip) return ticketStrip;
    if (protect(preparedStrip) && preparedStrip) return preparedStrip;
    // On a Book compose the ticket's own package IS the card's selection, so
    // it wins outright. The more-legs tiebreak below let a stale staged
    // 8-leg package override a freshly configured 6-leg one.
    if (bookSession && ticketStrip) return ticketStrip;
    if (ticketStrip && preparedStrip) {
      return ticketStrip.legs.length >= preparedStrip.legs.length
        ? ticketStrip
        : preparedStrip;
    }
    return ticketStrip ?? preparedStrip;
  })();
  const stripChoiceBase = prepared ?? ticket.sourcePackage ?? null;
  const stripChoices = stripChoicesOf(prepared, ticket.sourcePackage);
  const [choiceIdx, setChoiceIdx] = useState<number | null>(null);
  const chosenPkg =
    choiceIdx != null && stripChoices[choiceIdx] && stripChoiceBase
      ? preparedFromStripChoice(stripChoices[choiceIdx]!, stripChoiceBase)
      : null;
  const [legEnabled, setLegEnabled] = useState<Record<number, boolean>>({});
  const [legDeltaM, setLegDeltaM] = useState<Record<number, number>>({});
  const [schedEnds, setSchedEnds] = useState<number[] | null>(null);
  const [schedWeights, setSchedWeights] = useState<number[] | null>(null);
  const [ticketStripLegs, setTicketStripLegs] = useState<number | null>(null);
  /** Set by a real leg/schedule edit here; consumed once by the save effect. */
  const stripShapeDirtyRef = useRef(false);
  const bookedStripFromSeed = useMemo(() => {
    // Book compose mints a stripId that is on nothing yet. A part-worked
    // related strip is still a resume — keep its original rows. A finished
    // previous ladder is not in ownStripTickets (clean sheet).
    const seed = bookedStripResumeSeed(
      ticket.stripId,
      relatedOwnStripTickets,
      overlayOpenedAtMs,
    );
    if (!seed) return null;
    const pkg = stripPackageForTicketView(relatedOwnStripTickets, seed);
    return pkg?.structure === 'strip' && pkg.legs.length >= 2 ? pkg : null;
  }, [relatedOwnStripTickets, ticket.stripId, overlayOpenedAtMs]);
  // Analytics restaged a different remaining ladder (6-leg leftover vs the
  // executed 5-leg stamp). Do not pin Book to the old sourcePackage.
  const bookedStripPkg =
    resumePartWorkedStripOnBook({
      bookedStamp: bookedStripFromSeed,
      staged: ticket.sourcePackage ?? preparedStrip ?? stripPkg,
    })
      ? bookedStripFromSeed
      : null;
  const preconfiguredStrip =
    bookedStripPkg
    ?? (chosenPkg?.structure === 'strip' && chosenPkg.legs.length > 0
      ? chosenPkg
      : stripPkg && stripPkg.legs.length > 0
        ? stripPkg
        : null);
  const hasPreconfiguredStrip = preconfiguredStrip != null;
  const forecastTf =
    typeof varSetup.forecastMonths === 'number' && varSetup.forecastMonths > 0
      ? varSetup.forecastMonths
      : 12;
  const leftoverStrip =
    bookSession
    && bookedStripPkg == null
    && occupancyStripTickets.some(
      t =>
        t.instrument !== 'option'
        && !t.bracketRole
        && (t.status === 'booked' || t.status === 'scheduled'),
    );
  // Freeze occupied tenors at overlay open. Counting fills from THIS
  // session as occupied rebuilt the leftover ladder without those rows, so
  // a market print vanished from the modal the moment it booked.
  const leftoverOccupiedTickets = useMemo(() => {
    if (!leftoverStrip) return occupancyStripTickets;
    const opened = overlayOpenedAtMs;
    if (opened == null || !Number.isFinite(opened)) return occupancyStripTickets;
    return occupancyStripTickets.filter(t => {
      const at =
        (t.filledAtMs != null && Number.isFinite(t.filledAtMs) ? t.filledAtMs : 0)
        || 0;
      return at > 0 && at <= opened;
    });
  }, [leftoverStrip, occupancyStripTickets, overlayOpenedAtMs]);
  const leftoverSessionClip = useMemo(() => {
    if (!leftoverStrip) return null;
    return sessionBookOverlayClipAbs({
      programLocalM: ticket.amountLocalM,
      tickets: occupancyStripTickets,
      bookSession: true,
      openedAtMs: overlayOpenedAtMs,
    });
  }, [
    leftoverStrip,
    ticket.amountLocalM,
    occupancyStripTickets,
    overlayOpenedAtMs,
  ]);
  const leftoverClipAbs =
    leftoverSessionClip != null
      ? leftoverSessionClip.pendingAbs
      : Math.abs(ticket.amountLocalM);
  const hdDefaultStripSeed = useMemo((): PreparedHedgeProfile | null => {
    if (structure !== 'strip' || hasPreconfiguredStrip) return null;
    const seed = defaultHdStripPackage({
      coverLocalM: leftoverStrip ? leftoverClipAbs : ticket.amountLocalM,
      basis: pathExposure?.selectedBasis ?? 'varNeutral',
      ticketBasis: varSetup.exposureBasis,
      forecastMonths: forecastTf,
      hedgeRatio: pathExposure?.hedgeRatio,
      legCount: ticketStripLegs ?? defaultStripLegCount(varSetup),
    });
    if (!leftoverStrip) return seed;
    const occupied = occupiedStripTenorMonths(leftoverOccupiedTickets, ticket.ccy);
    if (occupied.size === 0) return seed;
    return stripFromSchedule(
      seed,
      freeStripSettleEnds(forecastTf, seed.legs.length, occupied),
      null,
      leftoverClipAbs,
    );
  }, [
    structure,
    hasPreconfiguredStrip,
    leftoverStrip,
    leftoverClipAbs,
    leftoverOccupiedTickets,
    ticket.amountLocalM,
    ticket.ccy,
    pathExposure?.selectedBasis,
    pathExposure?.hedgeRatio,
    varSetup,
    forecastTf,
    ticketStripLegs,
  ]);
  const baseStripPkg = preconfiguredStrip ?? hdDefaultStripSeed;
  const stripEditsDirty =
    Object.keys(legEnabled).length > 0 || Object.keys(legDeltaM).length > 0;
  const liveStripPkg = useMemo(() => {
    if (!baseStripPkg) return baseStripPkg;
    const clip = leftoverStrip ? leftoverClipAbs : Math.abs(ticket.amountLocalM);
    const bookedOnBook =
      Boolean(ticket.stripId)
      && bookedStripPkg
      && bookedStripPkg.legs.length >= 2
      && relatedOwnStripTickets.some(
        t => t.status === 'booked' || t.status === 'scheduled',
      );
    if (bookedOnBook && bookedStripPkg) {
      return stripEditsDirty
        ? withStripLegEdits(bookedStripPkg, legEnabled, legDeltaM, clip)
        : bookedStripPkg;
    }
    const occupied = leftoverStrip
      ? occupiedStripTenorMonths(leftoverOccupiedTickets, ticket.ccy)
      : new Set<number>();
    const requestedEnds = (): number[] => {
      if (schedEnds && schedEnds.length >= 2) return [...schedEnds];
      if (ticketStripLegs != null && ticketStripLegs >= 2) {
        return equalStripSettleEnds(forecastTf, ticketStripLegs);
      }
      return baseStripPkg.legs.map(l => l.settleMonths ?? l.endMonth);
    };
    let pkg = baseStripPkg;
    if (leftoverStrip) {
      const ends = occupied.size > 0
        ? freeStripSettleEnds(forecastTf, requestedEnds().length, occupied)
        : requestedEnds();
      const weights =
        schedWeights && schedWeights.length === ends.length
          ? schedWeights
          : null;
      pkg = stripFromSchedule(baseStripPkg, ends, weights, clip);
    } else if (schedEnds && schedEnds.length >= 2) {
      pkg = stripFromSchedule(baseStripPkg, schedEnds, schedWeights, clip);
    } else if (
      ticketStripLegs != null
      && ticketStripLegs >= 2
      && ticketStripLegs !== baseStripPkg.legs.length
    ) {
      pkg = stripFromSchedule(
        baseStripPkg,
        equalStripSettleEnds(forecastTf, ticketStripLegs),
        null,
        clip,
      );
    }
    if (stripEditsDirty) {
      return withStripLegEdits(pkg, legEnabled, legDeltaM, clip);
    }
    return pkg;
  }, [
    baseStripPkg,
    bookedStripPkg,
    leftoverStrip,
    leftoverClipAbs,
    leftoverOccupiedTickets,
    stripEditsDirty,
    legEnabled,
    legDeltaM,
    schedEnds,
    schedWeights,
    ticketStripLegs,
    ticket.amountLocalM,
    ticket.ccy,
    relatedOwnStripTickets,
    forecastTf,
  ]);
  const ownStripTickets = useMemo(() => {
    if (!leftoverStrip || !liveStripPkg || liveStripPkg.legs.length === 0) {
      return relatedOwnStripTickets;
    }
    const tenorToRow = new Map<number, number>();
    liveStripPkg.legs.forEach((l, i) => {
      tenorToRow.set(Math.round(l.settleMonths ?? l.endMonth), i);
    });
    return occupancyStripTickets
      .filter(t => {
        const m = stripCoverSlotMonths(t);
        return m != null && tenorToRow.has(m);
      })
      .map(t => ({
        ...t,
        stripEdgeIndex: tenorToRow.get(stripCoverSlotMonths(t)!) ?? t.stripEdgeIndex,
      }));
  }, [
    leftoverStrip,
    liveStripPkg,
    relatedOwnStripTickets,
    occupancyStripTickets,
  ]);
  const leftoverBookEdges = useMemo(() => {
    if (!leftoverStrip || !liveStripPkg || liveStripPkg.legs.length === 0) {
      return null;
    }
    return nextFreeStripEdges(
      occupiedStripEdgeIndices(leftoverOccupiedTickets, ticket.ccy),
      liveStripPkg.legs.length,
    );
  }, [
    leftoverStrip,
    liveStripPkg,
    leftoverOccupiedTickets,
    ticket.ccy,
  ]);
  // Outstanding is the unfilled ladder, not compose leftover minus fills
  // (that double-count showed 0.00M on reopen). Pad / option / remaining
  // spot all size off this. A full-program print on one edge only spends
  // that row. Leftover Book subtracts only fills after the overlay opened
  // so occupied old tenors do not eat the remaining clip.
  // Both branches below return {executedAbs, pendingAbs}; renaming on the way
  // out is what binds them. Destructuring the OLD names silently produced two
  // `undefined`s, so `pendingHedgeAbs > 1e-9` was always false — which zeroed
  // the strip clip (setSizeM(0)) and made the whole outstanding feature inert.
  const { executedAbs: executedCoverAbs, pendingAbs: pendingHedgeAbs } = useMemo(() => {
    if (leftoverSessionClip) return leftoverSessionClip;
    const stripClip =
      liveStripPkg?.structure === 'strip' && liveStripPkg.legs.length > 0
        ? sessionStripClipAbs(
            liveStripPkg.legs.map((_, i) =>
              incrementalLegSize(liveStripPkg.legs, i),
            ),
            ownStripTickets,
          )
        : null;
    return sessionBookOverlayClipAbs({
      programLocalM: ticket.amountLocalM,
      tickets: ownStripTickets,
      bookSession,
      openedAtMs: overlayOpenedAtMs,
      stripClip,
    });
  }, [
    leftoverSessionClip,
    liveStripPkg,
    ownStripTickets,
    ticket.amountLocalM,
    bookSession,
    overlayOpenedAtMs,
  ]);
  const liveBulletPkg =
    chosenPkg?.structure === 'bullet' ? chosenPkg : bulletPkg;
  const [selectedLegKey, setSelectedLegKey] = useState<string | null>(null);
  const [legMonths, setLegMonths] = useState<number | null>(bulletSettleInit);
  const [bookUnpriced, setBookUnpriced] = useState(false);
  const [repriceTick, setRepriceTick] = useState(0);
  const [livePrint, setLivePrint] = useState<SimSpotQuote | null>(null);
  const [livePrintErr, setLivePrintErr] = useState<string | null>(null);
  const [livePrintLoading, setLivePrintLoading] = useState(false);
  // A plain "leave order" ticket (orderSideForHit's bid→Sell/ask→Buy
  // convention) must never open into the bracket UI (limitOrderSideForHit's
  // OPPOSITE bid→Buy/ask→Sell convention) — resubmitting it there flips
  // Buy/Sell silently, since submitLimitOrder always applies the bracket
  // convention regardless of which one actually built the ticket.
  const isBracketTicket =
    ticket.orderType === 'takeProfit'
    || ticket.orderType === 'stopLoss'
    || ticket.orderType === 'oco';
  const restOpen =
    (ticket.status === 'scheduled' || ticket.status === 'cancelled')
    && ticket.limitRate != null;
  // Opened through Edit: a working order with read-only OFF (leaving an
  // order, or viewing one, opens it read-only). Its own leg is being edited.
  const editingOrder =
    !readOnly && ticket.status === 'scheduled' && ticket.limitRate != null;
  const initialWorkingHit =
    restOpen
      ? ticket.orderHit
        ?? (isBracketTicket && ticket.orderSide
          ? ticket.orderSide === 'Buy' ? 'bid' : 'ask'
          : ticket.amountLocalM >= 0 ? 'ask' : 'bid')
      : null;
  const initialOrderRate =
    restOpen
      ? fmtPx(ticket.limitRate!)
      : '';
  const [workingHit, setWorkingHit] = useState<HitSide | null>(initialWorkingHit);
  const [submittedHit, setSubmittedHit] = useState<HitSide | null>(null);
  const [hitTarget, setHitTarget] = useState<HitTarget | null>(
    initialWorkingHit != null ? { kind: 'main' } : null,
  );
  const [execReport, setExecReport] = useState<ExecReport | null>(null);
  /** The desk's own Rate choice for the tape, held for one chart identity. */
  const [candleSideChoice, setCandleSideChoice] = useState<{
    key: string;
    side: TapeCandleSide;
  } | null>(null);
  /**
   * The leg side the desk's last click ARMED (`${row.key}|${hit}`). A leg
   * fills only on a second click on that same, now orange, side — never on
   * a first click that happens to find matching state left from elsewhere.
   */
  const legArmTokenRef = useRef<string | null>(null);
  const [sessionStripId] = useState(
    () => ticket.stripId ?? `strip-${ticket.ccy}-${newHedgeTicketId()}`,
  );
  // New legs join the CCY's existing strip when one is already on the book
  // (unifyCcyStripIds keeps one canonical id per CCY) — a private session id
  // is only for the very first leg of a brand-new strip.
  const fillStripId =
    (stripStarted ? ownStripTickets[0]?.stripId : undefined)
    ?? ticket.stripId
    ?? ownStripTickets[0]?.stripId
    ?? sessionStripId;
  useEffect(() => {
    if (workingHit != null || execReport != null) return;
    setSizeM(Math.round(Math.abs(ticket.amountLocalM) * 100) / 100);
    // ticket.orderSide is stored as the FCY side (fcySideFromPairSide at
    // submission) — convert it to the pair-base side this state means.
    setSide(
      ticket.orderSide != null
        ? pairSideForFcySide(
            ticket.orderSide,
            ticket.ccy,
            pairBase(usdMarketPair(ticket.ccy)),
          )
        : pairSideFromFcySign(ticket.amountLocalM),
    );
    setQuoteSide(defaultQuoteSide(ticket.amountLocalM));
  }, [ticket.id, ticket.amountLocalM, workingHit, execReport]);
  const [orderRate, setOrderRate] = useState(initialOrderRate);
  /**
   * Which PAD a ticket's level was typed into. `orderHit` carries it for
   * anything left through the ticket UI; a ticket that reached us without
   * one (matcher-created, rehydrated from a source that drops it) still has
   * to land on a pad, so derive it the same way for every ticket rather
   * than only for the sibling — the asymmetry made a main ticket with no
   * orderHit resolve to null and silently fall back to pad convention,
   * which is the labelling bug this whole path exists to prevent.
   */
  const padHitForTicket = (t: HedgeTicket | null | undefined): HitSide | null => {
    if (!t) return null;
    return (
      t.orderHit
      ?? (isBracketTicket && t.orderSide
        ? t.orderSide === 'Buy' ? 'bid' : 'ask'
        : t.amountLocalM >= 0 ? 'ask' : 'bid')
    );
  };
  const siblingHit: HitSide | null =
    (siblingOrder?.status === 'scheduled' || siblingOrder?.status === 'cancelled')
    && siblingOrder.limitRate != null
      ? padHitForTicket(siblingOrder)
      : null;
  const siblingRate =
    siblingHit != null && siblingOrder?.limitRate != null
      ? fmtPx(siblingOrder.limitRate)
      : '';
  /**
   * What the order resting on this pad actually IS, from its own
   * `bracketRole`. The pad is not the answer: a Sell executes on the bid
   * whichever bracket it is, so `hit === limitTakeProfitHit(side)` titled a
   * filled TAKE PROFIT as "Stop Loss" while its status line, read from this
   * same ticket, said "Filled · TP". Null when nothing is resting there yet,
   * which is the only case a caller may fall back to pad convention for.
   */
  const padTicketForHit = (hit: HitSide): HedgeTicket | null | undefined => {
    if (hit === padHitForTicket(ticket)) return ticket;
    if (hit === siblingHit) return siblingOrder;
    // Map by bracket role onto the pad that role occupies for this side,
    // even when orderHit was never stamped (legacy / matcher fills).
    const tpHit = limitTakeProfitHit(side);
    const role: 'takeProfit' | 'stopLoss' =
      hit === tpHit ? 'takeProfit' : 'stopLoss';
    if (ticket.bracketRole === role) return ticket;
    if (siblingOrder?.bracketRole === role) return siblingOrder;
    return null;
  };
  const bracketRoleForHit = (hit: HitSide): 'takeProfit' | 'stopLoss' | null =>
    padTicketForHit(hit)?.bracketRole ?? null;
  const [orderRates, setOrderRates] = useState<Record<HitSide, string>>({
    bid:
      initialWorkingHit === 'bid'
        ? initialOrderRate
        : siblingHit === 'bid'
          ? siblingRate
          : '',
    ask:
      initialWorkingHit === 'ask'
        ? initialOrderRate
        : siblingHit === 'ask'
          ? siblingRate
          : '',
  });
  const [orderRateEdited, setOrderRateEdited] = useState(initialWorkingHit != null);
  const initialLimitOrderType =
    ticket.bracketRole === 'stopLoss'
    || ticket.orderType === 'stopLoss'
    || ticket.orderType === 'oco'
      ? ticket.orderType === 'oco' || ticket.ocoGroupId
        ? 'oco'
        : 'stopLoss'
      : 'takeProfit';
  const [limitOrderType, setLimitOrderType] = useState<Exclude<HedgeOrderType, 'market' | 'limit'>>(initialLimitOrderType);
  const [limitMode, setLimitMode] = useState(restOpen);
  // Off by default when a real sibling leg's own level is already known —
  // otherwise this immediately overwrites it with the live market rate.
  const [referenceStopLoss, setReferenceStopLoss] = useState(siblingHit == null);
  /** Why the last leave was refused — shown in the desk error line. */
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [validity, setValidity] = useState<OrderValidity>(
    ticket.orderValidity === 'DAY' || ticket.goodTillMs != null ? 'DAY' : 'GTC',
  );
  const [tapeOn, setTapeOn] = useState(true);
  const [tickDir, setTickDir] = useState<TickDir | null>(null);
  // Same-convention anchor for seeding recorded history: a book overlay must
  // not inherit a foreign-convention trail, but a null anchor makes
  // overlayOpenTapeTrail blank EVERY book session, so a reopened booking
  // rebuilt its chart from now instead of showing the recorded tape.
  // restingTapeAnchorMid (not a hand-rolled fxOutright/limitRate fallback)
  // carries the nearLimit sanity check that catches a spot-substituted
  // outright, so a forward whose stamp was backfilled from spot doesn't
  // anchor on a spot-shaped value and filter its own history to nothing.
  // A spot-referenced order's limit RESTS on spot while its chart is drawn at
  // the leg's forward. restingTapeAnchorMid answers in the resting convention,
  // and seedDraftHistory compares that anchor against the series tail — so a
  // forward series reads as a whole-points continuity break and is discarded
  // wholesale, leaving an empty chart. Anchor in the convention drawn.
  const spotReferencedAnchorShift = spotReferencedLegShift(ticket);
  const stampedAnchorRate =
    spotReferencedAnchorShift != null
    && ticket.limitRate != null
    && ticket.limitRate > 0
      ? ticket.limitRate + spotReferencedAnchorShift
      : restingTapeAnchorMid(ticket);
  const stampedAnchor =
    stampedAnchorRate != null && stampedAnchorRate > 0
      ? { mid: stampedAnchorRate }
      : null;
  /**
   * Seed the draft ticket's recorded history into a book-session chart. The
   * anchor decides WHOLESALE whether the series is the right convention (its
   * tail vs the anchor), then only genuine convention breaks inside the
   * series are trimmed. Filtering point-by-point against one anchor (what
   * overlayOpenTapeTrail does) silently deleted every recorded tick >40 pips
   * from that single sample — a normal intraday excursion, or the whole
   * recent tail when the anchor was a stale placement stamp (review H2).
   */
  /**
   * The chart tells THIS ORDER'S story: from the placement instant (decoded
   * from the ticket ids — the earliest across the draft, its OCO sibling
   * and its strip peers) to the fill plus the post-fill tail. The in-memory
   * history map can hold far more (heartbeat backfill, an earlier
   * unwindowed fetch), and seeding it unclipped opened the chart at the
   * very beginning of the record instead of at placement.
   */
  /**
   * The desk is still trading in this panel: a strip leg is left to trade
   * (assigned once freeStripLegKeys is known). The story's END (last fill +
   * tail) cannot apply then: with every ticket booked or cancelled — say a
   * leg's order was just cancelled beside filled legs — the chart stopped
   * taking live ticks and clipped them, so placing a new order on that leg
   * showed no live rate at all.
   */
  // Declared ahead of storyWindow / clipToStory: the stickyPlaced initialiser
  // runs clipToStory during the first render, and a later declaration threw
  // "Cannot access 'deskLiveRef' before initialization".
  const deskLiveRef = useRef(false);
  const storyWindow = useMemo((): {
    fromMs: number | null;
    toMs: number | null;
    /** The story's own start, before a From window widens it; null while nothing is placed. */
    anchorMs: number | null;
  } => {
    const group = [ticket, siblingOrder, ...relatedStripTickets].filter(
      (t): t is HedgeTicket => t != null,
    );
    // Only a PLACED order anchors the story start. The draft's own id is
    // minted when the card/modal is composed, which can be long before the
    // desk actually submits — anchoring on it opened the chart with the
    // whole pre-placement feed (an SL placed at :25 showed candles from
    // :06). While nothing is placed yet fromMs stays null (free context);
    // the moment an order rests or books, the window cuts to placement.
    // A LIVE (market) execution was never placed as an order: its ticket id
    // is minted when the card/strip is composed, often long before the desk
    // clicks Bid/Ask — anchoring on the id decode dumped the whole
    // pre-interaction feed onto the chart. Only tickets that actually
    // RESTED (a limit that filled, a working limit, a cancelled order)
    // anchor via their id; market fills anchor at the interaction below.
    const placedTimes = group
      .filter(
        t =>
          t.status === 'cancelled'
          || (t.status === 'scheduled' && t.limitRate != null)
          || (t.status === 'booked' && t.limitRate != null),
      )
      .map(t => ticketPlacedAtMs(t.id))
      .filter((n): n is number => n != null);
    const fillTimes = group
      .map(t => t.filledAtMs)
      .filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
    const allDone = group.every(
      t => t.status === 'booked' || t.status === 'cancelled',
    );
    const minFill = fillTimes.length > 0 ? Math.min(...fillTimes) : null;
    let fromMs = placedTimes.length > 0 ? Math.min(...placedTimes) : null;
    if (fromMs == null && minFill != null) {
      // Market-only story: the record starts when the desk opened this
      // trade panel (the first click on the tile). Reopening the booking
      // later puts the open AFTER the fill — show a short pre-fill lead
      // plus the recorded tail instead.
      fromMs =
        overlayOpenedAtMs != null
        && overlayOpenedAtMs > 0
        && overlayOpenedAtMs <= minFill
          ? overlayOpenedAtMs
          : minFill - 60_000;
    }
    // A placement cannot postdate a fill. A reopened draft can carry a
    // REGENERATED id (book compose clones), whose decoded "placement" is
    // the reopen instant — clipping to that emptied the whole seed. When
    // the decode contradicts the fills, fall back to a span before them.
    if (fromMs != null && minFill != null && fromMs > minFill) {
      fromMs = minFill - 30 * 60_000;
    }
    // A From window moves the story's START back in time — never forward,
    // and measured from the story's own start, not from the present. Its
    // end — fill plus tail — stays the order's own. Measured from now, "1h"
    // on a booking from yesterday began after the story had ended, clipped
    // to nothing, and left the chart on the order's three minutes whatever
    // was clicked. A draft with nothing placed anchors on now.
    const anchorMs = fromMs;
    const lookbackStartMs = tapeLookbackStartMs(tapeLookback, anchorMs ?? Date.now());
    if (lookbackStartMs != null) {
      fromMs = fromMs == null ? lookbackStartMs : Math.min(fromMs, lookbackStartMs);
    }
    return {
      fromMs,
      toMs:
        allDone && fillTimes.length > 0
          ? Math.max(...fillTimes) + POST_FILL_TAPE_TAIL_MS
          : null,
      anchorMs,
    };
  }, [ticket, siblingOrder, relatedStripTickets, overlayOpenedAtMs, tapeLookback]);
  const clipToStory = (points: TapePt[]): TapePt[] =>
    // A pure clip. The old "never erase" valve returned EVERYTHING when the
    // clip matched nothing (a fetch still in flight), dumping hours of
    // quotes over the narrow story window on reopen — the loading state
    // covers the in-flight gap now, and the regenerated-id case falls back
    // to fill − 30min inside storyWindow itself.
    points.filter(
      p =>
        (storyWindow.fromMs == null || p.t >= storyWindow.fromMs)
        && (storyWindow.toMs == null || deskLiveRef.current || p.t <= storyWindow.toMs),
    );
  /**
   * Count-cap only the unwindowed live feed. A Period window (or any story
   * with a start) is the series — slicing to TAPE_TRAIL_MAX_POINTS dropped
   * the day-record head as soon as ~6h of 1s ticks filled the cap, which is
   * why Last day / 48h looked like a minute of live tape on bullet.
   */
  const trimTapeTrail = (points: TapePt[]): TapePt[] => {
    const clipped = clipToStory(points);
    if (tapeLookback !== 'order' || storyWindow.fromMs != null) return clipped;
    return clipped.length > TAPE_TRAIL_MAX_POINTS
      ? clipped.slice(-TAPE_TRAIL_MAX_POINTS)
      : clipped;
  };
  /**
   * The day record for the Tape's From window — the stretch before the
   * order's recorded 1s tape. 1m bars cover the whole window (including
   * hours recorded before sub-minute storage); a finer series is layered
   * on top when the window is short enough. Empty while From is `order`.
   */
  const [lookbackCoarse, setLookbackCoarse] = useState<readonly SpotDayCandle[]>(
    [],
  );
  const [lookbackFine, setLookbackFine] = useState<readonly SpotDayCandle[]>([]);
  const [lookbackFineBarSec, setLookbackFineBarSec] =
    useState<SpotDayStoreBarSec>(60);
  useEffect(() => {
    const nowMs = Date.now();
    const startMs = tapeLookbackStartMs(tapeLookback, storyWindow.anchorMs ?? nowMs);
    // The record is read up to the story's end (or now for a working story),
    // within the one-request cap — for 48h that is exactly the lead-in.
    const endMs = Math.min(storyWindow.toMs ?? nowMs, (startMs ?? 0) + SPOT_DAY_MAX_WINDOW_MS);
    if (startMs == null || endMs <= startMs) {
      setLookbackCoarse([]);
      setLookbackFine([]);
      return;
    }
    const fineBarSec = pickSpotDayStoreBarSec(endMs - startMs);
    let cancelled = false;
    const take = (payload: {
      candles: readonly SpotDayCandle[];
      forming: SpotDayCandle | null;
    }) => (payload.forming ? [...payload.candles, payload.forming] : payload.candles);
    const readOnce = () =>
      Promise.all([
        fetchFxSpotDayCandles({
          ccy: ticket.ccy,
          fromMs: startMs,
          toMs: endMs,
          barSec: 60,
        }),
        fineBarSec === 60
          ? null
          : fetchFxSpotDayCandles({
              ccy: ticket.ccy,
              fromMs: startMs,
              toMs: endMs,
              barSec: fineBarSec,
            }),
      ]);
    // The read is RETRIED, not abandoned. It runs on mount and its
    // dependencies never change by themselves, so one transient failure —
    // a dev route compiling on first hit, a session not yet hydrated,
    // Postgres still coming back up — cleared the record to empty and
    // nothing ever asked again. The chart then stayed blank until the desk
    // reopened the panel or touched the From control, which is the "it only
    // loads on the second attempt" report. Backoff, then give up and clear.
    const retryDelaysMs = [400, 1200, 3000];
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const [coarse, fine] = await readOnce();
          if (cancelled) return;
          setLookbackCoarse(take(coarse));
          const servedFine = fine && fine.barSec !== 60 ? fine : null;
          setLookbackFineBarSec(servedFine?.barSec ?? 60);
          setLookbackFine(servedFine ? take(servedFine) : []);
          return;
        } catch {
          const delayMs = retryDelaysMs[attempt];
          if (cancelled) return;
          if (delayMs == null) {
            setLookbackCoarse([]);
            setLookbackFine([]);
            return;
          }
          await new Promise(resolve => setTimeout(resolve, delayMs));
          if (cancelled) return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tapeLookback, ticket.ccy, storyWindow.anchorMs, storyWindow.toMs]);
  const lookbackSig = `${tapeLookback}:${lookbackFineBarSec}:${lookbackCoarse.length}:${lookbackFine.length}:${lookbackCoarse[0]?.t ?? ''}:${lookbackFine[0]?.t ?? ''}`;
  /**
   * Record ticks in `shift`'s convention for the stretch BEFORE `firstMs`
   * (the first recorded 1s print), so the two sources never overlap — the
   * 1s tape stays authoritative wherever it exists.
   */
  const lookbackTicksBefore = (firstMs: number | null, shift: number): TapePt[] => {
    if (lookbackCoarse.length === 0 && lookbackFine.length === 0) return [];
    const fineBarMs = lookbackFineBarSec * 1000;
    const fine =
      firstMs != null
        ? lookbackFine.filter(bar => bar.t + fineBarMs <= firstMs)
        : lookbackFine;
    const fineFrom = fine[0]?.t ?? null;
    const coarse =
      firstMs != null || fineFrom != null
        ? lookbackCoarse.filter(bar => {
            const end = bar.t + 60_000;
            if (firstMs != null && end > firstMs) return false;
            if (fineFrom != null && bar.t >= fineFrom) return false;
            return true;
          })
        : lookbackCoarse;
    return [
      ...spotDayCandlesToTapeTicks(coarse, shift, 60),
      ...spotDayCandlesToTapeTicks(fine, shift, lookbackFineBarSec),
    ] as TapePt[];
  };
  // Live outright − spot lands the 1m record on a forward chart. Stamps
  // win when they exist; a draft with none waits for padQuote (ref below).
  //
  // The STAMPED part is resolved HERE, not with draftLookbackShift further
  // down, because the first seed runs in a useState initializer a few lines
  // below. Initialising the ref to 0 meant that seed shifted the spot day
  // record by nothing and drew it at spot level on a forward chart. Only the
  // live-quote fallback has to wait: it needs padQuote / priced / liveSpot.
  // null = no stamp to go on (not "zero shift"), so the fallback can tell
  // the two apart.
  const stampedLookbackShift = ((): number | null => {
    if ((ticket.instrument ?? 'spot') === 'spot') return 0;
    const referenced = spotReferencedLegShift(ticket);
    if (referenced != null) return referenced;
    const s = ticket.ipaQuote?.fxSpot;
    const o = ticket.ipaQuote?.fxOutright;
    return s != null && s > 0 && o != null && o > 0 ? o - s : null;
  })();
  const lookbackShiftRef = useRef(stampedLookbackShift ?? 0);
  const [lookbackShift, setLookbackShift] = useState(stampedLookbackShift ?? 0);
  lookbackShiftRef.current = lookbackShift;
  /**
   * `logTapeLoad` is defined further down but the first seed runs in a
   * useState initializer during the same render, so calling it directly is a
   * TDZ throw. The ref is filled once that definition is reached; the very
   * first seed simply does not log.
   */
  const seedDiagRef = useRef<
    | ((
        source: string,
        key: string | null,
        shift: number,
        pts: readonly { t: number; mid: number }[],
      ) => void)
    | null
  >(null);
  const seedDraftHistory = (
    points: TapePt[],
    anchorMid: number | null,
  ): TapePt[] => {
    const shift = lookbackShiftRef.current;
    const record = lookbackTicksBefore(points[0]?.t ?? null, shift);
    const withRecord = [...record, ...points];
    const positive = withRecord.filter(p => p.mid > 0);
    // A Period window is the day record plus the 1s tape. Dropping the
    // lookback head on a 40-pip join left Last day looking like the order's
    // last minute — and only Strip's other seed path kept the record.
    if (tapeLookback !== 'order') return clipToStory(positive);
    if (!bookSession) return clipToStory(positive);
    const story = clipToStory(withRecord);
    // Two very different empties, reported apart. "Recorded tape did not
    // load" says neither, which is why the same four words have stood for
    // "the database was down", "this window was never recorded" and "the
    // rows arrived and were thrown away" — three problems, three responses.
    if (story.length === 0) {
      if (withRecord.length > 0) {
        seedDiagRef.current?.('draft-clipped-to-story', null, shift, []);
      }
      return [];
    }
    const tailMid = story[story.length - 1]!.mid;
    if (anchorMid != null && isTapeContinuityBreak(anchorMid, tailMid)) {
      const recordOnly = clipToStory(record);
      // The break is the event worth naming; which side of it survives is
      // the consequence, so the line carries both.
      seedDiagRef.current?.(
        `draft-anchor-break(anchor=${anchorMid.toFixed(5)} tail=${tailMid.toFixed(5)} ${tapeJumpPips(anchorMid, tailMid).toFixed(1)}pips of ${story.length} → ${recordOnly.length > 0 ? 'record-only' : 'empty'})`,
        null,
        shift,
        recordOnly,
      );
      return recordOnly.length > 0 ? dropTapeConventionBreak(recordOnly) : [];
    }
    return dropTapeConventionBreak(story);
  };
  const [tapeTrail, setTapeTrail] = useState<TapePt[]>(() =>
    tapeWithFillMarker(
      seedDraftHistory(
        initialTapeTrail.map(p => ({ ...p })),
        stampedAnchor?.mid ?? null,
      ),
      bookSession ? undefined : ticket.filledAtMs,
      bookSession ? null : (tapeFillPrint(ticket) ?? ticket.limitRate),
    ),
  );
  const [optionTapeTrail, setOptionTapeTrail] = useState<TapePt[]>([]);
  /**
   * First-seen execution prints by ticket id. Once a TP/SL (or limit) fills,
   * its yellow axis level and fill arrow must never rebind to live IPA /
   * Brownian pad / limit edits — lock the print here.
   */
  const [stickyFills, setStickyFills] = useState<Record<string, number>>(() => {
    const px = executionFillRate(ticket);
    return px != null ? { [ticket.id]: px } : {};
  });
  /**
   * Order-left pin (time + mid). Book compose used to suppress `placedMark`
   * because `trail[0]` is overlay-open, not leave-time — so SUBMIT never got
   * a placement pin. Stamp the real leave instant here; blotter reopen
   * seeds from the leg's recorded trail head.
   */
  const [stickyPlaced, setStickyPlaced] = useState<{
    t: number;
    px: number;
  } | null>(() => {
    if (
      (ticket.limitRate == null || !(ticket.limitRate > 0))
      && (ticket.restingAnchorRate == null || !(ticket.restingAnchorRate > 0))
    ) {
      return null;
    }
    const seed = seedDraftHistory(
      initialTapeTrail.map(p => ({ ...p })),
      stampedAnchor?.mid ?? null,
    );
    // A working order charts on spot, so its pin is its spot anchor; only
    // an executed one is on its forward (anchor + points). The forward pin
    // on a spot chart also stretched the Y range on long tenors.
    if (isMarketExecutedHedgeTicket(ticket)) {
      return placementMarkFromTrail(
        { restingAnchorRate: placementAnchorRate(ticket) },
        seed,
        ticketPlacedAtMs(ticket.id),
      );
    }
    // The seed is the order's FORWARD (spot + points); take the points back
    // off so a long tenor's spot anchor is not read as a break against it.
    const spotAnchor = ticket.restingAnchorRate ?? ticket.limitRate ?? null;
    const fwdAnchor = placementAnchorRate(ticket);
    const back =
      spotAnchor != null && spotAnchor > 0 && fwdAnchor != null && fwdAnchor > 0
        ? new Decimal(fwdAnchor).minus(spotAnchor).toNumber()
        : 0;
    return placementMarkFromTrail(
      { restingAnchorRate: spotAnchor ?? undefined },
      back === 0
        ? seed
        : seed.map(p => ({ ...p, bid: p.bid - back, ask: p.ask - back, mid: p.mid - back })),
      ticketPlacedAtMs(ticket.id),
    );
  });
  /** Amend / re-leave stamps after the first PLACED pin (CHANGE markers). */
  const [stickyChanges, setStickyChanges] = useState<
    { t: number; px: number }[]
  >([]);
  const stickyPlacedRef = useRef(stickyPlaced);
  stickyPlacedRef.current = stickyPlaced;
  const tickFade = useRef<number | null>(null);
  // null (not '') so the effect below can tell "never run yet" apart from
  // "the key genuinely changed" — the first case must NOT wipe seeded
  // history (initialTapeTrail), only a real key change should reset the trail.
  const trailKeyRef = useRef<string | null>(null);
  const lastTrailStampRef = useRef('');
  // Assigned each render once the selected-leg state below is known; the
  // draft-key merge effect must not run while another strip leg is selected.
  const selectedLegIsDraftLegRef = useRef(true);
  /**
   * True while the chart is SPOT over a draft whose own series is not: a
   * working limit order charts on spot, but `initialTapeTrail` is always the
   * draft's booked-forward series (spot + the leg's points). Assigned once
   * chartIsSpot is known.
   */
  const chartSpotOverDraftRef = useRef(false);

  useEffect(() => {
    if (initialTapeTrail.length === 0 && lookbackCoarse.length === 0 && lookbackFine.length === 0) return;
    if (!selectedLegIsDraftLegRef.current) return;
    // Merging the draft's forward series into a spot chart put one forward
    // bar 40+ pips over a working order's spot levels; the continuity filter
    // then dropped every live spot tick behind it and the chart froze.
    if (chartSpotOverDraftRef.current) return;
    setTapeTrail(current => {
      const seeded = seedDraftHistory(
        initialTapeTrail.map(point => ({ ...point })),
        current.at(-1)?.mid ?? stampedAnchor?.mid ?? null,
      );
      if (seeded.length === 0) return current;
      const byTime = new Map(current.map(point => [point.t, point]));
      for (const point of seeded) byTime.set(point.t, { ...point });
      const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
      // Clip the UNION, not just the incoming seed: points already sitting
      // in the trail from before the window was known (heartbeat backfill,
      // an unwindowed fetch) would otherwise survive every merge and open
      // the chart at the record's beginning instead of at placement.
      return trimTapeTrail(merged);
    });
    // lookbackSig: the From window's record landing (or being cleared) must
    // reseed too — lookbackCandles is read through seedDraftHistory.
    // lookbackShift: a draft forward's 1m record waits for live outright −
    // spot; applying it later must re-shift the window onto the tape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTapeTrail, bookSession, stampedAnchorRate, lookbackSig, lookbackShift]);

  // The story window can move after points are already on the trail — a fill
  // arriving sets the post-fill tail end. Re-trim in place so the chart
  // shows placement → execution + tail, never the whole recorded session.
  useEffect(() => {
    setTapeTrail(prev => {
      const clipped = clipToStory(prev);
      return clipped.length === prev.length ? prev : clipped;
    });
    // clipToStory identity changes every render; the window values are the
    // real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyWindow.fromMs, storyWindow.toMs]);
  const storyWindowRef = useRef(storyWindow);
  storyWindowRef.current = storyWindow;

  const pair = usdMarketPair(ticket.ccy);
  const baseCcy = pairBase(pair);
  const activeBasisLabel =
    VAR_EXPOSURE_OPTIONS.find(o => o.id === varSetup.exposureBasis)?.label ??
    varSetup.exposureBasis;

  const amountLocalM = signedLocalMForPairSide(
    side,
    sizeM,
    ticket.ccy,
    baseCcy,
  );
  const ignorePathBasis = useCallback((_b: HedgePathBasisId) => {}, []);
  const ignorePathApply = useCallback(
    (_b: HedgePathBasisId, _s?: 'bullet' | 'strip') => {},
    [],
  );

  const padSpot = useMemo((): SimSpotQuote | null => {
    const typed = Number(spotOverride);
    if (spotOverride.trim() && Number.isFinite(typed) && typed > 0) {
      return overrideSpot(typed);
    }
    return livePrint;
  }, [spotOverride, livePrint]);

  /** Pad / fills / LIVE REF — /api/fx-spot (server walks when overlay is stale). */
  const liveSpot = padSpot;
  const deferredLiveSpot = useDeferredValue(padSpot);
  const prevLiveMidRef = useRef<number | null>(null);

  useEffect(() => {
    if (!liveSpot || !(liveSpot.mid > 0)) return;
    const prev = prevLiveMidRef.current;
    prevLiveMidRef.current = liveSpot.mid;
    if (prev == null) return;
    const pip = pipSizeOf(liveSpot.mid);
    if (liveSpot.mid > prev + pip * 0.25) setTickDir('up');
    else if (liveSpot.mid < prev - pip * 0.25) setTickDir('down');
    else return;
    if (tickFade.current != null) window.clearTimeout(tickFade.current);
    tickFade.current = window.setTimeout(() => setTickDir(null), 720);
  }, [liveSpot]);
  useEffect(() => () => {
    if (tickFade.current != null) window.clearTimeout(tickFade.current);
  }, []);

  const pullLiveSpot = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLivePrintLoading(true);
    setLivePrintErr(null);
    try {
      const q = await fetchFxSpot({ ccy: ticket.ccy, pair });
      setLivePrint({ bid: q.bid, ask: q.ask, mid: q.mid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Live FX spot failed';
      if (!isRefinitivTokenExpiredMessage(msg)) setLivePrintErr(msg);
    } finally {
      if (!opts?.silent) setLivePrintLoading(false);
      setRepriceTick(n => n + 1);
    }
  }, [ticket.ccy, pair]);

  useEffect(() => {
    void pullLiveSpot();
    const id = window.setInterval(() => {
      void pullLiveSpot({ silent: true });
    }, 1_000);
    return () => window.clearInterval(id);
  }, [pullLiveSpot]);

  const months =
    instrument === 'spot'
      ? 0
      : legMonths != null
        ? legMonths
        : VAR_HORIZON_OPTIONS.find(h => h.id === tenor)?.months ?? 1;

  const displayedSettleIso =
    settleIso ?? toIsoDate(settleDateFromMonths(instrument, months));

  const priceArgs = {
    ccy: ticket.ccy,
    instrument,
    tenorMonths: months,
    strikeInput,
    amountLocalM,
    bundle: marketRates,
    liveSpot: deferredLiveSpot,
    volPref,
    optionPut,
  };

  const { priced, pricedBid, pricedAsk, priceError } = useMemo(() => {
    void repriceTick;
    const t0 = performance.now();
    try {
      const bid = simulateTicketPrice({ ...priceArgs, quoteSide: 'bid' });
      const ask = simulateTicketPrice({ ...priceArgs, quoteSide: 'ask' });
      const mid =
        quoteSide === 'mid'
          ? simulateTicketPrice({ ...priceArgs, quoteSide: 'mid' })
          : quoteSide === 'bid'
            ? bid
            : ask;
      notePriceStage(
        'pad',
        performance.now() - t0,
        `${instrument} ${quoteSide === 'mid' ? '3 sides' : '2 sides'}`,
      );
      return {
        priced: mid,
        pricedBid: bid,
        pricedAsk: ask,
        priceError: null as string | null,
      };
    } catch (e) {
      notePriceStage('pad', performance.now() - t0, 'threw');
      return {
        priced: null,
        pricedBid: null,
        pricedAsk: null,
        priceError: e instanceof Error ? e.message : 'Desk blend failed',
      };
    }
    // priceArgs fields listed explicitly — avoid identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    instrument,
    tenor,
    strikeInput,
    amountLocalM,
    quoteSide,
    volPref,
    optionPut,
    deferredLiveSpot,
    ticket.ccy,
    marketRates,
    repriceTick,
    months,
  ]);

  const liveTape = liveTapeQuoteForOrder(
    {
      instrument,
      limitRate: ticket.limitRate,
      restingAnchorRate: ticket.restingAnchorRate,
      ipaQuote: ticket.ipaQuote ?? priced?.quote,
    },
    {
      bid: pricedBid?.quote.fxOutright ?? null,
      ask: pricedAsk?.quote.fxOutright ?? null,
    },
    liveSpot,
  );
  const padQuote = clickTradePadQuote({
    instrument,
    livePrint: padSpot,
    pricedBid: pricedBid?.quote.fxOutright ?? null,
    pricedAsk: pricedAsk?.quote.fxOutright ?? null,
  });
  const tileBid = padQuote?.bid ?? null;
  const tileAsk = padQuote?.ask ?? null;
  const tileMid = padQuote?.mid ?? null;
  /**
   * The live SPOT quote every WORKING limit / TP / SL references. A limit
   * order rests at a spot level and triggers on the spot tape whatever leg it
   * is for (`isSpotReferenced`); once it fills it books that leg's forward —
   * spot print + the leg's points — and every surface shows the forward.
   */
  const bracketRefBid = padSpot?.bid ?? tileBid;
  const bracketRefAsk = padSpot?.ask ?? tileAsk;
  // Desk: Spot and Forward are separate contracts. Strip books FWD only —
  // Bid/Ask stay on each leg's points-based outright. Options keep premium.
  const stripPadBlockedOnFwd = clickTradePadResetsToSpot({
    structure,
    instrument,
    legCount: liveStripPkg?.legs.length ?? 0,
    selectedLegKey,
  });
  const optionPremBid = pricedBid?.quote.premiumUsd ?? null;
  const optionPremAsk = pricedAsk?.quote.premiumUsd ?? null;
  // Stamps are already resolved above so the first seed can use them; this
  // adds only the live-quote fallback, for a draft that has no stamps yet.
  const draftLookbackShift = (() => {
    if (stampedLookbackShift != null) return stampedLookbackShift;
    if (instrument === 'spot') return 0;
    const outright = padQuote?.mid ?? priced?.quote.fxOutright ?? null;
    const spotMid = liveSpot?.mid ?? priced?.quote.fxSpot ?? null;
    if (outright != null && outright > 0 && spotMid != null && spotMid > 0) {
      return outright - spotMid;
    }
    return 0;
  })();
  // FX trail stays outright/spot even while the Option desk is open.
  // Feeding premiumUsd here jumped ~3.4e6 vs ~1.16 and the identity reset
  // then wiped the forward candles on the way back.
  const trailBid = tileBid;
  const trailAsk = tileAsk;
  useEffect(() => {
    if (instrument !== 'option') return;
    if (
      optionPremBid == null
      || optionPremAsk == null
      || !(optionPremBid > 0)
      || !(optionPremAsk > 0)
    ) {
      return;
    }
    setOptionTapeTrail(prev => {
      const tick = {
        bid: optionPremBid,
        ask: optionPremAsk,
        mid: (optionPremBid + optionPremAsk) / 2,
        t: Date.now(),
      };
      const last = prev[prev.length - 1];
      if (last && last.t >= tick.t && last.mid === tick.mid) return prev;
      const next = [...prev, tick];
      return tapeLookback !== 'order' || next.length <= TAPE_TRAIL_MAX_POINTS
        ? next
        : next.slice(-TAPE_TRAIL_MAX_POINTS);
    });
  }, [instrument, optionPremBid, optionPremAsk]);
  useEffect(() => {
    if (instrument !== 'option') return;
    const premMid =
      optionPremBid != null && optionPremAsk != null
        ? (optionPremBid + optionPremAsk) / 2
        : null;
    const deltaPct = priced?.quote.deltaPercent;
    const spotNow = liveSpot?.mid ?? priced?.quote.fxSpot ?? null;
    if (
      premMid == null
      || !(premMid > 0)
      || deltaPct == null
      || !Number.isFinite(deltaPct)
      || spotNow == null
      || !(spotNow > 0)
    ) {
      return;
    }
    const premArgs = {
      spotNow,
      premiumNow: premMid,
      deltaFrac: deltaPct / 100,
      notionalFcy: Math.abs(amountLocalM) * 1_000_000,
      quotedUsdPerFcy: isUsdPerFcyQuoted(ticket.ccy),
    };
    const fineFrom = lookbackFine[0]?.t;
    const coarseForPrem =
      fineFrom != null
        ? lookbackCoarse.filter(bar => bar.t < fineFrom)
        : lookbackCoarse;
    const hist = [
      ...spotDayCandlesToPremiumTicks(coarseForPrem, { ...premArgs, barSec: 60 }),
      ...spotDayCandlesToPremiumTicks(lookbackFine, {
        ...premArgs,
        barSec: lookbackFineBarSec,
      }),
    ].sort((a, b) => a.t - b.t);
    if (hist.length === 0) return;
    setOptionTapeTrail(current => {
      const firstLive = current[0]?.t ?? null;
      const lead =
        firstLive != null ? hist.filter(point => point.t < firstLive) : hist;
      if (lead.length === 0) return current;
      const byTime = new Map(current.map(point => [point.t, point]));
      for (const point of lead) byTime.set(point.t, { ...point });
      const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
      return trimTapeTrail(merged);
    });
    // lookbackSig covers candle identity; clipToStory follows the Period window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    instrument,
    lookbackSig,
    optionPremBid,
    optionPremAsk,
    priced?.quote.deltaPercent,
    liveSpot?.mid,
    amountLocalM,
    ticket.ccy,
    storyWindow.fromMs,
    storyWindow.toMs,
  ]);
  useEffect(() => {
    setOptionTapeTrail(prev => {
      const clipped = clipToStory(prev);
      return clipped.length === prev.length ? prev : clipped;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyWindow.fromMs, storyWindow.toMs]);
  const deskErr = [livePrintErr, priceError, leaveError]
    .filter((m): m is string => Boolean(m))
    .filter(m => !isRefinitivTokenExpiredMessage(m))
    .join(' · ');
  const ratesTapeInstrument = linearTapeInstrument(instrument, months);
  const trailKey = `${pair}|${ratesTapeInstrument}|${tenor}|${settleIso ?? ''}|${months}`;
  /**
   * The live quote in the CHART's convention (chartBid / chartAsk, assigned
   * where they are computed below). Every chart writer and seed filter reads
   * this one — never `liveTape`, which follows the opened ticket and the
   * tile, and turns into live spot for any forward within 40 pips (EUR M1 /
   * M2). A 1s writer appending that onto an M1 forward chart interleaved
   * spot and forward ticks in every bar: wicks 15 pips down to spot.
   */
  const chartLiveRef = useRef<{ bid: number; ask: number; mid: number } | null>(null);
  /** chartLegShift, for seeds built in effects — one offset for seed and live. */
  const chartLegShiftRef = useRef(0);
  const legTapeHistoryRef = useRef(legTapeHistory);
  legTapeHistoryRef.current = legTapeHistory;
  // initialTapeTrail is keyed to the DRAFT ticket; while a different leg or
  // tenor is selected its merge must stay off — adjacent tenors sit inside
  // the 40-pip continuity band, so the seed filter alone cannot stop it.
  // Applies to bullets too (review M2): flipping the tenor/instrument chip
  // must not stitch the draft's previous-tenor history onto the new
  // selection. Unknown draft months (no maturityMonths, unmapped maturity)
  // keeps the merge on — same behavior as before the guard existed.
  const draftLegInstrument = ticketTapeInstrument;
  const draftLegMonths =
    draftLegInstrument === 'spot'
      ? 0
      : ticket.maturityMonths
        ?? VAR_HORIZON_OPTIONS.find(h => h.id === ticket.maturity)?.months
        ?? null;
  // selectedLegIsDraftLegRef is assigned below, once chartTicket is known.

  /**
   * When the desk clicks between strip legs the tape must reseed to *that*
   * leg's own outright history (kept per `tapeQuoteKey` by the monitor), so
   * the chart shows the leg's path since it was placed — not an empty trail
   * that only starts rebuilding from the click. The key is taken off the leg's
   * own booked ticket so it matches what the monitor stored under; spot legs
   * share the one canonical `CCY|spot` key (tapeQuoteKey, 2026-09-07 decision).
   */
  /**
   * Convention this chart draws in. A reopened strip that belongs to one
   * edge selects that row and moves the pad onto its FWD (spot + points).
   * A fresh strip book stays on the spot tile with no row selected. Clicking
   * another row puts the tile on that leg (selectStripLeg).
   */
  const chartOpensOnOwnLeg =
    ticket.stripEdgeIndex != null
    && (ticket.instrument ?? 'spot') !== 'spot'
    && instrument === 'spot';
  const chartLegInstrument: HedgeInstrument = chartOpensOnOwnLeg
    ? ticket.instrument ?? 'spot'
    : instrument;
  const chartLegMonths = chartOpensOnOwnLeg
    ? ticket.maturityMonths ?? months
    : months;
  /**
   * The selected leg's own ticket: the cover that traded it, else the
   * spot-referenced order left for it. `tapeInstrument` routes those to the
   * spot tape, so matching on it alone never finds them on a forward leg.
   */
  const legTicketForSelectedLeg = () => {
    // Resolve by the SELECTED ROW'S EDGE first. The tenor match below cannot
    // do it: `atTenor` short-circuits to true for every leg whenever the
    // panel is on the spot tile, which a strip routinely is, so `.find`
    // returned whichever ticket happened to be first in the array rather
    // than the row the desk is looking at. Everything keyed off this —
    // chartTicket, and through it chartIsSpot, chartIsOwnLeg and the series
    // shift — then resolved to a different leg between renders, which is how
    // one stateful trail ended up holding two conventions at once.
    // `buildStripRows` builds the key as `leg-<leg.index>-<edgeIndex>`, so
    // the trailing segment is the edge these tickets are stamped with.
    const selectedEdge = (() => {
      if (!selectedLegKey) return null;
      const tail = selectedLegKey.split('-').pop();
      const n = tail == null ? Number.NaN : Number(tail);
      return Number.isInteger(n) && n >= 0 ? n : null;
    })();
    if (selectedEdge != null) {
      const atEdge = relatedStripTickets.filter(
        t => (t.stripEdgeIndex ?? 0) === selectedEdge,
      );
      const own =
        atEdge.find(t => !t.bracketRole && isMarketExecutedHedgeTicket(t))
        ?? atEdge.find(isMarketExecutedHedgeTicket)
        ?? atEdge.find(t => t.status === 'scheduled')
        ?? atEdge.find(t => t.status === 'cancelled');
      if (own) return own;
    }
    const atTenor = (t: HedgeTicket) =>
      chartLegInstrument === 'spot'
      || Math.abs((t.maturityMonths ?? 0) - Math.max(0, chartLegMonths)) < 1e-6;
    return (
      relatedStripTickets.find(
        t => tapeInstrument(t) === chartLegInstrument && atTenor(t),
      )
      ?? (chartLegInstrument === 'spot'
        ? undefined
        : relatedStripTickets.find(
            t =>
              t.isSpotReferenced === true
              && (t.instrument ?? 'spot') === chartLegInstrument
              && atTenor(t),
          ))
    );
  };
  /**
   * The order whose convention this chart draws. A bullet bracket is its own
   * chart. A STRIP reopened from one of its brackets shows whichever leg the
   * desk selects, and every leg carries its own points (L2 71.95, L3 99.45,
   * L4 135.18, L5 170.98 on one real EUR ladder) — reading the OPENED
   * bracket's points for all of them drew L2's forward under L3, L4 and L5
   * while their level lines, which already follow the row, floated 27–98
   * pips above the candles. Falls back to the draft when no leg resolves.
   */
  //
  // A SELECTED leg with nothing of its own is a free leg: it charts as a
  // plain leg, not as the opened bracket. Falling back to the bracket kept
  // its spot tape, its points and its identity, so a free M6 drew the
  // opened M3 order's forward.
  const chartTicket: HedgeTicket =
    ticket.bracketRole && structure === 'strip'
      ? legTicketForSelectedLeg()
        ?? (selectedLegKey != null
          ? {
              ...ticket,
              id: `${ticket.id}:free-leg`,
              bracketRole: undefined,
              ocoGroupId: undefined,
              status: undefined,
              limitRate: undefined,
              restingAnchorRate: undefined,
              isSpotReferenced: undefined,
              stripLegPoints: undefined,
              filledAtMs: undefined,
            }
          : ticket)
      : ticket;
  // A BRACKET draft owns the chart while the chart IS its own leg:
  // spot-referenced TP/SL are monitored, matched and filled on the draft's
  // own tape (decisions.md 2026-09-07), so the tile the desk happens to have
  // selected (a FORWARD tenor row) must never drag the bracket chart onto
  // the outright — that re-opened the exact chart-vs-fill divergence the
  // server-owned tape exists to kill (chart walking M3 FWD ~1.16696 while
  // the TP/SL sat at spot 1.16277/1.16247, 42 pips below). On a strip the
  // ownership moves with the selected leg: while another leg's bracket is
  // the chart, the draft's history must not be merged back over it.
  selectedLegIsDraftLegRef.current =
    (Boolean(chartTicket.bracketRole) && chartTicket.id === ticket.id)
    || (draftLegInstrument === instrument
      && (draftLegInstrument === 'spot'
        || draftLegMonths == null
        || Math.abs(draftLegMonths - Math.max(0, months)) < 1e-6));
  /**
   * Whether the chart shows the OPENED ticket's own leg. Everything the
   * opened ticket adds on top of the series — its bracket focus, the pad's
   * typed levels, its fill stamp — belongs there only. Applied to another
   * leg's chart they drew L2's spot TP/SL lines and L2's spot fill print over
   * L1's forward candles, and the bracket focus hid L1's own market pin.
   */
  const chartIsOwnLeg = ticket.bracketRole
    ? chartTicket.id === ticket.id
    : selectedLegIsDraftLegRef.current;
  // Which convention this chart draws in. A bracket's identity is the
  // instrument it BOOKS, not the tape it matches on: tapeInstrument answers
  // the matching question and maps every spot-referenced order to 'spot', so
  // reading it here gated off the forward conversion in tapeOrderLevels and a
  // spot-referenced TP/SL opened from the blotter drew its spot limitRate
  // against its own forward chart. For anything else it is the convention the
  // chart DRAWS, not the tile: a reopened strip sits on the spot tile while
  // the opened leg's chart is that leg's forward.
  //
  // A limit order that has NOT executed — drafted in limit mode, or resting —
  // draws on the SPOT chart: it rests at a spot level on the spot tape. Once
  // it executes it has booked its leg's forward and draws on that forward.
  // On a strip the test is the SELECTED leg's own order (the leg the chart
  // draws), not the ticket that opened the panel: reopened from an executed
  // leg, a working leg must still chart on spot, and the reverse.
  //
  // A selected leg with no order of its own is decided by the desk's own
  // mode alone — never by the opened ticket's resting level, which put a
  // free leg on spot while its card quoted the leg's forward. And an order
  // being PLACED is on spot whatever has executed here, as the card is
  // (`placingLimitOrder`).
  const chartConventionTicket: HedgeTicket | null =
    structure === 'strip' && selectedLegKey != null
      ? legTicketForSelectedLeg() ?? null
      : chartTicket;
  const chartLimitWorking =
    chartConventionTicket == null
      ? limitMode
      : !isMarketExecutedHedgeTicket(chartConventionTicket)
        ? limitMode || chartConventionTicket.limitRate != null
        // An executed ticket draws its forward — unless a new whole-strip
        // order is being placed from it (no leg selected; `limitMode` only
        // turns on for an executed ticket through Leave), which rests on spot.
        : structure === 'strip' && selectedLegKey == null && limitMode;
  const chartIsSpot = chartLimitWorking
    || (chartTicket.bracketRole
      ? (chartTicket.instrument ?? 'spot') === 'spot'
      : chartLegInstrument === 'spot');
  const chartSpotOverDraft = chartIsSpot && (ticket.instrument ?? 'spot') !== 'spot';
  chartSpotOverDraftRef.current = chartSpotOverDraft;
  /** The placement pin in the chart's convention — no points on a spot chart. */
  const chartPlacementAnchor = (src: HedgeTicket): number | null =>
    chartIsSpot
      ? (src.restingAnchorRate ?? src.limitRate ?? null)
      : placementAnchorRate(src);
  const seriesLookbackShift = chartIsSpot
    ? 0
    : (spotReferencedLegShift(chartTicket) ?? draftLookbackShift);
  lookbackShiftRef.current = seriesLookbackShift;
  useEffect(() => {
    setLookbackShift(prev =>
      (prev === seriesLookbackShift ? prev : seriesLookbackShift),
    );
  }, [seriesLookbackShift]);
  const seedTrailForSelectedLeg = (): TapePt[] => {
    // A limit order that has not executed charts on SPOT, whatever leg it is
    // for: the spot record, unshifted. Every branch below derives a forward
    // series (spot + the leg's points), which put a working order's spot
    // level 30-170 pips under its own candles.
    //
    // Once it HAS executed the leg is a forward: its level is drawn at the
    // forward it booked (`bookedForwardFill`) and the rest of the series is
    // shifted, so taking the unshifted path here mixed two conventions in
    // one stateful trail — the chart kept the forward candles and grew a
    // spike down to raw spot, ~28 pips low on an M2 leg. The guard has to
    // test what the comment says; `chartIsSpot` alone does not.
    if (
      chartIsSpot
      // A forward leg on a spot chart — or the spot tile over a draft whose
      // own series is forward (the draft branch below would seed it).
      && (chartLegInstrument !== 'spot' || chartSpotOverDraftRef.current)
      // Spot BECAUSE an order is working or being placed — the same test
      // chartIsSpot made (chartLimitWorking), not a separate ticket lookup
      // that could disagree with it and seed a forward series under a spot
      // identity.
      && chartLimitWorking
    ) {
      const spotKey = `${ticket.ccy.toUpperCase()}|spot`;
      const own = clipToStory(
        (legTapeHistoryRef.current?.[spotKey] ?? []).map(point => ({
          bid: point.bid,
          ask: point.ask,
          mid: point.mid,
          t: point.t,
        })),
      );
      const points = clipToStory([
        ...lookbackTicksBefore(own[0]?.t ?? null, 0),
        ...own,
      ]);
      logTapeLoad('working-limit-spot', spotKey, 0, points);
      return (
        tapeLookback === 'order' && bookSession
          ? dropTapeConventionBreak(points)
          : points
      ) as TapePt[];
    }
    // Same seed for bullet and strip. The old early-return left every
    // non-strip identity reset on an empty trail, so Period/Interval only
    // appeared to work after the desk switched to Strip.
    if (selectedLegIsDraftLegRef.current && !chartTicket.bracketRole) {
      const seeded = seedDraftHistory(
        initialTapeTrail.map(point => ({ ...point })),
        stampedAnchor?.mid ?? chartLiveRef.current?.mid ?? null,
      );
      logTapeLoad(
        seeded.length > 0 ? 'draft-series' : 'draft-empty',
        tapeQuoteKey(ticket),
        lookbackShiftRef.current,
        seeded,
      );
      return seeded;
    }
    const finishSeededTrail = (
      points: TapePt[],
      live: { mid: number } | null,
    ): TapePt[] => {
      if (points.length === 0) return [];
      if (tapeLookback !== 'order') return points;
      if (!live) {
        return (bookSession ? dropTapeConventionBreak(points) : points) as TapePt[];
      }
      return overlayOpenTapeTrail(points, live, bookSession) as TapePt[];
    };
    // A bracket draft's chart is its own tape — the tile's instrument /
    // tenor state names the PRICED leg row, not the series the bracket
    // fills on. Seed straight from the draft's key (legacy spelling
    // included) and skip the tile-driven lookup entirely.
    if (chartTicket.bracketRole) {
      // A SPOT-REFERENCED bracket rests and fills on spot, so tapeQuoteKey
      // sends it to the currency's spot series. That is right for matching
      // and wrong for drawing: the trade it books is the leg's FORWARD, and
      // an untouched spot record put a 1.1605 chart and a 1.1605 level under
      // a blotter row reading "L2 · M5 @ 1.16779" — nothing on screen showed
      // the rate that was actually booked. Shift by the leg's own points so
      // candles, level and fill pin all read in the booked convention.
      const bracketShift = spotReferencedLegShift(chartTicket) ?? 0;
      for (const key of tapeQuoteKeyCandidates(chartTicket)) {
        const candidate = legTapeHistoryRef.current?.[key];
        if (candidate && candidate.length > 0) {
          const own = clipToStory(
            candidate.map(point => ({
              ...point,
              bid: point.bid + bracketShift,
              mid: point.mid + bracketShift,
              ask: point.ask + bracketShift,
            })),
          );
          // The From window's record, in the same convention, ahead of the
          // first recorded 1s print — never overlapping it.
          const points = clipToStory([
            ...lookbackTicksBefore(own[0]?.t ?? null, bracketShift),
            ...own,
          ]);
          logTapeLoad('bracket-own-key', key, bracketShift, points);
          const liveForBracket = bracketShift === 0 ? chartLiveRef.current : null;
          return finishSeededTrail(points, liveForBracket);
        }
      }
      // No recorded 1s tape for this bracket — the From window's record can
      // still draw its chart, in the leg's convention.
      const record = clipToStory(lookbackTicksBefore(null, bracketShift));
      logTapeLoad(
        record.length > 0 ? 'bracket-lookback-record' : 'bracket-no-history',
        tapeQuoteKey(chartTicket),
        bracketShift,
        record,
      );
      return record;
    }
    const legTicket = legTicketForSelectedLeg();
    // A book overlay hides legs that filled before it opened, so the booked
    // ticket may be gone from relatedStripTickets while the tape history —
    // keyed only by instrument and tenor — is still served. Derive the key
    // from the selected leg state when the ticket lookup comes up empty.
    const primaryKey = legTicket
      ? tapeQuoteKey(legTicket)
      : tapeQuoteKey({
          ccy: ticket.ccy,
          instrument: chartLegInstrument,
          maturityMonths:
            chartLegInstrument === 'spot' ? null : Math.max(0, chartLegMonths),
        });
    // ONE key per chart — never cross conventions (desk rule 2026-09-08).
    // This used to fall back to the canonical CCY|spot tape when a forward
    // leg's own key had no recorded history (so spot-referenced brackets
    // showed the tape they fill against), but that seeded a spot-convention
    // body under a chart whose live appends are the leg's FWD outright: the
    // series then "jumped" pips from spot into the forward in one candle.
    // The spot story belongs to the spot identity (the tile a strip opens
    // on); a forward chart with no recorded forward history starts empty
    // and builds from its own live prints.
    // ONE recorded tape per currency — the spot record (desk architecture).
    // A forward leg's series is DERIVED: spot history shifted by the leg's
    // stamped points (fxOutright − fxSpot). The spot+points derivation is
    // the PRIMARY source for a stamped forward leg — the per-forward-key
    // rows recorded before this architecture are legacy, usually end hours
    // before the order's story window, clip to nothing, and rendered a
    // blank chart on every leg-tile click. Legacy rows are the fallback
    // for stamp-less legs only.
    let history = null as
      | readonly (SimSpotQuote & { t: number })[]
      | null
      | undefined;
    let shift = 0;
    let legSource = 'leg-spot+points';
    // The leg's points, kept for the From window's record even when the
    // leg's own 1s tape never arrived.
    let legPointsShift = 0;
    if (chartLegInstrument !== 'spot') {
      // Points for THIS leg: the executed leg's own stamps when it has
      // filled, otherwise the panel's live quote for the selected tenor —
      // `priced` follows the selected leg, so its outright/spot pair is
      // that leg's current points. Without the live fallback a leg still
      // being composed (no booked ticket yet) had no shift at all and its
      // chart could not render until the booking round-trip landed.
      // A spot-referenced order's stamps are spot-side, and its outright is
      // the resting limit until it fills — its points are the leg points it
      // was left for. Only a leg that executed stamps real points.
      const legShift = legTicket != null ? spotReferencedLegShift(legTicket) : null;
      const stampedSpot = legTicket?.ipaQuote?.fxSpot;
      const stampedOutright = legTicket?.ipaQuote?.fxOutright;
      const stamped =
        legShift
        ?? (legTicket != null
          && isMarketExecutedHedgeTicket(legTicket)
          && stampedSpot != null && stampedSpot > 0
          && stampedOutright != null && stampedOutright > 0
            ? stampedOutright - stampedSpot
            : null);
      const liveOutright = priced?.quote.fxOutright;
      const liveQuoteSpot = priced?.quote.fxSpot;
      const livePoints =
        // Only when the TILE prices the same convention this chart draws:
        // while the tile still lags on spot, its quote's points are spot's
        // (zero), which would flatten a forward leg's shift to nothing.
        chartLegInstrument === instrument
        && liveOutright != null && liveOutright > 0
        && liveQuoteSpot != null && liveQuoteSpot > 0
          ? liveOutright - liveQuoteSpot
          : null;
      // Last, the live offset the chart's ticks take (chartLegShift), so a
      // leg with no stamps and the tile elsewhere does not seed at spot
      // under forward live ticks.
      const points =
        stamped
        ?? livePoints
        ?? (chartLegShiftRef.current !== 0 ? chartLegShiftRef.current : null);
      legPointsShift = points ?? 0;
      if (points != null) {
        const spotHistory =
          legTapeHistoryRef.current?.[
            `${ticket.ccy.toUpperCase()}|spot`
          ];
        if (spotHistory && spotHistory.length > 0) {
          history = spotHistory;
          shift = points;
          legSource = stamped != null ? 'leg-spot+points' : 'leg-spot+live-points';
        }
      }
    }
    if (!history || history.length === 0) {
      history = legTapeHistoryRef.current?.[primaryKey];
      shift = 0;
      if (chartLegInstrument !== 'spot') {
        // Say WHY the spot+points derivation was skipped — that is the
        // whole diagnostic for "live-executed forward leg renders nothing".
        const stamps = legTicket?.ipaQuote;
        const noPoints =
          !(stamps?.fxSpot != null && stamps.fxSpot > 0
            && stamps?.fxOutright != null && stamps.fxOutright > 0)
          && !(priced?.quote.fxOutright != null && priced.quote.fxOutright > 0
            && priced?.quote.fxSpot != null && priced.quote.fxSpot > 0);
        legSource = noPoints
          ? 'leg-own-key(no-points)'
          : 'leg-own-key(no-spot-history)';
      } else {
        legSource = 'leg-own-key';
      }
    }
    if (!history || history.length === 0) {
      // No recorded 1s tape for this leg — the From window's record can
      // still draw it, in the leg's convention.
      const record = clipToStory(lookbackTicksBefore(null, legPointsShift));
      logTapeLoad(
        record.length > 0 ? 'leg-lookback-record' : legSource,
        primaryKey,
        legPointsShift,
        record,
      );
      return record;
    }
    // Leg reseeds obey the same story window as the draft seed.
    const own = clipToStory(
      history.map(point => ({
        ...point,
        bid: point.bid + shift,
        mid: point.mid + shift,
        ask: point.ask + shift,
      })),
    );
    // The From window's record, in the same convention, ahead of the first
    // recorded 1s print — never overlapping it.
    const points = clipToStory([
      ...lookbackTicksBefore(own[0]?.t ?? null, shift),
      ...own,
    ]);
    logTapeLoad(
      legSource,
      legSource.startsWith('leg-own-key')
        ? primaryKey
        : `${ticket.ccy.toUpperCase()}|spot`,
      shift,
      points,
    );
    // The per-leg history is already the right convention by construction. A
    // live quote (when one exists) still filters it per overlayOpenTapeTrail
    // below; with none, comparing every point to one arbitrary sample (the
    // series' own last tick) would delete any recorded tick the market has
    // since moved away from. Trim only a genuine convention break within the
    // series itself instead of discarding real history.
    // Only the tile's quote when the tile prices what this chart draws. On a
    // spot tile the sample is spot, and filtering a forward series against it
    // joined the two conventions in one candle.
    const liveForLeg =
      chartLegInstrument === instrument ? chartLiveRef.current : null;
    return finishSeededTrail(points, liveForLeg);
  };

  /**
   * Test capture: exactly what chart the UI loaded. One structured
   * [tape-load] line per DISTINCT load (source, key, shift, window,
   * points, time span, mid range) — dev only, deduped by signature so it
   * fires on change, not on every render. This is the ground truth for
   * "which series is this chart actually drawing".
   */
  const tapeLoadLogRef = useRef(
    new Map<string, { sig: string; atMs: number }>(),
  );
  const logTapeLoad = (
    source: string,
    key: string | null,
    shift: number,
    pts: readonly { t: number; mid: number }[],
  ) => {
    if (process.env.NODE_ENV === 'production') return;
    const w = storyWindowRef.current;
    // Signature is the load's SHAPE — source path, key, shift, window,
    // emptiness, and how far back the series reaches. Live appends only
    // move the tail and must not re-log; a DB merge extending history
    // back, or an empty→loaded flip, is a new load worth a line. The 5s
    // floor absorbs any residual churn (e.g. a capped series trimming
    // its head every beat) except emptiness flips, which always print.
    const sigKey = `${source}|${key}`;
    const emptiness = pts.length === 0 ? 'empty' : 'loaded';
    const sig = `${shift.toFixed(6)}|${w.fromMs ?? 0}|${w.toMs ?? 0}|${emptiness}|${pts[0]?.t ?? 0}`;
    const nowMs = Date.now();
    const prev = tapeLoadLogRef.current.get(sigKey);
    if (prev != null) {
      if (prev.sig === sig) return;
      const prevEmptiness = prev.sig.split('|')[3];
      if (prevEmptiness === emptiness && nowMs - prev.atMs < 5_000) return;
    }
    tapeLoadLogRef.current.set(sigKey, { sig, atMs: nowMs });
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const pt of pts) {
      if (pt.mid < lo) lo = pt.mid;
      if (pt.mid > hi) hi = pt.mid;
    }
    const record = {
      ticket: ticket.id,
      role: ticket.bracketRole ?? null,
      instrument: ticket.instrument ?? 'spot',
      source,
      key,
      shift: Number(shift.toFixed(6)),
      window: {
        from: w.fromMs != null ? new Date(w.fromMs).toISOString() : null,
        to: w.toMs != null ? new Date(w.toMs).toISOString() : null,
      },
      points: pts.length,
      first: pts.length > 0 ? new Date(pts[0]!.t).toISOString() : null,
      last:
        pts.length > 0
          ? new Date(pts[pts.length - 1]!.t).toISOString()
          : null,
      midRange: pts.length > 0 ? [lo, hi] : null,
    };
    console.info('[tape-load]', record);
    // The desk watches the DEV SERVER TERMINAL — mirror the capture there.
    void fetch('/api/tape-load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => {});
  };
  seedDiagRef.current = logTapeLoad;

  /**
   * Late-arriving history for a NON-draft leg selection. When the panel is
   * on a different tile than the draft ticket (a spot-referenced strip
   * whose panel opened on the FORWARD tenor tile — the fills are spot, the
   * chip says FWD), the initialTapeTrail merge is gated off by design, and
   * the trailKey first-run seed fires once at mount — BEFORE the Postgres
   * backstop resolves. That left no route at all for the fetched record
   * into the trail: the chart sat on "Loading recorded tape…" forever
   * while the rows were already in the browser. Reseed whenever the leg
   * history prop updates; merge keeps anything already on the trail.
   */
  // Reseed trigger is a CONTENT signature, not the prop's identity: the
  // parent rebuilds legTapeHistory as a fresh object on every render, so
  // depending on the object re-ran the seed each heartbeat, re-merged the
  // live appends the interval push already handles, and re-rendered the
  // chart constantly. What the reseed exists for is history arriving
  // EARLIER than what the trail has (the DB backstop landing) or a key
  // flipping empty→loaded — both move a series' FIRST timestamp, so the
  // signature is first-point-per-key and ignores tail growth.
  const legTapeHistorySig = legTapeHistory
    ? Object.entries(legTapeHistory)
        .map(
          ([key, points]) =>
            `${key}:${points.length > 0 ? points[0]!.t : 'empty'}`,
        )
        .join('|')
    : '';
  useEffect(() => {
    if (selectedLegIsDraftLegRef.current) return;
    const seeded = seedTrailForSelectedLeg();
    if (seeded.length === 0) return;
    setTapeTrail(current => {
      const byTime = new Map(current.map(p => [p.t, p]));
      let added = false;
      for (const p of seeded) {
        if (!byTime.has(p.t)) {
          byTime.set(p.t, { ...p });
          added = true;
        }
      }
      if (!added) return current;
      const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
      return trimTapeTrail(merged);
    });
    // seedTrailForSelectedLeg reads legTapeHistory via a ref; the content
    // signature above (backstop merges, empty→loaded flips) is the real
    // trigger — object identity churns every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `selectedLegKey` belongs here too: it flips the chart off the opened
    // ticket's own leg onto the row the desk picked (chartLegInstrument).
  }, [legTapeHistorySig, structure, instrument, months, selectedLegKey, lookbackSig]);

  // What names a TAPE: pair + linear instrument + tenor. Option is the
  // premium desk, not a third FX series — `linearTapeInstrument` keeps the
  // outright/spot identity so toggling Option does not wipe the candles.
  // trailKey used to carry settleIso / strike / put; settleIso initializes
  // ASYNC after mount (null → date), and resetting on that pseudo-change
  // wiped the seeded history: identity used to follow the TILE (strip
  // forces spot) instead of the series the chart draws.
  // Every spot-referenced bracket keys to CCY|spot, so the key alone cannot
  // tell L2's chart from L3's — the leg's own id names the series.
  const chartTapeInstrument = linearTapeInstrument(
    chartLegInstrument,
    chartLegMonths,
  );
  // The convention is part of the identity: a limit order draws on spot while
  // it works and on its leg's forward once it executes. Without it the flip
  // kept the working phase's spot ticks inside the forward series — a wick
  // down to spot on the fill bar.
  const tapeIdentity = (chartTicket.bracketRole
    ? `bracket|${tapeQuoteKey(chartTicket)}|${chartTicket.id}`
    : `${pair}|${chartTapeInstrument}|${chartTapeInstrument === 'spot' ? 0 : Math.max(0, chartLegMonths)}`)
    + `|${chartIsSpot ? 'spot' : 'fwd'}`;
  // The chart's series identity must name the data it HOLDS. tapeIdentity
  // flips on the click while the trail is re-derived an effect later, and a
  // key that moves first files the previous leg's candles under the new leg —
  // the next push then reads as a live update and only the last bar moves.
  const [tapeTrailIdentity, setTapeTrailIdentity] = useState(tapeIdentity);
  useEffect(() => {
    const isFirstRun = trailKeyRef.current == null;
    const reset = !isFirstRun && trailKeyRef.current !== tapeIdentity;
    trailKeyRef.current = tapeIdentity;
    if (reset) {
      lastTrailStampRef.current = '';
      const seeded = seedTrailForSelectedLeg();
      setTapeTrail(seeded);
      setTapeTrailIdentity(tapeIdentity);
      // Leg switch: drop the previous leg's leave stamp and pin this leg's
      // own recorded placement (if any).
      const legTicket = legTicketForSelectedLeg();
      const src = legTicket ?? (
        ticket.limitRate != null || ticket.restingAnchorRate != null
          ? ticket
          : null
      );
      setStickyPlaced(
        src != null
          ? placementMarkFromTrail(
              { restingAnchorRate: chartPlacementAnchor(src) },
              seeded,
              ticketPlacedAtMs(src.id),
            )
          : null,
      );
      setStickyChanges([]);
      return;
    }
    // First run: the mount initializer could only seed the DRAFT ticket's
    // own key (`initialTapeTrail`). A strip always opens on the 'spot' tile
    // regardless of which leg the draft ticket itself is, so whenever the
    // leg shown at mount is not the draft's own leg, its history has not
    // been seeded yet — checking `tapeTrail.length === 0` is not enough,
    // since the draft's (wrong-leg) history can already be sitting there.
    if (isFirstRun && (!selectedLegIsDraftLegRef.current || chartSpotOverDraft)) {
      // Replace even with an empty seed: the draft's history is a different
      // key's series by definition here, and keeping it because the selected
      // series has no record yet mixes conventions on one chart (the draft's
      // forward points under a spot identity, or vice versa).
      setTapeTrail(seedTrailForSelectedLeg());
    }
  }, [tapeIdentity]);

  /**
   * A reopened booking's chart is the ORDER'S story: it starts at the
   * placement instant and ends a few minutes past execution. Appending the
   * CURRENT market onto that record hours later drew a cliff from the fill
   * era to today's rate and made the story unreadable — once the tail is
   * over, the recorded tape is frozen.
   */
  const bookStoryFrozen =
    bookSession
    && ticket.filledAtMs != null
    && Number.isFinite(ticket.filledAtMs)
    && Date.now() > ticket.filledAtMs + POST_FILL_TAPE_TAIL_MS;

  // The draft-only freeze misses a strip whose GROUP finished (every leg
  // booked/cancelled while the draft itself never fills) — the story window's
  // own end covers that case, checked live via the ref so the 1s interval
  // stops without re-subscribing.
  const storyEnded = () => {
    if (deskLiveRef.current) return false;
    const w = storyWindowRef.current;
    return w.toMs != null && Date.now() > w.toMs;
  };


  const optionCharts = useMemo(() => {
    void repriceTick;
    const t0 = performance.now();
    try {
      return sampleOptionMarketCharts({
        ccy: ticket.ccy,
        instrument: 'option',
        tenorMonths: months > 0 ? months : 1,
        strikeInput,
        amountLocalM,
        bundle: marketRates,
        liveSpot: deferredLiveSpot,
        volPref,
        quoteSide,
        optionPut,
        longOption: true,
      });
    } catch {
      return null;
    } finally {
      // instrument is deliberately NOT a dep of this memo and the call
      // hardcodes 'option', so this runs on spot and forward tickets too —
      // the note records which, because that is wasted work when the
      // consumer (gated on optionDesk) never reads the result.
      notePriceStage(
        'optionCharts',
        performance.now() - t0,
        `ticket instrument=${instrument}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tenor,
    strikeInput,
    amountLocalM,
    quoteSide,
    volPref,
    optionPut,
    deferredLiveSpot,
    ticket.ccy,
    marketRates,
    repriceTick,
    months,
    workingHit,
  ]);

  const stripRows = useMemo(
    () => buildStripRows(liveStripPkg, instrument, ticket.ccy),
    [liveStripPkg, instrument, ticket.ccy],
  );
  const bookEdgeForStripRow = (row: StripRow): number => {
    const i = stripRows.findIndex(r => r.key === row.key);
    if (i < 0) return -1;
    return leftoverBookEdges?.[i] ?? i;
  };

  /**
   * Resolve a leg HitTarget against the CURRENT stripRows. `key` is
   * `leg-${leg.index}-${i}`, derived from array position in whichever
   * PreparedHedgeProfile liveStripPkg currently resolves to — and that can
   * swap (draft package -> booked package) while the modal sits open, e.g. a
   * matcher poll landing between a leg's arm click and its execute click. A
   * key captured before the swap then matches nothing in the rebuilt rows.
   * months is the leg's own settle, a stable identity across that swap.
   */
  const stripRowForLegTarget = (
    target: Extract<HitTarget, { kind: 'leg' }>,
  ): StripRow | undefined =>
    stripRows.find(r => r.key === target.key)
    ?? stripRows.find(r => Math.abs(r.months - target.months) < 1e-6);

  /**
   * Test capture: why a strip opened with the leg statuses it did. Prints
   * one [strip-open] line per distinct open to the DEV SERVER TERMINAL —
   * the ladder the panel resolved, where it came from, and the peer each
   * row matched. Dev-only, deduped by signature. "Legs do not open as
   * executed" is one of: no peers supplied, no ladder resolved, or an
   * edge-index mismatch between rows and peers; this says which.
   */
  const stripOpenLogRef = useRef('');
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (structure !== 'strip') return;
    const peers = ownStripTickets.map(t => ({
      id: t.id,
      edge: t.stripEdgeIndex ?? 0,
      status: t.status,
      role: t.bracketRole ?? null,
      instrument: t.instrument ?? 'spot',
      filledAtMs: t.filledAtMs ?? null,
      pkgLegs: t.sourcePackage?.legs.length ?? null,
    }));
    const rows = stripRows.map((row, edgeIndex) => {
      const { filled, working } = legPeersAtEdge(ownStripTickets, edgeIndex, {
        coverOnly: true,
      });
      return {
        edge: edgeIndex,
        label: row.label,
        months: row.months,
        resolved: filled ? 'filled' : working.length > 0 ? 'working' : 'free',
        peerId: filled?.id ?? working[0]?.id ?? null,
      };
    });
    const sig = JSON.stringify({ t: ticket.id, rows, peers });
    if (stripOpenLogRef.current === sig) return;
    stripOpenLogRef.current = sig;
    const record = {
      kind: 'strip-open',
      ticket: ticket.id,
      stripId: ticket.stripId ?? null,
      draftRole: ticket.bracketRole ?? null,
      structure,
      ladderFrom: bookedStripPkg
        ? 'booked-stamp'
        : preconfiguredStrip
          ? 'prepared'
          : 'default-seed',
      ladderLegs: liveStripPkg?.legs.length ?? 0,
      rows,
      peers,
    };
    console.info('[strip-open]', record);
    void fetch('/api/tape-load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => {});
  }, [
    structure,
    stripRows,
    ownStripTickets,
    ticket.id,
    ticket.stripId,
    ticket.bracketRole,
    bookedStripPkg,
    preconfiguredStrip,
    liveStripPkg,
  ]);

  /**
   * Filling the legs one at a time must end in the same executed state as one
   * hit on the main tile. Once every edge has a booked peer, rebuild the
   * report the top tile would have produced — real per-leg prices and dealers,
   * not an aggregate — which flips fillDone and retires the pads.
   */
  useEffect(() => {
    if (execReport != null) return;
    if (!ticket.stripId) return;
    if (structure !== 'strip' || stripRows.length === 0) return;
    const legs = stripRows.map((row, edgeIndex) => ({
      row,
      peer: ownStripTickets.find(
        t => (t.stripEdgeIndex ?? 0) === edgeIndex && isExecutedBookedTicket(t),
      ),
    }));
    if (legs.some(l => l.peer == null)) return;
    const last = legs[legs.length - 1]!.peer!;
    const filledAt = legs.reduce(
      (ms, l) => Math.max(ms, l.peer!.filledAtMs ?? 0),
      0,
    );
    setExecReport({
      at: filledAt > 0 ? formatFillClock(filledAt) : clockNow(),
      atMs: filledAt > 0 ? filledAt : Date.now(),
      pair,
      hit: last.orderHit ?? restingOrderHitSide(last),
      side: ticketTradeSide(last),
      scope: 'strip',
      fills: legs.map(({ row, peer }) => ({
        key: row.key,
        label: row.label,
        instrument: row.instrument,
        sizeM: row.sizeM,
        rate: peer!.ipaQuote?.fxOutright ?? peer!.limitRate ?? null,
        bank: peer!.counterparty ?? row.bank,
        premiumUsd: peer!.ipaQuote?.premiumUsd ?? null,
      })),
    });
  }, [execReport, structure, stripRows, ownStripTickets, pair, ticket.stripId]);

  const liveCoverLocalM =
    structure === 'strip' && liveStripPkg
      ? signedLocalMForPairSide(
          pairSideFromFcySign(ticket.amountLocalM),
          pendingHedgeAbs > 1e-9
            ? pendingHedgeAbs
            : stripStarted
              ? 0
              : Math.abs(liveStripPkg.coverLocalM),
          ticket.ccy,
          baseCcy,
        )
      : amountLocalM;
  const pathScheduleEnds = useMemo(() => {
    if (structure !== 'strip' || !liveStripPkg || liveStripPkg.legs.length < 2) {
      return null;
    }
    return stripLadderMonths(liveStripPkg.legs);
  }, [structure, liveStripPkg]);
  const pathScheduleWeights = useMemo(() => {
    if (!pathScheduleEnds || !liveStripPkg) return null;
    const sizes = liveStripPkg.legs.map((_, i) =>
      Math.abs(incrementalLegSize(liveStripPkg.legs, i)),
    );
    const tot = sizes.reduce((s, n) => s + n, 0);
    if (!(tot > 1e-9)) return null;
    return sizes.map(n => n / tot);
  }, [pathScheduleEnds, liveStripPkg]);
  const pathHedgeRatio = (() => {
    const staged = prepared?.coverLocalM ?? liveCoverLocalM;
    const base =
      pathExposure && pathExposure.hedgeRatio > 1e-9
        ? pathExposure.hedgeRatio
        : 1;
    if (!(Math.abs(staged) > 1e-9)) return base;
    return base * (Math.abs(liveCoverLocalM) / Math.abs(staged));
  })();

  const applyPackage = (
    next: 'bullet' | 'strip',
    pkg: PreparedHedgeProfile | null,
  ) => {
    setStructure(next);
    setLegEnabled({});
    setLegDeltaM({});
    setSchedEnds(null);
    setSchedWeights(null);
    setTicketStripLegs(null);
    setSelectedLegKey(null);
    setWorkingHit(null);
    setHitTarget(null);
    setSettleIso(null);
    if (next === 'bullet') {
      if (pkg) {
        const leftover =
          pendingHedgeAbs > 1e-9
            ? pendingHedgeAbs
            : stripStarted
              ? 0
              : Math.abs(ticket.amountLocalM);
        const clip =
          leftover > 1e-9
            ? (ticket.amountLocalM >= 0 ? leftover : -leftover)
            : stripStarted
              ? 0
              : pkg.coverLocalM;
        setSizeM(Math.round(Math.abs(clip) * 100) / 100);
        setSide(pairSideFromFcySign(clip));
        const settle = pkg.settleMonths;
        if (settle != null && settle > 0) {
          setLegMonths(settle);
          setTenor(horizonIdForForecastMonths(settle));
        } else {
          setLegMonths(null);
        }
      } else {
        setLegMonths(null);
      }
      return;
    }
    if (pkg && Math.abs(pkg.coverLocalM) > 1e-9) {
      const leftover =
        pendingHedgeAbs > 1e-9
          ? pendingHedgeAbs
          : stripStarted
            ? 0
            : Math.abs(ticket.amountLocalM);
      const clip =
        leftover > 1e-9
          ? (ticket.amountLocalM >= 0 ? leftover : -leftover)
          : stripStarted
            ? 0
            : pkg.coverLocalM;
      setSizeM(Math.round(Math.abs(clip) * 100) / 100);
      setSide(pairSideFromFcySign(clip));
    }
    // Strip books FWD. Spot is not a strip contract.
    setDeskSwap(false);
    if (instrument !== 'option') {
      setInstrument('forward');
      setStrikeInput('ATMF');
    }
  };

  const applyStructure = (next: 'bullet' | 'strip') => {
    if (workingHit != null || execReport != null) return;
    // Remaining clip may trade as bullet / option / spot, but the frozen
    // ladder must still be selectable — Option used to force Bullet, then
    // this guard blocked FWD → Strip so the desk could not get the strip
    // back. Restore the existing package; do not rebuild it.
    if (next === 'strip' && stripStarted) {
      const restore =
        bookedStripPkg
        ?? (stripPkg?.structure === 'strip' && stripPkg.legs.length >= 2
          ? stripPkg
          : null)
        ?? (liveStripPkg?.structure === 'strip' && liveStripPkg.legs.length >= 2
          ? liveStripPkg
          : null);
      if (!restore) return;
      setStructure('strip');
      setInstrument('forward');
      setDeskSwap(false);
      setStrikeInput('ATMF');
      setRatesLeft('structure');
      setSelectedLegKey(null);
      setIsStructureSelectionOpen(false);
      return;
    }
    setChoiceIdx(null);
    setLegEnabled({});
    setLegDeltaM({});
    setSchedEnds(null);
    setSchedWeights(null);
    setTicketStripLegs(null);
    applyPackage(next, next === 'bullet' ? bulletPkg : stripPkg);
    setIsStructureSelectionOpen(false);
  };

  const applyStripChoice = (i: number) => {
    if (workingHit != null || execReport != null) return;
    if (stripStarted) return;
    const choice = stripChoices[i];
    if (!choice || !stripChoiceBase) return;
    setChoiceIdx(i);
    setLegEnabled({});
    setLegDeltaM({});
    setSchedEnds(null);
    setSchedWeights(null);
    setTicketStripLegs(null);
    const pkg = preparedFromStripChoice(choice, stripChoiceBase);
    applyPackage(pkg.structure, pkg);
  };

  // Keep the ladder; only the Bid/Ask feed switches to live /api/fx-spot.
  // Whole-strip orders can then rest on spot (isSpotReferenced). Selecting a
  // FWD row still puts that leg back on its outright.
  const resetStripPadToSpot = () => {
    setInstrument('spot');
    setDeskSwap(false);
    setLegMonths(null);
    setSettleIso(null);
    setSelectedLegKey(null);
    setStrikeInput('ATMS');
  };

  const applyTenor = (id: VarHorizonId | 'spot') => {
    if (workingHit != null || execReport != null) return;
    if (id === 'spot') {
      if (structure === 'strip') {
        resetStripPadToSpot();
        return;
      }
      setInstrument('spot');
      setDeskSwap(false);
      setLegMonths(null);
      setSettleIso(null);
      setStrikeInput('ATMS');
      return;
    }
    if (instrument === 'spot') {
      setInstrument('forward');
      setStrikeInput('ATMF');
    }
    setTenor(id);
    setLegMonths(VAR_HORIZON_OPTIONS.find(h => h.id === id)?.months ?? 1);
    setSettleIso(null);
  };

  const applyInstrument = (id: HedgeInstrument) => {
    if (workingHit != null || execReport != null) return;
    if (id === 'spot' && structure === 'strip') {
      resetStripPadToSpot();
      return;
    }
    setInstrument(id);
    if (id !== 'forward') setDeskSwap(false);
    if (id === 'spot') setStrikeInput('ATMS');
    else if (id !== 'option') setStrikeInput('ATMF');
    if (id === 'option') {
      if (structure === 'strip') {
        setChoiceIdx(null);
        setRatesLeft('chart');
        applyPackage('bullet', bulletPkg);
      }
    }
    if (id === 'option') {
      const settle = liveBulletPkg?.settleMonths;
      if (settle != null && settle > 0) {
        setLegMonths(settle);
        setTenor(horizonIdForForecastMonths(settle));
        setSettleIso(null);
      } else if (legMonths == null || legMonths <= 0) {
        const fallback = VAR_HORIZON_OPTIONS.find(h => h.id === tenor)?.months ?? 1;
        setLegMonths(fallback);
      }
    }
  };

  const applyStrikeShortcut = (opt: string) => {
    if (workingHit != null || execReport != null) return;
    const m = opt.match(/^(\d+)d$/i);
    if (m) {
      setStrikeInput(`${m[1]}D${optionPut ? 'P' : 'C'}`);
      return;
    }
    setStrikeInput(opt);
  };

  const applyOptionSide = (put: boolean) => {
    if (workingHit != null || execReport != null) return;
    setOptionPut(put);
    const parsed = parseStrikeInput(strikeInput);
    if (parsed?.kind === 'delta') {
      setStrikeInput(`${parsed.deltaPct}D${put ? 'P' : 'C'}`);
    }
  };

  const applyOptionDeskPick = (pick: OptionDeskPick) => {
    if (execReport != null) return;
    if (pick.strikeInput) setStrikeInput(pick.strikeInput);
    if (pick.optionPut != null) setOptionPut(pick.optionPut);
    if (pick.tenorMonths != null && Number.isFinite(pick.tenorMonths) && pick.tenorMonths > 0) {
      setLegMonths(pick.tenorMonths);
      setTenor(horizonIdForForecastMonths(pick.tenorMonths));
      setSettleIso(toIsoDate(settleDateFromMonths('option', pick.tenorMonths)));
    }
  };

  const applySettleIso = (iso: string) => {
    if (workingHit != null || execReport != null) return;
    if (!iso) return;
    setSettleIso(iso);
    const to = new Date(`${iso}T12:00:00`);
    if (!Number.isFinite(to.getTime())) return;
    const months = monthsBetween(new Date(), to);
    if (months <= 0.08) {
      if (structure === 'strip') {
        resetStripPadToSpot();
        return;
      }
      if (instrument !== 'option') {
        setInstrument('spot');
        setDeskSwap(false);
        setLegMonths(null);
        setStrikeInput('ATMS');
      } else {
        setLegMonths(0);
        setTenor('1w');
      }
      return;
    }
    if (instrument === 'spot') {
      setInstrument('forward');
      setStrikeInput('ATMF');
    }
    setLegMonths(Math.round(months * 100) / 100);
    setTenor(horizonIdForForecastMonths(months));
  };

  const selectStripLeg = useCallback((row: StripRow) => {
    setSelectedLegKey(row.key);
    setInstrument(row.instrument === 'option' ? 'option' : 'forward');
    if (row.instrument !== 'forward') setDeskSwap(false);
    setTenor(row.tenor);
    setLegMonths(row.months);
    setSizeM(row.sizeM);
    setSettleIso(null);
    if (row.instrument !== 'option') setStrikeInput('ATMF');
  }, []);
  // A ticket that belongs to one strip edge opens with ITS row selected —
  // and on that row's FWD (spot + points). The chart's fill pin and level
  // tags are scoped to the selected row; with no row selected the pad stays
  // on live spot and L1 is unselected. Once per ticket: a later click on
  // another row is the desk's choice.
  const legPreselectedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (instrument === 'option') return;
    if (legPreselectedForRef.current === ticket.id) return;
    const edge = ticket.stripEdgeIndex;
    if (!ticket.stripId || edge == null || edge < 0) return;
    const row = stripRows[edge];
    if (!row) return;
    legPreselectedForRef.current = ticket.id;
    selectStripLeg(row);
  }, [
    instrument,
    ticket.id,
    ticket.stripId,
    ticket.stripEdgeIndex,
    stripRows,
    selectStripLeg,
  ]);
  // Opening on the spot tile does not imply the near (L1) row. A selected
  // key is the only on-state — then the pad is that row's FWD outright.
  const selectedStrip =
    selectedLegKey == null
      ? undefined
      : stripRows.find(r => r.key === selectedLegKey);
  /**
   * Which target a main-pad tile click acts on: an already-armed leg target
   * first, else the leg manually selected in the priced-legs panel (the pad
   * is showing ITS outright — a tile click picks a side, it must not un-pick
   * the leg and reset to spot), else the whole-strip main target.
   */
  /**
   * The leg the desk has picked in the priced-legs panel, as a target — null
   * when none is picked. An order is then for THAT leg alone; with nothing
   * picked the strip is the unit, which is the whole-strip main target.
   */
  const selectedLegTarget = (): Extract<HitTarget, { kind: 'leg' }> | null => {
    if (structure !== 'strip' || selectedLegKey == null) return null;
    const row = stripRows.find(r => r.key === selectedLegKey);
    return row ? { kind: 'leg', key: row.key, months: row.months } : null;
  };
  const padHitTarget = (): HitTarget => {
    if (hitTarget?.kind === 'leg') return hitTarget;
    return selectedLegTarget() ?? hitTarget ?? { kind: 'main' };
  };
  const tileBankBid = selectedStrip?.bankBid ?? selectedStrip?.bank ?? 'JPM';
  const tileBankAsk = selectedStrip?.bankAsk ?? selectedStrip?.bank ?? 'Citi';

  const stripQuotes = useMemo(() => {
    void repriceTick;
    const t0 = performance.now();
    const out = stripRows.map(row => {
      const args = {
        ccy: ticket.ccy,
        instrument: row.instrument,
        tenorMonths: row.months,
        strikeInput,
        amountLocalM: signedLocalMForPairSide(
          side,
          row.sizeM,
          ticket.ccy,
          baseCcy,
        ),
        bundle: marketRates,
        liveSpot: deferredLiveSpot,
        volPref,
        optionPut,
      };
      try {
        const bid = simulateTicketPrice({ ...args, quoteSide: 'bid' });
        const ask = simulateTicketPrice({ ...args, quoteSide: 'ask' });
        // Same rule as the main pad: no live print, no price. Without one the
        // pricer rebases to the bundle's seed spot, and a leg row then showed
        // — and a click BOOKED — the seed curve's outright: an M2 EUR leg at
        // 1.15563 against a stamped spot of 1.15937, 37 pips below spot on a
        // pair whose forward points are positive.
        const live =
          bid.blend.spotSource === 'live' && ask.blend.spotSource === 'live';
        return {
          key: row.key,
          bid: live ? bid.quote.fxOutright : null,
          ask: live ? ask.quote.fxOutright : null,
          points: bid.blend.curvePoints,
          askPoints: ask.blend.curvePoints,
          vol: bid.quote.impliedVolPercent,
          premiumUsd: bid.quote.premiumUsd,
          premiumBidUsd: bid.quote.premiumUsd,
          premiumAskUsd: ask.quote.premiumUsd,
          strike: bid.quote.strike,
          deltaPercent: bid.quote.deltaPercent,
          quoteBid: bid.quote,
          quoteAsk: ask.quote,
        };
      } catch {
        return {
          key: row.key,
          bid: null as number | null,
          ask: null as number | null,
          points: null as number | null,
          askPoints: null as number | null,
          vol: null as number | null,
          premiumUsd: null as number | null,
          premiumBidUsd: null as number | null,
          premiumAskUsd: null as number | null,
          strike: null as number | null,
          deltaPercent: null as number | null,
          quoteBid: null as HedgeIpaQuote | null,
          quoteAsk: null as HedgeIpaQuote | null,
        };
      }
    });
    notePriceStage(
      'stripQuotes',
      performance.now() - t0,
      `${stripRows.length} legs x 2 sides`,
    );
    return out;
  }, [
    stripRows,
    ticket.ccy,
    strikeInput,
    side,
    marketRates,
    deferredLiveSpot,
    volPref,
    optionPut,
    repriceTick,
  ]);

  /** The leg's forward points per quote side as priced now — stamped on an order left on the spot tile. */
  const pricedLegPoints = (row: StripRow) => {
    const q = stripQuotes.find(x => x.key === row.key);
    return { bid: q?.points, ask: q?.askPoints };
  };
  /**
   * What makes a working limit order on a leg spot-referenced: it rests at a
   * spot level on the spot tape and, when it fills, books the leg's forward —
   * spot print + these points (spotReferencedFillQuote). Only a forward leg
   * converts; a spot or option leg keeps its own shape.
   */
  const spotReferencedLegFields = (
    leg: Parameters<typeof spotTileStripLegFields>[0],
    points: Parameters<typeof spotTileStripLegFields>[1],
    executedSide: HitSide,
  ) =>
    leg.instrument === 'forward'
      ? spotTileStripLegFields(leg, points, executedSide)
      : stripLegTenorFields(leg);
  /**
   * A working limit on a forward leg must carry that leg's points, or it
   * cannot book the forward: spotTileStripLegFields then returns the plain
   * SPOT shape, and the desk's FWD order would book as a spot trade at a bare
   * spot print. Refuse the whole leave instead and say which legs.
   * `perRow` is how many tickets each row produced (2 for an OCO pair).
   */
  const unpricedForwardLegs = (
    rows: readonly StripRow[],
    tickets: readonly HedgeTicket[],
    perRow = 1,
  ): string | null => {
    const missing = rows.filter((row, i) =>
      row.instrument === 'forward'
      && tickets
        .slice(i * perRow, i * perRow + perRow)
        .some(t => !t.isSpotReferenced),
    );
    return missing.length === 0
      ? null
      : `No forward points priced for ${missing.map(r => r.label).join(', ')} — order not left. Retry once the curve prices.`;
  };
  /**
   * Resting level of a strip leg that is NOT spot-referenced (an option leg).
   * The matcher walks its tape as live spot + its stamped points, so the
   * typed spot level is carried by those same points: it triggers exactly
   * when spot crosses the typed level, as a spot-referenced leg does.
   */
  const restingLevelForLeg = (
    row: StripRow,
    spotLevel: number,
    legQuote: HedgeIpaQuote | null,
  ): number => {
    const outright = legQuote?.fxOutright;
    const spot = legQuote?.fxSpot;
    if (
      row.instrument !== 'option'
      || outright == null || !(outright > 0)
      || spot == null || !(spot > 0)
    ) {
      return spotLevel;
    }
    return new Decimal(spotLevel).plus(new Decimal(outright).minus(spot)).toNumber();
  };
  /** The same for a bullet: the pad's own forward tenor and priced points. */
  const bulletSpotReferenceFields = (executedSide: HitSide) =>
    instrument === 'forward'
      ? spotTileStripLegFields(
          {
            instrument,
            tenor,
            months,
            label: draftTicket.maturityLabel ?? formatMarketTenor(months),
          },
          { bid: pricedBid?.blend.curvePoints, ask: pricedAsk?.blend.curvePoints },
          executedSide,
        )
      : {};
  const selectedStripQuote = selectedStrip
    ? stripQuotes.find(x => x.key === selectedStrip.key)
    : undefined;
  const selectedPadBid =
    selectedStrip != null
      ? (selectedStripQuote?.bid != null && selectedStripQuote.bid > 0
          ? selectedStripQuote.bid
          : instrument === 'forward' && tileBid != null && tileBid > 0
            ? tileBid
            : null)
      : tileBid;
  const selectedPadAsk =
    selectedStrip != null
      ? (selectedStripQuote?.ask != null && selectedStripQuote.ask > 0
          ? selectedStripQuote.ask
          : instrument === 'forward' && tileAsk != null && tileAsk > 0
            ? tileAsk
            : null)
      : tileAsk;
  const selectedPadMid =
    selectedPadBid != null && selectedPadAsk != null
      ? (selectedPadBid + selectedPadAsk) / 2
      : tileMid;
  /**
   * Reference-live autofill for the stop-loss pad. A working limit order is
   * spot-referenced, so its reference is live spot (`bracketRefBid`).
   */
  useEffect(() => {
    if (readOnly) return;
    if (!limitMode || !referenceStopLoss || workingHit == null) return;
    const stopLossHit = stopLossHitForSelection(workingHit);
    const reference = stopLossHit === 'bid' ? bracketRefBid : bracketRefAsk;
    if (reference == null || !(reference > 0)) return;
    const value = fmtPx(reference);
    setOrderRates(prev => prev[stopLossHit] === value
      ? prev
      : { ...prev, [stopLossHit]: value });
  }, [
    readOnly,
    limitMode,
    referenceStopLoss,
    workingHit,
    bracketRefBid,
    bracketRefAsk,
  ]);

  const stripPremiumTot = useMemo(() => {
    let bid = 0;
    let ask = 0;
    let nBid = 0;
    let nAsk = 0;
    for (const q of stripQuotes) {
      if (q.premiumBidUsd != null && Number.isFinite(q.premiumBidUsd)) {
        bid += q.premiumBidUsd;
        nBid += 1;
      }
      if (q.premiumAskUsd != null && Number.isFinite(q.premiumAskUsd)) {
        ask += q.premiumAskUsd;
        nAsk += 1;
      }
    }
    return {
      bid: nBid > 0 ? bid : null,
      ask: nAsk > 0 ? ask : null,
    };
  }, [stripQuotes]);

  const draftTicket: HedgeTicket = useMemo(() => {
    const limit = Number(
      workingHit == null ? orderRate : orderRates[workingHit],
    );
    const stamped = priced
      ? {
          ipaQuote: {
            ...priced.quote,
            ...(Number.isFinite(limit) && limit > 0
              ? { fxOutright: limit }
              : {}),
          },
        }
      : {};
    // Every order built from this draft states its own tape: an opened
    // spot-referenced order must not lend its spot reference to a new one
    // (a forward-tile order would then key on spot).
    const {
      isSpotReferenced: _isSpotReferenced,
      stripLegPoints: _stripLegPoints,
      stripId: openedStripId,
      stripEdgeIndex: openedEdge,
      ...opened
    } = ticket;
    // Option (and any bullet after leaving Strip) is its own blotter row —
    // keeping the compose stripId made confirmBook merge it into M0 and the
    // Decision screen never rendered a new OPTION line.
    const keepStrip = structure === 'strip' && instrument !== 'option';
    const signed = {
      ...opened,
      amountLocalM,
      ...(keepStrip && openedStripId
        ? { stripId: openedStripId, stripEdgeIndex: openedEdge }
        : {}),
    };
    if (instrument === 'spot') {
      return {
        ...signed,
        instrument: 'spot',
        maturity: null,
        maturityLabel: null,
        ...stamped,
      };
    }
    return {
      ...signed,
      instrument,
      maturity: tenor,
      maturityLabel: tenorLabel(tenor),
      ...stamped,
      ...(structure === 'strip' && liveStripPkg
        ? { sourcePackage: liveStripPkg }
        : {}),
    };
  }, [
    ticket,
    instrument,
    tenor,
    priced,
    amountLocalM,
    orderRate,
    orderRates,
    workingHit,
    structure,
    liveStripPkg,
  ]);
  // An order for a strip ROW carries the ladder that row came from, never
  // the package the draft opened with. A draft composed from the card holds
  // the card's staged ladder; a strip the desk reshaped in the modal then
  // left its OCO orders stamped with a six-leg ladder they were not part of,
  // and reopening the booking charted every leg one tenor too far.
  // A new order is its own order, not a copy of the one the panel opened
  // on. draftTicket spreads that ticket, so a limit left after a market fill
  // inherited orderType 'market' (ticketRoleLabel then printed MARKET for its
  // own fill) plus that fill's time and dealer; and one left from a panel
  // opened on a TP / SL inherited its bracket role and OCO link, so the
  // partner's fill cancelled it. Each path sets its own role and OCO id.
  const {
    orderType: _openedOrderType,
    filledAtMs: _openedFilledAtMs,
    counterparty: _openedCounterparty,
    bracketRole: _openedBracketRole,
    ocoGroupId: _openedOcoGroupId,
    dismissedAtMs: _openedDismissedAtMs,
    ...orderSeed
  } = draftTicket;
  const { sourcePackage: _draftPkg, ...stripOrderSeed } = orderSeed;

  const clearReady = useCallback(() => {
    setWorkingHit(null);
    setHitTarget(null);
  }, []);

  /**
   * Picking a different leg — or stepping back to the whole strip — starts a
   * NEW order, so the pad has to let go of the last one.
   *
   * `submittedHit` latches on submit and is the guard that stops one
   * placement being sent twice (`placeLeaveOrder` and `submitLimitOrder` both
   * return early on it, and it is half of `freezeInputs`). Nothing ever
   * cleared it, so once an order was left the whole pad stayed frozen and the
   * only way to trade the next leg was to close and reopen the ticket.
   *
   * Releasing it on an explicit change of leg keeps the double-submit guard
   * where it matters — for the order sitting on the pad — while letting the
   * desk move on. A leg that now has a working order drops out of
   * `freeStripLegKeys`, so it locks on its own and cannot be booked twice.
   *
   * `limitMode` goes with it, and not only to reset the buttons: it is half
   * of `chartLimitWorking`, so while it stayed latched on after one leave
   * EVERY leg selected afterwards charted on spot — including a leg with no
   * order, whose chart is its own forward. Reopening the leave field turns it
   * back on.
   */
  const releasePadForNextOrder = useCallback(() => {
    setSubmittedHit(null);
    setWorkingHit(null);
    setHitTarget(null);
    setOrderRateEdited(false);
    setLimitMode(false);
    setLeaveError(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ratesFullScreen) return;
      if (execReport == null && workingHit != null) {
        e.preventDefault();
        // Same exit as HitPad CANCEL — leave live ready or SL/TP placement.
        setLimitMode(false);
        setOrderRateEdited(false);
        clearReady();
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, workingHit, execReport, clearReady, ratesFullScreen]);

  useEffect(() => {
    if (!ratesFullScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setRatesFullScreen(false);
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const read = () => setRatesFullH(Math.max(420, window.innerHeight - 140));
    read();
    window.addEventListener('resize', read);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', read);
      document.body.style.overflow = prev;
    };
  }, [ratesFullScreen]);

  useEffect(() => {
    if (workingHit != null || execReport != null) setTileMenu(false);
  }, [workingHit, execReport]);

  const quote = priced?.quote ?? null;
  const canConfirm = canConfirmSimTicket(quote, bookUnpriced);
  const spot = priced?.spot;
  // A spot-referenced BRACKET draft's chart appends the LIVE SPOT print —
  // the tile bid/ask on a forward row is the outright, ~40+ pips away, and
  // appending it walked the chart onto the FWD while the TP/SL (and the
  // matcher deciding them) stayed on spot.
  const bracketOnSpot =
    Boolean(chartTicket.bracketRole) && tapeInstrument(chartTicket) === 'spot';
  /**
   * The chart leg's points over spot — zero on a spot chart. A spot-
   * referenced bracket's are the points it was left for; an executed leg's
   * are its stamps; a leg still being composed takes the selected row's live
   * points. Every live print takes this delta before it may touch a forward
   * chart.
   */
  const chartLegShift = (() => {
    if (chartIsSpot) return 0;
    const referenced = spotReferencedLegShift(chartTicket);
    if (referenced != null) return referenced;
    const stampedSpot = chartTicket.ipaQuote?.fxSpot;
    const stampedOutright = chartTicket.ipaQuote?.fxOutright;
    if (
      isMarketExecutedHedgeTicket(chartTicket)
      && stampedSpot != null && stampedSpot > 0
      && stampedOutright != null && stampedOutright > 0
    ) {
      return stampedOutright - stampedSpot;
    }
    // The chart's own leg: the selected row, else the row at the chart's
    // tenor. With no row selected this used to fall straight to 0, and a
    // forward chart then took raw spot.
    const legRow =
      selectedStrip
      ?? stripRows.find(r => Math.abs(r.months - chartLegMonths) < 1e-6);
    const q = legRow ? stripQuotes.find(x => x.key === legRow.key) : undefined;
    if (q?.points != null && Number.isFinite(q.points)) {
      return swapPointsToPriceDelta(q.points, ticket.ccy);
    }
    // A leg booked without a print (a Decision "Send" leg) still carries
    // its priced outright and spot.
    if (
      stampedSpot != null && stampedSpot > 0
      && stampedOutright != null && stampedOutright > 0
    ) {
      return new Decimal(stampedOutright).minus(stampedSpot).toNumber();
    }
    return 0;
  })();
  /**
   * The live quote in THIS chart's convention. The tile prices whatever the
   * desk selected — spot while a reopened strip still sits on the spot tile —
   * so a forward leg's chart takes it raw only when the tile is on that leg;
   * otherwise it is the live spot shifted by the leg's points. Handed the
   * tile's spot raw, the chart's live line and forming bar walked from the
   * leg's forward down to spot the moment the story continued past the fill.
   */
  // A spot chart (a limit order not yet executed) takes live spot raw —
  // chartLegShift is 0 for it — whatever the tile is quoting.
  const liveFromSpot = chartIsSpot || bracketOnSpot || chartLegInstrument !== instrument;
  const shiftedSpot = (px: number | null | undefined) =>
    px != null && px > 0 ? px + chartLegShift : null;
  const chartBid = liveFromSpot ? shiftedSpot(spot?.bid) : trailBid;
  const chartAsk = liveFromSpot ? shiftedSpot(spot?.ask) : trailAsk;
  chartLegShiftRef.current = chartLegShift;
  chartLiveRef.current =
    chartBid != null && chartAsk != null && chartBid > 0 && chartAsk > 0
      ? { bid: chartBid, ask: chartAsk, mid: (chartBid + chartAsk) / 2 }
      : null;
  const liveTrailMaxPoints =
    tapeLookback !== 'order' ? Number.POSITIVE_INFINITY : TAPE_TRAIL_MAX_POINTS;
  const appendChartLiveTick = (prev: TapePt[], tick: TapePt): TapePt[] => {
    const last = prev[prev.length - 1];
    if (
      last
      && isTapeContinuityBreak(last.mid, tick.mid)
      && tapeLookback !== 'order'
    ) {
      return prev;
    }
    return appendLiveTapeTick(prev, tick, liveTrailMaxPoints);
  };

  useEffect(() => {
    if (bookStoryFrozen || storyEnded()) return;
    if (chartBid == null || chartAsk == null) return;
    if (!(chartBid > 0) || !(chartAsk > 0)) return;
    const stamp = `${trailKey}|${chartBid}|${chartAsk}`;
    lastTrailStampRef.current = stamp;
    setTapeTrail(prev =>
      appendChartLiveTick(prev, {
        bid: chartBid,
        ask: chartAsk,
        mid: (chartBid + chartAsk) / 2,
        t: Date.now(),
      }),
    );
  }, [chartBid, chartAsk, trailKey, bookStoryFrozen]);

  useEffect(() => {
    if (!tapeOn || bookStoryFrozen) return;
    const push = () => {
      if (storyEnded()) return;
      // The same quote the chartBid/chartAsk writer appends, already in the
      // chart's convention — one source, so the two writers cannot disagree.
      const q = chartLiveRef.current;
      if (!q || !(q.mid > 0)) return;
      setTapeTrail(prev =>
        appendChartLiveTick(prev, { ...q, t: Date.now() }),
      );
    };
    push();
    const timer = window.setInterval(push, 1_000);
    return () => window.clearInterval(timer);
    // tapeLookback: appendChartLiveTick closes over it, and a stale Period
    // decided whether a break was dropped or wiped the series.
  }, [tapeOn, trailKey, bookStoryFrozen, liveFromSpot, tapeLookback]);
  const fcyIsBase = ticket.ccy.toUpperCase() === baseCcy;
  const restFilled = ticket.status === 'booked' && ticket.limitRate != null;
  const liveFilled =
    ticket.status === 'booked'
    && ticket.limitRate == null
    && (
      ticket.orderHit != null
      || (ticket.filledAtMs != null && Number.isFinite(ticket.filledAtMs))
    );
  const fillDone = execReport != null || (
    structure !== 'strip' && (restFilled || liveFilled)
  );
  /**
   * A booking reopened from the book is read-only — but a strip is only
   * FINISHED when every leg has either executed or has an order working.
   * Legs that are neither (never actioned, or whose order was cancelled)
   * are still the desk's to trade: they stay clickable for a live fill and
   * for leaving an order, while everything already done stays frozen.
   */
  const freeStripLegKeys = useMemo((): Set<string> => {
    const free = new Set<string>();
    if (structure !== 'strip') return free;
    for (const [edgeIndex, row] of stripRows.entries()) {
      // Deliberately NOT coverOnly, unlike the priced-legs row: this asks "is
      // this leg still the desk's to trade", and a filled bracket is activity —
      // treat it as free and stripPadLive flips on, which nulls the tile's fill.
      const { filled, working } = legPeersAtEdge(ownStripTickets, edgeIndex);
      // `cancelled` is deliberately NOT a disqualifier. The doc comment above
      // says a leg whose order was cancelled is still the desk's to trade;
      // requiring `cancelled == null` contradicted it, and since a cancel now
      // RETAINS the ticket (removeHedgeTicketOrStrip) the leg was excluded
      // forever - pad locked, row disabled, never re-tradeable.
      if (filled == null && working.length === 0) free.add(row.key);
    }
    return free;
  }, [structure, stripRows, ownStripTickets]);
  const selectedLegIsFree =
    selectedStrip != null && freeStripLegKeys.has(selectedStrip.key);
  // A strip with a leg left to trade is still being traded here. Not
  // `limitMode` / `workingHit`: both start set on a panel opened read-only on
  // a finished order, whose chart must stay that order's frozen story.
  deskLiveRef.current = structure === 'strip' && freeStripLegKeys.size > 0;
  /**
   * A bulk fill that skipped legs with an order working marks the ticket
   * done (grey tile). If one of those orders is later cancelled, its leg is
   * the desk's to trade again, and the frozen panel would leave it
   * untradeable — so the freeze is released. Legs this report filled do not
   * count, even while their booked tickets are still on their way in.
   */
  useEffect(() => {
    if (execReport == null || execReport.scope !== 'strip') return;
    const filledKeys = new Set(execReport.fills.map(f => f.key));
    const reopened = stripRows.some(
      r => r.sizeM > 1e-9 && freeStripLegKeys.has(r.key) && !filledKeys.has(r.key),
    );
    if (!reopened) return;
    setExecReport(null);
    setWorkingHit(null);
    setHitTarget(null);
  }, [execReport, freeStripLegKeys, stripRows]);
  // After a strip fill, the pad / option / remaining-spot clip must track
  // outstanding, not the original program. A free selected leg still owns
  // its own row size so Bid/Ask on that row books that leg only.
  useEffect(() => {
    if (workingHit != null || submittedHit != null) return;
    if (selectedLegKey != null && selectedLegIsFree) return;
    const next = Math.round(pendingHedgeAbs * 100) / 100;
    setSizeM(prev => (Math.abs(prev - next) > 0.005 ? next : prev));
  }, [
    pendingHedgeAbs,
    selectedLegKey,
    selectedLegIsFree,
    workingHit,
    submittedHit,
  ]);
  // A strip with legs still to trade shows live Bid/Ask on the main pad —
  // including when no row is selected (spot / all remaining legs). L1 is
  // no longer implied-on, so that unselected pad must stay tradeable or
  // the tiles lock after a few fills — also when a still-working order
  // opened the panel; that order shows on its own row.
  /**
   * Show a live, tradable quote instead of an execution.
   *
   * True when nothing is selected, or the selected leg is still the desk's to
   * trade. It must NOT key off the ticket that opened the panel: `restFilled`
   * / `liveFilled` describe that ticket, and they fire exactly when the
   * selected leg is NOT free — that is, when it has an execution or an order
   * of its own and the pad should be showing it. Opening a strip from one
   * executed market leg therefore forced a live quote onto every executed leg
   * selected afterwards, so a row reading FILLED · MKT 1.14978 sat under a
   * tile quoting 1.14998/1.14999.
   */
  const stripPadLive = stripPadShowsLiveQuote({
    isStrip: structure === 'strip',
    freeLegCount: freeStripLegKeys.size,
    selectedLegKey,
    selectedLegIsFree,
  });
  // Read-only stops applying to the parts of a strip still left to trade.
  const readOnlyActions = readOnly && !selectedLegIsFree && !stripPadLive;
  const freezeInputs =
    readOnlyActions || workingHit != null || submittedHit != null || fillDone;
  // Reshaping the ladder (adding/removing legs, moving settle) stays locked
  // once this strip has a working or filled order — remaining size trades
  // as Spot / FWD / Option, not by growing or shrinking the strategy.
  const lockStripShape = readOnly || fillDone || stripStarted;
  const viewingBookedStrip =
    structure === 'strip'
    && (readOnly || fillDone || ticket.status === 'booked');
  /**
   * Push an explicit strip reshape (leg added/removed, settle moved) back to
   * the staged package, so Hedging Decision renders the same ladder instead of
   * the one it seeded. Armed only by this panel's own edit handlers — a seeded
   * package must never write itself back.
   */
  const onStripShapeChangeRef = useRef(onStripShapeChange);
  onStripShapeChangeRef.current = onStripShapeChange;
  useEffect(() => {
    // Armed by the leg/schedule handlers only, and disarmed on fire. Watching
    // liveStripPkg alone would re-fire on the parent's echo of what was just
    // saved, and a package that round-trips even slightly changed would then
    // loop; one shot per actual edit cannot.
    if (!stripShapeDirtyRef.current) return;
    if (lockStripShape) {
      stripShapeDirtyRef.current = false;
      return;
    }
    const pkg = liveStripPkg;
    if (!pkg || pkg.structure !== 'strip' || pkg.legs.length < 1) return;
    stripShapeDirtyRef.current = false;
    onStripShapeChangeRef.current?.(pkg);
  }, [liveStripPkg, lockStripShape]);
  useEffect(() => {
    if (
      structure !== 'strip'
      || freezeInputs
      || !liveStripPkg
      || !stripEditsDirty
    ) {
      return;
    }
    const next = Math.round(Math.abs(liveStripPkg.coverLocalM) * 100) / 100;
    setSizeM(cur => (Math.abs(cur - next) < 1e-9 ? cur : next));
  }, [structure, freezeInputs, liveStripPkg, stripEditsDirty]);
  const mainArmed: HitSide | null =
    hitTarget?.kind === 'main' && !fillDone ? workingHit : null;
  /**
   * The order whose EXECUTION the tile chrome describes — filled badge, time,
   * dealer, REF and the big rate.
   *
   * Keyed on the selected ROW's edge index, which is the row's own identity.
   * Matching on tenor (`legTicketForSelectedLeg`) cannot do it here: a strip
   * opens on the SPOT tile, so `chartLegInstrument` is 'spot', its `atTenor`
   * is true for every leg, and `find` returned leg 1 for every row — the
   * market-executed legs all showed L1's rate, dealer and time.
   *
   * `coverOnly` so a bracket resting at the same edge cannot stand in for the
   * leg's own trade; a spot-referenced bracket still counts, because that IS
   * the leg trading (decisions.md 2026-09-11).
   */
  const selectedEdgeIndex = stripRows.findIndex(r => r.key === selectedLegKey);
  /**
   * Does the SELECTED leg carry a resting level of its own?
   *
   * The tile used to take its shape from `restFilled`, which reads the ticket
   * that OPENED the panel — one shape for every leg. Open a market order and
   * each limit leg selected afterwards drew as a plain market tile; open an
   * executed limit leg and the bracket chrome stuck to every leg after it.
   * The StripLegRow list already resolves this per leg through
   * `legPeersAtEdge`, so the row chip and the tile above it could disagree
   * about the very same order.
   *
   * A leg renders as what it IS: its own resting level decides, whichever
   * ticket opened the panel. Not `coverOnly` — a bracket resting at this edge
   * is a limit order on this leg and the tile must offer its sheet. Falls back
   * to the opened ticket when there is no leg to ask (a bullet, nothing
   * selected); a leg with no order of its own takes the composing toggle.
   */
  const selectedLegLimitOrder = useMemo((): boolean => {
    if (structure !== 'strip') return restFilled;
    // No leg selected: the strip's main pad trades the whole strip at
    // market. The opened leg's order is shown on its own row.
    if (selectedEdgeIndex < 0) return false;
    const { filled, working, cancelled } = legPeersAtEdge(
      ownStripTickets,
      selectedEdgeIndex,
    );
    const own = filled ?? working[0] ?? cancelled;
    if (!own) return false;
    return own.limitRate != null;
  }, [structure, selectedEdgeIndex, ownStripTickets, restFilled]);
  const fillTicket: HedgeTicket = (() => {
    if (structure !== 'strip' || selectedEdgeIndex < 0) return ticket;
    // Every fallback stays AT THIS EDGE. Falling through to another leg is
    // the defect being fixed, so a row with nothing of its own drops to the
    // draft — where `filled` is false and no execution chrome renders — and
    // never borrows a neighbour's dealer, time or rate.
    const cover = legPeersAtEdge(ownStripTickets, selectedEdgeIndex, {
      coverOnly: true,
    });
    const any = legPeersAtEdge(ownStripTickets, selectedEdgeIndex);
    // Nothing at this edge: the draft with no order of its own. `ticket`
    // here gave a free leg the opened order's level, role and fill chrome.
    const {
      limitRate: _freeLimit,
      restingAnchorRate: _freeAnchor,
      status: _freeStatus,
      goodTillMs: _freeGoodTill,
      orderValidity: _freeValidity,
      ...freeLegDraft
    } = orderSeed;
    return (
      cover.filled
      ?? any.filled
      ?? cover.working[0]
      ?? any.working[0]
      ?? freeLegDraft
    );
  })();
  const fillTicketBooked = isMarketExecutedHedgeTicket(fillTicket);
  /**
   * The tile is VIEWING an order (a selected leg's, or the one a read-only
   * panel opened on) — not composing or editing one. Each pad then shows its
   * own order only: a leftover armed / typed rate on a pad with no order read
   * as a stop-loss at 1.14713 beside a lone take-profit.
   */
  //
  // On a strip that is decided by the SELECTED leg alone. The opened ticket
  // must not decide it: after an order is left the panel is read-only on
  // that order, and composing a new one on another, free leg then showed an
  // empty form (0.0000 / 0.0000) that ignored whatever was typed.
  const viewingOrder =
    !editingOrder
    && (structure === 'strip'
      ? selectedLegLimitOrder
      : readOnly && ticket.limitRate != null);
  /** Is `t` the order this panel is editing (or that order's OCO sibling)? */
  const isOrderBeingEdited = (t: HedgeTicket): boolean =>
    editingOrder
    && (t.id === ticket.id
      || (ticket.ocoGroupId != null && t.ocoGroupId === ticket.ocoGroupId));
  /**
   * What the header's Edit opens: the SELECTED leg's working order when one
   * is selected, else the order the panel opened on. It used to be only the
   * opened one, so on a strip the pencil could never reach the leg the desk
   * was looking at.
   */
  const editTarget = ((): HedgeTicket | null => {
    const selectedLegOrder =
      structure === 'strip' && selectedEdgeIndex >= 0
        ? legPeersAtEdge(ownStripTickets, selectedEdgeIndex).working[0] ?? null
        : null;
    const candidate = selectedLegOrder ?? (selectedEdgeIndex < 0 ? ticket : null);
    return candidate && isEditableWorkingOrder(candidate) && !isOrderBeingEdited(candidate)
      ? candidate
      : null;
  })();
  /**
   * A limit order the card is showing that has NOT executed yet — being
   * drafted, or working. It rests at a spot level on the spot tape, so the
   * card quotes live spot. Once it executes it has booked the leg's forward,
   * and the card goes back to the leg's forward quote like any fill.
   */
  // A NEW order being placed is on spot whatever `fillTicket` is: on a
  // reopened strip that is an executed ticket, and letting it veto the
  // placement put the card on forwards and ran each keystroke of the typed
  // level through fmtPx + the leg's points, so the field snapped back and
  // read as frozen.
  const placingLimitOrder =
    limitMode
    && submittedHit == null
    && !fillDone
    // An executed leg takes no new order; it stays on its forward, as its
    // chart does.
    && !(structure === 'strip' && selectedLegKey != null && fillTicketBooked);
  const limitOrderOnSpot =
    placingLimitOrder
    || ((limitMode || selectedLegLimitOrder) && !fillTicketBooked);
  /**
   * A spot-referenced order's level in the CARD's convention: its spot level
   * while the card quotes spot (working), else the forward it books at — spot
   * level + that leg's stamped points. A cancelled OCO sibling on an executed
   * card read its spot 1.14099 beside a forward LIVE REF while the chart drew
   * it at 1.14382.
   */
  const levelInCardConvention = (
    t: HedgeTicket | null | undefined,
    level: number | null | undefined,
  ): number | null => {
    if (level == null || !Number.isFinite(level) || level <= 0) return null;
    if (limitOrderOnSpot || !t?.isSpotReferenced) return level;
    return bookedForwardFromSpotFill({ fillPx: level, points: t.stripLegPoints, ccy: t.ccy })
      ?? level;
  };
  /** The tenor of the leg the card is on — exact, not the horizon bucket. */
  const cardTenorLabel =
    instrument !== 'spot' && legMonths != null
      ? formatMarketTenor(months)
      : (tenorLabel(tenor) ?? tenor);
  /**
   * The order resting / printed on THIS pad at the selected strip edge —
   * not the overlay `ticket`. `padTicketForHit` only sees the opened
   * ticket and its OCO sibling, so a mixed MKT+TP strip kept painting
   * L1's fill on the grey tile while the header already followed L3.
   */
  const selectedPadTicketForHit = (hit: HitSide): HedgeTicket | null | undefined => {
    if (structure !== 'strip' || selectedEdgeIndex < 0) {
      return padTicketForHit(hit);
    }
    // The row's execution (`fillTicket`) is the pad's fill. Scanning every
    // peer first handed a leftover / overlay ticket the grey tile — header
    // time and dealer already followed L2 while the pip-split stayed on L1.
    if (
      fillTicketBooked
      && (
        padHitForTicket(fillTicket) === hit
        || restingOrderHitSide(fillTicket) === hit
      )
    ) {
      return fillTicket;
    }
    const peers = ownStripTickets.filter(
      t => (t.stripEdgeIndex ?? 0) === selectedEdgeIndex,
    );
    // A leg with nothing of its own shows nothing of the opened order's.
    if (peers.length === 0) return null;
    const executed = peers.filter(isMarketExecutedHedgeTicket);
    const byTyped = executed.find(t => padHitForTicket(t) === hit);
    if (byTyped) return byTyped;
    const byExec = executed.find(t => restingOrderHitSide(t) === hit);
    if (byExec) return byExec;
    const tpHit = limitTakeProfitHit(side);
    const role: 'takeProfit' | 'stopLoss' =
      hit === tpHit ? 'takeProfit' : 'stopLoss';
    return peers.find(t => t.bracketRole === role) ?? null;
  };
  /**
   * Booked FX the priced-leg row prints (outright / FWD), not the tape
   * spot print `executionFillRate` returns for a spot-referenced TP/SL.
   */
  const bookedPadFillPx = (pad: HedgeTicket): number | null => {
    const outright = pad.ipaQuote?.fxOutright;
    if (outright != null && Number.isFinite(outright) && outright > 0) {
      return outright;
    }
    return (
      executionFillRate(pad)
      ?? (pad.limitRate != null && Number.isFinite(pad.limitRate) && pad.limitRate > 0
        ? pad.limitRate
        : null)
    );
  };
  /**
   * Which PAD/CARD the filled order's UI lives on — a tile concept, from
   * `orderHit` (the tile the level was typed into). Never use this for the
   * market side of the execution: for a bracket leg the two commonly differ
   * (a Buy TP is typed on the bid tile, executes on the ask).
   *
   * A strip row's own fill wins over `execReport` (the session's first
   * click, usually L1). Otherwise clicking a FILLED-TP row kept the bid
   * pad in L1's market-fill chrome.
   */
  const filledHit: HitSide | null =
    fillTicketBooked
      ? (fillTicket.orderHit ?? restingOrderHitSide(fillTicket))
      : execReport != null && execReport.scope !== 'leg'
        ? execReport.hit
        : restFilled || liveFilled
          ? (fillTicket.orderHit ?? restingOrderHitSide(fillTicket))
          : null;
  /**
   * The market side the fill actually executed on — the same
   * `restingOrderHitSide` convention the matcher fills with. This is what
   * fill markers, footers and dealer-side picks must show; using the typed
   * tile there rendered a Buy TP as `FILL · TP · BID` with a Sell arrow
   * while the matcher's own log said it filled the ask.
   */
  const executedHit: HitSide | null =
    fillTicketBooked
      ? restingOrderHitSide(fillTicket)
      : restFilled || liveFilled
        ? restingOrderHitSide(fillTicket)
        : execReport != null && execReport.scope !== 'leg'
          ? execReport.hit
          : null;
  const optionQuoteBid: HedgeIpaQuote | null =
    instrument !== 'option'
      ? null
      : fillDone && (executedHit === 'bid' || filledHit === 'bid')
        ? (fillTicket.ipaQuote ?? pricedBid?.quote ?? null)
        : structure === 'strip' && stripRows.length > 0
          ? blendStripOptionQuote(stripQuotes, stripRows, 'bid')
          : (pricedBid?.quote ?? null);
  const optionQuoteAsk: HedgeIpaQuote | null =
    instrument !== 'option'
      ? null
      : fillDone && (executedHit === 'ask' || filledHit === 'ask')
        ? (fillTicket.ipaQuote ?? pricedAsk?.quote ?? null)
        : structure === 'strip' && stripRows.length > 0
          ? blendStripOptionQuote(stripQuotes, stripRows, 'ask')
          : (pricedAsk?.quote ?? null);
  const reportFillPx =
    execReport?.fills.find(
      f => f.rate != null && Number.isFinite(f.rate) && f.rate > 0,
    )?.rate ?? null;
  const stickyFillPx = stickyFills[fillTicket.id];
  // The leg's OWN stored execution, never a live quote: executionFillRate
  // reads the booked rate off the ticket the matcher stamped. `reportFillPx`
  // is the session's first fill (usually L1) — only valid for that ticket.
  const fillPx: number | null =
    stickyFillPx != null && stickyFillPx > 0
      ? stickyFillPx
      : (fillTicket.id === ticket.id ? reportFillPx : null)
        ?? executionFillRate(fillTicket)
        ?? (fillTicket.limitRate != null && fillTicket.limitRate > 0
          ? fillTicket.limitRate
          : null);
  const fillRole =
    fillTicket.bracketRole === 'stopLoss'
      ? 'SL'
      : fillTicket.bracketRole === 'takeProfit'
        ? 'TP'
        : fillTicketBooked && fillTicket.limitRate != null
          ? 'LIMIT'
          : null;
  const fillAt =
    fillTicket.filledAtMs != null && Number.isFinite(fillTicket.filledAtMs)
      ? formatFillClock(fillTicket.filledAtMs)
      : execReport?.at ?? null;
  const fillAtMs =
    ticket.filledAtMs != null && Number.isFinite(ticket.filledAtMs) && ticket.filledAtMs > 0
      ? ticket.filledAtMs
      : execReport?.atMs ?? null;

  // Freeze first-seen execution prints for the panel ticket and any strip /
  // OCO peers drawn on the tape — later quote walk must not move yellow TP/SL.
  useEffect(() => {
    const next: Record<string, number> = {};
    const consider = (t: HedgeTicket | null | undefined) => {
      if (t == null) return;
      const px = executionFillRate(t);
      if (px == null) return;
      next[t.id] = px;
    };
    consider(ticket);
    consider(siblingOrder);
    for (const t of ownStripTickets) consider(t);
    // The report's fill is the OPENED ticket's own only for a bullet. A strip
    // or leg report fills other legs: pinning its first fill here froze L2's
    // 1.14710 onto a panel opened on L1's working TP, and the chart then drew
    // that TP as filled at 1.14710. Strip legs freeze from their own booked
    // tickets (ownStripTickets) above.
    if (
      execReport != null
      && execReport.scope === 'bullet'
      && fillAtMs != null
      && fillAtMs > 0
    ) {
      const reportPx = execReport.fills.find(
        f => f.rate != null && Number.isFinite(f.rate) && f.rate > 0,
      )?.rate;
      if (reportPx != null && reportPx > 0) next[ticket.id] = reportPx;
    }
    if (Object.keys(next).length === 0) return;
    setStickyFills(prev => {
      let changed = false;
      const merged = { ...prev };
      for (const [id, px] of Object.entries(next)) {
        if (merged[id] != null && merged[id]! > 0) continue;
        merged[id] = px;
        changed = true;
      }
      return changed ? merged : prev;
    });
  }, [ticket, siblingOrder, ownStripTickets, execReport, fillAtMs]);

  const ticketTapeFillPx = tapeFillPrint(ticket);
  const ticketBookedPx = ticket.ipaQuote?.fxOutright ?? null;
  useEffect(() => {
    if (ticket.status !== 'booked' || ticket.filledAtMs == null) return;
    // The opened ticket's execution is stamped onto its OWN leg's series
    // only, in that series' convention: on a forward chart a spot-referenced
    // fill sits at the forward it booked, not at its spot print — which is
    // inside the continuity band and once landed as a tick 27 pips under
    // every candle, stretching the bar down to it.
    if (!chartIsOwnLeg) return;
    const px = chartIsSpot
      ? stickyFills[ticket.id] ?? ticketTapeFillPx ?? ticket.limitRate
      : ticketBookedPx ?? stickyFills[ticket.id] ?? ticket.limitRate;
    if (px == null || !(px > 0)) return;
    setTapeTrail(prev =>
      tapeWithFillMarker(prev, ticket.filledAtMs, px),
    );
  }, [
    ticket.status,
    ticket.filledAtMs,
    ticketTapeFillPx,
    ticketBookedPx,
    ticket.limitRate,
    stickyFills,
    ticket.id,
    chartIsOwnLeg,
    chartIsSpot,
  ]);

  const armSelection = (
    hit: HitSide,
    target: HitTarget,
    px: number | null,
    limitOrder = false,
  ) => {
    const nextSide = limitOrder ? limitOrderSideForHit(hit) : orderSideForHit(hit);
    setWorkingHit(hit);
    setHitTarget(target);
    setSide(nextSide);
    setQuoteSide(hit);
    setOrderRate(px != null ? fmtPx(px) : '');
    setOrderRates(prev => ({
      ...prev,
      [hit]: px != null ? fmtPx(px) : '',
    }));
    setOrderRateEdited(false);
  };

  const executeHit = (hit: HitSide, target: HitTarget) => {
    // `fillDone` retires the MAIN tile. A leg is judged on its own (its row
    // locks once it executed), so a leg whose order is still working can be
    // filled now even after a bulk fill marked the tile done.
    if ((fillDone && target.kind !== 'leg') || !canConfirm) return;
    if (target.kind === 'main' && stripPadBlockedOnFwd) return;
    if (
      target.kind === 'main'
      && structure === 'strip'
      && (tileBid == null || tileAsk == null)
    ) {
      return;
    }
    // A level typed away from the market is a limit order, not a fill. Same
    // button either way: if it cannot execute at the current quote it rests
    // and the monitor fills it when the rate gets there.
    const selectedOrderRate = orderRates[hit];
    // Only the 'main' fill below (not a strip leg) ever prices off a typed
    // rate at all, so this is the only target the resting check applies to.
    let mainRateAlreadyThroughMarket = false;
    if (target.kind === 'main' && orderRateEdited) {
      const check = checkRestingLevel(hit, selectedOrderRate);
      if (check === 'rests') {
        placeLeaveOrder(hit);
        return;
      }
      if (check === 'invalid') {
        // Wrong side of the market, or too close to be meaningfully resting
        // (see checkRestingLevel) — reject rather than silently filling at
        // that arbitrary typed rate.
        return;
      }
      // 'triggered': the level is already at or through the market in the
      // right direction — a legitimate marketable order. Fall through to
      // the normal fill below, but price it off the live quote, not the
      // (now-irrelevant) typed rate.
      mainRateAlreadyThroughMarket = true;
    }
    const mainStrip =
      target.kind === 'main' && structure === 'strip' && stripRows.length > 0;
    const isStripFill = mainStrip || target.kind === 'leg';
    const nextSide = isStripFill
      ? pairSideForFcySide(
          (liveStripPkg?.coverLocalM ?? ticket.amountLocalM) >= 0
            ? 'Sell'
            : 'Buy',
          ticket.ccy,
          baseCcy,
        )
      : orderSideForHit(hit);
    const fillFromRow = (row: StripRow): ExecFill => {
      const q = stripQuotes.find(x => x.key === row.key);
      const livePx = hit === 'bid' ? tileBid : tileAsk;
      const legPx = hit === 'bid' ? q?.bid ?? null : q?.ask ?? null;
      const quoted = stripLevelFillRate({
        structure,
        instrument,
        target: target.kind,
        liveSpotPx: livePx,
        legOutrightPx: legPx,
      });
      const rate =
        target.kind === 'leg'
          || (target.kind === 'main' && instrument === 'spot' && orderRateEdited)
          || (target.kind === 'main' && row.near && orderRateEdited)
          ? parseLeaveRate(selectedOrderRate, quoted)
          : quoted;
      return {
        key: row.key,
        label: row.label,
        // Always the ROW's instrument: a forward leg executed off the spot
        // tile is still a forward booked at its own outright, not a spot
        // trade at the shared print.
        instrument: row.instrument,
        sizeM: row.sizeM,
        rate,
        bank: hit === 'bid' ? row.bankBid : row.bankAsk,
        premiumUsd:
          (hit === 'bid' ? q?.premiumBidUsd : q?.premiumAskUsd)
          ?? q?.premiumUsd
          ?? null,
      };
    };
    let fills: ExecFill[];
    let scope: ExecReport['scope'];
    // Set only inside the `mainStrip` branch: whether this bulk click priced
    // EVERY row it targeted, or silently dropped one for lacking a live
    // quote right now (the filter two lines below).
    let stripBulkUnpricedLegs = 0;
    if (mainStrip) {
      // A market click fills what the pad says is pending. A leg with an
      // order still working is not pending (sessionStripClipAbs counts it,
      // freeStripLegKeys locks its row) — and that order IS the leg's
      // execution, so filling the leg at market as well booked it twice
      // the moment the order triggered.
      const openRows = stripRowsForOrder({ kind: 'main' }).filter(row => {
        const edgeIndex = stripRows.findIndex(r => r.key === row.key);
        return legPeersAtEdge(ownStripTickets, edgeIndex).working.length === 0;
      });
      if (openRows.length === 0) return;
      fills = openRows.map(fillFromRow).filter(
        f => f.rate != null && Number.isFinite(f.rate) && f.rate > 0,
      );
      if (fills.length === 0) return;
      stripBulkUnpricedLegs = openRows.length - fills.length;
      scope = 'strip';
    } else if (target.kind === 'leg') {
      const row = stripRowForLegTarget(target);
      if (!row) return;
      fills = [fillFromRow(row)];
      scope = 'leg';
    } else {
      const quoted =
        hit === 'bid'
          ? tileBid ?? pricedBid?.quote.fxOutright ?? spot?.bid ?? null
          : tileAsk ?? pricedAsk?.quote.fxOutright ?? spot?.ask ?? null;
      fills = [
        {
          key: 'bullet',
          label: instrument === 'spot' ? 'Spot' : tenorLabel(tenor) ?? tenor,
          instrument,
          sizeM,
          rate:
            orderRateEdited && !mainRateAlreadyThroughMarket
              ? parseLeaveRate(selectedOrderRate, quoted)
              : quoted,
          bank: hit === 'bid' ? tileBankBid : tileBankAsk,
          premiumUsd:
            instrument === 'option'
              ? (hit === 'bid'
                  ? pricedBid?.quote.premiumUsd
                  : pricedAsk?.quote.premiumUsd) ?? null
              : null,
        },
      ];
      scope = 'bullet';
    }

    // A strip market fill needs a price per leg. A row that could not be
    // priced off the live print has no rate (stripQuotes withholds it), so
    // the click is refused rather than booking a seed-curve outright.
    if (
      isStripFill
      && fills.some(f => f.rate == null || !Number.isFinite(f.rate) || f.rate <= 0)
    ) {
      return;
    }
    const filledAtMs = Date.now();
    const report: ExecReport = {
      at: clockNow(),
      atMs: filledAtMs,
      pair,
      hit,
      side: nextSide,
      scope,
      fills,
    };
    // A leg fill books that row only, so it must not set the ticket-wide
    // execReport: that flips fillDone and freezes the whole panel — the other
    // legs and both top pads included. The row shows filled from its booked
    // peer in `relatedStripTickets` instead.
    //
    // A bulk strip click that dropped a leg for a missing live price is the
    // same case: that leg is still the desk's to trade, so the ticket-wide
    // freeze (`fillDone` for a strip is exactly `execReport != null`) is
    // held back and the desk clicks again. The rows it DID fill are booked
    // below regardless. A leg skipped because an order works on it is not
    // tradeable now anyway: the tile shows the fill (grey) as before, and
    // is released again if that order is cancelled (see the effect on
    // execReport below).
    if (scope === 'leg' || stripBulkUnpricedLegs > 0) {
      setWorkingHit(null);
      setHitTarget(null);
    } else {
      setExecReport(report);
      setWorkingHit(hit);
      setHitTarget(target);
    }
    // A partial bulk fill is surfaced, never silent: the rows it did fill
    // show as filled, and this says why the rest did not.
    setLeaveError(
      stripBulkUnpricedLegs > 0
        ? `${stripBulkUnpricedLegs} leg${stripBulkUnpricedLegs === 1 ? '' : 's'} had no live price and ${stripBulkUnpricedLegs === 1 ? 'was' : 'were'} not filled — click again to fill ${stripBulkUnpricedLegs === 1 ? 'it' : 'them'}.`
        : null,
    );
    setLimitMode(false);
    setOrderRateEdited(false);
    const firstFillPx = fills.find(
      f => f.rate != null && Number.isFinite(f.rate) && f.rate > 0,
    )?.rate;
    // The marker lives in CHART space. Legs book at their own outrights,
    // but the visible chart can be a different identity (the spot tile, or
    // another tenor) — a live click executes at the current print, so the
    // chart's own live mid at this instant IS the fill in chart
    // coordinates. Pinning the row's outright onto the spot series floated
    // the marker a whole points-shift off every candle.
    const chartMidAtFill =
      chartBid != null && chartAsk != null && chartBid > 0 && chartAsk > 0
        ? (chartBid + chartAsk) / 2
        : null;
    const markerPx = chartMidAtFill ?? firstFillPx;
    if (markerPx != null) {
      setTapeTrail(prev => tapeWithFillMarker(prev, filledAtMs, markerPx));
    }

    if (scope === 'leg' && target.kind === 'leg') {
      const row = stripRowForLegTarget(target);
      const fill = fills[0];
      if (!row || !fill) return;
      const {
        bracketRole: _bracketRole,
        ocoGroupId: _ocoGroupId,
        orderType: _orderType,
        limitRate: _limitRate,
        goodTillMs: _goodTillMs,
        orderValidity: _orderValidity,
        // A live click books the leg at its own outright — never on spot.
        isSpotReferenced: _isSpotReferenced,
        stripLegPoints: _stripLegPoints,
        // A market fill never rested: the opened order's spot anchor on it
        // drew a PLACED pin and seeded its forward chart from spot.
        restingAnchorRate: _restingAnchorRate,
        ...coverBase
      } = ticket;
      const stamped = {
        ...coverBase,
        status: 'booked' as const,
        orderType: 'market' as const,
        filledAtMs,
        counterparty: fill.bank,
        amountLocalM: signedLocalMForPairSide(
          nextSide,
          row.sizeM,
          ticket.ccy,
          baseCcy,
        ),
        orderSide: fcySideFromPairSide(nextSide, ticket.ccy, baseCcy),
        orderHit: hit,
        stripId: fillStripId,
        stripEdgeIndex: bookEdgeForStripRow(row),
        ...stripLegTenorFields(row),
        ipaQuote: {
          ...(priced?.quote ?? {}),
          strike: priced?.quote.strike ?? null,
          strikeInput,
          premiumUsd: fill.premiumUsd,
          premiumPercent: priced?.quote.premiumPercent ?? null,
          fxSpot: (hit === 'bid' ? liveSpot?.bid : liveSpot?.ask) ?? liveSpot?.mid ?? priced?.quote.fxSpot ?? null,
          fxOutright: fill.rate,
          atmVolPercent: priced?.quote.atmVolPercent ?? null,
          impliedVolPercent: priced?.quote.impliedVolPercent ?? null,
          deltaPercent: priced?.quote.deltaPercent ?? null,
          gammaPercent: priced?.quote.gammaPercent ?? null,
          vegaPercent: priced?.quote.vegaPercent ?? null,
          thetaPercent: priced?.quote.thetaPercent ?? null,
          vannaPercent: priced?.quote.vannaPercent ?? null,
          volgaPercent: priced?.quote.volgaPercent ?? null,
        },
        // The ladder SHAPE rides on a booked ticket, and reopening the
        // strip rebuilds its rows from it. Attaching only to edge 0 meant a
        // strip whose first leg was never executed came back with no shape
        // at all — stripPackageForTicketView saw one edge, returned a
        // 1-leg package, and the panel fell through to a synthetic default
        // ladder whose edges did not line up with the booked leg, so no
        // leg showed its executed status. Carry the shape on whichever leg
        // books first when no peer holds it yet.
        ...(liveStripPkg
          && (stripRows.findIndex(r => r.key === row.key) === 0
            || !ownStripTickets.some(t => t.sourcePackage))
          ? { sourcePackage: liveStripPkg }
          : {}),
      };
      onConfirm(stamped, {
        structure: 'strip',
        package: liveStripPkg ?? undefined,
        fillScope: 'leg',
      });
      // Filled at market while an order works on this leg: that order goes
      // (with its OCO sibling), or it would book the leg a second time when
      // it triggers. An order being edited here is retired by the parent's
      // edit path already.
      const retired = new Set<string>();
      for (const order of legPeersAtEdge(
        ownStripTickets,
        stripRows.findIndex(r => r.key === row.key),
      ).working) {
        const group = order.ocoGroupId ?? order.id;
        if (retired.has(group) || isOrderBeingEdited(order)) continue;
        retired.add(group);
        onCancelWorkingOrder?.(order, { replacedByFill: true });
      }
      return;
    }

    if (scope === 'strip') {
      const {
        bracketRole: _bracketRole,
        ocoGroupId: _ocoGroupId,
        orderType: _orderType,
        limitRate: _limitRate,
        goodTillMs: _goodTillMs,
        orderValidity: _orderValidity,
        isSpotReferenced: _isSpotReferenced,
        stripLegPoints: _stripLegPoints,
        // A market fill never rested: the opened order's spot anchor on it
        // drew a PLACED pin and seeded its forward chart from spot.
        restingAnchorRate: _restingAnchorRate,
        ...coverBase
      } = ticket;
      const stripTickets = fills.flatMap(fill => {
        const row = stripRows.find(r => r.key === fill.key);
        if (!row) return [];
        return [{
          ...coverBase,
          id: newHedgeTicketId(),
          status: 'booked' as const,
          orderType: 'market' as const,
          filledAtMs,
          counterparty: fill.bank,
          amountLocalM: signedLocalMForPairSide(
            nextSide,
            row.sizeM,
            ticket.ccy,
            baseCcy,
          ),
          orderSide: fcySideFromPairSide(nextSide, ticket.ccy, baseCcy),
          orderHit: hit,
          stripId: fillStripId,
          stripEdgeIndex: bookEdgeForStripRow(row),
          ...stripLegTenorFields(row),
          ipaQuote: {
            ...(priced?.quote ?? {}),
            strike: priced?.quote.strike ?? null,
            strikeInput,
            premiumUsd: fill.premiumUsd,
            premiumPercent: priced?.quote.premiumPercent ?? null,
            fxSpot: (hit === 'bid' ? liveSpot?.bid : liveSpot?.ask) ?? liveSpot?.mid ?? priced?.quote.fxSpot ?? null,
            fxOutright: fill.rate,
            atmVolPercent: priced?.quote.atmVolPercent ?? null,
            impliedVolPercent: priced?.quote.impliedVolPercent ?? null,
            deltaPercent: priced?.quote.deltaPercent ?? null,
            gammaPercent: priced?.quote.gammaPercent ?? null,
            vegaPercent: priced?.quote.vegaPercent ?? null,
            thetaPercent: priced?.quote.thetaPercent ?? null,
            vannaPercent: priced?.quote.vannaPercent ?? null,
            volgaPercent: priced?.quote.volgaPercent ?? null,
          },
          ...(liveStripPkg ? { sourcePackage: liveStripPkg } : {}),
        }];
      });
      if (stripTickets.length === 0) return;
      onConfirm(stripTickets[0]!, {
        structure: 'strip',
        package: liveStripPkg ?? undefined,
        fillScope: 'strip',
        stripTickets,
        stripFills: stripTickets.map(t => ({
          edgeIndex: t.stripEdgeIndex ?? 0,
          rate: t.ipaQuote?.fxOutright ?? null,
        })),
      });
      return;
    }

    const fillPx = fills[0]?.rate;
    // A market fill is its own trade: none of the opened order's resting
    // level, anchor or validity. Carrying `limitRate` labelled it LIMIT.
    const {
      limitRate: _mktLimit,
      restingAnchorRate: _mktAnchor,
      goodTillMs: _mktGoodTill,
      orderValidity: _mktValidity,
      ...marketSeed
    } = orderSeed;
    const booked =
      fillPx != null && Number.isFinite(fillPx)
        ? {
            ...marketSeed,
            orderType: 'market' as const,
            orderSide: fcySideFromPairSide(nextSide, ticket.ccy, baseCcy),
            orderHit: hit,
            status: 'booked' as const,
            filledAtMs,
            counterparty: fills[0]?.bank,
            ipaQuote: {
              ...(draftTicket.ipaQuote ?? {
                strike: priced?.quote.strike ?? null,
                strikeInput,
                premiumUsd: fills[0]?.premiumUsd ?? null,
                premiumPercent: priced?.quote.premiumPercent ?? null,
                fxSpot: (hit === 'bid' ? liveSpot?.bid : liveSpot?.ask) ?? liveSpot?.mid ?? priced?.quote.fxSpot ?? null,
                fxOutright: fillPx,
                atmVolPercent: priced?.quote.atmVolPercent ?? null,
                impliedVolPercent: priced?.quote.impliedVolPercent ?? null,
                deltaPercent: priced?.quote.deltaPercent ?? null,
                gammaPercent: priced?.quote.gammaPercent ?? null,
                vegaPercent: priced?.quote.vegaPercent ?? null,
                thetaPercent: priced?.quote.thetaPercent ?? null,
                vannaPercent: priced?.quote.vannaPercent ?? null,
                volgaPercent: priced?.quote.volgaPercent ?? null,
              }),
              fxOutright: fillPx,
            },
          }
        : {
            ...marketSeed,
            orderType: 'market' as const,
            status: 'booked' as const,
            filledAtMs,
            counterparty: fills[0]?.bank,
          };
    onConfirm(booked, {
      structure,
      package:
        structure === 'strip'
          ? (liveStripPkg ?? undefined)
          : (liveBulletPkg ?? undefined),
      fillScope: 'main',
      // Only a BULLET reaches here: the `scope === 'strip'` and `scope === 'leg'`
      // branches above both return, and a bullet has no strip legs to stamp. The
      // strip path reports its own fills by row edge index (see that block).
      stripFills: undefined,
    });
  };

  /**
   * Leave the order working at the typed level instead of hitting the market.
   * `side` decides the sign the same way a market fill does, so a resting
   * order and a filled one carry the same convention.
   */
  /**
   * Would an order at the typed level rest rather than execute now? Reuses the
   * monitor's own trigger rule so the ticket and the executor agree on which
   * side of the quote a level is reachable from.
   */
  /**
   * 'rests' — off-market on the correct side (including 1 pip). 'triggered'
   * — at or through that pad's LIVE REF (already marketable). 'invalid' —
   * no usable level / quote.
   */
  const checkRestingLevel = (
    hit: HitSide,
    rate = orderRates[hit],
    bracketRole?: 'takeProfit' | 'stopLoss',
    orderSide: 'Buy' | 'Sell' = orderSideForHit(hit),
  ): 'rests' | 'triggered' | 'invalid' => {
    if (!onLeaveOrder) return 'invalid';
    const limit = parseLeaveRate(rate, null);
    if (limit == null || !(limit > 0)) return 'invalid';
    // Against live spot — the tape every working limit order triggers on and
    // the LIVE REF the card shows. Validating against the panel tenor's
    // outright judged a spot level against a market it never watches.
    const q = { bid: bracketRefBid, ask: bracketRefAsk };
    if (q.bid == null || q.ask == null || !(q.bid > 0) || !(q.ask > 0)) {
      return 'invalid';
    }
    const probe: HedgeTicket = {
      ...draftTicket,
      amountLocalM: signedLocalMForPairSide(
        orderSide,
        sizeM,
        ticket.ccy,
        baseCcy,
      ),
      orderSide: fcySideFromPairSide(orderSide, ticket.ccy, baseCcy),
      orderHit: hit,
      bracketRole,
      status: 'scheduled',
      limitRate: limit,
    };
    const live = { bid: q.bid, ask: q.ask };
    return bracketRole
      ? classifyBracketLevel(probe, live)
      : classifyRestingLevel(probe, live);
  };

  // Bracket TP/SL may only be left working. Through-market is not a rest
  // (that used to enable Submit SL on a buy stop sitting below the ask).
  const restsAwayFromMarket = (
    hit: HitSide,
    rate = orderRates[hit],
    bracketRole?: 'takeProfit' | 'stopLoss',
    orderSide: 'Buy' | 'Sell' = orderSideForHit(hit),
  ): boolean => checkRestingLevel(hit, rate, bracketRole, orderSide) === 'rests';

  const quotePxForRow = (row: StripRow, hit: HitSide): number | null => {
    const q = stripQuotes.find(x => x.key === row.key);
    return hit === 'bid' ? q?.bid ?? null : q?.ask ?? null;
  };

  const stripRowsForOrder = (target: HitTarget): StripRow[] => {
    if (!(structure === 'strip' && stripRows.length > 0)) return [];
    // ANY execution closes the edge, a TP/SL fill included — it booked that
    // leg's forward (spot + points) just as a live click does. Counting only
    // non-bracket fills let the whole-strip market click buy a leg its own
    // take-profit had already filled: the edge was booked twice and the row
    // then showed the second, MARKET fill. freeStripLegKeys already counts
    // bracket fills as the leg having traded.
    const executedCoverEdges = new Set(
      ownStripTickets
        .filter(t => isExecutedBookedTicket(t))
        .map(t => t.stripEdgeIndex ?? 0),
    );
    const open = (row: StripRow, edgeIndex: number) =>
      row.sizeM > 1e-9 && !executedCoverEdges.has(edgeIndex);
    if (target.kind === 'leg') {
      const row = stripRowForLegTarget(target);
      const edgeIndex = row ? stripRows.findIndex(r => r.key === row.key) : -1;
      return row && edgeIndex >= 0 && open(row, edgeIndex) ? [row] : [];
    }
    return stripRows.filter((r, i) => open(r, i));
  };

  const midAnchor =
    tileBid != null && tileAsk != null && tileBid > 0 && tileAsk > 0
      ? (tileBid + tileAsk) / 2
      : liveSpot?.mid;

  /** Stamp leave-time on the tape + sticky PLACED / CHANGE pin (survives fill freeze). */
  const stampPlacement = (px: number | null | undefined) => {
    const t = Date.now();
    const rate =
      px != null && px > 0 && Number.isFinite(px)
        ? px
        : midAnchor != null && midAnchor > 0
          ? midAnchor
          : null;
    if (rate != null) {
      const prior = stickyPlacedRef.current;
      if (prior != null && prior.t > 0 && prior.px > 0) {
        // Already left once — this stamp is an amend / re-leave.
        setStickyChanges(chs => [...chs, { t, px: rate }]);
      } else {
        setStickyPlaced({ t, px: rate });
      }
    }
    // The chart's own quote: at submit the chart is on spot, and a forward
    // `liveTape` tick here spiked M1/M2 and, on the Order period, replaced
    // the whole series for longer tenors.
    const q = chartLiveRef.current;
    if (!q) return;
    setTapeTrail(prev =>
      appendChartLiveTick(prev, { ...q, t, marker: true }),
    );
  };

  const placeLeaveOrder = (hit: HitSide) => {
    if (!onLeaveOrder || fillDone) return;
    // The same target the bracket path and the pad's LIVE REF use. With a
    // leg selected, `hitTarget ?? main` still left the order on every row,
    // anchored on the near leg, while the pad quoted the selected leg.
    const leaveTarget = padHitTarget();
    if (leaveTarget.kind === 'main' && stripPadBlockedOnFwd) return;
    const limit = parseLeaveRate(orderRates[hit], null);
    if (limit == null || !(limit > 0)) return;
    const restingSide = orderSideForHit(hit);
    const target = leaveTarget;
    const legs = stripRowsForOrder(target);
    // Every targeted leg already executed: there is nothing to leave. The
    // bullet branch below would book an order on the OPENED ticket's leg.
    if (structure === 'strip' && stripRows.length > 0 && legs.length === 0) {
      setLeaveError(NO_OPEN_LEG_LEAVE);
      return;
    }
    // A working limit rests at a SPOT level on the spot tape, whichever leg
    // it is for, and books that leg's forward when it fills.
    const spotRef = hit === 'bid' ? bracketRefBid : bracketRefAsk;
    if (legs.length > 0) {
      const stripId = fillStripId;
      const tickets = legs.map(row => {
        const edgeIndex = bookEdgeForStripRow(row);
        // THIS leg's quote, not the draft's. `stripOrderSeed` carries the
        // draft's ipaQuote, whose fxOutright is the single typed level, so
        // every leg of a ladder booked that one near-spot rate whatever its
        // tenor. The per-leg quotes are already priced in `stripQuotes`.
        const legQuote = (() => {
          const q = stripQuotes.find(x => x.key === row.key);
          // Only a leg priced off a LIVE print: stripQuotes nulls bid/ask
          // otherwise, and a seed-curve fxSpot stamped here can seed the
          // currency's shared CCY|spot tape pips off the market.
          if (q?.bid == null || q?.ask == null) return null;
          return (hit === 'bid' ? q.quoteBid : q.quoteAsk) ?? null;
        })();
        const order: HedgeTicket = {
          ...stripOrderSeed,
          id: newHedgeTicketId(),
          stripId,
          stripEdgeIndex: edgeIndex,
          amountLocalM: signedLocalMForPairSide(
            restingSide,
            row.sizeM,
            ticket.ccy,
            baseCcy,
          ),
          orderSide: fcySideFromPairSide(restingSide, ticket.ccy, baseCcy),
          orderHit: hit,
          orderType: 'limit',
          status: 'scheduled' as const,
          limitRate: restingLevelForLeg(row, limit, legQuote),
          restingAnchorRate: spotRef ?? midAnchor,
          orderValidity: validity,
          goodTillMs: goodTillMsForValidity(validity),
          ...(liveStripPkg ? { sourcePackage: liveStripPkg } : {}),
        };
        // The leg's own priced quote — its spot and its live outright — never
        // the limit. The level lives in `limitRate`. The matcher prices a
        // forward order's trigger tape as live spot + (fxOutright − fxSpot);
        // stamping the limit there put the order's tape on its own limit at
        // placement, and shifted the leg's chart by the limit's distance from
        // market.
        const stamped: HedgeTicket = legQuote
          ? { ...order, ipaQuote: legQuote }
          : order;
        return {
          ...stamped,
          ...spotReferencedLegFields(row, pricedLegPoints(row), restingOrderHitSide(order)),
        };
      });
      const unpriced = unpricedForwardLegs(legs, tickets);
      if (unpriced) {
        setLeaveError(unpriced);
        return;
      }
      setLeaveError(null);
      onLeaveOrder(tickets);
      stampPlacement(spotRef ?? midAnchor);
    } else {
      const signed = signedLocalMForPairSide(
        restingSide,
        sizeM,
        ticket.ccy,
        baseCcy,
      );
      if (Math.abs(signed) < 1e-9) return;
      const order: HedgeTicket = {
        ...orderSeed,
        id: newHedgeTicketId(),
        amountLocalM: signed,
        orderSide: fcySideFromPairSide(restingSide, ticket.ccy, baseCcy),
        orderHit: hit,
        orderType: 'limit',
        status: 'scheduled',
        limitRate: limit,
        restingAnchorRate: spotRef ?? midAnchor,
        orderValidity: validity,
        goodTillMs: goodTillMsForValidity(validity),
      };
      const leaving = { ...order, ...bulletSpotReferenceFields(restingOrderHitSide(order)) };
      if (instrument === 'forward' && !leaving.isSpotReferenced) {
        setLeaveError(UNPRICED_FORWARD_LEAVE);
        return;
      }
      setLeaveError(null);
      onLeaveOrder(leaving);
      stampPlacement(spotRef ?? midAnchor);
    }
    setSubmittedHit(hit);
  };

  const submitLimitOrder = (
    orderType: Exclude<HedgeOrderType, 'market' | 'limit'>,
  ) => {
    if (fillDone || submittedHit != null || !onLeaveOrder) return;
    if (stripPadBlockedOnFwd && padHitTarget().kind !== 'leg') {
      return;
    }
    // Derive the bracket from the flip-aware `side`, exactly as the submit
    // buttons that gate this handler do — NOT from the raw armed pad.
    // `workingHit` restores to `ticket.orderHit` on reopen, and a stop-loss
    // leg's orderHit is the opposite pad by construction, so deriving from
    // it here inverted side, pads and roles against what the buttons had
    // just validated: SUBMIT SL could silently no-op, or — with a level on
    // the other pad — book the OPPOSITE side and role at the other pad's
    // level. The buttons and this handler must share one derivation.
    const selectedSide = side;
    const target = padHitTarget();
    const legs = stripRowsForOrder(target);
    if (structure === 'strip' && stripRows.length > 0 && legs.length === 0) {
      setLeaveError(NO_OPEN_LEG_LEAVE);
      return;
    }
    const takeProfitHit: HitSide = limitTakeProfitHit(selectedSide);
    const stopLossHit = stopLossHitForSelection(takeProfitHit);
    const profitRate = Number(orderRates[takeProfitHit]);
    const lossRate = Number(orderRates[stopLossHit]);
    if (
      orderType === 'oco'
      && Number.isFinite(profitRate)
      && Number.isFinite(lossRate)
      && bracketRoleFor(takeProfitHit, profitRate, lossRate) !== 'takeProfit'
    ) return;
    if (
      (orderType === 'takeProfit' || orderType === 'oco')
      && !restsAwayFromMarket(takeProfitHit, orderRates[takeProfitHit], 'takeProfit', selectedSide)
    ) return;
    if (
      (orderType === 'stopLoss' || orderType === 'oco')
      && !restsAwayFromMarket(stopLossHit, orderRates[stopLossHit], 'stopLoss', selectedSide)
    ) return;

    const makeTicket = (
      hit: HitSide,
      bracketRole: 'takeProfit' | 'stopLoss',
      row: StripRow | null,
      stripId: string | undefined,
      ocoId: string | undefined,
    ): HedgeTicket | null => {
      const typed = parseLeaveRate(orderRates[hit], null);
      if (typed == null || !(typed > 0)) return null;
      const size = row ? Math.abs(row.sizeM) : Math.abs(sizeM);
      if (!(size > 1e-9)) return null;
      const edgeIndex = row ? bookEdgeForStripRow(row) : -1;
      // A working bracket rests at the typed SPOT level on the spot tape,
      // whichever leg it is for, anchored to live spot; its fill books the
      // leg's forward (spot print + the leg's points).
      const spotRef = hit === 'bid' ? bracketRefBid : bracketRefAsk;
      // THIS leg's own priced quote, as placeLeaveOrder stamps. Spreading the
      // seed gave every leg the draft's one ipaQuote, and the matcher builds a
      // forward order's trigger tape as live spot + (fxOutright − fxSpot) —
      // so every tenor rested on the same points, and every leg's chart was
      // shifted by them.
      const legQuote = row
        ? (() => {
            const q = stripQuotes.find(x => x.key === row.key);
            if (q?.bid == null || q?.ask == null) return null;
            return (hit === 'bid' ? q.quoteBid : q.quoteAsk) ?? null;
          })()
        : null;
      const order: HedgeTicket = {
        ...(row ? stripOrderSeed : orderSeed),
        id: newHedgeTicketId(),
        amountLocalM: signedLocalMForPairSide(
          selectedSide,
          size,
          ticket.ccy,
          baseCcy,
        ),
        orderSide: fcySideFromPairSide(selectedSide, ticket.ccy, baseCcy),
        orderHit: hit,
        orderType,
        bracketRole,
        // NO isSpotReferenced in this literal. The flag means "a FORWARD
        // ticket that triggers on the spot tape", and it is valid ONLY paired
        // with a non-zero stripLegPoints - spotTileStripLegFields, applied
        // below, is its one source (decisions.md, 2026-09-11). Setting it on every bracket
        // produced tickets with the flag and no points, which isTicket()
        // in orders/route.ts rejects: the POST still answered 200, the
        // ticket stayed scheduled, and it displayed as working while the
        // matcher never received it. A spot bracket needs no flag -
        // tapeQuoteKey already keys a spot instrument to CCY|spot.
        ...(ocoId ? { ocoGroupId: ocoId } : {}),
        ...(stripId && edgeIndex >= 0 ? { stripId, stripEdgeIndex: edgeIndex } : {}),
        status: 'scheduled',
        limitRate: row ? restingLevelForLeg(row, typed, legQuote) : typed,
        restingAnchorRate: spotRef ?? midAnchor,
        orderValidity: validity,
        goodTillMs: goodTillMsForValidity(validity),
        ...(row && liveStripPkg ? { sourcePackage: liveStripPkg } : {}),
        ...(legQuote ? { ipaQuote: legQuote } : {}),
      };
      if (!row) {
        return { ...order, ...bulletSpotReferenceFields(restingOrderHitSide(order)) };
      }
      return {
        ...order,
        ...spotReferencedLegFields(row, pricedLegPoints(row), restingOrderHitSide(order)),
      };
    };

    const stripId = legs.length > 0 ? fillStripId : undefined;
    const rows: Array<StripRow | null> = legs.length > 0 ? legs : [null];
    const tickets = rows.flatMap(row => {
      const ocoId = orderType === 'oco' ? newHedgeTicketId() : undefined;
      return orderType === 'oco'
        ? [
            makeTicket(takeProfitHit, 'takeProfit', row, stripId, ocoId),
            makeTicket(stopLossHit, 'stopLoss', row, stripId, ocoId),
          ]
        : [
            makeTicket(
              orderType === 'takeProfit' ? takeProfitHit : stopLossHit,
              orderType === 'takeProfit' ? 'takeProfit' : 'stopLoss',
              row,
              stripId,
              undefined,
            ),
          ];
    });
    if (tickets.some(t => t == null)) return;
    const left = tickets as HedgeTicket[];
    const unpriced =
      legs.length > 0
        ? unpricedForwardLegs(legs, left, orderType === 'oco' ? 2 : 1)
        : instrument === 'forward' && left.some(t => !t.isSpotReferenced)
          ? UNPRICED_FORWARD_LEAVE
          : null;
    if (unpriced) {
      setLeaveError(unpriced);
      return;
    }
    setLeaveError(null);
    onLeaveOrder(left);
    setLimitOrderType(orderType);
    setSubmittedHit(orderType === 'takeProfit' ? takeProfitHit : stopLossHit);
    const first = tickets.find((t): t is HedgeTicket => t != null);
    stampPlacement(first?.restingAnchorRate ?? midAnchor);
  };

  const selectHitOnly = (
    hit: HitSide,
    target: HitTarget,
    limitOrder = false,
  ) => {
    if (fillDone && target.kind !== 'leg') return;
    if (target.kind === 'leg') {
      const row = stripRowForLegTarget(target);
      if (row) selectStripLeg(row);
    }
    // A working limit order rests on live spot (checkRestingLevel, the SL
    // autofill, the matcher), so its level starts there — never at the
    // forward outright, which sits the leg's points away from that tape.
    // That holds for ONE leg exactly as for the strip: `bracketRefBid` and
    // `placeLeaveOrder` both say "whatever leg it is for", and seeding a leg
    // order from the leg's outright put the level ~114 pips off its own tape.
    const px = limitOrder
      ? hit === 'bid' ? bracketRefBid : bracketRefAsk
      : target.kind === 'leg'
        ? (() => {
            const q = stripQuotes.find(x => x.key === target.key);
            return hit === 'bid' ? q?.bid ?? null : q?.ask ?? null;
          })()
        : hit === 'bid'
          ? tileBid ?? pricedBid?.quote.fxOutright ?? spot?.bid ?? null
          : tileAsk ?? pricedAsk?.quote.fxOutright ?? spot?.ask ?? null;
    armSelection(hit, target, px, limitOrder);
  };

  const optionDesk = instrument === 'option';
  const optionTenorDisplay =
    optionDesk && months > 0
      ? optionCharts?.premiumSurface?.tenors.find(
          t => Math.abs(t.months - months) < 0.05,
        )?.label
        ?? formatMarketTenor(months)
      : null;
  const showStructureBody = ratesLeft === 'structure';
  const showChartBody = ratesLeft === 'chart';
  const bookingPaneClass = (on: boolean) =>
    on
      ? 'relative z-10 flex min-h-0 min-w-0 w-full flex-1 flex-col'
      : 'pointer-events-none invisible absolute inset-0 z-0 flex min-h-0 min-w-0 flex-col';
  const ratesTenorNote =
    instrument !== 'spot' && legMonths != null
      ? formatMarketTenor(months)
      : tenorLabel(tenor) ?? (months > 0 ? `${months}M` : '1M');
  const ratesChartTitle =
    ratesChartView === 'path' ? 'Exposure path' : 'Price candles';

  const pathChart = pathExposure ? (
    <ExposureHedgePathChart
      ccy={ticket.ccy}
      stockM={pathExposure.stockM}
      monthlyFlowM={pathExposure.monthlyFlowM}
      monthlyFlows={pathExposure.monthlyFlows}
      setup={varSetup}
      marketRates={marketRates ?? undefined}
      appliedHedgeLocalM={liveCoverLocalM}
      hedgeRatio={
        viewingBookedStrip
          ? pathHedgeRatio
          : Math.abs(pathExposure.bookedCoverLocalM ?? 0) > 1e-12
            ? 1
            : pathHedgeRatio
      }
      equalVarHedgeLocalM={pathExposure.equalVarHedgeLocalM}
      endExposureM={pathExposure.endExposureM}
      bookedCoverLocalM={
        viewingBookedStrip ? 0 : pathExposure.bookedCoverLocalM
      }
      forecastTargetLocalM={pathExposure.endExposureM}
      bulletSettleMonthsOverride={structure === 'strip' ? null : months}
      selectedBasis={pathExposure.selectedBasis}
      onSelectedBasisChange={ignorePathBasis}
      onApplyBasis={ignorePathApply}
      hedgeStructure={structure}
      stripLegCount={
        liveStripPkg && liveStripPkg.legs.length > 0
          ? liveStripPkg.legs.length
          : (ticketStripLegs ?? 1)
      }
      onStripLegCountChange={
        lockStripShape
          ? undefined
          : n => {
              stripShapeDirtyRef.current = true;
              // A schedule of the old length cannot describe the new leg
              // count, and `liveStripPkg` reads `schedEnds` BEFORE
              // `ticketStripLegs` — so leaving it set made every leg-count
              // change a no-op: the ladder rebuilt at the old length and the
              // card's stepper snapped straight back. Changing the count
              // drops the custom schedule, which is what the chart's own leg
              // stepper already does before it calls this.
              setSchedEnds(null);
              setSchedWeights(null);
              setTicketStripLegs(n);
            }
      }
      scheduleEndMonths={pathScheduleEnds}
      scheduleHedgeWeights={pathScheduleWeights}
      onScheduleEndMonthsChange={
        lockStripShape
          ? undefined
          : ends => {
              stripShapeDirtyRef.current = true;
              setSchedEnds(ends);
            }
      }
      onScheduleHedgeWeightsChange={
        lockStripShape
          ? undefined
          : weights => {
              stripShapeDirtyRef.current = true;
              setSchedWeights(weights);
            }
      }
      lockOptimizeMix
      profileOnly
      summaryMetricsPlacement="none"
      prepareCtaPlacement="external"
      performancePanelPlacement="external"
      schedulePanelPlacement="external"
      schedulePanelHost={tickTradesHost}
      tickTradesHost={tickTradesHost}
      // Several copies of this element stay mounted at once (Chart pane,
      // Option pane, hidden Structure copy) — only the hidden Structure-pane
      // copy portals the tick-trades table, or the card duplicates.
      tickTradesPortalEnabled={false}
      selectedTickTradeLegIndex={(() => {
        if (selectedLegKey == null) return null;
        const i = stripRows.findIndex(r => r.key === selectedLegKey);
        return i >= 0 ? i : null;
      })()}
      onTickTradeLegSelect={
        fillDone && !stripPadLive
          ? undefined
          : (legIndex: number) => {
              const row = stripRows[legIndex];
              if (row) selectStripLeg(row);
            }
      }
      tickTradesLocked={lockStripShape}
      tickTradeEnabled={legEnabled}
      onTickTradeLegEnabledChange={
        lockStripShape
          ? undefined
          : (legIndex: number, enabled: boolean) => {
              setLegEnabled(prev => ({ ...prev, [legIndex]: enabled }));
            }
      }
      onTickTradeDeltaChange={
        lockStripShape
          ? undefined
          : (legIndex: number, deltaAbsM: number) => {
              setLegEnabled(prev => ({ ...prev, [legIndex]: true }));
              setLegDeltaM(prev => ({ ...prev, [legIndex]: deltaAbsM }));
            }
      }
    />
  ) : null;

  // Show the order's own level on the tape, not whatever side is currently
  // armed in the ticket UI — this plot is "where is price vs the order."
  // For a strip that means the *selected leg's* own outright limit (each leg
  // rests at its own tenor's forward-points-adjusted level), plus its bracket
  // sibling; for a bullet it means this ticket plus its OCO sibling. Kept on a
  // FILLED leg too (for the audit trail) — the level it triggered at.
  // Bracket focus must ignore a prior cover print at the same edge (see
  // chartTicketsAtEdge) or a resting TP is wiped / a cover FILL is drawn under it.
  const chartBracketFocus = useMemo((): Pick<HedgeTicket, 'bracketRole'> | null => {
    if (ticket.bracketRole === 'takeProfit' || ticket.bracketRole === 'stopLoss') {
      return { bracketRole: ticket.bracketRole };
    }
    // Drafting TP/SL/OCO on a strip whose cover already printed — same visual
    // trap as a booked bracket ticket inheriting the cover FILL arrow.
    if (
      limitMode
      && (limitOrderType === 'takeProfit'
        || limitOrderType === 'stopLoss'
        || limitOrderType === 'oco')
    ) {
      return {
        bracketRole:
          limitOrderType === 'stopLoss' ? 'stopLoss' : 'takeProfit',
      };
    }
    return null;
  }, [ticket.bracketRole, limitMode, limitOrderType]);
  const chartLevelTickets = useMemo((): HedgeTicket[] => {
    const hasLevel = (t: HedgeTicket | null | undefined): t is HedgeTicket =>
      t?.limitRate != null && t.limitRate > 0;
    if (structure === 'strip' && selectedStrip) {
      const edgeIndex = stripRows.findIndex(r => r.key === selectedStrip.key);
      // The opened ticket's bracket focus applies on its own leg only; another
      // leg shows its own fill and working levels.
      return chartTicketsAtEdge(
        ownStripTickets,
        edgeIndex,
        chartIsOwnLeg ? chartBracketFocus ?? ticket : null,
      );
    }
    // The opened order's levels belong on its own leg's chart only: on
    // another leg's forward they were drawn at that order's own forward.
    return structure !== 'strip' || chartIsOwnLeg
      ? [ticket, siblingOrder].filter(hasLevel)
      : [];
  }, [
    structure,
    selectedStrip,
    stripRows,
    ownStripTickets,
    ticket,
    siblingOrder,
    chartBracketFocus,
    chartIsOwnLeg,
  ]);
  const tapeOrderLevels = useMemo(() => {
    // A wick can touch a level line without meaning anything — the high is
    // ask, the low is bid, and only one of those sides is what this specific
    // order actually fills against. Rather than make the desk read that off
    // the drawing, run the exact same check the live matcher runs
    // (restingOrderTriggersAt) against the current quote, per level, and
    // label the answer directly — a level either says HIT or it doesn't,
    // no wick-reading required.
    const bracketRoleForLevel = (role: 'TP' | 'SL' | 'LIMIT'): string | null =>
      role === 'TP' ? 'takeProfit' : role === 'SL' ? 'stopLoss' : null;
    // Typed bracket levels are spot (the strip's brackets are spot-referenced).
    // On a forward leg's chart they sit at spot plus that leg's points: the
    // opened bracket's own stamped points, else the selected row's live points
    // while drafting.
    const previewLevelShift = (() => {
      const own = spotReferencedLegShift(ticket);
      if (own != null) return own;
      const q = selectedStrip
        ? stripQuotes.find(x => x.key === selectedStrip.key)
        : undefined;
      return q?.points != null && Number.isFinite(q.points)
        ? swapPointsToPriceDelta(q.points, ticket.ccy)
        : 0;
    })();
    const build = (spotView: boolean) => tapeOrderLevelsForChart({
      placed: chartLevelTickets,
      side,
      // Typed bracket levels while drafting / working — do not wait for a pad
      // arm (`workingHit`) or a fill. Placed tickets still win inside
      // tapeOrderLevels when chartLevelTickets already has a resting TP/SL.
      // They belong to the opened ticket's own leg only: on another leg's
      // chart they drew L2's spot TP/SL over L1's forward candles.
      // Never while merely VIEWING an order: limit mode starts on for a panel
      // opened on a working order, and its pads hold leftover rates.
      //
      // "Own leg" is the leg of the order being COMPOSED, which the chart is
      // on: the selected leg an order is being left on, or the whole strip /
      // bullet when no leg is selected. Keying it on the ticket the panel
      // opened on alone hid the live TP / SL lines for every new order left
      // after the first, since the panel then sits read-only on that order.
      previewRates:
        limitMode
        && !viewingOrder
        && (chartIsOwnLeg
          || (hitTarget?.kind === 'leg' && hitTarget.key === selectedLegKey)
          || (hitTarget?.kind === 'main' && selectedLegKey == null))
          ? orderRates
          : null,
      previewShift: spotView ? 0 : previewLevelShift,
      stickyFills,
      chartIsSpot: spotView,
    }).map(level => {
      const price = level.price;
      const sourceTicket = level.filled
        ? undefined
        : chartLevelTickets.find(
            t =>
              t.bracketRole === bracketRoleForLevel(level.role)
              && t.limitRate != null
              && Math.abs(t.limitRate - (level.spotLimitRate ?? price)) < 1e-9,
          );
      // Test the order against the tape it triggers on. `liveTape` is this
      // panel's own instrument, so on a forward leg it sits a points-shift
      // above a spot-referenced level and crossed every one of them at once.
      // Any order on the spot tape (spot-referenced, or a plain spot order)
      // is tested against live spot, whatever tenor the tile is on.
      const hitQuote =
        sourceTicket != null && tapeInstrument(sourceTicket) === 'spot'
          ? liveSpot
          : liveTape;
      const hitBid = hitQuote?.bid ?? null;
      const hitAsk = hitQuote?.ask ?? null;
      const isHit =
        !level.filled
        && !level.cancelled
        && sourceTicket != null
        && hitBid != null
        && hitAsk != null
        && hitBid > 0
        && hitAsk > 0
        && restingOrderTriggersAt(
          { ...sourceTicket, status: 'scheduled' },
          { bid: hitBid, ask: hitAsk },
        );
      // Resting TP emerald / SL rose. Actually hit right now → bright red,
      // unmissable and distinct from "filled" yellow (frozen past execution).
      // After either fills → yellow at the frozen execution print. A
      // cancelled OCO sibling never executed and never triggers — grey, so
      // the desk can still see where it was resting without reading it as
      // live or filled.
      // A level being composed is drawn exactly as the order will be once
      // placed — same colour, same title — so the line does not change
      // appearance at the moment of submission.
      const color =
        level.cancelled
          ? '#64748b'
          : isHit
            ? '#ef4444'
            : level.filled
              ? '#facc15'
              : level.role === 'TP'
                ? '#34d399'
                : level.role === 'SL'
                  ? '#fb7185'
                  : '#facc15';
      return {
        price,
        // LWC 5.2: axisLabelVisible:false early-returns and hides the pane
        // title too — that wiped resting TP/SL badges after the dedupe pass.
        // Keep the axis rate ONCE; put only the role (and HIT/CANCELLED) in
        // title so "TP 1.16312" + bare "1.16312" never sit side by side.
        title: `${level.role}${level.cancelled ? ' · CANCELLED' : isHit ? ' · HIT' : ''}`,
        color,
        axisLabelVisible: true,
        role: level.role,
      };
    });
    return build(chartIsSpot);
  }, [
    chartLevelTickets,
    side,
    limitMode,
    orderRates,
    stickyFills,
    liveTape,
    liveSpot,
    chartIsSpot,
    chartIsOwnLeg,
    viewingOrder,
    hitTarget,
    selectedLegKey,
    ticket,
    selectedStrip,
    stripQuotes,
  ]);
  const tapeFills = useMemo((): DeskTapeFill[] => {
    const toMark = (
      t: number | null | undefined,
      px: number | null | undefined,
      side: HitSide | null | undefined,
      leg: string | null,
      clock: string | null,
      // Role of the ticket that PRODUCED this fill — a strip peer's own
      // bracketRole, not the panel ticket's, or a leg-3 stop fill was
      // captioned FILL · TP off the draft leg.
      role: 'TP' | 'SL' | 'LIMIT' | null = fillRole,
      // The order's OWN direction — a sell take-profit fills on the ask
      // (2026-09-08 flip), so `side` (the executed quote side) no longer
      // implies buy/sell and must not decide the glyph.
      dir: 'buy' | 'sell' | null = null,
      // The spot print behind `px` when `px` is a spot-referenced order's
      // booked forward. A spot-convention chart pins at this instead, rather
      // than discarding the pin as a convention break.
      spotPx: number | null = null,
    ): DeskTapeFill[] => {
      if (t == null || !(t > 0) || !Number.isFinite(t)) return [];
      if (px == null || !(px > 0) || !Number.isFinite(px)) return [];
      if (
        !isCurrentOverlayTapeFill(t, {
          bookSession,
          overlayOpenedAtMs,
          trailStartMs: tapeTrail[0]?.t,
        })
      ) {
        return [];
      }
      // The caption states the rate the pin is drawn at, so a chart that
      // moves the pin to the spot print must move the caption with it.
      const captionAt = (rate: number) => [
        'FILL',
        role,
        side?.toUpperCase(),
        leg,
        clock ?? formatFillClock(t),
        fmtPx(rate),
      ].filter(Boolean).join(' · ');
      const onSpot = spotPx != null && spotPx > 0 && Number.isFinite(spotPx);
      return [{
        t,
        px,
        side: side ?? undefined,
        dir: dir ?? undefined,
        clock: clock ?? formatFillClock(t),
        role: role ?? undefined,
        ...(onSpot ? { spotPx, spotText: captionAt(spotPx) } : {}),
        text: captionAt(px),
      }];
    };

    // Strip: one pin for the priced-leg row that is on. No row selected
    // (spot pad default) → no pin. Never pile L1–L12. Unfilled selected →
    // no pin.
    // Bracket tickets must not inherit the cover's FILL · LIMIT · BID arrow
    // (fillTicketAtEdge) — that painted a sell triangle under a resting TP.
    if (structure === 'strip' && stripRows.length > 0) {
      const row = selectedStrip;
      if (!row) return [];
      const edgeIndex = stripRows.findIndex(r => r.key === row.key);
      // chartBracketFocus narrows only the role — graft it onto the ticket's
      // own identity fields so fillTicketAtEdge sees a complete focus.
      // The opened ticket's bracket focus applies on its own leg only: at
      // another leg's edge it found no bracket and returned nothing, hiding
      // that leg's own market fill pin.
      const focus = !chartIsOwnLeg
        ? { ...ticket, bracketRole: undefined }
        : chartBracketFocus
          ? { ...ticket, bracketRole: chartBracketFocus.bracketRole }
          : ticket;
      const peer = fillTicketAtEdge(ownStripTickets, edgeIndex, focus);
      // Cover-scoped execReport fills only apply when we are not focused on a
      // still-unfilled bracket — otherwise a strip confirm report resurrects
      // the cover print as a fake TP fill.
      const bracketFocus =
        focus.bracketRole === 'takeProfit' || focus.bracketRole === 'stopLoss';
      const execFill =
        !bracketFocus || peer != null
          ? execReport?.fills.find(f => f.key === row.key)
          : undefined;
      if (peer == null && execFill == null) return [];
      const stickyPeerPx = peer != null ? stickyFills[peer.id] : undefined;
      // The pin lives in the CHART's coordinate space. A spot-identity
      // chart plots a forward peer's fill at its SPOT stamp — its outright
      // sits a whole points-shift off the drawn series and floated below
      // every candle. A bracket's identity is its own instrument; any
      // other chart's identity is the SELECTED tile (a strip opens on the
      // spot tile while its legs fill at outrights).
      const peerFillPx =
        peer == null
          ? null
          : chartIsSpot && (peer.instrument ?? 'spot') !== 'spot'
            ? peer.ipaQuote?.fxSpot ?? peer.ipaQuote?.fxOutright
            : peer.ipaQuote?.fxOutright;
      // A spot-referenced peer's frozen print is its SPOT execution — on a
      // forward chart it pins at its booked forward (peerFillPx) instead.
      const px =
        (stickyPeerPx != null
          && stickyPeerPx > 0
          && !chartIsSpot
          && !peer?.isSpotReferenced
          ? stickyPeerPx
          : null)
        ?? peerFillPx
        ?? (peer != null ? peer.limitRate : null)
        ?? execFill?.rate
        ?? null;
      const t =
        peer?.filledAtMs != null && Number.isFinite(peer.filledAtMs) && peer.filledAtMs > 0
          ? peer.filledAtMs
          : peer == null
            && execFill != null
            && execReport?.atMs != null
            && execReport.atMs > 0
            ? execReport.atMs
            : null;
      // Marker side is the EXECUTED side, not the typed tile — orderHit is
      // the tile and for a bracket leg sits on the other side of the spread.
      const hit =
        peer != null
          ? restingOrderHitSide(peer)
          : execFill != null
            ? execReport?.hit ?? null
            : null;
      const clock =
        peer?.filledAtMs != null && Number.isFinite(peer.filledAtMs) && peer.filledAtMs > 0
          ? formatFillClock(peer.filledAtMs)
          : peer == null && execFill != null
            ? (execReport?.at ?? (t != null ? formatFillClock(t) : null))
            : t != null
              ? formatFillClock(t)
              : null;
      // A MARKET execution has no resting level, so its role is null — that
      // is what routes it to the yellow MARKET price-axis tag
      // (marketFillLevels filters on role == null). Calling every
      // non-bracket peer LIMIT left a live-executed leg with no tag at
      // all: excluded from marketFillLevels, and invisible to
      // tapeOrderLevels, which only draws tickets that carry a limitRate.
      const peerRole =
        peer?.bracketRole === 'takeProfit'
          ? ('TP' as const)
          : peer?.bracketRole === 'stopLoss'
            ? ('SL' as const)
            : peer?.limitRate != null && peer.limitRate > 0
              ? ('LIMIT' as const)
              : null;
      // amountLocalM >= 0 sells the FCY (the sellsFcy convention used by
      // restingOrderTriggersAt/restingOrderHitSide) — the same rule, applied
      // to whichever ticket actually produced this fill.
      const peerDir: 'buy' | 'sell' =
        peer != null
          ? (peer.amountLocalM >= 0 ? 'sell' : 'buy')
          : side === 'Sell' ? 'sell' : 'buy';
      // On a forward leg `px` is the booked forward. Carry the spot print so
      // the Day record can pin the same execution on its own series.
      // ANY forward leg's `px` is its booked outright — left on the spot
      // tile or clicked at market. A market-clicked leg carried no spot
      // print, so the Day record pinned it (and tagged its MARKET line) a
      // whole points-shift above every spot candle, inside the 40-pip band
      // the continuity filter trusts.
      const peerSpotPx =
        peer != null && (peer.instrument ?? 'spot') !== 'spot'
          ? peer.ipaQuote?.fxSpot ?? null
          : null;
      return toMark(t, px, hit, row.label, clock, peerRole, peerDir, peerSpotPx);
    }

    if (fillAtMs == null || !(fillAtMs > 0)) return [];
    const hit = executedHit ?? execReport?.hit ?? null;
    const clock = fillAt ?? formatFillClock(fillAtMs);
    const ticketDir: 'buy' | 'sell' = ticket.amountLocalM >= 0 ? 'sell' : 'buy';
    if (execReport != null && execReport.fills.length > 0) {
      const fill = execReport.fills.find(
        f => f.rate != null && Number.isFinite(f.rate) && f.rate > 0,
      );
      return toMark(
        fillAtMs,
        fill?.rate,
        hit,
        execReport.scope === 'leg' ? (fill?.label ?? null) : null,
        clock,
        fillRole,
        ticketDir,
      );
    }
    return toMark(fillAtMs, fillPx, hit, null, clock, fillRole, ticketDir);
  }, [
    structure,
    stripRows,
    selectedStrip,
    ticket,
    chartBracketFocus,
    fillAtMs,
    fillAt,
    fillPx,
    fillRole,
    executedHit,
    execReport,
    ownStripTickets,
    bookSession,
    overlayOpenedAtMs,
    tapeTrail,
    stickyFills,
    chartIsSpot,
    side,
  ]);
  /**
   * "Order placed" pin — sticky leave stamp when the desk just SUBMIT'd
   * (including Book compose, where `trail[0]` is overlay-open not leave),
   * else the leg's recorded trail head for blotter reopen. Survives the
   * sticky-fill freeze that clears trail `marker` flags.
   */
  const placedMark = useMemo((): DeskTapeFill | null => {
    const fromSticky =
      stickyPlaced != null
      && stickyPlaced.t > 0
      && stickyPlaced.px > 0
        ? stickyPlaced
        : null;
    let mark = fromSticky;
    if (mark == null) {
      const src =
        (structure === 'strip'
          ? chartLevelTickets[0]
          : ticket.limitRate != null
            ? ticket
            : siblingOrder) ?? null;
      if (src == null) return null;
      if (src.restingAnchorRate == null && src.limitRate == null) return null;
      // Fresh Book draft has no resting level — do not pin overlay-open as PLACED.
      mark = placementMarkFromTrail(
        { restingAnchorRate: chartPlacementAnchor(src) },
        tapeTrail,
        ticketPlacedAtMs(src.id),
      );
    }
    if (mark == null) return null;
    // Sticky leave in this overlay is always current. Trail-head pins still
    // respect the Book-session guard so a prior blotter fill does not pin.
    if (
      fromSticky == null
      && !isCurrentOverlayTapeFill(mark.t, {
        bookSession,
        overlayOpenedAtMs,
        trailStartMs: tapeTrail[0]?.t,
      })
    ) {
      return null;
    }
    return {
      t: mark.t,
      px: mark.px,
      text: `PLACED · ${fmtPx(mark.px)}`,
      clock: formatFillClock(mark.t),
      kind: 'placed',
    };
  }, [
    stickyPlaced,
    structure,
    chartLevelTickets,
    ticket,
    siblingOrder,
    tapeTrail,
    bookSession,
    overlayOpenedAtMs,
    chartIsSpot,
  ]);
  const changeMarks = useMemo((): DeskTapeFill[] => {
    return stickyChanges
      .filter(m => m.t > 0 && m.px > 0)
      .map(m => ({
        t: m.t,
        px: m.px,
        text: `CHANGE · ${fmtPx(m.px)}`,
        clock: formatFillClock(m.t),
        kind: 'change' as const,
      }));
  }, [stickyChanges]);
  const chartTapeFills = [
    ...tapeFills,
    ...(placedMark ? [placedMark] : []),
    ...changeMarks,
  ];
  // A market execution (no bracketRole — not a TP/SL) has no resting level,
  // so it never appears in tapeOrderLevels, and the Y-axis price tag that
  // marks TP/SL only ever tagged those two. Every actual fill still needs
  // one: the price-axis label, same family as TP/SL, distinct yellow so a
  // desk scanning the right edge sees exactly what filled and at what rate.
  const marketFillLevels = chartTapeFills
    .filter(f => f.kind !== 'placed' && f.kind !== 'change' && f.role == null)
    .map(f => ({
      price: f.px,
      title: `MARKET ${fmtPx(f.px)}`,
      color: '#facc15',
    }));
  // ── Missing-history fallback ──────────────────────────────────────────
  // A ticket that has a working level or a past execution must never render
  // a near-empty tape that looks like market data. Until its recorded
  // history is on the trail, the Tape view shows today's spot record instead
  // (real data, the order's levels drawn, spot pins only) with a notice
  // saying whether the tape is still loading or did not load — a chart at
  // once, never a blank plot rebuilding from t=0 and never a withheld one
  // (desk instruction, 2026-09-08). The Tape takes over by itself the moment
  // the history lands. A fresh compose (no level, no fill) is the one
  // legitimate empty start.
  // Options never get a tape: the matcher only walks spot/forward keys, so
  // an option leg's history is permanently "missing". The strip-open default
  // forces the UI's `instrument` state to 'spot' for display even on an
  // option leg, so that state can't be used here — check the ticket's own
  // real instrument instead.
  const expectsRecordedHistory =
    ticket.instrument !== 'option'
    && ((ticket.limitRate != null && ticket.limitRate > 0)
      || ticket.filledAtMs != null
      || ticket.status === 'booked');
  const tapeHistoryMissing = expectsRecordedHistory && tapeTrail.length === 0;
  // The series the chart draws: the trail plus each drawn fill's executed
  // print at its own time, so the bar over that moment contains it. Without
  // it a fill older than the in-memory tape was pinned onto the first bar,
  // which never reached the level it filled at.
  const tapeForChart = withFillPrints(
    tapeTrail,
    chartTapeFills.filter(f => f.kind !== 'placed' && f.kind !== 'change'),
  );
  // Default Rate: the side that triggers what this chart shows. An order
  // drawn here triggers on the side the matcher watches (a sell take-profit
  // on the ask, a sell stop on the bid); the one that executed wins, then a
  // working take-profit (an OCO's), then any. With no order, the side a
  // market fill of the trade takes: selling hits the bid, buying the ask.
  const defaultCandleSide: TapeCandleSide = (() => {
    const orders = chartLevelTickets.filter(t => t.limitRate != null && t.status !== 'cancelled');
    const order =
      orders.find(isMarketExecutedHedgeTicket)
      ?? orders.find(t => t.bracketRole === 'takeProfit')
      ?? orders[0];
    if (order) return restingOrderHitSide(order);
    // A market fill took the side it was clicked on.
    if (isMarketExecutedHedgeTicket(fillTicket) && fillTicket.orderHit) {
      return fillTicket.orderHit;
    }
    return side === 'Sell' ? 'bid' : 'ask';
  })();
  const candleSide: TapeCandleSide =
    candleSideChoice?.key === tapeIdentity ? candleSideChoice.side : defaultCandleSide;
  const tapePlot = (plotH?: number, notice?: string) => (
    <div className="flex h-full min-h-0 flex-col">
      {notice ? (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
          {notice}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <OptionSkewPayoutChart
          skew={null}
          payout={null}
          tape={tapeForChart}
          liveBid={tapeTrailIdentity === tapeIdentity ? chartBid : null}
          liveAsk={tapeTrailIdentity === tapeIdentity ? chartAsk : null}
          pair={pairSlash(pair)}
          tenorLabel={ratesTenorNote}
          mode="rates"
          framed={false}
          fillParent={plotH == null}
          plotHeight={
            plotH != null
              ? Math.max(200, plotH - (notice ? TAPE_NOTICE_H : 0))
              : undefined
          }
          orderLevels={[...tapeOrderLevels, ...marketFillLevels]}
          tapeFills={
            (structure === 'strip' && stripRows.length > 0) || chartTapeFills.length > 0
              ? chartTapeFills
              : undefined
          }
          markerText={
            (chartTapeFills.find(
              f => f.kind !== 'placed' && f.kind !== 'change',
            ) ?? chartTapeFills[0])?.text
          }
          // The Period window is part of the series identity: each window is
          // a new series to the chart, which then fits it whole instead of
          // right-anchoring the last few minutes of an order story.
          seriesKey={`${tapeTrailIdentity}|${tapeLookback}`}
          tapeFitToWindow={tapeLookback !== 'order'}
          lookback={tapeLookback}
          onLookbackChange={setTapeLookback}
          candleSide={candleSide}
          onCandleSideChange={next => setCandleSideChoice({ key: tapeIdentity, side: next })}
        />
      </div>
    </div>
  );

  const ratesPlot = (plotH?: number) => {
    // Path is the cash settlement path plan, never the price tape. It used
    // to sit behind a "live quote present" check that always won, which left
    // the view unreachable and its button a second Tape.
    if (ratesChartView === 'path') {
      // Fullscreen already mounts pathChart — keep a single instance so
      // tick-trades do not portal twice into Structure.
      if (ratesFullScreen && plotH == null) return null;
      return (
        pathChart ?? (
          <p className="rounded-md border border-dashed border-slate-800 px-2 py-6 text-center text-[10px] text-slate-500">
            Exposure path needs the Hedging Decision book for this
            CCY.
          </p>
        )
      );
    }
    // Missing recorded history is a notice on the Tape, never a different
    // chart: the trail builds from live prints, and a From window brings in
    // the day record — a chart at once, and always in one convention.
    return tapePlot(
      plotH,
      tapeHistoryMissing
        ? tapeHistoryLoading
          ? `Loading this ${ticket.ccy} order's recorded tape…`
          : `Recorded tape for this ${ticket.ccy} order did not load — the chart builds from live prints${
              tapeLookback === 'order' ? '; pick a Period window to load the day record' : ' and the day record'
            }.`
        : undefined,
    );
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-stretch justify-center overflow-hidden bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trade-ticket-title"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-4 text-slate-100 shadow-2xl">
        <div className="shrink-0 -mx-4 -mt-4 border-b border-slate-800/80 bg-slate-900 px-4 pb-3 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="trade-ticket-title" className="inline-flex items-center gap-1.5 text-sm font-semibold text-white">
              <DeskIcon name="action-book" className="h-4 w-4 text-slate-400" />
              Book · {ticket.ccy} · {pair}
            </h4>
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-200">
              Approved
            </span>
            <button
              type="button"
              onClick={onClose}
              title={fillDone ? 'Close ticket' : 'Cancel ticket'}
              aria-label={fillDone ? 'Close ticket' : 'Cancel ticket'}
              className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-slate-600 text-slate-300 hover:bg-slate-800"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            Left: approved booking parameters. Right: click Bid/Ask to select
            the order; Submit executes or leaves it working. Main tile fills
            every strip leg; Submit on a row fills that leg only. Esc exits
            ready. Desk blend, not IPA. Size starts from Hedge add %
            on {activeBasisLabel} · {varSetup.confidencePct}% ·{' '}
            {varSetup.horizon}.
          </p>
        </div>

        {/* Below lg this stacks to one column, so the two <section>s need
            TWO row tracks — one declared row plus an implicit `auto` one
            made the explicit track a minmax(0,1fr) competing for space
            against the second section's content height, and 1fr can shrink
            to 0: the left "Approved booking" panel collapsed toward
            nothing while "Live rate" (auto, sized to its own content) took
            the space. Two even tracks below lg, collapsing to the single
            row once lg:grid-cols-2 puts both sections side by side. */}
        <div className="mt-4 grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-2">
          <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-950/40 p-3">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
              1 · Approved booking
            </div>
            <div className="mt-3 shrink-0 space-y-1.5">
              {isStructureSelectionOpen ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                      Structure
                    </div>
                    {structurePreconfigured && (
                      <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                        Preconfigured · {preconfiguredStructure}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Tile
                      icon="instr-bullet"
                      label="Bullet"
                      hint={
                        liveBulletPkg?.settleMonths != null
                          ? `M${Math.round(liveBulletPkg.settleMonths)}`
                          : 'One tenor'
                      }
                      on={structure === 'bullet'}
                      disabled={freezeInputs}
                      onClick={() => applyStructure('bullet')}
                    />
                    <Tile
                      icon="instr-strip"
                      label="Strip"
                      hint={
                        liveStripPkg && liveStripPkg.legs.length > 0
                          ? `${liveStripPkg.legs.length} staged`
                          : 'Needs staged legs'
                      }
                      on={structure === 'strip'}
                      disabled={freezeInputs}
                      title={
                        stripStarted && structure !== 'strip'
                          ? 'Return to the frozen ladder — remaining clip can still trade as Bullet / Spot / FWD / Option'
                          : undefined
                      }
                      onClick={() => applyStructure('strip')}
                    />
                  </div>
                  <div>
                    <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                      Instrument
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {BOOK_INSTRUMENTS.map(opt => {
                        const isOn =
                          opt.id === 'swap'
                            ? deskSwap
                            : opt.id === 'forward'
                              ? instrument === 'forward' && !deskSwap
                              : instrument === opt.id;
                        return (
                          <Tile
                            key={opt.id}
                            icon={opt.icon}
                            label={opt.label}
                            hint={opt.hint}
                            on={isOn}
                            soon={opt.soon}
                            disabled={freezeInputs}
                            title={
                              opt.id === 'spot' && structure === 'strip'
                                ? 'Keep the strip — Bid/Ask switches to live spot'
                                : undefined
                            }
                            onClick={() => {
                              if (freezeInputs || opt.soon) return;
                              if (opt.id === 'swap') {
                                setDeskSwap(true);
                                applyInstrument('forward');
                                return;
                              }
                              setDeskSwap(false);
                              applyInstrument(opt.id);
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={freezeInputs}
                    onClick={() => setIsStructureSelectionOpen(true)}
                    className="shrink-0 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-300 hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Back
                  </button>
                  <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-200">
                    {structure}
                  </span>
                  <span className="h-4 w-px bg-slate-700" aria-hidden="true" />
                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                    Contract
                  </span>
                  <div className="grid min-w-0 flex-1 grid-cols-4 gap-1">
                    {BOOK_INSTRUMENTS.map(opt => {
                      const isOn =
                        opt.id === 'swap'
                          ? deskSwap
                          : opt.id === 'forward'
                            ? instrument === 'forward' && !deskSwap
                            : instrument === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={freezeInputs || opt.soon}
                          title={
                            opt.id === 'spot' && structure === 'strip'
                              ? 'Keep the strip — Bid/Ask switches to live spot'
                              : undefined
                          }
                          onClick={() => {
                            if (freezeInputs || opt.soon) return;
                            if (opt.id === 'swap') {
                              setDeskSwap(true);
                              applyInstrument('forward');
                              return;
                            }
                            setDeskSwap(false);
                            applyInstrument(opt.id);
                          }}
                          className={`min-w-0 rounded border px-1 py-1 text-[9px] font-semibold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-40 ${
                            isOn
                              ? 'border-sky-500/50 bg-sky-500/15 text-sky-100'
                              : 'border-slate-700 bg-slate-950/60 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="shrink-0">
                <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                  View
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <Chip
                    label="Structure"
                    on={ratesLeft === 'structure'}
                    onClick={() => setRatesLeft('structure')}
                  />
                  <Chip
                    label="Chart"
                    on={ratesLeft === 'chart'}
                    onClick={() => setRatesLeft('chart')}
                  />
                </div>
              </div>

              <div className="relative flex min-h-[220px] min-w-0 w-full flex-1 flex-col overflow-hidden">
                <div
                  className={bookingPaneClass(showChartBody && !optionDesk)}
                  aria-hidden={!(showChartBody && !optionDesk)}
                >
                  {/* Same fixed-height header row as the Option pane (and the
                      chart's own framed title row) — the docked view toggle
                      underneath then sits at the same y on every product. */}
                  <div className="mb-1.5 flex h-6 shrink-0 items-center justify-between gap-2">
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                      {ratesChartTitle}
                    </div>
                    <div className="truncate font-mono text-[9px] text-slate-600">
                      {pairSlash(pair)} · {ratesTenorNote}
                    </div>
                  </div>
                  <ChartViewFrame
                    value={ratesChartView}
                    onChange={setRatesChartView}
                    options={RATES_BOOK_VIEWS}
                    ariaLabel="Forward chart view"
                    overlay={false}
                    onExpand={() => setRatesFullScreen(true)}
                    className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-slate-800 bg-slate-950/80"
                  >
                    {ratesPlot()}
                  </ChartViewFrame>
                  {ratesFullScreen && typeof document !== 'undefined'
                    ? createPortal(
                        <div
                          className="fixed inset-0 z-[240] flex flex-col bg-slate-950"
                          role="dialog"
                          aria-modal="true"
                          aria-labelledby="rates-chart-full-title"
                        >
                          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
                            <div className="min-w-0">
                              <h2
                                id="rates-chart-full-title"
                                className="truncate text-sm font-medium text-slate-100"
                              >
                                {ratesChartTitle} · {pairSlash(pair)} ·{' '}
                                {ratesTenorNote}
                              </h2>
                              <p className="truncate font-mono text-[10px] text-slate-500">
                                Full screen · Esc to close
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setRatesFullScreen(false)}
                              className="rounded-md border border-slate-600 px-2.5 py-1 font-mono text-[11px] text-slate-300 hover:border-slate-400 hover:text-slate-100"
                            >
                              Close
                            </button>
                          </div>
                          <div
                            className={`min-h-0 flex-1 p-3 ${
                              ratesChartView === 'path'
                                ? 'overflow-y-auto'
                                : 'overflow-hidden'
                            }`}
                          >
                            <ChartViewFrame
                              value={ratesChartView}
                              onChange={setRatesChartView}
                              options={RATES_BOOK_VIEWS}
                              ariaLabel="Forward chart view"
                              overlay={false}
                              className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-slate-800 bg-slate-950/80"
                            >
                              {ratesPlot(ratesFullH)}
                            </ChartViewFrame>
                          </div>
                        </div>,
                        document.body,
                      )
                    : null}
                </div>

                {optionDesk ? (
                  <div
                    className={bookingPaneClass(showChartBody)}
                    aria-hidden={!showChartBody}
                  >
                    <OptionSkewPayoutChart
                      skew={optionCharts?.skew ?? null}
                      payout={optionCharts?.payout ?? null}
                      premiumSurface={optionCharts?.premiumSurface ?? null}
                      tape={optionTapeTrail}
                      liveBid={optionPremBid}
                      liveAsk={optionPremAsk}
                      pair={pairSlash(pair)}
                      strikeInput={strikeInput}
                      tenorLabel={
                        optionTenorDisplay
                        ?? tenorLabel(tenor)
                        ?? (months > 0 ? formatMarketTenor(months) : '1M')
                      }
                      mode="option"
                      fillParent
                      premiumBid={pricedBid?.quote.premiumUsd ?? null}
                      premiumAsk={pricedAsk?.quote.premiumUsd ?? null}
                      onSelectOption={applyOptionDeskPick}
                      pathChart={pathChart}
                      // BUY/SELL side toggle lives in the chart's own header
                      // row, not a stacked bar above it — both panes then have
                      // one h-6 header, and the view toggle lines up across
                      // Spot / FWD / Option.
                      headerExtra={
                        <div className="flex shrink-0 items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-wide">
                          <button
                            type="button"
                            disabled={freezeInputs}
                            aria-pressed={optionPut === optionProtectionIsPut}
                            onClick={() => applyOptionSide(optionProtectionIsPut)}
                            className={`rounded px-1.5 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                              optionPut === optionProtectionIsPut
                                ? 'bg-emerald-500/20 text-emerald-200'
                                : 'text-emerald-300 hover:bg-emerald-500/10'
                            }`}
                          >
                            {optionProtectionLabel}
                          </button>
                          <span className="text-slate-600">+</span>
                          <button
                            type="button"
                            disabled={freezeInputs}
                            aria-pressed={optionPut === optionFinancingIsPut}
                            onClick={() => applyOptionSide(optionFinancingIsPut)}
                            className={`rounded px-1.5 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                              optionPut === optionFinancingIsPut
                                ? 'bg-rose-500/20 text-rose-200'
                                : 'text-rose-300 hover:bg-rose-500/10'
                            }`}
                          >
                            {optionFinancingLabel}
                          </button>
                        </div>
                      }
                      seriesKey={`option-prem|${tapeLookback}`}
                      tapeFitToWindow={tapeLookback !== 'order'}
                      lookback={tapeLookback}
                      onLookbackChange={setTapeLookback}
                    />
                  </div>
                ) : null}

                <div
                  className={`${bookingPaneClass(showStructureBody)} overflow-y-auto`}
                  aria-hidden={!showStructureBody}
                >
                  {stripChoices.length > 0 ? (
                  <div>
                      <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                        Strip · choose ladder
                      </div>
                      <div className="overflow-x-auto rounded-md border border-slate-800">
                        <table className="w-full min-w-[420px] text-left text-[10px]">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="px-1.5 py-1 font-medium">Rank</th>
                              <th className="px-1.5 py-1 font-medium">Struct</th>
                              <th className="px-1.5 py-1 font-medium">CoM</th>
                              <th className="px-1.5 py-1 font-medium">Kurt</th>
                              <th className="px-1.5 py-1 font-medium">Schedule</th>
                              <th className="px-1.5 py-1 text-right font-medium">
                                Carry
                              </th>
                              <th className="px-1.5 py-1 text-right font-medium text-emerald-200/80">
                                Enh
                              </th>
                              <th className="px-1.5 py-1 text-right font-medium text-sky-200/80">
                                vs bullet
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {stripChoices.map((c, i) => {
                              const on = choiceIdx === i;
                              const totalCarry = c.newCarryUsdM + c.fwdCarryUsdM;
                              return (
                                <tr
                                  key={`choice-${i}-${c.settleScheduleLabel}`}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => {
                                    if (!freezeInputs && !stripStarted) applyStripChoice(i);
                                  }}
                                  onKeyDown={ev => {
                                    if (freezeInputs || stripStarted) return;
                                    if (ev.key === 'Enter' || ev.key === ' ') {
                                      ev.preventDefault();
                                      applyStripChoice(i);
                                    }
                                  }}
                                  className={`border-t border-slate-800/80 font-mono text-slate-300 ${
                                    freezeInputs || stripStarted
                                      ? 'cursor-not-allowed opacity-50'
                                      : 'cursor-pointer hover:bg-slate-800/50'
                                  } ${on ? 'bg-sky-500/15' : ''}`}
                                >
                                  <td className="px-1.5 py-1.5 text-slate-500">
                                    {i + 1}
                                  </td>
                                  <td className="px-1.5 py-1.5 text-violet-300/90">
                                    {c.structure === 'bullet'
                                      ? 'bullet'
                                      : `strip · ${c.legCount}`}
                                  </td>
                                  <td className="px-1.5 py-1.5 text-amber-200/90">
                                    {c.structure === 'bullet'
                                      ? '—'
                                      : `${(c.centerOfMass * 100).toFixed(0)}%`}
                                  </td>
                                  <td className="px-1.5 py-1.5 text-sky-200/90">
                                    {c.structure === 'bullet'
                                      ? '—'
                                      : c.kurtosis.toFixed(1)}
                                  </td>
                                  <td className="px-1.5 py-1.5 text-slate-400">
                                    {c.settleScheduleLabel}
                                  </td>
                                  <td
                                    className={`px-1.5 py-1.5 text-right font-semibold ${
                                      totalCarry >= 0
                                        ? 'text-slate-100'
                                        : 'text-rose-300'
                                    }`}
                                  >
                                    {fmtCarryK(totalCarry)}
                                  </td>
                                  <td className="px-1.5 py-1.5 text-right text-emerald-300">
                                    {fmtCarryK(c.enhancementUsdM)}
                                  </td>
                                  <td className="px-1.5 py-1.5 text-right text-sky-300">
                                    {fmtCarryK(c.vsBulletUsdM)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  {pathExposure ? (
                    <>
                      {/* This always-mounted hidden copy is the ONE instance
                          that portals the tick-trades table into the host —
                          the visible Chart/Option copies have the portal off,
                          so the card never duplicates. */}
                      <div className="hidden" aria-hidden="true">
                        {pathChart != null
                          ? cloneElement(pathChart, {
                              tickTradesPortalEnabled: true,
                            })
                          : null}
                      </div>
                      <div ref={setTickTradesHost} />
                    </>
                  ) : stripRows.length > 0 ? (
                    <p className="rounded-md border border-dashed border-slate-800 px-2 py-3 text-[10px] text-slate-500">
                      Tick trades need the Hedging Decision path for this CCY.
                    </p>
                  ) : stripChoices.length === 0 ? (
                    <p className="rounded-md border border-dashed border-slate-800 px-2 py-3 text-[10px] text-slate-500">
                      {structure === 'strip'
                        ? 'No strip legs on this ticket. Stage a strip from Cash Carry or Hedging Decision, then it prices here.'
                        : 'Bullet settle is on the Chart tab. Stage a strip from Cash Carry or Hedging Decision for a ladder here.'}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="flex h-full min-h-0 flex-col overflow-y-auto rounded-lg border border-slate-700 bg-slate-950/40 p-3">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
              2 · Live rate · click & trade
            </div>

            <ClickTradeTile
              pair={pair}
              baseCcy={baseCcy}
              bankBid={tileBankBid}
              bankAsk={tileBankAsk}
              instrument={instrument}
              tenor={tenor}
              referenceLabel={
                limitOrderOnSpot
                  ? 'spot'
                  : overlayTapeConventionLabel({
                      instrument,
                      maturityMonths: months,
                      maturity: tenor,
                      maturityLabel: ticket.maturityLabel,
                    })
              }
              bid={limitOrderOnSpot ? bracketRefBid : selectedPadBid}
              ask={limitOrderOnSpot ? bracketRefAsk : selectedPadAsk}
              mid={selectedPadMid}
              premiumBid={
                instrument === 'option'
                  ? structure === 'strip' && stripRows.length > 0
                    ? stripPremiumTot.bid
                    : pricedBid?.quote.premiumUsd ?? null
                  : null
              }
              premiumAsk={
                instrument === 'option'
                  ? structure === 'strip' && stripRows.length > 0
                    ? stripPremiumTot.ask
                    : pricedAsk?.quote.premiumUsd ?? null
                  : null
              }
              optionQuoteBid={optionQuoteBid}
              optionQuoteAsk={optionQuoteAsk}
              sizeM={sizeM}
              onSizeM={n => {
                if (!freezeInputs) setSizeM(n);
              }}
              strikeInput={strikeInput}
              onStrikeInput={v => {
                if (!freezeInputs) setStrikeInput(v);
              }}
              armed={mainArmed}
              submittedHit={submittedHit}
              confirmedSides={
                // Live pads (legs still to trade) quote the market, like a
                // fresh Book open: the ticket that OPENED the panel must not
                // paint them. Opened from a filled OCO take-profit, both pads
                // read "confirmed" and sat rose/emerald — the armed side then
                // went orange beside a green pad nobody had touched.
                stripPadLive
                  ? []
                  : restFilled && (limitOrderType === 'oco' || Boolean(ticket.ocoGroupId))
                    ? (['bid', 'ask'] as const)
                    : restingSides
              }
              onSubmitLimitOrder={submitLimitOrder}
              bracketRoleForHit={bracketRoleForHit}
              restsAwayFromMarket={restsAwayFromMarket}
              limitMode={
                stripPadLive ? limitMode : Boolean(limitMode || selectedLegLimitOrder)
              }
              referenceStopLoss={referenceStopLoss}
              onReferenceStopLossChange={(hit, enabled) => {
                setReferenceStopLoss(enabled);
                if (enabled) {
                  const reference = hit === 'bid' ? bracketRefBid : bracketRefAsk;
                  if (reference != null) {
                    const value = fmtPx(reference);
                    setOrderRates(prev => ({ ...prev, [hit]: value }));
                    if (workingHit === hit) setOrderRate(value);
                  }
                }
              }}
              orderPanelFor={hit => {
                const takeProfitHit = limitTakeProfitHit(side);
                const padTicket = selectedPadTicketForHit(hit);
                // Viewing an order: a pad with no order of its own has no
                // parameters to show.
                if (viewingOrder && padTicket == null) return null;
                const padRole = padTicket?.bracketRole ?? null;
                // Status/Fill/Executed must read the PAD'S OWN ticket, never
                // the outer fillRole/fillPx/fillAt — those are bound to this
                // component's single main `ticket` prop, so a TP focus and
                // an SL pad rendered side by side both showed the TP's fill
                // under a "Stop Loss" title.
                //
                // Do NOT reintroduce a `filledHit === hit` fallback for a pad
                // that resolves no ticket. It looks safe — it is the same gate
                // the badge uses — but `filledHit` is derived from
                // `fillTicket`, which is not this pad's order: it reproduced
                // exactly the failure above, printing a non-bracket LIMIT
                // ticket's 1.15318 / 23:36:37 on the SL pad while the TP pad
                // showed the same print from its own ticket. A pad with no
                // ticket has nothing of its own to show; the '—' is correct.
                const padFillRole: 'TP' | 'SL' | null =
                  padTicket?.bracketRole === 'stopLoss'
                    ? 'SL'
                    : padTicket?.bracketRole === 'takeProfit'
                      ? 'TP'
                      : null;
                // Gate on `fillTicket`, NOT on `ticket`. The outer `fillPx` /
                // `fillAt` describe `fillTicket`, and at a strip edge that
                // resolves the COVER leg first (`cover.filled` wins), which
                // is not this pad's bracket. Keying on `ticket` handed the
                // cover's rate and clock to a bracket pad whenever the panel
                // happened to be focused on that bracket — the take-profit
                // printed the M3 cover's outright 1.15318 as its own "Spot
                // fill", 40.4 pips off its real spot execution, while its
                // "Booked FWD" read correctly off its own quote. The two
                // then differed by 15.4 pips where that leg's points are
                // 55.83. Use the outer values only for the ticket they were
                // computed from; every other pad derives from its own.
                const padFillPx: number | null =
                  padTicket == null
                    ? null
                    : padTicket === fillTicket
                      ? fillPx
                      : executionFillRate(padTicket)
                        ?? (padTicket.limitRate != null && padTicket.limitRate > 0
                          ? padTicket.limitRate
                          : null);
                const padFillAt: string | null =
                  padTicket == null
                    ? null
                    : padTicket === fillTicket
                      ? fillAt
                      : padTicket.filledAtMs != null
                          && Number.isFinite(padTicket.filledAtMs)
                        ? formatFillClock(padTicket.filledAtMs)
                        : null;
                const padRestFilled = padTicket?.status === 'booked';
                // The sibling's OWN status — not inferred from the filled
                // leg, which printed "Cancelled · OCO" on the other pad even
                // when nothing rested there or the sibling expired rather
                // than cancelled.
                const cancelledSibling =
                  restFilled && hit === siblingHit && siblingOrder?.status === 'cancelled';
                const statusValue = padRestFilled
                  ? padFillRole === 'SL'
                    ? 'Filled · SL'
                    : padFillRole === 'TP'
                      ? 'Filled · TP'
                      : 'Filled'
                  : cancelledSibling
                    ? 'Cancelled · OCO'
                    : null;
                const fillValue =
                  padRestFilled && padFillPx != null ? fmtPx(padFillPx) : null;
                const bookedFwd =
                  padRestFilled
                  && padTicket?.isSpotReferenced
                  && padTicket.ipaQuote?.fxOutright != null
                    ? `${padTicket.maturityLabel ?? '—'} @ ${fmtPx(padTicket.ipaQuote.fxOutright)}`
                    : null;
                const executedAt = padRestFilled && padFillAt ? padFillAt : null;
                const limitValue = fmtPx(
                  levelInCardConvention(
                    padTicket,
                    (viewingOrder ? padTicket?.limitRate : undefined)
                    || Number(orderRates[hit])
                    || (hit === ticket.orderHit ? ticket.limitRate : undefined)
                    || (hit === siblingHit ? siblingOrder?.limitRate : undefined),
                  ) ?? undefined,
                );
                const rows: [string, string][] = [
                  ['Side', `${side} ${baseCcy}`],
                  // An order's own size; the tile's size is what is left to
                  // trade, which reads 0 once nothing is.
                  [
                    'Notional',
                    `${fmtUnits(
                      viewingOrder && padTicket != null
                        ? Math.abs(padTicket.amountLocalM)
                        : sizeM,
                    )} ${ticket.ccy}`,
                  ],
                  [
                    instrument === 'spot' ? 'Value' : 'Tenor',
                    instrument === 'spot'
                      ? (displayedSettleIso ?? 'spot')
                      : `${cardTenorLabel} · ${displayedSettleIso ?? ''}`.trim(),
                  ],
                  [
                    'Type',
                    // Placed order wins; the pad convention is only the
                    // pre-submit preview of what is about to be sent.
                    padRole === 'takeProfit'
                      ? 'Take Profit'
                      : padRole === 'stopLoss'
                        ? 'Stop Loss'
                        : limitOrderType === 'oco'
                          ? 'OCO'
                          : hit === takeProfitHit
                            ? 'Take Profit'
                            : 'Stop Loss',
                  ],
                ];
                if (statusValue) rows.push(['Status', statusValue]);
                if (fillValue) {
                  rows.push([
                    padTicket?.isSpotReferenced ? 'Spot fill' : 'Fill',
                    fillValue,
                  ]);
                }
                if (bookedFwd) rows.push(['Booked FWD', bookedFwd]);
                if (executedAt) rows.push(['Executed', executedAt]);
                if (limitValue && limitValue !== '—') {
                  rows.push(['Limit', limitValue]);
                }
                if (validity === 'DAY') {
                  rows.push([
                    'GTD',
                    `GTD ${formatGoodTillMs(ticket.goodTillMs ?? goodTillMsForValidity('DAY')!)}`,
                  ]);
                }
                return (
                  <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-left">
                    {rows.map(([k, v]) => (
                      <Fragment key={k}>
                        <dt className="font-mono text-[10px] uppercase tracking-wide text-white/60">
                          {k}
                        </dt>
                        <dd className="min-w-0 truncate text-right font-mono text-[11px] font-semibold text-white">
                          {v}
                        </dd>
                      </Fragment>
                    ))}
                    <dt className="font-mono text-[10px] uppercase tracking-wide text-white/60">
                      Valid
                    </dt>
                    <dd className="text-right">
                      <select
                        aria-label="Order validity"
                        value={validity}
                        onChange={event => setValidity(event.target.value as OrderValidity)}
                        className="h-5 max-w-full bg-transparent text-right font-mono text-[11px] font-semibold text-white outline-none"
                      >
                        <option value="DAY">Day</option>
                        <option value="GTC">Till Cancel</option>
                      </select>
                    </dd>
                  </dl>
                );
              }}
              filledHit={stripPadLive ? null : filledHit}
              executedHit={stripPadLive ? null : executedHit}
              counterparty={fillTicket.counterparty ?? null}
              fillPx={stripPadLive ? null : fillPx}
              padFillPx={
                stripPadLive || !fillTicketBooked
                  ? null
                  : bookedPadFillPx(fillTicket)
              }
              fillRole={stripPadLive ? null : fillRole}
              fillAt={stripPadLive ? null : fillAt}
              hitFill={
                stripPadLive
                  ? undefined
                  : hit => {
                      const pad = selectedPadTicketForHit(hit);
                      const cancelled =
                        pad?.status === 'cancelled'
                        || (siblingOrder?.status === 'cancelled'
                          && hit === siblingHit);
                      const filled =
                        pad != null && isMarketExecutedHedgeTicket(pad);
                      const px = filled ? bookedPadFillPx(pad) : null;
                      const role =
                        pad?.bracketRole === 'stopLoss'
                          ? 'SL'
                          : pad?.bracketRole === 'takeProfit'
                            ? 'TP'
                            : filled
                              ? 'LIMIT'
                              : null;
                      const at =
                        filled
                        && pad.filledAtMs != null
                        && Number.isFinite(pad.filledAtMs)
                          ? formatFillClock(pad.filledAtMs)
                          : null;
                      return {
                        filled,
                        px,
                        role,
                        at,
                        cancelled: Boolean(cancelled && !filled),
                      };
                    }
              }
              // Free leg selected on a reopened strip: the pad is how the
              // desk leaves an order on it (the row tiles only market-fill).
              // Executed edges are excluded from every fill and order path,
              // so an unlocked pad cannot re-trade a done leg. With legs
              // still to trade (stripPadLive) the pad is live regardless of
              // the opened ticket's own fill — its fill stays on its row.
              // Nothing free (every leg executed or has an order working):
              // the whole-strip pad has nothing to fill or leave, so it
              // does not arm and claim "ALL LEGS · READY".
              locked={
                fillDone
                || readOnlyActions
                || (
                  structure === 'strip'
                  && stripRows.length > 0
                  && freeStripLegKeys.size === 0
                  // Editing the last working leg is not "nothing to do".
                  && !editingOrder
                )
              }
              inputsLocked={freezeInputs}
              // `restFilled` describes the ticket that OPENED the panel, not
              // the SELECTED leg — `bracketSide` two props down already made
              // this switch. Without it, opening from a live market fill and
              // selecting a different, already-executed bracket leg left
              // `viewOnly` false, which forced `liveMarketFill` true and
              // suppressed the order-sheet view (LIVE REF / big rate / Filled
              // badge / Side·Notional·Limit·Valid) that leg's own fill should
              // show — the tile fell back to a live two-sided quote instead,
              // with only the side that leg actually executed on carrying
              // any fill chrome at all.
              viewOnly={
                !stripPadLive
                && (selectedLegLimitOrder || (readOnly && ticket.limitRate != null))
                // The unselected strip pad is never an order view.
                && !(structure === 'strip' && selectedLegKey == null)
                // The leg whose order is being EDITED is its editable sheet.
                // Every selected leg with an order read as a view, so Edit
                // on a strip leg opened straight back into view mode.
                && !(editingOrder && (() => {
                  const own = legTicketForSelectedLeg();
                  return own != null && (
                    own.id === ticket.id
                    || (ticket.ocoGroupId != null && own.ocoGroupId === ticket.ocoGroupId)
                  );
                })())
              }
              bracketSide={
                limitMode
                || (
                  !stripPadLive
                  && (selectedLegLimitOrder || fillTicketBooked)
                )
                  ? side
                  : null
              }
              orderRate={orderRate}
              // Levels in the card's convention. While working the card is
              // spot and these are the editable typed rates, unchanged; once
              // executed each pad's spot-referenced level shows as the
              // forward it books at (inputs are locked by then).
              orderRates={(() => {
                // Viewing an order (not composing one): the pad shows THAT
                // order's own level. `orderRates` can hold whatever the desk
                // last armed or typed on another leg — 1.15762 / 1.14132 sat
                // on the sheet of a TP resting at 1.13990.
                const shown = (hit: HitSide): string => {
                  const padTicket = selectedPadTicketForHit(hit);
                  const own = padTicket?.limitRate;
                  const ownLevel = own != null && own > 0 ? fmtPx(own) : '';
                  const raw = viewingOrder
                    ? ownLevel
                    : !limitMode && ownLevel !== '' ? ownLevel : orderRates[hit];
                  if (limitOrderOnSpot || raw.trim() === '') return raw;
                  return fmtPx(levelInCardConvention(padTicket, Number(raw)));
                };
                return { bid: shown('bid'), ask: shown('ask') };
              })()}
              rateEdited={orderRateEdited}
              onOrderRate={v => {
                if (!fillDone) {
                  setOrderRate(v);
                  if (workingHit != null) {
                    setOrderRates(prev => ({ ...prev, [workingHit]: v }));
                  }
                  setOrderRateEdited(true);
                }
              }}
              onOrderRateForHit={(hit, value) => {
                if (!fillDone) {
                  setOrderRates(prev => ({ ...prev, [hit]: value }));
                  if (workingHit === hit) setOrderRate(value);
                  setOrderRateEdited(true);
                }
              }}
              onArm={hit => {
                // Back on the main (whole-strip) pad, which is spot: leaving
                // a leg's tile on its forward had the card quote e.g. the 1Y
                // outright for a click that books every leg at its own.
                if (
                  structure === 'strip'
                  && selectedLegKey != null
                  && instrument !== 'option'
                ) {
                  resetStripPadToSpot();
                } else {
                  setSelectedLegKey(null);
                }
                setLimitMode(false);
                selectHitOnly(hit, { kind: 'main' });
              }}
              onFill={hit => {
                setSelectedLegKey(null);
                executeHit(hit, { kind: 'main' });
              }}
              onLeave={hit => {
                // The tile's BID / ASK leave the whole-strip (or bullet)
                // order. A selected leg's order is placed from that leg's
                // own BID / ASK, so these are blocked while one is selected
                // (leaveBlockedReason).
                setLimitMode(true);
                setLimitOrderType(hit === 'bid' ? 'takeProfit' : 'stopLoss');
                selectHitOnly(hit, { kind: 'main' }, true);
              }}
              leaveBlockedReason={
                structure === 'strip' && selectedLegKey != null
                  ? 'A leg is selected — leave its order from that leg’s own BID / ASK'
                  : null
              }
              onResetSpot={
                structure === 'strip' && stripRows.length > 1
                  ? () => {
                      if (!freezeInputs) resetStripPadToSpot();
                    }
                  : undefined
              }
              stripFwdBlocked={stripPadBlockedOnFwd}
              readyHit={fillDone ? null : workingHit}
              readyAllLegs={
                !fillDone
                && hitTarget?.kind === 'main'
                && selectedLegKey == null
                && structure === 'strip'
                && stripRows.length > 0
              }
              readyLegLabel={
                !fillDone
                  ? hitTarget?.kind === 'leg'
                    ? (stripRows.find(r => r.key === hitTarget.key)?.label
                      ?? '1 leg')
                    : selectedStrip?.label ?? null
                  : null
              }
              onCancelReady={() => {
                setLimitMode(false);
                setOrderRateEdited(false);
                clearReady();
              }}
              stripHint={
                structure === 'strip' && stripRows.length > 0
                  ? executedCoverAbs > 1e-9
                    ? `${pendingHedgeAbs.toFixed(2)}M pending · ${executedCoverAbs.toFixed(2)}M filled`
                    : `${stripRows.length} legs`
                  : null
              }
              menuOpen={tileMenu}
              onToggleMenu={() => {
                if (!freezeInputs) setTileMenu(v => !v);
              }}
              tapeOn={tapeOn}
              onToggleTape={() => setTapeOn(v => !v)}
              flash={tickDir}
              source={priced ? sourceLabel(priced.blend) : '—'}
              settleIso={displayedSettleIso}
              tenorDisplay={optionTenorDisplay}
              onTenor={applyTenor}
              onSettleIso={applySettleIso}
              optionPut={instrument === 'option' ? optionPut : null}
              onOptionPut={
                instrument === 'option' && !freezeInputs
                  ? applyOptionSide
                  : undefined
              }
              strikeLocked={instrument !== 'option'}
              disableSpotTenor={false}
            />

            {instrument === 'option'
              && !(structure === 'strip' && stripRows.length > 0) && (
              <div className="mt-1.5">
                <div className="mb-0.5 flex items-center justify-between">
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
                    Option · priced leg
                  </div>
                  <div className="text-[9px] text-slate-600">
                    Vanilla · one expiry · same blotter as executed FWD legs
                  </div>
                </div>
                <StripLegRow
                  row={{
                    key: 'option-bullet',
                    label: `L1 · ${
                      optionTenorDisplay
                      ?? tenorLabel(tenor)
                      ?? tenor
                    }`,
                    instrument: 'option',
                    tenor,
                    months,
                    sizeM: Math.abs(sizeM),
                    near: false,
                    linked: false,
                    bank: tileBankBid,
                    bankBid: tileBankBid,
                    bankAsk: tileBankAsk,
                  }}
                  legCcy={ticket.ccy}
                  bid={tileBid}
                  ask={tileAsk}
                  points={null}
                  vol={
                    fillTicket.ipaQuote?.impliedVolPercent
                    ?? quote?.impliedVolPercent
                    ?? null
                  }
                  premiumUsd={
                    fillTicket.ipaQuote?.premiumUsd
                    ?? (executedHit === 'ask' ? optionPremAsk : optionPremBid)
                    ?? optionPremBid
                    ?? optionPremAsk
                    ?? null
                  }
                  premiumBidUsd={optionPremBid}
                  premiumAskUsd={optionPremAsk}
                  optionPut={optionPut}
                  strike={
                    fillTicket.ipaQuote?.strike
                    ?? quote?.strike
                    ?? null
                  }
                  deltaPercent={
                    fillTicket.ipaQuote?.deltaPercent
                    ?? quote?.deltaPercent
                    ?? null
                  }
                  optionQuote={fillTicket.ipaQuote ?? quote ?? null}
                  optionQuoteBid={pricedBid?.quote ?? null}
                  optionQuoteAsk={pricedAsk?.quote ?? null}
                  fillPremiumUsd={
                    execReport?.fills[0]?.premiumUsd
                    ?? fillTicket.ipaQuote?.premiumUsd
                    ?? null
                  }
                  on
                  armed={mainArmed}
                  filledHit={fillDone ? (executedHit ?? filledHit) : null}
                  fillTradeSide={
                    fillDone
                      ? (execReport?.side
                        ?? pairSideForFcySide(
                          ticketTradeSide(fillTicket),
                          fillTicket.ccy,
                          baseCcy,
                        ))
                      : null
                  }
                  fillIsSpotExecution={false}
                  fillSpotRefPx={fillTicket.ipaQuote?.fxSpot ?? null}
                  orderStatus={
                    fillDone
                      ? 'filled'
                      : ticket.status === 'cancelled'
                        ? 'cancelled'
                        : ticket.status === 'scheduled' || submittedHit != null
                          ? 'working'
                          : null
                  }
                  orderTypeChip={
                    // The executed ticket states its own kind once it is on
                    // the book; execReport alone is a click's report (or one
                    // rebuilt from filled legs) and called a filled limit MKT.
                    fillDone && execReport != null && !fillTicketBooked
                      ? 'MKT'
                      : ticketOrderTypeChip(fillTicket)
                  }
                  orderLimit={fillTicket.limitRate ?? null}
                  fillPx={fillPx}
                  fillAt={fillAt}
                  locked={fillDone || readOnlyActions}
                  inputsLocked={freezeInputs || fillDone}
                  onSelect={() => {
                    if (!fillDone) {
                      releasePadForNextOrder();
                      setHitTarget({ kind: 'main' });
                      setSelectedLegKey(null);
                    }
                  }}
                  onHit={hit => {
                    const target: HitTarget = { kind: 'main' };
                    const already =
                      !fillDone
                      && !limitMode
                      && !orderRateEdited
                      && workingHit === hit
                      && (hitTarget?.kind === 'main' || hitTarget == null);
                    if (already) {
                      executeHit(hit, target);
                      return;
                    }
                    setLimitMode(false);
                    selectHitOnly(hit, target);
                  }}
                />
              </div>
            )}

            {structure === 'strip' && (
              <div className="mt-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
                    Strip · priced legs
                  </div>
                  <div className="text-[9px] text-slate-600">
                    {stripRows.length > 0
                      ? executedCoverAbs > 1e-9
                        ? `${pendingHedgeAbs.toFixed(2)}M outstanding · ${executedCoverAbs.toFixed(2)}M filled · row Bid/Ask = that leg`
                        : `${stripRows.length} · main tile = all legs · a row Bid/Ask = that leg only · fill is per leg`
                      : 'Stage a strip first'}
                  </div>
                </div>
                {stripRows.length === 0 ? (
                  <p className="rounded-md border border-dashed border-slate-800 px-2 py-3 text-[10px] text-slate-500">
                    No staged strip on this CCY. Fine-tune legs in Cash Carry
                    (or stage on Hedging Decision), then each row prices at
                    its own settle.
                  </p>
                ) : (
                  <div className="max-h-56 space-y-1.5 overflow-y-auto pr-0.5">
                    {stripRows.map((row, edgeIndex) => {
                      const q = stripQuotes.find(x => x.key === row.key);
                      const on = selectedLegKey === row.key;
                      const mainStripReady =
                        !fillDone
                        && workingHit != null
                        && hitTarget?.kind === 'main';
                      // A whole-strip arm lights only the legs that click will
                      // actually fill — free legs. A leg with an order working
                      // (or already executed) is skipped by the bulk fill, so
                      // lighting it read as that order being executed.
                      const rowArmed =
                        hitTarget?.kind === 'leg' && hitTarget.key === row.key
                          ? workingHit
                          : mainStripReady && freeStripLegKeys.has(row.key)
                            ? workingHit
                            : null;
                      const execFill = execReport?.fills.find(f => f.key === row.key);
                      const {
                        filled: filledPeer,
                        working: workingPeers,
                        cancelled: cancelledPeer,
                      } = legPeersAtEdge(ownStripTickets, edgeIndex, {
                        coverOnly: true,
                      });
                      const workingPeer = workingPeers[0];
                      // `filledPeer` is `coverOnly`: it refuses a bracket
                      // that has not itself proven it is this leg's own
                      // trade (its `isSpotReferenced` stamp). When that
                      // stamp is missing on an otherwise real, booked fill —
                      // a gap in booking, not in this row — coverOnly finds
                      // nothing and every field below fell back to
                      // `execFill`/`execReport`: a snapshot of the LAST
                      // live-click batch, keyed only by row.key, that still
                      // carries whichever price/side/simulated-dealer that
                      // batch had at the moment of the click. For a leg that
                      // actually filled later through the matcher, that
                      // record is unrelated to this fill and stale by
                      // definition. The plain (non-coverOnly) peer is still
                      // this row's own executed ticket regardless of the
                      // missing stamp, and a real ticket always outranks an
                      // ephemeral client-side snapshot.
                      const anyFilledPeer =
                        filledPeer ?? legPeersAtEdge(ownStripTickets, edgeIndex).filled;
                      // StripLegRow shows the execution (side, dealer, fill
                      // rate side) — derive the EXECUTED side, not the typed
                      // tile, or a filled Buy TP row reads "SELL · bid" over
                      // the wrong dealer.
                      const rowFilled =
                        anyFilledPeer != null
                          ? restingOrderHitSide(anyFilledPeer)
                          : execFill != null
                            ? (execReport?.hit ?? null)
                            : null;
                      const rowStatus =
                        execFill != null || anyFilledPeer != null
                          ? 'filled'
                          : workingPeer
                            ? 'working'
                            : cancelledPeer
                              ? 'cancelled'
                              : executedCoverAbs > 1e-9
                                ? 'pending'
                                : null;
                      const rowFillPx =
                        anyFilledPeer?.ipaQuote?.fxOutright
                        ?? anyFilledPeer?.limitRate
                        ?? execFill?.rate
                        ?? null;
                      const rowFillAt =
                        anyFilledPeer?.filledAtMs != null
                          ? formatFillClock(anyFilledPeer.filledAtMs)
                          : execFill != null
                            ? (execReport?.at ?? null)
                            : null;
                      // Click-trade / HitPad leg fills stamp orderType: market.
                      // An execReport row is MKT only when no ticket executed
                      // at this edge: the all-legs-filled report is rebuilt
                      // from the booked peers, so an order-filled leg reports
                      // the order that filled it (TP / SL / LIMIT), not MKT.
                      const orderTypePeer =
                        anyFilledPeer ?? workingPeer ?? cancelledPeer ?? null;
                      const rowOrderType: TicketOrderTypeChip | null =
                        orderTypePeer != null
                          ? ticketOrderTypeChip(orderTypePeer)
                          : execFill != null
                            ? 'MKT'
                            : null;
                      return (
                        <StripLegRow
                          key={row.key}
                          row={row}
                          legCcy={ticket.ccy}
                          bid={q?.bid ?? null}
                          ask={q?.ask ?? null}
                          points={
                            anyFilledPeer != null
                              // A legacy SPOT bracket fill has no points of its
                              // own; adding today's live points to its print
                              // shows a forward that was never booked. It reads
                              // as the spot fill it was ("fwd points n/a").
                              ? (anyFilledPeer.stripLegPoints
                                ?? (anyFilledPeer.instrument === 'spot'
                                  ? null
                                  // A market-filled leg's own booked points
                                  // (outright − spot as stamped), not today's
                                  // live points, which drift off its FWD.
                                  : (() => {
                                      // A market fill's stamps are one instant; an
                                      // older plain forward ORDER keeps its
                                      // placement spot, so its difference is not
                                      // points.
                                      if (anyFilledPeer.limitRate != null) return q?.points;
                                      const o = anyFilledPeer.ipaQuote?.fxOutright;
                                      const sp = anyFilledPeer.ipaQuote?.fxSpot;
                                      return o != null && o > 0 && sp != null && sp > 0
                                        ? new Decimal(o)
                                          .minus(sp)
                                          .div(swapPointsToPriceDelta(1, ticket.ccy))
                                          .toNumber()
                                        : q?.points;
                                    })())
                                ?? null)
                              : (q?.points ?? null)
                          }
                          vol={q?.vol ?? null}
                          premiumUsd={q?.premiumUsd ?? null}
                          premiumBidUsd={q?.premiumBidUsd ?? null}
                          premiumAskUsd={q?.premiumAskUsd ?? null}
                          optionPut={
                            row.instrument === 'option' ? optionPut : null
                          }
                          strike={
                            anyFilledPeer?.ipaQuote?.strike
                            ?? q?.strike
                            ?? null
                          }
                          deltaPercent={
                            anyFilledPeer?.ipaQuote?.deltaPercent
                            ?? q?.deltaPercent
                            ?? null
                          }
                          optionQuote={anyFilledPeer?.ipaQuote ?? null}
                          optionQuoteBid={q?.quoteBid ?? null}
                          optionQuoteAsk={q?.quoteAsk ?? null}
                          fillPremiumUsd={
                            anyFilledPeer?.ipaQuote?.premiumUsd
                            ?? execFill?.premiumUsd
                            ?? null
                          }
                          on={on}
                          // One highlight: the pad for a market arm, the BID /
                          // ASK button for an order.
                          armed={limitMode ? null : rowArmed}
                          filledHit={rowFilled}
                          fillTradeSide={
                            anyFilledPeer
                              ? pairSideForFcySide(
                                  ticketTradeSide(anyFilledPeer),
                                  anyFilledPeer.ccy,
                                  baseCcy,
                                )
                              : execReport?.side ?? null
                          }
                          fillIsSpotExecution={
                            (anyFilledPeer?.instrument
                              ?? execFill?.instrument
                              ?? row.instrument) === 'spot'
                          }
                          fillSpotRefPx={anyFilledPeer?.ipaQuote?.fxSpot ?? null}
                          orderStatus={rowStatus}
                          orderTypeChip={rowOrderType}
                          orderLimit={
                            (anyFilledPeer ?? workingPeer ?? cancelledPeer)?.limitRate
                            ?? null
                          }
                          fillPx={rowFillPx}
                          fillAt={rowFillAt}
                          counterparty={anyFilledPeer?.counterparty ?? null}
                          locked={
                            rowStatus === 'filled'
                            // A leg whose order still works can be filled at
                            // market now (that cancels the order); a free leg
                            // of a reopened strip is tradeable; everything
                            // else stays view-only.
                            || (fillDone && !workingPeer)
                            || (readOnly && !freeStripLegKeys.has(row.key) && !workingPeer)
                          }
                          inputsLocked={freezeInputs || rowStatus === 'filled'}
                          onSelect={() => {
                            releasePadForNextOrder();
                            if (selectedLegKey === row.key) {
                              // Deselecting returns to the spot main pad, as
                              // a fresh strip opens — not the leg's forward.
                              if (instrument === 'option') {
                                setSelectedLegKey(null);
                              } else {
                                resetStripPadToSpot();
                              }
                              setHitTarget({ kind: 'main' });
                              return;
                            }
                            selectStripLeg(row);
                          }}
                          onHit={hit => {
                            // Desk rule split (2026-09-08): the MAIN pad is
                            // spot-only, but a LEG row's own bid/ask
                            // market-executes THAT leg at its live quote —
                            // that is what the row tiles are for. A spot
                            // reset here intercepted the second (execute)
                            // click, because the first click's
                            // selectStripLeg flips the panel to the leg's
                            // forward tenor, so the leg could arm but never
                            // fill.
                            // Click → highlight (orange) → click → fill.
                            const token = `${row.key}|${hit}`;
                            const already =
                              legArmTokenRef.current === token
                              && !limitMode
                              && !orderRateEdited
                              && workingHit === hit
                              && hitTarget?.kind === 'leg'
                              && hitTarget.key === row.key;
                            if (already) {
                              legArmTokenRef.current = null;
                              executeHit(hit, { kind: 'leg', key: row.key, months: row.months });
                              return;
                            }
                            setLimitMode(false);
                            selectHitOnly(hit, { kind: 'leg', key: row.key, months: row.months });
                            legArmTokenRef.current = token;
                          }}
                          // The selected leg's own BID / ASK place an order on
                          // that leg — the job the main tile's chips used to
                          // do for a selected leg. The level is typed on the
                          // main tile's order sheet, as for any order.
                          onLeave={
                            on
                            && onLeaveOrder
                            && !fillDone
                            && freeStripLegKeys.has(row.key)
                              ? hit => {
                                  setLimitMode(true);
                                  setLimitOrderType(hit === 'bid' ? 'takeProfit' : 'stopLoss');
                                  selectHitOnly(
                                    hit,
                                    { kind: 'leg', key: row.key, months: row.months },
                                    true,
                                  );
                                }
                              : undefined
                          }
                          orderArmed={limitMode ? rowArmed : null}
                          onEditOrder={
                            workingPeer
                            && onEditWorkingOrder
                            && isEditableWorkingOrder(workingPeer)
                            && !isOrderBeingEdited(workingPeer)
                              ? () => onEditWorkingOrder(workingPeer)
                              : undefined
                          }
                          onCancelOrder={
                            workingPeer && onCancelWorkingOrder
                              ? () => onCancelWorkingOrder(workingPeer)
                              : undefined
                          }
                          // Opposite the pad the working order was placed on: an
                          // order left on the ASK fills now via the BID, and the
                          // reverse — the side a market fill of it executes on.
                          // For an OCO, opposite its take-profit's pad.
                          fillNowHit={(() => {
                            if (!workingPeer || rowStatus !== 'working') return null;
                            const order =
                              workingPeers.find(
                                t => t.bracketRole === 'takeProfit' || t.orderType === 'takeProfit',
                              )
                              ?? workingPeer;
                            const pad = order.orderHit ?? restingOrderHitSide(order);
                            return pad === 'bid' ? 'ask' : 'bid';
                          })()}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div
              className={`mt-2 grid gap-2 ${
                instrument === 'option'
                  ? 'grid-cols-2 sm:grid-cols-4'
                  : 'grid-cols-3'
              }`}
            >
              <MiniRate
                label="Points"
                value={
                  selectedStripQuote?.points != null
                    ? selectedStripQuote.points.toFixed(2)
                    : priced?.blend.curvePoints != null
                      ? priced.blend.curvePoints.toFixed(2)
                      : '—'
                }
              />
              <MiniRate
                label="Vol"
                value={
                  quote?.impliedVolPercent != null
                    ? `${quote.impliedVolPercent.toFixed(2)}%`
                    : '—'
                }
              />
              {instrument === 'option' ? (
                <>
                  <MiniRate
                    label={
                      structure === 'strip' && stripRows.length > 0
                        ? 'Σ Prem bid'
                        : 'Prem bid'
                    }
                    value={fmtUsd(
                      structure === 'strip' && stripRows.length > 0
                        ? stripPremiumTot.bid
                        : pricedBid?.quote.premiumUsd,
                    )}
                    tone="rose"
                  />
                  <MiniRate
                    label={
                      structure === 'strip' && stripRows.length > 0
                        ? 'Σ Prem ask'
                        : 'Prem ask'
                    }
                    value={fmtUsd(
                      structure === 'strip' && stripRows.length > 0
                        ? stripPremiumTot.ask
                        : pricedAsk?.quote.premiumUsd,
                    )}
                    tone="emerald"
                  />
                </>
              ) : (
                <MiniRate
                  label="Spot mid"
                  value={fmtPx(spot?.mid)}
                />
              )}
            </div>

            {instrument === 'option' && quote && (
              <p className="mt-1 font-mono text-[10px] text-slate-500">
                Strike {quote.strike != null ? quote.strike.toFixed(5) : '—'}
                {quote.deltaPercent != null ? ` · Δ ${quote.deltaPercent.toFixed(1)}` : ''}
                {quote.atmVolPercent != null
                  ? ` · ATM ${quote.atmVolPercent.toFixed(2)}%`
                  : ''}
              </p>
            )}

            {tileMenu && (
              <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/60 p-2.5">
                <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                  Configure tile
                </div>
                <div className="mt-2">
                  <div className="mb-1 text-[9px] uppercase tracking-wide text-slate-600">
                    Vol source
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {VOL_PREFS.map(opt => (
                      <Chip
                        key={opt}
                        label={opt === 'auto' ? 'Auto' : opt[0]!.toUpperCase() + opt.slice(1)}
                        on={volPref === opt}
                        disabled={freezeInputs}
                        onClick={() => {
                          if (!freezeInputs) setVolPref(opt);
                        }}
                      />
                    ))}
                  </div>
                </div>
                <div className="mt-2">
                  <div className="mb-1 text-[9px] uppercase tracking-wide text-slate-600">
                    Spot override · mid
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={spotOverride}
                    disabled={freezeInputs}
                    onChange={ev => setSpotOverride(ev.target.value)}
                    placeholder={spot?.mid != null ? fmtPx(spot.mid) : 'Live / last pull'}
                    className="h-7 w-full rounded-md border border-slate-700 bg-slate-950 px-2 font-mono text-[11px] text-slate-200 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {deskErr ? (
          <p className="mt-3 shrink-0 text-[11px] text-rose-300">{deskErr}</p>
        ) : null}

        <div className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2">
          {!fillDone && (
            <label className="mr-auto flex items-center gap-1.5 text-[10px] text-amber-200/90">
              <input
                type="checkbox"
                checked={bookUnpriced}
                disabled={freezeInputs}
                onChange={e => setBookUnpriced(e.target.checked)}
                className="accent-amber-400"
              />
              Book unpriced
            </label>
          )}
          {fillDone && (
            <span className="mr-auto min-w-0 font-mono text-[10px] font-semibold uppercase tracking-wide text-orange-200">
              {formatLiveFillSummary({
                pair,
                // Footer reports the EXECUTION: side/hit/dealer all come
                // from the executed side (restingOrderHitSide convention),
                // never from the typed tile — a Buy TP typed on the bid
                // read "Sell · bid" here while the matcher filled the ask.
                side:
                  execReport?.side
                  ?? (executedHit != null ? orderSideForHit(executedHit) : side),
                hit: executedHit ?? execReport?.hit ?? null,
                fillRole,
                fillAt,
                rates: (
                  execReport?.fills.map(f => f.rate)
                  ?? ownStripTickets
                    .filter(isExecutedBookedTicket)
                    .map(t => t.ipaQuote?.fxOutright)
                ).concat(fillPx),
                banks: execReport != null
                  ? execReport.fills.map(f => f.bank)
                  : stripRows.length > 0
                    ? stripRows.flatMap((row, i) => {
                        const t = ownStripTickets.find(
                          x => (x.stripEdgeIndex ?? 0) === i && isExecutedBookedTicket(x),
                        );
                        if (!t) return [];
                        const bank =
                          t.counterparty
                          ?? (restingOrderHitSide(t) === 'bid'
                            ? row.bankBid
                            : row.bankAsk);
                        return [bank];
                      })
                    : ticket.counterparty != null
                      ? [ticket.counterparty]
                      : executedHit != null
                        ? [executedHit === 'bid' ? tileBankBid : tileBankAsk]
                        : [],
              })}
            </span>
          )}
          {editTarget && onEditWorkingOrder && (
            <button
              type="button"
              onClick={() => onEditWorkingOrder(editTarget)}
              title="Edit this working order"
              aria-label="Edit this working order"
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-sky-600/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {readOnly && onCancelOrder && (
            <button
              type="button"
              onClick={onCancelOrder}
              title={
                ticket.status === 'scheduled'
                  ? 'Cancel this working order'
                  : 'Cancel this hedge and restage the ticket'
              }
              aria-label="Cancel order"
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-rose-600/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          {!fillDone && (
            <button
              type="button"
              onClick={() => void pullLiveSpot()}
              disabled={livePrintLoading || freezeInputs}
              className="rounded border border-sky-500/50 bg-sky-500/15 px-2.5 py-1.5 text-[10px] font-semibold text-sky-100 hover:bg-sky-500/25 disabled:opacity-50"
            >
              {livePrintLoading ? 'Live…' : 'Reprice'}
            </button>
          )}
          {fillDone ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded border border-[#FF5722] bg-[#FF5722] px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-[#E64A19]"
            >
              <DeskIcon name="action-book" className="h-3.5 w-3.5" />
              Done
            </button>
          ) : (
            <button
              type="button"
              disabled={
                readOnlyActions
                || !canConfirm
                || workingHit == null
                || limitMode
                || submittedHit != null
                || (
                  workingHit != null
                  && orderRateEdited
                  && checkRestingLevel(workingHit, orderRates[workingHit]) === 'invalid'
                )
              }
              title={
                readOnlyActions
                  ? 'View only'
                  : workingHit == null
                  ? 'Pick a side, type your level, then Submit'
                  : limitMode
                    ? 'Choose Submit TP Order, Submit SL Order, or Submit OCO'
                    : orderRateEdited && checkRestingLevel(workingHit, orderRates[workingHit]) === 'invalid'
                    ? 'That level is on the wrong side of (or too close to) the live market'
                    : orderRateEdited && checkRestingLevel(workingHit, orderRates[workingHit]) === 'triggered'
                    ? 'Submit — already through the market, executes now'
                    : orderRateEdited
                    ? 'Submit — leaves the limit order working at your level'
                    : `Submit ${orderSideForHit(workingHit)} at market`
              }
              onClick={() =>
                executeHit(
                  workingHit
                    ?? (quoteSide === 'bid' ? 'bid' : 'ask'),
                  hitTarget ?? { kind: 'main' },
                )
              }
              className="inline-flex items-center gap-1.5 rounded border border-[#FF5722] bg-[#FF5722] px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-[#E64A19] disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-700 disabled:text-slate-300 disabled:hover:bg-slate-700"
            >
              <DeskIcon name="action-book" className="h-3.5 w-3.5" />
              {limitMode
                ? 'Choose order type'
                : submittedHit != null
                  ? 'Working'
                  : workingHit
                ? hitTarget?.kind === 'main'
                  && structure === 'strip'
                  && stripRows.length > 1
                  ? `Submit strip · ${orderSideForHit(workingHit)}`
                    : orderRateEdited && restsAwayFromMarket(workingHit, orderRates[workingHit])
                    ? 'Submit order'
                    : `Submit ${orderSideForHit(workingHit)}`
                : 'Submit'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtPx(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 20) return v.toFixed(3);
  return v.toFixed(5);
}

function isExecutedBookedTicket(t: HedgeTicket | undefined): boolean {
  return t != null && isMarketExecutedHedgeTicket(t);
}

function formatLiveFillSummary(args: {
  pair: string;
  side: 'Buy' | 'Sell' | null;
  hit: HitSide | null;
  fillRole?: 'TP' | 'SL' | 'LIMIT' | null;
  fillAt: string | null;
  rates: readonly (number | null | undefined)[];
  banks: readonly string[];
}): string {
  const parts: string[] = [pairSlash(args.pair)];
  if (args.side) parts.push(args.side);
  if (args.hit) parts.push(args.hit);
  if (args.fillRole) parts.push(args.fillRole);
  const rates = args.rates.filter((r): r is number => r != null && Number.isFinite(r));
  if (rates.length === 1) {
    parts.push(fmtPx(rates[0]));
  } else if (rates.length > 1) {
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    parts.push(min === max ? fmtPx(min) : `${fmtPx(min)}–${fmtPx(max)}`);
  }
  const banks: string[] = [];
  const seen = new Set<string>();
  for (const bank of args.banks) {
    const key = bank.trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    banks.push(bank.trim());
  }
  if (banks.length > 0) parts.push(banks.join('/'));
  if (args.fillAt) parts.push(args.fillAt);
  return parts.join(' · ');
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `$${Math.round(v).toLocaleString()}`;
}

function Tile({
  icon,
  label,
  hint,
  title,
  on,
  soon,
  disabled = false,
  onClick,
}: {
  icon: DeskIconName;
  label: string;
  hint: string;
  title?: string;
  on: boolean;
  soon?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const blocked = Boolean(soon || disabled);

  return (
    <button
      type="button"
      disabled={blocked}
      title={title}
      onClick={onClick}
      className={`flex w-full flex-col items-center gap-1 rounded-lg border px-1.5 py-2 text-center transition-colors ${
        blocked
          ? 'cursor-not-allowed border-slate-800 bg-slate-950/40 opacity-40'
          : on
            ? 'border-sky-500/50 bg-sky-500/15'
            : 'border-slate-700 bg-slate-950/60 hover:border-slate-500'
      }`}
    >
      <span
        className={`flex h-8 w-8 items-center justify-center rounded-md border ${
          on
            ? 'border-sky-400/40 bg-sky-500/20 text-sky-100'
            : 'border-slate-700 bg-slate-900 text-slate-300'
        }`}
      >
        <DeskIcon name={icon} className="h-4 w-4" />
      </span>
      <span className={`text-[10px] font-semibold ${on ? 'text-sky-100' : 'text-slate-300'}`}>
        {label}
      </span>
      <span className="text-[9px] uppercase tracking-wide text-slate-600">
        {soon ? 'Soon' : hint}
      </span>
    </button>
  );
}

function Chip({
  label,
  on,
  disabled = false,
  onClick,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      onClick={onClick}
      className={`w-full rounded-md border px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
        disabled
          ? 'cursor-not-allowed border-slate-800 text-slate-600 opacity-50'
          : on
            ? 'border-sky-400/60 bg-sky-500/20 text-sky-100'
            : 'border-slate-700 bg-slate-950/60 text-slate-400 hover:border-slate-500'
      }`}
    >
      {label}
    </button>
  );
}

function strikeChipLabel(shortcut: string): string {
  const m = shortcut.match(/^(\d+)d$/i);
  return m ? `${m[1]}Δ` : shortcut;
}

function parseIsoNoon(iso: string): Date | null {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function TenorDateField({
  instrument,
  tenor,
  settleIso,
  tenorDisplay,
  disabled,
  disableSpot = false,
  onTenor,
  onSettleIso,
}: {
  instrument: HedgeInstrument;
  tenor: VarHorizonId;
  settleIso: string;
  tenorDisplay?: string | null;
  disabled: boolean;
  disableSpot?: boolean;
  onTenor: (id: VarHorizonId | 'spot') => void;
  onSettleIso: (iso: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const settleDate = parseIsoNoon(settleIso);
  const dateLabel = settleDate ? fmtSettle(settleDate) : settleIso;
  const matchedChip = TENOR_CHIPS.find(
    chip => impliedTenorIso(chip.id, instrument) === settleIso,
  );
  const tenorShort = (() => {
    if (tenorDisplay?.trim()) return tenorDisplay.trim();
    if (matchedChip?.label) return matchedChip.label;
    if (instrument === 'spot') return 'T+2';
    if (settleDate) {
      const m = monthsBetween(startOfToday(), settleDate);
      if (m < 0.4) return '1W';
      const rounded = Math.round(m);
      if (Math.abs(m - rounded) < 0.2) return `${rounded}M`;
      return `${m.toFixed(1)}M`;
    }
    return tenor.toUpperCase();
  })();
  const chipOn = (id: VarHorizonId | 'spot') => matchedChip?.id === id;
  const today = startOfToday();
  const [month, setMonth] = useState<Date>(settleDate ?? today);
  const [typedIso, setTypedIso] = useState(settleIso);

  useEffect(() => {
    setTypedIso(settleIso);
    const d = parseIsoNoon(settleIso);
    if (d) setMonth(d);
  }, [settleIso]);

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={next => {
        if (disabled) return;
        setOpen(next);
        if (next) {
          setTypedIso(settleIso);
          if (settleDate) setMonth(settleDate);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled}
          title="Tenor and settle date"
          aria-label="Tenor and settle date"
          className="h-6 shrink-0 gap-1 border-slate-700 bg-slate-900 px-1.5 font-mono text-[10px] text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-slate-100 [&_svg]:size-3"
        >
          <CalendarIcon />
          {tenorShort} · {dateLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="w-max min-w-max overflow-hidden p-0"
      >
        <div className="flex shrink-0">
          <Calendar
            mode="single"
            locale={enGB}
            captionLayout="dropdown"
            selected={settleDate ?? undefined}
            month={month}
            onMonthChange={setMonth}
            onSelect={d => {
              if (!d) return;
              onSettleIso(toIsoDate(d));
              setOpen(false);
            }}
            disabled={{ before: today }}
            startMonth={today}
            endMonth={addYears(today, 5)}
            className="shrink-0 bg-transparent p-3 [--cell-size:2.75rem]"
          />
          <div className="flex w-[4.35rem] shrink-0 flex-col gap-1 border-l border-slate-700 bg-slate-950/50 p-2">
            <div className="px-0.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
              Tenor
            </div>
            {TENOR_CHIPS.map(chip => {
              const spotOff = disableSpot && chip.id === 'spot';
              return (
              <Button
                key={chip.id}
                type="button"
                variant={chipOn(chip.id) ? 'default' : 'ghost'}
                size="xs"
                disabled={spotOff}
                title={spotOff ? 'Spot is not available in strip mode' : undefined}
                className="h-7 w-full justify-center font-mono text-[10px]"
                onClick={() => {
                  if (spotOff) return;
                  onTenor(chip.id);
                }}
              >
                {chip.label}
              </Button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-slate-700 px-2.5 py-2">
          <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
            Settle
          </span>
          <Input
            type="text"
            inputMode="numeric"
            spellCheck={false}
            value={typedIso}
            onChange={e => setTypedIso(e.target.value)}
            onBlur={() => {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(typedIso) || typedIso < toIsoDate(today)) {
                setTypedIso(settleIso);
                return;
              }
              onSettleIso(typedIso);
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!/^\d{4}-\d{2}-\d{2}$/.test(typedIso) || typedIso < toIsoDate(today)) {
                setTypedIso(settleIso);
                return;
              }
              onSettleIso(typedIso);
              setOpen(false);
            }}
            aria-label="Settle date"
            className="h-7"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

const OPTION_SIDE_CHIPS = [
  { id: 'put' as const, label: 'Put', title: 'Vanilla put' },
  { id: 'call' as const, label: 'Call', title: 'Vanilla call' },
] as const;

const OPTION_STRUCTURE_CHIPS = [
  { id: 'vanilla' as const, label: 'Van', title: 'Vanilla', soon: false },
  { id: 'rr' as const, label: 'RR', title: 'Risk reversal', soon: true },
  { id: 'straddle' as const, label: 'Strd', title: 'Straddle', soon: true },
  { id: 'strangle' as const, label: 'Strg', title: 'Strangle', soon: true },
  { id: 'fly' as const, label: 'Fly', title: 'Butterfly', soon: true },
  { id: 'ko' as const, label: 'KO', title: 'Knock-out', soon: true },
] as const;

function optionChipClass(on: boolean, blocked: boolean): string {
  return `h-5 rounded px-1.5 font-mono text-[9px] font-semibold tracking-wide transition-colors ${
    blocked
      ? 'cursor-not-allowed text-slate-600 opacity-40'
      : on
        ? 'bg-slate-100 text-slate-900'
        : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-200'
  }`;
}

/** Put / Call plus other FX option structures on the click-trade footer. */
function OptionContractBar({
  put,
  disabled,
  onPut,
}: {
  put: boolean;
  disabled: boolean;
  onPut?: (put: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
      <div
        className="inline-flex items-center rounded-md border border-slate-600/80 bg-slate-950/90 p-0.5"
        role="group"
        aria-label="Put or call"
      >
        {OPTION_SIDE_CHIPS.map(opt => {
          const on = opt.id === 'put' ? put : !put;
          return (
            <button
              key={opt.id}
              type="button"
              title={opt.title}
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onPut?.(opt.id === 'put')}
              className={optionChipClass(on, disabled)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div
        className="inline-flex items-center rounded-md border border-slate-600/80 bg-slate-950/90 p-0.5"
        role="group"
        aria-label="Option structure"
      >
        {OPTION_STRUCTURE_CHIPS.map(opt => {
          const blocked = disabled || opt.soon;
          const on = opt.id === 'vanilla';
          return (
            <button
              key={opt.id}
              type="button"
              title={opt.soon ? `${opt.title} · soon` : opt.title}
              aria-pressed={on}
              disabled={blocked}
              className={optionChipClass(on, blocked)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ClickTradeTile({
  pair,
  baseCcy,
  bankBid,
  bankAsk,
  instrument,
  tenor,
  referenceLabel = null,
  bid,
  ask,
  mid,
  premiumBid,
  premiumAsk,
  optionQuoteBid = null,
  optionQuoteAsk = null,
  sizeM,
  onSizeM,
  strikeInput,
  onStrikeInput,
  armed,
  submittedHit,
  confirmedSides = [],
  filledHit,
  executedHit = null,
  counterparty = null,
  fillPx = null,
  padFillPx = null,
  fillRole = null,
  fillAt = null,
  hitFill,
  locked,
  inputsLocked,
  orderRate,
  orderRates,
  rateEdited,
  onOrderRate,
  onOrderRateForHit,
  onArm,
  onFill,
  onLeave,
  leaveBlockedReason = null,
  bracketRoleForHit,
  onSubmitSide,
  submitLabelFor,
  onSubmitLimitOrder,
  restsAwayFromMarket,
  viewOnly = false,
  limitMode,
  bracketSide = null,
  referenceStopLoss,
  onReferenceStopLossChange,
  orderPanelFor,
  readyHit,
  readyAllLegs,
  readyLegLabel,
  onCancelReady,
  stripHint,
  menuOpen,
  onToggleMenu,
  tapeOn,
  onToggleTape,
  flash,
  source,
  settleIso,
  onTenor,
  onSettleIso,
  optionPut = null,
  onOptionPut,
  onResetSpot,
  stripFwdBlocked = false,
  tenorDisplay = null,
  strikeLocked = false,
  disableSpotTenor = false,
}: {
  pair: string;
  baseCcy: string;
  bankBid: string;
  bankAsk: string;
  instrument: HedgeInstrument;
  tenor: VarHorizonId;
  /** "3M outright" / "spot" — disambiguates LIVE REF's convention on sight. */
  referenceLabel?: string | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  premiumBid: number | null;
  premiumAsk: number | null;
  optionQuoteBid?: HedgeIpaQuote | null;
  optionQuoteAsk?: HedgeIpaQuote | null;
  sizeM: number;
  onSizeM: (n: number) => void;
  strikeInput: string;
  onStrikeInput: (v: string) => void;
  armed: HitSide | null;
  submittedHit: HitSide | null;
  /** Sides with a confirmed order working. Both for an OCO. */
  confirmedSides?: readonly HitSide[];
  filledHit: HitSide | null;
  /** Market side the fill EXECUTED on (restingOrderHitSide) — dealer/REF picks. */
  executedHit?: HitSide | null;
  /** Dealer the trade was done with, when the fill recorded one. */
  counterparty?: string | null;
  fillPx?: number | null;
  /**
   * Booked outright the grey executed pad prints — the priced-leg row's
   * FWD. Distinct from `fillPx`, which is the tape/spot REF in the header.
   */
  padFillPx?: number | null;
  fillRole?: 'TP' | 'SL' | 'LIMIT' | null;
  /** Wall-clock time the order moved to executed. */
  fillAt?: string | null;
  /**
   * Per-pad execution. A strip cover's FWD print must not land on the TP/SL
   * card, and a cancelled OCO sibling must show as cancelled on its own pad.
   */
  hitFill?: (hit: HitSide) => {
    filled: boolean;
    px: number | null;
    role: 'TP' | 'SL' | 'LIMIT' | null;
    at: string | null;
    cancelled: boolean;
  };
  locked: boolean;
  inputsLocked: boolean;
  orderRate: string;
  orderRates: Record<HitSide, string>;
  rateEdited: boolean;
  onOrderRate: (v: string) => void;
  onOrderRateForHit: (hit: HitSide, value: string) => void;
  onArm: (hit: HitSide) => void;
  /** Second click on an armed market pad — fill at the live quote. */
  onFill?: (hit: HitSide) => void;
  onLeave: (hit: HitSide) => void;
  /**
   * Set while the tile's BID / ASK must not start an order — e.g. a strip
   * leg is selected, whose own BID / ASK place its orders. Shown as the
   * buttons' tooltip.
   */
  leaveBlockedReason?: string | null;
  /**
   * The bracketRole of the order actually resting on a pad, or null when
   * none is. Supplied by the parent because only it holds the tickets — the
   * pad a level sits on does not identify its role (a Sell rests on the bid
   * whether it is the take-profit or the stop), so this has to come from the
   * order rather than be re-derived here.
   */
  bracketRoleForHit?: (hit: HitSide) => 'takeProfit' | 'stopLoss' | null;
  /** Sends the side being priced. Rendered inside that tile, full width. */
  onSubmitSide?: (hit: HitSide) => void;
  onSubmitLimitOrder?: (orderType: Exclude<HedgeOrderType, 'market' | 'limit'>) => void;
  /** Would this level rest rather than fire immediately against the live quote? */
  restsAwayFromMarket?: (
    hit: HitSide,
    rate: string,
    bracketRole: 'takeProfit' | 'stopLoss',
    orderSide: 'Buy' | 'Sell',
  ) => boolean;
  /**
   * Opened just to look — disables submission (TP/SL/OCO buttons) without
   * touching `inputsLocked`, which is ALSO true while genuinely editing an
   * existing order (a side is pre-armed then) and must not block that.
   */
  viewOnly?: boolean;
  limitMode: boolean;
  /** Restored ticket side — do not infer Buy/Sell from the armed pad (SL sits opposite TP). */
  bracketSide?: 'Buy' | 'Sell' | null;
  referenceStopLoss: boolean;
  onReferenceStopLossChange: (hit: HitSide, enabled: boolean) => void;
  /** Label for that button — says whether it rests or executes. */
  submitLabelFor?: (hit: HitSide) => string;
  /** Order parameters shown under the level while pricing that side. */
  orderPanelFor?: (hit: HitSide) => ReactNode;
  readyHit: HitSide | null;
  readyAllLegs: boolean;
  readyLegLabel: string | null;
  onCancelReady: () => void;
  stripHint: string | null;
  menuOpen: boolean;
  onToggleMenu: () => void;
  tapeOn: boolean;
  onToggleTape: () => void;
  /** Header control — keep the strip, switch the pad feed to live /api/fx-spot. */
  onResetSpot?: () => void;
  /** Whole-strip Bid/Ask is still on a FWD outright — place is blocked. */
  stripFwdBlocked?: boolean;
  flash: TickDir | null;
  source: string;
  settleIso: string;
  onTenor: (id: VarHorizonId | 'spot') => void;
  onSettleIso: (iso: string) => void;
  optionPut?: boolean | null;
  onOptionPut?: (put: boolean) => void;
  /** IPA / market tenor shown on the calendar chip (e.g. 1Y, ON) — not the VaR id. */
  tenorDisplay?: string | null;
  /** Spot / FWD / Swap lock K to ATMS / ATMF. Options keep the strike pad. */
  strikeLocked?: boolean;
  /** Hide T+2 in strip mode — Spot is not a strip contract. */
  disableSpotTenor?: boolean;
}) {
  const bidParts = bid != null ? splitFxPips(bid) : splitFxPips(NaN);
  const askParts = ask != null ? splitFxPips(ask) : splitFxPips(NaN);
  const selectedHit = armed ?? readyHit ?? filledHit;
  const selectedSide = bracketSide
    ?? (selectedHit == null
      ? null
      : limitMode
        ? limitOrderSideForHit(selectedHit)
        : orderSideForHit(selectedHit));
  const takeProfitHit = selectedSide != null
    ? limitTakeProfitHit(selectedSide)
    : (selectedHit ?? 'bid');
  const bidIsTakeProfit = takeProfitHit === 'bid';
  const askIsTakeProfit = takeProfitHit === 'ask';
  const spread = bid != null && ask != null ? spreadPips(bid, ask) : '—';
  // Rounded for display only: a strip leg's size is a float share of the
  // program and printed as 2.4198281699999997M.
  const sizeChip = `${Number.isFinite(sizeM) ? Number(sizeM.toFixed(2)) : 0}M`;
  const low = bid != null && ask != null ? bid - (ask - bid) * 8 : bid;
  const high = bid != null && ask != null ? ask + (ask - bid) * 8 : ask;
  const span = low != null && high != null ? high - low : 0;
  const mark = mid ?? bid ?? ask;
  const markPct =
    mark != null && low != null && span > 0
      ? Math.min(100, Math.max(0, ((mark - low) / span) * 100))
      : 50;
  const inst =
    instrument === 'spot' ? 'SPOT' : instrument === 'forward' ? 'FWD' : 'OPT';
  const step = sizeM >= 10 ? 1 : 0.1;

  const bidExec = hitFill?.('bid');
  const askExec = hitFill?.('ask');
  const bidPadFilled = bidExec?.filled ?? filledHit === 'bid';
  const askPadFilled = askExec?.filled ?? filledHit === 'ask';
  const filled = bidPadFilled || askPadFilled;
  // Resting/limit/OCO fills are viewOnly AND limitMode (parent ORs in
  // restFilled). A live market hit is filled without that pair — including
  // leftover limitMode, and including readOnly after the book so the
  // unfilled pad does not inherit the order sheet.
  const liveMarketFill = filled && !(viewOnly && limitMode);
  const bracketChrome = Boolean(limitMode) && !liveMarketFill;
  const showSubmitStrip =
    Boolean(limitMode && onSubmitLimitOrder && !viewOnly && !filled && submittedHit == null);
  const packageOn = armed != null && !locked;
  const readyOn = !filled && readyHit != null;
  const workingOn = !filled && submittedHit != null;
  const [leaveOpen, setLeaveOpen] = useState<HitSide | null>(null);
  const editingRate = !filled
    && (limitMode || (armed != null && rateEdited === true));
  const showBracketRole = bracketChrome || (rateEdited && !liveMarketFill);
  const sideForBid =
    (showBracketRole || bidPadFilled) && selectedSide != null
      ? selectedSide
      : orderSideForHit('bid');
  const sideForAsk =
    (showBracketRole || askPadFilled) && selectedSide != null
      ? selectedSide
      : orderSideForHit('ask');
  // A resting order names itself; only fall back to the pad convention while
  // nothing is resting on that pad. Deriving the title from the pad alone put
  // "Stop loss" above a filled take-profit.
  const padRoleIsTakeProfit = (hit: HitSide, fallback: boolean): boolean => {
    const role = bracketRoleForHit?.(hit) ?? null;
    return role != null ? role === 'takeProfit' : fallback;
  };
  // Title AND palette must come from the same authority, or a card reads
  // "Take profit" painted in stop-loss rose while its sibling does the
  // reverse. These feed both the labels below and isTakeProfit colour props.
  const bidPadIsTakeProfit = padRoleIsTakeProfit('bid', bidIsTakeProfit);
  const askPadIsTakeProfit = padRoleIsTakeProfit('ask', askIsTakeProfit);
  const bidLabel = showBracketRole && selectedSide != null
    ? `${bidPadIsTakeProfit ? 'Take profit' : 'Stop loss'} ${selectedSide} ${baseCcy}`
    : `${sideForBid} ${baseCcy}`;
  const askLabel = showBracketRole && selectedSide != null
    ? `${askPadIsTakeProfit ? 'Take profit' : 'Stop loss'} ${selectedSide} ${baseCcy}`
    : `${sideForAsk} ${baseCcy}`;

  const leaveFieldEnabled =
    leaveBlockedReason == null
    && leaveRateFieldEnabled({ locked, inputsLocked, limitMode });

  const openLeave = (hit: HitSide) => {
    if (locked) return;
    onLeave(hit);
    if (!leaveFieldEnabled) {
      setLeaveOpen(null);
      return;
    }
    setLeaveOpen(hit);
  };

  const hitPad = (hit: HitSide) => {
    if (locked) return;
    if (stripFwdBlocked) {
      onResetSpot?.();
      onArm(hit);
      setLeaveOpen(null);
      return;
    }
    if (
      onFill
      && !limitMode
      && !rateEdited
      && !viewOnly
      && armed === hit
    ) {
      onFill(hit);
      setLeaveOpen(null);
      return;
    }
    onArm(hit);
    setLeaveOpen(null);
  };

  useEffect(() => {
    // Only a finished ticket closes the rate field. `inputsLocked` also goes
    // true the moment a side is armed, and arming is exactly when the desk
    // wants to type a level — closing here made the field unopenable.
    if (locked || armed == null) {
      setLeaveOpen(null);
    }
  }, [armed, locked]);

  return (
    <div
      className={`mt-3 shrink-0 overflow-hidden rounded-lg border bg-slate-950 ${
        filled
          ? 'border-slate-700'
          : packageOn
            ? 'border-[#FF5722]'
            : 'border-slate-700'
      }`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-2.5 py-1.5">
        <span className="text-[10px] font-semibold text-rose-400">▸▸</span>
        <span className="font-mono text-[12px] font-semibold tracking-wide text-white">
          {pairSlash(pair)}
        </span>
        {stripHint && (
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-slate-400">
            {stripHint}
          </span>
        )}
        {onResetSpot && (
          instrument === 'spot' ? (
            <span
              className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-emerald-200"
              title="Whole-strip Bid/Ask is live /api/fx-spot"
            >
              Spot
            </span>
          ) : (
            <button
              type="button"
              onClick={onResetSpot}
              disabled={inputsLocked}
              title="Reset pad to live spot — whole-strip Bid/Ask cannot book a 2M/6M outright"
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide ${
                stripFwdBlocked
                  ? 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
              } disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Spot
            </button>
          )
        )}
        {filled ? (
          <span className="rounded bg-slate-700 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-white">
            Filled
            {fillAt ? ` · ${fillAt}` : ''}
            {/* Dealer and REF describe the EXECUTION: the stored
                counterparty, else the bank/quote on the executed side —
                never the typed tile, which for a bracket leg is the other
                side of the spread. */}
            {counterparty
              ? ` · ${counterparty}`
              : executedHit
                ? ` · ${executedHit === 'bid' ? bankBid : bankAsk}`
                : ''}
            {(() => {
              // The EXECUTED rate this leg booked at — not the live pad. REF
              // used to read `bid`/`ask`, which keep ticking after the fill,
              // so the header disagreed with the number under it (REF 1.16060
              // over a leg booked at 1.16026) and drifted further every beat.
              // The BOOKED rate: a spot-referenced order's fillPx is its spot
              // print, and after execution the card shows the leg's forward.
              const booked = padFillPx ?? fillPx;
              const ref =
                booked != null && Number.isFinite(booked) && booked > 0
                  ? booked
                  : null;
              return ref != null ? ` · REF ${fmtPx(ref)}` : '';
            })()}
          </span>
        ) : workingOn ? (
          <span className="rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-sky-200">
            {/* Direction is the TICKET's side — orderSideForHit(pad) is the
                market convention applied to the typed tile, which read
                "Sell · working" over a working Buy take-profit. */}
            {(selectedSide ?? orderSideForHit(submittedHit)) } · working
          </span>
        ) : readyOn ? (
          <>
            <span className="rounded bg-[#FF5722] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-white">
              {armed ?? readyHit}
              {readyAllLegs
                ? ' · all legs'
                : readyLegLabel
                  ? ` · ${readyLegLabel}`
                  : ''}
              {' · ready'}
            </span>
            <button
              type="button"
              onClick={onCancelReady}
              title="Esc — leave ready-to-execute"
              className="shrink-0 rounded border border-[#FF5722] bg-[#FF5722] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-white hover:bg-[#E64A19]"
            >
              Esc to exit
            </button>
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {(!limitMode || liveMarketFill) && (
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-200">
              {bankBid}
              <span className="mx-1 text-slate-600">/</span>
              {bankAsk}
            </span>
          )}
        <button
          type="button"
          onClick={onToggleTape}
          title={
            tapeOn
              ? 'Simulated ticks on — up green, down red. Click to pause.'
              : 'Start simulated bid/ask ticks'
          }
          aria-pressed={tapeOn}
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${
            tapeOn
              ? flash === 'up'
                ? 'bg-emerald-500/20 text-emerald-200'
                : flash === 'down'
                  ? 'bg-rose-500/20 text-rose-200'
                  : 'bg-slate-800 text-slate-300'
              : 'text-slate-600 hover:bg-slate-800 hover:text-slate-300'
          }`}
        >
          Tape
        </button>
        <button
          type="button"
          onClick={onToggleMenu}
          disabled={inputsLocked}
          title="Configure tile"
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
            menuOpen
              ? 'bg-sky-500/20 text-sky-100'
              : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
          } disabled:cursor-not-allowed disabled:opacity-40`}
        >
          ≡
        </button>
        </div>
      </div>

      <div className="p-1.5">
      <div
      title={
        stripFwdBlocked
          ? 'Whole-strip Bid/Ask cannot book a FWD outright — switching to live spot'
          : undefined
      }
      className={`relative grid grid-cols-2 overflow-hidden rounded-md border-2 border-black bg-black ${
        liveMarketFill
          ? instrument === 'option'
            ? 'h-[16rem] grid-rows-[16rem]'
            : 'h-[13rem] grid-rows-[13rem]'
          : filled || viewOnly
            ? 'h-auto items-stretch'
            : limitMode
              ? instrument === 'option'
                ? 'h-[24rem] grid-rows-[24rem]'
                : 'h-[22rem] grid-rows-[22rem]'
              : instrument === 'option'
                ? 'h-[16rem] grid-rows-[16rem]'
                : 'h-[13rem] grid-rows-[13rem]'
      }`}>
        {showSubmitStrip && (
          <div className="pointer-events-none absolute inset-x-0 bottom-1.5 z-30 flex items-end justify-center">
            <div className="pointer-events-auto flex overflow-hidden rounded border-2 border-black divide-x-2 divide-black">
            {(
              takeProfitHit === 'ask'
                ? (['stopLoss', 'oco', 'takeProfit'] as const)
                : (['takeProfit', 'oco', 'stopLoss'] as const)
            ).map(orderType => {
              const label =
                orderType === 'takeProfit'
                  ? 'SUBMIT TP ORDER'
                  : orderType === 'stopLoss'
                    ? 'SUBMIT SL ORDER'
                    : 'SUBMIT OCO';
              // Uses the OUTER takeProfitHit (flip-aware, defined above for
              // the tile labels) — a shadowing unflipped local here let this
              // disagree with the labels whenever limitOrderType ===
              // 'stopLoss' (i.e. always, when armed on ask — see onLeave),
              // so the button clicked could submit the opposite bracketRole
              // from what was shown, and validBracket would see numbers
              // that looked backwards and refuse to enable anything.
              const stopLossHit: HitSide = takeProfitHit === 'bid' ? 'ask' : 'bid';
              const submitHit = orderType === 'takeProfit' ? takeProfitHit : stopLossHit;
              const canSubmit = orderType === 'oco'
                ? orderRates.bid.trim() !== '' && orderRates.ask.trim() !== ''
                : orderRates[submitHit].trim() !== '';
              const profitRate = Number(orderRates[takeProfitHit]);
              const lossRate = Number(orderRates[stopLossHit]);
              // Side-aware: hitting the bid sells, so its take profit is the
              // LOWER level, not the higher one — see bracketRoleFor.
              const validBracket = Number.isFinite(profitRate)
                && Number.isFinite(lossRate)
                && bracketRoleFor(takeProfitHit, profitRate, lossRate) === 'takeProfit';
              const bracketSide = limitOrderSideForHit(takeProfitHit);
              // Each leg is validated against its OWN live market level — TP
              // must be better than the current best of bid/ask, SL must be
              // worse. A leg that fails disables only that leg's button (and
              // OCO, which needs both); the other single-leg button stays up.
              const tpCheck =
                restsAwayFromMarket == null
                  ? null
                  : (restsAwayFromMarket(
                      takeProfitHit,
                      orderRates[takeProfitHit],
                      'takeProfit',
                      bracketSide,
                    )
                      ? 'ok'
                      : 'invalid');
              const slCheck =
                restsAwayFromMarket == null
                  ? null
                  : (restsAwayFromMarket(
                      stopLossHit,
                      orderRates[stopLossHit],
                      'stopLoss',
                      bracketSide,
                    )
                      ? 'ok'
                      : 'invalid');
              const tpOk = tpCheck !== 'invalid';
              const slOk = slCheck !== 'invalid';
              const restsOk = orderType === 'oco' ? tpOk && slOk : orderType === 'takeProfit' ? tpOk : slOk;
              const disabledReason = viewOnly
                ? 'View only'
                : submittedHit != null
                  ? 'Already submitted'
                  : !canSubmit
                    ? 'Type a level first'
                    : orderType === 'oco' && !validBracket
                      ? 'TP must be the favorable level vs SL for this side'
                      : !restsOk
                        ? orderType === 'oco'
                          ? 'Both legs must rest on the correct side of the live quote'
                          : 'That level is on the wrong side of (or through) the live quote'
                        : undefined;
              return (
                <button
                  key={orderType}
                  type="button"
                  title={disabledReason}
                  disabled={
                    viewOnly
                    || !canSubmit
                    || !restsOk
                    || (orderType === 'oco' && !validBracket)
                    || submittedHit != null
                  }
                  onClick={() => onSubmitLimitOrder?.(orderType)}
                  className="min-w-0 whitespace-nowrap bg-[#FF5722] px-1.5 py-1.5 text-[11px] font-semibold leading-tight text-white hover:bg-[#E64A19] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300 disabled:hover:bg-slate-700 sm:px-2 sm:text-[12px]"
                >
                  {label}
                </button>
              );
            })}
            </div>
          </div>
        )}
        {!filled && !viewOnly && !showSubmitStrip && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2">
          <div className="flex flex-col items-center gap-1">
            <div className="flex gap-1">
              <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
                {sizeChip}
              </span>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
                {sizeChip}
              </span>
            </div>
          </div>
        </div>
        )}
        {!editingRate && !filled && !viewOnly && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="-translate-y-2 rounded border-2 border-black bg-slate-900 px-2 py-1 font-mono text-xs font-bold tabular-nums text-yellow-400">
              {spread}
            </span>
          </div>
        )}

        {(() => {
          // Bid stays left, ask stays right — same as the live quote.
          // Reordering by which typed level is numerically lower made TP/SL
          // jump sides the moment backspace left a partial or empty rate.
          const bidTile = (
            <HitPad
              key="bid"
              label={bidLabel}
              side={sideForBid}
              isTakeProfit={bidPadIsTakeProfit}
              optionType={optionPut == null ? null : optionPut ? 'Put' : 'Call'}
              bank={bidPadFilled ? (counterparty ?? bankBid) : bankBid}
              parts={bidParts}
              hit="bid"
              on={armed === 'bid'}
              filled={bidPadFilled}
              fillPx={
                bidPadFilled
                  ? (padFillPx ?? bidExec?.px ?? (filledHit === 'bid' ? fillPx : null))
                  : null
              }
              fillRole={
                bidExec != null
                  ? bidExec.role
                  : filledHit === 'bid'
                    ? fillRole
                    : null
              }
              fillAt={
                bidExec != null
                  ? bidExec.at
                  : filledHit === 'bid'
                    ? fillAt
                    : null
              }
              disabled={locked}
              onClick={() => hitPad('bid')}
              onCancelLive={
                !viewOnly && !filled && (limitMode || !rateEdited)
                  ? onCancelReady
                  : undefined
              }
              premiumUsd={instrument === 'option' ? premiumBid : null}
              optionQuote={instrument === 'option' ? optionQuoteBid : null}
              flash={flash}
              rate={orderRates.bid}
              referenceRate={bid}
              referenceLabel={referenceLabel}
              referenceMarket={referenceStopLoss}
              onReferenceMarketChange={enabled => onReferenceStopLossChange('bid', enabled)}
              limitMode={bracketChrome}
              rateEdited={rateEdited}
              onRateChange={locked ? undefined : value => onOrderRateForHit('bid', value)}
              viewOnly={viewOnly && !liveMarketFill}
              tileFilled={filled}
              confirmed={
                bidExec != null
                  ? bidExec.cancelled
                  : confirmedSides.includes('bid')
              }
              orderPanel={orderPanelFor?.('bid')}
              onSubmit={onSubmitSide ? () => onSubmitSide('bid') : undefined}
              submitLabel={submitLabelFor?.('bid') ?? 'Submit'}
            />
          );
          const askTile = (
            <HitPad
              key="ask"
              label={askLabel}
              side={sideForAsk}
              isTakeProfit={askPadIsTakeProfit}
              optionType={optionPut == null ? null : optionPut ? 'Put' : 'Call'}
              bank={askPadFilled ? (counterparty ?? bankAsk) : bankAsk}
              parts={askParts}
              hit="ask"
              on={armed === 'ask'}
              filled={askPadFilled}
              fillPx={
                askPadFilled
                  ? (padFillPx ?? askExec?.px ?? (filledHit === 'ask' ? fillPx : null))
                  : null
              }
              fillRole={
                askExec != null
                  ? askExec.role
                  : filledHit === 'ask'
                    ? fillRole
                    : null
              }
              fillAt={
                askExec != null
                  ? askExec.at
                  : filledHit === 'ask'
                    ? fillAt
                    : null
              }
              disabled={locked}
              onClick={() => hitPad('ask')}
              onCancelLive={
                !viewOnly && !filled && (limitMode || !rateEdited)
                  ? onCancelReady
                  : undefined
              }
              align="right"
              premiumUsd={instrument === 'option' ? premiumAsk : null}
              optionQuote={instrument === 'option' ? optionQuoteAsk : null}
              flash={flash}
              rate={orderRates.ask}
              referenceRate={ask}
              referenceLabel={referenceLabel}
              referenceMarket={referenceStopLoss}
              onReferenceMarketChange={enabled => onReferenceStopLossChange('ask', enabled)}
              limitMode={bracketChrome}
              rateEdited={rateEdited}
              onRateChange={locked ? undefined : value => onOrderRateForHit('ask', value)}
              viewOnly={viewOnly && !liveMarketFill}
              tileFilled={filled}
              confirmed={
                askExec != null
                  ? askExec.cancelled
                  : confirmedSides.includes('ask')
              }
              orderPanel={orderPanelFor?.('ask')}
              onSubmit={onSubmitSide ? () => onSubmitSide('ask') : undefined}
              submitLabel={submitLabelFor?.('ask') ?? 'Submit'}
            />
          );
          return <>{bidTile}{askTile}</>;
        })()}
      </div>
      </div>

      <div className="border-t border-slate-800 px-2.5 py-1.5">
        <div className="flex items-center gap-2 font-mono text-[9px] tabular-nums text-slate-500">
          <span>{low != null ? fmtPx(low) : '—'}</span>
          <div className="relative h-1.5 flex-1 rounded-sm bg-slate-800">
            <div className="absolute inset-y-0 left-0 rounded-sm bg-slate-600" style={{ width: `${markPct}%` }} />
            <div
              className={`absolute top-1/2 h-0 w-0 -translate-x-1/2 -translate-y-1/2 border-x-4 border-b-[6px] border-x-transparent ${
                flash === 'up'
                  ? 'border-b-emerald-400'
                  : flash === 'down'
                    ? 'border-b-rose-400'
                    : 'border-b-white'
              }`}
              style={{ left: `${markPct}%` }}
            />
          </div>
          <span>{high != null ? fmtPx(high) : '—'}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[10px]">
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[8px] text-slate-500">
              {instrument === 'spot' ? 'SP' : instrument === 'forward' ? 'SW' : 'Ω'}
            </span>
            <span className="font-semibold uppercase tracking-wide text-slate-300">{inst}</span>
          </span>
          {instrument === 'option' ? (
            <OptionContractBar
              put={optionPut !== false}
              disabled={inputsLocked || onOptionPut == null}
              onPut={onOptionPut}
            />
          ) : null}
          <TenorDateField
            instrument={instrument}
            tenor={tenor}
            settleIso={settleIso}
            tenorDisplay={tenorDisplay}
            disabled={inputsLocked}
            disableSpot={disableSpotTenor}
            onTenor={onTenor}
            onSettleIso={onSettleIso}
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5 border-t border-slate-800 px-2 py-1.5">
        <LeaveRateButton
          blockedTitle={leaveBlockedReason}
          hit="bid"
          open={leaveOpen === 'bid'}
          onOpenChange={open => (open ? openLeave('bid') : setLeaveOpen(null))}
          disabled={!leaveFieldEnabled}
          inputsLocked={locked}
          selected={limitMode && armed === 'bid'}
          isTakeProfit={bidPadIsTakeProfit}
          filled={filledHit === 'bid'}
          orderRate={orderRate}
          onOrderRate={onOrderRate}
        />
        <span className="font-mono text-[11px] font-semibold text-sky-300">
          {baseCcy === 'USD' ? 'USD' : baseCcy}
        </span>
        <div className="flex min-w-0 flex-1 gap-1.5">
          <div
            className={`flex min-w-0 flex-1 items-center rounded border bg-slate-900 ${
              strikeLocked
                ? 'border-slate-700'
                : 'border-violet-500/40'
            } ${inputsLocked || strikeLocked ? 'opacity-50' : ''}`}
            title={
              strikeLocked
                ? instrument === 'spot'
                  ? 'Strike is ATMS in Spot mode'
                  : 'Strike is ATMF in Forward / Swap mode'
                : 'Strike · type a rate or pick ATMF / Δ'
            }
          >
            <StrikeSelect
              value={strikeInput}
              onChange={onStrikeInput}
              embedded
              disabled={inputsLocked || strikeLocked}
            />
            <Input
              type="text"
              inputMode="decimal"
              aria-label="Strike"
              placeholder="1.16143"
              value={strikeInput}
              disabled={inputsLocked || strikeLocked}
              onChange={ev => onStrikeInput(ev.target.value)}
              className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-right text-[12px] tabular-nums text-violet-100 focus:border-0 disabled:cursor-not-allowed"
            />
          </div>
          <div
            className={`flex min-w-0 flex-1 items-center rounded border border-slate-700 bg-slate-900 ${
              inputsLocked ? 'opacity-50' : ''
            }`}
          >
            <Input
              type="text"
              inputMode="numeric"
              aria-label="Notional"
              value={fmtUnits(sizeM)}
              disabled={inputsLocked}
              onChange={ev => {
                const n = Number(String(ev.target.value).replace(/,/g, ''));
                if (Number.isFinite(n)) onSizeM(Math.round((n / 1_000_000) * 100) / 100);
              }}
              className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-right text-[12px] tabular-nums text-white focus:border-0 disabled:cursor-not-allowed"
            />
            <div className="flex flex-col border-l border-slate-800">
              <button
                type="button"
                aria-label="Increase size"
                disabled={inputsLocked}
                onClick={() => onSizeM(Math.round((sizeM + step) * 100) / 100)}
                className="px-1.5 text-[9px] leading-none text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                ▲
              </button>
              <button
                type="button"
                aria-label="Decrease size"
                disabled={inputsLocked}
                onClick={() => onSizeM(Math.max(0, Math.round((sizeM - step) * 100) / 100))}
                className="px-1.5 text-[9px] leading-none text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                ▼
              </button>
            </div>
          </div>
        </div>
        <LeaveRateButton
          blockedTitle={leaveBlockedReason}
          hit="ask"
          open={leaveOpen === 'ask'}
          onOpenChange={open => (open ? openLeave('ask') : setLeaveOpen(null))}
          disabled={!leaveFieldEnabled}
          inputsLocked={locked}
          selected={limitMode && armed === 'ask'}
          isTakeProfit={askPadIsTakeProfit}
          filled={filledHit === 'ask'}
          orderRate={orderRate}
          onOrderRate={onOrderRate}
        />
      </div>
      <p className="px-2.5 pb-2 font-mono text-[9px] text-slate-600">
        {tapeOn ? `${source} · Tape` : source}
      </p>
    </div>
  );
}

function LeaveRateButton({
  hit,
  isTakeProfit,
  open,
  onOpenChange,
  disabled,
  inputsLocked,
  selected,
  filled,
  orderRate,
  onOrderRate,
  blockedTitle = null,
}: {
  hit: HitSide;
  isTakeProfit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  inputsLocked: boolean;
  selected: boolean;
  filled: boolean;
  orderRate: string;
  onOrderRate: (v: string) => void;
  blockedTitle?: string | null;
}) {
  const bid = hit === 'bid';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onOpenChange(true)}
      title={blockedTitle ?? (isTakeProfit ? 'Edit take profit' : 'Edit stop loss')}
      className={`rounded border px-2 py-1 text-[10px] font-semibold ${
        selected || open
          ? HIT_CHIP_ON
          : filled
            ? 'border-slate-600 bg-slate-700 text-white'
            : isTakeProfit
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
      } disabled:cursor-not-allowed ${
        disabled && !(filled || selected || open) ? 'opacity-40' : ''
      }`}
    >
      {bid ? 'BID' : 'ASK'}
    </button>
  );
}

function StrikeSelect({
  value,
  onChange,
  embedded = false,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  embedded?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shortcut = STRIKE_SHORTCUTS.find(opt => strikeShortcutActive(value, opt));
  const shown = embedded
    ? shortcut
      ? strikeChipLabel(shortcut)
      : 'K'
    : strikeChipLabel(value) || value || 'ATMF';
  return (
    <Popover
      open={open && !disabled}
      onOpenChange={next => {
        if (!disabled) setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Strike shortcut"
          title="Strike · ATMF / ATM / 25Δ"
          className={
            embedded
              ? 'h-7 shrink-0 rounded-none border-0 border-r border-violet-500/30 bg-transparent px-1.5 font-mono text-[11px] text-violet-100 hover:bg-violet-500/10 disabled:cursor-not-allowed'
              : 'h-7 w-[4.75rem] shrink-0 rounded-md border border-violet-500/40 bg-slate-900 px-1.5 font-mono text-[11px] text-violet-100 hover:border-violet-400 disabled:cursor-not-allowed disabled:opacity-50'
          }
        >
          {shown}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1.5">
        <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
          Strike
        </div>
        <div className="flex flex-col gap-0.5">
          {STRIKE_SHORTCUTS.map(opt => {
            const on = strikeShortcutActive(value, opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`rounded px-2 py-1 text-left font-mono text-[11px] ${
                  on
                    ? 'bg-violet-500/25 text-violet-100'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {strikeChipLabel(opt)}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function fmtOptionMetric(
  n: number | null | undefined,
  digits: number,
  suffix = '',
): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `${n.toFixed(digits)}${suffix}`;
}

function OptionPricingMetrics({
  quote,
  align = 'end',
  compact = false,
}: {
  quote: HedgeIpaQuote | null | undefined;
  align?: 'start' | 'end';
  compact?: boolean;
}) {
  if (!quote) return null;
  const cells: { k: string; v: string; title: string }[] = [];
  const prem = fmtOptionMetric(quote.premiumPercent, 3, '%');
  if (prem) cells.push({ k: 'Prem', v: prem, title: 'Premium as % of spot' });
  const vol = fmtOptionMetric(quote.impliedVolPercent, 2, '%');
  if (vol) {
    const atm = fmtOptionMetric(quote.atmVolPercent, 2, '%');
    cells.push({
      k: 'Vol',
      v: vol,
      title: atm ? `Implied vol · ATM ${atm}` : 'Implied vol',
    });
  }
  const dlt = fmtOptionMetric(quote.deltaPercent, 1);
  if (dlt) cells.push({ k: 'Δ', v: dlt, title: 'Delta' });
  const gma = fmtOptionMetric(quote.gammaPercent, 2);
  if (gma) cells.push({ k: 'Γ', v: gma, title: 'Delta points per 1% spot move' });
  const vega = fmtOptionMetric(quote.vegaPercent, 3);
  if (vega) cells.push({ k: 'ν', v: vega, title: 'Premium % of spot per vol point' });
  const tht = fmtOptionMetric(quote.thetaPercent, 4);
  if (tht) cells.push({ k: 'Θ', v: tht, title: 'Premium % of spot per calendar day' });
  if (!compact) {
    const vanna = fmtOptionMetric(quote.vannaPercent, 3);
    if (vanna) cells.push({ k: 'Va', v: vanna, title: 'Delta points per vol point' });
    const volga = fmtOptionMetric(quote.volgaPercent, 4);
    if (volga) cells.push({ k: 'Vo', v: volga, title: 'Vega change per vol point' });
  }
  if (cells.length === 0) return null;
  return (
    <dl
      className={`mt-1.5 grid w-full grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[9px] font-medium normal-case tabular-nums tracking-normal ${
        align === 'start' ? 'text-left' : 'text-right'
      }`}
    >
      {cells.map(c => (
        <div
          key={c.k}
          className="flex min-w-0 items-baseline justify-between gap-1"
          title={c.title}
        >
          <dt className="text-slate-500">{c.k}</dt>
          <dd className="truncate text-slate-200">{c.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function blendStripOptionQuote(
  quotes: readonly {
    quoteBid?: HedgeIpaQuote | null;
    quoteAsk?: HedgeIpaQuote | null;
  }[],
  rows: readonly { sizeM: number }[],
  side: HitSide,
): HedgeIpaQuote | null {
  const sized = quotes
    .map((q, i) => ({
      quote: side === 'ask' ? q.quoteAsk : q.quoteBid,
      w: Math.abs(rows[i]?.sizeM ?? 0),
    }))
    .filter(
      (x): x is { quote: HedgeIpaQuote; w: number } =>
        x.quote != null && x.w > 0,
    );
  if (sized.length === 0) return null;
  const avg = (pick: (q: HedgeIpaQuote) => number | null | undefined) => {
    let s = 0;
    let w = 0;
    for (const x of sized) {
      const v = pick(x.quote);
      if (v == null || !Number.isFinite(v)) continue;
      s += v * x.w;
      w += x.w;
    }
    return w > 0 ? s / w : null;
  };
  const first = sized[0].quote;
  return {
    strike: first.strike,
    strikeInput: first.strikeInput,
    premiumUsd: sized.reduce((s, x) => s + (x.quote.premiumUsd ?? 0), 0),
    premiumPercent: avg(q => q.premiumPercent),
    fxSpot: first.fxSpot,
    fxOutright: first.fxOutright,
    atmVolPercent: avg(q => q.atmVolPercent),
    impliedVolPercent: avg(q => q.impliedVolPercent),
    deltaPercent: avg(q => q.deltaPercent),
    gammaPercent: avg(q => q.gammaPercent ?? null),
    vegaPercent: avg(q => q.vegaPercent ?? null),
    thetaPercent: avg(q => q.thetaPercent ?? null),
    vannaPercent: avg(q => q.vannaPercent ?? null),
    volgaPercent: avg(q => q.volgaPercent ?? null),
  };
}

function HitPad({
  label,
  side,
  isTakeProfit,
  referenceRate,
  referenceLabel = null,
  referenceMarket,
  onReferenceMarketChange,
  optionType,
  bank,
  parts,
  hit,
  on,
  filled,
  fillPx = null,
  fillRole = null,
  fillAt = null,
  disabled,
  onClick,
  onCancelLive,
  align,
  premiumUsd,
  optionQuote = null,
  flash = null,
  rate,
  limitMode,
  rateEdited,
  onRateChange,
  viewOnly = false,
  tileFilled = false,
  confirmed = false,
  orderPanel,
  onSubmit,
  submitLabel = 'Submit',
}: {
  label: string;
  /** Direction selected for this ticket; both bracket legs use the same side. */
  side: 'Buy' | 'Sell';
  isTakeProfit: boolean;
  referenceRate?: number | null;
  /** "3M outright" / "spot" — disambiguates LIVE REF's convention on sight. */
  referenceLabel?: string | null;
  referenceMarket?: boolean;
  onReferenceMarketChange?: (enabled: boolean) => void;
  optionType?: 'Put' | 'Call' | null;
  bank: string;
  parts: { big: string; lead: string; pips: string };
  hit: HitSide;
  on: boolean;
  filled: boolean;
  fillPx?: number | null;
  fillRole?: 'TP' | 'SL' | 'LIMIT' | null;
  fillAt?: string | null;
  disabled: boolean;
  onClick: () => void;
  /**
   * Exit without placing — live Bid/Ask ready-to-fill, or SL/TP/OCO
   * submission (limit) mode. Same corners and chrome either way.
   */
  onCancelLive?: () => void;
  align?: 'right';
  premiumUsd?: number | null;
  optionQuote?: HedgeIpaQuote | null;
  flash?: TickDir | null;
  /** Rate string shown in place of the quote once this side is armed. */
  rate?: string;
  limitMode?: boolean;
  rateEdited?: boolean;
  onRateChange?: (v: string) => void;
  /**
   * Opened just to look — show the level and its detail panel (LIVE REF,
   * SIDE/NOTIONAL/...), same as while editing, but as static text: no
   * input, no "Reference live" toggle. Without this, an order with no
   * `onRateChange` falls through to the live-quote big-figure/pips display
   * instead — the wrong thing to show for an order that already has a
   * fixed level.
   */
  viewOnly?: boolean;
  /** The other pad on this tile filled — mute this side's live quote. */
  tileFilled?: boolean;
  /** Parameters accepted — an order is confirmed on this bracket role. */
  confirmed?: boolean;
  /** Order-placement parameters, shown under the level while pricing. */
  orderPanel?: ReactNode;
  /** Sends THIS side. Rendered full-width at the foot of the card. */
  onSubmit?: () => void;
  submitLabel?: string;
}) {
  // Only color by take-profit/stop-loss role inside an actual bracket
  // context (limitMode) — isTakeProfit defaults to a fixed side when
  // nothing is armed yet, so coloring the idle live-quote ticker by it
  // outside limitMode paints a TP/SL palette onto a plain market quote that
  // has no such role at all.
  const restPip = limitMode
    ? (isTakeProfit ? 'text-emerald-400' : 'text-rose-400')
    : 'text-slate-100';
  const restFig = limitMode
    ? (isTakeProfit ? 'text-emerald-200/80' : 'text-rose-200/80')
    : 'text-slate-300/80';
  // Orange wash is armed / in-flight only. Filled stays hot for white type
  // on the grey pad — not for the vermillion execution color.
  const hot = on || filled || confirmed;
  const fullLabel = optionType ? `${label} ${optionType}` : label;
  const pipClass = hot
    ? 'text-white'
    : flash === 'up'
      ? 'text-emerald-400'
      : flash === 'down'
        ? 'text-rose-400'
        : restPip;
  const figClass = hot
    ? 'text-white'
    : flash === 'up'
      ? 'text-emerald-100'
      : flash === 'down'
        ? 'text-rose-100'
        : restFig;
  // In bracket (limitMode) UI both legs must be editable at once — that's
  // the whole point of showing an OCO pair side by side. Gating this on
  // `on` (the single armed side) forces the OTHER leg into the live-quote
  // ticker branch below instead of its own level, which is the wrong thing
  // to show for a leg that already has (or is getting) a real order level.
  // Resting/limit/OCO fills keep the grey order sheet. Live market hits stay
  // on the pip-split HitPad — do not swap that chrome for a blotter.
  const showOrderParams =
    Boolean(orderPanel) && Boolean(limitMode) && (!filled || viewOnly);
  const liveFillChrome = filled && !showOrderParams;
  const showOrderSheet =
    !liveFillChrome
    && (viewOnly || filled || onRateChange != null)
    && (limitMode || viewOnly || filled || (on && rateEdited === true));
  const editing = showOrderSheet && !filled;
  // Set once the desk types a stop level here; the sheet closing resets it,
  // so the "Reference live" toggle is back the next time the pad opens.
  const [stopLevelTyped, setStopLevelTyped] = useState(false);
  useEffect(() => {
    if (!showOrderSheet) setStopLevelTyped(false);
  }, [showOrderSheet]);
  const roleWash = side === 'Buy'
    ? 'bg-emerald-600 hover:bg-emerald-600 disabled:hover:bg-emerald-600'
    : 'bg-rose-600 hover:bg-rose-600 disabled:hover:bg-rose-600';
  // `on` (armed for THIS click) must win over `confirmed` (some order
  // already rests on this side) — confirmed is a resting-state background,
  // not a veto on the transient arm highlight. With confirmed checked
  // first, a strip carrying any resting bracket painted BOTH main pads
  // permanently rose/emerald and clicking to arm one showed no orange at
  // all — the common "click to select" feedback every other pad in the
  // app gives disappeared exactly where a bracket happened to be resting.
  const wash = liveFillChrome
    ? 'bg-slate-700 hover:bg-slate-700 disabled:hover:bg-slate-700'
    : tileFilled
      ? 'bg-slate-800 hover:bg-slate-800 disabled:hover:bg-slate-800'
      : showOrderSheet
        ? 'bg-slate-600 hover:bg-slate-600 disabled:hover:bg-slate-600'
        : on
          ? 'bg-[#FF5722] hover:bg-[#FF5722] disabled:hover:bg-[#FF5722]'
          : confirmed
            ? roleWash
            : flash === 'up'
              ? 'bg-emerald-500/10 hover:bg-emerald-500/20 disabled:hover:bg-emerald-500/10'
              : flash === 'down'
                ? 'bg-rose-500/10 hover:bg-rose-500/20 disabled:hover:bg-rose-500/10'
                : 'bg-black hover:bg-white/[0.06] disabled:hover:bg-black';
  const towardCenter = align === 'right' ? 'text-left' : 'text-right';
  const towardCenterItems = align === 'right' ? 'items-start' : 'items-end';
  const towardCenterJustify = align === 'right' ? 'justify-start' : 'justify-end';
  const showPadBank = !limitMode || liveFillChrome;
  const filledPx =
    filled && fillPx != null && Number.isFinite(fillPx) ? fmtPx(fillPx) : null;
  /**
   * A filled tile is a record of one execution, so it shows that execution and
   * nothing else. The side that traded shows its stored rate; the other side
   * has no historical value to show — the counter-side quote as of the fill is
   * not recorded anywhere (HedgeIpaQuote keeps fxSpot and fxOutright, not a
   * bid/ask pair) — and the live quote that used to sit there read as part of
   * the execution. On one real 8M leg it showed the live SPOT, 78 pips from
   * the booked outright beside it, as if the two were a spread.
   */
  const counterSideOfFill = Boolean(tileFilled) && !filled;
  const displayParts =
    liveFillChrome && fillPx != null && Number.isFinite(fillPx)
      ? splitFxPips(fillPx)
      : parts;
  const rateColor = limitMode
    ? (isTakeProfit ? 'text-emerald-300' : 'text-rose-300')
    : 'text-white';
  const option =
    (premiumUsd != null && Number.isFinite(premiumUsd))
    || (optionQuote?.premiumUsd != null && Number.isFinite(optionQuote.premiumUsd));
  const optionPremUsd =
    premiumUsd != null && Number.isFinite(premiumUsd)
      ? premiumUsd
      : optionQuote?.premiumUsd ?? null;
  const metricsAlign = align === 'right' ? 'start' : 'end';
  const joinEdge =
    align === 'right' ? 'rounded-none' : 'rounded-none border-r-2 border-black';
  // Orange Bid/Ask ready-to-fill, or dual SL/TP submission pads —
  // Cancel exits without placing (same handler / corners either way).
  const liveArmed =
    on && !limitMode && !rateEdited && !filled && !viewOnly && onCancelLive != null;
  const limitCancel =
    Boolean(limitMode) && !filled && !viewOnly && onCancelLive != null;
  const showCancel = liveArmed || limitCancel;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled && (!editing || (on && !limitMode && !rateEdited))) onClick();
      }}
      onKeyDown={e => {
        if (disabled || (editing && !(on && !limitMode && !rateEdited))) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      title={
        filled
          ? `${fullLabel} · filled${fillRole ? ` · ${fillRole}` : ''}${fillAt ? ` · ${fillAt}` : ''}`
          : on && !limitMode && !rateEdited
            ? `${fullLabel} · ${hit} — ready, click again to fill, Esc to exit`
            : on
            ? `${fullLabel} · ${hit} — type your level here, then Submit`
            : `${fullLabel} · ${hit} — click to select`
      }
      className={`relative z-[1] flex h-full min-h-0 flex-col overflow-hidden uppercase ${
        limitMode && !viewOnly && !filled ? 'pb-16 pt-5' : 'pb-5 pt-6'
      } transition-colors duration-200 disabled:cursor-not-allowed ${joinEdge} ${
        disabled && !hot && !viewOnly && !filled ? 'opacity-50' : ''
      } ${
        tileFilled && !filled ? 'opacity-60' : ''
      } ${
        showOrderSheet
          ? `${towardCenterItems} ${align === 'right' ? 'pl-5 pr-6' : 'pl-6 pr-5'}`
          : align === 'right' ? 'items-end pl-5 pr-6' : 'items-start pl-6 pr-5'
      } ${wash}`}
    >
      {showCancel && (
        <button
          type="button"
          title={
            limitCancel
              ? 'Esc — leave SL/TP placement'
              : 'Esc — leave ready-to-execute'
          }
          onClick={e => {
            e.stopPropagation();
            onCancelLive?.();
          }}
          onKeyDown={e => e.stopPropagation()}
          className={`absolute top-1.5 z-20 rounded border border-white/50 bg-black/45 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-white hover:bg-black/65 ${
            align === 'right' ? 'right-1.5' : 'left-1.5'
          }`}
        >
          Cancel
        </button>
      )}
      <span className={`relative z-[3] w-full shrink-0 text-xs font-semibold leading-tight ${towardCenter} ${hot || liveFillChrome ? 'text-white' : 'text-slate-200'}`}>
        {fullLabel}
      </span>
      {/* Fill detail lives in the header chip — an extra row here would push
          this tile's price out of line with the other one. */}
      {showPadBank && (
        <span
          className={`mt-0.5 w-full shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide ${towardCenter} ${
            hot ? 'text-white/90' : 'text-sky-300'
          }`}
        >
          {bank}
        </span>
      )}
      {showOrderSheet ? (
        <div className={`mt-1.5 flex w-full min-h-0 flex-col ${viewOnly || filled ? '' : 'flex-1'} ${filled || viewOnly ? towardCenterItems : ''} ${towardCenter}`}>
          {/* The slot is always rendered, even with nothing in it. The two
              pads sit side by side and this block is 28px tall (h-6 + mb-1),
              so dropping it on the pad without a badge pushed that pad's
              LIVE REF, its big rate and every row beneath it 28px above its
              neighbour's — the two cards read as one misaligned grid. Equal
              row COUNTS cannot fix that; the offset is above the rows. */}
          <div
            className={`mb-1 flex h-6 w-full shrink-0 items-center ${towardCenterJustify}`}
            aria-hidden={!(filled || confirmed)}
          >
            {filled ? (
              <span className="max-w-full truncate rounded bg-black/35 px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wide text-white">
                Filled{fillRole ? ` · ${fillRole}` : ''}
                {fillAt ? ` · ${fillAt}` : ''}
              </span>
            ) : confirmed ? (
              <span className="max-w-full truncate rounded bg-black/35 px-1.5 py-0.5 font-mono text-[11px] font-bold tracking-wide text-white/80">
                Cancelled · OCO
              </span>
            ) : null}
          </div>
          <div
            className={`mb-1 w-full shrink-0 text-[12px] font-mono leading-[15px] tabular-nums text-sky-200/90 ${towardCenter}`}
          >
            LIVE REF {referenceRate != null ? fmtPx(referenceRate) : '—'}
            {referenceLabel ? (
              <span className="ml-1 normal-case text-slate-500">
                · {referenceLabel}
              </span>
            ) : null}
          </div>
          {viewOnly || filled ? (
            <div
              className={`w-full shrink-0 font-mono text-3xl font-bold leading-none tabular-nums ${rateColor} ${towardCenter}`}
            >
              {filledPx
                ?? (rate && rate.trim() !== ''
                  // Static card: the same format as every other rate — the
                  // raw typed "1.14" beside a Limit row reading 1.14000.
                  ? (Number.isFinite(Number(rate)) && Number(rate) > 0 ? fmtPx(Number(rate)) : rate)
                  : '—')}
            </div>
          ) : (
            <input
              autoFocus
              inputMode="decimal"
              aria-label={`${fullLabel} rate`}
              value={rate ?? ''}
              onChange={ev => {
                // Typing a stop level takes it off the live reference —
                // which would otherwise overwrite it on the next tick — and
                // retires the "Reference live" toggle for this sheet.
                if (!isTakeProfit && onReferenceMarketChange) {
                  setStopLevelTyped(true);
                  if (referenceMarket) onReferenceMarketChange(false);
                }
                onRateChange?.(ev.target.value);
              }}
              onClick={ev => ev.stopPropagation()}
              onKeyDown={ev => {
                ev.stopPropagation();
              }}
              className={`w-full shrink-0 border-0 !bg-slate-600 p-0 font-mono text-3xl font-bold leading-none tabular-nums ${rateColor} outline-none ring-0 placeholder:text-white/30 focus:outline-none ${towardCenter}`}
              placeholder="0.0000"
            />
          )}
          {/* Fixed-height row on both pads so TP (no toggle) keeps the
              details separator aligned with SL instead of leaving a hole. */}
          {!viewOnly && !filled && onReferenceMarketChange && (
            <div
              className={`mt-1.5 flex h-4 shrink-0 items-center ${
                align === 'right' ? 'justify-start' : 'justify-end'
              }`}
            >
              {!isTakeProfit && !stopLevelTyped ? (
                <label className="flex items-center gap-1.5 text-[10px] text-slate-200">
                  <input
                    type="checkbox"
                    checked={referenceMarket === true}
                    onChange={event => onReferenceMarketChange(event.target.checked)}
                    onClick={event => event.stopPropagation()}
                    className="accent-sky-400"
                  />
                  Reference live
                </label>
              ) : null}
            </div>
          )}
          {option && optionPremUsd != null && (
            <>
              <span
                className={`mt-1.5 w-full shrink-0 font-mono text-3xl font-bold leading-none tabular-nums ${pipClass} ${towardCenter}`}
                title="Total option premium"
              >
                {fmtUsd(optionPremUsd)}
              </span>
              <OptionPricingMetrics quote={optionQuote} align={metricsAlign} />
            </>
          )}
          {showOrderParams && (
            <div
              className="mt-2 w-full shrink-0 border-t border-white/20 pt-2"
              onClick={ev => ev.stopPropagation()}
            >
              {orderPanel}
            </div>
          )}
          {editing && onSubmit && (
            <button
              type="button"
              onClick={ev => {
                ev.stopPropagation();
                onSubmit();
              }}
              className="mt-3 w-full shrink-0 rounded bg-[#FF5722] px-3 py-2 text-xs font-bold uppercase tracking-wide text-white hover:bg-[#E64A19]"
            >
              {submitLabel}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-1 flex w-full min-h-0 flex-1 flex-col justify-center">
          {option ? (
            <>
              <span
                className={`w-full font-mono text-4xl font-bold leading-none tabular-nums transition-colors duration-200 ${figClass} ${towardCenter} ${
                  counterSideOfFill ? 'opacity-30' : ''
                }`}
                title={
                  counterSideOfFill
                    ? 'Not recorded — the counter-side quote at the moment of execution is not stored'
                    : 'Forward outright'
                }
              >
                {counterSideOfFill
                  ? '—'
                  : fillPx != null && Number.isFinite(fillPx)
                    ? fmtPx(fillPx)
                    : joinFxPips(displayParts)}
              </span>
              {!counterSideOfFill && optionPremUsd != null ? (
                <span
                  className={`mt-2 w-full font-mono text-3xl font-bold leading-none tabular-nums ${pipClass} ${towardCenter}`}
                  title="Total option premium"
                >
                  {fmtUsd(optionPremUsd)}
                </span>
              ) : null}
              {!counterSideOfFill ? (
                <OptionPricingMetrics quote={optionQuote} align={metricsAlign} />
              ) : null}
            </>
          ) : (
            <>
              <span
                className={`flex w-full items-baseline justify-center gap-1 font-mono text-3xl font-semibold leading-none tabular-nums transition-colors duration-200 ${figClass}`}
              >
                <span>{counterSideOfFill ? '' : displayParts.big}</span>
                <span className="text-xl font-medium opacity-80">
                  {counterSideOfFill ? '' : displayParts.lead}
                </span>
              </span>
              <span
                className={`mt-1 w-full font-mono text-8xl font-bold leading-none tabular-nums transition-colors duration-200 ${pipClass} ${towardCenter} ${
                  counterSideOfFill ? 'opacity-30' : ''
                }`}
                title={
                  counterSideOfFill
                    ? 'Not recorded — the counter-side quote at the moment of execution is not stored'
                    : undefined
                }
              >
                {counterSideOfFill ? '—' : displayParts.pips}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function padHitClass(armed: boolean, filled: boolean, idle: string): string {
  if (filled || armed) {
    return `${HIT_CHIP_ON} hover:bg-[#FF5722] disabled:hover:bg-[#FF5722]`;
  }
  return idle;
}

function StripLegRow({
  row,
  legCcy,
  bid,
  ask,
  points,
  vol,
  premiumUsd,
  premiumBidUsd,
  premiumAskUsd,
  optionPut = null,
  strike = null,
  fillPremiumUsd = null,
  on,
  armed,
  filledHit,
  orderStatus = null,
  orderTypeChip = null,
  orderLimit = null,
  fillTradeSide = null,
  fillIsSpotExecution = false,
  fillSpotRefPx = null,
  fillPx = null,
  fillAt = null,
  counterparty = null,
  locked,
  inputsLocked: _inputsLocked,
  onSelect,
  onHit,
  onLeave,
  orderArmed = null,
  onEditOrder,
  onCancelOrder,
  fillNowHit = null,
}: {
  row: StripRow;
  /** Ticket currency — sizes the fwd-points price delta (JPY /100). */
  legCcy: string;
  bid: number | null;
  ask: number | null;
  points: number | null;
  vol: number | null;
  premiumUsd: number | null;
  premiumBidUsd: number | null;
  premiumAskUsd: number | null;
  optionPut?: boolean | null;
  strike?: number | null;
  deltaPercent?: number | null;
  optionQuote?: HedgeIpaQuote | null;
  optionQuoteBid?: HedgeIpaQuote | null;
  optionQuoteAsk?: HedgeIpaQuote | null;
  fillPremiumUsd?: number | null;
  on: boolean;
  armed: HitSide | null;
  filledHit: HitSide | null;
  orderStatus?: 'working' | 'filled' | 'cancelled' | 'pending' | null;
  /** Compact order type (MKT / LIMIT / TP / SL / OCO) from the leg ticket. */
  orderTypeChip?: TicketOrderTypeChip | null;
  orderLimit?: number | null;
  /** Pair-base side of the FILLED ticket - authoritative over the hit side. */
  fillTradeSide?: 'Buy' | 'Sell' | null;
  /**
   * True when fillPx is a SPOT execution (spot-referenced bracket fill) that
   * books forward by ADDING the leg's points. False when fillPx already IS
   * the executed outright (direct leg market fill) - adding points again
   * printed 1.18911 over a 1.17486 execution.
   */
  fillIsSpotExecution?: boolean;
  /** Stamped spot reference of the filled ticket (ipaQuote.fxSpot). */
  fillSpotRefPx?: number | null;
  fillPx?: number | null;
  fillAt?: string | null;
  /**
   * The filled ticket's own dealer, when it has one. `row.bankBid`/`bankAsk`
   * are a per-index simulated quoting scheme for the tile that has not
   * traded yet — a bracket that filled later through the matcher, not this
   * row's own live-click flow, was never given its own dealer here and
   * always showed the simulated name instead of who it actually traded with.
   */
  counterparty?: string | null;
  locked: boolean;
  inputsLocked: boolean;
  onSelect: () => void;
  onHit: (hit: HitSide) => void;
  /**
   * Leave an order on THIS leg, on that side. Present only on the selected
   * leg while it is still the desk's to trade; the level is then typed on
   * the main tile's order sheet, as for any order.
   */
  onLeave?: (hit: HitSide) => void;
  /** The side an order is being placed on for this leg — lights its button. */
  orderArmed?: HitSide | null;
  /** Open this leg's working order for editing. */
  onEditOrder?: () => void;
  /** Cancel this leg's working order (and its OCO sibling) — this leg only. */
  onCancelOrder?: () => void;
  /**
   * The side that fills this leg at market NOW while its order works — it
   * carries "click to fill" until armed. Filling it cancels the order.
   */
  fillNowHit?: HitSide | null;
}) {
  const kind =
    row.instrument === 'spot' ? 'SPOT' : row.instrument === 'option' ? 'OPT' : 'FWD';
  // The order button sits BESIDE the market-fill button, never inside it
  // (a button in a button is invalid HTML): the side's pad still fills at
  // market, its BID / ASK button places an order.
  // The slot beside a side's rate. On the side that fills a working order
  // now, "click to fill" takes the BID / ASK label's place while idle; once
  // armed (orange) the side reads BID / ASK and its rate again. No label at
  // all where the side's own BID / ASK order button already names it.
  const sideLabel = (hit: HitSide) => {
    if (fillNowHit === hit && armed !== hit) {
      return (
        <span
          className={`whitespace-nowrap text-[8px] font-semibold uppercase tracking-wide text-sky-300/90 ${
            hit === 'bid' ? 'mr-1' : 'ml-1'
          }`}
        >
          click to fill
        </span>
      );
    }
    if (onLeave) return null;
    return (
      <span className={`${hit === 'bid' ? 'mr-1' : 'ml-1'} text-[9px] uppercase text-slate-500`}>
        {hit === 'bid' ? 'Bid' : 'Ask'}
      </span>
    );
  };
  const leaveButton = (hit: HitSide) =>
    onLeave ? (
      <button
        type="button"
        disabled={locked}
        onClick={() => onLeave(hit)}
        title={`Leave an order on the ${hit} for ${row.label}`}
        className={`shrink-0 self-center rounded border px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          orderArmed === hit
            ? HIT_CHIP_ON
            : hit === 'bid'
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
        }`}
      >
        {hit === 'bid' ? 'BID' : 'ASK'}
      </button>
    ) : null;
  const optionLeg = row.instrument === 'option';
  const optionRight =
    optionLeg
      ? optionPut === true
        ? 'PUT'
        : optionPut === false
          ? 'CALL'
          : 'VAN'
      : null;
  const bidPrem = premiumBidUsd ?? premiumUsd;
  const askPrem = premiumAskUsd ?? premiumUsd;
  const cancelled = orderStatus === 'cancelled';
  const done = filledHit != null || orderStatus === 'filled' || cancelled;
  // The trade's direction comes from the TICKET, never from the executed
  // quote side: since the take-profit side flip a Sell TP executes on the
  // ASK, and orderSideForHit('ask') read "Buy" over a Sell fill.
  const fillSide =
    fillTradeSide
    ?? (filledHit != null ? orderSideForHit(filledHit) : null);
  const fillBank = counterparty ?? (filledHit === 'ask' ? row.bankAsk : row.bankBid);
  const fillRate =
    fillPx != null && Number.isFinite(fillPx)
      ? fillPx
      : filledHit === 'bid'
        ? bid
        : filledHit === 'ask'
          ? ask
          : orderLimit;
  // Spot-referenced bracket fill: the execution IS spot, the booked FWD is
  // spot + the leg's points (stamped when the order was left). Direct leg
  // market fill: the execution already IS the outright shown on the row -
  // never add points to it again. Points unknown: the print is shown as the
  // spot fill it is, never dressed up as the forward. Hoisted above the
  // detail block so the top row's timestamp can share the same "FWD" /
  // "Spot fill · fwd points n/a" / "Fill" label without recomputing it.
  const validFill = fillRate != null && Number.isFinite(fillRate) && fillRate > 0;
  const isFwdLeg = row.instrument === 'forward' && validFill;
  const bookedFwd =
    isFwdLeg && fillIsSpotExecution
      ? bookedForwardFromSpotFill({ fillPx: fillRate, points, ccy: legCcy })
      : null;
  const fwdPx = !isFwdLeg ? null : fillIsSpotExecution ? bookedFwd : fillRate;
  const spotRef = !isFwdLeg
    ? null
    : fillIsSpotExecution
      ? fillRate
      : fillSpotRefPx != null && Number.isFinite(fillSpotRefPx) && fillSpotRefPx > 0
        ? fillSpotRefPx
        : null;
  const pointsNote =
    isFwdLeg && fillIsSpotExecution && bookedFwd != null && points != null
      ? ` · ${points >= 0 ? '+' : ''}${points.toFixed(1)} pts`
      : '';
  const fillPremium =
    fillPremiumUsd != null && Number.isFinite(fillPremiumUsd)
      ? fillPremiumUsd
      : premiumUsd;
  const fillLabel = optionLeg
    ? 'PREM'
    : isFwdLeg
      ? fwdPx != null
        ? 'FWD'
        : 'Spot fill · fwd points n/a'
      : 'Fill';
  return (
    <div
      className={`w-full rounded-md border px-2 py-0.5 text-left ${
        done && on
          ? 'border-yellow-400 bg-slate-800'
          : cancelled
            ? 'border-slate-700 bg-slate-900/80 opacity-70'
            : done
            ? 'border-slate-600 bg-slate-800'
            : on
              ? 'border-yellow-400 bg-sky-500/10'
              : 'border-slate-800 bg-slate-950/70'
      }`}
    >
      <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {row.near && (
          <span className="rounded bg-sky-500/20 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-sky-200">
            {row.instrument === 'spot' ? 'Spot' : 'Near'}
          </span>
        )}
        {orderStatus === 'filled' && (
          <span className="rounded bg-black/40 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white">
            Filled{orderTypeChip ? ` · ${orderTypeChip}` : ''}
          </span>
        )}
        {orderStatus === 'working' && (
          <span className="rounded bg-sky-500/20 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-sky-200">
            Working{orderTypeChip ? ` · ${orderTypeChip}` : ''}
            {orderLimit != null && Number.isFinite(orderLimit) ? ` ${fmtPx(orderLimit)}` : ''}
          </span>
        )}
        {orderStatus === 'pending' && (
          <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-amber-200">
            Pending
          </span>
        )}
        {orderStatus === 'cancelled' && (
          <span className="rounded bg-slate-800 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-slate-400">
            Cancelled{orderTypeChip ? ` · ${orderTypeChip}` : ''}
          </span>
        )}
        {done && orderStatus == null && (
          <span className="rounded bg-black/40 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white">
            Filled{orderTypeChip ? ` · ${orderTypeChip}` : ''}
          </span>
        )}
        <span className={`font-mono text-[11px] font-semibold ${done ? 'text-slate-100' : 'text-slate-200'}`}>
          {row.label}
        </span>
        <span className="font-mono text-[9px] uppercase text-slate-500">{kind}</span>
        {optionRight ? (
          <span className="font-mono text-[9px] uppercase text-violet-300">
            {optionRight}
          </span>
        ) : null}
        {optionLeg && strike != null && Number.isFinite(strike) ? (
          <span className="font-mono text-[9px] tabular-nums text-violet-200/80">
            {fmtPx(strike)}
          </span>
        ) : null}
        {done && fillSide != null && (
          <span className="font-mono text-[9px] uppercase text-slate-500">
            {fillLabel}{fillAt ? ` · ${fillAt}` : ''}
          </span>
        )}
        <span className={`ml-auto font-mono text-[11px] tabular-nums ${done ? 'text-slate-200' : 'text-slate-300'}`}>
          {row.sizeM.toFixed(2)}M
        </span>
      </button>
      {onEditOrder ? (
        <button
          type="button"
          onClick={onEditOrder}
          title={`Edit ${row.label}'s working order`}
          aria-label={`Edit ${row.label}'s working order`}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-sky-600/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
        >
          <Pencil className="h-3 w-3" />
        </button>
      ) : null}
      {onCancelOrder ? (
        <button
          type="button"
          onClick={onCancelOrder}
          title={`Cancel ${row.label}'s working order`}
          aria-label={`Cancel ${row.label}'s working order`}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-rose-600/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      ) : null}
      </div>
      {done && fillSide != null ? (
        <div
          role="presentation"
          onClick={onSelect}
          className={`mt-0.5 flex cursor-pointer items-end gap-3 font-mono tabular-nums ${
            filledHit === 'ask' ? 'flex-row-reverse' : ''
          }`}
        >
          <div className={filledHit === 'ask' ? 'text-right' : 'text-left'}>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white">
              {fillSide}
              {optionRight ? ` ${optionRight}` : ''}
              {filledHit != null ? ` · ${filledHit}` : ''}
            </div>
            <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-200/80">
              {fillBank}
            </div>
          </div>
          <div className={`min-w-0 flex-1 ${filledHit === 'ask' ? 'text-left' : 'text-right'}`}>
            {/* A spot-referenced leg EXECUTES on spot but BOOKS as a forward
                at its own tenor — the booked FWD outright IS the trade, so
                it is the big figure, with the underlying spot execution as
                the reference line beneath. Spot legs keep the spot fill as
                the big figure with no reference line. Option legs print the
                premium as the trade. */}
            <div className="text-xl font-bold leading-none text-white">
              {optionLeg
                ? fmtUsd(fillPremium)
                : fmtPx(isFwdLeg && fwdPx != null ? fwdPx : fillRate)}
            </div>
            {optionLeg ? null : spotRef != null && fwdPx != null ? (
              <div className="mt-0.5 text-[10px] tabular-nums text-slate-400">
                {`Spot Ref ${fmtPx(spotRef)}${pointsNote}`}
              </div>
            ) : null}
          </div>
        </div>
      ) : cancelled ? (
        <div className="mt-0.5 px-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-500">
          Cancelled — hidden from live Bid/Ask
        </div>
      ) : (
      <>
      <div className="mt-0.5 grid grid-cols-[1fr_auto_1fr] items-center gap-1 font-mono tabular-nums">
        {optionLeg ? (
          <>
            <div className="flex min-w-0 items-stretch gap-1">
            <button
              type="button"
              disabled={locked}
              onClick={() => onHit('bid')}
              title={
                filledHit === 'bid'
                  ? 'Filled bid'
                  : armed === 'bid'
                    ? 'Ready — click again to fill, Esc to exit'
                    : 'Select bid'
              }
              className={`flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded border px-1.5 py-1 text-[12px] ${
                padHitClass(
                  armed === 'bid',
                  filledHit === 'bid',
                  'border-transparent text-rose-300 hover:border-slate-700',
                )
              }`}
            >
              <span
                className={`font-mono text-[10px] font-semibold uppercase tracking-wide ${
                  armed === 'bid' || filledHit === 'bid' ? 'text-white' : 'text-sky-300'
                }`}
              >
                {row.bankBid}
              </span>
              <span className="text-right">
                {sideLabel('bid')}
                <span className="font-semibold" title="Bid option premium">
                  {fmtUsd(bidPrem)}
                </span>
                <span className="ml-1 text-[9px] text-rose-200/70">{fmtPx(bid)}</span>
              </span>
            </button>
            {leaveButton('bid')}
            </div>
            <span className="flex min-w-[4.5rem] items-center justify-center text-center text-[10px] text-slate-400">
              {vol != null ? `${vol.toFixed(2)}%` : 'Prem'}
            </span>
            <div className="flex min-w-0 items-stretch gap-1">
            {leaveButton('ask')}
            <button
              type="button"
              disabled={locked}
              onClick={() => onHit('ask')}
              title={
                filledHit === 'ask'
                  ? 'Filled ask'
                  : armed === 'ask'
                    ? 'Ready — click again to fill, Esc to exit'
                    : 'Select ask'
              }
              className={`flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded border px-1.5 py-1 text-[12px] ${
                padHitClass(
                  armed === 'ask',
                  filledHit === 'ask',
                  'border-transparent text-emerald-300 hover:border-slate-700',
                )
              }`}
            >
              <span className="text-left">
                <span className="font-semibold" title="Ask option premium">
                  {fmtUsd(askPrem)}
                </span>
                <span className="ml-1 text-[9px] text-emerald-200/70">{fmtPx(ask)}</span>
                {sideLabel('ask')}
              </span>
              <span
                className={`font-mono text-[10px] font-semibold uppercase tracking-wide ${
                  armed === 'ask' || filledHit === 'ask' ? 'text-white' : 'text-sky-300'
                }`}
              >
                {row.bankAsk}
              </span>
            </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-stretch gap-1">
            <button
              type="button"
              disabled={locked}
              onClick={() => onHit('bid')}
              title={
                filledHit === 'bid'
                  ? 'Filled bid'
                  : armed === 'bid'
                    ? 'Ready — click again to fill, Esc to exit'
                    : 'Select bid'
              }
              className={`flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded border px-1.5 py-1 text-[12px] ${
                padHitClass(
                  armed === 'bid',
                  filledHit === 'bid',
                  'border-transparent text-rose-300 hover:border-slate-700',
                )
              }`}
            >
              <span
                className={`font-mono text-[10px] font-semibold uppercase tracking-wide ${
                  armed === 'bid' || filledHit === 'bid' ? 'text-white' : 'text-sky-300'
                }`}
              >
                {row.bankBid}
              </span>
              <span className="text-right">
                {sideLabel('bid')}
                <span className="font-semibold">{fmtPx(bid)}</span>
              </span>
            </button>
            {leaveButton('bid')}
            </div>
            <span className="flex min-w-[4.5rem] items-center justify-center text-center text-[10px] text-slate-400">
              {points != null
                ? `${points.toFixed(2)} pts`
                : vol != null
                  ? `${vol.toFixed(2)}%`
                  : '—'}
            </span>
            <div className="flex min-w-0 items-stretch gap-1">
            {leaveButton('ask')}
            <button
              type="button"
              disabled={locked}
              onClick={() => onHit('ask')}
              title={
                filledHit === 'ask'
                  ? 'Filled ask'
                  : armed === 'ask'
                    ? 'Ready — click again to fill, Esc to exit'
                    : 'Select ask'
              }
              className={`flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded border px-1.5 py-1 text-[12px] ${
                padHitClass(
                  armed === 'ask',
                  filledHit === 'ask',
                  'border-transparent text-emerald-300 hover:border-slate-700',
                )
              }`}
            >
              <span className="text-left">
                <span className="font-semibold">{fmtPx(ask)}</span>
                {sideLabel('ask')}
              </span>
              <span
                className={`font-mono text-[10px] font-semibold uppercase tracking-wide ${
                  armed === 'ask' || filledHit === 'ask' ? 'text-white' : 'text-sky-300'
                }`}
              >
                {row.bankAsk}
              </span>
            </button>
            </div>
          </>
        )}
      </div>
      </>
      )}
    </div>
  );
}

function MiniRate({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'rose' | 'emerald';
}) {
  const valueClass =
    tone === 'rose'
      ? 'text-rose-200'
      : tone === 'emerald'
        ? 'text-emerald-200'
        : 'text-slate-200';
  return (
    <div className="rounded border border-slate-800 bg-slate-950/50 px-1.5 py-1">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
        {label}
      </div>
      <div className={`font-mono text-[11px] tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
