'use client';

/**
 * Liquidity perspective on Analytics — how the desk covers the dip in the dated
 * cash path under the live sizing/booking regime.
 *
 * Layout follows docs/design/liquidity-analytics-claude-design.md
 * (Entity Dashboard Create UI-3 · Liquidity Analytics).
 */

import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { LiquidityFrontierModal } from '@/components/test-mode/LiquidityFrontierModal';
import {
  carryAxisFromArms,
  carryFwd,
  liquidityFrontierDial,
  liquidityFrontierDialLabel,
  signedPeakStanding,
} from '@/lib/test-mode/liquidity-frontier';
import {
  buildPortfolioLiquidityFrontier,
  portfolioCfarSnapshot,
  priceRegimeChartCfar,
  regimePortfolioCfar,
  toPortfolioCarryFrontier,
  type PortfolioFrontierPoint,
} from '@/lib/test-mode/portfolio-liquidity-frontier';
import {
  buildEfficientCarryVarFrontier,
  joinOverlayStripWeights,
  l1Weights,
  overlayBookBaseFcyM,
  overlayLegNotionalCeilingUsdM,
  OVERLAY_MAX_BASE_MULTIPLE,
  OVERLAY_MAX_LEG_LEVERAGE,
  type EfficientCarryLeg,
  type EfficientCarryVarFrontier,
  type OverlaySide,
} from '@/lib/portfolio-alloc';
import {
  orderedLiquidityScenarioPoints,
  pickConservativeFundingBook,
  plotCarryS,
  tangencyFromTrueZero,
} from '@/lib/test-mode/portfolio-modal-align';
import {
  buildSolutionPick,
  deskCarryTargetUsdYr,
  liftFrontierToTotalCarry,
  maxExpectedReturnFrontierPoint,
  normalizeSelectionPoint,
  persistScenarioId,
  pointForScenario,
  policyVarForSelection,
  remapSelectionToFrontier,
  selectionPointsEqual,
  solutionWeightedReturnUsdM,
  type PortfolioSelection,
  type SolutionPick,
  type SolutionScenarioId,
} from '@/lib/test-mode/solution-pick';
import {
  computePortfolioCarryFrontier,
  impliedPortfolioRFcyPct,
} from '@/lib/dashboard-model';
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
  POLICY_VAR_LIMITS,
  approvalTierCapUsd,
  universePolicyVarCap,
  CURRENCY_PARAMS,
  bufferLevelOf,
  setBufferLevel,
  toggleLayerGroup,
  type BufferChipKey,
  type LayerId,
  type PortfolioCarryFrontier,
  type PortfolioCarryFrontierPoint,
  type RowState,
} from '@/lib/fx-buffer';
import {
  VAR_CONFIDENCE_OPTIONS,
} from '@/lib/test-mode/var-confidence';
import {
  clearPreparedHedgeForCcy,
  setPreparedHedgeForCcy,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';
import { resolveMarketRatesForCcy } from '@/lib/fx-market-rates';
import { analyticsForwardsFromOverlays } from '@/lib/fx-hedge';
import type { AnalyticsForwardLeg } from '@/lib/test-mode/cash-carry-analytics';
import {
  fundingStripPreparedProfile,
  mergeResidualOverlays,
  residualNeedsFxStage,
} from '@/lib/test-mode/liquidity-strip-stage';
import {
  fxHedgeNetCfarByCcyUsdM,
  sumNetCfarUsdM,
} from '@/lib/test-mode/cfar-net-by-ccy';

type LiquidityAnalyticsViewProps = LiquidityAnalyticsSource & {
  extraForwards?: readonly AnalyticsForwardLeg[];
  stockNetByCcy?: Readonly<Record<string, number>>;
};

function fmtSignedK(usdM: number, decimals?: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-5) return '$0K';
  // ≥ $1M → dollars in millions (Policy VAR / Port. CFaR). Smaller → $K.
  if (Math.abs(usdM) >= 1 - 1e-9) {
    const sign = usdM > 0 ? '+' : usdM < 0 ? '−' : '';
    return `${sign}$${Math.abs(usdM).toFixed(1)}M`;
  }
  const k = usdM * 1000;
  const dec = decimals ?? (Math.abs(k) < 10 ? 1 : 0);
  const sign = k > 0 ? '+' : k < 0 ? '−' : '';
  return `${sign}$${Math.abs(k).toFixed(dec)}K`;
}

function fmtAbsK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-5) return '$0K';
  if (Math.abs(usdM) >= 1 - 1e-9) {
    return `$${Math.abs(usdM).toFixed(1)}M`;
  }
  const k = Math.abs(usdM * 1000);
  return `$${k.toFixed(k < 10 ? 1 : 0)}K`;
}

function fmtK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-5) return '$0K';
  if (Math.abs(usdM) >= 1 - 1e-9) {
    return `${usdM >= 0 ? '' : '−'}$${Math.abs(usdM).toFixed(1)}M`;
  }
  const k = usdM * 1000;
  const dec = Math.abs(k) < 10 ? 1 : 0;
  return `${k >= 0 ? '' : '−'}$${Math.abs(k).toFixed(dec)}K`;
}

function fmtM(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-12) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}M`;
}

function moneyTone(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 5e-5) return 'text-slate-500';
  return usdM >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

function fmtWeight(w: number): string {
  if (!Number.isFinite(w) || Math.abs(w) < 0.005) return '—';
  const pct = w * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(0)}%`;
}

/** What the overlay does on this CCY — long/short × EARN/PAY, or hold. */
function overlayDoLabel(side: OverlaySide, mu: number): string {
  if (side === 'flat') return 'hold';
  const tilt = mu > 1e-6 ? 'EARN' : mu < -1e-6 ? 'PAY' : 'flat';
  const hedge = (side === 'long' && tilt === 'PAY')
    || (side === 'short' && tilt === 'EARN');
  if (hedge) return `${side} ${tilt} hedge`;
  if (tilt === 'flat') return side;
  return `${side} ${tilt}`;
}

function stripOutstanding(c: LiquidityStrategyCcy): number {
  return c.schedule.length > 0
    ? c.schedule[c.schedule.length - 1]!.outstanding
    : 0;
}

