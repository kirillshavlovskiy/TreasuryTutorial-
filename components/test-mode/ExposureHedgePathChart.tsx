'use client';

import { useMemo } from 'react';
import {
  HEDGE_PATH_BASIS_OPTIONS,
  buildExposurePathPoints,
  buildResidualPath,
  hedgeBasisNotionalLocalM,
  hedgeBreakevenMonths,
  inferHedgePathBasis,
  overhedgeGapM,
  residualPathVarUsdM,
  resolveChartMonthlyFlows,
  type HedgePathBasisId,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  buildRollingHedgeEdges,
  buildRollingHedgePathPoints,
  hedgeBreakevensForStrip,
  needsRollingHedges,
  rollingHedgeAtMonth,
  type RollingEdgeSizing,
  type RollingHedgeEdge,
} from '@/lib/test-mode/rolling-hedge';
import { horizonMonths, type VarSetup } from '@/lib/test-mode/var-setup';

interface ExposureHedgePathChartProps {
  ccy: string;
  stockM: number;
  monthlyFlowM: number;
  monthlyFlows?: readonly number[];
  setup: VarSetup;
  /** Applied Decision hedge notional (local M). */
  appliedHedgeLocalM: number;
  hedgeRatio: number;
  equalVarHedgeLocalM: number;
  /** Table Exposure @ Δ1 (may be stock-only) — chart uses path end for E_end. */
  endExposureM: number;
  selectedBasis: HedgePathBasisId;
  onSelectedBasisChange: (b: HedgePathBasisId) => void;
  onApplyBasis: (b: HedgePathBasisId) => void;
  /** Book M0 live + later scheduled edges (when Tf > Th). */
  onBookRollingStrip?: (edges: RollingHedgeEdge[]) => void;
  /** Disable book when a strip for this CCY is already on the book. */
  stripAlreadyBooked?: boolean;
}

