'use client';

/**
 * Wizard Scenarios / Optimize panels restored from the local Liquidity wizard.
 * Shared calc stays in LiquidityAnalyticsView (handover overlay / frontier).
 */

import { useRef, useState, type PointerEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  cfarTailProbability,
  probabilityWeightedReturnUsdM,
  type LiquidityStrategyCcy,
  type LiquidityStrategyResult,
} from '@/lib/test-mode/liquidity-strategies';
import {
  computePortfolioVAR,
  CURRENCY_PARAMS,
  type LiquidityCapitalAllocation,
} from '@/lib/fx-buffer';
import {
  type EfficientCarryLeg,
} from '@/lib/portfolio-alloc';
import {
  diversifiedUsdRisk,
  signedCfarUsdM,
  type PortfolioLiquidityFrontier,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import {
  signedPeakStanding as frontierBookStanding,
} from '@/lib/test-mode/liquidity-frontier';

function fmtK(usdM: number): string {
  const k = usdM * 1000;
  if (Math.abs(k) < 0.5) return '$0K';
  return `${k >= 0 ? '' : '−'}$${Math.abs(k).toFixed(0)}K`;
}

export type FrontierSolutionCard = {
  id: string;
  name: string;
  short: string;
  rationale: string;
  carryUsdYrM: number;
  riskUsdM: number;
  usedPct: number;
  efficiency: number;
  approved: boolean;
  disabled: boolean;
};





export type OverlayVarRow = {
  ccy: string;
  usdM: number;
  standaloneUsdM: number;
};

/** Component VAR of overlay USD weights — same quadratic as computePortfolioVAR. */
export function overlayVarRows(legs: readonly EfficientCarryLeg[]): {
  portUsdM: number;
  standaloneUsdM: number;
  rows: OverlayVarRow[];
} {
  const peakVar = computePortfolioVAR(
    legs.map(l => {
      const spot = CURRENCY_PARAMS[l.ccy]?.spot ?? 1;
      return { ccy: l.ccy, cashFCY: spot > 1e-12 ? l.usdM / spot : 0 };
    }),
  );
  return {
    portUsdM: peakVar.portfolio_VAR_USD,
    standaloneUsdM: peakVar.standalone_sum_USD,
    rows: [...peakVar.currencies]
      .map(c => ({
        ccy: c.ccy,
        usdM: c.component_VAR_USD,
        standaloneUsdM: c.standalone_VAR_USD,
      }))
      .filter(r => Math.abs(r.usdM) > 0.0005 || r.standaloneUsdM > 0.0005)
      .sort((a, b) => Math.abs(b.usdM) - Math.abs(a.usdM)),
  };
}

export type OverlayContrib = {
  portVarUsdM: number;
  standaloneVarUsdM: number;
  liveVarRows: OverlayVarRow[];
  capVarRows: OverlayVarRow[];
  liveCarryRows: { ccy: string; usdM: number }[];
  capCarryRows: { ccy: string; usdM: number }[];
  liveCarryUsdYrM: number;
};

/** Cash + swap cash + CIP — the zip ledger used for E[return], not −net cost. */
export function strategyTotalCarryUsdYrM(r: LiquidityStrategyResult): number {
  return r.cashCarryUsdYrM + r.swapInterestUsdYrM + r.swapPointsUsdYrM;
}

export function weightedReturnUsdYrM(
  r: LiquidityStrategyResult,
  confidencePct: number,
): number {
  return probabilityWeightedReturnUsdM(
    strategyTotalCarryUsdYrM(r),
    r.finalCfarUsdM,
    confidencePct,
  );
}

const CARRY_FILL = 'bg-amber-300/90';

/** Signed carry track — zero in the middle, + right / − left. */
export function SignedCarryMeter({
  usdM,
  maxAbs,
  className = 'h-1',
}: {
  usdM: number;
  maxAbs: number;
  className?: string;
}) {
  const halfPct = (Math.abs(usdM) / Math.max(maxAbs, 1e-9)) * 50;
  return (
    <div className={`relative overflow-hidden rounded-full bg-slate-800 ${className}`}>
      <div
        className={`absolute inset-y-0 ${CARRY_FILL}`}
        style={
          usdM >= 0
            ? { left: '50%', width: `${halfPct}%` }
            : { right: '50%', width: `${halfPct}%` }
        }
      />
      <div className="absolute inset-y-0 left-1/2 z-10 w-px -translate-x-1/2 bg-slate-200/90" />
    </div>
  );
}

/** Left-column solution card: one funding regime, metrics and a signed carry bar. */
export function ParetoScenarioCard({
  scenario,
  maxAbsCarryUsdYrM,
  isSelected,
  onSelect,
  shareLabel = 'of $20M',
}: {
  scenario: FrontierSolutionCard;
  maxAbsCarryUsdYrM: number;
  isSelected: boolean;
  onSelect: () => void;
  /** Fourth metric label — Liquidity policy share, or % of unhedged VaR. */
  shareLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={scenario.disabled}
      aria-pressed={isSelected}
      title={scenario.rationale}
      className={`rounded-xl border p-4 text-left transition ${
        scenario.disabled
          ? 'cursor-not-allowed border-slate-800 bg-slate-950/30 opacity-60'
          : isSelected
            ? 'border-sky-400/60 bg-sky-500/10 ring-1 ring-inset ring-sky-400/30'
            : 'border-slate-800 bg-slate-950/50 hover:border-slate-600 hover:bg-slate-900/50'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-100">{scenario.name}</div>
          <div className="mt-1 text-[11px] leading-snug text-slate-500">
            {scenario.short}
      </div>
        </div>
        <span
          className={`flex-none rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
            scenario.disabled
              ? 'bg-slate-800 text-slate-500'
              : scenario.approved
                ? 'bg-emerald-500/20 text-emerald-200'
                : 'bg-amber-500/20 text-amber-200'
          }`}
        >
          {scenario.disabled ? 'n/a' : scenario.approved ? 'Approved' : 'Review'}
        </span>
      </div>
      <div className="mt-3.5 grid grid-cols-4 gap-2">
        <Metric label="Carry" value={fmtK(scenario.carryUsdYrM)} />
        <Metric label="VAR" value={scenario.disabled ? '—' : `$${scenario.riskUsdM.toFixed(1)}M`} />
        <Metric label={shareLabel} value={scenario.disabled ? '—' : `${scenario.usedPct.toFixed(0)}%`} />
        <Metric label="Eff." value={scenario.disabled ? '—' : scenario.efficiency.toFixed(0)} />
      </div>
      <SignedCarryMeter
        usdM={scenario.carryUsdYrM}
        maxAbs={maxAbsCarryUsdYrM}
        className="mt-3.5 h-1"
      />
      <div className="relative mt-1 h-3 font-mono text-[8px] text-slate-600">
        <span className="absolute left-0">−</span>
        <span className="absolute left-1/2 -translate-x-1/2">0</span>
        <span className="absolute right-0">+</span>
      </div>
    </button>
  );
}

export function SolutionCard({
  result,
  confidencePct,
  isLive,
  isSelected,
  onSelect,
}: {
  result: LiquidityStrategyResult;
  confidencePct: number;
  isLive: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const breach = result.floorBreaches > 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      title={`${result.strategy.summary} · ${result.strategy.tradeoff}`}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
        isSelected
          ? 'border-sky-400/60 bg-sky-500/10 ring-1 ring-inset ring-sky-400/30'
          : 'border-slate-700 bg-slate-950/50 hover:border-slate-600 hover:bg-slate-900/50'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-slate-100">
          {result.strategy.label}
        </div>
        <div className="truncate text-[10px] text-slate-500">
          {result.strategy.summary}
        </div>
      </div>
      <div className="hidden shrink-0 items-center gap-3 font-mono text-[11px] tabular-nums sm:flex">
        <span className="w-[58px]">
          <span className="text-slate-500">Cash </span>
          <span className="text-slate-200">{fmtK(result.cashCarryUsdYrM)}</span>
        </span>
        <span className="w-[58px]">
          <span className="text-slate-500">Swap </span>
          <span className="text-slate-200">{fmtK(result.swapInterestUsdYrM)}</span>
        </span>
        <span className="w-[52px]">
          <span className="text-slate-500">Net </span>
          <span className="text-slate-200">{fmtK(result.netCostUsdYrM)}</span>
        </span>
        <span className="w-[64px]">
          <span className="text-slate-500">E[ret] </span>
          <span className="text-slate-200">{fmtK(weightedReturnUsdYrM(result, confidencePct))}</span>
        </span>
      </div>
      <span
        className={`flex-none rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
          breach
            ? 'bg-rose-500/20 text-rose-200'
            : isLive
              ? 'bg-emerald-500/20 text-emerald-200'
              : 'bg-slate-700/60 text-slate-300'
        }`}
      >
        {breach ? `${result.floorBreaches}×` : isLive ? 'live' : 'ok'}
      </span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] text-slate-500">{label}</div>
      <div className="font-mono text-xs font-medium tabular-nums text-slate-200">
        {value}
      </div>
    </div>
  );
}

/** One-row metric cards for the selected regime / frontier solution. */
export function DetailMetrics({
  result,
  confidencePct,
  port,
  scenario,
  floorCfarUsdM = 0,
}: {
  result: LiquidityStrategyResult;
  confidencePct: number;
  port: PortfolioLiquidityFrontier | null;
  /** When set (Optimize step), carry & VAR match the highlighted solution card. */
  scenario?: Pick<FrontierSolutionCard, 'name' | 'carryUsdYrM' | 'riskUsdM'> | null;
  /**
   * Unhedged / residual CFaR floor. Weighted return charges only hedgeable
   * standing above this — same Max E[Return] / Book Weighted objective.
   */
  floorCfarUsdM?: number;
}) {
  const tailPct = Math.round(cfarTailProbability(confidencePct) * 100);
  const bookCarry = result.cashCarryUsdYrM + result.swapInterestUsdYrM;
  const totalCarry = scenario?.carryUsdYrM ?? strategyTotalCarryUsdYrM(result);
  const riskUsdM = scenario?.riskUsdM ?? (port?.book.portCfarUsdM ?? result.finalCfarUsdM);
  const weighted = scenario
    ? probabilityWeightedReturnUsdM(totalCarry, riskUsdM, confidencePct, floorCfarUsdM)
    : weightedReturnUsdYrM(result, confidencePct);
  const riskLabel = scenario ? 'Solution VAR' : 'Final CFaR';
  const riskSub = scenario
    ? `Policy overlay · ${scenario.name}`
    : port
      ? `Port ${fmtK(port.book.portCfarUsdM)} · sum ${fmtK(port.book.sumCfarUsdM)}`
      : 'FX hedge + funding bridge';
  const carrySub = scenario
    ? 'Σ⁻¹μ overlay at selected point · book ledger below'
    : 'Cash + swap cash + CIP';
  const cards = [
    {
      label: scenario ? 'Solution carry' : 'Total carry',
      value: `${fmtK(totalCarry)}/yr`,
      sub: carrySub,
    },
    {
      label: `Weighted return · ${confidencePct}%`,
      value: `${fmtK(weighted)}/yr`,
      sub: scenario
        ? `E[R] = carry − standing × ${tailPct}%`
        : `Carry − CFaR × ${tailPct}%`,
    },
    { label: 'Book now', value: result.bookNowUsdM > 0.005 ? `$${result.bookNowUsdM.toFixed(1)}M` : '—', sub: 'near leg, next cycle' },
    { label: 'Peak book', value: result.peakBookUsdM > 0.005 ? `$${result.peakBookUsdM.toFixed(1)}M` : '—', sub: 'max outstanding' },
    {
      label: riskLabel,
      value: scenario ? `$${riskUsdM.toFixed(1)}M` : fmtK(riskUsdM),
      sub: riskSub,
    },
    {
      label: 'Book carry',
      value: `${fmtK(bookCarry)}/yr`,
      sub: `Cash + swap · ${result.strategy.label}`,
    },
  ];
  return (
    <div className="grid grid-cols-6 gap-2">
      {cards.map(c => (
        <div key={c.label} className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/50 px-2.5 py-2">
          <div className="truncate text-[10px] text-slate-500">{c.label}</div>
          <div className="mt-0.5 truncate font-mono text-sm font-medium tabular-nums text-slate-100">
            {c.value}
          </div>
          <div className="truncate text-[9px] text-slate-500">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

const VAR_POLICY_M = 20;

type VarDistRow = {
  ccy: string;
  usdM: number;
  standaloneUsdM: number;
};

type VarDistribution = {
  kind: 'var' | 'cfar';
  portUsdM: number;
  standaloneUsdM: number;
  divBenefitUsdM: number;
  rows: VarDistRow[];
};

const CCY_BAR_TONE: Record<string, string> = {
  EUR: 'bg-sky-400',
  GBP: 'bg-violet-400',
  PLN: 'bg-emerald-400',
  AUD: 'bg-amber-400',
  JPY: 'bg-rose-400',
  CHF: 'bg-cyan-400',
  MXN: 'bg-fuchsia-400',
  ZAR: 'bg-lime-400',
  CAD: 'bg-orange-400',
  SEK: 'bg-teal-400',
  NOK: 'bg-indigo-400',
  DKK: 'bg-pink-400',
  HUF: 'bg-yellow-400',
  CZK: 'bg-blue-400',
  ILS: 'bg-green-400',
  SGD: 'bg-red-400',
  HKD: 'bg-purple-400',
  NZD: 'bg-sky-300',
  TRY: 'bg-amber-300',
  RON: 'bg-emerald-300',
  AED: 'bg-cyan-300',
  THB: 'bg-violet-300',
  RSD: 'bg-orange-300',
  CNY: 'bg-rose-300',
};

export function ccyBarTone(ccy: string): string {
  return CCY_BAR_TONE[ccy] ?? 'bg-sky-400';
}


function varPolicyTier(usdM: number): { label: string; color: string } {
  if (usdM > 10) return { label: 'CEO', color: 'bg-rose-400' };
  if (usdM > 5) return { label: 'CFO', color: 'bg-amber-400' };
  return { label: 'Director', color: 'bg-emerald-400' };
}

/**
 * Per-name displayed CFaR first so the bars add up to the $ figure on the
 * policy track. Component VAR on the peak funding book is the fallback
 * when the CFaR map is flat (no setup / empty nets).
 */
function buildVarDistribution(
  result: LiquidityStrategyResult,
  port: PortfolioLiquidityFrontier | null,
): VarDistribution {
  const cfarRows = result.byCcy
    .map(c => ({
      ccy: c.ccy,
      usdM: Math.abs(c.cfarUsdM),
      standaloneUsdM: Math.abs(c.cfarUsdM),
    }))
    .filter(r => r.usdM > 0.0005)
    .sort((a, b) => b.usdM - a.usdM);
  if (cfarRows.length > 0 || result.finalCfarUsdM > 0.001) {
    const standaloneUsdM =
      (port?.book.sumCfarUsdM ?? 0) > 0.001
        ? port!.book.sumCfarUsdM
        : cfarRows.reduce((s, r) => s + r.standaloneUsdM, 0);
    const portUsdM =
      result.finalCfarUsdM > 0.001
        ? result.finalCfarUsdM
        : (port?.book.portCfarUsdM ?? standaloneUsdM);
    return {
      kind: 'cfar',
      portUsdM,
      standaloneUsdM,
      divBenefitUsdM: standaloneUsdM - portUsdM,
      rows: cfarRows,
    };
  }

  const peakVar = computePortfolioVAR(
    result.byCcy.map(c => ({
      ccy: c.ccy,
      cashFCY: Math.abs(frontierBookStanding(c.plan)) || Math.abs(c.peakBook),
    })),
  );
  return {
    kind: 'var',
    portUsdM: peakVar.portfolio_VAR_USD,
    standaloneUsdM: peakVar.standalone_sum_USD,
    divBenefitUsdM: peakVar.div_benefit_USD,
    rows: [...peakVar.currencies]
      .map(c => ({
        ccy: c.ccy,
        usdM: c.component_VAR_USD,
        standaloneUsdM: c.standalone_VAR_USD,
      }))
      .filter(r => Math.abs(r.usdM) > 0.0005)
      .sort((a, b) => Math.abs(b.usdM) - Math.abs(a.usdM)),
  };
}

function scaleOf(tuneRatio: Record<string, number> | undefined, ccy: string): number {
  return (tuneRatio?.[ccy] ?? 100) / 100;
}

/**
 * Per-name carry for the tweak bars. CIP / gap-hedge points are excluded:
 * at mid they equal −Swap Carry, so Cash + swap + CIP collapses to ~$0K
 * and the mix strip draws nothing.
 */
function ccyTweakCarryUsdYrM(c: LiquidityStrategyCcy): number {
  const cash = c.cashCarryUsdYrM;
  const swap = c.swapInterestUsdYrM;
  const ledger = cash + swap;
  if (Math.abs(ledger) > 0.00005) return ledger;
  if (Math.abs(cash) > 0.00005) return cash;
  return swap;
}

function buildCarryDistribution(
  result: LiquidityStrategyResult,
  tuneRatio?: Record<string, number>,
): { portUsdM: number; rows: { ccy: string; usdM: number }[] } {
  const rows = result.byCcy
    .map(c => ({
      ccy: c.ccy,
      usdM: ccyTweakCarryUsdYrM(c) * scaleOf(tuneRatio, c.ccy),
    }))
    .filter(r => Math.abs(r.usdM) > 0.00005)
    .sort((a, b) => Math.abs(b.usdM) - Math.abs(a.usdM));
  return {
    portUsdM: rows.reduce((s, r) => s + r.usdM, 0),
    rows,
  };
}

export type StackSeg = { ccy: string; usdM: number };

type StackPortfolio = {
  id: string;
  label: string;
  status: string;
  individual: StackSeg[];
  diversified: StackSeg[];
  individualTotal: number;
  diversifiedTotal: number;
};

export function stackFromRisk(
  id: string,
  label: string,
  status: string,
  risk: ReturnType<typeof diversifiedUsdRisk>,
): StackPortfolio {
  const individual = risk.byCcy
    .map(c => ({ ccy: c.ccy, usdM: Math.abs(c.usdM) }))
    .filter(s => s.usdM > 1e-6);
  const rawDiv = risk.byCcy
    .map(c => ({ ccy: c.ccy, usdM: Math.max(0, c.componentUsdM) }))
    .filter(s => s.usdM > 1e-6);
  const pos = rawDiv.reduce((s, r) => s + r.usdM, 0);
  const diversified = pos > 1e-9 && risk.portfolioUsdM > 1e-9
    ? rawDiv.map(s => ({ ...s, usdM: s.usdM * (risk.portfolioUsdM / pos) }))
    : rawDiv;
  return {
    id,
    label,
    status,
    individual,
    diversified,
    individualTotal: risk.standaloneUsdM,
    diversifiedTotal: risk.portfolioUsdM,
  };
}

function stackFromOverlay(
  id: string,
  label: string,
  status: string,
  overlay: OverlayContrib,
  ratio: Record<string, number> | undefined,
  include: (ccy: string) => boolean,
): StackPortfolio {
  const rows = overlay.liveVarRows
    .filter(r => include(r.ccy))
    .map(r => ({
      ccy: r.ccy,
      usdM: r.usdM * scaleOf(ratio, r.ccy),
      standaloneUsdM: (r.standaloneUsdM ?? Math.abs(r.usdM)) * scaleOf(ratio, r.ccy),
    }));
  const risk = diversifiedUsdRisk(rows.map(r => ({ ccy: r.ccy, usdM: r.usdM })));
  const individual = rows
    .map(r => ({ ccy: r.ccy, usdM: Math.abs(r.standaloneUsdM) }))
    .filter(s => s.usdM > 1e-6);
  return {
    ...stackFromRisk(id, label, status, risk),
    individual,
    individualTotal: individual.reduce((s, r) => s + r.usdM, 0) || overlay.standaloneVarUsdM,
  };
}

function niceVarTicks(maxUsdM: number): number[] {
  const hi = Math.max(maxUsdM, 0.05);
  const step = hi > 20 ? 5 : hi > 8 ? 2 : hi > 3 ? 1 : hi > 1 ? 0.5 : 0.2;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= end + 1e-9; v += step) ticks.push(Number(v.toFixed(4)));
  return ticks;
}

/** Individual vs Diversified VaR stack — same chrome as Liquidity policy bars. */
export function VarCurrencyStackChart({
  unhedged,
  selected,
  confidencePct,
  horizon,
  openCcy,
  onOpenCcy,
  selectedBook,
  onSelectUnhedged,
  onSelectMix,
  onSetAfterRatio,
  beforeUsdByCcy,
  onRestoreTune,
}: {
  unhedged: StackPortfolio;
  selected: StackPortfolio;
  confidencePct: number;
  horizon: string;
  openCcy?: string | null;
  onOpenCcy?: (ccy: string) => void;
  selectedBook?: 'unhedged' | 'selected';
  onSelectUnhedged?: () => void;
  onSelectMix?: () => void;
  /** After mix Individual: drag residual → hedge % of VaR before mix. */
  onSetAfterRatio?: (ccy: string, hedgePct: number) => void;
  beforeUsdByCcy?: Readonly<Record<string, number>>;
  /** Restore After mix weights back to the selected frontier point. */
  onRestoreTune?: () => void;
}) {
  const books = [unhedged, selected];
  const axisUsdM = Math.max(
    ...books.flatMap(b => [b.individualTotal, b.diversifiedTotal]),
    0.05,
  ) * 1.08;
  const ticks = niceVarTicks(axisUsdM);
  const axisMax = ticks[ticks.length - 1] ?? axisUsdM;
  const marks = ticks
    .filter(v => v > 0)
    .map(v => v / axisMax);
  const legend = [...new Set(books.flatMap(b => [
    ...b.individual.map(s => s.ccy),
    ...b.diversified.map(s => s.ccy),
  ]))];
  const tail = Math.max(1, Math.round(100 - confidencePct));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-2.5">
        <h3 className="text-base font-medium text-slate-100">
          {tail}%-ile VaR for {horizon} tenor
        </h3>
        <span className="text-[11px] text-slate-500">
          {onSetAfterRatio
            ? 'VaR before mix = Δ 1 · VaR after mix = Resid · drag After mix to set hedge %'
            : onOpenCcy || onSelectUnhedged
              ? 'Click Unhedged to leave open · After mix is the live program · click a colour to open the trade'
              : 'Individual = Σ standalone · Diversified = Euler share of portfolio VaR'}
        </span>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
        <div className="space-y-4">
          {books.map((port, i) => {
            const isUnhedged = i === 0;
            const pick = isUnhedged ? onSelectUnhedged : onSelectMix;
            const active = selectedBook
              ? (isUnhedged ? selectedBook === 'unhedged' : selectedBook === 'selected')
              : i === 1;
            const mixTuned = !isUnhedged && port.status === 'TUNED';
            return (
            <div
              key={port.id}
              role={pick ? 'button' : undefined}
              tabIndex={pick ? 0 : undefined}
              onClick={pick}
              onKeyDown={pick ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  pick();
                }
              } : undefined}
              title={
                isUnhedged
                  ? 'VaR before mix — every name at Δ = 1'
                  : mixTuned
                    ? 'VaR after mix — amended from the selected mix · restore to snap back'
                    : onSetAfterRatio
                      ? 'VaR after mix — drag a colour to set that name’s hedge %'
                      : 'VaR after mix — live Resid VaR at the selected weights'
              }
              className={`space-y-2.5 rounded-lg p-3 ${
                isUnhedged
                  ? 'bg-rose-950/25'
                  : mixTuned
                    ? 'bg-amber-950/25'
                    : 'bg-slate-900/20'
              } ${pick ? 'cursor-pointer hover:ring-1 hover:ring-slate-500/60' : ''} ${
                active && pick
                  ? mixTuned
                    ? 'ring-1 ring-amber-400/50'
                    : 'ring-1 ring-sky-400/40'
                  : ''
              }`}
            >
              <div className="flex items-baseline gap-2">
                <div className="text-[12px] font-semibold text-slate-100">{port.label}</div>
                {port.status && port.status !== 'TUNED' ? (
                  <div className="font-mono text-[9px] uppercase tracking-wide text-slate-500">
                    {port.status}
                  </div>
                ) : null}
              </div>
              <PolicyCfarBar
                label={isUnhedged ? 'VaR before mix' : 'VaR after mix'}
                segs={port.individual}
                totalUsdM={port.individualTotal}
                axisUsdM={axisMax}
                marks={marks}
                openCcy={openCcy}
                onOpenCcy={onOpenCcy}
                onSetRatio={isUnhedged ? undefined : onSetAfterRatio}
                beforeByCcy={isUnhedged ? undefined : beforeUsdByCcy}
                tuned={mixTuned}
                onRestore={mixTuned ? onRestoreTune : undefined}
              />
              <PolicyCfarBar
                label="Diversified VaR"
                segs={port.diversified}
                totalUsdM={port.diversifiedTotal}
                axisUsdM={axisMax}
                marks={marks}
                openCcy={openCcy}
                onOpenCcy={onOpenCcy}
              />
            </div>
            );
          })}
        </div>
        <div className="grid grid-cols-[7.5rem_1fr] gap-x-3">
          <div />
          <div className="relative mt-1.5 h-4 font-mono text-[9px] text-slate-500">
            {ticks.map(v => (
              <span
                key={v}
                className="absolute -translate-x-1/2"
                style={{ left: `${(v / axisMax) * 100}%` }}
              >
                {v}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {legend.map(ccy => (
            onOpenCcy ? (
              <button
                key={ccy}
                type="button"
                onClick={() => onOpenCcy(ccy)}
                className={`flex items-center gap-1.5 font-mono text-[10px] text-slate-400 hover:text-slate-200 ${
                  openCcy === ccy ? 'text-slate-100' : ''
                }`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${ccyBarTone(ccy)}`} />
                {ccy}
              </button>
            ) : (
              <div key={ccy} className="flex items-center gap-1.5 font-mono text-[10px] text-slate-400">
                <span className={`h-2.5 w-2.5 rounded-full ${ccyBarTone(ccy)}`} />
                {ccy}
              </div>
            )
          ))}
        </div>
      </div>
    </div>
  );
}

