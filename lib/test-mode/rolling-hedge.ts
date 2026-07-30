/**
 * Rolling hedge edges when VaR horizon Th is shorter than forecast Tf.
 *
 * One flat Equal-VaR bullet only covers the first Th window. For Tf > Th,
 * book successive forwards: M0–Th from S₀, then Th–2Th from the grown stock
 * S₁ = e(Th), etc.
 */

import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import { newHedgeTicketId } from '@/lib/test-mode/hedge-var';
import {
  accruedPositionFromScheduleM,
  computeParametricVarUsdM,
  horizonMonths,
  VAR_HORIZON_OPTIONS,
  type VarExposureBasis,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

export type RollingEdgeSizing = 'stockStart' | 'varNeutral' | 'windowEnd';

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
 */
export function buildRollingHedgeEdges(
  stockM: number,
  monthlyFlows: readonly number[],
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'>,
  sizing: RollingEdgeSizing = 'varNeutral',
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
  const n = Math.max(1, Math.ceil(Tf / edgeTh - 1e-12));
  const edges: RollingHedgeEdge[] = [];

  for (let k = 0; k < n; k++) {
    const startMonth = k * edgeTh;
    if (startMonth >= Tf - 1e-12) break;
    const endMonth = Math.min(Tf, startMonth + edgeTh);
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

/**
 * Propose strip tickets: edge 0 is live (`booked`); later edges are
 * `scheduled` rolls (not traded until their start month).
 */
export function proposeRollingHedgeTickets(
  ccy: string,
  edges: readonly RollingHedgeEdge[],
  setup: VarSetup,
  basis: VarExposureBasis = 'simpleAvg',
): HedgeTicket[] {
  if (edges.length === 0) return [];
  const stripId = `strip-${ccy}-${newHedgeTicketId()}`;
  const tickets: HedgeTicket[] = [];
  for (const e of edges) {
    const w = Math.max(0, e.endMonth - e.startMonth);
    const maturity = edgeMaturityHorizonId(
      w > 1e-9 ? w : horizonMonths(setup.horizon),
      setup.horizon,
    );
    const maturityLabel =
      VAR_HORIZON_OPTIONS.find(h => h.id === maturity)?.label ?? maturity;
    const amountLocalM = e.hedgeLocalM;
    const live = e.index === 0;
    tickets.push({
      id: newHedgeTicketId(),
      ccy,
      instrument: 'forward',
      basis,
      amountLocalM,
      maturity,
      maturityLabel: `${e.label} · ${maturityLabel}`,
      varUsdM: computeParametricVarUsdM(amountLocalM, ccy, {
        ...setup,
        horizon: maturity,
      }),
      addressesHigherVar: true,
      status: live ? 'booked' : 'scheduled',
      stripId,
      stripEdgeIndex: e.index,
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
