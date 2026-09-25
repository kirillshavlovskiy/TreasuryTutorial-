/**
 * Live Ladder drill-down: residual risk, accrued P&L and greeks per VaR tenor
 * for one selected currency. Reuses Analytics VaR, closed-form CFaR and cash
 * interest — no third engine.
 */

import Decimal from 'decimal.js';
import { CURRENCY_PARAMS, type RowState } from '@/lib/fx-buffer';
import {
  monthlyFlowSeriesLocalM,
  type ForecastProfileState,
} from '@/lib/forecast-profile';
import {
  fwdCarryFromSwapPointsUsdM,
  isUsdPerFcyQuoted,
  type FxMarketRatesBundle,
} from '@/lib/fx-market-rates';
import { analyticsSpotUsd } from '@/lib/test-mode/fixtures/nordtech-var';
import {
  cashInterestPathToHorizon,
  interestBearingCashM,
  monthlyRevenueSeriesLocalM,
} from '@/lib/test-mode/cash-carry-analytics';
import {
  computeHedgeCfarBands,
  residualKnotsForHedge,
} from '@/lib/test-mode/cfar-residual';
import { exposureAtKnots } from '@/lib/test-mode/cfar-drawdown';
import {
  buildStripHedgedVarProfile,
  isLiveHedgeTicket,
  stripTicketsForCcy,
  varSetupWithLineUncertainty,
  type HedgeTicket,
  type PreparedHedgeProfile,
  type StripHedgedVarLeg,
} from '@/lib/test-mode/hedge-var';
import {
  VAR_HORIZON_OPTIONS,
  accruedPositionFromScheduleM,
  computeAnalyticsVarUsdM,
  growingVarByHorizonUsdM,
  horizonMonths,
  monthlyVolForSetup,
  type VarHorizonId,
  type VarSetup,
} from '@/lib/test-mode/var-setup';

const BP = new Decimal('0.0001');
const PCT = new Decimal('0.01');
const MONTHS_PA = new Decimal(12);

function dec(n: number): Decimal {
  return new Decimal(Number.isFinite(n) ? n : 0);
}

function money(n: Decimal): number {
  return n.toNumber();
}

/** Ladder row id: VaR chips plus the Cash / spot tenor. */
export type TenorRiskLadderId = VarHorizonId | 'cash';

/**
 * Overnight proxy for engines that need T>0 (√T VaR / CFaR). Cash is labeled
 * months=0; this is only the tenure fed into those closed forms.
 */
const CASH_ENGINE_MONTHS = 1 / 21;

export interface TenorRiskLadderPoint {
  id: TenorRiskLadderId;
  label: string;
  months: number;
  /** Signed unmatched book e(t)−H(t) at this tenor (local M). */
  residualLocalM: number;
  residualVarUsdM: number;
  residualCfarUsdM: number;
  /** Cash interest earned on the cash path through this tenor (USD M). */
  cashCarryUsdM: number;
  /** FX mark of the unmatched book through this tenor (USD M). */
  m2mUsdM: number;
  /** cashCarry + m2m (USD M). */
  totalPnlUsdM: number;
  /** USD P&L for +1% FCY vs USD. */
  deltaUsdPerPct: number;
  /**
   * Numerical convexity of Total P&L: P(S×1.01)+P(S×0.99)−2P(S).
   * Linear CIP / cash-carry marks are ~0; inverted-quote swap M2M is not.
   */
  gammaUsdPerPctSq: number;
  /** USD change in residual VaR for +1 vol point (σ₁ₘ +1%). */
  vegaUsdPerVolPt: number;
  /**
   * USD P&L for +1bp rates. Forward tenors: residual FX IR01 only.
   * Cash tenor: IR book DV01 (+ overnight cash IR01 when Cash FX is non-zero).
   */
  dv01Usd: number;
}

