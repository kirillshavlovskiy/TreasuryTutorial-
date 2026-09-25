'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChartViewFrame } from '@/components/ChartViewToggle';
import {
  DeskLwChart,
  type LwPriceLine,
  lwIndexFromTime,
  lwIndexTime,
  type LwCandle,
  type LwFillMark,
  type LwLinePt,
  type LwPriceFormat,
} from '@/components/test-mode/DeskLwChart';
import {
  PremiumSurfaceToolbar,
  PremiumSurfaceView,
  SurfaceChipGroup,
  type SurfaceMetric,
  type SurfaceViewMode,
} from '@/components/test-mode/PremiumSurfaceMesh';
import {
  TAPE_BAR_SEC,
  TAPE_LOOKBACK_OPTIONS,
  aggregateTapeCandles,
  chartPriceRangeWithLevels,
  dropTapeConventionBreak,
  holdChartPriceRange,
  pickTapeBarSec,
  snapMsToTapeBar,
  tapeBarLabel,
  tapeLookbackLabel,
  tapeLookbackTitle,
  tickTimeMs,
  widenCandlesToFills,
  type TapeBarSec,
  type TapeLookback,
} from '@/lib/test-mode/tape-candles';
import {
  payoutAtRemainingLife,
  payoutKinkSpot,
  type OptionPayoutCurve,
  type OptionPremiumSurface,
  type OptionSkewCurve,
  type OptionSkewPoint,
  type PayoutBasis,
} from '@/lib/test-mode/sim-ticket-price';
import {
  parseStrikeInput,
  strikeInputFromSignedDelta,
} from '@/lib/strikeNotation';
import type { UTCTimestamp } from 'lightweight-charts';

export type OptionDeskPick = {
  strikeInput: string;
  optionPut?: boolean;
  tenorMonths?: number;
};

function fmtStrikeInput(k: number): string {
  if (!(k > 0) || !Number.isFinite(k)) return '';
  if (k >= 20) return k.toFixed(2);
  if (k >= 1) return String(Number(k.toFixed(5)));
  return String(Number(k.toFixed(6)));
}

function pickFromSmilePoint(
  p: OptionSkewPoint,
  tenorMonths?: number,
): OptionDeskPick | null {
  const tenor =
    tenorMonths != null && tenorMonths > 0 ? { tenorMonths } : {};
  if (p.signedDelta != null && Number.isFinite(p.signedDelta)) {
    return { ...strikeInputFromSignedDelta(p.signedDelta), ...tenor };
  }
  const parsed = parseStrikeInput(p.label);
  if (parsed?.kind === 'atm') {
    return { strikeInput: parsed.expression, ...tenor };
  }
  if (parsed?.kind === 'delta') {
    const put =
      parsed.optionType === 'put'
        ? true
        : parsed.optionType === 'call'
          ? false
          : undefined;
    return {
      strikeInput:
        parsed.optionType != null
          ? `${parsed.deltaPct}D${put ? 'P' : 'C'}`
          : `${parsed.deltaPct}D`,
      optionPut: put,
      ...tenor,
    };
  }
  if (p.strike > 0) {
    return { strikeInput: fmtStrikeInput(p.strike), ...tenor };
  }
  return null;
}

function pickFromPayoutSpot(spot: number): OptionDeskPick | null {
  if (!(spot > 0) || !Number.isFinite(spot)) return null;
  return { strikeInput: fmtStrikeInput(spot) };
}

function pickFromSurfaceKnot(
  surface: OptionPremiumSurface,
  yi: number,
  ti: number,
): OptionDeskPick | null {
  const row = surface.rows[yi];
  const tenor = surface.tenors[ti];
  if (!row || !tenor) return null;
  const cell = surface.cells[yi]?.[ti];
  const tenorMonths = tenor.months > 0 ? tenor.months : undefined;
  if (surface.axisY === 'delta' || row.axis === 'delta') {
    return { ...strikeInputFromSignedDelta(row.value), tenorMonths };
  }
  const k = cell?.strike ?? (row.value > 0 ? row.value : 0);
  if (!(k > 0)) return null;
  return { strikeInput: fmtStrikeInput(k), tenorMonths };
}

const OPTION_CHART_VIEWS = [
  { id: 'path' as const, label: 'Path', title: 'Exposure profile · hedge path' },
  { id: 'surface' as const, label: 'Surface', title: '3D IPA premium / vol surface' },
  { id: 'tape' as const, label: 'Tape', title: 'Live option premium candlesticks · Period picks how far back to load' },
  { id: 'skew' as const, label: 'Smile', title: 'Implied vol vs strike' },
  { id: 'payout' as const, label: 'Payout', title: 'Vanilla expiry P&L vs spot' },
];

type OptionView = (typeof OPTION_CHART_VIEWS)[number]['id'];

const TAPE_PERIOD_ROW_H = 34;

/** Which side of the book the tape's candles are drawn from. */
export type TapeCandleSide = 'bid' | 'ask';

