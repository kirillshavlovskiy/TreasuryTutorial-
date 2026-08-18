'use client';

/**
 * Liquidity perspective on Analytics — how the desk covers the dip in the dated
 * cash path under the live sizing/booking regime.
 *
 * Layout follows docs/design/liquidity-analytics-claude-design.md
 * (Entity Dashboard Create UI-3 · Liquidity Analytics).
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import { LiquidityFrontierModal } from '@/components/test-mode/LiquidityFrontierModal';
import {
  liquidityFrontierDial,
  liquidityFrontierDialLabel,
  signedPeakStanding,
} from '@/lib/test-mode/liquidity-frontier';
import {
  bufferConstraintLabel,
  cfarTailProbability,
  evaluateLiquidityStrategies,
  liquidityStrategyInputFrom,
  probabilityWeightedReturnUsdM,
  strategyBookCarryK,
  strategyForRegime,
  usdMToCarryK,
  type LiquidityAnalyticsSource,
  type LiquidityStrategy,
  type LiquidityStrategyCcy,
  type LiquidityStrategyId,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import {
  DEFAULT_LIQUIDITY_TIMING,
  resolveLiquidityTiming,
} from '@/lib/liquidity-ladder';
import {
  FORECAST_ACCURACY_LAYERS,
  toggleLayerGroup,
  type BufferChipKey,
  type LayerId,
} from '@/lib/fx-buffer';
import {
  VAR_CONFIDENCE_OPTIONS,
} from '@/lib/test-mode/var-confidence';

type LiquidityAnalyticsViewProps = LiquidityAnalyticsSource;

function fmtSignedK(usdM: number, decimals?: number): string {
  const k = usdM * 1000;
  if (!Number.isFinite(k) || Math.abs(k) < 0.05) return '$0K';
  const dec = decimals ?? (Math.abs(k) < 10 ? 1 : 0);
  const sign = k > 0 ? '+' : k < 0 ? '−' : '';
  return `${sign}$${Math.abs(k).toFixed(dec)}K`;
}

function fmtAbsK(usdM: number): string {
  const k = Math.abs(usdM * 1000);
  if (!Number.isFinite(k) || k < 0.05) return '$0K';
  return `$${k.toFixed(k < 10 ? 1 : 0)}K`;
}

function fmtM(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-12) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}M`;
}

function moneyTone(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-5) return 'text-slate-500';
  return usdM >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

function rowCarryUsdM(c: Pick<
  LiquidityStrategyCcy,
  'cashCarryUsdYrM' | 'hedgeCarryUsdYrM' | 'swapInterestUsdYrM' | 'swapPointsUsdYrM'
>): number {
  return (
    usdMToCarryK(c.cashCarryUsdYrM)
    + usdMToCarryK(c.hedgeCarryUsdYrM)
    + usdMToCarryK(c.swapInterestUsdYrM)
    + usdMToCarryK(c.swapPointsUsdYrM)
  ) / 1000;
}

function compactFundingSchedule(
  schedule: LiquidityStrategyCcy['schedule'],
): string {
  if (schedule.length === 0) return '—';
  const months = [...new Set(schedule.map(l => l.valueDateMonths + 1))]
    .filter(m => m > 0)
    .sort((a, b) => a - b);
  if (months.length === 0) return '—';
  if (months.length === 1) return `M${months[0]}`;
  const lo = months[0]!;
  const hi = months[months.length - 1]!;
  const consecutive = months.length === hi - lo + 1;
  if (consecutive) return `M${lo}–M${hi}`;
  if (months.length <= 4) return months.map(m => `M${m}`).join('/');
  return `M${lo}–M${hi} · ${months.length}`;
}

function fundingStructLabel(
  strategy: LiquidityStrategy,
  schedule: LiquidityStrategyCcy['schedule'],
): string {
  if (strategy.regime === null) return '—';
  const n = schedule.filter(l => Math.abs(l.newLeg) > 0.001).length;
  if (strategy.id === 'termSwap') return n <= 1 ? 'bullet' : `term · ${n}`;
  if (strategy.id === 'nearCycle') return n > 0 ? `near · ${n}` : 'near';
  return n > 0 ? `strip · ${n}` : 'strip';
}

function ChapterLabel({
  n,
  title,
  hint,
}: {
  n: number;
  title: string;
  hint?: string;
}) {
  return (
    <div className="mb-1.5 flex items-baseline gap-2 px-0.5">
      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-400">
        {n} · {title}
      </span>
      <span className="h-px flex-1 bg-slate-800" />
      {hint && (
        <span className="font-mono text-[9px] text-slate-500">{hint}</span>
      )}
    </div>
  );
}

const BUFFER_LAYERS: readonly {
  id: BufferChipKey;
  layers: readonly LayerId[];
  label: string;
  dial: string;
  hint: string;
  settingsLabel: string;
  onClass: string;
  onDot: string;
  onDial: string;
  gearOn: string;
  gearBorder: string;
}[] = [
  {
    id: 'floorH',
    layers: ['floorH'],
    label: 'Min floor',
    dial: 'Min floor',
    hint: 'Hard minimum cash per currency',
    settingsLabel: 'Minimum liquidity buffer per currency — hard cash floor (M FCY)',
    onClass: 'border-amber-400/45 bg-amber-500/15 text-amber-200',
    onDot: 'bg-amber-300',
    onDial: 'border-amber-400/45 text-slate-400',
    gearOn: 'bg-amber-500/30 text-amber-100',
    gearBorder: 'border-amber-400/45',
  },
  {
    id: 'forecastAccuracy',
    layers: FORECAST_ACCURACY_LAYERS,
    label: 'Forecast accuracy',
    dial: 'σ buffer',
    hint: 'Payout-σ safety margin on FCY cash — FX Net CFaR is a readout, not Swap Near',
    settingsLabel: 'Forecast accuracy — payout σ and Net CFaR cover per currency',
    onClass: 'border-sky-400/45 bg-sky-500/15 text-sky-200',
    onDot: 'bg-sky-300',
    onDial: 'border-sky-400/45 text-slate-400',
    gearOn: 'bg-sky-500/30 text-sky-100',
    gearBorder: 'border-sky-400/45',
  },
  {
    id: 'carryOptim',
    layers: ['carryOptim'],
    label: 'Buffer Carry target',
    dial: 'Target Carry',
    hint: 'Apply the rate-driven buffer target',
    settingsLabel: 'Buffer Carry target — standing-swap cash Δr ask, r_OD and Δr per currency',
    onClass: 'border-emerald-400/45 bg-emerald-500/15 text-emerald-200',
    onDot: 'bg-emerald-300',
    onDial: 'border-emerald-400/45 text-slate-400',
    gearOn: 'bg-emerald-500/30 text-emerald-100',
    gearBorder: 'border-emerald-400/45',
  },
  {
    id: 'portfolioDiv',
    layers: ['portfolioDiv'],
    label: 'Portfolio VAR',
    dial: 'Target VAR',
    hint: 'Apply the cross-currency portfolio VaR constraint',
    settingsLabel: 'Portfolio VAR — notional sensitivity limit',
    onClass: 'border-violet-400/45 bg-violet-500/15 text-violet-200',
    onDot: 'bg-violet-300',
    onDial: 'border-violet-400/45 text-slate-400',
    gearOn: 'bg-violet-500/30 text-violet-100',
    gearBorder: 'border-violet-400/45',
  },
];

function GearIcon({ className }: { className?: string }) {
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
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.9 1.01 1.55 1.01H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function LiquidityAnalyticsView({
  setup,
  bookRows,
  forecastProfile,
  bookedHedges,
  preparedByCcy,
  ratesScopeId,
  marketRatesByCcy,
  activeLayers,
  onLayerToggle,
  layerPanel,
  onLayerPanelChange,
  livePlanByCcy,
  swapForwardOverlayByCcy,
  cfarNetByCcyUsd,
  deskShared,
  deskHedgeCarryByCcyUsdM,
  deskCashCarryByCcyUsdM,
  deskCipByCcyUsdM,
  onSetupChange,
}: LiquidityAnalyticsViewProps) {
  const months = setup.forecastMonths;
  const timing = resolveLiquidityTiming(forecastProfile) ?? DEFAULT_LIQUIDITY_TIMING;
  const liveStrategy = strategyForRegime(
    timing.sizingBasis ?? 'horizon',
    timing.bookingMode ?? 'rolling',
  );

  const input = useMemo(
    () =>
      liquidityStrategyInputFrom({
        setup,
        bookRows,
        forecastProfile,
        bookedHedges,
        preparedByCcy,
        ratesScopeId,
        marketRatesByCcy,
        activeLayers,
        livePlanByCcy,
        swapForwardOverlayByCcy,
        cfarNetByCcyUsd,
        deskShared,
        deskHedgeCarryByCcyUsdM,
        deskCashCarryByCcyUsdM,
        deskCipByCcyUsdM,
      }),
    [
      setup,
      bookRows,
      forecastProfile,
      bookedHedges,
      preparedByCcy,
      ratesScopeId,
      marketRatesByCcy,
      activeLayers,
      livePlanByCcy,
      swapForwardOverlayByCcy,
      cfarNetByCcyUsd,
      deskShared,
      deskHedgeCarryByCcyUsdM,
      deskCashCarryByCcyUsdM,
      deskCipByCcyUsdM,
    ],
  );
  const rUsd = input.shared.r_USD;
  const results = useMemo(() => evaluateLiquidityStrategies(input), [input]);
  const [selectedId, setSelectedId] = useState<LiquidityStrategyId>(
    liveStrategy.id,
  );
  const [inspectCcy, setInspectCcy] = useState<string | null>(null);

  useEffect(() => {
    if (results.some(r => r.strategy.id === selectedId)) return;
    setSelectedId(liveStrategy.id);
  }, [results, selectedId, liveStrategy.id]);

  const frontierEngineInput = useMemo(
    () => ({
      months,
      shared: input.shared,
      activeLayers: input.activeLayers,
      forecastProfile,
      hedgeSettleByCcy: input.hedgeSettleByCcy,
      cfarNetByCcyUsd,
      setup,
      bookedHedges,
      preparedByCcy,
      marketRatesByCcy,
      ratesScopeId,
      swapForwardOverlayByCcy,
    }),
    [
      months,
      input.shared,
      input.activeLayers,
      input.hedgeSettleByCcy,
      forecastProfile,
      cfarNetByCcyUsd,
      setup,
      bookedHedges,
      preparedByCcy,
      marketRatesByCcy,
      ratesScopeId,
      swapForwardOverlayByCcy,
    ],
  );

  const selected =
    results.find(r => r.strategy.id === selectedId)
    ?? results.find(r => r.strategy.id === liveStrategy.id)
    ?? results[0];
  const unfunded = results.find(r => r.strategy.id === 'unfunded');
  const inspectRow = inspectCcy
    ? bookRows?.find(r => r.ccy === inspectCcy)
    : undefined;

  if (results.length === 0 || !selected) {
    return (
      <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-10 text-center text-xs text-slate-500">
        {months > 0
          ? 'No FCY book to fund — the liquidity path is built from the currency rows on the simulator.'
          : 'Pick a forecast period of 1 month or more: without a cash path there is no trough to cover.'}
      </div>
    );
  }

  const isLive = selected.strategy.id === liveStrategy.id;
  const book = strategyBookCarryK(selected.byCcy);
  const tailPct = (cfarTailProbability(setup.confidencePct) * 100).toFixed(0);
  const weightedUsdM = probabilityWeightedReturnUsdM(
    book.total / 1000,
    selected.finalCfarUsdM,
    setup.confidencePct,
    unfunded?.finalCfarUsdM ?? 0,
  );
  const dial = liquidityFrontierDial(input.activeLayers);
  const constraintHue =
    selected.constraint === 'var'
      ? 'text-sky-300'
      : selected.constraint === 'carry'
        ? 'text-emerald-300'
        : 'text-slate-300';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2.5 px-0.5">
        <span className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-400">
          r_USD {rUsd.toFixed(2)}%
        </span>
        <span className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-400">
          Tf {months}m
        </span>
        <span className="ml-auto max-w-[26rem] text-right font-mono text-[9px] leading-snug text-slate-500">
          prices the funding programme covering the dated-path dip — not a fourth risk metric
        </span>
      </div>

      <section>
        <ChapterLabel n={1} title="Summary" />
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <SummaryCard
            label="Total carry"
            value={fmtSignedK(book.total / 1000, 0)}
            sub={`Cash + FWD + Swap cash + CIP · ${selected.strategy.label.toLowerCase()}`}
            tone="carry"
            valueClass={moneyTone(book.total / 1000)}
          />
          <SummaryCard
            label={`Final CFaR · ${setup.confidencePct}%`}
            value={fmtAbsK(selected.finalCfarUsdM)}
            sub="FX section RSS with the funding-swap bridge"
            tone="risk"
          />
          <SummaryCard
            label="Weighted return"
            value={fmtSignedK(weightedUsdM)}
            sub={`Carry − standing CFaR × ${tailPct}%`}
            tone="sky"
            valueClass={weightedUsdM >= 0 ? 'text-sky-300' : 'text-rose-300'}
          />
          {isLive ? (
            <SummaryCard
              label="Live regime"
              value={selected.strategy.label}
              sub={`${bufferConstraintLabel(selected.constraint)} · ${selected.constraintDetail || 'No layer'}`}
              tone="live"
              valueClass="text-emerald-300 text-[15px] leading-tight"
            />
          ) : (
            <SummaryCard
              label="Preview"
              value={selected.strategy.label}
              sub={`Live regime is ${liveStrategy.label} · ${bufferConstraintLabel(selected.constraint)} · ${selected.constraintDetail || 'No layer'}`}
              tone="preview"
              valueClass="text-violet-300 text-[15px] leading-tight"
            />
          )}
        </div>
      </section>

      <section>
        <ChapterLabel n={2} title="Controls" />
        <div className="rounded-[10px] border border-slate-700 bg-slate-950/50 px-3 py-2.5">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="min-w-0">
              <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
                Confidence
              </div>
              <div
                className="inline-flex rounded-md border border-slate-700 bg-slate-950 p-0.5"
                role="group"
                aria-label="Confidence level"
              >
                {VAR_CONFIDENCE_OPTIONS.map(opt => {
                  const on = setup.confidencePct === opt.pct;
                  return (
                    <button
                      key={opt.pct}
                      type="button"
                      title={`z = ${opt.z} · CFaR tail ${(100 - opt.pct).toFixed(0)}%`}
                      disabled={!onSetupChange}
                      onClick={() => onSetupChange?.({ ...setup, confidencePct: opt.pct })}
                      className={`rounded px-3 py-1 font-mono text-[11px] font-semibold transition-colors ${
                        on
                          ? 'bg-blue-500/25 text-blue-100'
                          : 'text-slate-500 hover:text-slate-300'
                      } ${onSetupChange ? '' : 'cursor-default opacity-80'}`}
                    >
                      {opt.pct}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 font-mono text-[9px] leading-snug text-slate-500">
                Carry − standing CFaR × {tailPct}% (above origin)
              </div>
            </div>
            <div className="min-w-0 border-slate-800 md:border-l md:pl-6">
              <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
                Buffer regime
              </div>
              <div className="flex flex-wrap gap-1.5">
                {BUFFER_LAYERS.map(layer => {
                  const active = layer.layers.some(id => activeLayers?.has(id) ?? false);
                  const panelOpen = layerPanel === layer.id;
                  return (
                    <span
                      key={layer.id}
                      className={`inline-flex items-stretch overflow-hidden rounded-md border transition ${
                        active
                          ? layer.onClass
                          : 'border-slate-700 bg-slate-950/60 text-slate-500'
                      }`}
                    >
                      <button
                        type="button"
                        disabled={!onLayerToggle}
                        aria-pressed={active}
                        onClick={() => {
                          if (!onLayerToggle) return;
                          toggleLayerGroup(layer.layers, activeLayers, onLayerToggle);
                          if (active && panelOpen) onLayerPanelChange?.(null);
                        }}
                        title={`${layer.hint}${onLayerToggle ? '' : ' · controlled from the Liquidity tab'}`}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold transition ${
                          active ? '' : 'hover:text-slate-300'
                        } disabled:cursor-default disabled:opacity-70`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            active ? layer.onDot : 'bg-slate-700'
                          }`}
                        />
                        {layer.label}
                        {layer.dial !== layer.label && (
                          <span
                            className={`border-l pl-1.5 font-mono text-[8px] tracking-wide ${
                              active ? layer.onDial : 'border-slate-700 text-slate-600'
                            }`}
                          >
                            {layer.dial}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={!onLayerPanelChange}
                        aria-pressed={panelOpen}
                        aria-label={layer.settingsLabel}
                        title={
                          onLayerPanelChange
                            ? layer.settingsLabel
                            : `${layer.settingsLabel} · open from the Liquidity tab`
                        }
                        onClick={() => {
                          if (!onLayerPanelChange) return;
                          onLayerPanelChange(panelOpen ? null : layer.id);
                        }}
                        className={`inline-flex items-center border-l px-1.5 transition-colors disabled:cursor-default disabled:opacity-70 ${
                          active ? layer.gearBorder : 'border-slate-700'
                        } ${
                          panelOpen
                            ? layer.gearOn
                            : 'text-slate-500 hover:text-slate-200'
                        }`}
                      >
                        <GearIcon className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  );
                })}
              </div>
              <div className="mt-1.5 font-mono text-[9px] leading-snug text-slate-500">
                Same layer stack as the Liquidity tab · binding dial →{' '}
                <span className="text-slate-400">{liquidityFrontierDialLabel(dial)}</span>
                {' · '}{selected.constraintDetail || 'No layer'}
              </div>
            </div>
          </div>
        </div>
      </section>

      <RegimeSummaryTable
        results={results}
        liveId={liveStrategy.id}
        selectedId={selected.strategy.id}
        confidencePct={setup.confidencePct}
        constraintHue={constraintHue}
        onSelect={setSelectedId}
      />

      <SelectedStrategyDetail
        result={selected}
        unfunded={unfunded}
        isLive={isLive}
        confidencePct={setup.confidencePct}
        onInspectCcy={setInspectCcy}
      />

      {inspectRow && (
        <LiquidityFrontierModal
          row={inspectRow}
          strategy={selected.strategy}
          constraintDetail={selected.constraintDetail}
          engineInput={frontierEngineInput}
          bookStanding={signedPeakStanding(
            selected.byCcy.find(c => c.ccy === inspectRow.ccy)?.plan,
          )}
          onSetupChange={onSetupChange}
          onClose={() => setInspectCcy(null)}
        />
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  tone,
  valueClass,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'carry' | 'risk' | 'sky' | 'live' | 'preview';
  valueClass?: string;
}) {
  const shell =
    tone === 'carry' || tone === 'live'
      ? 'border-emerald-500/35 bg-emerald-500/[0.07]'
      : tone === 'risk'
        ? 'border-amber-500/35 bg-amber-500/[0.07]'
        : tone === 'sky'
          ? 'border-sky-500/35 bg-sky-500/[0.07]'
          : 'border-violet-400/40 bg-violet-500/[0.08]';
  const labelFg =
    tone === 'carry' || tone === 'live'
      ? 'text-emerald-300'
      : tone === 'risk'
        ? 'text-amber-300'
        : tone === 'sky'
          ? 'text-sky-300'
          : 'text-violet-300';
  const valueFg =
    valueClass
    ?? (tone === 'risk' ? 'text-amber-300' : tone === 'preview' ? 'text-violet-300' : 'text-emerald-300');
  return (
    <div className={`rounded-[10px] border px-3 py-2.5 ${shell}`}>
      <div className={`mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] ${labelFg}`}>
        {label}
      </div>
      <div className={`mb-1 font-mono text-xl font-semibold tabular-nums ${valueFg}`}>
        {value}
      </div>
      <div className="font-mono text-[9px] leading-snug text-slate-400">{sub}</div>
    </div>
  );
}

function RegimeSummaryTable({
  results,
  liveId,
  selectedId,
  confidencePct,
  constraintHue,
  onSelect,
}: {
  results: readonly LiquidityStrategyResult[];
  liveId: LiquidityStrategyId;
  selectedId: LiquidityStrategyId;
  confidencePct: number;
  constraintHue: string;
  onSelect: (id: LiquidityStrategyId) => void;
}) {
  const tailPct = (cfarTailProbability(confidencePct) * 100).toFixed(0);
  const floorCfarUsdM = results.find(r => r.strategy.id === 'unfunded')?.finalCfarUsdM ?? 0;
  return (
    <section>
      <ChapterLabel
        n={3}
        title="Regimes"
        hint="click a row to preview · does not persist the desk regime"
      />
      <div className="overflow-x-auto rounded-[10px] border border-slate-700 bg-slate-950/50">
        <table className="w-full min-w-[820px] border-collapse text-left font-mono text-[10px] leading-snug">
          <thead>
            <tr className="text-slate-500">
              <th className="px-3 py-2 font-semibold tracking-wide">Regime</th>
              <th className="px-3 py-2 font-semibold tracking-wide">Constraint</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Cash Carry</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Swap cash</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">CIP</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Total carry</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Final CFaR</th>
              <th
                className="px-3 py-2 text-right font-semibold tracking-wide"
                title={`Carry − standing CFaR × ${tailPct}% (above unfunded/origin)`}
              >
                Weighted return
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map(r => {
              const live = r.strategy.id === liveId;
              const selected = r.strategy.id === selectedId;
              const book = strategyBookCarryK(r.byCcy);
              const weighted = probabilityWeightedReturnUsdM(
                book.total / 1000,
                r.finalCfarUsdM,
                confidencePct,
                floorCfarUsdM,
              );
              return (
                <tr
                  key={r.strategy.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  onClick={() => onSelect(r.strategy.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(r.strategy.id);
                    }
                  }}
                  className={`cursor-pointer outline-none transition ${
                    selected
                      ? 'bg-sky-500/15 text-slate-100 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.4)]'
                      : live
                        ? 'bg-sky-500/[0.06] text-slate-100 hover:bg-slate-800/55'
                        : 'text-slate-300 hover:bg-slate-800/55'
                  }`}
                >
                  <td className="border-b border-slate-900 px-3 py-2.5 align-top">
                    <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-semibold text-slate-100">
                        {r.strategy.label}
                      </span>
                      {live && (
                        <span className="rounded border border-emerald-400/50 bg-emerald-500/15 px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wide text-emerald-300">
                          Live
                        </span>
                      )}
                      {selected && (
                        <span className="rounded border border-sky-400/50 bg-sky-500/15 px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wide text-sky-300">
                          Selected
                        </span>
                      )}
                    </div>
                    <div className="max-w-[17.5rem] font-normal text-[9px] text-slate-500">
                      {r.strategy.summary}
                    </div>
                  </td>
                  <td className="border-b border-slate-900 px-3 py-2.5 align-top">
                    <div className={`font-semibold ${constraintHue}`}>
                      {bufferConstraintLabel(r.constraint)}
                    </div>
                    <div className="text-[9px] text-slate-500">{r.constraintDetail}</div>
                  </td>
                  <td className={`border-b border-slate-900 px-3 py-2.5 text-right align-top ${moneyTone((book.cash + book.hedge) / 1000)}`}>
                    {fmtSignedK((book.cash + book.hedge) / 1000, 0)}
                  </td>
                  <td className="border-b border-slate-900 px-3 py-2.5 text-right align-top text-sky-300">
                    {fmtSignedK(book.swap / 1000, 0)}
                  </td>
                  <td className="border-b border-slate-900 px-3 py-2.5 text-right align-top text-emerald-300">
                    {fmtSignedK(book.cip / 1000, 0)}
                  </td>
                  <td className={`border-b border-slate-900 px-3 py-2.5 text-right align-top font-semibold ${moneyTone(book.total / 1000)}`}>
                    {fmtSignedK(book.total / 1000, 0)}
                  </td>
                  <td className="border-b border-slate-900 px-3 py-2.5 text-right align-top text-amber-300">
                    {fmtAbsK(r.finalCfarUsdM)}
                  </td>
                  <td className={`border-b border-slate-900 px-3 py-2.5 text-right align-top ${moneyTone(weighted)}`}>
                    {fmtSignedK(weighted)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-slate-900 px-3 py-1.5 font-mono text-[9px] leading-snug text-slate-500">
          Cash Carry is desk Cash + FWD (Total without the funding-swap overlay) — identical on every regime; the swap lives in Swap cash + CIP. Final CFaR is this strategy&apos;s displayed bridge total, not a diversified portfolio VaR.
        </div>
      </div>
    </section>
  );
}

function SelectedStrategyDetail({
  result,
  unfunded,
  isLive,
  confidencePct,
  onInspectCcy,
}: {
  result: LiquidityStrategyResult;
  unfunded: LiquidityStrategyResult | undefined;
  isLive: boolean;
  confidencePct: number;
  onInspectCcy: (ccy: string) => void;
}) {
  // Open every CCY nest by default so leg pricing is on screen; chevron still
  // collapses. Switching programme re-opens so a new book is never hidden.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setCollapsed(new Set());
  }, [result.strategy.id]);
  const toggle = (ccy: string) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (!next.delete(ccy)) next.add(ccy);
      return next;
    });

  const book = strategyBookCarryK(result.byCcy);
  const unfundedByCcy = new Map(
    (unfunded?.byCcy ?? []).map(c => [c.ccy, c] as const),
  );
  const unfundedBook = unfunded ? strategyBookCarryK(unfunded.byCcy) : null;
  const vsDoNothingUsdM = unfundedBook
    ? (book.total - unfundedBook.total) / 1000
    : 0;
  const weightedUsdM = probabilityWeightedReturnUsdM(
    book.total / 1000,
    result.finalCfarUsdM,
    confidencePct,
    unfunded?.finalCfarUsdM ?? 0,
  );
  const tailPct = (cfarTailProbability(confidencePct) * 100).toFixed(0);

  return (
    <section>
      <ChapterLabel
        n={4}
        title="Book"
        hint={isLive ? 'live desk' : 'preview'}
      />
      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-3">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
            {result.strategy.label}
            {isLive ? ' · live desk' : ' · preview'}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-500">
            Click CCY for frontier · Carry − standing CFaR × {tailPct}% →{' '}
            <span className="font-semibold text-slate-300">{fmtSignedK(weightedUsdM)}</span>
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th className="py-2 pr-3 font-medium">CCY</th>
                <th className="py-2 pr-3 font-medium">Struct</th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Strip settle-window skew — funding legs are not strip-skewed"
                >
                  Settle skew
                </th>
                <th className="py-2 pr-3 font-medium">Schedule</th>
                <th className="py-2 pr-3 font-medium">Hedge Δ</th>
                <th className="py-2 pr-3 font-medium">FWD pts</th>
                <th className="py-2 pr-3 font-medium">Total carry</th>
                <th className="py-2 pr-3 font-medium">Δ vs do nothing</th>
                <th className="py-2 font-medium">Weighted return</th>
              </tr>
            </thead>
            <tbody>
              {result.byCcy.map(c => {
                const canOpen = c.schedule.length > 0;
                const open = canOpen && !collapsed.has(c.ccy);
                const carryUsdM = rowCarryUsdM(c);
                const vsUsdM = unfundedByCcy.has(c.ccy)
                  ? carryUsdM - rowCarryUsdM(unfundedByCcy.get(c.ccy)!)
                  : 0;
                const floorCfar = unfundedByCcy.get(c.ccy)?.cfarUsdM ?? 0;
                const weighted = probabilityWeightedReturnUsdM(
                  carryUsdM,
                  c.cfarUsdM,
                  confidencePct,
                  floorCfar,
                );
                const struct = fundingStructLabel(result.strategy, c.schedule);
                const schedule = compactFundingSchedule(c.schedule);
                return (
                  <Fragment key={c.ccy}>
                    <tr
                      role="button"
                      tabIndex={0}
                      title={`Open ${c.ccy} liquidity frontier`}
                      onClick={() => onInspectCcy(c.ccy)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onInspectCcy(c.ccy);
                        }
                      }}
                      className="cursor-pointer border-b border-slate-800/80 hover:bg-violet-500/10"
                    >
                      <td className="py-2 pr-3 font-semibold text-violet-200">
                        {canOpen && (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              toggle(c.ccy);
                            }}
                            title={open ? 'Hide the leg schedule' : 'Show each leg’s pricing and inputs'}
                            className="mr-1 font-mono text-[10px] text-slate-500 hover:text-slate-200"
                          >
                            {open ? '▾' : '▸'}
                          </button>
                        )}
                        {c.ccy}
                      </td>
                      <td className="py-2 pr-3 font-mono capitalize text-violet-300/90">
                        {struct}
                      </td>
                      <td
                        className="py-2 pr-3 font-mono text-slate-500"
                        title="Funding legs are not strip-skewed"
                      >
                        —
                      </td>
                      <td className="py-2 pr-3 font-mono text-amber-200/90">
                        {schedule}
                      </td>
                      <td className="py-2 pr-3 font-mono text-sky-300">
                        {fmtM(c.bookNow)}
                      </td>
                      <td className="py-2 pr-3 font-mono text-emerald-300/90">
                        {fmtSignedK(c.swapPointsUsdYrM)}
                      </td>
                      <td className={`py-2 pr-3 font-mono font-semibold ${
                        carryUsdM >= 0 ? 'text-slate-300' : 'text-rose-300'
                      }`}>
                        {fmtSignedK(carryUsdM)}
                      </td>
                      <td className={`py-2 pr-3 font-mono ${
                        Math.abs(vsUsdM) < 5e-5
                          ? 'text-slate-500'
                          : vsUsdM >= 0 ? 'text-emerald-200' : 'text-rose-300'
                      }`}>
                        {fmtSignedK(vsUsdM)}
                      </td>
                      <td className={`py-2 font-mono ${moneyTone(weighted)}`}>
                        {fmtSignedK(weighted)}
                      </td>
                    </tr>
                    {open &&
                      c.schedule.map(l => (
                        <tr
                          key={`${c.ccy}:${l.cycleIndex}`}
                          className="border-b border-slate-800/50 text-[11px]"
                        >
                          <td className="py-1.5 pl-5 pr-3 font-mono text-sky-200/90">
                            {l.preBookable ? 'Fwd-start' : 'Spot'}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-slate-500">
                            trade
                          </td>
                          <td className="py-1.5 pr-3 text-slate-600">—</td>
                          <td className="py-1.5 pr-3 font-mono text-amber-200/80">
                            M{l.valueDateMonths + 1}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-slate-400">
                            {fmtM(l.newLeg)}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-emerald-300/80">
                            {fmtSignedK(l.pointsUsdYr)}
                          </td>
                          <td
                            className={`py-1.5 pr-3 font-mono ${moneyTone(l.netUsdYr)}`}
                          >
                            {fmtSignedK(l.netUsdYr)}
                          </td>
                          <td className="py-1.5 pr-3 text-slate-600">—</td>
                          <td className="py-1.5 text-slate-600">—</td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-600 bg-slate-900/80 font-mono text-slate-200">
                <td className="py-2 pr-3 font-semibold text-white" colSpan={4}>
                  TOTAL $USD
                </td>
                <td className="py-2 pr-3 font-semibold text-sky-300">
                  {Math.abs(result.bookNowUsdM) > 0.005
                    ? `${result.bookNowUsdM >= 0 ? '' : '−'}$${Math.abs(result.bookNowUsdM).toFixed(2)}M`
                    : '—'}
                </td>
                <td className="py-2 pr-3 font-semibold text-emerald-300">
                  {fmtSignedK(book.cip / 1000)}
                </td>
                <td className="py-2 pr-3 font-semibold text-emerald-100">
                  {fmtSignedK(book.total / 1000)}
                </td>
                <td className={`py-2 pr-3 font-semibold ${moneyTone(vsDoNothingUsdM)}`}>
                  {fmtSignedK(vsDoNothingUsdM)}
                </td>
                <td className={`py-2 font-semibold ${moneyTone(weightedUsdM)}`}>
                  {fmtSignedK(weightedUsdM)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
      <p className="mt-1.5 px-0.5 font-mono text-[9px] leading-snug text-slate-500">
        Hedge Δ is the near-leg book-now in M FCY · child rows are each funding trade · ▾ hides them.
      </p>
    </section>
  );
}
