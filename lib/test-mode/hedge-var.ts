import {
  fcyToUsdM,
  fxBookNetLocalM,
  roundMoney,
  usdToFcyM,
  type LayerId,
  type RowState,
} from '@/lib/fx-buffer';
import type { SwapForwardOverlay } from '@/lib/fx-hedge';
import {
  effectiveForecastUncertainty1m,
  effectiveMonthlyFxFlowLocalM,
  monthlyFxFlowSeriesLocalM,
  periodFxFlowSumLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import { computeTaskVar } from '@/lib/test-mode/task-var';
import type { FxMarketRatesBundle } from '@/lib/fx-market-rates';
import type { CurrencyRiskRow } from '@/lib/test-mode/consolidate';
import { NORDTECH_VAR } from '@/lib/test-mode/fixtures/nordtech-var';
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
  horizonIdForForecastMonths,
  horizonMonths,
  linearBulletNotionalFromVarUsdM,
  averageExposureForVaR,
  monthlyVolForSetup,
  type VarExposureBasis,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';
import {
  zForConfidence,
  type VarConfidencePct,
} from '@/lib/test-mode/var-confidence';

/** Apply line-level forecast σ (Revenue / max line) over global Analytics u₁ₘ. */
export function varSetupWithLineUncertainty(
  setup: VarSetup,
  ccy: string,
  forecastProfile?: ForecastProfileState | null,
): VarSetup {
  const u = effectiveForecastUncertainty1m(
    forecastProfile,
    ccy,
    setup.forecastUncertainty1m,
  );
  if (Math.abs(u - (setup.forecastUncertainty1m ?? 0)) < 1e-12) return setup;
  return { ...setup, forecastUncertainty1m: u };
}

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
    fxBookNetLocalM(row) + periodFxFlowSumLocalM(row, T, forecastProfile),
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
  const flowM = effectiveMonthlyFxFlowLocalM(row, T, forecastProfile);
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

/**
 * Overlay live FX Risk table rows onto seed risk bars so Analytics / Decision /
 * Ladder VaR use edited Net FX stock + forecast flow — not the NordTech seed
 * (e.g. EUR cash+recv−debt = 1.9) frozen from entity setup.
 */
export function overlayRiskFromFxBook(
  risk: CurrencyRiskRow[],
  rows: readonly RowState[] | undefined,
  setup: VarSetup,
  forecastProfile?: ForecastProfileState | null,
): CurrencyRiskRow[] {
  if (!rows?.length) return risk;
  const byCcy = new Map(
    rows.filter(r => r.ccy !== 'USD').map(r => [r.ccy, r] as const),
  );
  if (byCcy.size === 0) return risk;

  const T =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 1;

  const barFromLive = (ccy: string, live: RowState) => {
    const stockNetM = fxBookNetLocalM(live);
    const flowM = effectiveMonthlyFxFlowLocalM(live, T, forecastProfile);
    let direction: CurrencyRiskRow['bar']['direction'] = 'hub';
    if (Math.abs(stockNetM) < 1e-9 && Math.abs(flowM) > 1e-9) {
      direction = 'hub';
    } else if (stockNetM > 1e-9) {
      direction = 'long';
    } else if (stockNetM < -1e-9) {
      direction = 'short';
    }
    if (ccy === 'USD') direction = 'hub';
    return {
      ccy,
      stockNetM,
      flowM,
      avg3mM: stockNetM + 0.5 * flowM,
      direction,
    };
  };

  const seen = new Set<string>();
  const out: CurrencyRiskRow[] = [];
  for (const row of risk) {
    const live = byCcy.get(row.bar.ccy);
    if (!live) {
      out.push(row);
      continue;
    }
    seen.add(row.bar.ccy);
    const bar = barFromLive(row.bar.ccy, live);
    out.push({
      bar,
      varStock: computeTaskVar(bar, { ...setup, exposureBasis: 'stock' }),
      varAvg3m: computeTaskVar(bar, { ...setup, exposureBasis: 'avgBuildup' }),
    });
  }
  for (const [ccy, live] of byCcy) {
    if (seen.has(ccy)) continue;
    const bar = barFromLive(ccy, live);
    out.push({
      bar,
      varStock: computeTaskVar(bar, { ...setup, exposureBasis: 'stock' }),
      varAvg3m: computeTaskVar(bar, { ...setup, exposureBasis: 'avgBuildup' }),
    });
  }
  return out;
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
        T > 0 ? monthlyFxFlowSeriesLocalM(r, T, forecastProfile) : [];
      const monthlyFlowM = effectiveMonthlyFxFlowLocalM(r, T > 0 ? T : 1, forecastProfile);
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
      const rowSetup = varSetupWithLineUncertainty(setup, r.ccy, forecastProfile);
      const varBeforeUsdM = computeAnalyticsVarUsdM(
        stockM,
        flowForPath,
        r.ccy,
        rowSetup,
        flows,
      );
      const varUsdM = computeAnalyticsVarUsdM(
        stockAfterHedgeM,
        flowForPath,
        r.ccy,
        rowSetup,
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
   * Hedge cover notional (local M) — same sign as Target N / Stock:
   *   Target × Hedge-add %  (or Σ strip legs when a strip is booked)
   * 100% Target → Hedge N = Target N.
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
   * VaR-neutral reference (Equal-VaR bullet on the open book @ Δ1) — Decision mid.
   * Sized from varBefore / open exposure, not leftover VaR after hedges.
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
 * Exposure @ Δ1 for the active Analytics basis (VaR quantity / hedge cap).
 * - Average → simple mid-point or time-weighted integral (exposureBasis)
 * - Growth path → path end
 * Optional `monthlyFlows` = custom uneven schedule (overrides flat F).
 */
export function analyticsOpenExposureLocalM(
  stockM: number,
  monthlyFlowM: number,
  setup: Pick<VarSetup, 'exposureBasis' | 'horizon' | 'forecastMonths'> &
    Partial<Pick<VarSetup, 'averagingConvention'>>,
  monthlyFlows?: readonly number[],
): number {
  if (setup.exposureBasis === 'stock') {
    return Number.isFinite(stockM) ? stockM : 0;
  }
  const Th = horizonMonths(setup.horizon);
  if (
    setup.exposureBasis === 'simpleAvg' ||
    setup.exposureBasis === 'avgBuildup'
  ) {
    return averageExposureForVaR(stockM, monthlyFlowM, setup, monthlyFlows);
  }
  // Growth path: Exposure @ Δ1 = end buildup
  if (monthlyFlows && monthlyFlows.length > 0) {
    return accruedPositionFromScheduleM(stockM, monthlyFlows, Th);
  }
  return accruedPositionLocalM(stockM, monthlyFlowM, 'totalBuildup', setup);
}

/**
 * Center of gravity of path VaR mass e(t)² on [0, T]:
 *   t_cog = ∫ t·e(t)² dt / ∫ e(t)² dt
 *   H     = e(t_cog)
 *
 * Open path VaR ∝ √∫e²dt — VN hedge is the exposure at that mass centroid.
 * Same for simple / time-weighted / growth profiles (all path-CoG based).
 * Flat F: S=1.9,F=1.2,T=12 → t_cog≈8.62m, H≈12.24 (Ē=9.1, RMS≈10.0).
 */
export function pathVarCogHedgeLocalM(
  stockM: number,
  monthlyFlowM: number,
  tenureMonths: number,
  monthlyFlows?: readonly number[],
): number {
  const T =
    typeof tenureMonths === 'number' && tenureMonths > 1e-12 ? tenureMonths : 0;
  const S = Number.isFinite(stockM) ? stockM : 0;
  if (!(T > 0)) return S;
  const flows =
    monthlyFlows && monthlyFlows.length > 0
      ? monthlyFlows
      : Array.from({ length: Math.max(1, Math.ceil(T)) }, () => monthlyFlowM);
  const eAt = (t: number) => accruedPositionFromScheduleM(S, flows, t);
  const e0 = eAt(0);
  const eT = eAt(T);

  const n = Math.max(80, Math.ceil(T * 40));
  const dt = T / n;
  let mass = 0;
  let moment = 0;
  for (let i = 0; i < n; i++) {
    const t0 = i * dt;
    const t1 = Math.min(T, (i + 1) * dt);
    const tm = 0.5 * (t0 + t1);
    const em = eAt(tm);
    const w = em * em * (t1 - t0);
    mass += w;
    moment += tm * w;
  }
  if (!(mass > 1e-18)) {
    const signed =
      Math.abs(eT) > 1e-12 ? (eT >= 0 ? 1 : -1) : e0 >= 0 ? 1 : -1;
    return signed * Math.abs(eT || e0);
  }
  const tCog = moment / mass;
  const H = eAt(Math.min(Math.max(tCog, 0), T));
  const signed =
    Math.abs(eT) > 1e-12 ? (eT >= 0 ? 1 : -1) : e0 >= 0 ? 1 : -1;
  return signed * Math.min(Math.abs(H), Math.abs(eT) || Math.abs(H));
}

/** @deprecated use pathVarCogHedgeLocalM */
export const riskBalanceHedgeLocalM = pathVarCogHedgeLocalM;

/**
 * VaR-neutral hedge notional at tenure T (months) — **profile-specific**:
 *
 * - stock: S
 * - simpleAvg: mid Ē = (S+E_end)/2  (flat-Ē VaR model → CoG at T/2)
 * - avgBuildup: time-weighted Ē = (1/T)∫e  (same as simple on flat F)
 * - totalBuildup (growth): path-VaR CoG H = e(∫t e²/∫e²)
 *
 * Strip uses the same rule per window. Not the same H across regimes.
 */
export function equalVarNotionalAtTenureLocalM(
  stockM: number,
  monthlyFlowM: number,
  _ccy: string,
  setup: VarSetup,
  tenureMonths: number,
  monthlyFlows?: readonly number[],
): number {
  const T =
    typeof tenureMonths === 'number' && tenureMonths > 1e-12 ? tenureMonths : 0;
  if (!(T > 0)) {
    return Number.isFinite(stockM) ? stockM : 0;
  }

  if (setup.exposureBasis === 'stock') {
    return Number.isFinite(stockM) ? stockM : 0;
  }

  // Growth path only → e² CoG. Simple / TW stay on their Ē (different regimes).
  if (setup.exposureBasis === 'totalBuildup') {
    return pathVarCogHedgeLocalM(stockM, monthlyFlowM, T, monthlyFlows);
  }

  const eBar = averageExposureForVaR(
    stockM,
    monthlyFlowM,
    setup,
    monthlyFlows,
    T,
  );
  const end =
    monthlyFlows && monthlyFlows.length > 0
      ? accruedPositionFromScheduleM(stockM, monthlyFlows, T)
      : accruedPositionFromScheduleM(
          stockM,
          Array.from({ length: Math.max(1, Math.ceil(T)) }, () => monthlyFlowM),
          T,
        );
  const sign =
    Math.abs(end) > 1e-12
      ? end >= 0
        ? 1
        : -1
      : eBar >= 0
        ? 1
        : -1;
  return sign * Math.min(Math.abs(eBar), Math.abs(end) || Math.abs(eBar));
}

/**
 * Equal-VaR linear hedge notional (exposure-signed):
 * invert Analytics VaR through the bullet formula |N|×σ×√Th×z, then cap by
 * |accrued end position at Th| (not by Ē).
 *
 * Weighted avg: VaR uses Ē=(1/T)∫e ⇒ |N|≈Ē ≪ |E_end| on a growing book.
 * Growth path (default): path-VaR CoG H=e(t*). Cap binds when a
 * caller-supplied path VaR invert exceeds accrued |E|.
 */
export function equalVarLinearHedgeNotionalLocalM(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: VarSetup,
  pathVarUsdM?: number,
  monthlyFlows?: readonly number[],
): { amountLocalM: number; uncappedAbsLocalM: number; capped: boolean } {
  const Th = horizonMonths(setup.horizon);
  const varUsd =
    typeof pathVarUsdM === 'number'
      ? pathVarUsdM
      : computeAnalyticsVarUsdM(stockM, monthlyFlowM, ccy, setup, monthlyFlows);
  const uncappedAbs = linearBulletNotionalFromVarUsdM(varUsd, ccy, setup);
  const amountLocalM =
    typeof pathVarUsdM === 'number'
      ? (() => {
          const end = analyticsOpenExposureLocalM(
            stockM,
            monthlyFlowM,
            setup,
            monthlyFlows,
          );
          const sign = end >= 0 ? 1 : -1;
          return sign * Math.min(uncappedAbs, Math.abs(end));
        })()
      : equalVarNotionalAtTenureLocalM(
          stockM,
          monthlyFlowM,
          ccy,
          setup,
          Th,
          monthlyFlows,
        );
  const end = analyticsOpenExposureLocalM(
    stockM,
    monthlyFlowM,
    setup,
    monthlyFlows,
  );
  return {
    amountLocalM,
    uncappedAbsLocalM: uncappedAbs,
    capped: uncappedAbs > Math.abs(end) + 1e-12,
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
   * `scheduled` = not yet traded (legacy / non-strip). Strip legs are all
   * `booked` from M0 with staggered tenures.
   */
  status?: HedgeTicketStatus;
  /** Shared id for a rolling strip (all legs live from M0). */
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

/**
 * Analytics path-chart package staged for the Hedging Decision tab.
 * Not on the live book until the user clicks Send in Decision.
 */
export interface PreparedHedgeLeg {
  index: number;
  startMonth: number;
  endMonth: number;
  /**
   * Economic cash / forward settle from M0 (period end / start / e∩H).
   * Defaults to endMonth when omitted.
   */
  settleMonths?: number;
  hedgeLocalM: number;
  label: string;
  stockStartM?: number;
  endExposureM?: number;
  /**
   * Incremental trade notional for this leg (Δ vs prior cumul H).
   * Carry is computed on this amount, not cumulative hedgeLocalM.
   */
  tradeNotionalLocalM?: number;
  /** Implied FWD carry from EURUSD swap points ($M). */
  impliedCarryUsdM?: number;
  swapPoints?: number;
  swapPointsSide?: 'bid' | 'ask' | 'mid';
}

export interface PreparedHedgeProfile {
  structure: 'bullet' | 'strip';
  /** Path-chart regime used when preparing. */
  basis: 'cash' | 'varNeutral' | 'totalExpected';
  ticketBasis: VarExposureBasis;
  /** Strip legs (empty for bullet). */
  legs: PreparedHedgeLeg[];
  /** Signed FCY M cover (bullet notional, or Σ strip). */
  coverLocalM: number;
  /** Bullet Decision % of Target (preview); strip usually 0 until sent. */
  hedgeRatio: number;
  /**
   * Bullet: cash-delivery rule (period end / start / e∩H) used at Prepare.
   * Strip uses per-leg settleMonths instead.
   */
  cashDeliveryAt?: 'periodEnd' | 'periodStart' | 'matchExposure';
  /** Bullet: forward settle tenure in months from M0. */
  settleMonths?: number;
  /**
   * Strip settle-window skew: neutral = equal Sched %; front / back tilt
   * tenor early / late (same as FX Risk path-chart Front / Back).
   */
  settleSkew?: 'neutral' | 'front' | 'back';
  /** Package Σ implied swap-points carry ($M) — bullet or strip. */
  impliedCarryUsdM?: number;
  swapPoints?: number;
  swapPointsSide?: 'bid' | 'ask' | 'mid';
  /**
   * Which objective shaped this package — FX Risk's equal-VaR path chart
   * ('var'), Cash Carry's Shape search / tick-trades editor ('carry'), or
   * Liquidity Book's residual-Δ funding strip ('liquidity').
   * Surfaced in Hedging Decision so the desk knows which lens sized what's
   * about to be booked. Undefined for packages prepared before this tag
   * existed.
   */
  preparedFor?: 'var' | 'carry' | 'liquidity';
}

/** Staged (prepared) FX-hedge FWD-points carry per CCY — same $M as Decision Carry. */
export function stagedFxHedgeCarryByCcyUsdM(
  preparedByCcy?: Record<string, PreparedHedgeProfile>,
): Record<string, number> {
  const map: Record<string, number> = {};
  if (!preparedByCcy) return map;
  for (const [ccy, profile] of Object.entries(preparedByCcy)) {
    const v = profile.impliedCarryUsdM;
    if (typeof v === 'number' && Number.isFinite(v)) {
      map[ccy] = v;
    }
  }
  return map;
}

/**
 * Cash Carry modal resume snapshot — persisted with the sandbox hedge book
 * so Apply / Prebook / schedule edits survive page reload (local + Neon).
 */
export type CarryProfileSessionV1 = {
  v: 1;
  draft: PreparedHedgeProfile | null;
  dirty: boolean;
  appliedShape: {
    legCount: number;
    centerOfMass: number;
    kurtosis: number;
  } | null;
  shapePreview: {
    legCount: number;
    centerOfMass: number;
    kurtosis: number;
  } | null;
  pathScheduleEnds: number[] | null;
  pathHedgeWeights: number[] | null;
  pathStripLegCount: number | null;
  pathStructure: 'bullet' | 'strip';
  pathBasis: 'cash' | 'varNeutral' | 'totalExpected';
  selectedSettleMonths: number | null;
  shapeStartManual: boolean;
};

/**
 * Overlay / residual Δ / Policy VAR the desk is running.
 * Not a booked ticket — still has to round-trip with the hedge book or every
 * reload / Fast Refresh wipes the programme the user just set.
 */
export interface EntityHedgeDeskState {
  residualByCcy?: Record<string, number>;
  swapForwardDeltaByRowId?: Record<string, number>;
  optionDeltaByRowId?: Record<string, number>;
  /** Live Swap+Fwd replacement overlay — must survive reload, not only React state. */
  swapForwardOverlayByCcy?: Record<string, SwapForwardOverlay>;
  hedgeStrategy?: string;
  policyVAR?: number;
  portfolioCarryK?: number;
  /** Buffer chips (carry / floor / portfolio / CFaR) — must survive remount. */
  activeLayers?: LayerId[];
  /** Overlay sweet-spot chip (conservative / balanced / maxCarry / maxReturn). */
  portfolioScenarioId?: string;
}

/** Per-entity (or group-scope) Decision-layer hedge book. */
export interface EntityHedgeBook {
  bookedHedges: HedgeTicket[];
  hedgeRatios: Record<string, number>;
  /** Staged Analytics packages keyed by CCY — Decision must Send to book. */
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  /** In-progress Cash Carry profile modals keyed by CCY. */
  carrySessionsByCcy?: Record<string, CarryProfileSessionV1>;
  /** Uploaded market-data curve (deposits + swap points) per CCY. */
  marketRatesByCcy?: Record<string, FxMarketRatesBundle>;
  /** Live overlay / residual Δ / Policy VAR (Analytics Liquidity desk). */
  desk?: EntityHedgeDeskState;
}

export function emptyHedgeBook(): EntityHedgeBook {
  return {
    bookedHedges: [],
    hedgeRatios: {},
    preparedByCcy: {},
    carrySessionsByCcy: {},
    marketRatesByCcy: {},
    desk: {},
  };
}

export type HedgeTicketsPatch =
  | HedgeTicket[]
  | ((prev: HedgeTicket[]) => HedgeTicket[]);

export type PreparedHedgesPatch =
  | Record<string, PreparedHedgeProfile>
  | ((prev: Record<string, PreparedHedgeProfile>) => Record<string, PreparedHedgeProfile>);

export function applyHedgeTicketsPatch(
  prev: HedgeTicket[],
  patch: HedgeTicketsPatch,
): HedgeTicket[] {
  return typeof patch === 'function' ? patch(prev) : patch;
}

export function applyPreparedHedgesPatch(
  prev: Record<string, PreparedHedgeProfile> | undefined,
  patch: PreparedHedgesPatch,
): Record<string, PreparedHedgeProfile> {
  return typeof patch === 'function' ? patch(prev ?? {}) : patch;
}

/** Residual Δ from staged liquidity packages, then any explicit desk overlay. */
export function residualByCcyFromBook(
  book: Pick<EntityHedgeBook, 'preparedByCcy' | 'desk'>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ccy, profile] of Object.entries(book.preparedByCcy ?? {})) {
    if (profile.preparedFor === 'liquidity' && typeof profile.hedgeRatio === 'number') {
      out[ccy] = profile.hedgeRatio;
    }
  }
  return { ...out, ...(book.desk?.residualByCcy ?? {}) };
}

export function setPreparedHedgeForCcy(
  prepared: Record<string, PreparedHedgeProfile> | undefined,
  ccy: string,
  profile: PreparedHedgeProfile,
): Record<string, PreparedHedgeProfile> {
  return { ...(prepared ?? {}), [ccy]: profile };
}

export function setMarketRatesForCcy(
  marketRatesByCcy: Record<string, FxMarketRatesBundle> | undefined,
  ccy: string,
  bundle: FxMarketRatesBundle,
): Record<string, FxMarketRatesBundle> {
  return { ...(marketRatesByCcy ?? {}), [ccy]: bundle };
}

export function clearPreparedHedgeForCcy(
  prepared: Record<string, PreparedHedgeProfile> | undefined,
  ccy: string,
): Record<string, PreparedHedgeProfile> {
  if (!prepared || !(ccy in prepared)) return prepared ?? {};
  const next = { ...prepared };
  delete next[ccy];
  return next;
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
      preparedByCcy: prev[id]?.preparedByCcy ?? {},
      carrySessionsByCcy: prev[id]?.carrySessionsByCcy ?? {},
      marketRatesByCcy: prev[id]?.marketRatesByCcy ?? {},
      ...(prev[id]?.desk ? { desk: prev[id]?.desk } : {}),
    };
  }
  out[GROUP_HEDGE_SCOPE] = {
    bookedHedges: buckets[GROUP_HEDGE_SCOPE] ?? [],
    hedgeRatios: prev[GROUP_HEDGE_SCOPE]?.hedgeRatios ?? {},
    preparedByCcy: prev[GROUP_HEDGE_SCOPE]?.preparedByCcy ?? {},
    carrySessionsByCcy: prev[GROUP_HEDGE_SCOPE]?.carrySessionsByCcy ?? {},
    marketRatesByCcy: prev[GROUP_HEDGE_SCOPE]?.marketRatesByCcy ?? {},
    ...(prev[GROUP_HEDGE_SCOPE]?.desk
      ? { desk: prev[GROUP_HEDGE_SCOPE]?.desk }
      : {}),
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

/**
 * Undiversified VaR offset from live non-strip tickets (parametric @ maturity).
 * Strip credit uses {@link stripAnalyticsWeightedVarUsdM} instead.
 */
export function bookedHedgeVarUsdM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
  setup: Pick<VarSetup, 'confidencePct' | 'horizon'> &
    Partial<Pick<VarSetup, 'volSource'>>,
): number {
  return bookedTickets
    .filter(t => t.ccy === ccy && isLiveHedgeTicket(t) && !t.stripId)
    .reduce((s, t) => {
      if (t.varUsdM > 0 && Number.isFinite(t.varUsdM)) return s + t.varUsdM;
      const horizon = t.maturity ?? setup.horizon;
      return (
        s +
        computeParametricVarUsdM(t.amountLocalM, ccy, { ...setup, horizon })
      );
    }, 0);
}

/**
 * Live-VaR credit for an M0 strip under the Analytics profile:
 *   Σ_k V(T_k) · |N_k| / |N_tot|
 * Target 9.1@6m + 7.2@12m → below bullet V(Tf) (strip underperforms).
 */
export function stripAnalyticsWeightedVarUsdM(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: VarSetup,
  legs: readonly { amountLocalM: number; tenureMonths: number }[],
  monthlyFlows?: readonly number[],
): number {
  const Ntot = legs.reduce((s, l) => s + Math.abs(l.amountLocalM), 0);
  if (Ntot < 1e-12) return 0;
  return legs.reduce((s, l) => {
    const T =
      l.tenureMonths > 0 ? l.tenureMonths : horizonMonths(setup.horizon);
    const V = computeAnalyticsVarUsdM(
      stockM,
      monthlyFlowM,
      ccy,
      setup,
      monthlyFlows,
      T,
    );
    return s + V * (Math.abs(l.amountLocalM) / Ntot);
  }, 0);
}

/**
 * Residual VaR after a bullet (or flat M0 cover) vs realized path:
 *   V_open · |e − H| / |E_ref|
 * Same formula as the path-modal / VaR-evolution resid series.
 * Target H=E(Tf) → 0 only when e=E(Tf); mid-path and VN stay non-zero.
 */
export function residualVarFromMismatchUsdM(
  openVarUsdM: number,
  exposureLocalM: number,
  hedgeCoverLocalM: number,
  referenceLocalM: number,
): number {
  const Eref = Math.abs(referenceLocalM);
  if (!(Eref > 1e-12) || !(openVarUsdM > 0)) return 0;
  return (
    openVarUsdM * (Math.abs(exposureLocalM - hedgeCoverLocalM) / Eref)
  );
}

/**
 * Residual VaR at tenure h after strip cover (legacy diagnostic):
 *   P(|cumul N|, h) − V_analytics(h)
 * Target @ 6m simpleAvg: P(9.1,6m) − V(6) ≈ 362.
 */
export function stripResidualVarAtMonthsUsdM(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: VarSetup,
  tenureMonths: number,
  cumulCoverLocalM: number,
  monthlyFlows?: readonly number[],
): number {
  if (!(tenureMonths > 0)) return 0;
  const horizon = horizonIdForForecastMonths(tenureMonths);
  const parametric = computeParametricVarUsdM(cumulCoverLocalM, ccy, {
    ...setup,
    horizon,
  });
  const analytics = computeAnalyticsVarUsdM(
    stockM,
    monthlyFlowM,
    ccy,
    setup,
    monthlyFlows,
    tenureMonths,
  );
  return Math.max(0, parametric - analytics);
}

/** Point on the M0→Tf hedged-portfolio VaR path. */
export interface StripHedgedVarProfilePoint {
  t: number;
  /** Open analytics VaR at tenure t. */
  openVarUsdM: number;
  /**
   * Residual VaR from unmatched book vs realized path:
   *   V(t) · |e(t) − H(t)| / E_ref
   * Target H=E(Tf): mid-path |E(Tf)−e(t)| > 0 (unrealized forecast) → VaR > 0;
   * matched only at Tf when e(Tf)=H.
   */
  hedgedVarUsdM: number;
  /** Accrued / realized exposure e(t) on the forecast path. */
  exposureLocalM: number;
  /** Hedge cover H(t) (Σ live M0 legs by default). */
  cumulCoverLocalM: number;
  /** |e(t) − H(t)| — cumulative residual exposure (over/under). */
  residualCoverLocalM: number;
}

export interface StripHedgedVarLeg {
  amountLocalM: number;
  /** Maturity (months from M0) — chart mark / label. */
  tenureMonths: number;
  /**
   * When this leg’s cover counts toward cumul N.
   * Default 0 — all M0-dealt legs are live from day 0 (bullet = strip).
   * Pass tenureMonths only for a maturity-step diagnostic.
   */
  recognizeFromMonths?: number;
}

/**
 * Hedged-portfolio VaR vs exposure with an arbitrary cover path H(t).
 * Resid VaR = V_open(t) · |e−H| / |E_ref|.
 */
export function buildHedgedVarProfileWithCoverAt(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: VarSetup,
  coverAt: (t: number) => number,
  monthlyFlows?: readonly number[],
  stepMonths = 1,
  referenceCoverLocalM?: number,
  throughMonths?: number,
  /** Extra sample times (e.g. strip maturity knots) for exact resid at dots. */
  extraSampleMonths?: readonly number[],
): StripHedgedVarProfilePoint[] {
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  if (Tf <= 0) return [];
  const through =
    typeof throughMonths === 'number' &&
    Number.isFinite(throughMonths) &&
    throughMonths > Tf + 1e-12
      ? throughMonths
      : Tf;
  const flows =
    monthlyFlows && monthlyFlows.length > 0
      ? monthlyFlows
      : Array.from({ length: Math.ceil(Tf) }, () => monthlyFlowM);
  const Eref =
    typeof referenceCoverLocalM === 'number' &&
    Math.abs(referenceCoverLocalM) > 1e-12
      ? Math.abs(referenceCoverLocalM)
      : Math.abs(accruedPositionFromScheduleM(stockM, flows, Tf));
  if (!(Eref > 1e-12)) return [];

  const pointAt = (t: number): StripHedgedVarProfilePoint => {
    const H = coverAt(t);
    const e = accruedPositionFromScheduleM(stockM, flows, t);
    const residualAbs = Math.abs(e - H);
    const openVarUsdM =
      t < 1e-9
        ? 0
        : computeAnalyticsVarUsdM(
            stockM,
            monthlyFlowM,
            ccy,
            setup,
            flows,
            t,
          );
    return {
      t,
      openVarUsdM,
      hedgedVarUsdM: openVarUsdM * (residualAbs / Eref),
      exposureLocalM: e,
      cumulCoverLocalM: H,
      residualCoverLocalM: residualAbs,
    };
  };
  const step = stepMonths > 0 ? stepMonths : 1;
  const out: StripHedgedVarProfilePoint[] = [];
  const pushUnique = (t: number) => {
    const pt = pointAt(t);
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - pt.t) < 1e-9) {
      out[out.length - 1] = pt;
      return;
    }
    out.push(pt);
  };
  for (let t = 0; t <= through + 1e-9; t += step) {
    pushUnique(Math.min(t, through));
  }
  if (Tf < through - 1e-9) pushUnique(Tf);
  pushUnique(through);
  if (extraSampleMonths) {
    for (const raw of extraSampleMonths) {
      if (!Number.isFinite(raw)) continue;
      pushUnique(Math.max(0, Math.min(through, raw)));
    }
  }
  out.sort((a, b) => a.t - b.t);
  const deduped: StripHedgedVarProfilePoint[] = [];
  for (const p of out) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.t - p.t) < 1e-9) {
      deduped[deduped.length - 1] = p;
    } else {
      deduped.push(p);
    }
  }
  return deduped;
}