export interface TenorRiskLadderInput {
  ccy: string;
  row: RowState;
  stockM: number;
  monthlyFlowM: number;
  monthlyFlows?: readonly number[];
  setup: VarSetup;
  bookedHedges?: readonly HedgeTicket[];
  prepared?: PreparedHedgeProfile | null;
  /** Decision hedge notional (local M) when nothing is booked/prepared. */
  hedgeNotionalLocalM?: number;
  forecastProfile?: ForecastProfileState | null;
  marketRates?: FxMarketRatesBundle | null;
}

function usdRatePct(): number {
  const v = CURRENCY_PARAMS.USD?.carry;
  return typeof v === 'number' && Number.isFinite(v) ? v : 3.5;
}

/** Overlay USD-per-FCY spot onto a market bundle (market-quote convention). */
export function bundleWithSpotUsd(
  bundle: FxMarketRatesBundle,
  ccy: string,
  spotUsd: number,
): FxMarketRatesBundle {
  if (!(spotUsd > 0) || !Number.isFinite(spotUsd)) return bundle;
  if (isUsdPerFcyQuoted(ccy)) {
    return {
      ...bundle,
      spot: { bid: spotUsd, ask: spotUsd, mid: spotUsd },
    };
  }
  const q = 1 / spotUsd;
  return {
    ...bundle,
    spot: { bid: q, ask: q, mid: q },
  };
}

function liveTicketsForCcy(
  booked: readonly HedgeTicket[],
  ccy: string,
): HedgeTicket[] {
  return booked.filter(t => t.ccy === ccy && isLiveHedgeTicket(t));
}

/**
 * Prepared package the CFaR / residual engines understand: staged package,
 * else live booked non-strip cover, else the Decision hedge-add bullet.
 * Booked strips are read directly from tickets inside residualKnotsForHedge.
 */
export function coverPreparedForLadder(
  input: Pick<
    TenorRiskLadderInput,
    'ccy' | 'setup' | 'bookedHedges' | 'prepared' | 'hedgeNotionalLocalM'
  >,
): PreparedHedgeProfile | null {
  const prepared = input.prepared;
  if (prepared && Math.abs(prepared.coverLocalM) > 1e-12) return prepared;
  const booked = input.bookedHedges ?? [];
  if (stripTicketsForCcy(booked, input.ccy).length > 0) return null;
  const live = liveTicketsForCcy(booked, input.ccy);
  const bookedCover = live.reduce((s, t) => s + t.amountLocalM, 0);
  const cover =
    Math.abs(bookedCover) > 1e-12
      ? bookedCover
      : (input.hedgeNotionalLocalM ?? 0);
  if (Math.abs(cover) < 1e-12) return null;
  const Tf = input.setup.forecastMonths;
  const settle =
    Tf > 0 ? Tf : horizonMonths(input.setup.horizon);
  return {
    structure: 'bullet',
    basis: 'totalExpected',
    ticketBasis: 'stock',
    legs: [],
    coverLocalM: cover,
    hedgeRatio: 1,
    settleMonths: settle,
  };
}

function varLegsForCcy(input: TenorRiskLadderInput): StripHedgedVarLeg[] {
  const booked = input.bookedHedges ?? [];
  const strip = stripTicketsForCcy(booked, input.ccy)
    .slice()
    .sort((a, b) => (a.stripEdgeIndex ?? 0) - (b.stripEdgeIndex ?? 0));
  if (strip.length > 0) {
    return strip.map(t => ({
      amountLocalM: t.amountLocalM,
      tenureMonths: horizonMonths(t.maturity ?? input.setup.horizon),
      recognizeFromMonths: 0,
    }));
  }
  const prepared = coverPreparedForLadder(input);
  if (!prepared) return [];
  if (prepared.structure === 'strip' && prepared.legs.length > 0) {
    return prepared.legs.map(l => ({
      amountLocalM: l.tradeNotionalLocalM ?? l.hedgeLocalM,
      tenureMonths: l.settleMonths ?? (l.endMonth > 0 ? l.endMonth : 0),
      recognizeFromMonths: 0,
    }));
  }
  if (Math.abs(prepared.coverLocalM) < 1e-12) return [];
  const settle =
    prepared.settleMonths != null && prepared.settleMonths > 0
      ? prepared.settleMonths
      : input.setup.forecastMonths > 0
        ? input.setup.forecastMonths
        : horizonMonths(input.setup.horizon);
  return [
    {
      amountLocalM: prepared.coverLocalM,
      tenureMonths: settle,
      recognizeFromMonths: 0,
    },
  ];
}

