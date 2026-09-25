'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type AutoscaleInfo,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  stabilizeTapeBarSec,
  TAPE_BAR_OPTIONS,
  tapeBarLabel,
  type TapeBarSec,
} from '@/lib/test-mode/tape-candles';

const INDEX_AXIS_H = 22;
const CONTROL_BAR_H = 36;
const TARGET_VISIBLE_BARS = 80;

const UP = '#34d399';
const DOWN = '#fb7185';
const GRID = '#1e293b';
const TEXT = '#94a3b8';
const BG = '#020617';
const CROSS = '#64748b';
const HAIR = '#e2e8f0';
const PICK = '#38bdf8';
const MARK = '#facc15';
const PLACED = '#94a3b8';

export type TimeInterval = TapeBarSec;

const INTERVAL_OPTIONS: { label: string; value: TimeInterval }[] =
  TAPE_BAR_OPTIONS.map(value => ({ label: tapeBarLabel(value), value }));

export type LwCandle = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type LwLinePt = {
  time: UTCTimestamp;
  value: number;
};

export type LwPriceFormat = {
  precision: number;
  minMove: number;
};

export type LwPriceRange = {
  min: number;
  max: number;
};

export type LwPriceLine = {
  price: number;
  title: string;
  color: string;
  /**
   * Native price-axis badge. Default true.
   *
   * IMPORTANT (lightweight-charts 5.2): `axisLabelVisible: false` hides BOTH
   * the axis rate AND the pane `title` — CustomPriceLinePriceAxisView returns
   * before applying the title. Callers that need a visible TP/SL marker must
   * keep this true and put only the role in `title` (rate stays on the axis)
   * so the bare rate is not duplicated inside the title string.
   */
  axisLabelVisible?: boolean;
};

/** Live/resting fill overlay: X = execution time, Y = fill rate. */
export type LwFillMark = {
  time: UTCTimestamp;
  price: number;
  text: string;
  /** Wall-clock label under the time-axis pin (e.g. 23:17:39). */
  clock?: string;
  /** Role of the order that produced this pin — shown with the clock so two
   * pins on one chart (OCO / strip) stay tellable apart by more than time. */
  role?: 'TP' | 'SL' | 'LIMIT';
  /** bid = sold / hit bid (rose ↓); ask = bought / lifted ask (emerald ↑). */
  side?: 'bid' | 'ask';
  /**
   * The ORDER's direction. Since the TP fill-side flip (2026-09-08) a sell
   * take-profit executes on the ASK, so the executed quote side no longer
   * implies direction — a sell fill must not paint a buy triangle. When set,
   * this wins over `side` for glyph direction and color.
   */
  dir?: 'buy' | 'sell';
  /**
   * 'placed' / 'change' = leave / amend pins (non-triangle); default 'fill'
   * = execution arrow.
   */
  kind?: 'fill' | 'placed' | 'change';
};

const DEFAULT_PRICE: LwPriceFormat = { precision: 5, minMove: 0.00001 };