/**
 * Hedged-portfolio VaR vs the realized exposure path.
 *
 * H(t) = Σ legs live by t (default: all M0 legs from day 0).
 * Strip resid (all regimes): H(t) = Σ M0 legs live by t (default: all from 0).
 *
 * e(t) = accrued forecast exposure (flat at E(Tf) once the schedule ends).
 * residual = |e − H|
 * hedged VaR = V(t) · |e−H| / E_ref
 */
export function buildStripHedgedVarProfile(
  stockM: number,
  monthlyFlowM: number,
  ccy: string,
  setup: VarSetup,
  legs: readonly StripHedgedVarLeg[],
  monthlyFlows?: readonly number[],
  /** Sample step in months (default 1). */
  stepMonths = 1,
  /**
   * Reference notional for scaling (usually |E(Tf)|).
   * Defaults to Σ |leg| when omitted.
   */
  referenceCoverLocalM?: number,
  /** End of sample window in months (default = Tf). Use >Tf for post-forecast resid. */
  throughMonths?: number,
): StripHedgedVarProfilePoint[] {
  const Tf =
    typeof setup.forecastMonths === 'number' && setup.forecastMonths > 0
      ? setup.forecastMonths
      : 0;
  if (Tf <= 0 || legs.length === 0) return [];
  const Ntot = legs.reduce((s, l) => s + Math.abs(l.amountLocalM), 0);
  if (Ntot < 1e-12) return [];
  const recognizeAt = (l: StripHedgedVarLeg) =>
    typeof l.recognizeFromMonths === 'number' ? l.recognizeFromMonths : 0;
  const hedgeAt = (t: number) =>
    legs
      .filter(l => recognizeAt(l) <= t + 1e-9)
      .reduce((s, l) => s + l.amountLocalM, 0);
  return buildHedgedVarProfileWithCoverAt(
    stockM,
    monthlyFlowM,
    ccy,
    setup,
    hedgeAt,
    monthlyFlows,
    stepMonths,
    referenceCoverLocalM ??
      (Math.abs(
        accruedPositionFromScheduleM(
          stockM,
          monthlyFlows && monthlyFlows.length > 0
            ? monthlyFlows
            : Array.from({ length: Math.ceil(Tf) }, () => monthlyFlowM),
          Tf,
        ),
      ) ||
        Ntot),
    throughMonths,
  );
}

