import {
  fcyToUsdM,
  fxBookNetLocalM,
  roundMoney,
  usdToFcyM,
  type RowState,
} from '@/lib/fx-buffer';
import {
  effectiveMonthlyFlowLocalM,
  monthlyFlowSeriesLocalM,
  periodFlowSumLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import { computeTaskVar } from '@/lib/test-mode/task-var';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  DEFAULT_VAR_SETUP,
  VAR_HORIZON_OPTIONS,
  accruedForecastMonths,
  accruedPositionFromScheduleM,
  buildupLocalMForBasis,
  computeAnalyticsVarUsdM,
  computeGrowingExposureVarUsdM,
  computeParametricVarUsdM,
  exposureLocalMForBasis,
  horizonMonths,
  linearBulletNotionalFromVarUsdM,
  type VarExposureBasis,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import type { VarConfidencePct } from '@/lib/test-mode/var-confidence';

/** Per-row Risk Metrics cell data for the FX table (VaR before P&L). */
export interface RowRiskMetric {
  ccy: string;
  exposureLocalM: number;
  varUsdM: number;
}

/** FX Risk table metrics including Decision-layer spot/forward hedges. */
export interface FxTableRiskMetric extends RowRiskMetric {
  /** Residual exposure after booked + incremental hedges (Analytics basis). */
  residualLocalM: number;
  varBeforeUsdM: number;
  /** Signed booked + attributed incremental spot hedge (local M). */
  spotHedgeLocalM: number;
  /** Signed booked + attributed incremental forward hedge (local M). */
  forwardHedgeLocalM: number;
}

/**
 * Stock / Net FX book for exposure math (same as workspace Net FX):
 *   Cash FX + Fwd + Receivables + Liability + Investments − Debt
 * NordTech EUR unhedged: 2.5 + 2.4 − 3.0 = 1.9
 */
export function fxStockExposureLocalM(row: RowState): number {
  return fxBookNetLocalM(row);
}

/** Forecast / flow buildup for avg exposure (collections + payout + fcastFX). */
export function fxFlowLocalM(row: RowState): number {
  return row.collections + row.payout + (row.fcastFX ?? 0);
}

/**
 * Hedge-target exposure for Risk Metrics Exp:
 *   Net FX Forecast = Net FX book + period flow (F×T or custom Σ)
 * This is what the book is trying to hedge — not Analytics "stock only".
 */
export function fxHedgeTargetLocalM(
  row: RowState,
  forecastMonths: number = 1,
  forecastProfile?: ForecastProfileState | null,
): number {
  const T = Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1;
  return roundMoney(
    fxBookNetLocalM(row) + periodFlowSumLocalM(row, T, forecastProfile),
  );
}

/** Exposure for Analytics basis on a live simulator row. */
export function fxExposureForBasis(
  row: RowState,
  basis: VarSetup['exposureBasis'],
  forecastMonths: number = 1,
  forecastProfile?: ForecastProfileState | null,
): number {
  const T = Number.isFinite(forecastMonths) && forecastMonths >= 0 ? forecastMonths : 1;
  // When a custom period profile is active, feed an equivalent monthly flow
  // so existing S + F×T / S + ½×F×T helpers stay correct (F_eff × T = Σ months).
  const flowM = effectiveMonthlyFlowLocalM(row, T, forecastProfile);
  return exposureLocalMForBasis(
    fxStockExposureLocalM(row),
    flowM,
    basis,
    T,
  );
}

export function exposureFromRiskRow(
  row: CurrencyRiskRow,
  basis: VarSetup['exposureBasis'],
  forecastMonths: number = 1,
): number {
  return exposureLocalMForBasis(
    row.bar.stockNetM,
    row.bar.flowM,
    basis,
    forecastMonths,
  );
}

/** Build VaR-before-hedge metrics from live simulator FX rows. */
export function riskMetricsFromRows(
  rows: RowState[],
  setupOrConfidence: VarSetup | VarConfidencePct = 95,
): RowRiskMetric[] {
  return fxTableRiskMetrics(rows, setupOrConfidence).map(
    ({ ccy, exposureLocalM, varBeforeUsdM }) => ({
      ccy,
      exposureLocalM,
      varUsdM: varBeforeUsdM,
    }),
  );
}

/**
 * FX Risk table metrics: Exp = Net FX Forecast (hedge target), plus booked
 * spot/forward hedge structure, residual, and path-integrated VaR.
 *
 * Exp follows Exposure period (F×T / custom profile) — hedge notional target.
 * VaR uses linearly growing book e(t)=S+F·t over the VaR tenure (√∫ e² dt),
 * not snapshot |E_end|×σ×√T (which overstates risk on a building pipeline).
 *
 * Tickets are exposure-signed (long → SELL hedge). Hedge columns show the
 * offsetting position (−ticket), so Residual = Exp + Spot hedge + Fwd hedge.
 *
 * `hedgeRatios` (Decision-layer Hedge-add %) is optional staging math. The FX
 * Risk table should pass `{}` so Residual/VaR stay on the open book until a
 * trade is actually booked.
 */
export function fxTableRiskMetrics(
  rows: RowState[],
  setupOrConfidence: VarSetup | VarConfidencePct = 95,
  bookedTickets: readonly HedgeTicket[] = [],
  hedgeRatios: Record<string, number> = {},
  forecastProfile?: ForecastProfileState | null,
): FxTableRiskMetric[] {
  const setup: VarSetup =
    typeof setupOrConfidence === 'number'
      ? { ...DEFAULT_VAR_SETUP, confidencePct: setupOrConfidence }
      : setupOrConfidence;

  return rows
    .filter(r => r.ccy !== 'USD')
    .map(r => {
      const stockM = fxBookNetLocalM(r);
      const T =
        typeof setup.forecastMonths === 'number' && setup.forecastMonths >= 0
          ? setup.forecastMonths
          : 1;
      const schedule =
        T > 0 ? monthlyFlowSeriesLocalM(r, T, forecastProfile) : [];
      const monthlyFlowM = effectiveMonthlyFlowLocalM(r, T > 0 ? T : 1, forecastProfile);
      const flowForPath = T > 0 ? monthlyFlowM : 0;
      const exposureLocalM = fxHedgeTargetLocalM(r, T, forecastProfile);
      const tickets = bookedTickets.filter(
        t => t.ccy === r.ccy && isLiveHedgeTicket(t),
      );
      let spotBooked = 0;
      let forwardBooked = 0;
      for (const t of tickets) {
        if (t.instrument === 'spot') spotBooked += t.amountLocalM;
        else forwardBooked += t.amountLocalM; // forward + option notionals
      }
      const bookedAmt = spotBooked + forwardBooked;
      // Chip apply (Total E_end) may exceed 100% of Equal-VaR.
      const ratio = Math.max(0, hedgeRatios[r.ccy] ?? 0);
      const incremental = (exposureLocalM - bookedAmt) * ratio;
      // Position sign: opposite of exposure-signed ticket (SELL long → short hedge).
      const spotHedgeLocalM = -spotBooked;
      const forwardHedgeLocalM = -forwardBooked;
      const totalHedgeLocalM = bookedAmt + incremental;
      const residualLocalM =
        exposureLocalM + spotHedgeLocalM + forwardHedgeLocalM - incremental;
      // Constant hedge notional shifts the path: e_res(t) = (S − B) + F·t.
      const stockAfterHedgeM = stockM - totalHedgeLocalM;
      const flows = schedule.length > 0 ? schedule : undefined;
      const varBeforeUsdM = computeAnalyticsVarUsdM(
        stockM,
        flowForPath,
        r.ccy,
        setup,
        flows,
      );
      const varUsdM = computeAnalyticsVarUsdM(
        stockAfterHedgeM,
        flowForPath,
        r.ccy,
        setup,
        flows,
      );
      return {
        ccy: r.ccy,
        exposureLocalM,
        residualLocalM,
        varBeforeUsdM,
        varUsdM,
        spotHedgeLocalM,
        forwardHedgeLocalM,
      };
    });
}

export interface HedgeVarRow {
  ccy: string;
  direction: 'long' | 'short' | 'hub';
  /**
   * Net book on this Analytics basis after booked hedges (before Hedge-add %).
   * 0 when booked trades fully cover the open exposure.
   */
  exposureLocalM: number;
  /** Original Analytics exposure before any booked hedges (Δ = 1 basis). */
  openExposureLocalM: number;
  hedgeRatio: number;
  /**
   * VaR delta: varAfter / varBefore — 1 = unhedged, 0 = equal-VaR hedge fully offsets.
   * (Not |residual|/|open| — path VaR can be matched by a smaller bullet notional.)
   */
  delta: number;
  /**
   * Incremental Decision hedge notional (local M) = Target × Hedge-add %.
   * 100% = full Total expected (Target); Cash / VaR-neutral sit below that.
   */
  hedgeNotionalLocalM: number;
  /**
   * 100% Decision reference — Total expected over the forecast (net of booked).
   * Hedge-add % scales this, not Equal-VaR.
   */
  targetHedgeLocalM: number;
  /** Cash / stock exposure net of booked (Decision min meaningful hedge). */
  stockHedgeLocalM: number;
  /**
   * VaR-neutral (Equal-VaR linear bullet) for the working book — Decision mid.
   * |N| ≤ |accrued forecast position at min(Th,Tf)|.
   */
  equalVarHedgeLocalM: number;
  /** True when equal-VaR size was capped by accrued position (cannot fully offset VaR). */
  hedgeCapped: boolean;
  residualLocalM: number;
  /** VaR on open (unhedged) exposure — always the Δ = 1 figure. */
  varBeforeUsdM: number;
  /** VaR after booked + equal-VaR Hedge-add % (linear opposite-VaR offset). */
  varAfterUsdM: number;
}

/**
 * Accrued exposure by VaR horizon — upper bound for a bullet hedge notional:
 *   g = min(Th, Tf)
 *   stock → S
 *   avg   → S + ½×F×g
 *   path  → S + F×g
 */
export function accruedPositionLocalM(
  stockM: number,
  monthlyFlowM: number,
  basis: VarExposureBasis,
  setup: Pick<VarSetup, 'horizon' | 'forecastMonths'>,
): number {
  const g = accruedForecastMonths(horizonMonths(setup.horizon), setup.forecastMonths);
  const F =
    g > 0 && Number.isFinite(monthlyFlowM) ? monthlyFlowM : 0;
  const S = Number.isFinite(stockM) ? stockM : 0;
  if (basis === 'stock') return S;
  if (basis === 'simpleAvg' || basis === 'avgBuildup') return S + 0.5 * F * g;
  return S + F * g;
}

/**
 * Accrued (end-of-window) position at Th — physical forecast buildup / hedge cap.
 * Weighted-avg VaR uses time-avg Ē=(1/T)∫e dt; Exposure @ Δ1 always shows end.
 * Optional `monthlyFlows` = custom uneven schedule (overrides flat F).
 */
export function analyticsOpenExposureLocalM(
  stockM: number,
  monthlyFlowM: number,
  setup: Pick<VarSetup, 'exposureBasis' | 'horizon' | 'forecastMonths'>,
  monthlyFlows?: readonly number[],
): number {
  if (setup.exposureBasis === 'stock') {
    return Number.isFinite(stockM) ? stockM : 0;
  }
  const Th = horizonMonths(setup.horizon);
  if (setup.exposureBasis === 'simpleAvg') {
    if (monthlyFlows && monthlyFlows.length > 0) {
      const end = accruedPositionFromScheduleM(stockM, monthlyFlows, Th);
      const S = Number.isFinite(stockM) ? stockM : 0;
      return (S + end) / 2;
    }
    return accruedPositionLocalM(stockM, monthlyFlowM, 'simpleAvg', setup);
  }
  // Weighted avg / growth path: Exposure @ Δ1 = end buildup
  if (monthlyFlows && monthlyFlows.length > 0) {
    return accruedPositionFromScheduleM(stockM, monthlyFlows, Th);
  }
  return accruedPositionLocalM(stockM, monthlyFlowM, 'totalBuildup', setup);
}

/**
 * Equal-VaR linear hedge notional (exposure-signed):
 * invert Analytics VaR through the bullet formula |N|×σ×√Th×z, then cap by
 * |accrued end position at Th| (not by Ē).
 *
 * Weighted avg: VaR uses Ē=(1/T)∫e ⇒ |N|≈Ē ≪ |E_end| on a growing book.
 * Growth path: |N| = RMS-equivalent ≪ |E_end|. Cap binds when forecast-u
 * inflates VaR above what a bullet on the accrued position can offset.
 */
export function equalVarLinearHedgeNotionalLocalM(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: VarSetup,
  pathVarUsdM?: number,
  monthlyFlows?: readonly number[],
): { amountLocalM: number; uncappedAbsLocalM: number; capped: boolean } {
  const varUsd =
    typeof pathVarUsdM === 'number'
      ? pathVarUsdM
      : computeAnalyticsVarUsdM(stockM, monthlyFlowM, ccy, setup, monthlyFlows);
  const uncappedAbs = linearBulletNotionalFromVarUsdM(varUsd, ccy, setup);
  // Cap / sign from accrued end (Exposure @ Δ1) — never from Ē (that made N≡Exposure on avg).
  const end = analyticsOpenExposureLocalM(
    stockM,
    monthlyFlowM,
    setup,
    monthlyFlows,
  );
  const capAbs = Math.abs(end);
  const sign = end >= 0 ? 1 : -1;
  const cappedAbs = Math.min(uncappedAbs, capAbs);
  const capped = uncappedAbs > capAbs + 1e-12;
  return {
    amountLocalM: sign * cappedAbs,
    uncappedAbsLocalM: uncappedAbs,
    capped,
  };
}

export interface HedgeVarSummary {
  rows: HedgeVarRow[];
  totalVarBeforeUsdM: number;
  totalVarAfterUsdM: number;
  varReductionUsdM: number;
  setup: VarSetup;
  /** @deprecated use setup.confidencePct */
  confidencePct: VarConfidencePct;
}

/** @deprecated prefer computeParametricVarUsdM with full setup */
export function computeVarOnExposure(
  ccy: string,
  exposureLocalM: number,
  confidencePct: VarConfidencePct = 95,
): number {
  return computeParametricVarUsdM(exposureLocalM, ccy, {
    confidencePct,
    horizon: '1m',
  });
}

/** Hedge instrument for a booked decision-layer trade. */
export type HedgeInstrument = 'spot' | 'forward' | 'option';

/** Live trade vs future roll leg (not yet executable). */
export type HedgeTicketStatus = 'booked' | 'scheduled';

export interface HedgeTicket {
  /** Stable id for the booked-transactions list / cancellation. */
  id: string;
  ccy: string;
  /** Spot / forward / option — chosen at book time (not forced by exposure basis). */
  instrument: HedgeInstrument;
  basis: VarExposureBasis;
  /** Local FCY millions to hedge (signed with exposure). */
  amountLocalM: number;
  /** Forward / option tenor; null for spot. */
  maturity: VarHorizonId | null;
  maturityLabel: string | null;
  varUsdM: number;
  /** True when this basis has the higher VaR of stock vs avg. */
  addressesHigherVar: boolean;
  /** Owning entity id — rolls into Group FX consolidation. */
  entityId?: string;
  /** Display name for consolidated booked-hedge lists. */
  entityName?: string;
  /**
   * `scheduled` = planned roll (not traded yet) — excluded from VaR / positions.
   * Omit or `booked` = live ticket.
   */
  status?: HedgeTicketStatus;
  /** Shared id for a rolling strip (M0 live + later scheduled legs). */
  stripId?: string;
  /** 0-based edge index within the strip. */
  stripEdgeIndex?: number;
}

/** Live (traded) tickets — scheduled strip legs do not count. */
export function isLiveHedgeTicket(t: HedgeTicket): boolean {
  return t.status !== 'scheduled';
}

export function liveHedgeTickets(
  tickets: readonly HedgeTicket[],
): HedgeTicket[] {
  return tickets.filter(isLiveHedgeTicket);
}

/** Scope key for hedges booked on the Group FX consolidated book. */
export const GROUP_HEDGE_SCOPE = '__group__';

/** Per-entity (or group-scope) Decision-layer hedge book. */
export interface EntityHedgeBook {
  bookedHedges: HedgeTicket[];
  hedgeRatios: Record<string, number>;
}

export function emptyHedgeBook(): EntityHedgeBook {
  return { bookedHedges: [], hedgeRatios: {} };
}

/** Flatten entity (+ optional group) booked tickets for consolidated metrics. */
export function aggregateBookedHedges(
  hedgesByEntityId: Record<string, EntityHedgeBook | undefined>,
  entityIds: readonly string[],
  includeGroup = true,
): HedgeTicket[] {
  const out: HedgeTicket[] = [];
  for (const id of entityIds) {
    const book = hedgesByEntityId[id];
    if (book?.bookedHedges.length) out.push(...book.bookedHedges);
  }
  if (includeGroup) {
    const g = hedgesByEntityId[GROUP_HEDGE_SCOPE];
    if (g?.bookedHedges.length) out.push(...g.bookedHedges);
  }
  return out;
}

/**
 * Write a consolidated ticket list back into per-entity books.
 * Tickets without a matching entityId land on the group scope.
 */
export function applyConsolidatedBookedChange(
  nextTickets: readonly HedgeTicket[],
  entityIds: readonly string[],
  prev: Record<string, EntityHedgeBook | undefined>,
): Record<string, EntityHedgeBook> {
  const allowed = new Set(entityIds);
  const buckets: Record<string, HedgeTicket[]> = { [GROUP_HEDGE_SCOPE]: [] };
  for (const id of entityIds) buckets[id] = [];

  for (const t of nextTickets) {
    const key =
      t.entityId && allowed.has(t.entityId) ? t.entityId : GROUP_HEDGE_SCOPE;
    (buckets[key] ??= []).push(t);
  }

  const out: Record<string, EntityHedgeBook> = { ...prev } as Record<
    string,
    EntityHedgeBook
  >;
  for (const id of entityIds) {
    out[id] = {
      bookedHedges: buckets[id] ?? [],
      hedgeRatios: prev[id]?.hedgeRatios ?? {},
    };
  }
  out[GROUP_HEDGE_SCOPE] = {
    bookedHedges: buckets[GROUP_HEDGE_SCOPE] ?? [],
    hedgeRatios: prev[GROUP_HEDGE_SCOPE]?.hedgeRatios ?? {},
  };
  return out;
}

/** New ticket id for each book confirmation. */
export function newHedgeTicketId(): string {
  return `ht-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Prefer a live booked ticket on the active Analytics basis; else any live ticket for the CCY. */
export function bookedTicketForCcy(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
  preferredBasis?: VarExposureBasis,
): HedgeTicket | undefined {
  const forCcy = bookedTickets.filter(
    t => t.ccy === ccy && isLiveHedgeTicket(t),
  );
  if (forCcy.length === 0) return undefined;
  if (preferredBasis) {
    const match = forCcy.find(t => t.basis === preferredBasis);
    if (match) return match;
  }
  return forCcy[0];
}

/** Signed live booked notional for a CCY (scheduled strip legs excluded). */
export function bookedNotionalLocalM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
): number {
  return bookedTickets
    .filter(t => t.ccy === ccy && isLiveHedgeTicket(t))
    .reduce((s, t) => s + t.amountLocalM, 0);
}

/** Additive FX POSITION adjustments from Decision-layer tickets (book sign). */
export interface BookedPositionOffset {
  spotLocalM: number;
  fwdLocalM: number;
}

/**
 * Map booked hedges into FX POSITION offsets.
 * Tickets are exposure-signed (long → SELL); the position book records the
 * offsetting short spot/forward leg (−amount).
 */
export function bookedPositionOffsetsByCcy(
  bookedTickets: readonly HedgeTicket[],
): Record<string, BookedPositionOffset> {
  const map: Record<string, BookedPositionOffset> = {};
  for (const t of bookedTickets) {
    if (!isLiveHedgeTicket(t)) continue;
    const cur = map[t.ccy] ?? { spotLocalM: 0, fwdLocalM: 0 };
    if (t.instrument === 'spot') cur.spotLocalM -= t.amountLocalM;
    else cur.fwdLocalM -= t.amountLocalM; // forward + option → FWD position overlay
    map[t.ccy] = cur;
  }
  return map;
}

/** Apply booked Decision-layer hedges onto simulator rows for FWD/Spot display. */
export function applyBookedHedgePositions(
  rows: RowState[],
  bookedTickets: readonly HedgeTicket[],
): RowState[] {
  if (!bookedTickets.length) return rows;
  const offsets = bookedPositionOffsetsByCcy(bookedTickets);
  return rows.map(r => {
    const o = offsets[r.ccy];
    if (!o) return r;
    if (Math.abs(o.spotLocalM) < 1e-12 && Math.abs(o.fwdLocalM) < 1e-12) return r;
    const fwdFcy = usdToFcyM(r.fwd, r.ccy) + o.fwdLocalM;
    return {
      ...r,
      spot: r.spot + o.spotLocalM,
      fwd: fcyToUsdM(fwdFcy, r.ccy),
    };
  });
}

/**
 * Hedging Decision / Live Ladder / Analytics rows.
 *
 * Decision Hedge-add % is of Total expected (Target):
 *   0% → unhedged · Cash → stock/Target · VaR-neutral → Equal-VaR/Target · 100% → Target
 * Open VaR still uses the Analytics engine at Th; Equal-VaR is the mid reference only.
 */
export function buildHedgeVarSummary(
  risk: CurrencyRiskRow[],
  hedgeRatios: Record<string, number> = {},
  setupOrConfidence: VarSetup | VarConfidencePct = 95,
  bookedTickets: readonly HedgeTicket[] = [],
  /** Per-CCY custom month nets; when set, Analytics VaR uses the uneven schedule. */
  monthlyFlowsByCcy: Record<string, readonly number[]> = {},
): HedgeVarSummary {
  const setup: VarSetup =
    typeof setupOrConfidence === 'number'
      ? { ...DEFAULT_VAR_SETUP, confidencePct: setupOrConfidence }
      : setupOrConfidence;

  const rows: HedgeVarRow[] = risk
    .filter(r => r.bar.ccy !== 'USD')
    .map(row => {
      const { bar } = row;
      const stockM = bar.stockNetM;
      const flowM =
        setup.forecastMonths > 0 && Math.abs(bar.flowM) > 1e-15 ? bar.flowM : 0;
      const schedule = monthlyFlowsByCcy[bar.ccy];
      const flows =
        schedule && schedule.length > 0 ? schedule : undefined;
      // Open exposure at Th: avg/path accrue with g=min(Th,Tf) — not full F×Tf.
      const openLocalM = analyticsOpenExposureLocalM(
        stockM,
        flowM,
        setup,
        flows,
      );
      const bookedAmt = bookedNotionalLocalM(bookedTickets, bar.ccy);
      // Working book after settled hedges (incremental % applies here).
      const exposureLocalM = openLocalM - bookedAmt;
      // Decision ladder: 100% = Total expected over full forecast (Target).
      const Tf = setup.forecastMonths;
      const totalRaw =
        flows && flows.length > 0 && Tf > 0
          ? accruedPositionFromScheduleM(stockM, flows, Tf)
          : exposureLocalMForBasis(stockM, flowM, 'totalBuildup', Tf);
      const stockHedgeLocalM = stockM - bookedAmt;
      const targetHedgeLocalM = totalRaw - bookedAmt;
      // Hedge-add % of Target (0–100%).
      const ratio = Math.min(1, Math.max(0, hedgeRatios[bar.ccy] ?? 0));

      const varBeforeUsdM = computeAnalyticsVarUsdM(
        stockM,
        flowM,
        bar.ccy,
        setup,
        flows,
      );
      // Booked tickets as linear bullets (opposite VaR); size remaining on residual VaR.
      const bookedVarUsdM = computeParametricVarUsdM(bookedAmt, bar.ccy, setup);
      const varAfterBookUsdM = Math.max(0, varBeforeUsdM - bookedVarUsdM);
      const eq = equalVarLinearHedgeNotionalLocalM(
        stockM,
        flowM,
        bar.ccy,
        setup,
        varAfterBookUsdM,
        flows,
      );
      // Cap remaining equal-VaR size by leftover accrued capacity after booked.
      const accruedCap = analyticsOpenExposureLocalM(
        stockM,
        flowM,
        setup,
        flows,
      );
      const remainCapAbs = Math.max(0, Math.abs(accruedCap) - Math.abs(bookedAmt));
      const equalAbs = Math.min(Math.abs(eq.amountLocalM), remainCapAbs);
      const sign =
        Math.abs(targetHedgeLocalM) > 1e-12
          ? targetHedgeLocalM >= 0
            ? 1
            : -1
          : openLocalM >= 0
            ? 1
            : -1;
      const equalVarHedgeLocalM = sign * equalAbs;
      const hedgeNotionalLocalM = targetHedgeLocalM * ratio;
      const hedgeVarUsdM = computeParametricVarUsdM(
        hedgeNotionalLocalM,
        bar.ccy,
        setup,
      );
      const varAfterUsdM = Math.max(0, varAfterBookUsdM - hedgeVarUsdM);
      const residualLocalM = openLocalM - bookedAmt - hedgeNotionalLocalM;
      const delta =
        varBeforeUsdM < 1e-12
          ? 0
          : Math.min(1, Math.max(0, varAfterUsdM / varBeforeUsdM));
      const hedgeCapped =
        eq.uncappedAbsLocalM > Math.abs(accruedCap) + 1e-12 ||
        eq.uncappedAbsLocalM > remainCapAbs + Math.abs(bookedAmt) + 1e-12;

      return {
        ccy: bar.ccy,
        direction: bar.direction,
        exposureLocalM,
        openExposureLocalM: openLocalM,
        hedgeRatio: ratio,
        delta,
        hedgeNotionalLocalM,
        targetHedgeLocalM,
        stockHedgeLocalM,
        equalVarHedgeLocalM,
        hedgeCapped,
        residualLocalM,
        varBeforeUsdM,
        varAfterUsdM,
      };
    });

  const totalVarBeforeUsdM = rows.reduce((s, r) => s + r.varBeforeUsdM, 0);
  const totalVarAfterUsdM = rows.reduce((s, r) => s + r.varAfterUsdM, 0);
  return {
    rows,
    totalVarBeforeUsdM,
    totalVarAfterUsdM,
    varReductionUsdM: totalVarBeforeUsdM - totalVarAfterUsdM,
    setup,
    confidencePct: setup.confidencePct,
  };
}

export function stockVarMatches(
  row: CurrencyRiskRow,
  confidencePct: VarConfidencePct = 95,
): boolean {
  return (
    Math.abs(
      row.varStock.varUsdM - computeTaskVar(row.bar, 'stock', confidencePct).varUsdM,
    ) < 1e-12
  );
}

/**
 * Build a bookable hedge ticket sized for equal opposite VaR (linear bullet).
 * - stock → spot @ equal-VaR notional (≈ |S| when u=0)
 * - avg / growth → forward @ VaR horizon, |N| from invert(VaR) ≤ accrued @ Th
 */
export function proposeBookHedge(
  row: CurrencyRiskRow,
  basis: VarExposureBasis,
  setup: Pick<
    VarSetup,
    'confidencePct' | 'horizon' | 'forecastMonths' | 'forecastUncertainty1m' | 'exposureBasis'
  > | VarSetup,
): HedgeTicket {
  const fullSetup: VarSetup = {
    ...DEFAULT_VAR_SETUP,
    ...setup,
    exposureBasis: basis,
  };
  const stockM = row.bar.stockNetM;
  const flowM =
    fullSetup.forecastMonths > 0 && Math.abs(row.bar.flowM) > 1e-15
      ? row.bar.flowM
      : 0;
  const pathVar = computeAnalyticsVarUsdM(stockM, flowM, row.bar.ccy, fullSetup);
  const { amountLocalM } = equalVarLinearHedgeNotionalLocalM(
    stockM,
    flowM,
    row.bar.ccy,
    fullSetup,
    pathVar,
  );
  const varUsdM = computeParametricVarUsdM(amountLocalM, row.bar.ccy, fullSetup);

  const candidates: VarExposureBasis[] = [
    'stock',
    'simpleAvg',
    'avgBuildup',
    'totalBuildup',
  ];
  let higher: VarExposureBasis = 'stock';
  let higherVar = -Infinity;
  for (const b of candidates) {
    const v = computeAnalyticsVarUsdM(stockM, flowM, row.bar.ccy, {
      ...fullSetup,
      exposureBasis: b,
    });
    if (v > higherVar + 1e-12) {
      higherVar = v;
      higher = b;
    }
  }

  if (basis === 'stock') {
    return {
      id: newHedgeTicketId(),
      ccy: row.bar.ccy,
      instrument: 'spot',
      basis: 'stock',
      amountLocalM,
      maturity: null,
      maturityLabel: null,
      varUsdM,
      addressesHigherVar: higher === 'stock',
    };
  }

  const horizonLabel =
    VAR_HORIZON_OPTIONS.find(h => h.id === fullSetup.horizon)?.label ??
    fullSetup.horizon;
  return {
    id: newHedgeTicketId(),
    ccy: row.bar.ccy,
    instrument: 'forward',
    basis,
    amountLocalM,
    maturity: fullSetup.horizon,
    maturityLabel: horizonLabel,
    varUsdM,
    addressesHigherVar: higher === basis,
  };
}

/** Prefer the exposure basis with the higher Analytics VaR. */
export function proposeHigherVarHedge(
  row: CurrencyRiskRow,
  setup: Pick<
    VarSetup,
    'confidencePct' | 'horizon' | 'forecastMonths' | 'forecastUncertainty1m' | 'exposureBasis'
  > | VarSetup,
  /** Fraction of equal-VaR notional to book (0–1). Defaults to full cover. */
  hedgeRatio = 1,
): HedgeTicket {
  const stock = proposeBookHedge(row, 'stock', setup);
  const avg = proposeBookHedge(row, 'avgBuildup', setup);
  const total = proposeBookHedge(row, 'totalBuildup', setup);
  const full = [stock, avg, total].reduce((best, t) =>
    t.varUsdM > best.varUsdM + 1e-12 ? t : best,
  );
  const ratio = Math.min(1, Math.max(0, hedgeRatio));
  if (ratio >= 1 - 1e-12) return full;
  return {
    ...full,
    amountLocalM: full.amountLocalM * ratio,
    varUsdM: full.varUsdM * ratio,
  };
}

/** Buildup leg (local M) for the active Analytics basis — 0 for stock. */
export function analyticsBuildupLocalM(
  row: CurrencyRiskRow,
  setup: Pick<VarSetup, 'exposureBasis' | 'forecastMonths'>,
): number {
  return buildupLocalMForBasis(
    row.bar.flowM,
    setup.exposureBasis,
    setup.forecastMonths,
  );
}