function cipM2mUsdM(
  residualLocalM: number,
  ccy: string,
  months: number,
  rFcyPct: number,
  spotUsd = analyticsSpotUsd(ccy),
): number {
  const residualUsd = dec(residualLocalM).mul(spotUsd);
  const dR = dec(rFcyPct).minus(usdRatePct()).div(100);
  return money(residualUsd.mul(dR).mul(dec(months).div(MONTHS_PA)));
}

/**
 * Unmatched FX mark through `months`. Swap-points CIP when a curve is loaded,
 * otherwise deposit-rate CIP. `spotUsd` overrides the Analytics pin so a
 * historical reconstruct can reprice without re-running the residual engine.
 */
export function m2mUsdMAt(
  residualLocalM: number,
  ccy: string,
  months: number,
  rFcyPct: number,
  marketRates?: FxMarketRatesBundle | null,
  spotUsd?: number,
): number {
  if (Math.abs(residualLocalM) < 1e-12 || months <= 0) return 0;
  const s =
    typeof spotUsd === 'number' && Number.isFinite(spotUsd) && spotUsd > 0
      ? spotUsd
      : analyticsSpotUsd(ccy);
  if (marketRates) {
    const bundle =
      typeof spotUsd === 'number' && Number.isFinite(spotUsd) && spotUsd > 0
        ? bundleWithSpotUsd(marketRates, ccy, s)
        : marketRates;
    const pts = fwdCarryFromSwapPointsUsdM({
      notionalLocalM: residualLocalM,
      settleMonths: Math.max(months, 0.25),
      bundle,
      ccy,
    });
    if (pts) return pts.fwdCarryUsdM;
  }
  return cipM2mUsdM(residualLocalM, ccy, months, rFcyPct, s);
}

/**
 * Convexity of Total P&L (cash carry + M2M) for a ±1% spot bump.
 * Carry converts linearly in USD/FCY; M2M is repriced at the bumped spots.
 */
export function gammaUsdPerPctSqAt(input: {
  residualLocalM: number;
  months: number;
  ccy: string;
  rFcyPct: number;
  cashCarryUsdM: number;
  spotUsd: number;
  marketRates?: FxMarketRatesBundle | null;
}): number {
  const spot = input.spotUsd > 0 ? input.spotUsd : analyticsSpotUsd(input.ccy);
  const pnlAt = (s: number) => {
    const carry = input.cashCarryUsdM * (s / spot);
    const m2m =
      input.months <= 0
        ? 0
        : m2mUsdMAt(
            input.residualLocalM,
            input.ccy,
            input.months,
            input.rFcyPct,
            input.marketRates,
            s,
          );
    return carry + m2m;
  };
  const p0 = pnlAt(spot);
  return pnlAt(spot * 1.01) + pnlAt(spot * 0.99) - 2 * p0;
}

function irBookDv01Usd(row: RowState, spotUsd: number): Decimal {
  const assets = dec(row.ir_asset_notional).plus(row.ir_invest_notional ?? 0);
  const net = assets.minus(row.ir_liab_notional);
  return net.mul(spotUsd).mul(row.ir_net_dur).mul(BP);
}

/** Overnight cash IR01: Cash FX × spot × (1 business day) × 1bp. */
function cashOvernightDv01Usd(cashLocalM: number, spotUsd: number): Decimal {
  if (Math.abs(cashLocalM) < 1e-12) return new Decimal(0);
  return dec(cashLocalM)
    .mul(spotUsd)
    .mul(dec(CASH_ENGINE_MONTHS).div(MONTHS_PA))
    .mul(BP);
}

