'use client';

import { LineChart, type ChartMarker } from '@/components/LineChart';
import { POLICY_VAR_LIMITS, type PortfolioCarryFrontier, type PortfolioCarryFrontierPoint } from '@/lib/fx-buffer';
import {
  aroundSweetPoints,
  limitedUniverseWindow,
  nearestFrontierPoint,
  PORTFOLIO_SCENARIO_COLORS,
  portfolioScenarioDefs,
  type PortfolioScenarioId,
  unclampedRayChord,
} from '@/lib/test-mode/portfolio-carry-scenarios';

function fmtSignedK(usdM: number): string {
  const k = usdM * 1000;
  if (!Number.isFinite(k) || Math.abs(k) < 0.05) return '$0K';
  const dec = Math.abs(k) < 10 ? 1 : 0;
  const sign = k > 0 ? '+' : k < 0 ? '−' : '';
  return `${sign}$${Math.abs(k).toFixed(dec)}K`;
}

type PlotPick = {
  id: PortfolioScenarioId;
  overlayVarUsdM: number;
  bookCarryUsdYrM?: number;
  label: string;
};

export function PortfolioCarryVarFrontierPlot({
  frontier,
  policyVAR,
  confidencePct,
  selectedScenarioId,
  compact,
  picks,
  bookFront,
  onApplyScenario,
  onUseBalanced,
}: {
  frontier: PortfolioCarryFrontier;
  policyVAR: number;
  confidencePct: number;
  selectedScenarioId?: PortfolioScenarioId | null;
  compact?: boolean;
  picks?: readonly PlotPick[];
  /** Priced cash Δr vs overlay VAR — the front the Solutions cards are picked from. */
  bookFront?: readonly { x: number; y: number }[];
  onApplyScenario?: (id: PortfolioScenarioId, point: PortfolioCarryFrontierPoint) => void;
  onUseBalanced?: () => void;
}) {
  const pts = frontier.points;
  if (pts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 px-4 py-8 text-center text-[11px] text-slate-500">
        No overlay ray yet — need at least two FCY names with a Policy VAR cap.
      </div>
    );
  }
  const priced = (bookFront ?? []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  const usePriced = priced.length >= 2;
  const sweet = pts[frontier.sweetSpotIndex] ?? null;
  let today = pts[0]!;
  for (const p of pts) {
    if (Math.abs(p.portfolioVarUsd - policyVAR) < Math.abs(today.portfolioVarUsd - policyVAR)) today = p;
  }
  const scenarioDefs = picks && picks.length > 0
    ? picks.map(p => ({
        id: p.id,
        label: p.label,
        point: {
          k: p.overlayVarUsdM,
          portfolioVarUsd: p.overlayVarUsdM,
          totalCarryUsdYr: p.bookCarryUsdYrM
            ?? nearestFrontierPoint(pts, p.overlayVarUsdM)?.totalCarryUsdYr
            ?? 0,
          floorBoundCcys: [] as string[],
        },
        disabledHint: undefined as string | undefined,
      }))
    : portfolioScenarioDefs(frontier, confidencePct);
  const window = limitedUniverseWindow(pts, scenarioDefs);
  const around = !usePriced && sweet ? aroundSweetPoints(pts, sweet.portfolioVarUsd) : null;
  const chord = usePriced
    ? [
        { x: priced[0]!.x, y: priced[0]!.y },
        { x: priced[priced.length - 1]!.x, y: priced[priced.length - 1]!.y },
      ]
    : unclampedRayChord(pts);
  const markers: ChartMarker[] = [];
  for (const s of scenarioDefs) {
    if (!s.point) continue;
    const point = s.point;
    markers.push({
      x: point.portfolioVarUsd,
      y: point.totalCarryUsdYr,
      label: compact ? s.label.split(' ')[0] : s.label,
      color: PORTFOLIO_SCENARIO_COLORS[s.id] ?? '#94a3b8',
      ring: selectedScenarioId === s.id,
      onClick: onApplyScenario ? () => onApplyScenario(s.id, point) : undefined,
    });
  }
  if (!selectedScenarioId) {
    if (usePriced) {
      let live = priced[0]!;
      for (const p of priced) {
        if (Math.abs(p.x - policyVAR) < Math.abs(live.x - policyVAR)) live = p;
      }
      markers.push({ x: live.x, y: live.y, label: 'today', color: '#38bdf8', ring: true });
    } else {
      markers.push({ x: today.portfolioVarUsd, y: today.totalCarryUsdYr, label: 'today', color: '#38bdf8', ring: true });
    }
  }

  const series = [
    ...(chord
      ? [{
          name: usePriced ? 'linear scale' : 'unclamped ray',
          color: '#475569',
          width: 1.25,
          dashed: true,
          data: chord,
        }]
      : []),
    {
      name: usePriced ? 'priced strip' : 'universe',
      color: '#94a3b8',
      width: 1.75,
      data: usePriced ? [...priced] : pts.map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr })),
    },
    ...(around && around.length >= 2
      ? [{
          name: 'around sweet',
          color: '#f59e0b',
          width: 3,
          data: around,
        }]
      : []),
    ...(!usePriced && frontier.farPoints.length >= 2
      ? [{
          name: 'far (hedged)',
          color: '#fb7185',
          width: 1.75,
          data: frontier.farPoints.map(p => ({ x: p.portfolioVarUsd, y: p.totalCarryUsdYr })),
        }]
      : []),
  ];

  const clampPastSweep = frontier.nearestClampVarUsd != null
    && frontier.nearestClampVarUsd > POLICY_VAR_LIMITS[POLICY_VAR_LIMITS.length - 1]!.usd * 4;
  const balancedVar = scenarioDefs.find(s => s.id === 'balanced')?.point?.portfolioVarUsd
    ?? sweet?.portfolioVarUsd;

  return (
    <div className={`rounded-lg border border-slate-700 bg-slate-950/40 ${compact ? 'p-2' : 'p-3'}`}>
      <div className={`flex flex-wrap items-center gap-2 ${compact ? 'mb-1' : 'mb-2 gap-2.5'}`}>
        <span
          className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-amber-200/80"
          title={usePriced
            ? 'Solid = cash Δr of this strip at each overlay fill. Markers are the named Pareto books.'
            : frontier.sweetSpotIndex === -1
              ? (frontier.nearestClampVarUsd != null
                ? `Straight Σ⁻¹μ ray until ${frontier.nearestClampCcy} clamps at $${frontier.nearestClampVarUsd.toFixed(1)}M VaR${clampPastSweep ? ' — past this window.' : '.'}`
                : 'No sold name in this book has a Min floor or an expensive overdraft, so nothing clamps. Dashed line = the ray.')
              : 'Dashed = unclamped Σ⁻¹μ ray. Solid peels off when a PAY short hits its floor. Click a preset to assign that sweet.'}
        >
          {usePriced ? 'Pareto books' : 'Limited universe'}
        </span>
        {scenarioDefs.map(s => (
          <button
            key={s.id}
            type="button"
            disabled={!s.point || !onApplyScenario}
            onClick={() => { if (s.point) onApplyScenario?.(s.id, s.point); }}
            className={`inline-flex items-center gap-1 font-mono text-[9px] ${
              selectedScenarioId === s.id ? 'font-semibold text-amber-200' : 'text-slate-400'
            } ${s.point && onApplyScenario ? 'hover:text-slate-200' : 'cursor-default'}`}
            title={s.point
              ? `${s.label} — $${s.point.portfolioVarUsd.toFixed(1)}M VaR, ${fmtSignedK(s.point.totalCarryUsdYr)}/yr`
              : (s.disabledHint ?? 'not in this universe')}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: s.point ? PORTFOLIO_SCENARIO_COLORS[s.id] : '#475569' }}
            />
            {s.label}
            {selectedScenarioId === s.id && <span className="text-amber-300/80">sweet</span>}
            {!s.point && <span className="text-slate-600">(n/a)</span>}
          </button>
        ))}
      </div>
      {!compact && balancedVar != null && onUseBalanced && selectedScenarioId !== 'balanced' && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={onUseBalanced}
            className="shrink-0 rounded border border-amber-400/50 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] font-semibold text-amber-300 hover:bg-amber-500/20"
            title={`Assign the Balanced Pareto book: $${balancedVar.toFixed(2)}M VaR`}
          >
            use Balanced ${balancedVar.toFixed(1)}M
          </button>
        </div>
      )}
      <div className="rounded-md bg-slate-900/60 p-2 [&_text]:fill-slate-400 [&_line]:stroke-slate-800">
        <LineChart
          width={640}
          height={compact ? 148 : 220}
          xLabel="Overlay VAR ($M)"
          yLabel={compact ? '' : (usePriced ? 'Cash Δr ($M/yr)' : 'Carry ($M/yr)')}
          xDecimals={1}
          yDecimals={1}
          series={series}
          markers={markers}
          xDomain={window ? [window.xMin, window.xMax] : undefined}
          showLegend={false}
        />
      </div>
    </div>
  );
}