/** Funding-swap ledger only: Buffer Carry (cash Δr) + CIP. Not Cash Carry / Hedge FWD. */
function swapCarryUsdM(c: Pick<
  LiquidityStrategyCcy,
  'swapInterestUsdYrM' | 'swapPointsUsdYrM'
>): number {
  return (
    usdMToCarryK(c.swapInterestUsdYrM)
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

/** Compact “i” — click opens a short explanation popover. Notes live here, not as grey captions. */
function InfoTip({
  label,
  children,
  align = 'left',
}: {
  label: string;
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={e => {
          e.stopPropagation();
          setOpen(v => !v);
        }}
        className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold leading-none transition-colors ${
          open
            ? 'border-sky-500/60 bg-sky-500/20 text-sky-100'
            : 'border-slate-600 bg-slate-900 text-slate-400 hover:border-slate-500 hover:text-slate-200'
        }`}
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`absolute top-full z-30 mt-1.5 w-80 max-w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-slate-600 bg-slate-900 p-3 text-left text-[10px] leading-relaxed text-slate-300 shadow-xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {label}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

function ChapterLabel({
  n,
  title,
  info,
  infoLabel,
}: {
  n: number;
  title: string;
  info?: ReactNode;
  infoLabel?: string;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 px-0.5">
      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-400">
        {n} · {title}
      </span>
      {info != null && (
        <InfoTip label={infoLabel ?? title}>{info}</InfoTip>
      )}
      <span className="h-px flex-1 bg-slate-800" />
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
    settingsLabel: 'Buffer Carry target — Total Carry ask ($K/yr) plus per-currency r_OD / Target LP Cash / Buffer Carry',
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
    hint: 'Cross-currency mix: Σ⁻¹μ overlay under the shared Policy VAR cap',
    settingsLabel: 'Policy VAR — overlay sensitivity limit (portfolio level)',
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

type PortfolioScenarioId = 'unhedged' | 'carryTarget' | 'balanced' | 'maxCarry' | 'maxReturn';

function asPortfolioScenarioId(raw: string | null | undefined): PortfolioScenarioId | null {
  if (raw === 'conservative' || raw === 'carryTarget') return 'carryTarget';
  if (raw === 'maxPolicyRisk' || raw === 'maxCarry') return 'maxCarry';
  if (raw === 'unhedged' || raw === 'balanced' || raw === 'maxReturn') return raw;
  return null;
}

/** Overlay mix t at the selected chart marker — same pick the table must use. */

/**
 * Scales every $-amount field on each row by `amplitude` — everything the
 * book actually holds grows or shrinks together. Rates (r_FCY, r_OD, β_IR,
 * σ_daily, ir_*_rate, ir_net_dur) are untouched: they describe the currency,
 * not the position size. `cash_floor` is also left untouched on purpose —
 * it is a fixed operational threshold set by ops, not a fraction of the
 * book — that asymmetry (position scales, floor doesn't) is exactly what
 * makes clamp timing a non-linear function of book size at fixed amplitude
 * ratios (see fx-buffer.test.ts's "position-amplitude scaling" suite).
 */
function scaleRowsByAmplitude(rows: readonly RowState[], amplitude: number): RowState[] {
  return rows.map(r => ({
    ...r,
    spot: r.spot * amplitude,
    fwd: r.fwd * amplitude,
    nonCash: r.nonCash * amplitude,
    nonCashAsset: r.nonCashAsset != null ? r.nonCashAsset * amplitude : r.nonCashAsset,
    cash: r.cash * amplitude,
    payout: r.payout * amplitude,
    collections: r.collections * amplitude,
    fcastFX: r.fcastFX * amplitude,
    nonLpCash: r.nonLpCash * amplitude,
    carry_target: r.carry_target != null ? r.carry_target * amplitude : r.carry_target,
    ir_asset_notional: r.ir_asset_notional * amplitude,
    ir_liab_notional: r.ir_liab_notional * amplitude,
    ir_invest_notional: r.ir_invest_notional != null ? r.ir_invest_notional * amplitude : r.ir_invest_notional,
  }));
}

interface PortfolioScenarioDef {
  id: PortfolioScenarioId;
  label: string;
  point: PortfolioCarryFrontierPoint | null;
  disabledHint?: string;
  /**
   * True when this point's VAR exceeds its own reference approval tier —
   * NOT a sizing failure the overlay could fix. If frontier.points[0] (zero
   * overlay) is already above the tier, the fixed standalone exposure
   * (delta_cfar) alone breaches it — no amount of overlay discipline
   * changes that. Never let a breached point be applied as if compliant.
   */
  breached: boolean;
  breachTierUsd?: number;
}

/**
 * The four named scenarios, all derived from the same limited-universe
 * frontier — shared by the preset buttons, the Pareto plot's markers, and
 * the per-currency modal, so the three surfaces can never drift apart on
 * what "Balanced" etc. means.
 */
function portfolioScenarioDefs(
  frontier: PortfolioCarryFrontier | null,
  confidencePct: number,
  conservativePoint?: PortfolioCarryFrontierPoint | null,
  unhedgedOriginUsdM?: number | null,
  policyCapUsd?: number | null,
  carryS?: number,
  carryTargetUsdYr?: number | null,
): PortfolioScenarioDef[] {
  const pts = frontier?.points ?? [];
  const minTier = POLICY_VAR_LIMITS[0]!.usd;
  const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  const policyCap = typeof policyCapUsd === 'number'
    && Number.isFinite(policyCapUsd)
    && policyCapUsd > 0
    ? policyCapUsd
    : maxTier;
  const sweet = frontier && frontier.sweetSpotIndex >= 0
    ? frontier.points[frontier.sweetSpotIndex] ?? null
    : null;
  const tailProb = cfarTailProbability(confidencePct);
  // VAR at zero overlay — the fixed standalone exposure (delta_cfar) alone.
  // If THIS is already above a tier, every point on the curve is too (VAR
  // only grows from here), so it's a base-book breach, not a bad pick.
  const floorVarUsd = pts.length > 0
    ? Math.min(...pts.map(p => p.portfolioVarUsd).filter(Number.isFinite))
    : 0;
  const breachOf = (tier: number) => floorVarUsd > tier + 1e-6;
  const ordered = orderedLiquidityScenarioPoints({
    points: pts,
    conservative: conservativePoint,
    policyCapUsd: policyCap,
    originCfarUsd: pts[0]?.portfolioVarUsd ?? null,
    carryS,
    carryTargetUsdYr,
  });
  const unhedgedPoint = ordered.origin;
  const carryTargetPoint = frontier
    ? pointForScenario({
        frontier,
        scenarioId: 'carryTarget',
        policyCapUsd: policyCap,
        carryTargetUsdYr: typeof carryTargetUsdYr === 'number' ? carryTargetUsdYr : undefined,
        confidencePct,
      })
    : ordered.carryTarget;
  const balancedPoint = ordered.balanced;
  const maxCarryPoint = ordered.maxCarry;
  return [
    {
      id: 'unhedged',
      label: 'Unhedged',
      point: unhedgedPoint,
      breached: breachOf(minTier),
      breachTierUsd: minTier,
    },
    {
      id: 'carryTarget',
      label: 'Carry Target',
      point: carryTargetPoint,
      disabledHint: carryTargetPoint
        ? undefined
        : (typeof carryTargetUsdYr === 'number' && Number.isFinite(carryTargetUsdYr)
          ? `Target Carry ${fmtSignedK(carryTargetUsdYr)}/yr is off the open arm`
          : 'Target Carry $32k/yr is off the open arm — raise Total Carry in Buffer Carry target setup or extend the walk'),
      breached: false,
    },
    {
      // (0, 0) supporting-ray touch on the full open arm.
      id: 'balanced',
      label: 'Balanced',
      point: balancedPoint,
      disabledHint: balancedPoint
        ? undefined
        : (frontier?.nearestClampVarUsd != null
          ? `no (0,0) tangent in range yet — first clamp is ${frontier.nearestClampCcy} at $${frontier.nearestClampVarUsd.toFixed(1)}M CFaR`
          : 'no interior tangency from (0,0) on the open arm'),
      breached: balancedPoint != null && breachOf(maxTier),
      breachTierUsd: maxTier,
    },
    {
      id: 'maxCarry',
      label: 'Max Policy Risk',
      point: maxCarryPoint,
      disabledHint: maxCarryPoint
        ? undefined
        : `no open-arm point at or below the $${policyCap.toFixed(0)}M policy cap`,
      breached: breachOf(policyCap),
      breachTierUsd: policyCap,
    },
    {
      id: 'maxReturn',
      label: 'Max E[Return]',
      point: maxExpectedReturnFrontierPoint(pts, tailProb),
      disabledHint: 'the risk-adjusted objective is still improving at the edge of the swept range — '
        + 'raise Policy VAR (or set a Min floor) so a real optimum can appear inside it',
      breached: floorVarUsd > 0 && breachOf(maxTier)
        && maxExpectedReturnFrontierPoint(pts, tailProb) != null,
      breachTierUsd: maxTier,
    },
  ];
}

function roundPolicyVar(usdM: number): number {
  return Math.round(usdM * 10) / 10;
}


/**
 * X-window that frames the live book the way the per-CCY modal does:
 * origin + Carry Target/Balanced (and a selected preset). Max Policy Risk /
 * the $5–$20 approval tail clips — it does not zoom the plot out.
 */
function limitedUniverseWindow(
  pts: readonly PortfolioCarryFrontierPoint[],
  defs: readonly PortfolioScenarioDef[],
  selectedId?: PortfolioScenarioId | null,
): { xMin: number; xMax: number } | null {
  const origin = pts[0]?.portfolioVarUsd;
  const core: number[] = [];
  if (typeof origin === 'number' && Number.isFinite(origin)) core.push(origin);
  for (const d of defs) {
    if (!d.point || !Number.isFinite(d.point.portfolioVarUsd)) continue;
    if (d.id === 'carryTarget' || d.id === 'balanced') core.push(d.point.portfolioVarUsd);
  }
  const coreHi = core.length > 0 ? Math.max(...core) : 0;
  for (const d of defs) {
    if (!d.point || !Number.isFinite(d.point.portfolioVarUsd)) continue;
    if (d.id === 'carryTarget' || d.id === 'balanced') continue;
    const atEdge = pts.length > 1 && d.point === pts[pts.length - 1];
    if (selectedId === d.id || (!atEdge && d.point.portfolioVarUsd <= coreHi * 1.25 + 1e-9)) {
      core.push(d.point.portfolioVarUsd);
    }
  }
  if (core.length === 0) return null;
  const x0 = Math.max(0, typeof origin === 'number' && Number.isFinite(origin) ? origin : Math.min(...core));
  const cfarHi = Math.max(x0, ...core);
  const xMax = Math.max(cfarHi * 1.08, x0 + 0.025);
  const xMin = Math.max(0, x0 - (xMax - x0) * 0.28);
  return { xMin, xMax };
}

/** Modal-style frame: origin + live book. Overlay $5–$20 markers clip unless selected. */
function liveBookWindow(
  pts: readonly PortfolioCarryFrontierPoint[],
  selectedX?: number,
): { xMin: number; xMax: number } | null {
  const origin = pts[0]?.portfolioVarUsd;
  const core: number[] = [];
  if (typeof origin === 'number' && Number.isFinite(origin)) core.push(origin);
  for (const p of pts) {
    if (p.levered) continue;
    if (Number.isFinite(p.portfolioVarUsd)) core.push(p.portfolioVarUsd);
  }
  if (typeof selectedX === 'number' && Number.isFinite(selectedX)) core.push(selectedX);
  if (core.length === 0) return null;
  const x0 = Math.max(0, typeof origin === 'number' && Number.isFinite(origin) ? origin : Math.min(...core));
  const cfarHi = Math.max(x0, ...core);
  const xMax = Math.max(cfarHi * 1.08, x0 + 0.025);
  const xMin = Math.max(0, x0 - (xMax - x0) * 0.28);
  return { xMin, xMax };
}

/**
 * Shrink the asinh-carry window vs CFaR so vertical shape reads clearly —
 * frontier peel vs the (0,0) tangent — without clipping $0 carry or the
 * open-arm / scenario samples in `mustInclude`.
 */
function emphasizeCarryFrame(
  yMin: number,
  yMax: number,
  carryS: number,
  emphasis: number,
  mustInclude: readonly number[],
): { yMin: number; yMax: number } {
  const zLo = carryFwd(yMin, carryS);
  const zHi = carryFwd(yMax, carryS);
  if (!(zHi > zLo + 1e-9)) return { yMin, yMax };
  const mid = (zLo + zHi) / 2;
  let half = Math.max((zHi - zLo) / (2 * Math.max(emphasis, 1)), 0.08);
  for (const yv of mustInclude) {
    if (!Number.isFinite(yv)) continue;
    half = Math.max(half, Math.abs(carryFwd(yv, carryS) - mid) * 1.06);
  }
  return {
    yMin: carryS * Math.sinh(mid - half),
    yMax: carryS * Math.sinh(mid + half),
  };
}

/** Unclamped Σ⁻¹μ ray as a 2-point chord — any floor-clamp peels the live curve off it. */
function unclampedRayChord(
  pts: readonly PortfolioCarryFrontierPoint[],
): { x: number; y: number }[] | null {
  const free = pts.filter(p => p.floorBoundCcys.length === 0);
  const a = (free.length >= 2 ? free[0] : pts[0])!;
  const b = (free.length >= 2 ? free[free.length - 1] : pts[1])!;
  if (!a || !b) return null;
  const dx = b.portfolioVarUsd - a.portfolioVarUsd;
  if (Math.abs(dx) < 1e-9) return null;
  const slope = (b.totalCarryUsdYr - a.totalCarryUsdYr) / dx;
  const x0 = pts[0]!.portfolioVarUsd;
  const x1 = pts[pts.length - 1]!.portfolioVarUsd;
  return [
    { x: x0, y: a.totalCarryUsdYr + slope * (x0 - a.portfolioVarUsd) },
    { x: x1, y: a.totalCarryUsdYr + slope * (x1 - a.portfolioVarUsd) },
  ];
}

/**
 * Named sweet-spot presets on the carry/VAR frontier:
 *  - Carry Target:   open-arm hit on the desk Target Carry ($K/yr), else
 *                     $32k/yr (Buffer Carry target modal blank — not the H* book's own carry)
 *  - Balanced:       tangency from true (0, 0), not the Unhedged CFaR pin
 *  - Max Policy Risk: max open-arm CFaR still inside the policy cap
 *  - Max E[Return]:  the point maximizing carry − CFaR × tail%
 */
function PortfolioScenarioPresets({
  frontier,
  confidencePct,
  selectedId,
  conservativePoint,
  unhedgedOriginUsdM,
  policyCapUsd,
  carryTargetUsdYr,
  scenarioDefs,
  onApply,
}: {
  frontier: PortfolioCarryFrontier | null;
  confidencePct: number;
  selectedId: PortfolioScenarioId | null;
  conservativePoint?: PortfolioCarryFrontierPoint | null;
  unhedgedOriginUsdM?: number | null;
  policyCapUsd?: number | null;
  carryTargetUsdYr?: number | null;
  scenarioDefs?: readonly PortfolioScenarioDef[];
  onApply: (id: PortfolioScenarioId, point: PortfolioCarryFrontierPoint) => void;
}) {
  const defs = scenarioDefs ?? portfolioScenarioDefs(
    frontier, confidencePct, conservativePoint, unhedgedOriginUsdM, policyCapUsd,
    undefined, carryTargetUsdYr,
  );
  const scenarios = defs.map(s => ({
    id: s.id,
    label: s.label,
    hint: s.breached
      ? `${s.label} — POLICY BREACH: base standalone exposure alone is above $${s.breachTierUsd?.toFixed(0)}M — no overlay sizing can fix this, escalate per fx-hedging-policy.md approval thresholds`
      : (s.point
        ? `${s.label} — ${fmtAbsK(s.point.portfolioVarUsd)} CFaR, ${fmtSignedK(s.point.totalCarryUsdYr)}/yr${
            s.id === 'carryTarget' ? ' · Target Carry on the open arm' : ''
          }${s.id === 'balanced' ? ' · tangent from (0,0)' : ''
          }${s.id === 'maxCarry' ? ' · policy CFaR cap' : ''}`
        : `${s.label} — ${s.disabledHint ?? 'not available yet'}`),
    // A breached point is not a valid scenario to apply — its VAR violates
    // its own reference tier before any overlay decision is made. Disabled,
    // same as "no point exists," but for a different, more serious reason.
    disabled: !s.point || s.breached,
    breached: s.breached,
    on: selectedId === s.id && !!s.point && !s.breached,
    apply: () => {
      if (!s.point || s.breached) return;
      onApply(s.id, s.point);
    },
  }));
  return (
    <div
      className="inline-flex rounded-md border border-amber-400/45 bg-slate-950 p-0.5"
      role="group"
      aria-label="Overlay sweet spot"
    >
      {scenarios.map(s => (
        <button
          key={s.id}
          type="button"
          disabled={s.disabled}
          aria-pressed={s.on}
          title={s.hint}
          onClick={s.apply}
          className={`rounded px-2 py-1 font-mono text-[11px] font-semibold transition-colors ${
            s.breached
              ? 'cursor-not-allowed bg-rose-500/20 text-rose-300'
              : s.on
                ? 'bg-amber-500/25 text-amber-100'
                : s.disabled
                  ? 'cursor-not-allowed text-slate-700'
                  : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          {s.breached ? '⚠ ' : ''}{s.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Shows the selected scenario's own point re-derived at other book sizes —
 * amount fields scale, cash_floor doesn't, so this is NOT a straight-line
 * readout: carry-per-VAR at a fixed amplitude ratio shifts as clamping
 * timing shifts, and past some amplitude the point can vanish entirely
 * (real clamp, past what the bounded universe window can reach). See
 * `scaleRowsByAmplitude` and fx-buffer.test.ts's amplitude-scaling suite.
 */
function ScenarioAmplitudeSensitivity({
  scenarioLabel,
  points,
}: {
  scenarioLabel: string;
  points: readonly { amplitude: number; point: PortfolioCarryFrontierPoint | null }[] | null;
}) {
  if (!points) return null;
  const onePt = points.find(p => Math.abs(p.amplitude - 1) < 1e-9)?.point ?? null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-800 bg-slate-950/60 px-2 py-1">
      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        Amplitude sensitivity · {scenarioLabel}
      </span>
      {points.map(({ amplitude, point }) => {
        // Non-linear tell: at a fixed amplitude ratio, VAR should scale
        // exactly by that ratio if nothing has clamped differently — a
        // ratio that drifts from `amplitude` itself is the floor's fixed
        // size biting at a different point in the scaled book.
        const ratio = point && onePt && onePt.portfolioVarUsd > 1e-6
          ? point.portfolioVarUsd / (onePt.portfolioVarUsd * amplitude)
          : null;
        const offLinear = ratio != null && Math.abs(ratio - 1) > 0.03;
        return (
          <span
            key={amplitude}
            className="inline-flex items-center gap-1 font-mono text-[9px]"
            title={point
              ? `${amplitude}× book — $${point.portfolioVarUsd.toFixed(1)}M CFaR, ${fmtSignedK(point.totalCarryUsdYr)}/yr carry`
              + (offLinear ? ` — off the ${amplitude}× line (fixed floor biting differently at this book size)` : '')
              : `${amplitude}× book — unavailable: the clamp point at this size is real but past what the bounded window can reach`}
          >
            <span className="text-slate-500">{amplitude}×</span>
            {point ? (
              <span className={offLinear ? 'text-amber-300' : 'text-slate-300'}>
                ${point.portfolioVarUsd.toFixed(1)}M
              </span>
            ) : (
              <span className="text-rose-400/70">—</span>
            )}
          </span>
        );
      })}
    </div>
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
  policyVAR,
  onPolicyVARChange,
  portfolioCarryK,
  onPortfolioCarryKChange,
  onPreparedByCcyChange,
  residualByCcy: residualByCcyProp,
  onResidualByCcyChange,
  portfolioScenarioId: portfolioScenarioIdProp,
  onPortfolioScenarioIdChange,
  extraForwards,
  stockNetByCcy,
}: LiquidityAnalyticsViewProps) {
  const months = setup.forecastMonths;
  const timing = resolveLiquidityTiming(forecastProfile) ?? DEFAULT_LIQUIDITY_TIMING;
  const liveStrategy = strategyForRegime(
    timing.sizingBasis ?? 'horizon',
    timing.bookingMode ?? 'rolling',
  );
  const [localResidualByCcy, setLocalResidualByCcy] = useState<Record<string, number>>(
    () => residualByCcyProp ?? {},
  );
  const residualByCcy = residualByCcyProp ?? localResidualByCcy;
  const setResidualByCcy = (next: Record<string, number>) => {
    if (onResidualByCcyChange) onResidualByCcyChange(next);
    else setLocalResidualByCcy(next);
  };
  const [lastMixResidual, setLastMixResidual] = useState<number | null>(null);
  /** Sole selection — chart / strip / regimes / summary all read this. */
  const [selection, setSelection] = useState<PortfolioSelection | null>(null);
  // Which currencies feed the portfolio Σ⁻¹μ overlay — null = all eligible
  // (default, no behavior change). Diagnostic/verification toggle: forcing
  // this down to a single currency should make the "Limited universe"
  // frontier converge onto that currency's own per-currency frontier.
  const [portfolioIncludedCcys, setPortfolioIncludedCcys] = useState<Set<string> | null>(null);
  const scenarioPolicyRef = useRef<number | null>(null);
  const scenarioPolicySyncedRef = useRef(false);
  const portfolioEligibleCcys = useMemo(
    () => Array.from(new Set(
      (bookRows ?? []).filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy]).map(r => r.ccy),
    )),
    [bookRows],
  );
  const isPortfolioCcyIncluded = (ccy: string) => !portfolioIncludedCcys || portfolioIncludedCcys.has(ccy);
  const pinDeskBudgetsOnCcyFilter = () => {
    // Filtered universe still consumes the full desk Policy VAR + Target Carry
    // — pin the dial so remap does not shrink the budget to the new marker X.
    scenarioPolicyRef.current = typeof policyVAR === 'number' ? policyVAR : 5;
    scenarioPolicySyncedRef.current = true;
  };
  const togglePortfolioCcy = (ccy: string) => {
    pinDeskBudgetsOnCcyFilter();
    setPortfolioIncludedCcys((prev) => {
      const base = prev ?? new Set(portfolioEligibleCcys);
      const next = new Set(base);
      if (next.has(ccy)) next.delete(ccy); else next.add(ccy);
      return next;
    });
  };
  const soloPortfolioCcy = (ccy: string) => {
    pinDeskBudgetsOnCcyFilter();
    setPortfolioIncludedCcys(new Set([ccy]));
  };
  const resetPortfolioCcys = () => {
    pinDeskBudgetsOnCcyFilter();
    setPortfolioIncludedCcys(null);
  };
  const setPortfolioScenarioId = (id: PortfolioScenarioId | null) => {
    if (onPortfolioScenarioIdChange) onPortfolioScenarioIdChange(id);
  };
  // Desk-persisted named id (custom is not persisted). Prefer live selection.
  const portfolioScenarioId: PortfolioScenarioId | null = selection
    ? (selection.kind === 'custom' ? null : selection.kind)
    : asPortfolioScenarioId(portfolioScenarioIdProp);

  const modeledOverlays = useMemo(
    () => mergeResidualOverlays(swapForwardOverlayByCcy, residualByCcy),
    [swapForwardOverlayByCcy, residualByCcy],
  );
  // Same displayed Net per CCY as the CFaR tab (MC + funding-swap bridge).
  // Cover-sizing `cfarNetByCcyUsd` is FX-only and is not this number.
  const tabNetByCcyUsd = useMemo(
    () => {
      const T = setup.forecastMonths;
      const forwards = extraForwards
        ?? analyticsForwardsFromOverlays({
          overlayByCcy: modeledOverlays,
          planByCcy: livePlanByCcy,
          forecastMonths: T,
        });
      return fxHedgeNetCfarByCcyUsdM({
        rows: bookRows ?? [],
        setup,
        forecastProfile,
        bookedHedges,
        preparedByCcy,
        marketRatesByCcy,
        ratesScopeId,
        fundingPlanByCcy: livePlanByCcy,
        swapForwardOverlayByCcy: modeledOverlays,
        extraForwards: forwards,
        stockNetByCcy,
      });
    },
    [
      bookRows,
      setup,
      forecastProfile,
      bookedHedges,
      preparedByCcy,
      marketRatesByCcy,
      ratesScopeId,
      livePlanByCcy,
      modeledOverlays,
      extraForwards,
      stockNetByCcy,
    ],
  );
  const modeledDeskCip = useMemo(() => {
    if (!deskCipByCcyUsdM) return deskCipByCcyUsdM;
    const picked = Object.keys(residualByCcy);
    if (picked.length === 0) return deskCipByCcyUsdM;
    const next = { ...deskCipByCcyUsdM };
    for (const ccy of picked) delete next[ccy];
    return next;
  }, [deskCipByCcyUsdM, residualByCcy]);

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
        swapForwardOverlayByCcy: modeledOverlays,
        cfarNetByCcyUsd,
        deskShared,
        deskHedgeCarryByCcyUsdM,
        deskCashCarryByCcyUsdM,
        deskCipByCcyUsdM: modeledDeskCip,
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
      modeledOverlays,
      cfarNetByCcyUsd,
      deskShared,
      deskHedgeCarryByCcyUsdM,
      deskCashCarryByCcyUsdM,
      modeledDeskCip,
    ],
  );
  const rUsd = input.shared.r_USD;
  const results = useMemo(() => evaluateLiquidityStrategies(input), [input]);
  const [selectedId, setSelectedId] = useState<LiquidityStrategyId>(
    liveStrategy.id,
  );
  const conservativeBook = useMemo(
    () => pickConservativeFundingBook(results, selectedId),
    [results, selectedId],
  );
  const tabAllCcyNetUsdM = useMemo(() => {
    const picked: Record<string, number> = {};
    for (const [ccy, v] of Object.entries(tabNetByCcyUsd)) {
      if (ccy === 'USD') continue;
      if (!isPortfolioCcyIncluded(ccy)) continue;
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) picked[ccy] = v;
    }
    return sumNetCfarUsdM(picked);
  }, [tabNetByCcyUsd, portfolioIncludedCcys]);
  const unfundedPortCfarUsdM = tabAllCcyNetUsdM;
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
      cfarNetByCcyUsd: tabNetByCcyUsd,
      setup,
      bookedHedges,
      preparedByCcy,
      marketRatesByCcy,
      ratesScopeId,
      swapForwardOverlayByCcy: modeledOverlays,
    }),
    [
      months,
      input.shared,
      input.activeLayers,
      input.hedgeSettleByCcy,
      forecastProfile,
      tabNetByCcyUsd,
      setup,
      bookedHedges,
      preparedByCcy,
      marketRatesByCcy,
      ratesScopeId,
      modeledOverlays,
    ],
  );
  // Same S(t) = t × S_book walk as the per-currency left-end. Conservative
  // is t = 1 on that arm — one pricer, no shape break.
  const universeFrontier = useMemo(() => {
    if (bufferLevelOf(activeLayers) !== 'portfolio') return null;
    const rows = (bookRows ?? [])
      .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && isPortfolioCcyIncluded(r.ccy));
    if (rows.length < 1) return null;
    const book = results.find(r => r.strategy.id === selectedId) ?? conservativeBook;
    if (book) {
      const liq = buildPortfolioLiquidityFrontier({
        result: book,
        strategy: book.strategy,
        rows: rows as RowState[],
        engine: frontierEngineInput,
      });
      return toPortfolioCarryFrontier(liq);
    }
    const base = {
      rows: rows as RowState[],
      shared: input.shared,
      activeLayers: activeLayers ?? new Set(),
      forecastProfile,
      hedgeSettleByCcy: input.hedgeSettleByCcy,
      cfarNetByCcyUsd: tabNetByCcyUsd,
      marketRatesByCcy,
    };
    const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
    return computePortfolioCarryFrontier({
      ...base,
      policyVAR: maxTier,
      unhedgedCfarUsdM: tabAllCcyNetUsdM,
    }, 48, 1, true);
  }, [
    activeLayers,
    bookRows,
    conservativeBook,
    results,
    selectedId,
    frontierEngineInput,
    input.shared,
    input.hedgeSettleByCcy,
    forecastProfile,
    tabNetByCcyUsd,
    tabAllCcyNetUsdM,
    marketRatesByCcy,
    portfolioIncludedCcys,
  ]);
  // CFaR-tab All CCY Net (Σ of Nets). Both arms leave this vertex.
  const unhedgedOriginUsdM = (
    universeFrontier?.points[0]?.portfolioVarUsd
    && universeFrontier.points[0]!.portfolioVarUsd > 1e-9
  )
    ? universeFrontier.points[0]!.portfolioVarUsd
    : tabAllCcyNetUsdM;
  const conservativePoint = useMemo(() => {
    const hold = universeFrontier?.points.find(p => Math.abs(p.k - 1) < 1e-6);
    return hold ?? null;
  }, [universeFrontier]);
  const regimeChartCfarById = useMemo(() => {
    const map = new Map<string, { sumUsdM: number; portUsdM: number }>();
    const rows = (bookRows ?? [])
      .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && isPortfolioCcyIncluded(r.ccy));
    for (const r of results) {
      if (r.strategy.id === 'unfunded') {
        map.set(r.strategy.id, {
          sumUsdM: tabAllCcyNetUsdM,
          portUsdM: tabAllCcyNetUsdM,
        });
        continue;
      }
      if (
        conservativeBook
        && r.strategy.id === conservativeBook.strategy.id
        && conservativePoint
      ) {
        map.set(r.strategy.id, {
          sumUsdM: conservativePoint.portfolioVarUsd,
          portUsdM: conservativePoint.portfolioVarUsd,
        });
        continue;
      }
      if (rows.length < 1) {
        map.set(r.strategy.id, {
          sumUsdM: tabAllCcyNetUsdM,
          portUsdM: tabAllCcyNetUsdM,
        });
        continue;
      }
      map.set(r.strategy.id, priceRegimeChartCfar({
        result: r,
        strategy: r.strategy,
        rows: rows as RowState[],
        engine: frontierEngineInput,
      }));
    }
    return map;
  }, [
    results,
    bookRows,
    conservativeBook,
    conservativePoint,
    tabAllCcyNetUsdM,
    frontierEngineInput,
    portfolioIncludedCcys,
  ]);

  const scenarioCapUsd = approvalTierCapUsd(policyVAR);
  const carryTargetUsdYr = deskCarryTargetUsdYr(portfolioCarryK);

  // Re-derives the selected scenario's own point at other book sizes —
  // amount fields scale with the book, but cash_floor does NOT (it is a
  // fixed operational threshold, not proportional to position size). That
  // asymmetry is exactly what makes the clamp point / knee availability a
  // non-linear function of book size: see the fx-buffer.test.ts suite
  // "position-amplitude scaling" for the proof this mirrors.
  const scenarioAmplitudeSensitivity = useMemo(() => {
    const ampId = selection && selection.kind !== 'custom' ? selection.kind : null;
    if (!ampId) return null;
    const rows = (bookRows ?? [])
      .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && isPortfolioCcyIncluded(r.ccy)) as RowState[];
    if (rows.length < 1) return null;
    const amplitudes = [0.5, 1, 2, 5, 10];
    const base = {
      shared: input.shared,
      activeLayers: activeLayers ?? new Set(),
      forecastProfile,
      hedgeSettleByCcy: input.hedgeSettleByCcy,
      cfarNetByCcyUsd,
      marketRatesByCcy,
    };
    const maxTier = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
    return amplitudes.map((amplitude) => {
      const scaledRows = scaleRowsByAmplitude(rows, amplitude);
      const probe = computePortfolioCarryFrontier({ ...base, rows: scaledRows, policyVAR: maxTier }, 5, 1);
      const cap = universePolicyVarCap(probe.nearestClampVarUsd);
      const fine = computePortfolioCarryFrontier({ ...base, rows: scaledRows, policyVAR: cap }, 10, 1);
      const point = portfolioScenarioDefs(
        fine, setup.confidencePct, conservativePoint, unhedgedOriginUsdM, scenarioCapUsd,
        undefined, carryTargetUsdYr,
      ).find(s => s.id === ampId)?.point ?? null;
      return { amplitude, point };
    });
  }, [
    selection,
    bookRows,
    input.shared,
    activeLayers,
    forecastProfile,
    input.hedgeSettleByCcy,
    cfarNetByCcyUsd,
    marketRatesByCcy,
    setup.confidencePct,
    portfolioIncludedCcys,
    conservativePoint,
    unhedgedOriginUsdM,
    scenarioCapUsd,
    carryTargetUsdYr,
  ]);

  useEffect(() => {
    if (!selection) return;
    if (selection.kind === 'maxCarry') {
      scenarioPolicyRef.current = policyVAR ?? 5;
      scenarioPolicySyncedRef.current = true;
      return;
    }
    if (selection.kind === 'custom') {
      const pinned = scenarioPolicyRef.current;
      if (pinned == null) return;
      if (Math.abs((policyVAR ?? 5) - pinned) < 0.05) {
        scenarioPolicySyncedRef.current = true;
      }
      return;
    }
    const pinned = scenarioPolicyRef.current;
    if (pinned == null) return;
    if (Math.abs((policyVAR ?? 5) - pinned) < 0.05) {
      scenarioPolicySyncedRef.current = true;
      return;
    }
    if (!scenarioPolicySyncedRef.current) return;
    // Dial moved off the named sweet spot → clear selection (keep custom intact above).
    setSelection(null);
    setPortfolioScenarioId(null);
    scenarioPolicyRef.current = null;
    scenarioPolicySyncedRef.current = false;
  }, [policyVAR, selection]);

  const commitSelection = (
    kind: SolutionScenarioId,
    point: PortfolioCarryFrontierPoint,
  ) => {
    const nextPoint = normalizeSelectionPoint(kind, point, unhedgedOriginUsdM);
    setSelection({ kind, point: nextPoint });
    setPortfolioScenarioId(persistScenarioId(kind) as PortfolioScenarioId | null);
    const tier = approvalTierCapUsd(policyVAR);
    const v = policyVarForSelection({
      kind,
      point: nextPoint,
      policyVAR,
      approvalTierUsd: tier,
    });
    if (v != null) {
      scenarioPolicyRef.current = v;
      scenarioPolicySyncedRef.current = false;
      onPolicyVARChange?.(v);
    } else {
      scenarioPolicyRef.current = typeof policyVAR === 'number' ? policyVAR : tier;
      scenarioPolicySyncedRef.current = true;
    }
    // Desk Total Carry ask is independent of which sweet-spot is selected.
    // Clearing it here made the Buffer Carry modal / Carry Target reset to
    // $32k whenever the user picked Balanced / Max Policy Risk / filtered
    // and remapped onto another scenario.
    if (onLayerToggle && !(activeLayers?.has('carryOptim') ?? false)) {
      onLayerToggle('carryOptim');
    }
  };

  const mvFrontier = useMemo((): EfficientCarryVarFrontier | null => {
    if (bufferLevelOf(activeLayers) !== 'portfolio') return null;
    const rows = (bookRows ?? [])
      .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && isPortfolioCcyIncluded(r.ccy));
    if (rows.length < 1) return null;
    const rUsd = input.shared.r_USD;
    const bookingMode = timing.bookingMode ?? 'rolling';
    const tenorMonths = bookingMode === 'rolling'
      ? 1
      : Math.max(1, input.shared.forecastMonths ?? months);
    const ccys = rows.map(r => r.ccy);
    const mu = rows.map(r => (
      impliedPortfolioRFcyPct(
        r.ccy, r.r_FCY, rUsd, marketRatesByCcy, tenorMonths,
      ) - rUsd
    ) / 100);
    const varCapUsdM = policyVAR ?? 5;
    // Full desk Policy VAR is the overlay cap for the *included* CCYs only —
    // filtering does not scale the budget down; the subset gets 100% of it.
    const basesFcy = rows.map(r => overlayBookBaseFcyM(r));
    const rOd = rows.map(r => r.r_OD);
    const fixedCfarUsdM = activeLayers?.has('cfarCover')
      ? rows.map(r => Math.abs(cfarNetByCcyUsd?.[r.ccy] ?? 0))
      : undefined;
    const floorFcy = activeLayers?.has('floorH')
      ? rows.map(r => r.cash_floor)
      : undefined;
    return buildEfficientCarryVarFrontier({
      ccys,
      mu,
      varCapUsdM,
      basesFcy,
      rOd,
      r_USD: rUsd,
      fixedCfarUsdM,
      floorFcy,
    });
  }, [
    activeLayers,
    bookRows,
    cfarNetByCcyUsd,
    input.shared.r_USD,
    input.shared.forecastMonths,
    timing.bookingMode,
    months,
    marketRatesByCcy,
    policyVAR,
    portfolioIncludedCcys,
  ]);

  const solutionFrontier = useMemo(() => {
    if (!universeFrontier) return null;
    const overlayOn = (
      bufferLevelOf(activeLayers) === 'portfolio'
      && activeLayers?.has('carryOptim') === true
      && (mvFrontier?.capLegs.length ?? 0) > 0
    );
    if (!overlayOn) return universeFrontier;
    return liftFrontierToTotalCarry({
      frontier: universeFrontier,
      capLegs: mvFrontier!.capLegs,
      policyCapUsd: scenarioCapUsd,
    });
  }, [universeFrontier, activeLayers, mvFrontier, scenarioCapUsd]);

  const solutionConservative = useMemo(
    () => solutionFrontier?.points.find(p => Math.abs(p.k - 1) < 1e-6) ?? conservativePoint,
    [solutionFrontier, conservativePoint],
  );

  const scenarioDefs = useMemo(() => {
    const pts = solutionFrontier?.points ?? [];
    const carryS = pts.length > 0 ? plotCarryS(pts) : undefined;
    return portfolioScenarioDefs(
      solutionFrontier, setup.confidencePct, solutionConservative, unhedgedOriginUsdM, scenarioCapUsd,
      carryS, carryTargetUsdYr,
    );
  }, [
    solutionFrontier, setup.confidencePct, solutionConservative, unhedgedOriginUsdM,
    scenarioCapUsd, carryTargetUsdYr,
  ]);

  // Hydrate named selection once from desk persist when local selection is empty.
  const hydratedScenarioRef = useRef(false);
  useEffect(() => {
    if (hydratedScenarioRef.current || selection != null) return;
    const id = asPortfolioScenarioId(portfolioScenarioIdProp);
    if (!id || !solutionFrontier) return;
    const point = pointForScenario({
      frontier: solutionFrontier,
      scenarioId: id,
      policyCapUsd: scenarioCapUsd,
      carryTargetUsdYr,
      confidencePct: setup.confidencePct,
    });
    if (!point) return;
    hydratedScenarioRef.current = true;
    setSelection({
      kind: id,
      point: normalizeSelectionPoint(id, point, unhedgedOriginUsdM),
    });
  }, [
    selection,
    portfolioScenarioIdProp,
    solutionFrontier,
    scenarioCapUsd,
    carryTargetUsdYr,
    setup.confidencePct,
    unhedgedOriginUsdM,
  ]);

  // Desk Total Carry ask → Carry Target selection (only when $K changes).
  const lastWiredCarryKRef = useRef<number | null>(null);
  useEffect(() => {
    if (portfolioCarryK == null || !Number.isFinite(portfolioCarryK)) {
      lastWiredCarryKRef.current = null;
      return;
    }
    if (lastWiredCarryKRef.current === portfolioCarryK) return;
    if (!solutionFrontier) return;
    const point = pointForScenario({
      frontier: solutionFrontier,
      scenarioId: 'carryTarget',
      policyCapUsd: scenarioCapUsd,
      carryTargetUsdYr: deskCarryTargetUsdYr(portfolioCarryK),
      confidencePct: setup.confidencePct,
    });
    if (!point) {
      setPortfolioScenarioId('carryTarget');
      return;
    }
    lastWiredCarryKRef.current = portfolioCarryK;
    commitSelection('carryTarget', point);
  }, [portfolioCarryK, solutionFrontier, scenarioCapUsd, setup.confidencePct]);

  // Frontier rebuilt (CCY filter / overlay / cap) → re-price active selection
  // onto the new arm so chart markers, strip, and regimes stay lockstep.
  // Keep desk Policy VAR + Target Carry as the full budgets for whatever
  // CCYs remain — do not write the remapped marker X back into the dial.
  useEffect(() => {
    if (!selection || !solutionFrontier) return;
    const remapped = remapSelectionToFrontier({
      selection,
      frontier: solutionFrontier,
      policyCapUsd: scenarioCapUsd,
      carryTargetUsdYr,
      confidencePct: setup.confidencePct,
      unhedgedOriginUsdM,
    });
    if (!remapped) {
      if (selection.kind === 'custom') return;
      setSelection(null);
      setPortfolioScenarioId(null);
      return;
    }
    if (selectionPointsEqual(remapped.point, selection.point)) return;
    setSelection(remapped);
    scenarioPolicyRef.current = typeof policyVAR === 'number' ? policyVAR : scenarioCapUsd;
    scenarioPolicySyncedRef.current = true;
  }, [
    solutionFrontier,
    selection,
    scenarioCapUsd,
    carryTargetUsdYr,
    setup.confidencePct,
    unhedgedOriginUsdM,
    policyVAR,
  ]);

  const selectedScenario = useMemo(() => {
    if (!portfolioScenarioId) return null;
    return scenarioDefs.find(s => s.id === portfolioScenarioId) ?? null;
  }, [portfolioScenarioId, scenarioDefs]);

  const selectedPlotLabel = selection
    ? (selection.kind === 'custom'
      ? 'Custom'
      : (scenarioDefs.find(s => s.id === selection.kind)?.label ?? selection.kind))
    : (solutionConservative ? 'Carry Target' : 'Unhedged');

  const selected =
    results.find(r => r.strategy.id === selectedId)
    ?? results.find(r => r.strategy.id === liveStrategy.id)
    ?? results[0];
  const solutionPick = useMemo((): SolutionPick | null => {
    if (!selected || !solutionFrontier || !selection) return null;
    const rows = (bookRows ?? [])
      .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && isPortfolioCcyIncluded(r.ccy));
    if (rows.length < 1) return null;
    const overlayOn = (
      bufferLevelOf(activeLayers) === 'portfolio'
      && activeLayers?.has('carryOptim') === true
    );
    return buildSolutionPick({
      regimeId: selected.strategy.id,
      scenarioId: selected.strategy.id === 'unfunded' ? 'unhedged' : selection.kind,
      point: selection.point,
      frontier: solutionFrontier,
      policyCapUsd: scenarioCapUsd,
      result: selected,
      rows: rows as RowState[],
      engine: frontierEngineInput,
      capLegs: overlayOn ? mvFrontier?.capLegs : undefined,
    });
  }, [
    selected,
    solutionFrontier,
    selection,
    bookRows,
    activeLayers,
    scenarioCapUsd,
    frontierEngineInput,
    mvFrontier,
    portfolioIncludedCcys,
  ]);
  const plotOverlayLegs = solutionPick?.overlayLegs;

  /** Checked sweet-spot on every funded programme — same Selection as strip / chart. */
  const regimeSolutionById = useMemo(() => {
    const map = new Map<string, { totalCarryUsdYr: number; portUsdM: number }>();
    if (!solutionPick || !solutionFrontier || !selection) return map;
    const scenarioId = selection.kind;
    const rows = (bookRows ?? [])
      .filter(r => r.ccy !== 'USD' && CURRENCY_PARAMS[r.ccy] && isPortfolioCcyIncluded(r.ccy));
    if (rows.length < 1) return map;
    const overlayOn = (
      bufferLevelOf(activeLayers) === 'portfolio'
      && activeLayers?.has('carryOptim') === true
    );
    const capLegs = overlayOn ? mvFrontier?.capLegs : undefined;
    const customPoint = scenarioId === 'custom' ? selection.point : null;
    for (const r of results) {
      if (r.strategy.id === 'unfunded') continue;
      if (r.strategy.id === selected?.strategy.id) {
        map.set(r.strategy.id, {
          totalCarryUsdYr: solutionPick.point.totalCarryUsdYr,
          portUsdM: solutionPick.point.portfolioVarUsd,
        });
        continue;
      }
      const liq = buildPortfolioLiquidityFrontier({
        result: r,
        strategy: r.strategy,
        rows: rows as RowState[],
        engine: frontierEngineInput,
      });
      const raw = toPortfolioCarryFrontier(liq);
      const lifted = liftFrontierToTotalCarry({
        frontier: raw,
        capLegs,
        policyCapUsd: scenarioCapUsd,
      });
      const point = pointForScenario({
        frontier: lifted,
        scenarioId,
        policyCapUsd: scenarioCapUsd,
        carryTargetUsdYr,
        confidencePct: setup.confidencePct,
        customPoint,
      });
      if (!point) continue;
      map.set(r.strategy.id, {
        totalCarryUsdYr: point.totalCarryUsdYr,
        portUsdM: point.portfolioVarUsd,
      });
    }
    return map;
  }, [
    selection,
    solutionFrontier,
    bookRows,
    activeLayers,
    mvFrontier,
    results,
    solutionPick,
    selected,
    frontierEngineInput,
    scenarioCapUsd,
    carryTargetUsdYr,
    setup.confidencePct,
    portfolioIncludedCcys,
  ]);
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
  const overdraftCfarUsdM = unhedgedOriginUsdM > 1e-9
    ? unhedgedOriginUsdM
    : (unfunded?.finalCfarUsdM ?? 0);
  const selectedCfarUsdM = solutionPick?.point.portfolioVarUsd
    ?? (selected.strategy.id === 'unfunded' ? overdraftCfarUsdM : selected.finalCfarUsdM);
  const summaryCarryUsdYr = solutionPick?.point.totalCarryUsdYr ?? book.total / 1000;
  const weightedUsdM = solutionPick
    ? solutionWeightedReturnUsdM(
      solutionPick.point.totalCarryUsdYr,
      solutionPick.point.portfolioVarUsd,
      setup.confidencePct,
    )
    : probabilityWeightedReturnUsdM(
      book.total / 1000,
      selectedCfarUsdM,
      setup.confidencePct,
      overdraftCfarUsdM,
    );
  const dial = liquidityFrontierDial(input.activeLayers);
  const constraintHue =
    selected.constraint === 'var'
      ? 'text-sky-300'
      : selected.constraint === 'carry'
        ? 'text-emerald-300'
        : 'text-slate-300';
  const portfolioLevel = bufferLevelOf(activeLayers) === 'portfolio';
  const carryOn = activeLayers?.has('carryOptim') === true;
  const overlayActiveForModal = portfolioLevel && carryOn && mvFrontier != null;
  const namedScenarioLabel = selection
    ? (selection.kind === 'custom'
      ? 'Custom'
      : (selectedScenario?.label ?? selection.kind))
    : null;
  const activeScenarioLabel = overlayActiveForModal
    ? (namedScenarioLabel
      ?? (portfolioCarryK != null
        ? 'Custom Total Carry target'
        : `Custom $${(policyVAR ?? 5).toFixed(1)}M`))
    : namedScenarioLabel;
  const inspectOverlayLeg = inspectRow && overlayActiveForModal
    ? (solutionPick?.overlayLegs.find(l => l.ccy === inspectRow.ccy) ?? null)
    : null;

  const setCcyResidual = (ccy: string, residual: number) => {
    setLastMixResidual(residual);
    setResidualByCcy({ ...residualByCcy, [ccy]: residual });
  };

  const profileForStrip = (
    ccy: string,
    residual: number,
    schedule: LiquidityStrategyCcy['schedule'],
  ) =>
    fundingStripPreparedProfile({
      ccy,
      schedule,
      residual,
      forecastMonths: months,
      marketRates: resolveMarketRatesForCcy(
        marketRatesByCcy, ccy, ratesScopeId,
      ),
      ratesScopeId,
    });

  const stageFundingStrip = (
    ccy: string,
    residual: number,
    schedule: LiquidityStrategyCcy['schedule'],
  ) => {
    if (!onPreparedByCcyChange) return;
    const profile = profileForStrip(ccy, residual, schedule);
    if (!profile) return;
    onPreparedByCcyChange(prev =>
      setPreparedHedgeForCcy(prev, ccy, profile),
    );
  };

  const stageAllFundingStrips = () => {
    if (!onPreparedByCcyChange) return;
    onPreparedByCcyChange(prev => {
      let next = prev;
      let changed = false;
      for (const c of selected.byCcy) {
        const residual = residualByCcy[c.ccy];
        if (residual == null || !residualNeedsFxStage(residual)) continue;
        const profile = profileForStrip(c.ccy, residual, c.schedule);
        if (!profile) continue;
        next = setPreparedHedgeForCcy(next, c.ccy, profile);
        changed = true;
      }
      return changed ? next : prev;
    });
  };

  const resetDeskPrograms = () => {
    setResidualByCcy({});
    setLastMixResidual(null);
    if (!onPreparedByCcyChange) return;
    onPreparedByCcyChange(prev => {
      let next = prev;
      let changed = false;
      for (const [ccy, profile] of Object.entries(prev)) {
        if (profile.preparedFor !== 'liquidity') continue;
        next = clearPreparedHedgeForCcy(next, ccy);
        changed = true;
      }
      return changed ? next : prev;
    });
  };

  const applyPortfolioDelta = () => {
    const residual = lastMixResidual;
    if (residual == null) return;
    const next: Record<string, number> = {};
    for (const c of selected.byCcy) next[c.ccy] = residual;
    setResidualByCcy(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2.5 px-0.5">
        <span className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-400">
          r_USD {rUsd.toFixed(2)}%
        </span>
        <span className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-400">
          Tf {months}m
        </span>
      </div>

      <section>
        <ChapterLabel
          n={1}
          title="Summary"
          info={
            <>
              <p>
                Prices the funding programme covering the dated-path dip — not a fourth risk metric.
              </p>
              <p className="mt-1.5">
                Total carry is Cash + FWD + Swap cash + CIP. Final CFaR is FX Net RSS’d with the
                funding-swap bridge (overdraft is FX-only). Weighted return is Carry − standing CFaR
                × {tailPct}%. Preview is a what-if — it is not the booked programme.
              </p>
            </>
          }
        />
        <div className="grid grid-cols-4 divide-x divide-slate-800 overflow-hidden rounded-[10px] border border-slate-700 bg-slate-950/50">
          <SummaryCard
            label="Total carry"
            value={fmtSignedK(summaryCarryUsdYr, 0)}
            sub={
              solutionPick
                ? `${selectedPlotLabel} · ${selected.strategy.label.toLowerCase()}`
                : `Cash + FWD + Swap cash + CIP · ${selected.strategy.label.toLowerCase()}`
            }
            tone="carry"
            valueClass={moneyTone(summaryCarryUsdYr)}
          />
          <SummaryCard
            label={`Final CFaR · ${setup.confidencePct}%`}
            value={fmtAbsK(selectedCfarUsdM)}
            sub={
              selected.strategy.id === 'unfunded'
                ? 'CFaR-tab FX-only Net · no funding-swap bridge'
                : solutionPick
                  ? `${selectedPlotLabel} Port. CFaR`
                  : 'FX section RSS with the funding-swap bridge'
            }
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
              valueClass="text-emerald-300"
            />
          ) : (
            <SummaryCard
              label="Preview"
              value={selected.strategy.label}
              sub={`Live regime is ${liveStrategy.label} · ${bufferConstraintLabel(selected.constraint)} · ${selected.constraintDetail || 'No layer'}`}
              tone="preview"
              valueClass="text-violet-300"
            />
          )}
        </div>
      </section>

      <section>
        <ChapterLabel
          n={2}
          title="Controls"
          info={
            <>
              <p>
                Weighted return uses Carry − standing CFaR × {tailPct}% (above origin). Confidence
                chips write the shared CFaR level.
              </p>
              <p className="mt-1.5">
                {bufferLevelOf(activeLayers) === 'portfolio'
                  ? `Portfolio level · Σ⁻¹μ long/short mix · Policy VAR is the approval cap · Sweet spot is ${
                      activeScenarioLabel ?? 'the Policy VAR fill'
                    }.`
                  : 'Per-currency chips — same stack as the Liquidity tab.'}
                {' '}Binding dial → {liquidityFrontierDialLabel(dial)}
                {selected.constraintDetail ? ` · ${selected.constraintDetail}` : ''}.
              </p>
            </>
          }
        />
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
            </div>
            <div className="min-w-0 border-slate-800 md:border-l md:pl-6">
              <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
                Buffer regime
              </div>
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <div
                  className="inline-flex rounded-md border border-slate-700 bg-slate-950 p-0.5"
                  role="group"
                  aria-label="Buffer level"
                >
                  {(['currency', 'portfolio'] as const).map(level => {
                    const on = bufferLevelOf(activeLayers) === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        disabled={!onLayerToggle}
                        aria-pressed={on}
                        onClick={() => {
                          if (!onLayerToggle) return;
                          setBufferLevel(activeLayers, level, onLayerToggle);
                          if (level === 'currency' && layerPanel === 'portfolioDiv') {
                            onLayerPanelChange?.(null);
                          }
                        }}
                        title={
                          level === 'portfolio'
                            ? 'Same chips, book mix: Σ⁻¹μ overlay · Policy VAR + USD budget'
                            : 'Same chips, each currency on its own floor / σ / carry ask'
                        }
                        className={`rounded px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors ${
                          on
                            ? 'bg-violet-500/25 text-violet-100'
                            : 'text-slate-500 hover:text-slate-300'
                        } ${onLayerToggle ? '' : 'cursor-default opacity-80'}`}
                      >
                        {level === 'currency' ? 'Currency' : 'Portfolio'}
                      </button>
                    );
                  })}
                </div>
                {bufferLevelOf(activeLayers) === 'portfolio' && (
                  <div
                    className="inline-flex rounded-md border border-violet-400/45 bg-slate-950 p-0.5"
                    role="group"
                    aria-label="Policy VAR"
                  >
                    {POLICY_VAR_LIMITS.map(pl => {
                      const on = (policyVAR ?? 5) === pl.usd;
                      return (
                        <button
                          key={pl.usd}
                          type="button"
                          disabled={!onPolicyVARChange}
                          title={`${pl.label} · ${pl.who} approval`}
                          onClick={() => {
                            const keepMaxCarry = selection?.kind === 'maxCarry';
                            scenarioPolicyRef.current = pl.usd;
                            scenarioPolicySyncedRef.current = keepMaxCarry;
                            if (!keepMaxCarry) {
                              setSelection(null);
                              setPortfolioScenarioId(null);
                            }
                            onPolicyVARChange?.(pl.usd);
                          }}
                          className={`rounded px-2 py-1 font-mono text-[11px] font-semibold transition-colors ${
                            on
                              ? 'bg-violet-500/25 text-violet-100'
                              : 'text-slate-500 hover:text-slate-300'
                          } ${onPolicyVARChange ? '' : 'cursor-default opacity-80'}`}
                        >
                          {pl.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {bufferLevelOf(activeLayers) === 'portfolio' && (
                <div className="mb-1.5 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-amber-200/90">
                      Sweet spot
                    </span>
                    <PortfolioScenarioPresets
                      frontier={solutionFrontier}
                      confidencePct={setup.confidencePct}
                      selectedId={portfolioScenarioId}
                      conservativePoint={solutionConservative}
                      unhedgedOriginUsdM={unhedgedOriginUsdM}
                      policyCapUsd={approvalTierCapUsd(policyVAR)}
                      carryTargetUsdYr={carryTargetUsdYr}
                      scenarioDefs={scenarioDefs}
                      onApply={(id, point) => commitSelection(id, point)}
                    />
                  </div>
                  {selection && selection.kind !== 'custom' && (
                    <ScenarioAmplitudeSensitivity
                      scenarioLabel={selectedScenario?.label ?? selection.kind}
                      points={scenarioAmplitudeSensitivity}
                    />
                  )}
                </div>
              )}
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
        bookRows={bookRows ?? []}
        onSelect={setSelectedId}
        portfolioLevel={bufferLevelOf(activeLayers) === 'portfolio'}
        carryOn={activeLayers?.has('carryOptim') === true}
        mvFrontier={mvFrontier}
        overlayScenarioLabel={activeScenarioLabel}
        universeFrontier={solutionFrontier}
        policyVAR={policyVAR ?? 5}
        portfolioScenarioId={portfolioScenarioId}
        conservativePoint={solutionConservative}
        carryTargetUsdYr={carryTargetUsdYr}
        unhedgedOriginUsdM={unhedgedOriginUsdM}
        regimeChartCfarById={regimeChartCfarById}
        selectedPlotLabel={selectedPlotLabel}
        solutionPick={solutionPick}
        regimeSolutionById={regimeSolutionById}
        plotOverlayLegs={plotOverlayLegs}
        scenarioDefs={scenarioDefs}
        selection={selection}
        tabNetByCcyUsd={tabNetByCcyUsd}
        onCommitSelection={commitSelection}
        portfolioIncludedCcys={portfolioIncludedCcys}
        onTogglePortfolioCcy={togglePortfolioCcy}
        onSoloPortfolioCcy={soloPortfolioCcy}
        onResetPortfolioCcys={resetPortfolioCcys}
      />

      <SelectedStrategyDetail
        result={selected}
        isLive={isLive}
        onInspectCcy={setInspectCcy}
        residualByCcy={residualByCcy}
        onResidualChange={setCcyResidual}
        preparedByCcy={preparedByCcy}
        overlayLegs={portfolioLevel && carryOn ? plotOverlayLegs : undefined}
        onStage={onPreparedByCcyChange ? stageFundingStrip : undefined}
        onStageAll={onPreparedByCcyChange ? stageAllFundingStrips : undefined}
        onResetDesk={resetDeskPrograms}
        onApplyPortfolioDelta={portfolioLevel ? applyPortfolioDelta : undefined}
        canApplyPortfolioDelta={
          portfolioLevel && lastMixResidual != null
        }
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
          onPickResidual={residual => setCcyResidual(inspectRow.ccy, residual)}
          onStage={
            onPreparedByCcyChange
              ? residual => {
                  const row = selected.byCcy.find(c => c.ccy === inspectRow.ccy);
                  if (!row || !residualNeedsFxStage(residual)) return;
                  setCcyResidual(inspectRow.ccy, residual);
                  stageFundingStrip(inspectRow.ccy, residual, row.schedule);
                }
              : undefined
          }
          staged={preparedByCcy?.[inspectRow.ccy]?.preparedFor === 'liquidity'}
          portfolioSuggestion={
            inspectOverlayLeg && activeScenarioLabel
              ? {
                  fcyM: inspectOverlayLeg.fcyM,
                  usdM: inspectOverlayLeg.usdM,
                  side: inspectOverlayLeg.side,
                  scenarioLabel: activeScenarioLabel,
                }
              : null
          }
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
    <div className="min-w-0 px-2.5 py-1.5" title={sub}>
      <div className={`font-mono text-[9px] font-semibold uppercase tracking-[0.08em] ${labelFg}`}>
        {label}
      </div>
      <div className={`truncate font-mono text-sm font-semibold tabular-nums leading-tight ${valueFg}`}>
        {value}
      </div>
    </div>
  );
}

function RegimeSummaryTable({
  results,
  liveId,
  selectedId,
  confidencePct,
  constraintHue,
  bookRows,
  onSelect,
  portfolioLevel,
  carryOn,
  mvFrontier,
  overlayScenarioLabel,
  universeFrontier,
  policyVAR,
  portfolioScenarioId,
  conservativePoint,
  carryTargetUsdYr,
  unhedgedOriginUsdM,
  regimeChartCfarById,
  selectedPlotLabel,
  solutionPick,
  regimeSolutionById,
  plotOverlayLegs,
  scenarioDefs,
  selection,
  tabNetByCcyUsd,
  onCommitSelection,
  portfolioIncludedCcys,
  onTogglePortfolioCcy,
  onSoloPortfolioCcy,
  onResetPortfolioCcys,
}: {
  results: readonly LiquidityStrategyResult[];
  liveId: LiquidityStrategyId;
  selectedId: LiquidityStrategyId;
  confidencePct: number;
  constraintHue: string;
  bookRows: readonly RowState[];
  onSelect: (id: LiquidityStrategyId) => void;
  portfolioLevel: boolean;
  carryOn: boolean;
  mvFrontier: EfficientCarryVarFrontier | null;
  overlayScenarioLabel: string | null;
  universeFrontier: PortfolioCarryFrontier | null;
  policyVAR: number;
  portfolioScenarioId: PortfolioScenarioId | null;
  conservativePoint: PortfolioCarryFrontierPoint | null;
  carryTargetUsdYr?: number | null;
  unhedgedOriginUsdM: number;
  regimeChartCfarById: ReadonlyMap<string, { sumUsdM: number; portUsdM: number }>;
  selectedPlotLabel: string;
  solutionPick: SolutionPick | null;
  regimeSolutionById: ReadonlyMap<string, { totalCarryUsdYr: number; portUsdM: number }>;
  plotOverlayLegs?: readonly EfficientCarryLeg[];
  scenarioDefs?: readonly PortfolioScenarioDef[];
  selection: PortfolioSelection | null;
  tabNetByCcyUsd: Record<string, number>;
  onCommitSelection: (kind: SolutionScenarioId, point: PortfolioCarryFrontierPoint) => void;
  portfolioIncludedCcys: ReadonlySet<string> | null;
  onTogglePortfolioCcy: (ccy: string) => void;
  onSoloPortfolioCcy: (ccy: string) => void;
  onResetPortfolioCcys: () => void;
}) {
  const portById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof portfolioCfarSnapshot>>();
    for (const r of results) {
      map.set(
        r.strategy.id,
        portfolioCfarSnapshot(
          r.byCcy.map(c => ({
            ccy: c.ccy,
            cfarUsdM: c.cfarUsdM,
            standing: signedPeakStanding(c.plan),
          })),
        ),
      );
    }
    return map;
  }, [results]);
  const tailPct = (cfarTailProbability(confidencePct) * 100).toFixed(0);
  const overdraftCfarUsdM = unhedgedOriginUsdM > 1e-9
    ? unhedgedOriginUsdM
    : (results.find(r => r.strategy.id === 'unfunded')?.finalCfarUsdM ?? 0);
  const floorCfarUsdM = overdraftCfarUsdM;
  const includedPlotRows = useMemo(
    () => (bookRows ?? []).filter(row => (
      row.ccy !== 'USD'
      && CURRENCY_PARAMS[row.ccy]
      && (!portfolioIncludedCcys || portfolioIncludedCcys.has(row.ccy))
    )),
    [bookRows, portfolioIncludedCcys],
  );
  const soloPlotRow = includedPlotRows.length === 1 ? includedPlotRows[0]! : null;
  const plotFrontier = universeFrontier;
  const overlayActive = portfolioLevel && carryOn && (plotOverlayLegs != null || mvFrontier != null);
  const overlayCapBreached = overlayActive && mvFrontier!.sweet.capBreachedAtZeroOverlay;

  return (
    <section>
      <ChapterLabel
        n={3}
        title="Regimes"
        info={
          <>
            <p>Click a row to preview. Preview does not persist the desk regime.</p>
            <ul className="mt-1.5 space-y-1">
              {results.map(r => (
                <li key={r.strategy.id}>
                  <span className="font-semibold text-slate-200">{r.strategy.label}.</span>{' '}
                  {r.strategy.summary}
                </li>
              ))}
            </ul>
            <p className="mt-1.5">
              Cash Carry is desk Cash + FWD — identical on every regime. The swap lives in Swap cash
              + CIP.               Sum CFaR and Port. CFaR are the same numbers as the carry/CFaR plot:
              Unfunded = Unhedged (CFaR-tab All CCY Net Σ); a funded book is the
              open arm at t = 1. Not cover-sizing leftovers and not overlay Euler.
              Weighted return is Carry − Port. CFaR × {tailPct}%.
            </p>
            {overlayActive ? (
              <p className="mt-1.5">
                Portfolio + Carry: Total carry, Sum / Port. CFaR, and Weighted return on every
                funded row are the checked sweet spot ({overlayScenarioLabel ?? 'the plot marker'})
                on that programme’s curve. Cash Carry / Swap cash / CIP stay that programme’s
                book. Unfunded stays the overdraft / Unhedged pin.
              </p>
            ) : (
              <p className="mt-1.5">
                Select a row for carry vs CFaR as the books scale together. Portfolio + Carry shows
                the overlay mix beside it.
              </p>
            )}
          </>
        }
      />
      <div className="overflow-x-auto rounded-[10px] border border-slate-700 bg-slate-950/50">
        <table className="w-full min-w-[920px] border-collapse text-left font-mono text-[10px] leading-snug">
          <thead>
            <tr className="text-slate-500">
              <th className="px-3 py-2 font-semibold tracking-wide">Regime</th>
              <th className="px-3 py-2 font-semibold tracking-wide">Constraint</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Cash Carry</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Swap cash</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">CIP</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Total carry</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Sum CFaR</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Port. CFaR</th>
              <th className="px-3 py-2 text-right font-semibold tracking-wide">Weighted return</th>
            </tr>
          </thead>
          <tbody>
            {results.map(r => {
              const live = r.strategy.id === liveId;
              const selected = r.strategy.id === selectedId;
              const book = strategyBookCarryK(r.byCcy);
              const port = portById.get(r.strategy.id);
              const include = (ccy: string) => (
                !portfolioIncludedCcys || portfolioIncludedCcys.has(ccy)
              );
              const sol = r.strategy.id === 'unfunded'
                ? null
                : (regimeSolutionById.get(r.strategy.id)
                  ?? (selected && solutionPick
                    ? {
                      totalCarryUsdYr: solutionPick.point.totalCarryUsdYr,
                      portUsdM: solutionPick.point.portfolioVarUsd,
                    }
                    : null));
              const followPlot = sol != null;
              const tabRisk = regimePortfolioCfar(
                r.byCcy.map(c => ({
                  ccy: c.ccy,
                  cfarUsdM: tabNetByCcyUsd[c.ccy] ?? c.cfarUsdM,
                  standing: signedPeakStanding(c.plan),
                })),
                undefined,
                include,
              );
              const portRisk = tabRisk;
              const chartCfar = regimeChartCfarById.get(r.strategy.id);
              const sumCfarUsdM = followPlot
                ? sol.portUsdM
                : (chartCfar?.sumUsdM ?? portRisk.standaloneUsdM);
              const displayTotalK = followPlot
                ? sol.totalCarryUsdYr * 1000
                : book.total;
              const displayPortUsdM = followPlot
                ? sol.portUsdM
                : (chartCfar?.portUsdM ?? portRisk.portfolioUsdM);
              const weighted = followPlot
                ? solutionWeightedReturnUsdM(
                  sol.totalCarryUsdYr,
                  sol.portUsdM,
                  confidencePct,
                )
                : probabilityWeightedReturnUsdM(
                  displayTotalK / 1000,
                  displayPortUsdM,
                  confidencePct,
                  floorCfarUsdM,
                );
              return (
                <Fragment key={r.strategy.id}>
                  <tr
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
                      <div className="flex flex-wrap items-center gap-1.5">
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
                    </td>
                    <td
                      className={`border-b border-slate-900 px-3 py-2.5 align-top font-semibold ${constraintHue}`}
                      title={r.constraintDetail || undefined}
                    >
                      {bufferConstraintLabel(r.constraint)}
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
                    <td
                      className={`border-b border-slate-900 px-3 py-2.5 text-right align-top font-semibold ${moneyTone(displayTotalK / 1000)}`}
                      title={followPlot ? selectedPlotLabel : undefined}
                    >
                      {fmtSignedK(displayTotalK / 1000, 0)}
                    </td>
                    <td className="border-b border-slate-900 px-3 py-2.5 text-right align-top text-amber-300/80">
                      {fmtAbsK(sumCfarUsdM)}
                    </td>
                    <td
                      className={`border-b border-slate-900 px-3 py-2.5 text-right align-top ${
                        overlayCapBreached ? 'text-rose-400' : 'text-amber-200'
                      }`}
                      title={[
                        portRisk.standaloneUsdM > 1e-9
                          ? `${(portRisk.divFactor * 100).toFixed(0)}% of ${fmtAbsK(portRisk.standaloneUsdM)} sum · −${fmtAbsK(portRisk.divBenefitUsdM)} div`
                          : null,
                        port && port.standaloneUsdM > 1e-9 && r.strategy.id !== 'unfunded'
                          ? `book ${(port.divFactor * 100).toFixed(0)}% of sum`
                          : null,
                        overlayCapBreached
                          ? 'POLICY BREACH — base standalone exposure alone exceeds Policy VAR, before any overlay decision'
                          : null,
                      ].filter(Boolean).join(' · ') || undefined}
                    >
                      {overlayCapBreached && <span className="mr-0.5">⚠</span>}
                      {fmtAbsK(displayPortUsdM)}
                    </td>
                    <td className={`border-b border-slate-900 px-3 py-2.5 text-right align-top ${moneyTone(weighted)}`}>
                      {fmtSignedK(weighted)}
                    </td>
                  </tr>
                  {selected && (
                    <tr>
                      <td colSpan={9} className="border-b border-slate-900 bg-slate-950/80 px-3 pb-3 pt-2">
                        {portfolioLevel && plotFrontier && plotFrontier.points.length > 2 && (
                          <div className="mb-2">
                            <PortfolioCarryVarFrontierPlot
                              key={
                                portfolioIncludedCcys
                                  ? `ccy:${[...portfolioIncludedCcys].sort().join(',')}`
                                  : 'ccy:all'
                              }
                              frontier={plotFrontier}
                              overlayFrontier={undefined}
                              matchModalAxis={soloPlotRow != null}
                              projectScenarioPoint={undefined}
                              conservativePoint={conservativePoint}
                              carryTargetUsdYr={carryTargetUsdYr}
                              unhedgedOriginUsdM={unhedgedOriginUsdM}
                              policyVAR={policyVAR}
                              confidencePct={confidencePct}
                              selectedScenarioId={
                                selection && selection.kind !== 'custom' ? selection.kind : null
                              }
                              customPoint={
                                selection?.kind === 'custom' ? selection.point : null
                              }
                              selectedPoint={selection?.point ?? null}
                              scenarioDefs={scenarioDefs}
                              onApplyScenario={(id, point) => onCommitSelection(id, point)}
                              onPickCustom={point => onCommitSelection('custom', point)}
                              onUseBalanced={
                                (() => {
                                  const balanced = scenarioDefs?.find(s => s.id === 'balanced')?.point;
                                  return balanced
                                    ? () => onCommitSelection('balanced', balanced)
                                    : undefined;
                                })()
                              }
                            />
                          </div>
                        )}
                        <SweetStripSplit
                          result={r}
                          overlayLegs={portfolioLevel && carryOn ? plotOverlayLegs : undefined}
                          overlayT={solutionPick?.overlayT}
                          overlayScenarioLabel={overlayScenarioLabel}
                          plotLabel={selectedPlotLabel}
                          totalCarryByCcy={solutionPick?.totalCarryByCcy}
                          totalCarryUsdYr={solutionPick?.point.totalCarryUsdYr}
                          cfarByCcy={solutionPick?.cfarByCcy}
                          portCfarUsdM={solutionPick?.point.portfolioVarUsd}
                          policyCapUsd={typeof policyVAR === 'number' ? policyVAR : 5}
                          carryTargetUsdYr={carryTargetUsdYr}
                          bookCcys={bookRows
                            .filter(row => row.ccy !== 'USD' && CURRENCY_PARAMS[row.ccy])
                            .map(row => row.ccy)}
                          portfolioIncludedCcys={portfolioLevel ? portfolioIncludedCcys : undefined}
                          onTogglePortfolioCcy={portfolioLevel ? onTogglePortfolioCcy : undefined}
                          onSoloPortfolioCcy={portfolioLevel ? onSoloPortfolioCcy : undefined}
                          onResetPortfolioCcys={portfolioLevel ? onResetPortfolioCcys : undefined}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function finitePt(p: PortfolioFrontierPoint): boolean {
  return Number.isFinite(p.cfarUsdM) && Number.isFinite(p.carryUsdYrM);
}

function tickDot(p: PortfolioFrontierPoint): boolean {
  if (Math.abs(p.scale - 1) < 1e-6) return true;
  const t = Math.round(p.scale * 4) / 4;
  return Math.abs(p.scale - t) < 0.03 && t >= 0 && t <= 1.25;
}

function mixTick(p: PortfolioFrontierPoint): boolean {
  const t = Math.round(p.cover * 4) / 4;
  return Math.abs(p.cover - t) < 0.04;
}

function OverlayMixChips({ mix }: { mix: EfficientCarryVarFrontier }) {
  const weights = l1Weights(mix.legs.map(l => l.usdM));
  const legs = mix.legs
    .map((leg, i) => ({ leg, w: weights[i]! }))
    .filter(x => x.leg.side !== 'flat')
    .slice(0, 10);
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {legs.map(({ leg, w }) => {
        const tilt = leg.mu > 1e-6 ? 'EARN' : leg.mu < -1e-6 ? 'PAY' : 'flat';
        const hedge = (leg.side === 'long' && tilt === 'PAY')
          || (leg.side === 'short' && tilt === 'EARN');
        return (
          <span
            key={leg.ccy}
            className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
              leg.side === 'long'
                ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-400/40 bg-rose-500/10 text-rose-200'
            }`}
            title={`${tilt} vs USD${hedge ? ' · hedge vs a correlated name' : ''} · mix ${fmtWeight(w)} · overlay ${fmtSignedK(leg.usdM)} · ${leg.fcyM >= 0 ? '+' : '−'}${Math.abs(leg.fcyM).toFixed(2)}M ${leg.ccy}`}
          >
            {leg.ccy} {fmtWeight(w)} {leg.side} {fmtSignedK(leg.usdM)}
            <span className="ml-1 text-slate-500">{hedge ? `${tilt} hedge` : tilt}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Sweet overlay mix vs this regime's funding-swap strip, per CCY.
 * Overlay = H* − hold at the Σ⁻¹μ sweet. Strip = Swap Near / Book on the
 * selected programme. Weights are signed L1 shares of USD.
 */
function SweetStripSplit({
  result,
  overlayLegs,
  overlayT,
  overlayScenarioLabel,
  plotLabel,
  totalCarryByCcy,
  totalCarryUsdYr,
  cfarByCcy,
  portCfarUsdM,
  policyCapUsd,
  carryTargetUsdYr,
  bookCcys,
  portfolioIncludedCcys,
  onTogglePortfolioCcy,
  onSoloPortfolioCcy,
  onResetPortfolioCcys,
}: {
  result: LiquidityStrategyResult;
  overlayLegs?: readonly EfficientCarryLeg[];
  overlayT?: number;
  overlayScenarioLabel?: string | null;
  plotLabel?: string;
  totalCarryByCcy?: Readonly<Record<string, number>>;
  totalCarryUsdYr?: number;
  cfarByCcy?: Readonly<Record<string, number>>;
  portCfarUsdM?: number;
  policyCapUsd?: number;
  /** Desk Target Carry ($M/yr) — full ask applied to included CCYs. */
  carryTargetUsdYr?: number | null;
  bookCcys?: readonly string[];
  portfolioIncludedCcys?: ReadonlySet<string> | null;
  onTogglePortfolioCcy?: (ccy: string) => void;
  onSoloPortfolioCcy?: (ccy: string) => void;
  onResetPortfolioCcys?: () => void;
}) {
  const byCcy = new Map(result.byCcy.map(c => [c.ccy, c]));
  const bookSet = new Set(bookCcys ?? []);
  const stripSeen = new Set(result.byCcy.map(c => c.ccy));
  const stripInputs = [
    ...result.byCcy.map(c => ({
      ccy: c.ccy,
      bookNow: c.bookNow,
      outstanding: stripOutstanding(c),
    })),
    ...[...bookSet]
      .filter(ccy => !stripSeen.has(ccy))
      .map(ccy => ({ ccy, bookNow: 0, outstanding: 0 })),
  ];
  const liveCarryOf = (ccy: string) => {
    const c = byCcy.get(ccy);
    return c
      ? c.cashCarryUsdYrM + c.hedgeCarryUsdYrM + c.swapInterestUsdYrM + c.swapPointsUsdYrM
      : 0;
  };
  const totalCarryOf = (ccy: string) => (
    totalCarryByCcy && Object.prototype.hasOwnProperty.call(totalCarryByCcy, ccy)
      ? (totalCarryByCcy[ccy] ?? 0)
      : liveCarryOf(ccy)
  );
  const cfarOf = (ccy: string) => (
    cfarByCcy && Object.prototype.hasOwnProperty.call(cfarByCcy, ccy)
      ? (cfarByCcy[ccy] ?? 0)
      : (byCcy.get(ccy)?.cfarUsdM ?? 0)
  );
  const rows = joinOverlayStripWeights(overlayLegs ?? [], stripInputs).filter(r => {
    if (bookSet.has(r.ccy)) return true;
    const c = byCcy.get(r.ccy);
    return (
      Math.abs(r.overlayUsdM) > 0.02
      || Math.abs(r.stripUsdM) > 0.02
      || Math.abs(r.bookNow) > 0.02
      || Math.abs(c?.cfarUsdM ?? 0) > 0.02
      || Math.abs(totalCarryOf(r.ccy)) > 0.02
    );
  });
  if (rows.length === 0) return null;
  const hasOverlay = (overlayLegs?.length ?? 0) > 0;
  const totals = rows.reduce((acc, row) => {
    const included = !portfolioIncludedCcys || portfolioIncludedCcys.has(row.ccy);
    const c = byCcy.get(row.ccy);
    const far = c && c.plan.length > 0 ? c.plan[c.plan.length - 1]!.far_leg : 0;
    acc.total += totalCarryOf(row.ccy);
    acc.notional += included ? row.overlayUsdM : 0;
    acc.overlayFcy += included ? row.overlayFcyM : 0;
    acc.near += row.bookNow;
    acc.far += far;
    acc.book += row.outstanding;
    return acc;
  }, {
    total: 0, notional: 0, overlayFcy: 0, near: 0, far: 0, book: 0,
  });
  const sigmaCarry = typeof totalCarryUsdYr === 'number' ? totalCarryUsdYr : totals.total;
  const sigmaCfar = typeof portCfarUsdM === 'number' ? portCfarUsdM : 0;
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-slate-800 bg-slate-950/60">
      <div className="flex items-center gap-1.5 border-b border-slate-800 px-2.5 py-1.5">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-400">
          {hasOverlay ? (overlayScenarioLabel ?? 'Sweet') : 'Strip'}
        </span>
        {typeof policyCapUsd === 'number' && policyCapUsd > 0 && (
          <span
            className="rounded border border-amber-400/40 bg-amber-500/10 px-1.5 py-px font-mono text-[9px] font-semibold text-amber-200"
            title={
              portfolioIncludedCcys
                ? 'Full desk Policy VAR allocated to the checked CCYs only (not scaled down)'
                : 'Policy VAR approval cap'
            }
          >
            Policy VAR {fmtAbsK(policyCapUsd)}
            {portfolioIncludedCcys ? ' → in' : ''}
          </span>
        )}
        {typeof carryTargetUsdYr === 'number' && Number.isFinite(carryTargetUsdYr) && (
          <span
            className="rounded border border-violet-400/40 bg-violet-500/10 px-1.5 py-px font-mono text-[9px] font-semibold text-violet-200"
            title={
              portfolioIncludedCcys
                ? 'Full desk Target Carry allocated to the checked CCYs only (not scaled down)'
                : 'Desk Target Carry ($/yr) for the Carry Target marker'
            }
          >
            Target Carry {fmtSignedK(carryTargetUsdYr)}/yr
            {portfolioIncludedCcys ? ' → in' : ''}
          </span>
        )}
        {typeof portCfarUsdM === 'number' && (
          <span
            className="rounded border border-sky-400/40 bg-sky-500/10 px-1.5 py-px font-mono text-[9px] font-semibold text-sky-200"
            title="Port. CFaR at the selected chart marker (same as chart X)"
          >
            Port. CFaR {fmtAbsK(portCfarUsdM)}
          </span>
        )}
        <InfoTip label="Strip split">
          {hasOverlay ? (
            <p>
              {plotLabel ?? overlayScenarioLabel ?? 'Sweet'} on this regime
              {typeof overlayT === 'number' ? ` · t=${overlayT.toFixed(2)}` : ''}.
              Total Carry is chart Y. Port. CFaR is chart X. Policy VAR and
              Target Carry are the full desk budgets
              {portfolioIncludedCcys
                ? ' — both apply 100% to the checked CCYs (filter does not pro-rate).'
                : '.'}
              {' '}Overlay Mix / FCY / Notional are position size.
              Swap Near / Far / Book stay on this programme.
            </p>
          ) : (
            <p>
              This regime’s strip split (Σ |outstanding × spot|). Turn on Portfolio + Carry for the
              overlay mix.
            </p>
          )}
        </InfoTip>
        {onResetPortfolioCcys && portfolioIncludedCcys && (
          <button
            type="button"
            onClick={onResetPortfolioCcys}
            className="font-mono text-[9px] text-slate-500 hover:text-slate-300"
            title="Re-include every currency — Policy VAR and Target Carry stay at the desk amounts"
          >
            reset (all in)
          </button>
        )}
      </div>
      <table className="w-full min-w-[780px] text-left font-mono text-[10px]">
        <thead>
          <tr className="text-slate-500">
            <th className="px-2.5 py-1.5 font-semibold">CCY</th>
            <th className="px-2.5 py-1.5 font-semibold" title="What the overlay does on this name">Do</th>
            {hasOverlay && (
              <th className="px-2.5 py-1.5 font-semibold" title="Signed L1 share of overlay USD">Mix w%</th>
            )}
            <th className="px-2.5 py-1.5 font-semibold" title="Total Carry at the selected chart marker — same Y as the plot">Total Carry</th>
            <th
              className="px-2.5 py-1.5 font-semibold"
              title="Port. CFaR. Per CCY is the whole priced book. Σ is Port. CFaR — the same chart X as the selected marker."
            >
              Port. CFaR
            </th>
            {hasOverlay && (
              <>
                <th
                  className="px-2.5 py-1.5 font-semibold"
                  title={`Overlay USD notional at the sweet — position size, not Policy VAR. Per-leg ceilings: ${OVERLAY_MAX_LEG_LEVERAGE}× Policy VAR and ${OVERLAY_MAX_BASE_MULTIPLE}× that CCY's own book. Nobody hard-codes a $5M EUR sell — if you see ~$5M it is usually the Policy VAR dial (Dir. Finance tier) or Port. CFaR at Max Policy Risk.`}
                >
                  Notional $
                </th>
                <th className="px-2.5 py-1.5 font-semibold" title="H* − hold, M FCY">Overlay FCY</th>
              </>
            )}
            <th className="px-2.5 py-1.5 font-semibold">Strip</th>
            <th className="px-2.5 py-1.5 font-semibold">Schedule</th>
            <th className="px-2.5 py-1.5 font-semibold">Swap Near</th>
            <th className="px-2.5 py-1.5 font-semibold" title="Far-leg notional if the funding swap is term-booked (fully) or strip-term (partially) — 0 on a rolling regime, nothing is locked at a far date">Swap Far</th>
            <th className="px-2.5 py-1.5 font-semibold">Swap Book</th>
            <th className="px-2.5 py-1.5 font-semibold" title="Signed L1 share of swap-book USD">Strip w%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const c = byCcy.get(row.ccy);
            const included = !portfolioIncludedCcys || portfolioIncludedCcys.has(row.ccy);
            const struct = c
              ? fundingStructLabel(result.strategy, c.schedule)
              : '—';
            const schedule = c
              ? compactFundingSchedule(c.schedule)
              : '—';
            const totalCarryM = totalCarryOf(row.ccy);
            const cfarUsdM = cfarOf(row.ccy);
            const farLeg = c && c.plan.length > 0 ? c.plan[c.plan.length - 1]!.far_leg : 0;
            const doLabel = !included
              ? 'out'
              : hasOverlay
                ? overlayDoLabel(row.side, row.mu)
                : (Math.abs(row.outstanding) > 0.001 || Math.abs(row.bookNow) > 0.001
                  ? 'fund strip'
                  : 'hold');
            const doTone = !included || !hasOverlay || row.side === 'flat'
              ? 'text-slate-400'
              : row.side === 'long' ? 'text-emerald-300' : 'text-rose-300';
            return (
              <tr
                key={row.ccy}
                className={`border-t border-slate-800/80 ${
                  included ? 'text-slate-300' : 'text-slate-500'
                }`}
              >
                <td className={`px-2.5 py-1.5 font-semibold ${
                  included ? 'text-violet-200' : 'text-slate-500'
                }`}>
                  {onTogglePortfolioCcy ? (
                    <label
                      className="inline-flex cursor-pointer items-center gap-1"
                      title={`Include/exclude ${row.ccy} in the Σ⁻¹μ overlay. Unticked names stay on the book with no overlay. Click "${row.ccy}" to isolate it alone.`}
                    >
                      <input
                        type="checkbox"
                        checked={!portfolioIncludedCcys || portfolioIncludedCcys.has(row.ccy)}
                        onChange={() => onTogglePortfolioCcy(row.ccy)}
                        className="accent-violet-400"
                      />
                      <button
                        type="button"
                        onClick={() => onSoloPortfolioCcy?.(row.ccy)}
                        className="hover:text-violet-100"
                      >
                        {row.ccy}
                      </button>
                    </label>
                  ) : row.ccy}
                </td>
                <td className={`px-2.5 py-1.5 ${doTone}`}>{doLabel}</td>
                {hasOverlay && (
                  <td className={`px-2.5 py-1.5 ${
                    !included
                      ? 'text-slate-600'
                      : row.side === 'long' ? 'text-emerald-300' : row.side === 'short' ? 'text-rose-300' : 'text-slate-500'
                  }`}>
                    {included ? fmtWeight(row.overlayWeight) : '—'}
                  </td>
                )}
                <td
                  className={`px-2.5 py-1.5 font-semibold ${moneyTone(totalCarryM)}`}
                  title={plotLabel ?? 'Plot'}
                >
                  {fmtSignedK(totalCarryM)}
                </td>
                <td className="px-2.5 py-1.5 text-amber-200/90">
                  {fmtAbsK(cfarUsdM)}
                </td>
                {hasOverlay && (
                  <>
                    <td
                      className={`px-2.5 py-1.5 ${included ? moneyTone(row.overlayUsdM) : 'text-slate-600'}`}
                      title={
                        included
                          ? [
                              `Overlay notional ${fmtSignedK(row.overlayUsdM)} — position size, not Policy VAR.`,
                              typeof policyCapUsd === 'number'
                                ? `Leg ceiling up to ${fmtAbsK(overlayLegNotionalCeilingUsdM({
                                  policyCapUsdM: policyCapUsd,
                                  spot: CURRENCY_PARAMS[row.ccy]?.spot,
                                }))} (${OVERLAY_MAX_LEG_LEVERAGE}× Policy VAR; also capped at ${OVERLAY_MAX_BASE_MULTIPLE}× that CCY's book when known).`
                                : null,
                              row.side === 'short'
                                ? 'Short = sell FCY / receive USD (PAY tilt or hedge).'
                                : row.side === 'long'
                                  ? 'Long = buy FCY / pay USD (EARN tilt or hedge).'
                                  : null,
                            ].filter(Boolean).join(' ')
                          : 'Excluded from overlay'
                      }
                    >
                      {included ? fmtSignedK(row.overlayUsdM) : '—'}
                    </td>
                    <td className={`px-2.5 py-1.5 ${included ? 'text-sky-200/90' : 'text-slate-600'}`}>
                      {included ? fmtM(row.overlayFcyM) : '—'}
                    </td>
                  </>
                )}
                <td className="px-2.5 py-1.5 capitalize text-violet-300/90">{struct}</td>
                <td className="px-2.5 py-1.5 text-amber-200/90">{schedule}</td>
                <td className="px-2.5 py-1.5 text-sky-300">{fmtM(row.bookNow)}</td>
                <td className={`px-2.5 py-1.5 ${moneyTone(farLeg)}`}>
                  {Math.abs(farLeg) > 0.001 ? fmtM(farLeg) : '—'}
                </td>
                <td className={`px-2.5 py-1.5 ${moneyTone(row.outstanding)}`}>
                  {Math.abs(row.outstanding) > 0.001 ? fmtM(row.outstanding) : '—'}
                </td>
                <td className="px-2.5 py-1.5 text-amber-200">{fmtWeight(row.stripWeight)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-700 bg-slate-900/80 font-semibold text-slate-200">
            <td className="px-2.5 py-1.5 text-slate-400">Σ</td>
            <td className="px-2.5 py-1.5 text-slate-600">—</td>
            {hasOverlay && <td className="px-2.5 py-1.5 text-slate-600">—</td>}
            <td className={`px-2.5 py-1.5 ${moneyTone(sigmaCarry)}`}>
              {fmtSignedK(sigmaCarry)}
            </td>
            <td
              className="px-2.5 py-1.5 text-amber-200"
              title="Port. CFaR at the selected marker — same as chart X"
            >
              {fmtAbsK(sigmaCfar)}
            </td>
            {hasOverlay && (
              <>
                <td className={`px-2.5 py-1.5 ${moneyTone(totals.notional)}`}>
                  {fmtSignedK(totals.notional)}
                </td>
                <td className="px-2.5 py-1.5 text-sky-200/90">{fmtM(totals.overlayFcy)}</td>
              </>
            )}
            <td className="px-2.5 py-1.5 text-slate-600">—</td>
            <td className="px-2.5 py-1.5 text-slate-600">—</td>
            <td className="px-2.5 py-1.5 text-sky-300">{fmtM(totals.near)}</td>
            <td className={`px-2.5 py-1.5 ${moneyTone(totals.far)}`}>
              {Math.abs(totals.far) > 0.001 ? fmtM(totals.far) : '—'}
            </td>
            <td className={`px-2.5 py-1.5 ${moneyTone(totals.book)}`}>
              {Math.abs(totals.book) > 0.001 ? fmtM(totals.book) : '—'}
            </td>
            <td className="px-2.5 py-1.5 text-slate-600">—</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * The real (curvature-aware) carry/VAR frontier — limited approval-tier
 * universe, zoomed so the bend around the sweet is visible. Distinct from
 * the Σ⁻¹μ ray `mvFrontier` annotates `BookScaleFrontierPlot` with: that
 * ray has no floor clamping, so it is linear by construction.
 */
const PORTFOLIO_SCENARIO_COLORS: Record<string, string> = {
  unhedged: '#94a3b8',
  carryTarget: '#60a5fa',
  balanced: '#f59e0b',
  // Was #f87171 — nearly identical to the far-leg's #fb7185 (both
  // reddish-pink), read as the same curve at a glance. Violet is distinct
  // from every other scenario color and from the far-leg pink.
  maxCarry: '#a78bfa',
  maxReturn: '#34d399',
};

function cfarKTicks(minM: number, maxM: number): number[] {
  const lo = Math.floor(minM * 1000);
  const hi = Math.ceil(maxM * 1000);
  if (hi <= lo) return [minM];
  const span = hi - lo;
  const step = span <= 8 ? 1
    : span <= 40 ? 5
    : span <= 120 ? 10
    : span <= 400 ? 25
    : span <= 1000 ? 50
    : span <= 2500 ? 100
    : span <= 6000 ? 250
    : 500;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let k = start; k <= hi + 1e-9; k += step) {
    if (k + 1e-9 >= lo) out.push(k / 1000);
  }
  return out.length > 0 ? out : [minM];
}

function carryLogTicks(yMin: number, yMax: number): number[] {
  const out = [0];
  for (let exp = -4; exp <= 2; exp += 1) {
    for (const f of [1, 2, 5]) {
      const m = f * 10 ** exp;
      if (m <= yMax * 1.02 + 1e-12) out.push(m);
      if (-m >= yMin * 1.02 - 1e-12) out.push(-m);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

type CarryVarPlotView = { xMin: number; xMax: number; yMin: number; yMax: number };

function svgLocalXY(
  el: SVGSVGElement,
  clientX: number,
  clientY: number,
  W: number,
  H: number,
): { sx: number; sy: number } | null {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    sx: ((clientX - rect.left) / rect.width) * W,
    sy: ((clientY - rect.top) / rect.height) * H,
  };
}

function inPlotRect(
  sx: number,
  sy: number,
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
): boolean {
  return sx >= padL && sx <= padL + plotW && sy >= padT && sy <= padT + plotH;
}

function placeAxisSpan(
  start: number,
  span: number,
  lo: number,
  hi: number,
): { start: number; span: number } {
  const room = hi - lo;
  if (!(room > 1e-12)) return { start: lo, span: Math.max(span, 0) };
  let s = Math.min(span, room);
  let a = start;
  if (a < lo) a = lo;
  if (a + s > hi) a = hi - s;
  if (a < lo) {
    a = lo;
    s = room;
  }
  return { start: a, span: s };
}

/**
 * Clamp a zoom/pan window inside `world`.
 *
 * X (CFaR) and Z (asinh carry) must zoom isotropically. Independent floors
 * (`minXSpan` vs `minZSpan`) used to squash the curve on zoom-in and then
 * lock that aspect on zoom-out. Optional `preferAspect` (auto-frame
 * xSpan/zSpan) repairs an already-distorted view on the next wheel tick.
 */
function clampCarryVarPlotView(
  next: CarryVarPlotView,
  world: CarryVarPlotView,
  carryS: number,
  keep?: { x: number; z: number },
  preferAspect?: number | null,
): CarryVarPlotView {
  const minXSpan = 0.01;
  const worldXSpan = Math.max(world.xMax - world.xMin, minXSpan);
  const xLo = world.xMin - worldXSpan * 0.35;
  const xHi = world.xMax + worldXSpan * 0.35;
  const maxXSpan = Math.max(xHi - xLo, minXSpan);

  const minZSpan = 0.14;
  const worldZMin = carryFwd(world.yMin, carryS);
  const worldZMax = carryFwd(world.yMax, carryS);
  const worldZSpan = Math.max(worldZMax - worldZMin, minZSpan);
  const zLo = worldZMin - worldZSpan * 1.15;
  const zHi = worldZMax + worldZSpan * 1.15;
  const maxZSpan = Math.max(zHi - zLo, minZSpan);

  const reqXSpan = Math.max(next.xMax - next.xMin, 1e-15);
  let rawZ0 = carryFwd(next.yMin, carryS);
  let rawZ1 = carryFwd(next.yMax, carryS);
  if (rawZ1 < rawZ0) {
    const swap = rawZ0;
    rawZ0 = rawZ1;
    rawZ1 = swap;
  }
  const reqZSpan = Math.max(rawZ1 - rawZ0, 1e-15);

  let xSpan = reqXSpan;
  let zSpan = reqZSpan;

  // Restore auto-frame aspect (fixes views already squashed by the old clamp).
  if (preferAspect != null && preferAspect > 1e-12) {
    const curAspect = xSpan / zSpan;
    if (Math.abs(curAspect / preferAspect - 1) > 0.08) {
      const geo = Math.sqrt(xSpan * zSpan);
      zSpan = geo / Math.sqrt(preferAspect);
      xSpan = geo * Math.sqrt(preferAspect);
    }
  }

  // Isotropic floor — grow both axes by the larger deficit.
  const bump = Math.max(
    1,
    minXSpan / xSpan,
    minZSpan / zSpan,
  );
  xSpan *= bump;
  zSpan *= bump;

  // Isotropic ceiling — shrink both axes by the tighter limit.
  const shrink = Math.min(
    1,
    maxXSpan / xSpan,
    maxZSpan / zSpan,
  );
  xSpan *= shrink;
  zSpan *= shrink;

  // World too tight for both mins: last-resort independent clamp.
  if (xSpan < minXSpan - 1e-12 || zSpan < minZSpan - 1e-12) {
    xSpan = Math.min(maxXSpan, Math.max(minXSpan, xSpan));
    zSpan = Math.min(maxZSpan, Math.max(minZSpan, zSpan));
  }

  const xAnchor = keep?.x ?? (next.xMin + next.xMax) / 2;
  const zAnchor = keep?.z ?? (rawZ0 + rawZ1) / 2;
  const tX = (xAnchor - next.xMin) / reqXSpan;
  const tZ = (zAnchor - rawZ0) / reqZSpan;
  const xPlaced = placeAxisSpan(xAnchor - tX * xSpan, xSpan, xLo, xHi);
  const zPlaced = placeAxisSpan(zAnchor - tZ * zSpan, zSpan, zLo, zHi);
  return {
    xMin: xPlaced.start,
    xMax: xPlaced.start + xPlaced.span,
    yMin: carryS * Math.sinh(zPlaced.start),
    yMax: carryS * Math.sinh(zPlaced.start + zPlaced.span),
  };
}

function thinTicks(
  values: readonly number[],
  pos: (v: number) => number,
  minGap: number,
): number[] {
  const preferred = [...values].sort((a, b) => {
    const az = Math.abs(a) < 1e-12 ? -1 : 0;
    const bz = Math.abs(b) < 1e-12 ? -1 : 0;
    if (az !== bz) return az - bz;
    return Math.abs(b) - Math.abs(a);
  });
  const kept: number[] = [];
  for (const v of preferred) {
    if (kept.every(u => Math.abs(pos(u) - pos(v)) >= minGap)) kept.push(v);
  }
  return kept.sort((a, b) => a - b);
}

function pickDotsAlongPolyline(
  pts: readonly { x: number; y: number }[],
  maxDots: number,
  minGap: number,
): Set<number> {
  const n = pts.length;
  if (n === 0) return new Set();
  if (n <= maxDots) {
    const all = new Set<number>();
    let last = 0;
    all.add(0);
    for (let i = 1; i < n; i += 1) {
      const near = i / n < 0.4;
      const gap = near ? minGap * 0.5 : minGap;
      if (Math.hypot(pts[i]!.x - pts[last]!.x, pts[i]!.y - pts[last]!.y) >= gap) {
        all.add(i);
        last = i;
      }
    }
    all.add(n - 1);
    return all;
  }
  const out = new Set<number>([0]);
  let last = 0;
  for (let i = 1; i < n - 1; i += 1) {
    const near = i / n < 0.4;
    const gap = near ? minGap * 0.5 : minGap;
    if (Math.hypot(pts[i]!.x - pts[last]!.x, pts[i]!.y - pts[last]!.y) >= gap) {
      out.add(i);
      last = i;
      if (out.size >= maxDots - 1) break;
    }
  }
  out.add(n - 1);
  return out;
}

function nearestFrontierIndex(
  points: readonly PortfolioCarryFrontierPoint[],
  targetVarUsd: number,
): number {
  if (points.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (Math.abs(points[i]!.portfolioVarUsd - targetVarUsd)
      < Math.abs(points[best]!.portfolioVarUsd - targetVarUsd)) {
      best = i;
    }
  }
  return best;
}

function SelectedFrontierMark({
  cx,
  cy,
  label,
  detail,
  plotLeft,
  plotRight,
  plotTop,
  plotBottom,
  xTick,
  yTick,
}: {
  cx: number;
  cy: number;
  label: string;
  detail: string;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  xTick: string;
  yTick: string;
}) {
  const flipX = cx + 14 > plotRight - 96;
  const flipY = cy < plotTop + 28;
  const tx = flipX ? cx - 14 : cx + 14;
  const ty = flipY
    ? Math.min(plotBottom - 18, cy + 20)
    : Math.max(plotTop + 12, cy - 16);
  // Intersection values sit just inside the plot edges (not in the axis gutters).
  const xLabelY = plotBottom - 5;
  const yLabelNearLeft = cx < plotLeft + 56;
  const yLabelX = yLabelNearLeft
    ? Math.min(plotRight - 4, cx + 12)
    : plotLeft + 6;
  const yLabelY = cy - 4;
  return (
    <g className="pointer-events-none">
      <line
        x1={cx}
        y1={plotTop}
        x2={cx}
        y2={plotBottom}
        stroke="#7dd3fc"
        strokeWidth={1.1}
        strokeDasharray="4 3"
        strokeOpacity={0.7}
      />
      <line
        x1={plotLeft}
        y1={cy}
        x2={plotRight}
        y2={cy}
        stroke="#7dd3fc"
        strokeWidth={1.1}
        strokeDasharray="4 3"
        strokeOpacity={0.7}
      />
      <text
        x={cx}
        y={xLabelY}
        textAnchor="middle"
        fontSize={8}
        fontWeight={700}
        fill="#7dd3fc"
      >
        {xTick}
      </text>
      <text
        x={yLabelX}
        y={yLabelY}
        textAnchor="start"
        fontSize={8}
        fontWeight={700}
        fill="#7dd3fc"
      >
        {yTick}
      </text>
      <circle cx={cx} cy={cy} r={20} fill="#38bdf8" fillOpacity={0.14} />
      <circle cx={cx} cy={cy} r={13} fill="none" stroke="#7dd3fc" strokeWidth={2.25} />
      <circle cx={cx} cy={cy} r={7} fill="#38bdf8" stroke="#f8fafc" strokeWidth={2} />
      <text
        x={tx}
        y={ty}
        textAnchor={flipX ? 'end' : 'start'}
        fontSize={10}
        fontWeight={700}
        fill="#e0f2fe"
      >
        {label}
      </text>
      <text
        x={tx}
        y={ty + 12}
        textAnchor={flipX ? 'end' : 'start'}
        fontSize={8}
        fill="#94a3b8"
      >
        {detail}
      </text>
    </g>
  );
}

function UniverseLegend({
  swatch,
  border,
  label,
}: {
  swatch: 'solid' | 'dashed' | 'dot';
  border: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[9px] text-slate-400">
      {swatch === 'dot' ? (
        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
      ) : (
        <span
          className={`h-0 w-3.5 border-t-2 ${border} ${
            swatch === 'dashed' ? 'border-dashed' : ''
          }`}
        />
      )}
      {label}
    </span>
  );
}

function PortfolioCarryVarFrontierPlot({
  frontier,
  overlayFrontier,
  projectScenarioPoint,
  matchModalAxis,
  conservativePoint,
  carryTargetUsdYr,
  unhedgedOriginUsdM,
  policyVAR,
  confidencePct,
  selectedScenarioId,
  customPoint,
  selectedPoint,
  scenarioDefs: scenarioDefsProp,
  compact,
  onApplyScenario,
  onPickCustom,
  onUseBalanced,
}: {
  frontier: PortfolioCarryFrontier;
  /** Optional second walk. Portfolio plot leaves this unset so one S(t) arm is used. */
  overlayFrontier?: PortfolioCarryFrontier | null;
  projectScenarioPoint?: (p: PortfolioCarryFrontierPoint) => { x: number; y: number } | null;
  /** Same asinh arms + live-book frame as the per-currency modal. */
  matchModalAxis?: boolean;
  /** Funded H* book (cash + swap, no CIP) — Conservative is not a $5M fill. */
  conservativePoint?: PortfolioCarryFrontierPoint | null;
  carryTargetUsdYr?: number | null;
  /** Priced walk origin (t = 0, $0 carry). Not the CFaR-tab Σ. */
  unhedgedOriginUsdM?: number | null;
  policyVAR: number;
  confidencePct: number;
  selectedScenarioId?: PortfolioScenarioId | null;
  /** Clicked open-arm sample when no named scenario is selected. */
  customPoint?: PortfolioCarryFrontierPoint | null;
  /** Live pick — wins over the named-scenario lookup so Earn moves the dot. */
  selectedPoint?: PortfolioCarryFrontierPoint | null;
  scenarioDefs?: readonly PortfolioScenarioDef[];
  compact?: boolean;
  onApplyScenario?: (id: PortfolioScenarioId, point: PortfolioCarryFrontierPoint) => void;
  onPickCustom?: (point: PortfolioCarryFrontierPoint) => void;
  onUseBalanced?: () => void;
}) {
  const clipRaw = useId();
  const clipId = `lu-clip-${clipRaw.replace(/:/g, '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<{
    W: number;
    H: number;
    padL: number;
    padT: number;
    plotW: number;
    plotH: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    carryS: number;
    dataFrame: CarryVarPlotView;
    /** auto-frame xSpan / zSpan — keep zoom isotropic + repair squash */
    preferAspect: number;
    setView: (next: CarryVarPlotView) => void;
  } | null>(null);
  const [hover, setHover] = useState<{
    label: string;
    x: number;
    y: number;
    /** Σ|overlay legs| at this point (M USD) — capital deployed, not risk. */
    grossUsdM?: number;
    /** Net FX overlay (M USD). The USD funding/risk-free leg is its negative — see usdLegLabel. */
    netUsdM?: number;
  } | null>(null);
  const [view, setView] = useState<CarryVarPlotView | null>(null);
  const [panning, setPanning] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    lastSx: number;
    lastSy: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const pts = frontier.points;
  const farPts = frontier.farPoints ?? [];
  const sweet = pts[frontier.sweetSpotIndex] ?? null;
  const noHedge = pts[0] ?? null;
  // Tangency portfolio — line from the true (0,0) risk-free origin, tangent
  // to the curve (argmax carry/CFaR). Distinct from `sweet` (max distance
  // from the curve's own chord): only interior once a leg floor-clamps.
  const tangency = (frontier.tangencyIndex != null && frontier.tangencyIndex >= 0)
    ? pts[frontier.tangencyIndex] ?? null
    : null;
  let today = pts[0]!;
  for (const p of pts) {
    if (Math.abs(p.portfolioVarUsd - policyVAR) < Math.abs(today.portfolioVarUsd - policyVAR)) {
      today = p;
    }
  }
  const scenarioDefs = scenarioDefsProp ?? portfolioScenarioDefs(
    overlayFrontier ?? frontier,
    confidencePct,
    conservativePoint,
    unhedgedOriginUsdM,
    approvalTierCapUsd(policyVAR),
    plotCarryS(pts),
    carryTargetUsdYr,
  );
  const walkOriginX = noHedge && Number.isFinite(noHedge.portfolioVarUsd)
    ? Math.max(0, noHedge.portfolioVarUsd)
    : 0;
  const basisX = (
    typeof unhedgedOriginUsdM === 'number'
    && Number.isFinite(unhedgedOriginUsdM)
    && unhedgedOriginUsdM > 1e-9
  )
    ? unhedgedOriginUsdM
    : walkOriginX;
  const x0 = basisX;
  const unhedgedOrigin = { x: x0, y: 0 };
  const scenarioXy = (
    p: PortfolioCarryFrontierPoint | null,
    id?: PortfolioScenarioId,
  ) => {
    if (!p) return null;
    // Unhedged is the walk origin the arms start at — priced t = 0, $0 carry.
    if (id === 'unhedged') return unhedgedOrigin;
    if (id === 'carryTarget') {
      return { x: p.portfolioVarUsd, y: p.totalCarryUsdYr };
    }
    return projectScenarioPoint?.(p) ?? { x: p.portfolioVarUsd, y: p.totalCarryUsdYr };
  };
  const selectedOverlayPoint = selectedPoint
    ?? (selectedScenarioId
      ? scenarioDefs.find(s => s.id === selectedScenarioId)?.point ?? null
      : customPoint ?? null);
  const selectedXy = selectedScenarioId
    ? scenarioXy(selectedOverlayPoint, selectedScenarioId)
    : customPoint
      ? { x: customPoint.portfolioVarUsd, y: customPoint.totalCarryUsdYr }
      : null;
  const autoWindow = matchModalAxis
    ? liveBookWindow(pts, selectedXy?.x)
    : limitedUniverseWindow(pts, scenarioDefs, selectedScenarioId);
  const standingWalk = frontier.walk === 'book-scale';
  const chord = matchModalAxis || standingWalk ? null : unclampedRayChord(pts);

  const W = 680;
  // Taller plot so carry (Y) has more pixels vs CFaR (X) — frontier vs tangent.
  const H = compact ? 280 : 440;
  const padL = 72;
  const padR = 40;
  const padT = 28;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const autoXMin = 0;
  const autoXMax = autoWindow?.xMax ?? Math.max(x0 + 0.025, ...pts.map(p => p.portfolioVarUsd));
  const inAutoX = (v: number) => v >= autoXMin - 1e-9 && v <= autoXMax + 1e-9;

  const openY = [
    0,
    ...pts.filter(p => inAutoX(p.portfolioVarUsd)).map(p => p.totalCarryUsdYr),
    ...scenarioDefs.flatMap(s => {
      if (!s.point) return [];
      if (matchModalAxis && s.id !== 'carryTarget' && s.id !== 'balanced' && s.id !== 'unhedged') {
        return [];
      }
      const xy = scenarioXy(s.point, s.id);
      return xy && inAutoX(xy.x) ? [xy.y] : [];
    }),
  ].filter(Number.isFinite);
  const farYInFrame = farPts
    .filter(p => inAutoX(p.portfolioVarUsd))
    .map(p => p.totalCarryUsdYr)
    .filter(Number.isFinite);
  const yMaxData = Math.max(0.012, ...openY);
  const openLo = Math.min(0, ...openY);
  const farLo = Math.min(0, ...farYInFrame);
  let autoYMin: number;
  let autoYMax: number;
  let carryS: number;
  if (matchModalAxis) {
    const axis = carryAxisFromArms(openLo, yMaxData, farLo);
    carryS = axis.s;
    autoYMin = carryS * Math.sinh(axis.zNeg);
    autoYMax = carryS * Math.sinh(axis.zPos);
  } else {
    // Default view = open-arm carry band (far CIP stays reachable via pan/zoom).
    const yPad = Math.max(yMaxData * 0.04, 0.003);
    autoYMin = Math.min(0, openLo);
    if (autoYMin < -1e-6) autoYMin -= yPad;
    else autoYMin = -yPad * 0.35; // room under the $0 carry line
    autoYMax = yMaxData + yPad;
    // Same asinh band as parent scenarioDefs / tangencyFromTrueZero — not
    // frame/4, which put Balanced on a different hull vertex until select.
    carryS = plotCarryS(pts);
  }
  // Magnify carry vs CFaR so the open-arm bend separates from the (0,0) tangent.
  {
    const keepY: number[] = [0, openLo, yMaxData];
    for (const s of scenarioDefs) {
      if (s.id !== 'balanced' && s.id !== 'carryTarget' && s.id !== 'unhedged') continue;
      const xy = scenarioXy(s.point, s.id);
      if (xy && Number.isFinite(xy.y)) keepY.push(xy.y);
    }
    if (selectedXy && Number.isFinite(selectedXy.y)) keepY.push(selectedXy.y);
    const framed = emphasizeCarryFrame(
      autoYMin,
      autoYMax,
      carryS,
      // Higher = tighter asinh-Y window → more vertical zoom vs CFaR.
      matchModalAxis ? 2.1 : 3.0,
      keepY,
    );
    autoYMin = framed.yMin;
    autoYMax = framed.yMax;
  }
  const autoFrame: CarryVarPlotView = {
    xMin: autoXMin,
    xMax: autoXMax,
    yMin: autoYMin,
    yMax: autoYMax,
  };

  const allCarry = [
    ...pts.map(p => p.totalCarryUsdYr),
    ...farPts.map(p => p.totalCarryUsdYr),
  ].filter(Number.isFinite);
  const allCfar = [
    ...pts.map(p => p.portfolioVarUsd),
    ...farPts.map(p => p.portfolioVarUsd),
  ].filter(Number.isFinite);
  const policyHi = POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd;
  const yCoreMin = Math.min(autoFrame.yMin, ...allCarry, 0);
  const yCoreMax = Math.max(autoFrame.yMax, ...allCarry, 0.012);
  const zCore0 = carryFwd(yCoreMin, carryS);
  const zCore1 = carryFwd(yCoreMax, carryS);
  const zCorePad = Math.max(zCore1 - zCore0, 0.55);
  const dataFrame: CarryVarPlotView = {
    xMin: 0,
    xMax: Math.max(autoFrame.xMax, ...allCfar, policyHi, 0.05) * 1.2,
    yMin: carryS * Math.sinh(zCore0 - zCorePad),
    yMax: carryS * Math.sinh(zCore1 + zCorePad),
  };

  useEffect(() => {
    setView(null);
  }, [selectedScenarioId]);

  const xMin = view?.xMin ?? autoFrame.xMin;
  const xMax = view?.xMax ?? autoFrame.xMax;
  const yMin = view?.yMin ?? autoFrame.yMin;
  const yMax = view?.yMax ?? autoFrame.yMax;
  const inX = (v: number) => v >= xMin - 1e-9 && v <= xMax + 1e-9;
  const inFrame = (px: number, py: number) =>
    inX(px) && py >= yMin - 1e-9 && py <= yMax + 1e-9;

  const zMin = carryFwd(yMin, carryS);
  const zMax = carryFwd(yMax, carryS);
  const zDen = zMax - zMin;
  const xDen = xMax - xMin;
  const x = (v: number) => padL + (xDen > 1e-12 ? ((v - xMin) / xDen) * plotW : 0);
  const y = (v: number) => padT + (1 - (carryFwd(v, carryS) - zMin) / (zDen || 1)) * plotH;
  const ox0 = x(0);
  const oy0 = y(0);
  // Balanced = (0,0) supporting-ray touch in the same asinh band as this plot.
  // Do not use a pixel-space "graze" or the chord sweet — those sit elsewhere and
  // made the amber marker jump when selected.
  const balancedTouch = tangencyFromTrueZero(pts, carryS);
  const graze = balancedTouch;
  const y0 = y(0);
  const yTickMin = yMin;
  const yTickMax = yMax;
  const originInX = x0 >= xMin - 1e-9 && x0 <= xMax + 1e-9;
  const zeroInY = yMin <= 1e-12 && yMax >= -1e-12;

  const autoZ0 = carryFwd(autoFrame.yMin, carryS);
  const autoZ1 = carryFwd(autoFrame.yMax, carryS);
  const preferAspect = (autoFrame.xMax - autoFrame.xMin)
    / Math.max(autoZ1 - autoZ0, 1e-9);

  zoomRef.current = {
    W, H, padL, padT, plotW, plotH, xMin, xMax, yMin, yMax, carryS, dataFrame,
    preferAspect, setView,
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const z = zoomRef.current;
      if (!z) return;
      const pt = svgLocalXY(el, e.clientX, e.clientY, z.W, z.H);
      if (!pt || !inPlotRect(pt.sx, pt.sy, z.padL, z.padT, z.plotW, z.plotH)) {
        return;
      }
      e.preventDefault();
      const raw = e.deltaMode === 1
        ? e.deltaY * 16
        : e.deltaMode === 2
          ? Math.sign(e.deltaY) * z.plotH
          : e.deltaY;
      if (raw === 0) return;
      const factor = Math.exp(Math.max(-12, Math.min(12, raw)) * (e.ctrlKey ? 0.0035 : 0.002));
      if (Math.abs(factor - 1) < 0.001) return;
      const xSpan = z.xMax - z.xMin;
      const ax = z.xMin + ((pt.sx - z.padL) / z.plotW) * xSpan;
      const zLo = carryFwd(z.yMin, z.carryS);
      const zHi = carryFwd(z.yMax, z.carryS);
      const az = zHi - ((pt.sy - z.padT) / z.plotH) * (zHi - zLo);
      z.setView(clampCarryVarPlotView(
        {
          xMin: ax - (ax - z.xMin) * factor,
          xMax: ax + (z.xMax - ax) * factor,
          yMin: z.carryS * Math.sinh(az - (az - zLo) * factor),
          yMax: z.carryS * Math.sinh(az + (zHi - az) * factor),
        },
        z.dataFrame,
        z.carryS,
        { x: ax, z: az },
        z.preferAspect,
      ));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const endPan = (e: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.moved) {
      suppressClickRef.current = true;
      queueMicrotask(() => { suppressClickRef.current = false; });
    }
    dragRef.current = null;
    setPanning(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  const onPlotPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const z = zoomRef.current;
    const el = svgRef.current;
    if (!z || !el) return;
    const pt = svgLocalXY(el, e.clientX, e.clientY, z.W, z.H);
    if (!pt || !inPlotRect(pt.sx, pt.sy, z.padL, z.padT, z.plotW, z.plotH)) return;
    if (snapNamedNear(pt.sx, pt.sy)) return;
    dragRef.current = { pointerId: e.pointerId, lastSx: pt.sx, lastSy: pt.sy, moved: false };
  };

  const onPlotPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const z = zoomRef.current;
    const el = svgRef.current;
    if (!drag || !z || !el || drag.pointerId !== e.pointerId) return;
    const pt = svgLocalXY(el, e.clientX, e.clientY, z.W, z.H);
    if (!pt) return;
    const dSx = pt.sx - drag.lastSx;
    const dSy = pt.sy - drag.lastSy;
    if (!drag.moved && Math.hypot(dSx, dSy) < 3) return;
    if (!drag.moved) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* already captured */ }
    }
    drag.moved = true;
    drag.lastSx = pt.sx;
    drag.lastSy = pt.sy;
    if (!panning) setPanning(true);
    const xSpan = z.xMax - z.xMin;
    const zLo = carryFwd(z.yMin, z.carryS);
    const zHi = carryFwd(z.yMax, z.carryS);
    const zSpan = zHi - zLo;
    z.setView(clampCarryVarPlotView(
      {
        xMin: z.xMin - (dSx / z.plotW) * xSpan,
        xMax: z.xMax - (dSx / z.plotW) * xSpan,
        yMin: z.carryS * Math.sinh(zLo + (dSy / z.plotH) * zSpan),
        yMax: z.carryS * Math.sinh(zHi + (dSy / z.plotH) * zSpan),
      },
      z.dataFrame,
      z.carryS,
    ));
  };

  const toPath = (rows: readonly { x: number; y: number }[]) =>
    rows
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`)
      .join(' ');

  const forkAtUnhedged = (
    path: readonly { x: number; y: number }[],
  ): { x: number; y: number }[] => {
    if (x0 <= 1e-9) return [...path];
    const rest = path.filter(p => (
      p.x >= x0 - 1e-9 && Math.hypot(p.x - x0, p.y) > 1e-4
    ));
    return [{ x: x0, y: 0 }, ...rest];
  };
  const openPath = forkAtUnhedged(pts.map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr })));
  const farPath = forkAtUnhedged(farPts.map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr })));
  const openInView = pts.filter(p => (
    p.portfolioVarUsd >= x0 - 1e-9 && inFrame(p.portfolioVarUsd, p.totalCarryUsdYr)
  ));
  const farInView = farPts.filter(p => (
    p.portfolioVarUsd >= x0 - 1e-9 && inFrame(p.portfolioVarUsd, p.totalCarryUsdYr)
  ));
  const openDotAt = pickDotsAlongPolyline(
    openInView.map(p => ({ x: x(p.portfolioVarUsd), y: y(p.totalCarryUsdYr) })),
    24,
    7,
  );
  const farDotAt = pickDotsAlongPolyline(
    farInView.map(p => ({ x: x(p.portfolioVarUsd), y: y(p.totalCarryUsdYr) })),
    22,
    7,
  );

  const xTickRaw = cfarKTicks(xMin, xMax);
  if (xMin <= 1e-9 && !xTickRaw.some(v => Math.abs(v) < 1e-9)) xTickRaw.unshift(0);
  if (x0 > 0 && !xTickRaw.some(v => Math.abs(v * 1000 - x0 * 1000) < 0.51)) {
    xTickRaw.push(x0);
  }
  xTickRaw.sort((a, b) => a - b);
  const xTicks: number[] = [];
  const xPriority = [x0, ...(xMin <= 1e-9 ? [0] : [])];
  for (const v of xPriority) {
    if (v >= xMin - 1e-9 && v <= xMax + 1e-9 && xTicks.every(u => Math.abs(x(u) - x(v)) >= 22)) {
      xTicks.push(v);
    }
  }
  for (const v of xTickRaw) {
    if (xTicks.every(u => Math.abs(x(u) - x(v)) >= 36)) xTicks.push(v);
  }
  xTicks.sort((a, b) => a - b);
  const yTicks = thinTicks(
    carryLogTicks(yTickMin, yTickMax).filter(v => {
      const py = y(v);
      return py >= padT - 2 && py <= padT + plotH + 2;
    }),
    y,
    14,
  );

  // USD is the risk-free leg funding the FX overlay: net FCY bought is USD
  // sold (and vice versa) — the mirror image of netOverlayUsdM, not a
  // separately-solved number.
  const usdLegTxt = (netUsdM?: number) =>
    netUsdM != null ? ` · USD ${fmtSignedK(-netUsdM)}` : '';

  const hoverTip = hover
    ? `${hover.label} · carry ${fmtSignedK(hover.y)} · CFaR ${fmtAbsK(hover.x)}${
        hover.grossUsdM != null ? ` · FX ${fmtAbsK(hover.grossUsdM)}` : ''
      }${usdLegTxt(hover.netUsdM)}`
    : null;

  const walkPts = (overlayFrontier ?? frontier).points;
  const selectedLabel = selectedScenarioId
    ? (scenarioDefs.find(s => s.id === selectedScenarioId)?.label ?? selectedScenarioId)
    : 'Custom';
  const selectedGrossUsdM = selectedOverlayPoint?.grossOverlayUsdM ?? today?.grossOverlayUsdM;
  const selectedNetUsdM = selectedOverlayPoint?.netOverlayUsdM ?? today?.netOverlayUsdM;
  const selectedDetail = selectedXy
    ? `${fmtAbsK(selectedXy.x)} · ${fmtSignedK(selectedXy.y)}/yr${
        selectedGrossUsdM != null ? ` · FX ${fmtAbsK(selectedGrossUsdM)}` : ''
      }${usdLegTxt(selectedNetUsdM)}`
    : today
      ? `${fmtAbsK(today.portfolioVarUsd)} · ${fmtSignedK(today.totalCarryUsdYr)}/yr${
          selectedGrossUsdM != null ? ` · FX ${fmtAbsK(selectedGrossUsdM)}` : ''
        }${usdLegTxt(selectedNetUsdM)}`
      : '';
  const selectedMarkXy = selectedXy
    ?? (today ? { x: today.portfolioVarUsd, y: today.totalCarryUsdYr } : null);
  const balancedCfarUsd = balancedTouch?.portfolioVarUsd
    ?? scenarioXy(
      scenarioDefs.find(s => s.id === 'balanced')?.point ?? null,
      'balanced',
    )?.x
    ?? null;
  const walkX = selectedMarkXy?.x ?? policyVAR;
  const walkIdx = nearestFrontierIndex(walkPts, walkX);
  const canWalkPrev = walkIdx > 0;
  const canWalkNext = walkIdx >= 0 && walkIdx < walkPts.length - 1;
  const snapNamedNear = (px: number, py: number) => {
    let best: { id: PortfolioScenarioId; point: PortfolioCarryFrontierPoint; d: number } | null = null;
    for (const s of scenarioDefs) {
      const point = s.id === 'balanced' && balancedTouch
        ? balancedTouch
        : s.point;
      const xy = scenarioXy(point, s.id);
      if (!point || !xy || s.breached) continue;
      const d = Math.hypot(x(xy.x) - px, y(xy.y) - py);
      if (d <= 12 && (!best || d < best.d)) {
        const applied = s.id === 'unhedged'
          ? { ...point, k: 0, portfolioVarUsd: x0, totalCarryUsdYr: 0 }
          : point;
        best = { id: s.id, point: applied, d };
      }
    }
    return best;
  };
  const applyOpenPoint = (p: PortfolioCarryFrontierPoint) => {
    const named = snapNamedNear(x(p.portfolioVarUsd), y(p.totalCarryUsdYr));
    if (named && onApplyScenario) onApplyScenario(named.id, named.point);
    else onPickCustom?.(p);
  };
  const walkBy = (dir: -1 | 1) => {
    const next = walkPts[walkIdx + dir];
    if (next) applyOpenPoint(next);
  };
  const pickNearestOpenAt = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    const z = zoomRef.current;
    if (!el || !z) return null;
    const loc = svgLocalXY(el, clientX, clientY, z.W, z.H);
    if (!loc) return null;
    let best: PortfolioCarryFrontierPoint | null = null;
    let bestD = Infinity;
    for (const p of pts) {
      const d = Math.hypot(x(p.portfolioVarUsd) - loc.sx, y(p.totalCarryUsdYr) - loc.sy);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return bestD <= 22 ? best : null;
  };

  return (
    <div className={`rounded-[10px] border border-slate-700 bg-slate-950 ${compact ? 'p-2' : 'p-3'}`}>
      <div className={`flex flex-wrap items-center gap-2 ${compact ? 'mb-1' : 'mb-2 gap-2.5'}`}>
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-slate-400">
          Carry vs CFaR
        </span>
        <InfoTip label="Limited universe">
          {matchModalAxis ? (
            <p>
              One currency — same standing walk, cash carry, and CFaR as that
              name&apos;s per-currency modal. Scroll inside the plot to zoom, drag
              to pan, double-click to reset.
              Carry Target / Balanced still apply the overlay Policy VAR fill.
            </p>
          ) : frontier.sweetSpotIndex === -1 ? (
            <p>
              Straight Σ⁻¹μ ray — carry and CFaR scale together until a sold PAY name hits a floor.
              {frontier.nearestClampVarUsd != null
                ? ` First clamp is ${frontier.nearestClampCcy} at ${fmtAbsK(frontier.nearestClampVarUsd)}${
                    frontier.nearestClampVarUsd > POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd * 4
                      ? ' — past the bounded sweep, so this window never bends.'
                      : '.'
                  }`
                : ' No sold name in this book has a Min floor or an expensive overdraft (r_OD > r_USD), so nothing clamps. Dashed line = the ray.'}
            </p>
          ) : standingWalk ? (
            <p>
              Same standing walk as a one-name left-end: S(t) = t × book.
              Green is open cash; pink is far (cash + points). Unhedged is
              the CFaR-tab All CCY Net at $0 carry. Carry Target is the open-arm
              hit on the desk Target Carry. The amber dashed line is the
              tangent from (0, 0) and meets the open arm at Balanced.
            </p>
          ) : (
            <p>
              Frame is the live book and the $0-carry origin. Carry Y is log-scaled
              so the live bend is visible; scroll inside the plot to zoom, drag to
              pan, double-click to reset.
              Dashed = unclamped Σ⁻¹μ ray. Solid peels off when a PAY short hits its
              floor. Max Policy Risk clips unless you pick it. Click a preset, a green
              sample, or the open curve for a custom fill. ◀ ▶ steps the
              prerendered dots.
            </p>
          )}
        </InfoTip>
        {scenarioDefs.map(s => {
          const chipPoint = s.id === 'balanced' && balancedTouch
            ? balancedTouch
            : s.point;
          return (
          <button
            key={s.id}
            type="button"
            disabled={!chipPoint || !onApplyScenario || s.breached}
            onClick={() => {
              if (!chipPoint || s.breached) return;
              onApplyScenario?.(s.id, s.id === 'unhedged'
                ? { ...chipPoint, k: 0, portfolioVarUsd: x0, totalCarryUsdYr: 0 }
                : chipPoint);
            }}
            className={`inline-flex items-center gap-1 font-mono text-[9px] ${
              s.breached
                ? 'text-rose-400'
                : selectedScenarioId === s.id ? 'font-semibold text-amber-200' : 'text-slate-400'
            } ${chipPoint && onApplyScenario && !s.breached ? 'hover:text-slate-200' : 'cursor-not-allowed'}`}
            title={s.breached
              ? `${s.label} — POLICY BREACH: base standalone exposure alone exceeds $${s.breachTierUsd?.toFixed(0)}M, no overlay sizing fixes this`
              : (chipPoint
                ? `${s.label} — ${fmtAbsK(s.id === 'unhedged' ? x0 : chipPoint.portfolioVarUsd)} CFaR, ${fmtSignedK(s.id === 'unhedged' ? 0 : chipPoint.totalCarryUsdYr)}/yr`
                : (s.disabledHint ?? 'not in this universe'))}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: s.breached ? '#f43f5e' : (chipPoint ? PORTFOLIO_SCENARIO_COLORS[s.id] : '#475569') }}
            />
            {s.breached && '⚠ '}{s.label}
            {selectedScenarioId === s.id && !s.breached && <span className="text-amber-300/80">sweet</span>}
            {s.breached && <span className="text-rose-500">breach</span>}
            {!chipPoint && !s.breached && <span className="text-slate-600">(n/a)</span>}
          </button>
          );
        })}
        {!selectedScenarioId && selectedMarkXy && (
          <span className="inline-flex items-center gap-1 font-mono text-[9px] font-semibold text-sky-200">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
            Custom
            <span className="font-normal text-slate-500">{selectedDetail}</span>
          </span>
        )}
        {onPickCustom && walkPts.length > 1 && (
          <span className="inline-flex items-center overflow-hidden rounded border border-slate-700">
            <button
              type="button"
              disabled={!canWalkPrev}
              title="Previous prerendered point"
              onClick={() => walkBy(-1)}
              className="px-1.5 py-0.5 font-mono text-[10px] text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-700"
            >
              ◀
            </button>
            <button
              type="button"
              disabled={!canWalkNext}
              title="Next prerendered point"
              onClick={() => walkBy(1)}
              className="px-1.5 py-0.5 font-mono text-[10px] text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-700"
            >
              ▶
            </button>
          </span>
        )}
        {onUseBalanced && selectedScenarioId !== 'balanced' && !compact
          && balancedCfarUsd != null && (
          <button
            type="button"
            onClick={onUseBalanced}
            className="ml-auto shrink-0 rounded border border-amber-400/50 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] font-semibold text-amber-300 hover:bg-amber-500/20"
            title={`Assign the Balanced sweet spot: ${fmtAbsK(balancedCfarUsd)} CFaR`}
          >
            use Balanced {fmtAbsK(balancedCfarUsd)}
          </button>
        )}
      </div>
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-[9px] text-slate-500">
          Origin: carry $0 @ section {noHedge ? fmtAbsK(noHedge.portfolioVarUsd) : '—'}
          {matchModalAxis ? ' · same engine as CCY modal' : ' · log Y'} · scroll in plot to zoom · drag to pan
        </span>
        {view && (
          <button
            type="button"
            onClick={() => setView(null)}
            className="font-mono text-[9px] text-sky-400 hover:text-sky-300"
          >
            reset zoom
          </button>
        )}
        <span className="ml-auto flex flex-wrap gap-2.5">
          <UniverseLegend swatch="solid" border="border-emerald-400" label="open · cash" />
          <UniverseLegend swatch="solid" border="border-rose-400" label="far · cash + points" />
          {!matchModalAxis && !standingWalk && (
            <UniverseLegend swatch="dashed" border="border-slate-400" label="unclamped ray" />
          )}
          <UniverseLegend swatch="dashed" border="border-amber-400" label="tangent from (0,0)" />
          <UniverseLegend swatch="dot" border="border-sky-400" label="selected" />
        </span>
      </div>
      <div className="relative" style={{ overscrollBehavior: 'contain' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full touch-none select-none overflow-hidden rounded-md bg-slate-950/50 outline-none focus:outline-none"
          tabIndex={0}
          role="img"
          aria-label="Carry versus CFaR. Arrow keys step prerendered points."
          onDoubleClick={() => setView(null)}
          onPointerDown={onPlotPointerDown}
          onPointerMove={onPlotPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onClick={e => {
            if (suppressClickRef.current) return;
            const el = svgRef.current;
            const z = zoomRef.current;
            if (!el || !z) return;
            const loc = svgLocalXY(el, e.clientX, e.clientY, z.W, z.H);
            if (!loc) return;
            const named = snapNamedNear(loc.sx, loc.sy);
            if (named && onApplyScenario) {
              onApplyScenario(named.id, named.point);
            }
          }}
          onKeyDown={e => {
            if (e.key === 'ArrowLeft' && canWalkPrev) {
              e.preventDefault();
              walkBy(-1);
            } else if (e.key === 'ArrowRight' && canWalkNext) {
              e.preventDefault();
              walkBy(1);
            }
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={padL} y={padT} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          <text x={padL + plotW / 2} y={H - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">
            CFaR ($K) — risk
          </text>
          <text
            x={13}
            y={padT + plotH / 2}
            textAnchor="middle"
            fontSize={9}
            fill="#94a3b8"
            transform={`rotate(-90 13 ${padT + plotH / 2})`}
          >
            Carry ($K/yr) — log
          </text>
          <line x1={padL} y1={padT} x2={W - padR} y2={padT} stroke="#334155" strokeWidth={1} />
          <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#475569" strokeWidth={1} />
          <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#334155" strokeWidth={1} />
          {xTicks.map(v => (
            <g key={`xt-${v}`}>
              <line x1={x(v)} y1={H - padB} x2={x(v)} y2={H - padB + 4} stroke="#64748b" />
              <text
                x={x(v)}
                y={H - padB + 15}
                textAnchor="middle"
                fontSize={8}
                fill={Math.abs(v - x0) < 1e-6 ? '#e2e8f0' : '#cbd5e1'}
              >
                {fmtK(v)}
              </text>
            </g>
          ))}
          {yTicks.map(v => (
            <g key={`yt-${v}`}>
              <line x1={padL - 4} y1={y(v)} x2={padL} y2={y(v)} stroke="#64748b" />
              <text
                x={padL - 7}
                y={y(v) + 3}
                textAnchor="end"
                fontSize={8}
                fill={Math.abs(v) < 1e-9 ? '#e2e8f0' : '#cbd5e1'}
              >
                {Math.abs(v) < 1e-9 ? '$0' : fmtK(v)}
              </text>
            </g>
          ))}
          {originInX && (
            <line x1={x(x0)} y1={padT} x2={x(x0)} y2={H - padB} stroke="#334155" strokeWidth={1} />
          )}
          {zeroInY && (
            <line x1={padL} y1={y0} x2={W - padR} y2={y0} stroke="#94a3b8" strokeWidth={1.2} />
          )}
          {originInX && zeroInY && (
            <>
              <text x={x(x0) + 8} y={y0 + 12} fontSize={8} fill="#e2e8f0">
                carry $0
              </text>
              <text x={x(x0) + 8} y={y0 + 23} fontSize={8} fill="#94a3b8">
                unhedged {fmtAbsK(x0)}
              </text>
            </>
          )}
          <rect
            x={padL}
            y={padT}
            width={plotW}
            height={plotH}
            fill="transparent"
            className={panning ? 'cursor-grabbing' : 'cursor-grab'}
          />
          <g clipPath={`url(#${clipId})`}>
            {chord && chord.length >= 2 && (
              <path
                d={toPath(chord)}
                fill="none"
                stroke="#64748b"
                strokeWidth={1.25}
                strokeDasharray="5 4"
              />
            )}
            {(() => {
              const touch = graze
                ?? scenarioDefs.find(s => s.id === 'balanced')?.point
                ?? tangency;
              if (!touch) return null;
              const tx = x(touch.portfolioVarUsd);
              const ty = y(touch.totalCarryUsdYr);
              const den = tx - ox0;
              if (!(Math.abs(den) > 1e-6)) return null;
              const m = (ty - oy0) / den;
              const xL = padL;
              const xR = padL + plotW;
              return (
                <path
                  d={`M${xL.toFixed(1)},${(oy0 + m * (xL - ox0)).toFixed(1)} L${xR.toFixed(1)},${(oy0 + m * (xR - ox0)).toFixed(1)}`}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={1.2}
                  strokeDasharray="4 3"
                />
              );
            })()}
            {openPath.length >= 2 && (
              <path d={toPath(openPath)} fill="none" stroke="#34d399" strokeWidth={1.8} />
            )}
            {openPath.length >= 2 && onPickCustom && (
              <path
                d={toPath(openPath)}
                fill="none"
                stroke="transparent"
                strokeWidth={16}
                className="cursor-pointer"
                onClick={e => {
                  e.stopPropagation();
                  if (suppressClickRef.current) return;
                  const hit = pickNearestOpenAt(e.clientX, e.clientY);
                  if (hit) applyOpenPoint(hit);
                }}
              />
            )}
            {farPath.length >= 2 && (
              <path d={toPath(farPath)} fill="none" stroke="#fb7185" strokeWidth={1.6} />
            )}
          </g>
          {farInView.map((p, i) => (
            farDotAt.has(i) ? (
              <circle
                key={`f-${i}`}
                cx={x(p.portfolioVarUsd)}
                cy={y(p.totalCarryUsdYr)}
                r={3.5}
                fill="#fb7185"
                stroke="#0b1220"
                strokeWidth={1}
                className="pointer-events-none"
              />
            ) : null
          ))}
          {openInView.map((p, i) => (
            openDotAt.has(i) ? (
              <g key={`o-${i}`}>
                {onPickCustom && (
                  <circle
                    cx={x(p.portfolioVarUsd)}
                    cy={y(p.totalCarryUsdYr)}
                    r={9}
                    fill="transparent"
                    className="cursor-pointer"
                    onClick={e => {
                      e.stopPropagation();
                      if (suppressClickRef.current) return;
                      applyOpenPoint(p);
                    }}
                    onDoubleClick={e => e.stopPropagation()}
                    onMouseEnter={() => setHover({
                      label: 'Custom sample',
                      x: p.portfolioVarUsd,
                      y: p.totalCarryUsdYr,
                      grossUsdM: p.grossOverlayUsdM,
                      netUsdM: p.netOverlayUsdM,
                    })}
                    onMouseLeave={() => setHover(null)}
                  />
                )}
                <circle
                  cx={x(p.portfolioVarUsd)}
                  cy={y(p.totalCarryUsdYr)}
                  r={3.5}
                  fill="#34d399"
                  stroke="#0b1220"
                  strokeWidth={1}
                  className="pointer-events-none"
                />
              </g>
            ) : null
          ))}
          {tangency && inFrame(tangency.portfolioVarUsd, tangency.totalCarryUsdYr) && (
            <g onPointerDown={e => e.stopPropagation()}>
              <circle
                cx={x(tangency.portfolioVarUsd)}
                cy={y(tangency.totalCarryUsdYr)}
                r={11}
                fill="transparent"
                onMouseEnter={() => setHover({
                  label: 'Tangency (max Sharpe)',
                  x: tangency.portfolioVarUsd,
                  y: tangency.totalCarryUsdYr,
                  grossUsdM: tangency.grossOverlayUsdM,
                  netUsdM: tangency.netOverlayUsdM,
                })}
                onMouseLeave={() => setHover(null)}
              />
              <circle
                cx={x(tangency.portfolioVarUsd)}
                cy={y(tangency.totalCarryUsdYr)}
                r={4}
                fill="#22d3ee"
                stroke="#0b1220"
                strokeWidth={1}
                className="pointer-events-none"
              />
            </g>
          )}
          {scenarioDefs.map(s => {
            const point = s.id === 'balanced' && balancedTouch
              ? balancedTouch
              : s.point;
            const xy = scenarioXy(point, s.id);
            if (!point || !xy || !inFrame(xy.x, xy.y)) return null;
            const fill = s.breached ? '#f43f5e' : (PORTFOLIO_SCENARIO_COLORS[s.id] ?? '#94a3b8');
            const p = s.id === 'unhedged'
              ? { ...point, k: 0, portfolioVarUsd: x0, totalCarryUsdYr: 0 }
              : point;
            return (
              <g
                key={s.id}
                onPointerDown={e => e.stopPropagation()}
              >
                <circle
                  cx={x(xy.x)}
                  cy={y(xy.y)}
                  r={11}
                  fill="transparent"
                  className={onApplyScenario && !s.breached ? 'cursor-pointer' : undefined}
                  onClick={e => {
                    e.stopPropagation();
                    if (suppressClickRef.current) return;
                    if (onApplyScenario && !s.breached) onApplyScenario(s.id, p);
                  }}
                  onDoubleClick={e => e.stopPropagation()}
                  onMouseEnter={() => setHover({
                    label: s.breached ? `${s.label} (breach)` : s.label,
                    x: xy.x,
                    y: xy.y,
                    grossUsdM: point.grossOverlayUsdM,
                    netUsdM: point.netOverlayUsdM,
                  })}
                  onMouseLeave={() => setHover(null)}
                />
                <circle
                  cx={x(xy.x)}
                  cy={y(xy.y)}
                  r={5}
                  fill={fill}
                  stroke="#0b1220"
                  strokeWidth={1}
                  className="pointer-events-none"
                />
              </g>
            );
          })}
          {selectedMarkXy && inFrame(selectedMarkXy.x, selectedMarkXy.y) && (
            <SelectedFrontierMark
              cx={x(selectedMarkXy.x)}
              cy={y(selectedMarkXy.y)}
              label={selectedLabel}
              detail={selectedDetail}
              plotLeft={padL}
              plotRight={padL + plotW}
              plotTop={padT}
              plotBottom={padT + plotH}
              xTick={fmtAbsK(selectedMarkXy.x)}
              yTick={fmtSignedK(selectedMarkXy.y)}
            />
          )}
        </svg>
        {hoverTip && (
          <div className="pointer-events-none absolute right-2 top-2 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-200">
            {hoverTip}
          </div>
        )}
      </div>
    </div>
  );
}


function SelectedStrategyDetail({
  result,
  isLive,
  onInspectCcy,
  residualByCcy,
  onResidualChange,
  preparedByCcy,
  overlayLegs,
  onStage,
  onStageAll,
  onResetDesk,
  onApplyPortfolioDelta,
  canApplyPortfolioDelta,
}: {
  result: LiquidityStrategyResult;
  isLive: boolean;
  onInspectCcy: (ccy: string) => void;
  residualByCcy: Record<string, number>;
  onResidualChange: (ccy: string, residual: number) => void;
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  overlayLegs?: readonly EfficientCarryLeg[];
  onStage?: (
    ccy: string,
    residual: number,
    schedule: LiquidityStrategyCcy['schedule'],
  ) => void;
  onStageAll?: () => void;
  onResetDesk: () => void;
  onApplyPortfolioDelta?: () => void;
  canApplyPortfolioDelta?: boolean;
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
  const swapCarryK = book.swap + book.cip;
  const hasOverlay = (overlayLegs?.length ?? 0) > 0;
  const mixJoin = joinOverlayStripWeights(
    overlayLegs ?? [],
    result.byCcy.map(c => ({
      ccy: c.ccy,
      bookNow: c.bookNow,
      outstanding: stripOutstanding(c),
    })),
  );
  const mixByCcy = new Map(mixJoin.map(r => [r.ccy, r]));
  const overlayUsdTotal = mixJoin.reduce((s, r) => s + r.overlayUsdM, 0);
  const modeledCount = Object.keys(residualByCcy).length;
  const stageable = result.byCcy.filter(c => {
    const residual = residualByCcy[c.ccy];
    return residual != null && residualNeedsFxStage(residual) && c.schedule.length > 0;
  });

  return (
    <section>
      <ChapterLabel
        n={4}
        title="Book"
        info={
          <>
            <p>
              Swap columns are the funding-swap ledger. Overlay columns are the Σ⁻¹μ mix (H* −
              hold) — not Swap Near. Mix w% / Overlay FCY / Overlay $ track that
              position; Strip w% / Swap Near / Book / cash / CIP stay on the swap. Δ residual 1 =
              open (stage FX strip) · 0 = far (CIP on). Auto Δ copies the last frontier mix.
              Reset desk restores the precomputed per-CCY swap programmes.
            </p>
            <p className="mt-1.5">
              Click a CCY to open the frontier. Chevron expands legs only.
            </p>
          </>
        }
      />
      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
            {result.strategy.label}
            {isLive ? ' · live desk' : ' · preview'}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {onApplyPortfolioDelta ? (
              <button
                type="button"
                disabled={!canApplyPortfolioDelta}
                onClick={onApplyPortfolioDelta}
                title={
                  canApplyPortfolioDelta
                    ? 'Apply the last frontier Δ to every CCY strip (portfolio flow)'
                    : 'Pick a Δ mix on a currency frontier first'
                }
                className="rounded border border-violet-500/50 bg-violet-500/15 px-2 py-1 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Auto Δ
              </button>
            ) : null}
            <button
              type="button"
              disabled={modeledCount === 0}
              onClick={onResetDesk}
              title="Restore per-CCY precomputed swap programmes (launch desk)"
              className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset desk
            </button>
            {onStageAll && stageable.length > 0 ? (
              <button
                type="button"
                onClick={onStageAll}
                title="Stage every Δ>0 strip for FX Risk / Carry / Decision"
                className="rounded border border-violet-500/50 bg-violet-500/20 px-2.5 py-1 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30"
              >
                Stage all
              </button>
            ) : null}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th className="py-2 pr-3 font-medium">CCY</th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Signed L1 share of Σ⁻¹μ overlay USD at the sweet (H* − hold)"
                >
                  Mix w%
                </th>
                <th
                  className="py-2 pr-3 font-medium text-violet-300/90"
                  title="H* − hold, M FCY — overlay notional, not Swap Near"
                >
                  Overlay FCY
                </th>
                <th
                  className="py-2 pr-3 font-medium text-violet-300/90"
                  title="Overlay USD at the sweet — position size, not risk"
                >
                  Overlay $
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Signed L1 share of this programme’s swap-book USD"
                >
                  Strip w%
                </th>
                <th className="py-2 pr-3 font-medium">Struct</th>
                <th className="py-2 pr-3 font-medium">Schedule</th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Frontier residual Δ · 1 open (CIP off, stage FX) · 0 far (CIP on)"
                >
                  Δ
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Near-leg book-now in M FCY — funding-swap standing, not the FX hedge"
                >
                  Swap Near
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Swap notional outstanding once every leg on the funded path is on — every earlier leg is rolled or held, not run off, so the legs add up. Same figure as Swap Book on the desk."
                >
                  Swap Book
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Standing-book cash Δr (desk Buffer Carry) — not Cash Carry"
                >
                  Swap cash
                </th>
                <th
                  className="py-2 pr-3 font-medium"
                  title="Far-leg CIP on the funding swap — scaled by (1−Δ)"
                >
                  CIP
                </th>
                <th
                  className="py-2 font-medium"
                  title="Swap cash + CIP"
                >
                  Swap carry
                </th>
              </tr>
            </thead>
            <tbody>
              {result.byCcy.map(c => {
                const canOpen = c.schedule.length > 0;
                const open = canOpen && !collapsed.has(c.ccy);
                const carryUsdM = swapCarryUsdM(c);
                const struct = fundingStructLabel(result.strategy, c.schedule);
                const schedule = compactFundingSchedule(c.schedule);
                const endingBook = c.schedule.length > 0
                  ? c.schedule[c.schedule.length - 1]!.outstanding
                  : 0;
                const modeled = Object.prototype.hasOwnProperty.call(residualByCcy, c.ccy);
                const residual = modeled ? residualByCcy[c.ccy]! : 0;
                const staged = preparedByCcy?.[c.ccy]?.preparedFor === 'liquidity';
                const canStage = Boolean(
                  onStage && modeled && residualNeedsFxStage(residual) && canOpen,
                );
                const mixRow = mixByCcy.get(c.ccy);
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
                        {staged ? (
                          <span className="ml-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wide text-emerald-200">
                            Staged
                          </span>
                        ) : null}
                      </td>
                      <td
                        className="py-2 pr-3 font-mono"
                        title={mixRow ? `Overlay ${fmtSignedK(mixRow.overlayUsdM)} · ${fmtM(mixRow.overlayFcyM)} FCY` : 'No overlay mix'}
                      >
                        {mixRow ? fmtWeight(mixRow.overlayWeight) : '—'}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono ${mixRow && Math.abs(mixRow.overlayFcyM) > 0.001 ? moneyTone(mixRow.overlayFcyM) : 'text-slate-600'}`}
                        title="H* − hold overlay FCY — not the funding swap"
                      >
                        {hasOverlay && mixRow && Math.abs(mixRow.overlayFcyM) > 0.001
                          ? fmtM(mixRow.overlayFcyM)
                          : '—'}
                      </td>
                      <td
                        className={`py-2 pr-3 font-mono ${mixRow && Math.abs(mixRow.overlayUsdM) > 0.005 ? moneyTone(mixRow.overlayUsdM) : 'text-slate-600'}`}
                        title="Overlay USD notional at the sweet"
                      >
                        {hasOverlay && mixRow && Math.abs(mixRow.overlayUsdM) > 0.005
                          ? fmtSignedK(mixRow.overlayUsdM)
                          : '—'}
                      </td>
                      <td className="py-2 pr-3 font-mono text-amber-200">
                        {mixRow ? fmtWeight(mixRow.stripWeight) : '—'}
                      </td>
                      <td className="py-2 pr-3 font-mono capitalize text-violet-300/90">
                        {struct}
                      </td>
                      <td className="py-2 pr-3 font-mono text-amber-200/90">
                        {schedule}
                      </td>
                      <td
                        className="py-2 pr-3"
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-1.5">
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={Math.round(residual * 100)}
                            aria-label={`${c.ccy} residual delta`}
                            title="1 open · 0 far"
                            onChange={e => {
                              onResidualChange(c.ccy, Number(e.target.value) / 100);
                            }}
                            className="h-1 w-16 accent-yellow-300"
                          />
                          <span className="w-8 font-mono text-[10px] text-yellow-200">
                            {modeled ? residual.toFixed(2) : 'desk'}
                          </span>
                          {canStage ? (
                            <button
                              type="button"
                              onClick={() => onStage?.(c.ccy, residual, c.schedule)}
                              className="rounded border border-violet-500/50 bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-violet-100 hover:bg-violet-500/30"
                            >
                              {staged ? 'Restage' : 'Stage'}
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-sky-300">
                        {fmtM(c.bookNow)}
                      </td>
                      <td className={`py-2 pr-3 font-mono ${moneyTone(endingBook)}`}
                        title="Standing after every leg on the funded path is on">
                        {Math.abs(endingBook) > 0.001 ? fmtM(endingBook) : '—'}
                      </td>
                      <td className={`py-2 pr-3 font-mono ${moneyTone(c.swapInterestUsdYrM)}`}>
                        {fmtSignedK(c.swapInterestUsdYrM)}
                      </td>
                      <td className={`py-2 pr-3 font-mono ${moneyTone(c.swapPointsUsdYrM)}`}>
                        {fmtSignedK(c.swapPointsUsdYrM)}
                      </td>
                      <td className={`py-2 font-mono font-semibold ${moneyTone(carryUsdM)}`}>
                        {fmtSignedK(carryUsdM)}
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
                          <td className="py-1.5 pr-3 font-mono text-slate-600">—</td>
                          <td className="py-1.5 pr-3 font-mono text-slate-600">—</td>
                          <td className="py-1.5 pr-3 font-mono text-slate-600">—</td>
                          <td className="py-1.5 pr-3 font-mono text-slate-600">—</td>
                          <td className="py-1.5 pr-3 font-mono text-slate-500">
                            trade
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-amber-200/80">
                            {l.settleMonths > 1 ? `${l.settleMonths}M far` : `M${l.valueDateMonths + 1}`}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-yellow-200/80">
                            {modeled ? `${fmtM(residual * l.newLeg)} Δ` : '—'}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-slate-400">
                            {fmtM(l.newLeg)}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-slate-500"
                            title="Rolled forward from earlier legs + this leg — every earlier leg is rolled or held, not run off">
                            {Math.abs(l.outstanding) > 0.001 ? fmtM(l.outstanding) : '—'}
                          </td>
                          <td
                            className={`py-1.5 pr-3 font-mono ${moneyTone(l.interestUsdYr)}`}
                            title={`FCY ${fmtSignedK(l.fcyOnUsdYr)} · USD ${fmtSignedK(l.usdOnUsdYr)}`}
                          >
                            {fmtSignedK(l.interestUsdYr)}
                          </td>
                          <td
                            className={`py-1.5 pr-3 font-mono ${moneyTone(l.pointsUsdYr)}`}
                            title={
                              l.midPoints != null
                                ? `Mid ${l.midPoints.toFixed(2)} pts · ${l.settleMonths}M`
                                : undefined
                            }
                          >
                            {fmtSignedK(l.pointsUsdYr)}
                          </td>
                          <td
                            className={`py-1.5 font-mono ${moneyTone(l.netUsdYr)}`}
                            title={`FCY ${fmtSignedK(l.fcyOnUsdYr)} · USD ${fmtSignedK(l.usdOnUsdYr)} · CIP ${fmtSignedK(l.pointsUsdYr)}`}
                          >
                            {fmtSignedK(l.netUsdYr)}
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-600 bg-slate-900/80 font-mono text-slate-200">
                <td className="py-2 pr-3 font-semibold text-white" colSpan={2}>
                  TOTAL $USD
                </td>
                <td className="py-2 pr-3 text-slate-500">—</td>
                <td className={`py-2 pr-3 font-semibold ${hasOverlay ? moneyTone(overlayUsdTotal) : 'text-slate-500'}`}>
                  {hasOverlay && Math.abs(overlayUsdTotal) > 0.005
                    ? fmtSignedK(overlayUsdTotal)
                    : '—'}
                </td>
                <td className="py-2 pr-3 text-slate-500" colSpan={4}>—</td>
                <td className="py-2 pr-3 font-semibold text-sky-300">
                  {Math.abs(result.bookNowUsdM) > 0.005
                    ? `${result.bookNowUsdM >= 0 ? '' : '−'}$${Math.abs(result.bookNowUsdM).toFixed(2)}M`
                    : '—'}
                </td>
                <td className="py-2 pr-3 text-slate-500">—</td>
                <td className={`py-2 pr-3 font-semibold ${moneyTone(book.swap / 1000)}`}>
                  {fmtSignedK(book.swap / 1000)}
                </td>
                <td className={`py-2 pr-3 font-semibold ${moneyTone(book.cip / 1000)}`}>
                  {fmtSignedK(book.cip / 1000)}
                </td>
                <td className={`py-2 font-semibold ${moneyTone(swapCarryK / 1000)}`}>
                  {fmtSignedK(swapCarryK / 1000)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </section>
  );
}