export function DeskLwChart({
  kind,
  candles,
  line,
  height = 220,
  fillParent = false,
  priceFormat = DEFAULT_PRICE,
  tickLabels,
  crosshairLabels,
  markerTime,
  markerText = 'K',
  refTime,
  fillMarks,
  lockVisibleToMarker = false,
  lineColor = '#38bdf8',
  scale = 'fit',
  valueSuffix = '',
  indexAxis = false,
  selectOnDrag = false,
  showControlBar = false,
  currentInterval,
  onIntervalChange,
  autoInterval = true,
  intervalOptions,
  fitOnLoad = false,
  onHoverTime,
  onClickTime,
  zeroPrice,
  zeroLineTitle = '0',
  zeroLineColor = '#64748b',
  premiumPrice,
  premiumText,
  priceLines,
  priceRange,
  overlay,
  overlayColor = '#facc15',
  overlayLineWidth = 2,
  overlayPriceRange,
  overlayUnit = 'number',
  overlayPrecision = 2,
  companion,
  companionColor = '#38bdf8',
  seriesKey,
}: {
  kind: 'candlestick' | 'line' | 'histogram';
  candles?: readonly LwCandle[];
  line?: readonly LwLinePt[];
  height?: number;
  /** Stretch to the parent box instead of a fixed pixel height. */
  fillParent?: boolean;
  priceFormat?: LwPriceFormat;
  /** Map unix seconds → axis tick (sparse). */
  tickLabels?: ReadonlyMap<number, string>;
  /** Map unix seconds → crosshair / hover-marker label (every knot or candle). */
  crosshairLabels?: ReadonlyMap<number, string>;
  markerTime?: UTCTimestamp | null;
  markerText?: string;
  /** Secondary reference line (e.g. current spot on a payout) — grey, no dot. */
  refTime?: UTCTimestamp | null;
  /** Execution pins at (time, fill px). Plot + time-axis arrows only (no series markers). */
  fillMarks?: readonly LwFillMark[];
  /** Keep the time window on the marker (fill) instead of scrolling to now. */
  lockVisibleToMarker?: boolean;
  lineColor?: string;
  /** `stream` keeps a fixed bar width and scrolls; `fit` squashes the whole series. */
  scale?: 'fit' | 'stream';
  valueSuffix?: string;
  /** Constant P&L / price reference (dashed). */
  zeroPrice?: number | null;
  /** Label on the zeroPrice line — e.g. "LIMIT" for a resting order's level. */
  zeroLineTitle?: string;
  /** Color of the zeroPrice line. */
  zeroLineColor?: string;
  /** P&L level of the premium, drawn as a badge on the left scale. */
  premiumPrice?: number | null;
  /** Axis text for `premiumPrice`. Kept short — the scale is ~50px wide. */
  premiumText?: string;
  /** Multiple dashed reference levels, such as a TP/SL bracket. */
  priceLines?: readonly LwPriceLine[];
  /** Lock the Y scale so `zeroPrice` does not jump when the series moves. */
  priceRange?: LwPriceRange | null;
  /** Second series. On a payout this is Δ as a fraction of notional. */
  overlay?: readonly LwLinePt[];
  overlayColor?: string;
  overlayLineWidth?: 1 | 2 | 3 | 4;
  /** Lock the overlay scale (symmetric ±N so 0 matches the main axis). */
  overlayPriceRange?: LwPriceRange | null;
  /**
   * `percent` draws the overlay axis as −100%…100% and lets each scale use
   * its own formatter. The fraction itself stays on −1…1.
   */
  overlayUnit?: 'number' | 'percent';
  /** Decimals on a numeric overlay axis. Ignored while `overlayUnit` is percent. */
  overlayPrecision?: number;
  /** Extra series on the main P&L scale (next-valuation mark). */
  companion?: readonly LwLinePt[];
  companionColor?: string;
  /** Hide LWC date axis and draw HTML labels (vol smile / payout). */
  indexAxis?: boolean;
  /** Horizontal drag commits the nearest knot (payout strike line). */
  selectOnDrag?: boolean;
  /** Show interval selector and zoom controls. */
  showControlBar?: boolean;
  /** Current time interval in seconds. */
  currentInterval?: TimeInterval;
  /** Called when interval changes. */
  onIntervalChange?: (interval: TimeInterval) => void;
  /** Zoom-out coarsens candles (1m / 5m / 15m) so hours of tape stay readable. */
  autoInterval?: boolean;
  /** Restrict the interval selector; default is every TAPE_BAR_OPTIONS entry. */
  intervalOptions?: readonly TimeInterval[];
  /** A new series opens fitted to its whole span instead of the last 80 bars. */
  fitOnLoad?: boolean;
  onHoverTime?: (time: UTCTimestamp | null) => void;
  onClickTime?: (time: UTCTimestamp | null) => void;
  /**
   * Identity of the underlying series (e.g. the leg's own tapeQuoteKey).
   * `samePrefix` below only compares candle *times*, and two different
   * legs' tapes can land in the same wall-clock 5s buckets by coincidence
   * — without this, a leg switch can be mistaken for a live continuation
   * of the previous leg's series, leaving its old candles on screen under
   * the new ones instead of replacing them. A key change always forces a
   * full replace regardless of what the time-based check would conclude.
   */
  seriesKey?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<
    ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | null
  >(null);
  const overlaySeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const companionSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const labelsRef = useRef(tickLabels);
  labelsRef.current = tickLabels;
  const crosshairLabelsRef = useRef(crosshairLabels);
  crosshairLabelsRef.current = crosshairLabels;
  const candlesRef = useRef(candles);
  const lineRef = useRef(line);
  const overlayRef = useRef(overlay);
  const companionRef = useRef(companion);
  const markerTimeRef = useRef(markerTime);
  const refTimeRef = useRef(refTime);
  const markerTextRef = useRef(markerText);
  const fillMarksRef = useRef(fillMarks);
  const lockVisibleToMarkerRef = useRef(lockVisibleToMarker);
  const scaleRef = useRef(scale);
  const suffixRef = useRef(valueSuffix);
  suffixRef.current = valueSuffix;
  const zeroPriceRef = useRef(zeroPrice);
  zeroPriceRef.current = zeroPrice;
  const zeroLineTitleRef = useRef(zeroLineTitle);
  zeroLineTitleRef.current = zeroLineTitle;
  const zeroLineColorRef = useRef(zeroLineColor);
  zeroLineColorRef.current = zeroLineColor;
  const premiumPriceRef = useRef(premiumPrice);
  premiumPriceRef.current = premiumPrice;
  const priceLinesRef = useRef(priceLines);
  priceLinesRef.current = priceLines;
  const priceRangeRef = useRef(priceRange);
  priceRangeRef.current = priceRange;
  const overlayPriceRangeRef = useRef(overlayPriceRange);
  overlayPriceRangeRef.current = overlayPriceRange;
  const zeroLineRef = useRef<{ price: number; line: IPriceLine }[]>([]);
  const hoverTimeRef = useRef(onHoverTime);
  hoverTimeRef.current = onHoverTime;
  const clickTimeRef = useRef(onClickTime);
  clickTimeRef.current = onClickTime;
  const lastCandlesRef = useRef<LwCandle[]>([]);
  const seriesKeyRef = useRef(seriesKey);
  seriesKeyRef.current = seriesKey;
  const lastPushedSeriesKeyRef = useRef<string | undefined>(undefined);
  const lastPushedIntervalRef = useRef<TimeInterval | null>(null);
  const currentIntervalRef = useRef<TimeInterval>(currentInterval ?? 5);
  const onIntervalChangeRef = useRef(onIntervalChange);
  const autoIntervalRef = useRef(autoInterval);
  const fitOnLoadRef = useRef(fitOnLoad);
  const applyingRangeRef = useRef(false);
  const pendingFitBarsRef = useRef<TimeInterval | null>(null);
  const userScaledRef = useRef(false);
  const userPriceScaledRef = useRef(false);
  const forceLockPriceRef = useRef(false);
  const autoIntervalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [axisTicks, setAxisTicks] = useState<
    { x: number; label: string; on?: boolean }[]
  >([]);
  const [hair, setHair] = useState<{ x: number; y: number } | null>(null);
  const [dragHair, setDragHair] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [hoverTip, setHoverTip] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [zeroY, setZeroY] = useState<number | null>(null);
  const [premiumMark, setPremiumMark] = useState<{ y: number; left: number } | null>(null);
  /** Pane edges in host pixels so rules stop before either price scale. */
  const [plotX, setPlotX] = useState<{ x1: number; x2: number } | null>(null);
  const [refX, setRefX] = useState<number | null>(null);
  const [fillPins, setFillPins] = useState<
    {
      x: number;
      y: number;
      axisY: number;
      text: string;
      clock: string;
      role?: 'TP' | 'SL' | 'LIMIT';
      side?: 'bid' | 'ask';
      dir?: 'buy' | 'sell';
      kind?: 'fill' | 'placed' | 'change';
    }[]
  >([]);
  candlesRef.current = candles;
  lineRef.current = line;
  overlayRef.current = overlay;
  companionRef.current = companion;
  markerTimeRef.current = markerTime;
  refTimeRef.current = refTime;
  markerTextRef.current = markerText;
  fillMarksRef.current = fillMarks;
  lockVisibleToMarkerRef.current = lockVisibleToMarker;
  scaleRef.current = scale;
  currentIntervalRef.current = currentInterval ?? 5;
  onIntervalChangeRef.current = onIntervalChange;
  autoIntervalRef.current = autoInterval;
  fitOnLoadRef.current = fitOnLoad;
  const indexAxisRef = useRef(indexAxis);
  indexAxisRef.current = indexAxis;
  const showControlBarRef = useRef(showControlBar);
  showControlBarRef.current = showControlBar;
  const controlH = showControlBar ? CONTROL_BAR_H : 0;
  const plotH = fillParent
    ? 0
    : indexAxis
      ? Math.max(80, height - INDEX_AXIS_H - controlH)
      : height - controlH;
  const layoutH = fillParent ? 0 : plotH;
  const [hostReady, setHostReady] = useState(!fillParent);
  useLayoutEffect(() => {
    if (!fillParent) {
      setHostReady(true);
      return;
    }
    const el = hostRef.current;
    if (!el) return;
    const check = () => {
      if (el.clientWidth >= 8 && el.clientHeight >= 8) setHostReady(true);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fillParent]);

  const applyMarkers = () => {
    if (indexAxisRef.current) {
      markersRef.current?.setMarkers([]);
      emitHair();
      emitRef();
      emitFillPins();
      return;
    }
    const fills = fillMarksRef.current ?? [];
    if (fills.length > 0) {
      // Fill pins are SVG plot + time-axis arrows — clear series markers so
      // candles are not double-marked with the old triangle/dot shapes.
      markersRef.current?.setMarkers([]);
      emitFillPins();
      return;
    }
    const t = markerTimeRef.current;
    markersRef.current?.setMarkers(
      t != null
        ? [
            {
              time: t,
              position: 'aboveBar',
              color: MARK,
              shape: 'arrowDown',
              text: markerTextRef.current,
            },
          ]
        : [],
    );
    emitFillPins();
  };

  const emitFillPins = () => {
    if (indexAxisRef.current) {
      setFillPins(prev => (prev.length === 0 ? prev : []));
      return;
    }
    const chart = chartRef.current;
    const series = seriesRef.current;
    const marks = fillMarksRef.current ?? [];
    if (!chart || !series || marks.length === 0) {
      setFillPins(prev => (prev.length === 0 ? prev : []));
      return;
    }
    const paneH = chart.paneSize().height;
    const hostH = hostRef.current?.clientHeight ?? paneH;
    const axisBand = Math.max(10, hostH - paneH);
    // The library's own native time-tick text sits near the top of this
    // band — 0.35 put our arrow+clock right on top of it (reported: a fill
    // arrow rendering directly over "13:25:10"). Push to the lower part of
    // the band so the two rows are visually distinct instead of merged.
    const axisY = paneH + axisBand * 0.72;
    const next: {
      x: number;
      y: number;
      axisY: number;
      text: string;
      clock: string;
      role?: 'TP' | 'SL' | 'LIMIT';
      side?: 'bid' | 'ask';
      dir?: 'buy' | 'sell';
      kind?: 'fill' | 'placed' | 'change';
    }[] = [];
    for (const mark of marks) {
      if (!(mark.price > 0) || !Number.isFinite(mark.price)) continue;
      const paneX = chart.timeScale().timeToCoordinate(mark.time);
      const y = series.priceToCoordinate(mark.price);
      if (paneX == null || y == null || !Number.isFinite(paneX) || !Number.isFinite(y)) {
        continue;
      }
      next.push({
        x: hostX(chart, paneX),
        y,
        axisY,
        text: mark.text,
        clock: clockLabelForMark(mark, currentIntervalRef.current),
        role: mark.role,
        side: mark.side,
        dir: mark.dir,
        kind: mark.kind,
      });
    }
    setFillPins(next);
  };

  const emitHair = () => {
    if (!indexAxisRef.current) {
      setHair(null);
      return;
    }
    const chart = chartRef.current;
    const series = seriesRef.current;
    const t = markerTimeRef.current;
    if (!chart || !series || t == null) {
      setHair(null);
      return;
    }
    const pt = (lineRef.current ?? []).find(p => p.time === t);
    if (!pt || !Number.isFinite(pt.value)) {
      setHair(null);
      return;
    }
    const paneX = chart.timeScale().timeToCoordinate(t);
    const y = series.priceToCoordinate(pt.value);
    if (paneX == null || y == null || !Number.isFinite(paneX) || !Number.isFinite(y)) {
      setHair(null);
      return;
    }
    setHair({ x: hostX(chart, paneX), y });
  };

  const emitRef = () => {
    const chart = chartRef.current;
    const t = refTimeRef.current;
    if (!indexAxisRef.current || !chart || t == null) {
      setRefX(null);
      return;
    }
    const paneX = chart.timeScale().timeToCoordinate(t);
    setRefX(paneX != null && Number.isFinite(paneX) ? hostX(chart, paneX) : null);
  };

  const emitPlotX = () => {
    const next = measurePlotX(chartRef.current, hostRef.current);
    if (!next) return;
    setPlotX(prev => (prev && prev.x1 === next.x1 && prev.x2 === next.x2 ? prev : next));
  };

  const emitZero = () => {
    const series = seriesRef.current;
    const z = zeroPriceRef.current;
    if (!series || z == null || !Number.isFinite(z)) {
      setZeroY(null);
      return;
    }
    const y = series.priceToCoordinate(z);
    setZeroY(y != null && Number.isFinite(y) ? y : null);
  };

  const emitPremium = () => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const price = premiumPriceRef.current;
    if (!chart || !series || price == null || !Number.isFinite(price)) {
      setPremiumMark(null);
      return;
    }
    const y = series.priceToCoordinate(price);
    const left = chart.priceScale('left').width();
    if (y == null || !Number.isFinite(y) || !(left > 8)) {
      setPremiumMark(null);
      return;
    }
    setPremiumMark({ y, left });
  };

  const applyZeroLine = () => {
    const series = seriesRef.current;
    if (!series) return;
    const configured = priceLinesRef.current ?? [];
    const lines = configured.length > 0
      ? configured
      : zeroPriceRef.current != null && Number.isFinite(zeroPriceRef.current)
        ? [{
            price: zeroPriceRef.current,
            color: zeroLineColorRef.current,
            title: zeroLineTitleRef.current,
          }]
        : [];
    const wanted = lines.filter(line => Number.isFinite(line.price));
    const indexPlot = indexAxisRef.current && configured.length === 0;
    const optionsFor = (line: typeof wanted[number]) => ({
      price: line.price,
      color: line.color,
      lineWidth: 1 as const,
      lineStyle: LineStyle.Dashed,
      // The payout chart draws 0 P&L itself, as a solid rule. The native
      // dashed line would sit on top of it.
      lineVisible: indexPlot ? false : true,
      // Must stay true when `title` is set — LWC 5.2 drops the pane title
      // whenever axisLabelVisible is false (see CustomPriceLinePriceAxisView).
      axisLabelVisible: indexPlot ? false : (line.axisLabelVisible ?? true),
      title: line.title,
    });
    // A level sitting exactly on the market flips colour/title every tick as it
    // crosses. Tearing every line down and rebuilding makes that flicker visible,
    // so update in place whenever the set of prices is unchanged.
    const prev = zeroLineRef.current;
    const samePrices =
      prev.length === wanted.length && prev.every((p, i) => p.price === wanted[i]!.price);
    if (samePrices) {
      prev.forEach((p, i) => p.line.applyOptions(optionsFor(wanted[i]!)));
      return;
    }
    prev.forEach(p => series.removePriceLine(p.line));
    zeroLineRef.current = wanted.map(line => ({
      price: line.price,
      line: series.createPriceLine(optionsFor(line)),
    }));
  };

  const emitAxisTicks = () => {
    const chart = chartRef.current;
    const labels = labelsRef.current;
    if (!indexAxisRef.current || !chart || !labels || labels.size === 0) {
      setAxisTicks(prev => (prev.length === 0 ? prev : []));
      return;
    }
    const ts = chart.timeScale();
    const w = ts.width();
    const origin = chart.priceScale('left').width();
    const selectedSec = markerTimeRef.current;
    const next: { x: number; label: string; on?: boolean }[] = [];
    labels.forEach((label, sec) => {
      const x = ts.timeToCoordinate(sec as UTCTimestamp);
      if (x == null || !Number.isFinite(x)) return;
      if (x < -8 || (w > 0 && x > w + 8)) return;
      next.push({
        x: x + origin,
        label,
        on: selectedSec != null && Number(sec) === Number(selectedSec),
      });
    });
    if (next.length === 0) {
      const rows = lineRef.current ?? [];
      const span = Math.max(1, rows.length - 1);
      rows.forEach((pt, i) => {
        const label = labels.get(pt.time);
        if (!label || !(w > 0)) return;
        next.push({
          x: origin + (i / span) * w,
          label,
          on: selectedSec != null && Number(pt.time) === Number(selectedSec),
        });
      });
    }
    next.sort((a, b) => a.x - b.x);
    const spaced: { x: number; label: string; on?: boolean }[] = [];
    next.forEach(t => {
      let hitI = -1;
      for (let i = spaced.length - 1; i >= 0; i--) {
        if (Math.abs(spaced[i]!.x - t.x) < 28) {
          hitI = i;
          break;
        }
      }
      if (hitI >= 0) {
        if (t.on && !spaced[hitI]!.on) spaced[hitI] = t;
        return;
      }
      spaced.push(t);
    });
    setAxisTicks(spaced);
  };

  const samePrefix = (prev: readonly LwCandle[], next: readonly LwCandle[]) => {
    if (next.length < prev.length) return false;
    if (next.length - prev.length > 1) return false;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i]!.time !== next[i]!.time) return false;
    }
    return prev.length > 0;
  };

  const applyTimeRange = (from: number, to: number) => {
    const chart = chartRef.current;
    if (!chart || !(to > from) || !Number.isFinite(from) || !Number.isFinite(to)) {
      return;
    }
    applyingRangeRef.current = true;
    try {
      chart.timeScale().setVisibleRange({
        from: from as UTCTimestamp,
        to: to as UTCTimestamp,
      });
    } catch {
      /* range may be empty while data is swapping */
    }
    requestAnimationFrame(() => {
      applyingRangeRef.current = false;
    });
  };

  const fitViewport = () => {
    const chart = chartRef.current;
    if (!chart) return;
    applyingRangeRef.current = true;
    try {
      chart.timeScale().fitContent();
    } catch {
      /* empty series */
    }
    requestAnimationFrame(() => {
      applyingRangeRef.current = false;
    });
  };

  const visibleSpanSec = () => {
    const chart = chartRef.current;
    if (!chart) return 0;
    const logical = chart.timeScale().getVisibleLogicalRange();
    if (!logical) return 0;
    const bars = Math.max(0, logical.to - logical.from);
    return bars * currentIntervalRef.current;
  };

  const maybeAutoInterval = () => {
    if (!autoIntervalRef.current) return;
    const onChange = onIntervalChangeRef.current;
    if (!onChange || applyingRangeRef.current) return;
    const span = visibleSpanSec();
    if (!(span > 0)) return;
    const next = stabilizeTapeBarSec(currentIntervalRef.current, span);
    if (next !== currentIntervalRef.current) onChange(next);
  };

  const pushData = () => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    if (kind === 'candlestick') {
      const rows = [...(candlesRef.current ?? [])].sort((a, b) => a.time - b.time);
      const candleSeries = series as ISeriesApi<'Candlestick'>;
      const prev = lastCandlesRef.current;
      const streaming = scaleRef.current === 'stream';
      const savedRange = chart.timeScale().getVisibleRange();
      const intervalNow = currentIntervalRef.current;
      // samePrefix only compares candle *times* — two different series
      // (e.g. two strip legs) can land in the same wall-clock 5s buckets by
      // coincidence and look like a continuation. An explicit key change
      // overrides that: never treat it as an append/mutate/resample.
      const keyChanged =
        lastPushedSeriesKeyRef.current !== undefined
        && seriesKeyRef.current !== undefined
        && lastPushedSeriesKeyRef.current !== seriesKeyRef.current;
      lastPushedSeriesKeyRef.current = seriesKeyRef.current;
      const resampled =
        !keyChanged
        && lastPushedIntervalRef.current != null
        && lastPushedIntervalRef.current !== intervalNow;
      lastPushedIntervalRef.current = intervalNow;
      const pendingFit = pendingFitBarsRef.current;
      pendingFitBarsRef.current = null;
      const appended =
        !keyChanged
        && streaming && samePrefix(prev, rows) && rows.length === prev.length + 1;
      const mutated =
        !keyChanged
        && streaming && samePrefix(prev, rows) && rows.length === prev.length;
      // A leg switch swaps in a different leg's own tape — not a resample of
      // the same series and not a live continuation of it. Reset to the
      // auto-follow baseline so every leg opens the same way, regardless of
      // whatever the previously-viewed leg's zoom happened to be left at.
      const newSeries = !appended && !mutated && !resampled;
      if (newSeries) {
        userScaledRef.current = false;
        userPriceScaledRef.current = false;
      }
      if ((appended || mutated) && rows.length > 0) {
        candleSeries.update(rows[rows.length - 1]!);
      } else {
        candleSeries.setData(rows);
      }
      lastCandlesRef.current = rows;
      applyMarkers();
      if (pendingFit && rows.length > 0 && userScaledRef.current) {
        const last = Number(rows[rows.length - 1]!.time);
        applyTimeRange(
          last - TARGET_VISIBLE_BARS * pendingFit,
          last + pendingFit * 4,
        );
      } else if (resampled && savedRange && userScaledRef.current) {
        const from = timeToUnix(savedRange.from);
        const to = timeToUnix(savedRange.to);
        if (from != null && to != null) applyTimeRange(from, to);
      } else if (
        newSeries && streaming && rows.length > 0 && !fitOnLoadRef.current
      ) {
        // (fitOnLoad series fall through to fitViewport below instead.)
        // Same window on every leg: the last TARGET_VISIBLE_BARS bars at the
        // current interval, right-anchored. fitContent() would zoom to that
        // leg's own full recorded history instead, so a leg placed a minute
        // ago and one placed an hour ago would land on different zoom levels
        // (and, via the auto-interval follow above, different bar sizes).
        const last = Number(rows[rows.length - 1]!.time);
        applyTimeRange(
          last - TARGET_VISIBLE_BARS * intervalNow,
          last + intervalNow * 4,
        );
      } else if (!userScaledRef.current) {
        fitViewport();
      }
    } else if (kind === 'histogram') {
      const rows = [...(lineRef.current ?? [])]
        .sort((a, b) => a.time - b.time)
        .map(p => ({
          time: p.time,
          value: p.value,
          color: p.value >= 0 ? UP : DOWN,
        }));
      (series as ISeriesApi<'Histogram'>).setData(rows);
      applyMarkers();
      chart.timeScale().fitContent();
    } else {
      const rows = [...(lineRef.current ?? [])].sort((a, b) => a.time - b.time);
      (series as ISeriesApi<'Line'>).setData(rows);
      const overlayRows = [...(overlayRef.current ?? [])].sort(
        (a, b) => a.time - b.time,
      );
      overlaySeriesRef.current?.setData(overlayRows);
      const companionRows = [...(companionRef.current ?? [])].sort(
        (a, b) => a.time - b.time,
      );
      companionSeriesRef.current?.setData(companionRows);
      chart.priceScale('left').applyOptions({
        visible: Boolean(overlayPriceRangeRef.current) || overlayRows.length > 1,
      });
      applyMarkers();
      chart.timeScale().fitContent();
    }
    const lockScale = (
      scaleId: 'left' | 'right',
      range: LwPriceRange | null | undefined,
      resetAuto = false,
    ) => {
      if (
        !range
        || !Number.isFinite(range.min)
        || !Number.isFinite(range.max)
      ) {
        return;
      }
      const ps = chart.priceScale(scaleId);
      if (resetAuto) ps.setAutoScale(true);
      ps.setVisibleRange({ from: range.min, to: range.max });
      ps.setAutoScale(false);
    };
    const dual = Boolean(overlayPriceRangeRef.current);
    if (!userPriceScaledRef.current || forceLockPriceRef.current) {
      const resetAuto = forceLockPriceRef.current;
      forceLockPriceRef.current = false;
      lockScale(dual ? 'left' : 'right', priceRangeRef.current, resetAuto);
      lockScale('right', overlayPriceRangeRef.current, resetAuto);
    }
    applyZeroLine();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      emitAxisTicks();
      emitHair();
      emitRef();
      emitPlotX();
      emitZero();
      emitPremium();
      emitFillPins();
    }));
  };

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    if (fillParent && !hostReady) return;
    userScaledRef.current = false;
    userPriceScaledRef.current = false;
    lastCandlesRef.current = [];
    lastPushedSeriesKeyRef.current = undefined;

    const streaming = scale === 'stream';
    const hasControlBar = showControlBar;
    const dualAxis = Boolean(overlayPriceRange);
    const startW = Math.max(el.clientWidth, 8);
    const startH = Math.max(el.clientHeight, fillParent ? 8 : plotH);
    const chart = createChart(el, {
      // Flex remounts (Option → Forward) often measure 0 on the first
      // frame; LWC autoSize then sticks on an empty pane. Size the host
      // ourselves once it has a box.
      autoSize: !fillParent,
      width: startW,
      ...(fillParent || plotH <= 0 ? { height: startH } : { height: plotH }),
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: TEXT,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      ...(indexAxis && !showControlBar
        ? {
            handleScroll: {
              mouseWheel: false,
              pressedMouseMove: false,
              horzTouchDrag: false,
              vertTouchDrag: false,
            },
            handleScale: {
              axisPressedMouseMove: false,
              mouseWheel: false,
              pinch: false,
            },
          }
        : showControlBar
          ? {
              handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true,
                horzTouchDrag: true,
                vertTouchDrag: false,
              },
              handleScale: {
                axisPressedMouseMove: { time: true, price: true },
                axisDoubleClickReset: { time: true, price: true },
                mouseWheel: true,
                pinch: true,
              },
            }
          : {}),
      crosshair: {
        mode: streaming ? CrosshairMode.Normal : CrosshairMode.Magnet,
        vertLine: indexAxis
          ? {
              visible: true,
              color: 'rgba(0,0,0,0)',
              width: 1,
              labelVisible: false,
            }
          : { color: CROSS, width: 1, labelBackgroundColor: '#0f172a' },
        horzLine: indexAxis
          ? {
              visible: true,
              color: 'rgba(0,0,0,0)',
              width: 1,
              labelVisible: false,
            }
          : { color: CROSS, width: 1, labelBackgroundColor: '#0f172a' },
      },
      rightPriceScale: {
        borderColor: GRID,
        // Percent Δ is exactly −1…1. Extra margins would print ±120% past the
        // bound. Zero stays centered, so it still shares a pixel with P&L.
        scaleMargins: overlayUnit === 'percent' || overlayPriceRange
          ? { top: 0, bottom: 0 }
          : { top: 0.1, bottom: 0.1 },
        textColor: dualAxis ? overlayColor : TEXT,
      },
      leftPriceScale: {
        visible: dualAxis || Boolean(overlay && overlay.length > 1),
        borderColor: GRID,
        scaleMargins: { top: 0.1, bottom: 0.1 },
        textColor: dualAxis ? TEXT : overlayColor,
      },
      timeScale: {
        borderColor: GRID,
        visible: !indexAxis,
        timeVisible: streaming,
        secondsVisible: streaming,
        barSpacing: streaming ? 8 : 6,
        minBarSpacing: streaming ? 1.5 : 0.5,
        rightOffset: streaming ? 4 : 0,
        shiftVisibleRangeOnNewBar: streaming,
        fixLeftEdge: !streaming,
        fixRightEdge: !streaming,
        tickMarkMaxCharacterLength: 8,
        tickMarkFormatter: streaming
          ? (time: Time) => formatClock(time, currentIntervalRef.current)
          : (time: Time) => {
              const sec = timeToUnix(time);
              if (sec == null) return '';
              return labelsRef.current?.get(sec) ?? '';
            },
      },
      localization: {
        // A percent overlay needs its own formatter. The chart-wide one would
        // paint that same text on the P&L scale.
        priceFormatter: overlayUnit === 'percent' || overlayPrecision !== 2
          ? undefined
          : (price: number) =>
              `${formatPrice(price, priceFormat)}${suffixRef.current}`,
        timeFormatter: (time: Time) => {
          if (streaming) return formatClock(time, currentIntervalRef.current);
          const sec = timeToUnix(time);
          if (sec == null) return '';
          return (
            crosshairLabelsRef.current?.get(sec)
            ?? labelsRef.current?.get(sec)
            ?? ''
          );
        },
      },
    });

    const series =
      kind === 'candlestick'
        ? chart.addSeries(CandlestickSeries, {
            upColor: UP,
            downColor: DOWN,
            borderUpColor: UP,
            borderDownColor: DOWN,
            wickUpColor: UP,
            wickDownColor: DOWN,
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: {
              type: 'price',
              precision: priceFormat.precision,
              minMove: priceFormat.minMove,
            },
            autoscaleInfoProvider: (base: () => AutoscaleInfo | null) =>
              autoscaleLockedRange(
                userPriceScaledRef.current,
                priceRangeRef.current,
                base,
              ),
          })
        : kind === 'histogram'
          ? chart.addSeries(HistogramSeries, {
              color: UP,
              priceLineVisible: false,
              lastValueVisible: true,
              base: 0,
              priceFormat: {
                type: 'price',
                precision: priceFormat.precision,
                minMove: priceFormat.minMove,
              },
              autoscaleInfoProvider: (base: () => AutoscaleInfo | null) =>
                autoscaleLockedRange(
                  userPriceScaledRef.current,
                  priceRangeRef.current,
                  base,
                ),
            })
        : chart.addSeries(LineSeries, {
            color: lineColor,
            lineWidth: 2,
            priceScaleId: dualAxis ? 'left' : 'right',
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            priceFormat: {
              type: 'price',
              precision: priceFormat.precision,
              minMove: priceFormat.minMove,
            },
            // Same fallback as the candle series: no locked range means
            // LWC's own autoscale, never "no range".
            autoscaleInfoProvider: (base: () => AutoscaleInfo | null) =>
              autoscaleLockedRange(
                userPriceScaledRef.current,
                priceRangeRef.current,
                base,
              ),
          });

    chartRef.current = chart;
    seriesRef.current = series;
    overlaySeriesRef.current =
      kind === 'line'
        ? chart.addSeries(LineSeries, {
            color: overlayColor,
            lineWidth: overlayLineWidth,
            lineStyle: LineStyle.Solid,
            priceScaleId: dualAxis ? 'right' : 'left',
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            priceFormat: overlayUnit === 'percent'
              ? {
                  type: 'custom',
                  minMove: 0.01,
                  formatter: (price: number) => `${Math.round(price * 100)}%`,
                }
              : {
                  type: 'price',
                  precision: overlayPrecision,
                  minMove: 10 ** -overlayPrecision,
                },
            autoscaleInfoProvider: (base: () => AutoscaleInfo | null) =>
              autoscaleLockedRange(
                userPriceScaledRef.current,
                overlayPriceRangeRef.current,
                base,
              ),
          })
        : null;
    companionSeriesRef.current =
      kind === 'line' && Boolean(companion && companion.length > 1)
        ? chart.addSeries(LineSeries, {
            color: companionColor,
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            priceScaleId: dualAxis ? 'left' : 'right',
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            priceFormat: {
              type: 'price',
              precision: priceFormat.precision,
              minMove: priceFormat.minMove,
            },
            autoscaleInfoProvider: (base: () => AutoscaleInfo | null) =>
              autoscaleLockedRange(
                userPriceScaledRef.current,
                priceRangeRef.current,
                base,
              ),
          })
        : null;
    markersRef.current = createSeriesMarkers(series);
    const asTime = (time: Time | undefined): UTCTimestamp | null => {
      const sec = timeToUnix(time);
      return sec != null ? (sec as UTCTimestamp) : null;
    };
    const timeFromParam = (param: {
      time?: Time;
      point?: { x: number; y: number } | undefined;
    }): UTCTimestamp | null => {
      const fromEvent = asTime(param.time);
      if (fromEvent != null) return nearestLineTime(fromEvent, param.point?.x);
      if (param.point) return nearestLineTime(null, param.point.x);
      return null;
    };
    chart.subscribeCrosshairMove(param => {
      const t = timeFromParam(param);
      hoverTimeRef.current?.(t);
      // Stream/candlestick hover marker: Bid/Ask · bar Δ · ticks · fill.
      // Index-axis plots (smile/payout) keep their own footer via onHoverTime.
      if (indexAxisRef.current) {
        setHoverTip(null);
        return;
      }
      const labels = crosshairLabelsRef.current;
      const text =
        t != null && labels && labels.size > 0
          ? labels.get(Number(t))
          : undefined;
      const pt = param.point;
      if (
        text
        && pt
        && Number.isFinite(pt.x)
        && Number.isFinite(pt.y)
      ) {
        setHoverTip({ x: pt.x, y: pt.y, text });
      } else {
        setHoverTip(null);
      }
    });
    chart.subscribeClick(param => {
      clickTimeRef.current?.(timeFromParam(param));
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      emitAxisTicks();
      emitHair();
      emitRef();
      emitPlotX();
      emitZero();
      emitPremium();
      emitFillPins();
      if (applyingRangeRef.current) return;
      userScaledRef.current = true;
      if (autoIntervalTimerRef.current) clearTimeout(autoIntervalTimerRef.current);
      autoIntervalTimerRef.current = setTimeout(() => {
        autoIntervalTimerRef.current = null;
        maybeAutoInterval();
      }, 140);
    });

    const allowPriceAxisScale = !(indexAxis && !hasControlBar);
    const markUserPriceScale = (clientX: number) => {
      if (!allowPriceAxisScale) return;
      if (!pointerOnPriceScale(chart, el, clientX)) return;
      userPriceScaledRef.current = true;
      try {
        chart.priceScale('right').setAutoScale(false);
        chart.priceScale('left').setAutoScale(false);
      } catch {
        /* scale may be unused */
      }
    };
    const onPriceAxisPointerDown = (ev: PointerEvent) => {
      markUserPriceScale(ev.clientX);
    };
    const onPriceAxisWheel = (ev: WheelEvent) => {
      markUserPriceScale(ev.clientX);
    };
    const onPriceAxisDblClick = (ev: MouseEvent) => {
      if (!allowPriceAxisScale) return;
      if (!pointerOnPriceScale(chart, el, ev.clientX)) return;
      userPriceScaledRef.current = false;
      forceLockPriceRef.current = true;
      pushData();
    };
    el.addEventListener('pointerdown', onPriceAxisPointerDown, true);
    el.addEventListener('wheel', onPriceAxisWheel, { passive: true, capture: true });
    el.addEventListener('dblclick', onPriceAxisDblClick, true);

    pushData();

    let lastWh = { w: 0, h: 0 };
    const resizeToHost = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      if (w < 2 || h < 2) return;
      if (!fillParent && chart.autoSizeActive()) return;
      if (w === lastWh.w && h === lastWh.h) return;
      const wasTiny = lastWh.w < 8 || lastWh.h < 8;
      lastWh = { w, h };
      chart.resize(w, h);
      emitPlotX();
      if (wasTiny) pushData();
    };
    resizeToHost();
    const roRaf = { id: 0 as number };
    const ro = new ResizeObserver(() => {
      if (roRaf.id) cancelAnimationFrame(roRaf.id);
      roRaf.id = requestAnimationFrame(() => {
        roRaf.id = 0;
        resizeToHost();
      });
    });
    ro.observe(el);

    return () => {
      el.removeEventListener('pointerdown', onPriceAxisPointerDown, true);
      el.removeEventListener('wheel', onPriceAxisWheel, true);
      el.removeEventListener('dblclick', onPriceAxisDblClick, true);
      if (roRaf.id) cancelAnimationFrame(roRaf.id);
      ro.disconnect();
      if (autoIntervalTimerRef.current) {
        clearTimeout(autoIntervalTimerRef.current);
        autoIntervalTimerRef.current = null;
      }
      markersRef.current?.detach();
      markersRef.current = null;
      zeroLineRef.current = [];
      overlaySeriesRef.current = null;
      companionSeriesRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      lastCandlesRef.current = [];
      lastPushedIntervalRef.current = null;
      lastPushedSeriesKeyRef.current = undefined;
      setHoverTip(null);
      chart.remove();
    };
  }, [kind, layoutH, fillParent, hostReady, lineColor, overlayColor, overlayLineWidth, companionColor, priceFormat.precision, priceFormat.minMove, scale, indexAxis, showControlBar, Boolean(overlayPriceRange), overlayUnit, overlayPrecision, Boolean(companion && companion.length > 1)]);

  useEffect(() => {
    if (overlayUnit !== 'percent') return;
    chartRef.current?.priceScale('right').applyOptions({
      scaleMargins: { top: 0, bottom: 0 },
    });
  }, [overlayUnit]);

  const seriesSig = [
    line ? line.map(p => `${p.time}:${p.value}`).join('|') : '',
    overlay ? overlay.map(p => `${p.time}:${p.value}`).join('|') : '',
    companion ? companion.map(p => `${p.time}:${p.value}`).join('|') : '',
    candles
      ? candles.map(c => `${c.time}:${c.open}:${c.high}:${c.low}:${c.close}`).join('|')
      : '',
  ].join('~');
  const fillSig = fillMarks
    ? fillMarks
        .map(m => `${m.time}:${m.price}:${m.text}:${m.side ?? ''}:${m.kind ?? ''}`)
        .join('|')
    : '';
  const priceLinesSig = priceLines
    ? priceLines.map(l => `${l.price}:${l.color}:${l.title ?? ''}:${l.axisLabelVisible ?? true}`).join('|')
    : '';
  const axisSig = tickLabels
    ? Array.from(tickLabels, ([t, l]) => `${t}:${l}`).join('|')
    : '';

  const rangeSig = priceRange
    ? `${priceRange.min}:${priceRange.max}`
    : '';
  const overlayRangeSig = overlayPriceRange
    ? `${overlayPriceRange.min}:${overlayPriceRange.max}`
    : '';

  useEffect(() => {
    pushData();
  }, [kind, seriesSig, markerTime, markerText, fillSig, axisSig, rangeSig, overlayRangeSig, zeroPrice, zeroLineTitle, zeroLineColor, premiumPrice, priceLinesSig]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || scale !== 'stream') return;
    const iv = currentInterval ?? 5;
    chart.timeScale().applyOptions({
      secondsVisible: iv < 60,
      timeVisible: true,
    });
  }, [currentInterval, scale]);

  function nearestLineTime(
    hinted: UTCTimestamp | null,
    x: number | null | undefined,
  ): UTCTimestamp | null {
    const rows = lineRef.current ?? [];
    if (rows.length === 0) return hinted;
    if (hinted != null) {
      const exact = rows.find(p => Number(p.time) === Number(hinted));
      if (exact) return exact.time;
    }
    const chart = chartRef.current;
    const origin = chart ? chart.priceScale('left').width() : 0;
    if (chart && x != null && Number.isFinite(x)) {
      const paneX = x - origin;
      let best: UTCTimestamp | null = null;
      let bestD = Infinity;
      for (const p of rows) {
        const cx = chart.timeScale().timeToCoordinate(p.time);
        if (cx == null || !Number.isFinite(cx)) continue;
        const d = Math.abs(cx - paneX);
        if (d < bestD) {
          bestD = d;
          best = p.time;
        }
      }
      if (best != null) return best;
    }
    if (x != null && Number.isFinite(x)) {
      const paneW = chart?.timeScale().width() ?? 0;
      const w = paneW > 0 ? paneW : (hostRef.current?.clientWidth ?? 0);
      const local = paneW > 0 ? x - origin : x;
      if (w > 0 && rows.length > 1) {
        const i = Math.round((local / w) * (rows.length - 1));
        return rows[Math.max(0, Math.min(rows.length - 1, i))]!.time;
      }
    }
    return hinted;
  }

  const pickFromClientX = (clientX: number): UTCTimestamp | null => {
    const host = hostRef.current;
    if (!host) return null;
    return nearestLineTime(null, clientX - host.getBoundingClientRect().left);
  };

  const hairAtClientX = (clientX: number): { x: number; y: number } | null => {
    const host = hostRef.current;
    const series = seriesRef.current;
    const t = pickFromClientX(clientX);
    if (!host || !series || t == null) return null;
    const x = clientX - host.getBoundingClientRect().left;
    const pt = (lineRef.current ?? []).find(p => Number(p.time) === Number(t));
    if (!pt || !Number.isFinite(pt.value)) return { x, y: hair?.y ?? 0 };
    const y = series.priceToCoordinate(pt.value);
    if (y == null || !Number.isFinite(y)) return { x, y: hair?.y ?? 0 };
    return { x, y };
  };

  const shownHair = dragHair ?? hair;
  // The time axis is hidden on payout charts, and its width() is then 0.
  // Measure the pane from the host so the rules still draw.
  const plotEdges = measurePlotX(chartRef.current, hostRef.current) ?? plotX;

  return (
    <div
      className={`flex w-full min-w-0 flex-col ${
        fillParent ? 'h-full min-h-[220px] min-w-0 flex-1' : ''
      }`}
      style={fillParent ? undefined : { height }}
    >
      {showControlBar ? (
        <ControlBar
          height={CONTROL_BAR_H}
          currentInterval={currentInterval}
          intervalOptions={intervalOptions}
          onIntervalChange={
            onIntervalChange
              ? interval => {
                  pendingFitBarsRef.current = interval;
                  onIntervalChange(interval);
                }
              : undefined
          }
          chart={chartRef.current}
          onFit={() => {
            userScaledRef.current = false;
            userPriceScaledRef.current = false;
            forceLockPriceRef.current = true;
            fitViewport();
            pushData();
          }}
          onManualScale={() => {
            userScaledRef.current = true;
          }}
        />
      ) : null}
      <div
        className="relative min-h-0 w-full min-w-0 flex-1"
        style={fillParent ? undefined : { height: plotH }}
      >
        <div ref={hostRef} className="absolute inset-0 h-full w-full" />
        {indexAxis ? (
          <IndexPickLayer
            selectOnDrag={selectOnDrag}
            onHover={t => hoverTimeRef.current?.(t)}
            onPick={t => clickTimeRef.current?.(t)}
            pickX={pickFromClientX}
            hairAt={hairAtClientX}
            onDragHair={setDragHair}
          />
        ) : null}
        {indexAxis && (shownHair || zeroY != null || refX != null || premiumMark) ? (
          <svg
            className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible"
            aria-hidden="true"
          >
            {zeroY != null && plotEdges ? (
              <>
                <line
                  x1={plotEdges.x1}
                  y1={zeroY}
                  x2={plotEdges.x2}
                  y2={zeroY}
                  stroke="#94a3b8"
                  strokeWidth={1.25}
                />
                <text
                  x={plotEdges.x1 + 6}
                  y={zeroY - 4}
                  fill="#94a3b8"
                  fontSize="9"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  0 P&L
                </text>
              </>
            ) : null}
            {premiumMark && premiumText ? (
              <g>
                <title>Premium</title>
                <line
                  x1={premiumMark.left + 7}
                  y1={premiumMark.y}
                  x2={premiumMark.left + 36}
                  y2={premiumMark.y}
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                />
                <rect
                  x={1}
                  y={premiumMark.y - 15}
                  width={Math.max(20, premiumMark.left - 1)}
                  height={30}
                  fill="#f59e0b"
                />
                <polygon
                  points={`${premiumMark.left - 1},${premiumMark.y - 5} ${premiumMark.left + 7},${premiumMark.y} ${premiumMark.left - 1},${premiumMark.y + 5}`}
                  fill="#f59e0b"
                />
                <text
                  x={premiumMark.left / 2}
                  y={premiumMark.y - 2}
                  textAnchor="middle"
                  fill="#1c1917"
                  fontSize="9"
                  fontWeight={700}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  PREM
                </text>
                <text
                  x={premiumMark.left / 2}
                  y={premiumMark.y + 10}
                  textAnchor="middle"
                  fill="#1c1917"
                  fontSize="10"
                  fontWeight={700}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {premiumText}
                </text>
              </g>
            ) : null}
            {refX != null ? (
              <line
                x1={refX}
                y1={0}
                x2={refX}
                y2="100%"
                stroke="#94a3b8"
                strokeWidth={1}
                strokeDasharray="3 4"
                opacity={0.7}
              />
            ) : null}
            {shownHair ? (
              <>
                <line
                  x1={shownHair.x}
                  y1={0}
                  x2={shownHair.x}
                  y2="100%"
                  stroke={HAIR}
                  strokeWidth={dragHair ? 2 : 1.25}
                  strokeDasharray="5 4"
                />
                {plotEdges ? (
                  <line
                    x1={plotEdges.x1}
                    y1={shownHair.y}
                    x2={plotEdges.x2}
                    y2={shownHair.y}
                    stroke={HAIR}
                    strokeWidth="1.25"
                    strokeDasharray="5 4"
                  />
                ) : null}
                <circle cx={shownHair.x} cy={shownHair.y} r="4.5" fill={PICK} />
              </>
            ) : null}
          </svg>
        ) : null}
        {hoverTip ? (
          <div
            className="pointer-events-none absolute z-[5] max-w-[min(100%,28rem)] rounded border border-slate-600/80 bg-slate-950/95 px-2 py-1 font-mono text-[9px] leading-snug text-slate-300 shadow-lg shadow-slate-950/60"
            style={{
              left: hoverTip.x,
              top: hoverTip.y,
              transform:
                hoverTip.x > (hostRef.current?.clientWidth ?? 0) * 0.55
                  ? hoverTip.y < 48
                    ? 'translate(calc(-100% - 10px), 8px)'
                    : 'translate(calc(-100% - 10px), calc(-100% - 8px))'
                  : hoverTip.y < 48
                    ? 'translate(10px, 8px)'
                    : 'translate(10px, calc(-100% - 8px))',
            }}
            role="status"
          >
            {hoverTip.text}
          </div>
        ) : null}
        {fillPins.length > 0 ? (
          <svg
            className="pointer-events-none absolute inset-0 z-[3] h-full w-full overflow-visible"
            aria-label="Trade fill"
          >
            {/*
              Two pins close in time (a strip's PLACED + a same-bar FILL, or
              an OCO's TP + SL) print their clock label at the same x and
              row, so the text overlapped into an unreadable smear. Stagger
              the label row whenever the next pin's label would sit within
              one label-width of the previous one still on that row.
            */}
            {(() => {
              const LABEL_HALF_WIDTH_PX = 42;
              const rows: number[] = [];
              const lastXAtRow = new Map<number, number>();
              for (const pin of fillPins) {
                let row = 0;
                while (
                  lastXAtRow.has(row)
                  && Math.abs(pin.x - lastXAtRow.get(row)!) < LABEL_HALF_WIDTH_PX * 2
                ) {
                  row += 1;
                }
                lastXAtRow.set(row, pin.x);
                rows.push(row);
              }
              return fillPins.map((pin, i) => {
                const labelRow = rows[i] ?? 0;
              const leave =
                pin.kind === 'placed' || pin.kind === 'change';
              const changed = pin.kind === 'change';
              // Triangle ORIENTATION (up/down) is the order's direction.
              // `dir` is authoritative when the caller sends it; `side`
              // (bid=sell, ask=buy) is the fallback for callers that predate
              // it — a take-profit fills on the opposite quote side from its
              // own direction (2026-09-08 flip), which is exactly why `dir`
              // exists: `side` alone points the arrow the wrong way for a TP.
              const buy =
                pin.dir != null ? pin.dir === 'buy' : pin.side !== 'bid';
              // COLOR is role, not direction: TP is always green, SL always
              // red, a plain/LIMIT pin keeps the direction color. Desk
              // instruction 2026-09-08 — color must read as "which bracket
              // leg fired," the arrow alone says which way it traded.
              const color = leave
                ? PLACED
                : pin.role === 'TP'
                  ? UP
                  : pin.role === 'SL'
                    ? DOWN
                    : buy
                      ? UP
                      : DOWN;
              return (
                <g key={`${pin.x}:${pin.y}:${i}`}>
                  {/* Vertical time guide — rates live on the right price axis. */}
                  <line
                    x1={pin.x}
                    y1={pin.y}
                    x2={pin.x}
                    y2={pin.axisY}
                    stroke={color}
                    strokeOpacity={0.4}
                    strokeWidth={1}
                    strokeDasharray="3 4"
                  />
                  {leave ? (
                    // Leave/amend ≠ fill: hollow shapes (never triangles).
                    changed ? (
                      <polygon
                        points={hollowDiamond(pin.x, pin.y)}
                        fill="none"
                        stroke={color}
                        strokeWidth={2.25}
                      />
                    ) : (
                      <circle
                        cx={pin.x}
                        cy={pin.y}
                        r={6}
                        fill="none"
                        stroke={color}
                        strokeWidth={2.25}
                      />
                    )
                  ) : (
                    <polygon
                      points={fillTriangle(pin.x, pin.y, buy)}
                      fill={color}
                      stroke="#0f172a"
                      strokeWidth={1}
                    />
                  )}
                  {/* Time-axis pin + timestamp (diamond for leave, arrow for fill). */}
                  {leave ? (
                    <polygon
                      points={timeAxisDiamond(pin.x, pin.axisY)}
                      fill={color}
                      stroke="#0f172a"
                      strokeWidth={0.75}
                    />
                  ) : (
                    <polygon
                      points={timeAxisArrow(pin.x, pin.axisY)}
                      fill={color}
                      stroke="#0f172a"
                      strokeWidth={0.75}
                    />
                  )}
                  {pin.clock ? (
                    <text
                      x={pin.x}
                      y={pin.axisY + 14 + labelRow * 11}
                      textAnchor="middle"
                      fill={color}
                      fontSize="9"
                      fontWeight={600}
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      stroke="#020617"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {pin.role ? `${pin.role} · ` : ''}{pin.clock}
                    </text>
                  ) : null}
                </g>
              );
              });
            })()}
          </svg>
        ) : null}
      </div>
      {indexAxis ? (
        <IndexAxisStrip
          height={INDEX_AXIS_H}
          ticks={axisTicks}
          selectOnDrag={selectOnDrag}
          onPick={t => clickTimeRef.current?.(t)}
          pickX={pickFromClientX}
        />
      ) : null}
    </div>
  );
}