function TapePeriodBar({
  lookback,
  onLookbackChange,
  candleSide,
  onCandleSideChange,
}: {
  lookback: TapeLookback;
  onLookbackChange: (next: TapeLookback) => void;
  candleSide?: TapeCandleSide | null;
  onCandleSideChange?: (next: TapeCandleSide) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-1.5">
      {candleSide && onCandleSideChange ? (
        <div className="flex items-center gap-1" title="Rate the candles are drawn from — defaults to the side that triggers the order">
          <span className="text-[11px] font-semibold text-slate-400">Rate:</span>
          {(['bid', 'ask'] as const).map(option => (
            <button
              key={option}
              type="button"
              onClick={() => onCandleSideChange(option)}
              aria-pressed={candleSide === option}
              className={`rounded px-2 py-0.5 font-mono text-[11px] uppercase transition-colors ${
                candleSide === option
                  ? 'bg-cyan-500 font-semibold text-slate-950'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <span className="text-[11px] font-semibold text-slate-400">Period:</span>
      <div className="flex flex-wrap gap-1">
        {TAPE_LOOKBACK_OPTIONS.map(option => (
          <button
            key={option}
            type="button"
            onClick={() => onLookbackChange(option)}
            aria-pressed={lookback === option}
            title={tapeLookbackTitle(option)}
            className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
              lookback === option
                ? 'bg-cyan-500 font-semibold text-slate-950'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {tapeLookbackLabel(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** IPA tenor dropdown — picking a column prices that tenor on the ticket. */
function OptionTenorSelect({
  surface,
  selectedTi,
  onPickTenor,
}: {
  surface: OptionPremiumSurface;
  selectedTi: number;
  onPickTenor: (ti: number) => void;
}) {
  return (
    <label className="flex items-center gap-1 font-mono text-[10px] text-slate-400">
      Tenor:
      <select
        value={selectedTi}
        onChange={e => onPickTenor(Number(e.target.value))}
        aria-label="Option tenor"
        className="rounded border border-slate-600/80 bg-slate-950/90 px-1 py-0.5 font-mono text-[10px] text-slate-200"
      >
        {surface.tenors.map((t, ti) => (
          <option key={`${t.label}-${ti}`} value={ti}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export type DeskTapePt = {
  bid: number;
  ask: number;
  mid: number;
  t?: number;
  marker?: boolean;
};

/** Ticket fill to plot on Path Tape: X = fill clock, Y = fill rate. */
export type DeskTapeFill = {
  t: number;
  px: number;
  side?: 'bid' | 'ask';
  /** The order's own direction — wins over `side` for glyph color/shape;
   * see LwFillMark.dir (a take-profit's executed side no longer implies it). */
  dir?: 'buy' | 'sell';
  text: string;
  /** Wall-clock for the time-axis arrow; falls back to parsing `text`. */
  clock?: string;
  /** Role of the producing order — rendered with the clock on the pin. */
  role?: 'TP' | 'SL' | 'LIMIT';
  /**
   * 'placed' / 'change' = leave / amend pins (non-triangle); 'fill' (default)
   * = execution arrow.
   */
  kind?: 'fill' | 'placed' | 'change';
  /**
   * The spot print this fill executed on, when `px` is a spot-referenced
   * order's booked forward. A spot-convention chart pins at this instead.
   */
  spotPx?: number;
  /** `text` rewritten for `spotPx`, so a moved pin never quotes the forward. */
  spotText?: string;
};

function fmtPx(px: number): string {
  if (!(px > 0) || !Number.isFinite(px)) return '—';
  if (px >= 20) return px.toFixed(2);
  if (px >= 1) return px.toFixed(4);
  return px.toFixed(5);
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `$${Math.round(v).toLocaleString()}`;
}

function volSourceNote(skew: OptionSkewCurve): string {
  if (skew.smile) return 'IPA smile';
  if (skew.volSource === 'atlas') return 'Atlas vol · flat';
  if (skew.volSource === 'seed') return 'Seed vol · flat';
  return 'Last surface · flat';
}

function compactSmileLabel(label: string): string {
  if (/ATM/i.test(label)) return 'ATM';
  const m = label.match(/(-?\d+(?:\.\d+)?)/);
  if (!m) return label;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return label;
  const absRaw = Math.abs(n);
  const abs = absRaw > 0 && absRaw <= 1 ? Math.round(absRaw * 100) : absRaw;
  if (abs < 1e-6) return 'ATM';
  const put = n < 0 || /P|put/i.test(label);
  return `${abs}Δ${put ? 'P' : 'C'}`;
}

function smileAxisLabel(p: OptionSkewPoint): string {
  if (p.signedDelta != null && Number.isFinite(p.signedDelta)) {
    const magRaw = Math.abs(p.signedDelta);
    if (magRaw < 1e-6) return 'ATM';
    const mag = magRaw <= 1 ? Math.round(magRaw * 100) : Math.round(magRaw);
    if (mag < 1) return 'ATM';
    return `${mag}Δ${p.signedDelta < 0 ? 'P' : 'C'}`;
  }
  return compactSmileLabel(p.label);
}

function smileWindow(skew: OptionSkewCurve): OptionSkewCurve['points'] {
  const raw = skew.points.filter(
    p => Number.isFinite(p.strike) && Number.isFinite(p.volPercent) && p.strike > 0,
  );
  const sorted = [...raw].sort((a, b) => a.strike - b.strike);
  const f =
    skew.forward > 0
      ? skew.forward
      : skew.selectedStrike != null && skew.selectedStrike > 0
        ? skew.selectedStrike
        : sorted[Math.floor(sorted.length / 2)]?.strike;
  if (!(f > 0) || sorted.length < 2) return sorted;
  const windowed = sorted.filter(p => p.strike >= f * 0.88 && p.strike <= f * 1.12);
  const use = windowed.length >= 3 ? windowed : sorted;
  const seen = new Set<number>();
  return use.filter(p => {
    const k = Math.round(p.strike * 1e5);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type CandlePack = {
  candles: LwCandle[];
  labels: Map<number, string>;
  /** Per-bar Bid/Ask · Δ · ticks · fill — shown as the candle hover marker. */
  crosshairLabels: Map<number, string>;
  markerTime: UTCTimestamp | null;
  fillMarks: LwFillMark[];
  priceFormat: LwPriceFormat;
};

function strikeTapeNote(raw: string | undefined): string {
  if (!raw?.trim()) return '';
  const parsed = parseStrikeInput(raw);
  if (parsed?.kind === 'absolute') return `fixed K ${fmtPx(parsed.value)}`;
  if (parsed?.kind === 'delta') {
    const side =
      parsed.optionType === 'put' ? 'P' : parsed.optionType === 'call' ? 'C' : '';
    return `${parsed.deltaPct}Δ${side} · K floats`;
  }
  if (parsed?.kind === 'atm') return `${parsed.expression} · K floats`;
  if (parsed?.kind === 'moneyness') return `${parsed.expression} · K floats`;
  return raw.trim();
}

function fmtUsdDelta(d: number): string {
  const mag = fmtUsd(Math.abs(d));
  return d >= 0 ? `+${mag}` : `−${mag}`;
}

function premiumPriceFormat(mid: number): LwPriceFormat {
  if (mid >= 1000) return { precision: 0, minMove: 1 };
  if (mid >= 10) return { precision: 2, minMove: 0.01 };
  return { precision: 4, minMove: 0.0001 };
}

function tapeToPack(
  pts: DeskTapePt[],
  metric: 'spot' | 'premium',
  barSec: TapeBarSec,
  fills?: readonly DeskTapeFill[],
  candleSide?: TapeCandleSide | null,
): CandlePack | null {
  const ticks = pts.filter(p => Number.isFinite(p.mid) && p.mid > 0);
  // Spot vs outright is a convention jump on an FX tape. Premium is USD —
  // the 40-pip FX cap would treat a $1 premium walk as a break and drop the
  // loaded Period window.
  const series = metric === 'premium' ? ticks : dropTapeConventionBreak(ticks);
  if (series.length === 0) return null;
  // Candles follow ONE side of the book when a side is chosen — the side an
  // order triggers on reads its own crossing, instead of a mid that sits a
  // half-spread short of it. The mid path otherwise.
  const candles = aggregateTapeCandles(
    series.map(p => ({
      bid: p.bid,
      ask: p.ask,
      mid: candleSide === 'bid' ? p.bid : candleSide === 'ask' ? p.ask : p.mid,
      t: p.t && p.t > 0 ? p.t : 0,
    })),
    barSec,
  );
  if (candles.length === 0) return null;
  const last = ticks[ticks.length - 1]!;
  const barTimes = candles.map(c => Number(c.time));
  const fromTicks: DeskTapeFill[] = [];
  for (const point of pts) {
    if (point.marker && point.t && point.t > 0 && point.mid > 0) {
      fromTicks.push({ t: point.t, px: point.mid, text: '' });
    }
  }
  // Explicit `tapeFills` (including []) wins: a selected unfilled strip leg
  // must not revive every trail `marker` pin. Omit the prop to use ticks.
  const raw = fills != null ? fills : fromTicks;
  const fillMarks: LwFillMark[] = [];
  const seen = new Set<string>();
  for (const fill of raw) {
    if (!(fill.px > 0) || !Number.isFinite(fill.px) || !(fill.t > 0)) continue;
    const snapped = snapMsToTapeBar(fill.t, barSec, barTimes);
    if (snapped == null) continue;
    const key = `${snapped}:${fill.px.toFixed(8)}:${fill.side ?? ''}:${fill.kind ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fillMarks.push({
      time: snapped as UTCTimestamp,
      price: fill.px,
      text: fill.text,
      clock: fill.clock,
      role: fill.role,
      side: fill.side,
      dir: fill.dir,
      kind: fill.kind,
    });
  }
  // lightweight-charts binary-searches the marker list and requires ascending
  // time — a "placed" pin at the opening bar arriving after a later fill would
  // otherwise drop the fill arrow once the placement bar scrolls out of view.
  fillMarks.sort((a, b) => Number(a.time) - Number(b.time));
  // The "placed" pin sits at the tape's opening bar; anchor the view and the
  // caption on a real execution when there is one.
  const primaryMark =
    fillMarks.find(m => m.kind !== 'placed' && m.kind !== 'change')
    ?? fillMarks[0];
  const markerTime = primaryMark?.time ?? null;
  const px = last.mid >= 20 ? 3 : 5;
  const barLabel = tapeBarLabel(barSec);
  const barCount = candles.length;
  const ticksByBar = new Map<number, DeskTapePt[]>();
  for (const p of ticks) {
    const ms = tickTimeMs(p.t ?? 0);
    const t = Math.floor(ms / (barSec * 1000)) * barSec;
    const list = ticksByBar.get(t);
    if (list) list.push(p);
    else ticksByBar.set(t, [p]);
  }
  const fillText = (mark: LwFillMark): string => {
    const trimmed = mark.text?.trim();
    if (trimmed) return trimmed;
    if (mark.kind === 'placed') return `PLACED · ${fmtPx(mark.price)}`;
    if (mark.kind === 'change') return `CHANGE · ${fmtPx(mark.price)}`;
    return `FILL · ${fmtPx(mark.price)}`;
  };
  const statusForBar = (c: (typeof candles)[number]): string => {
    const inBarTicks = ticksByBar.get(Number(c.time)) ?? [];
    const quote = inBarTicks[inBarTicks.length - 1] ?? last;
    const d = c.close - c.open;
    const core =
      metric === 'premium'
        ? `Prem bid ${fmtUsd(quote.bid)} · ask ${fmtUsd(quote.ask)} · bar ${fmtUsdDelta(d)} · ${inBarTicks.length} ticks / ${barLabel} · ${barCount} bars`
        : `Bid ${fmtPx(quote.bid)} · Ask ${fmtPx(quote.ask)} · bar ${d >= 0 ? '+' : ''}${d.toFixed(px)} · ${inBarTicks.length} ticks / ${barLabel} · ${barCount} bars`;
    const onBar = fillMarks.filter(m => Number(m.time) === Number(c.time));
    if (onBar.length === 0) return core;
    return `${core} · ${onBar.map(fillText).join(' · ')}`;
  };
  const crosshairLabels = new Map<number, string>();
  for (const c of candles) {
    crosshairLabels.set(Number(c.time), statusForBar(c));
  }
  return {
    // Bars are the mid path; a fill printed on one side of the book is put
    // back inside its own bar so the chart still shows the level it hit.
    candles: widenCandlesToFills(candles, fillMarks),
    labels: new Map<number, string>(),
    crosshairLabels,
    markerTime,
    fillMarks,
    priceFormat:
      metric === 'premium'
        ? premiumPriceFormat(last.mid)
        : {
            precision: last.mid >= 20 ? 3 : 5,
            minMove: last.mid >= 20 ? 0.001 : 0.00001,
          },
  };
}

/** Smile knot: skew point plus premium / surface row when sourced from IPA. */
type SmileSourcePoint = OptionSkewPoint & {
  premiumUsd?: number;
  /** Row index into the premium surface when the smile is a surface column. */
  surfaceYi?: number;
};

type SmilePack = {
  line: LwLinePt[];
  tickLabels: Map<number, string>;
  crosshairLabels: Map<number, string>;
  points: SmileSourcePoint[];
  selectedIndex: number;
};

function nearestIdx(values: readonly number[], target: number): number {
  let best = 0;
  let bestD = Infinity;
  values.forEach((v, i) => {
    const d = Math.abs(v - target);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * Smile at one tenor, cut from the IPA premium surface — carries premium
 * next to σ so the Smile view can plot either metric and list both in Grid.
 */
function smileFromSurface(
  surface: OptionPremiumSurface,
  ti: number,
  metric: SurfaceMetric,
): SmilePack | null {
  const pts: SmileSourcePoint[] = [];
  surface.rows.forEach((row, yi) => {
    const cell = surface.cells[yi]?.[ti];
    if (!cell || !(cell.strike > 0) || !(cell.volPercent > 0)) return;
    pts.push({
      strike: cell.strike,
      volPercent: cell.volPercent,
      premiumUsd: cell.premiumUsd,
      label: row.label,
      signedDelta: row.axis === 'delta' ? row.value : undefined,
      surfaceYi: yi,
    });
  });
  pts.sort((a, b) => a.strike - b.strike);
  if (pts.length < 2) return null;
  const tickLabels = new Map<number, string>();
  const crosshairLabels = new Map<number, string>();
  const line = pts.map((p, i) => {
    const time = lwIndexTime(i);
    const lab = smileAxisLabel(p);
    crosshairLabels.set(
      time,
      `${lab} · K ${fmtPx(p.strike)} · σ ${p.volPercent.toFixed(2)}% · ${fmtUsd(p.premiumUsd)}`,
    );
    const sparse =
      pts.length <= 8
      || /ATM|25|10/i.test(lab)
      || i === 0
      || i === pts.length - 1;
    if (sparse) tickLabels.set(time, lab);
    return {
      time,
      value: metric === 'premium' ? (p.premiumUsd ?? 0) : p.volPercent,
    };
  });
  let selectedIndex = Math.floor(pts.length / 2);
  let best = Infinity;
  pts.forEach((p, i) => {
    const d =
      surface.axisY === 'delta' && p.signedDelta != null
        ? Math.abs(p.signedDelta - surface.selectedY)
        : Math.abs(p.strike - surface.selectedY);
    if (d < best) {
      best = d;
      selectedIndex = i;
    }
  });
  const sel = pts[selectedIndex];
  if (sel) tickLabels.set(line[selectedIndex]!.time, smileAxisLabel(sel));
  return { line, tickLabels, crosshairLabels, points: pts, selectedIndex };
}

function smileLine(skew: OptionSkewCurve): SmilePack | null {
  const pts = smileWindow(skew);
  if (pts.length < 2) return null;
  const tickLabels = new Map<number, string>();
  const crosshairLabels = new Map<number, string>();
  const line = pts.map((p, i) => {
    const time = lwIndexTime(i);
    const lab = smileAxisLabel(p);
    crosshairLabels.set(time, `${lab} · ${fmtPx(p.strike)}`);
    const sparse =
      pts.length <= 8
      || /ATM|25|10/i.test(lab)
      || i === 0
      || i === pts.length - 1;
    if (sparse) tickLabels.set(time, lab);
    return { time, value: p.volPercent };
  });
  let selectedIndex = Math.floor(pts.length / 2);
  if (skew.selectedSignedDelta != null && Number.isFinite(skew.selectedSignedDelta)) {
    let best = Infinity;
    pts.forEach((p, i) => {
      if (p.signedDelta == null) return;
      const d = Math.abs(p.signedDelta - skew.selectedSignedDelta!);
      if (d < best) {
        best = d;
        selectedIndex = i;
      }
    });
  } else if (skew.selectedStrike != null && skew.selectedStrike > 0) {
    let best = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(p.strike - skew.selectedStrike!);
      if (d < best) {
        best = d;
        selectedIndex = i;
      }
    });
  } else {
    const atm = pts.findIndex(p => /ATM/i.test(p.label));
    if (atm >= 0) selectedIndex = atm;
  }
  const selected = pts[selectedIndex];
  if (selected) {
    tickLabels.set(line[selectedIndex]!.time, smileAxisLabel(selected));
  }
  return { line, tickLabels, crosshairLabels, points: pts, selectedIndex };
}

function payoutPriceRange(
  payout: OptionPayoutCurve,
  pts: OptionPayoutCurve['points'],
): { min: number; max: number } {
  const span = Math.abs(pts[pts.length - 1]!.spot - pts[0]!.spot);
  const per = Math.abs(payout.pnlPerSpotUsdM);
  // Scale from notional × window only — never premium or current K —
  // so the exercised segment keeps a constant angle.
  const pad = Math.max(per * span * 0.5, 0.02);
  return { min: -pad, max: pad };
}

/** Signed Δ as a fraction of notional. The percent lives in −1…1; notional does not. */
function deltaPriceRange(): { min: number; max: number } {
  return { min: -1, max: 1 };
}

type PayoutGreek = 'delta' | 'gamma' | 'vega' | 'theta';

const GREEK_SWITCH: readonly { id: PayoutGreek; label: string; hint: string }[] = [
  { id: 'delta', label: 'Δ', hint: 'Yellow · delta, % of notional' },
  { id: 'gamma', label: 'Γ', hint: 'Yellow · gamma, Δ points per 1% spot' },
  { id: 'vega', label: 'ν', hint: 'Yellow · vega, premium % per vol point' },
  { id: 'theta', label: 'Θ', hint: 'Yellow · theta, premium % per day' },
];

function greekOf(point: OptionPayoutCurve['points'][number], greek: PayoutGreek, notionalLocalM: number): number {
  if (greek === 'gamma') return point.gamma;
  if (greek === 'vega') return point.vega;
  if (greek === 'theta') return point.theta;
  return deltaFraction(point.deltaLocalM, notionalLocalM);
}

function greekRange(values: readonly number[], greek: PayoutGreek): { min: number; max: number } {
  if (greek === 'delta') return deltaPriceRange();
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));
  if (!(peak > 1e-12)) peak = 1;
  const padded = peak * 1.12;
  return { min: -padded, max: padded };
}

function greekPrecision(greek: PayoutGreek): number {
  if (greek === 'theta') return 4;
  if (greek === 'vega') return 3;
  return 2;
}

function fmtGreek(
  point: OptionPayoutCurve['points'][number],
  greek: PayoutGreek,
  notionalLocalM: number,
): string {
  if (greek === 'delta') {
    const pct = notionalLocalM > 0 ? (point.deltaLocalM / notionalLocalM) * 100 : 0;
    return `Δ ${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%`;
  }
  const value = greekOf(point, greek, notionalLocalM);
  const label = greek === 'gamma' ? 'Γ' : greek === 'vega' ? 'ν' : 'Θ';
  const text = Math.abs(value).toFixed(greekPrecision(greek));
  return `${label} ${value >= 0 ? '+' : '−'}${text}`;
}

function deltaFraction(deltaLocalM: number, notionalLocalM: number): number {
  if (!(notionalLocalM > 0) || !Number.isFinite(deltaLocalM)) return 0;
  const frac = deltaLocalM / notionalLocalM;
  return Math.min(1, Math.max(-1, frac));
}

function payoutLine(
  payout: OptionPayoutCurve,
  marker?: { spot: number; label: string },
  greek: PayoutGreek = 'delta',
): {
  line: LwLinePt[];
  overlay: LwLinePt[];
  companion: LwLinePt[];
  labels: Map<number, string>;
  extra: string;
  points: OptionPayoutCurve['points'];
  selectedIndex: number;
  spotTime: number;
  spot: number;
  strike: number;
  priceRange: { min: number; max: number };
  overlayPriceRange: { min: number; max: number };
  ccy: string;
} | null {
  const pts = payout.points.filter(
    p => Number.isFinite(p.spot) && Number.isFinite(p.pnlUsdM),
  );
  if (pts.length < 2) return null;
  const labels = new Map<number, string>();
  const line = pts.map((p, i) => {
    const time = lwIndexTime(i);
    if (i === 0 || i === pts.length - 1) labels.set(time, fmtPx(p.spot));
    return { time, value: p.pnlUsdM };
  });
  const overlayValues = pts.map(p => greekOf(p, greek, payout.notionalLocalM));
  const overlay = pts.map((p, i) => ({
    time: lwIndexTime(i),
    value: overlayValues[i]!,
  }));
  const companion = pts.map((p, i) => ({
    time: lwIndexTime(i),
    value: Number.isFinite(p.markUsdM) ? p.markUsdM : 0,
  }));
  let selectedIndex = 0;
  let best = Infinity;
  const markerSpot = marker?.spot ?? payout.strike;
  pts.forEach((p, i) => {
    const d = Math.abs(p.spot - markerSpot);
    if (d < best) {
      best = d;
      selectedIndex = i;
    }
  });
  // Spot reference first, so K wins the axis slot when the option is struck
  // at the money and the two land on the same node.
  let spotIndex = 0;
  let spotBest = Infinity;
  pts.forEach((p, i) => {
    const d = Math.abs(p.spot - payout.spot);
    if (d < spotBest) {
      spotBest = d;
      spotIndex = i;
    }
  });
  labels.set(line[spotIndex]!.time, `S ${fmtPx(payout.spot)}`);
  labels.set(
    line[selectedIndex]!.time,
    marker?.label ?? `K ${fmtPx(payout.strike)}`,
  );
  return {
    line,
    overlay,
    companion,
    labels,
    extra: `Prem $${Math.abs(payout.premiumUsdM).toFixed(3)}M · σ ${payout.deltaVolPercent.toFixed(2)}%`,
    points: pts,
    selectedIndex,
    spotTime: line[spotIndex]!.time,
    spot: payout.spot,
    strike: payout.strike,
    priceRange: payoutPriceRange(payout, pts),
    overlayPriceRange: greekRange(overlayValues, greek),
    ccy: payout.ccy,
  };
}

export function OptionSkewPayoutChart({
  skew,
  payout,
  premiumSurface,
  tape,
  liveBid,
  liveAsk,
  pair,
  tenorLabel,
  mode = 'rates',
  strikeInput,
  premiumBid,
  premiumAsk,
  onSelectOption,
  framed = true,
  fillParent = false,
  plotHeight,
  pathChart,
  headerExtra,
  limitRate,
  limitLabel,
  orderLevels,
  markerText,
  tapeFills,
  seriesKey,
  tapeFitToWindow = false,
  lookback,
  onLookbackChange,
  candleSide = null,
  onCandleSideChange,
}: {
  skew: OptionSkewCurve | null;
  payout: OptionPayoutCurve | null;
  premiumSurface?: OptionPremiumSurface | null;
  tape: DeskTapePt[];
  liveBid: number | null;
  liveAsk: number | null;
  pair: string;
  tenorLabel: string;
  mode?: 'option' | 'rates';
  strikeInput?: string;
  premiumBid?: number | null;
  premiumAsk?: number | null;
  onSelectOption?: (pick: OptionDeskPick) => void;
  /** When false, plot only — parent owns Path / Tape chrome. */
  framed?: boolean;
  /** Stretch the chart viewport to the height allocated by its parent. */
  fillParent?: boolean;
  plotHeight?: number;
  /** Same Exposure path as the forward book (leftover increment vs forecast). */
  pathChart?: ReactNode;
  /**
   * Extra controls in the framed title row (e.g. the Book overlay's BUY/SELL
   * side toggle) — keeps them out of a stacked bar above the chart so the
   * view toggle sits at the same y as the Spot/FWD pane's.
   */
  headerExtra?: ReactNode;
  /** A resting order's level, drawn as a dashed reference line on the tape. */
  limitRate?: number | null;
  /** Label on that line — defaults to "LIMIT". */
  limitLabel?: string;
  /** TP/SL levels from an order bracket, rendered together on the tape. */
  orderLevels?: readonly LwPriceLine[];
  /** Label on the tape time marker (fill / leave). */
  markerText?: string;
  /** Live / booked fills to pin on the tape at execution time and px. */
  tapeFills?: readonly DeskTapeFill[];
  /** Identity of the underlying tape series (e.g. a leg's tapeQuoteKey) — see DeskLwChart. */
  seriesKey?: string;
  /**
   * The tape is a chosen Period window, not an order's story: fit the whole
   * span on load and pick a bar size that suits it. A story instead
   * right-anchors the last ~80 bars at the current interval, the same on
   * every leg — which made a window of hours look like the same seven
   * minutes whatever the desk clicked.
   */
  tapeFitToWindow?: boolean;
  /** How far back the Tape loads — Order, last hour, last day, 24h, 48h. */
  lookback?: TapeLookback;
  onLookbackChange?: (next: TapeLookback) => void;
  /** Side the tape's candles are drawn from; null draws the mid. */
  candleSide?: TapeCandleSide | null;
  onCandleSideChange?: (next: TapeCandleSide) => void;
}) {
  const optionMode = mode === 'option';
  const [optionView, setOptionView] = useState<OptionView>('surface');
  const [surfaceMetric, setSurfaceMetric] = useState<SurfaceMetric>('premium');
  const [surfaceMode, setSurfaceMode] = useState<SurfaceViewMode>('mesh');
  const [smileMetric, setSmileMetric] = useState<SurfaceMetric>('vol');
  const [smileMode, setSmileMode] = useState<'plot' | 'grid'>('plot');
  /** Tenor override for the Smile view — null follows the ticket tenor. */
  const [smileTenorSel, setSmileTenorSel] = useState<number | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [fullPlotH, setFullPlotH] = useState(560);
  const [tapeBarSec, setTapeBarSec] = useState<TapeBarSec>(TAPE_BAR_SEC);
  const [intervalLocked, setIntervalLocked] = useState(false);
  // A From window gets a bar size for its whole span, re-picked on a new key
  // or Period. A manual Interval chip after that stays until the next such
  // change — auto-interval and fit-to-window must not steal 5s…1h.
  const firstTapeMs = tape.length > 0 ? tape[0]!.t ?? null : null;
  const lastTapeMsRef = useRef<number | null>(null);
  lastTapeMsRef.current = tape.length > 0 ? tape[tape.length - 1]!.t ?? null : null;
  useEffect(() => {
    setIntervalLocked(false);
  }, [seriesKey, lookback, tapeFitToWindow]);
  useEffect(() => {
    if (intervalLocked) return;
    if (!tapeFitToWindow || firstTapeMs == null || lastTapeMsRef.current == null) return;
    const spanSec = (lastTapeMsRef.current - firstTapeMs) / 1000;
    if (!(spanSec > 0)) return;
    setTapeBarSec(pickTapeBarSec(spanSec));
  }, [tapeFitToWindow, seriesKey, firstTapeMs, lookback, intervalLocked]);
  const view = optionMode ? optionView : 'tape';

  const hasPath = pathChart != null;
  const hasSurface = premiumSurface != null;

  // Compute smile whenever skew changes, not just when view changes.
  // This way we can check the actual renderable state, not just presence of raw points.
  const smile = useMemo(
    () => skew ? smileLine(skew) : null,
    [skew],
  );
  // Smile sourced from the IPA surface column at the picked tenor — brings
  // premium next to σ and lets the desk walk tenors without repricing.
  const smileTenorMonths =
    smileTenorSel
    ?? skew?.tenorMonths
    ?? premiumSurface?.selectedTenorMonths
    ?? null;
  const smileTi =
    premiumSurface && smileTenorMonths != null
      ? nearestIdx(
          premiumSurface.tenors.map(t => t.months),
          smileTenorMonths,
        )
      : -1;
  const surfaceSmile = useMemo(
    () =>
      premiumSurface && smileTi >= 0
        ? smileFromSurface(premiumSurface, smileTi, smileMetric)
        : null,
    [premiumSurface, smileTi, smileMetric],
  );
  const smilePack = surfaceSmile ?? smile;
  const actualHasSkew = smilePack != null;

  useEffect(() => {
    if (!optionMode) return;
    // Only reset the view if the currently selected view's data is no longer available.
    setOptionView(current => {
      if (current === 'surface' && hasSurface) return current;
      if (current === 'skew' && actualHasSkew) return current;
      if (current === 'path' && hasPath) return current;
      // View data is no longer available — pick a new one.
      if (hasSurface) return 'surface';
      if (actualHasSkew) return 'skew';
      if (hasPath) return 'path';
      return current;
    });
  }, [optionMode, hasPath, hasSurface, actualHasSkew]);

  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setFullScreen(false);
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const read = () => setFullPlotH(Math.max(420, window.innerHeight - 140));
    read();
    window.addEventListener('resize', read);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', read);
      document.body.style.overflow = prev;
    };
  }, [fullScreen]);

  const pts = useMemo((): DeskTapePt[] => {
    if (tape.length > 0) return tape;
    if (liveBid != null && liveAsk != null && liveBid > 0 && liveAsk > 0) {
      return [
        {
          bid: liveBid,
          ask: liveAsk,
          mid: (liveBid + liveAsk) / 2,
          t: Date.now(),
        },
      ];
    }
    return [];
  }, [tape, liveBid, liveAsk]);

  const tapeMetric = optionMode ? 'premium' : 'spot';
  const candlePack = useMemo(
    () => (view === 'tape' ? tapeToPack(pts, tapeMetric, tapeBarSec, tapeFills, candleSide) : null),
    [view, pts, tapeMetric, tapeBarSec, tapeFills, candleSide],
  );
  // The Y window must not follow the live tape tick by tick. While a level
  // rests outside the candles it pins one end of the range and the axis holds
  // still; the moment the market reaches that level the range is driven by the
  // candles alone, and every new high or low rescales it — which is the whole
  // plot, price lines and fill markers included, jumping up and down. So keep
  // the window already on screen until what must be visible no longer fits in
  // it, or until it has grown far wider than the data needs.
  const tapeRangeHoldRef = useRef<{ key: string; range: { min: number; max: number } } | null>(null);
  const tapePriceRange = useMemo(() => {
    if (!candlePack) return null;
    const want = chartPriceRangeWithLevels(candlePack.candles, [
      ...(orderLevels?.map(level => level.price) ?? []),
      ...candlePack.fillMarks.map(mark => mark.price),
    ]);
    if (!want) return null;
    const key = `${seriesKey ?? ''}|${tapeMetric}`;
    const held = tapeRangeHoldRef.current;
    const range = holdChartPriceRange(held?.key === key ? held.range : null, want);
    tapeRangeHoldRef.current = { key, range };
    return range;
  }, [candlePack, orderLevels, seriesKey, tapeMetric]);

  const pay = view === 'payout' && payout ? payoutLine(payout) : null;

  const strikeNote = optionMode ? strikeTapeNote(strikeInput) : '';
  const title =
    view === 'path'
      ? 'Exposure path'
      : view === 'surface'
        ? 'Premium surface'
        : view === 'tape'
          ? optionMode
            ? 'Premium candles'
            : 'Price candles'
          : view === 'skew'
            ? surfaceSmile && smileMetric === 'premium'
              ? 'Premium vs strike'
              : 'Vol vs strike'
            : 'Expiry payout';
  const note =
    view === 'path'
      ? ''
      : view === 'surface'
        ? premiumSurface
          ? ` · IPA 3D · ${premiumSurface.rows.length} Δ × ${premiumSurface.tenors.length} tenors`
          : ''
        : view === 'tape'
          ? ` · ${tapeBarLabel(tapeBarSec)} OHLC · 1s ticks${strikeNote ? ` · ${strikeNote}` : ''}`
          : view === 'skew'
            ? `${
                surfaceSmile && premiumSurface
                  ? ` · ${premiumSurface.tenors[smileTi]?.label ?? ''}`
                  : ''
              }${skew ? ` · ${volSourceNote(skew)}` : ''}`
            : payout
              ? ` · ${payout.longOption ? 'long' : 'short'} ${payout.put ? 'put' : 'call'}`
              : '';

  const empty =
    view === 'path' && !pathChart
      ? 'Exposure path needs the Hedging Decision book for this CCY.'
      : view === 'surface' && !premiumSurface
        ? 'Pull an IPA smile on Market data to price strike × tenor.'
        : view === 'tape' && !candlePack
          ? optionMode
            ? 'Tape will plot premium once the live option price ticks, or pick a Period to load the day record.'
            : 'Tape will plot here once the live rate ticks, or pick a Period to load the day record.'
          : view === 'skew' && !smilePack
            ? 'No vol points for this tenor — pull an IPA surface on Market data.'
            : view === 'payout' && !pay
              ? 'Need a strike and size for the payout diagram.'
              : null;

  /** Tenor pick on Smile / Surface prices that column on the ticket so the
   *  live pad (right) shows the same expiry, vol and premium. */
  const commitTenorColumn = (ti: number) => {
    if (!premiumSurface) return;
    const tenor = premiumSurface.tenors[ti];
    if (!tenor) return;
    if (onSelectOption) {
      const yi = nearestIdx(
        premiumSurface.rows.map(r => r.value),
        premiumSurface.selectedY,
      );
      const pick = pickFromSurfaceKnot(premiumSurface, yi, ti);
      onSelectOption(
        pick ?? {
          strikeInput: strikeInput?.trim() || 'ATMF',
          tenorMonths: tenor.months,
        },
      );
      setSmileTenorSel(null);
      return;
    }
    setSmileTenorSel(tenor.months);
  };

  const chartInner = (height: number, tall: boolean) => {
    const periodBar =
      view === 'tape' && lookback != null && onLookbackChange ? (
        <TapePeriodBar
          lookback={lookback}
          onLookbackChange={onLookbackChange}
          candleSide={candleSide}
          onCandleSideChange={onCandleSideChange}
        />
      ) : null;
    const periodH = periodBar ? TAPE_PERIOD_ROW_H : 0;
    if (view === 'tape') {
      const stretch = fillParent || tall;
      if (!candlePack) {
        return (
          <div
            className={
              stretch
                ? 'flex h-full min-h-0 min-w-0 w-full flex-col'
                : undefined
            }
          >
            {periodBar}
            <p className="px-3 py-10 text-center text-[10px] text-slate-500">
              {empty
                ?? (optionMode
                  ? 'Tape will plot premium once the live option price ticks, or pick a Period to load the day record.'
                  : 'Tape will plot here once the live rate ticks, or pick a Period to load the day record.')}
            </p>
          </div>
        );
      }
      const executionMarks = candlePack.fillMarks.filter(
        mark => mark.kind !== 'placed' && mark.kind !== 'change',
      );
      const primaryFill = executionMarks[0] ?? candlePack.fillMarks[0];
      const hoverLabels =
        strikeNote
          ? new Map(
              [...candlePack.crosshairLabels].map(([t, text]) => [
                t,
                `${text} · ${strikeNote}`,
              ]),
            )
          : candlePack.crosshairLabels;
      return (
        <div
          className={
            stretch
              ? 'flex h-full min-h-0 min-w-0 w-full flex-col'
              : undefined
          }
        >
          {periodBar}
          <div className={stretch ? 'min-h-0 min-w-0 flex-1' : undefined}>
            <DeskLwChart
              kind="candlestick"
              scale="stream"
              fillParent={stretch}
              height={Math.max(80, height - periodH)}
              candles={candlePack.candles}
              crosshairLabels={hoverLabels}
              markerTime={candlePack.markerTime}
              markerText={
                markerText
                ?? primaryFill?.text
                ?? 'FILL'
              }
              fillMarks={candlePack.fillMarks.map(mark => ({
                ...mark,
                text:
                  mark.text
                  || (mark.kind === 'placed'
                    ? `PLACED · ${fmtPx(mark.price)}`
                    : mark.kind === 'change'
                      ? `CHANGE · ${fmtPx(mark.price)}`
                      : markerText || `FILL · ${fmtPx(mark.price)}`),
              }))}
              lockVisibleToMarker={
                candlePack.candles.length > 1
                && executionMarks.length > 0
                && executionMarks.some(mark =>
                  candlePack.candles.some(c => Number(c.time) === Number(mark.time)),
                )
              }
              priceFormat={candlePack.priceFormat}
              zeroPrice={limitRate}
              zeroLineTitle={limitLabel ?? 'LIMIT'}
              zeroLineColor="#facc15"
              priceLines={orderLevels}
              priceRange={tapePriceRange}
              showControlBar
              currentInterval={tapeBarSec}
              onIntervalChange={next => {
                setIntervalLocked(true);
                setTapeBarSec(next);
              }}
              autoInterval={!intervalLocked && !tapeFitToWindow}
              seriesKey={seriesKey}
              fitOnLoad={tapeFitToWindow}
            />
          </div>
        </div>
      );
    }
    if (empty) {
      return (
        <p className="px-3 py-10 text-center text-[10px] text-slate-500">
          {empty}
        </p>
      );
    }
    if (optionMode && optionView === 'path') {
      return (
        pathChart ?? (
          <p className="px-3 py-10 text-center text-[10px] text-slate-500">
            Exposure path needs the Hedging Decision book for this CCY.
          </p>
        )
      );
    }
    if (optionMode && optionView === 'surface' && premiumSurface) {
      const stretch = fillParent || tall;
      return (
        <div
          className={
            stretch
              ? 'flex h-full min-h-0 min-w-0 w-full flex-col'
              : undefined
          }
        >
          {/* Same control-bar row as the Tape's Period bar — the extra
              controls live UNDER the docked view menu, never inside it. */}
          <div className="flex shrink-0 items-center justify-center gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-1.5">
            <span className="text-[11px] font-semibold text-slate-400">
              Surface:
            </span>
            <PremiumSurfaceToolbar
              metric={surfaceMetric}
              onMetric={setSurfaceMetric}
              mode={surfaceMode}
              onMode={setSurfaceMode}
            />
            <OptionTenorSelect
              surface={premiumSurface}
              selectedTi={nearestIdx(
                premiumSurface.tenors.map(t => t.months),
                premiumSurface.selectedTenorMonths,
              )}
              onPickTenor={commitTenorColumn}
            />
          </div>
          <div className={stretch ? 'min-h-0 min-w-0 flex-1' : undefined}>
            <PremiumSurfaceView
              surface={premiumSurface}
              metric={surfaceMetric}
              mode={surfaceMode}
              tall={tall}
              onPickKnot={
                onSelectOption
                  ? next => {
                      const pick = pickFromSurfaceKnot(
                        premiumSurface,
                        next.yi,
                        next.ti,
                      );
                      if (pick) onSelectOption(pick);
                    }
                  : undefined
              }
            />
          </div>
        </div>
      );
    }
    if (optionMode && optionView === 'skew' && smilePack) {
      const stretch = fillParent || tall;
      const metricUsed: SurfaceMetric = surfaceSmile ? smileMetric : 'vol';
      const pickPoint = onSelectOption
        ? (p: SmileSourcePoint) => {
            const pick =
              p.surfaceYi != null && premiumSurface
                ? pickFromSurfaceKnot(premiumSurface, p.surfaceYi, smileTi)
                : pickFromSmilePoint(
                    p,
                    premiumSurface?.tenors[smileTi]?.months,
                  );
            if (pick) onSelectOption(pick);
          }
        : undefined;
      return (
        <div
          className={
            stretch
              ? 'flex h-full min-h-0 min-w-0 w-full flex-col'
              : undefined
          }
        >
          {/* Same control-bar row as Surface / the Tape's Period bar. */}
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-1.5">
            <span className="text-[11px] font-semibold text-slate-400">
              Smile:
            </span>
            {surfaceSmile ? (
              <SurfaceChipGroup
                value={smileMetric}
                onChange={setSmileMetric}
                ariaLabel="Smile metric"
                options={[
                  { id: 'premium', label: 'Prem' },
                  { id: 'vol', label: 'Vol' },
                ]}
              />
            ) : null}
            <SurfaceChipGroup
              value={smileMode}
              onChange={setSmileMode}
              ariaLabel="Smile view"
              options={[
                { id: 'plot', label: 'Plot' },
                { id: 'grid', label: 'Grid' },
              ]}
            />
            {surfaceSmile && premiumSurface ? (
              <OptionTenorSelect
                surface={premiumSurface}
                selectedTi={smileTi}
                onPickTenor={commitTenorColumn}
              />
            ) : null}
          </div>
          {smileMode === 'grid' ? (
            <div
              className={
                stretch ? 'min-h-0 min-w-0 flex-1 overflow-auto' : 'overflow-auto'
              }
              style={
                stretch
                  ? undefined
                  : { height: Math.max(120, height - TAPE_PERIOD_ROW_H) }
              }
            >
              <SmileGrid
                points={smilePack.points}
                selectedIndex={smilePack.selectedIndex}
                onSelect={pickPoint}
              />
            </div>
          ) : (
            <div
              className={
                stretch ? 'flex min-h-0 min-w-0 flex-1 flex-col' : undefined
              }
            >
              <SmilePlot
                pack={smilePack}
                metric={metricUsed}
                height={Math.max(120, height - TAPE_PERIOD_ROW_H)}
                fillParent={stretch}
                premiumBid={premiumBid}
                premiumAsk={premiumAsk}
                onSelect={pickPoint}
              />
            </div>
          )}
        </div>
      );
    }
    if (optionMode && view === 'payout' && payout && pay) {
      return (
        <PayoutPlot
          payout={payout}
          height={height}
          fillParent={fillParent || tall}
          onSelect={
            onSelectOption
              ? spot => {
                  const pick = pickFromPayoutSpot(spot);
                  if (pick) onSelectOption(pick);
                }
              : undefined
          }
        />
      );
    }
    return (
      <p className="px-3 py-10 text-center text-[10px] text-slate-500">
        {empty ?? 'No chart'}
      </p>
    );
  };

  const frame = (tall: boolean, height: number, canExpand: boolean) => {
    const inner = chartInner(height, tall);
    const viewport = (
      <div
        className={`flex min-h-0 min-w-0 w-full flex-col overflow-hidden ${
          tall || fillParent
            ? 'h-full min-h-[220px] flex-1'
            : 'h-[340px] min-h-[340px]'
        }`}
      >
        <div className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col">
          {inner}
        </div>
      </div>
    );
    if (!framed) return viewport;
    if (optionMode) {
      return (
        <ChartViewFrame
          value={optionView}
          onChange={setOptionView}
          options={OPTION_CHART_VIEWS}
          ariaLabel="Desk chart view"
          onExpand={canExpand ? () => setFullScreen(true) : undefined}
          // Docked toolbar, same chrome and position as the Spot/FWD pane's
          // Path/Tape toggle — never a floating pill over the plot.
          overlay={false}
          className={`overflow-hidden rounded-md border border-slate-800 bg-slate-950/80 ${
            tall ? 'relative flex h-full min-h-0 flex-1 flex-col' : 'min-h-0'
          }`}
        >
          {viewport}
        </ChartViewFrame>
      );
    }
    return (
      <div
        className={`overflow-hidden rounded-md border border-slate-800 bg-slate-950/80 ${
          tall ? 'h-full min-h-0' : ''
        }`}
      >
        {viewport}
      </div>
    );
  };

  return (
    <div
      className={
        fillParent || plotHeight != null
          ? 'flex h-full min-h-0 min-w-0 w-full flex-1 flex-col'
          : undefined
      }
    >
      {framed ? (
        /* Same fixed-height header row as the Book overlay's Spot/FWD pane —
           the docked view toggle below lands at the same y on every product. */
        <div className="mb-1.5 flex h-6 shrink-0 items-center justify-between gap-2">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
            {title}
          </div>
          <div className="flex min-w-0 shrink items-center gap-2">
            {headerExtra}
            <div className="truncate font-mono text-[9px] text-slate-600">
              {pair} · {tenorLabel}
              {note}
            </div>
          </div>
        </div>
      ) : null}
      {frame(fillParent || plotHeight != null, plotHeight ?? 340, framed)}
      {fullScreen && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="fixed inset-0 z-[240] flex flex-col bg-slate-950"
              role="dialog"
              aria-modal="true"
              aria-labelledby="desk-chart-full-title"
            >
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
                <div className="min-w-0">
                  <h2
                    id="desk-chart-full-title"
                    className="truncate text-sm font-medium text-slate-100"
                  >
                    {title} · {pair} · {tenorLabel}
                  </h2>
                  <p className="truncate font-mono text-[10px] text-slate-500">
                    Full screen{note} · Esc to close
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setFullScreen(false)}
                  className="rounded-md border border-slate-600 px-2.5 py-1 font-mono text-[11px] text-slate-300 hover:border-slate-400 hover:text-slate-100"
                >
                  Close
                </button>
              </div>
              <div
                className={`min-h-0 flex-1 p-3 ${
                  optionView === 'path' ? 'overflow-y-auto' : 'overflow-hidden'
                }`}
              >
                {frame(true, fullPlotH, false)}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function SmilePlot({
  pack,
  metric = 'vol',
  height = 220,
  fillParent = false,
  premiumBid,
  premiumAsk,
  onSelect,
}: {
  pack: SmilePack;
  /** Y axis — implied σ% or vanilla premium USD at ticket size. */
  metric?: SurfaceMetric;
  height?: number;
  fillParent?: boolean;
  premiumBid?: number | null;
  premiumAsk?: number | null;
  onSelect?: (point: SmileSourcePoint) => void;
}) {
  const [pick, setPick] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const n = pack.points.length;
  const committedI = pick ?? pack.selectedIndex;
  const shownI = hover ?? committedI;
  const shown = pack.points[shownI];
  const markerTime = pack.line[committedI]?.time ?? null;
  const volValues = pack.line.map(point => point.value).filter(Number.isFinite);
  const volMin = volValues.length > 0 ? Math.min(...volValues) : 0;
  const volMax = volValues.length > 0 ? Math.max(...volValues) : 1;
  const volPad = Math.max(
    (volMax - volMin) * 0.2,
    metric === 'premium' ? Math.max(volMax * 0.02, 1) : 0.25,
  );
  const priceFormat: LwPriceFormat =
    metric === 'premium'
      ? volMax >= 1000
        ? { precision: 0, minMove: 1 }
        : { precision: 2, minMove: 0.01 }
      : { precision: 2, minMove: 0.01 };

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending != null) {
      if (pending === pack.selectedIndex) pendingRef.current = null;
      return;
    }
    if (pick != null && pick !== pack.selectedIndex) setPick(null);
  }, [pack.selectedIndex, pick]);

  const fromTime = (time: number | null) => {
    if (time == null) return null;
    const exact = pack.line.findIndex(p => Number(p.time) === Number(time));
    if (exact >= 0) return exact;
    const i = lwIndexFromTime(time);
    return i >= 0 && i < n ? i : null;
  };

  return (
    <div
      className={
        fillParent
          ? 'relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col'
          : undefined
      }
    >
      <DeskLwChart
        kind="line"
        height={height}
        fillParent={fillParent}
        line={pack.line}
        tickLabels={pack.tickLabels}
        crosshairLabels={pack.crosshairLabels}
        markerTime={markerTime}
        markerText={
          pack.points[committedI]
            ? `K ${fmtPx(pack.points[committedI]!.strike)}`
            : 'K'
        }
        priceFormat={priceFormat}
        lineColor="#38bdf8"
        valueSuffix={metric === 'premium' ? '' : '%'}
        indexAxis
        priceRange={{ min: volMin - volPad, max: volMax + volPad }}
        onHoverTime={t => setHover(fromTime(t))}
        onClickTime={t => {
          const i = fromTime(t);
          if (i == null) return;
          pendingRef.current = i;
          setPick(i);
          const p = pack.points[i];
          if (p) onSelect?.(p);
        }}
      />
      <p
        className={
          fillParent
            ? 'pointer-events-none absolute inset-x-0 bottom-[22px] z-[1] bg-gradient-to-t from-slate-950/80 to-transparent px-2 pb-1.5 pt-6 font-mono text-[9px] text-slate-500'
            : 'px-2 pb-1.5 font-mono text-[9px] text-slate-500'
        }
      >
        {shown
          ? `${compactSmileLabel(shown.label)} · K ${fmtPx(shown.strike)} · σ ${shown.volPercent.toFixed(2)}%${
              shown.premiumUsd != null ? ` · ${fmtUsd(shown.premiumUsd)}` : ''
            }`
          : 'Click a knot to price that Δ / strike'}
        {premiumBid != null || premiumAsk != null
          ? ` · Prem bid ${fmtUsd(premiumBid ?? null)} · ask ${fmtUsd(premiumAsk ?? null)}`
          : ''}
      </p>
    </div>
  );
}

/** Smile as a table — one row per Δ / strike knot, σ and premium side by side. */
function SmileGrid({
  points,
  selectedIndex,
  onSelect,
}: {
  points: SmileSourcePoint[];
  selectedIndex: number;
  onSelect?: (point: SmileSourcePoint) => void;
}) {
  const hasPrem = points.some(p => p.premiumUsd != null);
  return (
    <table className="w-full border-collapse text-left">
      <thead className="sticky top-0 z-[2]">
        <tr>
          {['Δ / K', 'Strike', 'σ', ...(hasPrem ? ['Premium'] : [])].map(h => (
            <th
              key={h}
              className="bg-slate-950 px-2 py-1 font-mono text-[8px] font-medium text-slate-500"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {points.map((p, i) => {
          const on = i === selectedIndex;
          return (
            <tr
              key={`${p.label}-${i}`}
              onClick={onSelect ? () => onSelect(p) : undefined}
              title={onSelect ? 'Price this Δ / strike on the ticket' : undefined}
              className={`${onSelect ? 'cursor-pointer' : ''} ${
                on
                  ? 'bg-sky-500/15 text-sky-100'
                  : 'text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <td className="px-2 py-0.5 font-mono text-[9px] font-semibold">
                {smileAxisLabel(p)}
              </td>
              <td className="px-2 py-0.5 font-mono text-[9px] tabular-nums">
                {fmtPx(p.strike)}
              </td>
              <td className="px-2 py-0.5 font-mono text-[9px] tabular-nums">
                {p.volPercent.toFixed(2)}%
              </td>
              {hasPrem ? (
                <td className="px-2 py-0.5 font-mono text-[9px] tabular-nums">
                  {fmtUsd(p.premiumUsd)}
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type PayoutPack = NonNullable<ReturnType<typeof payoutLine>>;

function fmtRemainingLife(years: number): string {
  if (!(years > 0)) return 'Expiry';
  const days = years * 365;
  if (days < 1.5) return `${Math.max(1, Math.round(days * 24))}h`;
  const months = years * 12;
  if (months < 1.5) return `${Math.round(days)}d`;
  if (months >= 11.5) {
    const y = months / 12;
    return `${y.toFixed(y >= 10 ? 0 : 1)}y`;
  }
  return `${months.toFixed(1)}m`;
}

function PayoutPlot({
  payout,
  height = 220,
  fillParent = false,
  onSelect,
}: {
  payout: OptionPayoutCurve;
  height?: number;
  fillParent?: boolean;
  onSelect?: (spot: number) => void;
}) {
  const [lifePct, setLifePct] = useState(100);
  const [basis, setBasis] = useState<PayoutBasis>('forward');
  const [greek, setGreek] = useState<PayoutGreek>('delta');
  useEffect(() => {
    setLifePct(100);
  }, [payout.ccy, payout.tenorYears, payout.put, payout.longOption]);
  const tenorMonths = Math.max(0, payout.tenorYears * 12);
  const monthsLeft = (lifePct / 100) * tenorMonths;
  const lifeFrac = lifePct / 100;
  const lived = useMemo(
    () => payoutAtRemainingLife(payout, lifeFrac, basis),
    [payout, lifeFrac, basis],
  );
  const kinkSpot = payoutKinkSpot(payout, lifeFrac, basis);
  const markerLabel = basis === 'forward'
    ? `F=K ${fmtPx(kinkSpot)}`
    : `PV ${fmtPx(kinkSpot)}`;
  const pack = useMemo(
    () => payoutLine(lived, { spot: kinkSpot, label: markerLabel }, greek),
    [lived, kinkSpot, markerLabel, greek],
  );
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  const spotRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pack != null && pending != null && pending === pack.selectedIndex) {
      pendingRef.current = null;
    }
  }, [pack]);

  if (!pack) return null;
  const n = pack.points.length;
  const committedI = pack.selectedIndex;
  const shown = pack.points[committedI];
  const markerTime = pack.line[committedI]?.time ?? null;

  const fromTime = (time: number | null) => {
    if (time == null) return null;
    const exact = pack.line.findIndex(p => Number(p.time) === Number(time));
    if (exact >= 0) return exact;
    const i = lwIndexFromTime(time);
    return i >= 0 && i < n ? i : null;
  };

  const commit = (time: number | null) => {
    const i = fromTime(time);
    if (i == null) return;
    const p = pack.points[i];
    if (!p) return;
    pendingRef.current = i;
    spotRef.current = p.spot;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const spot = spotRef.current;
      if (spot != null) onSelect?.(spot);
    });
  };

  return (
    <div
      className={
        fillParent
          ? 'relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col'
          : undefined
      }
    >
      <div className="flex shrink-0 items-center gap-2 px-2 pt-1.5">
        <div className="flex shrink-0 rounded border border-slate-700 p-px">
          {([
            ['forward', 'FWD'],
            ['spot', 'Spot'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={basis === id}
              onClick={() => setBasis(id)}
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide ${
                basis === id
                  ? 'bg-slate-100 text-slate-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 rounded border border-slate-700 p-px">
          {GREEK_SWITCH.map(item => (
            <button
              key={item.id}
              type="button"
              aria-pressed={greek === item.id}
              title={item.hint}
              onClick={() => setGreek(item.id)}
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                greek === item.id
                  ? 'bg-amber-300 text-slate-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label
          htmlFor="payout-time-left"
          className="shrink-0 font-mono text-[9px] font-semibold uppercase tracking-wide text-slate-500"
        >
          Time left
        </label>
        <input
          id="payout-time-left"
          type="range"
          min={0}
          max={100}
          step={1}
          value={lifePct}
          aria-valuetext={fmtRemainingLife(payout.tenorYears * (lifePct / 100))}
          onChange={event => setLifePct(Number(event.target.value))}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-sky-400"
        />
        <input
          type="number"
          min={0}
          max={Number(tenorMonths.toFixed(2))}
          step={tenorMonths >= 2 ? 0.1 : 0.01}
          value={Number(monthsLeft.toFixed(2))}
          aria-label="Remaining months before expiration"
          onChange={event => {
            const months = Number(event.target.value);
            if (!Number.isFinite(months) || !(tenorMonths > 0)) return;
            const next = Math.min(tenorMonths, Math.max(0, months));
            setLifePct((next / tenorMonths) * 100);
          }}
          className="w-14 rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-right font-mono text-[10px] text-sky-200 outline-none focus:border-sky-500"
        />
        <span className="w-12 shrink-0 text-right font-mono text-[10px] text-sky-300">
          {lifePct <= 0 ? 'Expiry' : fmtRemainingLife(payout.tenorYears * (lifePct / 100))}
        </span>
      </div>
      <p className="px-2 pb-0.5 font-mono text-[9px] text-slate-500">
        {basis === 'forward'
          ? 'Blue · forward value − premium · Green · discounted forward payoff'
          : 'Blue · spot value, both rates − premium · Green · discounted spot payoff'}
        {` · ${GREEK_SWITCH.find(item => item.id === greek)?.hint ?? ''}`}
      </p>
      <div className="relative flex min-h-0 w-full flex-1 flex-col">
      <DeskLwChart
        kind="line"
        height={height}
        fillParent={fillParent}
        line={pack.line}
        overlay={pack.overlay}
        overlayColor="#facc15"
        overlayLineWidth={1}
        companion={pack.companion}
        companionColor="#38bdf8"
        tickLabels={pack.labels}
        markerTime={markerTime}
        markerText={`K ${fmtPx(pack.strike)}`}
        refTime={pack.spotTime as UTCTimestamp}
        priceFormat={{ precision: 3, minMove: 0.001 }}
        lineColor="#34d399"
        indexAxis
        selectOnDrag
        zeroPrice={0}
        premiumPrice={(payout.longOption ? -1 : 1) * Math.abs(payout.premiumUsdM)}
        premiumText={`${payout.longOption ? '−' : '+'}${Math.abs(payout.premiumUsdM).toFixed(3)}`}
        priceRange={pack.priceRange}
        overlayPriceRange={pack.overlayPriceRange}
        overlayUnit={greek === 'delta' ? 'percent' : 'number'}
        overlayPrecision={greekPrecision(greek)}
        onClickTime={commit}
      />
      </div>
      <p
        className={
          fillParent
            ? 'pointer-events-none absolute inset-x-0 bottom-[22px] z-[1] bg-gradient-to-t from-slate-950/80 to-transparent px-2 pb-1.5 pt-6 font-mono text-[9px] text-slate-500'
            : 'px-2 pb-1.5 font-mono text-[9px] text-slate-500'
        }
      >
        {shown
          ? `K ${fmtPx(pack.strike)} · S ${fmtPx(pack.spot)} · P&L $${shown.pnlUsdM.toFixed(3)}M · M2M $${shown.markUsdM >= 0 ? '' : '−'}${Math.abs(shown.markUsdM).toFixed(3)}M`
          : 'Drag the strike line left / right'}
        {shown ? ` · ${fmtGreek(shown, greek, payout.notionalLocalM)}` : ''}
        {` · ${pack.extra}`}
      </p>
    </div>
  );
}
