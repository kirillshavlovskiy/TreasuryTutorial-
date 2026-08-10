'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ExposureHedgePathChart,
  type HedgePathSummaryMetrics,
} from '@/components/test-mode/ExposureHedgePathChart';
import {
  assignImpliedCarryFromSwapPoints,
  buildCarryEvolutionBars,
  buildCarryEvolutionLegBars,
  buildCarryEvolutionLegBarsFromSamples,
  buildCashCarryAnalytics,
  buildCashForecastCarryComparison,
  buildCashForecastSchedule,
  buildSettleWamScenarios,
  optimizeStripShapeAroundWam,
  resolvedHedgedTotalCarryUsdM,
  preparedLegFwdCarryUsdM,
  preparedBulletFwdCarryUsdM,
  scoreStripShapeAroundWam,
  type CarryEvolutionBar,
  type CashCarryAnalytics,
  type CashForecastMonthRow,
  type SettleWamScenario,
  type StripShapeScore,
} from '@/lib/test-mode/cash-carry-analytics';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  equalVarLinearHedgeNotionalLocalM,
  setPreparedHedgeForCcy,
  type CarryProfileSessionV1,
  type HedgeTicket,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import {
  hedgeBasisNotionalLocalM,
  resolveChartMonthlyFlows,
  type HedgePathBasisId,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  endMonthsFromScheduleWeights,
  hasRollingStripForCcy,
  notionalWeightsFromAmounts,
  rampStripScheduleWeights,
  varSetupForPathHedgeRegime,
  type ForecastHedgeStructure,
  type RollingHedgeEdge,
} from '@/lib/test-mode/rolling-hedge';
import {
  defaultStripLegCount,
  settleSkewFromCenterOfMass,
  type SettleSkewId,
} from '@/lib/test-mode/remodel-prepared-hedge';
import {
  VAR_HORIZON_OPTIONS,
  VAR_VOL_SOURCE_OPTIONS,
  horizonMonths,
  monthlyVolForSetup,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import {
  VAR_CONFIDENCE_OPTIONS,
  zForConfidence,
} from '@/lib/test-mode/var-confidence';
import {
  cashInterestModeOf,
  resolveMarketRatesForCcy,
  type CashInterestMode,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { setMarketRatesForCcy } from '@/lib/test-mode/hedge-var';
import type { RowState } from '@/lib/fx-buffer';
import {
  DEFAULT_FORECAST_PROFILE,
  monthlyFlowSeriesLocalM,
  normalizeMonthFlow,
  resizeMonthSeries,
  seedMonthsFromRow,
  type ForecastProfileState,
} from '@/lib/forecast-profile';

function inferSettleSkewFromEnds(
  ends: readonly number[],
  Tf: number,
): SettleSkewId {
  const n = ends.length;
  if (n < 2 || !(Tf > 0)) return 'neutral';
  const sorted = [...ends].map(m => Math.round(m * 100) / 100).sort((a, b) => a - b);
  const dist = (mode: 'equal' | 'front' | 'back') => {
    const target = endMonthsFromScheduleWeights(
      rampStripScheduleWeights(n, mode),
      Tf,
    );
    if (target.length !== sorted.length) return Infinity;
    return sorted.reduce(
      (s, x, i) => s + Math.abs(x - (target[i] ?? 0)),
      0,
    );
  };
  const dEq = dist('equal');
  const dFr = dist('front');
  const dBk = dist('back');
  if (dFr <= dEq && dFr <= dBk) return 'front';
  if (dBk <= dEq && dBk <= dFr) return 'back';
  return 'neutral';
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v6" />
      <path d="M12 7h.01" />
    </svg>
  );
}

/** Snap to nearest step within [min, max]. */
function snapStepperValue(
  raw: number,
  min: number,
  max: number,
  step: number,
): number {
  if (!(step > 0)) return Math.min(max, Math.max(min, raw));
  const n = Math.round((raw - min) / step);
  const snapped = min + n * step;
  const rounded = Math.round(snapped * 1e6) / 1e6;
  return Math.min(max, Math.max(min, rounded));
}

/**
 * Desk-style parameter stepper: track + fill + major/minor ticks + thumb,
 * optional −/+ nudge. Used for shape-search Legs / CoM / Kurtosis.
 */
function TickBarStepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
  disabled = false,
  formatValue,
  tickValues,
  tickLabels,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  formatValue: (v: number) => string;
  /** Major tick positions (also get labels when tickLabels provided). */
  tickValues: readonly number[];
  tickLabels?: readonly string[];
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const span = max - min;
  const pct =
    span > 1e-12 ? ((Math.min(max, Math.max(min, value)) - min) / span) * 100 : 0;

  const valueFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1e-6) return value;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return snapStepperValue(min + t * span, min, max, step);
  };

  const nudge = (dir: -1 | 1) => {
    if (disabled) return;
    onChange(snapStepperValue(value + dir * step, min, max, step));
  };

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    onChangeRef.current(valueFromClientX(e.clientX));
    const onMove = (ev: PointerEvent) => {
      onChangeRef.current(valueFromClientX(ev.clientX));
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const stepBtn =
    'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-950 text-[11px] font-semibold text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40';

  // Minor ticks at every step (cap density for continuous ranges).
  const minorTicks: number[] = [];
  const maxMinors = 24;
  const stepCount = Math.round(span / step);
  if (stepCount > 0 && stepCount <= maxMinors) {
    for (let i = 0; i <= stepCount; i++) {
      minorTicks.push(min + i * step);
    }
  }

  return (
    <div
      className={`rounded-md border border-slate-700 bg-slate-900/80 px-2.5 py-2${
        disabled ? ' opacity-50' : ''
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-slate-100">
          {formatValue(value)}
        </span>
      </div>

      {/* − / bar / + share one 24px row so buttons sit on the track centerline */}
      <div className="flex h-6 items-center gap-1.5">
        <button
          type="button"
          className={stepBtn}
          disabled={disabled || value <= min + 1e-12}
          aria-label={`Decrease ${label}`}
          onClick={() => nudge(-1)}
        >
          −
        </button>

        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={formatValue(value)}
          aria-disabled={disabled}
          onKeyDown={e => {
            if (disabled) return;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault();
              nudge(-1);
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault();
              nudge(1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              onChange(min);
            } else if (e.key === 'End') {
              e.preventDefault();
              onChange(max);
            }
          }}
          onPointerDown={beginDrag}
          className={`relative h-6 min-w-0 flex-1 select-none touch-none ${
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          }`}
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-slate-800 ring-1 ring-slate-700/80">
            <div
              className="h-full rounded-full bg-slate-400"
              style={{ width: `${pct}%` }}
            />
          </div>

          {minorTicks.map(t => {
            const p = span > 1e-12 ? ((t - min) / span) * 100 : 0;
            const isMajor = tickValues.some(
              m => Math.abs(m - t) < step * 0.25 + 1e-9,
            );
            if (isMajor) return null;
            return (
              <span
                key={`m-${t}`}
                className="pointer-events-none absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-600"
                style={{ left: `${p}%` }}
              />
            );
          })}

          {tickValues.map(t => {
            const p = span > 1e-12 ? ((t - min) / span) * 100 : 0;
            return (
              <span
                key={`M-${t}`}
                className="pointer-events-none absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-400"
                style={{ left: `${p}%` }}
              />
            );
          })}

          <span
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-300 bg-slate-950 shadow-md"
            style={{ left: `${pct}%` }}
          />
        </div>

        <button
          type="button"
          className={stepBtn}
          disabled={disabled || value >= max - 1e-12}
          aria-label={`Increase ${label}`}
          onClick={() => nudge(1)}
        >
          +
        </button>
      </div>

      {tickLabels != null && tickLabels.length > 0 && (
        <div className="mt-1 flex gap-1.5">
          <div className="h-3 w-6 shrink-0" aria-hidden />
          <div className="relative h-3 min-w-0 flex-1">
            {tickValues.map((t, i) => {
              const lab = tickLabels[i];
              if (lab == null) return null;
              const p = span > 1e-12 ? ((t - min) / span) * 100 : 0;
              return (
                <span
                  key={`L-${t}`}
                  className={`absolute top-0 whitespace-nowrap font-mono text-[8px] leading-none text-slate-500 ${
                    i === 0
                      ? 'left-0'
                      : i === tickValues.length - 1
                        ? 'right-0'
                        : '-translate-x-1/2'
                  }`}
                  style={
                    i === 0 || i === tickValues.length - 1
                      ? undefined
                      : { left: `${p}%` }
                  }
                >
                  {lab}
                </span>
              );
            })}
          </div>
          <div className="h-3 w-6 shrink-0" aria-hidden />
        </div>
      )}
    </div>
  );
}

function fmtK(usdM: number): string {
  const k = usdM * 1000;
  const sign = k >= 0 ? '+' : '−';
  return `${sign}${Math.abs(k).toFixed(1)}K`;
}

function fmtM(v: number): string {
  const sign = v >= 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(2)}M`;
}

/** Shared bipolar bar chart height (carry / cash-flow panels). */
const CARRY_CHART_HALF_PX = 88;
const CARRY_CHART_BODY_H = CARRY_CHART_HALF_PX * 2 + 2;

/** Outer edge only: top of positive stack, bottom of negative stack. */
function stackSegRadius(
  index: number,
  count: number,
  positive: boolean,
): string {
  if (count <= 0) return '';
  if (count === 1) return positive ? 'rounded-t-sm' : 'rounded-b-sm';
  if (positive) return index === count - 1 ? 'rounded-t-sm' : '';
  return index === count - 1 ? 'rounded-b-sm' : '';
}

function shortHorizonLabel(label: string): string {
  if (/^M\d+$/i.test(label.trim())) return label.trim();
  return label
    .replace(' months', 'm')
    .replace(' month', 'm')
    .replace(' week', 'w')
    .replace(' year', 'y')
    .replace(/^M0–/, '');
}

/** `${ccy}:all` · `${ccy}:bullet` · `${ccy}:leg:${index}` */
type HedgeTradeSelectionKey = string;

function preparedByCcyForTradeSelection(
  preparedByCcy: Record<string, PreparedHedgeProfile>,
  tradeKey: HedgeTradeSelectionKey | null,
): Record<string, PreparedHedgeProfile> {
  if (!tradeKey) return preparedByCcy;
  const [ccy, kind, idxStr] = tradeKey.split(':');
  if (!ccy || kind === 'all') return preparedByCcy;
  const prep = preparedByCcy[ccy];
  if (!prep) return preparedByCcy;

  if (kind === 'bullet') {
    return preparedByCcy;
  }

  if (kind === 'leg') {
    const legIndex = Number(idxStr);
    const legPos = prep.legs.findIndex(l => l.index === legIndex);
    const leg = legPos >= 0 ? prep.legs[legPos] : undefined;
    if (!leg) return preparedByCcy;
    const prevHedge =
      legPos > 0 ? (prep.legs[legPos - 1]?.hedgeLocalM ?? 0) : 0;
    const delta =
      typeof leg.tradeNotionalLocalM === 'number'
        ? leg.tradeNotionalLocalM
        : leg.hedgeLocalM - prevHedge;
    if (Math.abs(delta) < 1e-12) return preparedByCcy;
    return {
      ...preparedByCcy,
      [ccy]: {
        ...prep,
        structure: 'strip',
        legs: [
          {
            ...leg,
            hedgeLocalM: delta,
            tradeNotionalLocalM: delta,
          },
        ],
        coverLocalM: delta,
      },
    };
  }

  return preparedByCcy;
}

function bookedHedgesForTradeSelection(
  booked: readonly HedgeTicket[],
  tradeKey: HedgeTradeSelectionKey | null,
): readonly HedgeTicket[] {
  if (!tradeKey) return booked;
  const [ccy, kind] = tradeKey.split(':');
  if (!ccy || kind === 'all') return booked;
  return booked.filter(t => t.ccy !== ccy);
}

function tradeSelectionLabel(
  tradeKey: HedgeTradeSelectionKey,
  preparedByCcy: Record<string, PreparedHedgeProfile>,
): string {
  const [ccy, kind, idxStr] = tradeKey.split(':');
  const prep = preparedByCcy[ccy ?? ''];
  if (!prep || kind === 'all') return `${ccy} · all trades`;
  if (kind === 'bullet') {
    const m = prep.settleMonths ?? prep.legs[0]?.settleMonths;
    return `${ccy} bullet${m != null ? ` · M${Math.round(m)}` : ''}`;
  }
  if (kind === 'leg') {
    const leg = prep.legs.find(l => String(l.index) === idxStr);
    const settle = leg?.settleMonths ?? leg?.endMonth;
    const label = leg?.label ?? `L${idxStr}`;
    return `${ccy} ${label}${settle != null ? ` · M${Math.round(settle)}` : ''}`;
  }
  return tradeKey;
}

interface CashCarryAnalyticsViewProps {
  risk: CurrencyRiskRow[];
  setup: VarSetup;
  /** Edit the shared VaR setup (σ source + confidence) from the Cash Carry tab. */
  onSetupChange?: (setup: VarSetup) => void;
  bookedHedges: readonly HedgeTicket[];
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  /** Stage remodelled bullet/strip packages (same as FX Risk Prepare). */
  onPreparedByCcyChange?: (
    next: Record<string, PreparedHedgeProfile>,
  ) => void;
  /**
   * Persisted Cash Carry modal sessions (sandbox / Neon). Survives reload so
   * Apply / Prebook / schedule edits are not lost with the in-memory ref.
   */
  carrySessionsByCcy?: Record<string, CarryProfileSessionV1>;
  onCarrySessionsByCcyChange?: (
    next: Record<string, CarryProfileSessionV1>,
  ) => void;
  /** Live FX book — cash + Revenue/Expenses forecast inputs per CCY. */
  bookRows?: readonly RowState[];
  forecastProfile?: ForecastProfileState | null;
  ratesScopeId?: string;
  marketRates?: FxMarketRatesBundle;
  /** DB-persisted market data per currency — preferred over `marketRates`/`ratesScopeId`. */
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  /** Persist cash-interest mode / O/N edits from Cash Carry. */
  onMarketRatesByCcyChange?: (
    next: Record<string, FxMarketRatesBundle>,
  ) => void;
  /** Optional tab heading (Liquidity tab). */
  title?: string;
  subtitle?: string;
  /**
   * Live All-CCY Total carry (same as table footer) — keeps Analytics tab rail
   * in lockstep with the Cash Carry table.
   */
  onAllCcyTotalCarryUsdMChange?: (totalCarryUsdM: number) => void;
}

/** Prefer M12 for legend inspect; else last available month. */
function defaultChartInspectMonth(
  months: readonly { monthIndex: number }[],
): number {
  if (months.some(m => Math.abs(m.monthIndex - 12) < 1e-9)) return 12;
  return months[months.length - 1]?.monthIndex ?? 12;
}

function CarryEvolutionBarChart({
  bars,
  Tf,
  activeHorizon,
  ccy,
  mode,
}: {
  bars: CarryEvolutionBar[];
  Tf: number;
  activeHorizon: VarHorizonId;
  ccy: string;
  mode: 'structure' | 'leg';
}) {
  const activeMonths = horizonMonths(activeHorizon);
  const perLeg = mode === 'leg';
  /** Legend month (defaults M12). */
  const [inspectMonths, setInspectMonths] = useState(() =>
    defaultChartInspectMonth(bars.map(b => ({ monthIndex: b.months }))),
  );
  /** Only this bar renders Residual / FWD / USD stack — null = all Do-nothing/Enhancement. */
  const [expandedMonth, setExpandedMonth] = useState<number | null>(null);

  useEffect(() => {
    setInspectMonths(
      defaultChartInspectMonth(bars.map(b => ({ monthIndex: b.months }))),
    );
    setExpandedMonth(null);
  }, [ccy, bars.length, mode]);

  const inspected =
    bars.find(b => Math.abs(b.months - inspectMonths) < 1e-9) ??
    bars[bars.length - 1] ??
    null;

  /** Scale: structure stacks + component parts (for the expanded bar). */
  const maxAbs = Math.max(
    1e-9,
    ...bars.flatMap(b =>
      perLeg
        ? [Math.abs(b.improvedCarryUsdM)]
        : [
            Math.abs(b.improvedCarryUsdM),
            Math.abs(b.defaultCarryUsdM),
            Math.abs(b.hedgeImprovementUsdM),
            Math.abs(b.hedgeBreakdown.fcyInterestUsdM),
            Math.abs(b.hedgeBreakdown.fwdCarryUsdM),
            Math.abs(b.hedgeBreakdown.usdInterestUsdM),
          ],
    ),
  );
  const halfPx = CARRY_CHART_HALF_PX;
  const hOf = (abs: number) =>
    Math.max(
      abs > 1e-12 ? 3 : 0,
      Math.round((abs / maxAbs) * halfPx),
    );

  const renderHalf = (
    segs: { h: number; cls: string; title: string }[],
    positive: boolean,
    outerRing = '',
  ) => {
    if (segs.length === 0) {
      return <div style={{ height: halfPx }} className="w-full" />;
    }
    const ordered = positive ? [...segs].reverse() : segs;
    const extent = ordered.reduce((m, s) => m + s.h, 0);
    return (
      <div
        className={`flex w-full flex-col items-center ${
          positive ? 'justify-end' : 'justify-start'
        }`}
        style={{ height: halfPx }}
      >
        <div
          className={`flex w-7 flex-col overflow-hidden sm:w-8 ${
            positive ? 'justify-end rounded-t-sm' : 'justify-start rounded-b-sm'
          } ${outerRing}`.trim()}
          style={{ height: extent }}
        >
          {ordered.map((s, i) => (
            <div
              key={i}
              className={`w-full ${s.cls}`}
              style={{ height: s.h }}
              title={s.title}
            />
          ))}
        </div>
      </div>
    );
  };

  /**
   * Cumulative do-nothing vs cumulative enhancement — bipolar by sign:
   * · Yellow = do-nothing on its own side of the axis (neg → below, pos → above)
   * · Green = positive improvement ALWAYS above the axis
   * · Red = disimprovement ALWAYS below the axis
   * Same rule for every month bar (PLN: yellow down + green up).
   */
  const renderStructureStack = (
    doNothing: number,
    _total: number,
    diff: number,
    ring: string,
  ) => {
    const posSegs: { h: number; cls: string; title: string }[] = [];
    const negSegs: { h: number; cls: string; title: string }[] = [];
    const amber = 'bg-amber-300/90';
    const green = 'bg-emerald-400/85';
    const red = 'bg-rose-400/75';

    if (doNothing > 1e-12) {
      posSegs.push({
        h: hOf(doNothing),
        cls: amber,
        title: `Do nothing ${fmtK(doNothing)}`,
      });
    } else if (doNothing < -1e-12) {
      negSegs.push({
        h: hOf(Math.abs(doNothing)),
        cls: amber,
        title: `Do nothing ${fmtK(doNothing)}`,
      });
    }

    if (diff > 1e-12) {
      // Improvement always stacks on the positive (top) side.
      posSegs.push({
        h: hOf(diff),
        cls: green,
        title: `Enhancement ${fmtK(diff)}`,
      });
    } else if (diff < -1e-12) {
      negSegs.push({
        h: hOf(Math.abs(diff)),
        cls: red,
        title: `Enhancement ${fmtK(diff)}`,
      });
    }

    return (
      <>
        {renderHalf(posSegs, true, ring)}
        <div className="h-px w-full bg-slate-500/80" />
        {renderHalf(negSegs, false, ring)}
      </>
    );
  };

  /** Clicked bar only: Residual · FWD · USD int accrued through that month. */
  const renderComponentStack = (
    residual: number,
    fwd: number,
    usdInt: number,
    ring: string,
  ) => {
    const segments = [
      {
        value: residual,
        cls: 'bg-amber-300/90',
        title: `Residual int ${fmtK(residual)}`,
      },
      {
        value: fwd,
        cls: 'bg-emerald-400/85',
        title: `FWD pts ${fmtK(fwd)}`,
      },
      {
        value: usdInt,
        cls: 'bg-sky-400/85',
        title: `USD int ${fmtK(usdInt)}`,
      },
    ];
    const posSegs = segments
      .filter(s => s.value > 1e-12)
      .map(s => ({
        h: hOf(s.value),
        cls: s.cls,
        title: s.title,
      }));
    const negSegs = segments
      .filter(s => s.value < -1e-12)
      .map(s => ({
        h: hOf(Math.abs(s.value)),
        cls: s.cls,
        title: s.title,
      }));

    return (
      <>
        {renderHalf(posSegs, true, ring)}
        <div className="h-px w-full bg-slate-500/80" />
        {renderHalf(negSegs, false, ring)}
      </>
    );
  };



  return (
    <>
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))`,
        }}
      >
        {bars.map(bar => {
          const total = bar.improvedCarryUsdM;
          const doNothing = bar.defaultCarryUsdM;
          const diff = bar.hedgeImprovementUsdM;
          const beyondForecast = Tf > 0 && bar.months > Tf + 1e-9;
          const horizonOn = perLeg
            ? Math.abs(bar.months - activeMonths) < 0.51 && !beyondForecast
            : Math.abs(bar.months - activeMonths) < 1e-9 && !beyondForecast;
          const legendOn = Math.abs(bar.months - inspectMonths) < 1e-9;
          const expanded =
            !perLeg &&
            expandedMonth != null &&
            Math.abs(bar.months - expandedMonth) < 1e-9;
          const isTfBar =
            !perLeg &&
            Tf > 0 &&
            Math.abs(bar.months - Tf) < 1e-9;
          const barKey = `${bar.id}-${bar.months}`;
          const ring = expanded
            ? 'ring-1 ring-emerald-400/50'
            : horizonOn
              ? 'ring-1 ring-emerald-400/35'
              : '';
          const tfRing =
            isTfBar && !beyondForecast && !expanded
              ? 'ring-1 ring-amber-400/30'
              : '';

          return (
            <button
              key={barKey}
              type="button"
              title={
                beyondForecast
                  ? `${ccy} ${bar.label}: beyond forecast — display only.`
                  : perLeg
                    ? [
                        `${ccy} ${bar.label}`,
                        bar.amountLocalM != null
                          ? `Δ ${bar.amountLocalM.toFixed(2)}M`
                          : null,
                        `final accrued ${fmtK(total)}`,
                        `enhancement ${fmtK(diff)}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : expanded
                      ? [
                          `${ccy} ${bar.label}`,
                          `Residual ${fmtK(bar.hedgeBreakdown.fcyInterestUsdM)}`,
                          `FWD ${fmtK(bar.hedgeBreakdown.fwdCarryUsdM)}`,
                          `USD int ${fmtK(bar.hedgeBreakdown.usdInterestUsdM)}`,
                          `carry Σ ${fmtK(total)}`,
                        ].join(' · ')
                      : [
                          `${ccy} ${bar.label}`,
                          `do nothing ${fmtK(doNothing)}`,
                          `enhancement ${fmtK(diff)}`,
                          `carry Σ ${fmtK(total)}`,
                          '— click for Residual / FWD / USD split',
                        ].join(' · ')
              }
              onClick={() => {
                setInspectMonths(bar.months);
                if (!perLeg) {
                  setExpandedMonth(prev =>
                    prev != null && Math.abs(prev - bar.months) < 1e-9
                      ? null
                      : bar.months,
                  );
                }
              }}
              className={`flex flex-col items-center rounded-md px-0.5 py-1 transition-colors ${
                expanded
                  ? 'bg-emerald-500/15 ring-1 ring-emerald-400/45'
                  : horizonOn
                    ? 'bg-emerald-500/10'
                    : beyondForecast
                      ? 'bg-slate-800/40 hover:bg-slate-800/70'
                      : 'hover:bg-slate-800/50'
              }`}
            >
              <div className="mb-1 font-mono text-[10px] tabular-nums leading-none">
                <span
                  className={
                    expanded || horizonOn
                      ? 'font-semibold text-emerald-100'
                      : total >= 0
                        ? 'text-emerald-300/90'
                        : 'text-rose-300/90'
                  }
                  title={perLeg ? 'Final accrued carry' : 'Total hedged carry'}
                >
                  {fmtK(total)}
                </span>
              </div>
              <div
                className={`relative flex w-full flex-col items-center ${
                  beyondForecast ? 'opacity-50' : ''
                }`}
                style={{ height: CARRY_CHART_BODY_H }}
              >
                {expanded ? (
                  renderComponentStack(
                    bar.hedgeBreakdown.fcyInterestUsdM,
                    bar.hedgeBreakdown.fwdCarryUsdM,
                    bar.hedgeBreakdown.usdInterestUsdM,
                    `${ring} ${tfRing}`.trim(),
                  )
                ) : (
                  renderStructureStack(
                    doNothing,
                    total,
                    diff,
                    `${ring} ${tfRing}`.trim(),
                  )
                )}
              </div>
              <span
                className={`mt-1 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-[10px] font-semibold ${
                  expanded
                    ? 'bg-emerald-500/30 text-emerald-100 ring-1 ring-emerald-400/50'
                    : legendOn || horizonOn
                      ? 'bg-emerald-500/20 text-emerald-100'
                      : beyondForecast
                        ? 'text-slate-400'
                        : isTfBar
                          ? 'text-amber-200/90'
                          : 'text-slate-500'
                }`}
              >
                {perLeg ? bar.label : shortHorizonLabel(bar.label)}
              </span>
              {expanded ? (
                <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wide text-emerald-500/80">
                  split
                </span>
              ) : isTfBar && !beyondForecast ? (
                <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wide text-amber-500/80">
                  Tf
                </span>
              ) : null}
              {!perLeg && beyondForecast && !expanded && !legendOn && (
                <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wide text-slate-500">
                  view only
                </span>
              )}
              {perLeg && bar.amountLocalM != null && (
                <span className="mt-0.5 font-mono text-[8px] text-slate-600">
                  {Math.abs(bar.amountLocalM) >= 10
                    ? bar.amountLocalM.toFixed(0)
                    : bar.amountLocalM.toFixed(1)}
                  M
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span className="font-semibold text-slate-400">
          {inspected
            ? perLeg
              ? inspected.label
              : shortHorizonLabel(inspected.label)
            : 'M—'}
        </span>
        {perLeg ? (
          <>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="inline-block h-2 w-2 rounded-sm bg-amber-300/90" />
              <span className="text-slate-500">Do nothing</span>
              <span
                className={
                  (inspected?.defaultCarryUsdM ?? 0) >= 0
                    ? 'text-amber-200/90'
                    : 'text-rose-300/90'
                }
              >
                {fmtK(inspected?.defaultCarryUsdM ?? 0)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span
                className={`inline-block h-2 w-2 rounded-sm ${
                  (inspected?.hedgeImprovementUsdM ?? 0) >= 0
                    ? 'bg-emerald-400/85'
                    : 'bg-rose-400/75'
                }`}
              />
              <span className="text-slate-500">Enhancement</span>
              <span
                className={
                  (inspected?.hedgeImprovementUsdM ?? 0) >= 0
                    ? 'text-emerald-300/90'
                    : 'text-rose-300/90'
                }
              >
                {fmtK(inspected?.hedgeImprovementUsdM ?? 0)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="text-slate-500">Carry Σ</span>
              <span
                className={
                  (inspected?.improvedCarryUsdM ?? 0) >= 0
                    ? 'font-semibold text-emerald-100'
                    : 'font-semibold text-rose-300/90'
                }
              >
                {fmtK(inspected?.improvedCarryUsdM ?? 0)}
              </span>
            </span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="inline-block h-2 w-2 rounded-sm bg-amber-300/90" />
              <span className="text-amber-300/90">Residual int</span>
              <span
                className={
                  (inspected?.hedgeBreakdown.fcyInterestUsdM ?? 0) >= 0
                    ? 'text-amber-300'
                    : 'text-rose-300/90'
                }
              >
                {fmtK(inspected?.hedgeBreakdown.fcyInterestUsdM ?? 0)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400/85" />
              <span className="text-emerald-300/90">FWD pts</span>
              <span
                className={
                  (inspected?.hedgeBreakdown.fwdCarryUsdM ?? 0) >= 0
                    ? 'text-emerald-300/90'
                    : 'text-rose-300/90'
                }
              >
                {fmtK(inspected?.hedgeBreakdown.fwdCarryUsdM ?? 0)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="inline-block h-2 w-2 rounded-sm bg-sky-400/85" />
              <span className="text-sky-300/90">USD int</span>
              <span
                className={
                  (inspected?.hedgeBreakdown.usdInterestUsdM ?? 0) >= 0
                    ? 'text-sky-300/90'
                    : 'text-rose-300/90'
                }
              >
                {fmtK(inspected?.hedgeBreakdown.usdInterestUsdM ?? 0)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="inline-block h-2 w-2 rounded-sm bg-amber-300/90" />
              <span className="text-slate-500">Do nothing</span>
              <span
                className={
                  (inspected?.defaultCarryUsdM ?? 0) >= 0
                    ? 'text-amber-200/90'
                    : 'text-rose-300/90'
                }
              >
                {fmtK(inspected?.defaultCarryUsdM ?? 0)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span
                className={`inline-block h-2 w-2 rounded-sm ${
                  (inspected?.hedgeImprovementUsdM ?? 0) >= 0
                    ? 'bg-emerald-400/85'
                    : 'bg-rose-400/75'
                }`}
              />
              <span className="text-slate-500">Enhancement</span>
              <span
                className={
                  (inspected?.hedgeImprovementUsdM ?? 0) >= 0
                    ? 'text-emerald-300/90'
                    : 'text-rose-300/90'
                }
              >
                {fmtK(inspected?.hedgeImprovementUsdM ?? 0)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <span className="text-slate-500">Carry Σ</span>
              <span
                className={
                  (inspected?.improvedCarryUsdM ?? 0) >= 0
                    ? 'font-semibold text-emerald-100'
                    : 'font-semibold text-rose-300/90'
                }
              >
                {fmtK(inspected?.improvedCarryUsdM ?? 0)}
              </span>
            </span>
            <span className="text-slate-600">
              Accrued through month · click a bar
            </span>
          </>
        )}
      </div>
    </>
  );
}

/** Per-month cash-flow legs for chart stacks (M FCY, signed). */
type CashFlowMonthLegs = {
  monthIndex: number;
  label: string;
  settleLegCount: number;
  /** End cash book (FCY) — net position. */
  endCashM: number;
  /** Opening Cash FX (as-is); constant on cumulative path. */
  openingCashM: number;
  collectionsM: number;
  invoiceFcastM: number;
  nwcInM: number;
  debtInM: number;
  investInM: number;
  otherInM: number;
  /** Outflows as positive magnitudes. */
  expensesM: number;
  nwcOutM: number;
  debtOutM: number;
  investOutM: number;
  otherOutM: number;
  hedgeCashFlowM: number;
};

/**
 * Full cash-source legs from forecast profile + schedule hedge / opening.
 * Profile months supply Revenue / invoice / NWC / debt / invest / other;
 * schedule supplies hedge CF and end cash.
 */
function cashFlowMonthLegs(
  months: readonly CashForecastMonthRow[],
  bookRow: RowState | undefined,
  forecastProfile: ForecastProfileState | null | undefined,
  openingCashM: number,
): CashFlowMonthLegs[] {
  const T = months.length;
  const profile = forecastProfile ?? DEFAULT_FORECAST_PROFILE;
  const g =
    typeof profile.growthRateMoM === 'number' &&
    Number.isFinite(profile.growthRateMoM)
      ? profile.growthRateMoM
      : 0;
  const extras = profile.extrasByCcy?.[bookRow?.ccy ?? ''] ?? null;
  const profileMonths =
    bookRow != null
      ? profile.mode === 'custom'
        ? resizeMonthSeries(profile.byCcy[bookRow.ccy], T, bookRow, extras)
        : seedMonthsFromRow(bookRow, T, g, extras)
      : [];

  return months.map((m, i) => {
    const flow = normalizeMonthFlow(profileMonths[i]);
    /** Prefer profile split; fall back to schedule revenue lump. */
    const hasProfile = bookRow != null && profileMonths.length === T;
    const collectionsM = hasProfile ? flow.collections : m.revenueM;
    const invoiceFcastM = hasProfile ? flow.invoiceFcast : 0;
    const nwcInM = hasProfile ? flow.nwcIn : 0;
    const debtInM = hasProfile ? flow.debtIn : 0;
    const investInM = hasProfile ? flow.investIn : 0;
    const otherInM = hasProfile ? flow.otherIn : 0;
    const expensesM = hasProfile
      ? Math.abs(Math.min(0, flow.payout))
      : m.payoutM;
    const nwcOutM = hasProfile ? Math.abs(Math.min(0, flow.nwcOut)) : 0;
    const debtOutM = hasProfile ? Math.abs(Math.min(0, flow.debtOut)) : 0;
    const investOutM = hasProfile ? Math.abs(Math.min(0, flow.investOut)) : 0;
    const otherOutM = hasProfile ? Math.abs(Math.min(0, flow.otherOut)) : 0;
    return {
      monthIndex: m.monthIndex,
      label: m.label,
      settleLegCount: m.settleLegCount,
      endCashM: m.endCashM,
      openingCashM,
      collectionsM,
      invoiceFcastM,
      nwcInM,
      debtInM,
      investInM,
      otherInM,
      expensesM,
      nwcOutM,
      debtOutM,
      investOutM,
      otherOutM,
      hedgeCashFlowM: m.hedgeCashFlowM,
    };
  });
}

/** M1…MTf cash path — FX book sources + revenue / expenses / hedge CF. */
function CashFlowMonthBarChart({
  months,
  ccy,
  presentation = 'mom',
  bookRow,
  forecastProfile,
  openingCashM,
}: {
  months: CashForecastMonthRow[];
  ccy: string;
  presentation?: 'mom' | 'cumulative';
  bookRow?: RowState;
  forecastProfile?: ForecastProfileState | null;
  openingCashM: number;
}) {
  const cumulative = presentation === 'cumulative';
  /** Month shown in the legend (and expanded sources in cumulative). Default M12. */
  const [inspectMonth, setInspectMonth] = useState(() =>
    defaultChartInspectMonth(months),
  );

  useEffect(() => {
    setInspectMonth(defaultChartInspectMonth(months));
  }, [ccy, presentation, months.length]);

  const displayMonths = useMemo(() => {
    const legs = cashFlowMonthLegs(
      months,
      bookRow,
      forecastProfile,
      openingCashM,
    );
    if (presentation === 'mom') {
      /** Starting Cash FX only on M1 — later months are period flows. */
      return legs.map(m => ({
        ...m,
        openingCashM: m.monthIndex === 1 ? openingCashM : 0,
      }));
    }
    let cumCol = 0;
    let cumFcast = 0;
    let cumNwcIn = 0;
    let cumDebtIn = 0;
    let cumInvestIn = 0;
    let cumOtherIn = 0;
    let cumExp = 0;
    let cumNwcOut = 0;
    let cumDebtOut = 0;
    let cumInvestOut = 0;
    let cumOtherOut = 0;
    let cumHedge = 0;
    return legs.map(m => {
      cumCol += m.collectionsM;
      cumFcast += m.invoiceFcastM;
      cumNwcIn += m.nwcInM;
      cumDebtIn += m.debtInM;
      cumInvestIn += m.investInM;
      cumOtherIn += m.otherInM;
      cumExp += m.expensesM;
      cumNwcOut += m.nwcOutM;
      cumDebtOut += m.debtOutM;
      cumInvestOut += m.investOutM;
      cumOtherOut += m.otherOutM;
      cumHedge += m.hedgeCashFlowM;
      return {
        ...m,
        openingCashM,
        collectionsM: cumCol,
        invoiceFcastM: cumFcast,
        nwcInM: cumNwcIn,
        debtInM: cumDebtIn,
        investInM: cumInvestIn,
        otherInM: cumOtherIn,
        expensesM: cumExp,
        nwcOutM: cumNwcOut,
        debtOutM: cumDebtOut,
        investOutM: cumInvestOut,
        otherOutM: cumOtherOut,
        hedgeCashFlowM: cumHedge,
      };
    });
  }, [months, bookRow, forecastProfile, presentation, openingCashM]);

  const maxAbs = Math.max(
    1e-9,
    ...displayMonths.flatMap(m => [
      Math.abs(m.endCashM),
      Math.abs(m.openingCashM),
      Math.abs(m.collectionsM),
      Math.abs(m.invoiceFcastM),
      Math.abs(m.nwcInM),
      Math.abs(m.debtInM),
      Math.abs(m.investInM),
      Math.abs(m.otherInM),
      Math.abs(m.expensesM),
      Math.abs(m.nwcOutM),
      Math.abs(m.debtOutM),
      Math.abs(m.investOutM),
      Math.abs(m.otherOutM),
      Math.abs(m.hedgeCashFlowM),
    ]),
  );
  const halfPx = CARRY_CHART_HALF_PX;
  const hOf = (abs: number) =>
    Math.max(abs > 1e-12 ? 3 : 0, Math.round((abs / maxAbs) * halfPx));

  const renderFlowHalf = (
    segs: { h: number; cls: string; title: string }[],
    positive: boolean,
  ) => {
    if (segs.length === 0) {
      return <div style={{ height: halfPx }} className="w-full" />;
    }
    /** Outer edge first — VaR Evolution clip stack. */
    const ordered = positive ? [...segs].reverse() : segs;
    const extent = ordered.reduce((s, x) => s + x.h, 0);
    return (
      <div
        className={`flex w-full flex-col items-center ${
          positive ? 'justify-end' : 'justify-start'
        }`}
        style={{ height: halfPx }}
      >
        <div
          className={`flex w-7 flex-col overflow-hidden sm:w-8 ${
            positive ? 'justify-end rounded-t-sm' : 'justify-start rounded-b-sm'
          }`}
          style={{ height: extent }}
        >
          {ordered.map((s, i) => (
            <div
              key={i}
              className={`w-full ${s.cls}`}
              style={{ height: s.h }}
              title={s.title}
            />
          ))}
        </div>
      </div>
    );
  };

  const pushSeg = (
    segs: { h: number; cls: string; title: string }[],
    value: number,
    cls: string,
    title: string,
  ) => {
    if (Math.abs(value) <= 1e-12) return;
    segs.push({ h: hOf(Math.abs(value)), cls, title });
  };

  /** Full cash-position source stack (opening + flows + hedge). */
  const sourceSegs = (m: CashFlowMonthLegs, includeOpening: boolean) => {
    const upper: { h: number; cls: string; title: string }[] = [];
    const lower: { h: number; cls: string; title: string }[] = [];
    if (includeOpening) {
      if (m.openingCashM > 1e-12) {
        pushSeg(
          upper,
          m.openingCashM,
          'bg-sky-300/90',
          `Cash FX (as-is) ${fmtM(m.openingCashM)}`,
        );
      } else if (m.openingCashM < -1e-12) {
        pushSeg(
          lower,
          m.openingCashM,
          'bg-sky-500/75',
          `Cash FX (as-is) ${fmtM(m.openingCashM)}`,
        );
      }
    }
    pushSeg(upper, m.collectionsM, 'bg-emerald-400/85', `Revenue ${fmtM(m.collectionsM)}`);
    pushSeg(
      upper,
      m.invoiceFcastM,
      'bg-violet-400/85',
      `Invoice fcast ${fmtM(m.invoiceFcastM)}`,
    );
    pushSeg(upper, m.nwcInM, 'bg-violet-300/75', `NWC in ${fmtM(m.nwcInM)}`);
    pushSeg(upper, m.debtInM, 'bg-amber-300/80', `Debt draw ${fmtM(m.debtInM)}`);
    pushSeg(upper, m.investInM, 'bg-teal-400/80', `Invest in ${fmtM(m.investInM)}`);
    pushSeg(upper, m.otherInM, 'bg-indigo-300/70', `Other in ${fmtM(m.otherInM)}`);
    if (m.hedgeCashFlowM > 1e-12) {
      pushSeg(
        upper,
        m.hedgeCashFlowM,
        'bg-sky-400/85',
        `Hedge CF ${fmtM(m.hedgeCashFlowM)}`,
      );
    }
    pushSeg(lower, m.expensesM, 'bg-rose-400/80', `Expenses ${fmtM(-m.expensesM)}`);
    pushSeg(lower, m.nwcOutM, 'bg-rose-300/70', `NWC out ${fmtM(-m.nwcOutM)}`);
    pushSeg(lower, m.debtOutM, 'bg-amber-500/75', `Debt repay ${fmtM(-m.debtOutM)}`);
    pushSeg(
      lower,
      m.investOutM,
      'bg-teal-600/70',
      `Invest out ${fmtM(-m.investOutM)}`,
    );
    pushSeg(
      lower,
      m.otherOutM,
      'bg-indigo-500/65',
      `Other out ${fmtM(-m.otherOutM)}`,
    );
    if (m.hedgeCashFlowM < -1e-12) {
      pushSeg(
        lower,
        m.hedgeCashFlowM,
        'bg-sky-400/85',
        `Hedge CF ${fmtM(m.hedgeCashFlowM)}`,
      );
    }
    return { upper, lower };
  };

  const inspected =
    displayMonths.find(m => Math.abs(m.monthIndex - inspectMonth) < 1e-9) ??
    displayMonths[displayMonths.length - 1] ??
    null;

  const legendItems: { cls: string; label: string; value: number }[] = inspected
    ? [
        {
          cls: 'bg-sky-300/90',
          label: 'Cash FX',
          value: inspected.openingCashM,
        },
        {
          cls: 'bg-emerald-400/85',
          label: 'Revenue',
          value: inspected.collectionsM,
        },
        {
          cls: 'bg-violet-400/85',
          label: 'Invoice fcast',
          value: inspected.invoiceFcastM,
        },
        { cls: 'bg-violet-300/75', label: 'NWC in', value: inspected.nwcInM },
        {
          cls: 'bg-amber-300/80',
          label: 'Debt draw',
          value: inspected.debtInM,
        },
        {
          cls: 'bg-teal-400/80',
          label: 'Invest in',
          value: inspected.investInM,
        },
        {
          cls: 'bg-indigo-300/70',
          label: 'Other in',
          value: inspected.otherInM,
        },
        {
          cls: 'bg-rose-400/80',
          label: 'Expenses',
          value: -inspected.expensesM,
        },
        {
          cls: 'bg-rose-300/70',
          label: 'NWC out',
          value: -inspected.nwcOutM,
        },
        {
          cls: 'bg-amber-500/75',
          label: 'Debt repay',
          value: -inspected.debtOutM,
        },
        {
          cls: 'bg-teal-600/70',
          label: 'Invest out',
          value: -inspected.investOutM,
        },
        {
          cls: 'bg-indigo-500/65',
          label: 'Other out',
          value: -inspected.otherOutM,
        },
        {
          cls: 'bg-sky-400/85',
          label: 'Hedge CF',
          value: inspected.hedgeCashFlowM,
        },
      ].filter(x => Math.abs(x.value) > 1e-12)
    : [];

  return (
    <>
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${displayMonths.length}, minmax(0, 1fr))`,
        }}
      >
        {displayMonths.map(m => {
          const selected = Math.abs(m.monthIndex - inspectMonth) < 1e-9;
          const expanded = cumulative && selected;
          const netH = hOf(Math.abs(m.endCashM));
          const includeOpening =
            Math.abs(m.openingCashM) > 1e-12 &&
            (!cumulative || expanded);
          const { upper, lower } = sourceSegs(m, includeOpening);
          const tipParts = [
            `${ccy} ${m.label}`,
            includeOpening ? `Cash FX ${fmtM(m.openingCashM)}` : null,
            Math.abs(m.collectionsM) > 1e-12
              ? `Revenue ${fmtM(m.collectionsM)}`
              : null,
            Math.abs(m.invoiceFcastM) > 1e-12
              ? `Invoice fcast ${fmtM(m.invoiceFcastM)}`
              : null,
            Math.abs(m.nwcInM) > 1e-12 ? `NWC in ${fmtM(m.nwcInM)}` : null,
            Math.abs(m.debtInM) > 1e-12 ? `Debt draw ${fmtM(m.debtInM)}` : null,
            Math.abs(m.investInM) > 1e-12
              ? `Invest in ${fmtM(m.investInM)}`
              : null,
            Math.abs(m.otherInM) > 1e-12
              ? `Other in ${fmtM(m.otherInM)}`
              : null,
            m.expensesM > 1e-12 ? `Expenses ${fmtM(-m.expensesM)}` : null,
            m.nwcOutM > 1e-12 ? `NWC out ${fmtM(-m.nwcOutM)}` : null,
            m.debtOutM > 1e-12 ? `Debt repay ${fmtM(-m.debtOutM)}` : null,
            m.investOutM > 1e-12
              ? `Invest out ${fmtM(-m.investOutM)}`
              : null,
            m.otherOutM > 1e-12 ? `Other out ${fmtM(-m.otherOutM)}` : null,
            Math.abs(m.hedgeCashFlowM) > 1e-12
              ? `Hedge CF ${fmtM(m.hedgeCashFlowM)}`
              : null,
            `Net cash ${fmtM(m.endCashM)}`,
          ].filter(Boolean);
          return (
            <button
              key={m.monthIndex}
              type="button"
              onClick={() => setInspectMonth(m.monthIndex)}
              className={`flex flex-col items-center rounded-md px-0.5 py-1 transition-colors ${
                selected
                  ? 'bg-slate-700/40 ring-1 ring-slate-400/40'
                  : m.settleLegCount > 0
                    ? 'bg-emerald-500/[0.06] hover:bg-slate-800/50'
                    : 'hover:bg-slate-800/50'
              }`}
              title={
                cumulative && !expanded
                  ? `${ccy} ${m.label} · net cash ${fmtM(m.endCashM)} — click for source split`
                  : tipParts.join(' · ')
              }
            >
              <div className="mb-1 flex min-h-[1.25rem] flex-col items-center justify-end font-mono text-[9px] tabular-nums leading-none">
                <span
                  className={
                    selected ? 'font-semibold text-slate-200' : 'text-slate-400'
                  }
                  title={cumulative ? `Net cash ${ccy}` : `End ${ccy}`}
                >
                  {fmtM(m.endCashM)}
                </span>
              </div>
              <div
                className="relative flex w-full flex-col items-center"
                style={{ height: CARRY_CHART_BODY_H }}
              >
                {cumulative && !expanded ? (
                  <>
                    <div
                      className="flex w-full flex-col items-center justify-end"
                      style={{ height: halfPx }}
                    >
                      {m.endCashM > 1e-12 && netH > 0 && (
                        <div
                          className="w-7 overflow-hidden rounded-t-sm bg-slate-300/70 sm:w-8"
                          style={{ height: netH }}
                          title={`Net cash ${fmtM(m.endCashM)}`}
                        />
                      )}
                    </div>
                    <div className="h-px w-full bg-slate-500/80" />
                    <div
                      className="flex w-full flex-col items-center justify-start"
                      style={{ height: halfPx }}
                    >
                      {m.endCashM < -1e-12 && netH > 0 && (
                        <div
                          className="w-7 overflow-hidden rounded-b-sm bg-slate-400/55 sm:w-8"
                          style={{ height: netH }}
                          title={`Net cash ${fmtM(m.endCashM)}`}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {renderFlowHalf(upper, true)}
                    <div className="h-px w-full bg-slate-500/80" />
                    {renderFlowHalf(lower, false)}
                  </>
                )}
              </div>
              <span
                className={`mt-1 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-[10px] font-semibold ${
                  selected
                    ? 'bg-slate-500/30 text-slate-100 ring-1 ring-slate-400/40'
                    : m.settleLegCount > 0
                      ? 'bg-emerald-500/20 text-emerald-100'
                      : 'text-slate-500'
                }`}
              >
                {m.label}
              </span>
              {selected ? (
                <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wide text-slate-400">
                  split
                </span>
              ) : m.settleLegCount > 0 ? (
                <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wide text-emerald-500/80">
                  settle
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span className="font-semibold text-slate-400">
          {inspected?.label ?? 'M—'}
        </span>
        {legendItems.map(item => (
          <span
            key={item.label}
            className="inline-flex items-center gap-1.5 font-mono tabular-nums"
          >
            <span className={`inline-block h-2 w-2 rounded-sm ${item.cls}`} />
            <span className="text-slate-500">{item.label}</span>
            <span
              className={
                item.value >= 0 ? 'text-emerald-300/90' : 'text-rose-300/90'
              }
            >
              {fmtM(item.value)}
            </span>
          </span>
        ))}
        {inspected && (
          <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
            <span className="text-slate-500">Net</span>
            <span
              className={
                inspected.endCashM >= 0
                  ? 'font-semibold text-slate-200'
                  : 'font-semibold text-rose-300/90'
              }
            >
              {fmtM(inspected.endCashM)}
            </span>
          </span>
        )}
        <span className="text-slate-600">
          {cumulative
            ? 'Cumulative sources · click a month'
            : `MoM flows · End ${ccy}`}
        </span>
      </div>
    </>
  );
}

/** Per-period hedged carry — Residual / FWD / USD int only (not accrued, not do-nothing). */
function CarryPeriodComponentsChart({
  hedgedMonths,
  Tf,
  activeHorizon,
  ccy,
}: {
  hedgedMonths: CashForecastMonthRow[];
  unhedgedMonths?: CashForecastMonthRow[];
  Tf: number;
  activeHorizon: VarHorizonId;
  ccy: string;
}) {
  const activeMonths = horizonMonths(activeHorizon);
  const [inspectMonth, setInspectMonth] = useState(() =>
    defaultChartInspectMonth(hedgedMonths),
  );

  useEffect(() => {
    setInspectMonth(defaultChartInspectMonth(hedgedMonths));
  }, [ccy, hedgedMonths.length]);

  const inspected =
    hedgedMonths.find(m => Math.abs(m.monthIndex - inspectMonth) < 1e-9) ??
    hedgedMonths[hedgedMonths.length - 1] ??
    null;

  const maxAbs = Math.max(
    1e-9,
    ...hedgedMonths.flatMap(m => [
      Math.abs(m.residualEurInterestUsdM),
      Math.abs(m.fwdCarryUsdM),
      Math.abs(m.usdInterestUsdM),
      Math.abs(m.incomeUsdM),
    ]),
  );
  const halfPx = CARRY_CHART_HALF_PX;
  const hOf = (abs: number) =>
    Math.max(abs > 1e-12 ? 3 : 0, Math.round((abs / maxAbs) * halfPx));

  const renderSignedColumn = (
    segments: { value: number; cls: string; title: string }[],
  ) => {
    const pos = segments.filter(s => s.value > 1e-12);
    const neg = segments.filter(s => s.value < -1e-12);

    /** Same VaR Evolution clip stack as cumulative carry. */
    const renderHalf = (
      segs: { value: number; cls: string; title: string }[],
      positive: boolean,
    ) => {
      if (segs.length === 0) {
        return <div style={{ height: halfPx }} className="w-full" />;
      }
      /** Outer edge first (blue → green → amber from top), base on axis. */
      const ordered = positive ? [...segs].reverse() : segs;
      const extent = ordered.reduce(
        (s, x) => s + hOf(Math.abs(x.value)),
        0,
      );
      return (
        <div
          className={`flex w-full flex-col items-center ${
            positive ? 'justify-end' : 'justify-start'
          }`}
          style={{ height: halfPx }}
        >
          <div
            className={`flex w-7 flex-col overflow-hidden sm:w-8 ${
              positive ? 'justify-end rounded-t-sm' : 'justify-start rounded-b-sm'
            }`}
            style={{ height: extent }}
          >
            {ordered.map((s, i) => (
              <div
                key={i}
                className={`w-full ${s.cls}`}
                style={{ height: hOf(Math.abs(s.value)) }}
                title={s.title}
              />
            ))}
          </div>
        </div>
      );
    };

    return (
      <div className="flex w-full flex-col items-center">
        {renderHalf(pos, true)}
        <div className="h-px w-full bg-slate-500/80" />
        {renderHalf(neg, false)}
      </div>
    );
  };

  return (
    <>
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${hedgedMonths.length}, minmax(0, 1fr))`,
        }}
      >
        {hedgedMonths.map(m => {
          const income = m.incomeUsdM;
          const beyondForecast = Tf > 0 && m.monthIndex > Tf + 1e-9;
          const horizonOn =
            Math.abs(m.monthIndex - activeMonths) < 1e-9 && !beyondForecast;
          const selected = Math.abs(m.monthIndex - inspectMonth) < 1e-9;
          const isTf = Math.abs(m.monthIndex - Tf) < 1e-9;

          return (
            <button
              key={m.monthIndex}
              type="button"
              title={[
                `${ccy} ${m.label}`,
                `Residual ${fmtK(m.residualEurInterestUsdM)}`,
                `FWD ${fmtK(m.fwdCarryUsdM)}`,
                `USD int ${fmtK(m.usdInterestUsdM)}`,
                `Income Σ ${fmtK(income)}`,
              ].join(' · ')}
              onClick={() => setInspectMonth(m.monthIndex)}
              className={`flex flex-col items-center rounded-md px-0.5 py-1 transition-colors ${
                selected
                  ? 'bg-emerald-500/15 ring-1 ring-emerald-400/45'
                  : horizonOn
                    ? 'bg-emerald-500/10'
                    : beyondForecast
                      ? 'bg-slate-800/40 hover:bg-slate-800/70'
                      : 'hover:bg-slate-800/50'
              }`}
            >
              <div className="mb-1 font-mono text-[10px] tabular-nums leading-none">
                <span
                  className={
                    selected || horizonOn
                      ? 'font-semibold text-emerald-100'
                      : income >= 0
                        ? 'text-emerald-300/90'
                        : 'text-rose-300/90'
                  }
                  title="Hedged income this month"
                >
                  {fmtK(income)}
                </span>
              </div>
              <div
                className={`w-full ${
                  beyondForecast ? 'opacity-50' : ''
                }`}
                style={{ height: CARRY_CHART_BODY_H }}
              >
                {renderSignedColumn([
                  {
                    value: m.residualEurInterestUsdM,
                    cls: 'bg-amber-300/90',
                    title: `Residual int ${fmtK(m.residualEurInterestUsdM)}`,
                  },
                  {
                    value: m.fwdCarryUsdM,
                    cls: 'bg-emerald-400/85',
                    title: `FWD pts ${fmtK(m.fwdCarryUsdM)}`,
                  },
                  {
                    value: m.usdInterestUsdM,
                    cls: 'bg-sky-400/85',
                    title: `USD int ${fmtK(m.usdInterestUsdM)}`,
                  },
                ])}
              </div>
              <span
                className={`mt-1 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-[10px] font-semibold ${
                  selected
                    ? 'bg-emerald-500/30 text-emerald-100 ring-1 ring-emerald-400/50'
                    : horizonOn
                      ? 'bg-emerald-500/20 text-emerald-100'
                      : beyondForecast
                        ? 'text-slate-400'
                        : isTf
                          ? 'text-amber-200/90'
                          : m.settleLegCount > 0
                            ? 'text-emerald-300/90'
                            : 'text-slate-500'
                }`}
              >
                {m.label}
              </span>
              {selected ? (
                <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wide text-emerald-500/80">
                  split
                </span>
              ) : isTf && !beyondForecast ? (
                <span className="mt-0.5 text-[8px] font-medium uppercase tracking-wide text-amber-500/80">
                  Tf
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span className="font-semibold text-slate-400">
          {inspected?.label ?? 'M—'}
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-300/90" />
          <span className="text-amber-300/90">Residual int</span>
          <span
            className={
              (inspected?.residualEurInterestUsdM ?? 0) >= 0
                ? 'text-amber-300'
                : 'text-rose-300/90'
            }
          >
            {fmtK(inspected?.residualEurInterestUsdM ?? 0)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400/85" />
          <span className="text-emerald-300/90">FWD pts</span>
          <span
            className={
              (inspected?.fwdCarryUsdM ?? 0) >= 0
                ? 'text-emerald-300/90'
                : 'text-rose-300/90'
            }
          >
            {fmtK(inspected?.fwdCarryUsdM ?? 0)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
          <span className="inline-block h-2 w-2 rounded-sm bg-sky-400/85" />
          <span className="text-sky-300/90">USD int</span>
          <span
            className={
              (inspected?.usdInterestUsdM ?? 0) >= 0
                ? 'text-sky-300/90'
                : 'text-rose-300/90'
            }
          >
            {fmtK(inspected?.usdInterestUsdM ?? 0)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
          <span className="text-slate-300">Income Σ</span>
          <span
            className={
              (inspected?.incomeUsdM ?? 0) >= 0
                ? 'font-semibold text-slate-100'
                : 'font-semibold text-rose-300/90'
            }
          >
            {fmtK(inspected?.incomeUsdM ?? 0)}
          </span>
        </span>
        <span className="text-slate-600">
          MoM · hedged · click a month
        </span>
      </div>
    </>
  );
}

/** Parse "M3/M6/M9/M12" / "M1·start" → month indices for strip markers. */
function parseScheduleMonths(label: string): number[] {
  const found = [...label.matchAll(/M(\d+)/gi)].map(m => Number(m[1]));
  return [...new Set(found.filter(n => Number.isFinite(n)))].sort(
    (a, b) => a - b,
  );
}

/**
 * Modal chart: absolute Enhancement (New − Old + FWD) across settle-WAM months.
 * Selected / book marker stays on its true Enhancement level (not forced to 0).
 * Click a dot to restage the prepared package at that settle WAM.
 */
function SettleWamDeltaVsBookChart({
  scenarios,
  ccy,
  selectedSettleMonths,
  proposalMonths: proposalMonthsProp,
  legBars,
  executionLegs,
  view = 'enhancement',
  onSelectScenario,
  onSelectLegBar,
}: {
  scenarios: readonly SettleWamScenario[];
  ccy: string;
  /** Highlighted target WAM — independent of curve shape. */
  selectedSettleMonths?: number | null;
  /** Optional strip schedule months (amber rings) — overlay only. */
  proposalMonths?: readonly number[];
  /**
   * Applied-shape per-leg bars (Carry Evolution style) — drawn under the
   * matching settle-month points on the same x-scale.
   */
  legBars?: readonly CarryEvolutionBar[];
  /** Exact Δ × settle timing for Strip execution view. */
  executionLegs?: readonly {
    settleMonths: number;
    amountLocalM: number;
    weight: number;
    label: string;
  }[];
  view?: 'enhancement' | 'execution';
  onSelectScenario?: (scenario: SettleWamScenario) => void;
  onSelectLegBar?: (bar: CarryEvolutionBar) => void;
}) {
  const book = scenarios.find(s => s.isCurrentWam) ?? scenarios[0];
  const selected =
    selectedSettleMonths != null
      ? (scenarios.find(
          s => Math.round(s.settleMonths) === Math.round(selectedSettleMonths),
        ) ?? null)
      : null;
  const structure = book?.structure ?? 'none';
  const legCount = book?.legCount ?? 0;
  const proposalMonths =
    proposalMonthsProp ??
    (book ? parseScheduleMonths(book.settleScheduleLabel) : []);
  const proposalSet = new Set(
    proposalMonths.map(m => Math.round(m)).filter(m => Number.isFinite(m)),
  );
  const selectable = Boolean(onSelectScenario);
  /** Per-leg bars render only in Strip execution (grid) — never under the curve. */
  const showLegBars = false;
  /** Strip execution: prefer per-leg carry stacks (MoM style); Δ bars as fallback. */
  const showExecutionStacks =
    view === 'execution' && Boolean(legBars && legBars.length > 0);
  const showExecution =
    view === 'execution' &&
    !showExecutionStacks &&
    Boolean(executionLegs && executionLegs.length > 0);

  const pts = scenarios.map(s => {
    const isSelected =
      selectedSettleMonths != null &&
      Math.round(s.settleMonths) === Math.round(selectedSettleMonths);
    return {
      scenario: s,
      m: s.settleMonths,
      /** Absolute Enhancement vs do-nothing — same column as the table. */
      y: s.enhancementUsdM,
      vsBook: s.totalVsBookUsdM,
      total: s.totalCarryUsdM,
      label: s.label,
      isBook: s.isCurrentWam,
      isSelected,
      isProposal: proposalSet.has(Math.round(s.settleMonths)),
      schedule: s.settleScheduleLabel,
      beyond: s.beyondForecast,
    };
  });

  const W = 720;
  /** Per-leg bipolar bars sit above the M1…M12 axis, not below it. */
  const LEG_BAND = 100;
  const AXIS_BAND = 28;
  const padT = 28;
  const padR = 24;
  const padL = 56;
  const enhInnerH = 212; // fixed Enhancement plot height
  const padB = showLegBars ? LEG_BAND + AXIS_BAND : 40;
  const H = padT + enhInnerH + padB;
  const pad = { t: padT, r: padR, b: padB, l: padL };
  const innerW = W - pad.l - pad.r;
  const innerH = enhInnerH;

  const xs = pts.map(p => p.m);
  const ys = pts.map(p => p.y);
  const xMin = xs.length ? Math.min(...xs) : 0;
  const xMax = xs.length ? Math.max(...xs) : 12;
  // Zoom Y to the Enhancement band so month-to-month variance is visible
  // (do not force 0 into the domain — that flattens the curve).
  const yRawMin = ys.length ? Math.min(...ys) : 0;
  const yRawMax = ys.length ? Math.max(...ys) : 1e-6;
  const ySpan0 = yRawMax - yRawMin;
  // Floor span at ~8% of |mid| (or 1e-5 $M) so near-flat series still has room.
  const yMid = (yRawMin + yRawMax) / 2;
  const minSpan = Math.max(Math.abs(yMid) * 0.08, 1e-5);
  const ySpan = Math.max(ySpan0, minSpan);
  const yPad = ySpan * 0.18;
  const yCenter = ySpan0 < 1e-12 ? yMid : (yRawMin + yRawMax) / 2;
  const yMin =
    ySpan0 < 1e-12 ? yCenter - ySpan / 2 - yPad : yRawMin - yPad;
  const yMax =
    ySpan0 < 1e-12 ? yCenter + ySpan / 2 + yPad : yRawMax + yPad;

  const xOf = (m: number) =>
    pad.l +
    (xMax <= xMin ? innerW / 2 : ((m - xMin) / (xMax - xMin)) * innerW);
  const yOf = (v: number) =>
    pad.t + ((yMax - v) / (yMax - yMin || 1)) * innerH;

  const pathD =
    pts.length === 0
      ? ''
      : pts
          .map(
            (p, i) =>
              `${i === 0 ? 'M' : 'L'} ${xOf(p.m).toFixed(1)} ${yOf(p.y).toFixed(1)}`,
          )
          .join(' ');

  const zeroInView = 0 >= yMin - 1e-15 && 0 <= yMax + 1e-15;
  const zeroY = yOf(0);
  const yMidTick = (yMin + yMax) / 2;
  const structLabel =
    structure === 'strip'
      ? `Strip · ${legCount} leg${legCount === 1 ? '' : 's'}`
      : structure === 'bullet'
        ? 'Bullet'
        : '—';

  const eligibleForBest = pts.filter(
    p => !p.beyond && Math.abs(p.scenario.hedgeDeltaLocalM) > 1e-12,
  );
  const bestPt =
    eligibleForBest.length > 0
      ? eligibleForBest.reduce((a, b) => (b.y > a.y ? b : a), eligibleForBest[0]!)
      : pts.length > 0
        ? pts.reduce((a, b) => (b.y > a.y ? b : a), pts[0]!)
        : null;
  const selPt =
    selected != null
      ? (pts.find(p => p.isSelected) ?? bestPt)
      : bestPt;
  const selSameAsBest =
    bestPt != null &&
    selPt != null &&
    Math.round(bestPt.m) === Math.round(selPt.m);
  const selVsBestFmt =
    bestPt && selPt
      ? selSameAsBest
        ? '—'
        : fmtK(selPt.y - bestPt.y)
      : '—';

  const legMaxAbs = showLegBars
    ? Math.max(
        1e-9,
        ...legBars!.map(b =>
          Math.max(
            Math.abs(b.improvedCarryUsdM),
            Math.abs(b.defaultCarryUsdM),
            Math.abs(b.hedgeImprovementUsdM),
          ),
        ),
      )
    : 1;
  const legHalfPx = 32;
  const enhBottom = pad.t + innerH;
  /** Midline of bipolar bars — directly under Enhancement, above M1…M12. */
  const legBarMidY = enhBottom + 10 + legHalfPx;
  const legBarW = Math.min(
    16,
    Math.max(8, (innerW / Math.max(xMax - xMin + 1, 1)) * 0.45),
  );
  const monthLabelY = H - 12;
  const legNameY = legBarMidY + legHalfPx + 11;

  /**
   * Strip execution — per-leg Enhancement structure as stacked bars
   * (same Residual / FWD / USD palette as Carry · MoM).
   */
  if (showExecutionStacks && legBars) {
    const halfPx = CARRY_CHART_HALF_PX;
    const maxAbs = Math.max(
      1e-9,
      ...legBars.flatMap(b => [
        Math.abs(b.hedgeBreakdown.fcyInterestUsdM),
        Math.abs(b.hedgeBreakdown.fwdCarryUsdM),
        Math.abs(b.hedgeBreakdown.usdInterestUsdM),
        Math.abs(b.hedgeImprovementUsdM),
        Math.abs(b.improvedCarryUsdM),
      ]),
    );
    const hOf = (abs: number) =>
      Math.max(abs > 1e-12 ? 3 : 0, Math.round((abs / maxAbs) * halfPx));

    const renderEnhancementStack = (bar: CarryEvolutionBar) => {
      const residual = bar.hedgeBreakdown.fcyInterestUsdM;
      const fwd = bar.hedgeBreakdown.fwdCarryUsdM;
      const usdInt = bar.hedgeBreakdown.usdInterestUsdM;
      const segments = [
        {
          value: residual,
          cls: 'bg-amber-300/90',
          title: `Residual int ${fmtK(residual)}`,
        },
        {
          value: fwd,
          cls: 'bg-emerald-400/85',
          title: `FWD pts ${fmtK(fwd)}`,
        },
        {
          value: usdInt,
          cls: 'bg-sky-400/85',
          title: `USD int ${fmtK(usdInt)}`,
        },
      ];
      const pos = segments.filter(s => s.value > 1e-12);
      const neg = segments.filter(s => s.value < -1e-12);
      const renderHalf = (
        segs: { value: number; cls: string; title: string }[],
        positive: boolean,
      ) => {
        if (segs.length === 0) {
          return <div style={{ height: halfPx }} className="w-full" />;
        }
        const ordered = positive ? [...segs].reverse() : segs;
        const extent = ordered.reduce(
          (s, x) => s + hOf(Math.abs(x.value)),
          0,
        );
        return (
          <div
            className={`flex w-full flex-col items-center ${
              positive ? 'justify-end' : 'justify-start'
            }`}
            style={{ height: halfPx }}
          >
            <div
              className={`flex w-8 flex-col overflow-hidden sm:w-9 ${
                positive
                  ? 'justify-end rounded-t-sm'
                  : 'justify-start rounded-b-sm'
              }`}
              style={{ height: extent }}
            >
              {ordered.map((s, i) => (
                <div
                  key={i}
                  className={`w-full ${s.cls}`}
                  style={{ height: hOf(Math.abs(s.value)) }}
                  title={s.title}
                />
              ))}
            </div>
          </div>
        );
      };
      return (
        <>
          {renderHalf(pos, true)}
          <div className="h-px w-full bg-slate-500/80" />
          {renderHalf(neg, false)}
        </>
      );
    };

    const enhSum = legBars.reduce((s, b) => s + b.hedgeImprovementUsdM, 0);
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-amber-300/90" />
            <span className="text-amber-300/90">Residual int</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400/85" />
            <span className="text-emerald-300/90">FWD pts</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm bg-sky-400/85" />
            <span className="text-sky-300/90">USD int</span>
          </span>
          <span className="font-mono text-slate-400">
            Σ enh {fmtK(enhSum)} · {legBars.length} leg
            {legBars.length === 1 ? '' : 's'} · same stack as Carry · MoM
          </span>
        </div>
        <div
          className="grid gap-2 rounded-lg border border-slate-700/80 bg-slate-950/50 p-3"
          style={{
            gridTemplateColumns: `repeat(${legBars.length}, minmax(0, 1fr))`,
          }}
          role="img"
          aria-label={`${ccy} strip execution · Enhancement stack per leg`}
        >
          {legBars.map(bar => {
            const enh = bar.hedgeImprovementUsdM;
            const settleM = Math.round(bar.months);
            const delta =
              bar.hedgeBreakdown.hedgeDeltaLocalM ?? bar.amountLocalM;
            const title = [
              bar.label,
              `settle M${settleM}`,
              delta != null ? `Δ ${fmtM(delta)}` : null,
              `Enh ${fmtK(enh)}`,
              `Residual ${fmtK(bar.hedgeBreakdown.fcyInterestUsdM)}`,
              `FWD ${fmtK(bar.hedgeBreakdown.fwdCarryUsdM)}`,
              `USD int ${fmtK(bar.hedgeBreakdown.usdInterestUsdM)}`,
            ]
              .filter(Boolean)
              .join(' · ');
            // Display-only — never wire clicks; selecting a leg must not
            // re-pin WAM / rebuild the staged strip.
            return (
              <div
                key={bar.id}
                title={title}
                className="flex flex-col items-center rounded-md px-0.5 py-1"
              >
                <div className="mb-1 font-mono text-[10px] tabular-nums leading-none">
                  <span
                    className={
                      enh >= 0 ? 'text-emerald-300/90' : 'text-rose-300/90'
                    }
                    title="Enhancement = New − Old + FWD"
                  >
                    {fmtK(enh)}
                  </span>
                </div>
                <div
                  className="w-full"
                  style={{ height: CARRY_CHART_BODY_H }}
                >
                  {renderEnhancementStack(bar)}
                </div>
                <span className="mt-1 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-[10px] font-semibold text-violet-200/90">
                  {bar.label.includes('·')
                    ? bar.label.split('·')[0]!.trim()
                    : bar.label}
                </span>
                <span className="mt-0.5 font-mono text-[8px] text-amber-200/80">
                  M{settleM}
                  {delta != null && Math.abs(delta) > 1e-12
                    ? ` · ${fmtM(delta)}`
                    : ''}
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-slate-500">
          Each bar = one strip leg at its settle month (read-only). Stack =
          Enhancement sources (Residual FCY int · FWD pts · USD int) — Carry ·
          MoM colours. Label above = Enhancement Σ for that leg.
        </p>
      </div>
    );
  }

  /** Fallback: exact Δ bars when leg carry stacks unavailable. */
  if (showExecution && executionLegs) {
    const exXs = scenarios.map(s => s.settleMonths);
    const exXMin = exXs.length ? Math.min(...exXs) : 0;
    const exXMax = exXs.length ? Math.max(...exXs) : 12;
    const exW = 720;
    const exH = 280;
    const exPad = { t: 36, r: 24, b: 40, l: 56 };
    const exInnerW = exW - exPad.l - exPad.r;
    const exInnerH = exH - exPad.t - exPad.b;
    const exXOf = (m: number) =>
      exPad.l +
      (exXMax <= exXMin
        ? exInnerW / 2
        : ((m - exXMin) / (exXMax - exXMin)) * exInnerW);
    const maxAmt = Math.max(
      1e-9,
      ...executionLegs.map(l => Math.abs(l.amountLocalM)),
    );
    const barW = Math.min(
      28,
      Math.max(12, (exInnerW / Math.max(exXMax - exXMin + 1, 1)) * 0.55),
    );
    const baseY = exPad.t + exInnerH;
    const totalDelta = executionLegs.reduce((s, l) => s + l.amountLocalM, 0);
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2.5 text-[10px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-1.5 rounded-sm bg-violet-400/80" />
            Strip leg Δ (Sched-% × hedge Δ)
          </span>
          <span className="font-mono text-slate-400">
            Σ {fmtM(totalDelta)} · {executionLegs.length} leg
            {executionLegs.length === 1 ? '' : 's'} · settle = bar x
          </span>
        </div>
        <svg
          viewBox={`0 0 ${exW} ${exH}`}
          className="h-auto w-full max-h-[360px] rounded-lg border border-slate-700/80 bg-slate-950/50"
          role="img"
          aria-label={`${ccy} strip execution amounts by settle month`}
        >
          {[0.25, 0.5, 0.75, 1].map(t => {
            const y = exPad.t + (1 - t) * exInnerH;
            return (
              <g key={t}>
                <line
                  x1={exPad.l}
                  x2={exW - exPad.r}
                  y1={y}
                  y2={y}
                  stroke="#334155"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                />
                <text
                  x={8}
                  y={y + 3}
                  fill="#64748b"
                  fontSize={8}
                  fontFamily="ui-monospace, monospace"
                >
                  {fmtM(maxAmt * t)}
                </text>
              </g>
            );
          })}
          {scenarios.map(s => (
            <text
              key={`ex-m-${s.label}`}
              x={exXOf(s.settleMonths)}
              y={exH - 12}
              textAnchor="middle"
              fill={
                selectedSettleMonths != null &&
                Math.round(s.settleMonths) ===
                  Math.round(selectedSettleMonths)
                  ? '#a7f3d0'
                  : '#64748b'
              }
              fontSize={9}
              fontWeight={
                selectedSettleMonths != null &&
                Math.round(s.settleMonths) ===
                  Math.round(selectedSettleMonths)
                  ? 600
                  : 400
              }
            >
              {s.label}
            </text>
          ))}
          {executionLegs.map((leg, i) => {
            const cx = exXOf(leg.settleMonths);
            const h = Math.max(
              4,
              (Math.abs(leg.amountLocalM) / maxAmt) * exInnerH * 0.92,
            );
            const x = cx - barW / 2;
            const y = baseY - h;
            const m = Math.max(0, Math.round(leg.settleMonths));
            return (
              <g key={`ex-leg-${leg.label}-${i}`}>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={2}
                  fill="rgba(167, 139, 250, 0.55)"
                  stroke="#a78bfa"
                  strokeWidth={1.25}
                />
                <text
                  x={cx}
                  y={y - 12}
                  textAnchor="middle"
                  fill="#ddd6fe"
                  fontSize={9}
                  fontWeight={600}
                  fontFamily="ui-monospace, monospace"
                >
                  {leg.label}
                </text>
                <text
                  x={cx}
                  y={y - 2}
                  textAnchor="middle"
                  fill="#e9d5ff"
                  fontSize={8}
                  fontFamily="ui-monospace, monospace"
                >
                  {fmtM(leg.amountLocalM)}
                </text>
                <text
                  x={cx}
                  y={baseY + 11}
                  textAnchor="middle"
                  fill="#fde68a"
                  fontSize={8}
                  fontWeight={600}
                  fontFamily="ui-monospace, monospace"
                >
                  M{m} · {(leg.weight * 100).toFixed(0)}%
                </text>
                <title>{`${leg.label} · settle M${m} · Sched ${(leg.weight * 100).toFixed(1)}% · Δ ${fmtM(leg.amountLocalM)}`}</title>
              </g>
            );
          })}
          <text
            x={exPad.l - 8}
            y={exPad.t - 14}
            fill="#c4b5fd"
            fontSize={10}
            fontWeight={600}
            textAnchor="start"
          >
            Leg Δ ($M)
          </text>
          <text
            x={exW / 2}
            y={exH - 2}
            fill="#64748b"
            fontSize={9}
            textAnchor="middle"
          >
            Settle month (execution timing)
          </text>
        </svg>
        <p className="text-[10px] text-slate-500">
          Amounts = Sched-% × total hedge Δ (optimizer weights) — not exposure
          path intersection. Bar x = cash settle month from M0.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
          A · Enhancement curve ($K)
        </span>
        {bestPt && selPt ? (
          <span className="font-mono text-[10px] text-slate-500">
            best{' '}
            <span className="text-emerald-300">
              {bestPt.label} {fmtK(bestPt.y)}
            </span>
            {' · '}
            selected{' '}
            <span className="text-slate-100">
              {selPt.label} {fmtK(selPt.y)}
            </span>{' '}
            <span className="text-slate-400">{selVsBestFmt} vs best</span>
          </span>
        ) : null}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={`h-auto w-full rounded-lg border border-slate-700/80 bg-slate-950/50 ${
          showLegBars ? 'max-h-[480px]' : 'max-h-[360px]'
        }`}
        role="img"
        aria-label={`${ccy} Enhancement across settle WAM months`}
      >
        {[0.25, 0.5, 0.75].map(t => {
          const y = pad.t + t * innerH;
          return (
            <line
              key={t}
              x1={pad.l}
              x2={W - pad.r}
              y1={y}
              y2={y}
              stroke="#334155"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
          );
        })}
        {zeroInView && (
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={zeroY}
            y2={zeroY}
            stroke="#64748b"
            strokeWidth={1.25}
            strokeDasharray="4 3"
          />
        )}

        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke="#34d399"
            strokeWidth={2}
            strokeDasharray="7 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {selPt && (
          <line
            x1={xOf(selPt.m)}
            x2={xOf(selPt.m)}
            y1={pad.t - 4}
            y2={pad.t + innerH + 4}
            stroke="rgba(226,232,240,.35)"
            strokeWidth={1}
            pointerEvents="none"
          />
        )}
        {bestPt && !selSameAsBest && (
          <line
            x1={xOf(bestPt.m)}
            x2={xOf(bestPt.m)}
            y1={pad.t - 4}
            y2={pad.t + innerH + 4}
            stroke="rgba(52,211,153,.45)"
            strokeWidth={1}
            strokeDasharray="3 4"
            pointerEvents="none"
          />
        )}

        {/* Guide lines from strip-leg settle months down into the bar band */}
        {showLegBars &&
          legBars!.map((bar, i) => {
            const cx = xOf(bar.months);
            return (
              <line
                key={`leg-guide-${bar.id}-${i}`}
                x1={cx}
                x2={cx}
                y1={pad.t + innerH}
                y2={legBarMidY - legHalfPx}
                stroke="#475569"
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.7}
                pointerEvents="none"
              />
            );
          })}

        {pts.map(p => {
          const cx = xOf(p.m);
          const cy = yOf(p.y);
          const isBest =
            bestPt != null && Math.round(p.m) === Math.round(bestPt.m);
          const r = isBest ? 6 : p.isBook || p.isProposal ? 5 : 3.5;
          const fill = isBest
            ? '#34d399'
            : p.isBook
              ? '#a7f3d0'
              : '#10b981';
          const stroke = p.isProposal ? '#f59e0b' : 'none';
          const strokeWidth = p.isProposal ? 2 : 0;
          return (
            <circle
              key={`pt-${p.label}`}
              cx={cx}
              cy={cy}
              r={r}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
              opacity={p.beyond ? 0.45 : 1}
              pointerEvents="none"
            />
          );
        })}
        {bestPt && (
          <circle
            cx={xOf(bestPt.m)}
            cy={yOf(bestPt.y)}
            r={10}
            fill="none"
            stroke="rgba(52,211,153,.55)"
            strokeWidth={1.5}
            pointerEvents="none"
          />
        )}
        {pts.map(p => {
          const cx = xOf(p.m);
          const cy = yOf(p.y);
          const canSelect =
            selectable && Math.abs(p.scenario.hedgeDeltaLocalM) > 1e-12;
          const pointTitle = `${p.isSelected ? 'Selected' : 'Select'} ${p.label} · Enh ${fmtK(p.y)} · vs book ${fmtK(p.vsBook)} · ${p.schedule}`;
          if (!canSelect) return null;
          return (
            <circle
              key={`hit-${p.label}`}
              cx={cx}
              cy={cy}
              r={13}
              fill="transparent"
              className="cursor-pointer"
              onClick={() => onSelectScenario?.(p.scenario)}
              onMouseDown={e => e.preventDefault()}
            >
              <title>{pointTitle}</title>
            </circle>
          );
        })}
        {pts.map(p => {
          const cx = xOf(p.m);
          const cy = yOf(p.y);
          const isBest =
            bestPt != null && Math.round(p.m) === Math.round(bestPt.m);
          if (isBest) {
            return (
              <text
                key={`cap-${p.label}`}
                x={cx}
                y={cy - 13}
                textAnchor="middle"
                fill="#6ee7b7"
                fontSize={9}
                fontWeight={600}
                fontFamily="ui-monospace, monospace"
                pointerEvents="none"
              >
                {`best ${fmtK(p.y)}`}
              </text>
            );
          }
          if (p.isBook) {
            return (
              <text
                key={`cap-${p.label}`}
                x={cx}
                y={cy + 17}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize={9}
                fontWeight={600}
                fontFamily="ui-monospace, monospace"
                pointerEvents="none"
              >
                book
              </text>
            );
          }
          return null;
        })}
        {pts.map(p => {
          const cx = xOf(p.m);
          const isBest =
            bestPt != null && Math.round(p.m) === Math.round(bestPt.m);
          const canSelect =
            selectable && Math.abs(p.scenario.hedgeDeltaLocalM) > 1e-12;
          const labelFill = isBest
            ? '#6ee7b7'
            : p.isSelected
              ? '#f1f5f9'
              : p.isBook
                ? '#a7f3d0'
                : p.isProposal
                  ? 'rgba(253,230,138,0.9)'
                  : '#64748b';
          const labelWeight =
            isBest || p.isSelected ? 700 : p.isBook || p.isProposal ? 600 : 400;
          return (
            <text
              key={`mx-${p.label}`}
              x={cx}
              y={monthLabelY}
              textAnchor="middle"
              fill={labelFill}
              fontSize={9}
              fontWeight={labelWeight}
              className={canSelect ? 'cursor-pointer' : undefined}
              pointerEvents={canSelect ? 'auto' : 'none'}
              onClick={
                canSelect ? () => onSelectScenario?.(p.scenario) : undefined
              }
            >
              {p.label}
            </text>
          );
        })}

        {/* Per-leg bars — same xOf as curve points (Carry Evolution style) */}
        {showLegBars && (
          <>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={legBarMidY}
              y2={legBarMidY}
              stroke="#64748b"
              strokeWidth={1}
              opacity={0.85}
            />
            <text
              x={pad.l - 8}
              y={legBarMidY - legHalfPx - 4}
              fill="#a78bfa"
              fontSize={9}
              fontWeight={600}
              textAnchor="start"
            >
              Per leg
            </text>
            {legBars!.map((bar, i) => {
              const cx = xOf(bar.months);
              const total = bar.improvedCarryUsdM;
              const doNothing = bar.defaultCarryUsdM;
              const diff = bar.hedgeImprovementUsdM;
              const hPx = (abs: number) =>
                Math.max(
                  abs > 1e-12 ? 3 : 0,
                  Math.round((abs / legMaxAbs) * legHalfPx),
                );
              const x = cx - legBarW / 2;
              const active =
                selectedSettleMonths != null &&
                Math.abs(bar.months - selectedSettleMonths) < 0.51;
              const title = [
                bar.label,
                bar.amountLocalM != null
                  ? `Δ ${bar.amountLocalM.toFixed(2)}M`
                  : null,
                `do nothing ${fmtK(doNothing)}`,
                `enhancement ${fmtK(diff)}`,
                `accrued ${fmtK(total)}`,
              ]
                .filter(Boolean)
                .join(' · ');
              const amber = 'rgba(252, 211, 77, 0.9)';
              const green = 'rgba(52, 211, 153, 0.85)';
              const red = 'rgba(251, 113, 133, 0.75)';
              // Same bipolar rule as CarryEvolutionBarChart: yellow by
              // do-nothing sign; green improvement always above mid-line.
              const upSegs: { h: number; fill: string }[] = [];
              const dnSegs: { h: number; fill: string }[] = [];
              if (doNothing > 1e-12) {
                upSegs.push({ h: hPx(doNothing), fill: amber });
              } else if (doNothing < -1e-12) {
                dnSegs.push({ h: hPx(Math.abs(doNothing)), fill: amber });
              }
              if (diff > 1e-12) {
                upSegs.push({ h: hPx(diff), fill: green });
              } else if (diff < -1e-12) {
                dnSegs.push({ h: hPx(Math.abs(diff)), fill: red });
              }
              const upExtent = upSegs.reduce((s, x) => s + x.h, 0);
              const dnExtent = dnSegs.reduce((s, x) => s + x.h, 0);
              return (
                <g key={`leg-bar-${bar.id}-${i}`}>
                  <title>{title}</title>
                  {upSegs.map((s, si) => {
                    let acc = 0;
                    for (let j = upSegs.length - 1; j > si; j -= 1) {
                      acc += upSegs[j]!.h;
                    }
                    const rectY = legBarMidY - upExtent + acc;
                    return (
                      <rect
                        key={`u-${si}`}
                        x={x}
                        y={rectY}
                        width={legBarW}
                        height={s.h}
                        rx={si === 0 ? 1.5 : 0}
                        fill={s.fill}
                        stroke={active ? '#a7f3d0' : 'transparent'}
                        strokeWidth={active ? 1.25 : 0}
                      />
                    );
                  })}
                  {dnSegs.map((s, si) => {
                    let acc = 0;
                    for (let j = 0; j < si; j += 1) acc += dnSegs[j]!.h;
                    return (
                      <rect
                        key={`d-${si}`}
                        x={x}
                        y={legBarMidY + acc}
                        width={legBarW}
                        height={s.h}
                        rx={si === dnSegs.length - 1 ? 1.5 : 0}
                        fill={s.fill}
                        stroke={active ? '#a7f3d0' : 'transparent'}
                        strokeWidth={active ? 1.25 : 0}
                      />
                    );
                  })}
                  {(upExtent > 0 || dnExtent > 0) && (
                    <text
                      x={cx}
                      y={
                        upExtent >= dnExtent
                          ? legBarMidY - upExtent - 3
                          : legBarMidY + dnExtent + 9
                      }
                      textAnchor="middle"
                      fill={diff >= 0 ? '#6ee7b7' : '#fda4af'}
                      fontSize={7}
                      fontFamily="ui-monospace, monospace"
                      pointerEvents="none"
                    >
                      {fmtK(total)}
                    </text>
                  )}
                  <text
                    x={cx}
                    y={legNameY}
                    textAnchor="middle"
                    fill={active ? '#c4b5fd' : '#94a3b8'}
                    fontSize={8}
                    fontWeight={600}
                    pointerEvents="none"
                  >
                    {bar.label.includes('·')
                      ? bar.label.split('·')[0]!.trim()
                      : bar.label}
                  </text>
                </g>
              );
            })}
          </>
        )}

        <text
          x={8}
          y={pad.t + 4}
          fill="#94a3b8"
          fontSize={9}
          fontFamily="ui-monospace, monospace"
        >
          {fmtK(yMax)}
        </text>
        <text
          x={8}
          y={yOf(yMidTick) + 3}
          fill="#64748b"
          fontSize={9}
          fontFamily="ui-monospace, monospace"
        >
          {fmtK(yMidTick)}
        </text>
        {zeroInView && Math.abs(yMidTick) > 1e-9 && (
          <text
            x={8}
            y={zeroY + 3}
            fill="#64748b"
            fontSize={8}
            fontFamily="ui-monospace, monospace"
          >
            0
          </text>
        )}
        <text
          x={8}
          y={pad.t + innerH}
          fill="#94a3b8"
          fontSize={9}
          fontFamily="ui-monospace, monospace"
        >
          {fmtK(yMin)}
        </text>
        <text
          x={pad.l - 8}
          y={pad.t - 10}
          fill="#6ee7b7"
          fontSize={10}
          fontWeight={600}
          textAnchor="start"
        >
          Enhancement ($K)
        </text>
        <text
          x={W / 2}
          y={H - 2}
          fill="#64748b"
          fontSize={9}
          textAnchor="middle"
        >
          Settle WAM (M-index)
        </text>
      </svg>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-slate-800 pt-2 text-[10px] text-slate-500">
        <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
          D · Legend
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-emerald-400/55 bg-emerald-400" />
          Peak enhancement
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-px bg-slate-200/55" />
          Selected settle WAM
        </span>
        {proposalMonths.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full border-2 border-amber-500 bg-emerald-500" />
            Proposed
          </span>
        )}
        {selectable && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Click a month to apply
          </span>
        )}
        <span className="hidden h-3 w-px bg-slate-700 sm:inline-block" aria-hidden />
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0 w-4 border-t border-dashed border-emerald-400/60"
            aria-hidden
          />
          Peak rule
        </span>
        {structLabel !== '—' ? (
          <span className="font-mono text-slate-400">{structLabel}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Analytics Cash Carry — VaR-style evolution bars + cash / hedge layers.
 */
export function CashCarryAnalyticsView({
  risk,
  setup,
  onSetupChange,
  bookedHedges,
  preparedByCcy = {},
  onPreparedByCcyChange,
  carrySessionsByCcy = {},
  onCarrySessionsByCcyChange,
  bookRows,
  forecastProfile,
  ratesScopeId,
  marketRates: marketRatesProp,
  marketRatesByCcy = {},
  onMarketRatesByCcyChange,
  title,
  subtitle,
  onAllCcyTotalCarryUsdMChange,
}: CashCarryAnalyticsViewProps) {
  /** Resolve the uploaded curve for any CCY — multi-ccy table rows use this directly. */
  const marketRatesFor = useCallback(
    (ccy: string): FxMarketRatesBundle =>
      marketRatesProp ??
      resolveMarketRatesForCcy(marketRatesByCcy, ccy, ratesScopeId),
    [marketRatesProp, marketRatesByCcy, ratesScopeId],
  );

  const patch = (partial: Partial<VarSetup>) =>
    onSetupChange?.({ ...setup, ...partial });
  const sigmaMonthly = monthlyVolForSetup(setup);
  const zConf = zForConfidence(setup.confidencePct);

  const chartCcys = useMemo(
    () =>
      risk
        .map(r => r.bar.ccy)
        .filter(ccy => ccy !== 'USD' && ccy.length > 0),
    [risk],
  );
  const [chartCcy, setChartCcy] = useState('EUR');
  /** Curve for the currently open modal / chart CCY — most call sites use this. */
  const marketRates = marketRatesFor(chartCcy);
  const cashInterestMode = cashInterestModeOf(marketRates);

  const setCashInterestMode = (mode: CashInterestMode) => {
    if (!onMarketRatesByCcyChange) return;
    onMarketRatesByCcyChange(
      setMarketRatesForCcy(marketRatesByCcy, chartCcy, {
        ...marketRates,
        cashInterestMode: mode,
      }),
    );
  };
  /** Settle-WAM / analytical profile modal (VarAnalytics pattern). */
  const [profileCcy, setProfileCcy] = useState<string | null>(null);
  useEffect(() => {
    if (chartCcys.length === 0) return;
    if (!chartCcys.includes(chartCcy)) {
      const next = chartCcys.includes('EUR') ? 'EUR' : chartCcys[0]!;
      setChartCcy(next);
    }
    if (profileCcy && !chartCcys.includes(profileCcy)) {
      setProfileCcy(null);
    }
  }, [chartCcys, chartCcy, profileCcy]);

  const [pathInfoOpen, setPathInfoOpen] = useState(false);
  /** Carry + cash flow charts: per-month vs running cumulative. */
  const [pathPresentationMode, setPathPresentationMode] = useState<
    'mom' | 'cumulative'
  >('mom');
  /** Month schedule / carry / cash path — unified panel view. */
  const [ccyPathView, setCcyPathView] = useState<
    'carry' | 'cashflow' | 'table'
  >('carry');
  /** Hedging summary trade row → filter carry / cashflow to one leg. */
  const [selectedTradeKey, setSelectedTradeKey] =
    useState<HedgeTradeSelectionKey | null>(null);
  const [pathBasis, setPathBasis] = useState<HedgePathBasisId>('totalExpected');
  const [pathStructure, setPathStructure] =
    useState<ForecastHedgeStructure>('bullet');
  const [pathStripLegCount, setPathStripLegCount] = useState<number | null>(
    null,
  );
  /** Strip settle months mirrored into gear Schedule setup from Settle-WAM. */
  const [pathScheduleEnds, setPathScheduleEnds] = useState<number[] | null>(
    null,
  );
  /** Optimizer Hedge-% weights (notional shares) for path schedule table. */
  const [pathHedgeWeights, setPathHedgeWeights] = useState<number[] | null>(
    null,
  );
  const [pathSummaryMetrics, setPathSummaryMetrics] =
    useState<HedgePathSummaryMetrics | null>(null);
  const [pathPerfPanelHost, setPathPerfPanelHost] =
    useState<HTMLElement | null>(null);
  const [pathSchedulePanelHost, setPathSchedulePanelHost] =
    useState<HTMLElement | null>(null);
  /** Callback refs must not setState when the node is unchanged. */
  const bindPathPerfPanelHost = useCallback((el: HTMLElement | null) => {
    setPathPerfPanelHost(prev => (prev === el ? prev : el));
  }, []);
  const bindPathSchedulePanelHost = useCallback((el: HTMLElement | null) => {
    setPathSchedulePanelHost(prev => (prev === el ? prev : el));
  }, []);
  /** WAM chart: Enhancement curve vs strip Δ × settle timing. */
  const [wamChartView, setWamChartView] = useState<
    'enhancement' | 'execution'
  >('enhancement');
  /** Target settle WAM on the static bullet Enhancement curve (does not reshape). */
  const [selectedSettleMonths, setSelectedSettleMonths] = useState<
    number | null
  >(null);
  /** Manual / selected strip shape around WAM (defaults to optimizer best). */
  const [shapePreview, setShapePreview] = useState<{
    legCount: number;
    centerOfMass: number;
    kurtosis: number;
  } | null>(null);
  /**
   * Once the desk edits starting knobs or path Strip legs, do not reseed from
   * optimizer best / clear on WAM browse — that made −/+ look dead.
   */
  const shapeStartManualRef = useRef(false);
  /** Last WAM used for shape search — ignore settleScenarios identity churn. */
  const lastShapeWamRef = useRef<number | null>(null);
  /**
   * Locked shape after Apply — WAM chart/table switches to this shape × Mm
   * ladder so the desk can re-check optimal WAM.
   */
  const [appliedShape, setAppliedShape] = useState<{
    legCount: number;
    centerOfMass: number;
    kurtosis: number;
  } | null>(null);
  /** Locked Apply-shape score — feeds header Total opt. carry / Final enh. */
  const [appliedShapeScore, setAppliedShapeScore] =
    useState<StripShapeScore | null>(null);
  /**
   * Modal hedge package. Apply shape / rank row / path Prepare all update
   * this local draft only; Assign/Prebook is the sole explicit action that
   * promotes it to Analytics prepared + Neon / Decision.
   */
  const [profileDraft, setProfileDraft] = useState<PreparedHedgeProfile | null>(
    null,
  );
  const [profileDraftDirty, setProfileDraftDirty] = useState(false);
  /**
   * Keep Apply / draft / custom schedule when closing the modal so Hedging
   * Summary ↔ profile round-trips do not fall back to equal-period ladder.
   * Mirrored into carrySessionsByCcy (sandbox/Neon) for reload survival.
   */
  type ProfileSession = {
    draft: PreparedHedgeProfile | null;
    dirty: boolean;
    appliedShape: {
      legCount: number;
      centerOfMass: number;
      kurtosis: number;
    } | null;
    appliedShapeScore: StripShapeScore | null;
    shapePreview: {
      legCount: number;
      centerOfMass: number;
      kurtosis: number;
    } | null;
    pathScheduleEnds: number[] | null;
    pathHedgeWeights: number[] | null;
    pathStripLegCount: number | null;
    pathStructure: ForecastHedgeStructure;
    pathBasis: HedgePathBasisId;
    selectedSettleMonths: number | null;
    shapeStartManual: boolean;
  };
  const profileSessionByCcyRef = useRef<Record<string, ProfileSession>>({});
  const persistSessionHydratedRef = useRef(false);
  const carrySessionsRef = useRef(carrySessionsByCcy);
  carrySessionsRef.current = carrySessionsByCcy;

  const toPersistedSession = (s: ProfileSession): CarryProfileSessionV1 => ({
    v: 1,
    draft: s.draft,
    dirty: s.dirty,
    appliedShape: s.appliedShape,
    shapePreview: s.shapePreview,
    pathScheduleEnds: s.pathScheduleEnds,
    pathHedgeWeights: s.pathHedgeWeights,
    pathStripLegCount: s.pathStripLegCount,
    pathStructure: s.pathStructure,
    pathBasis: s.pathBasis,
    selectedSettleMonths: s.selectedSettleMonths,
    shapeStartManual: s.shapeStartManual,
  });

  const fromPersistedSession = (s: CarryProfileSessionV1): ProfileSession => ({
    draft: s.draft,
    dirty: s.dirty,
    appliedShape: s.appliedShape,
    appliedShapeScore: null,
    shapePreview: s.shapePreview,
    pathScheduleEnds: s.pathScheduleEnds,
    pathHedgeWeights: s.pathHedgeWeights,
    pathStripLegCount: s.pathStripLegCount,
    pathStructure: s.pathStructure,
    pathBasis: s.pathBasis,
    selectedSettleMonths: s.selectedSettleMonths,
    shapeStartManual: s.shapeStartManual,
  });

  // Hydrate in-memory sessions once from persisted sandbox book (reload).
  useEffect(() => {
    if (persistSessionHydratedRef.current) return;
    const keys = Object.keys(carrySessionsByCcy);
    if (keys.length === 0) return;
    persistSessionHydratedRef.current = true;
    const next = { ...profileSessionByCcyRef.current };
    for (const ccy of keys) {
      const snap = carrySessionsByCcy[ccy];
      if (!snap || snap.v !== 1) continue;
      if (next[ccy]) continue;
      next[ccy] = fromPersistedSession(snap);
    }
    profileSessionByCcyRef.current = next;
  }, [carrySessionsByCcy]);

  const persistSessionSig = (s: CarryProfileSessionV1): string => {
    const draft = s.draft;
    const draftSig = draft
      ? [
          draft.structure,
          draft.basis,
          Math.round(draft.coverLocalM * 1e6) / 1e6,
          Math.round((draft.hedgeRatio ?? 0) * 1e4) / 1e4,
          draft.legs
            ?.map(
              l =>
                `${l.index}:${Math.round((l.settleMonths ?? l.endMonth) * 100) / 100}:${Math.round(l.hedgeLocalM * 1e6) / 1e6}`,
            )
            .join('|') ?? '',
        ].join('/')
      : '';
    return [
      draftSig,
      s.dirty ? '1' : '0',
      s.pathStructure,
      s.pathBasis,
      s.pathStripLegCount ?? '',
      (s.pathScheduleEnds ?? []).map(m => m.toFixed(4)).join(','),
      (s.pathHedgeWeights ?? []).map(w => w.toFixed(6)).join(','),
      s.selectedSettleMonths ?? '',
      s.appliedShape
        ? `${s.appliedShape.legCount}:${s.appliedShape.centerOfMass.toFixed(4)}:${s.appliedShape.kurtosis.toFixed(4)}`
        : '',
      s.shapePreview
        ? `${s.shapePreview.legCount}:${s.shapePreview.centerOfMass.toFixed(4)}:${s.shapePreview.kurtosis.toFixed(4)}`
        : '',
      s.shapeStartManual ? '1' : '0',
    ].join('\0');
  };
  const lastPersistedSessionSigByCcyRef = useRef<Record<string, string>>({});

  const persistProfileSession = (
    ccy: string,
    session: ProfileSession,
    opts?: { force?: boolean },
  ) => {
    profileSessionByCcyRef.current[ccy] = session;
    if (!onCarrySessionsByCcyChange) return;
    const snap = toPersistedSession(session);
    const sig = persistSessionSig(snap);
    if (
      !opts?.force &&
      lastPersistedSessionSigByCcyRef.current[ccy] === sig
    ) {
      return;
    }
    lastPersistedSessionSigByCcyRef.current[ccy] = sig;
    const next = {
      ...carrySessionsRef.current,
      [ccy]: snap,
    };
    carrySessionsRef.current = next;
    onCarrySessionsByCcyChange(next);
  };

  /** Update in-memory modal session without writing Neon / parent hedges. */
  const rememberProfileSession = (ccy: string, session: ProfileSession) => {
    profileSessionByCcyRef.current[ccy] = session;
  };

  const multiCcyRows = useMemo(() => {
    return chartCcys
      .map(ccy => {
        const cmp = buildCashForecastCarryComparison({
          ccy,
          bookRows,
          forecastProfile,
          forecastMonths: setup.forecastMonths,
          marketRates: marketRatesFor(ccy),
          bookedHedges,
          preparedByCcy,
          setup,
        });
        if (!cmp) return null;
        const prep = preparedByCcy[ccy];
        const rates = marketRatesFor(ccy);
        const resolved = resolvedHedgedTotalCarryUsdM({
          comparison: cmp,
          prepared: prep,
          marketRates: rates,
        });
        return {
          ccy,
          openingCashM: cmp.hedged.openingCashM,
          endCashM: cmp.hedged.totals.endCashM,
          endUsdCashM: cmp.hedged.totals.endUsdCashM,
          residualEurInterestUsdM:
            cmp.categories.residualEurInterestUsdM,
          fwdCarryUsdM: resolved.fwdCarryUsdM,
          usdInterestUsdM: cmp.categories.usdInterestUsdM,
          totalCarryUsdM: resolved.totalCarryUsdM,
          doNothingUsdM: cmp.categories.unhedgedIncomeUsdM,
          benefitUsdM: resolved.benefitUsdM,
          hasHedge: cmp.hasHedge,
          hedgeCashOutM: cmp.hedged.totals.hedgeCashOutM,
          cmp,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r != null);
  }, [
    chartCcys,
    bookRows,
    forecastProfile,
    setup,
    marketRates,
    bookedHedges,
    preparedByCcy,
  ]);

  const multiCcyTotals = useMemo(() => {
    return multiCcyRows.reduce(
      (a, r) => ({
        residualEurInterestUsdM:
          a.residualEurInterestUsdM + r.residualEurInterestUsdM,
        fwdCarryUsdM: a.fwdCarryUsdM + r.fwdCarryUsdM,
        usdInterestUsdM: a.usdInterestUsdM + r.usdInterestUsdM,
        totalCarryUsdM: a.totalCarryUsdM + r.totalCarryUsdM,
        doNothingUsdM: a.doNothingUsdM + r.doNothingUsdM,
        benefitUsdM: a.benefitUsdM + r.benefitUsdM,
      }),
      {
        residualEurInterestUsdM: 0,
        fwdCarryUsdM: 0,
        usdInterestUsdM: 0,
        totalCarryUsdM: 0,
        doNothingUsdM: 0,
        benefitUsdM: 0,
      },
    );
  }, [multiCcyRows]);

  useEffect(() => {
    onAllCcyTotalCarryUsdMChange?.(multiCcyTotals.totalCarryUsdM);
  }, [multiCcyTotals.totalCarryUsdM, onAllCcyTotalCarryUsdMChange]);

  const selectCcyRow = (ccy: string) => {
    setChartCcy(ccy);
    setSelectedTradeKey(null);
  };

  const selectTradeForPath = (tradeKey: HedgeTradeSelectionKey) => {
    const ccy = tradeKey.split(':')[0];
    if (ccy) setChartCcy(ccy);
    setSelectedTradeKey(prev => (prev === tradeKey ? null : tradeKey));
  };

  /** Equal-var bullet seed so WAM / shape work with zero shared prepared. */
  const buildEqualVarBulletDraft = (
    ccy: string,
  ): PreparedHedgeProfile | null => {
    const riskRow = risk.find(r => r.bar.ccy === ccy);
    const bookRow = bookRows?.find(r => r.ccy === ccy);
    if (!riskRow && !bookRow) return null;
    const stockNetM =
      riskRow?.bar.stockNetM ??
      (typeof bookRow?.cash === 'number' ? bookRow.cash : 0);
    const tfLocal =
      setup.forecastMonths > 0
        ? setup.forecastMonths
        : horizonMonths(setup.horizon);
    const flows = bookRow
      ? monthlyFlowSeriesLocalM(
          bookRow,
          Math.max(1, tfLocal),
          forecastProfile ?? DEFAULT_FORECAST_PROFILE,
        )
      : undefined;
    const flowM =
      setup.forecastMonths > 0
        ? (riskRow?.bar.flowM ??
          (flows && flows.length > 0
            ? flows.reduce((a, b) => a + b, 0) / flows.length
            : 0))
        : 0;
    const amountLocalM = equalVarLinearHedgeNotionalLocalM(
      stockNetM,
      flowM,
      ccy,
      varSetupForPathHedgeRegime(setup, 'bullet'),
      undefined,
      flows,
    ).amountLocalM;
    if (Math.abs(amountLocalM) < 1e-12) return null;
    const settle = Math.max(0.25, tfLocal || 1);
    const ticketBasis =
      setup.exposureBasis === 'stock' ? 'simpleAvg' : setup.exposureBasis;
    return assignImpliedCarryFromSwapPoints(
      {
        structure: 'bullet',
        basis: 'totalExpected',
        ticketBasis,
        legs: [],
        coverLocalM: amountLocalM,
        hedgeRatio: 1,
        settleMonths: settle,
      },
      { marketRates, bulletSettleMonths: settle },
    );
  };

  const profileDraftSig = (p: PreparedHedgeProfile | null): string => {
    if (!p) return '';
    return [
      p.structure,
      p.basis,
      Math.round(p.coverLocalM * 1e6) / 1e6,
      Math.round((p.hedgeRatio ?? 0) * 1e4) / 1e4,
      p.settleMonths ?? '',
      p.settleSkew ?? '',
      p.cashDeliveryAt ?? '',
      p.legs
        .map(
          l =>
            `${l.index}:${Math.round((l.settleMonths ?? l.endMonth) * 100) / 100}:${Math.round(l.hedgeLocalM * 1e6) / 1e6}`,
        )
        .join('|'),
    ].join('/');
  };

  const commitProfileDraft = (
    next: PreparedHedgeProfile | null,
    opts?: { markDirty?: boolean },
  ) => {
    const markDirty = opts?.markDirty !== false;
    setProfileDraft(prev => {
      if (profileDraftSig(prev) === profileDraftSig(next)) {
        if (!markDirty) setProfileDraftDirty(false);
        return prev;
      }
      setProfileDraftDirty(markDirty);
      return next;
    });
  };

  /** Path schedule + weights from a prepared / draft strip (never equal-period wipe). */
  const hydratePathFromProfile = (profile: PreparedHedgeProfile | null) => {
    if (profile?.basis) setPathBasis(profile.basis);
    if (profile?.structure === 'strip' && profile.legs.length >= 1) {
      const ends = profile.legs.map(l =>
        Math.max(0.05, l.settleMonths ?? l.endMonth),
      );
      const amounts = profile.legs.map((l, i) => {
        if (
          typeof l.tradeNotionalLocalM === 'number' &&
          Number.isFinite(l.tradeNotionalLocalM)
        ) {
          return l.tradeNotionalLocalM;
        }
        const prev = i > 0 ? profile.legs[i - 1]!.hedgeLocalM : 0;
        return l.hedgeLocalM - prev;
      });
      setPathStructure('strip');
      setPathStripLegCount(Math.max(2, ends.length));
      setPathScheduleEnds(ends);
      setPathHedgeWeights(
        ends.length >= 2 ? notionalWeightsFromAmounts(amounts) : null,
      );
      return;
    }
    setPathStructure(profile?.structure === 'strip' ? 'strip' : 'bullet');
    setPathStripLegCount(null);
    setPathScheduleEnds(null);
    setPathHedgeWeights(null);
  };

  /**
   * Starting point for shape search + hedge path (legs / CoM / kurt).
   * Keeps upper steppers and path Strip legs in sync without a fighting
   * live-mirror effect.
   */
  const applyShapeStartingPoint = (
    next: {
      legCount: number;
      centerOfMass: number;
      kurtosis: number;
    },
    opts?: {
      fromUser?: boolean;
      keepSchedule?: boolean;
    },
  ) => {
    if (opts?.fromUser) shapeStartManualRef.current = true;
    setShapePreview(next);
    // Equal spacing while tuning start — Apply shape pushes custom settles.
    // keepSchedule: path chart echoed leg count after Apply (must not wipe).
    if (!opts?.keepSchedule) {
      setPathScheduleEnds(null);
      setPathHedgeWeights(null);
    }
    if (next.legCount <= 1) {
      setPathStructure('bullet');
      setPathStripLegCount(null);
      return;
    }
    setPathStructure('strip');
    setPathStripLegCount(next.legCount);
  };

  const openCcyProfile = (ccy: string) => {
    setChartCcy(ccy);
    setProfileCcy(ccy);
    setPathSummaryMetrics(null);
    setPathPerfPanelHost(null);
    setPathSchedulePanelHost(null);
    lastShapeWamRef.current = null;

    // Prefer in-memory, then persisted sandbox session (survives reload).
    const session =
      profileSessionByCcyRef.current[ccy] ??
      (carrySessionsByCcy[ccy]?.v === 1
        ? fromPersistedSession(carrySessionsByCcy[ccy]!)
        : null);
    if (session) {
      profileSessionByCcyRef.current[ccy] = session;
      setProfileDraft(session.draft);
      setProfileDraftDirty(session.dirty);
      setAppliedShape(session.appliedShape);
      setAppliedShapeScore(session.appliedShapeScore);
      setShapePreview(session.shapePreview);
      shapeStartManualRef.current = session.shapeStartManual;
      setPathStructure(session.pathStructure);
      setPathBasis(session.pathBasis);
      setPathStripLegCount(session.pathStripLegCount);
      setPathScheduleEnds(session.pathScheduleEnds);
      setPathHedgeWeights(session.pathHedgeWeights);
      setSelectedSettleMonths(session.selectedSettleMonths);
      setWamChartView('enhancement');
      return;
    }

    setSelectedSettleMonths(null);
    setShapePreview(null);
    shapeStartManualRef.current = false;
    setAppliedShape(null);
    setAppliedShapeScore(null);
    setWamChartView('enhancement');
    const prep = preparedByCcy[ccy];
    const draft = prep ?? buildEqualVarBulletDraft(ccy);
    setProfileDraft(draft);
    // Seeded equal-var is unstaged; platform prepared starts clean.
    setProfileDraftDirty(!prep && draft != null);
    hydratePathFromProfile(draft);
    // Staged strip → treat as applied lock so optimizer does not overwrite.
    if (draft?.structure === 'strip' && draft.legs.length >= 2) {
      const locked = {
        legCount: draft.legs.length,
        centerOfMass:
          draft.settleSkew === 'front'
            ? 0.25
            : draft.settleSkew === 'back'
              ? 0.75
              : 0.5,
        kurtosis: 0,
      };
      shapeStartManualRef.current = true;
      setShapePreview(locked);
      setAppliedShape(locked);
      // Restore Settle WAM selection from the staged strip's WAM so Optimal
      // strip / enhancement context is not blank after reload.
      const amounts = draft.legs.map((l, i) => {
        if (
          typeof l.tradeNotionalLocalM === 'number' &&
          Number.isFinite(l.tradeNotionalLocalM)
        ) {
          return Math.abs(l.tradeNotionalLocalM);
        }
        const prev = i > 0 ? draft.legs[i - 1]!.hedgeLocalM : 0;
        return Math.abs(l.hedgeLocalM - prev);
      });
      const sum = amounts.reduce((a, b) => a + b, 0);
      if (sum > 1e-12) {
        const wam = draft.legs.reduce((acc, l, i) => {
          const settle = l.settleMonths ?? l.endMonth;
          return acc + (amounts[i]! / sum) * settle;
        }, 0);
        if (wam > 1e-9) setSelectedSettleMonths(Math.round(wam));
      }
    } else if (
      draft?.structure === 'bullet' &&
      typeof draft.settleMonths === 'number' &&
      draft.settleMonths > 1e-9
    ) {
      setSelectedSettleMonths(Math.round(draft.settleMonths));
    }
  };

  const closeCcyProfile = () => {
    if (profileCcy) {
      persistProfileSession(profileCcy, {
        draft: profileDraft,
        dirty: profileDraftDirty,
        appliedShape,
        appliedShapeScore,
        shapePreview,
        pathScheduleEnds,
        pathHedgeWeights,
        pathStripLegCount,
        pathStructure,
        pathBasis,
        selectedSettleMonths,
        shapeStartManual: shapeStartManualRef.current,
      });
    }
    setProfileCcy(null);
    setPathSummaryMetrics(null);
    setPathPerfPanelHost(null);
    setPathSchedulePanelHost(null);
  };

  const lastStagedPkgSigRef = useRef('');
  const stageProfileDraft = (draft?: PreparedHedgeProfile | null) => {
    const pkg = draft ?? profileDraft;
    if (!onPreparedByCcyChange || !pkg || !chartCcy) return;
    const sig = [
      chartCcy,
      pkg.structure,
      pkg.basis,
      pkg.coverLocalM.toFixed(6),
      (pkg.hedgeRatio ?? 0).toFixed(6),
      pkg.legs
        .map(
          l =>
            `${(l.settleMonths ?? l.endMonth).toFixed(4)}:${(l.tradeNotionalLocalM ?? 0).toFixed(6)}:${l.hedgeLocalM.toFixed(6)}`,
        )
        .join('|'),
    ].join('/');
    // Auto-stage can rebuild an identical package each paint — skip parent
    // setState or Cash Carry ↔ path chart fight to Maximum update depth.
    if (sig === lastStagedPkgSigRef.current) {
      setProfileDraftDirty(false);
      return;
    }
    lastStagedPkgSigRef.current = sig;
    onPreparedByCcyChange(
      setPreparedHedgeForCcy(preparedByCcy, chartCcy, {
        ...pkg,
        preparedFor: 'carry',
      }),
    );
    setProfileDraftDirty(false);
    // Persist session + prepared package so reload restores Prebook state.
    const prev = profileSessionByCcyRef.current[chartCcy];
    persistProfileSession(chartCcy, {
      draft: pkg,
      dirty: false,
      appliedShape: appliedShape ?? prev?.appliedShape ?? null,
      appliedShapeScore: appliedShapeScore ?? prev?.appliedShapeScore ?? null,
      shapePreview: shapePreview ?? prev?.shapePreview ?? null,
      pathScheduleEnds: pathScheduleEnds ?? prev?.pathScheduleEnds ?? null,
      pathHedgeWeights: pathHedgeWeights ?? prev?.pathHedgeWeights ?? null,
      pathStripLegCount: pathStripLegCount ?? prev?.pathStripLegCount ?? null,
      pathStructure:
        pkg.structure === 'strip' ? 'strip' : pathStructure,
      pathBasis: pkg.basis ?? pathBasis,
      selectedSettleMonths:
        selectedSettleMonths ?? prev?.selectedSettleMonths ?? null,
      shapeStartManual: shapeStartManualRef.current,
    });
  };

  const profileOpen = profileCcy != null && profileCcy === chartCcy;

  /**
   * Modal sandbox overlays: draft replaces prepared for the open CCY and
   * booked tickets for that CCY are excluded so draft is the sole model
   * (no prepared+booked double-count while exploring).
   * Platform all-ccy table keeps using preparedByCcy / bookedHedges as-is.
   */
  const modalPreparedByCcy = useMemo(() => {
    if (!profileOpen || !profileDraft || !profileCcy) return preparedByCcy;
    return { ...preparedByCcy, [profileCcy]: profileDraft };
  }, [profileOpen, profileDraft, profileCcy, preparedByCcy]);

  const modalBookedHedges = useMemo(() => {
    if (!profileOpen || !profileDraft || !profileCcy) return bookedHedges;
    return bookedHedges.filter(t => t.ccy !== profileCcy);
  }, [profileOpen, profileDraft, profileCcy, bookedHedges]);

  const carryPreparedByCcy = useMemo(
    () =>
      preparedByCcyForTradeSelection(modalPreparedByCcy, selectedTradeKey),
    [modalPreparedByCcy, selectedTradeKey],
  );

  const carryBookedHedges = useMemo(
    () => bookedHedgesForTradeSelection(modalBookedHedges, selectedTradeKey),
    [modalBookedHedges, selectedTradeKey],
  );

  const cashForecast = useMemo(
    () =>
      buildCashForecastSchedule({
        ccy: chartCcy,
        bookRows,
        forecastProfile,
        forecastMonths: setup.forecastMonths,
        marketRates,
        bookedHedges: carryBookedHedges,
        preparedByCcy: carryPreparedByCcy,
        setup,
      }),
    [
      chartCcy,
      bookRows,
      forecastProfile,
      setup,
      marketRates,
      carryBookedHedges,
      carryPreparedByCcy,
    ],
  );

  const carryComparison = useMemo(
    () =>
      buildCashForecastCarryComparison({
        ccy: chartCcy,
        bookRows,
        forecastProfile,
        forecastMonths: setup.forecastMonths,
        marketRates,
        bookedHedges: carryBookedHedges,
        preparedByCcy: carryPreparedByCcy,
        setup,
      }),
    [
      chartCcy,
      bookRows,
      forecastProfile,
      setup,
      marketRates,
      carryBookedHedges,
      carryPreparedByCcy,
    ],
  );

  /**
   * Month schedule carry columns = accrued through that month (running sum),
   * matching Carry evolution cumulative split / legend — not MoM period slices.
   */
  const monthScheduleAccrued = useMemo(() => {
    if (!cashForecast) return [];
    let residual = 0;
    let fwd = 0;
    let usd = 0;
    let income = 0;
    let enhancement = 0;
    return cashForecast.months.map(m => {
      const unhedged =
        carryComparison?.unhedged.months.find(
          u => u.monthIndex === m.monthIndex,
        )?.incomeUsdM ?? 0;
      residual += m.residualEurInterestUsdM;
      fwd += m.fwdCarryUsdM;
      usd += m.usdInterestUsdM;
      income += m.incomeUsdM;
      enhancement += m.incomeUsdM - unhedged;
      return {
        month: m,
        residualEurInterestUsdM: residual,
        fwdCarryUsdM: fwd,
        usdInterestUsdM: usd,
        incomeUsdM: income,
        enhancementUsdM: enhancement,
      };
    });
  }, [cashForecast, carryComparison]);

  const analytics: CashCarryAnalytics = useMemo(
    () =>
      buildCashCarryAnalytics({
        risk,
        setup,
        bookedHedges,
        preparedByCcy,
        marketRates,
        bookRows,
        forecastProfile,
      }),
    [
      risk,
      setup,
      bookedHedges,
      preparedByCcy,
      marketRates,
      bookRows,
      forecastProfile,
    ],
  );

  // Prefer modal draft overlay so Carry evolution flips to M3/M5/M7 the
  // same paint as Apply (not one tick behind platform preparedByCcy).
  const structureBars = useMemo(
    () =>
      buildCarryEvolutionBars({
        ccy: chartCcy,
        risk,
        setup,
        bookedHedges: carryBookedHedges,
        preparedByCcy: carryPreparedByCcy,
        marketRates,
        bookRows,
        forecastProfile,
      }),
    [
      chartCcy,
      risk,
      setup,
      carryBookedHedges,
      carryPreparedByCcy,
      marketRates,
      bookRows,
      forecastProfile,
    ],
  );

  const legBars = useMemo(
    () =>
      buildCarryEvolutionLegBars({
        ccy: chartCcy,
        risk,
        setup,
        bookedHedges: carryBookedHedges,
        preparedByCcy: carryPreparedByCcy,
        marketRates,
      }),
    [
      chartCcy,
      risk,
      setup,
      carryBookedHedges,
      carryPreparedByCcy,
      marketRates,
    ],
  );

  const settleScenarios = useMemo(() => {
    /**
     * Always the static bullet Enhancement curve (M1…M12) for WAM selection,
     * chart dots, and ladder "best" row. Strip execution view only changes
     * chart leg stacks — it must not swap in buildShapedSettleWamScenarios
     * (that replaced ~$297–302K bullet peaks with lower shaped-strip scores).
     */
    return buildSettleWamScenarios({
      ccy: chartCcy,
      risk,
      setup,
      bookedHedges: modalBookedHedges,
      preparedByCcy: modalPreparedByCcy,
      marketRates,
      bookRows,
      forecastProfile,
      maxSettleMonths: 12,
      ladderMode: 'bullet',
    });
  }, [
    chartCcy,
    risk,
    setup,
    modalBookedHedges,
    modalPreparedByCcy,
    marketRates,
    bookRows,
    forecastProfile,
  ]);

  useEffect(() => {
    setSelectedSettleMonths(prev => {
      if (
        prev != null &&
        settleScenarios.some(
          s => Math.round(s.settleMonths) === Math.round(prev),
        )
      ) {
        return prev;
      }
      const book = settleScenarios.find(s => s.isCurrentWam);
      return book?.settleMonths ?? settleScenarios[0]?.settleMonths ?? null;
    });
  }, [settleScenarios]);

  const Tf = analytics.horizonMonths;
  const hasStrategyHedge = settleScenarios.some(
    s => Math.abs(s.hedgeDeltaLocalM) > 1e-12,
  );
  const currentWamRow = settleScenarios.find(s => s.isCurrentWam);
  const selectedWamRow =
    selectedSettleMonths != null
      ? (settleScenarios.find(
          s =>
            Math.round(s.settleMonths) === Math.round(selectedSettleMonths),
        ) ?? null)
      : null;

  /** Ladder table: highest Enhancement first (same objective as shape search). */
  const settleScenariosForTable = useMemo(
    () =>
      [...settleScenarios].sort((a, b) => {
        if (a.beyondForecast !== b.beyondForecast) {
          return a.beyondForecast ? 1 : -1;
        }
        const aHas = Math.abs(a.hedgeDeltaLocalM) > 1e-12;
        const bHas = Math.abs(b.hedgeDeltaLocalM) > 1e-12;
        if (aHas !== bHas) return aHas ? -1 : 1;
        const d = b.enhancementUsdM - a.enhancementUsdM;
        if (Math.abs(d) > 1e-9) return d;
        return a.settleMonths - b.settleMonths;
      }),
    [settleScenarios],
  );

  const selectSettleWamScenario = (scenario: SettleWamScenario) => {
    if (Math.abs(scenario.hedgeDeltaLocalM) < 1e-12) return;
    const next = scenario.settleMonths;
    if (
      selectedSettleMonths != null &&
      Math.round(selectedSettleMonths) === Math.round(next)
    ) {
      return;
    }
    setSelectedSettleMonths(next);
    // Re-pin WAM on the bullet curve — drop stale Apply score so header /
    // ladder reflect the new target; shape knobs stay until desk re-applies.
    if (appliedShapeScore != null) {
      setAppliedShapeScore(null);
    }
  };

  /** Enhancement curve + ladder rows are interactive; execution view is read-only. */
  const wamSelectionEnabled = wamChartView === 'enhancement';

  const shapeTargetWamMonths = selectedWamRow
    ? selectedWamRow.settleScheduleLabel.includes('start')
      ? 0
      : selectedWamRow.settleMonths
    : null;

  const stripShapeOpt = useMemo(() => {
    if (shapeTargetWamMonths == null || !hasStrategyHedge) return null;
    return optimizeStripShapeAroundWam({
      ccy: chartCcy,
      risk,
      setup,
      bookedHedges: modalBookedHedges,
      preparedByCcy: modalPreparedByCcy,
      marketRates,
      bookRows,
      forecastProfile,
      targetWamMonths: shapeTargetWamMonths,
      hedgeDeltaLocalM: selectedWamRow?.hedgeDeltaLocalM,
      maxLegCount: Math.min(8, Math.max(2, Tf)),
      topN: 6,
    });
  }, [
    shapeTargetWamMonths,
    hasStrategyHedge,
    chartCcy,
    risk,
    setup,
    modalBookedHedges,
    modalPreparedByCcy,
    marketRates,
    bookRows,
    forecastProfile,
    selectedWamRow?.hedgeDeltaLocalM,
    Tf,
  ]);

  useEffect(() => {
    /** Keep starting knobs when desk is fine-tuning; only clear on real WAM change. */
    if (appliedShape) return;
    if (shapeStartManualRef.current) return;
    if (shapeTargetWamMonths == null) return;
    const prev = lastShapeWamRef.current;
    const same =
      prev != null && Math.round(prev) === Math.round(shapeTargetWamMonths);
    lastShapeWamRef.current = shapeTargetWamMonths;
    if (prev != null && !same) setShapePreview(null);
  }, [shapeTargetWamMonths, appliedShape]);

  useEffect(() => {
    if (!stripShapeOpt) return;
    if (shapeStartManualRef.current) return;
    if (shapePreview) return;
    if (appliedShape) {
      applyShapeStartingPoint({ ...appliedShape });
      return;
    }
    const b = stripShapeOpt.best;
    applyShapeStartingPoint({
      legCount: b.legCount,
      centerOfMass: b.centerOfMass,
      kurtosis: b.kurtosis,
    });
  }, [stripShapeOpt, appliedShape, shapePreview]);

  const shapePreviewScore = useMemo((): StripShapeScore | null => {
    if (shapeTargetWamMonths == null || !shapePreview) return null;
    const baseDelta = selectedWamRow?.hedgeDeltaLocalM ?? 0;
    // Cover-of-target / Hedge % from the path chart (profileDraft.hedgeRatio)
    // must scale the scored Δ — otherwise slider edits look like a no-op.
    const coverScale =
      typeof profileDraft?.hedgeRatio === 'number' &&
      profileDraft.hedgeRatio > 1e-9 &&
      profileDraft.hedgeRatio <= 1 + 1e-9
        ? Math.min(1, Math.max(0, profileDraft.hedgeRatio))
        : 1;
    const hedgeDeltaLocalM = baseDelta * coverScale;
    return scoreStripShapeAroundWam({
      ccy: chartCcy,
      risk,
      setup,
      bookedHedges: modalBookedHedges,
      preparedByCcy: modalPreparedByCcy,
      marketRates,
      bookRows,
      forecastProfile,
      targetWamMonths: shapeTargetWamMonths,
      hedgeDeltaLocalM,
      legCount: shapePreview.legCount,
      centerOfMass: shapePreview.centerOfMass,
      kurtosis: shapePreview.kurtosis,
      // Live "Strip schedule · tick trades" edits (settle date + Hedge % per
      // leg) override the CoM/kurtosis-derived shape so Total carry /
      // Enhancement always scores the ladder actually shown below.
      customSettleMonths: pathScheduleEnds,
      customWeights: pathHedgeWeights,
    });
  }, [
    shapeTargetWamMonths,
    shapePreview,
    chartCcy,
    risk,
    setup,
    modalBookedHedges,
    modalPreparedByCcy,
    marketRates,
    bookRows,
    forecastProfile,
    selectedWamRow?.hedgeDeltaLocalM,
    profileDraft?.hedgeRatio,
    pathScheduleEnds,
    pathHedgeWeights,
  ]);

  /** Per-leg carry for preview / applied shape (amounts + timing detail). */
  const previewLegBars = useMemo((): CarryEvolutionBar[] => {
    if (!shapePreviewScore?.legs.length) return [];
    return buildCarryEvolutionLegBarsFromSamples({
      ccy: chartCcy,
      setup,
      marketRates,
      legs: shapePreviewScore.legs.map(l => ({
        settleMonths: l.settleMonths,
        amountLocalM: l.amountLocalM,
        structure:
          shapePreviewScore.structure === 'bullet' ? 'bullet' : 'strip',
        label: `${l.label} · M${Math.round(l.settleMonths)}`,
      })),
    });
  }, [shapePreviewScore, chartCcy, setup, marketRates]);

  /** Per-leg carry stacks for Strip execution (applied, else live shape preview). */
  const shapedLegBars =
    appliedShape || (shapePreviewScore && shapePreviewScore.legs.length > 0)
      ? previewLegBars
      : [];

  /** Modal draft when open; else platform prepared (main-page chips). */
  const prepared = profileOpen
    ? (profileDraft ?? preparedByCcy[chartCcy])
    : preparedByCcy[chartCcy];
  /** Strip knobs: any Tf ≥ 2 (not gated on VaR tenor < Tf). */
  const stripAvailable = Tf >= 2;
  const instrumentLegCount =
    prepared?.structure === 'strip' && prepared.legs.length >= 2
      ? prepared.legs.length
      : defaultStripLegCount(setup);
  const instrumentSettleSkew: SettleSkewId =
    prepared?.settleSkew === 'front' || prepared?.settleSkew === 'back'
      ? prepared.settleSkew
      : 'neutral';

  /** Build modal draft directly from optimizer legs (settles + Δ weights). */
  const draftFromShapeScore = (
    score: StripShapeScore,
    basis: HedgePathBasisId = pathBasis,
  ): PreparedHedgeProfile => {
    const ticketBasis =
      basis === 'cash'
        ? 'stock'
        : basis === 'totalExpected'
          ? 'totalBuildup'
          : setup.exposureBasis === 'stock'
            ? 'simpleAvg'
            : setup.exposureBasis;
    const defaultTf = setup.forecastMonths || horizonMonths(setup.horizon);
    const coverPct =
      typeof profileDraft?.hedgeRatio === 'number' &&
      profileDraft.hedgeRatio > 1e-9
        ? Math.min(1, Math.max(0, profileDraft.hedgeRatio))
        : 1;
    // score.hedgeDeltaLocalM / leg amounts already include coverScale when
    // scored from the live draft — do not multiply twice.
    const coverLocalM = score.hedgeDeltaLocalM;

    if (score.structure === 'bullet' || score.legCount <= 1) {
      const settle = Math.max(
        0,
        score.settleMonths[0] ?? score.wamMonths ?? defaultTf,
      );
      return assignImpliedCarryFromSwapPoints(
        {
          structure: 'bullet',
          basis,
          ticketBasis,
          legs: [],
          coverLocalM,
          hedgeRatio: coverPct,
          settleMonths: settle,
        },
        { marketRates, bulletSettleMonths: Math.max(0.25, settle || defaultTf) },
      );
    }

    let cumul = 0;
    const legs = score.legs.map((leg, i) => {
      const settle = Math.max(
        0.05,
        Math.min(Tf > 0 ? Tf : leg.settleMonths, leg.settleMonths),
      );
      cumul += leg.amountLocalM;
      return {
        index: i,
        startMonth: 0,
        endMonth: settle,
        settleMonths: settle,
        hedgeLocalM: cumul,
        tradeNotionalLocalM: leg.amountLocalM,
        label: leg.label,
      };
    });
    return assignImpliedCarryFromSwapPoints(
      {
        structure: 'strip',
        basis,
        ticketBasis,
        legs,
        coverLocalM,
        hedgeRatio: coverPct,
        cashDeliveryAt: 'periodEnd',
        settleSkew: settleSkewFromCenterOfMass(score.centerOfMass),
      },
      { marketRates, bulletSettleMonths: defaultTf },
    );
  };

  /** Lock shape → draft + path schedule, and stage to prepared book (Neon). */
  const applyStripShapeAroundWam = (score: StripShapeScore) => {
    if (Math.abs(score.hedgeDeltaLocalM) < 1e-12) return;
    const locked = {
      legCount: score.legCount,
      centerOfMass: score.centerOfMass,
      kurtosis: score.kurtosis,
    };
    shapeStartManualRef.current = true;
    setShapePreview(locked);
    setAppliedShape(locked);
    setAppliedShapeScore(score);

    const pinned = draftFromShapeScore(score, pathBasis);
    commitProfileDraft(pinned, { markDirty: true });

    const stagePinned = (session: ProfileSession) => {
      if (!chartCcy) return;
      persistProfileSession(chartCcy, session);
      // Apply shape must hit preparedByCcy / DB — otherwise reload loses the
      // whole Prebook process (session used to live only in a React ref).
      if (onPreparedByCcyChange) {
        lastStagedPkgSigRef.current = '';
        onPreparedByCcyChange(
          setPreparedHedgeForCcy(preparedByCcy, chartCcy, {
            ...pinned,
            preparedFor: 'carry',
          }),
        );
        setProfileDraftDirty(false);
      }
    };

    if (score.structure === 'bullet' || score.legCount <= 1) {
      setPathStructure('bullet');
      setPathStripLegCount(null);
      setPathScheduleEnds(null);
      setPathHedgeWeights(null);
      setWamChartView('enhancement');
      const appliedWam = Math.max(
        1,
        Math.round(score.wamMonths > 1e-12 ? score.wamMonths : 1),
      );
      setSelectedSettleMonths(appliedWam);
      stagePinned({
        draft: pinned,
        dirty: false,
        appliedShape: locked,
        appliedShapeScore: score,
        shapePreview: locked,
        pathScheduleEnds: null,
        pathHedgeWeights: null,
        pathStripLegCount: null,
        pathStructure: 'bullet',
        pathBasis,
        selectedSettleMonths: appliedWam,
        shapeStartManual: true,
      });
      return;
    }

    // Exact optimizer settles — do not re-pin last leg to Tf (M12 phantom).
    const ends = score.settleMonths.map(m =>
      Math.max(0.05, Math.min(Tf > 0 ? Tf : m, m)),
    );
    const weights = score.legs.map(l => l.weight);
    const hedgeWeights =
      weights.length === ends.length && ends.length >= 2 ? weights : null;
    setPathStructure('strip');
    setPathStripLegCount(Math.max(2, ends.length));
    setPathScheduleEnds(ends);
    setPathHedgeWeights(hedgeWeights);
    // Design: after Apply → shaped ladder + M3/M5/M7 overlays (not bullet).
    // Desk can still toggle back to Enhancement to re-pin WAM.
    setWamChartView('execution');
    const appliedWam = Math.max(
      1,
      Math.round(score.wamMonths > 1e-12 ? score.wamMonths : 1),
    );
    setSelectedSettleMonths(appliedWam);
    stagePinned({
      draft: pinned,
      dirty: false,
      appliedShape: locked,
      appliedShapeScore: score,
      shapePreview: locked,
      pathScheduleEnds: ends,
      pathHedgeWeights: hedgeWeights,
      pathStripLegCount: Math.max(2, ends.length),
      pathStructure: 'strip',
      pathBasis,
      selectedSettleMonths: appliedWam,
      shapeStartManual: true,
    });
  };

  // Knob / strip-leg edits only update the local preview (shapePreview /
  // shapePreviewScore below) — the desk must click Apply shape to lock it
  // into the modal draft, and Assign/Prebook to stage it to platform.

  const pathRiskBar = risk.find(r => r.bar.ccy === chartCcy)?.bar;
  const pathBookRow = bookRows?.find(r => r.ccy === chartCcy);
  const pathStockM =
    pathRiskBar?.stockNetM ??
    (typeof pathBookRow?.cash === 'number' ? pathBookRow.cash : 0);
  const pathFlows = useMemo(() => {
    if (!pathBookRow) return undefined;
    return monthlyFlowSeriesLocalM(
      pathBookRow,
      Math.max(1, Tf > 0 ? Tf : 1),
      forecastProfile ?? DEFAULT_FORECAST_PROFILE,
    );
  }, [pathBookRow, Tf, forecastProfile]);
  const pathFlowM =
    setup.forecastMonths > 0
      ? pathRiskBar?.flowM ??
        (pathFlows && pathFlows.length > 0
          ? pathFlows.reduce((a, b) => a + b, 0) / pathFlows.length
          : 0)
      : 0;
  const pathEqualVarLocalM = useMemo(() => {
    if (!chartCcy) return 0;
    return equalVarLinearHedgeNotionalLocalM(
      pathStockM,
      pathFlowM,
      chartCcy,
      varSetupForPathHedgeRegime(setup, pathStructure),
      undefined,
      pathFlows,
    ).amountLocalM;
  }, [chartCcy, pathStockM, pathFlowM, setup, pathStructure, pathFlows]);
  const pathEndExposureM = useMemo(() => {
    const { endM } = resolveChartMonthlyFlows(
      pathStockM,
      pathFlowM,
      setup,
      pathFlows,
    );
    return endM;
  }, [pathStockM, pathFlowM, setup, pathFlows]);
  const pathAppliedHedgeLocalM =
    prepared?.coverLocalM ??
    (Math.abs(pathEqualVarLocalM) > 1e-12 ? pathEqualVarLocalM : 0);

  /** Path chart → modal draft only (Stage to Analytics promotes to platform). */
  const bookPathHedgeProfile = (args: {
    structure: ForecastHedgeStructure;
    basis: HedgePathBasisId;
    edges: RollingHedgeEdge[];
    cashSettleByEdgeIndex?: Record<number, number>;
    bulletSettleMonths?: number;
    cashDeliveryAt?: 'periodEnd' | 'periodStart' | 'matchExposure';
    coverPct?: number;
  }) => {
    if (!chartCcy || !profileOpen) return;
    const {
      structure,
      basis,
      edges,
      cashSettleByEdgeIndex,
      bulletSettleMonths: chartBulletSettle,
      cashDeliveryAt,
      coverPct: coverPctArg,
    } = args;
    const coverPct = Math.min(1, Math.max(0, coverPctArg ?? 1));
    setPathBasis(basis);
    setPathStructure(structure);

    const ticketBasis =
      basis === 'cash'
        ? 'stock'
        : basis === 'totalExpected'
          ? 'totalBuildup'
          : setup.exposureBasis === 'stock'
            ? 'simpleAvg'
            : setup.exposureBasis;
    const defaultTf = setup.forecastMonths || horizonMonths(setup.horizon);

    if (structure === 'strip') {
      if (edges.length === 0) {
        commitProfileDraft(null);
        return;
      }
      // Always persist the live chart ladder (fine-tuned settles / Hedge %).
      // Re-applying frozen appliedShapeScore here wiped Edit-mode finetunes
      // so Prebook / Neon kept the optimizer snapshot instead.
      const coverLocalM = edges[edges.length - 1]?.hedgeLocalM ?? 0;
      const settleEnds = edges.map(
        e => cashSettleByEdgeIndex?.[e.index] ?? e.endMonth,
      );
      let cumul = 0;
      const legs = edges.map((e, i) => {
        const settle = cashSettleByEdgeIndex?.[e.index] ?? e.endMonth;
        const prev = i > 0 ? edges[i - 1]!.hedgeLocalM : 0;
        const delta = e.hedgeLocalM - prev;
        cumul = e.hedgeLocalM;
        return {
          index: e.index,
          startMonth: e.startMonth,
          endMonth: e.endMonth,
          settleMonths: settle,
          hedgeLocalM: cumul,
          tradeNotionalLocalM: delta,
          label: e.label.startsWith('M0–') ? `L${i + 1}` : e.label,
          stockStartM: e.stockStartM,
          endExposureM: e.endExposureM,
        };
      });
      const profile = assignImpliedCarryFromSwapPoints(
        {
          structure: 'strip',
          basis,
          ticketBasis,
          legs,
          coverLocalM,
          hedgeRatio: coverPct,
          cashDeliveryAt,
          settleSkew: inferSettleSkewFromEnds(settleEnds, defaultTf),
        },
        {
          marketRates,
          bulletSettleMonths: defaultTf,
        },
      );
      // Local draft only — do NOT echo settleEnds/weights into parent
      // path state here (setPathScheduleEnds → chart sync setCustomEndMonths
      // was an infinite update loop). Assign/Prebook stages to platform.
      // Also: do NOT persistProfileSession on every auto-stage paint — that
      // rewrote hedges → Neon PUT → re-render → Maximum update depth.
      const nextWeights =
        legs.length >= 2
          ? notionalWeightsFromAmounts(legs.map(l => l.tradeNotionalLocalM ?? 0))
          : null;
      commitProfileDraft(profile, { markDirty: true });
      const prev = profileSessionByCcyRef.current[chartCcy];
      rememberProfileSession(chartCcy, {
        draft: profile,
        dirty: true,
        appliedShape: prev?.appliedShape ?? null,
        appliedShapeScore: prev?.appliedShapeScore ?? null,
        shapePreview: prev?.shapePreview ?? null,
        pathScheduleEnds: settleEnds,
        pathHedgeWeights: nextWeights,
        pathStripLegCount: Math.max(2, legs.length),
        pathStructure: 'strip',
        pathBasis: basis,
        selectedSettleMonths: prev?.selectedSettleMonths ?? null,
        shapeStartManual: prev?.shapeStartManual ?? shapeStartManualRef.current,
      });
      return;
    }

    const { startM, endM, flows } = resolveChartMonthlyFlows(
      pathStockM,
      pathFlowM,
      setup,
      pathFlows,
    );
    const bulletEq = equalVarLinearHedgeNotionalLocalM(
      pathStockM,
      pathFlowM,
      chartCcy,
      varSetupForPathHedgeRegime(setup, 'bullet'),
      undefined,
      pathFlows ?? flows,
    ).amountLocalM;
    const target =
      hedgeBasisNotionalLocalM(basis, startM, endM, bulletEq) * coverPct;
    const settle = Math.max(
      0.25,
      Math.min(defaultTf, chartBulletSettle ?? defaultTf),
    );
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'bullet',
        basis,
        ticketBasis,
        legs: [],
        coverLocalM: target,
        hedgeRatio: coverPct,
        cashDeliveryAt,
        settleMonths: settle,
      },
      {
        marketRates,
        bulletSettleMonths: settle,
      },
    );
    commitProfileDraft(profile);
  };

  return (
    <div className="min-w-0 max-w-full space-y-4">
      {title && (
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
          )}
        </div>
      )}
      {/* Risk settings · σ source + confidence — shared VaR setup (drives FX Risk / CFaR). */}
      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          Risk settings · σ &amp; confidence
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
              Volatility σ₁ₘ
            </div>
            <div
              className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Volatility source"
            >
              {VAR_VOL_SOURCE_OPTIONS.map(opt => {
                const on = setup.volSource === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    title={opt.description}
                    disabled={!onSetupChange}
                    onClick={() => patch({ volSource: opt.id })}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      on
                        ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    } ${onSetupChange ? '' : 'cursor-default opacity-80'}`}
                  >
                    {opt.label}
                    <span className="ml-1 font-mono text-[10px] font-normal opacity-80">
                      {(opt.monthlyVol * 100).toFixed(1)}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-blue-300">
              Confidence
            </div>
            <div
              className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Confidence level"
            >
              {VAR_CONFIDENCE_OPTIONS.map(opt => {
                const on = setup.confidencePct === opt.pct;
                return (
                  <button
                    key={opt.pct}
                    type="button"
                    title={`z = ${opt.z}`}
                    disabled={!onSetupChange}
                    onClick={() => patch({ confidencePct: opt.pct })}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      on
                        ? 'bg-blue-500/20 text-blue-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    } ${onSetupChange ? '' : 'cursor-default opacity-80'}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="font-mono text-[10px] text-slate-500">
            Shared VaR setup · drives FX Risk &amp; CFaR (carry is deterministic) ·
            σ₁ₘ={(sigmaMonthly * 100).toFixed(2)}% · z={zConf.toFixed(2)}
          </p>
        </div>
      </section>
      {/* ── All currencies — module chrome (meta / Tf / gear) lives on RiskPerspectiveSelector ── */}
      <div className="space-y-3">
        {multiCcyRows.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-500">
            No cash rows on the FX book — add currencies in the Simulator table.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500">
                  <th className="py-2 pr-3 font-medium">CCY</th>
                  <th
                    className="py-2 pr-3 font-medium"
                    title="Hedged total income @ Tf (USD $K)"
                  >
                    Total
                  </th>
                  <th
                    className="py-2 pr-3 font-medium text-amber-300/90"
                    title="Unhedged / do-nothing income @ Tf"
                  >
                    Do nothing
                  </th>
                  <th
                    className="py-2 pr-3 font-medium"
                    title="Total − Do nothing (hedge benefit)"
                  >
                    Δ
                  </th>
                  <th
                    className="py-2 pr-3 font-medium"
                    title="Opening cash / Net FX stock at t=0"
                  >
                    Opening
                  </th>
                  <th
                    className="py-2 pr-3 font-medium text-white"
                    title="Hedge cash settlement flows over Tf"
                  >
                    Hedge CF
                  </th>
                  <th
                    className="py-2 pr-3 font-medium text-amber-300/90"
                    title="Residual FCY interest on cash — grows as FCY interest is earned"
                  >
                    Residual int
                  </th>
                  <th
                    className="py-2 pr-3 font-medium text-emerald-300/80"
                    title="Forward-points carry accrued @ Tf"
                  >
                    FWD accrued
                  </th>
                  <th
                    className="py-2 font-medium"
                    title="USD interest on cash after hedge settles"
                  >
                    USD int
                  </th>
                </tr>
              </thead>
              <tbody>
                {multiCcyRows.map(r => {
                  const selected = chartCcy === r.ccy;
                  const prep = preparedByCcy[r.ccy];
                  const structLabel =
                    prep?.structure === 'strip' && prep.legs.length >= 2
                      ? `Strip · ${prep.legs.length}`
                      : prep?.structure === 'bullet' || r.hasHedge
                        ? 'Bullet'
                        : null;
                  return (
                    <tr
                      key={r.ccy}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectCcyRow(r.ccy)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          selectCcyRow(r.ccy);
                        }
                      }}
                      title={`Select ${r.ccy} carry chart`}
                      className={`cursor-pointer border-b border-slate-800/80 hover:bg-violet-500/10 ${
                        selected ? 'bg-violet-500/10' : ''
                      }`}
                    >
                      <td className="py-2 pr-3 font-semibold text-violet-200">
                        <span className="inline-flex flex-col gap-0.5">
                          <span className="inline-flex items-baseline gap-1.5">
                            {r.ccy}
                            {structLabel ? (
                              <span
                                className="text-[9px] font-semibold uppercase tracking-wide text-violet-300/90"
                                title="Prepared / booked hedge structure"
                              >
                                {structLabel}
                              </span>
                            ) : null}
                          </span>
                          {r.hasHedge ? (
                            <span className="text-[9px] font-semibold uppercase tracking-wide text-emerald-400/90">
                              Hedged
                            </span>
                          ) : (
                            <span className="text-[9px] font-normal text-slate-600">
                              —
                            </span>
                          )}
                        </span>
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono font-semibold ${
                          r.totalCarryUsdM >= 0
                            ? 'text-slate-300'
                            : 'text-rose-300'
                        }`}
                      >
                        {fmtK(r.totalCarryUsdM)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-amber-300">
                        {fmtK(r.doNothingUsdM)}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono ${
                          Math.abs(r.benefitUsdM) < 1e-12
                            ? 'text-slate-500'
                            : r.benefitUsdM >= 0
                              ? 'text-emerald-200'
                              : 'text-rose-300'
                        }`}
                      >
                        {fmtK(r.benefitUsdM)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-slate-300">
                        {fmtM(r.openingCashM)}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono ${
                          Math.abs(r.hedgeCashOutM) < 1e-12
                            ? 'text-slate-600'
                            : 'text-white'
                        }`}
                      >
                        {Math.abs(r.hedgeCashOutM) < 1e-12
                          ? '—'
                          : fmtM(-r.hedgeCashOutM)}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono ${
                          r.residualEurInterestUsdM >= 0
                            ? 'text-amber-300'
                            : 'text-rose-300'
                        }`}
                      >
                        {fmtK(r.residualEurInterestUsdM)}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono ${
                          Math.abs(r.fwdCarryUsdM) < 1e-12
                            ? 'text-slate-600'
                            : 'text-emerald-300/90'
                        }`}
                      >
                        {Math.abs(r.fwdCarryUsdM) < 1e-12
                          ? '—'
                          : fmtK(r.fwdCarryUsdM)}
                      </td>
                      <td
                        className={`py-2 font-mono ${
                          Math.abs(r.usdInterestUsdM) < 1e-12
                            ? 'text-slate-600'
                            : 'text-sky-300/90'
                        }`}
                      >
                        {Math.abs(r.usdInterestUsdM) < 1e-12
                          ? '—'
                          : fmtK(r.usdInterestUsdM)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {multiCcyRows.length > 1 && (
                <tfoot>
                  <tr className="border-b border-slate-800/80 bg-slate-900/40">
                    <td className="py-2 pr-3 font-semibold text-violet-200">
                      All CCY
                    </td>
                    <td className="py-2 pr-3 font-mono font-semibold text-slate-300">
                      {fmtK(multiCcyTotals.totalCarryUsdM)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-amber-300">
                      {fmtK(multiCcyTotals.doNothingUsdM)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-emerald-200">
                      {fmtK(multiCcyTotals.benefitUsdM)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-slate-500" colSpan={2}>
                      —
                    </td>
                    <td className="py-2 pr-3 font-mono text-amber-300">
                      {fmtK(multiCcyTotals.residualEurInterestUsdM)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-emerald-300/90">
                      {fmtK(multiCcyTotals.fwdCarryUsdM)}
                    </td>
                    <td className="py-2 font-mono text-sky-300/90">
                      {fmtK(multiCcyTotals.usdInterestUsdM)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {cashForecast && multiCcyRows.length > 0 && (
        <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
          <div className="mb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="relative flex items-center gap-1.5">
                <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
                  Carry evolution · select horizon
                </div>
                {selectedTradeKey && (
                  <button
                    type="button"
                    onClick={() => setSelectedTradeKey(null)}
                    className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-500/20"
                    title="Show full hedge package in carry / cash flow"
                  >
                    {tradeSelectionLabel(selectedTradeKey, preparedByCcy)} ·
                    clear
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Path details"
                  aria-expanded={pathInfoOpen}
                  title="Path details"
                  onClick={() => setPathInfoOpen(o => !o)}
                  className={`rounded-md p-1 transition-colors ${
                    pathInfoOpen
                      ? 'bg-slate-700/80 text-slate-200'
                      : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
                  }`}
                >
                  <InfoIcon className="h-3.5 w-3.5" />
                </button>
                {pathInfoOpen && (
                  <div
                    role="dialog"
                    aria-label="Carry path details"
                    className="absolute left-0 top-full z-20 mt-1.5 w-[min(20rem,calc(100vw-3rem))] rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl shadow-black/40"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        Path details
                      </span>
                      <button
                        type="button"
                        aria-label="Close"
                        onClick={() => setPathInfoOpen(false)}
                        className="rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-slate-300"
                      >
                        Close
                      </button>
                    </div>
                    <dl className="space-y-1.5 font-mono text-[11px]">
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">CCY</dt>
                        <dd className="text-slate-200">{chartCcy}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Tf</dt>
                        <dd className="text-slate-200">
                          {setup.forecastMonths === 0
                            ? '0 (stock)'
                            : `${setup.forecastMonths}m`}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Settles</dt>
                        <dd className="text-slate-200">
                          {
                            cashForecast.months.filter(m => m.settleLegCount > 0)
                              .length
                          }
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Structure</dt>
                        <dd className="text-slate-200">
                          {prepared?.structure === 'strip'
                            ? 'strip'
                            : prepared?.structure === 'bullet'
                              ? 'bullet'
                              : multiCcyRows.find(r => r.ccy === chartCcy)
                                    ?.hasHedge
                                ? 'hedged'
                                : 'unhedged'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">View</dt>
                        <dd className="text-right text-slate-200">
                          {ccyPathView === 'carry'
                            ? pathPresentationMode === 'cumulative'
                              ? 'Carry · cumulative; click a bar for Residual / FWD / USD split'
                              : 'Carry · MoM Residual / FWD / USD int'
                            : ccyPathView === 'cashflow'
                              ? pathPresentationMode === 'cumulative'
                                ? 'Cash flow · cumulative revenue / expenses / hedge'
                                : 'Cash flow · MoM revenue / expenses / hedge'
                              : 'Table · dual cash book; carry cols accrued through month'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3 border-t border-slate-800 pt-1.5">
                        <dt className="text-slate-500">Rates</dt>
                        <dd className="max-w-[12rem] text-right text-slate-300">
                          {analytics.ratesSource}
                          <div className="mt-0.5 text-[10px] text-slate-500">
                            Cash:{' '}
                            {cashInterestMode === 'current'
                              ? 'Current (flat O/N)'
                              : 'Forward (ladder)'}
                          </div>
                        </dd>
                      </div>
                    </dl>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div
                  className="inline-flex shrink-0 rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
                  role="group"
                  aria-label="Cash interest rate mode"
                  title="Current = flat O/N; Forward = SW→1Y ladder"
                >
                  {(
                    [
                      { id: 'current' as const, label: 'Current' },
                      { id: 'forward' as const, label: 'Forward' },
                    ] as const
                  ).map(opt => {
                    const on = cashInterestMode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={!onMarketRatesByCcyChange}
                        onClick={() => setCashInterestMode(opt.id)}
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                          on
                            ? 'bg-sky-500/25 text-sky-100 shadow-sm'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <div
                  className="inline-flex shrink-0 rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
                  role="group"
                  aria-label="Carry and cash path view"
                >
                  <button
                    type="button"
                    aria-pressed={ccyPathView === 'carry'}
                    onClick={() => setCcyPathView('carry')}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                      ccyPathView === 'carry'
                        ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Carry
                  </button>
                  <button
                    type="button"
                    aria-pressed={ccyPathView === 'cashflow'}
                    onClick={() => setCcyPathView('cashflow')}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                      ccyPathView === 'cashflow'
                        ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Cash flow
                  </button>
                  <button
                    type="button"
                    aria-pressed={ccyPathView === 'table'}
                    onClick={() => setCcyPathView('table')}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                      ccyPathView === 'table'
                        ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Table
                  </button>
                </div>
                {(ccyPathView === 'carry' || ccyPathView === 'cashflow') && (
                  <div
                    className="inline-flex shrink-0 rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
                    role="group"
                    aria-label="Path presentation"
                  >
                    <button
                      type="button"
                      aria-pressed={pathPresentationMode === 'mom'}
                      onClick={() => setPathPresentationMode('mom')}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                        pathPresentationMode === 'mom'
                          ? 'bg-violet-500/20 text-violet-100 shadow-sm'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      MoM
                    </button>
                    <button
                      type="button"
                      aria-pressed={pathPresentationMode === 'cumulative'}
                      onClick={() => setPathPresentationMode('cumulative')}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                        pathPresentationMode === 'cumulative'
                          ? 'bg-violet-500/20 text-violet-100 shadow-sm'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      Cumulative
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {(ccyPathView === 'table' || ccyPathView === 'cashflow') && (
            <div className="mb-3 flex flex-wrap gap-3 font-mono text-[11px]">
              <div>
                <span className="text-slate-500">Cash FX </span>
                <span className="text-sky-300/90">
                  {fmtM(cashForecast.openingCashM)}
                </span>
              </div>
              {pathBookRow != null &&
                Math.abs(pathBookRow.nonCashAsset ?? 0) > 1e-9 && (
                  <div>
                    <span className="text-slate-500">Receivables / NWC </span>
                    <span className="text-violet-300/90">
                      {fmtM(pathBookRow.nonCashAsset ?? 0)}
                    </span>
                  </div>
                )}
              {pathBookRow != null &&
                Math.abs(pathBookRow.ir_liab_notional) > 1e-9 && (
                  <div>
                    <span className="text-slate-500">Debt (FCY) </span>
                    <span className="text-amber-200/90">
                      {fmtM(pathBookRow.ir_liab_notional)}
                    </span>
                  </div>
                )}
              {pathBookRow != null &&
                Math.abs(pathBookRow.ir_invest_notional ?? 0) > 1e-9 && (
                  <div>
                    <span className="text-slate-500">Investments </span>
                    <span className="text-teal-300/90">
                      {fmtM(pathBookRow.ir_invest_notional ?? 0)}
                    </span>
                  </div>
                )}
              <div>
                <span className="text-slate-500">Revenue Σ </span>
                <span className="text-slate-300">
                  {fmtM(cashForecast.totals.revenueInflowM)}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Expenses Σ </span>
                <span className="text-rose-300/80">
                  {fmtM(-cashForecast.totals.payoutOutflowM)}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Hedge CF </span>
                <span className="text-rose-300/80">
                  {fmtM(-cashForecast.totals.hedgeCashOutM)}
                </span>
              </div>
              <div>
                <span className="text-slate-500">End {chartCcy} </span>
                <span className="text-slate-100">
                  {fmtM(cashForecast.totals.endCashM)}
                </span>
              </div>
              <div>
                <span className="text-slate-500">End USD </span>
                <span className="text-slate-100">
                  {fmtM(cashForecast.totals.endUsdCashM)}
                </span>
              </div>
            </div>
          )}

          <div className="min-w-0 flex-1">
          {cashForecast.months.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">
              Tf = 0 — opening cash only.
            </p>
          ) : ccyPathView === 'carry' ? (
            pathPresentationMode === 'cumulative' ? (
              structureBars.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">
                  No carry path for {chartCcy} at Tf = {Tf}m.
                </p>
              ) : (
                <>
                  <CarryEvolutionBarChart
                    bars={structureBars}
                    Tf={Tf}
                    activeHorizon={setup.horizon}
                    ccy={chartCcy}
                    mode="structure"
                  />
                </>
              )
            ) : (
              <CarryPeriodComponentsChart
                hedgedMonths={cashForecast.months}
                unhedgedMonths={carryComparison?.unhedged.months}
                Tf={Tf}
                activeHorizon={setup.horizon}
                ccy={chartCcy}
              />
            )
          ) : ccyPathView === 'cashflow' ? (
            <CashFlowMonthBarChart
              months={cashForecast.months}
              ccy={chartCcy}
              presentation={pathPresentationMode}
              bookRow={pathBookRow}
              forecastProfile={forecastProfile}
              openingCashM={cashForecast.openingCashM}
            />
          ) : (
            <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs sm:min-w-[880px] lg:min-w-[1040px]">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-500">
                      <th className="sticky left-0 z-[1] bg-slate-900 py-2 pr-3 font-medium">
                        Month
                      </th>
                      <th className="py-2 pr-3 text-right font-medium">
                        Start {chartCcy}
                      </th>
                      <th className="py-2 pr-3 text-right font-medium">
                        Income
                      </th>
                      <th className="py-2 pr-3 text-right font-medium">
                        Expenses
                      </th>
                      <th className="py-2 pr-3 text-right font-medium text-white">
                        Hedge CF
                      </th>
                      <th className="py-2 pr-3 text-right font-medium">
                        End {chartCcy}
                      </th>
                      <th className="py-2 pr-3 text-right font-medium">
                        End USD
                      </th>
                      <th
                        className="border-l border-slate-800 py-2 pl-3 pr-3 text-right font-medium text-amber-300/90"
                        title="Residual FCY interest accrued through this month"
                      >
                        Residual int
                      </th>
                      <th
                        className="py-2 pr-3 text-right font-medium text-emerald-300/80"
                        title="Forward-points carry accrued through this month (same as Carry evolution cumulative)"
                      >
                        FWD accrued
                      </th>
                      <th
                        className="py-2 pr-3 text-right font-medium text-sky-300/80"
                        title="USD interest accrued through this month"
                      >
                        USD int
                      </th>
                      <th
                        className="py-2 pr-3 text-right font-medium text-emerald-200/80"
                        title="Income Σ accrued through this month"
                      >
                        Income Σ
                      </th>
                      <th
                        className="py-2 text-right font-medium text-emerald-200/80"
                        title="Enhancement vs do-nothing accrued through this month"
                      >
                        Enhancement
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthScheduleAccrued.map(row => {
                      const m = row.month;
                      return (
                        <tr
                          key={m.monthIndex}
                          className={`border-b border-slate-800/80 font-mono text-slate-300${
                            m.settleLegCount > 0
                              ? ' bg-emerald-500/[0.06]'
                              : ''
                          }`}
                        >
                          <td
                            className={`sticky left-0 z-[1] py-2 pr-3 font-semibold text-white ${
                              m.settleLegCount > 0
                                ? 'bg-emerald-950/80'
                                : 'bg-slate-900'
                            }`}
                          >
                            {m.label}
                            {m.settleLegCount > 0 && (
                              <span className="ml-1 text-[9px] font-normal text-emerald-300/80">
                                settle
                                {m.settleLegCount > 1
                                  ? `×${m.settleLegCount}`
                                  : ''}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right text-slate-300">
                            {fmtM(m.startCashM)}
                          </td>
                          <td className="py-2 pr-3 text-right text-slate-300">
                            {fmtM(m.revenueM)}
                          </td>
                          <td className="py-2 pr-3 text-right text-slate-300">
                            {fmtM(-m.payoutM)}
                          </td>
                          <td
                            className={`py-2 pr-3 text-right ${
                              Math.abs(m.hedgeCashFlowM) < 1e-12
                                ? 'text-slate-600'
                                : 'text-white'
                            }`}
                          >
                            {Math.abs(m.hedgeCashFlowM) < 1e-12
                              ? '—'
                              : fmtM(m.hedgeCashFlowM)}
                          </td>
                          <td className="py-2 pr-3 text-right text-slate-100">
                            {fmtM(m.endCashM)}
                          </td>
                          <td className="py-2 pr-3 text-right text-slate-100">
                            {Math.abs(m.endUsdCashM) < 1e-12
                              ? '—'
                              : fmtM(m.endUsdCashM)}
                          </td>
                          <td
                            className={`border-l border-slate-800 py-2 pl-3 pr-3 text-right ${
                              row.residualEurInterestUsdM >= 0
                                ? 'text-amber-300'
                                : 'text-rose-300'
                            }`}
                          >
                            {fmtK(row.residualEurInterestUsdM)}
                          </td>
                          <td className="py-2 pr-3 text-right text-emerald-300">
                            {Math.abs(row.fwdCarryUsdM) < 1e-12
                              ? '—'
                              : fmtK(row.fwdCarryUsdM)}
                          </td>
                          <td className="py-2 pr-3 text-right text-sky-300">
                            {Math.abs(row.usdInterestUsdM) < 1e-12
                              ? '—'
                              : fmtK(row.usdInterestUsdM)}
                          </td>
                          <td
                            className={`py-2 pr-3 text-right font-semibold ${
                              row.incomeUsdM >= 0
                                ? 'text-emerald-100'
                                : 'text-rose-300'
                            }`}
                          >
                            {fmtK(row.incomeUsdM)}
                          </td>
                          <td
                            className={`py-2 text-right font-semibold ${
                              row.enhancementUsdM >= 0
                                ? 'text-emerald-100'
                                : 'text-rose-300'
                            }`}
                          >
                            {fmtK(row.enhancementUsdM)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-600 bg-slate-900/80 font-mono text-slate-200">
                      <td
                        className="sticky left-0 z-[1] bg-slate-900 py-2 pr-3 font-semibold text-white"
                        colSpan={7}
                      >
                        Total @ Tf
                      </td>
                      <td className="border-l border-slate-800 py-2 pl-3 pr-3 text-right font-semibold text-amber-300">
                        {fmtK(cashForecast.totals.residualEurInterestUsdM)}
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold text-slate-200">
                        {fmtK(cashForecast.totals.fwdCarryUsdM)}
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold text-slate-200">
                        {fmtK(cashForecast.totals.usdInterestUsdM)}
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold text-emerald-100">
                        {fmtK(cashForecast.totals.incomeUsdM)}
                      </td>
                      <td className="py-2 text-right font-semibold text-emerald-100">
                        {carryComparison
                          ? fmtK(
                              carryComparison.categories.hedgeVsNoHedgeUsdM,
                            )
                          : '—'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
          )}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-3">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
            Hedging summary
          </div>
          <p className="mt-1.5 text-[10px] text-slate-500">
            Click CCY for profile · click a trade row to filter carry / cash
            flow below
          </p>
        </div>
        {multiCcyRows.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-500">
            No FX currencies on the book.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500">
                  <th className="py-2 pr-3 font-medium">CCY</th>
                  <th className="py-2 pr-3 font-medium">Struct</th>
                  <th
                    className="py-2 pr-3 font-medium"
                    title="Strip settle-window skew — equal / front-loaded / back-loaded"
                  >
                    Settle skew
                  </th>
                  <th className="py-2 pr-3 font-medium">Schedule</th>
                  <th className="py-2 pr-3 font-medium">Hedge Δ</th>
                  <th className="py-2 pr-3 font-medium">FWD pts</th>
                  <th className="py-2 pr-3 font-medium">Total carry</th>
                  <th className="py-2 font-medium">Δ vs do nothing</th>
                </tr>
              </thead>
              <tbody>
                {multiCcyRows.flatMap(r => {
                  const prep = preparedByCcy[r.ccy];
                  const isStrip =
                    prep?.structure === 'strip' && (prep.legs?.length ?? 0) >= 2;
                  const struct = isStrip
                    ? `strip · ${prep!.legs.length}`
                    : prep?.structure === 'bullet'
                      ? 'bullet'
                      : r.hasHedge
                        ? 'hedged'
                        : '—';
                  const skew: SettleSkewId =
                    prep?.settleSkew === 'front' || prep?.settleSkew === 'back'
                      ? prep.settleSkew
                      : 'neutral';
                  const schedule = isStrip
                    ? prep!.legs
                        .map(l => `M${Math.round(l.settleMonths ?? l.endMonth)}`)
                        .join('/')
                    : prep?.settleMonths != null
                      ? `M${Math.round(prep.settleMonths)}`
                      : '—';
                  const hedgeDelta = prep?.coverLocalM ?? 0;
                  const fwdPtsUsdM = r.fwdCarryUsdM;
                  const open = profileCcy === r.ccy;
                  const skewLabel = !isStrip
                    ? '—'
                    : skew === 'front'
                      ? 'Front'
                      : skew === 'back'
                        ? 'Back'
                        : 'Neutral';

                  const summaryRow = (
                    <tr
                      key={r.ccy}
                      role="button"
                      tabIndex={0}
                      onClick={() => openCcyProfile(r.ccy)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openCcyProfile(r.ccy);
                        }
                      }}
                      title={`Open ${r.ccy} settle WAM / strip analysis`}
                      className={`cursor-pointer border-b border-slate-800/80 hover:bg-violet-500/10 ${
                        open ? 'bg-violet-500/10' : ''
                      }`}
                    >
                      <td className="py-2 pr-3 font-semibold text-violet-200">
                        {r.ccy}
                      </td>
                      <td className="py-2 pr-3 font-mono capitalize text-violet-300/90">
                        {struct}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono ${
                          isStrip ? 'text-amber-200/90' : 'text-slate-500'
                        }`}
                        title={
                          isStrip
                            ? 'Strip settle-window skew (edit in profile modal)'
                            : 'Settle skew applies to strip only'
                        }
                      >
                        {skewLabel}
                      </td>
                      <td className="py-2 pr-3 font-mono text-amber-200/90">
                        {schedule}
                      </td>
                      <td className="py-2 pr-3 font-mono text-slate-300">
                        {Math.abs(hedgeDelta) < 1e-12 ? '—' : fmtM(hedgeDelta)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-emerald-300/90">
                        {fmtK(fwdPtsUsdM)}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono font-semibold ${
                          r.totalCarryUsdM >= 0
                            ? 'text-slate-300'
                            : 'text-rose-300'
                        }`}
                      >
                        {fmtK(r.totalCarryUsdM)}
                      </td>
                      <td
                        className={`py-2 font-mono ${
                          Math.abs(r.benefitUsdM) < 1e-12
                            ? 'text-slate-500'
                            : r.benefitUsdM >= 0
                              ? 'text-emerald-200'
                              : 'text-rose-300'
                        }`}
                      >
                        {fmtK(r.benefitUsdM)}
                      </td>
                    </tr>
                  );

                  if (!prep || Math.abs(prep.coverLocalM) < 1e-12) {
                    return [summaryRow];
                  }

                  const tradeRows =
                    isStrip && prep.legs.length >= 2
                      ? prep.legs.flatMap((leg, i) => {
                          const prevHedge =
                            i > 0 ? (prep.legs[i - 1]?.hedgeLocalM ?? 0) : 0;
                          const delta =
                            typeof leg.tradeNotionalLocalM === 'number'
                              ? leg.tradeNotionalLocalM
                              : leg.hedgeLocalM - prevHedge;
                          if (Math.abs(delta) < 1e-12) return [];
                          const tradeKey: HedgeTradeSelectionKey = `${r.ccy}:leg:${leg.index}`;
                          const selected = selectedTradeKey === tradeKey;
                          const settle = Math.round(
                            leg.settleMonths ?? leg.endMonth,
                          );
                          const legFwd = preparedLegFwdCarryUsdM(
                            leg,
                            prevHedge,
                            marketRatesFor(r.ccy),
                          );
                          return [
                            <tr
                              key={tradeKey}
                              role="button"
                              tabIndex={0}
                              onClick={() => selectTradeForPath(tradeKey)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  selectTradeForPath(tradeKey);
                                }
                              }}
                              title={`Show ${r.ccy} ${leg.label} only in carry / cash flow`}
                              className={`cursor-pointer border-b border-slate-800/50 text-[11px] hover:bg-emerald-500/10 ${
                                selected
                                  ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-400/30'
                                  : ''
                              }`}
                            >
                              <td className="py-1.5 pl-5 pr-3 font-mono text-sky-200/90">
                                {leg.label}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-slate-500">
                                trade
                              </td>
                              <td className="py-1.5 pr-3 text-slate-600">—</td>
                              <td className="py-1.5 pr-3 font-mono text-amber-200/80">
                                M{settle}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-slate-400">
                                {fmtM(delta)}
                              </td>
                              <td className="py-1.5 pr-3 font-mono text-emerald-300/80">
                                {Math.abs(legFwd) < 1e-12
                                  ? '—'
                                  : fmtK(legFwd)}
                              </td>
                              <td className="py-1.5 pr-3 text-slate-600">—</td>
                              <td className="py-1.5 text-slate-600">—</td>
                            </tr>,
                          ];
                        })
                      : [
                          (() => {
                            const tradeKey: HedgeTradeSelectionKey = `${r.ccy}:bullet`;
                            const selected = selectedTradeKey === tradeKey;
                            const bulletFwd = preparedBulletFwdCarryUsdM(
                              prep,
                              marketRatesFor(r.ccy),
                              r.fwdCarryUsdM,
                            );
                            return (
                              <tr
                                key={tradeKey}
                                role="button"
                                tabIndex={0}
                                onClick={() => selectTradeForPath(tradeKey)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    selectTradeForPath(tradeKey);
                                  }
                                }}
                                title={`Show ${r.ccy} bullet trade only in carry / cash flow`}
                                className={`cursor-pointer border-b border-slate-800/50 text-[11px] hover:bg-emerald-500/10 ${
                                  selected
                                    ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-400/30'
                                    : ''
                                }`}
                              >
                                <td className="py-1.5 pl-5 pr-3 font-mono text-sky-200/90">
                                  Bullet
                                </td>
                                <td className="py-1.5 pr-3 font-mono text-slate-500">
                                  trade
                                </td>
                                <td className="py-1.5 pr-3 text-slate-600">—</td>
                                <td className="py-1.5 pr-3 font-mono text-amber-200/80">
                                  {schedule}
                                </td>
                                <td className="py-1.5 pr-3 font-mono text-slate-400">
                                  {fmtM(prep.coverLocalM)}
                                </td>
                                <td className="py-1.5 pr-3 font-mono text-emerald-300/80">
                                  {Math.abs(bulletFwd) < 1e-12
                                    ? '—'
                                    : fmtK(bulletFwd)}
                                </td>
                                <td className="py-1.5 pr-3 text-slate-600">—</td>
                                <td className="py-1.5 text-slate-600">—</td>
                              </tr>
                            );
                          })(),
                        ];

                  return [summaryRow, ...tradeRows];
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {profileOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cash-carry-profile-title"
            onClick={e => {
              if (e.target === e.currentTarget) closeCcyProfile();
            }}
          >
            <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-xl rounded-b-none border border-slate-700 bg-slate-900 shadow-2xl">
              {/* Fixed header — stays pinned while modal body scrolls. */}
              <div className="sticky top-0 z-30 shrink-0 rounded-t-xl border-b border-slate-800 bg-slate-900 px-4 pb-3 pt-4 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.75)]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h4
                    id="cash-carry-profile-title"
                    className="text-sm font-semibold text-white"
                  >
                    {chartCcy} — hedge carry profile
                  </h4>
                  <button
                    type="button"
                    onClick={closeCcyProfile}
                    className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800"
                  >
                    Close
                  </button>
                </div>

                {(() => {
                  const chip =
                    'inline-flex items-center gap-1 rounded border border-slate-700/80 bg-slate-950/90 px-1.5 py-0.5 text-[10px] text-slate-500';
                  const val = 'font-mono font-semibold tabular-nums';
                  const optScore =
                    appliedShapeScore ??
                    shapePreviewScore ??
                    stripShapeOpt?.best ??
                    null;
                  const locked = appliedShapeScore != null;
                  const optStruct =
                    optScore == null
                      ? pathStructure === 'strip'
                        ? `Strip · ${pathStripLegCount ?? instrumentLegCount}`
                        : 'Bullet'
                      : optScore.structure === 'bullet' ||
                          optScore.legCount <= 1
                        ? 'Bullet'
                        : `Strip · ${optScore.legCount}`;
                  const optSkew =
                    optScore != null && optScore.legCount > 1
                      ? settleSkewFromCenterOfMass(optScore.centerOfMass)
                      : instrumentSettleSkew;
                  const optSched =
                    optScore?.settleScheduleLabel ??
                    (pathScheduleEnds != null && pathScheduleEnds.length >= 2
                      ? pathScheduleEnds
                          .map(m => `M${Math.round(m)}`)
                          .join('/')
                      : null) ??
                    (profileDraft?.structure === 'strip' &&
                    (profileDraft.legs?.length ?? 0) >= 2
                      ? profileDraft.legs
                          .map(
                            l =>
                              `M${Math.round(l.settleMonths ?? l.endMonth)}`,
                          )
                          .join('/')
                      : null) ??
                    currentWamRow?.settleScheduleLabel ??
                    null;
                  const residZero =
                    pathSummaryMetrics != null &&
                    (pathSummaryMetrics.residVarValue === '$0K' ||
                      pathSummaryMetrics.residVarValue === '0' ||
                      /\$0/.test(pathSummaryMetrics.residVarValue));
                  const canApply =
                    shapePreviewScore != null &&
                    Math.abs(shapePreviewScore.hedgeDeltaLocalM) > 1e-12;

                  return (
                    <div
                      className={`mt-2 rounded-md border px-2.5 py-2 ${
                        locked
                          ? 'border-emerald-600/50 bg-emerald-950/40'
                          : 'border-slate-700 bg-slate-950/80'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                              {locked ? 'Applied' : 'Opt. preview'}
                            </span>
                            <span className="font-mono text-[10px] font-semibold text-violet-200">
                              {optStruct}
                              {optScore != null && optScore.legCount > 1 && (
                                <>
                                  {' '}
                                  · CoM{' '}
                                  {(optScore.centerOfMass * 100).toFixed(0)}% ·
                                  kurt {optScore.kurtosis.toFixed(1)}
                                </>
                              )}
                              {optSched && (
                                <span className="ml-1 text-amber-200/90">
                                  {optSched}
                                </span>
                              )}
                            </span>
                            {optScore != null && optScore.legCount > 1 && (
                              <span className={`${chip} text-amber-200/90`}>
                                {optSkew === 'front'
                                  ? 'Front'
                                  : optSkew === 'back'
                                    ? 'Back'
                                    : 'Neutral'}
                              </span>
                            )}
                            {(currentWamRow || optScore) && (
                              <span className={chip}>
                                WAM{' '}
                                <span className={`${val} text-emerald-200`}>
                                  {optScore
                                    ? `M${Math.round(optScore.wamMonths)}`
                                    : currentWamRow!.label}
                                </span>
                              </span>
                            )}
                            {profileDraftDirty && (
                              <span className="rounded border border-amber-700/40 bg-amber-950/30 px-1 py-px text-[9px] font-medium text-amber-300/90">
                                Draft
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
                            <div className="inline-flex items-baseline gap-1.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                                Carry
                              </span>
                              <span
                                className={`font-mono text-base font-semibold tabular-nums ${
                                  ((optScore?.newCarryUsdM ?? 0) +
                                    (optScore?.fwdCarryUsdM ?? 0)) >=
                                  0
                                    ? 'text-emerald-100'
                                    : 'text-rose-300'
                                }`}
                                title="Total carry = New (FCY+USD int) + FWD pts — same as table"
                              >
                                {optScore
                                  ? fmtK(
                                      optScore.newCarryUsdM +
                                        optScore.fwdCarryUsdM,
                                    )
                                  : '—'}
                              </span>
                            </div>
                            <div className="inline-flex items-baseline gap-1.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                                Enh
                              </span>
                              <span
                                className={`font-mono text-base font-semibold tabular-nums ${
                                  (optScore?.enhancementUsdM ?? 0) >= 0
                                    ? 'text-emerald-100'
                                    : 'text-rose-300'
                                }`}
                              >
                                {optScore
                                  ? fmtK(optScore.enhancementUsdM)
                                  : '—'}
                              </span>
                            </div>
                            <div className="inline-flex items-baseline gap-1.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                                vs bullet
                              </span>
                              <span
                                className={`font-mono text-sm font-semibold tabular-nums ${
                                  (optScore?.vsBulletUsdM ?? 0) >= 0
                                    ? 'text-sky-200'
                                    : 'text-rose-300'
                                }`}
                              >
                                {optScore ? fmtK(optScore.vsBulletUsdM) : '—'}
                              </span>
                              {optScore && (
                                <span className="font-mono text-[9px] text-slate-500">
                                  Σ {fmtM(optScore.hedgeDeltaLocalM)} · M
                                  {Math.round(optScore.wamMonths)}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-1">
                            {pathSummaryMetrics ? (
                              <>
                                <span
                                  className={chip}
                                  title={pathSummaryMetrics.coverSub}
                                >
                                  Cover{' '}
                                  <span className={`${val} text-slate-100`}>
                                    {pathSummaryMetrics.coverValue}
                                  </span>
                                  {pathSummaryMetrics.coverPct != null && (
                                    <span className={`${val} text-slate-400`}>
                                      {pathSummaryMetrics.coverPct}
                                    </span>
                                  )}
                                </span>
                                <span
                                  className={chip}
                                  title={pathSummaryMetrics.legsSub}
                                >
                                  Legs{' '}
                                  <span className={`${val} text-sky-200`}>
                                    {optScore && optScore.legCount > 1
                                      ? String(optScore.legCount)
                                      : pathSummaryMetrics.legsValue}
                                  </span>
                                </span>
                                <span
                                  className={chip}
                                  title={pathSummaryMetrics.residVarSub}
                                >
                                  Resid{' '}
                                  <span
                                    className={`${val} ${
                                      residZero
                                        ? 'text-slate-300'
                                        : 'text-rose-300'
                                    }`}
                                  >
                                    {pathSummaryMetrics.residVarValue}
                                  </span>
                                </span>
                                <span
                                  className={chip}
                                  title={
                                    pathSummaryMetrics.breakevenSub ??
                                    'Breakeven'
                                  }
                                >
                                  BE{' '}
                                  <span
                                    className={`${val} text-amber-200/90`}
                                  >
                                    {pathSummaryMetrics.breakevenValue}
                                  </span>
                                </span>
                              </>
                            ) : (
                              <span className="text-[9px] text-slate-600">
                                Cover / Legs / Resid / BE load with hedge path…
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-stretch gap-1 sm:items-end">
                          <div className="flex flex-row flex-wrap items-center justify-end gap-1">
                            <button
                              type="button"
                              disabled={!canApply}
                              onClick={() => {
                                if (shapePreviewScore)
                                  applyStripShapeAroundWam(shapePreviewScore);
                              }}
                              className="rounded border border-emerald-700/50 bg-emerald-950/50 px-2.5 py-1.5 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-900/50 disabled:cursor-not-allowed disabled:opacity-40"
                              title="Lock optimal strip into modal draft (local — Assign/Prebook to stage to Analytics)"
                            >
                              {locked ? 'Re-apply' : 'Apply shape'}
                            </button>
                            {profileDraft && onPreparedByCcyChange && (
                              <button
                                type="button"
                                onClick={() => stageProfileDraft()}
                                disabled={!profileDraftDirty}
                                className="rounded border border-violet-500/50 bg-violet-500/20 px-2.5 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                                title="Prebook package for Hedging Decision — Send under this CCY to book"
                              >
                                {profileDraftDirty ? 'Prebook' : 'Prebooked'}
                              </button>
                            )}
                          </div>
                          <span className="text-right text-[8px] text-slate-600">
                            Prebook → Decision · Send to book
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-none bg-slate-900 p-4">
                <div className="space-y-3.5">
                <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
                  2 · Performance &amp; setup
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
                  <div
                    ref={bindPathPerfPanelHost}
                    className="min-h-0"
                    aria-label={`${chartCcy} hedge performance · tick trades`}
                  />
                </div>

                <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
                  3 · Settle WAM
                </div>
                <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-950 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-emerald-200">
                        Settle WAM
                      </div>
                      <p className="mt-0.5 font-mono text-[10px] leading-snug text-slate-500">
                        {wamChartView === 'execution' &&
                        shapedLegBars.length > 0
                          ? `Strip execution · ${shapedLegBars.length} leg stacks (read-only)${
                              selectedWamRow
                                ? ` · WAM ${selectedWamRow.label}`
                                : ''
                            }`
                          : selectedWamRow
                            ? `Enhancement · selected ${selectedWamRow.label}${
                                currentWamRow
                                  ? ` · book ${currentWamRow.label}`
                                  : ''
                              }`
                            : appliedShape
                              ? `Enhancement · WAM M${
                                  appliedShapeScore
                                    ? Math.round(appliedShapeScore.wamMonths)
                                    : selectedSettleMonths != null
                                      ? Math.round(selectedSettleMonths)
                                      : '—'
                                }${
                                  currentWamRow
                                    ? ` · book ${currentWamRow.label}`
                                    : ''
                                }`
                              : 'Enhancement · click Mm to pin bullet WAM, then Apply shape.'}
                      </p>
                    </div>
                    {shapePreviewScore &&
                      shapePreviewScore.legs.length > 0 && (
                        <div
                          className="inline-flex shrink-0 rounded-md border border-slate-700 bg-slate-950/60 p-0.5"
                          role="group"
                          aria-label="WAM chart view"
                        >
                          <button
                            type="button"
                            aria-pressed={wamChartView === 'enhancement'}
                            onClick={() => setWamChartView('enhancement')}
                            className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                              wamChartView === 'enhancement'
                                ? 'bg-emerald-500/20 text-emerald-100'
                                : 'text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            Enhancement
                          </button>
                          <button
                            type="button"
                            aria-pressed={wamChartView === 'execution'}
                            onClick={() => setWamChartView('execution')}
                            className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                              wamChartView === 'execution'
                                ? 'bg-violet-500/20 text-violet-100'
                                : 'text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            Strip execution
                          </button>
                        </div>
                      )}
                  </div>
                  {!hasStrategyHedge || settleScenarios.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-500">
                      No model hedge for {chartCcy} yet — set cover / structure
                      in Hedge path below (stays in this modal until Stage to
                      Analytics).
                    </p>
                  ) : (
                    <>
                      <SettleWamDeltaVsBookChart
                        scenarios={settleScenarios}
                        ccy={chartCcy}
                        selectedSettleMonths={selectedSettleMonths}
                        view={
                          wamChartView === 'execution' &&
                          shapedLegBars.length > 0
                            ? 'execution'
                            : 'enhancement'
                        }
                        proposalMonths={
                          wamChartView === 'enhancement'
                            ? appliedShapeScore &&
                              appliedShapeScore.settleMonths.length > 0
                              ? appliedShapeScore.settleMonths
                              : shapePreviewScore &&
                                  shapePreviewScore.settleMonths.length > 0
                                ? shapePreviewScore.settleMonths
                                : pathStructure === 'strip' &&
                                    pathScheduleEnds
                                  ? pathScheduleEnds
                                  : undefined
                            : undefined
                        }
                        legBars={
                          wamChartView === 'execution' &&
                          shapedLegBars.length > 0
                            ? shapedLegBars
                            : undefined
                        }
                        executionLegs={
                          wamChartView === 'execution'
                            ? appliedShapeScore &&
                              appliedShapeScore.legs.length > 0
                              ? appliedShapeScore.legs
                              : shapePreviewScore &&
                                  shapePreviewScore.legs.length > 0
                                ? shapePreviewScore.legs
                                : undefined
                            : undefined
                        }
                        onSelectScenario={
                          wamSelectionEnabled
                            ? selectSettleWamScenario
                            : undefined
                        }
                      />
                      <>
                          <div className="overflow-x-auto">
                            <table className="w-full min-w-0 text-left text-[10px] md:min-w-[980px]">
                              <thead>
                                <tr>
                                  <th className="sticky left-0 z-[1] bg-slate-950 pb-0.5 pr-2" />
                                  <th
                                    colSpan={2}
                                    className="pb-0.5 pr-2 text-right text-[9px] font-semibold uppercase tracking-wide text-slate-600"
                                  >
                                    Outcome
                                  </th>
                                  <th
                                    colSpan={9}
                                    className="hidden border-l border-slate-800 pb-0.5 pl-3 text-right text-[9px] font-semibold uppercase tracking-wide text-slate-600 md:table-cell"
                                  >
                                    Setup &amp; carry split
                                  </th>
                                </tr>
                                <tr className="text-slate-500">
                                  <th
                                    className="sticky left-0 z-[1] bg-slate-950 py-1 pr-2 font-medium"
                                    title="Assumed weighted-average settle from M0"
                                  >
                                    Settle WAM
                                  </th>
                                  <th
                                    className="py-1 pr-2 text-right font-medium text-emerald-200/80"
                                    title="Enhancement = New − Old + FWD pts"
                                  >
                                    Enhancement
                                  </th>
                                  <th
                                    className="py-1 pr-2 text-right font-medium text-sky-200/80"
                                    title="Enhancement − book Enhancement"
                                  >
                                    vs book
                                  </th>
                                  <th className="hidden border-l border-slate-800 py-1 pl-3 pr-2 font-medium text-violet-300/80 md:table-cell">
                                    Struct
                                  </th>
                                  <th className="hidden py-1 pr-2 font-medium md:table-cell">
                                    Hedge Δ
                                  </th>
                                  <th
                                    className="hidden py-1 pr-2 font-medium md:table-cell"
                                    title="Leg settle months for this WAM row"
                                  >
                                    Schedule
                                  </th>
                                  <th
                                    className="hidden py-1 pr-2 font-medium text-amber-200/80 md:table-cell"
                                    title="Old: unhedged FCY cash interest @ Tf"
                                  >
                                    Default (Old)
                                  </th>
                                  <th
                                    className="hidden py-1 pr-2 font-medium text-violet-300/80 md:table-cell"
                                    title="FCY overnight"
                                  >
                                    FCY int
                                  </th>
                                  <th
                                    className="hidden py-1 pr-2 font-medium text-sky-300/80 md:table-cell"
                                    title="USD overnight on settle proceeds"
                                  >
                                    USD int
                                  </th>
                                  <th
                                    className="hidden py-1 pr-2 font-medium md:table-cell"
                                    title="New = FCY int + USD int"
                                  >
                                    New
                                  </th>
                                  <th
                                    className="hidden py-1 pr-2 font-medium text-emerald-300/80 md:table-cell"
                                    title="Σ swap-points on each leg"
                                  >
                                    FWD pts
                                  </th>
                                  <th
                                    className="hidden py-1 font-medium md:table-cell"
                                    title="Absolute carry = New + FWD pts"
                                  >
                                    Total
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {settleScenariosForTable.map((s, rank) => {
                                  const isSelected =
                                    selectedSettleMonths != null &&
                                    Math.round(s.settleMonths) ===
                                      Math.round(selectedSettleMonths);
                                  const isBest =
                                    rank === 0 &&
                                    Math.abs(s.hedgeDeltaLocalM) > 1e-12 &&
                                    !s.beyondForecast;
                                  const stickyBg = isSelected
                                    ? 'bg-emerald-950'
                                    : 'bg-slate-950';
                                  const canSelect =
                                    wamSelectionEnabled &&
                                    Math.abs(s.hedgeDeltaLocalM) > 1e-12;
                                  return (
                                    <tr
                                      key={s.label}
                                      className={`border-t border-slate-800/80 font-mono text-slate-300${
                                        isSelected
                                          ? ' bg-emerald-500/[0.08]'
                                          : ''
                                      }${s.beyondForecast ? ' opacity-50' : ''}${
                                        canSelect
                                          ? ' cursor-pointer hover:bg-slate-800/50'
                                          : ''
                                      }`}
                                      onClick={() => {
                                        if (canSelect) {
                                          selectSettleWamScenario(s);
                                        }
                                      }}
                                      title={
                                        isSelected
                                          ? 'Selected settle WAM'
                                          : s.isCurrentWam
                                            ? 'Book settle WAM — click to select'
                                            : 'Select this settle WAM (bullet curve stays fixed)'
                                      }
                                    >
                                      <td
                                        className={`sticky left-0 z-[1] py-1.5 pr-2 font-semibold text-white ${stickyBg}`}
                                      >
                                        {s.label}
                                        {isBest && (
                                          <span className="ml-1 text-[9px] font-normal text-emerald-300/90">
                                            best
                                          </span>
                                        )}
                                        {isSelected && (
                                          <span className="ml-1 text-[9px] font-normal text-emerald-300/80">
                                            selected
                                          </span>
                                        )}
                                        {s.isCurrentWam && !isSelected && (
                                          <span className="ml-1 text-[9px] font-normal text-slate-400">
                                            book
                                          </span>
                                        )}
                                        {s.beyondForecast && (
                                          <span className="ml-1 text-[9px] font-normal text-slate-500">
                                            &gt;Tf
                                          </span>
                                        )}
                                        <div className="mt-0.5 text-[9px] font-normal text-slate-500 md:hidden">
                                          {s.structure === 'none'
                                            ? '—'
                                            : s.structure === 'strip'
                                              ? `strip${s.legCount > 1 ? ` · ${s.legCount}` : ''}`
                                              : 'bullet'}
                                          {' · '}
                                          {s.settleScheduleLabel}
                                        </div>
                                      </td>
                                      <td
                                        className={`py-1.5 pr-2 text-right text-[11px] font-semibold ${
                                          s.enhancementUsdM >= 0
                                            ? 'text-emerald-100'
                                            : 'text-rose-300'
                                        }`}
                                        title="New − Old + FWD pts"
                                      >
                                        {fmtK(s.enhancementUsdM)}
                                      </td>
                                      <td
                                        className={`py-1.5 pr-2 text-right text-[11px] font-semibold ${
                                          s.isCurrentWam
                                            ? 'text-slate-500'
                                            : s.enhancementVsBookUsdM >= 0
                                              ? 'text-sky-200'
                                              : 'text-rose-300'
                                        }`}
                                        title="Enhancement − book Enhancement"
                                      >
                                        {s.isCurrentWam
                                          ? '—'
                                          : fmtK(s.enhancementVsBookUsdM)}
                                      </td>
                                      <td className="hidden border-l border-slate-800 py-1.5 pl-3 pr-2 capitalize text-violet-300/90 md:table-cell">
                                        {s.structure === 'none'
                                          ? '—'
                                          : s.structure === 'strip'
                                            ? `strip${s.legCount > 1 ? ` · ${s.legCount}` : ''}`
                                            : 'bullet'}
                                      </td>
                                      <td className="hidden py-1.5 pr-2 text-slate-300 md:table-cell">
                                        {fmtM(s.hedgeDeltaLocalM)}
                                      </td>
                                      <td
                                        className="hidden py-1.5 pr-2 text-slate-400 md:table-cell"
                                        title="Leg settle months"
                                      >
                                        {s.settleScheduleLabel}
                                      </td>
                                      <td
                                        className="hidden py-1.5 pr-2 text-amber-200/90 md:table-cell"
                                        title="Unhedged FCY cash interest @ Tf"
                                      >
                                        {fmtK(s.defaultCarryUsdM)}
                                      </td>
                                      <td className="hidden py-1.5 pr-2 text-violet-300/90 md:table-cell">
                                        {fmtK(s.fcyInterestUsdM)}
                                      </td>
                                      <td className="hidden py-1.5 pr-2 text-sky-300 md:table-cell">
                                        {fmtK(s.usdInterestUsdM)}
                                      </td>
                                      <td
                                        className="hidden py-1.5 pr-2 text-white md:table-cell"
                                        title="FCY int + USD int"
                                      >
                                        {fmtK(s.newCarryUsdM)}
                                      </td>
                                      <td
                                        className="hidden py-1.5 pr-2 text-emerald-300 md:table-cell"
                                        title="Σ per-leg swap-points"
                                      >
                                        {fmtK(s.fwdCarryUsdM)}
                                      </td>
                                      <td
                                        className={`hidden py-1.5 md:table-cell ${
                                          s.totalCarryUsdM >= 0
                                            ? 'text-slate-300'
                                            : 'text-rose-300/80'
                                        }`}
                                        title="New + FWD pts (absolute)"
                                      >
                                        {fmtK(s.totalCarryUsdM)}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          <p className="text-[10px] text-slate-500 md:hidden">
                            Default (Old) · FCY int · USD int · New · FWD pts ·
                            Total stay in the expanded ladder above ~840px.
                          </p>
                        </>
                    </>
                  )}
                </section>

                <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
                  4 · Optimal strip around WAM
                </div>
                <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-950 p-3">
                  {!hasStrategyHedge ||
                  shapeTargetWamMonths == null ||
                  !stripShapeOpt ||
                  !shapePreviewScore ? (
                    <p className="py-4 text-center text-xs text-slate-500">
                      Select a settle WAM above — then we search strip count ×
                      skew (CoM) × kurtosis for max Enhancement at that WAM.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[11px] font-semibold text-violet-200">
                            Shape search @{' '}
                            {stripShapeOpt.startConversion
                              ? 'M1·start'
                              : `M${Math.round(stripShapeOpt.targetWamMonths)}`}
                          </div>
                          <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                            Objective: max Enhancement · fixed hedge Δ · WAM
                            pinned · grid over legs / CoM / kurtosis
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            applyStripShapeAroundWam(shapePreviewScore)
                          }
                          className="rounded-md border border-emerald-700/50 bg-emerald-950/40 px-2.5 py-1 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-900/50"
                          title="Lock optimal strip into Analytics prepared package (Hedging Summary + reopen)"
                        >
                          {appliedShape ? 'Re-apply shape' : 'Apply shape'}
                        </button>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-3">
                        {(() => {
                          const staged = appliedShapeScore ?? stripShapeOpt.best;
                          const locked = appliedShapeScore != null;
                          const live = shapePreviewScore;
                          const coverScale =
                            typeof profileDraft?.hedgeRatio === 'number' &&
                            profileDraft.hedgeRatio > 1e-9 &&
                            profileDraft.hedgeRatio <= 1 + 1e-9
                              ? Math.min(
                                  1,
                                  Math.max(0, profileDraft.hedgeRatio),
                                )
                              : 1;
                          const bulletEnh =
                            stripShapeOpt.bullet.enhancementUsdM * coverScale;
                          // Live ladder for carry figures (Hedge % / settle edits).
                          const metrics = live ?? staged;
                          const totalCarry =
                            metrics.newCarryUsdM + metrics.fwdCarryUsdM;
                          return (
                            <>
                              <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2.5 py-1.5">
                                <div className="text-[9px] font-semibold uppercase tracking-wide text-emerald-400/80">
                                  {locked ? 'Applied strip' : 'Best strip setup'}
                                </div>
                                <div
                                  className={`mt-0.5 font-mono text-sm font-semibold ${
                                    staged.enhancementUsdM >= 0
                                      ? 'text-emerald-100'
                                      : 'text-rose-300'
                                  }`}
                                  title="Enhancement = Resid + USD + FWD − Old"
                                >
                                  Enh {fmtK(staged.enhancementUsdM)}
                                </div>
                                {(() => {
                                  const oldCarry =
                                    staged.newCarryUsdM -
                                    staged.interestDeltaUsdM;
                                  return (
                                    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[9px] tabular-nums">
                                      <span
                                        className="text-amber-300/90"
                                        title="Residual FCY int"
                                      >
                                        Resid {fmtK(staged.fcyInterestUsdM)}
                                      </span>
                                      <span
                                        className="text-sky-300/90"
                                        title="USD int"
                                      >
                                        USD {fmtK(staged.usdInterestUsdM)}
                                      </span>
                                      <span
                                        className="text-emerald-300/90"
                                        title="FWD pts"
                                      >
                                        FWD {fmtK(staged.fwdCarryUsdM)}
                                      </span>
                                      <span
                                        className="text-slate-400"
                                        title="Do-nothing Old (unhedged FCY int)"
                                      >
                                        Old {fmtK(-oldCarry)}
                                      </span>
                                    </div>
                                  );
                                })()}
                                <div className="mt-0.5 font-mono text-[10px] text-amber-200/90">
                                  {staged.settleScheduleLabel}
                                  {' · '}Σ {fmtM(staged.hedgeDeltaLocalM)}
                                </div>
                              </div>
                              <div className="rounded border border-slate-700 bg-slate-900/60 px-2.5 py-1.5">
                                <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                                  Total carry
                                </div>
                                <div
                                  className={`mt-0.5 font-mono text-sm font-semibold ${
                                    totalCarry >= 0
                                      ? 'text-slate-100'
                                      : 'text-rose-300'
                                  }`}
                                  title="Resid + FWD + USD int"
                                >
                                  {fmtK(totalCarry)}
                                </div>
                                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[9px] tabular-nums">
                                  <span className="text-amber-300/90">
                                    Resid {fmtK(metrics.fcyInterestUsdM)}
                                  </span>
                                  <span className="text-emerald-300/90">
                                    FWD {fmtK(metrics.fwdCarryUsdM)}
                                  </span>
                                  <span className="text-sky-300/90">
                                    USD {fmtK(metrics.usdInterestUsdM)}
                                  </span>
                                </div>
                              </div>
                              <div className="rounded border border-slate-700 bg-slate-900/60 px-2.5 py-1.5">
                                <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                                  vs bullet @ WAM
                                </div>
                                <div
                                  className={`font-mono text-sm font-semibold ${
                                    metrics.enhancementUsdM - bulletEnh >= 0
                                      ? 'text-emerald-200'
                                      : 'text-rose-300'
                                  }`}
                                >
                                  {fmtK(metrics.enhancementUsdM - bulletEnh)}
                                </div>
                                <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                                  bullet enh {fmtK(bulletEnh)}
                                </div>
                              </div>
                            </>
                          );
                        })()}
                      </div>

                      <div className="grid gap-2 sm:grid-cols-3">
                        {(() => {
                          const maxLegs = Math.min(8, Math.max(2, Tf));
                          const legs = shapePreview?.legCount ?? 1;
                          const com = shapePreview?.centerOfMass ?? 0.5;
                          const kurt = shapePreview?.kurtosis ?? 0;
                          const stripOff = legs <= 1;
                          const patchShape = (
                            patch: Partial<{
                              legCount: number;
                              centerOfMass: number;
                              kurtosis: number;
                            }>,
                          ) => {
                            applyShapeStartingPoint(
                              {
                                legCount: patch.legCount ?? legs,
                                centerOfMass: patch.centerOfMass ?? com,
                                kurtosis: patch.kurtosis ?? kurt,
                              },
                              { fromUser: true },
                            );
                          };
                          const legTicks = Array.from(
                            { length: maxLegs },
                            (_, i) => i + 1,
                          );
                          return (
                            <>
                              <TickBarStepper
                                label="Strip legs"
                                value={legs}
                                min={1}
                                max={maxLegs}
                                step={1}
                                onChange={legCount => patchShape({ legCount })}
                                formatValue={v =>
                                  v <= 1 ? 'bullet' : String(Math.round(v))
                                }
                                tickValues={legTicks}
                                tickLabels={legTicks.map(n =>
                                  n === 1 ? '•' : String(n),
                                )}
                              />
                              <TickBarStepper
                                label="Skew · CoM"
                                value={com}
                                min={0}
                                max={1}
                                step={0.05}
                                disabled={stripOff}
                                onChange={centerOfMass =>
                                  patchShape({ centerOfMass })
                                }
                                formatValue={v =>
                                  `${settleSkewFromCenterOfMass(v)} · ${(v * 100).toFixed(0)}%`
                                }
                                tickValues={[0, 0.25, 0.5, 0.75, 1]}
                                tickLabels={[
                                  'front',
                                  '25',
                                  'mid',
                                  '75',
                                  'back',
                                ]}
                              />
                              <TickBarStepper
                                label="Kurtosis"
                                value={kurt}
                                min={-1}
                                max={1}
                                step={0.05}
                                disabled={stripOff}
                                onChange={kurtosis =>
                                  patchShape({ kurtosis })
                                }
                                formatValue={v => v.toFixed(2)}
                                tickValues={[-1, -0.5, 0, 0.5, 1]}
                                tickLabels={[
                                  'wings',
                                  '−0.5',
                                  'flat',
                                  '+0.5',
                                  'peak',
                                ]}
                              />
                            </>
                          );
                        })()}
                      </div>

                      {(pathStructure === 'strip' ||
                        (shapePreviewScore?.legs.length ?? 0) > 1) && (
                        <div className="overflow-x-auto rounded-md border border-slate-700 bg-slate-950/50 p-2">
                          <div
                            ref={bindPathSchedulePanelHost}
                            className="min-h-0"
                            aria-label={`${chartCcy} strip schedule setup`}
                          />
                          {shapePreviewScore && (
                            <div className="mt-2 space-y-1 border-t border-slate-800 pt-2 text-[9px] text-slate-500">
                              {(() => {
                                const s = shapePreviewScore;
                                const total =
                                  s.newCarryUsdM + s.fwdCarryUsdM;
                                const oldCarry =
                                  s.newCarryUsdM - s.interestDeltaUsdM;
                                return (
                                  <>
                                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                      <span>
                                        Preview · WAM≈{s.wamMonths.toFixed(1)}
                                        {' · '}Σ {fmtM(s.hedgeDeltaLocalM)}
                                      </span>
                                      <span className="inline-flex flex-wrap items-baseline gap-x-2 font-mono tabular-nums">
                                        <span
                                          className={
                                            total >= 0
                                              ? 'font-semibold text-slate-200'
                                              : 'font-semibold text-rose-300'
                                          }
                                        >
                                          Carry {fmtK(total)}
                                        </span>
                                        <span className="text-amber-300/90">
                                          Resid {fmtK(s.fcyInterestUsdM)}
                                        </span>
                                        <span className="text-emerald-300/90">
                                          FWD {fmtK(s.fwdCarryUsdM)}
                                        </span>
                                        <span className="text-sky-300/90">
                                          USD {fmtK(s.usdInterestUsdM)}
                                        </span>
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                      <span className="inline-flex flex-wrap items-baseline gap-x-2 font-mono tabular-nums">
                                        <span
                                          className={
                                            s.enhancementUsdM >= 0
                                              ? 'font-semibold text-emerald-200/90'
                                              : 'font-semibold text-rose-300'
                                          }
                                        >
                                          Enh {fmtK(s.enhancementUsdM)}
                                        </span>
                                        <span className="text-amber-300/90">
                                          Resid {fmtK(s.fcyInterestUsdM)}
                                        </span>
                                        <span className="text-sky-300/90">
                                          USD {fmtK(s.usdInterestUsdM)}
                                        </span>
                                        <span className="text-emerald-300/90">
                                          FWD {fmtK(s.fwdCarryUsdM)}
                                        </span>
                                        <span className="text-slate-400">
                                          Old {fmtK(-oldCarry)}
                                        </span>
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setWamChartView('execution')
                                        }
                                        className="ml-auto font-semibold text-violet-300/90 hover:text-violet-100"
                                      >
                                        Open Strip execution chart →
                                      </button>
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[720px] text-left text-[10px]">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="py-1 pr-2 font-medium">Rank</th>
                              <th className="py-1 pr-2 font-medium">Struct</th>
                              <th className="py-1 pr-2 font-medium">CoM</th>
                              <th className="py-1 pr-2 font-medium">Kurt</th>
                              <th className="py-1 pr-2 font-medium">Schedule</th>
                              <th
                                className="py-1 pr-2 text-right font-medium text-slate-300"
                                title="Total carry = Resid + FWD + USD"
                              >
                                Carry
                              </th>
                              <th
                                className="py-1 pr-2 text-right font-medium text-emerald-200/80"
                                title="Enhancement = Carry − Old"
                              >
                                Enh
                              </th>
                              <th className="py-1 text-right font-medium text-sky-200/80">
                                vs bullet
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {stripShapeOpt.top.map((c, i) => {
                              const active =
                                shapePreview != null &&
                                c.legCount === shapePreview.legCount &&
                                Math.abs(
                                  c.centerOfMass - shapePreview.centerOfMass,
                                ) < 0.03 &&
                                Math.abs(c.kurtosis - shapePreview.kurtosis) <
                                  0.03;
                              const staged =
                                appliedShapeScore != null &&
                                c.legCount === appliedShapeScore.legCount &&
                                Math.abs(
                                  c.centerOfMass -
                                    appliedShapeScore.centerOfMass,
                                ) < 0.03 &&
                                Math.abs(
                                  c.kurtosis - appliedShapeScore.kurtosis,
                                ) < 0.03 &&
                                c.settleScheduleLabel ===
                                  appliedShapeScore.settleScheduleLabel;
                              const totalCarry =
                                c.newCarryUsdM + c.fwdCarryUsdM;
                              return (
                                <tr
                                  key={`rank-${i}-${c.legCount}-${c.centerOfMass}-${c.kurtosis}-${c.settleScheduleLabel}-${c.enhancementUsdM.toFixed(6)}`}
                                  className={`cursor-pointer border-t border-slate-800/80 font-mono text-slate-300 hover:bg-slate-800/50${
                                    staged
                                      ? ' bg-emerald-500/15'
                                      : active
                                        ? ' bg-violet-500/10'
                                        : ''
                                  }`}
                                  onClick={() => applyStripShapeAroundWam(c)}
                                  title="Apply this strip locally · Assign/Prebook to stage to Analytics + Neon"
                                >
                                  <td className="py-1.5 pr-2 text-slate-500">
                                    {i + 1}
                                  </td>
                                  <td className="py-1.5 pr-2 text-violet-300/90">
                                    {c.structure === 'bullet'
                                      ? 'bullet'
                                      : `strip · ${c.legCount}`}
                                  </td>
                                  <td className="py-1.5 pr-2 text-amber-200/90">
                                    {c.structure === 'bullet'
                                      ? '—'
                                      : `${(c.centerOfMass * 100).toFixed(0)}%`}
                                  </td>
                                  <td className="py-1.5 pr-2 text-sky-200/90">
                                    {c.structure === 'bullet'
                                      ? '—'
                                      : c.kurtosis.toFixed(1)}
                                  </td>
                                  <td className="py-1.5 pr-2 text-slate-400">
                                    {c.settleScheduleLabel}
                                  </td>
                                  <td
                                    className={`py-1.5 pr-2 text-right font-semibold ${
                                      totalCarry >= 0
                                        ? 'text-slate-100'
                                        : 'text-rose-300'
                                    }`}
                                  >
                                    {fmtK(totalCarry)}
                                  </td>
                                  <td
                                    className={`py-1.5 pr-2 text-right font-semibold ${
                                      c.enhancementUsdM >= 0
                                        ? 'text-emerald-100'
                                        : 'text-rose-300'
                                    }`}
                                  >
                                    {fmtK(c.enhancementUsdM)}
                                  </td>
                                  <td
                                    className={`py-1.5 text-right ${
                                      c.vsBulletUsdM >= 0
                                        ? 'text-sky-200/90'
                                        : 'text-rose-300/80'
                                    }`}
                                  >
                                    {fmtK(c.vsBulletUsdM)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[10px] text-slate-500">
                        Click a rank row to Apply the shape locally. Use
                        Assign/Prebook above to stage it to Analytics / Neon.
                      </p>
                    </>
                  )}
                </section>

                <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">
                  5 · Hedge path
                </div>
                <ExposureHedgePathChart
                  // Do not key on pathBasis / pathStructure — remounting
                  // resets gear (stripScheduleOpen) and aborts setup edits.
                  key={`${chartCcy}-${setup.horizon}-${setup.forecastMonths}-${setup.exposureBasis}-${hasRollingStripForCcy(bookedHedges, chartCcy) ? 'strip' : 'open'}`}
                  ccy={chartCcy}
                  stockM={pathStockM}
                  monthlyFlowM={pathFlowM}
                  monthlyFlows={pathFlows}
                  setup={setup}
                  marketRates={marketRates}
                  appliedHedgeLocalM={pathAppliedHedgeLocalM}
                  hedgeRatio={prepared?.hedgeRatio ?? 0}
                  equalVarHedgeLocalM={pathEqualVarLocalM}
                  endExposureM={pathEndExposureM}
                  selectedBasis={pathBasis}
                  onSelectedBasisChange={setPathBasis}
                  onApplyBasis={(b, structure) => {
                    setPathBasis(b);
                    if (structure) setPathStructure(structure);
                  }}
                  onBookHedgeProfile={bookPathHedgeProfile}
                  autoStagePrepared
                  summaryMetricsPlacement="none"
                  onSummaryMetricsChange={setPathSummaryMetrics}
                  performancePanelPlacement="external"
                  performancePanelHost={pathPerfPanelHost}
                  schedulePanelPlacement="external"
                  schedulePanelHost={pathSchedulePanelHost}
                  stripAlreadyBooked={hasRollingStripForCcy(
                    bookedHedges,
                    chartCcy,
                  )}
                  hedgeStructure={pathStructure}
                  onHedgeStructureChange={s => {
                    setPathStructure(s);
                    if (s === 'bullet') {
                      applyShapeStartingPoint(
                        {
                          legCount: 1,
                          centerOfMass: shapePreview?.centerOfMass ?? 0.5,
                          kurtosis: shapePreview?.kurtosis ?? 0,
                        },
                        { fromUser: true },
                      );
                    } else {
                      applyShapeStartingPoint(
                        {
                          legCount: Math.max(
                            2,
                            pathStripLegCount ?? shapePreview?.legCount ?? 2,
                          ),
                          centerOfMass: shapePreview?.centerOfMass ?? 0.5,
                          kurtosis: shapePreview?.kurtosis ?? 0,
                        },
                        { fromUser: true },
                      );
                    }
                  }}
                  stripLegCount={pathStripLegCount}
                  onStripLegCountChange={n => {
                    if (n == null) {
                      setPathStripLegCount(null);
                      return;
                    }
                    const legs = Math.max(2, n);
                    // Chart syncing from applied custom ends — keep schedule.
                    if (
                      pathScheduleEnds != null &&
                      pathScheduleEnds.length === legs
                    ) {
                      // Chart echo after Apply — keep custom settles; this
                      // stays local until Apply shape / Assign is clicked.
                      applyShapeStartingPoint(
                        {
                          legCount: legs,
                          centerOfMass: shapePreview?.centerOfMass ?? 0.5,
                          kurtosis: shapePreview?.kurtosis ?? 0,
                        },
                        { fromUser: true, keepSchedule: true },
                      );
                      return;
                    }
                    applyShapeStartingPoint(
                      {
                        legCount: legs,
                        centerOfMass: shapePreview?.centerOfMass ?? 0.5,
                        kurtosis: shapePreview?.kurtosis ?? 0,
                      },
                      { fromUser: true },
                    );
                  }}
                  scheduleEndMonths={pathScheduleEnds}
                  scheduleHedgeWeights={pathHedgeWeights}
                  onScheduleEndMonthsChange={ends => {
                    setPathScheduleEnds(ends);
                    if (ends != null && ends.length >= 2) {
                      setPathStripLegCount(ends.length);
                    } else {
                      setPathHedgeWeights(null);
                    }
                  }}
                  onScheduleHedgeWeightsChange={weights => {
                    setPathHedgeWeights(weights);
                  }}
                />
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

    </div>
  );
}
