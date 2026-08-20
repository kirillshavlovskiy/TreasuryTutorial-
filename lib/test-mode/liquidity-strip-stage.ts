/**
 * Liquidity Book → staged FX package.
 *
 * Residual Δ is the frontier slider (1 = open, 0 = far). CIP on the funding
 * strip stays on the far share (1−Δ). The open share is an FX strip the desk
 * can Stage / Send like any other hedge — it must not write swapNear into
 * the unfunded liquidity path.
 */

import { clampHedgeDelta, type SwapForwardOverlay } from '@/lib/fx-hedge';
import { resolveMarketRatesForCcy, type FxMarketRatesBundle } from '@/lib/fx-market-rates';
import { assignImpliedCarryFromSwapPoints } from '@/lib/test-mode/cash-carry-analytics';
import type { PreparedHedgeProfile } from '@/lib/test-mode/hedge-var';
import type { LiquiditySwapLegRow } from '@/lib/test-mode/liquidity-strategies';

const RESIDUAL_STAGE_EPS = 1e-6;
const NOTIONAL_DUST = 0.001;

export type FundingStripStageLeg = Pick<
  LiquiditySwapLegRow,
  | 'cycleIndex'
  | 'valueDateMonths'
  | 'newLeg'
  | 'outstanding'
  | 'settleMonths'
  | 'preBookable'
>;

/**
 * Overlay that only sets Δ so CIP retention/CFaR-bridge scaling read right.
 * No extra FX forward.
 *
 * `residual` here is the frontier's own convention (1 = open/nothing
 * hedged, 0 = far/fully hedged — see the module comment). SwapForwardOverlay
 * .delta is the OPPOSITE convention everywhere else it's read
 * (allocateSwapForwardOverlay: "replacement fraction moved to forward",
 * Δ=1 = fully hedged — see retainedFundingPlanByCcy's own test, which
 * expects (1-Δ) retained under THAT convention). Passing residual straight
 * through as delta silently inverted CIP retention and the CFaR bridge for
 * every chart-picked residual: a fully open (residual=1) position read as
 * fully hedged (delta=1), retaining ZERO of its real risk instead of all
 * of it. Invert once, here, at the one point a frontier residual becomes a
 * SwapForwardOverlay — every downstream reader of .delta already assumes
 * the hedge-coverage convention and must not be touched.
 */
export function overlayDeltaStub(residual: number): SwapForwardOverlay {
  const delta = 1 - clampHedgeDelta(residual);
  return {
    delta,
    exposureLocalM: 0,
    swapNearLocalM: 0,
    swapStandingLocalM: 0,
    forwardLocalM: 0,
    remainingFarLocalM: 0,
    residualNearLocalM: 0,
    finalNetLocalM: 0,
  };
}

/** Desk overlays, with modeled residual Δ replacing any CCY the book has picked. */
export function mergeResidualOverlays(
  desk: Readonly<Record<string, SwapForwardOverlay>> | undefined,
  residualByCcy: Readonly<Record<string, number>>,
): Record<string, SwapForwardOverlay> {
  const next: Record<string, SwapForwardOverlay> = { ...(desk ?? {}) };
  for (const [ccy, residual] of Object.entries(residualByCcy)) {
    next[ccy] = overlayDeltaStub(residual);
  }
  return next;
}

export function residualNeedsFxStage(residual: number): boolean {
  return clampHedgeDelta(residual) > RESIDUAL_STAGE_EPS;
}

/**
 * FX strip that hedges the OPEN residual of a funding programme.
 * Δ = 0 (far) → null. Δ > 0 → notionals × Δ, same dates as the swap ledger.
 */
export function fundingStripPreparedProfile(input: {
  ccy: string;
  schedule: readonly FundingStripStageLeg[];
  residual: number;
  forecastMonths: number;
  marketRates?: FxMarketRatesBundle | null;
  ratesScopeId?: string | null;
}): PreparedHedgeProfile | null {
  const residual = clampHedgeDelta(input.residual);
  if (residual < RESIDUAL_STAGE_EPS) return null;

  const trades = input.schedule.filter(
    l => Math.abs(l.newLeg) > NOTIONAL_DUST && l.settleMonths > 0,
  );
  if (trades.length === 0) return null;

  const months = Math.max(1, Math.floor(input.forecastMonths));
  const isStrip = trades.length > 1;
  let cumul = 0;
  const legs = trades.map((l, i) => {
    const trade = residual * l.newLeg;
    cumul += trade;
    const startMonth = Math.max(0, l.valueDateMonths);
    const settle = Math.max(1, l.settleMonths);
    return {
      index: i,
      startMonth,
      endMonth: startMonth + settle,
      settleMonths: settle,
      hedgeLocalM: cumul,
      tradeNotionalLocalM: trade,
      label: l.preBookable
        ? `Fwd M${l.valueDateMonths + 1}`
        : `Spot M${l.valueDateMonths + 1}`,
    };
  });

  const coverLocalM = isStrip ? cumul : residual * trades[0]!.newLeg;
  const bulletSettle = isStrip ? months : Math.max(1, trades[0]!.settleMonths);

  const raw: PreparedHedgeProfile = isStrip
    ? {
        structure: 'strip',
        basis: 'cash',
        ticketBasis: 'stock',
        legs,
        coverLocalM,
        hedgeRatio: residual,
        preparedFor: 'liquidity',
      }
    : {
        structure: 'bullet',
        basis: 'cash',
        ticketBasis: 'stock',
        legs: [],
        coverLocalM,
        hedgeRatio: residual,
        settleMonths: bulletSettle,
        cashDeliveryAt: 'periodEnd',
        preparedFor: 'liquidity',
      };

  if (Math.abs(raw.coverLocalM) < NOTIONAL_DUST) return null;

  const bundle = input.marketRates
    ?? resolveMarketRatesForCcy(undefined, input.ccy, input.ratesScopeId);
  return {
    ...assignImpliedCarryFromSwapPoints(raw, {
      marketRates: bundle,
      bulletSettleMonths: bulletSettle,
    }),
    preparedFor: 'liquidity',
  };
}