/** Live strip legs for a CCY (all dealt from M0). */
export function stripTicketsForCcy(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
): HedgeTicket[] {
  return bookedTickets.filter(
    t => t.ccy === ccy && Boolean(t.stripId) && isLiveHedgeTicket(t),
  );
}

/** Total exposure-signed strip cover (sum of incremental legs). */
export function stripCoverLocalM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
): number {
  return stripTicketsForCcy(bookedTickets, ccy).reduce(
    (s, t) => s + t.amountLocalM,
    0,
  );
}

/**
 * Strip cover that offsets Analytics open @ Th — first edge only
 * (edge 0 incremental ≡ absolute H on the first Th window).
 */
export function stripNearTermCoverLocalM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
): number {
  return stripTicketsForCcy(bookedTickets, ccy)
    .filter(t => (t.stripEdgeIndex ?? 0) === 0)
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

/** Staged (prepared) package → FWD overlay. Same book sign as a live forward. */
export function preparedPositionOffsetsByCcy(
  preparedByCcy?: Record<string, PreparedHedgeProfile>,
): Record<string, BookedPositionOffset> {
  const map: Record<string, BookedPositionOffset> = {};
  for (const [ccy, prep] of Object.entries(preparedByCcy ?? {})) {
    if (Math.abs(prep.coverLocalM) < 1e-12) continue;
    map[ccy] = { spotLocalM: 0, fwdLocalM: -prep.coverLocalM };
  }
  return map;
}

/**
 * Merge booked + staged FX POSITION offsets.
 * A staged package replaces booked forwards for that CCY (same as the
 * cash-flow collector) so Stage cannot double-count FWD.
 */
export function hedgePositionOffsetsByCcy(
  bookedTickets: readonly HedgeTicket[],
  preparedByCcy?: Record<string, PreparedHedgeProfile>,
): Record<string, BookedPositionOffset> {
  const map = bookedPositionOffsetsByCcy(bookedTickets);
  for (const [ccy, o] of Object.entries(preparedPositionOffsetsByCcy(preparedByCcy))) {
    const cur = map[ccy] ?? { spotLocalM: 0, fwdLocalM: 0 };
    map[ccy] = { spotLocalM: cur.spotLocalM, fwdLocalM: o.fwdLocalM };
  }
  return map;
}

function applyPositionOffsets(
  rows: RowState[],
  offsets: Record<string, BookedPositionOffset>,
): RowState[] {
  if (Object.keys(offsets).length === 0) return rows;
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
 * Apply booked (and optional staged) Decision-layer hedges onto simulator
 * rows for FWD/Spot display. Does not size the funding swap.
 */
export function applyBookedHedgePositions(
  rows: RowState[],
  bookedTickets: readonly HedgeTicket[],
  preparedByCcy?: Record<string, PreparedHedgeProfile>,
): RowState[] {
  return applyPositionOffsets(
    rows,
    hedgePositionOffsetsByCcy(bookedTickets, preparedByCcy),
  );
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
  /** When set, Revenue / line σ overrides global Analytics u₁ₘ per CCY. */
  forecastProfile?: ForecastProfileState | null,
): HedgeVarSummary {
  const setup: VarSetup =
    typeof setupOrConfidence === 'number'
      ? { ...DEFAULT_VAR_SETUP, confidencePct: setupOrConfidence }
      : setupOrConfidence;

  const rows: HedgeVarRow[] = risk
    .filter(r => r.bar.ccy !== 'USD')
    .map(row => {
      const { bar } = row;
      const rowSetup = varSetupWithLineUncertainty(
        setup,
        bar.ccy,
        forecastProfile,
      );
      const stockM = bar.stockNetM;
      const flowM =
        rowSetup.forecastMonths > 0 && Math.abs(bar.flowM) > 1e-15
          ? bar.flowM
          : 0;
      const schedule = monthlyFlowsByCcy[bar.ccy];
      const flows =
        schedule && schedule.length > 0 ? schedule : undefined;
      // Open exposure at Th: avg/path accrue with g=min(Th,Tf) — not full F×Tf.
      const openLocalM = analyticsOpenExposureLocalM(
        stockM,
        flowM,
        rowSetup,
        flows,
      );
      const stripAmt = stripCoverLocalM(bookedTickets, bar.ccy);
      const hasStrip = Math.abs(stripAmt) > 1e-12;
      const stripNear = stripNearTermCoverLocalM(bookedTickets, bar.ccy);
      const nonStripAmt = bookedTickets
        .filter(
          t =>
            t.ccy === bar.ccy &&
            isLiveHedgeTicket(t) &&
            !t.stripId,
        )
        .reduce((s, t) => s + t.amountLocalM, 0);
      // Decision ladder: 100% = Total expected over full forecast (Target).
      const Tf = rowSetup.forecastMonths;
      const totalRaw =
        flows && flows.length > 0 && Tf > 0
          ? accruedPositionFromScheduleM(stockM, flows, Tf)
          : exposureLocalMForBasis(stockM, flowM, 'totalBuildup', Tf);
      // Cash / Target chips: only non-strip bookings reduce the ladder
      // (full strip cover must not wipe Stock to −13M).
      const stockHedgeLocalM = stockM - nonStripAmt;
      const targetHedgeLocalM = totalRaw - nonStripAmt;
      // Working open after near-term hedge (strip: first edge only @ Th).
      const exposureLocalM = openLocalM - nonStripAmt - stripNear;
      // Hedge-add % of Target (0–100%) — ignored when a strip is booked.
      const ratio = hasStrip
        ? Math.min(
            1,
            Math.abs(totalRaw) > 1e-12
              ? Math.abs(stripAmt) / Math.abs(totalRaw)
              : 1,
          )
        : Math.min(1, Math.max(0, hedgeRatios[bar.ccy] ?? 0));

      // Open VaR: strip → full Tf analytics; bullet → Analytics horizon (avg/path).
      const varBeforeUsdM = computeAnalyticsVarUsdM(
        stockM,
        flowM,
        bar.ccy,
        rowSetup,
        flows,
        hasStrip && Tf > 0 ? Tf : undefined,
      );
      // VN: growth → path CoG; simple/TW → Ē. Stock → growth so VN ≠ Cash.
      const eqTenure = Tf > 0 ? Tf : horizonMonths(rowSetup.horizon);
      const eqSetup: VarSetup =
        rowSetup.exposureBasis === 'stock'
          ? { ...rowSetup, exposureBasis: 'totalBuildup' }
          : rowSetup;
      const eqAmount = equalVarNotionalAtTenureLocalM(
        stockM,
        flowM,
        bar.ccy,
        eqSetup,
        eqTenure,
        flows,
      );
      const eqOpen = equalVarLinearHedgeNotionalLocalM(
        stockM,
        flowM,
        bar.ccy,
        rowSetup,
        undefined,
        flows,
      );
      const accruedCap = analyticsOpenExposureLocalM(
        stockM,
        flowM,
        rowSetup,
        flows,
      );
      const sign =
        Math.abs(targetHedgeLocalM) > 1e-12
          ? targetHedgeLocalM >= 0
            ? 1
            : -1
          : openLocalM >= 0
            ? 1
            : -1;
      const equalVarHedgeLocalM = sign * Math.abs(eqAmount);
      // Leftover capacity after near-term cover (for cap flag only).
      const remainCapAbs = Math.max(
        0,
        Math.abs(accruedCap) - Math.abs(nonStripAmt) - Math.abs(stripNear),
      );
      // Same sign as Target N / Stock (cover). 100% Target → Hedge N = Target N.
      const hedgeNotionalLocalM = hasStrip
        ? stripAmt
        : targetHedgeLocalM * ratio;
      // Residual vs path-end when forecasting: 100% Target → e(Tf)=H → Δ=0
      // (bullet and strip). Th alone made Target look under-/over-hedged when Tf>Th.
      const Th = horizonMonths(rowSetup.horizon);
      const tenureForResid = Tf > 0 ? Tf : Th;
      const schedForPath =
        flows && flows.length > 0
          ? flows
          : Tf > 0
            ? Array.from({ length: Math.ceil(Tf) }, () => flowM)
            : [];
      const pathExposureM = accruedPositionFromScheduleM(
        stockM,
        schedForPath,
        tenureForResid,
      );
      const hedgeCoverM = hasStrip
        ? stripAmt + nonStripAmt
        : hedgeNotionalLocalM + nonStripAmt;
      const ErefM = Math.abs(totalRaw) > 1e-12 ? totalRaw : pathExposureM;
      // Resid VaR = V·|e−H|/|E(Tf)| — same as path modal / evolution (no floors).
      let varAfterUsdM = residualVarFromMismatchUsdM(
        varBeforeUsdM,
        pathExposureM,
        hedgeCoverM,
        ErefM,
      );
      if (varAfterUsdM < 1e-9) varAfterUsdM = 0;
      // Residual N = path e − H (matches |e−H| in evolution / modal).
      const residualLocalM = pathExposureM - hedgeCoverM;
      const delta =
        varBeforeUsdM < 1e-12
          ? 0
          : Math.min(1, Math.max(0, varAfterUsdM / varBeforeUsdM));
      const hedgeCapped =
        eqOpen.uncappedAbsLocalM > Math.abs(accruedCap) + 1e-12 ||
        eqOpen.uncappedAbsLocalM >
          remainCapAbs + Math.abs(nonStripAmt) + Math.abs(stripNear) + 1e-12;

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
