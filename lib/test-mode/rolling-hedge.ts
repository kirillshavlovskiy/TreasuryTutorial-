/**
 * Rolling hedge edges when VaR horizon Th is shorter than forecast Tf.
 *
 * One flat Equal-VaR bullet only covers the first Th window. For Tf > Th,
 * book successive forwards: M0–Th from S₀, then Th–2Th from the grown stock
 * S₁ = e(Th), etc.
 */

import type { HedgeTicket } from '@/lib/test-mode/hedge-var';
import {
  equalVarNotionalAtTenureLocalM,
  isLiveHedgeTicket,
  newHedgeTicketId,
} from '@/lib/test-mode/hedge-var';
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
 * - varNeutral → geometric mid (fallback when Equal-VaR context missing)
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
 * Month-net slice for a strip window, rebased so index 0 is window start.
 * Used for per-window Equal-VaR (not path-from-t=0).
 */
export function windowFlowSlice(
  monthlyFlows: readonly number[],
  startMonth: number,
  endMonth: number,
  fallbackFlatF = 0,
): number[] {
  const dt = endMonth - startMonth;
  if (!(dt > 1e-12)) return [];
  const n = Math.max(1, Math.ceil(dt - 1e-12));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = startMonth + i;
    const idx = Math.min(
      Math.max(0, Math.floor(t + 1e-12)),
      Math.max(0, monthlyFlows.length - 1),
    );
    out.push(
      monthlyFlows.length > 0
        ? (monthlyFlows[idx] ?? 0)
        : fallbackFlatF,
    );
  }
  return out;
}

export interface BuildRollingHedgeEdgesOptions {
  /** Overrides ceil(Tf/Th) — equal windows Tf/n (min 1). */
  legCount?: number;
  /**
   * Custom maturity months (uneven strip). Sorted unique ends in (0, Tf];
   * last forced to Tf. When set, overrides equal `legCount` spacing.
   */
  endMonths?: readonly number[];
  /**
   * Currency + full VaR setup — required for per-window Equal-VaR strip VN
   * (path-VaR CoG inside each window; leg count changes final cover).
   */
  ccy?: string;
  varSetup?: VarSetup;
}

/**
 * Sort / clamp custom strip maturities (≤ Tf).
 * Default `forceThroughTf` appends Tf when missing — use `{ forceThroughTf: false }`
 * for applied / WAM-pinned strips that intentionally end earlier.
 */
export function normalizeStripEndMonths(
  raw: readonly number[],
  throughMonths: number,
  opts?: { forceThroughTf?: boolean },
): number[] {
  const Tf =
    typeof throughMonths === 'number' && throughMonths > 1e-12 ? throughMonths : 0;
  if (!(Tf > 1e-12)) return [];
  /** When false, keep the caller’s last settle (editable final date ≤ Tf). */
  const forceThroughTf = opts?.forceThroughTf !== false;
  const cleaned = raw
    .filter(m => typeof m === 'number' && Number.isFinite(m))
    .map(m => Math.round(m * 1000) / 1000)
    .filter(m => m > 1e-9 && m <= Tf + 1e-9);
  const uniq = [...new Set(cleaned)].sort((a, b) => a - b);
  if (uniq.length === 0) return [Tf];
  if (forceThroughTf && Math.abs(uniq[uniq.length - 1]! - Tf) > 1e-6) {
    uniq.push(Tf);
  }
  return [...new Set(uniq.map(m => Math.round(m * 1000) / 1000))].sort(
    (a, b) => a - b,
  );
}

/** Preset window-duration weights (share of Tf); renormalized to sum 1. */
export const STRIP_SCHEDULE_WEIGHT_PRESETS = {
  /** More tenor early — front of the curve. */
  front: [0.4, 0.25, 0.2, 0.15],
  /** More tenor late — back of the curve. */
  back: [0.15, 0.2, 0.25, 0.4],
} as const;

export type StripScheduleWeightPreset = keyof typeof STRIP_SCHEDULE_WEIGHT_PRESETS;