function fillTriangle(cx: number, cy: number, up: boolean, r = 7): string {
  if (up) {
    return `${cx},${cy - r} ${cx - r},${cy + r * 0.65} ${cx + r},${cy + r * 0.65}`;
  }
  return `${cx},${cy + r} ${cx - r},${cy - r * 0.65} ${cx + r},${cy - r * 0.65}`;
}

/** Hollow diamond at amend / change rate (same family as placement circle). */
function hollowDiamond(cx: number, cy: number, r = 6.5): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

/** Upward arrow on the time axis under a fill (not used for place/change). */
function timeAxisArrow(cx: number, cy: number, r = 5): string {
  return `${cx},${cy - r} ${cx - r * 0.85},${cy + r * 0.55} ${cx + r * 0.85},${cy + r * 0.55}`;
}

/** Diamond pin on the time axis under place/change (distinct from fill arrow). */
function timeAxisDiamond(cx: number, cy: number, r = 4.5): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
}

function clockLabelForMark(
  mark: Pick<LwFillMark, 'clock' | 'text' | 'time'>,
  intervalSec: number,
): string {
  if (mark.clock && mark.clock.trim()) return mark.clock.trim();
  const fromText = mark.text.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  if (fromText?.[1]) return fromText[1];
  return formatClock(mark.time, intervalSec);
}

