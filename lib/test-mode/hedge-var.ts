import {
  fcyToUsdM,
  fxBookNetLocalM,
  roundMoney,
  usdToFcyM,
  type LayerId,
  type RowState,
} from '@/lib/fx-buffer';
import Decimal from 'decimal.js';
import type { SwapForwardOverlay } from '@/lib/fx-hedge';
import {
  effectiveForecastUncertainty1m,
  effectiveMonthlyFxFlowLocalM,
  monthlyFxFlowSeriesLocalM,
  periodFxFlowSumLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import { computeTaskVar } from '@/lib/test-mode/task-var';
import { isUsdPerFcyQuoted, type FxMarketRatesBundle } from '@/lib/fx-market-rates';
import { bookedForwardFromSpotFill } from '@/lib/test-mode/click-trade-pad';
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

/**
 * Gross expected position over Tf: S + Σ F(t). Same number Live VaR Target N,
 * Approve New forecast, and mix cover (w × E) must share — never Atlas local.
 */
export function grossForecastTargetLocalM(
  stockNetM: number,
  forecastMonths: number,
  monthlyFlows?: readonly number[],
  monthlyFlowM = 0,
): number {
  const Tf =
    Number.isFinite(forecastMonths) && forecastMonths > 0 ? forecastMonths : 0;
  const S = Number.isFinite(stockNetM) ? stockNetM : 0;
  const F = Number.isFinite(monthlyFlowM) ? monthlyFlowM : 0;
  if (monthlyFlows && monthlyFlows.length > 0 && Tf > 0) {
    return roundMoney(accruedPositionFromScheduleM(S, monthlyFlows, Tf));
  }
  return roundMoney(exposureLocalMForBasis(S, F, 'totalBuildup', Tf));
}

/** Mix / Approve hedge base: gross forecast when present, else remaining Target. */
export function mixCoverTargetLocalM(row: {
  targetHedgeLocalM: number;
  forecastTargetLocalM?: number;
}): number {
  const e = row.forecastTargetLocalM;
  if (typeof e === 'number' && Number.isFinite(e)) return e;
  return row.targetHedgeLocalM;
}

/** Live booked notional expressed as cover of the forecast (same sign as E). */
export function bookedCoverOnForecastLocalM(
  forecastTargetLocalM: number,
  bookedCoverLocalM: number,
): number {
  const E = Number.isFinite(forecastTargetLocalM) ? forecastTargetLocalM : 0;
  const B = Number.isFinite(bookedCoverLocalM) ? bookedCoverLocalM : 0;
  if (Math.abs(E) < 1e-12) return B;
  return Math.sign(E) * Math.abs(B);
}

/** Unbooked clip of a mix: w × forecast − live booked cover. */
export function pendingHedgeCoverLocalM(
  forecastTargetLocalM: number,
  bookedCoverLocalM: number,
  hedgeRatio = 1,
): number {
  const w = Number.isFinite(hedgeRatio)
    ? Math.min(1, Math.max(0, hedgeRatio))
    : 1;
  const E = Number.isFinite(forecastTargetLocalM) ? forecastTargetLocalM : 0;
  // Leftover Target of 0 (already fully covered) must not become −booked
  // and re-open Book on the default forecast.
  if (Math.abs(E) < 1e-12) return 0;
  const B = bookedCoverOnForecastLocalM(E, bookedCoverLocalM);
  return roundMoney(w * E - B);
}

/** Pending / approved FX cover is committed — same as a live blotter hedge. */
export function isApprovalCommitted(
  p?: Pick<PreparedHedgeProfile, 'approvalStatus' | 'preparedFor'> | null,
): boolean {
  if (!p || p.preparedFor === 'liquidity') return false;
  return p.approvalStatus === 'pending' || p.approvalStatus === 'approved';
}

/** Target-signed cover already claimed by a pending / approved package. */
export function approvalCommittedCoverLocalM(
  forecastTargetLocalM: number,
  p?: Pick<PreparedHedgeProfile, 'approvalStatus' | 'preparedFor' | 'coverLocalM'> | null,
): number {
  if (!p || !isApprovalCommitted(p)) return 0;
  const cover = Number.isFinite(p.coverLocalM) ? p.coverLocalM : 0;
  return bookedCoverOnForecastLocalM(forecastTargetLocalM, cover);
}

/**
 * Clip that is still allowed to add (same sign as Target).
 * 0 when the live hedge — or a pending / approved package — already covers
 * w × E. Default forecast must not unlock another ticket.
 */
export function bookableHedgeCoverLocalM(
  forecastTargetLocalM: number,
  bookedCoverLocalM: number,
  hedgeRatio = 1,
  prepared?: Pick<
    PreparedHedgeProfile,
    'approvalStatus' | 'preparedFor' | 'coverLocalM'
  > | null,
): number {
  const E = Number.isFinite(forecastTargetLocalM) ? forecastTargetLocalM : 0;
  const pending = pendingHedgeCoverLocalM(E, bookedCoverLocalM, hedgeRatio);
  const extra = approvalCommittedCoverLocalM(E, prepared);
  const remaining = pending - extra;
  // Dust leftover (rounding / 12.10 vs 12.1004) must not re-open Book
  // or flip a fully covered long to SHORT.
  if (Math.abs(remaining) <= 0.005) return 0;
  return remaining;
}

/**
 * Ticket this package should book: the unbooked add, even when the package
 * was sized as full H* = w × E (mix restage). Never a stale leftover cover.
 */
export function preparedTicketCoverLocalM(
  p: { coverLocalM: number; hedgeRatio?: number },
  forecastTargetLocalM: number,
  bookedCoverLocalM: number,
): number {
  const ratio = p.hedgeRatio;
  const w =
    typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 1e-9
      ? ratio
      : 1;
  return bookableHedgeCoverLocalM(
    forecastTargetLocalM,
    bookedCoverLocalM,
    w,
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
  /**
   * Gross expected position over Tf (S + Σ flows), before booked cover.
   * Live VaR Target N / Approve New forecast / mix cover share this.
   */
  forecastTargetLocalM?: number;
  /** Σ live booked tickets (same sign as Target / cover). */
  bookedCoverLocalM?: number;
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
export type HedgeTicketStatus = 'booked' | 'scheduled' | 'cancelled';
export type HedgeOrderType = 'market' | 'limit' | 'takeProfit' | 'stopLoss' | 'oco';

/** Live IPA quote stamped when the desk Prices the ticket. */
export type HedgeIpaQuote = {
  strike: number | null;
  strikeInput: string;
  premiumUsd: number | null;
  premiumPercent: number | null;
  fxSpot: number | null;
  fxOutright: number | null;
  atmVolPercent: number | null;
  impliedVolPercent: number | null;
  deltaPercent: number | null;
  /** Δ points per 1% spot move. */
  gammaPercent?: number | null;
  /** Premium % of spot per 1 vol point. */
  vegaPercent?: number | null;
  /** Premium % of spot per calendar day. */
  thetaPercent?: number | null;
  /** Δ points per 1 vol point. */
  vannaPercent?: number | null;
  /** Vega change per 1 vol point. */
  volgaPercent?: number | null;
  errorMessage?: string;
};

export interface HedgeTicket {
  /** Stable id for the booked-transactions list / cancellation. */
  id: string;
  ccy: string;
  /** Spot / forward / option — chosen at book time (not forced by exposure basis). */
  instrument: HedgeInstrument;
  basis: VarExposureBasis;
  /** Local FCY millions to hedge (signed with exposure). */
  amountLocalM: number;
  /** Direction selected in the trade ticket; sign remains the hedge convention. */
  orderSide?: 'Buy' | 'Sell';
  /** Quote side selected in the trade ticket for scheduled execution. */
  orderHit?: 'bid' | 'ask';
  orderType?: HedgeOrderType;
  /** Forward / option tenor; null for spot. */
  maturity: VarHorizonId | null;
  maturityLabel: string | null;
  /**
   * Exact settle months for strip legs. VaR `maturity` buckets 6.3–8.2m into
   * `9m`, which must not share one matcher tape or one fill print.
   */
  maturityMonths?: number;
  varUsdM: number;
  /** True when this basis has the higher VaR of stock vs avg. */
  addressesHigherVar: boolean;
  /** Owning entity id — rolls into Group FX consolidation. */
  entityId?: string;
  /** Display name for consolidated booked-hedge lists. */
  entityName?: string;
  /**
   * `scheduled` = not yet traded. Market-booked rolling-strip legs are
   * `booked` from M0. A strip left as an order uses `scheduled` per leg
   * until that leg fills on the tape.
   */
  status?: HedgeTicketStatus;
  /**
   * When the desk dismissed this dead row from the blotter, epoch ms.
   *
   * A dismissal HIDES, it does not delete: a cancelled ticket is still the
   * only source of its leg's grey "where it rested" chart level
   * (chartTicketsAtEdge), can be the one leg carrying the strip's
   * `sourcePackage` ladder shape, and participates in edge resolution. So the
   * object stays in `bookedHedges` and only the blotter filters it out.
   *
   * Lives on the TICKET, not the book: normalizeHedgeBooksMap rebuilds
   * EntityHedgeBook from a fixed field whitelist, so a book-level field is
   * dropped on every load, PUT and sidecar parse — a ticket field is passed
   * through opaquely by every hop.
   *
   * Monotone under reconciliation: if any copy of an id carries a stamp, the
   * reconciled ticket carries the EARLIEST one. That makes the rule
   * idempotent and order-independent, so a dismissal survives the union
   * merge that otherwise resurrects cancelled orders.
   */
  dismissedAtMs?: number;
  /** Shared id for a rolling strip (all legs live from M0). */
  stripId?: string;
  /** 0-based edge index within the strip. */
  stripEdgeIndex?: number;
  /**
   * Forward points (market-pair pips) of the strip leg a spot-referenced
   * order hedges, stamped when the order is left. A spot bracket on an M11
   * leg executes on spot; the booked forward is that spot print plus these
   * points, so the all-in rate must not depend on re-pricing the curve at
   * render time (which once printed the bare spot fill as the M11 rate).
   */
  stripLegPoints?: number;
  /**
   * The ticket books its own instrument (a forward strip leg), but its level
   * rests on the SPOT tape: `limitRate` / `restingAnchorRate` are spot levels,
   * it triggers and records on `CCY|spot` (tapeInstrument), and a fill books
   * the spot print plus `stripLegPoints`. Set only with non-zero points —
   * spotTileStripLegFields is its one source.
   */
  isSpotReferenced?: boolean;
  /** Refinitiv IPA quote from Book → Price (optional). */
  ipaQuote?: HedgeIpaQuote;
  /**
   * Staged package this ticket was booked from. Cancel strip / cancel ticket
   * restages this instead of falling back to the default EUR bullet.
   * Attached on the first leg of a strip (looked up by stripId).
   */
  sourcePackage?: PreparedHedgeProfile;
  /**
   * Resting limit ("leave") order level, in the MARKET-pair quote convention —
   * the same convention as `ipaQuote.fxOutright` and the simulated tape (e.g.
   * USDPLN = PLN per USD), NOT USD-per-FCY. Set only on a `scheduled` order
   * left to work; absent on a ticket that was hit at market.
   */
  limitRate?: number;
  /**
   * The mid the desk was looking at when the order was left, in the same
   * MARKET-pair convention as `limitRate`. The monitor walks around THIS, not
   * the stored curve seed — otherwise a level set against a live print can sit
   * outside the walk's range and never fill.
   */
  restingAnchorRate?: number;
  /**
   * Shared id for a one-cancels-other pair. When one leg fills the monitor
   * removes its siblings — a bracket must never leave both legs live.
   */
  ocoGroupId?: string;
  /** Which leg of the bracket this is, for display. */
  bracketRole?: BracketRole;
  /** Wall-clock ms when a resting order filled. */
  filledAtMs?: number;
  /** Dealer the trade was done with. Set on fill — a working order has none. */
  counterparty?: string;
  /** Day vs good-till-cancelled, as selected on the ticket. */
  orderValidity?: 'DAY' | 'GTC';
  /** Wall-clock ms when a DAY order expires (NY 17:00). Absent on GTC. */
  goodTillMs?: number;
}

/** Shown on a resting order the automated cap refuses to fill. Carries no amounts. */
export const OVER_AUTOMATED_LIMIT_NOTE =
  'Over automated limit — needs FX Lead + CFO';

/** Live (traded) tickets — scheduled and cancelled orders do not count. */
export function isLiveHedgeTicket(t: HedgeTicket): boolean {
  return t.status !== 'scheduled' && t.status !== 'cancelled';
}

/**
 * Can this order still be edited?
 *
 * Only a working order with a level of its own: editing resubmits, which
 * cancels the original and places a replacement, and neither is meaningful
 * for an order that has already filled or been cancelled.
 *
 * The Edit action used to be offered for any order opened read-only from the
 * blotter, while the handler behind it returned silently unless the order was
 * scheduled — so Edit on a filled order looked available and did nothing.
 * Both sides now ask this, of the ticket that would actually be edited (an
 * OCO pair's primary), so they cannot disagree.
 */
export function isEditableWorkingOrder(
  t: Pick<HedgeTicket, 'status' | 'limitRate'> | null | undefined,
): boolean {
  if (!t || t.status !== 'scheduled') return false;
  const limit = t.limitRate;
  return limit != null && Number.isFinite(limit) && limit > 0;
}

/**
 * True when the ticket has an actual market print (live hit or matcher fill).
 * A rolling-strip leg booked from M0 without a fill is live cover, but not
 * a print — later working orders may still rest on empty edges, not on this.
 */
export function isMarketExecutedHedgeTicket(t: HedgeTicket): boolean {
  if (t.status !== 'booked') return false;
  // filledAtMs is the ONLY print evidence: every fill path (live hit,
  // matcher, client fallback) stamps it. orderHit is the UI tile the level
  // was typed into and is set on every ticket left through the ticket UI —
  // treating it as a print made any booked UI ticket count as executed
  // even when it booked without one (review finding 12).
  return t.filledAtMs != null && Number.isFinite(t.filledAtMs) && t.filledAtMs > 0;
}

/**
 * Single source of truth for "what is this strip leg's state right now,"
 * given every ticket ever created at that edge: filled beats working beats
 * cancelled. Used by the ticket panel's chart (level lines, placement pin,
 * fill marker, and the "Strip · priced legs" row list) and by the
 * verify-strip-legs API route, so none of them can independently latch onto
 * a different ticket at the same edge (e.g. a cancelled OCO sibling's stale
 * level) than what any of the others resolve.
 */
export function legPeersAtEdge(
  ownStripTickets: readonly HedgeTicket[],
  edgeIndex: number,
  opts?: { coverOnly?: boolean },
): { filled?: HedgeTicket; working: HedgeTicket[]; cancelled?: HedgeTicket } {
  const peers = ownStripTickets.filter(t => (t.stripEdgeIndex ?? 0) === edgeIndex);
  // The cover leg's own fill wins. `coverOnly` additionally refuses to let
  // a legacy SPOT bracket stand in when the cover has not traded: it booked
  // a bare spot print, and on the priced-legs row it printed that SPOT
  // price under the leg's FORWARD label (an M6 row reading 1.16302, the
  // take-profit's fill, where the leg's own outright was 1.17078). A
  // spot-referenced bracket (`isSpotReferenced`) books the leg's own
  // forward at spot + its points, so its fill IS the leg trading and does
  // count. Consumers that report an edge's execution as such — the chart's
  // level lines, the verify-strip-legs replay — still want every bracket
  // fill, so this is opt in per call site rather than a change for everyone.
  const filled =
    peers.find(t => !t.bracketRole && isMarketExecutedHedgeTicket(t))
    ?? (opts?.coverOnly
      ? peers.find(t => t.isSpotReferenced && isMarketExecutedHedgeTicket(t))
      : peers.find(isMarketExecutedHedgeTicket));
  const working = filled
    ? peers.filter(t => t.status === 'scheduled' && t.bracketRole)
    : peers.filter(t => t.status === 'scheduled');
  const cancelled = peers.find(t => t.status === 'cancelled');
  return { filled, working, cancelled };
}

/**
 * Has this strip started — at least one working or filled order on the
 * strategy? After that the ladder is frozen: remaining clip trades as
 * Spot / FWD / Option, not by adding or deleting legs.
 */
export function stripExecutionStarted(
  stripTickets: readonly HedgeTicket[],
): boolean {
  return stripTickets.some(
    t => t.status === 'scheduled' || isMarketExecutedHedgeTicket(t),
  );
}

/**
 * Is this strip finished — every edge of its own ladder executed, with
 * nothing still working?
 *
 * A Book compose mints a `stripId` that is on nothing yet, so the panel is
 * handed the currency's most recent strip instead. While that strip is
 * part-worked that is right: its free slots are the ones Book fills, and
 * hiding them would show legs whose clicks go nowhere. Once it is DONE the
 * reasoning inverts — the desk is starting the next ladder, and inheriting
 * six executed legs marks every row of the new one as already filled.
 *
 * Strict on purpose. A still-resting order means the book is live, so a
 * filled cover with a working bracket beside it is not finished; neither is
 * a ladder with an edge that never traded.
 */
export function stripFullyExecuted(
  stripTickets: readonly HedgeTicket[],
): boolean {
  if (stripTickets.length === 0) return false;
  if (stripTickets.some(t => t.status === 'scheduled')) return false;
  const seed = stripTickets.find(t => t.status !== 'cancelled');
  if (!seed) return false;
  const pkg = stripPackageForTicketView(stripTickets, seed);
  if (pkg?.structure !== 'strip' || pkg.legs.length < 2) return false;
  return pkg.legs.every(
    (_leg, edgeIndex) => legPeersAtEdge(stripTickets, edgeIndex).filled != null,
  );
}

/**
 * Which booked strip the overlay should resume. A Decision Book compose
 * always mints a fresh `stripId` that matches nothing on the book — that
 * used to fall through to a leftover-scaled *new* ladder, then map the
 * previous attempt's filled edges onto it by index. One executed leg and
 * three intact ones became a new 9.68M booking with L1 already grey, so
 * outstanding showed the leftover-scaled remainder (6.59M) instead of the
 * original remaining rows.
 *
 * Resume the part-worked strip. A finished one is not supplied as peers
 * (clean sheet). An exact `ticket.stripId` match still wins when the desk
 * reopens that blotter ticket.
 *
 * "Finished" means finished BEFORE this overlay opened (`openedAtMs`). A
 * strip whose last leg fills while the modal is open is the strip being
 * traded here: dropping it at that instant flipped the panel onto a
 * leftover ladder on other tenors, so the legs just executed read PENDING
 * until the modal was reopened.
 */
export function bookedStripResumeSeed(
  ticketStripId: string | undefined,
  ownStripTickets: readonly HedgeTicket[],
  openedAtMs?: number | null,
): HedgeTicket | undefined {
  if (ownStripTickets.length < 1) return undefined;
  if (ticketStripId) {
    const exact = ownStripTickets.find(t => t.stripId === ticketStripId);
    if (exact) return exact;
  } else {
    // Bullet Book compose has no stripId — do not pull a live strip in.
    return undefined;
  }
  if (!stripExecutionStarted(ownStripTickets)) return undefined;
  // The strip as it stood when the overlay opened: fills since then are
  // this session's, not evidence the strip was already finished.
  const atOpen =
    openedAtMs != null && Number.isFinite(openedAtMs)
      ? ownStripTickets.filter(
          t => !(t.filledAtMs != null && Number.isFinite(t.filledAtMs) && t.filledAtMs >= openedAtMs),
        )
      : ownStripTickets;
  if (!stripFullyExecuted(atOpen)) {
    return ownStripTickets.find(t => t.status !== 'cancelled');
  }
  return undefined;
}

function ticketHasRestingLevel(t: HedgeTicket): boolean {
  return t.limitRate != null && t.limitRate > 0;
}

/**
 * Tickets whose price lines the tape chart should draw for one strip edge.
 *
 * `legPeersAtEdge` prefers the live cover print — correct for the priced-legs
 * row and Decision blotter. The chart must not: when the desk is on a
 * take-profit / stop-loss ticket, a prior market cover fill at the same edge
 * was drawn as a pink `FILL · LIMIT · BID` arrow under the resting TP line,
 * looking exactly like the TP filled before price reached it.
 *
 * - Bracket focus: that edge's filled TP/SL ticket, plus its OCO sibling if
 *   the fill auto-cancelled it (so the chart still shows where the
 *   cancelled leg was resting) — else working > cancelled.
 * - Cover / plain: filled cover plus any still-working brackets (so a resting
 *   TP stays visible after the cover prints), plus the same auto-cancelled
 *   OCO sibling, else cancelled.
 *
 * The cancelled sibling is returned on BOTH paths on purpose. It is not the
 * opened ticket's decoration — it belongs to the edge, and this function is
 * already scoped to one edge — so gating it on the caller's `focus` made it
 * vanish whenever `chartIsOwnLeg` was false, which on a strip opened from the
 * spot tile is most of the time: `legTicketForSelectedLeg`'s `atTenor` short-
 * circuits to true for every leg there, so `chartTicket` resolves to some
 * other leg's ticket, `chartIsOwnLeg` goes false, focus arrives null, and the
 * desk saw the filled leg's yellow line with no grey level anywhere.
 */
export function chartTicketsAtEdge(
  ownStripTickets: readonly HedgeTicket[],
  edgeIndex: number,
  focus?: Pick<HedgeTicket, 'bracketRole'> | null,
): HedgeTicket[] {
  const peers = ownStripTickets.filter(t => (t.stripEdgeIndex ?? 0) === edgeIndex);
  /**
   * Brackets this edge's fills auto-cancelled — matched by `ocoGroupId`, not
   * merely "cancelled and at this edge". Re-leaving an OCO on a leg that
   * already cycled leaves the previous round's cancelled sibling on the book
   * too, and an unscoped filter drew a grey level for every one of them:
   * two OCO cycles on one leg put four lines on the chart, two of them from
   * orders the desk had already finished with.
   */
  const cancelledOcoSiblingsOf = (fills: readonly HedgeTicket[]): HedgeTicket[] => {
    const groups = new Set(
      fills.map(t => t.ocoGroupId).filter((id): id is string => id != null),
    );
    if (groups.size === 0) return [];
    return peers.filter(
      t =>
        t.status === 'cancelled'
        && t.ocoGroupId != null
        && groups.has(t.ocoGroupId)
        && ticketHasRestingLevel(t),
    );
  };

  if (focus?.bracketRole === 'takeProfit' || focus?.bracketRole === 'stopLoss') {
    const brackets = peers.filter(t => t.bracketRole != null);
    const filled = brackets.filter(isMarketExecutedHedgeTicket);
    if (filled.length > 0) {
      // An OCO fill auto-cancels its sibling rather than removing it (see
      // requestCancellation vs the OCO auto-cancel in
      // HedgingDecisionLayer) — it is still in the book with its original
      // limitRate, so the chart can draw where it rested, not just drop it.
      return [
        ...filled.filter(ticketHasRestingLevel),
        ...cancelledOcoSiblingsOf(filled),
      ];
    }
    const working = brackets.filter(t => t.status === 'scheduled');
    if (working.length > 0) return working.filter(ticketHasRestingLevel);
    return brackets
      .filter(t => t.status === 'cancelled')
      .filter(ticketHasRestingLevel);
  }

  const { filled, working, cancelled } = legPeersAtEdge(ownStripTickets, edgeIndex);
  if (filled) {
    // Every bracket fill at this edge, not just `legPeersAtEdge`'s single
    // preferred one: it prefers the cover, and the OCO group that cancelled a
    // sibling is usually a bracket's, so asking it alone found no group.
    const bracketFills = peers.filter(
      t => t.bracketRole != null && isMarketExecutedHedgeTicket(t),
    );
    const cancelledSiblings = cancelledOcoSiblingsOf([filled, ...bracketFills]);
    const levels = [
      ...(ticketHasRestingLevel(filled) ? [filled] : []),
      ...working.filter(ticketHasRestingLevel),
      ...cancelledSiblings,
    ];
    if (levels.length > 0) return levels;
    return cancelled && ticketHasRestingLevel(cancelled) ? [cancelled] : [];
  }
  if (working.length > 0) return working.filter(ticketHasRestingLevel);
  return cancelled && ticketHasRestingLevel(cancelled) ? [cancelled] : [];
}

/**
 * Which ticket's execution print becomes the tape FILL arrow for this edge.
 *
 * Bracket focus → only that role's fill (never the cover). Cover focus →
 * cover-first via `legPeersAtEdge.filled`. A working TP must yield no arrow
 * even when the cover already printed.
 */
export function fillTicketAtEdge(
  ownStripTickets: readonly HedgeTicket[],
  edgeIndex: number,
  focus?: Pick<
    HedgeTicket,
    'bracketRole' | 'stripEdgeIndex' | 'status' | 'orderHit' | 'filledAtMs' | 'id'
  > | null,
): HedgeTicket | undefined {
  const peers = ownStripTickets.filter(t => (t.stripEdgeIndex ?? 0) === edgeIndex);
  if (focus?.bracketRole === 'takeProfit' || focus?.bracketRole === 'stopLoss') {
    const roleFill = peers.find(
      t => t.bracketRole === focus.bracketRole && isMarketExecutedHedgeTicket(t),
    );
    if (roleFill) return roleFill;
    if (
      (focus.stripEdgeIndex ?? 0) === edgeIndex
      && isMarketExecutedHedgeTicket(focus as HedgeTicket)
    ) {
      return focus as HedgeTicket;
    }
    return undefined;
  }
  return (
    legPeersAtEdge(ownStripTickets, edgeIndex).filled
    ?? (
      focus != null
      && (focus.stripEdgeIndex ?? 0) === edgeIndex
      && isMarketExecutedHedgeTicket(focus as HedgeTicket)
        ? (focus as HedgeTicket)
        : undefined
    )
  );
}

/**
 * Identity of a resting limit independent of ticket id. The matcher uses this
 * so a browser re-sync cannot resurrect a filled TP/SL under a new `ht-` id.
 */
export function hedgeRestingKey(t: {
  ccy: string;
  instrument?: HedgeTicket['instrument'];
  basis?: HedgeTicket['basis'];
  bracketRole?: HedgeTicket['bracketRole'];
  limitRate?: number | null;
  amountLocalM: number;
  ocoGroupId?: string;
  stripId?: string;
  stripEdgeIndex?: number;
}): string {
  const limit =
    t.limitRate != null && Number.isFinite(t.limitRate)
      ? t.limitRate.toFixed(6)
      : '';
  const amt = Number.isFinite(t.amountLocalM) ? t.amountLocalM.toFixed(4) : '';
  return [
    t.ccy,
    t.instrument ?? '',
    t.basis ?? '',
    t.bracketRole ?? '',
    limit,
    amt,
    t.ocoGroupId ?? '',
    t.stripId ?? '',
    t.stripEdgeIndex != null ? String(t.stripEdgeIndex) : '',
  ].join('|');
}

/** Resting limit still working on the tape. */
export function isWorkingHedgeTicket(t: HedgeTicket): boolean {
  return t.status === 'scheduled';
}

/**
 * Execution state of one ticket, for any surface that shows order status.
 *
 * All-or-nothing on purpose: a ticket carries one notional with no
 * filled-so-far quantity, so there is no partial state here. Partial is a
 * property of a multi-leg strip, derived from its legs.
 */
export type HedgeTicketExecutionState =
  | 'FILLED'
  | 'WORKING'
  | 'HELD'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

export function hedgeTicketExecutionState(
  t: HedgeTicket,
  nowMs: number,
): HedgeTicketExecutionState {
  if (t.status === 'cancelled') return 'CANCELLED';
  // A booked fill is done even if the cap note was still on the quote when
  // the matcher crossed — notifications must not keep saying HELD / partial.
  if (t.status === 'booked') return 'FILLED';
  const err = t.ipaQuote?.errorMessage;
  // The automated-cap note is not a dealer break — the order stands, it just
  // needs a human to release it.
  if (err === OVER_AUTOMATED_LIMIT_NOTE) return 'HELD';
  if (err) return 'REJECTED';
  if (t.status === 'scheduled') {
    return t.goodTillMs != null && nowMs > t.goodTillMs ? 'EXPIRED' : 'WORKING';
  }
  return 'FILLED';
}

/**
 * Decision STRUCTURE / expanded-card order counts. Working limits (including
 * a policy HELD rest) are pending; live fills are filled. Cancelled / expired
 * / rejected tickets are omitted so a 5-leg OCO strip jumps pending as soon
 * as `setBooked` receives the scheduled tickets — not after a matcher fill.
 */
export function decisionCcyOrderCounts(
  tickets: readonly HedgeTicket[],
  nowMs = Date.now(),
): { pending: number; filled: number } {
  let pending = 0;
  let filled = 0;
  for (const t of tickets) {
    const state = hedgeTicketExecutionState(t, nowMs);
    if (state === 'WORKING' || state === 'HELD') pending += 1;
    else if (state === 'FILLED') filled += 1;
  }
  return { pending, filled };
}

/** STRUCTURE column / expanded-card subtitle from staged legs + live orders. */
export function decisionStructureCaption(input: {
  stagedLegs: number;
  stagedKind: 'strip' | 'bullet' | null;
  isStrip: boolean;
  draftLegCount: number;
  pending: number;
  filled: number;
  /**
   * Covering already exceeds target, so the next trade is a buy-back and the
   * staged package is not what it books. Saying "6 staged strip" above a
   * table showing the single bullet buy-back reads as a table that lost five
   * rows; it is the caption describing a different thing from the rows.
   */
  isUnwind?: boolean;
}): string {
  const parts: string[] = [];
  if (!input.isUnwind && input.stagedLegs > 0 && input.stagedKind) {
    parts.push(`${input.stagedLegs} staged ${input.stagedKind}`);
  }
  if (input.filled > 0) parts.push(`${input.filled} filled`);
  if (input.pending > 0) parts.push(`${input.pending} pending`);
  if (input.isUnwind) parts.push('unwind buy-back');
  if (parts.length > 0) return parts.join(' · ');
  return input.isStrip ? `${input.draftLegCount}-leg strip` : 'bullet';
}

/** Drop a policy hold from a quote that just filled. */
export function quoteAfterFill(
  quote: HedgeIpaQuote | null | undefined,
  fill: { fxOutright: number | null; fxSpot: number | null },
): HedgeIpaQuote {
  const base = quote ?? {
    strike: null,
    strikeInput: '',
    premiumUsd: null,
    premiumPercent: null,
    fxSpot: null,
    fxOutright: null,
    atmVolPercent: null,
    impliedVolPercent: null,
    deltaPercent: null,
  };
  const { errorMessage: _cap, ...rest } = base;
  return { ...rest, fxOutright: fill.fxOutright, fxSpot: fill.fxSpot };
}

/**
 * Fill quote of a spot-referenced order (`isSpotReferenced`): it executed at
 * `spotFillPx` on the spot tape and books the forward leg it was left for —
 * `fxSpot` is that execution print, `fxOutright` the print plus the leg's
 * stamped points. Null for every other ticket; those stamp their fill as
 * before.
 */
export function spotReferencedFillQuote(
  ticket: Pick<HedgeTicket, 'ccy' | 'isSpotReferenced' | 'stripLegPoints'>,
  spotFillPx: number,
): { fxOutright: number; fxSpot: number } | null {
  if (!ticket.isSpotReferenced) return null;
  const fxOutright = bookedForwardFromSpotFill({
    fillPx: spotFillPx,
    points: ticket.stripLegPoints,
    ccy: ticket.ccy,
  });
  return fxOutright == null ? null : { fxOutright, fxSpot: spotFillPx };
}

/**
 * Automated hedges book without manual approval only up to this notional.
 * Above it needs FX Lead + CFO, so an automated fill must STOP rather than
 * book. Source: `div/policy.md` → FX trade limits;
 * `div/fx-hedging-policy.md` → Approval Thresholds.
 */
export const AUTOMATED_HEDGE_LIMIT_USD_M = 10;

/**
 * Does a resting limit order trigger at this quote? New tickets use the quote
 * side selected in the ticket; legacy tickets fall back to signed notional.
 *
 * `quote` is in the MARKET-pair convention the tape walks, matching
 * `limitRate`. Do not pass a USD-per-FCY spot here.
 */
export function restingOrderTriggersAt(
  ticket: HedgeTicket,
  quote: { bid: number; ask: number },
): boolean {
  if (ticket.status !== 'scheduled') return false;
  const limit = ticket.limitRate;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return false;
  const sellsFcy = ticket.amountLocalM >= 0;
  // Which side of the quote we trade, and which direction is the FAVORABLE
  // (limit-style) one, both depend on whether the FCY is the pair's BASE.
  // EURUSD is USD per EUR, so selling EUR lifts the bid and a HIGHER rate is
  // better. USDPLN is PLN per USD, so selling PLN is buying the base USD: we
  // pay the ask and a LOWER rate is better. Getting this wrong fires on the
  // wrong side of the spread for the 11 USD-base desk CCYs.
  //
  // `orderHit` only ever names the side this ticket's own level already sits
  // on (chosen by the UI when the order was left) — it is not an independent
  // direction signal, so it is not used here. A stop-loss triggers as a
  // market order the instant the adverse side reaches it, so it samples the
  // same side a plain resting order does (liftsBid) and only the direction
  // is inverted. A take-profit behaves as a passive resting order instead —
  // it is filled by whichever side of the market actually reaches it, which
  // is the OPPOSITE quote side from the one liftsBid names (2026-09-08
  // desk instruction: EUR Buy TP fills at bid, EUR Sell TP fills at ask —
  // the reverse of the stop-loss/plain-order convention on the same ticket).
  // The favorable DIRECTION (which way is "better" for this position) does
  // not change with which side is sampled — only the take-profit's sampled
  // side does — so `liftsBid` still drives crossedUp/crossedDown below.
  const fcyIsBase = isUsdPerFcyQuoted(ticket.ccy);
  const liftsBid = sellsFcy === fcyIsBase;
  const isTakeProfit = ticket.bracketRole === 'takeProfit';
  const px = liftsBid === isTakeProfit ? quote.ask : quote.bid;
  if (!Number.isFinite(px) || px <= 0) return false;
  // No distance veto here (product decision 2026-09-08, removing the 40-pip
  // TAPE_MAX_JUMP_PIPS cap on orders): a TP/SL may rest any distance from
  // market and still fill when its own tape crosses it. Wrong-convention
  // protection is structural now — the matcher only ever hands this ticket
  // the quote under its own tapeQuoteKey, and the runtime's feed gates
  // (quoteIsWrongTapeForOrder there) still keep foreign prints off a key.
  const level = new Decimal(limit);
  const crossedUp = new Decimal(px).gte(level);
  const crossedDown = new Decimal(px).lte(level);
  if (ticket.bracketRole === 'stopLoss') {
    return liftsBid ? crossedDown : crossedUp;
  }
  // Take-profit is strictly better than the live print. Inclusive gte parks
  // the tape ON the level (bid === limit) and "fills" a rest that was 2 pips away.
  if (isTakeProfit) {
    return liftsBid ? new Decimal(px).gt(level) : new Decimal(px).lt(level);
  }
  return liftsBid ? crossedUp : crossedDown;
}

/**
 * Ticket UI Buy/Sell is the market pair's BASE (EUR on EURUSD, USD on
 * USDMXN). Hedge `amountLocalM` > 0 always sells `ticket.ccy` (the FCY).
 * On a USD-base pair those are opposites: Sell USD is Buy MXN.
 */
export function sellsFcyFromPairSide(
  pairBaseSide: 'Buy' | 'Sell',
  ticketCcy: string,
  pairBaseCcy: string,
): boolean {
  const sellingBase = pairBaseSide === 'Sell';
  const fcyIsBase = ticketCcy.toUpperCase() === pairBaseCcy.toUpperCase();
  return fcyIsBase ? sellingBase : !sellingBase;
}

export function fcySideFromPairSide(
  pairBaseSide: 'Buy' | 'Sell',
  ticketCcy: string,
  pairBaseCcy: string,
): 'Buy' | 'Sell' {
  return sellsFcyFromPairSide(pairBaseSide, ticketCcy, pairBaseCcy)
    ? 'Sell'
    : 'Buy';
}

export function signedLocalMForPairSide(
  pairBaseSide: 'Buy' | 'Sell',
  sizeM: number,
  ticketCcy: string,
  pairBaseCcy: string,
): number {
  return (
    (sellsFcyFromPairSide(pairBaseSide, ticketCcy, pairBaseCcy) ? 1 : -1)
    * Math.abs(sizeM)
  );
}

export type RestingLevelStatus = 'rests' | 'triggered' | 'invalid';

/**
 * Plain leave-order: any strictly off-market difference (including 1 pip)
 * is a rest. At or through the tradeable touch is marketable.
 */
export function classifyRestingLevel(
  ticket: HedgeTicket,
  quote: { bid: number; ask: number },
): RestingLevelStatus {
  const limit = ticket.limitRate;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return 'invalid';
  if (!(quote.bid > 0) || !(quote.ask > 0)) return 'invalid';
  const probe: HedgeTicket = { ...ticket, status: 'scheduled' };
  if (restingOrderTriggersAt(probe, quote)) return 'triggered';
  return 'rests';
}

/**
 * Bracket TP/SL vs the LIVE REF on that pad (bid pad vs bid, ask pad vs ask).
 * Take profit must be strictly *better* than that print; stop loss strictly
 * *worse*. Direction follows FCY sign vs quote convention: buy the pair base
 * cheaper (TP below), sell the pair base dearer (TP above). `amountLocalM`
 * must be the FCY hedge sign — Sell USD on USDMXN is a MXN *buy* (negative).
 */
export function classifyBracketLevel(
  ticket: HedgeTicket,
  quote: { bid: number; ask: number },
): RestingLevelStatus {
  const limit = ticket.limitRate;
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return 'invalid';
  if (!(quote.bid > 0) || !(quote.ask > 0)) return 'invalid';
  // Measure against the side the matcher actually watches
  // (restingOrderHitSide — the same convention restingOrderTriggersAt
  // uses), never ticket.orderHit: that is the typed UI tile, a full spread
  // away for a bracket leg, so gating on it refused legitimate in-spread
  // levels the matcher would happily have rested.
  const hit = restingOrderHitSide(ticket);
  const ref = hit === 'bid' ? quote.bid : quote.ask;
  if (!Number.isFinite(ref) || !(ref > 0)) return 'invalid';
  const sellsFcy = ticket.amountLocalM >= 0;
  const betterIsHigher = sellsFcy === isUsdPerFcyQuoted(ticket.ccy);
  const wantHigher = ticket.bracketRole === 'stopLoss' ? !betterIsHigher : betterIsHigher;
  const delta = new Decimal(limit).minus(ref);
  const onSide = wantHigher ? delta.gt(0) : delta.lt(0);
  return onSide ? 'rests' : 'triggered';
}

export type BracketRole = 'takeProfit' | 'stopLoss';

/**
 * Which leg of a bracket a level is, given the side BOTH levels are quoted on.
 *
 * Hitting the bid sells, and a seller profits as the rate falls — so the LOWER
 * level is the profit target and the higher one is the stop. Lifting the ask
 * buys, so it is the other way round. Equal levels are not a bracket.
 */
export function bracketRoleFor(
  side: 'bid' | 'ask',
  level: number,
  otherLevel: number,
): BracketRole | null {
  if (!Number.isFinite(level) || !Number.isFinite(otherLevel)) return null;
  if (level <= 0 || otherLevel <= 0) return null;
  if (new Decimal(level).eq(otherLevel)) return null;
  const isLower = new Decimal(level).lt(otherLevel);
  const lowerIsTakeProfit = side === 'bid';
  return isLower === lowerIsTakeProfit ? 'takeProfit' : 'stopLoss';
}

/** The two legs of a bracket, or null when the pair cannot form one. */
export function bracketLegs(
  side: 'bid' | 'ask',
  levelA: number,
  levelB: number,
): { takeProfit: number; stopLoss: number } | null {
  const roleA = bracketRoleFor(side, levelA, levelB);
  if (roleA == null) return null;
  return roleA === 'takeProfit'
    ? { takeProfit: levelA, stopLoss: levelB }
    : { takeProfit: levelB, stopLoss: levelA };
}

/**
 * Which side of the quote a resting order works on. Same convention as
 * `restingOrderTriggersAt` — kept here so the trigger rule and anything that
 * displays the side cannot drift apart. Deliberately ignores `orderHit`: it
 * names which UI tile the level was typed into (a display/arming concept —
 * see limitOrderSideForHit vs orderSideForHit in TradeTicketPanel), not
 * which market side the trade actually executes on. A real ticket always
 * has `orderHit` set, and for a bracket leg it commonly does NOT match this
 * derivation — trusting it here would let the recorded/displayed side
 * silently disagree with what actually triggers the fill.
 */
export function restingOrderHitSide(ticket: HedgeTicket): 'bid' | 'ask' {
  const sellsFcy = ticket.amountLocalM >= 0;
  const liftsBid = sellsFcy === isUsdPerFcyQuoted(ticket.ccy);
  // Take-profit fills at the opposite side from stop-loss/plain on the same
  // ticket — see restingOrderTriggersAt.
  const isTakeProfit = ticket.bracketRole === 'takeProfit';
  return liftsBid === isTakeProfit ? 'ask' : 'bid';
}

/**
 * USD per 1 unit of the ticket's CCY, taken from the same market quote the
 * order fills against — so the notional the policy cap is measured on comes
 * from the executing rate, not a fixture pinned for scoring.
 */
export function usdPerLocalFromQuote(ccy: string, quoteMid: number): number {
  if (!Number.isFinite(quoteMid) || quoteMid <= 0) return 0;
  return isUsdPerFcyQuoted(ccy)
    ? quoteMid
    : new Decimal(1).div(quoteMid).toNumber();
}

/**
 * USD-equivalent notional of a ticket. `spotUsdPerLocal` is supplied by the
 * caller so the rate's source stays explicit — there is no implicit
 * "current rate" here.
 */
export function ticketNotionalUsdM(
  ticket: HedgeTicket,
  spotUsdPerLocal: number,
): number {
  if (!Number.isFinite(spotUsdPerLocal) || spotUsdPerLocal <= 0) return 0;
  return new Decimal(ticket.amountLocalM)
    .abs()
    .mul(spotUsdPerLocal)
    .toNumber();
}

/**
 * Whether an automated fill of this order is inside the automated-hedge
 * notional cap. `false` means the level triggered but the fill must NOT book —
 * it needs FX Lead + CFO first. Options need FX Lead sign-off at any notional.
 */
export function autoFillAllowedByPolicy(
  ticket: HedgeTicket,
  spotUsdPerLocal: number,
  /**
   * USD notional already committed for this CCY in this beat — live cover plus
   * anything else filling alongside. The cap is on the position, so without
   * this three 9M orders at one level would each pass and book 27M unapproved.
   */
  alreadyCommittedUsdM = 0,
): boolean {
  if (ticket.instrument === 'option') return false;
  const notionalUsdM = ticketNotionalUsdM(ticket, spotUsdPerLocal);
  if (notionalUsdM <= 0) return false;
  const committed = Number.isFinite(alreadyCommittedUsdM)
    ? Math.abs(alreadyCommittedUsdM)
    : 0;
  return new Decimal(notionalUsdM)
    .plus(committed)
    .lte(AUTOMATED_HEDGE_LIMIT_USD_M);
}

/**
 * Drop the live bullet (non-strip) ticket for a CCY *within one book scope* so a
 * re-book supersedes it rather than stacking a second cover on the same
 * exposure. Strips already have this via `mergeRollingStripIntoBook`; bullets
 * had no equivalent, so repeated Book clicks accumulated.
 *
 * `scopeId` is mandatory and must be the booking scope (`ratesScopeId`:
 * `GROUP_HEDGE_SCOPE` on the consolidated desk, `entity.id` on an entity desk).
 * At group scope `booked` is the CROSS-ENTITY aggregate from
 * `aggregateBookedHedges`, so a ccy-only filter would delete other entities'
 * hedges — scoping is what prevents that.
 *
 * `instrument` is equally load-bearing: only a like-for-like cover is
 * superseded. A forward must never silently drop a live option on the same
 * CCY — that option carries a paid premium and is a separate position.
 *
 * Strip legs and `scheduled` tickets are left alone — those are separate
 * positions, not a re-book of this one.
 */
function isLiveScopedCover(
  t: HedgeTicket,
  ccy: string,
  scopeId: string,
): boolean {
  return (
    t.ccy === ccy &&
    (t.entityId ?? GROUP_HEDGE_SCOPE) === scopeId &&
    !t.stripId &&
    isLiveHedgeTicket(t)
  );
}

export function clearLiveBulletForCcy(
  booked: readonly HedgeTicket[],
  ccy: string,
  scopeId: string,
  instrument: HedgeInstrument,
): HedgeTicket[] {
  return booked.filter(
    t => !(isLiveScopedCover(t, ccy, scopeId) && t.instrument === instrument),
  );
}

/** Any live non-strip cover already booked for this CCY in this scope. */
export function hasLiveCoverForCcy(
  booked: readonly HedgeTicket[],
  ccy: string,
  scopeId: string,
): boolean {
  return booked.some(t => isLiveScopedCover(t, ccy, scopeId));
}

/**
 * Hedge (forward-points) carry for whichever regime is currently in effect
 * for this CCY: the staged package if one is present, else the actually-
 * booked live cover. Mirrors `tenor-risk-ladder.ts`'s `coverPreparedForLadder`
 * precedence exactly (staged first, non-zero cover, else booked) so a
 * "locked carry" figure and an "M2M" figure computed from the same inputs
 * describe the same assumed position — never a staged-regime M2M sitting
 * next to a booked-only carry, or vice versa.
 *
 * `bookedForCcy` should already be filtered to this CCY (and, at group scope,
 * to the booking scope — see `clearLiveBulletForCcy`'s scoping note); this
 * function only filters out non-live (`scheduled`) tickets.
 */
export function modeledHedgeCarryUsdM(
  prepared: PreparedHedgeProfile | null | undefined,
  bookedForCcy: readonly HedgeTicket[],
): number {
  if (prepared && Math.abs(prepared.coverLocalM) > 1e-12) {
    return prepared.impliedCarryUsdM ?? 0;
  }
  return bookedForCcy
    .filter(isLiveHedgeTicket)
    .reduce((s, t) => s + (t.sourcePackage?.impliedCarryUsdM ?? 0), 0);
}

/** Economic settle months from a booked ticket label (strip `settle M6` / bullet tenor). */
export function settleMonthsFromHedgeTicket(t: HedgeTicket): number {
  const label = t.maturityLabel ?? '';
  const settleM = /settle\s+M(\d+(?:\.\d+)?)/i.exec(label);
  if (settleM) return Number(settleM[1]);
  const settleT = /settle\s+t=(\d+(?:\.\d+)?)/i.exec(label);
  if (settleT) return Number(settleT[1]);
  const window = /M0[–-]M(\d+(?:\.\d+)?)/.exec(label);
  if (window) return Number(window[1]);
  // The ticket's OWN tenor, before the tenor bucket. maturityMonths is what
  // the leg was actually booked at (and what tapeQuoteKey keys on);
  // `maturity` is the coarse bucket it rounds into — a 10M and a 12M leg
  // are both '1y'. Falling straight to the bucket reported both as M12, so
  // a 6-leg ladder showed L4/L5/L6 all at M12 and every view that groups by
  // settle month collapsed three legs into one.
  if (t.maturityMonths != null && Number.isFinite(t.maturityMonths) && t.maturityMonths > 0) {
    return t.maturityMonths;
  }
  if (t.maturity) return horizonMonths(t.maturity);
  return 0;
}

function preparedBasisFromTicket(
  t: HedgeTicket,
): PreparedHedgeProfile['basis'] {
  if (t.basis === 'stock') return 'cash';
  if (t.basis === 'totalBuildup') return 'totalExpected';
  return 'varNeutral';
}

/** Stamp the staged package onto the first ticket so Cancel can restage it. */
export function stampSourcePackage(
  tickets: readonly HedgeTicket[],
  pkg: PreparedHedgeProfile,
): HedgeTicket[] {
  if (tickets.length === 0) return [];
  return tickets.map((t, i) => (i === 0 ? { ...t, sourcePackage: pkg } : t));
}

function stripEdgeTicketRank(t: HedgeTicket): number {
  if (!t.bracketRole && isMarketExecutedHedgeTicket(t)) return 4;
  if (!t.bracketRole && t.status === 'booked') return 3;
  if (!t.bracketRole) return 2;
  if (isMarketExecutedHedgeTicket(t)) return 1;
  return 0;
}

/**
 * One ticket per strip edge. Live cover prints win over a TP/SL that
 * later filled on the same tenor, so the Decision strip table matches
 * the ticket's priced legs instead of the bracket blotter.
 */
export function preferredStripEdgeTickets(
  tickets: readonly HedgeTicket[],
): HedgeTicket[] {
  const byEdge = new Map<number, HedgeTicket>();
  for (const t of tickets) {
    if (!t.stripId || t.status === 'cancelled') continue;
    const i = t.stripEdgeIndex ?? 0;
    const cur = byEdge.get(i);
    if (!cur || stripEdgeTicketRank(t) > stripEdgeTicketRank(cur)) {
      byEdge.set(i, t);
    }
  }
  return [...byEdge.values()].sort(
    (a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0),
  );
}

/**
 * Rebuild the staged package that Cancel should put back on the desk.
 * Prefers the snapshot attached at Book; otherwise reconstructs legs / settle
 * from the tickets so a pre-snapshot strip does not collapse to the default
 * EURUSD bullet.
 */
export function preparedHedgeFromBookedTickets(
  booked: readonly HedgeTicket[],
  ticket: HedgeTicket,
): PreparedHedgeProfile | null {
  const group = ticket.stripId
    ? booked.filter(t => t.stripId === ticket.stripId)
    : booked.filter(t => t.id === ticket.id);
  const attached = group.find(t => t.sourcePackage)?.sourcePackage;
  if (attached) return { ...attached };

  if (ticket.stripId) {
    const legs = preferredStripEdgeTickets(group);
    if (legs.length === 0) return null;
    let cum = 0;
    const preparedLegs: PreparedHedgeLeg[] = legs.map((t, i) => {
      cum += t.amountLocalM;
      const settle = settleMonthsFromHedgeTicket(t);
      return {
        index: t.stripEdgeIndex ?? i,
        startMonth: 0,
        endMonth: settle,
        settleMonths: settle,
        hedgeLocalM: cum,
        tradeNotionalLocalM: t.amountLocalM,
        label: `L${i + 1}`,
      };
    });
    return {
      structure: 'strip',
      basis: preparedBasisFromTicket(legs[0]!),
      ticketBasis: legs[0]!.basis,
      legs: preparedLegs,
      coverLocalM: cum,
      hedgeRatio: 0,
    };
  }

  if (group.length === 0) return null;
  const settle = settleMonthsFromHedgeTicket(ticket);
  return {
    structure: 'bullet',
    basis: preparedBasisFromTicket(ticket),
    ticketBasis: ticket.basis,
    legs: [],
    coverLocalM: ticket.amountLocalM,
    hedgeRatio: 0,
    settleMonths: settle,
  };
}

/**
 * Ticket Structure / priced-legs package after a strip is on the book.
 * Keeps Carry / Liquidity snapshots intact. If more edges were booked than
 * the parent Hedging Decision stamp (custom + legs in the ticket), rebuild
 * from those tickets so the UI does not snap back to the default stub.
 */
export function stripPackageForTicketView(
  booked: readonly HedgeTicket[],
  ticket: HedgeTicket,
): PreparedHedgeProfile | null {
  if (!ticket.stripId) {
    // A free Decision Book compose ticket is not yet on the blotter — do
    // not inherit the CCY's live strip (leftover add / unwind buy-back).
    const onBlotter =
      ticket.status === 'booked'
      || ticket.status === 'scheduled'
      || ticket.status === 'cancelled';
    if (!onBlotter) {
      return preparedHedgeFromBookedTickets(booked, ticket);
    }
    const peer =
      booked.find(
        t =>
          t.ccy === ticket.ccy
          && Boolean(t.stripId)
          && t.status !== 'cancelled',
      ) ?? null;
    if (peer?.stripId) {
      return stripPackageForTicketView(booked, peer);
    }
    return preparedHedgeFromBookedTickets(booked, ticket);
  }
  const group = booked.filter(
    t => t.stripId === ticket.stripId && t.status !== 'cancelled',
  );
  const edges = preferredStripEdgeTickets(group);
  // The strip's CURRENT shape is the largest ladder any of its tickets was
  // stamped with, not whichever ticket happens to sit first in the group. A
  // leg added in the modal after the first legs executed is stamped only on
  // the tickets placed after it (a bracket, a later leg); the first ticket's
  // older, shorter stamp hid it — the third leg the desk had added never
  // reached the card and could not be traded on reopen. Ties keep group
  // order. A booked strip cannot shrink (reshaping is locked once on the
  // book), so the largest stamp is the latest.
  // ...unless it contradicts what was booked. A stamp whose leg at a
  // ticket's edge is not that ticket's own tenor is not this strip's shape,
  // however many legs it has: OCO orders left on a strip the desk had
  // reshaped from the card's six-leg ladder to M1/M2/M3/M5/M8 carried the
  // six-leg stamp, "largest wins" labelled and charted every leg one tenor
  // too far, and each real print sat under its series by the points
  // difference. Only a ticket that states its own tenor can contradict.
  const agreesWithBookedTenors = (pkg: PreparedHedgeProfile): boolean =>
    group.every(t => {
      const months = t.maturityMonths;
      if (months == null || !Number.isFinite(months) || months <= 0) return true;
      const leg = pkg.legs[t.stripEdgeIndex ?? 0];
      return leg != null && Math.abs((leg.settleMonths ?? leg.endMonth) - months) < 1e-6;
    });
  const attached = group
    .map(t => t.sourcePackage)
    .filter((pkg): pkg is PreparedHedgeProfile => pkg?.structure === 'strip')
    .filter(agreesWithBookedTenors)
    .sort((a, b) => b.legs.length - a.legs.length)[0];
  // A shorter Hedging Decision / Carry stamp must not hide extra edges that
  // were actually booked in the ticket (6 live legs vs a leftover 3-leg draft).
  const keepStamp =
    attached?.structure === 'strip'
    && attached.legs.length >= Math.max(2, edges.length);
  if (keepStamp && attached) return { ...attached };
  if (edges.length < 2) return preparedHedgeFromBookedTickets(booked, ticket);
  return preparedHedgeFromBookedTickets(
    edges.map(t => {
      const { sourcePackage: _drop, ...rest } = t;
      return rest;
    }),
    (() => {
      const { sourcePackage: _drop, ...rest } = ticket;
      return rest;
    })(),
  );
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
  /**
   * Analytics stages as `draft`. Send-for-approval (VAR policy) moves to
   * `pending`, then `approved` — only then the package is on Hedging Decision.
   * Missing = legacy, treated as already released.
   */
  approvalStatus?: 'draft' | 'pending' | 'approved';
  /** Policy signer when status is pending / approved (`varApprovalRequired`). */
  approvalWho?: string;
  /**
   * Fine-tuned sibling structures from Cash Carry (or a later restage).
   * Booking can price Bullet and Strip on the same ticket and choose.
   * Nested entries omit `packages` so persistence stays flat.
   */
  packages?: {
    bullet?: PreparedHedgePackageCore;
    strip?: PreparedHedgePackageCore;
  };
  /**
   * Cash Carry ranked strip shapes (top-N) so booking can pick a ladder
   * without reopening the optimizer.
   */
  stripChoices?: StagedStripChoice[];
}

/** Compact Cash Carry rank-table row persisted on the staged package. */
export type StagedStripChoice = {
  structure: 'bullet' | 'strip';
  legCount: number;
  centerOfMass: number;
  kurtosis: number;
  settleScheduleLabel: string;
  settleMonths: number[];
  legs: {
    settleMonths: number;
    amountLocalM: number;
    label: string;
  }[];
  hedgeDeltaLocalM: number;
  enhancementUsdM: number;
  newCarryUsdM: number;
  fwdCarryUsdM: number;
  vsBulletUsdM: number;
};

/** A staged package already known to be a multi-leg strip. */
export type PreparedStripProfile = PreparedHedgeProfile & { structure: 'strip' };

/**
 * True when a staged package is a multi-leg strip (Cash Carry / FX Risk / Liquidity).
 *
 * The predicate narrows to the strip-only shape, not to `PreparedHedgeProfile`
 * itself — with the latter every negated use narrowed its subject to `never`,
 * which silently disabled type-checking through `livePreparedHedge` and
 * `mergePreparedPackages`.
 */
export function isPreparedStrip(
  p?: PreparedHedgeProfile | null,
): p is PreparedStripProfile {
  return p != null && p.structure === 'strip' && p.legs.length >= 2;
}

/** Settle months of a staged strip — Cash Carry optimized schedule. */
export function stripScheduleEndsFromPrepared(
  p?: PreparedHedgeProfile | null,
): number[] | null {
  if (!isPreparedStrip(p)) return null;
  return p.legs.map(l => l.settleMonths ?? l.endMonth);
}

/** Same settle ladder — not notionals. 6×M2/M4/… vs 5×2.4m is a new program. */
export function stripSchedulesAgree(
  a?: PreparedHedgeProfile | null,
  b?: PreparedHedgeProfile | null,
): boolean {
  const ea = stripScheduleEndsFromPrepared(a);
  const eb = stripScheduleEndsFromPrepared(b);
  if (!ea || !eb || ea.length !== eb.length) return false;
  return ea.every((m, i) => Math.abs(m - eb[i]!) < 1e-6);
}

/**
 * Resume a part-worked booked strip on Book only when the staged remaining
 * program is that same ladder. A new Analytics optimization (6-leg leftover
 * vs an executed 5-leg stamp) is a clean remaining sheet.
 */
export function resumePartWorkedStripOnBook(args: {
  bookedStamp?: PreparedHedgeProfile | null;
  staged?: PreparedHedgeProfile | null;
}): boolean {
  const booked = args.bookedStamp;
  if (!isPreparedStrip(booked)) return false;
  const staged = livePreparedHedge(args.staged) ?? args.staged;
  if (!isPreparedStrip(staged)) return true;
  return stripSchedulesAgree(booked, staged);
}

/** Incremental notional shares (sum → 1) of a staged strip. */
export function stripScheduleWeightsFromPrepared(
  p?: PreparedHedgeProfile | null,
): number[] | null {
  if (!isPreparedStrip(p)) return null;
  const sizes = p.legs.map((l, i) => {
    if (
      typeof l.tradeNotionalLocalM === 'number'
      && Number.isFinite(l.tradeNotionalLocalM)
    ) {
      return Math.abs(l.tradeNotionalLocalM);
    }
    const prev = i > 0 ? p.legs[i - 1]!.hedgeLocalM : 0;
    return Math.abs(l.hedgeLocalM - prev);
  });
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum < 1e-12) return null;
  return sizes.map(s => s / sum);
}

export function snapshotStripChoice(s: {
  structure: 'bullet' | 'strip';
  legCount: number;
  centerOfMass: number;
  kurtosis: number;
  settleScheduleLabel: string;
  settleMonths: readonly number[];
  legs: readonly {
    settleMonths: number;
    amountLocalM: number;
    label: string;
  }[];
  hedgeDeltaLocalM: number;
  enhancementUsdM: number;
  newCarryUsdM: number;
  fwdCarryUsdM: number;
  vsBulletUsdM: number;
}): StagedStripChoice {
  return {
    structure: s.structure,
    legCount: s.legCount,
    centerOfMass: s.centerOfMass,
    kurtosis: s.kurtosis,
    settleScheduleLabel: s.settleScheduleLabel,
    settleMonths: [...s.settleMonths],
    legs: s.legs.map(l => ({
      settleMonths: l.settleMonths,
      amountLocalM: l.amountLocalM,
      label: l.label,
    })),
    hedgeDeltaLocalM: s.hedgeDeltaLocalM,
    enhancementUsdM: s.enhancementUsdM,
    newCarryUsdM: s.newCarryUsdM,
    fwdCarryUsdM: s.fwdCarryUsdM,
    vsBulletUsdM: s.vsBulletUsdM,
  };
}

/** First non-empty ranked-ladder list on a staged package or its nested strip. */
export function stripChoicesOf(
  ...pkgs: Array<PreparedHedgeProfile | null | undefined>
): StagedStripChoice[] {
  for (const p of pkgs) {
    const list = p?.stripChoices ?? p?.packages?.strip?.stripChoices;
    if (list && list.length > 0) return list;
  }
  return [];
}

export function preparedFromStripChoice(
  choice: StagedStripChoice,
  base: PreparedHedgeProfile,
): PreparedHedgeProfile {
  const cover = choice.hedgeDeltaLocalM || base.coverLocalM;
  if (choice.structure === 'bullet' || choice.legCount <= 1) {
    return {
      ...stripPreparedPackages(base),
      structure: 'bullet',
      legs: [],
      coverLocalM: cover,
      settleMonths: choice.settleMonths[0] ?? base.settleMonths,
      settleSkew: undefined,
    };
  }
  let cumul = 0;
  const legs = choice.legs.map((leg, i) => {
    cumul += leg.amountLocalM;
    return {
      index: i,
      startMonth: 0,
      endMonth: leg.settleMonths,
      settleMonths: leg.settleMonths,
      hedgeLocalM: cumul,
      tradeNotionalLocalM: leg.amountLocalM,
      label: leg.label,
    };
  });
  return {
    ...stripPreparedPackages(base),
    structure: 'strip',
    legs,
    coverLocalM: cover,
    settleSkew:
      choice.centerOfMass < 0.35
        ? 'front'
        : choice.centerOfMass > 0.65
          ? 'back'
          : 'neutral',
  };
}

/** Prepared package without nested siblings (avoids recursive persistence). */
export type PreparedHedgePackageCore = Omit<PreparedHedgeProfile, 'packages'>;

export function stripPreparedPackages(
  p: PreparedHedgeProfile,
): PreparedHedgePackageCore {
  const { packages: _omit, ...core } = p;
  return core;
}

/** Dust on program clip — same band as leftover bookable cover. */
const PROGRAM_CLIP_DUST_M = 0.005;

/**
 * Same hedge program for approval: total cover notional and direction.
 * Cash Carry strip-point / tenor edits keep sign and |cover|; they must not
 * bounce an approved package back to draft.
 */
export function sameHedgeProgramExecution(
  a?: Pick<PreparedHedgeProfile, 'coverLocalM'> | null,
  b?: Pick<PreparedHedgeProfile, 'coverLocalM'> | null,
): boolean {
  if (!a || !b) return false;
  const A = a.coverLocalM;
  const B = b.coverLocalM;
  if (!Number.isFinite(A) || !Number.isFinite(B)) return false;
  if (Math.abs(A) <= PROGRAM_CLIP_DUST_M && Math.abs(B) <= PROGRAM_CLIP_DUST_M) {
    return true;
  }
  if (A * B < 0) return false;
  return Math.abs(A - B) <= PROGRAM_CLIP_DUST_M;
}

function withProgramApproval(
  existing: PreparedHedgeProfile | undefined,
  incoming: PreparedHedgeProfile,
): PreparedHedgeProfile {
  if (!existing) return incoming;
  if (sameHedgeProgramExecution(existing, incoming)) {
    if (
      existing.approvalStatus === incoming.approvalStatus
      && existing.approvalWho === incoming.approvalWho
    ) {
      return incoming;
    }
    return {
      ...incoming,
      approvalStatus: existing.approvalStatus,
      approvalWho: existing.approvalWho,
    };
  }
  // Hedging Decision restages already-released tickets in place.
  if (
    incoming.approvalStatus === 'pending'
    || incoming.approvalStatus === 'approved'
  ) {
    return incoming;
  }
  const released =
    existing.approvalStatus === 'pending'
    || existing.approvalStatus === 'approved'
    || existing.approvalStatus == null;
  if (!released) return incoming;
  return {
    ...incoming,
    approvalStatus: 'draft',
    approvalWho: undefined,
  };
}

export function attachPreparedPackages(
  active: PreparedHedgeProfile,
  pair: {
    bullet?: PreparedHedgeProfile | null;
    strip?: PreparedHedgeProfile | null;
  },
): PreparedHedgeProfile {
  const bullet = pair.bullet
    ? stripPreparedPackages(pair.bullet)
    : active.structure === 'bullet'
      ? stripPreparedPackages(active)
      : undefined;
  const strip = pair.strip
    ? stripPreparedPackages(pair.strip)
    : active.structure === 'strip'
      ? stripPreparedPackages(active)
      : undefined;
  if (!bullet && !strip) return active;
  return {
    ...active,
    packages: {
      ...(bullet ? { bullet } : {}),
      ...(strip ? { strip } : {}),
    },
  };
}

function mergePreparedPackages(
  existing: PreparedHedgeProfile | undefined,
  incoming: PreparedHedgeProfile,
): PreparedHedgeProfile {
  const incomingPair = incoming.packages;
  const existingPair = existing?.packages;
  const bullet =
    incomingPair?.bullet ??
    (incoming.structure === 'bullet'
      ? stripPreparedPackages(incoming)
      : undefined) ??
    existingPair?.bullet ??
    (existing?.structure === 'bullet'
      ? stripPreparedPackages(existing)
      : undefined);
  const strip =
    incomingPair?.strip ??
    (incoming.structure === 'strip'
      ? stripPreparedPackages(incoming)
      : undefined) ??
    existingPair?.strip ??
    (existing?.structure === 'strip' && existing.legs.length > 0
      ? stripPreparedPackages(existing)
      : undefined);
  const stripChoices = stripChoicesOf(incoming, existing);
  const stripWithRanks =
    strip && stripChoices.length > 0
      ? { ...strip, stripChoices }
      : strip;
  if (!bullet && !stripWithRanks) {
    const merged =
      stripChoices.length > 0
        ? { ...incoming, stripChoices }
        : incoming;
    return withProgramApproval(existing, merged);
  }
  const { packages: _omit, ...incomingCore } = incoming;
  const packages = {
    ...(bullet ? { bullet } : {}),
    ...(stripWithRanks ? { strip: stripWithRanks } : {}),
  };
  // Mix restage writes a Tf bullet. If Cash Carry / path already attached a
  // strip (live or nested), keep that ladder as the Decision ticket and only
  // retarget cover — otherwise Hedging Decision shows Bullet · 12M.
  const mixBullet =
    incoming.structure === 'bullet'
    && incoming.preparedFor === 'var'
    && !isPreparedStrip(incoming)
    && stripWithRanks
    && stripWithRanks.structure === 'strip'
    && (stripWithRanks.legs?.length ?? 0) >= 2
    && existing;
  if (mixBullet && existing) {
    const liveStrip: PreparedHedgeProfile = {
      ...existing,
      ...stripWithRanks,
      structure: 'strip',
      packages,
      approvalStatus: existing.approvalStatus,
      approvalWho: existing.approvalWho,
      preparedFor: existing.preparedFor,
      stripChoices: existing.stripChoices ?? stripWithRanks.stripChoices,
    };
    return withProgramApproval(
      existing,
      scalePreparedHedgeToCover(liveStrip, {
        coverLocalM: incoming.coverLocalM,
        hedgeRatio: incoming.hedgeRatio,
        impliedCarryUsdM: incoming.impliedCarryUsdM,
      }),
    );
  }
  return withProgramApproval(existing, {
    ...incomingCore,
    ...(stripChoices.length > 0 ? { stripChoices } : {}),
    packages,
  });
}

/** Same-notional WAM bullet from a fine-tuned strip — booking comparison only. */
export function bulletCounterpartFromStrip(
  strip: PreparedHedgeProfile,
): PreparedHedgeProfile | null {
  if (strip.structure === 'bullet') return stripPreparedPackages(strip);
  if (strip.structure !== 'strip' || strip.legs.length < 1) return null;
  let wSum = 0;
  let wSettle = 0;
  for (let i = 0; i < strip.legs.length; i++) {
    const leg = strip.legs[i]!;
    const sz =
      typeof leg.tradeNotionalLocalM === 'number'
        ? Math.abs(leg.tradeNotionalLocalM)
        : Math.abs(
            leg.hedgeLocalM - (i > 0 ? strip.legs[i - 1]!.hedgeLocalM : 0),
          );
    const settle = Math.max(0, leg.settleMonths ?? leg.endMonth);
    if (sz < 1e-12) continue;
    wSum += sz;
    wSettle += sz * settle;
  }
  const last = strip.legs[strip.legs.length - 1]!;
  const settle =
    wSum > 1e-12
      ? wSettle / wSum
      : (strip.settleMonths ?? last.settleMonths ?? last.endMonth);
  return {
    ...stripPreparedPackages(strip),
    structure: 'bullet',
    legs: [],
    settleMonths: settle,
    settleSkew: undefined,
  };
}

function isCarryOrLiquidityStamp(
  p?: Pick<PreparedHedgeProfile, 'preparedFor'> | null,
): boolean {
  return p?.preparedFor === 'carry' || p?.preparedFor === 'liquidity';
}

export function packageForStructure(
  prep: PreparedHedgeProfile | null | undefined,
  structure: 'bullet' | 'strip',
): PreparedHedgeProfile | null {
  if (!prep) return null;
  const ranked = stripChoicesOf(prep);
  const withRanks = (pkg: PreparedHedgeProfile): PreparedHedgeProfile =>
    ranked.length > 0 && !(pkg.stripChoices && pkg.stripChoices.length > 0)
      ? { ...pkg, stripChoices: ranked }
      : pkg;
  const nested = prep.packages?.[structure];
  /**
   * Nested `packages.strip` is the sibling from a mix / prior Stage. A custom
   * live ladder (12-leg ticket) must not lose to a leftover Hedging Decision
   * parent (ceil(Tf/Th)=5). Carry / Liquidity stamps still win when they are
   * at least as long as the live legs.
   */
  if (structure === 'strip' && isPreparedStrip(prep)) {
    if (isCarryOrLiquidityStamp(prep)) return withRanks(prep);
    if (
      nested
      && nested.legs.length > 0
      && isCarryOrLiquidityStamp(nested)
      && nested.legs.length >= prep.legs.length
    ) {
      return withRanks({ ...nested, structure, packages: prep.packages });
    }
    if (nested && nested.legs.length > prep.legs.length) {
      return withRanks({ ...nested, structure, packages: prep.packages });
    }
    return withRanks(prep);
  }
  if (nested && (structure === 'bullet' || nested.legs.length > 0)) {
    return withRanks({ ...nested, structure, packages: prep.packages });
  }
  if (prep.structure === structure) return withRanks(prep);
  if (structure === 'bullet') {
    const bullet = bulletCounterpartFromStrip(prep);
    return bullet ? withRanks(bullet) : null;
  }
  return null;
}

/**
 * Ticket Hedging Decision should execute: a nested Cash Carry / path strip
 * outranks a mix 12M bullet left as the live `structure`.
 */
export function livePreparedHedge(
  p?: PreparedHedgeProfile | null,
): PreparedHedgeProfile | undefined {
  if (!p) return undefined;
  if (isPreparedStrip(p)) return p;
  const nested = packageForStructure(p, 'strip');
  if (nested && isPreparedStrip(nested)) {
    return {
      ...p,
      ...nested,
      packages: p.packages,
      approvalStatus: p.approvalStatus,
      approvalWho: p.approvalWho,
      preparedFor: p.preparedFor ?? nested.preparedFor,
      stripChoices: p.stripChoices ?? nested.stripChoices,
    };
  }
  return p;
}

export function isReleasedToHedgingDecision(p: PreparedHedgeProfile): boolean {
  return p.approvalStatus == null || p.approvalStatus === 'approved';
}

export function releasedPreparedByCcy(
  prepared: Record<string, PreparedHedgeProfile> | undefined,
): Record<string, PreparedHedgeProfile> {
  const out: Record<string, PreparedHedgeProfile> = {};
  for (const [ccy, p] of Object.entries(prepared ?? {})) {
    if (isReleasedToHedgingDecision(p)) out[ccy] = p;
  }
  return out;
}

export type HedgeApprovalStatus = 'draft' | 'pending' | 'approved';

export function markPreparedApproval(
  prepared: Record<string, PreparedHedgeProfile>,
  patch: {
    status: HedgeApprovalStatus;
    who?: string;
    from?: HedgeApprovalStatus;
    /** Only touch these CCYs (portfolio include-set). */
    onlyCcys?: ReadonlySet<string>;
    /** Only touch packages shaped by this lens. */
    preparedFor?: PreparedHedgeProfile['preparedFor'];
  },
): Record<string, PreparedHedgeProfile> {
  const next: Record<string, PreparedHedgeProfile> = { ...prepared };
  for (const [ccy, p] of Object.entries(next)) {
    if (patch.onlyCcys && !patch.onlyCcys.has(ccy)) continue;
    if (patch.preparedFor && p.preparedFor !== patch.preparedFor) continue;
    const st = p.approvalStatus;
    if (patch.from != null) {
      if (st !== patch.from) continue;
    } else if (st === 'approved') {
      continue;
    }
    next[ccy] = {
      ...p,
      approvalStatus: patch.status,
      approvalWho: patch.who ?? p.approvalWho,
    };
  }
  return next;
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
 * so Apply / Prebook / schedule edits survive page reload (local + Postgres).
 */
export type CarryProfileSessionV1 = {
  v: 1;
  draft: PreparedHedgeProfile | null;
  /** Last fine-tuned bullet — kept when the live draft is a strip. */
  lastBullet?: PreparedHedgeProfile | null;
  /** Last fine-tuned strip — kept when the live draft is a bullet. */
  lastStrip?: PreparedHedgeProfile | null;
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
  return {
    ...(prepared ?? {}),
    [ccy]: mergePreparedPackages(prepared?.[ccy], profile),
  };
}

/** FX Risk bullet staged from the selected Optimize mix (Target × weight). */
export function preparedHedgeFromAtlasMix(input: {
  coverLocalM: number;
  hedgeRatio: number;
  settleMonths: number;
  impliedCarryUsdM: number;
}): PreparedHedgeProfile {
  return {
    structure: 'bullet',
    basis: 'totalExpected',
    ticketBasis: 'totalBuildup',
    legs: [],
    coverLocalM: input.coverLocalM,
    hedgeRatio: input.hedgeRatio,
    settleMonths: input.settleMonths,
    impliedCarryUsdM: input.impliedCarryUsdM,
    preparedFor: 'var',
    approvalStatus: 'draft',
  };
}

/** Scale a staged package to a new cover, keeping strip shape (relative legs). */
export function scalePreparedHedgeToCover(
  p: PreparedHedgeProfile,
  next: {
    coverLocalM: number;
    hedgeRatio?: number;
    impliedCarryUsdM?: number;
    settleMonths?: number;
  },
): PreparedHedgeProfile {
  const cover = Number.isFinite(next.coverLocalM) ? next.coverLocalM : p.coverLocalM;
  const old = p.coverLocalM;
  const ratio =
    Math.abs(old) > 1e-12 && Number.isFinite(old) ? cover / old : 1;
  const legs =
    Math.abs(ratio - 1) < 1e-12 || p.legs.length === 0
      ? p.legs
      : p.legs.map(l => ({
          ...l,
          hedgeLocalM: l.hedgeLocalM * ratio,
          tradeNotionalLocalM:
            l.tradeNotionalLocalM != null
              ? l.tradeNotionalLocalM * ratio
              : undefined,
          impliedCarryUsdM:
            l.impliedCarryUsdM != null
              ? l.impliedCarryUsdM * ratio
              : undefined,
        }));
  return {
    ...p,
    coverLocalM: cover,
    legs,
    hedgeRatio:
      typeof next.hedgeRatio === 'number' && Number.isFinite(next.hedgeRatio)
        ? next.hedgeRatio
        : p.hedgeRatio,
    settleMonths: next.settleMonths ?? p.settleMonths,
    impliedCarryUsdM:
      typeof next.impliedCarryUsdM === 'number'
        && Number.isFinite(next.impliedCarryUsdM)
        ? next.impliedCarryUsdM
        : p.impliedCarryUsdM != null && Number.isFinite(ratio)
          ? p.impliedCarryUsdM * ratio
          : p.impliedCarryUsdM,
  };
}

export type HedgeSizerSnapshot = Record<
  string,
  { forecast: number; stock: number; varNeutral: number; booked?: number }
>;

function sizerForPrepared(
  p: PreparedHedgeProfile,
  snap: { forecast: number; stock: number; varNeutral: number } | undefined,
): number {
  if (!snap) return 0;
  if (p.basis === 'cash') return snap.stock;
  if (p.basis === 'varNeutral') return snap.varNeutral;
  return snap.forecast;
}

function mixWeightFromPackage(
  p: PreparedHedgeProfile,
  prev: { forecast: number; booked?: number } | undefined,
): number {
  if (Number.isFinite(p.hedgeRatio) && p.hedgeRatio > 1e-9) {
    return Math.min(1, p.hedgeRatio);
  }
  const E0 = prev?.forecast ?? 0;
  const B0 = prev?.booked ?? 0;
  if (Math.abs(E0) < 1e-12) return 1;
  const pending0 = pendingHedgeCoverLocalM(E0, B0, 1);
  if (Math.abs(p.coverLocalM - pending0) < 1e-4) return 1;
  return Math.min(1, Math.abs(p.coverLocalM) / Math.abs(E0));
}

/**
 * When Tf / profile moves, keep mix % and strip shape and rewrite cover.
 * FX Risk packages retarget to w × E − booked (not a naive E_new/E_old scale,
 * which leaves a 12.1 ticket sitting on a 26.75 forecast).
 * Liquidity overlays stay put — they are not forecast-sized.
 */
export function scalePreparedHedgesBySizerMove(
  prepared: Record<string, PreparedHedgeProfile> | undefined,
  prev: HedgeSizerSnapshot,
  next: HedgeSizerSnapshot,
): Record<string, PreparedHedgeProfile> | null {
  if (!prepared || Object.keys(prev).length === 0) return null;
  let changed = false;
  const out: Record<string, PreparedHedgeProfile> = { ...prepared };
  for (const [ccy, p] of Object.entries(prepared)) {
    if (p.preparedFor === 'liquidity') continue;
    if (p.preparedFor === 'var') {
      if (isApprovalCommitted(p)) continue;
      const snap = next[ccy];
      if (!snap) continue;
      const w = mixWeightFromPackage(p, prev[ccy]);
      const clip = bookableHedgeCoverLocalM(
        snap.forecast,
        snap.booked ?? 0,
        w,
      );
      if (Math.abs(clip) < 1e-9) {
        if (ccy in out) {
          delete out[ccy];
          changed = true;
        }
        continue;
      }
      if (Math.abs(clip - p.coverLocalM) < 1e-6 && Math.abs(w - (p.hedgeRatio ?? 0)) < 1e-9) {
        continue;
      }
      out[ccy] = scalePreparedHedgeToCover(p, {
        coverLocalM: clip,
        hedgeRatio: w,
      });
      changed = true;
      continue;
    }
    const a = sizerForPrepared(p, prev[ccy]);
    const b = sizerForPrepared(p, next[ccy]);
    if (!(Math.abs(a) > 1e-12) || !Number.isFinite(b)) continue;
    if (Math.abs(b - a) < 1e-6) continue;
    const cover = p.coverLocalM * (b / a);
    if (Math.abs(cover - p.coverLocalM) < 1e-6) continue;
    out[ccy] = scalePreparedHedgeToCover(p, { coverLocalM: cover });
    changed = true;
  }
  return changed ? out : null;
}

/**
 * Fill missing Optimize-mix tickets so Approve / Hedging Decision share
 * cover and locked carry.
 *
 * `preserveStrips`: keep a staged strip (Cash Carry optimized schedule,
 * Liquidity funding strip, or FX Risk path-chart strip). Book restage used
 * to rewrite those as 12M bullets, so Hedging Decision / the path modal
 * never showed the ladder.
 */
export function stageAtlasMixPrepared(
  prev: Record<string, PreparedHedgeProfile> | undefined,
  legs: readonly {
    ccy: string;
    weight: number;
    coverLocalM: number;
    lockedCarryUsdM: number;
  }[],
  settleMonths: number,
  opts?: { preserveStrips?: boolean },
): Record<string, PreparedHedgeProfile> {
  let next = { ...(prev ?? {}) };
  for (const leg of legs) {
    if (leg.ccy === 'USD') continue;
    const w = Number.isFinite(leg.weight) ? Math.min(1, Math.max(0, leg.weight)) : 0;
    if (w < 1e-9 || Math.abs(leg.coverLocalM) < 1e-9) {
      if (opts?.preserveStrips && isPreparedStrip(next[leg.ccy])) continue;
      if (leg.ccy in next && !isApprovalCommitted(next[leg.ccy])) {
        const copy = { ...next };
        delete copy[leg.ccy];
        next = copy;
      }
      continue;
    }
    const existing = next[leg.ccy];
    if (existing?.preparedFor === 'liquidity') continue;
    if (isApprovalCommitted(existing)) continue;
    // Keep Cash Carry / path strips (and carry bullets) — only retarget cover
    // to the mix leftover. Rewriting as a 12M var bullet is what desynced
    // Cash Carry Book Hedge CF from FX Approval / Hedging Decision.
    if (
      opts?.preserveStrips
      && existing
      && (isPreparedStrip(existing) || existing.preparedFor === 'carry')
    ) {
      next[leg.ccy] = scalePreparedHedgeToCover(existing, {
        coverLocalM: leg.coverLocalM,
        hedgeRatio: w,
        impliedCarryUsdM: leg.lockedCarryUsdM,
      });
      continue;
    }
    next = setPreparedHedgeForCcy(next, leg.ccy, preparedHedgeFromAtlasMix({
      coverLocalM: leg.coverLocalM,
      hedgeRatio: w,
      settleMonths,
      impliedCarryUsdM: leg.lockedCarryUsdM,
    }));
  }
  return next;
}

/** True when Optimize mix has at least one non-zero hedge %. */
export function mixRatiosAreActive(
  hedgeRatios?: Readonly<Record<string, number>>,
): boolean {
  return Object.values(hedgeRatios ?? {}).some(
    w => Number.isFinite(w) && w > 1e-9,
  );
}

/**
 * Cash Carry Book / Path overlay: same leftover clip as FX Book & Approval
 * (`w × forecast − committed`), keeping strip/bullet shape.
 * When mix is off, prepared packages are unchanged.
 */
export function preparedByCcyAlignedToMix(input: {
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  hedgeRatios?: Readonly<Record<string, number>>;
  bookedTickets: readonly HedgeTicket[];
  forecastByCcy: Readonly<Record<string, number>>;
  settleMonths: number;
}): Record<string, PreparedHedgeProfile> {
  const prev = input.preparedByCcy ?? {};
  if (!mixRatiosAreActive(input.hedgeRatios)) return prev;
  const next: Record<string, PreparedHedgeProfile> = { ...prev };
  const ccys = new Set([
    ...Object.keys(next),
    ...Object.keys(input.hedgeRatios ?? {}),
    ...Object.keys(input.forecastByCcy),
  ]);
  for (const ccy of ccys) {
    if (!ccy || ccy === 'USD') continue;
    const prep = next[ccy];
    if (prep?.preparedFor === 'liquidity') continue;
    const wRaw = input.hedgeRatios?.[ccy];
    const w = Number.isFinite(wRaw) ? Math.min(1, Math.max(0, wRaw as number)) : 0;
    const E = input.forecastByCcy[ccy] ?? 0;
    const clip = bookableAddHedgeCoverLocalM(
      E,
      committedHedgeNotionalLocalM(input.bookedTickets, ccy),
      w,
      isApprovalCommitted(prep) ? prep : null,
    );
    if (Math.abs(clip) < 1e-12) {
      if (prep && !isApprovalCommitted(prep)) delete next[ccy];
      continue;
    }
    if (prep) {
      next[ccy] = scalePreparedHedgeToCover(prep, {
        coverLocalM: clip,
        hedgeRatio: w,
      });
    } else {
      next[ccy] = preparedHedgeFromAtlasMix({
        coverLocalM: clip,
        hedgeRatio: w,
        settleMonths: input.settleMonths,
        impliedCarryUsdM: 0,
      });
    }
  }
  return next;
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

/**
 * Cover already printed in this strip session (market fills only, no TP/SL).
 * One notional per edge — a later matcher duplicate of the same leg does not
 * double-count.
 */
export function sessionExecutedCoverAbs(
  tickets: readonly HedgeTicket[],
): number {
  const byEdge = new Map<number, number>();
  for (const t of tickets) {
    if (t.bracketRole) continue;
    if (!isMarketExecutedHedgeTicket(t)) continue;
    const abs = Math.abs(t.amountLocalM);
    if (!(abs > 1e-12)) continue;
    const edge = t.stripEdgeIndex ?? 0;
    byEdge.set(edge, Math.max(byEdge.get(edge) ?? 0, abs));
  }
  let sum = 0;
  for (const n of byEdge.values()) sum += n;
  return sum;
}

/**
 * Outstanding clip still to trade after session fills: original program
 * minus executed cover. Spot / forward / option remaining all size off this.
 *
 * `programNettedAtMs`: Decision Book compose already subtracted fills that
 * printed before the overlay opened (`snap.trade` is leftover). Subtracting
 * those again zeroed outstanding on reopen. Only fills after that instant
 * come off the leftover.
 */
export function sessionPendingHedgeAbs(
  programLocalM: number,
  tickets: readonly HedgeTicket[],
  opts?: { programNettedAtMs?: number | null },
): number {
  const program = Math.abs(Number.isFinite(programLocalM) ? programLocalM : 0);
  const nettedAt = opts?.programNettedAtMs;
  const counted =
    nettedAt != null && Number.isFinite(nettedAt)
      ? tickets.filter(t => (t.filledAtMs ?? 0) > nettedAt)
      : tickets;
  const leftover = program - sessionExecutedCoverAbs(counted);
  return leftover > 1e-9 ? leftover : 0;
}

/**
 * Strip outstanding / filled from the ladder itself, not the compose clip.
 *
 * A Book reopen sizes `ticket.amountLocalM` as leftover (already net of
 * fills). Feeding that into {@link sessionPendingHedgeAbs} subtracted the
 * same fills again and showed 0.00 outstanding while free legs remained.
 * A pad-sized fill on one edge also used to consume the whole program.
 * Each edge only spends its own row: remaining legs stay the spot / fwd /
 * option clip.
 */
export function sessionStripClipAbs(
  legSizeAbs: readonly number[],
  tickets: readonly HedgeTicket[],
): { executedAbs: number; pendingAbs: number } {
  let executedAbs = 0;
  let pendingAbs = 0;
  for (let i = 0; i < legSizeAbs.length; i++) {
    const size = Math.abs(legSizeAbs[i] ?? 0);
    if (!(size > 1e-12)) continue;
    const { filled, working, cancelled } = legPeersAtEdge(tickets, i, {
      coverOnly: true,
    });
    if (filled != null || working.length > 0) executedAbs += size;
    else if (cancelled != null) continue;
    else pendingAbs += size;
  }
  return { executedAbs, pendingAbs };
}

/**
 * Pad clip for the overlay. A rendered strip is never a new leftover
 * booking while free legs of that ladder remain: remaining rows are the
 * clip (`stripClip`). Treating Book-open as leftover ignored those rows
 * and sized the pad as a fresh 9.68M compose even after L1 had printed.
 *
 * No strip (bullet leftover, or a finished ladder so Book starts clean):
 * compose leftover, and on Book only fills after the overlay opened come
 * off it — earlier prints are already inside `snap.trade`.
 */
export function sessionBookOverlayClipAbs(args: {
  programLocalM: number;
  tickets: readonly HedgeTicket[];
  bookSession: boolean;
  openedAtMs?: number | null;
  stripClip?: { executedAbs: number; pendingAbs: number } | null;
}): { executedAbs: number; pendingAbs: number } {
  if (args.stripClip != null) return args.stripClip;
  const leftover = sessionPendingHedgeAbs(args.programLocalM, args.tickets, {
    programNettedAtMs: args.bookSession ? args.openedAtMs ?? null : null,
  });
  if (args.bookSession) {
    const afterOpen =
      args.openedAtMs != null && Number.isFinite(args.openedAtMs)
        ? args.tickets.filter(t => (t.filledAtMs ?? 0) > args.openedAtMs!)
        : [];
    return {
      executedAbs: sessionExecutedCoverAbs(afterOpen),
      pendingAbs: leftover,
    };
  }
  return {
    executedAbs: sessionExecutedCoverAbs(args.tickets),
    pendingAbs: leftover,
  };
}

/**
 * Tickets that spend hedge budget for a CCY: live + working, cancelled
 * excluded. An OCO TP/SL pair is one claim (the take-profit leg).
 */
export function committedHedgeTickets(
  bookedTickets: readonly HedgeTicket[],
  ccy?: string,
): HedgeTicket[] {
  const relevant = bookedTickets.filter(
    t =>
      (ccy == null || t.ccy === ccy) && t.status !== 'cancelled',
  );
  const out: HedgeTicket[] = [];
  const seenOco = new Set<string>();
  for (const t of relevant) {
    if (t.ocoGroupId) {
      if (seenOco.has(t.ocoGroupId)) continue;
      seenOco.add(t.ocoGroupId);
      const group = relevant.filter(x => x.ocoGroupId === t.ocoGroupId);
      out.push(
        group.find(x => x.bracketRole === 'takeProfit') ?? group[0]!,
      );
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Gross hedge notional already committed (live fills + working limits).
 * Opposite-sign tickets do not cancel: a SELL 5.1 and a BUY option 12.1
 * spend 17.2 of budget, not 7. Signed net is for residual VaR, not for
 * "how much more can we still book".
 */
export function committedHedgeNotionalLocalM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
): number {
  return committedHedgeTickets(bookedTickets, ccy).reduce(
    (s, t) => s + Math.abs(t.amountLocalM),
    0,
  );
}

/**
 * Same-direction add still allowed. Opposite leftover (already over-covered)
 * is 0 — do not propose an unwind clip as a new hedge.
 */
export function bookableAddHedgeCoverLocalM(
  forecastTargetLocalM: number,
  committedNotionalLocalM: number,
  hedgeRatio = 1,
  prepared?: Pick<
    PreparedHedgeProfile,
    'approvalStatus' | 'preparedFor' | 'coverLocalM'
  > | null,
): number {
  const remaining = bookableHedgeCoverLocalM(
    forecastTargetLocalM,
    committedNotionalLocalM,
    hedgeRatio,
    prepared,
  );
  const E = Number.isFinite(forecastTargetLocalM) ? forecastTargetLocalM : 0;
  if (Math.abs(E) < 1e-12) return remaining <= 0.005 ? 0 : remaining;
  if (remaining * E < 0) return 0;
  return remaining;
}

/**
 * Ticket-convention sign of the covering cluster: `+1` SELL (covers a long),
 * `-1` BUY (covers a short). When the forecast is gone (`E = 0`), the larger
 * same-sign cluster of committed tickets is the cover to unwind.
 */
export function coveringHedgeDirectionSign(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
  forecastTargetLocalM: number,
): number {
  const E = Number.isFinite(forecastTargetLocalM) ? forecastTargetLocalM : 0;
  if (Math.abs(E) > 1e-12) return Math.sign(E);
  const tickets = committedHedgeTickets(bookedTickets, ccy);
  let pos = 0;
  let neg = 0;
  for (const t of tickets) {
    if (t.amountLocalM >= 0) pos += Math.abs(t.amountLocalM);
    else neg += Math.abs(t.amountLocalM);
  }
  if (pos >= neg && pos > 1e-12) return 1;
  if (neg > 1e-12) return -1;
  return 0;
}

/**
 * Filled covering vs working/scheduled covering that still has to settle.
 * Opposite-sign tickets (e.g. a BUY option on a long) are budget, not cover.
 */
export function coveringHedgeSplitLocalM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
  forecastTargetLocalM: number,
): { existing: number; pending: number; covering: number } {
  const tickets = committedHedgeTickets(bookedTickets, ccy);
  const dir = coveringHedgeDirectionSign(
    bookedTickets,
    ccy,
    forecastTargetLocalM,
  );
  let existing = 0;
  let pending = 0;
  for (const t of tickets) {
    if (Math.abs(t.amountLocalM) < 1e-12) continue;
    if (dir !== 0 && Math.sign(t.amountLocalM) === -dir) continue;
    const abs = Math.abs(t.amountLocalM);
    if (isWorkingHedgeTicket(t)) pending += abs;
    else existing += abs;
  }
  return { existing, pending, covering: existing + pending };
}

/**
 * Same-direction cover of the forecast (OCO once). Desk convention:
 * amountLocalM ≥ 0 is SELL (covers a long), < 0 is BUY (covers a short).
 */
export function coveringHedgeNotionalLocalM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
  forecastTargetLocalM: number,
): number {
  return coveringHedgeSplitLocalM(
    bookedTickets,
    ccy,
    forecastTargetLocalM,
  ).covering;
}

/** Residual after covering: w×E − sign(E)×covering. Negative = overhedged. */
export function residualAfterCoveringLocalM(
  forecastTargetLocalM: number,
  coveringNotionalLocalM: number,
  hedgeRatio = 1,
): number {
  const w = Number.isFinite(hedgeRatio)
    ? Math.min(1, Math.max(0, hedgeRatio))
    : 1;
  const E = Number.isFinite(forecastTargetLocalM) ? forecastTargetLocalM : 0;
  const have = Number.isFinite(coveringNotionalLocalM)
    ? Math.abs(coveringNotionalLocalM)
    : 0;
  if (Math.abs(E) < 1e-12) return roundMoney(-have);
  return roundMoney(w * E - Math.sign(E) * have);
}

/**
 * Buy-back size when covering exceeds w×|E| (always ≥ 0).
 */
export function unwindHedgeCoverLocalM(
  forecastTargetLocalM: number,
  coveringNotionalLocalM: number,
  hedgeRatio = 1,
): number {
  const residual = residualAfterCoveringLocalM(
    forecastTargetLocalM,
    coveringNotionalLocalM,
    hedgeRatio,
  );
  if (residual >= -0.005) return 0;
  return roundMoney(-residual);
}

/**
 * Ticket amountLocalM to book next (Sell ≥ 0, Buy < 0): same-direction add,
 * else a buy-back when the book is over-covered in the hedge direction.
 */
export function executableHedgeTradeLocalM(
  forecastTargetLocalM: number,
  committedGrossLocalM: number,
  coveringNotionalLocalM: number,
  hedgeRatio = 1,
  prepared?: Pick<
    PreparedHedgeProfile,
    'approvalStatus' | 'preparedFor' | 'coverLocalM'
  > | null,
  coverDirectionSign?: number,
): number {
  const add = bookableAddHedgeCoverLocalM(
    forecastTargetLocalM,
    committedGrossLocalM,
    hedgeRatio,
    prepared,
  );
  if (Math.abs(add) > 1e-9) return add;
  const unwind = unwindHedgeCoverLocalM(
    forecastTargetLocalM,
    coveringNotionalLocalM,
    hedgeRatio,
  );
  if (unwind <= 1e-9) return 0;
  const E = Number.isFinite(forecastTargetLocalM) ? forecastTargetLocalM : 0;
  const sign =
    coverDirectionSign != null && coverDirectionSign !== 0
      ? coverDirectionSign
      : Math.abs(E) > 1e-12
        ? Math.sign(E)
        : 1;
  return roundMoney(-sign * unwind);
}

/** One snapshot for Decision NET / Hedge / Target / Book. */
export function hedgeCoverSnapshot(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
  forecastTargetLocalM: number,
  hedgeRatio = 1,
): {
  committedGross: number;
  coveringSign: number;
  existing: number;
  pending: number;
  covering: number;
  existingSigned: number;
  pendingSigned: number;
  coveringSigned: number;
  residual: number;
  unwind: number;
  trade: number;
  flattenTrade: number;
} {
  const committedGross = committedHedgeNotionalLocalM(bookedTickets, ccy);
  const coveringSign = coveringHedgeDirectionSign(
    bookedTickets,
    ccy,
    forecastTargetLocalM,
  );
  const split = coveringHedgeSplitLocalM(
    bookedTickets,
    ccy,
    forecastTargetLocalM,
  );
  const residual = residualAfterCoveringLocalM(
    forecastTargetLocalM,
    split.covering,
    hedgeRatio,
  );
  const unwind = unwindHedgeCoverLocalM(
    forecastTargetLocalM,
    split.covering,
    hedgeRatio,
  );
  const trade = executableHedgeTradeLocalM(
    forecastTargetLocalM,
    committedGross,
    split.covering,
    hedgeRatio,
    // Do not net an approved/pending package here. Decision Book is the
    // step that turns that package into blotter cover; subtracting it
    // would leave trade = 0 and keep Book disabled after FX Approval.
    undefined,
    coveringSign,
  );
  return {
    committedGross,
    coveringSign,
    existing: split.existing,
    pending: split.pending,
    covering: split.covering,
    existingSigned: coveringSign * split.existing,
    pendingSigned: coveringSign * split.pending,
    coveringSigned: coveringSign * split.covering,
    residual,
    unwind,
    trade,
    flattenTrade: roundMoney(-residual),
  };
}

/**
 * Decision Book overlay structure. A live strip stays on the blotter;
 * leftover add and unwind buy-back are a new free ticket beside it.
 */
export function decisionBookOpenStructure(input: {
  isUnwind: boolean;
  liveStripOnBook: boolean;
  prepared?: PreparedHedgeProfile | null;
}): 'bullet' | 'strip' {
  if (input.isUnwind || input.liveStripOnBook) return 'bullet';
  return isPreparedStrip(input.prepared) ? 'strip' : 'bullet';
}

/**
 * Which structure the trade ticket opens a Decision draft in.
 *
 * The Hedging Decision card's own Bullet/Strip toggle is the signal for a
 * draft that carries no structure of its own — after a Reset there is no
 * staged package, and a card sitting on Strip must still open as a strip.
 * It is NOT the signal for a draft the compose already decided, and taking
 * it unconditionally is what made an unwind buy-back open as a strip.
 *
 * A Book compose states its decision by what it mints:
 * `composeDecisionBookTicket` mints a `stripId` for every strip it opens, so
 * a compose WITHOUT one chose bullet — an unwind buy-back beside the filled
 * strip. Reading `sourcePackage` instead is not enough: the compose attaches
 * none when nothing is staged, and sending a strip clears the staged package,
 * so the case that matters most arrives with no package at all.
 *
 * Opened in strip mode, that bullet had no `stripId` for the panel's booked
 * ladder lookup, fell back to a default seed ladder, and then matched the
 * real booked legs onto it by edge index — rows under the wrong tenors, all
 * showing as already executed, and the buy-back impossible to book.
 */
export function ticketOpensAsStrip(input: {
  ticket: Pick<HedgeTicket, 'stripId' | 'sourcePackage'>;
  /** The draft came from `composeDecisionBookTicket` (Decision Book overlay). */
  bookSession: boolean;
  /** The card's live Bullet/Strip toggle, when there is a card. */
  decisionStructure?: 'bullet' | 'strip' | null;
  prepared?: PreparedHedgeProfile | null;
}): boolean {
  if (input.ticket.stripId) return true;
  if (input.bookSession) return false;
  const stamped = input.ticket.sourcePackage;
  if (stamped) return stamped.structure === 'strip';
  if (input.decisionStructure != null) {
    return input.decisionStructure === 'strip';
  }
  return input.prepared?.structure === 'strip';
}

/**
 * Fresh compose ticket for Decision Book. Never reopens a blotter fill:
 * new id, no strip/OCO/limit/fill fields, unwind is a bullet buy-back.
 */
export function composeDecisionBookTicket(input: {
  template: HedgeTicket;
  amountLocalM: number;
  isUnwind: boolean;
  liveStripOnBook?: boolean;
  prepared?: PreparedHedgeProfile | null;
  instrument?: HedgeTicket['instrument'];
  maturity: HedgeTicket['maturity'];
  maturityLabel: string;
  varUsdM: number;
  /**
   * Caller's structure choice (the Decision card's own selection). Without
   * it this fell back to decisionBookOpenStructure, which forces 'bullet'
   * whenever a strip is live on the book — the card previewed a 5-leg
   * draft, the caller computed 'strip', and the compose silently threw
   * that away, so Book opened the panel's default 3-leg strip instead.
   */
  structure?: 'bullet' | 'strip';
}): HedgeTicket {
  const {
    template,
    amountLocalM,
    isUnwind,
    liveStripOnBook = false,
    prepared,
    instrument = 'forward',
    maturity,
    maturityLabel,
    varUsdM,
  } = input;
  // An explicit `structure` is the caller's own decision and wins. Only when
  // none is given does an unwind default to a bullet buy-back — that default
  // used to override the caller too, so a card set to Strip composed a
  // bullet with `legs: []` and the modal had no ladder to render.
  const openAs =
    input.structure
    ?? (isUnwind
      ? 'bullet'
      : decisionBookOpenStructure({ isUnwind, liveStripOnBook, prepared }));
  let sourcePackage: PreparedHedgeProfile | undefined;
  if (openAs === 'strip' && prepared) {
    const strip = packageForStructure(prepared, 'strip') ?? prepared;
    sourcePackage = scalePreparedHedgeToCover(strip, { coverLocalM: amountLocalM });
  } else if (prepared) {
    const bullet =
      packageForStructure(prepared, 'bullet')
      ?? bulletCounterpartFromStrip(prepared);
    if (bullet) {
      const scaled = scalePreparedHedgeToCover(bullet, {
        coverLocalM: amountLocalM,
      });
      const { packages: _packages, stripChoices: _choices, ...core } = scaled;
      sourcePackage = {
        ...core,
        structure: 'bullet',
        legs: [],
        coverLocalM: amountLocalM,
      };
    }
  }
  return {
    id: newHedgeTicketId(),
    ccy: template.ccy,
    instrument,
    basis: template.basis,
    amountLocalM,
    maturity,
    maturityLabel,
    varUsdM,
    addressesHigherVar: template.addressesHigherVar,
    entityId: template.entityId,
    entityName: template.entityName,
    ...(openAs === 'strip'
      ? { stripId: `strip-${template.ccy}-${newHedgeTicketId()}` }
      : {}),
    ...(sourcePackage ? { sourcePackage } : {}),
  };
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
 * Signed notional already resting (scheduled, non-strip) against a CCY.
 * Excluded from {@link bookedNotionalLocalM} on purpose — VAR/risk must
 * reflect executed cover only, not a working order. But "how much MORE
 * should a new hedge propose" is a different question: a resting order
 * already claims part of the exposure even though it hasn't filled, so a
 * caller deciding whether to stage another order must net this out too, or
 * it will happily propose a second order against exposure the first one is
 * already working — approval requirement makes no difference either way.
 */
export function restingHedgeNotionalLocalM(
  bookedTickets: readonly HedgeTicket[],
  ccy: string,
): number {
  return bookedTickets
    .filter(t => t.ccy === ccy && isWorkingHedgeTicket(t))
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

/** Open-book hint so approval can tell a hedge from a risk-adding ticket. */
export type HedgeApprovalRiskHint = {
  /** Open book on the Analytics basis (stock / path residual). */
  exposureLocalM?: number;
  /** Notional the package was sized against (forecast / Target N). */
  targetLocalM?: number;
  /**
   * Total expected position over the forecast horizon, always
   * forecast-inclusive — unlike `targetLocalM`, which collapses to the
   * cash/varNeutral sizer when the package was staged on those bases.
   */
  forecastTargetLocalM?: number;
  /** Notional already booked and live for this currency. */
  bookedCoverLocalM?: number;
  openVarUsdM?: number;
  /** Precomputed ΔVaR (after − before). Negative = decreases FX risk. */
  deltaVarUsdM?: number;
};

export type FxHedgeRiskKind = 'decrease' | 'increase' | 'flat';

export type FxHedgeRiskEffect = {
  kind: FxHedgeRiskKind;
  openVarUsdM: number;
  residualVarUsdM: number;
  deltaVarUsdM: number;
};

/**
 * Does this cover shrink unmatched FX exposure (diversifier) or add to it?
 * Policy rungs apply only when the trade increases FX risk.
 *
 * Cover is sell-signed (same sign as Target N) and often sized on forecast,
 * while open book can be stock-only or opposite-signed residual. Compare
 * |open| vs ||open| − |cover|| so a normal offset is ↓ FX risk.
 */
export function classifyHedgeFxRisk(
  coverLocalM: number,
  hint?: HedgeApprovalRiskHint | null,
): FxHedgeRiskEffect {
  const openVar = hint?.openVarUsdM ?? 0;
  if (
    hint
    && typeof hint.deltaVarUsdM === 'number'
    && Number.isFinite(hint.deltaVarUsdM)
  ) {
    const d = hint.deltaVarUsdM;
    const kind: FxHedgeRiskKind =
      d < -1e-9 ? 'decrease' : d > 1e-9 ? 'increase' : 'flat';
    return {
      kind,
      openVarUsdM: openVar,
      residualVarUsdM: Math.max(0, openVar + d),
      deltaVarUsdM: d,
    };
  }

  const e = hint?.exposureLocalM ?? 0;
  const target = hint?.targetLocalM ?? e;
  const H = Number.isFinite(coverLocalM) ? coverLocalM : 0;
  const open = Math.abs(target) >= Math.abs(e) ? target : e;
  const openAbs = Math.abs(open);
  const coverAbs = Math.abs(H);

  if (openAbs < 1e-12) {
    if (coverAbs < 1e-12) {
      return {
        kind: 'flat',
        openVarUsdM: openVar,
        residualVarUsdM: openVar,
        deltaVarUsdM: 0,
      };
    }
    return {
      kind: 'increase',
      openVarUsdM: openVar,
      residualVarUsdM: openVar,
      deltaVarUsdM: coverAbs,
    };
  }

  const unmatched = Math.abs(openAbs - coverAbs);
  const residualVar =
    openVar > 0 ? openVar * (unmatched / openAbs) : 0;
  const deltaVar = residualVar - (openVar > 0 ? openVar : 0);
  if (unmatched < openAbs - 1e-9) {
    return {
      kind: 'decrease',
      openVarUsdM: openVar,
      residualVarUsdM: residualVar,
      deltaVarUsdM: deltaVar,
    };
  }
  if (unmatched > openAbs + 1e-9) {
    return {
      kind: 'increase',
      openVarUsdM: openVar,
      residualVarUsdM: residualVar,
      deltaVarUsdM: deltaVar,
    };
  }
  return {
    kind: 'flat',
    openVarUsdM: openVar,
    residualVarUsdM: residualVar,
    deltaVarUsdM: 0,
  };
}

/**
 * Approval compares cover to the notional the ticket was sized on.
 * Stock-only open book is often much smaller than a forecast / Cash Carry
 * cover — using it makes every real hedge look like an overshoot (↑ Adds VaR).
 *
 * Prefer hedgeRatio-implied target, then the caller hint, then the cover
 * itself for FX Risk / Cash Carry packages. Liquidity keeps the Euler hint.
 */
export function approvalRiskHintForPackage(
  p: Pick<PreparedHedgeProfile, 'coverLocalM' | 'hedgeRatio' | 'preparedFor'>,
  hint?: HedgeApprovalRiskHint | null,
): HedgeApprovalRiskHint {
  const cover = Number.isFinite(p.coverLocalM) ? p.coverLocalM : 0;
  const coverAbs = Math.abs(cover);
  const ratio =
    Number.isFinite(p.hedgeRatio) && Math.abs(p.hedgeRatio) > 1e-6
      ? cover / p.hedgeRatio
      : undefined;
  const hintLooksLikeSizer = (x: number | undefined): x is number =>
    x != null && Number.isFinite(x) && Math.abs(x) >= coverAbs * 0.45;

  if (p.preparedFor === 'liquidity') {
    return { ...hint };
  }

  const target =
    ratio != null && Number.isFinite(ratio) && Math.abs(ratio) > 1e-12
      ? ratio
      : hintLooksLikeSizer(hint?.targetLocalM)
        ? hint.targetLocalM
        : coverAbs > 1e-12
          ? cover
          : hint?.targetLocalM;

  return {
    ...hint,
    targetLocalM: target,
  };
}

/** Risk-reducing / flat hedges skip Director / CFO / CEO VAR rungs. */
export function hedgeSkipsApprovalPolicy(kind: FxHedgeRiskKind): boolean {
  return kind !== 'increase';
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
      const totalRaw = grossForecastTargetLocalM(
        stockM,
        Tf,
        flows,
        flowM,
      );
      const bookedCoverLocalM = nonStripAmt + stripAmt;
      const bookedOnTarget = bookedCoverOnForecastLocalM(totalRaw, bookedCoverLocalM);
      const bookedNearOpen = bookedCoverOnForecastLocalM(
        openLocalM,
        nonStripAmt + stripNear,
      );
      // Stock is cash at t=0 (pre-hedge). A BUY option of −12.1 must not
      // flip Stock to +14; leftover / residual take Target-signed cover.
      const stockHedgeLocalM = stockM;
      const targetHedgeLocalM = totalRaw - bookedOnTarget;
      const exposureLocalM = openLocalM - bookedNearOpen;
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
      // Total H = live booked cover + incremental leftover × %. Strip cover
      // is already inside bookedOnTarget; do not add the signed strip again.
      const incrementalCover = hasStrip ? 0 : hedgeNotionalLocalM;
      const hedgeCoverM = bookedOnTarget + incrementalCover;
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
        forecastTargetLocalM: totalRaw,
        bookedCoverLocalM,
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