/** Positive weights renormalized to sum 1 (empty if none usable). */
export function normalizeStripScheduleWeights(
  weights: readonly number[],
): number[] {
  const pos = weights.filter(w => typeof w === 'number' && Number.isFinite(w) && w > 0);
  const sum = pos.reduce((a, b) => a + b, 0);
  if (!(sum > 1e-12)) return [];
  return pos.map(w => w / sum);
}

/** Equal window shares for n legs. */
export function equalStripScheduleWeights(legCount: number): number[] {
  const n = Math.max(1, Math.round(legCount));
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * Front / back ramp for `n` strip legs (carry tilt).
 * Front = more Sched % early (low-rate bucket); back = more late (high-rate).
 */
export function rampStripScheduleWeights(
  legCount: number,
  mode: 'front' | 'back' | 'equal',
): number[] {
  const n = Math.max(1, Math.round(legCount));
  if (mode === 'equal') return equalStripScheduleWeights(n);
  const raw = Array.from({ length: n }, (_, i) =>
    mode === 'front' ? n - i : i + 1,
  );
  return normalizeStripScheduleWeights(raw);
}

/**
 * Shape strip Sched-% weights by center of mass + kurtosis.
 *
 * - `centerOfMass` ∈ [0,1]: where weight sits along Tf (0 = front, 0.5 = mid, 1 = back)
 * - `kurtosis` ∈ [-1,1]:
 *     +1 = peaked near CoM (legs execute closer together around the center)
 *      0 = flatter / near-equal
 *     −1 = wings (mass pushed distant from CoM — near & far extremes)
 */
export function shapedStripScheduleWeights(
  legCount: number,
  centerOfMass: number,
  kurtosis: number,
): number[] {
  const n = Math.max(1, Math.round(legCount));
  if (n === 1) return [1];
  const mu = Math.min(0.92, Math.max(0.08, centerOfMass));
  const k = Math.min(1, Math.max(-1, kurtosis));
  // Midpoints of n equal bins on [0,1] — weight each bin by shape, then normalize.
  const xs = Array.from({ length: n }, (_, i) => (i + 0.5) / n);

  if (Math.abs(k) < 0.04 && Math.abs(mu - 0.5) < 0.04) {
    return equalStripScheduleWeights(n);
  }

  let raw: number[];
  if (k >= 0) {
    // Peaked around CoM — σ shrinks as kurtosis → +1.
    const sigma = Math.max(0.055, 0.42 * (1 - 0.88 * k));
    raw = xs.map(x => {
      const z = (x - mu) / sigma;
      return Math.exp(-0.5 * z * z);
    });
  } else {
    // Wings — mass grows with |x − μ|; |k|→1 exaggerates extremes.
    const wing = Math.abs(k);
    raw = xs.map(x => {
      const d = Math.abs(x - mu);
      return (1 - wing) * 1 + wing * (0.12 + d * d * 4);
    });
  }
  return normalizeStripScheduleWeights(raw);
}

/**
 * Set leg `index` to `pinnedFraction` (0–1) and rescale the other legs so
 * the vector still sums to 1 — the edited cell keeps the typed value.
 */
export function pinStripScheduleWeightAt(
  weights: readonly number[],
  index: number,
  pinnedFraction: number,
): number[] {
  const n = weights.length;
  if (n === 0 || index < 0 || index >= n) return [...weights];
  if (n === 1) return [1];
  const pinned = Math.min(0.99, Math.max(0.01, pinnedFraction));
  const base = weights.map(w =>
    typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 0,
  );
  const remain = 1 - pinned;
  let othersSum = 0;
  for (let i = 0; i < n; i++) {
    if (i !== index) othersSum += base[i]!;
  }
  if (othersSum < 1e-12) {
    const each = remain / (n - 1);
    return base.map((_, i) => (i === index ? pinned : each));
  }
  return base.map((w, i) =>
    i === index ? pinned : (w / othersSum) * remain,
  );
}

/**
 * Cumulative settle months from window-duration weights.
 * wᵢ = share of Tf for leg i; ends at Tf.
 */
export function endMonthsFromScheduleWeights(
  weights: readonly number[],
  throughMonths: number,
): number[] {
  const Tf =
    typeof throughMonths === 'number' && throughMonths > 1e-12 ? throughMonths : 0;
  const w = normalizeStripScheduleWeights(weights);
  if (!(Tf > 1e-12) || w.length === 0) return [];
  let cum = 0;
  const raw: number[] = [];
  for (let i = 0; i < w.length; i++) {
    cum += w[i]!;
    if (i === w.length - 1) {
      raw.push(Tf);
    } else {
      raw.push(Math.max(Tf / 24, Math.round(cum * Tf * 100) / 100));
    }
  }
  return normalizeStripEndMonths(raw, Tf);
}

/** Inverse: window weights from settle months (duration / Tf). */
export function scheduleWeightsFromEndMonths(
  endMonths: readonly number[],
  throughMonths: number,
): number[] {
  // Keep caller’s terminal settle (WAM / custom last date may be < Tf).
  const ends = normalizeStripEndMonths(endMonths, throughMonths, {
    forceThroughTf: false,
  });
  const Tf =
    typeof throughMonths === 'number' && throughMonths > 1e-12 ? throughMonths : 0;
  if (!(Tf > 1e-12) || ends.length === 0) return [];
  const widths: number[] = [];
  let prev = 0;
  for (const e of ends) {
    widths.push(Math.max(1e-9, e - prev));
    prev = e;
  }
  return normalizeStripScheduleWeights(widths);
}

/** Notional share of each leg |Δ| / Σ|Δ|. */
export function notionalWeightsFromAmounts(
  amounts: readonly number[],
): number[] {
  const abs = amounts.map(a => Math.abs(a));
  const sum = abs.reduce((a, b) => a + b, 0);
  if (!(sum > 1e-12)) return amounts.map(() => 0);
  return abs.map(a => a / sum);
}

/**
 * Redistribute strip Δ notionals by hedge-share weights (sum→1).
 * Keeps Σ cover and sign; tenures / path context unchanged.
 */
export function applyStripHedgeShareWeights(
  legs: readonly StripForwardLeg[],
  weights: readonly number[],
): StripForwardLeg[] {
  if (legs.length === 0) return [];
  const w = normalizeStripScheduleWeights(weights);
  if (w.length !== legs.length) return legs.map(l => ({ ...l }));
  const total = legs.reduce((s, l) => s + l.amountLocalM, 0);
  const sign = total >= 0 || Math.abs(total) < 1e-12 ? 1 : -1;
  const absTot = Math.abs(total);
  let cumul = 0;
  return legs.map((leg, i) => {
    const amountLocalM = sign * absTot * (w[i] ?? 0);
    cumul += amountLocalM;
    return {
      ...leg,
      amountLocalM,
      cumulCoverLocalM: cumul,
    };
  });
}

/**
 * Build rolling forward edges over the forecast.
 * Flat F or uneven `monthlyFlows` schedule.
 *
 * VaR-neutral: absolute cover = Equal-VaR of that window only
 * (stock at window start, tenure = window length) — not EQ(path 0→Tf).
 * Leg count changes window widths ⇒ changes levels and final cover.
 */
export function buildRollingHedgeEdges(
  stockM: number,
  monthlyFlows: readonly number[],
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'> | VarSetup,
  sizing: RollingEdgeSizing = 'varNeutral',
  options?: BuildRollingHedgeEdgesOptions,
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
  // Keep caller settles as-is (applied optimal strip may end before Tf).
  // Re-locking to Tf here invented a phantom final leg (e.g. M5/M8/M9 → +M12).
  const customEnds =
    options?.endMonths && options.endMonths.length > 0
      ? normalizeStripEndMonths(options.endMonths, Tf, {
          forceThroughTf: false,
        })
      : null;
  const n =
    customEnds != null
      ? customEnds.length
      : typeof options?.legCount === 'number' && Number.isFinite(options.legCount)
        ? Math.max(1, Math.round(options.legCount))
        : nDefault;
  const window = customEnds != null ? 0 : Tf / n;
  const edges: RollingHedgeEdge[] = [];
  const varSetup = options?.varSetup;
  const ccy = options?.ccy;
  const useEqualVarVn =
    sizing === 'varNeutral' &&
    Boolean(varSetup && ccy && typeof ccy === 'string');
  /** Stock Analytics ⇒ VN≡Cash; use growth so strip VN = window Ē ≠ Cash. */
  const eqVarSetup =
    useEqualVarVn && varSetup
      ? varSetupForPathHedgeRegime(varSetup, 'strip')
      : varSetup;
  const flatFlow =
    monthlyFlows.length > 0
      ? monthlyFlows.reduce((a, b) => a + b, 0) / monthlyFlows.length
      : 0;

  for (let k = 0; k < n; k++) {
    const startMonth =
      customEnds != null
        ? k === 0
          ? 0
          : customEnds[k - 1]!
        : k * window;
    if (startMonth >= Tf - 1e-12) break;
    const endMonth =
      customEnds != null
        ? customEnds[k]!
        : Math.min(Tf, startMonth + window);
    if (endMonth <= startMonth + 1e-12) continue;
    const stockStartM = accruedPositionFromScheduleM(S0, monthlyFlows, startMonth);
    const endExposureM = accruedPositionFromScheduleM(S0, monthlyFlows, endMonth);
    const windowLen = endMonth - startMonth;
    const hedgeLocalM =
      useEqualVarVn && eqVarSetup && ccy && windowLen > 1e-12
        ? equalVarNotionalAtTenureLocalM(
            stockStartM,
            flatFlow,
            ccy,
            eqVarSetup,
            windowLen,
            windowFlowSlice(monthlyFlows, startMonth, endMonth, flatFlow),
          )
        : sizeRollingEdgeLocalM(stockStartM, endExposureM, sizing);
    const label =
      Math.abs(endMonth - startMonth - Math.round(endMonth - startMonth)) < 1e-6 &&
      Math.abs(startMonth - Math.round(startMonth)) < 1e-6
        ? `M${Math.round(startMonth)}–M${Math.round(endMonth)}`
        : `t=${startMonth.toFixed(1)}–${endMonth.toFixed(1)}`;
    edges.push({
      index: edges.length,
      startMonth,
      endMonth,
      stockStartM,
      endExposureM,
      hedgeLocalM,
      label,
    });
  }

  /**
   * Total (windowEnd) regime must cover full E(Tf). Custom settle ladders
   * (optimal strip / WAM) often end before Tf — without this, last cover
   * stays at E(lastSettle) and the path chart looks underhedged vs E_end
   * even though Target was selected. Keep settles; bump final absolute level.
   */
  if (sizing === 'windowEnd' && edges.length > 0) {
    const eTf = accruedPositionFromScheduleM(S0, monthlyFlows, Tf);
    const last = edges[edges.length - 1]!;
    const sign =
      Math.abs(eTf) > 1e-12
        ? eTf >= 0
          ? 1
          : -1
        : last.hedgeLocalM >= 0
          ? 1
          : -1;
    const targetAbs = Math.abs(eTf);
    if (Math.abs(Math.abs(last.hedgeLocalM) - targetAbs) > 1e-9) {
      last.hedgeLocalM = sign * targetAbs;
    }
  }

  return edges;
}

/**
 * Rebuild active strip ladder when some forwards are unticked.
 * Unticked Δ notionals fold into the next ticked maturity (e.g. untick M0–M3
 * → M0–M6 size = former M3+M6). Maturities stay on the kept forwards.
 * Trailing unticked Δ folds into the last ticked leg.
 */
export function packSelectedStripEdges(
  edges: readonly RollingHedgeEdge[],
  amountsByIndex: ReadonlyMap<number, number> | readonly { index: number; amountLocalM: number }[],
  enabled: Readonly<Record<number, boolean>>,
  throughMonths: number,
): RollingHedgeEdge[] {
  const Tf =
    typeof throughMonths === 'number' && throughMonths > 1e-12 ? throughMonths : 0;
  if (edges.length === 0 || Tf <= 1e-12) return [];
  const amountOf = (index: number): number => {
    if (amountsByIndex instanceof Map) return amountsByIndex.get(index) ?? 0;
    const list = amountsByIndex as readonly {
      index: number;
      amountLocalM: number;
    }[];
    const hit = list.find(a => a.index === index);
    return hit?.amountLocalM ?? 0;
  };

  let pending = 0;
  const folded: { edge: RollingHedgeEdge; amountLocalM: number }[] = [];
  for (const e of edges) {
    const amt = amountOf(e.index);
    if (enabled[e.index] === false) {
      pending += amt;
      continue;
    }
    folded.push({ edge: e, amountLocalM: pending + amt });
    pending = 0;
  }
  if (folded.length === 0) return [];
  if (Math.abs(pending) > 1e-12) {
    const last = folded[folded.length - 1]!;
    last.amountLocalM += pending;
  }

  let cumul = 0;
  let t0 = 0;
  const out: RollingHedgeEdge[] = [];
  for (const { edge, amountLocalM } of folded) {
    cumul += amountLocalM;
    const endMonth = Math.min(Tf, Math.max(t0, edge.endMonth));
    const label =
      Math.abs(endMonth - Math.round(endMonth)) < 1e-6
        ? `M0–M${Math.round(endMonth)}`
        : `M0–t${endMonth.toFixed(1)}`;
    out.push({
      ...edge,
      startMonth: t0,
      endMonth,
      hedgeLocalM: cumul,
      label,
    });
    t0 = endMonth;
  }
  return out;
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

/**
 * Continuous path-matching cover for Target strip resid.
 *
 * Knots: (0, H₀), (T₀, H₀), (T₁, H₁), …, (Tₙ₋₁, Hₙ₋₁) with Hₖ = cumul at
 * window end (= e(Tₖ) for Target). First window: hold H₀ until T₀ (match).
 * Later windows: ramp Hₖ₋₁→Hₖ with e → resid ≈ 0 on a linear path. More
 * legs → shorter unmatched first window → resid → flat ~0 line.
 */
export function rollingHedgeSmoothAtMonth(
  edges: readonly RollingHedgeEdge[],
  t: number,
): number {
  if (edges.length === 0) return 0;
  const H0 = edges[0]!.hedgeLocalM;
  const t0 = edges[0]!.endMonth;
  const knots: { t: number; H: number }[] = [
    { t: 0, H: H0 },
    { t: t0, H: H0 },
  ];
  for (let i = 1; i < edges.length; i++) {
    const e = edges[i]!;
    const prev = knots[knots.length - 1]!;
    if (Math.abs(e.endMonth - prev.t) < 1e-12) {
      prev.H = e.hedgeLocalM;
    } else {
      knots.push({ t: e.endMonth, H: e.hedgeLocalM });
    }
  }
  if (t <= knots[0]!.t) return knots[0]!.H;
  const last = knots[knots.length - 1]!;
  if (t >= last.t) return last.H;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i]!;
    const b = knots[i + 1]!;
    if (t + 1e-12 >= a.t && t <= b.t + 1e-12) {
      const span = b.t - a.t;
      if (span <= 1e-12) return b.H;
      const u = (t - a.t) / span;
      return a.H + u * (b.H - a.H);
    }
  }
  return last.H;
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
  /**
   * Economic settle months from M0 keyed by edge index (cash delivery mode).
   * Defaults to each leg’s window-end tenure.
   */
  settleMonthsByEdgeIndex?: Readonly<Record<number, number>>,
): HedgeTicket[] {
  if (edges.length === 0) return [];
  const stripId = `strip-${ccy}-${newHedgeTicketId()}`;
  const tickets: HedgeTicket[] = [];
  for (const leg of stripForwardLegsFromEdges(edges)) {
    const settleMonths =
      settleMonthsByEdgeIndex?.[leg.index] ?? leg.tenureMonths;
    const maturity = edgeMaturityHorizonId(settleMonths, setup.horizon);
    const maturityLabel =
      VAR_HORIZON_OPTIONS.find(h => h.id === maturity)?.label ?? maturity;
    const settleTag =
      Math.abs(settleMonths - Math.round(settleMonths)) < 1e-6
        ? `M${Math.round(settleMonths)}`
        : `t=${settleMonths.toFixed(1)}`;
    tickets.push({
      id: newHedgeTicketId(),
      ccy,
      instrument: 'forward',
      basis,
      amountLocalM: leg.amountLocalM,
      maturity,
      maturityLabel: `${leg.label} · settle ${settleTag} · ${maturityLabel}`,
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
    { ccy, varSetup: setup },
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

/** Drop all strip legs for a CCY (bullet regime / clear Decision strip). */
export function clearRollingStripForCcy(
  booked: readonly HedgeTicket[],
  ccy: string,
): HedgeTicket[] {
  return booked.filter(t => !(t.ccy === ccy && t.stripId));
}

/** Nearest Cash / VN / Target sizing for a live M0 hedge notional. */
export function inferRollingEdgeSizing(
  hedgeLocalM: number,
  stockStartM: number,
  endExposureM: number,
  /** Equal-VaR at first edge end (preferred VN reference). */
  equalVarLocalM?: number,
): RollingEdgeSizing {
  const h = Math.abs(hedgeLocalM);
  const vn =
    typeof equalVarLocalM === 'number' && Number.isFinite(equalVarLocalM)
      ? Math.abs(equalVarLocalM)
      : Math.abs((stockStartM + endExposureM) / 2);
  const opts: { id: RollingEdgeSizing; n: number }[] = [
    { id: 'stockStart', n: Math.abs(stockStartM) },
    { id: 'varNeutral', n: vn },
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
    const edgeOpts = { ccy, varSetup: setup };
    const probe = buildRollingHedgeEdges(
      bar.stockNetM,
      flows,
      setup,
      'windowEnd',
      edgeOpts,
    );
    if (probe.length === 0) continue;
    const flatF =
      flows.length > 0
        ? flows.reduce((a, b) => a + b, 0) / flows.length
        : bar.flowM;
    const w0 = probe[0]!;
    const eqFirst = equalVarNotionalAtTenureLocalM(
      w0.stockStartM,
      flatF,
      ccy,
      varSetupForPathHedgeRegime(setup, 'strip'),
      Math.max(1e-9, w0.endMonth - w0.startMonth),
      windowFlowSlice(flows, w0.startMonth, w0.endMonth, flatF),
    );
    const sizing = inferRollingEdgeSizing(
      live.amountLocalM,
      probe[0]!.stockStartM,
      probe[0]!.endExposureM,
      eqFirst,
    );
    // Re-infer against the chosen sizing’s first edge for a tighter match.
    const edges = buildRollingHedgeEdges(
      bar.stockNetM,
      flows,
      setup,
      sizing,
      edgeOpts,
    );
    if (edges.length === 0) continue;
    // Always pass true Equal-VaR — not edge.hedgeLocalM (for Target that
    // equals E_end and would tie VN vs windowEnd, picking VN wrongly).
    const refined = inferRollingEdgeSizing(
      live.amountLocalM,
      edges[0]!.stockStartM,
      edges[0]!.endExposureM,
      eqFirst,
    );
    const finalEdges =
      refined === sizing
        ? edges
        : buildRollingHedgeEdges(
            bar.stockNetM,
            flows,
            setup,
            refined,
            edgeOpts,
          );
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