function IndexPickLayer({
  selectOnDrag,
  onHover,
  onPick,
  pickX,
  hairAt,
  onDragHair,
}: {
  selectOnDrag?: boolean;
  onHover: (time: UTCTimestamp | null) => void;
  onPick: (time: UTCTimestamp | null) => void;
  pickX: (clientX: number) => UTCTimestamp | null;
  hairAt: (clientX: number) => { x: number; y: number } | null;
  onDragHair: (next: { x: number; y: number } | null) => void;
}) {
  const originRef = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className={`absolute inset-0 z-[1] ${
        selectOnDrag ? 'cursor-ew-resize' : 'cursor-crosshair'
      }`}
      onPointerDown={e => {
        originRef.current = { x: e.clientX, y: e.clientY };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* capture optional */
        }
        if (selectOnDrag) {
          const t = pickX(e.clientX);
          onDragHair(hairAt(e.clientX));
          onPick(t);
        }
      }}
      onPointerMove={e => {
        const t = pickX(e.clientX);
        onHover(t);
        if (!originRef.current) return;
        if (selectOnDrag) {
          onDragHair(hairAt(e.clientX));
          onPick(t);
        }
      }}
      onPointerUp={e => {
        const origin = originRef.current;
        originRef.current = null;
        onDragHair(null);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        if (!origin) return;
        const dist = Math.hypot(e.clientX - origin.x, e.clientY - origin.y);
        if (!selectOnDrag && dist > 16) return;
        onPick(pickX(e.clientX));
      }}
      onPointerCancel={() => {
        originRef.current = null;
        onDragHair(null);
      }}
      onPointerLeave={() => {
        if (!originRef.current) onHover(null);
      }}
    />
  );
}