function fmtM(v: number): string {
  const sign = v >= 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(2)}M`;
}

function fmtMonths(t: number): string {
  if (t + 1e-9 < 1) return `${Math.max(0, t * 4).toFixed(1)}w`;
  return `${t.toFixed(2)}m`;
}

function fmtVarK(usdM: number): string {
  return `$${(usdM * 1000).toFixed(0)}K`;
}

/** Catmull–Rom → cubic Bézier SVG path (smooth spline through all points). */
function smoothSplinePath(
  pts: readonly { x: number; y: number }[],
  tension = 1,
): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) {
    return `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  }
  if (pts.length === 2) {
    return `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)} L${pts[1]!.x.toFixed(1)},${pts[1]!.y.toFixed(1)}`;
  }
  let d = `M${pts[0]!.x.toFixed(1)},${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1]!;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Exposure growth path vs flat applied hedge — month grid, start/end labels,
 * over/under zones + breakeven.
 */
export function ExposureHedgePathChart({
  ccy,
  stockM,
  monthlyFlowM,
  monthlyFlows,
  setup,
  appliedHedgeLocalM,
  hedgeRatio,
  equalVarHedgeLocalM,
  selectedBasis,
  onSelectedBasisChange,
  onApplyBasis,
  onBookRollingStrip,
  stripAlreadyBooked = false,
}: ExposureHedgePathChartProps) {
  const Th = horizonMonths(setup.horizon);
  const rolling = needsRollingHedges(setup);

  const { flows, windowMonths, startM, endM: pathEndM } = useMemo(
    () => resolveChartMonthlyFlows(stockM, monthlyFlowM, setup, monthlyFlows),
    [stockM, monthlyFlowM, setup, monthlyFlows],
  );

  const path = useMemo(
    () => buildExposurePathPoints(startM, flows, windowMonths),
    [startM, flows, windowMonths],
  );

  const rollingSizing: RollingEdgeSizing =
    selectedBasis === 'cash'
      ? 'stockStart'
      : selectedBasis === 'totalExpected'
        ? 'windowEnd'
        : 'varNeutral';

  const rollingEdgesCash = useMemo(
    () =>
      rolling ? buildRollingHedgeEdges(startM, flows, setup, 'stockStart') : [],
    [rolling, startM, flows, setup],
  );
  const rollingEdgesVarNeutral = useMemo(
    () =>
      rolling ? buildRollingHedgeEdges(startM, flows, setup, 'varNeutral') : [],
    [rolling, startM, flows, setup],
  );
  const rollingEdgesTotal = useMemo(
    () =>
      rolling ? buildRollingHedgeEdges(startM, flows, setup, 'windowEnd') : [],
    [rolling, startM, flows, setup],
  );
  const rollingEdges =
    selectedBasis === 'cash'
      ? rollingEdgesCash
      : selectedBasis === 'totalExpected'
        ? rollingEdgesTotal
        : rollingEdgesVarNeutral;

  const showRollingStrip =
    rolling &&
    rollingEdges.length > 1 &&
    (selectedBasis === 'cash' ||
      selectedBasis === 'totalExpected' ||
      selectedBasis === 'varNeutral');

  const basisTarget = showRollingStrip
    ? rollingEdges[0]!.hedgeLocalM
    : hedgeBasisNotionalLocalM(
        selectedBasis,
        startM,
        pathEndM,
        equalVarHedgeLocalM,
      );

  const hedgeLevel =
    Math.abs(appliedHedgeLocalM) < 1e-12
      ? 0
      : Math.sign(pathEndM || startM || 1) * Math.abs(appliedHedgeLocalM);

  const stripBreakevens = useMemo(
    () =>
      showRollingStrip
        ? hedgeBreakevensForStrip(path, rollingEdges, rollingSizing)
        : [],
    [showRollingStrip, path, rollingEdges, rollingSizing],
  );

  const breakevenT = useMemo(() => {
    if (showRollingStrip) {
      return stripBreakevens[0]?.t ?? null;
    }
    return hedgeBreakevenMonths(path, hedgeLevel);
  }, [showRollingStrip, stripBreakevens, path, hedgeLevel]);

  const rollingHedgePts = useMemo(
    () => (showRollingStrip ? buildRollingHedgePathPoints(rollingEdges) : []),
    [showRollingStrip, rollingEdges],
  );

  const hasHedge = Math.abs(appliedHedgeLocalM) > 1e-9;

  const geom = useMemo(() => {
    const W = 640;
    const H = 260;
    const padL = 52;
    const padR = 72;
    const padT = 28;
    const padB = 36;
    const values = [
      ...path.map(p => p.exposureM),
      hedgeLevel,
      basisTarget,
      startM,
      pathEndM,
      ...rollingEdges.map(e => e.hedgeLocalM),
      ...rollingEdges.map(e => e.endExposureM),
    ];
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    const span0 = Math.max(0.5, dataMax - dataMin);
    const pad = span0 * 0.12;
    const minY = dataMin - pad;
    const maxY = dataMax + pad;
    const xScale = (t: number) =>
      padL + (windowMonths <= 0 ? 0 : (t / windowMonths) * (W - padL - padR));
    const yScale = (v: number) => {
      const span = maxY - minY || 1;
      return padT + (1 - (v - minY) / span) * (H - padT - padB);
    };
    const expLine = smoothSplinePath(
      path.map(p => ({ x: xScale(p.t), y: yScale(p.exposureM) })),
    );
    // Stepped rolling hedge polyline (horizontal + vertical joins)
    let rollLine = '';
    if (rollingHedgePts.length > 0) {
      rollLine = `M${xScale(rollingHedgePts[0]!.t).toFixed(1)},${yScale(rollingHedgePts[0]!.hedgeM).toFixed(1)}`;
      for (let i = 1; i < rollingHedgePts.length; i++) {
        const prev = rollingHedgePts[i - 1]!;
        const cur = rollingHedgePts[i]!;
        if (Math.abs(cur.hedgeM - prev.hedgeM) > 1e-9) {
          // vertical step at cur.t (after flat to prev)
          rollLine += ` L${xScale(cur.t).toFixed(1)},${yScale(prev.hedgeM).toFixed(1)}`;
        }
        rollLine += ` L${xScale(cur.t).toFixed(1)},${yScale(cur.hedgeM).toFixed(1)}`;
      }
    }

    const monthTicks: number[] = [];
    for (let m = 0; m <= Math.ceil(windowMonths); m++) {
      if (m <= windowMonths + 1e-9) monthTicks.push(m);
    }
    if (monthTicks[monthTicks.length - 1] !== windowMonths) {
      monthTicks.push(windowMonths);
    }

    const yTicks = 4;
    const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) =>
      minY + ((maxY - minY) * i) / yTicks,
    );

    return {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      minY,
      maxY,
      xScale,
      yScale,
      expLine,
      rollLine,
      monthTicks,
      yTickVals,
    };
  }, [
    path,
    windowMonths,
    hedgeLevel,
    basisTarget,
    startM,
    pathEndM,
    rollingEdges,
    rollingHedgePts,
  ]);

  const {
    W,
    H,
    padL,
    padR,
    padT,
    padB,
    xScale,
    yScale,
    expLine,
    rollLine,
    monthTicks,
    yTickVals,
  } = geom;

  const startGap = overhedgeGapM(startM, hedgeLevel);
  const endGap = overhedgeGapM(
    pathEndM,
    showRollingStrip
      ? rollingHedgeAtMonth(rollingEdges, windowMonths)
      : hedgeLevel,
  );

  const residualBasis = useMemo(() => {
    if (!hasHedge) return selectedBasis;
    const inferred = inferHedgePathBasis(
      hedgeLevel,
      startM,
      pathEndM,
      equalVarHedgeLocalM,
    );
    // Prefer the chip the user applied when it still matches H
    const chipN = hedgeBasisNotionalLocalM(
      selectedBasis,
      startM,
      pathEndM,
      equalVarHedgeLocalM,
    );
    return Math.abs(Math.abs(hedgeLevel) - Math.abs(chipN)) < 0.05
      ? selectedBasis
      : inferred;
  }, [
    hasHedge,
    hedgeLevel,
    startM,
    pathEndM,
    equalVarHedgeLocalM,
    selectedBasis,
  ]);

  const residual = useMemo(() => {
    if (showRollingStrip) {
      return buildResidualPath(path, rollingEdges[0]!.hedgeLocalM, {
        basis: selectedBasis,
        startM,
        endM: pathEndM,
        hedgeAt: t => rollingHedgeAtMonth(rollingEdges, t),
      });
    }
    if (!hasHedge) return [];
    return buildResidualPath(path, hedgeLevel, {
      basis: residualBasis,
      startM,
      endM: pathEndM,
    });
  }, [
    showRollingStrip,
    rollingEdges,
    selectedBasis,
    hasHedge,
    path,
    hedgeLevel,
    residualBasis,
    startM,
    pathEndM,
  ]);
  const budgetNetM = residual[0]?.budgetNetM ?? 0;

  const residualGeom = useMemo(() => {
    const W = 640;
    const H = 160;
    const padL = 52;
    const padR = 56;
    const padT = 22;
    const padB = 28;
    if (residual.length === 0) {
      return { W, H, padL, padR, padT, padB, absLine: '', cumLine: '', maxAbs: 1, maxCum: 1, xScale: () => padL, yAbs: () => padT, yCum: () => padT, monthTicks: [] as number[] };
    }
    const maxAbs = Math.max(0.2, ...residual.map(p => p.absResidualM)) * 1.1;
    const maxCum = Math.max(0.2, ...residual.map(p => p.cumPathFactor)) * 1.1;
    const xScale = (t: number) =>
      padL + (windowMonths <= 0 ? 0 : (t / windowMonths) * (W - padL - padR));
    const yAbs = (v: number) => padT + (1 - v / maxAbs) * (H - padT - padB);
    const yCum = (v: number) => padT + (1 - v / maxCum) * (H - padT - padB);
    const absLine = smoothSplinePath(
      residual.map(p => ({ x: xScale(p.t), y: yAbs(p.absResidualM) })),
    );
    const cumLine = smoothSplinePath(
      residual.map(p => ({ x: xScale(p.t), y: yCum(p.cumPathFactor) })),
    );
    const monthTicks: number[] = [];
    for (let m = 0; m <= Math.ceil(windowMonths); m++) {
      if (m <= windowMonths + 1e-9) monthTicks.push(m);
    }
    return { W, H, padL, padR, padT, padB, absLine, cumLine, maxAbs, maxCum, xScale, yAbs, yCum, monthTicks };
  }, [residual, windowMonths]);

  const peakAbsR = residual.reduce((m, p) => Math.max(m, p.absResidualM), 0);
  const totalPathFactor = residual[residual.length - 1]?.cumPathFactor ?? 0;
  const totalResVarUsdM = residualPathVarUsdM(
    totalPathFactor,
    ccy,
    setup.confidencePct,
  );
  const beIdx =
    breakevenT == null
      ? -1
      : residual.findIndex(p => p.t >= breakevenT - 1e-9);
  const cumAtBe =
    beIdx >= 0 ? residual[beIdx]!.cumPathFactor : null;
  const varAtBe =
    cumAtBe != null
      ? residualPathVarUsdM(cumAtBe, ccy, setup.confidencePct)
      : null;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
      <div className="mb-2 grid gap-2 sm:grid-cols-4">
        <div className="rounded border border-sky-700/40 bg-sky-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-sky-400/80">Start S (t=0)</div>
          <div className="font-mono text-sm font-semibold text-sky-200">{fmtM(startM)}</div>
        </div>
        <div className="rounded border border-sky-700/40 bg-sky-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-sky-400/80">
            End path (t={windowMonths}m)
          </div>
          <div className="font-mono text-sm font-semibold text-sky-200">
            {fmtM(pathEndM)}
          </div>
        </div>
        <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-emerald-400/80">
            Applied hedge ({Math.round(hedgeRatio * 100)}%)
          </div>
          <div className="font-mono text-sm font-semibold text-emerald-200">
            {hasHedge ? fmtM(appliedHedgeLocalM) : '—'}
          </div>
        </div>
        <div className="rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-amber-400/80">
            {showRollingStrip ? 'Breakevens' : 'Breakeven'}
          </div>
          <div className="font-mono text-sm font-semibold text-amber-200">
            {showRollingStrip
              ? stripBreakevens.length > 0
                ? `${stripBreakevens.length}× strip`
                : '—'
              : !hasHedge
                ? '—'
                : breakevenT != null
                  ? fmtMonths(breakevenT)
                  : startGap > 0
                    ? 'always over'
                    : 'always under'}
          </div>
          {showRollingStrip && stripBreakevens.length > 0 && (
            <div className="mt-0.5 text-[9px] text-amber-200/70">
              {stripBreakevens.map(b => fmtMonths(b.t)).join(' · ')}
            </div>
          )}
        </div>
      </div>

      {rolling && rollingEdgesVarNeutral.length > 1 && (
        <div className="mb-2 rounded-md border border-violet-700/40 bg-violet-950/30 px-2.5 py-2">
          <div className="mb-1 text-[10px] font-semibold text-violet-200">
            Rolling edges — VaR {Th}m &lt; forecast {setup.forecastMonths}m
            {showRollingStrip
              ? selectedBasis === 'cash'
                ? ' · Cash / stock (S@start)'
                : selectedBasis === 'totalExpected'
                  ? ' · Total (window-end)'
                  : ' · VaR-neutral (mid)'
              : ' · pick Cash / VaR-neutral / Total → rolling'}
          </div>
          <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
            One flat hedge cannot cover the full forecast. Select{' '}
            <span className="text-slate-200">Cash</span> (stock at each roll),{' '}
            <span className="text-slate-200">VaR-neutral strip</span> (mid), or{' '}
            <span className="text-slate-200">Total → rolling</span> (E@end). Path
            end {fmtM(pathEndM)}.
          </p>
          {showRollingStrip && (
            <>
              <div className="mb-2 overflow-x-auto">
                <table className="w-full min-w-[320px] text-left text-[10px]">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="py-1 pr-2 font-medium">Edge</th>
                      <th className="py-1 pr-2 font-medium">Stock @ start</th>
                      <th className="py-1 pr-2 font-medium">Hedge N</th>
                      <th className="py-1 font-medium">E @ end</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rollingEdges.map(e => (
                      <tr
                        key={e.index}
                        className="border-t border-slate-800/80 font-mono text-slate-300"
                      >
                        <td className="py-1 pr-2 text-violet-200">{e.label}</td>
                        <td className="py-1 pr-2">{fmtM(e.stockStartM)}</td>
                        <td className="py-1 pr-2 font-semibold text-emerald-300">
                          {fmtM(e.hedgeLocalM)}
                        </td>
                        <td className="py-1">{fmtM(e.endExposureM)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {onBookRollingStrip && (
                <button
                  type="button"
                  disabled={stripAlreadyBooked}
                  onClick={() => onBookRollingStrip(rollingEdges)}
                  className="rounded-md border border-violet-500/50 bg-violet-500/20 px-2.5 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    stripAlreadyBooked
                      ? 'Strip already on the book — cancel it to rebook'
                      : 'Book M0 forward now; later edges stay scheduled until roll date'
                  }
                >
                  {stripAlreadyBooked
                    ? 'Strip booked'
                    : `Book ${
                        selectedBasis === 'cash'
                          ? 'Cash/stock'
                          : selectedBasis === 'totalExpected'
                            ? 'Total'
                            : 'VaR-neutral'
                      } M0 + ${rollingEdges.length - 1} scheduled`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-slate-500">Apply hedge path</span>
        {HEDGE_PATH_BASIS_OPTIONS.map(opt => {
          const on = selectedBasis === opt.id;
          const stripEdges =
            opt.id === 'cash'
              ? rollingEdgesCash
              : opt.id === 'totalExpected'
                ? rollingEdgesTotal
                : opt.id === 'varNeutral'
                  ? rollingEdgesVarNeutral
                  : [];
          const useStrip = rolling && stripEdges.length > 1;
          const n = useStrip
            ? stripEdges[0]!.hedgeLocalM
            : hedgeBasisNotionalLocalM(
                opt.id,
                startM,
                pathEndM,
                equalVarHedgeLocalM,
              );
          return (
            <button
              key={opt.id}
              type="button"
              title={
                useStrip
                  ? `${opt.description} → first edge ${fmtM(n)}; full strip in table above`
                  : `${opt.description} → set Hedge N = ${fmtM(n)}`
              }
              disabled={Math.abs(equalVarHedgeLocalM) < 1e-9 && Math.abs(startM) < 1e-9}
              onClick={() => {
                onSelectedBasisChange(opt.id);
                onApplyBasis(opt.id);
              }}
              aria-pressed={on}
              className={`rounded-md border px-2.5 py-1.5 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                on
                  ? 'border-violet-400 bg-violet-500/25 text-violet-50 ring-2 ring-violet-400/80 shadow-[0_0_0_1px_rgba(167,139,250,0.45)]'
                  : 'border-slate-700 text-slate-300 hover:border-violet-600/50 hover:bg-violet-500/10'
              }`}
            >
              {opt.id === 'cash'
                ? useStrip
                  ? 'Cash (stock) → rolling'
                  : 'Cash (stock)'
                : opt.id === 'varNeutral'
                  ? useStrip
                    ? 'VaR-neutral → strip'
                    : 'VaR-neutral'
                  : useStrip
                    ? 'Target (Total) → rolling'
                    : 'Target (Total)'}
              {on ? (
                <span className="ml-1 rounded bg-violet-400/30 px-1 text-[9px] uppercase tracking-wide">
                  on
                </span>
              ) : null}
              <span className="ml-1 font-mono font-normal opacity-90">{fmtM(n)}</span>
            </button>
          );
        })}
      </div>

      <p className="mb-1.5 text-[10px] text-slate-500">
        Blue = expected exposure e(t) over {windowMonths}m
        {Th !== windowMonths ? ` (VaR horizon ${Th}m)` : ''}. Purple dashed =
        selected regime / strip. Green = applied Decision hedge. Amber band =
        overhedged (|H| &gt; |e|).
      </p>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full max-w-full rounded border border-slate-800 bg-slate-950"
        role="img"
        aria-label={`${ccy} exposure path versus hedge`}
      >
        {/* Month grid */}
        {monthTicks.map(m => (
          <g key={`mx-${m}`}>
            <line
              x1={xScale(m)}
              x2={xScale(m)}
              y1={padT}
              y2={H - padB}
              stroke={m === 0 || Math.abs(m - windowMonths) < 1e-9 ? '#475569' : '#1e293b'}
              strokeWidth={m === 0 || Math.abs(m - windowMonths) < 1e-9 ? 1.25 : 1}
            />
            <text
              x={xScale(m)}
              y={H - 10}
              textAnchor="middle"
              fill="#94a3b8"
              fontSize={10}
            >
              {Number.isInteger(m) ? `M${m}` : `${m.toFixed(1)}m`}
            </text>
          </g>
        ))}

        {/* Y grid */}
        {yTickVals.map((v, i) => (
          <g key={`my-${i}`}>
            <line
              x1={padL}
              x2={W - padR}
              y1={yScale(v)}
              y2={yScale(v)}
              stroke="#1e293b"
              strokeWidth={1}
            />
            <text
              x={padL - 6}
              y={yScale(v) + 3}
              textAnchor="end"
              fill="#94a3b8"
              fontSize={9}
            >
              {v.toFixed(1)}
            </text>
          </g>
        ))}

        {/* Overhedge band */}
        {hasHedge &&
          path.slice(0, -1).map((p, i) => {
            const n = path[i + 1]!;
            const over0 = Math.abs(hedgeLevel) > Math.abs(p.exposureM) + 1e-9;
            const over1 = Math.abs(hedgeLevel) > Math.abs(n.exposureM) + 1e-9;
            if (!over0 && !over1) return null;
            return (
              <polygon
                key={i}
                points={`${xScale(p.t)},${yScale(p.exposureM)} ${xScale(n.t)},${yScale(n.exposureM)} ${xScale(n.t)},${yScale(hedgeLevel)} ${xScale(p.t)},${yScale(hedgeLevel)}`}
                fill="rgba(245, 158, 11, 0.14)"
                stroke="none"
              />
            );
          })}

        {/* Rolling strip (Tf > Th): stepped VaR-window hedges */}
        {showRollingStrip && rollLine && (
          <>
            <path
              d={rollLine}
              fill="none"
              stroke="#a78bfa"
              strokeWidth={2}
              strokeDasharray="6 3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {rollingEdges.map(e => (
              <text
                key={`rl-${e.index}`}
                x={xScale((e.startMonth + e.endMonth) / 2)}
                y={yScale(e.hedgeLocalM) - 6}
                textAnchor="middle"
                fill="#c4b5fd"
                fontSize={9}
                fontWeight={600}
              >
                {e.label} {fmtM(e.hedgeLocalM)}
              </text>
            ))}
          </>
        )}

        {/* Purple dashed = selected regime target (flat) */}
        {!showRollingStrip && Math.abs(basisTarget) > 1e-9 && (
          <>
            <line
              x1={padL}
              x2={W - padR}
              y1={yScale(basisTarget)}
              y2={yScale(basisTarget)}
              stroke="#a78bfa"
              strokeWidth={2}
              strokeDasharray="6 3"
              strokeLinecap="round"
            />
            {Math.abs(basisTarget - hedgeLevel) > 0.05 && (
              <text
                x={W - padR - 4}
                y={yScale(basisTarget) - 4}
                textAnchor="end"
                fill="#c4b5fd"
                fontSize={10}
                fontWeight={600}
              >
                Target {fmtM(basisTarget)}
              </text>
            )}
          </>
        )}

        {/* Green = applied Decision hedge — always when set (incl. after regime switch) */}
        {hasHedge && !showRollingStrip && (
          <>
            <line
              x1={padL}
              x2={W - padR}
              y1={yScale(hedgeLevel)}
              y2={yScale(hedgeLevel)}
              stroke="#34d399"
              strokeWidth={2.25}
            />
            <text
              x={W - padR - 4}
              y={
                yScale(hedgeLevel) +
                (Math.abs(basisTarget - hedgeLevel) > 0.05 ? 12 : -4)
              }
              textAnchor="end"
              fill="#6ee7b7"
              fontSize={10}
              fontWeight={600}
            >
              Hedge {fmtM(hedgeLevel)}
            </text>
          </>
        )}
        {hasHedge && showRollingStrip && (
          <>
            <line
              x1={padL}
              x2={xScale(rollingEdges[0]?.endMonth ?? Th)}
              y1={yScale(hedgeLevel)}
              y2={yScale(hedgeLevel)}
              stroke="#34d399"
              strokeWidth={2.25}
            />
            <text
              x={W - padR - 4}
              y={yScale(hedgeLevel) - 4}
              textAnchor="end"
              fill="#6ee7b7"
              fontSize={10}
              fontWeight={600}
            >
              Hedge @M0 {fmtM(hedgeLevel)}
            </text>
          </>
        )}

        {/* Exposure path */}
        <path
          d={expLine}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Start / end markers */}
        <circle cx={xScale(0)} cy={yScale(startM)} r={5} fill="#38bdf8" />
        <text
          x={xScale(0) + 8}
          y={yScale(startM) - 8}
          fill="#7dd3fc"
          fontSize={10}
          fontWeight={600}
        >
          S {fmtM(startM)}
        </text>
        <circle
          cx={xScale(windowMonths)}
          cy={yScale(pathEndM)}
          r={5}
          fill="#38bdf8"
        />
        <text
          x={xScale(windowMonths) - 8}
          y={yScale(pathEndM) - 8}
          textAnchor="end"
          fill="#7dd3fc"
          fontSize={10}
          fontWeight={600}
        >
          E {fmtM(pathEndM)}
        </text>

        {/* Breakeven(s) — one per strip edge, or single flat BE */}
        {showRollingStrip
          ? stripBreakevens.map(be => (
              <g key={`be-${be.edgeIndex}`}>
                <line
                  x1={xScale(be.t)}
                  x2={xScale(be.t)}
                  y1={padT}
                  y2={H - padB}
                  stroke="#fbbf24"
                  strokeWidth={1.25}
                  strokeDasharray="4 3"
                />
                <circle
                  cx={xScale(be.t)}
                  cy={yScale(rollingHedgeAtMonth(rollingEdges, be.t))}
                  r={4}
                  fill="#fbbf24"
                  stroke="#0f172a"
                  strokeWidth={1}
                />
                <text
                  x={xScale(be.t)}
                  y={padT - 6}
                  textAnchor="middle"
                  fill="#fcd34d"
                  fontSize={8}
                  fontWeight={600}
                >
                  BE {be.label}
                </text>
              </g>
            ))
          : breakevenT != null &&
            hasHedge && (
              <>
                <line
                  x1={xScale(breakevenT)}
                  x2={xScale(breakevenT)}
                  y1={padT}
                  y2={H - padB}
                  stroke="#fbbf24"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
                <circle
                  cx={xScale(breakevenT)}
                  cy={yScale(hedgeLevel)}
                  r={5}
                  fill="#fbbf24"
                  stroke="#0f172a"
                  strokeWidth={1}
                />
                <text
                  x={xScale(breakevenT)}
                  y={padT - 6}
                  textAnchor="middle"
                  fill="#fcd34d"
                  fontSize={10}
                  fontWeight={600}
                >
                  BE {fmtMonths(breakevenT)}
                </text>
              </>
            )}

        <text
          x={(padL + W - padR) / 2}
          y={H - 2}
          textAnchor="middle"
          fill="#64748b"
          fontSize={9}
        >
          months
        </text>
      </svg>

      <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 bg-sky-400" /> Exposure e(t)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 border-t-2 border-dashed border-violet-400" />{' '}
          {showRollingStrip ? 'Rolling strip' : 'Selected target'}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 bg-emerald-400" /> Applied hedge
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-500/40" /> Overhedged
        </span>
        {hasHedge && (
          <span className="ml-auto tabular-nums text-slate-400">
            t=0: {startGap > 1e-9 ? 'over' : startGap < -1e-9 ? 'under' : 'on'}{' '}
            {fmtM(Math.abs(startGap))} · t={windowMonths}m:{' '}
            {endGap > 1e-9 ? 'over' : endGap < -1e-9 ? 'under' : 'on'}{' '}
            {fmtM(Math.abs(endGap))}
          </span>
        )}
      </div>

      {hasHedge && residual.length > 0 && (
        <div className="mt-4 border-t border-slate-800 pt-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            What the bottom chart shows
          </div>
          <div className="mb-3 space-y-1.5 text-[11px] leading-relaxed text-slate-400">
            <p>
              A <span className="text-slate-200">flat hedge</span> is a constant
              notional offset vs growing e(t). Residual risk accrues from{' '}
              <span className="text-slate-200">t=0</span> as{' '}
              <span className="text-orange-300">√∫(e−H)²</span> — when |e−H| is
              roughly constant that tracks <span className="text-slate-200">|r|√t</span>
              , so orange cannot stay flat in month 1.
            </p>
            <p>
              <span className="font-semibold text-rose-300">Rose — |e−H|</span>
              : mismatch path (U-shaped for VaR-neutral: over → BE → under; Total
              falls to ~0 at maturity).
            </p>
            <p>
              <span className="font-semibold text-orange-300">Orange — √∫r²</span>
              : path residual factor from t=0 (over- and under-hedge). End |e−H|
              can be ~0 for Cash/Total while path residual VaR is still &gt; 0.
            </p>
          </div>
          <div className="mb-2 grid gap-2 sm:grid-cols-3">
            <div className="rounded border border-rose-700/40 bg-rose-950/25 px-2 py-1.5">
              <div className="text-[9px] uppercase text-rose-400/80">
                Peak |e−H|
              </div>
              <div className="font-mono text-sm font-semibold text-rose-200">
                {fmtM(peakAbsR)}
              </div>
            </div>
            <div className="rounded border border-orange-700/40 bg-orange-950/25 px-2 py-1.5">
              <div className="text-[9px] uppercase text-orange-400/80">
                Residual VaR @ end
              </div>
              <div className="font-mono text-sm font-semibold text-orange-200">
                {fmtVarK(totalResVarUsdM)}
              </div>
              <div className="mt-0.5 text-[9px] text-orange-200/60">
                path √∫r² · end gap {fmtM(budgetNetM)}
              </div>
            </div>
            <div className="rounded border border-amber-700/40 bg-amber-950/25 px-2 py-1.5">
              <div className="text-[9px] uppercase text-amber-400/80">
                Residual VaR @ BE
              </div>
              <div className="font-mono text-sm font-semibold text-amber-200">
                {varAtBe != null ? fmtVarK(varAtBe) : '—'}
              </div>
              <div className="mt-0.5 text-[9px] text-amber-200/60">
                accrued from t=0 to BE
              </div>
            </div>
          </div>
          <svg
            viewBox={`0 0 ${residualGeom.W} ${residualGeom.H}`}
            className="h-auto w-full max-w-full rounded border border-slate-800 bg-slate-950"
            role="img"
            aria-label={`${ccy} residual mismatch path`}
          >
            {residualGeom.monthTicks.map(m => (
              <line
                key={`rm-${m}`}
                x1={residualGeom.xScale(m)}
                x2={residualGeom.xScale(m)}
                y1={residualGeom.padT}
                y2={residualGeom.H - residualGeom.padB}
                stroke="#1e293b"
              />
            ))}
            <path
              d={residualGeom.absLine}
              fill="none"
              stroke="#fb7185"
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={residualGeom.cumLine}
              fill="none"
              stroke="#fb923c"
              strokeWidth={2}
              strokeDasharray="5 3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {showRollingStrip
              ? stripBreakevens.map(be => (
                  <line
                    key={`rbe-${be.edgeIndex}`}
                    x1={residualGeom.xScale(be.t)}
                    x2={residualGeom.xScale(be.t)}
                    y1={residualGeom.padT}
                    y2={residualGeom.H - residualGeom.padB}
                    stroke="#fbbf24"
                    strokeDasharray="3 2"
                  />
                ))
              : breakevenT != null && (
                  <line
                    x1={residualGeom.xScale(breakevenT)}
                    x2={residualGeom.xScale(breakevenT)}
                    y1={residualGeom.padT}
                    y2={residualGeom.H - residualGeom.padB}
                    stroke="#fbbf24"
                    strokeDasharray="3 2"
                  />
                )}
            <text
              x={residualGeom.padL}
              y={12}
              fill="#fb7185"
              fontSize={9}
            >
              |e−H| (→ {residualGeom.maxAbs.toFixed(1)})
            </text>
            <text
              x={residualGeom.W - residualGeom.padR}
              y={12}
              textAnchor="end"
              fill="#fb923c"
              fontSize={9}
            >
              √∫(e−H)² (→ {residualGeom.maxCum.toFixed(1)})
            </text>
            {residualGeom.monthTicks
              .filter(m => Number.isInteger(m))
              .map(m => (
                <text
                  key={`rl-${m}`}
                  x={residualGeom.xScale(m)}
                  y={residualGeom.H - 8}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize={9}
                >
                  M{m}
                </text>
              ))}
          </svg>
        </div>
      )}
    </div>
  );
}
