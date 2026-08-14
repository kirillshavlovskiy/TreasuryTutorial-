'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DeskStepper } from '@/components/DeskStepper';
import { createPortal } from 'react-dom';
import {
  ExposureHedgePathChart,
  type HedgePathPrepareAction,
  type HedgePathSummaryMetrics,
} from '@/components/test-mode/ExposureHedgePathChart';
import {
  chipsFromPathSummary,
  HedgeStagingHeader,
} from '@/components/test-mode/HedgeStagingHeader';
import {
  DEFAULT_FORECAST_PROFILE,
  monthlyFlowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import type { RowState } from '@/lib/fx-buffer';
import type { FcyComputedRow } from '@/lib/dashboard-model';
import type { LiquidityBookingMode, LiquiditySizingBasis } from '@/lib/liquidity-ladder';
import { LiquiditySwapDecision } from '@/components/LiquiditySwapDecision';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  hedgeBasisNotionalLocalM,
  hedgeRatioForNumber,
  inferHedgePathBasis,
  resolveChartMonthlyFlows,
  resyncHedgeRatiosToNearestRegime,
  type HedgePathBasisId,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  buildHedgeVarSummary,
  clearPreparedHedgeForCcy,
  equalVarLinearHedgeNotionalLocalM,
  isLiveHedgeTicket,
  newHedgeTicketId,
  overlayRiskFromFxBook,
  proposeBookHedge,
  setPreparedHedgeForCcy,
  varSetupWithLineUncertainty,
  type HedgeInstrument,
  type HedgeTicket,
  type PreparedHedgeLeg,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import { assignImpliedCarryFromSwapPoints } from '@/lib/test-mode/cash-carry-analytics';
import {
  resolveMarketRatesForCcy,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import {
  buildRollingHedgeEdges,
  bulletMaturityForForecast,
  clearRollingStripForCcy,
  hasRollingStripForCcy,
  mergeRollingStripIntoBook,
  needsRollingHedges,
  proposeRollingHedgeTickets,
  removeHedgeTicketOrStrip,
  resyncBookedRollingStrips,
  sizingForHedgePathBasis,
  varSetupForHedgeStructure,
  varSetupForPathHedgeRegime,
  type ForecastHedgeStructure,
  type RollingHedgeEdge,
} from '@/lib/test-mode/rolling-hedge';
import {
  type RiskPerspective,
  type RiskPerspectiveTabStat,
} from '@/components/test-mode/RiskPerspectiveSelector';
import {
  DEFAULT_VAR_SETUP,
  computeAnalyticsVarUsdM,
  computeParametricVarUsdM,
  horizonMonths,
  monthlyVolForSetup,
  VAR_EXPOSURE_OPTIONS,
  VAR_HORIZON_OPTIONS,
  type VarExposureBasis,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

const HEDGE_STEP_PCT = 10;

const BOOK_INSTRUMENTS: { id: HedgeInstrument; label: string }[] = [
  { id: 'spot', label: 'Spot' },
  { id: 'forward', label: 'Forward' },
  { id: 'option', label: 'Option' },
];

function fmtLocal(v: number, ccy: string): string {
  const abs = Math.abs(v).toFixed(2);
  const sign = v >= 0 ? '+' : '−';
  if (ccy === 'EUR') return `${sign}€${abs}M`;
  if (ccy === 'PLN') return `${sign}zł${abs}M`;
  if (ccy === 'GBP') return `${sign}£${abs}M`;
  return `${sign}${abs}M ${ccy}`;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

/**
 * Minimal dashed-underline click-to-apply control (Hedge Structuring card) —
 * "VaR-neutral · click to apply" style from the design: no border/background,
 * just a dashed emerald underline, matching the mockup exactly.
 */
function QuickApplyReadout({
  label,
  valueLocalM,
  ccy,
  varUsdM,
  disabled,
  onApply,
}: {
  label: string;
  valueLocalM: number;
  ccy: string;
  varUsdM: number;
  disabled: boolean;
  onApply: () => void;
}) {
  const empty = Math.abs(valueLocalM) < 1e-9;
  return (
    <button
      type="button"
      disabled={disabled || empty}
      onClick={onApply}
      title={`Click → apply ${label} as target · ${fmtLocal(valueLocalM, ccy)} · ${fmtVarK(varUsdM)}`}
      className="flex flex-col items-start gap-1 border-0 border-b border-dashed border-emerald-500/50 bg-transparent pb-0.5 text-left disabled:cursor-not-allowed disabled:border-transparent disabled:opacity-40"
    >
      <span className="text-[9px] uppercase tracking-wide text-emerald-400/80">
        {label} · click to apply
      </span>
      <span className="font-mono text-xs text-emerald-300">
        {fmtLocal(valueLocalM, ccy)}
      </span>
    </button>
  );
}

/** Hedge add is % of Total expected (Target) — 0–100%. */
const MAX_HEDGE_PCT = 100;

function clampPct(pct: number): number {
  return Math.min(MAX_HEDGE_PCT, Math.max(0, pct));
}

function tenorLabel(id: VarHorizonId | null): string | null {
  if (!id) return null;
  return VAR_HORIZON_OPTIONS.find(h => h.id === id)?.label ?? id;
}

function ticketLabel(t: HedgeTicket): string {
  const side = t.amountLocalM >= 0 ? 'SELL' : 'BUY';
  const amt = fmtLocal(-t.amountLocalM, t.ccy);
  const tenor = t.maturityLabel ?? t.maturity;
  const base =
    t.instrument === 'spot'
      ? `${side} ${t.ccy} spot ${amt}`
      : t.instrument === 'option'
        ? `${side} ${t.ccy} opt ${tenor ?? ''} ${amt}`.replace(/\s+/g, ' ').trim()
        : `${side} ${t.ccy} fwd ${tenor ?? ''} ${amt}`.replace(/\s+/g, ' ').trim();
  return t.entityName ? `${base} · ${t.entityName}` : base;
}

/**
 * Strip leg shaping — how the target notional splits across legs.
 * `optimized` = derived from a real prepared strip this component didn't
 * build (e.g. the Cash Carry WAM shape-search) — settle/share come from
 * that package's actual legs, not a formula, and no preset button is "on".
 */
type StripShaping = 'equal' | 'front' | 'carry' | 'optimized';

/** Per-CCY structuring UI state — independent of the committed prepared profile. */
interface StructCfg {
  legCount: number;
  shaping: StripShaping;
  /** Settle month per leg — editable, may drift from the shaping preset. */
  t: number[];
  /** Share % per leg (of target) — editable, may not sum to 100. */
  sh: number[];
}

/** n settle months, equally spaced, last leg pinned to Tf (never left short). */
function stripSettleMonths(n: number, tf: number): number[] {
  const T = tf > 0 ? tf : 1;
  return Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    return k === n ? T : Math.max(0.5, Math.round(((k * T) / n) * 2) / 2);
  });
}

/**
 * Share weights (0–100, summing to 100) for a shaping preset.
 * `equal` = flat; `front` = front-loaded (early legs bigger, 1/(i+1)^1.4);
 * `carry` = back-loaded (later legs — longer tenor — carry more, i+1).
 */
function stripShareWeights(n: number, shaping: StripShaping): number[] {
  const w = Array.from({ length: n }, (_, i) =>
    shaping === 'equal' ? 1 : shaping === 'front' ? 1 / Math.pow(i + 1, 1.4) : i + 1,
  );
  const s = w.reduce((a, b) => a + b, 0);
  const out = w.map(x => Math.round((x / s) * 200) / 2);
  out[n - 1] = +(100 - out.slice(0, n - 1).reduce((a, b) => a + b, 0)).toFixed(1);
  return out;
}

/** Rescale arbitrary (possibly off-100) shares back to summing 100. */
function rebalanceShares(shares: readonly number[]): number[] {
  const s = shares.reduce((a, b) => a + b, 0);
  if (s <= 0) return shares.map(() => +(100 / shares.length).toFixed(1));
  const out = shares.map(x => Math.round((x / s) * 200) / 2);
  out[out.length - 1] = +(
    100 - out.slice(0, -1).reduce((a, b) => a + b, 0)
  ).toFixed(1);
  return out;
}

/** {t, sh} preset for a structure/legCount/shaping combination. */
function structPreset(
  structure: ForecastHedgeStructure,
  legCount: number,
  shaping: StripShaping,
  tf: number,
): { t: number[]; sh: number[] } {
  return structure === 'bullet'
    ? { t: [tf > 0 ? tf : 1], sh: [100] }
    : { t: stripSettleMonths(legCount, tf), sh: stripShareWeights(legCount, shaping) };
}

function fmtShare(v: number): string {
  return `${(Math.round(v * 10) / 10).toFixed(v % 1 ? 1 : 0)}%`;
}

interface HedgingDecisionLayerProps {
  risk: CurrencyRiskRow[];
  embedded?: boolean;
  title?: string;
  hedgeRatios?: Record<string, number>;
  onHedgeRatiosChange?: (ratios: Record<string, number>) => void;
  /** Booked hedge tickets — shared with Live Ladder for VaR recalculation. */
  bookedHedges?: HedgeTicket[];
  onBookedHedgesChange?: (tickets: HedgeTicket[]) => void;
  /** Analytics-prepared packages (not live until Send). */
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  onPreparedByCcyChange?: (next: Record<string, PreparedHedgeProfile>) => void;
  /** Entity/group scope for Market data swap-points carry on Prepare. */
  ratesScopeId?: string;
  /** DB-persisted market data per currency (Market data tab uploads). */
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  /** Shared with Analytics — bullet vs rolling strip. */
  hedgeStructure?: ForecastHedgeStructure;
  onHedgeStructureChange?: (s: ForecastHedgeStructure) => void;
  varSetup?: VarSetup;
  onBookHedge?: (ticket: HedgeTicket) => void;
  bookRows?: RowState[];
  forecastProfile?: ForecastProfileState;
  /** Desk-computed funded plan — the funding strip this module books first. */
  fcyComputed?: FcyComputedRow[];
  r_USD?: number;
  sizingBasis?: LiquiditySizingBasis;
  bookingMode?: LiquidityBookingMode;
  forecastMonths?: number;
  onSizingBasisChange?: (v: LiquiditySizingBasis) => void;
  onBookingModeChange?: (v: LiquidityBookingMode) => void;
}

/**
 * Decision layer — start at delta = 1 (unhedged), add hedge notional,
 * and read per-currency VaR before / after on the consolidated book.
 */
export function HedgingDecisionLayer({
  risk: seedRisk,
  embedded = true,
  title: _moduleTitle = 'Decision layer — Hedging (Δ → VaR)',
  hedgeRatios: controlledRatios,
  onHedgeRatiosChange,
  bookedHedges: controlledBooked,
  onBookedHedgesChange,
  preparedByCcy: controlledPrepared,
  onPreparedByCcyChange,
  ratesScopeId,
  marketRatesByCcy = {},
  hedgeStructure: controlledStructure,
  onHedgeStructureChange,
  varSetup = DEFAULT_VAR_SETUP,
  onBookHedge,
  bookRows,
  forecastProfile = DEFAULT_FORECAST_PROFILE,
  fcyComputed,
  r_USD,
  sizingBasis,
  bookingMode,
  forecastMonths,
  onSizingBasisChange,
  onBookingModeChange,
}: HedgingDecisionLayerProps) {
  const risk = useMemo(
    () =>
      overlayRiskFromFxBook(
        seedRisk,
        bookRows,
        varSetup,
        forecastProfile,
      ),
    [seedRisk, bookRows, varSetup, forecastProfile],
  );
  const [localRatios, setLocalRatios] = useState<Record<string, number>>({});
  const [localBooked, setLocalBooked] = useState<HedgeTicket[]>([]);
  const [localPrepared, setLocalPrepared] = useState<
    Record<string, PreparedHedgeProfile>
  >({});
  const [draft, setDraft] = useState<HedgeTicket | null>(null);
  const [chartCcy, setChartCcy] = useState<string | null>(null);
  const [pathSummaryMetrics, setPathSummaryMetrics] =
    useState<HedgePathSummaryMetrics | null>(null);
  const [pathPrepareAction, setPathPrepareAction] =
    useState<HedgePathPrepareAction | null>(null);
  const [pathBasis, setPathBasis] = useState<HedgePathBasisId>('varNeutral');
  /** bullet = one Tf forward; strip = rolling Th windows (when Tf > Th). */
  const [localStructure, setLocalStructure] =
    useState<ForecastHedgeStructure>('bullet');
  const hedgeStructure = controlledStructure ?? localStructure;
  const setHedgeStructure = (s: ForecastHedgeStructure) => {
    if (onHedgeStructureChange) onHedgeStructureChange(s);
    else setLocalStructure(s);
  };
  const ratios = controlledRatios ?? localRatios;
  const booked = controlledBooked ?? localBooked;
  const preparedByCcy = controlledPrepared ?? localPrepared;
  const setRatios = (next: Record<string, number>) => {
    if (onHedgeRatiosChange) onHedgeRatiosChange(next);
    else setLocalRatios(next);
  };
  const setBooked = (next: HedgeTicket[]) => {
    if (onBookedHedgesChange) onBookedHedgesChange(next);
    else setLocalBooked(next);
  };
  const setPreparedByCcy = (next: Record<string, PreparedHedgeProfile>) => {
    if (onPreparedByCcyChange) onPreparedByCcyChange(next);
    else setLocalPrepared(next);
  };

  const TfM =
    typeof varSetup.forecastMonths === 'number' && varSetup.forecastMonths > 0
      ? varSetup.forecastMonths
      : 0;
  const stripAvailable = needsRollingHedges(varSetup);
  const stripBooked = booked.some(t => Boolean(t.stripId));
  const effectiveStructure: ForecastHedgeStructure =
    stripAvailable && (hedgeStructure === 'strip' || stripBooked)
      ? 'strip'
      : 'bullet';
  /** Bullet sizes VaR at Th = Tf. Path VN uses totalBuildup when Analytics is stock. */
  const hedgeSizingSetup = useMemo(
    () => varSetupForHedgeStructure(varSetup, effectiveStructure),
    [varSetup, effectiveStructure],
  );
  const pathRegimeSetup = useMemo(
    () => varSetupForPathHedgeRegime(varSetup, effectiveStructure),
    [varSetup, effectiveStructure],
  );

  // If strip isn't available (Tf ≤ Th), keep state on bullet.
  useEffect(() => {
    if (!stripAvailable && hedgeStructure === 'strip') {
      setHedgeStructure('bullet');
    }
  }, [stripAvailable, hedgeStructure]);

  const monthlyFlowsByCcy = useMemo(() => {
    const out: Record<string, number[]> = {};
    const T = varSetup.forecastMonths;
    if (T <= 0) return out;
    const rowsByCcy = new Map((bookRows ?? []).map(r => [r.ccy, r]));
    for (const { bar } of risk) {
      if (bar.ccy === 'USD') continue;
      const row = rowsByCcy.get(bar.ccy);
      if (!row) continue;
      out[bar.ccy] = monthlyFlowSeriesLocalM(row, T, forecastProfile);
    }
    return out;
  }, [bookRows, forecastProfile, risk, varSetup.forecastMonths]);

  const summary = useMemo(
    () =>
      buildHedgeVarSummary(
        risk,
        ratios,
        hedgeSizingSetup,
        booked,
        monthlyFlowsByCcy,
        forecastProfile,
      ),
    [risk, ratios, hedgeSizingSetup, booked, monthlyFlowsByCcy, forecastProfile],
  );

  /** Re-snap Cash·VN·Target % and rebuild strips when Analytics setup changes. */
  const hedgeSetupSig = [
    varSetup.exposureBasis,
    varSetup.averagingConvention,
    varSetup.forecastMonths,
    varSetup.horizon,
    varSetup.confidencePct,
    varSetup.forecastUncertainty1m,
    JSON.stringify(forecastProfile.uncertainty1mByCcy ?? {}),
    // Effective σ₁ₘ, not just the source id — an edited override changes the
    // vol without changing which source is selected.
    monthlyVolForSetup(varSetup),
    hedgeSizingSetup.horizon,
    hedgeSizingSetup.exposureBasis,
  ].join('|');
  const prevHedgeSetupSig = useRef<string | null>(null);
  useEffect(() => {
    if (prevHedgeSetupSig.current === null) {
      prevHedgeSetupSig.current = hedgeSetupSig;
      return;
    }
    if (prevHedgeSetupSig.current === hedgeSetupSig) return;
    prevHedgeSetupSig.current = hedgeSetupSig;
    const synced = resyncHedgeRatiosToNearestRegime(summary.rows, ratios);
    if (synced) setRatios(synced);
    const bars = risk.map(r => ({
      ccy: r.bar.ccy,
      stockNetM: r.bar.stockNetM,
      flowM: r.bar.flowM,
    }));
    const rebuilt = resyncBookedRollingStrips(
      booked,
      bars,
      varSetup,
      monthlyFlowsByCcy,
    );
    if (rebuilt) setBooked(rebuilt);
  }, [hedgeSetupSig, summary.rows, ratios, booked, risk, varSetup, monthlyFlowsByCcy]);

  const riskByCcy = useMemo(() => {
    const m = new Map<string, CurrencyRiskRow>();
    for (const r of risk) m.set(r.bar.ccy, r);
    return m;
  }, [risk]);

  const setRatio = (ccy: string, pct: number) => {
    // Manual: 0–100% of Total expected (Target).
    setRatios({
      ...ratios,
      [ccy]: clampPct(pct) / 100,
    });
  };

  const hedgeAll = (pct: number) => {
    const next: Record<string, number> = {};
    for (const r of summary.rows) next[r.ccy] = clampPct(pct) / 100;
    setRatios(next);
  };

  const openPathChart = (ccy: string) => {
    const r = summary.rows.find(row => row.ccy === ccy);
    if (!r) return;
    // Reopen on the regime that matches Live / Decision Hedge N.
    const inferred =
      Math.abs(r.hedgeNotionalLocalM) > 1e-9
        ? inferHedgePathBasis(
            r.hedgeNotionalLocalM,
            r.stockHedgeLocalM,
            r.targetHedgeLocalM,
            r.equalVarHedgeLocalM,
          )
        : 'varNeutral';
    setPathBasis(inferred);
    setChartCcy(ccy);
  };

  const closePathChart = () => setChartCcy(null);

  const chartRow = chartCcy
    ? summary.rows.find(r => r.ccy === chartCcy)
    : undefined;
  const chartBar = chartCcy
    ? risk.find(r => r.bar.ccy === chartCcy)?.bar
    : undefined;

  const applyPathBasis = (
    basis: HedgePathBasisId,
    structure?: ForecastHedgeStructure,
  ) => {
    if (!chartRow || !chartBar) return;
    setPathBasis(basis);
    const flowM =
      varSetup.forecastMonths > 0 && Math.abs(chartBar.flowM) > 1e-15
        ? chartBar.flowM
        : 0;
    const flowsForCcy = monthlyFlowsByCcy[chartRow.ccy];
    const { startM, endM, flows } = resolveChartMonthlyFlows(
      chartBar.stockNetM,
      flowM,
      varSetup,
      flowsForCcy,
    );
    // Prefer structure from the chart (avoids stale parent 'bullet' on Strip click).
    if (structure && structure !== hedgeStructure) {
      setHedgeStructure(structure);
    }
    // Never auto-book strips from path chips — only Decision %. Prepare/Send is explicit.
    if (hasRollingStripForCcy(booked, chartRow.ccy)) {
      setBooked(clearRollingStripForCcy(booked, chartRow.ccy));
    }
    if (preparedByCcy[chartRow.ccy]) {
      setPreparedByCcy(clearPreparedHedgeForCcy(preparedByCcy, chartRow.ccy));
    }
    const bulletEq = equalVarLinearHedgeNotionalLocalM(
      chartBar.stockNetM,
      flowM,
      chartRow.ccy,
      varSetupForPathHedgeRegime(varSetup, 'bullet'),
      undefined,
      flowsForCcy ?? flows,
    ).amountLocalM;
    const target = hedgeBasisNotionalLocalM(
      basis,
      startM,
      endM,
      bulletEq,
    );
    const target100 = Math.abs(chartRow.targetHedgeLocalM);
    const ratio =
      target100 < 1e-12
        ? 0
        : Math.min(1, hedgeRatioForNumber(target, chartRow.targetHedgeLocalM));
    setRatios({ ...ratios, [chartRow.ccy]: ratio });
  };

  const ticketBasisForPath = (
    basis: HedgePathBasisId,
  ): VarExposureBasis =>
    basis === 'cash'
      ? 'stock'
      : basis === 'totalExpected'
        ? 'totalBuildup'
        : varSetup.exposureBasis === 'stock'
          ? 'simpleAvg'
          : varSetup.exposureBasis;

  /** Path-chart Book → stage package under CCY (Send in Decision books it). */
  const bookHedgeProfileFromChart = (args: {
    structure: ForecastHedgeStructure;
    basis: HedgePathBasisId;
    edges: RollingHedgeEdge[];
    cashSettleByEdgeIndex?: Record<number, number>;
    bulletSettleMonths?: number;
    cashDeliveryAt?: 'periodEnd' | 'periodStart' | 'matchExposure';
    coverPct?: number;
  }) => {
    if (!chartRow || !chartBar) return;
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
    setHedgeStructure(structure);
    const ticketBasis = ticketBasisForPath(basis);
    const defaultTf =
      varSetup.forecastMonths || horizonMonths(varSetup.horizon);

    if (structure === 'strip' && edges.length > 1) {
      const coverLocalM = edges[edges.length - 1]?.hedgeLocalM ?? 0;
      const profile = assignImpliedCarryFromSwapPoints(
        {
          structure: 'strip',
          basis,
          ticketBasis,
          legs: edges.map(e => ({
            index: e.index,
            startMonth: e.startMonth,
            endMonth: e.endMonth,
            settleMonths: cashSettleByEdgeIndex?.[e.index] ?? e.endMonth,
            hedgeLocalM: e.hedgeLocalM,
            label: e.label,
            stockStartM: e.stockStartM,
            endExposureM: e.endExposureM,
          })),
          coverLocalM,
          hedgeRatio: coverPct,
          cashDeliveryAt,
        },
        {
          marketRates: resolveMarketRatesForCcy(
            marketRatesByCcy,
            chartRow.ccy,
            ratesScopeId,
          ),
          bulletSettleMonths: defaultTf,
        },
      );
      setPreparedByCcy(
        setPreparedHedgeForCcy(preparedByCcy, chartRow.ccy, {
          ...profile,
          preparedFor: 'var',
        }),
      );
      // Stay open — same as Cash Carry's Prebook: stage, don't dismiss.
      // The header shows a live "Prebooked" badge as confirmation.
      return;
    }

    // Bullet: stage one forward package; Decision % preview still via Apply chips.
    const flowM =
      varSetup.forecastMonths > 0 && Math.abs(chartBar.flowM) > 1e-15
        ? chartBar.flowM
        : 0;
    const flowsForCcy = monthlyFlowsByCcy[chartRow.ccy];
    const { startM, endM, flows } = resolveChartMonthlyFlows(
      chartBar.stockNetM,
      flowM,
      varSetup,
      flowsForCcy,
    );
    const bulletEq = equalVarLinearHedgeNotionalLocalM(
      chartBar.stockNetM,
      flowM,
      chartRow.ccy,
      varSetupForPathHedgeRegime(varSetup, 'bullet'),
      undefined,
      flowsForCcy ?? flows,
    ).amountLocalM;
    const target =
      hedgeBasisNotionalLocalM(basis, startM, endM, bulletEq) * coverPct;
    const target100 = Math.abs(chartRow.targetHedgeLocalM);
    const ratio =
      target100 < 1e-12
        ? 0
        : Math.min(1, hedgeRatioForNumber(target, chartRow.targetHedgeLocalM));
    const bulletSettleMonths = chartBulletSettle ?? defaultTf;
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'bullet',
        basis,
        ticketBasis,
        legs: [],
        coverLocalM: target,
        hedgeRatio: coverPctArg != null ? coverPct : ratio,
        cashDeliveryAt,
        settleMonths: bulletSettleMonths,
      },
      {
        marketRates: resolveMarketRatesForCcy(
          marketRatesByCcy,
          chartRow.ccy,
          ratesScopeId,
        ),
        bulletSettleMonths,
      },
    );
    setPreparedByCcy(
      setPreparedHedgeForCcy(preparedByCcy, chartRow.ccy, {
        ...profile,
        preparedFor: 'var',
      }),
    );
    // Stay open — same as Cash Carry's Prebook: stage, don't dismiss.
    // The header shows a live "Prebooked" badge as confirmation.
  };

  const discardPrepared = (ccy: string) => {
    setPreparedByCcy(clearPreparedHedgeForCcy(preparedByCcy, ccy));
  };

  /** Commit Analytics-prepared package onto the live Decision book. */
  const sendPreparedToDecision = (ccy: string) => {
    const prep = preparedByCcy[ccy];
    const row = summary.rows.find(r => r.ccy === ccy);
    const riskRow = riskByCcy.get(ccy);
    if (!prep || !row || !riskRow) return;

    if (prep.structure === 'strip' && prep.legs.length > 1) {
      const edges: RollingHedgeEdge[] = prep.legs.map(l => ({
        index: l.index,
        startMonth: l.startMonth,
        endMonth: l.endMonth,
        hedgeLocalM: l.hedgeLocalM,
        label: l.label,
        stockStartM: l.stockStartM ?? 0,
        endExposureM: l.endExposureM ?? 0,
      }));
      const settleMonthsByEdgeIndex: Record<number, number> = {};
      for (const l of prep.legs) {
        settleMonthsByEdgeIndex[l.index] = l.settleMonths ?? l.endMonth;
      }
      const tickets = proposeRollingHedgeTickets(
        ccy,
        edges,
        varSetup,
        prep.ticketBasis,
        monthlyFlowsByCcy[ccy] ?? [],
        settleMonthsByEdgeIndex,
      );
      setBooked(mergeRollingStripIntoBook(booked, tickets, ccy));
      setRatios({ ...ratios, [ccy]: 0 });
      for (const t of tickets) {
        if (isLiveHedgeTicket(t)) onBookHedge?.(t);
      }
      setPreparedByCcy(clearPreparedHedgeForCcy(preparedByCcy, ccy));
      return;
    }

    // Bullet → one forward ticket at cash-delivery settle (default Tf).
    if (Math.abs(prep.coverLocalM) < 1e-9) return;
    const template = proposeBookHedge(riskRow, prep.ticketBasis, varSetup);
    const settleM =
      prep.settleMonths != null
        ? prep.settleMonths
        : varSetup.forecastMonths > 0
          ? varSetup.forecastMonths
          : horizonMonths(varSetup.horizon);
    const maturity = bulletMaturityForForecast(settleM, varSetup.horizon);
    const maturityLabel =
      VAR_HORIZON_OPTIONS.find(h => h.id === maturity)?.label ?? maturity;
    const settleTag =
      prep.cashDeliveryAt === 'periodStart'
        ? 'period start'
        : prep.cashDeliveryAt === 'matchExposure'
          ? 'e ∩ H'
          : 'Tf';
    const ticket: HedgeTicket = {
      ...template,
      id: newHedgeTicketId(),
      instrument: 'forward',
      amountLocalM: prep.coverLocalM,
      maturity,
      maturityLabel: `${maturityLabel} · bullet ${settleTag}`,
      varUsdM: computeParametricVarUsdM(prep.coverLocalM, ccy, {
        ...varSetup,
        horizon: maturity,
      }),
    };
    const withoutStrip = hasRollingStripForCcy(booked, ccy)
      ? clearRollingStripForCcy(booked, ccy)
      : booked;
    setBooked([ticket, ...withoutStrip]);
    setRatios({ ...ratios, [ccy]: 0 });
    onBookHedge?.(ticket);
    setPreparedByCcy(clearPreparedHedgeForCcy(preparedByCcy, ccy));
  };

  const openBookModal = (ccy: string) => {
    const row = riskByCcy.get(ccy);
    if (!row) return;
    // Book the Decision Hedge N (Target × %), defaulting to full Target.
    const net = summary.rows.find(r => r.ccy === ccy);
    const targetN = net?.targetHedgeLocalM ?? 0;
    if (Math.abs(targetN) < 1e-9) return;
    const ratio = ratios[ccy] ?? 0;
    const bookRatio = ratio > 1e-9 ? ratio : 1;
    const template = proposeBookHedge(row, varSetup.exposureBasis, varSetup);
    const amountLocalM = targetN * bookRatio;
    // Bullet: one forward covering full forecast; else VaR-horizon tenor.
    const useBulletTenor =
      hedgeStructure !== 'strip' || !needsRollingHedges(varSetup);
    const maturity = useBulletTenor
      ? bulletMaturityForForecast(
          varSetup.forecastMonths,
          varSetup.horizon,
        )
      : varSetup.horizon;
    const maturityLabel =
      VAR_HORIZON_OPTIONS.find(h => h.id === maturity)?.label ?? maturity;
    const ticket: HedgeTicket = {
      ...template,
      instrument: 'forward',
      amountLocalM,
      maturity,
      maturityLabel: useBulletTenor
        ? `${maturityLabel} · bullet Tf`
        : maturityLabel,
      varUsdM: computeParametricVarUsdM(amountLocalM, ccy, {
        ...varSetup,
        horizon: maturity,
      }),
    };
    if (Math.abs(ticket.amountLocalM) < 1e-9) return;
    setDraft(ticket);
  };

  const confirmBook = (edited: HedgeTicket) => {
    // Each confirm appends a new transaction; incremental hedge % resets on the net book.
    const ticket: HedgeTicket = { ...edited, id: newHedgeTicketId() };
    setBooked([ticket, ...booked]);
    setRatios({ ...ratios, [ticket.ccy]: 0 });
    onBookHedge?.(ticket);
    setDraft(null);
  };

  /** Cancel one ticket, or the whole strip if it belongs to a roll. */
  const requestCancellation = (ticket: HedgeTicket) => {
    setBooked(removeHedgeTicketOrStrip(booked, ticket));
    setRatios({ ...ratios, [ticket.ccy]: 0 });
  };

  const rollingStrip = useMemo(() => {
    if (!stripAvailable || effectiveStructure !== 'strip') return null;
    const eur = risk.find(r => r.bar.ccy === 'EUR') ?? risk[0];
    if (!eur) return null;
    const flowM =
      varSetup.forecastMonths > 0 && Math.abs(eur.bar.flowM) > 1e-15
        ? eur.bar.flowM
        : 0;
    const row = bookRows?.find(r => r.ccy === eur.bar.ccy);
    const custom =
      row && forecastProfile.mode === 'custom'
        ? monthlyFlowSeriesLocalM(row, varSetup.forecastMonths, forecastProfile)
        : undefined;
    const { flows, startM, endM } = resolveChartMonthlyFlows(
      eur.bar.stockNetM,
      flowM,
      varSetup,
      custom,
    );
    // Same Cash / VN / Target sizing as the path-chart regime (not Analytics
    // profile → Target). Growth-path Analytics used to force windowEnd (=9.1).
    const sizing = sizingForHedgePathBasis(pathBasis);
    const edges = buildRollingHedgeEdges(startM, flows, varSetup, sizing, {
      ccy: eur.bar.ccy,
      varSetup,
    });
    if (edges.length < 2) return null;
    return { ccy: eur.bar.ccy, edges, endM, sizing };
  }, [
    risk,
    varSetup,
    bookRows,
    forecastProfile,
    stripAvailable,
    effectiveStructure,
    pathBasis,
  ]);

  const stripAlreadyBooked =
    rollingStrip != null && hasRollingStripForCcy(booked, rollingStrip.ccy);
  const stripAlreadyPrepared =
    rollingStrip != null &&
    preparedByCcy[rollingStrip.ccy]?.structure === 'strip';

  /** Stage EUR/default strip for Decision Send (does not book live). */
  const prepareRollingStrip = () => {
    if (!rollingStrip || stripAlreadyBooked) return;
    setHedgeStructure('strip');
    const ticketBasis =
      rollingStrip.sizing === 'stockStart'
        ? 'stock'
        : rollingStrip.sizing === 'windowEnd'
          ? 'totalBuildup'
          : varSetup.exposureBasis === 'stock'
            ? 'simpleAvg'
            : varSetup.exposureBasis;
    const coverLocalM =
      rollingStrip.edges[rollingStrip.edges.length - 1]?.hedgeLocalM ?? 0;
    const profile = assignImpliedCarryFromSwapPoints(
      {
        structure: 'strip',
        basis: pathBasis,
        ticketBasis,
        legs: rollingStrip.edges.map(e => ({
          index: e.index,
          startMonth: e.startMonth,
          endMonth: e.endMonth,
          hedgeLocalM: e.hedgeLocalM,
          label: e.label,
          stockStartM: e.stockStartM,
          endExposureM: e.endExposureM,
        })),
        coverLocalM,
        hedgeRatio: 0,
      },
      {
        marketRates: resolveMarketRatesForCcy(
          marketRatesByCcy,
          rollingStrip.ccy,
          ratesScopeId,
        ),
        bulletSettleMonths:
          varSetup.forecastMonths || horizonMonths(varSetup.horizon),
      },
    );
    setPreparedByCcy(
      setPreparedHedgeForCcy(preparedByCcy, rollingStrip.ccy, {
        ...profile,
        preparedFor: 'var',
      }),
    );
  };

  /**
   * Hedge Structuring — per-CCY expand/collapse card (structure/legs/shaping)
   * on top of the existing prepared-package pipeline. `structCfg` only tracks
   * the editable leg layout (settle/share); the committed `PreparedHedgeProfile`
   * itself still lives in `preparedByCcy`, same as every other prepare path in
   * this file, so Send/Discard/Book below are unchanged.
   */
  const [structCcy, setStructCcy] = useState<string | null>(null);
  const [structCfg, setStructCfg] = useState<Record<string, StructCfg>>({});

  /**
   * First-touch cfg for a CCY: if a real strip is already prepared (booked
   * elsewhere — Cash Carry's WAM shape-search, a rolling-strip Prepare, etc.)
   * read its actual legs so opening this card / nudging the ratio can never
   * silently discard that shape for a generic equal/3-leg default. Only a
   * fresh CCY with nothing prepared gets the equal/3-leg starting point.
   */
  const deriveStructCfg = (ccy: string): StructCfg => {
    const prep = preparedByCcy[ccy];
    if (prep?.structure === 'strip' && prep.legs.length >= 2) {
      const total = prep.coverLocalM;
      let prevCum = 0;
      const t = prep.legs.map(l => l.settleMonths ?? l.endMonth);
      const sh = prep.legs.map(l => {
        const delta =
          l.tradeNotionalLocalM ?? l.hedgeLocalM - prevCum;
        prevCum = l.hedgeLocalM;
        return Math.abs(total) > 1e-9
          ? +((delta / total) * 100).toFixed(1)
          : 0;
      });
      return { legCount: prep.legs.length, shaping: 'optimized', t, sh };
    }
    const preset = structPreset('strip', 3, 'equal', TfM);
    return { legCount: 3, shaping: 'equal', t: preset.t, sh: preset.sh };
  };

  const ticketBasisForStruct = (basis: HedgePathBasisId): VarExposureBasis =>
    basis === 'cash'
      ? 'stock'
      : basis === 'totalExpected'
        ? 'totalBuildup'
        : varSetup.exposureBasis === 'stock'
          ? 'simpleAvg'
          : varSetup.exposureBasis;

  const buildStructuredProfile = (
    ccy: string,
    targetLocalM: number,
    structure: ForecastHedgeStructure,
    cfg: StructCfg,
    basis: HedgePathBasisId,
  ): PreparedHedgeProfile => {
    const rates = resolveMarketRatesForCcy(marketRatesByCcy, ccy, ratesScopeId);
    const bulletTf = TfM > 0 ? TfM : horizonMonths(varSetup.horizon);
    if (structure === 'bullet' || cfg.t.length < 2) {
      return assignImpliedCarryFromSwapPoints(
        {
          structure: 'bullet',
          basis,
          ticketBasis: ticketBasisForStruct(basis),
          legs: [],
          coverLocalM: targetLocalM,
          hedgeRatio: 0,
          settleMonths: cfg.t[0] ?? bulletTf,
        },
        { marketRates: rates, bulletSettleMonths: bulletTf },
      );
    }
    let cum = 0;
    const legs: PreparedHedgeLeg[] = cfg.t.map((t, i) => {
      const tradeNotionalLocalM = (targetLocalM * (cfg.sh[i] ?? 0)) / 100;
      cum += tradeNotionalLocalM;
      return {
        index: i,
        startMonth: 0,
        endMonth: t,
        settleMonths: t,
        hedgeLocalM: cum,
        tradeNotionalLocalM,
        label: `L${i + 1}`,
      };
    });
    return assignImpliedCarryFromSwapPoints(
      {
        structure: 'strip',
        basis,
        ticketBasis: ticketBasisForStruct(basis),
        legs,
        coverLocalM: cum,
        hedgeRatio: 0,
      },
      { marketRates: rates, bulletSettleMonths: bulletTf },
    );
  };

  const structPctFor = (ccy: string) => Math.round((ratios[ccy] ?? 0) * 100);
  const structureFor = (ccy: string): ForecastHedgeStructure =>
    preparedByCcy[ccy]?.structure ?? 'bullet';

  const commitStructured = (
    ccy: string,
    ratioPct: number,
    structure: ForecastHedgeStructure,
    cfg: StructCfg,
    basis: HedgePathBasisId = pathBasis,
  ) => {
    const row = summary.rows.find(r => r.ccy === ccy);
    if (!row) return;
    const targetLocalM = row.targetHedgeLocalM * (ratioPct / 100);
    if (Math.abs(targetLocalM) < 1e-9) {
      setPreparedByCcy(clearPreparedHedgeForCcy(preparedByCcy, ccy));
      return;
    }
    const profile = buildStructuredProfile(
      ccy,
      targetLocalM,
      structure,
      cfg,
      basis,
    );
    setPreparedByCcy(
      setPreparedHedgeForCcy(preparedByCcy, ccy, {
        ...profile,
        preparedFor: 'var',
      }),
    );
  };

  /** Cash / VaR-neutral / Target quick-apply — sets ratio and restructures. */
  const applyStructRegime = (
    ccy: string,
    targetLocalM: number,
    basis: HedgePathBasisId,
  ) => {
    const row = summary.rows.find(r => r.ccy === ccy);
    if (!row || Math.abs(row.targetHedgeLocalM) < 1e-9) return;
    setPathBasis(basis);
    const ratio = Math.min(
      1,
      hedgeRatioForNumber(targetLocalM, row.targetHedgeLocalM),
    );
    setRatios({ ...ratios, [ccy]: ratio });
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    commitStructured(ccy, ratio * 100, structureFor(ccy), cfg, basis);
  };

  const setStructRatio = (ccy: string, pct: number) => {
    setRatio(ccy, pct);
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    commitStructured(ccy, pct, structureFor(ccy), cfg);
  };

  const setStructStructure = (ccy: string, structure: ForecastHedgeStructure) => {
    const prev = structCfg[ccy] ?? deriveStructCfg(ccy);
    const preset = structPreset(
      structure,
      structure === 'bullet' ? 1 : prev.legCount,
      prev.shaping,
      TfM,
    );
    const cfg: StructCfg = { ...prev, t: preset.t, sh: preset.sh };
    setStructCfg(p => ({ ...p, [ccy]: cfg }));
    commitStructured(ccy, structPctFor(ccy), structure, cfg);
  };

  const setStructLegCount = (ccy: string, n: number) => {
    const clamped = Math.max(2, Math.min(6, n));
    const prev = structCfg[ccy] ?? deriveStructCfg(ccy);
    const preset = structPreset('strip', clamped, prev.shaping, TfM);
    const cfg: StructCfg = { legCount: clamped, shaping: prev.shaping, t: preset.t, sh: preset.sh };
    setStructCfg(p => ({ ...p, [ccy]: cfg }));
    commitStructured(ccy, structPctFor(ccy), 'strip', cfg);
  };

  const setStructShaping = (ccy: string, shaping: StripShaping) => {
    const prev = structCfg[ccy] ?? deriveStructCfg(ccy);
    const preset = structPreset('strip', prev.legCount, shaping, TfM);
    const cfg: StructCfg = { legCount: prev.legCount, shaping, t: preset.t, sh: preset.sh };
    setStructCfg(p => ({ ...p, [ccy]: cfg }));
    commitStructured(ccy, structPctFor(ccy), 'strip', cfg);
  };

  const legSettleStep = (ccy: string, i: number, dir: 1 | -1) => {
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    const t = cfg.t.map((v, j) =>
      j === i ? Math.max(0.5, Math.min(TfM || v, +(v + dir * 0.5).toFixed(1))) : v,
    );
    const next: StructCfg = { ...cfg, t };
    setStructCfg(p => ({ ...p, [ccy]: next }));
    commitStructured(ccy, structPctFor(ccy), 'strip', next);
  };

  const legShareStep = (ccy: string, i: number, dir: 1 | -1) => {
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    const sh = cfg.sh.map((v, j) => (j === i ? Math.max(0, Math.min(100, v + dir * 5)) : v));
    const next: StructCfg = { ...cfg, sh };
    setStructCfg(p => ({ ...p, [ccy]: next }));
    commitStructured(ccy, structPctFor(ccy), 'strip', next);
  };

  const rebalanceLegs = (ccy: string) => {
    const cfg = structCfg[ccy] ?? deriveStructCfg(ccy);
    const next: StructCfg = { ...cfg, sh: rebalanceShares(cfg.sh) };
    setStructCfg(p => ({ ...p, [ccy]: next }));
    commitStructured(ccy, structPctFor(ccy), 'strip', next);
  };

  const shell = embedded
    ? 'rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-200'
    : 'rounded-xl border border-gray-200 bg-white p-5 text-gray-900';
  const muted = embedded ? 'text-slate-500' : 'text-gray-500';
  const head = embedded ? 'text-slate-500' : 'text-gray-500';
  const border = embedded ? 'border-slate-800' : 'border-gray-200';

  /** FX Exposure overview — read-only per-currency snapshot (Cash Carry-style summary table). */
  const exposureOverviewRows = useMemo(() => {
    return summary.rows.map(r => {
      const riskRow = riskByCcy.get(r.ccy);
      const stockRaw = riskRow?.bar.stockNetM ?? r.stockHedgeLocalM;
      const flowRaw = riskRow?.bar.flowM ?? 0;
      const totalM = r.targetHedgeLocalM;
      const flowForVar =
        varSetup.forecastMonths > 0 && Math.abs(flowRaw) > 1e-15
          ? flowRaw
          : 0;
      const varStock = computeAnalyticsVarUsdM(stockRaw, 0, r.ccy, {
        ...varSetup,
        exposureBasis: 'stock',
      });
      const varTotal = computeAnalyticsVarUsdM(stockRaw, flowForVar, r.ccy, {
        ...varSetup,
        exposureBasis: 'totalBuildup',
      });
      const direction: 'long' | 'short' | 'flat' =
        Math.abs(totalM) < 1e-9 ? 'flat' : totalM > 0 ? 'long' : 'short';
      return {
        ccy: r.ccy,
        stockM: stockRaw,
        flowM: flowRaw,
        totalM,
        varStock,
        varTotal,
        direction,
      };
    });
  }, [summary.rows, riskByCcy, varSetup]);

  const exposureOverviewTotals = useMemo(
    () =>
      exposureOverviewRows.reduce(
        (a, r) => ({
          varStock: a.varStock + r.varStock,
          varTotal: a.varTotal + r.varTotal,
        }),
        { varStock: 0, varTotal: 0 },
      ),
    [exposureOverviewRows],
  );

  const perspectiveTabStats = useMemo((): Partial<
    Record<RiskPerspective, RiskPerspectiveTabStat>
  > => {
    const resid = summary.totalVarAfterUsdM;
    const residLabel =
      !Number.isFinite(resid) || Math.abs(resid) < 1e-12
        ? '—'
        : Math.abs(resid) >= 0.1
          ? `$${resid.toFixed(2)}M`
          : `$${(resid * 1000).toFixed(1)}K`;
    return {
      fxRisk: { value: residLabel, label: 'Resid VaR' },
    };
  }, [summary.totalVarAfterUsdM]);

  return (
    <div className={`space-y-4 ${shell}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-tight text-slate-50">
            Hedging Decision
          </h3>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            Resid VaR{' '}
            <span className="font-semibold text-slate-300">
              {perspectiveTabStats.fxRisk?.value ?? '—'}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {rollingStrip && (
            <button
              type="button"
              onClick={prepareRollingStrip}
              disabled={stripAlreadyBooked}
              title={
                stripAlreadyBooked
                  ? 'Strip already on the book — cancel it to rebook'
                  : stripAlreadyPrepared
                    ? `Replace prepared ${rollingStrip.edges.length}-leg strip — then Send under ${rollingStrip.ccy}`
                    : `Prepare ${rollingStrip.edges.length} forwards from M0 — Send under ${rollingStrip.ccy} to book`
              }
              className="rounded-md border border-violet-500/50 bg-violet-500/20 px-2.5 py-1 text-[11px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {stripAlreadyBooked
                ? 'Strip booked'
                : stripAlreadyPrepared
                  ? `Prepared ${rollingStrip.edges.length}-leg strip`
                  : `Prepare ${rollingStrip.edges.length}-leg strip`}
            </button>
          )}
          <button
            type="button"
            onClick={() => hedgeAll(0)}
            className="rounded-md border border-slate-600 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Unhedged
          </button>
          {varSetup.forecastMonths != null && (
            <span className="inline-flex items-baseline gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-2 py-0.5 text-[11px] text-slate-500">
              Tf
              <span className="font-mono font-semibold tabular-nums text-sky-200">
                {varSetup.forecastMonths === 0
                  ? '0m'
                  : `${varSetup.forecastMonths}m`}
              </span>
            </span>
          )}
        </div>
      </div>

      <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="VaR at Δ = 1"
          value={fmtVarK(summary.totalVarBeforeUsdM)}
          hint="Open book (before hedges) · undiversified Σ"
          embedded={embedded}
        />
        <Stat
          label="VaR after hedge"
          value={fmtVarK(summary.totalVarAfterUsdM)}
          hint={
            booked.length > 0 || summary.rows.some(r => r.hedgeRatio > 1e-9)
              ? 'Residual after booked / hedge %'
              : 'No hedge yet — same as Δ = 1'
          }
          embedded={embedded}
          accent
        />
        <Stat
          label="VaR reduction"
          value={fmtVarK(summary.varReductionUsdM)}
          hint={
            summary.totalVarBeforeUsdM > 1e-12
              ? `${((summary.varReductionUsdM / summary.totalVarBeforeUsdM) * 100).toFixed(0)}% cut`
              : 'Unhedged − residual'
          }
          embedded={embedded}
        />
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          FX Exposure overview
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead>
              <tr className={`border-b ${border} ${head}`}>
                <th className="py-2 pr-3 font-medium">CCY</th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Cash / Net FX book at t=0"
                >
                  Stock
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Forecast flow over the horizon"
                >
                  Flow
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Net FX Forecast = Stock + Flow — the hedge target"
                >
                  Net exposure
                </th>
                <th
                  className="py-2 pr-3 font-medium text-amber-300/90"
                  title="Undiversified VaR on Stock only"
                >
                  VaR (Stock)
                </th>
                <th
                  className="py-2 pr-3 font-medium text-emerald-300/80"
                  title="Undiversified VaR on Net exposure"
                >
                  VaR (Net)
                </th>
                <th className="py-2 font-medium">Direction</th>
              </tr>
            </thead>
            <tbody>
              {exposureOverviewRows.map(r => (
                <tr
                  key={r.ccy}
                  role="button"
                  tabIndex={0}
                  onClick={() => setStructCcy(r.ccy)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setStructCcy(r.ccy);
                    }
                  }}
                  title={`Structure ${r.ccy} hedge`}
                  className={`cursor-pointer border-b ${border}/60 hover:bg-violet-500/10${
                    r.direction === 'flat' ? ' opacity-50' : ''
                  }${structCcy === r.ccy ? ' bg-violet-500/10' : ''}`}
                >
                  <td className="py-2 pr-3 font-semibold text-white">
                    {r.ccy}
                  </td>
                  <td className="py-2 pr-3 font-mono text-slate-300">
                    {fmtLocal(r.stockM, r.ccy)}
                  </td>
                  <td
                    className={`py-2 pr-3 font-mono ${
                      Math.abs(r.flowM) < 1e-9
                        ? 'text-slate-600'
                        : 'text-slate-300'
                    }`}
                  >
                    {Math.abs(r.flowM) < 1e-9
                      ? '—'
                      : fmtLocal(r.flowM, r.ccy)}
                  </td>
                  <td className="py-2 pr-3 font-mono font-semibold text-violet-200">
                    {fmtLocal(r.totalM, r.ccy)}
                  </td>
                  <td className="py-2 pr-3 font-mono text-amber-300">
                    {fmtVarK(r.varStock)}
                  </td>
                  <td className="py-2 pr-3 font-mono font-semibold text-emerald-300">
                    {fmtVarK(r.varTotal)}
                  </td>
                  <td className="py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                        r.direction === 'long'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : r.direction === 'short'
                            ? 'bg-rose-500/15 text-rose-300'
                            : 'bg-slate-700/50 text-slate-500'
                      }`}
                    >
                      {r.direction}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            {exposureOverviewRows.length > 1 && (
              <tfoot>
                <tr className="bg-slate-900/40">
                  <td className="py-2 pr-3 font-semibold text-violet-200">
                    All CCY
                  </td>
                  <td
                    className={`py-2 pr-3 font-mono text-slate-500`}
                    colSpan={3}
                    title="FCY amounts don't sum across currencies — see VaR (USD) totals"
                  >
                    —
                  </td>
                  <td className="py-2 pr-3 font-mono font-semibold text-amber-300">
                    {fmtVarK(exposureOverviewTotals.varStock)}
                  </td>
                  <td className="py-2 pr-3 font-mono font-semibold text-emerald-300">
                    {fmtVarK(exposureOverviewTotals.varTotal)}
                  </td>
                  <td className="py-2" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Hedge structuring · adjust before booking
          </div>
          <div className="font-mono text-[9px] text-slate-600">
            {TfM}m horizon · {summary.rows.length} currencies ·{' '}
            {booked.length === 0 ? 'nothing booked' : `${booked.length} booked`}
          </div>
        </div>
        {summary.rows.map(r => {
              const riskRow = riskByCcy.get(r.ccy);
              const stockRaw = riskRow?.bar.stockNetM ?? r.stockHedgeLocalM;
              const flowRaw = riskRow?.bar.flowM ?? 0;
              const stockM = r.stockHedgeLocalM;
              const totalM = r.targetHedgeLocalM;
              const flowForVar =
                varSetup.forecastMonths > 0 && Math.abs(flowRaw) > 1e-15
                  ? flowRaw
                  : 0;
              const varNeutralM =
                varSetup.exposureBasis === 'stock'
                  ? (() => {
                      const eq = equalVarLinearHedgeNotionalLocalM(
                        stockRaw,
                        flowForVar,
                        r.ccy,
                        pathRegimeSetup,
                        undefined,
                        monthlyFlowsByCcy[r.ccy],
                      ).amountLocalM;
                      const sign = totalM >= 0 || stockM >= 0 ? 1 : -1;
                      return sign * Math.abs(eq);
                    })()
                  : r.equalVarHedgeLocalM;
              const varNeutralUsd = computeParametricVarUsdM(
                varNeutralM,
                r.ccy,
                pathRegimeSetup,
              );
              const flat = Math.abs(totalM) < 1e-9;
              const canBook = !flat;
              const prepared = preparedByCcy[r.ccy];
              const regimeLabel =
                prepared?.basis === 'cash'
                  ? 'Expected stock'
                  : prepared?.basis === 'totalExpected'
                    ? 'Target'
                    : prepared?.basis === 'varNeutral'
                      ? 'VaR-neutral'
                      : null;
              const bookedForCcy = booked
                .filter(t => t.ccy === r.ccy)
                .sort(
                  (a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0),
                );
              const preparedLegs =
                prepared?.structure === 'strip' && prepared.legs.length > 0
                  ? prepared.legs
                  : prepared
                    ? [
                        {
                          index: 0,
                          startMonth: 0,
                          endMonth: TfM,
                          settleMonths:
                            prepared.settleMonths != null
                              ? prepared.settleMonths
                              : TfM,
                          hedgeLocalM: prepared.coverLocalM,
                          label: `M0–M${Math.round(
                            prepared.settleMonths != null
                              ? prepared.settleMonths
                              : TfM,
                          )}`,
                          tradeNotionalLocalM: prepared.coverLocalM,
                          impliedCarryUsdM: prepared.impliedCarryUsdM,
                          swapPoints: prepared.swapPoints,
                          swapPointsSide: prepared.swapPointsSide,
                        },
                      ]
                    : [];
              const tradeCount =
                preparedLegs.length + bookedForCcy.length;
              const open = structCcy === r.ccy;
              const cfg = structCfg[r.ccy] ?? deriveStructCfg(r.ccy);
              const structure = structureFor(r.ccy);
              const isStrip = structure === 'strip';
              const sumShare = cfg.sh.reduce((a, b) => a + b, 0);
              const needsRebalance = isStrip && Math.abs(sumShare - 100) > 0.05;
              const shapeBtn = (on: boolean) =>
                `rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  on
                    ? 'bg-violet-500/25 text-violet-100'
                    : `${muted} hover:text-slate-300`
                }`;
              return (
                <div
                  key={r.ccy}
                  className={`rounded-lg border ${
                    open
                      ? 'border-violet-500/40 bg-slate-950/60'
                      : `${border} bg-slate-950/30`
                  }`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    title={`Structure ${r.ccy} hedge`}
                    onClick={() => setStructCcy(open ? null : r.ccy)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setStructCcy(open ? null : r.ccy);
                      }
                    }}
                    className={`flex cursor-pointer flex-wrap items-center gap-4 px-3 py-2.5 ${
                      flat ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="flex w-[120px] flex-none flex-col gap-0.5">
                      <span className="text-sm font-semibold text-violet-200">
                        {r.ccy}
                      </span>
                      <span className={`text-[9px] ${muted}`}>
                        {tradeCount === 0
                          ? isStrip
                            ? `${cfg.legCount} prepared strip`
                            : '1 prepared bullet'
                          : [
                              preparedLegs.length > 0
                                ? `${preparedLegs.length} prepared ${
                                    prepared?.structure === 'strip'
                                      ? 'strip'
                                      : 'bullet'
                                  }`
                                : null,
                              bookedForCcy.length > 0
                                ? `${bookedForCcy.length} booked`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                      </span>
                    </div>
                    <div className="flex w-[150px] flex-none flex-col gap-0.5">
                      <span className="text-[9px] uppercase tracking-wide text-slate-500">
                        Target (total)
                      </span>
                      <span className="font-mono text-xs font-semibold text-sky-300">
                        {fmtLocal(r.hedgeNotionalLocalM, r.ccy)}
                      </span>
                    </div>
                    <div className="flex w-[130px] flex-none flex-col gap-0.5">
                      <span className="text-[9px] uppercase tracking-wide text-slate-500">
                        Residual
                      </span>
                      <span
                        className={`font-mono text-xs ${
                          Math.abs(r.residualLocalM) < 1e-9
                            ? muted
                            : 'text-amber-300'
                        }`}
                      >
                        {fmtLocal(r.residualLocalM, r.ccy)}
                      </span>
                    </div>
                    <div className="flex w-[120px] flex-none flex-col gap-0.5">
                      <span className="text-[9px] uppercase tracking-wide text-slate-500">
                        VaR after
                      </span>
                      <span
                        className={`font-mono text-xs font-semibold ${
                          r.varAfterUsdM < r.varBeforeUsdM - 1e-9
                            ? 'text-emerald-300'
                            : 'text-amber-300'
                        }`}
                      >
                        {fmtVarK(r.varAfterUsdM)}
                      </span>
                    </div>
                    <div className="flex w-[120px] flex-none flex-col gap-0.5">
                      <span className="text-[9px] uppercase tracking-wide text-slate-500">
                        Carry
                      </span>
                      <span className="font-mono text-xs font-semibold text-emerald-300">
                        {prepared?.impliedCarryUsdM != null
                          ? fmtVarK(prepared.impliedCarryUsdM)
                          : '—'}
                      </span>
                    </div>
                    <span className="flex-1" />
                    <span className={`text-[10px] ${muted}`}>
                      {open ? 'Structuring' : 'Click to structure'}
                    </span>
                  </div>

                  {open && (
                    <div
                      className={`flex flex-col gap-3 border-t ${border} bg-slate-950/40 px-3 py-3.5`}
                    >
                      <div className="flex flex-wrap items-end gap-5">
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Cash (stock)
                          </span>
                          <span className={`font-mono text-xs ${muted}`}>
                            {fmtLocal(stockM, r.ccy)}
                          </span>
                        </div>
                        <QuickApplyReadout
                          label="VaR-neutral"
                          valueLocalM={varNeutralM}
                          ccy={r.ccy}
                          varUsdM={varNeutralUsd}
                          disabled={flat || Math.abs(varNeutralM) < 1e-9}
                          onApply={() =>
                            applyStructRegime(r.ccy, varNeutralM, 'varNeutral')
                          }
                        />
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Net exposure
                          </span>
                          <span className={`font-mono text-xs ${muted}`}>
                            {fmtLocal(totalM, r.ccy)}
                          </span>
                        </div>
                        <DeskStepper
                          label="Hedge"
                          value={Math.round(r.hedgeRatio * 100)}
                          min={0}
                          max={MAX_HEDGE_PCT}
                          step={1}
                          nudgeStep={HEDGE_STEP_PCT}
                          onChange={pct => setStructRatio(r.ccy, pct)}
                          formatValue={v => `${v}%`}
                          suffix={`→ ${fmtLocal(-r.hedgeNotionalLocalM, r.ccy)}`}
                          editable
                          disabled={flat}
                          tickValues={[0, 25, 50, 75, 100]}
                          className="min-w-[280px] w-[280px]"
                          title={
                            flat
                              ? 'No net exposure to hedge'
                              : `Scale hedge % of Target / Total expected (0–${MAX_HEDGE_PCT}%)`
                          }
                          ariaLabel="Hedge percent"
                        />
                        <div className="flex flex-col gap-1">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Target (total)
                          </span>
                          <span className="font-mono text-sm font-semibold text-sky-300">
                            {fmtLocal(r.hedgeNotionalLocalM, r.ccy)}
                          </span>
                        </div>
                      </div>

                      <div
                        className={`flex flex-wrap items-center gap-4 border-y ${border} py-2.5`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] uppercase tracking-wide text-slate-500">
                            Structure
                          </span>
                          <span className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5">
                            <button
                              type="button"
                              onClick={() => setStructStructure(r.ccy, 'bullet')}
                              className={shapeBtn(!isStrip)}
                            >
                              Bullet
                            </button>
                            <button
                              type="button"
                              disabled={!stripAvailable}
                              onClick={() => setStructStructure(r.ccy, 'strip')}
                              className={`${shapeBtn(isStrip)} disabled:cursor-not-allowed disabled:opacity-40`}
                            >
                              Strip
                            </button>
                          </span>
                        </div>

                        {isStrip && (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] uppercase tracking-wide text-slate-500">
                                Legs
                              </span>
                              <span className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setStructLegCount(r.ccy, cfg.legCount - 1)
                                  }
                                  className="flex h-5 w-5 items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800"
                                >
                                  −
                                </button>
                                <span className="w-3 text-center font-mono text-xs text-slate-100">
                                  {cfg.legCount}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setStructLegCount(r.ccy, cfg.legCount + 1)
                                  }
                                  className="flex h-5 w-5 items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800"
                                >
                                  +
                                </button>
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] uppercase tracking-wide text-slate-500">
                                Shaping
                              </span>
                              <span className="inline-flex rounded-lg border border-slate-700 bg-slate-950/60 p-0.5">
                                {(
                                  [
                                    { id: 'equal' as const, label: 'Equal' },
                                    { id: 'front' as const, label: 'Front-loaded' },
                                    { id: 'carry' as const, label: 'Carry-shaped' },
                                  ] as const
                                ).map(opt => (
                                  <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() =>
                                      setStructShaping(r.ccy, opt.id)
                                    }
                                    className={shapeBtn(cfg.shaping === opt.id)}
                                  >
                                    {opt.label}
                                  </button>
                                ))}
                              </span>
                              {cfg.shaping === 'optimized' && (
                                <span
                                  className="text-[9px] font-semibold uppercase tracking-wide text-violet-300/90"
                                  title="Legs match the prepared package as-is (e.g. Cash Carry's WAM shape-search) — picking a preset above replaces this shape"
                                >
                                  Optimized · as prepared
                                </span>
                              )}
                            </div>
                          </>
                        )}

                        <span className="flex-1" />
                        <span
                          className={`text-[10px] ${
                            needsRebalance ? 'text-amber-300' : muted
                          }`}
                        >
                          {isStrip
                            ? needsRebalance
                              ? `Σ share ${fmtShare(sumShare)} · off target`
                              : 'Σ share 100% · balanced'
                            : null}
                        </span>
                        {needsRebalance && (
                          <button
                            type="button"
                            onClick={() => rebalanceLegs(r.ccy)}
                            className="rounded border border-amber-700/50 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/20"
                          >
                            Rebalance to 100%
                          </button>
                        )}
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[720px] text-left text-[11px]">
                          <thead>
                            <tr className={muted}>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Leg
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Settle
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Share
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Notional
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium">
                                Cumulative H
                              </th>
                              <th className="py-0 pb-1.5 pr-3 font-medium text-emerald-300/70">
                                Implied carry
                              </th>
                              <th className="py-0 pb-1.5 font-medium">
                                Status
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {preparedLegs.map((leg, i) => {
                              const prev =
                                i > 0 ? preparedLegs[i - 1]!.hedgeLocalM : 0;
                              const delta = leg.hedgeLocalM - prev;
                              const settle = leg.settleMonths ?? leg.endMonth;
                              const settleLabel =
                                Math.abs(settle - Math.round(settle)) < 1e-6
                                  ? `M${Math.round(settle)}`
                                  : `t=${settle.toFixed(1)}`;
                              const carry =
                                leg.impliedCarryUsdM ??
                                (prepared?.structure === 'bullet'
                                  ? prepared.impliedCarryUsdM
                                  : undefined);
                              return (
                                <tr
                                  key={`${r.ccy}-prep-${leg.index}`}
                                  className={`border-t ${border}/80`}
                                >
                                  <td className="py-1.5 pr-3">
                                    <span className="inline-flex items-center gap-1.5">
                                      <span className="rounded bg-violet-500/20 px-1 py-0.5 text-[9px] font-semibold text-violet-200">
                                        FWD
                                      </span>
                                      <span className="font-mono text-slate-100">
                                        {isStrip ? `L${i + 1}` : leg.label}
                                      </span>
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    {isStrip ? (
                                      <span className="inline-flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            legSettleStep(r.ccy, i, -1)
                                          }
                                          className="flex h-[18px] w-[18px] items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800"
                                        >
                                          −
                                        </button>
                                        <span className="w-10 text-center font-mono text-amber-200/90">
                                          {settleLabel}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            legSettleStep(r.ccy, i, 1)
                                          }
                                          className="flex h-[18px] w-[18px] items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800"
                                        >
                                          +
                                        </button>
                                      </span>
                                    ) : (
                                      <span className="font-mono text-amber-200/90">
                                        {settleLabel}
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3">
                                    {isStrip ? (
                                      <span className="inline-flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={() =>
                                            legShareStep(r.ccy, i, -1)
                                          }
                                          className="flex h-[18px] w-[18px] items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800"
                                        >
                                          −
                                        </button>
                                        <span className="w-9 text-center font-mono text-slate-100">
                                          {fmtShare(cfg.sh[i] ?? 0)}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            legShareStep(r.ccy, i, 1)
                                          }
                                          className="flex h-[18px] w-[18px] items-center justify-center rounded border border-slate-700 bg-slate-950/60 text-slate-300 hover:bg-slate-800"
                                        >
                                          +
                                        </button>
                                      </span>
                                    ) : (
                                      <span className="font-mono text-slate-100">
                                        100%
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono font-semibold text-emerald-300">
                                    {fmtLocal(delta, r.ccy)}
                                  </td>
                                  <td className={`py-1.5 pr-3 font-mono ${muted}`}>
                                    {fmtLocal(leg.hedgeLocalM, r.ccy)}
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-emerald-300/90">
                                    {carry == null
                                      ? '—'
                                      : fmtVarK(Math.abs(carry) * 1000).replace(
                                          '$',
                                          carry >= 0 ? '+$' : '−$',
                                        )}
                                  </td>
                                  <td className={`py-1.5 text-[10px] ${muted}`}>
                                    {prepared
                                      ? [
                                          prepared.preparedFor === 'carry'
                                            ? 'Cash Carry'
                                            : 'prepared',
                                          regimeLabel,
                                        ]
                                          .filter(Boolean)
                                          .join(' · ')
                                      : '—'}
                                  </td>
                                </tr>
                              );
                            })}
                            {bookedForCcy.map(t => {
                              const scheduled = !isLiveHedgeTicket(t);
                              return (
                                <tr
                                  key={t.id}
                                  className={`border-t ${border}/80 bg-emerald-500/[0.04]`}
                                >
                                  <td className="py-1.5 pr-3">
                                    <span className="inline-flex items-center gap-1.5">
                                      <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold text-emerald-300">
                                        {t.instrument.toUpperCase()}
                                      </span>
                                      <span className="font-mono text-slate-100">
                                        {ticketLabel(t)}
                                      </span>
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-amber-200/90">
                                    {t.maturityLabel ?? t.maturity ?? '—'}
                                  </td>
                                  <td className={`py-1.5 pr-3 font-mono ${muted}`}>
                                    —
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono font-semibold text-emerald-300">
                                    {fmtLocal(t.amountLocalM, r.ccy)}
                                  </td>
                                  <td className={`py-1.5 pr-3 font-mono ${muted}`}>
                                    —
                                  </td>
                                  <td className="py-1.5 pr-3 font-mono text-slate-400">
                                    {fmtVarK(t.varUsdM)}
                                  </td>
                                  <td className="py-1.5 text-[10px]">
                                    <span
                                      className={
                                        scheduled
                                          ? 'text-amber-200'
                                          : 'text-emerald-300/80'
                                      }
                                    >
                                      {scheduled ? 'PENDING' : 'live'}
                                    </span>{' '}
                                    <button
                                      type="button"
                                      title={
                                        t.stripId
                                          ? 'Cancel entire rolling strip'
                                          : 'Cancel this hedge transaction'
                                      }
                                      onClick={() => requestCancellation(t)}
                                      className="ml-1 rounded border border-rose-600/40 bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-medium text-rose-300 hover:bg-rose-500/20"
                                    >
                                      {t.stripId ? 'Cancel strip' : 'Cancel'}
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        <span className="flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
                          <span className={muted}>
                            VaR @ Δ1{' '}
                            <span className="font-mono text-slate-300">
                              {fmtVarK(r.varBeforeUsdM)}
                            </span>
                          </span>
                          <span className={muted}>
                            Delta{' '}
                            <span className="font-mono text-amber-300">
                              {r.delta.toFixed(2)}
                            </span>
                          </span>
                          <span className={muted}>
                            Residual{' '}
                            <span className="font-mono text-slate-300">
                              {fmtLocal(r.residualLocalM, r.ccy)}
                            </span>
                          </span>
                          <span className={muted}>
                            VaR after{' '}
                            <span className="font-mono font-semibold text-emerald-300">
                              {fmtVarK(r.varAfterUsdM)}
                            </span>
                          </span>
                        </span>
                        <span className="flex-1" />
                        <button
                          type="button"
                          disabled={!prepared}
                          title="Discard prepared package"
                          onClick={() => discardPrepared(r.ccy)}
                          className="rounded-md border border-slate-600 px-3 py-1.5 text-[11px] font-semibold text-slate-400 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          Discard
                        </button>
                        <button
                          type="button"
                          disabled={flat}
                          title="Open exposure path + residual VaR charts"
                          onClick={() => openPathChart(r.ccy)}
                          className="rounded-md border border-violet-500/50 bg-violet-500/15 px-3 py-1.5 text-[11px] font-semibold text-violet-200 hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          Path charts
                        </button>
                        <button
                          type="button"
                          disabled={
                            !prepared || hasRollingStripForCcy(booked, r.ccy)
                          }
                          title="Book this prepared package onto the Decision book"
                          onClick={() => sendPreparedToDecision(r.ccy)}
                          className="rounded-md border border-emerald-600/60 bg-emerald-500/20 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          Send to decision book
                        </button>
                        <button
                          type="button"
                          disabled={!canBook}
                          title={
                            flat
                              ? 'No net exposure on this Analytics basis'
                              : 'Open book-hedge proposal (auto size & timeline)'
                          }
                          onClick={() => openBookModal(r.ccy)}
                          className="rounded-md border border-sky-600/50 bg-sky-500/10 px-3.5 py-1.5 text-[11px] font-semibold text-sky-300 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          Book hedge
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
      </div>

      <LiquiditySwapDecision
        rows={fcyComputed ?? []}
        r_USD={r_USD ?? 0}
        sizingBasis={sizingBasis ?? 'horizon'}
        bookingMode={bookingMode ?? 'rolling'}
        forecastMonths={forecastMonths ?? varSetup.forecastMonths ?? 1}
        onSizingBasisChange={onSizingBasisChange}
        onBookingModeChange={onBookingModeChange}
        embedded={embedded}
      />

      {draft && (
        <BookHedgeModal
          ticket={draft}
          varSetup={varSetup}
          onClose={() => setDraft(null)}
          onConfirm={confirmBook}
        />
      )}

      {chartCcy &&
        chartRow &&
        chartBar &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="decision-path-title"
            onClick={e => {
              if (e.target === e.currentTarget) closePathChart();
            }}
          >
            <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
              <div className="sticky top-0 z-30 shrink-0 border-b border-slate-800 bg-slate-900 px-4 pb-3 pt-4 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.75)]">
                <HedgeStagingHeader
                  titleId="decision-path-title"
                  title={`${chartCcy} — exposure path vs hedge`}
                  subtitle={
                    <>
                      Selected regime:{' '}
                      <span className="font-semibold text-violet-200">
                        {pathBasis === 'cash'
                          ? 'Cash (stock)'
                          : pathBasis === 'varNeutral'
                            ? 'VaR-neutral'
                            : 'Target (Total)'}
                      </span>
                    </>
                  }
                  chips={
                    pathSummaryMetrics
                      ? chipsFromPathSummary(pathSummaryMetrics)
                      : undefined
                  }
                  isPrebooked={Boolean(chartCcy && preparedByCcy[chartCcy])}
                  prepareAction={pathPrepareAction}
                  onClose={closePathChart}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
              <ExposureHedgePathChart
                key={`${chartRow.ccy}-${pathBasis}-${effectiveStructure}-${hedgeSizingSetup.horizon}-${varSetup.forecastMonths}-${varSetup.exposureBasis}-${hasRollingStripForCcy(booked, chartRow.ccy) ? 'strip' : 'open'}`}
                ccy={chartRow.ccy}
                stockM={chartBar.stockNetM}
                monthlyFlowM={
                  varSetup.forecastMonths > 0 &&
                  Math.abs(chartBar.flowM) > 1e-15
                    ? chartBar.flowM
                    : 0
                }
                monthlyFlows={monthlyFlowsByCcy[chartRow.ccy]}
                setup={varSetupWithLineUncertainty(
                  varSetup,
                  chartRow.ccy,
                  forecastProfile,
                )}
                marketRates={resolveMarketRatesForCcy(
                  marketRatesByCcy,
                  chartRow.ccy,
                  ratesScopeId,
                )}
                appliedHedgeLocalM={chartRow.hedgeNotionalLocalM}
                hedgeRatio={chartRow.hedgeRatio}
                equalVarHedgeLocalM={chartRow.equalVarHedgeLocalM}
                endExposureM={chartRow.openExposureLocalM}
                selectedBasis={pathBasis}
                onSelectedBasisChange={setPathBasis}
                onApplyBasis={applyPathBasis}
                onBookHedgeProfile={bookHedgeProfileFromChart}
                summaryMetricsPlacement="none"
                onSummaryMetricsChange={setPathSummaryMetrics}
                prepareCtaPlacement="external"
                onPrepareActionChange={setPathPrepareAction}
                stripAlreadyBooked={hasRollingStripForCcy(
                  booked,
                  chartRow.ccy,
                )}
                hedgeStructure={hedgeStructure}
                onHedgeStructureChange={setHedgeStructure}
              />
              </div>
            </div>
          </div>,
          document.body,
        )}
      </>
    </div>
  );
}

function BookHedgeModal({
  ticket,
  varSetup,
  onClose,
  onConfirm,
}: {
  ticket: HedgeTicket;
  varSetup: VarSetup;
  onClose: () => void;
  onConfirm: (ticket: HedgeTicket) => void;
}) {
  const defaultTenor: VarHorizonId =
    ticket.maturity && VAR_HORIZON_OPTIONS.some(h => h.id === ticket.maturity)
      ? ticket.maturity
      : varSetup.horizon;
  const [instrument, setInstrument] = useState<HedgeInstrument>(ticket.instrument);
  const [tenor, setTenor] = useState<VarHorizonId>(defaultTenor);

  const side = ticket.amountLocalM >= 0 ? 'Sell' : 'Buy';
  const basisLabel =
    VAR_EXPOSURE_OPTIONS.find(o => o.id === ticket.basis)?.label ?? ticket.basis;
  const activeBasisLabel =
    VAR_EXPOSURE_OPTIONS.find(o => o.id === varSetup.exposureBasis)?.label ??
    varSetup.exposureBasis;

  const draftTicket: HedgeTicket = useMemo(() => {
    if (instrument === 'spot') {
      return {
        ...ticket,
        instrument: 'spot',
        maturity: null,
        maturityLabel: null,
      };
    }
    return {
      ...ticket,
      instrument,
      maturity: tenor,
      maturityLabel: tenorLabel(tenor),
    };
  }, [ticket, instrument, tenor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="book-hedge-title"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl">
        <h4 id="book-hedge-title" className="text-base font-semibold text-white">
          Book hedge · {ticket.ccy}
        </h4>
        <p className="mt-1 text-xs text-slate-400">
          Size follows Hedge add % on the Analytics-selected exposure (
          {activeBasisLabel}) · {varSetup.confidencePct}% · {varSetup.horizon}. Choose instrument
          and tenor, then confirm.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Instrument
            </div>
            <div className="flex flex-wrap gap-1.5">
              {BOOK_INSTRUMENTS.map(opt => {
                const on = instrument === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setInstrument(opt.id)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      on
                        ? 'border-sky-500 bg-sky-500/20 text-sky-100'
                        : 'border-slate-700 text-slate-400 hover:border-slate-500'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {instrument !== 'spot' && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Tenor
              </div>
              <div className="flex flex-wrap gap-1.5">
                {VAR_HORIZON_OPTIONS.map(opt => {
                  const on = tenor === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setTenor(opt.id)}
                      className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        on
                          ? 'border-emerald-500 bg-emerald-500/20 text-emerald-100'
                          : 'border-slate-700 text-slate-400 hover:border-slate-500'
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

        <dl className="mt-4 space-y-2.5 text-sm">
          <Row term="Exposure basis" detail={
            <>
              {basisLabel}
              {ticket.addressesHigherVar && (
                <span className="ml-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                  higher VaR
                </span>
              )}
            </>
          } />
          <Row
            term="Timeline"
            detail={
              <span className="font-mono text-xs">
                {instrument === 'spot'
                  ? 'Spot (T+2)'
                  : `${instrument === 'option' ? 'Option' : 'Forward'} · ${tenorLabel(tenor)}`}
              </span>
            }
          />
          <Row
            term="Size (auto)"
            detail={
              <span className="font-mono font-semibold text-emerald-300">
                {side} {fmtLocal(Math.abs(ticket.amountLocalM), ticket.ccy).replace(/^[+−]/, '')}
              </span>
            }
          />
          <Row
            term="Offsets exposure"
            detail={
              <span className="font-mono text-xs text-slate-300">
                {fmtLocal(ticket.amountLocalM, ticket.ccy)}
              </span>
            }
          />
          <Row
            term="VaR addressed"
            detail={<span className="font-mono text-xs">{fmtVarK(ticket.varUsdM)}</span>}
          />
          <Row
            term="Ticket"
            detail={
              <span className="font-mono text-xs text-slate-300">{ticketLabel(draftTicket)}</span>
            }
          />
        </dl>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(draftTicket)}
            className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/30"
          >
            Confirm book
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ term, detail }: { term: string; detail: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-2">
      <dt className="text-[11px] text-slate-500">{term}</dt>
      <dd className="text-right text-xs text-slate-200">{detail}</dd>
    </div>
  );
}

function Stat({
  label, value, hint, embedded, accent,
}: {
  label: string;
  value: string;
  hint: string;
  embedded: boolean;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        embedded
          ? accent
            ? 'border-emerald-600/40 bg-emerald-500/10'
            : 'border-slate-800 bg-slate-950/50'
          : 'border-gray-200 bg-gray-50'
      }`}
    >
      <div className={`text-[11px] ${embedded ? 'text-slate-500' : 'text-gray-500'}`}>{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${accent ? 'text-emerald-300' : ''}`}>
        {value}
      </div>
      <div className={`text-[10px] ${embedded ? 'text-slate-600' : 'text-gray-400'}`}>{hint}</div>
    </div>
  );
}