function IndexAxisStrip({
  height,
  ticks,
  selectOnDrag,
  onPick,
  pickX,
}: {
  height: number;
  ticks: { x: number; label: string; on?: boolean }[];
  selectOnDrag?: boolean;
  onPick: (time: UTCTimestamp | null) => void;
  pickX: (clientX: number) => UTCTimestamp | null;
}) {
  const dragging = useRef(false);
  return (
    <div
      className={`relative shrink-0 overflow-hidden ${
        selectOnDrag ? 'cursor-ew-resize' : 'cursor-crosshair'
      }`}
      style={{ height }}
      onPointerDown={e => {
        dragging.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* optional */
        }
        if (selectOnDrag) onPick(pickX(e.clientX));
      }}
      onPointerMove={e => {
        if (selectOnDrag && dragging.current) onPick(pickX(e.clientX));
      }}
      onPointerUp={e => {
        dragging.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        onPick(pickX(e.clientX));
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      {ticks.map(t => (
        <span
          key={`${t.label}-${Math.round(t.x)}`}
          className={`absolute top-0.5 font-mono text-[9px] leading-4 ${
            t.on ? 'font-semibold text-sky-300' : 'text-slate-400'
          }`}
          style={{ left: t.x, transform: 'translateX(-50%)' }}
        >
          {t.label}
        </span>
      ))}
    </div>
  );
}

function timeToUnix(time: Time | undefined): number | null {
  if (time == null) return null;
  if (typeof time === 'number' && Number.isFinite(time)) return time;
  if (typeof time === 'string') {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(time) ? `${time}T00:00:00Z` : time;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  if (
    typeof time === 'object'
    && 'year' in time
    && 'month' in time
    && 'day' in time
  ) {
    return Date.UTC(time.year, time.month - 1, time.day) / 1000;
  }
  return null;
}

function formatClock(time: Time, intervalSec = 5): string {
  const sec = timeToUnix(time);
  if (sec == null) return '';
  const d = new Date(sec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (intervalSec >= 3600) {
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mo}-${dd} ${hh}:${mm}`;
  }
  if (intervalSec >= 60) return `${hh}:${mm}`;
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatPrice(price: number, fmt: LwPriceFormat): string {
  if (!Number.isFinite(price)) return '';
  return price.toFixed(fmt.precision);
}

/** `timeToCoordinate` is pane-local. Overlays cover the whole chart, past the left scale. */
function hostX(chart: IChartApi, paneX: number): number {
  return paneX + chart.priceScale('left').width();
}

/** Pane edges in host pixels. Stops rules before either price scale.
 *  Do not use timeScale().width() here: it is 0 while the time axis is hidden. */
function measurePlotX(
  chart: IChartApi | null,
  host: HTMLElement | null,
): { x1: number; x2: number } | null {
  if (!chart || !host) return null;
  const x1 = chart.priceScale('left').width();
  const right = chart.priceScale('right').width();
  const width = host.clientWidth;
  if (!(width > x1 + 8)) return null;
  const x2 = width - Math.max(0, right);
  if (!(x2 > x1)) return null;
  return { x1: Math.max(0, x1), x2 };
}

function pointerOnPriceScale(
  chart: IChartApi,
  host: HTMLElement,
  clientX: number,
): boolean {
  const x = clientX - host.getBoundingClientRect().left;
  const w = host.clientWidth;
  const rightW = chart.priceScale('right').width();
  const leftW = chart.priceScale('left').width();
  if (rightW > 0 && x >= w - rightW - 1) return true;
  if (leftW > 0 && x <= leftW + 1) return true;
  return false;
}

function autoscaleLockedRange(
  userScaled: boolean,
  locked: LwPriceRange | null | undefined,
  base: () => AutoscaleInfo | null,
): AutoscaleInfo | null {
  if (userScaled) return base();
  if (
    !locked
    || !Number.isFinite(locked.min)
    || !Number.isFinite(locked.max)
  ) {
    return base();
  }
  return {
    priceRange: {
      minValue: locked.min,
      maxValue: locked.max,
    },
  };
}

/** Evenly spaced unix seconds so LWC can plot strike / tick index on a time axis. */
export function lwIndexTime(index: number, stepSec = 86_400): UTCTimestamp {
  return (1_704_067_200 + index * stepSec) as UTCTimestamp;
}

export function lwIndexFromTime(time: number, stepSec = 86_400): number {
  return Math.round((time - 1_704_067_200) / stepSec);
}

function ControlBar({
  height,
  currentInterval,
  intervalOptions,
  onIntervalChange,
  chart,
  onFit,
  onManualScale,
}: {
  height: number;
  currentInterval?: TimeInterval;
  intervalOptions?: readonly TimeInterval[];
  onIntervalChange?: (interval: TimeInterval) => void;
  chart: IChartApi | null;
  onFit?: () => void;
  onManualScale?: () => void;
}) {
  const handleZoomIn = () => {
    if (!chart) return;
    onManualScale?.();
    const timeScale = chart.timeScale();
    const logicalRange = timeScale.getVisibleLogicalRange();
    if (logicalRange) {
      const { from, to } = logicalRange;
      const center = (from + to) / 2;
      const range = to - from;
      const newRange = range * 0.5;
      timeScale.setVisibleLogicalRange({
        from: center - newRange / 2,
        to: center + newRange / 2,
      });
    }
  };

  const handleZoomOut = () => {
    if (!chart) return;
    onManualScale?.();
    const timeScale = chart.timeScale();
    const logicalRange = timeScale.getVisibleLogicalRange();
    if (logicalRange) {
      const { from, to } = logicalRange;
      const center = (from + to) / 2;
      const range = to - from;
      const newRange = range / 0.5;
      timeScale.setVisibleLogicalRange({
        from: center - newRange / 2,
        to: center + newRange / 2,
      });
    }
  };

  const handleFitContent = () => {
    onFit?.();
    if (!onFit) chart?.timeScale().fitContent();
  };

  return (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-700 bg-slate-900 px-4 py-2"
      style={{ height }}
    >
      <div className="flex items-center gap-2">
        {onIntervalChange ? <>
          <span className="text-xs font-semibold text-slate-400">Interval:</span>
          <div className="flex gap-1">
            {(intervalOptions
              ? intervalOptions.map(value => ({ label: tapeBarLabel(value), value }))
              : INTERVAL_OPTIONS
            ).map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onIntervalChange(opt.value)}
                className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                  currentInterval === opt.value
                    ? 'bg-cyan-500 text-slate-950 font-semibold'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </> : null}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-400">Zoom:</span>
        <button
          onClick={handleZoomIn}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-600/80 bg-slate-950/90 text-slate-300 transition-colors hover:border-slate-400 hover:bg-slate-900 hover:text-slate-100"
          title="Zoom in (scroll up)"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        </button>
        <button
          onClick={handleZoomOut}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-600/80 bg-slate-950/90 text-slate-300 transition-colors hover:border-slate-400 hover:bg-slate-900 hover:text-slate-100"
          title="Zoom out"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
        <button
          onClick={handleFitContent}
          className="inline-flex h-7 items-center justify-center rounded-md border border-slate-600/80 bg-slate-950/90 px-2.5 font-mono text-xs text-slate-300 transition-colors hover:border-slate-400 hover:bg-slate-900 hover:text-slate-100"
          title="Fit all content"
        >
          Fit
        </button>
      </div>
    </div>
  );
}
