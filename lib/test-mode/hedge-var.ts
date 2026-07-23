import type { RowState } from '@/lib/fx-buffer';
import { computeTaskVar } from '@/lib/test-mode/task-var';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import {
  DEFAULT_VAR_SETUP,
  VAR_HORIZON_OPTIONS,
  computeParametricVarUsdM,
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

/** Stock FX book used for Task Mode VaR columns. */
export function fxStockExposureLocalM(row: RowState): number {
  return row.spot + (row.nonCashAsset ?? 0) + row.nonCash;
}

/** Forecast / flow buildup for avg exposure (collections + payout + fcastFX). */
export function fxFlowLocalM(row: RowState): number {
  return row.collections + row.payout + (row.fcastFX ?? 0);
}

/** Exposure for Analytics basis on a live simulator row. */
export function fxExposureForBasis(
  row: RowState,
  basis: VarSetup['exposureBasis'],
): number {
  const stock = fxStockExposureLocalM(row);
  if (basis === 'stock') return stock;
  // avg ≈ S + 1.5F (same ladder convention)
  return stock + 1.5 * fxFlowLocalM(row);
}

export function exposureFromRiskRow(
  row: CurrencyRiskRow,
  basis: VarSetup['exposureBasis'],
): number {
  return basis === 'avgBuildup' ? row.bar.avg3mM : row.bar.stockNetM;
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
 * FX Risk table metrics: original exposure, spot/forward hedge structure,
 * residual, and VaR after hedges under the Analytics regime.
 */
export function fxTableRiskMetrics(
  rows: RowState[],
  setupOrConfidence: VarSetup | VarConfidencePct = 95,
  bookedTickets: readonly HedgeTicket[] = [],
  hedgeRatios: Record<string, number> = {},
): FxTableRiskMetric[] {
  const setup: VarSetup =
    typeof setupOrConfidence === 'number'
      ? { ...DEFAULT_VAR_SETUP, confidencePct: setupOrConfidence }
      : setupOrConfidence;

  return rows
    .filter(r => r.ccy !== 'USD')
    .map(r => {
      const exposureLocalM = fxExposureForBasis(r, setup.exposureBasis);
      const tickets = bookedTickets.filter(t => t.ccy === r.ccy);
      let spotBooked = 0;
      let forwardBooked = 0;
      for (const t of tickets) {
        if (t.instrument === 'spot') spotBooked += t.amountLocalM;
        else forwardBooked += t.amountLocalM;
      }
      const bookedAmt = spotBooked + forwardBooked;
      const ratio = Math.min(1, Math.max(0, hedgeRatios[r.ccy] ?? 0));
      const incremental = (exposureLocalM - bookedAmt) * ratio;
      // Attribute unbooked incremental % to the Analytics instrument.
      const spotHedgeLocalM =
        spotBooked + (setup.exposureBasis === 'stock' ? incremental : 0);
      const forwardHedgeLocalM =
        forwardBooked + (setup.exposureBasis === 'avgBuildup' ? incremental : 0);
      const totalHedge = spotHedgeLocalM + forwardHedgeLocalM;
      const residualLocalM = exposureLocalM - totalHedge;
      const varBeforeUsdM = computeParametricVarUsdM(exposureLocalM, r.ccy, setup);
      const varUsdM = computeParametricVarUsdM(residualLocalM, r.ccy, setup);
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
  /** Pre-hedge exposure used for VaR (stock or avg buildup). */
  exposureLocalM: number;
  hedgeRatio: number;
  delta: number;
  hedgeNotionalLocalM: number;
  residualLocalM: number;
  varBeforeUsdM: number;
  varAfterUsdM: number;
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
export type HedgeInstrument = 'spot' | 'forward';

export interface HedgeTicket {
  /** Stable id for the booked-transactions list / cancellation. */
  id: string;
  ccy: string;
  /** Stock now → spot; avg monthly buildup (future) → forward. */
  instrument: HedgeInstrument;
  basis: VarExposureBasis;
  /** Local FCY millions to hedge (signed with exposure). */
  amountLocalM: number;
  /** Forward value date = VaR horizon; null for spot. */
  maturity: VarHorizonId | null;
  maturityLabel: string | null;
  varUsdM: number;
  /** True when this basis has the higher VaR of stock vs avg. */
  addressesHigherVar: boolean;
  /** Owning entity id — rolls into Group FX consolidation. */
  entityId?: string;
  /** Display name for consolidated booked-hedge lists. */
  entityName?: string;
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

/** Prefer a booked ticket on the active Analytics basis; else any ticket for the CCY. */
export function bookedTicketForCcy(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
  preferredBasis?: VarExposureBasis,
): HedgeTicket | undefined {
  const forCcy = bookedTickets.filter(t => t.ccy === ccy);
  if (forCcy.length === 0) return undefined;
  if (preferredBasis) {
    const match = forCcy.find(t => t.basis === preferredBasis);
    if (match) return match;
  }
  return forCcy[0];
}

/** Signed booked notional still sitting on the book for a CCY (sum of tickets). */
export function bookedNotionalLocalM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
): number {
  return bookedTickets
    .filter(t => t.ccy === ccy)
    .reduce((s, t) => s + t.amountLocalM, 0);
}

/**
 * Hedging Decision / Live Ladder / Analytics rows.
 *
 * Booked tickets are netted into the base exposure (raw − booked), then incremental
 * hedge % starts from 0 on that net book. Switching Analytics basis recalculates raw
 * exposure, so a stock hedge leaves avg-buildup residual active again.
 */
export function buildHedgeVarSummary(
  risk: CurrencyRiskRow[],
  hedgeRatios: Record<string, number> = {},
  setupOrConfidence: VarSetup | VarConfidencePct = 95,
  bookedTickets: readonly HedgeTicket[] = [],
): HedgeVarSummary {
  const setup: VarSetup =
    typeof setupOrConfidence === 'number'
      ? { ...DEFAULT_VAR_SETUP, confidencePct: setupOrConfidence }
      : setupOrConfidence;

  const rows: HedgeVarRow[] = risk
    .filter(r => r.bar.ccy !== 'USD')
    .map(row => {
      const { bar } = row;
      const rawLocalM = exposureFromRiskRow(row, setup.exposureBasis);
      const bookedAmt = bookedNotionalLocalM(bookedTickets, bar.ccy);
      // Stock' = original exposure + hedge offset (= raw − booked amount).
      const exposureLocalM = rawLocalM - bookedAmt;
      const ratio = Math.min(1, Math.max(0, hedgeRatios[bar.ccy] ?? 0));
      const residualLocalM = exposureLocalM * (1 - ratio);
      return {
        ccy: bar.ccy,
        direction: bar.direction,
        exposureLocalM,
        hedgeRatio: ratio,
        delta: 1 - ratio,
        hedgeNotionalLocalM: exposureLocalM * ratio,
        residualLocalM,
        varBeforeUsdM: computeParametricVarUsdM(exposureLocalM, bar.ccy, setup),
        varAfterUsdM: computeParametricVarUsdM(residualLocalM, bar.ccy, setup),
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
 * Build a bookable hedge ticket for one exposure measurement.
 * - stock → spot hedge for stock notional
 * - avgBuildup → forward hedge, maturity = VaR horizon, notional = avg monthly buildup
 */
export function proposeBookHedge(
  row: CurrencyRiskRow,
  basis: VarExposureBasis,
  setup: Pick<VarSetup, 'confidencePct' | 'horizon'>,
): HedgeTicket {
  const stockM = row.bar.stockNetM;
  const avgM = row.bar.avg3mM;
  const varStock = computeParametricVarUsdM(stockM, row.bar.ccy, setup);
  const varAvg = computeParametricVarUsdM(avgM, row.bar.ccy, setup);
  const higher: VarExposureBasis =
    varAvg > varStock + 1e-12 ? 'avgBuildup' : 'stock';

  if (basis === 'stock') {
    return {
      id: newHedgeTicketId(),
      ccy: row.bar.ccy,
      instrument: 'spot',
      basis: 'stock',
      amountLocalM: stockM,
      maturity: null,
      maturityLabel: null,
      varUsdM: varStock,
      addressesHigherVar: higher === 'stock',
    };
  }

  const horizonLabel =
    VAR_HORIZON_OPTIONS.find(h => h.id === setup.horizon)?.label ?? setup.horizon;
  return {
    id: newHedgeTicketId(),
    ccy: row.bar.ccy,
    instrument: 'forward',
    basis: 'avgBuildup',
    amountLocalM: avgM,
    maturity: setup.horizon,
    maturityLabel: horizonLabel,
    varUsdM: varAvg,
    addressesHigherVar: higher === 'avgBuildup',
  };
}

/** Prefer the exposure basis with the higher parametric VaR. */
export function proposeHigherVarHedge(
  row: CurrencyRiskRow,
  setup: Pick<VarSetup, 'confidencePct' | 'horizon'>,
  /** Fraction of exposure to book (0–1). Defaults to full cover. */
  hedgeRatio = 1,
): HedgeTicket {
  const stock = proposeBookHedge(row, 'stock', setup);
  const avg = proposeBookHedge(row, 'avgBuildup', setup);
  const full = avg.varUsdM > stock.varUsdM + 1e-12 ? avg : stock;
  const ratio = Math.min(1, Math.max(0, hedgeRatio));
  if (ratio >= 1 - 1e-12) return full;
  return {
    ...full,
    amountLocalM: full.amountLocalM * ratio,
    varUsdM: full.varUsdM * ratio,
  };
}
