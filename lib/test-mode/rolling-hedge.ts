/**
 * Rolling hedge edges when VaR horizon Th is shorter than forecast Tf.
 *
 * One flat Equal-VaR bullet only covers the first Th window. For Tf > Th,
 * book successive forwards: M0–Th from S₀, then Th–2Th from the grown stock
 * S₁ = e(Th), etc.
 */

import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import { isLiveHedgeTicket, newHedgeTicketId } from '@/lib/test-mode/hedge-var';
import {
  accruedPositionFromScheduleM,
  computeParametricVarUsdM,
  horizonIdForForecastMonths,
  horizonMonths,
  VAR_HORIZON_OPTIONS,
  type VarExposureBasis,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

export type RollingEdgeSizing = 'stockStart' | 'varNeutral' | 'windowEnd';

/**
 * How to cover Tf when VaR tenor Th &lt; forecast:
 * - bullet — one forward at t=0 for the selected regime (Cash / VN / Target)
 * - strip  — staggered forwards from M0 (own size + tenure per edge)
 */
export type ForecastHedgeStructure = 'bullet' | 'strip';

export interface RollingHedgeEdge {
  index: number;
  /** Inclusive start month (from t=0). */
  startMonth: number;
  /** Exclusive end month of the edge window. */
  endMonth: number;
  /** Accrued exposure at startMonth. */
  stockStartM: number;
  /** Accrued exposure at endMonth. */
  endExposureM: number;
  /** Hedge notional for this edge (signed with exposure). */
  hedgeLocalM: number;
  label: string;
}

export interface StripBreakeven {
  t: number;
  edgeIndex: number;
  label: string;
}

/** True when forecast extends past the VaR tenure — need multiple edges. */
export function needsRollingHedges(
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'>,
): boolean {
  const Th = horizonMonths(setup.horizon);
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  return Tf > Th + 1e-9;
}

/** Number of Th-length edges to cover Tf (last edge may be shorter). */
export function rollingEdgeCount(
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'>,
): number {
  const Th = horizonMonths(setup.horizon);
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  if (Th <= 1e-12 || Tf <= 1e-12) return Tf > 0 ? 1 : 0;
  return Math.max(1, Math.ceil(Tf / Th - 1e-12));
}

/**
 * Size one edge window [start, end]:
 * - stockStart → S at window start (cash / stock roll)
 * - varNeutral → mid-point (S_start + E_end) / 2
 * - windowEnd  → E_end (Total expected roll)
 */
export function sizeRollingEdgeLocalM(
  stockStartM: number,
  endExposureM: number,
  sizing: RollingEdgeSizing,
): number {
  if (sizing === 'stockStart') return stockStartM;
  if (sizing === 'windowEnd') return endExposureM;
  return (stockStartM + endExposureM) / 2;
}

/**
 * Build rolling forward edges over the forecast.
 * Flat F or uneven `monthlyFlows` schedule.
 * Optional `legCount` overrides ceil(Tf/Th) — equal windows Tf/n (min 1).
 */
export function buildRollingHedgeEdges(
  stockM: number,
  monthlyFlows: readonly number[],
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'>,
  sizing: RollingEdgeSizing = 'varNeutral',
  options?: { legCount?: number },
): RollingHedgeEdge[] {
  const Th = horizonMonths(setup.horizon);
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  const S0 = Number.isFinite(stockM) ? stockM : 0;
  if (Tf <= 1e-12) {
    return [
      {
        index: 0,
        startMonth: 0,
        endMonth: 0,
        stockStartM: S0,
        endExposureM: S0,
        hedgeLocalM: S0,
        label: 'M0',
      },
    ];
  }
  const edgeTh = Th > 1e-12 ? Th : Tf;
  const nDefault = Math.max(1, Math.ceil(Tf / edgeTh - 1e-12));
  const n =
    typeof options?.legCount === 'number' && Number.isFinite(options.legCount)
      ? Math.max(1, Math.round(options.legCount))
      : nDefault;
  const window = Tf / n;
  const edges: RollingHedgeEdge[] = [];

  for (let k = 0; k < n; k++) {
    const startMonth = k * window;
    if (startMonth >= Tf - 1e-12) break;
    const endMonth = Math.min(Tf, startMonth + window);
    const stockStartM = accruedPositionFromScheduleM(S0, monthlyFlows, startMonth);
    const endExposureM = accruedPositionFromScheduleM(S0, monthlyFlows, endMonth);
    const hedgeLocalM = sizeRollingEdgeLocalM(stockStartM, endExposureM, sizing);
    const label =
      Math.abs(endMonth - startMonth - Math.round(endMonth - startMonth)) < 1e-6 &&
      Math.abs(startMonth - Math.round(startMonth)) < 1e-6
        ? `M${Math.round(startMonth)}–M${Math.round(endMonth)}`
        : `t=${startMonth.toFixed(1)}–${endMonth.toFixed(1)}`;
    edges.push({
      index: k,
      startMonth,
      endMonth,
      stockStartM,
      endExposureM,
      hedgeLocalM,
      label,
    });
  }
  return edges;
}

/** Active hedge notional at time t from a rolling strip (step function). */
export function rollingHedgeAtMonth(
  edges: readonly RollingHedgeEdge[],
  t: number,
): number {
  if (edges.length === 0) return 0;
  for (const e of edges) {
    if (t + 1e-12 >= e.startMonth && t < e.endMonth - 1e-12) {
      return e.hedgeLocalM;
    }
  }
  // At / past final end — last edge level
  const last = edges[edges.length - 1]!;
  if (t + 1e-12 >= last.startMonth) return last.hedgeLocalM;
  return edges[0]!.hedgeLocalM;
}

/** Stepped hedge path samples aligned to edge boundaries (+ optional denser t). */
export function buildRollingHedgePathPoints(
  edges: readonly RollingHedgeEdge[],
): { t: number; hedgeM: number }[] {
  if (edges.length === 0) return [];
  const pts: { t: number; hedgeM: number }[] = [];
  for (const e of edges) {
    pts.push({ t: e.startMonth, hedgeM: e.hedgeLocalM });
    // Point just before end so step stays flat through the window
    const tEnd = Math.max(e.startMonth, e.endMonth - 1e-6);
    pts.push({ t: tEnd, hedgeM: e.hedgeLocalM });
  }
  const last = edges[edges.length - 1]!;
  pts.push({ t: last.endMonth, hedgeM: last.hedgeLocalM });
  return pts;
}

/**
 * Per-edge breakevens for a rolling strip vs exposure path e(t).
 * - stockStart: matched at roll (t = start)
 * - windowEnd: matched at window end (t = end) when H = E_end
 * - varNeutral: first strict |e| cross of H inside (start, end]
 */
export function hedgeBreakevensForStrip(
  path: readonly { t: number; exposureM: number }[],
  edges: readonly RollingHedgeEdge[],
  sizing: RollingEdgeSizing,
): StripBreakeven[] {
  if (path.length < 2 || edges.length === 0) return [];
  const out: StripBreakeven[] = [];

  for (const e of edges) {
    const H = Math.abs(e.hedgeLocalM);
    if (H < 1e-12) continue;

    if (sizing === 'stockStart') {
      // Matched at roll date; exposure then grows past H.
      out.push({ t: e.startMonth, edgeIndex: e.index, label: e.label });
      continue;
    }
    if (sizing === 'windowEnd') {
      out.push({ t: e.endMonth, edgeIndex: e.index, label: e.label });
      continue;
    }

    // varNeutral: find crossing inside the window
    let found: number | null = null;
    for (let i = 1; i < path.length; i++) {
      const t0 = path[i - 1]!.t;
      const t1 = path[i]!.t;
      if (t1 < e.startMonth - 1e-12) continue;
      if (t0 > e.endMonth + 1e-12) break;
      const a = Math.abs(path[i - 1]!.exposureM);
      const b = Math.abs(path[i]!.exposureM);
      // Landed on H
      if (a < H - 1e-9 && Math.abs(b - H) <= 1e-9) {
        const tStar = Math.min(Math.max(t1, e.startMonth), e.endMonth);
        if (tStar > e.startMonth + 1e-6) {
          found = tStar;
          break;
        }
      }
      if ((a - H) * (b - H) >= 0) continue;
      if (Math.abs(b - a) < 1e-15) {
        found = Math.min(Math.max(t1, e.startMonth), e.endMonth);
        break;
      }
      const w = (H - a) / (b - a);
      const tStar = t0 + w * (t1 - t0);
      if (tStar < e.startMonth + 1e-6 || tStar > e.endMonth + 1e-9) continue;
      found = tStar;
      break;
    }
    if (found != null) {
      out.push({ t: found, edgeIndex: e.index, label: e.label });
    }
  }
  return out;
}

/** Map edge window length to nearest VaR horizon id for ticket maturity. */
export function edgeMaturityHorizonId(
  edgeMonths: number,
  fallback: VarHorizonId,
): VarHorizonId {
  if (!(edgeMonths > 0) || !Number.isFinite(edgeMonths)) return fallback;
  let best = fallback;
  let bestDist = Infinity;
  for (const h of VAR_HORIZON_OPTIONS) {
    const d = Math.abs(h.months - edgeMonths);
    if (d < bestDist) {
      bestDist = d;
      best = h.id;
    }
  }
  return best;
}

/** Bullet forward tenor = full forecast length (nearest horizon chip). */
export function bulletMaturityForForecast(
  forecastMonths: number,
  fallback: VarHorizonId = '6m',
): VarHorizonId {
  return edgeMaturityHorizonId(forecastMonths, fallback);
}

/**
 * Bullet covers the full forecast in one forward — size VaR / Equal-VaR at
 * Th := Tf so VaR-neutral lines up with Target (Total expected).
 * Strip keeps the Analytics VaR horizon (rolling Th windows).
 */
export function varSetupForHedgeStructure(
  setup: VarSetup,
  structure: ForecastHedgeStructure,
): VarSetup {
  if (structure !== 'bullet') return setup;
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  if (Tf <= 0) return setup;
  const horizon = horizonIdForForecastMonths(Tf);
  if (horizon === setup.horizon) return setup;
  return { ...setup, horizon };
}

/**
 * Setup for Cash / VaR-neutral / Target sizing on the path chart & Decision ladder.
 * - Bullet → Th = Tf (same as matched horizon/forecast).
 * - Stock Analytics profile makes Equal-VaR ≡ Cash; use growth-path (totalBuildup)
 *   so VaR-neutral sits between Cash and Target like the strip mid.
 */
export function varSetupForPathHedgeRegime(
  setup: VarSetup,
  structure: ForecastHedgeStructure,
): VarSetup {
  const sized = varSetupForHedgeStructure(setup, structure);
  if (sized.exposureBasis === 'stock') {
    return { ...sized, exposureBasis: 'totalBuildup' };
  }
  return sized;
}

/**
 * M0-origin forward legs from absolute edge levels.
 * Target Tf=12 / Th=6 → 9.1 @ 6m + 7.2 @ 12m (not a deferred M6–M12 roll at 16.3).
 */
export interface StripForwardLeg {
  index: number;
  /** M0–Mk (both legs dealt today). */
  label: string;
  tenureMonths: number;
  /** Incremental booked notional. */
  amountLocalM: number;
  /** Σ increments through this leg. */
  cumulCoverLocalM: number;
  /** Path exposure at maturity (context). */
  endExposureM: number;
  stockStartM: number;
}

/** Convert absolute edge ladder → incremental M0 forwards. */
export function stripForwardLegsFromEdges(
  edges: readonly RollingHedgeEdge[],
): StripForwardLeg[] {
  let prevAbs = 0;
  let cumul = 0;
  const out: StripForwardLeg[] = [];
  for (const e of edges) {
    const tenureMonths =
      e.endMonth > 1e-9
        ? e.endMonth
        : Math.max(0, e.endMonth - e.startMonth);
    const level = e.hedgeLocalM;
    const sign = level >= 0 || Math.abs(level) < 1e-12 ? 1 : -1;
    const incrAbs = Math.max(0, Math.abs(level) - prevAbs);
    prevAbs = Math.abs(level);
    const amountLocalM = sign * incrAbs;
    cumul += amountLocalM;
    out.push({
      index: e.index,
      label: `M0–M${Math.round(tenureMonths)}`,
      tenureMonths,
      amountLocalM,
      cumulCoverLocalM: cumul,
      endExposureM: e.endExposureM,
      stockStartM: e.stockStartM,
    });
  }
  return out;
}

/**
 * Propose strip tickets — all live from M0 (dealt today):
 * - size = incremental (H_k − H_{k−1}); Target 16.3 → 9.1 @ 6m + 7.2 @ 12m
 * - tenure = M0 → edge end (not a deferred roll starting at Mk)
 * - ticket VaR = parametric |N_k| at that tenure (linear in N)
 */
export function proposeRollingHedgeTickets(
  ccy: string,
  edges: readonly RollingHedgeEdge[],
  setup: VarSetup,
  basis: VarExposureBasis = 'simpleAvg',
  _monthlyFlows: readonly number[] = [],
): HedgeTicket[] {
  if (edges.length === 0) return [];
  const stripId = `strip-${ccy}-${newHedgeTicketId()}`;
  const tickets: HedgeTicket[] = [];
  for (const leg of stripForwardLegsFromEdges(edges)) {
    const maturity = edgeMaturityHorizonId(leg.tenureMonths, setup.horizon);
    const maturityLabel =
      VAR_HORIZON_OPTIONS.find(h => h.id === maturity)?.label ?? maturity;
    tickets.push({
      id: newHedgeTicketId(),
      ccy,
      instrument: 'forward',
      basis,
      amountLocalM: leg.amountLocalM,
      maturity,
      maturityLabel: `${leg.label} · ${maturityLabel}`,
      varUsdM: computeParametricVarUsdM(leg.amountLocalM, ccy, {
        ...setup,
        horizon: maturity,
      }),
      addressesHigherVar: true,
      status: 'booked',
      stripId,
      stripEdgeIndex: leg.index,
    });
  }
  return tickets;
}

/** True when this CCY already has a rolling-strip ticket on the book. */
export function hasRollingStripForCcy(
  booked: readonly HedgeTicket[],
  ccy: string,
): boolean {
  return booked.some(t => t.ccy === ccy && Boolean(t.stripId));
}

/** Map path-chart Cash / VN / Target → edge sizing. */
export function sizingForHedgePathBasis(
  basis: 'cash' | 'varNeutral' | 'totalExpected',
): RollingEdgeSizing {
  if (basis === 'cash') return 'stockStart';
  if (basis === 'totalExpected') return 'windowEnd';
  return 'varNeutral';
}

/**
 * Build + book a full M0 strip for the regime (replaces any prior strip).
 * Apply-chip and Book-strip share this so Live VaR sees every leg immediately.
 */
export function bookStripForBasis(
  ccy: string,
  stockM: number,
  monthlyFlows: readonly number[],
  setup: VarSetup,
  basis: 'cash' | 'varNeutral' | 'totalExpected',
  booked: readonly HedgeTicket[],
  ticketBasis: VarExposureBasis = 'totalBuildup',
): HedgeTicket[] {
  const edges = buildRollingHedgeEdges(
    stockM,
    monthlyFlows,
    setup,
    sizingForHedgePathBasis(basis),
  );
  // Same reference when unchanged — avoids setState loops from apply chips.
  if (stripMatchesEdges(booked, ccy, edges)) return booked as HedgeTicket[];
  const tickets = proposeRollingHedgeTickets(
    ccy,
    edges,
    setup,
    ticketBasis,
    monthlyFlows,
  );
  return mergeRollingStripIntoBook(booked, tickets, ccy);
}

/** True when booked strip notionals already match these edges (incremental). */
export function stripMatchesEdges(
  booked: readonly HedgeTicket[],
  ccy: string,
  edges: readonly RollingHedgeEdge[],
): boolean {
  const legs = booked
    .filter(t => t.ccy === ccy && t.stripId)
    .slice()
    .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
  if (legs.length === 0 || legs.length !== edges.length) return false;
  let prevAbs = 0;
  for (let i = 0; i < edges.length; i++) {
    const level = edges[i]!.hedgeLocalM;
    const sign = level >= 0 || Math.abs(level) < 1e-12 ? 1 : -1;
    const incr = sign * Math.max(0, Math.abs(level) - prevAbs);
    prevAbs = Math.abs(level);
    if (Math.abs(legs[i]!.amountLocalM - incr) > 1e-6) return false;
  }
  return true;
}

/**
 * Insert a new strip, replacing any prior strip for the same CCY
 * (prevents stacking duplicate strips on repeat clicks).
 */
export function mergeRollingStripIntoBook(
  booked: readonly HedgeTicket[],
  stripTickets: readonly HedgeTicket[],
  ccy: string,
): HedgeTicket[] {
  const withoutPrior = booked.filter(t => !(t.ccy === ccy && t.stripId));
  return [...stripTickets, ...withoutPrior];
}

/** Nearest Cash / VN / Target sizing for a live M0 hedge notional. */
export function inferRollingEdgeSizing(
  hedgeLocalM: number,
  stockStartM: number,
  endExposureM: number,
): RollingEdgeSizing {
  const h = Math.abs(hedgeLocalM);
  const opts: { id: RollingEdgeSizing; n: number }[] = [
    { id: 'stockStart', n: Math.abs(stockStartM) },
    {
      id: 'varNeutral',
      n: Math.abs((stockStartM + endExposureM) / 2),
    },
    { id: 'windowEnd', n: Math.abs(endExposureM) },
  ];
  let best = opts[0]!;
  let bestDist = Math.abs(h - best.n);
  for (const o of opts.slice(1)) {
    const d = Math.abs(h - o.n);
    if (d < bestDist - 1e-12) {
      best = o;
      bestDist = d;
    }
  }
  return best.id;
}

/**
 * Rebuild booked rolling strips after Analytics VaR profile / Th·Tf change.
 * All legs stay live from M0 with incremental size + own tenure; VaR is
 * recomputed per leg. Returns null when nothing changed.
 */
export function resyncBookedRollingStrips(
  booked: readonly HedgeTicket[],
  bars: readonly { ccy: string; stockNetM: number; flowM: number }[],
  setup: VarSetup,
  monthlyFlowsByCcy: Record<string, readonly number[]> = {},
): HedgeTicket[] | null {
  const stripCcys = [
    ...new Set(booked.filter(t => t.stripId).map(t => t.ccy)),
  ];
  if (stripCcys.length === 0) return null;

  let next = [...booked];
  let changed = false;
  for (const ccy of stripCcys) {
    // Infer regime from first edge (incremental ≡ absolute on edge 0).
    const live =
      next.find(
        t => t.ccy === ccy && t.stripId && (t.stripEdgeIndex ?? 0) === 0,
      ) ?? next.find(t => t.ccy === ccy && t.stripId);
    if (!live) continue;
    const bar = bars.find(b => b.ccy === ccy);
    if (!bar) continue;
    const Tf =
      typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
        ? setup.forecastMonths
        : 0;
    const schedule = monthlyFlowsByCcy[ccy];
    const flows =
      schedule && schedule.length > 0
        ? [...schedule]
        : Tf > 0
          ? Array.from({ length: Tf }, () =>
              setup.forecastMonths > 0 && Math.abs(bar.flowM) > 1e-15
                ? bar.flowM
                : 0,
            )
          : [];
    const probe = buildRollingHedgeEdges(
      bar.stockNetM,
      flows,
      setup,
      'windowEnd',
    );
    if (probe.length === 0) continue;
    const sizing = inferRollingEdgeSizing(
      live.amountLocalM,
      probe[0]!.stockStartM,
      probe[0]!.endExposureM,
    );
    // Re-infer against the chosen sizing’s first edge for a tighter match.
    const edges = buildRollingHedgeEdges(bar.stockNetM, flows, setup, sizing);
    if (edges.length === 0) continue;
    const refined = inferRollingEdgeSizing(
      live.amountLocalM,
      edges[0]!.stockStartM,
      edges[0]!.endExposureM,
    );
    const finalEdges =
      refined === sizing
        ? edges
        : buildRollingHedgeEdges(bar.stockNetM, flows, setup, refined);
    const tickets = proposeRollingHedgeTickets(
      ccy,
      finalEdges,
      setup,
      live.basis,
      flows,
    ).map(t => ({
      ...t,
      entityId: live.entityId,
      entityName: live.entityName,
    }));
    const prevStrip = next.filter(t => t.ccy === ccy && t.stripId);
    const same =
      prevStrip.length === tickets.length &&
      prevStrip.every((t, i) => {
        const n = tickets[i]!;
        return (
          Math.abs(t.amountLocalM - n.amountLocalM) < 1e-9 &&
          t.status === n.status &&
          t.maturity === n.maturity
        );
      });
    if (same) continue;
    next = mergeRollingStripIntoBook(next, tickets, ccy);
    changed = true;
  }
  return changed ? next : null;
}

/** Drop an entire strip (or a single non-strip ticket) on cancellation. */
export function removeHedgeTicketOrStrip(
  booked: readonly HedgeTicket[],
  ticket: HedgeTicket,
): HedgeTicket[] {
  if (ticket.stripId) {
    return booked.filter(t => t.stripId !== ticket.stripId);
  }
  return booked.filter(t => t.id !== ticket.id);
}