function pointGreeks(input: {
  residualLocalM: number;
  residualVarUsdM: number;
  months: number;
  spotUsd: number;
  sigma: number;
  /** Extra DV01 (IR book / cash) layered on residual FX IR01. */
  extraDv01Usd?: Decimal;
}): Pick<
  TenorRiskLadderPoint,
  'deltaUsdPerPct' | 'vegaUsdPerVolPt' | 'dv01Usd'
> {
  const residualUsd = dec(input.residualLocalM).mul(input.spotUsd);
  const deltaUsdPerPct = money(residualUsd.mul(PCT));
  const vegaUsdPerVolPt =
    input.sigma > 1e-12
      ? money(dec(input.residualVarUsdM).div(input.sigma).mul(PCT))
      : 0;
  const fxDv01 = residualUsd
    .mul(dec(input.months).div(MONTHS_PA))
    .mul(BP);
  const dv01Usd = money(fxDv01.plus(input.extraDv01Usd ?? 0));
  return { deltaUsdPerPct, vegaUsdPerVolPt, dv01Usd };
}

export function buildTenorRiskLadder(
  input: TenorRiskLadderInput,
): TenorRiskLadderPoint[] {
  const { ccy, row, stockM, setup } = input;
  const booked = input.bookedHedges ?? [];
  const flows =
    input.monthlyFlows && input.monthlyFlows.length > 0
      ? input.monthlyFlows
      : monthlyFlowSeriesLocalM(
          row,
          Math.max(1, Math.ceil(setup.forecastMonths)),
          input.forecastProfile,
        );
  const flowM =
    Number.isFinite(input.monthlyFlowM) && Math.abs(input.monthlyFlowM) > 1e-15
      ? input.monthlyFlowM
      : flows.length > 0
        ? flows.reduce((a, b) => a + b, 0) / flows.length
        : 0;
  const rowSetup = varSetupWithLineUncertainty(
    setup,
    ccy,
    input.forecastProfile,
  );
  const prepared = coverPreparedForLadder(input);
  const throughMonths = Math.max(
    setup.forecastMonths,
    ...VAR_HORIZON_OPTIONS.map(h => h.months),
  );
  const hedgeInput = {
    stockM,
    monthlyFlows: flows,
    ccy,
    setup: rowSetup,
    bookedHedges: booked,
    prepared,
    tenureMonths: throughMonths,
    forecastProfile: input.forecastProfile,
  };
  const residualPath = residualKnotsForHedge(hedgeInput);
  const Tf = rowSetup.forecastMonths;
  const Eref = Math.abs(
    Tf > 0
      ? accruedPositionFromScheduleM(stockM, flows, Tf)
      : stockM,
  );
  const legs = varLegsForCcy({ ...input, monthlyFlows: flows, monthlyFlowM: flowM });
  const varProfile =
    Tf > 0 && legs.length > 0
      ? buildStripHedgedVarProfile(
          stockM,
          flowM,
          ccy,
          rowSetup,
          legs,
          flows,
          1,
          Eref > 1e-12 ? Eref : undefined,
          throughMonths,
        )
      : [];
  const openTerm = growingVarByHorizonUsdM(
    stockM,
    flowM,
    ccy,
    rowSetup,
    flows,
  );
  const sigma = monthlyVolForSetup(rowSetup);
  const spotUsd = analyticsSpotUsd(ccy);
  const revenue = monthlyRevenueSeriesLocalM(
    row,
    Math.max(1, Math.ceil(throughMonths)),
    input.forecastProfile,
  );
  const cashFxLocalM = interestBearingCashM(row);
  const irDv01 = irBookDv01Usd(row, spotUsd);
  const cashDv01 = cashOvernightDv01Usd(cashFxLocalM, spotUsd);

  const atProfile = (months: number) => {
    if (varProfile.length === 0) return null;
    return (
      varProfile.find(p => Math.abs(p.t - months) < 1e-6) ??
      varProfile.reduce((best, p) =>
        Math.abs(p.t - months) < Math.abs(best.t - months) ? p : best,
      )
    );
  };

  const cashCarryThrough = (months: number) =>
    cashInterestPathToHorizon({
      openingCashM: cashFxLocalM,
      monthlyNets: flows,
      monthlyRevenue: revenue,
      creditPct: row.r_FCY,
      debitPct: row.r_OD,
      ccy,
      throughMonths: months,
      marketRates: input.marketRates ?? undefined,
    }).interestUsdM;

  /** Cash / spot tenor — first row; residual at t=0 + Cash FX / IR book greeks. */
  const residualCashLocalM = exposureAtKnots(residualPath.knots, 0);
  const cashVarUsdM = computeAnalyticsVarUsdM(
    residualCashLocalM,
    0,
    ccy,
    { ...rowSetup, exposureBasis: 'stock', forecastMonths: 0 },
    undefined,
    CASH_ENGINE_MONTHS,
  );
  const cashCfar = computeHedgeCfarBands({
    ...hedgeInput,
    tenureMonths: CASH_ENGINE_MONTHS,
  });
  const cashCarryUsdM = cashCarryThrough(0);
  const cashM2mUsdM = 0; // spot — no forward points
  const cashGreeks = pointGreeks({
    residualLocalM: residualCashLocalM,
    residualVarUsdM: cashVarUsdM,
    // months=0 → no residual FX IR01; Cash owns IR book + overnight Cash FX.
    months: 0,
    spotUsd,
    sigma,
    extraDv01Usd: irDv01.plus(cashDv01),
  });
  const gammaAt = (residualLocalM: number, months: number, cashCarry: number) =>
    gammaUsdPerPctSqAt({
      residualLocalM,
      months,
      ccy,
      rFcyPct: row.r_FCY,
      cashCarryUsdM: cashCarry,
      spotUsd,
      marketRates: input.marketRates,
    });
  const cashPoint: TenorRiskLadderPoint = {
    id: 'cash',
    label: 'Cash',
    months: 0,
    residualLocalM: residualCashLocalM,
    residualVarUsdM: cashVarUsdM,
    residualCfarUsdM: cashCfar.netCriticalCashUsdM,
    cashCarryUsdM,
    m2mUsdM: cashM2mUsdM,
    totalPnlUsdM: money(dec(cashCarryUsdM).plus(cashM2mUsdM)),
    gammaUsdPerPctSq: gammaAt(residualCashLocalM, 0, cashCarryUsdM),
    ...cashGreeks,
  };

  const forwardPoints = VAR_HORIZON_OPTIONS.map((h, i) => {
    const residualLocalM = exposureAtKnots(residualPath.knots, h.months);
    const open = openTerm[i]!;
    const p = atProfile(h.months);
    let residualVarUsdM: number;
    if (p && residualPath.hedged) {
      residualVarUsdM = p.hedgedVarUsdM;
    } else if (Tf <= 0) {
      residualVarUsdM = computeAnalyticsVarUsdM(
        residualLocalM,
        0,
        ccy,
        { ...rowSetup, horizon: h.id },
      );
    } else {
      residualVarUsdM = open.varUsdM;
    }
    const cfar = computeHedgeCfarBands({
      ...hedgeInput,
      tenureMonths: h.months,
    });
    const residualCfarUsdM = cfar.netCriticalCashUsdM;
    const cashCarryUsdMFwd = cashCarryThrough(h.months);
    const m2mUsdM = m2mUsdMAt(
      residualLocalM,
      ccy,
      h.months,
      row.r_FCY,
      input.marketRates,
    );
    const totalPnlUsdM = money(dec(cashCarryUsdMFwd).plus(m2mUsdM));
    const greeks = pointGreeks({
      residualLocalM,
      residualVarUsdM,
      months: h.months,
      spotUsd,
      sigma,
      // IR book / overnight cash live on the Cash tenor only.
    });
    return {
      id: h.id,
      label: h.label,
      months: h.months,
      residualLocalM,
      residualVarUsdM,
      residualCfarUsdM,
      cashCarryUsdM: cashCarryUsdMFwd,
      m2mUsdM,
      totalPnlUsdM,
      gammaUsdPerPctSq: gammaAt(residualLocalM, h.months, cashCarryUsdMFwd),
      ...greeks,
    };
  });

  return [cashPoint, ...forwardPoints];
}
