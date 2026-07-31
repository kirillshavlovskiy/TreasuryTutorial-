'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HEDGE_PATH_BASIS_OPTIONS,
  buildExposurePathPoints,
  hedgeBasisNotionalLocalM,
  hedgeBreakevenMonths,
  overhedgeGapM,
  resolveChartMonthlyFlows,
  type HedgePathBasisId,
} from '@/lib/test-mode/exposure-hedge-path';
import {
  buildStripHedgedVarProfile,
  equalVarLinearHedgeNotionalLocalM,
} from '@/lib/test-mode/hedge-var';
import {
  buildRollingHedgeEdges,
  stripForwardLegsFromEdges,
  needsRollingHedges,
  varSetupForPathHedgeRegime,
  type ForecastHedgeStructure,
  type RollingHedgeEdge,
  type StripForwardLeg,
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
  /**
   * Apply Cash / VN / Target. Pass the chart's structure so strip booking does
   * not race parent's hedgeStructure state (stale 'bullet' → Cash % only).
   */
  onApplyBasis: (
    b: HedgePathBasisId,
    structure?: ForecastHedgeStructure,
  ) => void;
  /** Book staggered strip from M0 (when Tf > Th and structure=strip). */
  onBookRollingStrip?: (edges: RollingHedgeEdge[]) => void;
  /** Disable book when a strip for this CCY is already on the book. */
  stripAlreadyBooked?: boolean;
  /** bullet = one Tf forward; strip = rolling Th windows (enabled when Tf &gt; Th). */
  hedgeStructure?: ForecastHedgeStructure;
  onHedgeStructureChange?: (s: ForecastHedgeStructure) => void;
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
  hedgeStructure: hedgeStructureProp,
  onHedgeStructureChange,
}: ExposureHedgePathChartProps) {
  const [localStructure, setLocalStructure] =
    useState<ForecastHedgeStructure>('bullet');
  /** Manual strip leg count (min 2 when strip). null = default ceil(Tf/Th). */
  const [stripLegCount, setStripLegCount] = useState<number | null>(null);
  /** Which forward legs contribute to the resid VaR profile (checkbox). */
  const [enabledLegIds, setEnabledLegIds] = useState<Record<number, boolean>>(
    {},
  );
  const controlled = hedgeStructureProp != null;
  const hedgeStructure = controlled ? hedgeStructureProp : localStructure;
  useEffect(() => {
    if (controlled) setLocalStructure(hedgeStructureProp);
  }, [controlled, hedgeStructureProp]);
  const setStructure = (s: ForecastHedgeStructure) => {
    if (!controlled) setLocalStructure(s);
    onHedgeStructureChange?.(s);
  };
  const Th = horizonMonths(setup.horizon);
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  const rollingAvailable = needsRollingHedges(setup);
  const showStructurePicker = Tf > 0;
  const effectiveStructure: ForecastHedgeStructure =
    hedgeStructure === 'strip' && rollingAvailable ? 'strip' : 'bullet';
  useEffect(() => {
    if (!rollingAvailable && hedgeStructure === 'strip') {
      if (!controlled) setLocalStructure('bullet');
      onHedgeStructureChange?.('bullet');
    }
  }, [
    rollingAvailable,
    hedgeStructure,
    controlled,
    onHedgeStructureChange,
  ]);
  const rolling = effectiveStructure === 'strip';
  /** When switching strip → bullet, drop Target default so residual P&L uses VN. */
  const prevStructureRef = useRef(effectiveStructure);
  useEffect(() => {
    const prev = prevStructureRef.current;
    prevStructureRef.current = effectiveStructure;
    if (prev === 'strip' && effectiveStructure === 'bullet') {
      onSelectedBasisChange('varNeutral');
    }
  }, [effectiveStructure, onSelectedBasisChange]);
  /** Bullet Th=Tf; stock profile → path totalBuildup so VN ≠ Cash. */
  const sizingSetup = useMemo(
    () => varSetupForPathHedgeRegime(setup, effectiveStructure),
    [setup, effectiveStructure],
  );

  const { flows, windowMonths, startM, endM: pathEndM } = useMemo(
    () => resolveChartMonthlyFlows(stockM, monthlyFlowM, setup, monthlyFlows),
    [stockM, monthlyFlowM, setup, monthlyFlows],
  );

  const path = useMemo(
    () => buildExposurePathPoints(startM, flows, windowMonths),
    [startM, flows, windowMonths],
  );

  /**
   * Equal-VaR for chips / flat hedge line. Bullet forces Th=Tf so this matches
   * the Th=forecast case exactly (ignore stale Analytics-Th prop).
   */
  const matchedEqualVarLocalM = useMemo(() => {
    if (rolling) return equalVarHedgeLocalM;
    return equalVarLinearHedgeNotionalLocalM(
      stockM,
      monthlyFlowM,
      ccy,
      sizingSetup,
      undefined,
      flows,
    ).amountLocalM;
  }, [
    rolling,
    equalVarHedgeLocalM,
    stockM,
    monthlyFlowM,
    ccy,
    sizingSetup,
    flows,
  ]);

  const defaultStripLegs = useMemo(() => {
    if (!(Tf > 0) || !(Th > 0)) return 2;
    return Math.max(2, Math.ceil(Tf / Th - 1e-12));
  }, [Tf, Th]);
  const maxStripLegs = useMemo(
    () => Math.max(2, Math.min(24, Math.ceil(Tf) || 2)),
    [Tf],
  );
  const effectiveStripLegs = Math.min(
    maxStripLegs,
    Math.max(2, stripLegCount ?? defaultStripLegs),
  );
  const stripEdgeOpts = useMemo(
    () => (rolling ? { legCount: effectiveStripLegs } : undefined),
    [rolling, effectiveStripLegs],
  );

  const rollingEdgesCash = useMemo(
    () =>
      rolling
        ? buildRollingHedgeEdges(startM, flows, setup, 'stockStart', stripEdgeOpts)
        : [],
    [rolling, startM, flows, setup, stripEdgeOpts],
  );
  const rollingEdgesVarNeutral = useMemo(
    () =>
      rolling
        ? buildRollingHedgeEdges(
            startM,
            flows,
            setup,
            'varNeutral',
            stripEdgeOpts,
          )
        : [],
    [rolling, startM, flows, setup, stripEdgeOpts],
  );
  const rollingEdgesTotal = useMemo(
    () =>
      rolling
        ? buildRollingHedgeEdges(startM, flows, setup, 'windowEnd', stripEdgeOpts)
        : [],
    [rolling, startM, flows, setup, stripEdgeOpts],
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

  /**
   * Forwards for the VaR-over-time panel:
   * - Strip → incremental M0 legs (all live from day 0)
   * - Bullet → one M0–Tf forward (same instantaneous cover model)
   */
  const hedgeLegs = useMemo((): StripForwardLeg[] => {
    if (showRollingStrip) return stripForwardLegsFromEdges(rollingEdges);
    if (!(Tf > 0)) return [];
    const amount = hedgeBasisNotionalLocalM(
      selectedBasis,
      startM,
      pathEndM,
      matchedEqualVarLocalM,
    );
    if (Math.abs(amount) < 1e-12) return [];
    return [
      {
        index: 0,
        label: `M0–M${Math.round(Tf)}`,
        tenureMonths: Tf,
        amountLocalM: amount,
        cumulCoverLocalM: amount,
        endExposureM: pathEndM,
        stockStartM: startM,
      },
    ];
  }, [
    showRollingStrip,
    rollingEdges,
    Tf,
    selectedBasis,
    startM,
    pathEndM,
    matchedEqualVarLocalM,
  ]);

  /** Σ all strip legs (full program). */
  const stripTotalCoverM = showRollingStrip
    ? hedgeLegs.reduce((s, l) => s + l.amountLocalM, 0)
    : 0;

  const showHedgePerf = hedgeLegs.length > 0 && Tf > 0;

  // Keep checkbox map in sync when legs change (default: all on).
  useEffect(() => {
    setEnabledLegIds(prev => {
      const next: Record<number, boolean> = {};
      let changed = false;
      for (const l of hedgeLegs) {
        const on = prev[l.index] !== false;
        next[l.index] = on;
        if (prev[l.index] === undefined) changed = true;
      }
      for (const k of Object.keys(prev)) {
        if (!(Number(k) in next)) changed = true;
      }
      return changed || Object.keys(prev).length !== Object.keys(next).length
        ? next
        : prev;
    });
  }, [hedgeLegs]);

  const activeHedgeLegs = useMemo(
    () => hedgeLegs.filter(l => enabledLegIds[l.index] !== false),
    [hedgeLegs, enabledLegIds],
  );

  /**
   * Resid VaR profile from checked trades.
   * Window = chart horizon (max(Th,Tf)) so when Tf is short, post-forecast
   * VN residual (|E_end−H_VN| flat, V(t) still growing) stays on the track.
   */
  const hedgedVarProfile = useMemo(() => {
    if (!showHedgePerf) return [];
    const Eref = Math.abs(pathEndM);
    const through = Math.max(Tf, windowMonths);
    if (activeHedgeLegs.length === 0) {
      // No trades on → remaining = full open VaR.
      const bare = buildStripHedgedVarProfile(
        startM,
        monthlyFlowM,
        ccy,
        setup,
        [
          {
            amountLocalM: Eref > 1e-12 ? Eref : 1,
            tenureMonths: Tf,
            recognizeFromMonths: 0,
          },
        ],
        flows,
        1,
        Eref > 1e-12 ? Eref : undefined,
        through,
      );
      return bare.map(p => ({
        ...p,
        hedgedVarUsdM: p.openVarUsdM,
        cumulCoverLocalM: 0,
        residualCoverLocalM: Math.abs(p.exposureLocalM),
      }));
    }
    // Flat Σ ticked fractions from M0 (same as VaR Evolution) — after Tf,
    // e stays at E_end and resid VaR = V(t)·|E_end−H|/|E_end| keeps evolving.
    return buildStripHedgedVarProfile(
      startM,
      monthlyFlowM,
      ccy,
      setup,
      activeHedgeLegs.map(l => ({
        amountLocalM: l.amountLocalM,
        tenureMonths: l.tenureMonths,
        recognizeFromMonths: 0,
      })),
      flows,
      1,
      Eref > 1e-12 ? Eref : undefined,
      through,
    );
  }, [
    showHedgePerf,
    activeHedgeLegs,
    startM,
    monthlyFlowM,
    ccy,
    setup,
    flows,
    pathEndM,
    Tf,
    windowMonths,
  ]);

  /** Full-program resid VaR (all legs on) — locks VaR chart Y scale vs checkboxes. */
  const hedgedVarProfileFull = useMemo(() => {
    if (!showHedgePerf || hedgeLegs.length === 0) return [];
    const Eref = Math.abs(pathEndM);
    const through = Math.max(Tf, windowMonths);
    return buildStripHedgedVarProfile(
      startM,
      monthlyFlowM,
      ccy,
      setup,
      hedgeLegs.map(l => ({
        amountLocalM: l.amountLocalM,
        tenureMonths: l.tenureMonths,
        recognizeFromMonths: 0,
      })),
      flows,
      1,
      Eref > 1e-12 ? Eref : undefined,
      through,
    );
  }, [
    showHedgePerf,
    hedgeLegs,
    pathEndM,
    Tf,
    windowMonths,
    startM,
    monthlyFlowM,
    ccy,
    setup,
    flows,
  ]);

  const hedgedVarProfileGeom = useMemo(() => {
    const W = 640;
    const H = 160;
    const padL = 48;
    const padR = 56;
    const padT = 22;
    const padB = 34;
    if (hedgedVarProfile.length === 0) {
      return {
        W,
        H,
        padL,
        padR,
        padT,
        padB,
        openLine: '',
        residLine: '',
        reductionArea: '',
        maxVar: 1,
        endResidVarUsdM: 0,
        xScale: (_t: number) => padL,
        yScale: (_v: number) => padT,
        monthTicks: [] as number[],
        legMarks: [] as { t: number; hedgedVarUsdM: number; label: string }[],
      };
    }
    const TfChart = hedgedVarProfile[hedgedVarProfile.length - 1]!.t;
    const endResidVarUsdM =
      hedgedVarProfile[hedgedVarProfile.length - 1]!.hedgedVarUsdM;
    // Y max from open VaR + full-program resid (not the ticked subset).
    const scaleSrc =
      hedgedVarProfileFull.length > 0 ? hedgedVarProfileFull : hedgedVarProfile;
    const maxVar =
      Math.max(
        0.01,
        ...scaleSrc.map(p => Math.max(p.openVarUsdM, p.hedgedVarUsdM)),
        ...hedgedVarProfile.map(p => Math.max(p.openVarUsdM, p.hedgedVarUsdM)),
      ) * 1.12;
    const xScale = (t: number) =>
      padL + (TfChart <= 0 ? 0 : (t / TfChart) * (W - padL - padR));
    const yScale = (v: number) =>
      padT + (1 - v / maxVar) * (H - padT - padB);
    // Dashed slate = open VaR; yellow = resid; green fill = reduction band.
    const openPts = hedgedVarProfile.map(p => ({
      x: xScale(p.t),
      y: yScale(p.openVarUsdM),
    }));
    const residPts = hedgedVarProfile.map(p => ({
      x: xScale(p.t),
      y: yScale(p.hedgedVarUsdM),
    }));
    const openLine = smoothSplinePath(openPts);
    const residLine = smoothSplinePath(residPts);
    const residBack = smoothSplinePath([...residPts].reverse()).replace(
      /^M/,
      'L',
    );
    const reductionArea =
      openLine && residBack ? `${openLine} ${residBack} Z` : '';
    const monthTicks: number[] = [];
    for (let m = 0; m <= Math.ceil(TfChart); m++) {
      if (m <= TfChart + 1e-9) monthTicks.push(m);
    }
    if (
      monthTicks.length === 0 ||
      Math.abs(monthTicks[monthTicks.length - 1]! - TfChart) > 1e-9
    ) {
      monthTicks.push(TfChart);
    }
    const legMarks = activeHedgeLegs.map(leg => {
      const pt =
        hedgedVarProfile.find(p => Math.abs(p.t - leg.tenureMonths) < 1e-6) ??
        hedgedVarProfile.reduce((best, p) =>
          Math.abs(p.t - leg.tenureMonths) < Math.abs(best.t - leg.tenureMonths)
            ? p
            : best,
        );
      return {
        t: leg.tenureMonths,
        hedgedVarUsdM: pt.hedgedVarUsdM,
        label: leg.label,
      };
    });
    return {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      openLine,
      residLine,
      reductionArea,
      maxVar,
      endResidVarUsdM,
      xScale,
      yScale,
      monthTicks,
      legMarks,
    };
  }, [hedgedVarProfile, hedgedVarProfileFull, activeHedgeLegs]);

  const resetStripToDefault = () => {
    setStripLegCount(null);
    setEnabledLegIds({});
  };

  /** Detail rows under the chart: each FWD (checkbox) + Tf. */
  const hedgePerfRows = useMemo(() => {
    if (hedgeLegs.length === 0) return [];
    type Row = {
      key: string;
      label: string;
      kind: 'leg' | 'end';
      legIndex: number | null;
      hedgeDeltaM: number | null;
      cumulCoverLocalM: number;
      endExposureM: number | null;
      residualLocalM: number;
      openVarUsdM: number;
      hedgedVarUsdM: number;
      enabled: boolean;
    };
    const at = (t: number) =>
      hedgedVarProfile.find(p => Math.abs(p.t - t) < 1e-6) ??
      (hedgedVarProfile.length
        ? hedgedVarProfile.reduce((best, p) =>
            Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best,
          )
        : null);
    const rows: Row[] = [];
    for (const leg of hedgeLegs) {
      const p = at(leg.tenureMonths);
      const enabled = enabledLegIds[leg.index] !== false;
      rows.push({
        key: `leg-${leg.index}`,
        label: leg.label,
        kind: 'leg',
        legIndex: leg.index,
        hedgeDeltaM: leg.amountLocalM,
        cumulCoverLocalM: enabled
          ? (p?.cumulCoverLocalM ?? leg.cumulCoverLocalM)
          : 0,
        endExposureM: p?.exposureLocalM ?? leg.endExposureM,
        residualLocalM: p?.residualCoverLocalM ?? 0,
        openVarUsdM: p?.openVarUsdM ?? 0,
        hedgedVarUsdM: p?.hedgedVarUsdM ?? 0,
        enabled,
      });
    }
    const endT = hedgedVarProfile[hedgedVarProfile.length - 1]?.t;
    if (
      endT != null &&
      !hedgeLegs.some(l => Math.abs(l.tenureMonths - endT) < 1e-6)
    ) {
      const pEnd = at(endT);
      rows.push({
        key: 'tf',
        label: `M${Math.round(endT)}`,
        kind: 'end',
        legIndex: null,
        hedgeDeltaM: null,
        cumulCoverLocalM: pEnd?.cumulCoverLocalM ?? 0,
        endExposureM: pEnd?.exposureLocalM ?? pathEndM,
        residualLocalM: pEnd?.residualCoverLocalM ?? 0,
        openVarUsdM: pEnd?.openVarUsdM ?? 0,
        hedgedVarUsdM: pEnd?.hedgedVarUsdM ?? 0,
        enabled: true,
      });
    }
    return rows;
  }, [hedgeLegs, hedgedVarProfile, pathEndM, enabledLegIds]);

  /** Cover from ticked legs only (unticked legs excluded from green H & resid). */
  const activeStripCoverM = showRollingStrip
    ? activeHedgeLegs.reduce((s, l) => s + l.amountLocalM, 0)
    : 0;

  const basisTarget = showRollingStrip
    ? activeStripCoverM
    : hedgeBasisNotionalLocalM(
        selectedBasis,
        startM,
        pathEndM,
        matchedEqualVarLocalM,
      );

  // Bullet only: sync Decision % when Cash/VN/Target or structure changes.
  // Strip must not auto-apply here — booking is explicit via "Book … forwards".
  const onApplyBasisRef = useRef(onApplyBasis);
  onApplyBasisRef.current = onApplyBasis;
  const applySigRef = useRef('');
  useEffect(() => {
    if (effectiveStructure === 'strip') return;
    const sig = `${effectiveStructure}|${selectedBasis}|${matchedEqualVarLocalM.toFixed(6)}|${pathEndM.toFixed(6)}`;
    if (applySigRef.current === sig) return;
    applySigRef.current = sig;
    onApplyBasisRef.current(selectedBasis, effectiveStructure);
  }, [
    effectiveStructure,
    selectedBasis,
    matchedEqualVarLocalM,
    pathEndM,
  ]);

  /**
   * Flat H = Σ ticked strip fractions (all live from M0) or bullet level.
   * Fraction-of-target strip → one cover level → one breakeven.
   */
  const hedgeLevel = showRollingStrip
    ? Math.abs(activeStripCoverM) > 1e-12
      ? activeStripCoverM
      : 0
    : Math.abs(basisTarget) > 1e-12
      ? basisTarget
      : Math.abs(appliedHedgeLocalM) < 1e-12
        ? 0
        : Math.sign(pathEndM || startM || 1) * Math.abs(appliedHedgeLocalM);

  const hasFlatHedge = Math.abs(hedgeLevel) > 1e-9;

  /** Single BE where |e| crosses flat H (strip fractions sum or bullet). */
  const breakevenT = useMemo(
    () => (hasFlatHedge ? hedgeBreakevenMonths(path, hedgeLevel) : null),
    [hasFlatHedge, path, hedgeLevel],
  );

  /** Preview residual when bullet H set or any strip leg ticked. */
  const hasHedge = showRollingStrip
    ? activeHedgeLegs.length > 0
    : hasFlatHedge;

  const geom = useMemo(() => {
    const W = 640;
    const H = 260;
    const padL = 52;
    const padR = 72;
    const padT = 28;
    const padB = 36;
    // Stable Y domain from exposure path + full strip program (not ticked subset).
    const fullProgramCover = showRollingStrip
      ? stripTotalCoverM
      : Math.abs(appliedHedgeLocalM) > 1e-12
        ? Math.sign(pathEndM || startM || 1) * Math.abs(appliedHedgeLocalM)
        : hedgeBasisNotionalLocalM(
            selectedBasis,
            startM,
            pathEndM,
            matchedEqualVarLocalM,
          );
    const values = [
      ...path.map(p => p.exposureM),
      startM,
      pathEndM,
      fullProgramCover,
      ...rollingEdges.map(e => e.hedgeLocalM),
      ...rollingEdges.map(e => e.endExposureM),
      ...hedgeLegs.map(l => l.cumulCoverLocalM),
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
      monthTicks,
      yTickVals,
    };
  }, [
    path,
    windowMonths,
    startM,
    pathEndM,
    showRollingStrip,
    stripTotalCoverM,
    appliedHedgeLocalM,
    selectedBasis,
    matchedEqualVarLocalM,
    rollingEdges,
    hedgeLegs,
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
    monthTicks,
    yTickVals,
  } = geom;

  const startGap = overhedgeGapM(startM, hedgeLevel);
  const endGap = overhedgeGapM(pathEndM, hedgeLevel);

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
            {showRollingStrip
              ? `Strip cover · ${
                  selectedBasis === 'cash'
                    ? 'Cash'
                    : selectedBasis === 'varNeutral'
                      ? 'VaR-neutral'
                      : 'Target'
                }${stripAlreadyBooked ? ' · booked' : ''}`
              : `Hedge · ${
                  selectedBasis === 'cash'
                    ? 'Cash'
                    : selectedBasis === 'varNeutral'
                      ? 'VaR-neutral'
                      : 'Target'
                }`}
          </div>
          <div className="font-mono text-sm font-semibold text-emerald-200">
            {showRollingStrip
              ? (() => {
                  // Full stacked cover = last absolute edge level (≠ Decision % of Tf).
                  const last = rollingEdges[rollingEdges.length - 1];
                  const cover =
                    last != null
                      ? Math.sign(pathEndM || startM || 1) *
                        Math.abs(last.hedgeLocalM)
                      : hedgeLevel;
                  return Math.abs(cover) > 1e-9 ? fmtM(cover) : '—';
                })()
              : hasHedge
                ? fmtM(hedgeLevel)
                : '—'}
          </div>
          {showRollingStrip && rollingEdges.length > 1 && (
            <div className="mt-0.5 text-[9px] text-emerald-200/60">
              {rollingEdges.length} legs from M0 · M0{' '}
              {fmtM(
                Math.sign(pathEndM || startM || 1) *
                  Math.abs(rollingEdges[0]!.hedgeLocalM),
              )}
            </div>
          )}
        </div>
        <div className="rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1.5">
          <div className="text-[9px] uppercase text-amber-400/80">
            Breakeven
          </div>
          <div className="font-mono text-sm font-semibold text-amber-200">
            {!hasHedge
              ? '—'
              : breakevenT != null
                ? fmtMonths(breakevenT)
                : startGap > 0
                  ? 'always over'
                  : 'always under'}
          </div>
          {showRollingStrip && hasHedge && (
            <div className="mt-0.5 text-[9px] text-amber-200/70">
              vs Σ ticked = {fmtM(hedgeLevel)}
            </div>
          )}
        </div>
      </div>

      {showStructurePicker && (
        <div className="mb-2 space-y-2 rounded-md border border-slate-700 bg-slate-950/40 px-2.5 py-2">
          <div className="text-[10px] font-medium text-slate-400">
            Hedge structure · VaR {Th}m · forecast {Tf}m
          </div>
          <div
            className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
            role="group"
            aria-label="Hedge structure"
          >
            {(
              [
                {
                  id: 'bullet' as const,
                  label: 'Bullet',
                  hint: 'One forward at t=0 for Cash / VaR-neutral / Target over full Tf',
                  enabled: true,
                },
                {
                  id: 'strip' as const,
                  label: 'Rolling strip',
                  hint: rollingAvailable
                    ? 'Staggered forwards from M0 — each leg own size + tenure'
                    : `Needs VaR tenor < forecast (now ${Th}m ≥ ${Tf}m)`,
                  enabled: rollingAvailable,
                },
              ] as const
            ).map(opt => {
              const on = effectiveStructure === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={opt.hint}
                  aria-pressed={on}
                  disabled={!opt.enabled}
                  onClick={() => setStructure(opt.id)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    on
                      ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {effectiveStructure === 'bullet' ? (
            <p className="text-[10px] leading-relaxed text-slate-400">
              <span className="text-slate-200">Bullet</span> — Equal-VaR sized at
              forecast {Tf}m. VaR-neutral = mid (Ē / RMS); Target = E_end — pick
              the chip below for path / residual P&L. One forward at t=0.
            </p>
          ) : (
            <p className="text-[10px] leading-relaxed text-slate-400">
              <span className="text-slate-200">Rolling strip</span> — picking
              Cash / VN / Target <span className="text-slate-300">books</span>{' '}
              every forward from M0 (own size + tenure). Live VaR uses Σ leg
              VaRs — not Decision % of Target.
            </p>
          )}

          <div className="border-t border-slate-800 pt-2">
            <div className="mb-1 text-[10px] text-slate-500">Apply hedge path</div>
            <div
              className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
              role="group"
              aria-label="Apply hedge path"
            >
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
                  ? stripEdges[stripEdges.length - 1]!.hedgeLocalM
                  : hedgeBasisNotionalLocalM(
                      opt.id,
                      startM,
                      pathEndM,
                      matchedEqualVarLocalM,
                    );
                const n0 = useStrip ? stripEdges[0]!.hedgeLocalM : n;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    title={
                      useStrip
                        ? `${opt.description} → preview ${stripEdges.length}-leg strip from M0 (cover ${fmtM(n)}, M0 ${fmtM(n0)}); use Book to commit`
                        : `${opt.description} → set Hedge N = ${fmtM(n)}`
                    }
                    disabled={
                      Math.abs(matchedEqualVarLocalM) < 1e-9 &&
                      Math.abs(startM) < 1e-9
                    }
                    onClick={() => {
                      onSelectedBasisChange(opt.id);
                      onApplyBasis(opt.id, effectiveStructure);
                    }}
                    aria-pressed={on}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      on
                        ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {opt.id === 'cash'
                      ? useStrip
                        ? 'Cash → rolling'
                        : 'Cash (stock)'
                      : opt.id === 'varNeutral'
                        ? useStrip
                          ? 'VaR-neutral → strip'
                          : 'VaR-neutral'
                        : useStrip
                          ? 'Target → rolling'
                          : 'Target (Total)'}
                    <span
                      className={`ml-1 font-mono text-[10px] font-normal ${
                        on ? 'text-emerald-200/80' : 'text-slate-500'
                      }`}
                    >
                      {fmtM(n)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {showHedgePerf && (
            <>
              <div className="mb-2 rounded-md border border-slate-700/80 bg-slate-950/50 p-2">
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                  {showRollingStrip ? 'Strip' : 'Bullet'} · resid VaR profile
                </div>
                <p className="mb-2 text-[9px] leading-relaxed text-slate-500">
                  Same resid formula as VaR Evolution: V(t)·|e−H|/E. Shaded right
                  = beyond forecast (e flat at E_end; yellow resid keeps growing
                  with tenure when H &lt; E_end).
                </p>

                {hedgedVarProfile.length > 0 && (
                  <>
                    <svg
                      viewBox={`0 0 ${hedgedVarProfileGeom.W} ${hedgedVarProfileGeom.H}`}
                      className="mb-1 h-auto w-full max-w-full rounded border border-slate-800 bg-slate-950"
                      role="img"
                      aria-label={`${ccy} open VaR before hedge vs residual VaR`}
                    >
                      {hedgedVarProfileGeom.monthTicks.map(m => (
                        <g key={`hv-m-${m}`}>
                          <line
                            x1={hedgedVarProfileGeom.xScale(m)}
                            x2={hedgedVarProfileGeom.xScale(m)}
                            y1={hedgedVarProfileGeom.padT}
                            y2={
                              hedgedVarProfileGeom.H - hedgedVarProfileGeom.padB
                            }
                            stroke={
                              m === 0 ||
                              Math.abs(
                                m -
                                  (hedgedVarProfile[hedgedVarProfile.length - 1]
                                    ?.t ?? 0),
                              ) < 1e-9
                                ? '#475569'
                                : '#1e293b'
                            }
                          />
                          <text
                            x={hedgedVarProfileGeom.xScale(m)}
                            y={
                              hedgedVarProfileGeom.H -
                              hedgedVarProfileGeom.padB +
                              14
                            }
                            textAnchor="middle"
                            className="fill-slate-400"
                            style={{ fontSize: 9 }}
                          >
                            {Number.isInteger(m) ? `M${m}` : `${m.toFixed(1)}m`}
                          </text>
                        </g>
                      ))}
                      {/* Forecast vs beyond-forecast regions */}
                      {Tf > 0 &&
                        hedgedVarProfile[hedgedVarProfile.length - 1]!.t >
                          Tf + 1e-9 && (
                          <g>
                            <rect
                              x={hedgedVarProfileGeom.xScale(Tf)}
                              y={hedgedVarProfileGeom.padT}
                              width={Math.max(
                                0,
                                hedgedVarProfileGeom.xScale(
                                  hedgedVarProfile[
                                    hedgedVarProfile.length - 1
                                  ]!.t,
                                ) - hedgedVarProfileGeom.xScale(Tf),
                              )}
                              height={
                                hedgedVarProfileGeom.H -
                                hedgedVarProfileGeom.padT -
                                hedgedVarProfileGeom.padB
                              }
                              fill="rgba(148, 163, 184, 0.1)"
                              stroke="none"
                            />
                            <line
                              x1={hedgedVarProfileGeom.xScale(Tf)}
                              x2={hedgedVarProfileGeom.xScale(Tf)}
                              y1={hedgedVarProfileGeom.padT}
                              y2={
                                hedgedVarProfileGeom.H -
                                hedgedVarProfileGeom.padB
                              }
                              stroke="#94a3b8"
                              strokeWidth={1.25}
                              strokeDasharray="3 3"
                            />
                            <text
                              x={
                                (hedgedVarProfileGeom.padL +
                                  hedgedVarProfileGeom.xScale(Tf)) /
                                2
                              }
                              y={hedgedVarProfileGeom.padT - 4}
                              textAnchor="middle"
                              className="fill-slate-500"
                              style={{ fontSize: 8 }}
                            >
                              forecast
                            </text>
                            <text
                              x={
                                (hedgedVarProfileGeom.xScale(Tf) +
                                  hedgedVarProfileGeom.W -
                                  hedgedVarProfileGeom.padR) /
                                2
                              }
                              y={hedgedVarProfileGeom.padT - 4}
                              textAnchor="middle"
                              className="fill-slate-400"
                              style={{ fontSize: 8, fontWeight: 600 }}
                            >
                              beyond Tf · resid evolves
                            </text>
                          </g>
                        )}
                      {/* End resid level — light horizontal guide */}
                      <line
                        x1={hedgedVarProfileGeom.padL}
                        x2={
                          hedgedVarProfileGeom.W - hedgedVarProfileGeom.padR
                        }
                        y1={hedgedVarProfileGeom.yScale(
                          hedgedVarProfileGeom.endResidVarUsdM,
                        )}
                        y2={hedgedVarProfileGeom.yScale(
                          hedgedVarProfileGeom.endResidVarUsdM,
                        )}
                        stroke="#e2e8f0"
                        strokeWidth={1}
                        strokeDasharray="4 3"
                        opacity={0.4}
                      />
                      {/* Reduction band: open VaR − resid */}
                      {hedgedVarProfileGeom.reductionArea && (
                        <path
                          d={hedgedVarProfileGeom.reductionArea}
                          fill="rgba(52, 211, 153, 0.22)"
                          stroke="none"
                        />
                      )}
                      {/* Original open VaR before hedge (dashed) */}
                      <path
                        d={hedgedVarProfileGeom.openLine}
                        fill="none"
                        stroke="#94a3b8"
                        strokeWidth={1.75}
                        strokeDasharray="4 3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={0.95}
                      />
                      <path
                        d={hedgedVarProfileGeom.residLine}
                        fill="none"
                        stroke="#fcd34d"
                        strokeWidth={2.25}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={0.95}
                      />
                      {/* Single BE (same t as exposure path chart) */}
                      {breakevenT != null &&
                        (() => {
                          const residAtBe =
                            hedgedVarProfile.find(
                              p => Math.abs(p.t - breakevenT) < 1e-6,
                            ) ??
                            hedgedVarProfile.reduce((best, p) =>
                              Math.abs(p.t - breakevenT) <
                              Math.abs(best.t - breakevenT)
                                ? p
                                : best,
                            );
                          return (
                            <g key={`var-be-${breakevenT}`}>
                              <line
                                x1={hedgedVarProfileGeom.xScale(breakevenT)}
                                x2={hedgedVarProfileGeom.xScale(breakevenT)}
                                y1={hedgedVarProfileGeom.padT}
                                y2={
                                  hedgedVarProfileGeom.H -
                                  hedgedVarProfileGeom.padB
                                }
                                stroke="#fbbf24"
                                strokeWidth={1.25}
                                strokeDasharray="4 3"
                              />
                              <circle
                                cx={hedgedVarProfileGeom.xScale(breakevenT)}
                                cy={hedgedVarProfileGeom.yScale(
                                  residAtBe.hedgedVarUsdM,
                                )}
                                r={4}
                                fill="#fbbf24"
                                stroke="#0f172a"
                                strokeWidth={1}
                              />
                              <text
                                x={hedgedVarProfileGeom.xScale(breakevenT)}
                                y={hedgedVarProfileGeom.padT - 4}
                                textAnchor="middle"
                                className="fill-amber-300"
                                style={{ fontSize: 8, fontWeight: 600 }}
                              >
                                BE {fmtMonths(breakevenT)}
                              </text>
                            </g>
                          );
                        })()}
                      <text
                        x={hedgedVarProfileGeom.padL}
                        y={hedgedVarProfileGeom.padT + 8}
                        className="fill-slate-500"
                        style={{ fontSize: 8 }}
                      >
                        {fmtVarK(hedgedVarProfileGeom.maxVar)}
                      </text>
                      <text
                        x={hedgedVarProfileGeom.padL + 4}
                        y={
                          hedgedVarProfileGeom.yScale(
                            hedgedVarProfileGeom.endResidVarUsdM,
                          ) - 4
                        }
                        textAnchor="start"
                        className="fill-slate-300"
                        style={{ fontSize: 8 }}
                      >
                        resid @ M
                        {Math.round(
                          hedgedVarProfile[hedgedVarProfile.length - 1]?.t ??
                            Tf,
                        )}{' '}
                        {fmtVarK(hedgedVarProfileGeom.endResidVarUsdM)}
                      </text>
                    </svg>
                    <div className="mt-1.5 flex flex-wrap gap-3 text-[9px] text-slate-500">
                      <span>
                        <span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-slate-400 align-middle" />
                        Open VaR (before hedge)
                      </span>
                      <span>
                        <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-emerald-400/30 align-middle" />
                        Reduction
                      </span>
                      <span>
                        <span className="mr-1 inline-block h-0.5 w-3 bg-amber-300 align-middle" />
                        Remaining resid
                      </span>
                      <span className="text-amber-300/80">· BE</span>
                      <span className="text-slate-400">
                        · light line = resid @ window end
                      </span>
                    </div>
                  </>
                )}

                <div className="mt-2 overflow-x-auto">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[9px] font-medium uppercase tracking-wide text-slate-500">
                      Performance · tick trades to show/hide green hedge
                    </div>
                    {showRollingStrip && (
                      <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/60 px-1.5 py-0.5">
                        <button
                          type="button"
                          onClick={resetStripToDefault}
                          className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                          title={`Reset to default ${defaultStripLegs} legs (ceil(Tf/Th)) for current parameters, all trades on`}
                        >
                          Reset
                        </button>
                        <span className="text-[9px] text-slate-600">|</span>
                        <span className="text-[9px] text-slate-500">
                          Strip legs
                        </span>
                        <button
                          type="button"
                          disabled={effectiveStripLegs <= 2}
                          onClick={() =>
                            setStripLegCount(
                              Math.max(2, effectiveStripLegs - 1),
                            )
                          }
                          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                          title="Fewer strip forwards (min 2)"
                        >
                          −
                        </button>
                        <span className="min-w-[1.25rem] text-center font-mono text-[11px] text-amber-200">
                          {effectiveStripLegs}
                        </span>
                        <button
                          type="button"
                          disabled={effectiveStripLegs >= maxStripLegs}
                          onClick={() =>
                            setStripLegCount(
                              Math.min(maxStripLegs, effectiveStripLegs + 1),
                            )
                          }
                          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                          title={`More strip forwards (max ${maxStripLegs})`}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                  <table className="w-full min-w-[420px] text-left text-[10px]">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="py-1 pr-1 font-medium" title="Include in resid VaR profile">
                          On
                        </th>
                        <th className="py-1 pr-2 font-medium">
                          {showRollingStrip ? 'Forward / t' : 'Forward'}
                        </th>
                        <th className="py-1 pr-2 font-medium">Hedge N</th>
                        <th className="py-1 pr-2 font-medium">e @ t</th>
                        <th className="py-1 pr-2 font-medium">|e−H|</th>
                        <th className="py-1 pr-2 font-medium">Open VaR</th>
                        <th className="py-1 font-medium">Resid VaR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hedgePerfRows.map(row => (
                        <tr
                          key={row.key}
                          className={`border-t border-slate-800/80 font-mono text-slate-300 ${
                            row.kind === 'leg' && !row.enabled
                              ? 'opacity-40'
                              : ''
                          }`}
                        >
                          <td className="py-1 pr-1">
                            {row.legIndex != null ? (
                              <input
                                type="checkbox"
                                checked={row.enabled}
                                onChange={() =>
                                  setEnabledLegIds(prev => ({
                                    ...prev,
                                    [row.legIndex!]: !row.enabled,
                                  }))
                                }
                                className="h-3.5 w-3.5 cursor-pointer rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500/40"
                                title={
                                  row.enabled
                                    ? 'Exclude trade from resid VaR profile'
                                    : 'Include trade in resid VaR profile'
                                }
                              />
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                          <td className="py-1 pr-2 text-slate-300">
                            {row.label}
                            {row.kind === 'end' ? (
                              <span className="ml-1 text-[8px] text-slate-500">
                                Tf
                              </span>
                            ) : null}
                          </td>
                          <td className="py-1 pr-2 text-emerald-300/90">
                            {row.hedgeDeltaM != null
                              ? fmtM(row.hedgeDeltaM)
                              : '—'}
                          </td>
                          <td className="py-1 pr-2 text-slate-400">
                            {row.endExposureM != null
                              ? fmtM(row.endExposureM)
                              : '—'}
                          </td>
                          <td className="py-1 pr-2 text-amber-300/90">
                            {fmtM(row.residualLocalM)}
                          </td>
                          <td className="py-1 pr-2 text-slate-400">
                            {fmtVarK(row.openVarUsdM)}
                          </td>
                          <td
                            className={`py-1 font-semibold ${
                              row.hedgedVarUsdM < 1e-6
                                ? 'text-emerald-300'
                                : 'text-amber-200'
                            }`}
                          >
                            {fmtVarK(row.hedgedVarUsdM)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {showRollingStrip && onBookRollingStrip && (
                <button
                  type="button"
                  disabled={stripAlreadyBooked}
                  onClick={() => onBookRollingStrip(rollingEdges)}
                  className="rounded-md border border-violet-500/50 bg-violet-500/20 px-2.5 py-1.5 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    stripAlreadyBooked
                      ? 'Strip already on the book — cancel it to rebook'
                      : `Book ${rollingEdges.length} forwards from M0 (incremental size, tenure to each edge end)`
                  }
                >
                  {stripAlreadyBooked
                    ? 'Strip booked (re-apply chip to replace)'
                    : `Book ${
                        selectedBasis === 'cash'
                          ? 'Cash/stock'
                          : selectedBasis === 'totalExpected'
                            ? 'Total'
                            : 'VaR-neutral'
                      } ${rollingEdges.length}-leg strip`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {!showStructurePicker && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] text-slate-500">Apply hedge path</div>
          <div
            className="inline-flex max-w-full flex-wrap rounded-lg border border-slate-700 bg-slate-950/60 p-0.5"
            role="group"
            aria-label="Apply hedge path"
          >
            {HEDGE_PATH_BASIS_OPTIONS.map(opt => {
              const on = selectedBasis === opt.id;
              const n = hedgeBasisNotionalLocalM(
                opt.id,
                startM,
                pathEndM,
                matchedEqualVarLocalM,
              );
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={`${opt.description} → set Hedge N = ${fmtM(n)}`}
                  disabled={
                    Math.abs(matchedEqualVarLocalM) < 1e-9 &&
                    Math.abs(startM) < 1e-9
                  }
                  onClick={() => {
                    onSelectedBasisChange(opt.id);
                    onApplyBasis(opt.id, effectiveStructure);
                  }}
                  aria-pressed={on}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    on
                      ? 'bg-emerald-500/20 text-emerald-100 shadow-sm'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {opt.id === 'cash'
                    ? 'Cash (stock)'
                    : opt.id === 'varNeutral'
                      ? 'VaR-neutral'
                      : 'Target (Total)'}
                  <span
                    className={`ml-1 font-mono text-[10px] font-normal ${
                      on ? 'text-emerald-200/80' : 'text-slate-500'
                    }`}
                  >
                    {fmtM(n)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <p className="mb-1.5 text-[10px] text-slate-500">
        Blue = e(t) over {windowMonths}m (forecast to Tf={Tf}m
        {windowMonths > Tf + 1e-9 ? ', then flat beyond forecast' : ''}
        ). Strip ladder: each forward on its window only. Tick → green segment;
        untick → purple dashed. Roll connectors stay purple. Amber = overhedged
        vs Σ ticked H.
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

        {/* Post-forecast band: e flat, resid VaR still evolves (same as Evolution) */}
        {Tf > 0 && windowMonths > Tf + 1e-9 && (
          <g>
            <rect
              x={xScale(Tf)}
              y={padT}
              width={Math.max(0, xScale(windowMonths) - xScale(Tf))}
              height={H - padT - padB}
              fill="rgba(148, 163, 184, 0.08)"
              stroke="none"
            />
            <line
              x1={xScale(Tf)}
              x2={xScale(Tf)}
              y1={padT}
              y2={H - padB}
              stroke="#94a3b8"
              strokeWidth={1.25}
              strokeDasharray="4 3"
            />
            <text
              x={(xScale(Tf) + xScale(windowMonths)) / 2}
              y={padT + 12}
              textAnchor="middle"
              fill="#94a3b8"
              fontSize={9}
              fontWeight={600}
            >
              beyond forecast
            </text>
            <text
              x={(xScale(0) + xScale(Tf)) / 2}
              y={padT + 12}
              textAnchor="middle"
              fill="#64748b"
              fontSize={9}
            >
              forecast
            </text>
          </g>
        )}

        {/* Overhedge band vs flat H (Σ ticked fractions or bullet) */}
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

        {/* Strip ladder: each forward only on its window [start,end] — not from Y-axis.
            Green solid = ticked; purple dashed = unticked. Vertical rolls stay purple. */}
        {showRollingStrip &&
          rollingEdges.map(e => {
            const leg = hedgeLegs.find(l => l.index === e.index);
            const on = enabledLegIds[e.index] !== false;
            const x0 = xScale(e.startMonth);
            const x1 = xScale(Math.max(e.startMonth, e.endMonth));
            const y = yScale(e.hedgeLocalM);
            const delta = leg?.amountLocalM ?? e.hedgeLocalM;
            const label = leg?.label ?? e.label;
            return (
              <g key={`fwd-${e.index}`}>
                <line
                  x1={x0}
                  x2={x1}
                  y1={y}
                  y2={y}
                  stroke={on ? '#34d399' : '#a78bfa'}
                  strokeWidth={on ? 2.25 : 2}
                  strokeDasharray={on ? undefined : '6 3'}
                  strokeLinecap="round"
                />
                <text
                  x={(x0 + x1) / 2}
                  y={y - 6}
                  textAnchor="middle"
                  fill={on ? '#6ee7b7' : '#c4b5fd'}
                  fontSize={9}
                  fontWeight={600}
                >
                  {label} {fmtM(delta)}
                </text>
              </g>
            );
          })}

        {/* Purple vertical ladder connectors at roll / next-forward switch */}
        {showRollingStrip &&
          rollingEdges.slice(0, -1).map((e, i) => {
            const next = rollingEdges[i + 1]!;
            const t = e.endMonth;
            if (!(t > 1e-9) || !(t < windowMonths + 1e-9)) return null;
            const y0 = yScale(e.hedgeLocalM);
            const y1 = yScale(next.hedgeLocalM);
            return (
              <g key={`roll-${e.index}`}>
                <line
                  x1={xScale(t)}
                  x2={xScale(t)}
                  y1={padT}
                  y2={H - padB}
                  stroke="#a78bfa"
                  strokeWidth={1}
                  strokeDasharray="3 4"
                  opacity={0.35}
                />
                <line
                  x1={xScale(t)}
                  x2={xScale(t)}
                  y1={Math.min(y0, y1)}
                  y2={Math.max(y0, y1)}
                  stroke="#a78bfa"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  strokeLinecap="round"
                />
                <text
                  x={xScale(t) + 4}
                  y={(y0 + y1) / 2 + 3}
                  fill="#c4b5fd"
                  fontSize={8}
                  fontWeight={600}
                >
                  →{Number.isInteger(t) ? `M${t}` : t.toFixed(1)}
                </text>
              </g>
            );
          })}

        {/* Purple dashed = bullet regime target when it differs from applied */}
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

        {/* Bullet: green = applied cover (strip greens are per ticked forward above) */}
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
          <text
            x={W - padR - 4}
            y={yScale(hedgeLevel) - 4}
            textAnchor="end"
            fill="#6ee7b7"
            fontSize={9}
            fontWeight={600}
          >
            Σ H {fmtM(hedgeLevel)}
          </text>
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
          cx={xScale(Tf > 0 && windowMonths > Tf + 1e-9 ? Tf : windowMonths)}
          cy={yScale(pathEndM)}
          r={5}
          fill="#38bdf8"
        />
        <text
          x={
            xScale(Tf > 0 && windowMonths > Tf + 1e-9 ? Tf : windowMonths) - 8
          }
          y={yScale(pathEndM) - 8}
          textAnchor="end"
          fill="#7dd3fc"
          fontSize={10}
          fontWeight={600}
        >
          E {fmtM(pathEndM)}
        </text>

        {/* Single breakeven vs flat H */}
        {breakevenT != null && hasHedge && (
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
          Unticked / planned
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 bg-emerald-400" />{' '}
          {showRollingStrip ? 'Ticked forward' : 'Applied hedge'}
        </span>
        {showRollingStrip && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-0 border-l-2 border-dashed border-violet-400" />{' '}
            Roll / next forward
          </span>
        )}
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

    </div>
  );
}