/** Portfolio policy bar plus Carry / VAR contribution bars. Drag a bar to rebalance. */
export function VarBudgetUsage({
  result,
  port,
  budgetUsdM = VAR_POLICY_M,
  openCcy,
  onOpenCcy,
  overlay,
  tuneRatio,
  onSetRatio,
  includedCcys,
  selectedLabel,
}: {
  result: LiquidityStrategyResult;
  port: PortfolioLiquidityFrontier | null;
  budgetUsdM?: number;
  openCcy: string | null;
  onOpenCcy: (ccy: string) => void;
  overlay?: OverlayContrib | null;
  tuneRatio?: Record<string, number>;
  onSetRatio?: (ccy: string, ratio: number) => void;
  tabNetByCcyUsd?: Record<string, number>;
  includedCcys?: ReadonlySet<string> | null;
  selectedLabel?: string;
  confidencePct?: number;
  horizon?: string;
}) {
  const [contribMode, setContribMode] = useState<'var' | 'carry'>('var');
  const includeCcy = (ccy: string) => !includedCcys || includedCcys.has(ccy);
  const selectedStack = overlay
    ? stackFromOverlay(
      'selected',
      selectedLabel ?? 'Selected',
      'OVERLAY',
      overlay,
      tuneRatio,
      includeCcy,
    )
    : stackFromRisk(
      'selected',
      selectedLabel ?? 'Selected',
      'SWAP',
      diversifiedUsdRisk(
        result.byCcy
          .filter(c => includeCcy(c.ccy))
          .map(c => ({
            ccy: c.ccy,
            usdM: signedCfarUsdM(c.cfarUsdM, frontierBookStanding(c.plan))
              * scaleOf(tuneRatio, c.ccy),
          })),
      ),
    );
  const liveOverlay = overlay != null;
  const raw = liveOverlay
    ? {
        kind: 'var' as const,
        portUsdM: overlay.portVarUsdM,
        standaloneUsdM: overlay.standaloneVarUsdM,
        divBenefitUsdM: overlay.standaloneVarUsdM - overlay.portVarUsdM,
        rows: overlay.capVarRows.map(r => ({ ...r, standaloneUsdM: Math.abs(r.usdM) })),
      }
    : buildVarDistribution(result, port);
  // Live overlay base is the priced component book; otherwise regime CFaR / peak VAR.
  // Cap rows stay on `raw` for the policy track — bars use live as 100% so drag is responsive.
  const varBaseRows = liveOverlay ? overlay.liveVarRows : raw.rows;
  const scaledRows = varBaseRows
    .map(r => ({ ...r, usdM: r.usdM * scaleOf(tuneRatio, r.ccy) }))
    .filter(r => Math.abs(r.usdM) > 0.00005);
  const scaledRisk = liveOverlay
    ? (() => {
        const risk = diversifiedUsdRisk(
          scaledRows.map(r => ({ ccy: r.ccy, usdM: r.usdM })),
        );
        return {
          portfolioUsdM: risk.portfolioUsdM > 1e-9 ? risk.portfolioUsdM : (
            scaledRows.reduce((s, r) => s + Math.abs(r.usdM), 0) || overlay.portVarUsdM
          ),
          standaloneUsdM: risk.standaloneUsdM > 1e-9
            ? risk.standaloneUsdM
            : scaledRows.reduce((s, r) => s + Math.abs(r.usdM), 0) || overlay.standaloneVarUsdM,
        };
      })()
    : diversifiedUsdRisk(
      result.byCcy.map(c => ({
        ccy: c.ccy,
        usdM: signedCfarUsdM(c.cfarUsdM, frontierBookStanding(c.plan)) * scaleOf(tuneRatio, c.ccy),
      })),
    );
  const dist = {
    ...raw,
    rows: scaledRows,
    portUsdM: scaledRisk.portfolioUsdM > 1e-9 ? scaledRisk.portfolioUsdM : (
      varBaseRows.reduce((s, r) => s + Math.abs(r.usdM) * scaleOf(tuneRatio, r.ccy), 0)
      || raw.portUsdM
    ),
    standaloneUsdM: scaledRisk.standaloneUsdM > 1e-9 ? scaledRisk.standaloneUsdM : raw.standaloneUsdM,
  };
  const carryRaw = liveOverlay
    ? {
        portUsdM: overlay.liveCarryRows.reduce((s, r) => s + r.usdM, 0),
        rows: overlay.liveCarryRows,
      }
    : buildCarryDistribution(result);
  const carryDist = liveOverlay
    ? (() => {
        const rows = overlay.liveCarryRows
          .map(r => ({ ...r, usdM: r.usdM * scaleOf(tuneRatio, r.ccy) }))
          .filter(r => Math.abs(r.usdM) > 0.00005);
        return {
          portUsdM: rows.reduce((s, r) => s + r.usdM, 0),
          rows,
        };
      })()
    : buildCarryDistribution(result, tuneRatio);
  const policyAxisUsdM = VAR_POLICY_M;
  const ofBudget = budgetUsdM > 0 ? (dist.portUsdM / budgetUsdM) * 100 : 0;
  const tier = varPolicyTier(dist.portUsdM);
  const activeScaled = contribMode === 'var' ? dist.rows : carryDist.rows;
  const activeBase = contribMode === 'var' ? varBaseRows : carryRaw.rows;
  const stackBase = activeScaled.reduce((s, r) => s + Math.abs(r.usdM), 0);
  const maxBase = Math.max(
    ...activeBase.map(r => Math.abs(r.usdM)),
    ...activeScaled.map(r => Math.abs(r.usdM)),
    1e-9,
  );
  const baseBy = new Map(activeBase.map(r => [r.ccy, r.usdM]));
  const scaledBy = new Map(activeScaled.map(r => [r.ccy, r.usdM]));
  const names =
    activeBase.length > 0
      ? activeBase.map(r => r.ccy)
      : result.byCcy.map(c => c.ccy);
  const portLabel = contribMode === 'var' ? fmtK(dist.portUsdM) : fmtK(carryDist.portUsdM);

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-3 flex flex-wrap items-baseline gap-2.5">
          <h3 className="text-base font-medium text-slate-100">VAR budget usage</h3>
          <span className="text-[11px] text-slate-500">
            Individual vs diversified CFaR on Dir / CFO / CEO approval tiers
          </span>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[11px]">
            <span className="text-sm font-medium text-slate-100">
              {fmtK(dist.standaloneUsdM)}
              <span className="mx-1.5 text-slate-600">→</span>
              {fmtK(dist.portUsdM)}
            </span>
            <span className="text-slate-500">
              {tier.label} tier · {ofBudget.toFixed(0)}% of ${budgetUsdM.toFixed(0)}M budget
            </span>
          </div>
          <div className="space-y-2.5">
            <PolicyCfarBar
              label="Individual CFaR"
              segs={selectedStack.individual}
              totalUsdM={selectedStack.individualTotal}
              axisUsdM={policyAxisUsdM}
            />
            <PolicyCfarBar
              label="Diversified CFaR"
              segs={selectedStack.diversified}
              totalUsdM={selectedStack.diversifiedTotal}
              axisUsdM={policyAxisUsdM}
            />
          </div>
          <div className="grid grid-cols-[7.5rem_1fr] gap-x-3">
            <div />
            <div className="relative mt-1.5 h-4 font-mono text-[9px] text-slate-500">
              <span className="absolute left-0">$0</span>
              <span className="absolute left-1/4 -translate-x-1/2">$5M · Dir</span>
              <span className="absolute left-1/2 -translate-x-1/2">$10M · CFO</span>
              <span className="absolute right-0">$20M · CEO</span>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {[...new Set([
              ...selectedStack.individual.map(s => s.ccy),
              ...selectedStack.diversified.map(s => s.ccy),
            ])].map(ccy => (
              <div key={ccy} className="flex items-center gap-1.5 font-mono text-[10px] text-slate-400">
                <span className={`h-2.5 w-2.5 rounded-full ${ccyBarTone(ccy)}`} />
                {ccy}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h3 className="text-base font-medium text-slate-100">
              {contribMode === 'var' ? 'CFaR contribution' : 'Carry contribution'}
            </h3>
            <span className="text-[11px] text-slate-500">
              {liveOverlay
                ? contribMode === 'var'
                  ? 'Live overlay CFaR · drag pins USD · others refill Policy VAR'
                  : 'Live cash Δr on strip + overlay · drag pins USD · others refill Policy VAR'
                : contribMode === 'var'
                  ? 'Drag pins USD · click the name to fine-tune'
                  : 'Drag pins that name · others refill the VAR budget · click the name to fine-tune'}
            </span>
          </div>
          <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-0.5">
            {(['var', 'carry'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setContribMode(mode)}
                className={`rounded-md px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide ${
                  contribMode === mode
                    ? 'bg-slate-700 text-slate-100'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {mode === 'var' ? 'CFaR' : 'Carry'}
              </button>
            ))}
          </div>
        </div>

        {names.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 px-4 py-6 text-center text-[11px] text-slate-500">
            No per-currency {contribMode === 'var' ? 'CFaR' : 'carry'} on this regime.
          </div>
        ) : (
          <div className="space-y-3">
            {contribMode === 'carry' && (
              <MixStrip
                title="Carry mix"
                total={portLabel}
                hint={
                  liveOverlay
                    ? 'Cash Δr on the live overlay book · right of 0 earns · left of 0 pays'
                    : 'Cash + swap cash · right of 0 earns · left of 0 pays · sign is fixed'
                }
                rows={activeScaled}
                portAbs={stackBase}
                signed
              />
            )}

            <div className="flex flex-col gap-1.5">
              {names.map(ccy => {
                const usdM = scaledBy.get(ccy) ?? 0;
                const baseUsdM = baseBy.get(ccy) ?? 0;
                const open = openCcy === ccy;
                const ratio = Math.round(scaleOf(tuneRatio, ccy) * 100);
                const tone =
                  contribMode === 'carry' ? CARRY_FILL : ccyBarTone(ccy);
                return (
                  <div
                    key={ccy}
                    className={`flex items-center gap-2 rounded-lg px-1.5 py-0.5 ${
                      open ? 'bg-sky-500/10 ring-1 ring-inset ring-sky-400/30' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenCcy(ccy)}
                      className="w-11 flex-none text-left font-mono text-sm font-medium text-slate-100 hover:text-sky-200"
                    >
                      {ccy}
                    </button>
                    <ContributionBar
                      usdM={usdM}
                      widthPct={Math.min(100, (Math.abs(usdM) / maxBase) * 100)}
                      fullWidthPct={Math.min(100, (Math.abs(baseUsdM) / maxBase) * 100)}
                      tone={tone}
                      signed={contribMode === 'carry'}
                      sign={baseUsdM >= 0 ? 1 : -1}
                      onRatio={onSetRatio ? r => onSetRatio(ccy, r) : undefined}
                    />
                    <span className="relative z-10 w-[4.5rem] flex-none text-right font-mono text-[11px] tabular-nums text-slate-200">
                      {fmtK(usdM)}
                    </span>
                    <span className="relative z-10 w-10 flex-none text-right font-mono text-[10px] text-slate-500">
                      {ratio}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtUsdM(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 0.05) return '$0M';
  return `$${usdM.toFixed(1)}M`;
}

const CAPITAL_SEGMENTS: {
  key: keyof Pick<
    LiquidityCapitalAllocation,
    'fcyNwcAllocatedM' | 'cfarCoverageAllocatedM' | 'usdNwcReservedM' | 'unallocatedUsdM'
  >;
  label: string;
  tone: string;
  bar: string;
}[] = [
  { key: 'fcyNwcAllocatedM', label: 'Hedging', tone: 'text-sky-200', bar: 'bg-sky-500' },
  { key: 'cfarCoverageAllocatedM', label: 'CFaR cover', tone: 'text-violet-200', bar: 'bg-violet-500' },
  { key: 'usdNwcReservedM', label: 'USD utilization', tone: 'text-amber-200', bar: 'bg-amber-500' },
  { key: 'unallocatedUsdM', label: 'Left', tone: 'text-emerald-200', bar: 'bg-slate-500' },
];

/** Full-width stacked bar: hedge / CFaR cover / USD NWC / leftover of Total capital. */
export function UsdCapitalUsageBar({ alloc }: { alloc: LiquidityCapitalAllocation }) {
  const total = Math.max(0, alloc.totalCapitalUsdM);
  const parts = CAPITAL_SEGMENTS.map(seg => ({
    ...seg,
    usdM: Math.max(0, alloc[seg.key]),
  }));
  const spent = parts.reduce((s, p) => s + p.usdM, 0);
  const scale = Math.max(total, spent, 1e-9);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-2.5">
        <h3 className="text-base font-medium text-slate-100">USD capital allocation</h3>
        <span className="text-[11px] text-slate-500">
          How Total capital is spent — hedging, CFaR cover, USD NWC, leftover
        </span>
      </div>
      <div className={`rounded-xl border p-4 ${
        alloc.capitalBinding
          ? 'border-orange-400/40 bg-orange-500/10'
          : 'border-slate-800 bg-slate-950/50'
      }`}>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[11px]">
          <span className="text-sm font-medium text-slate-100">{fmtUsdM(total)}</span>
          <span className={alloc.capitalBinding ? 'text-orange-200' : 'text-slate-500'}>
            {alloc.capitalBinding ? 'Capital binding' : 'Within capital'}
            {total > 0 ? ` · leftover ${fmtUsdM(alloc.unallocatedUsdM)}` : ''}
          </span>
        </div>
        <div className="flex h-7 overflow-hidden rounded-lg bg-slate-800">
          {parts.map(p => {
            const pct = (p.usdM / scale) * 100;
            if (pct < 0.15) return null;
            return (
              <div
                key={p.key}
                className={`h-full ${p.bar}`}
                style={{ width: `${pct}%` }}
                title={`${p.label} ${fmtUsdM(p.usdM)}`}
              />
            );
          })}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
          {parts.map(p => {
            const pct = total > 1e-9 ? (p.usdM / total) * 100 : 0;
            return (
              <div key={p.key} className="flex items-baseline gap-1.5 font-mono text-[11px]">
                <span className={`h-2 w-2 rounded-sm ${p.bar}`} />
                <span className="text-slate-500">{p.label}</span>
                <span className={p.tone}>{fmtUsdM(p.usdM)}</span>
                <span className="text-slate-600">{pct.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Policy-scale stacked CFaR / VaR bar. */
export function PolicyCfarBar({
  label,
  segs,
  totalUsdM,
  axisUsdM,
  marks,
  formatTotal = fmtK,
  openCcy,
  onOpenCcy,
  onSetRatio,
  beforeByCcy,
  tuned,
  onRestore,
}: {
  label: string;
  segs: readonly StackSeg[];
  totalUsdM: number;
  axisUsdM: number;
  /** Vertical guides as a fraction of the axis (0–1). Default Dir / CFO / CEO. */
  marks?: readonly number[];
  formatTotal?: (usdM: number) => string;
  openCcy?: string | null;
  onOpenCcy?: (ccy: string) => void;
  /** Drag residual along the axis → hedge % of VaR before mix. */
  onSetRatio?: (ccy: string, hedgePct: number) => void;
  beforeByCcy?: Readonly<Record<string, number>>;
  /** Residual bar was amended off the selected mix. */
  tuned?: boolean;
  onRestore?: () => void;
}) {
  const guides = marks ?? [0.25, 0.5, 1];
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    ccy: string;
    startX: number;
    startUsd: number;
    moved: boolean;
  } | null>(null);
  const skipClick = useRef(false);
  const onSetRef = useRef(onSetRatio);
  const beforeRef = useRef(beforeByCcy);
  const axisRef = useRef(axisUsdM);
  onSetRef.current = onSetRatio;
  beforeRef.current = beforeByCcy;
  axisRef.current = axisUsdM;

  const applyRatio = (ccy: string, startUsd: number, startX: number, clientX: number) => {
    const fn = onSetRef.current;
    const el = trackRef.current;
    if (!fn || !el) return;
    const box = el.getBoundingClientRect();
    if (box.width <= 0) return;
    const before = Math.max(beforeRef.current?.[ccy] ?? startUsd, 1e-12);
    const after = Math.min(
      before,
      Math.max(0, startUsd + ((clientX - startX) / box.width) * axisRef.current),
    );
    fn(ccy, Math.round((1 - after / before) * 100));
  };

  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-x-3">
      <div>
        <div className="flex items-center gap-1">
          <div
            className={`text-[10px] ${
              tuned ? 'font-semibold text-amber-300' : 'text-slate-400'
            }`}
          >
            {tuned ? 'Tuned' : label}
          </div>
          {tuned && onRestore ? (
            <button
              type="button"
              title="Restore the selected mix"
              aria-label="Restore the selected mix"
              onClick={e => {
                e.stopPropagation();
                onRestore();
              }}
              onPointerDown={e => e.stopPropagation()}
              onKeyDown={e => e.stopPropagation()}
              className="rounded p-0.5 text-amber-300/85 hover:bg-amber-500/15 hover:text-amber-100"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          ) : null}
        </div>
        <div className="font-mono text-[10px] tabular-nums text-slate-200">
          {formatTotal(totalUsdM)}
        </div>
      </div>
      <div
        ref={trackRef}
        className={`relative h-7 w-full overflow-hidden rounded-lg bg-slate-800 ${
          tuned ? 'ring-1 ring-inset ring-amber-400/55' : ''
        }`}
      >
        <div className="absolute inset-0 z-10 flex">
          {segs.map(s => {
            const w = axisUsdM > 1e-9 ? (s.usdM / axisUsdM) * 100 : 0;
            if (w < 0.08) return null;
            const active = openCcy === s.ccy;
            const interactive = Boolean(onOpenCcy || onSetRatio);
            const cls = `${ccyBarTone(s.ccy)} box-border h-full min-h-full shrink-0 border-0 p-0 ${
              onSetRatio
                ? 'cursor-ew-resize hover:brightness-110'
                : onOpenCcy
                  ? 'cursor-pointer hover:brightness-110'
                  : ''
            } ${active ? 'ring-1 ring-inset ring-white/70' : ''}`;
            const fillStyle = { flex: `0 0 ${w}%` } as const;
            const title = onSetRatio
              ? `${s.ccy} ${formatTotal(s.usdM)} residual — drag to set hedge %`
              : onOpenCcy
                ? `${s.ccy} ${formatTotal(s.usdM)} — open trade`
                : `${s.ccy} ${formatTotal(s.usdM)}`;
            if (!interactive) {
              return (
                <div
                  key={s.ccy}
                  className={cls}
                  style={fillStyle}
                  title={title}
                />
              );
            }
            return (
              <button
                key={s.ccy}
                type="button"
                role={onSetRatio ? 'slider' : undefined}
                aria-label={title}
                className={cls}
                style={fillStyle}
                title={title}
                onClick={e => {
                  e.stopPropagation();
                  if (skipClick.current) {
                    skipClick.current = false;
                    return;
                  }
                  onOpenCcy?.(s.ccy);
                }}
                onPointerDown={e => {
                  e.stopPropagation();
                  if (!onSetRatio) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = {
                    ccy: s.ccy,
                    startX: e.clientX,
                    startUsd: s.usdM,
                    moved: false,
                  };
                }}
                onPointerMove={e => {
                  const d = drag.current;
                  if (!d || d.ccy !== s.ccy) return;
                  if (Math.abs(e.clientX - d.startX) > 3) d.moved = true;
                  if (d.moved) applyRatio(d.ccy, d.startUsd, d.startX, e.clientX);
                }}
                onPointerUp={e => {
                  const d = drag.current;
                  if (d && e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                  if (d?.moved) {
                    skipClick.current = true;
                    e.preventDefault();
                    e.stopPropagation();
                  }
                  drag.current = null;
                }}
              />
            );
          })}
        </div>
        {guides.map(g => (
          <div
            key={g}
            className="pointer-events-none absolute inset-y-0 w-px bg-rose-400/80"
            style={{ left: `${Math.min(100, g * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function MixStrip({
  title,
  total,
  hint,
  rows,
  portAbs,
  signed,
}: {
  title: string;
  total: string;
  hint: string;
  rows: readonly { ccy: string; usdM: number }[];
  portAbs: number;
  signed?: boolean;
}) {
  const pos = rows.filter(r => r.usdM > 0);
  const neg = rows.filter(r => r.usdM < 0);
  const posSum = pos.reduce((s, r) => s + r.usdM, 0);
  const negSum = neg.reduce((s, r) => s + Math.abs(r.usdM), 0);
  const sideScale = Math.max(posSum, negSum, 1e-9);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
          {title}
        </span>
        <span className="font-mono text-sm font-medium tabular-nums text-slate-100">{total}</span>
      </div>
      {signed ? (
        <div className="relative h-6 overflow-hidden rounded-md bg-slate-800">
          <div className="absolute inset-y-0 left-0 flex w-1/2 flex-row-reverse">
            {neg.map(r => {
              const w = (Math.abs(r.usdM) / sideScale) * 100;
              if (w < 0.4) return null;
              return (
                <div
                  key={r.ccy}
                  className={`h-full ${CARRY_FILL}`}
                  style={{ width: `${w}%` }}
                  title={`${r.ccy} ${fmtK(r.usdM)}`}
                />
              );
            })}
          </div>
          <div className="absolute inset-y-0 right-0 flex w-1/2">
            {pos.map(r => {
              const w = (r.usdM / sideScale) * 100;
              if (w < 0.4) return null;
              return (
                <div
                  key={r.ccy}
                  className={`h-full ${CARRY_FILL}`}
                  style={{ width: `${w}%` }}
                  title={`${r.ccy} ${fmtK(r.usdM)}`}
                />
              );
            })}
          </div>
          <div className="absolute inset-y-0 left-1/2 z-10 w-px -translate-x-1/2 bg-slate-200/90" />
        </div>
      ) : (
        <div className="flex h-6 overflow-hidden rounded-md bg-slate-800">
          {rows.map(r => {
            const w = portAbs > 0 ? (Math.abs(r.usdM) / portAbs) * 100 : 0;
            if (w < 0.4) return null;
            return (
              <div
                key={r.ccy}
                className={`${ccyBarTone(r.ccy)} h-full`}
                style={{ width: `${w}%` }}
                title={`${r.ccy} ${fmtK(r.usdM)}`}
              />
            );
          })}
        </div>
      )}
      {signed && (
        <div className="relative mt-1 h-3 font-mono text-[8px] text-slate-600">
          <span className="absolute left-0">−</span>
          <span className="absolute left-1/2 -translate-x-1/2">0</span>
          <span className="absolute right-0">+</span>
        </div>
      )}
      <div className={`${signed ? '' : 'mt-1.5 '}text-[10px] text-slate-500`}>{hint}</div>
    </div>
  );
}

export function ContributionBar({
  usdM,
  widthPct,
  fullWidthPct,
  tone,
  signed,
  sign = 1,
  onRatio,
}: {
  usdM: number;
  widthPct: number;
  fullWidthPct: number;
  tone: string;
  signed?: boolean;
  /** +1 earn / −1 pay. Drag cannot cross zero. */
  sign?: 1 | -1;
  onRatio?: (ratio: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const onRatioRef = useRef(onRatio);
  const fullRef = useRef(fullWidthPct);
  const fullDragRef = useRef(Math.max(fullWidthPct / 100, 0.02));
  const signedRef = useRef(signed);
  const signRef = useRef(sign);
  onRatioRef.current = onRatio;
  fullRef.current = fullWidthPct;
  signedRef.current = signed;
  signRef.current = sign;
  const fill = Math.min(100, Math.max(widthPct, Math.abs(usdM) > 0.00005 ? 1.5 : 0));
  const halfFill = fill / 2;
  const handleLeft = signed
    ? sign > 0
      ? Math.min(98.5, 50 + halfFill)
      : Math.max(1.5, 50 - halfFill)
    : Math.min(98.5, fill);

  const apply = (clientX: number) => {
    const el = trackRef.current;
    const fn = onRatioRef.current;
    if (!el || !fn) return;
    const box = el.getBoundingClientRect();
    if (box.width <= 0) return;
    const full = fullDragRef.current;
    if (signedRef.current) {
      const mid = box.left + box.width / 2;
      const alongSide = (clientX - mid) * signRef.current;
      const fullPx = full * (box.width / 2);
      fn(Math.round(Math.min(1, Math.max(0, alongSide / fullPx)) * 100));
      return;
    }
    const t = (clientX - box.left) / box.width;
    fn(Math.round(Math.min(1, Math.max(0, t / full)) * 100));
  };

  return (
    <div
      ref={trackRef}
      role={onRatio ? 'slider' : undefined}
      aria-label={fmtK(usdM)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fullWidthPct > 0 ? (widthPct / fullWidthPct) * 100 : 0)}
      onPointerDown={e => {
        if (!onRatio) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        fullDragRef.current = Math.max(fullRef.current / 100, 0.02);
        apply(e.clientX);
      }}
      onPointerMove={e => {
        if (!dragging.current) return;
        apply(e.clientX);
      }}
      onPointerUp={e => {
        dragging.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerCancel={e => {
        dragging.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onLostPointerCapture={() => {
        dragging.current = false;
      }}
      className={`relative min-w-0 flex-1 overflow-hidden rounded-md bg-slate-800 ${
        onRatio ? 'cursor-ew-resize touch-none select-none' : ''
      }`}
    >
      <div className="relative h-[22px]">
        {signed ? (
          <div
            className={`absolute inset-y-0 ${tone}`}
            style={
              sign > 0
                ? { left: '50%', width: `${halfFill}%` }
                : { right: '50%', width: `${halfFill}%` }
            }
          />
        ) : (
          <div
            className={`absolute inset-y-0 left-0 rounded-md ${tone}`}
            style={{ width: `${fill}%` }}
          />
        )}
        {signed && (
          <div className="absolute inset-y-0 left-1/2 z-10 w-px -translate-x-1/2 bg-slate-200/90" />
        )}
        {onRatio && fill > 0 && (
          <div
            className="absolute top-1/2 z-10 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-white/90 shadow"
            style={{ left: `${handleLeft}%` }}
          />
        )}
      </div>
    </div>
  );
}